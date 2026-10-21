import {
  awaitQuiescence,
  ClickHouseService,
  committedCheckpoint,
  deleteLedgersAbove,
  isLedgerParseError,
  LedgerParseError,
  LedgerSource,
  LedgerWriter,
  LedgerWriteResult,
  RawLedger,
  retryAfterMsOf,
  ShutdownSignals,
  storedLedgerHash,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { NODE_CLIENT, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** The `LedgerSource` the live runner reads from (an `RpcLedgerSource` in the app). */
export const LEDGER_SOURCE = Symbol('LEDGER_SOURCE');
/** Optional `LiveRunnerOptions` (timings, logger); tests shorten the timings. */
export const LIVE_RUNNER_OPTIONS = Symbol('LIVE_RUNNER_OPTIONS');

/** Ledgers per partition of `ledgers` (`PARTITION BY intDiv(ledger_index, 1000000)`): a commit never spans two. */
export const LEDGERS_PARTITION_SIZE = 1_000_000;

/**
 * `ingest_log` rows of the live runner's first-write intents have a `run_id` with this prefix (`live:<bootId>`) and the
 * key `(range_start = start, range_end = LIVE_INTENT_RANGE_END)`.
 */
export const LIVE_INTENT_PREFIX = 'live:';

/**
 * `range_end` of a live first-write intent: 0, a sentinel no range-ingest chunk can have (a chunk's `range_end` is at
 * least its `range_start`), so that a live intent never shares the ReplacingMergeTree key `(range_start, range_end)` of
 * `ingest_log` with a range chunk, and no merge collapses one into the other (ruling R26). Readers of range chunks must
 * skip `run_id` `live:%` (and range_end 0).
 */
export const LIVE_INTENT_RANGE_END = 0;

/**
 * A ledger whose `parent_hash` is not the hash of the ledger before it, or a stored checkpoint whose hash the node does
 * not confirm. The runner halts (status `halted`, liveliness 503): the data and the node disagree about history, and only
 * an operator can tell which one is wrong.
 */
export class ChainBreakError extends Error {
  constructor(
    message: string,
    readonly ledgerIndex: number,
  ) {
    super(message);
    this.name = 'ChainBreakError';
  }
}

/** Another syncer holds the lease now (it took over after this one stalled): this one halts and writes nothing more. */
export class LeaseLostError extends Error {
  constructor(readonly holder: string) {
    super(holder === '' ? 'lease lost: it was released by another syncer' : `lease lost to ${holder}`);
    this.name = 'LeaseLostError';
  }
}

export type RunnerState = 'starting' | 'catching_up' | 'live' | 'halted';

export interface RunnerStatus {
  state: RunnerState;
  /** Highest committed ledger; undefined while nothing is committed. */
  checkpoint?: number;
  /** Newest validated ledger the runner knows of (the last known one while the node is unreachable). */
  head?: number;
  /** `head` minus the committed checkpoint (or minus the ledger before the start, while nothing is committed). */
  lag?: number;
  /** Unix seconds of the last commit made by this process. */
  lastCommitAt?: number;
  /** True while a failed write (or the boot cleanup) is being recovered: nothing is written until that succeeds. */
  recovering?: boolean;
  /** The error that is holding progress up (recovery, boot), or why the runner halted. */
  error?: string;
}

export interface LiveRunnerOptions {
  /** A lease whose last heartbeat is younger than this (on the ClickHouse server's clock) belongs to its holder. Default 30000. */
  leaseTtlMs?: number;
  /** Heartbeat interval of the lease; each heartbeat first checks that the lease is still this runner's. Default 10000. */
  heartbeatMs?: number;
  /** Poll `validatedHead()` when no `ledgerClosed` hint has arrived for this long. Default 15000. */
  headSilenceMs?: number;
  /** First retry delay of a fetch, the boot cleanup and a recovery; it doubles per attempt. Default 500. */
  backoffInitialMs?: number;
  /** Cap of the retry delay. Default 30000. */
  backoffMaxMs?: number;
  /** `awaitQuiescence` timeout (before the kill, and again after it). Default 60000. */
  quiescenceTimeoutMs?: number;
  /** Default: a Nest `Logger` with context `LiveRunner`. */
  logger?: RunnerLogger;
}

interface RunnerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: unknown): void;
  debug?(message: string): void;
}

const DEFAULTS = {
  leaseTtlMs: 30_000,
  heartbeatMs: 10_000,
  headSilenceMs: 15_000,
  backoffInitialMs: 500,
  backoffMaxMs: 30_000,
  quiescenceTimeoutMs: 60_000,
};

/** Shortest wait of the loop, so that a deadline that has just passed cannot make it spin. */
const MIN_WAIT_MS = 5;

/** A lease confirmation older than this many heartbeat intervals is re-checked before anything is written. */
const LEASE_RECHECK_INTERVALS = 1.5;

/** What `abortable` resolves to when its signal aborts first. */
const ABORTED = Symbol('aborted');

/** Thrown by a boot or recovery step that the stop signal cut short (it is not an error). */
class StoppedError extends Error {}

/**
 * The live ingest loop: the single writer of a network's ledger tables.
 *
 * **Boot** (`onApplicationBootstrap`): take the `syncer_lease` (refused while another holder's heartbeat is younger than
 * 30 s on the ClickHouse server's clock), then, in the background: verify that the node confirms the hash stored for the
 * committed checkpoint (else halt), delete the uncommitted tail above it, and continue at checkpoint + 1. With no
 * checkpoint the start is `GH_SYNC_START_LEDGER` (default: the validated head); the rows above
 * min(start, earliest unfinished first-write intent) - 1 are deleted first (what a crashed first write left), and the
 * start is recorded as an intent in `ingest_log` until the first commit.
 *
 * **Lease.** Every heartbeat first checks that the newest lease row is still this runner's; if another syncer took over,
 * the runner halts (`lease lost to <holder>`) and writes nothing more. A confirmation older than 1.5 heartbeats (after a
 * stall) is re-checked before any write or delete.
 *
 * **Loop.** The head is the highest `ledgerClosed` hint of the node client, or a poll of `validatedHead()` when no hint
 * has arrived for 15 s; it never goes down, so the lag stays defined while the node is away. Up to `catchupConcurrency`
 * ledgers are fetched at once, by index, each retried forever with a capped backoff (a ledger is never skipped); a
 * rate-limited node (`NodeThrottledError`) is waited out for as long as it asked instead (ruling R98). Fetched
 * ledgers are reordered and accepted in index order, each only if its `parent_hash` is the hash of the one before (else
 * the verified prefix is committed and the runner halts). Accepted ledgers are written as one batch when it holds
 * `catchupFlushLedgers` ledgers or `catchupFlushTxs` transactions, is `catchupFlushMs` old, reaches to within one ledger
 * of the head (live, every ledger is its own commit), or the next ledger starts a new `ledgers` partition (a commit never
 * spans two, so a half-applied commit cannot leave a marker above a gap).
 *
 * **A failed write** is recovered as `LedgerWriter` documents (ruling R16): wait until the failed run's queries are gone,
 * re-read the checkpoint, delete everything above it and wait for that too, carry on with a writer under a new runId and
 * a pipeline rebuilt from checkpoint + 1. A recovery step that fails (a stuck mutation) is logged as an error, shown in
 * the status, and retried with backoff; nothing is written until it succeeds.
 *
 * **A ledger the parser rejects** (`LedgerParseError`) is not a failed write: parsing is pure, so it would fail the same
 * way after any recovery (ruling R96). The ledgers of the batch before it are committed (the writer parses the whole
 * batch before it inserts anything, so the same writer may write that prefix), then the runner halts like on a chain
 * break: status `halted` with the error, liveliness 503, `syncer_ingest_halts_total{reason="parse_error"}`. An operator
 * has to look at the ledger (a parser fix, then a restart, which carries on after the checkpoint).
 *
 * **Shutdown** (`onModuleDestroy`, or SIGTERM through `ShutdownSignals`): stop the loop (a write in progress finishes, a
 * partial batch is dropped and refetched next time; a boot or recovery step is abandoned, the next boot redoes it) and
 * release the lease.
 */
@Injectable()
export class LiveRunner implements OnApplicationBootstrap, OnModuleDestroy {
  /** Identifies this process's runner: in the lease holder and in its `ingest_log` intent. */
  readonly bootId = randomUUID();
  /** `hostname:pid:bootId`, written to `syncer_lease`. */
  readonly holder = `${hostname()}:${process.pid}:${this.bootId}`;

  private readonly opts: typeof DEFAULTS;
  private readonly logger: RunnerLogger;

  private state: RunnerState = 'starting';
  private recovering = false;
  private lastError?: string;
  private haltError?: Error;
  private lag?: number;
  private lastCommitAt?: number;

  // --- head ----------------------------------------------------------------------------------------------------------
  private head?: number;
  private lastHintAt = 0;
  private lastPollAt = 0;
  private polling = false;

  // --- committed position --------------------------------------------------------------------------------------------
  private prepared = false;
  /** The ledger below the first one this runner writes when nothing is committed (`start - 1`, or the boot checkpoint). */
  private floor?: number;
  private committed?: number;
  /** Consecutive failed writes; slows down a write that fails again and again (ClickHouse refusing a batch). */
  private writeFailures = 0;
  /** The first-write intent of an empty-database boot is still to be marked done (after the first commit). */
  private liveIntentPending = false;

  // --- pipeline (rebuilt by `reset`) ---------------------------------------------------------------------------------
  /** Bumped by every reset: fetches of an older generation are ignored. */
  private generation = 0;
  private fetchAbort = new AbortController();
  private nextToFetch = 0;
  private nextToAccept = 0;
  /** Hash of the last accepted ledger: the `parent_hash` the next one must have. Undefined: no check (first write). */
  private tipHash?: string;
  /** Fetched, not yet accepted (out of order). Its size plus the fetches in flight is at most `catchupConcurrency`. */
  private readonly ready = new Map<number, RawLedger>();
  private batch: RawLedger[] = [];
  private batchTxs = 0;
  private batchSince = 0;
  private pendingBreak?: ChainBreakError;

  // --- wake-ups and lifecycle ----------------------------------------------------------------------------------------
  private dirty = false;
  private wake?: () => void;
  private stopping = false;
  private stopped?: Promise<void>;
  private readonly stopAbort = new AbortController();
  /** The background loop, or a `runOnce()` in progress. */
  private running?: Promise<void>;
  private listening = false;

  // --- lease ---------------------------------------------------------------------------------------------------------
  private lease?: Promise<void>;
  private leaseHeld = false;
  /** `performance.now()` of the last check that found the lease ours (and renewed it). */
  private leaseConfirmedAt = 0;
  private leaseCheckFailures = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private beating?: Promise<boolean>;

  constructor(
    @Inject(LEDGER_SOURCE) private readonly source: LedgerSource,
    private writer: LedgerWriter,
    private readonly ch: ClickHouseService,
    @Inject(NODE_CLIENT) private readonly headHints: EventEmitter,
    private readonly cfg: SyncerConfig,
    @Optional() private readonly metrics?: PrometheusService,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(LIVE_RUNNER_OPTIONS) options: LiveRunnerOptions = {},
  ) {
    const { logger, ...timings } = options;
    this.opts = { ...DEFAULTS, ...definedOnly(timings) };
    this.logger = logger ?? new Logger(LiveRunner.name);
  }

  status(): RunnerStatus {
    const status: RunnerStatus = { state: this.state };
    if (this.committed !== undefined) status.checkpoint = this.committed;
    if (this.head !== undefined) status.head = this.head;
    if (this.lag !== undefined) status.lag = this.lag;
    if (this.lastCommitAt !== undefined) status.lastCommitAt = this.lastCommitAt;
    if (this.recovering) status.recovering = true;
    const error = this.haltError?.message ?? this.lastError;
    if (error !== undefined) status.error = error;
    return status;
  }

  /** Takes the lease (failing the boot when another syncer holds it), then runs the loop in the background. */
  async onApplicationBootstrap(): Promise<void> {
    this.assertUsable();
    await this.acquireLease();
    this.shutdownSignals?.register('ingest', () => this.stop());
    this.listen();
    this.subscribeLedgerStream();
    this.running = this.runForever().catch((err) => {
      this.logger.error(
        `The ingest loop ended unexpectedly: ${describe(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Test hook: take the lease, prepare (first call only), catch up to the validated head as polled now (or a higher hint)
   * and resolve. Rejects with `ChainBreakError` / `LedgerParseError` / `LeaseLostError` when the runner halts. Not for use
   * while the background loop runs.
   */
  async runOnce(): Promise<void> {
    this.assertUsable();
    if (this.running) throw new Error('runOnce() cannot run while the ingest loop is running');
    const run = (async () => {
      await this.acquireLease();
      this.listen();
      try {
        await this.prepare();
        this.lastPollAt = Date.now();
        const polled = await this.untilDone('poll the validated head', 'warn', () => this.source.validatedHead());
        if (polled !== undefined) this.observeHead(polled);
        const target = this.head;
        if (target !== undefined) await this.pipeline(() => (this.committedTip() ?? 0) >= target);
      } catch (err) {
        if (err instanceof ChainBreakError || isLedgerParseError(err)) this.halt(err);
        throw err;
      }
      if (this.haltError) throw this.haltError;
    })();
    this.running = run.catch(() => undefined);
    try {
      await run;
    } finally {
      this.running = undefined;
    }
  }

  /** Stop the loop (a write in progress finishes; a partial batch is dropped) and release the lease. Idempotent. */
  stop(): Promise<void> {
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  // =================================================================================================================
  // Lease
  // =================================================================================================================

  /** Take the lease once (a failed attempt may be retried), then heartbeat every `heartbeatMs`. */
  private acquireLease(): Promise<void> {
    this.lease ??= this.takeLease().catch((err) => {
      this.lease = undefined;
      throw err;
    });
    return this.lease;
  }

  private async takeLease(): Promise<void> {
    const current = await this.currentLease();
    if (current.holder !== '' && current.holder !== this.holder) {
      if (current.ageMs < this.opts.leaseTtlMs) throw new Error(`Another syncer holds the lease (${current.holder})`);
      this.logger.warn(
        `Taking over the lease of ${current.holder}, whose last heartbeat is ${Math.round(current.ageMs / 1000)} s old`,
      );
    }
    await this.writeLeaseRow(this.holder);
    this.leaseHeld = true;
    this.leaseConfirmedAt = performance.now();
    this.logger.log(`Holding the ${this.cfg.network} syncer lease as ${this.holder}`);
    if (this.stopping) return; // stop() releases it as soon as this returns
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  /**
   * The newest lease row of this network, and its age on the ClickHouse server's clock (heartbeats are written with the
   * server's clock too, so no two hosts' clocks are ever compared). `holder` is '' when there is none or it was released.
   */
  private async currentLease(): Promise<{ holder: string; ageMs: number }> {
    const row = await this.ch.queryOne<{ holder: string; age_ms: string | number }>(
      `SELECT argMax(holder, heartbeat) AS holder, dateDiff('millisecond', max(heartbeat), now64(3)) AS age_ms
         FROM ${Table.SyncerLease} WHERE network = {network:String}`,
      { network: this.cfg.network },
    );
    return { holder: row?.holder ?? '', ageMs: Number(row?.age_ms ?? Number.POSITIVE_INFINITY) };
  }

  /**
   * One lease row with the server's current time, strictly newer than every row of this network: the newest row is the
   * lease (argMax, and the table is ReplacingMergeTree(heartbeat)), so a release must win over the last heartbeat.
   * Written by the server (`now64(3)`), the DateTime64(3) column never sees a client number.
   *
   * With `onlyIfHeldBy` the row is written only if that holder has the newest row when the statement reads the table: a
   * takeover that landed between a heartbeat's check and its write is not overwritten, and the next check sees it and
   * halts. ClickHouse has no transactions, so a takeover that lands while this very statement runs can still end up
   * older than the row it writes; then the other syncer's next check finds this one newest and that one halts.
   */
  private async writeLeaseRow(holder: string, onlyIfHeldBy?: string): Promise<void> {
    const newest = `SELECT argMax(holder, heartbeat) FROM ${Table.SyncerLease} WHERE network = {network:String}`;
    await this.ch.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat)
       SELECT {network:String}, {holder:String},
              greatest(now64(3), (SELECT max(heartbeat) FROM ${Table.SyncerLease} WHERE network = {network:String})
                                 + toIntervalMillisecond(1))
       ${onlyIfHeldBy === undefined ? '' : `WHERE (${newest}) = {owner:String}`}`,
      { network: this.cfg.network, holder, ...(onlyIfHeldBy !== undefined && { owner: onlyIfHeldBy }) },
    );
  }

  /**
   * Check that the lease is still ours and renew it; resolves true when it is. Another holder halts the runner. A failed
   * check (ClickHouse unreachable) resolves false and is retried by the next heartbeat. Only one runs at a time.
   */
  private heartbeat(): Promise<boolean> {
    this.beating ??= this.checkAndRenewLease()
      .then(
        (ours) => {
          if (ours) this.leaseCheckFailures = 0;
          return ours;
        },
        (err: unknown) => {
          this.leaseCheckFailures += 1;
          this.logger.warn(`Lease heartbeat failed: ${describe(err)}`);
          return false;
        },
      )
      .finally(() => {
        this.beating = undefined;
      });
    return this.beating;
  }

  private async checkAndRenewLease(): Promise<boolean> {
    if (!this.leaseHeld) return false;
    const current = await this.currentLease();
    if (!this.leaseHeld) return false;
    if (current.holder !== this.holder) {
      this.loseLease(current.holder);
      return false;
    }
    await this.writeLeaseRow(this.holder, this.holder);
    this.leaseConfirmedAt = performance.now();
    return true;
  }

  /**
   * Whether this runner may write now: true while the last lease confirmation is recent; otherwise (after a stall, or
   * failed heartbeats) the lease is checked again first. False when it was lost (the runner is halted then) or cannot be
   * confirmed right now.
   */
  private async leaseIsFresh(): Promise<boolean> {
    if (!this.leaseHeld) return false;
    if (performance.now() - this.leaseConfirmedAt <= this.opts.heartbeatMs * LEASE_RECHECK_INTERVALS) return true;
    return this.heartbeat();
  }

  private loseLease(holder: string): void {
    this.leaseHeld = false;
    clearInterval(this.heartbeatTimer);
    this.halt(new LeaseLostError(holder));
  }

  /**
   * Hand the lease back so that the next syncer can start at once instead of waiting out the TTL: a newer row with an
   * empty holder (a row with heartbeat 0 would never be the newest, so never read). Skipped when the lease is not ours.
   */
  private async releaseLease(): Promise<void> {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    clearInterval(this.heartbeatTimer);
    await this.beating;
    try {
      const current = await this.currentLease();
      if (current.holder !== this.holder) {
        this.logger.warn(`Not releasing the lease: it is held by ${current.holder || 'nobody'} now`);
        return;
      }
      await this.writeLeaseRow('', this.holder);
      this.logger.log('Released the syncer lease');
    } catch (err) {
      this.logger.warn(`Could not release the lease (it expires on its own): ${describe(err)}`);
    }
  }

  /** Throws unless the lease is confirmed ours: a step that would write or delete must not run without it. */
  private async assertLease(): Promise<void> {
    if (await this.leaseIsFresh()) return;
    if (this.haltError) throw this.haltError;
    throw new Error('The syncer lease cannot be confirmed right now');
  }

  // =================================================================================================================
  // First-write intent (ingest_log)
  // =================================================================================================================

  /** The lowest start of a live first-write intent that never got its first commit, if any. */
  private async earliestUnfinishedLiveIntent(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ start: number | string | null }>(
      `SELECT minOrNull(range_start) AS start FROM (
         SELECT range_start, argMax(status, updated_at) AS last_status FROM ${Table.IngestLog}
          WHERE startsWith(run_id, {prefix:String})
          GROUP BY range_start, range_end
       ) WHERE last_status = 'started'`,
      { prefix: LIVE_INTENT_PREFIX },
    );
    return row?.start == null ? undefined : Number(row.start);
  }

  /**
   * Record that this runner is about to write its first ledger at `start`, before any row of it goes in. The key is
   * `(start, LIVE_INTENT_RANGE_END)`, which no range-ingest chunk uses.
   */
  private async recordLiveIntent(start: number): Promise<void> {
    // updated_at is DateTime64(3): a JSON number is read as seconds, so it is sent as fractional seconds.
    await this.ch.insert(Table.IngestLog, [
      {
        range_start: start,
        range_end: LIVE_INTENT_RANGE_END,
        run_id: `${LIVE_INTENT_PREFIX}${this.bootId}`,
        status: 'started',
        updated_at: Date.now() / 1000,
      },
    ]);
  }

  /** After the first commit: mark every unfinished live intent done (the older ones were cleaned up at boot). */
  private async markLiveIntentsDone(): Promise<void> {
    await this.ch.command(
      `INSERT INTO ${Table.IngestLog} (range_start, range_end, run_id, status, updated_at)
       SELECT range_start, range_end, {runId:String}, 'done', greatest(now64(3), max(updated_at) + toIntervalMillisecond(1))
         FROM ${Table.IngestLog}
        WHERE startsWith(run_id, {prefix:String})
        GROUP BY range_start, range_end
       HAVING argMax(status, updated_at) = 'started'`,
      { runId: `${LIVE_INTENT_PREFIX}${this.bootId}`, prefix: LIVE_INTENT_PREFIX },
    );
  }

  // =================================================================================================================
  // Head
  // =================================================================================================================

  private readonly onLedgerClosed = (message: { ledger_index?: unknown } | undefined): void => {
    const index = toLedgerIndex(message?.ledger_index);
    if (index === undefined) return;
    this.lastHintAt = Date.now();
    this.observeHead(index);
  };

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.headHints.on('ledgerClosed', this.onLedgerClosed);
  }

  /** Ask the node client for the `ledger` stream. Not awaited: a failure only means the head is polled instead. */
  private subscribeLedgerStream(): void {
    const subscribe = (this.headHints as { subscribe?: (streams: string[]) => Promise<void> }).subscribe;
    if (typeof subscribe !== 'function') return;
    subscribe.call(this.headHints, ['ledger']).catch((err: unknown) => {
      this.logger.warn(`Subscribing to the ledger stream failed; polling the validated head instead: ${describe(err)}`);
    });
  }

  /** Raise the head (it never goes down). */
  private observeHead(index: number): void {
    if (this.head !== undefined && index <= this.head) return;
    this.head = index;
    this.metrics?.headLedger.set(index);
    this.updateStatus();
    this.notify();
  }

  /** Poll `validatedHead()` in the background when no hint (and no poll) has arrived for `headSilenceMs`. */
  private pollHeadIfSilent(): void {
    const now = Date.now();
    if (this.polling || now - Math.max(this.lastHintAt, this.lastPollAt) < this.opts.headSilenceMs) return;
    this.polling = true;
    this.lastPollAt = now;
    Promise.resolve()
      .then(() => this.source.validatedHead())
      .then(
        (index) => this.observeHead(index),
        (err: unknown) => {
          // A rate-limited node: the node client logged the pause; the head is polled again after headSilenceMs.
          if (retryAfterMsOf(err) > 0) this.lastPollAt = Date.now() + retryAfterMsOf(err) - this.opts.headSilenceMs;
          else this.logger.warn(`Polling the validated head failed: ${describe(err)}`);
        },
      )
      .finally(() => {
        this.polling = false;
        this.notify();
      });
  }

  // =================================================================================================================
  // Boot, loop, pipeline
  // =================================================================================================================

  private async runForever(): Promise<void> {
    while (!this.stopping && !this.haltError) {
      try {
        await this.prepare();
        await this.pipeline(() => false);
        return;
      } catch (err) {
        if (err instanceof ChainBreakError || isLedgerParseError(err)) {
          this.halt(err);
          return;
        }
        if (this.stopping || this.haltError) return;
        // Not a write error (those are recovered in `flush`): a bug or something unexpected. Start over from the
        // committed checkpoint, the same way as after a failed write.
        this.logger.error(`The ingest loop failed: ${describe(err)}`, err instanceof Error ? err.stack : undefined);
        this.writeFailures += 1; // backs a repeating failure off, as for a failing write
        if (this.prepared) await this.recover(err);
        else await this.sleep(this.opts.backoffInitialMs);
      }
    }
  }

  /**
   * Find where to continue, once: verify the checkpoint against the node and delete the uncommitted tail above it, or,
   * with nothing committed, clean up after any crashed first write and record this one's intent. Transient failures are
   * retried; throws `ChainBreakError`.
   */
  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await this.untilDone('prepare the ingest checkpoint', 'error', async () => {
      const checkpoint = await this.step(committedCheckpoint(this.ch));
      this.committed = checkpoint;
      this.updateStatus();
      if (checkpoint === undefined) {
        const start = this.cfg.syncStartLedger ?? (await this.step(this.source.validatedHead()));
        // A first write that crashed left rows above its own start, which (with the start defaulting to the head) may be
        // lower than this one: its unfinished intent says where.
        const earlier = await this.step(this.earliestUnfinishedLiveIntent());
        const cleanFrom = Math.min(start, earlier ?? start);
        await this.assertLease();
        await this.deleteAbove(cleanFrom - 1, 'boot');
        await this.step(this.recordLiveIntent(start));
        this.liveIntentPending = true;
        this.floor = start - 1;
        this.reset(undefined, undefined);
        this.logger.log(
          `Nothing is committed yet: starting at ledger ${start}` +
            (cleanFrom < start ? ` (cleaned up after an unfinished first write from ${cleanFrom})` : ''),
        );
      } else {
        const stored = await this.step(storedLedgerHash(this.ch, checkpoint));
        if (stored === undefined) throw new Error(`The checkpoint ${checkpoint} has no stored hash`);
        const ledger = await this.fetchLedger(checkpoint, this.stopAbort.signal);
        if (ledger === undefined) throw new StoppedError();
        if (ledger.header.ledger_hash !== stored) {
          throw new ChainBreakError(
            `The node's ledger ${checkpoint} has hash ${ledger.header.ledger_hash}, ` +
              `but the committed checkpoint ${checkpoint} is stored with hash ${stored}`,
            checkpoint,
          );
        }
        await this.assertLease();
        await this.deleteAbove(checkpoint, 'boot');
        this.floor = checkpoint;
        this.reset(checkpoint, stored);
        this.logger.log(`Resuming after the committed checkpoint ${checkpoint}`);
      }
      this.prepared = true;
      this.recovering = false;
      this.lastError = undefined;
      this.updateStatus();
    });
  }

  /** Fetch, accept and write ledgers until `done()` (checked between steps), a halt or stop. Throws `ChainBreakError`. */
  private async pipeline(done: () => boolean): Promise<void> {
    while (!this.stopping && !this.haltError && this.prepared && !done()) {
      this.dirty = false;
      this.pollHeadIfSilent();
      const head = this.head;
      if (head !== undefined) {
        this.fill(head);
        this.accept(head);
        // Accepting frees room in the fetch window: refill it before waiting, or catch-up stalls until the batch is due.
        this.fill(head);
        if (this.shouldFlush(head)) {
          await this.flush();
          continue;
        }
      }
      await this.idle(this.waitBudget());
    }
  }

  /** Start fetches for the next indexes up to the head, keeping at most `catchupConcurrency` ahead of acceptance. */
  private fill(head: number): void {
    if (this.pendingBreak) return;
    while (this.nextToFetch <= head && this.nextToFetch - this.nextToAccept < this.cfg.catchupConcurrency) {
      this.startFetch(this.nextToFetch);
      this.nextToFetch += 1;
    }
  }

  private startFetch(index: number): void {
    const generation = this.generation;
    void this.fetchLedger(index, this.fetchAbort.signal).then((ledger) => {
      if (ledger === undefined || generation !== this.generation) return;
      this.ready.set(index, ledger);
      this.notify();
    });
  }

  /**
   * `source.fetch(index)`, retried forever with a capped backoff; undefined as soon as `signal` aborts, even while a
   * request is still out (it is abandoned). Never rejects.
   */
  private async fetchLedger(index: number, signal: AbortSignal): Promise<RawLedger | undefined> {
    let delay = this.opts.backoffInitialMs;
    for (let attempt = 1; !signal.aborted; attempt++) {
      try {
        const ledger = await abortable(
          Promise.resolve().then(() => this.source.fetch(index)),
          signal,
        );
        if (ledger === ABORTED) break;
        if (ledger.header.ledger_index !== index) {
          throw new Error(`Ledger ${index} was requested but ledger ${ledger.header.ledger_index} came back`);
        }
        return ledger;
      } catch (err) {
        if (signal.aborted) break;
        const throttled = retryAfterMsOf(err);
        if (throttled > 0) {
          // The node asked this process to slow down: the node client logged the pause once; wait it out (R98).
          this.logger.debug?.(`Fetching ledger ${index} waits ${throttled} ms for a rate-limited node`);
          await this.sleep(throttled, signal);
          continue;
        }
        this.logger.warn(
          `Fetching ledger ${index} failed (attempt ${attempt}, retry in ${delay} ms): ${describe(err)}`,
        );
        await this.sleep(delay, signal);
        delay = Math.min(delay * 2, this.opts.backoffMaxMs);
      }
    }
    return undefined;
  }

  /**
   * Move fetched ledgers into the batch in index order while each one chains to the one before. A batch that is due is
   * never appended to: it is written as it is, even when its write has to wait (a lease that cannot be confirmed right
   * now), so it cannot grow across a `ledgers` partition or past the flush thresholds.
   */
  private accept(head: number): void {
    while (!this.pendingBreak) {
      if (this.batch.length > 0 && this.shouldFlush(head)) return;
      const ledger = this.ready.get(this.nextToAccept);
      if (ledger === undefined) return;
      const { ledger_index: index, ledger_hash: hash, parent_hash: parentHash } = ledger.header;
      if (this.tipHash !== undefined && parentHash !== this.tipHash) {
        this.pendingBreak = new ChainBreakError(
          `Ledger ${index} has parent_hash ${parentHash}, but ledger ${index - 1} has hash ${this.tipHash}`,
          index,
        );
        this.cancelFetches();
        return;
      }
      this.ready.delete(index);
      this.batch.push(ledger);
      this.batchTxs += ledger.transactions.length;
      if (this.batch.length === 1) this.batchSince = Date.now();
      this.tipHash = hash;
      this.nextToAccept += 1;
    }
  }

  private shouldFlush(head: number): boolean {
    if (this.pendingBreak) return true;
    if (this.batch.length === 0) return false;
    const tip = this.nextToAccept - 1;
    return (
      head - tip <= 1 ||
      // The next ledger opens a new partition of `ledgers`: one commit INSERT must not span two (ruling R24).
      (tip + 1) % LEDGERS_PARTITION_SIZE === 0 ||
      this.batch.length >= this.cfg.catchupFlushLedgers ||
      this.batchTxs >= this.cfg.catchupFlushTxs ||
      Date.now() - this.batchSince >= this.cfg.catchupFlushMs
    );
  }

  /** Write the batch (a failure is recovered), then raise a pending chain break: the verified prefix is committed first. */
  private async flush(): Promise<void> {
    const batch = this.batch;
    if (batch.length > 0) {
      if (!(await this.leaseIsFresh())) {
        // Lost: halted, the loop ends. Unconfirmed (ClickHouse trouble): write nothing, and try again shortly.
        if (!this.haltError) await this.sleep(this.backoff(this.leaseCheckFailures));
        return;
      }
      const first = batch[0].header.ledger_index;
      const last = batch[batch.length - 1].header.ledger_index;
      let written: LedgerWriteResult;
      try {
        written = await this.writer.write(batch);
      } catch (err) {
        if (isLedgerParseError(err)) {
          await this.haltOnUnparsable(batch, err);
          return;
        }
        this.writeFailures += 1;
        this.logger.error(
          `Writing ledgers ${first}-${last} failed (run ${this.writer.runId}); recovering from the committed checkpoint: ` +
            describe(err),
          err instanceof Error ? err.stack : undefined,
        );
        await this.recover(err);
        return;
      }
      this.batch = [];
      this.batchTxs = 0;
      this.batchSince = 0;
      this.countUnclassified(written);
      await this.committedBatch(first, last);
    }
    if (this.pendingBreak) throw this.pendingBreak;
  }

  /**
   * `syncer_amm_unclassified_total`: the pools of AMM transactions the parser made no swap, liquidity or governance row
   * for, in a batch that is committed. Only a batch that is, so that a write that failed and was recovered is counted
   * once, when its rewrite commits.
   */
  private countUnclassified(written: LedgerWriteResult): void {
    if (written.ammUnclassified > 0) this.metrics?.ammUnclassifiedTotal.inc(written.ammUnclassified);
  }

  /** The bookkeeping after the ledgers `first`..`last` were committed. */
  private async committedBatch(first: number, last: number): Promise<void> {
    this.writeFailures = 0;
    this.committed = last;
    this.lastCommitAt = Date.now() / 1000;
    this.metrics?.lastCommitTimestampSeconds.set(this.lastCommitAt);
    this.updateStatus();
    if (this.state === 'catching_up') {
      this.logger.log(`Committed ledgers ${first}-${last}; head ${this.head}, lag ${this.lag}`);
    } else {
      this.logger.debug?.(`Committed ledger${first === last ? ` ${last}` : `s ${first}-${last}`}`);
    }
    if (this.liveIntentPending) {
      await this.markLiveIntentsDone().then(
        () => (this.liveIntentPending = false),
        (err: unknown) => this.logger.warn(`Could not mark the first-write intent done (retried): ${describe(err)}`),
      );
    }
  }

  /**
   * Ruling R96: a ledger of `batch` cannot be parsed. Nothing of the batch was written (the writer parses all of it
   * first), so the ledgers before the bad one are written with the same writer, then the runner halts. If writing that
   * prefix fails, it is a failed write like any other: recovery, and the next attempt ends here again.
   */
  private async haltOnUnparsable(batch: RawLedger[], err: LedgerParseError): Promise<void> {
    const prefix = batch.filter((ledger) => ledger.header.ledger_index < err.ledgerIndex);
    if (prefix.length > 0) {
      const first = prefix[0].header.ledger_index;
      const last = prefix[prefix.length - 1].header.ledger_index;
      let written: LedgerWriteResult;
      try {
        written = await this.writer.write(prefix);
      } catch (prefixErr) {
        this.writeFailures += 1;
        this.logger.error(
          `Writing ledgers ${first}-${last}, before the ledger ${err.ledgerIndex} that cannot be parsed, failed ` +
            `(run ${this.writer.runId}); recovering from the committed checkpoint: ${describe(prefixErr)}`,
          prefixErr instanceof Error ? prefixErr.stack : undefined,
        );
        await this.recover(prefixErr);
        return;
      }
      this.countUnclassified(written);
      await this.committedBatch(first, last);
    }
    this.batch = [];
    this.batchTxs = 0;
    this.batchSince = 0;
    this.halt(err);
  }

  /**
   * The recovery contract of `LedgerWriter` (ruling R16), retried until it succeeds, the runner stops or halts:
   *  1. wait until nothing of the failed run is running on the server,
   *  2. re-read the committed checkpoint (and its stored hash, which must exist),
   *  3. delete everything above it under a new query id prefix, and wait for that too,
   *  4. carry on with a writer under a new runId, from a pipeline rebuilt at checkpoint + 1.
   * Nothing is written before all of it succeeded.
   */
  private async recover(cause: unknown): Promise<void> {
    const failed = this.writer;
    this.recovering = true;
    this.lastError = describe(cause);
    this.cancelFetches();
    if (this.writeFailures > 1) {
      // The same write keeps failing (e.g. ClickHouse refuses the batch): do not hammer the node and ClickHouse.
      await this.sleep(this.backoff(this.writeFailures - 1));
    }
    let delay = this.opts.backoffInitialMs;
    while (!this.stopping && !this.haltError) {
      try {
        await this.step(awaitQuiescence(this.ch, failed.runId, { timeoutMs: this.opts.quiescenceTimeoutMs }));
        const checkpoint = await this.step(committedCheckpoint(this.ch));
        const hash = checkpoint === undefined ? undefined : await this.step(storedLedgerHash(this.ch, checkpoint));
        if (checkpoint !== undefined && hash === undefined) {
          // Without it the next ledger's parent_hash would go unchecked (ruling R25).
          throw new Error(`The checkpoint ${checkpoint} has no stored hash`);
        }
        await this.assertLease();
        await this.deleteAbove(checkpoint ?? (this.floor as number), 'recovery');
        this.writer = failed.withNewRunId();
        this.reset(checkpoint, hash);
        this.recovering = false;
        this.lastError = undefined;
        this.updateStatus();
        this.logger.log(
          `Recovered: continuing after ledger ${checkpoint ?? this.floor} with run ${this.writer.runId} ` +
            `(the failed run was ${failed.runId})`,
        );
        return;
      } catch (err) {
        if (this.stopping || this.haltError) return;
        this.lastError = describe(err);
        this.logger.error(
          `Recovery is stuck, so nothing is written until it succeeds (retry in ${delay} ms): ${describe(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.opts.backoffMaxMs);
      }
    }
  }

  /** `deleteLedgersAbove` under a fresh query id prefix, then wait until the deletes (mutations) are done. */
  private async deleteAbove(checkpoint: number, purpose: string): Promise<void> {
    const queryIdPrefix = `${purpose}-${randomUUID()}`;
    await this.step(deleteLedgersAbove(this.ch, checkpoint, { queryIdPrefix }));
    await this.step(awaitQuiescence(this.ch, queryIdPrefix, { timeoutMs: this.opts.quiescenceTimeoutMs }));
  }

  /**
   * A boot or recovery step that stop() may cut short (it throws `StoppedError` then). The abandoned statement may keep
   * running on the server. Only a delete matters: it is a mutation, which touches only the parts that existed when it was
   * created (never rows written later), and the next boot, after its own delete, waits for every unfinished mutation on
   * the ledger tables (`awaitQuiescence`) before it writes. Abandoned reads are harmless.
   */
  private async step<T>(promise: Promise<T>): Promise<T> {
    const result = await abortable(promise, this.stopAbort.signal);
    if (result === ABORTED) throw new StoppedError();
    return result;
  }

  /** Rebuild the pipeline after `checkpoint` (undefined: after the floor). Fetches of the old pipeline are dropped. */
  private reset(checkpoint: number | undefined, hash: string | undefined): void {
    this.cancelFetches();
    this.batch = [];
    this.batchTxs = 0;
    this.batchSince = 0;
    this.pendingBreak = undefined;
    this.committed = checkpoint;
    this.tipHash = hash;
    this.nextToAccept = (checkpoint ?? (this.floor as number)) + 1;
    this.nextToFetch = this.nextToAccept;
  }

  private cancelFetches(): void {
    this.generation += 1;
    this.fetchAbort.abort();
    this.fetchAbort = new AbortController();
    this.ready.clear();
  }

  /**
   * Halt for good (chain break, a ledger that cannot be parsed, lost lease): nothing is fetched or written any more;
   * liveliness fails, and `syncer_ingest_halts_total{reason}` counts it.
   */
  private halt(err: Error): void {
    if (this.haltError) return;
    this.haltError = err;
    this.state = 'halted';
    this.metrics?.ingestHaltsTotal.inc({ reason: haltReason(err) });
    this.cancelFetches();
    this.notify();
    this.logger.error(`Ingest halted until an operator intervenes: ${err.message}`);
  }

  // =================================================================================================================
  // Status, waiting, stopping
  // =================================================================================================================

  /** The highest ledger that counts as done: the checkpoint, or the floor while nothing is committed. */
  private committedTip(): number | undefined {
    return this.committed ?? this.floor;
  }

  private updateStatus(): void {
    const tip = this.committedTip();
    this.lag = this.head !== undefined && tip !== undefined ? Math.max(0, this.head - tip) : undefined;
    if (this.lag !== undefined) this.metrics?.lagLedgers.set(this.lag);
    if (this.committed !== undefined) this.metrics?.checkpointLedger.set(this.committed);
    if (this.state === 'halted') return;
    if (!this.prepared) this.state = 'starting';
    else this.state = this.lag !== undefined && this.lag <= 1 ? 'live' : 'catching_up';
  }

  /** How long the loop may sleep: until the batch is due, or the head is due for a poll. */
  private waitBudget(): number {
    const now = Date.now();
    // A poll in flight wakes the loop when it ends; until then the head needs no other attention.
    let ms = this.polling
      ? this.opts.headSilenceMs
      : Math.max(this.lastHintAt, this.lastPollAt) + this.opts.headSilenceMs - now;
    if (this.batch.length > 0) ms = Math.min(ms, this.batchSince + this.cfg.catchupFlushMs - now);
    return Math.max(ms, MIN_WAIT_MS);
  }

  private notify(): void {
    this.dirty = true;
    this.wake?.();
  }

  /** Sleep up to `ms`, or until `notify()` (a fetch landed, the head moved, a halt, stop). */
  private idle(ms: number): Promise<void> {
    if (this.dirty || this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** A timer that ends early when `signal` aborts (default: on stop). */
  private sleep(ms: number, signal: AbortSignal = this.stopAbort.signal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private backoff(attempt: number): number {
    return Math.min(this.opts.backoffInitialMs * 2 ** Math.max(0, attempt - 1), this.opts.backoffMaxMs);
  }

  /** `fn()` until it succeeds; a failure is logged and retried with backoff. Undefined when stopped or halted first. */
  private async untilDone<T>(what: string, level: 'warn' | 'error', fn: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; !this.stopping && !this.haltError; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ChainBreakError) throw err;
        if (this.stopping || this.haltError) break;
        // A rate-limited node asks for a wait of its own (ruling R98).
        const delay = Math.max(this.backoff(attempt), retryAfterMsOf(err));
        if (level === 'error') {
          this.recovering = true;
          this.lastError = describe(err);
          this.logger.error(
            `Could not ${what}, nothing is written until it succeeds (retry in ${delay} ms): ${describe(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        } else {
          this.logger.warn(`Could not ${what} (retry in ${delay} ms): ${describe(err)}`);
        }
        await this.sleep(delay);
      }
    }
    return undefined;
  }

  private assertUsable(): void {
    if (this.stopping) throw new Error('The LiveRunner is stopped');
    if (this.haltError) throw this.haltError;
  }

  private async shutDown(): Promise<void> {
    this.stopping = true;
    this.stopAbort.abort();
    this.cancelFetches();
    this.notify();
    this.headHints.off('ledgerClosed', this.onLedgerClosed);
    clearInterval(this.heartbeatTimer);
    await this.lease?.catch(() => undefined); // a lease being taken right now is released below, not left beating
    await this.running;
    await this.releaseLease();
  }
}

/** `promise`, or `ABORTED` as soon as `signal` aborts (the promise is abandoned, its rejection swallowed). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** A ledger index from a stream message (a number, or a decimal string on some servers). */
function toLedgerIndex(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** The `reason` label of `syncer_ingest_halts_total` for the error the runner halted on. */
function haltReason(err: Error): string {
  if (err instanceof ChainBreakError) return 'chain_break';
  if (err instanceof LeaseLostError) return 'lease_lost';
  if (isLedgerParseError(err)) return 'parse_error';
  return 'other';
}

/** `name: message`, plus the ClickHouse error code when there is one. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, type } = err as Error & { code?: unknown; type?: unknown };
  const detail = [code, type].filter((part) => part !== undefined && part !== '').join(' ');
  return `${err.name}: ${err.message}${detail ? ` (${detail})` : ''}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

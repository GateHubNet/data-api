import {
  awaitQuiescence,
  ClickHouseService,
  committedCheckpoint,
  deleteLedgersAbove,
  LedgerSource,
  LedgerWriter,
  RawLedger,
  storedLedgerHash,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { NODE_CLIENT, SyncerConfig } from '../config/syncer.config';
import { ShutdownSignals } from '../core/shutdown-signals';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** The `LedgerSource` the live runner reads from (an `RpcLedgerSource` in the app). */
export const LEDGER_SOURCE = Symbol('LEDGER_SOURCE');
/** Optional `LiveRunnerOptions` (timings, logger); tests shorten the timings. */
export const LIVE_RUNNER_OPTIONS = Symbol('LIVE_RUNNER_OPTIONS');

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
  /** A lease whose last heartbeat is younger than this belongs to its holder. Default 30000. */
  leaseTtlMs?: number;
  /** Heartbeat interval of the lease. Default 10000. */
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

/**
 * The live ingest loop: the single writer of a network's ledger tables.
 *
 * **Boot** (`onApplicationBootstrap`): take the `syncer_lease` (refused while another holder's heartbeat is younger than
 * 30 s), then, in the background: verify that the node confirms the hash stored for the committed checkpoint (else
 * halt), delete the uncommitted tail above it, and continue at checkpoint + 1. With no checkpoint the start is
 * `GH_SYNC_START_LEDGER` (default: the validated head), and the rows above start - 1 are deleted first (what a crashed
 * first write left).
 *
 * **Loop.** The head is the highest `ledgerClosed` hint of the node client, or a poll of `validatedHead()` when no hint
 * has arrived for 15 s; it never goes down, so the lag stays defined while the node is away. Up to `catchupConcurrency`
 * ledgers are fetched at once, by index, each retried forever with a capped backoff (a ledger is never skipped). Fetched
 * ledgers are reordered and accepted in index order, each only if its `parent_hash` is the hash of the one before (else
 * the verified prefix is committed and the runner halts). Accepted ledgers are written as one batch when it holds
 * `catchupFlushLedgers` ledgers or `catchupFlushTxs` transactions, is `catchupFlushMs` old, or reaches to within one
 * ledger of the head: live, every ledger is its own commit.
 *
 * **A failed write** is recovered as `LedgerWriter` documents (ruling R16): wait until the failed run's queries are gone,
 * re-read the checkpoint, delete everything above it and wait for that too, carry on with a writer under a new runId and
 * a pipeline rebuilt from checkpoint + 1. A recovery step that fails (a stuck mutation) is logged as an error, shown in
 * the status, and retried with backoff; nothing is written until it succeeds.
 *
 * **Shutdown** (`onModuleDestroy`, or SIGTERM through `ShutdownSignals`): stop the loop (a write in progress finishes, a
 * partial batch is dropped and refetched next time) and release the lease.
 */
@Injectable()
export class LiveRunner implements OnApplicationBootstrap, OnModuleDestroy {
  /** `hostname:pid:bootId`, written to `syncer_lease`. */
  readonly holder = `${hostname()}:${process.pid}:${randomUUID()}`;

  private readonly opts: typeof DEFAULTS;
  private readonly logger: RunnerLogger;

  private state: RunnerState = 'starting';
  private recovering = false;
  private lastError?: string;
  private haltError?: ChainBreakError;
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
  /** Consecutive failed writes; slows down a write that fails again and again (a ledger the parser rejects). */
  private writeFailures = 0;

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
  private heartbeatTimer?: NodeJS.Timeout;
  private beating?: Promise<void>;
  private lastBeatMs = 0;

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
   * and resolve. Rejects with `ChainBreakError` when the chain breaks (the runner is then halted). Not for use while the
   * background loop runs.
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
        if (target === undefined) return;
        await this.pipeline(() => (this.committedTip() ?? 0) >= target);
      } catch (err) {
        if (err instanceof ChainBreakError) this.halt(err);
        throw err;
      }
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
      const age = Date.now() - current.heartbeatMs;
      if (age < this.opts.leaseTtlMs) throw new Error(`Another syncer holds the lease (${current.holder})`);
      this.logger.warn(
        `Taking over the lease of ${current.holder}, whose last heartbeat is ${Math.round(age / 1000)} s old`,
      );
    }
    await this.writeHeartbeat();
    this.leaseHeld = true;
    this.logger.log(`Holding the ${this.cfg.network} syncer lease as ${this.holder}`);
    if (this.stopping) return; // stop() releases it as soon as this returns
    this.heartbeatTimer = setInterval(() => {
      this.beating ??= this.writeHeartbeat()
        .catch((err) => this.logger.warn(`Lease heartbeat failed: ${describe(err)}`))
        .finally(() => (this.beating = undefined));
    }, this.opts.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  /** The newest lease row of this network; `holder` is '' when there is none or it was released. */
  private async currentLease(): Promise<{ holder: string; heartbeatMs: number }> {
    const row = await this.ch.queryOne<{ holder: string; heartbeat_ms: string | number }>(
      `SELECT argMax(holder, heartbeat) AS holder, toUnixTimestamp64Milli(max(heartbeat)) AS heartbeat_ms
         FROM ${Table.SyncerLease} WHERE network = {network:String}`,
      { network: this.cfg.network },
    );
    return { holder: row?.holder ?? '', heartbeatMs: Number(row?.heartbeat_ms ?? 0) };
  }

  /**
   * One lease row for this holder. `heartbeat` is a DateTime64(3), which reads a JSON number as (fractional) seconds:
   * a millisecond integer would land thousands of years in the future.
   */
  private async writeHeartbeat(holder = this.holder): Promise<void> {
    // Strictly increasing, so that the release row is always the newest (argMax / ReplacingMergeTree(heartbeat)).
    const ms = Math.max(Date.now(), this.lastBeatMs + 1);
    this.lastBeatMs = ms;
    await this.ch.insert(Table.SyncerLease, [{ network: this.cfg.network, holder, heartbeat: ms / 1000 }]);
  }

  /**
   * Hand the lease back so that the next syncer can start at once instead of waiting out the TTL. The table keeps the row
   * with the highest heartbeat (ReplacingMergeTree(heartbeat), read with argMax), so a release is a newer row with an
   * empty holder; a row with heartbeat 0 would never be the one read. Skipped when someone else holds the lease by now.
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
      await this.writeHeartbeat('');
      this.logger.log('Released the syncer lease');
    } catch (err) {
      this.logger.warn(`Could not release the lease (it expires on its own): ${describe(err)}`);
    }
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
        (err: unknown) => this.logger.warn(`Polling the validated head failed: ${describe(err)}`),
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
    while (!this.stopping) {
      try {
        await this.prepare();
        await this.pipeline(() => false);
        return;
      } catch (err) {
        if (err instanceof ChainBreakError) {
          this.halt(err);
          return;
        }
        if (this.stopping) return;
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
   * with nothing committed, delete above start - 1. Transient failures are retried; throws `ChainBreakError`.
   */
  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await this.untilDone('prepare the ingest checkpoint', 'error', async () => {
      const checkpoint = await committedCheckpoint(this.ch);
      this.committed = checkpoint;
      this.updateStatus();
      if (checkpoint === undefined) {
        const start = this.cfg.syncStartLedger ?? (await this.source.validatedHead());
        await this.deleteAbove(start - 1, 'boot');
        this.floor = start - 1;
        this.reset(undefined, undefined);
        this.logger.log(`Nothing is committed yet: starting at ledger ${start}`);
      } else {
        const stored = await storedLedgerHash(this.ch, checkpoint);
        if (stored === undefined) throw new Error(`The checkpoint ${checkpoint} has no stored hash`);
        const ledger = await this.fetchLedger(checkpoint, this.stopAbort.signal);
        if (ledger === undefined) return; // stopping
        if (ledger.header.ledger_hash !== stored) {
          throw new ChainBreakError(
            `The node's ledger ${checkpoint} has hash ${ledger.header.ledger_hash}, ` +
              `but the committed checkpoint ${checkpoint} is stored with hash ${stored}`,
            checkpoint,
          );
        }
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

  /** Fetch, accept and write ledgers until `done()` (checked between steps) or stop. Throws `ChainBreakError`. */
  private async pipeline(done: () => boolean): Promise<void> {
    while (!this.stopping && this.prepared && !done()) {
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

  /** `source.fetch(index)`, retried forever with a capped backoff; undefined once `signal` aborts. Never rejects. */
  private async fetchLedger(index: number, signal: AbortSignal): Promise<RawLedger | undefined> {
    let delay = this.opts.backoffInitialMs;
    for (let attempt = 1; !signal.aborted; attempt++) {
      try {
        const ledger = await this.source.fetch(index);
        if (ledger.header.ledger_index !== index) {
          throw new Error(`Ledger ${index} was requested but ledger ${ledger.header.ledger_index} came back`);
        }
        return ledger;
      } catch (err) {
        if (signal.aborted) break;
        this.logger.warn(
          `Fetching ledger ${index} failed (attempt ${attempt}, retry in ${delay} ms): ${describe(err)}`,
        );
        await this.sleep(delay, signal);
        delay = Math.min(delay * 2, this.opts.backoffMaxMs);
      }
    }
    return undefined;
  }

  /** Move fetched ledgers into the batch in index order while each one chains to the one before. */
  private accept(head: number): void {
    while (!this.pendingBreak) {
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
      if (this.shouldFlush(head)) return;
    }
  }

  private shouldFlush(head: number): boolean {
    if (this.pendingBreak) return true;
    if (this.batch.length === 0) return false;
    const tip = this.nextToAccept - 1;
    return (
      head - tip <= 1 ||
      this.batch.length >= this.cfg.catchupFlushLedgers ||
      this.batchTxs >= this.cfg.catchupFlushTxs ||
      Date.now() - this.batchSince >= this.cfg.catchupFlushMs
    );
  }

  /** Write the batch (a failure is recovered), then raise a pending chain break: the verified prefix is committed first. */
  private async flush(): Promise<void> {
    const batch = this.batch;
    if (batch.length > 0) {
      const first = batch[0].header.ledger_index;
      const last = batch[batch.length - 1].header.ledger_index;
      try {
        await this.writer.write(batch);
      } catch (err) {
        this.writeFailures += 1;
        this.logger.error(
          `Writing ledgers ${first}-${last} failed (run ${this.writer.runId}); recovering from the committed checkpoint: ` +
            describe(err),
          err instanceof Error ? err.stack : undefined,
        );
        await this.recover(err);
        return;
      }
      this.writeFailures = 0;
      this.batch = [];
      this.batchTxs = 0;
      this.batchSince = 0;
      this.committed = last;
      this.lastCommitAt = Date.now() / 1000;
      this.metrics?.lastCommitTimestampSeconds.set(this.lastCommitAt);
      this.updateStatus();
      if (this.state === 'catching_up') {
        this.logger.log(`Committed ledgers ${first}-${last}; head ${this.head}, lag ${this.lag}`);
      } else {
        this.logger.debug?.(`Committed ledger${first === last ? ` ${last}` : `s ${first}-${last}`}`);
      }
    }
    if (this.pendingBreak) throw this.pendingBreak;
  }

  /**
   * The recovery contract of `LedgerWriter` (ruling R16), retried until it succeeds or the runner stops:
   *  1. wait until nothing of the failed run is running on the server,
   *  2. re-read the committed checkpoint,
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
      // The same write keeps failing (e.g. a ledger the parser rejects): do not hammer the node and ClickHouse.
      await this.sleep(this.backoff(this.writeFailures - 1));
    }
    let delay = this.opts.backoffInitialMs;
    while (!this.stopping) {
      try {
        await awaitQuiescence(this.ch, failed.runId, { timeoutMs: this.opts.quiescenceTimeoutMs });
        const checkpoint = await committedCheckpoint(this.ch);
        await this.deleteAbove(checkpoint ?? (this.floor as number), 'recovery');
        const hash = checkpoint === undefined ? undefined : await storedLedgerHash(this.ch, checkpoint);
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
    await deleteLedgersAbove(this.ch, checkpoint, { queryIdPrefix });
    await awaitQuiescence(this.ch, queryIdPrefix, { timeoutMs: this.opts.quiescenceTimeoutMs });
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

  private halt(err: ChainBreakError): void {
    this.haltError = err;
    this.state = 'halted';
    this.cancelFetches();
    this.logger.error(`Chain break, ingest halted until an operator intervenes: ${err.message}`);
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

  /** Sleep up to `ms`, or until `notify()` (a fetch landed, the head moved, stop). */
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

  /** `fn()` until it succeeds; a failure is logged and retried with backoff. Undefined when stopped first. */
  private async untilDone<T>(what: string, level: 'warn' | 'error', fn: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ChainBreakError) throw err;
        if (this.stopping) break;
        const delay = this.backoff(attempt);
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

/** A ledger index from a stream message (a number, or a decimal string on some servers). */
function toLedgerIndex(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

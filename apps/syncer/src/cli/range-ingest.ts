import {
  awaitQuiescence,
  buildLedgerRows,
  clickHouseConfigFromEnv,
  ClickHouseService,
  committedCheckpoint,
  deleteLedgerRange,
  getNetworkProfile,
  isLedgerParseError,
  LedgerNotAvailableError,
  LedgerSource,
  LedgerWriter,
  LedgerWriteResult,
  NodeClient,
  ParseContext,
  parseContextFor,
  RawLedger,
  retryAfterMsOf,
  Table,
  throttleHint,
  wait,
} from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadSyncerConfig } from '../config/syncer.config';
import { migrateOnBoot } from '../core/migrate-on-boot';
import { createNodeClient } from '../core/node-client.provider';
import { LEDGERS_PARTITION_SIZE, LIVE_INTENT_PREFIX } from '../ingest/live-runner';
import { RpcLedgerSource } from '../ingest/rpc-ledger-source';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

export interface RangeIngestOptions {
  /** First ledger of the range (inclusive), at least 1. */
  from: number;
  /** Last ledger of the range (inclusive). */
  to: number;
  /**
   * Ingest only these ledgers, and only those of them that lie inside `[from, to]` (the others are never fetched). Without
   * it every ledger of `[from, to]` is ingested, and a ledger the source does not have fails the run.
   */
  indexes?: number[];
  /**
   * Ledgers per chunk. Chunks are aligned to multiples of it, so that a chunk never spans two `ledgers` partitions: it
   * must divide 1,000,000. Default 1000. A chunk is fetched and written as a whole, so it is also the memory the run needs.
   */
  chunkSize?: number;
  /** Ledgers of a chunk fetched at once. Default 8. */
  concurrency?: number;
  /** Delete and rewrite the ledgers in the range even if they are committed. Default false: those are skipped. */
  reprocess?: boolean;
  /**
   * Allow a range that starts above the live checkpoint + 1 on a database a live syncer has run on (ruling R110). The
   * live syncer resumes after the highest committed ledger, so the ledgers between the checkpoint and `from` would be
   * skipped for good unless something else fills them. Default false: such a range is refused.
   */
  allowGap?: boolean;
  /**
   * Names this invocation in `ingest_log.run_id`, in the dedup tokens and in the query ids of its inserts. A per-invocation
   * nonce is appended (`${runId}:${nonce}`): the dedup log of the tables survives a DELETE, so reusing a `runId` after
   * a delete would silently drop the rows of the rewrite. Must not start with `live:` (the live runner's intents).
   */
  runId?: string;

  // The options below are not part of the ingest's contract: they exist for the CLI and for tests.

  /** Network name of the `syncer_lease` row to look at. Default: the network whose CTID id is `ctx.networkId`. */
  network?: string;
  /** Attempts per chunk (the first one included) before the run gives up. Default 3. */
  maxAttempts?: number;
  /** Wait before the second attempt of a chunk; it doubles per attempt (at most 30 s). Default 500. */
  retryBackoffMs?: number;
  /**
   * How long the fetches of one chunk may go without a ledger arriving while they wait out transient failures (rulings
   * R100, R105): a rate-limited node (as long as it asks) and a ledger the node does not have right now (`lgrNotFound`,
   * retried after `retryBackoffMs`, doubling to 30 s). Every ledger fetched starts it again; a chunk fails only when this
   * long passes with no ledger fetched (or a wait would end after that and nothing else can arrive before it). Default
   * 1200000 (20 min, the longest pause the node client honours).
   */
  maxTransientWaitMs?: number;
  /** A live syncer's lease younger than this (server clock) is fresh. Default 30000, the live runner's TTL. */
  leaseFreshMs?: number;
  /** `awaitQuiescence` timeout (before the kill, and again after it). Default 60000. */
  quiescenceTimeoutMs?: number;
  /** Default: a Nest `Logger` with context `RangeIngest`. */
  logger?: RangeLogger;
  /**
   * Where `syncer_amm_unclassified_total` is counted: the pools of AMM transactions the parser could make no row for, in
   * the ledgers this run wrote (once per write that committed; a ledger found committed and skipped adds nothing).
   * Default: a `PrometheusService`, whose counters are the process-wide ones. Tests pass their own.
   */
  metrics?: Pick<PrometheusService, 'ammUnclassifiedTotal'>;
}

export interface RangeLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: unknown): void;
}

export interface RangeIngestResult {
  /** Chunks that are complete when the run ends: written by it, or found committed already. */
  chunksDone: number;
  /** Ledgers this run wrote. Ledgers it found committed (and did not reprocess) are not counted. */
  ledgers: number;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_LEASE_FRESH_MS = 30_000;
const DEFAULT_MAX_TRANSIENT_WAIT_MS = 20 * 60_000;
/** The pause after a rate-limit answer that names no wait, as the node client takes it. */
const DEFAULT_THROTTLE_WAIT_MS = 10_000;
const DEFAULT_QUIESCENCE_TIMEOUT_MS = 60_000;
const MAX_LEDGER_INDEX = 2 ** 32 - 1;
const HOUR_SECONDS = 3600;

/**
 * The fetch phase of one chunk (rulings R100, R105): when the last ledger arrived, what each worker is doing (fetching,
 * or waiting until a time to fetch again), and whether the chunk has failed. A waiting worker sleeps until its time, but
 * wakes on every change (a ledger arrived, a worker finished, the chunk failed) to look again.
 */
class FetchPhase {
  /** When the last ledger of the chunk arrived (the start of the phase before the first). */
  private lastProgress = Date.now();
  /** Per worker: 0 while it fetches, else the time it fetches again. Finished workers are not in it. */
  private readonly next = new Map<number, number>();
  private readonly sleepers = new Set<() => void>();
  failed = false;

  constructor(readonly maxWaitMs: number) {}

  /** The time after which the chunk has gone `maxWaitMs` without a ledger. */
  get deadline(): number {
    return this.lastProgress + this.maxWaitMs;
  }

  fetching(worker: number): void {
    this.next.set(worker, 0);
  }

  waiting(worker: number, until: number): void {
    this.next.set(worker, until);
  }

  progress(): void {
    this.lastProgress = Date.now();
    this.wakeAll();
  }

  finished(worker: number): void {
    this.next.delete(worker);
    this.wakeAll();
  }

  fail(): void {
    this.failed = true;
    this.wakeAll();
  }

  /**
   * No ledger can arrive before the deadline: every worker waits until it or later (a fetching one counts as arriving
   * now). With a budget of 0 that is always so: nothing is waited for.
   */
  hopeless(now: number): boolean {
    let earliest = Number.POSITIVE_INFINITY;
    for (const at of this.next.values()) earliest = Math.min(earliest, at === 0 ? now : at);
    return earliest >= this.deadline;
  }

  /** Sleep until `until`, or until the next change of the phase, whichever comes first. */
  sleep(until: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, until - Date.now()));
      this.sleepers.add(wake);
    });
  }

  private wakeAll(): void {
    for (const wake of [...this.sleepers]) wake();
  }
}

/** Thrown by a fetch that gave up because another fetch of its chunk failed: not a failure of its own. */
class FetchAbandoned extends Error {}

/** A run of ledgers that is ingested and logged as one: it lies inside one aligned `chunkSize` bucket. */
interface Chunk {
  /** Lowest and highest ledger of `targets`: the key of the chunk in `ingest_log`. */
  start: number;
  end: number;
  /** The ledgers to ingest, ascending: `start..end` for a range, the listed indexes of the bucket for an index list. */
  targets: number[];
}

/** An `ingest_log` chunk whose newest row says 'started'. */
interface CloseWindow {
  min: number;
  max: number;
}

interface OpenIntent {
  start: number;
  end: number;
  runId: string;
}

const isLedgerIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LEDGER_INDEX;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ingests the ledgers `[from, to]` (or the listed `indexes` among them) from `source` into ClickHouse, in aligned chunks
 * of `chunkSize` ledgers, one chunk after the other. It is the entry point of historical loads: the CLI of this file
 * feeds it an `RpcLedgerSource`, and an importer of older data feeds it any other `LedgerSource`.
 *
 * **Per chunk** (the key of a chunk in `ingest_log` is `(first ledger, last ledger)` of the chunk):
 *  1. The ledgers of the chunk that are already committed (they have a `ledgers` row) are skipped, unless `reprocess`
 *     is set: then all of its ledgers are replaced.
 *  2. `ingest_log` gets a 'started' row (with the `run_id` of the attempt) before anything is deleted or written.
 *  3. The ledgers to write are fetched (up to `concurrency` at once). When they replace committed ones, each is also
 *     parsed (nothing is kept of that), so that a ledger the source lacks, a node that keeps failing or a parser that
 *     rejects a ledger leaves the committed chunk untouched.
 *  4. The live-syncer check (below) is repeated, the old ledgers of a replaced chunk are deleted, and the new ones are
 *     written with one `LedgerWriter.write()`.
 *  5. `ingest_log` gets a 'done' row, and `agg_dirty` a row for the chunk. A chunk with nothing to write is complete
 *     without any log row.
 *
 * **An unfinished intent** is a chunk whose newest `ingest_log` row says 'started': a run died, or gave up, in the middle
 * of it. At the start the runs of the intents that overlap `[from, to]` are waited for (`awaitQuiescence`); then, before
 * the first chunk, each of them is redone over its own recorded range, whatever the chunk size and the range of this run
 * (overlapping ones as one range), marked in `agg_dirty` and closed ('done') right after (rulings R100, R110, see
 * `redoOpenIntents`). `ingest_log` rows with a
 * `live:` run id belong to the live runner (key `(start, 0)`): they are never read as chunks, redone or marked.
 *
 * **Transient fetch failures** (rulings R100, R105): a rate-limited node is asked again when the pause it named is over,
 * a ledger the node does not have right now (`lgrNotFound` from one member of a cluster) after a backoff. A chunk fails
 * only when `maxTransientWaitMs` (20 min) passes without a ledger of it arriving: every ledger fetched starts that time
 * again, so a slow but moving chunk never runs out of it, and a ledger the node really lacks still fails in bounded time.
 *
 * **A failed attempt** is recovered as `LedgerWriter` documents (ruling R16): wait until the failed run's queries are gone,
 * delete the ledgers of the chunk that this run was writing (never a ledger it had skipped), wait for that too, and try
 * again with `writer.withNewRunId()`. A fetch that failed needs none of this: nothing was written, and the fetched
 * ledgers are kept for the next attempt. A `LedgerNotAvailableError`, a ledger the parser rejects (a `LedgerParseError`
 * with the ledger index and the reason: parsing is pure, a retry fails the same way, ruling R96) and a live syncer
 * that appeared are never retried: they stop the run, and the chunk stays an unfinished intent. After `maxAttempts` the
 * error is thrown the same way.
 *
 * **A live syncer** owns everything above its checkpoint (ruling R27): a range that reaches above the committed
 * checkpoint is refused while a lease younger than 30 s (on the server's clock) is held, and is checked again for every
 * chunk after its ledgers were fetched, in case a live syncer started in the meantime. On a database a live syncer has
 * run on, a range that starts above the checkpoint + 1 is refused unless `allowGap` (ruling R110): the live syncer
 * resumes after the highest committed ledger and would skip the ledgers in between.
 *
 * **`agg_dirty`.** Every chunk that was written gets a row right after its 'done', from the close times of its ledgers,
 * from the start of the hour of the earliest to the end of the hour of the latest, so that the aggregator recomputes
 * them. A run that is killed therefore loses no mark of the chunks it finished. The committed ledgers a run skips get one
 * row at the end (their close times are read from `ledgers`): it also covers chunks that an earlier run finished but
 * could not mark.
 *
 * Two range ingests over overlapping ranges must not run at the same time.
 */
export async function rangeIngest(
  source: LedgerSource,
  ch: ClickHouseService,
  ctx: ParseContext,
  opts: RangeIngestOptions,
): Promise<RangeIngestResult> {
  return new RangeRunner(source, ch, ctx, opts).run();
}

class RangeRunner {
  private readonly from: number;
  private readonly to: number;
  private readonly indexes?: number[];
  private readonly chunkSize: number;
  private readonly concurrency: number;
  private readonly reprocess: boolean;
  private readonly allowGap: boolean;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly maxTransientWaitMs: number;
  private readonly leaseFreshMs: number;
  private readonly quiescenceTimeoutMs: number;
  private readonly network: string;
  private readonly logger: RangeLogger;
  /** The effective run id of the invocation (a user supplied one plus the nonce). */
  private readonly runId: string | undefined;

  private writer: LedgerWriter;
  private open: OpenIntent[] = [];
  /**
   * Why a fetch gave up on a transient failure (for the log): the chunk went `maxTransientWaitMs` without a ledger, or the
   * node asked for a pause longer than that, which fails at once.
   */
  private readonly outOfTime = new WeakMap<object, string>();
  /** The ledgers the redo of the unfinished intents wrote in this run (and marked in agg_dirty). */
  private readonly redone = new Set<number>();
  private readonly metrics: Pick<PrometheusService, 'ammUnclassifiedTotal'>;
  /** Pools of AMM transactions the parser made no row for, in what this run wrote: for the log at the end. */
  private ammUnclassified = 0;

  private chunksDone = 0;
  /** Of `chunksDone`, the chunks that needed no write. */
  private chunksSkipped = 0;
  private ledgersWritten = 0;
  /** Earliest and latest close time (unix seconds), read from `ledgers`, of the committed ledgers this run skipped. */
  private skippedWindow?: CloseWindow;

  constructor(
    private readonly source: LedgerSource,
    private readonly ch: ClickHouseService,
    private readonly ctx: ParseContext,
    opts: RangeIngestOptions,
  ) {
    const { from, to } = opts;
    if (!isLedgerIndex(from) || !isLedgerIndex(to) || from > to) {
      throw new RangeError(
        `Invalid ledger range [${from},${to}]: from and to must be integers from 1 to ${MAX_LEDGER_INDEX}, from <= to`,
      );
    }
    this.from = from;
    this.to = to;

    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!isPositiveInteger(this.chunkSize) || LEDGERS_PARTITION_SIZE % this.chunkSize !== 0) {
      throw new RangeError(
        `chunkSize ${this.chunkSize} must be a positive integer that divides ${LEDGERS_PARTITION_SIZE} ` +
          '(the size of a ledgers partition), so that no chunk spans two partitions',
      );
    }
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!isPositiveInteger(this.concurrency)) {
      throw new RangeError(`concurrency must be a positive integer, got ${this.concurrency}`);
    }
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!isPositiveInteger(this.maxAttempts)) {
      throw new RangeError(`maxAttempts must be a positive integer, got ${this.maxAttempts}`);
    }
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxTransientWaitMs = opts.maxTransientWaitMs ?? DEFAULT_MAX_TRANSIENT_WAIT_MS;
    if (typeof this.maxTransientWaitMs !== 'number' || !(this.maxTransientWaitMs >= 0)) {
      throw new RangeError(`maxTransientWaitMs must be a non-negative number, got ${this.maxTransientWaitMs}`);
    }
    this.leaseFreshMs = opts.leaseFreshMs ?? DEFAULT_LEASE_FRESH_MS;
    this.quiescenceTimeoutMs = opts.quiescenceTimeoutMs ?? DEFAULT_QUIESCENCE_TIMEOUT_MS;
    this.reprocess = opts.reprocess ?? false;
    this.allowGap = opts.allowGap ?? false;

    if (opts.indexes !== undefined) {
      for (const index of opts.indexes) {
        if (!isLedgerIndex(index)) {
          throw new RangeError(
            `Invalid ledger index ${index} in indexes: expected an integer from 1 to ${MAX_LEDGER_INDEX}`,
          );
        }
      }
      this.indexes = [...new Set(opts.indexes.filter((i) => i >= from && i <= to))].sort((a, b) => a - b);
    }

    if (opts.runId !== undefined) {
      if (typeof opts.runId !== 'string' || opts.runId === '' || opts.runId.startsWith(LIVE_INTENT_PREFIX)) {
        throw new RangeError(
          `runId must be a non-empty string that does not start with "${LIVE_INTENT_PREFIX}" (the live runner's intents)`,
        );
      }
      this.runId = `${opts.runId}:${randomUUID()}`;
    }

    this.network = opts.network ?? networkOf(ctx);
    this.logger = opts.logger ?? new Logger('RangeIngest');
    this.metrics = opts.metrics ?? new PrometheusService();
    this.writer = new LedgerWriter(ch, ctx, { runId: this.runId });
  }

  async run(): Promise<RangeIngestResult> {
    let failure: unknown;
    try {
      await this.assertNoLiveSyncer(this.to);
      await this.assertNoGap();
      await this.waitForOpenIntents();
      await this.redoOpenIntents();
      for (const chunk of this.chunks()) {
        await this.assertNoLiveSyncer(chunk.end);
        await this.ingestChunk(chunk);
        this.chunksDone += 1;
      }
    } catch (err) {
      failure = err;
    }

    try {
      // The committed ledgers this run skipped: an earlier run may have been killed before it marked them.
      if (this.skippedWindow) await this.markAggregatesDirty(this.skippedWindow);
    } catch (err) {
      if (failure === undefined) failure = err;
      else this.logger.error(`Could not mark the skipped hours in agg_dirty: ${describe(err)}`);
    }

    if (this.ammUnclassified > 0) {
      this.logger.warn(
        `${this.ammUnclassified} AMM pool${this.ammUnclassified === 1 ? '' : 's'} in the ledgers written could not be ` +
          'classified (no swap, liquidity or governance row, or an unknown pair): see syncer_amm_unclassified_total',
      );
    }
    if (failure !== undefined) throw failure;
    this.logger.log(
      `Range [${this.from},${this.to}] ingested: ${this.chunksDone} chunks complete ` +
        `(${this.chunksSkipped} had nothing to write), ${this.ledgersWritten} ledgers written`,
    );
    return { chunksDone: this.chunksDone, ledgers: this.ledgersWritten };
  }

  // =================================================================================================================
  // Chunks
  // =================================================================================================================

  /** The chunks of the run, lazily: ascending, each inside one aligned bucket of `chunkSize` ledgers. */
  private *chunks(): Generator<Chunk> {
    const make = (targets: number[]): Chunk => ({ start: targets[0], end: targets[targets.length - 1], targets });
    if (this.indexes) {
      let bucket = -1;
      let current: number[] = [];
      for (const index of this.indexes) {
        const b = Math.floor(index / this.chunkSize);
        if (b !== bucket && current.length > 0) {
          yield make(current);
          current = [];
        }
        bucket = b;
        current.push(index);
      }
      if (current.length > 0) yield make(current);
      return;
    }
    for (let b = Math.floor(this.from / this.chunkSize); b <= Math.floor(this.to / this.chunkSize); b++) {
      const start = Math.max(this.from, b * this.chunkSize);
      const end = Math.min(this.to, (b + 1) * this.chunkSize - 1);
      yield make(Array.from({ length: end - start + 1 }, (_, k) => start + k));
    }
  }

  private async ingestChunk(chunk: Chunk): Promise<void> {
    const startedAt = Date.now();
    const committed = await this.committedIn(chunk.start, chunk.end);
    // The unfinished intents were redone and closed before the first chunk (`redoOpenIntents`).
    const redo = this.reprocess;
    const toWrite = redo ? chunk.targets : chunk.targets.filter((i) => !committed.has(i));
    if (!redo) {
      // A ledger the redo of an intent wrote in this run is marked in agg_dirty already.
      for (const index of chunk.targets) if (!this.redone.has(index)) this.noteSkipped(committed.get(index));
    }
    if (toWrite.length === 0) {
      this.chunksSkipped += 1;
      return;
    }
    // Ledgers of the span that this run keeps: a delete must not reach them.
    const writing = new Set(toWrite);
    const spans = deleteSpans(
      toWrite,
      [...committed.keys()].filter((i) => !writing.has(i)).sort((a, b) => a - b),
    );

    const ledgers = await this.writeWithRecovery(chunk, toWrite, spans, redo);
    await this.logIntent(chunk, this.writer.runId, 'done');
    // Marked now, not when the run ends: a run that is killed would leave these hours unmarked, and its rerun skips them.
    await this.markAggregatesDirty(closeWindowOf(ledgers));

    this.ledgersWritten += ledgers.length;
    this.logger.log(
      `Chunk [${chunk.start},${chunk.end}] done in ${Date.now() - startedAt} ms: ${ledgers.length} ledgers written` +
        (redo ? ' (redone)' : `, ${chunk.targets.length - ledgers.length} already committed`),
    );
  }

  private noteSkipped(closeTime: number | undefined): void {
    if (closeTime === undefined) return;
    const window = (this.skippedWindow ??= { min: closeTime, max: closeTime });
    window.min = Math.min(window.min, closeTime);
    window.max = Math.max(window.max, closeTime);
  }

  /**
   * Fetch `toWrite` and write it, recovering from a failed attempt as the class description says (`maxAttempts` attempts
   * in all). Returns the ledgers written. With `deleteFirst` the `spans` are deleted before the first write.
   *
   * Nothing is deleted until the replacement is in hand: the ledgers are fetched, and (before a delete) every one of
   * them is parsed, so that a missing ledger, a node that keeps failing or a parser that rejects a ledger leaves the
   * committed rows of the chunk as they were. The live-syncer check is repeated right before the delete and the write,
   * after the time the fetch took.
   */
  private async writeWithRecovery(
    chunk: Chunk,
    toWrite: number[],
    spans: Array<[number, number]>,
    deleteFirst: boolean,
  ): Promise<RawLedger[]> {
    let ledgers: RawLedger[] | undefined;
    let parsed = false;
    let needsCleanup = deleteFirst;
    /** Runs whose inserts may still be running on the server: waited for before the delete. */
    const failedRuns: string[] = [];
    /** The run id the chunk's newest 'started' row carries. */
    let loggedRun: string | undefined;
    /** The failure of this attempt would fail again: it is not retried. */
    let permanent = false;
    const unretryable = async <T>(work: () => Promise<T> | T): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        permanent = true;
        throw err;
      }
    };
    for (let attempt = 1; ; attempt++) {
      try {
        // The intent comes before anything is deleted or written ...
        if (loggedRun === undefined) await this.logIntent(chunk, this.writer.runId, 'started');
        loggedRun ??= this.writer.runId;
        ledgers ??= await this.fetchAll(toWrite);
        if (needsCleanup && !parsed) {
          await unretryable(() => ledgers?.forEach((raw) => buildLedgerRows(raw, this.ctx)));
          parsed = true;
        }
        await unretryable(() => this.assertNoLiveSyncer(chunk.end));
        if (needsCleanup) {
          await this.cleanup(failedRuns, spans);
          needsCleanup = false;
        }
        // ... and a retry's new run id is logged only once the failed run is gone, so that a crash in between leaves the
        // id of the run that still has to be waited for.
        if (loggedRun !== this.writer.runId) {
          await this.logIntent(chunk, this.writer.runId, 'started');
          loggedRun = this.writer.runId;
        }
        let written: LedgerWriteResult;
        try {
          written = await this.writer.write(ledgers);
        } catch (err) {
          // Some of its inserts may have landed, and some may still be running on the server.
          needsCleanup = true;
          failedRuns.push(this.writer.runId);
          throw err;
        }
        // Counted once the write is committed, so that a failed attempt and its retry are one.
        if (written.ammUnclassified > 0) {
          this.ammUnclassified += written.ammUnclassified;
          this.metrics.ammUnclassifiedTotal.inc(written.ammUnclassified);
        }
        return ledgers;
      } catch (err) {
        // A ledger the parser rejects (`LedgerParseError`, which names it) fails the same way every time (ruling R96). A
        // missing ledger and a rate limit were retried by the fetch until the chunk's wait budget ran out (ruling R100).
        const spent =
          err instanceof LedgerNotAvailableError || retryAfterMsOf(err) > 0 || throttleHint(err) !== undefined;
        if (permanent || isLedgerParseError(err) || spent || attempt >= this.maxAttempts) {
          const why = typeof err === 'object' && err !== null ? this.outOfTime.get(err) : undefined;
          const outOfTime = why === undefined ? '' : `: ${why}`;
          this.logger.error(
            `Chunk [${chunk.start},${chunk.end}] failed (attempt ${attempt} of ${this.maxAttempts})${outOfTime}, ` +
              `its intent stays open: ${describe(err)}`,
          );
          throw err;
        }
        const delay = Math.min(MAX_RETRY_BACKOFF_MS, this.retryBackoffMs * 2 ** (attempt - 1));
        this.logger.warn(
          `Chunk [${chunk.start},${chunk.end}] failed (attempt ${attempt} of ${this.maxAttempts}), ` +
            `retrying in ${delay} ms under a new run id: ${describe(err)}`,
        );
        await wait(delay);
        this.writer = this.writer.withNewRunId(this.runId === undefined ? undefined : `${this.runId}:${randomUUID()}`);
      }
    }
  }

  /** The ledgers in `[from, to]` that have a `ledgers` row, with their close times (unix seconds). */
  private async committedIn(from: number, to: number): Promise<Map<number, number>> {
    const rows = await this.ch.query<{ ledger_index: number | string; close: number | string }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS close FROM ${Table.Ledgers}
        WHERE ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}`,
      { from, to },
    );
    return new Map(rows.map((r) => [Number(r.ledger_index), Number(r.close)]));
  }

  /**
   * The recovery contract of `LedgerWriter` (ruling R16) up to the retry: wait until nothing of the failed runs is left
   * on the server, delete the ledgers this run writes under a fresh query id prefix, and wait for the deletes too.
   */
  private async cleanup(failedRuns: string[], spans: Array<[number, number]>): Promise<void> {
    while (failedRuns.length > 0) {
      await awaitQuiescence(this.ch, failedRuns[0], { timeoutMs: this.quiescenceTimeoutMs });
      failedRuns.shift();
    }
    const queryIdPrefix = `range-cleanup-${randomUUID()}`;
    for (const [from, to] of spans) await deleteLedgerRange(this.ch, from, to, { queryIdPrefix });
    await awaitQuiescence(this.ch, queryIdPrefix, { timeoutMs: this.quiescenceTimeoutMs });
  }

  /**
   * Fetch the ledgers, `concurrency` at a time, and return them in the order of `indexes`. After the first failure no new
   * fetch starts: a fetch that waits out a transient failure wakes and gives up at once (`FetchAbandoned`, ruling R105),
   * and the requests still on the wire are waited for. Then a `LedgerNotAvailableError` is thrown in preference to any
   * other error, and otherwise the error of the lowest index.
   */
  private async fetchAll(indexes: number[]): Promise<RawLedger[]> {
    const results = new Array<RawLedger>(indexes.length);
    const failures: Array<{ position: number; error: unknown }> = [];
    let next = 0;
    const phase = new FetchPhase(this.maxTransientWaitMs);
    const worker = async (id: number): Promise<void> => {
      try {
        while (!phase.failed && next < indexes.length) {
          const position = next++;
          try {
            results[position] = await this.fetchOne(indexes[position], phase, id);
            phase.progress();
          } catch (error) {
            if (error instanceof FetchAbandoned) break;
            failures.push({ position, error });
            phase.fail();
          }
        }
      } finally {
        phase.finished(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, indexes.length) }, (_, id) => worker(id)));
    if (failures.length > 0) {
      failures.sort((a, b) => a.position - b.position);
      throw (failures.find((f) => f.error instanceof LedgerNotAvailableError) ?? failures[0]).error;
    }
    return results;
  }

  /**
   * `source.fetch(index)`, retried while the failure is transient (rulings R100, R105): a rate-limited node is asked again
   * when the pause it named is over (the node client logged it), a ledger the node does not have right now
   * (`LedgerNotAvailableError`: a cluster member without it) after a backoff. The chunk may go `maxTransientWaitMs`
   * without a ledger arriving; a wait that cannot see one arrive in that time gives up (the error is thrown). Anything
   * else is thrown at once. When another fetch of the chunk failed, a waiting fetch wakes and stops (`FetchAbandoned`).
   */
  private async fetchOne(index: number, phase: FetchPhase, worker: number): Promise<RawLedger> {
    for (let missing = 0; ; ) {
      phase.fetching(worker);
      try {
        const ledger = await this.source.fetch(index);
        if (ledger.header.ledger_index !== index) {
          throw new Error(`Ledger ${index} was requested but the source returned ledger ${ledger.header.ledger_index}`);
        }
        return ledger;
      } catch (err) {
        if (phase.failed) throw new FetchAbandoned();
        let delay: number;
        const throttle = throttleHint(err);
        const paused = retryAfterMsOf(err) > 0 || throttle !== undefined;
        if (paused) {
          delay = retryAfterMsOf(err) || throttle?.retryInMs || DEFAULT_THROTTLE_WAIT_MS;
        } else if (err instanceof LedgerNotAvailableError) {
          missing += 1;
          delay = Math.min(MAX_RETRY_BACKOFF_MS, this.retryBackoffMs * 2 ** (missing - 1));
        } else {
          throw err;
        }
        const resumeAt = Date.now() + delay;
        phase.waiting(worker, resumeAt);
        let logged = false;
        for (;;) {
          if (phase.failed) throw new FetchAbandoned();
          const now = Date.now();
          if (now >= resumeAt) break;
          if (phase.hopeless(now)) {
            if (typeof err === 'object' && err !== null) {
              this.outOfTime.set(
                err,
                // a pause of the node's that would end after the budget fails at once, without waiting for it;
                // anything else means the budget ran out (or would, before the next try)
                paused && now < phase.deadline && resumeAt >= phase.deadline
                  ? `the node asked for a pause of ${(delay / 1000).toFixed(1)} s, longer than --max-wait ` +
                      `(${this.maxTransientWaitMs / 1000} s) without a ledger allows: failed at once`
                  : `no ledger fetched for --max-wait (${this.maxTransientWaitMs / 1000} s)`,
              );
            }
            throw err;
          }
          if (!logged && err instanceof LedgerNotAvailableError) {
            this.logger.warn(`Ledger ${index} is not available on the node right now; asking again in ${delay} ms`);
          }
          logged = true;
          await phase.sleep(Math.min(resumeAt, phase.deadline));
        }
      }
    }
  }

  // =================================================================================================================
  // ingest_log
  // =================================================================================================================

  /**
   * The chunks of `[from, to]` whose newest `ingest_log` row says 'started'. The live runner's intents are not chunks and
   * never show up here: they are skipped by their `live:` run id, and their `range_end` of 0 could not overlap a range
   * that starts at ledger 1 or later anyway.
   */
  private async unfinishedIntents(): Promise<OpenIntent[]> {
    const rows = await this.ch.query<{ range_start: number | string; range_end: number | string; last_run_id: string }>(
      `SELECT range_start, range_end, argMax(run_id, updated_at) AS last_run_id
         FROM ${Table.IngestLog}
        WHERE NOT startsWith(run_id, {live:String})
          AND range_start <= {to:UInt32} AND range_end >= {from:UInt32}
        GROUP BY range_start, range_end
       HAVING argMax(status, updated_at) = 'started'
        ORDER BY range_start, range_end`,
      { live: LIVE_INTENT_PREFIX, from: this.from, to: this.to },
    );
    return rows.map((r) => ({ start: Number(r.range_start), end: Number(r.range_end), runId: r.last_run_id }));
  }

  /**
   * Read the unfinished intents, and wait until nothing of their runs is left on the server (a killed process may leave
   * an insert running there, and its rows would land behind the delete that redoes the chunk).
   */
  private async waitForOpenIntents(): Promise<void> {
    this.open = await this.unfinishedIntents();
    if (this.open.length > 0) {
      this.logger.log(`${this.open.length} unfinished intents in [${this.from},${this.to}] will be redone`);
    }
    for (const runId of new Set(this.open.map((i) => i.runId))) {
      if (runId !== '') await awaitQuiescence(this.ch, runId, { timeoutMs: this.quiescenceTimeoutMs });
    }
  }

  private logIntent(chunk: Pick<Chunk, 'start' | 'end'>, runId: string, status: 'started' | 'done'): Promise<void> {
    return this.writeIntent(chunk.start, chunk.end, runId, status);
  }

  /**
   * One row of `ingest_log`, strictly newer than every row of its key. `updated_at` is the version of the
   * ReplacingMergeTree and the order `argMax` reads the newest status in, so a 'done' must never tie with, or lose to, the
   * 'started' before it. The server's clock is used (a DateTime64(3) written from a client is a JSON number of seconds, and
   * clients of different hosts disagree about the time).
   */
  private async writeIntent(start: number, end: number, runId: string, status: 'started' | 'done'): Promise<void> {
    await this.ch.command(
      `INSERT INTO ${Table.IngestLog} (range_start, range_end, run_id, status, updated_at)
       SELECT {start:UInt32}, {end:UInt32}, {runId:String}, {status:String},
              greatest(now64(3), (SELECT max(updated_at) FROM ${Table.IngestLog}
                                   WHERE range_start = {start:UInt32} AND range_end = {end:UInt32})
                                 + toIntervalMillisecond(1))`,
      { start, end, runId, status },
    );
  }

  /**
   * Rulings R100, R110: redo every unfinished intent over its own recorded range, whatever the chunk size and the range of
   * this run are, and close it. Overlapping intents are merged and redone as one. For each such range, before any chunk
   * of this run:
   *  - a ledger that is committed in it is complete (its commit marker went in after all of its rows) and is kept as it
   *    is: neither fetched nor rewritten;
   *  - the ledgers to write are all the uncommitted ones of the recorded range, also those outside `[from, to]` (a
   *    narrower rerun must not close an intent over ledgers it never wrote); inside `[from, to]` an index-list run writes
   *    its listed ones only. They are fetched and parsed, then every uncommitted span of the range is deleted (which also
   *    takes the child rows a crashed write left for ledgers that are not written now), then they are written, as one
   *    chunk with its own intent row (nothing of this when the whole range is committed);
   *  - every intent of the range gets a 'done' row;
   *  - `agg_dirty` gets the close-time window of every committed ledger of the range, the ones that were committed before
   *    as well: the run that died may have committed them and never marked them.
   * A redo that fails leaves the intents open, and the next run redoes them again; one that succeeds closes them, so no
   * intent is redone by every run after it (F5: a run with a smaller `--chunk` than the one that died kept rewriting the
   * first chunk of a wider intent and never closed it).
   */
  private async redoOpenIntents(): Promise<void> {
    const sorted = [...this.open].sort((a, b) => a.start - b.start || a.end - b.end);
    const groups: Array<{ start: number; end: number; members: OpenIntent[] }> = [];
    for (const intent of sorted) {
      const last = groups[groups.length - 1];
      if (last && intent.start <= last.end) {
        last.end = Math.max(last.end, intent.end);
        last.members.push(intent);
      } else {
        groups.push({ start: intent.start, end: intent.end, members: [intent] });
      }
    }
    for (const group of groups) {
      const startedAt = Date.now();
      await this.assertNoLiveSyncer(group.end);
      const committed = await this.committedIn(group.start, group.end);
      const toWrite = this.redoTargets(group.start, group.end).filter((i) => !committed.has(i));
      const gaps = uncommittedSpans(
        group.start,
        group.end,
        [...committed.keys()].sort((a, b) => a - b),
      );
      let ledgers: RawLedger[] = [];
      let groupClosed = false;
      if (gaps.length > 0) {
        const chunk: Chunk = { start: group.start, end: group.end, targets: toWrite };
        ledgers = await this.writeWithRecovery(chunk, toWrite, gaps, true);
        await this.logIntent(chunk, this.writer.runId, 'done');
        groupClosed = true;
      }
      for (const intent of group.members) {
        if (groupClosed && intent.start === group.start && intent.end === group.end) continue;
        await this.writeIntent(intent.start, intent.end, this.writer.runId, 'done');
      }
      // the window of everything committed in the range now: what was there, and what was written
      let window: CloseWindow | undefined;
      for (const close of [...committed.values(), ...ledgers.map((l) => l.header.close_time)]) {
        window = window
          ? { min: Math.min(window.min, close), max: Math.max(window.max, close) }
          : { min: close, max: close };
      }
      if (window) await this.markAggregatesDirty(window);
      for (const index of committed.keys()) this.redone.add(index);
      for (const ledger of ledgers) this.redone.add(ledger.header.ledger_index);
      this.ledgersWritten += ledgers.length;
      this.logger.log(
        `Unfinished intent${group.members.length > 1 ? 's' : ''} ` +
          `${group.members.map((i) => `[${i.start},${i.end}]`).join(', ')} redone in ${Date.now() - startedAt} ms: ` +
          `${ledgers.length} ledgers written, closed`,
      );
    }
    this.open = [];
  }

  /**
   * The ledgers of the recorded range `[start, end]` of an unfinished intent that its redo writes (when they are not
   * committed): every one of them, except that inside `[from, to]` an index-list run keeps to its listed indexes.
   */
  private redoTargets(start: number, end: number): number[] {
    const all = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    if (!this.indexes) return all;
    const listed = new Set(this.indexes);
    return all.filter((i) => i < this.from || i > this.to || listed.has(i));
  }

  // =================================================================================================================
  // The live syncer, agg_dirty
  // =================================================================================================================

  /**
   * Ruling R27: the live runner owns everything above its checkpoint (it deletes the tail above it when it recovers), so
   * ledgers above it are not written while a live syncer holds a fresh lease. `upTo` is the highest ledger about to be
   * written; the message names the whole range.
   *
   * The lease is read as `LiveRunner` reads it: the newest row of the network, aged on the ClickHouse server's clock.
   */
  private async assertNoLiveSyncer(upTo: number): Promise<void> {
    const checkpoint = await committedCheckpoint(this.ch);
    if (checkpoint !== undefined && upTo <= checkpoint) return;
    const lease = await this.ch.queryOne<{ holder: string; age_ms: string | number }>(
      `SELECT argMax(holder, heartbeat) AS holder, dateDiff('millisecond', max(heartbeat), now64(3)) AS age_ms
         FROM ${Table.SyncerLease} WHERE network = {network:String}`,
      { network: this.network },
    );
    const holder = lease?.holder ?? '';
    const ageMs = Number(lease?.age_ms ?? Number.POSITIVE_INFINITY);
    if (holder !== '' && ageMs < this.leaseFreshMs) {
      throw new Error(
        `Range [${this.from},${this.to}] reaches above the live checkpoint ${checkpoint ?? 'none'} ` +
          `while a live syncer holds the lease (${holder})`,
      );
    }
  }

  /**
   * Ruling R110: on a database a live syncer has run on (it has a `syncer_lease` row, fresh or not), a range must not
   * start above the committed checkpoint + 1 unless `allowGap`. The live syncer resumes after the highest committed
   * ledger, so the ledgers between its checkpoint and `from` would be skipped for good; and a live syncer that boots
   * while the range is written deletes the ledgers above its checkpoint. A database filled by range ingests alone (no
   * lease row) is not checked: there the gaps are the operator's to fill.
   */
  private async assertNoGap(): Promise<void> {
    if (this.allowGap) return;
    const checkpoint = await committedCheckpoint(this.ch);
    if (checkpoint === undefined || this.from <= checkpoint + 1) return;
    const lease = await this.ch.queryOne<{ n: string | number }>(
      `SELECT count() AS n FROM ${Table.SyncerLease} WHERE network = {network:String}`,
      { network: this.network },
    );
    if (Number(lease?.n ?? 0) === 0) return;
    throw new Error(
      `Range [${this.from},${this.to}] starts above the live checkpoint ${checkpoint} + 1: the live syncer resumes after ` +
        `the highest committed ledger and would skip ${checkpoint + 1}..${this.from - 1}. Start at ${checkpoint + 1}, ` +
        'or pass --allow-gap (allowGap) when the gap is deliberate and will be filled by another range ingest',
    );
  }

  /**
   * One `agg_dirty` row for ledgers whose close times span `window`: from the start of the hour of the earliest to the end
   * of the hour of the latest (the hour after it, so that a ledger that closed on the hour is covered too). Retried like
   * a chunk. If it still fails, the chunk it belongs to is committed and `done`, and a rerun marks it as part of the
   * ledgers it skips.
   */
  private async markAggregatesDirty(window: CloseWindow): Promise<void> {
    const row = {
      from_hour: Math.floor(window.min / HOUR_SECONDS) * HOUR_SECONDS,
      to_hour: (Math.floor(window.max / HOUR_SECONDS) + 1) * HOUR_SECONDS,
      // DateTime64(3): a JSON number is read as seconds, so it is sent as fractional seconds.
      created_at: Date.now() / 1000,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ch.insert(Table.AggDirty, [row]);
        return;
      } catch (err) {
        if (attempt >= this.maxAttempts) throw err;
        await wait(Math.min(MAX_RETRY_BACKOFF_MS, this.retryBackoffMs * 2 ** (attempt - 1)));
      }
    }
  }
}

/** Earliest and latest close time of `ledgers` (not empty). */
function closeWindowOf(ledgers: RawLedger[]): CloseWindow {
  const window = { min: ledgers[0].header.close_time, max: ledgers[0].header.close_time };
  for (const { header } of ledgers) {
    window.min = Math.min(window.min, header.close_time);
    window.max = Math.max(window.max, header.close_time);
  }
  return window;
}

/** The network whose CTID network id is `ctx.networkId`: the `network` column of its `syncer_lease` row. */
function networkOf(ctx: ParseContext): string {
  for (const name of ['xrpl', 'xahau']) {
    if (getNetworkProfile(name).networkId === ctx.networkId) return name;
  }
  throw new Error(`No network has the CTID network id ${ctx.networkId}: pass the network option`);
}

/** The spans of `[start, end]` that hold no ledger of `committed` (ascending, all inside the range). */
export function uncommittedSpans(start: number, end: number, committed: number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = start;
  for (const index of committed) {
    if (index > from) spans.push([from, index - 1]);
    from = Math.max(from, index + 1);
  }
  if (from <= end) spans.push([from, end]);
  return spans;
}

/**
 * The ranges to delete so that exactly `targets` (ascending) are removed. Consecutive targets share a range unless a
 * ledger from `keep` (ascending, none of them a target) lies between them, because a range delete takes every ledger in it.
 */
export function deleteSpans(targets: number[], keep: number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let spanStart = targets[0];
  let previous = targets[0];
  let k = 0;
  for (let i = 1; i < targets.length; i++) {
    const target = targets[i];
    while (k < keep.length && keep[k] < previous) k++;
    if (k < keep.length && keep[k] < target) {
      spans.push([spanStart, previous]);
      spanStart = target;
    }
    previous = target;
  }
  spans.push([spanStart, previous]);
  return spans;
}

// =====================================================================================================================
// CLI
// =====================================================================================================================

export const USAGE = `Usage: pnpm ingest:range --from <ledger> --to <ledger> [options]

Ingests the ledgers from..to (both inclusive) from GH_NODE_ENDPOINTS into ClickHouse, in aligned chunks.
The network, ClickHouse and node come from the same GH_* environment as the syncer.

  --from <ledger>        first ledger (required)
  --to <ledger>          last ledger (required)
  --chunk <n>            ledgers per chunk, must divide 1000000 (default ${DEFAULT_CHUNK_SIZE}); a chunk is held in memory
  --concurrency <n>      ledgers of a chunk fetched at once (default ${DEFAULT_CONCURRENCY})
  --max-wait <s>         seconds a chunk may go without a ledger arriving while it waits for a rate-limited node or a
                         ledger the node lacks right now, before it fails (default ${DEFAULT_MAX_TRANSIENT_WAIT_MS / 1000})
  --reprocess            delete and rewrite ledgers that are committed already (default: skip them)
  --allow-gap            allow a range that starts above the highest committed ledger + 1 on a database a live syncer
                         has run on (refused by default: the live syncer would never fetch the ledgers in between)
  --run-id <id>          name of this run in ingest_log and in query ids (a nonce is appended)
  --help                 print this text

Exit status: 0 when the range is ingested, 1 when the run failed (rerun the same command: finished chunks are skipped, unfinished ones redone),
2 for a wrong command line.`;

/** The command line is wrong. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function integerFlag(name: string, raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new UsageError(`--${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** The options for `rangeIngest` from the command line (without `node` and the script), or 'help'. */
export function parseRangeIngestArgs(argv: string[]): RangeIngestOptions | 'help' {
  // `pnpm run ingest:range -- --from 1` hands the separator over.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        chunk: { type: 'string' },
        concurrency: { type: 'string' },
        'max-wait': { type: 'string' },
        reprocess: { type: 'boolean' },
        'allow-gap': { type: 'boolean' },
        'run-id': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new UsageError(describe(err));
  }
  if (values.help) return 'help';
  if (values.from === undefined) throw new UsageError('--from is required');
  if (values.to === undefined) throw new UsageError('--to is required');

  const opts: RangeIngestOptions = {
    from: integerFlag('from', values.from as string),
    to: integerFlag('to', values.to as string),
  };
  if (values.chunk !== undefined) opts.chunkSize = integerFlag('chunk', values.chunk as string);
  if (values.concurrency !== undefined) opts.concurrency = integerFlag('concurrency', values.concurrency as string);
  if (values['max-wait'] !== undefined) {
    opts.maxTransientWaitMs = integerFlag('max-wait', values['max-wait'] as string) * 1000;
  }
  if (values.reprocess) opts.reprocess = true;
  if (values['allow-gap']) opts.allowGap = true;
  if (values['run-id'] !== undefined) opts.runId = values['run-id'] as string;
  return opts;
}

/** Runs the CLI; resolves to the exit status. */
export async function main(argv: string[]): Promise<number> {
  let parsed: RangeIngestOptions | 'help';
  try {
    parsed = parseRangeIngestArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }

  const logger = new Logger('RangeIngest');
  const cfg = await loadSyncerConfig();
  const profile = getNetworkProfile(cfg.network);
  const clickHouse = clickHouseConfigFromEnv(process.env, profile);
  const ch = new ClickHouseService(clickHouse);
  let client: NodeClient | undefined;
  try {
    await migrateOnBoot(cfg, clickHouse, logger);
    client = await createNodeClient(cfg, profile);
    const source = new RpcLedgerSource(client, { fetchTimeoutMs: cfg.ledgerFetchTimeoutMs });
    logger.log(
      `Ingesting ledgers ${parsed.from}..${parsed.to} of ${profile.name} into database "${clickHouse.database}"` +
        (parsed.reprocess ? ' (reprocessing committed ledgers)' : ''),
    );
    await rangeIngest(source, ch, parseContextFor(profile), { ...parsed, network: profile.name, logger });
    return 0;
  } catch (err) {
    logger.error(`Range ingest failed: ${describe(err)}`, err instanceof Error ? err.stack : undefined);
    return 1;
  } finally {
    await client?.stop().catch((err: unknown) => logger.warn(`Stopping the node client failed: ${describe(err)}`));
    await ch.onModuleDestroy().catch((err: unknown) => logger.warn(`Closing ClickHouse failed: ${describe(err)}`));
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      new Logger('RangeIngest').error(`Fatal: ${describe(err)}`, err instanceof Error ? err.stack : undefined);
      process.exit(1);
    },
  );
}

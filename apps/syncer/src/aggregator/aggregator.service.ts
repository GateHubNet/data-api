import {
  ClickHouseService,
  HOUR_SECONDS,
  recomputeStatsHourly,
  ShutdownSignals,
  StatsRecomputeAborted,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { deleteDirtyRange, DirtyRange, narrowDirtyRange, readDirtyRanges } from './agg-dirty';

/** The aggregator runs its jobs once a minute. */
export const AGGREGATOR_INTERVAL_MS = 60_000;

/**
 * How long a tick may keep starting slices. The check is made before each slice, so a tick can run as long as one slice
 * (a day of ledgers: well under a second to a few seconds) longer. Work left over goes to the next tick, so a
 * range of years in `agg_dirty` cannot stall the minute-by-minute refresh of the current hour for longer than this.
 */
export const AGGREGATOR_TICK_BUDGET_MS = 30_000;

/**
 * How much of the tick `stats_live` may use (at most; the tick budget is the limit when it is smaller). A catch-up of
 * months would otherwise take all of the tick, and `stats_dirty` (and the jobs that come after it) would never run until it
 * was over.
 */
export const AGGREGATOR_LIVE_BUDGET_MS = 20_000;

/**
 * How long a shutdown waits for the tick in flight. The cleanups of `ShutdownSignals` share one budget of 10 s and the
 * ingest runner, which releases the syncer lease, can stop after this one, so a database that hangs must not use it up:
 * the tick is abandoned (it has been told to write nothing more, see `stop()`).
 */
export const AGGREGATOR_SHUTDOWN_WAIT_MS = 2000;

/** Every tick recomputes this far back from now (a ledger that is committed late lands in the hour it closed in). */
export const LIVE_LOOKBACK_SECONDS = 2 * HOUR_SECONDS;

/** A range is recomputed in slices of at most this many seconds: one aggregation query and one insert each. */
export const MAX_SLICE_SECONDS = 24 * HOUR_SECONDS;

/** How many `agg_dirty` ranges a tick reads (the oldest ones); the rest wait for the next. */
export const DIRTY_RANGES_PER_TICK = 100;

/** How many hours of `stats_hourly` one read of the watermark looks at; it goes on to older hours only past hours without ledgers. */
export const WATERMARK_CHUNK_HOURS = 100;

const MAX_UINT32 = 4_294_967_295;

/** A tick gives up on `agg_dirty` after this many ranges failed, so that an outage does not log a line per range. */
export const MAX_FAILED_DIRTY_RANGES_PER_TICK = 3;

/** Optional `AggregatorOptions` (interval, budget, logger, clock, ...); tests shorten the interval and capture the log. */
export const AGGREGATOR_OPTIONS = Symbol('AGGREGATOR_OPTIONS');

/** What a job is handed by the tick it runs in. */
export interface AggregatorTick {
  /** The time of the tick. */
  now: Date;
  /** The clock reading (`Date.now()` scale, milliseconds) after which a job should not start another slice. */
  deadline: number;
  /** Aborted when the shutdown begins: pass it to whatever writes, so that nothing is written after that. */
  signal: AbortSignal;
}

/**
 * One piece of the tick. The tick runs its jobs one after the other; a job that throws is logged and counted
 * (`syncer_aggregator_errors_total{job}`), and the jobs after it still run. A job that finishes counts in
 * `syncer_aggregator_runs_total{job}`.
 */
export interface AggregatorJob {
  /** The `job` label of its metrics and the name in its log lines. */
  readonly name: string;
  /**
   * The most of the tick this job may use, from the moment it starts (and never more than what is left of the tick budget).
   * Without it the job may use what the jobs before it left. A job that runs after jobs that can use up the tick (the volume
   * jobs come after `stats_dirty`) gives itself a budget, so that it is served too.
   */
  readonly budgetMs?: number;
  run(tick: AggregatorTick): Promise<void>;
}

export interface AggregatorOptions {
  /** Default: `AGGREGATOR_INTERVAL_MS`. */
  intervalMs?: number;
  /** Default: `AGGREGATOR_TICK_BUDGET_MS`. */
  tickBudgetMs?: number;
  /** Default: `AGGREGATOR_LIVE_BUDGET_MS`. */
  liveBudgetMs?: number;
  /** Default: a Nest `Logger` with the context `AggregatorService`. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  /** The clock, in unix milliseconds. Default: `Date.now`. */
  now?: () => number;
  /** Replaces `recomputeStatsHourly`; for tests. */
  recompute?: typeof recomputeStatsHourly;
  /** Jobs that run after the ones of the stats, in this order. */
  extraJobs?: AggregatorJob[];
}

/** `[from, to)` cut into slices of at most `MAX_SLICE_SECONDS`, counted from `from`. Empty or reversed gives none. */
export function sliceRange(from: number, to: number): Array<[number, number]> {
  const slices: Array<[number, number]> = [];
  for (let start = from; start < to; start += MAX_SLICE_SECONDS) {
    slices.push([start, Math.min(to, start + MAX_SLICE_SECONDS)]);
  }
  return slices;
}

const hourStart = (seconds: number): number => Math.floor(seconds / HOUR_SECONDS) * HOUR_SECONDS;
const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The `aggregator` worker: once a minute it runs its jobs, in this order,
 *
 *  1. **stats_live**: recomputes `stats_hourly` for the hours that may have changed since the last tick, in two parts, oldest
 *     first, in slices of at most a day:
 *      - the **catch-up**, from the watermark (the newest hour with ledgers) up to two hours ago, or to the hour of the newest
 *        ledger if that is earlier. The live runner writes no `agg_dirty` row, so after an outage, for a database whose
 *        live runner started at an old ledger, and for an aggregator enabled late, this is what brings the hours it
 *        caught up on into the stats. With no stats at all it starts at the hour of the first ledger. A slice that holds no
 *        ledger jumps to the hour of the next one, so that a gap in the ledgers costs one read and not a slice a day.
 *      - the **tail**, from two hours ago up to the end of the current hour (a ledger that is committed late lands in the
 *        hour it closed in), only once the catch-up is over: the watermark is the cursor of the catch-up and lives in the
 *        database, so it must not move past hours that have not been done. A restart takes the catch-up up where it was.
 *
 *     It gets at most `AGGREGATOR_LIVE_BUDGET_MS` of the tick, so that `stats_dirty` is served in every tick. **During a long
 *     catch-up (weeks of ledgers after an outage, the first sweep of a database with years of history) the tail is not
 *     run, so the stats of the current hour are stale**; `syncer_aggregator_stats_lag_seconds` says how much is left.
 *  2. **stats_dirty**: drains `agg_dirty`, the ranges that ingest rewrote behind the aggregator, oldest first, each in slices
 *     of at most a day.
 *
 * and a later task adds its volume jobs to the list. Every slice is idempotent (`recomputeStatsHourly`), which is what lets
 * this retry, resume and crash anywhere:
 *
 *  - **A failed slice is retried next tick.** The live job stops at the first failure (its slices are in order, and a later one
 *    would move the watermark past it); the dirty job leaves the range in the queue, keeps the progress it made, and goes on
 *    with the next range, until three ranges have failed in a tick. Errors are logged and counted, and never stop the loop.
 *  - **A range of years does not stall a tick.** Slices are started until the budget of the job (`AGGREGATOR_LIVE_BUDGET_MS`
 *    for the live job) or of the tick (`AGGREGATOR_TICK_BUDGET_MS`) is spent. The unfinished
 *    `agg_dirty` range is replaced by one that starts where the work stopped (inserted first, then the old one deleted), with
 *    the `created_at` it had; the live window picks up from the watermark.
 *  - **A mark is never lost.** A range is deleted only after all its slices succeeded, and only the marks made at or before
 *    the one that was read; a range that the ingest marked again meanwhile stays and is done again.
 *  - **No overlap.** A tick that finds the previous one still running is skipped and logged.
 *  - **Shutdown** (module destroy, or SIGTERM through `ShutdownSignals`): no tick starts after it; the signal of the slice in
 *    flight is aborted, so that its rows are not written; no change to `agg_dirty` is started after it (a narrowing that
 *    has inserted its row finishes its delete, so as not to leave the old row beside the new one). The stop waits for the
 *    tick for at most `AGGREGATOR_SHUTDOWN_WAIT_MS`, then abandons it and says so.
 */
@Injectable()
export class AggregatorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly tickBudgetMs: number;
  private readonly liveBudgetMs: number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  private readonly clock: () => number;
  private readonly recompute: typeof recomputeStatsHourly;
  /** The jobs of a tick, in order. A task that adds a job adds a line here. */
  private readonly jobs: AggregatorJob[];
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  /** Set when a stop begins: nothing starts, and nothing is written, after it. */
  private closing = false;
  private stopped?: Promise<void>;

  constructor(
    private readonly ch: ClickHouseService,
    @Optional() private readonly metrics?: PrometheusService,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(AGGREGATOR_OPTIONS) options: AggregatorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? AGGREGATOR_INTERVAL_MS;
    this.tickBudgetMs = options.tickBudgetMs ?? AGGREGATOR_TICK_BUDGET_MS;
    this.liveBudgetMs = options.liveBudgetMs ?? AGGREGATOR_LIVE_BUDGET_MS;
    this.logger = options.logger ?? new Logger(AggregatorService.name);
    this.clock = options.now ?? Date.now;
    this.recompute = options.recompute ?? recomputeStatsHourly;
    this.jobs = [
      { name: 'stats_live', budgetMs: this.liveBudgetMs, run: (tick) => this.statsLive(tick) },
      { name: 'stats_dirty', run: (tick) => this.statsDirty(tick) },
      ...(options.extraJobs ?? []),
    ];
  }

  /** Runs the first tick at once (not awaited: a slow database does not hold up the boot), then one every interval. */
  onApplicationBootstrap(): void {
    if (this.closing || this.timer) return;
    this.shutdownSignals?.register('aggregator', () => this.stop());
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Stops the ticks, tells the slice in flight to write nothing, and waits for the tick, at most
   * `AGGREGATOR_SHUTDOWN_WAIT_MS`. Idempotent; a stopped aggregator does not start again.
   */
  stop(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  /**
   * One run of all the jobs; `now` is the time the live window is worked out from (default: the clock). Never rejects:
   * what goes wrong is logged and counted. Called by the timer; exported for tests.
   */
  tick(now?: Date): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.inFlight) {
      this.logger.warn('Skipping an aggregator tick: the previous tick is still running');
      return this.inFlight;
    }
    const tick: AggregatorTick = {
      now: now ?? new Date(this.clock()),
      deadline: this.clock() + this.tickBudgetMs,
      signal: this.abort.signal,
    };
    const run = this.runJobs(tick).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async runJobs(tick: AggregatorTick): Promise<void> {
    for (const job of this.jobs) {
      if (this.closing) return;
      try {
        const deadline =
          job.budgetMs === undefined ? tick.deadline : Math.min(tick.deadline, this.clock() + job.budgetMs);
        await job.run({ ...tick, deadline });
        this.metrics?.aggregatorRunsTotal.inc({ job: job.name });
      } catch (err) {
        this.failed(job.name, err);
      }
    }
  }

  /** Logs and counts a failure of a job (or of one slice of it); one that comes of the shutdown is neither. */
  private failed(job: string, err: unknown, where = ''): void {
    if (this.closing && err instanceof StatsRecomputeAborted) {
      this.logger.log(`Dropped the ${job} slice in flight at shutdown`);
      return;
    }
    this.metrics?.aggregatorErrorsTotal.inc({ job });
    this.logger.error(`Aggregator job ${job} failed${where}: ${describe(err)}`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // stats_live
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The newest hour of `stats_hourly` whose newest version has ledgers, unix seconds; none when there is none. Read from the
   * newest hour backwards, a chunk of hours at a time, and stopped at the first hour that has ledgers (the zero rows of
   * vanished hours are skipped, not counted): the cost does not grow with the years of history.
   */
  private async watermarkHour(): Promise<number | undefined> {
    let before = MAX_UINT32;
    for (;;) {
      const rows = await this.ch.query<{ hour_start: number | string; ledger_count: number | string }>(
        `SELECT toUnixTimestamp(hour) AS hour_start, ledger_count
           FROM ${Table.StatsHourly}
          WHERE hour < toDateTime({before:UInt32}, 'UTC')
          ORDER BY hour DESC, version DESC
          LIMIT 1 BY hour
          LIMIT {n:UInt32}`,
        { before, n: WATERMARK_CHUNK_HOURS },
      );
      const withLedgers = rows.find((row) => Number(row.ledger_count) > 0);
      if (withLedgers !== undefined) return Number(withLedgers.hour_start);
      if (rows.length < WATERMARK_CHUNK_HOURS) return undefined;
      before = Number(rows[rows.length - 1].hour_start);
    }
  }

  /** The close time of the newest ledger (the one with the highest index: a read of the end of the primary key). */
  private async latestCloseTime(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ closed: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.closed);
  }

  /** The close time of the oldest ledger (the one with the lowest index: a read of the start of the primary key). */
  private async firstCloseTime(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ closed: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index ASC LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.closed);
  }

  /**
   * The hour the catch-up goes on at after a slice that held no ledger: that of the first ledger that closed at or after
   * `from`, at most `limit`. The lowest index that closed in or after `from` is read from the primary key in order
   * (the minmax index on `close_time` skips the granules before it), so a gap of years costs one short read.
   */
  private async hourOfNextLedger(from: number, limit: number): Promise<number> {
    const row = await this.ch.queryOne<{ closed: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS closed
         FROM ${Table.Ledgers}
        WHERE close_time >= toDateTime({from:UInt32}, 'UTC')
        ORDER BY ledger_index ASC
        LIMIT 1`,
      { from },
    );
    return row === undefined ? limit : Math.min(limit, Math.max(from, hourStart(Number(row.closed))));
  }

  /** `syncer_aggregator_stats_lag_seconds`: how many seconds of the catch-up are still to do. */
  private reportLag(seconds: number): void {
    this.metrics?.aggregatorStatsLagSeconds.set(Math.max(0, seconds));
  }

  private async statsLive(tick: AggregatorTick): Promise<void> {
    const now = Math.floor(tick.now.getTime() / 1000);
    const [watermark, latestClose] = await Promise.all([this.watermarkHour(), this.latestCloseTime()]);
    // With no stats at all (a new database, a live runner that started from an old ledger, an aggregator enabled late) the
    // sweep starts at the hour of the first ledger: only `range-ingest` marks `agg_dirty`, the live runner does not.
    const firstClose = watermark === undefined && latestClose !== undefined ? await this.firstCloseTime() : undefined;

    const lookback = hourStart(now - LIVE_LOOKBACK_SECONDS);
    // up to the end of the hour of now, or of the newest ledger if that closed later
    const liveEnd = hourStart(Math.max(now, latestClose ?? 0)) + HOUR_SECONDS;
    // The hours since the watermark that the lookback does not reach, up to the hour of the newest ledger (the hours
    // after it hold no ledger: nothing in them can have changed).
    const catchUpEnd = Math.min(lookback, latestClose === undefined ? lookback : hourStart(latestClose) + HOUR_SECONDS);
    const catchUpStart = Math.min(lookback, watermark ?? (firstClose === undefined ? lookback : hourStart(firstClose)));

    // 1. The catch-up, oldest first. Its cursor is the watermark, which is in the database: a restart, or a tick that ran out
    //    of budget, takes it up where it was. A slice that holds no ledger jumps to the hour of the next one, so that a gap
    //    in the ledgers costs one read and not a slice a day.
    let cursor = catchUpStart;
    this.reportLag(catchUpEnd - cursor);
    while (cursor < catchUpEnd) {
      if (!this.mayStartSlice(tick)) return;
      const end = Math.min(catchUpEnd, cursor + MAX_SLICE_SECONDS);
      const rows = await this.recompute(this.ch, new Date(cursor * 1000), new Date(end * 1000), {
        signal: tick.signal,
      });
      this.logger.debug(`stats_live: ${iso(cursor)} - ${iso(end)}: ${rows} row(s)`);
      cursor = rows === 0 && end < catchUpEnd ? await this.hourOfNextLedger(end, catchUpEnd) : end;
      this.reportLag(catchUpEnd - cursor);
    }

    // 2. The tail: the last two hours up to the end of the current one, only once the catch-up is over (the watermark must
    //    not move past hours that have not been done).
    for (const [start, end] of sliceRange(lookback, liveEnd)) {
      if (!this.mayStartSlice(tick)) return;
      const rows = await this.recompute(this.ch, new Date(start * 1000), new Date(end * 1000), {
        signal: tick.signal,
      });
      this.logger.debug(`stats_live: ${iso(start)} - ${iso(end)}: ${rows} row(s)`);
    }
  }

  /** Whether the live job may start another slice: not after the shutdown began, and not past its budget (it says so). */
  private mayStartSlice(tick: AggregatorTick): boolean {
    if (this.closing) return false;
    if (this.clock() < tick.deadline) return true;
    this.logger.warn(
      'Aggregator job stats_live reached its budget; it goes on where it stopped next tick (until then the stats of the last hours are stale)',
    );
    return false;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // stats_dirty
  // -------------------------------------------------------------------------------------------------------------------

  private async statsDirty(tick: AggregatorTick): Promise<void> {
    const ranges = await readDirtyRanges(this.ch, DIRTY_RANGES_PER_TICK);
    let failedRanges = 0;
    for (const range of ranges) {
      if (this.closing) return;
      if (this.clock() >= tick.deadline) {
        this.logger.warn('Aggregator job stats_dirty reached the tick budget; the ranges left go on next tick');
        return;
      }
      const outcome = await this.recomputeDirty(range, tick);
      if (this.closing) return;
      if (outcome === 'budget') {
        this.logger.warn(
          `Aggregator job stats_dirty reached the tick budget in ${iso(range.from)} - ${iso(range.to)}; it goes on next tick`,
        );
        return;
      }
      if (outcome === 'failed' && ++failedRanges >= MAX_FAILED_DIRTY_RANGES_PER_TICK) return;
    }
  }

  /**
   * Recomputes a range slice by slice. When all slices are done the range is deleted; otherwise (the budget, a failed slice)
   * it is replaced by the part that is left, so that the progress is kept.
   */
  private async recomputeDirty(range: DirtyRange, tick: AggregatorTick): Promise<'done' | 'budget' | 'failed'> {
    let done = range.from;
    let outcome: 'done' | 'budget' | 'failed' = 'done';
    for (const [start, end] of sliceRange(range.from, range.to)) {
      if (this.closing) return 'done';
      if (this.clock() >= tick.deadline) {
        outcome = 'budget';
        break;
      }
      try {
        await this.recompute(this.ch, new Date(start * 1000), new Date(end * 1000), { signal: tick.signal });
      } catch (err) {
        this.failed('stats_dirty', err, ` in ${iso(start)} - ${iso(end)}`);
        outcome = 'failed';
        break;
      }
      done = end;
    }
    // no change to agg_dirty is started once the shutdown has begun; one that is under way (narrowDirtyRange's INSERT and
    // DELETE) is finished, so that the queue is not left with the old row beside the narrowed one
    if (this.closing) return outcome;
    if (done >= range.to) await deleteDirtyRange(this.ch, range);
    else await narrowDirtyRange(this.ch, range, done);
    return outcome;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private async shutDown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const running = this.inFlight;
    if (running === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), AGGREGATOR_SHUTDOWN_WAIT_MS);
    });
    const abandoned = await Promise.race([running.then(() => false), timedOut]);
    clearTimeout(timer);
    if (abandoned) {
      this.logger.warn(
        `Abandoning the aggregator tick in flight: it did not end within ${AGGREGATOR_SHUTDOWN_WAIT_MS} ms of the shutdown`,
      );
    }
  }
}

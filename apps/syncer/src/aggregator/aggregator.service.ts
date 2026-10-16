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
  run(tick: AggregatorTick): Promise<void>;
}

export interface AggregatorOptions {
  /** Default: `AGGREGATOR_INTERVAL_MS`. */
  intervalMs?: number;
  /** Default: `AGGREGATOR_TICK_BUDGET_MS`. */
  tickBudgetMs?: number;
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
 *  1. **stats_live**: recomputes `stats_hourly` for the hours that may have changed since the last tick: from two hours
 *     ago up to the end of the current hour (a ledger that is committed late lands in the hour it closed in). When the
 *     newest hour with ledgers (the watermark) is older than that, the window starts there instead: the live
 *     runner writes no `agg_dirty` row, so after an outage this is what brings the hours it caught up on into the stats.
 *     The window is worked in slices of at most a day, oldest first. The stretch between the newest ledger and two hours
 *     ago is skipped when the chain stood still for longer than that: nothing in it could have changed.
 *  2. **stats_dirty**: drains `agg_dirty`, the ranges that ingest rewrote behind the aggregator, oldest first, each in slices
 *     of at most a day.
 *
 * and a later task adds its volume jobs to the list. Every slice is idempotent (`recomputeStatsHourly`), which is what lets
 * this retry, resume and crash anywhere:
 *
 *  - **A failed slice is retried next tick.** The live job stops at the first failure (its slices are in order, and a later one
 *    would move the watermark past it); the dirty job leaves the range in the queue, keeps the progress it made, and goes on
 *    with the next range, until three ranges have failed in a tick. Errors are logged and counted, and never stop the loop.
 *  - **A range of years does not stall a tick.** Slices are started until `AGGREGATOR_TICK_BUDGET_MS` is spent. The unfinished
 *    `agg_dirty` range is replaced by one that starts where the work stopped (inserted first, then the old one deleted), with
 *    the `created_at` it had; the live window picks up from the watermark.
 *  - **A mark is never lost.** A range is deleted only after all its slices succeeded, and only the marks made at or before
 *    the one that was read; a range that the ingest marked again meanwhile stays and is done again.
 *  - **No overlap.** A tick that finds the previous one still running is skipped and logged.
 *  - **Shutdown** (module destroy, or SIGTERM through `ShutdownSignals`): no tick starts after it; the signal of the slice in
 *    flight is aborted, so that its rows are not written; nothing is written to `agg_dirty` either. The stop waits for the tick
 *    for at most `AGGREGATOR_SHUTDOWN_WAIT_MS`, then abandons it and says so.
 */
@Injectable()
export class AggregatorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly tickBudgetMs: number;
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
    this.logger = options.logger ?? new Logger(AggregatorService.name);
    this.clock = options.now ?? Date.now;
    this.recompute = options.recompute ?? recomputeStatsHourly;
    this.jobs = [
      { name: 'stats_live', run: (tick) => this.statsLive(tick) },
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
        await job.run(tick);
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

  /** The newest hour of `stats_hourly` that has ledgers (newest version of each hour), unix seconds; none when there is none. */
  private async watermarkHour(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ hour: number | string | null }>(
      `SELECT toUnixTimestamp(maxOrNull(hour)) AS hour
         FROM (
              SELECT hour, ledger_count
                FROM ${Table.StatsHourly}
               ORDER BY hour ASC, version DESC
               LIMIT 1 BY hour
              )
        WHERE ledger_count > 0`,
    );
    return row?.hour == null ? undefined : Number(row.hour);
  }

  /** The close time of the newest ledger (the one with the highest index: a read of the end of the primary key). */
  private async latestCloseTime(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ closed: number | string }>(
      `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.closed);
  }

  private async statsLive(tick: AggregatorTick): Promise<void> {
    const now = Math.floor(tick.now.getTime() / 1000);
    const [watermark, latestClose] = await Promise.all([this.watermarkHour(), this.latestCloseTime()]);

    const lookback = hourStart(now - LIVE_LOOKBACK_SECONDS);
    // up to the end of the hour of now, or of the newest ledger if that closed later
    const liveEnd = hourStart(Math.max(now, latestClose ?? 0)) + HOUR_SECONDS;
    // The hours since the watermark that the lookback does not reach, up to the hour of the newest ledger (the hours
    // after it hold no ledger: nothing in them can have changed).
    const catchUpEnd = Math.min(lookback, latestClose === undefined ? lookback : hourStart(latestClose) + HOUR_SECONDS);
    const windows: Array<[number, number]> = [
      [Math.min(lookback, watermark ?? lookback), catchUpEnd],
      [lookback, liveEnd],
    ];

    for (const [from, to] of windows) {
      for (const [start, end] of sliceRange(from, to)) {
        if (this.closing) return;
        if (this.clock() >= tick.deadline) {
          this.logger.warn(
            'Aggregator job stats_live reached the tick budget; it goes on with the next slice next tick',
          );
          return;
        }
        const rows = await this.recompute(this.ch, new Date(start * 1000), new Date(end * 1000), {
          signal: tick.signal,
        });
        this.logger.debug(`stats_live: ${iso(start)} - ${iso(end)}: ${rows} row(s)`);
      }
    }
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
    // nothing is written to agg_dirty once the shutdown has begun
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

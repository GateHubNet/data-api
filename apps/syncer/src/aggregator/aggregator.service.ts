import {
  AmmPoolsRecomputeAborted,
  ammPoolsWatermark,
  ClickHouseService,
  computeDailyVolumeSet,
  computeLiveVolumeSet,
  dailySetVersions,
  HOUR_SECONDS,
  livePeriodsOf,
  liveSetVersions,
  MarketsConfig,
  poolsChangedSince,
  poolsClosedIn,
  RatesService,
  recomputeAmmPools,
  recomputeStatsHourly,
  ShutdownSignals,
  StatsRecomputeAborted,
  Table,
  VOLUME_DAY_SETTLE_MS,
  VOLUME_METRICS,
  volumeDaysDone,
  VolumeMetric,
  VolumeRecomputeAborted,
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
 * How much of the tick `stats_dirty` may use. A backlog of ranges (a range-ingest of years marks thousands) would otherwise
 * take what `stats_live` left of the tick, and the jobs after it would get nothing.
 */
export const AGGREGATOR_DIRTY_BUDGET_MS = 10_000;

/**
 * How much of the tick `volume_live` (the seven live sets) may use. It runs first, so that the live volumes are refreshed at
 * every tick whatever the sweeps after it are doing; its sets are a handful of queries each, so this is a bound for a
 * database that has gone slow, not a share it needs.
 */
export const AGGREGATOR_VOLUME_LIVE_BUDGET_MS = 5000;

/** How much of the tick `volume_daily` (the sets of today and of yesterday: four) may use; it runs second, for the same reason. */
export const AGGREGATOR_VOLUME_DAILY_BUDGET_MS = 4000;

/**
 * How much of the tick `volume_backfill` may use. The closed days (a fresh deployment over years of history, or a new config
 * version) are computed newest first, a set at a time, until this is spent or the tick budget is, whichever comes first:
 * the job runs last, so the live work of the tick is done by then, and a tick that ends within its budget leaves the next
 * one to start on time.
 */
export const AGGREGATOR_VOLUME_BACKFILL_BUDGET_MS = 10_000;

/**
 * How much of the tick `amm_pools` may use. It runs right after the daily volumes, so that the pool list is refreshed at every
 * tick; a batch of pools is a few queries, so this is a bound for a database that has gone slow, or for the first sweep of
 * a deployment with thousands of pools (the sweep goes on where it stopped at the next tick).
 */
export const AGGREGATOR_AMM_POOLS_BUDGET_MS = 3000;

/** How many pools one batch of `amm_pools` recomputes (and so how far the cursor of the job moves at a time). */
export const AMM_POOLS_BATCH = 200;

/**
 * A batch of `amm_pools` that fails is halved until the pools that fail on their own are found (Ruling R-A15). When more than
 * this many of one batch fail, the cause is not the pools (the database, a limit) and the batch is the failure of the job: the
 * cursor stays behind it and the next tick does it again.
 */
export const MAX_ISOLATED_POOLS_PER_BATCH = 3;

/**
 * A pool that fails on its own is set aside, in memory, and tried again after this long, and after twice as long after each
 * further failure, up to `AMM_POOL_MAX_RETRY_MS`, while the cursor and the other pools go on. A restart forgets the set: the
 * pool is stale in the tables (`ammPoolsWatermark`), so the new process finds it again.
 */
export const AMM_POOL_RETRY_MS = 5 * 60_000;
export const AMM_POOL_MAX_RETRY_MS = 60 * 60_000;

/** A volume job gives up after this many sets failed in a tick, so that an outage does not log a line per set. */
export const MAX_FAILED_VOLUME_SETS_PER_TICK = 3;

/**
 * A closed day whose set failed is left alone for this long before the back-fill tries it again, and for twice as long after
 * each further failure, up to `VOLUME_BACKFILL_MAX_RETRY_MS`: a day that fails every time (bad data, a query over the memory
 * limit) must not stop the back-fill of the older days, which the cap of failures per tick would otherwise do from the newest
 * end for ever. Kept in memory: a restart tries them all again.
 */
export const VOLUME_BACKFILL_RETRY_MS = 5 * 60_000;
export const VOLUME_BACKFILL_MAX_RETRY_MS = 60 * 60_000;

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
   * The most of the tick this job may use, counted from the moment it starts, and never more than what is left of the tick
   * budget. It caps the job's OWN use and nothing else: it reserves no time for the jobs after it, and a job that runs later
   * only gets what the jobs before it left. So a job that has to run at every tick goes early in the list, and every job
   * that can run long (a sweep, a backlog, a back-fill) has a budget, which is what keeps it from taking the whole tick
   * from the ones after it. Without a budget the job may use all that is left.
   */
  readonly budgetMs?: number;
  run(tick: AggregatorTick): Promise<void>;
}

/** The jobs the aggregator has of its own, in the order of a tick. */
export type AggregatorJobName =
  | 'volume_live'
  | 'volume_daily'
  | 'amm_pools'
  | 'stats_live'
  | 'stats_dirty'
  | 'volume_backfill';

/** What the volume jobs work with: the rates of the network and its versioned markets config. */
export interface AggregatorVolumes {
  rates: RatesService;
  markets: MarketsConfig;
}

/** The functions of the shared package the volume jobs call; tests replace them. */
export interface VolumeFunctions {
  computeLiveSet: typeof computeLiveVolumeSet;
  computeDailySet: typeof computeDailyVolumeSet;
  daysDone: typeof volumeDaysDone;
  /** When each live set was last written, keyed `<metric>/<period>`: the stalest is started first. */
  liveVersions: typeof liveSetVersions;
  /** The same for the daily sets of today and of yesterday, keyed `<metric>/<day>`. */
  dailyVersions: typeof dailySetVersions;
}

/** What the `amm_pools` job works with: the rates of the network, for the value of a pool. */
export interface AggregatorAmmPools {
  rates: RatesService;
}

/** The functions of the shared package the `amm_pools` job calls; tests replace them. */
export interface AmmPoolsFunctions {
  /** Where the job goes on from after a start: see `ammPoolsWatermark`. */
  watermark: typeof ammPoolsWatermark;
  changedSince: typeof poolsChangedSince;
  /** The pools of the ledgers that closed in a window (the slice of an `agg_dirty` range). */
  poolsClosedIn: typeof poolsClosedIn;
  recompute: typeof recomputeAmmPools;
}

export interface AggregatorOptions {
  /** Default: `AGGREGATOR_INTERVAL_MS`. */
  intervalMs?: number;
  /** Default: `AGGREGATOR_TICK_BUDGET_MS`. */
  tickBudgetMs?: number;
  /** Default: `AGGREGATOR_LIVE_BUDGET_MS`. Short for `budgetsMs.stats_live`. */
  liveBudgetMs?: number;
  /** The budget of each job of the aggregator (see `AggregatorJob.budgetMs`); the defaults are the `AGGREGATOR_*_BUDGET_MS` constants. */
  budgetsMs?: Partial<Record<AggregatorJobName, number>>;
  /** With it the volume jobs run (live sets, today and yesterday, the back-fill and the days of `agg_dirty`); without it they do not. */
  volumes?: AggregatorVolumes;
  /** Replaces the volume functions of the shared package; for tests. */
  volumeFunctions?: Partial<VolumeFunctions>;
  /** With it the `amm_pools` job runs (the current state of every AMM pool, and the pools of the days of `agg_dirty`); without it it does not. */
  ammPools?: AggregatorAmmPools;
  /** Replaces the AMM functions of the shared package; for tests. */
  ammPoolsFunctions?: Partial<AmmPoolsFunctions>;
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
const DAY_SECONDS = 86_400;
/** The start of the UTC day of a time, unix seconds. */
const utcDayStart = (seconds: number): number => Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
/** `YYYY-MM-DD` of the UTC day that starts at `seconds`. */
const dayKey = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * The sets in the order they are started: first the ones whose last attempt did not fail, then the ones whose did, and within
 * each group the one whose newest version is the oldest first, a set with no version (never written) before all of them, equals
 * in the order they are listed in. A set that keeps failing is always the stalest, so without the second rule it would start
 * first at every tick, and a failure that is slow (a timeout longer than the budget), or three fast ones, would keep every
 * healthy set from being refreshed; it is tried last instead, with the budget that is left.
 */
function staleFirst<T extends { key: string }>(
  sets: T[],
  versions: ReadonlyMap<string, number>,
  failedLast: ReadonlySet<string> = new Set(),
): T[] {
  return sets
    .map((set, i) => ({ set, i, version: versions.get(set.key) ?? 0, failed: failedLast.has(set.key) ? 1 : 0 }))
    .sort((a, b) => a.failed - b.failed || a.version - b.version || a.i - b.i)
    .map(({ set }) => set);
}
const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The `aggregator` worker: once a minute it runs its jobs, in this order (the order is the priority: a job only gets what the
 * jobs before it left of the tick, so what has to be fresh at every tick goes first and what can run long goes last, each
 * with a budget of its own),
 *
 *  1. **volume_live** (with the `volumes` option): the seven live volume sets (trade volume for hour, day, 3day, 7day and 30day,
 *     payment volume for hour and day), each recomputed whole under one version, the stalest first: when the budget is too
 *     short for all of them every set is refreshed in turn.
 *  2. **volume_daily**: the daily volume sets of today and of yesterday (UTC), both metrics, the stalest first (yesterday's are
 *     the ones that are finalised after the midnight).
 *  3. **amm_pools** (with the `ammPools` option): rebuilds the `amm_pools` row of every AMM pool whose state rows changed
 *     since the cursor of the job, `AMM_POOLS_BATCH` pools at a time, oldest change first, for at most
 *     `AGGREGATOR_AMM_POOLS_BUDGET_MS`. The cursor is a ledger index kept in memory and found again from the tables when the
 *     process starts (`ammPoolsWatermark`: the ledger before the oldest state row that its pool's newest `amm_pools` row has not
 *     seen), so a restart takes the work up where it was; it moves past a batch only once the batch is written. A pool is a
 *     whole recompute from its state rows, so a batch is idempotent and a failed one is simply done again at the next tick.
 *     A batch that fails is halved to find the pools that fail on their own (at most `MAX_ISOLATED_POOLS_PER_BATCH`): those
 *     are set aside in memory, each counted as an error, and tried again after `AMM_POOL_RETRY_MS`, doubling up to an hour,
 *     while the cursor and the other pools go on; a batch that fails as a whole (the database) is the failure of the job.
 *  4. **stats_live**: recomputes `stats_hourly` for the hours that may have changed since the last tick, in two parts, oldest
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
 *     It gets at most `AGGREGATOR_LIVE_BUDGET_MS` of the tick. **During a long catch-up (weeks of ledgers after an outage, the
 *     first sweep of a database with years of history) the tail is not run, so the stats of the current hour are stale**;
 *     `syncer_aggregator_stats_lag_seconds` says how much is left.
 *  5. **stats_dirty**: drains `agg_dirty`, the ranges that ingest rewrote behind the aggregator, oldest first, each in slices
 *     of at most a day, for at most `AGGREGATOR_DIRTY_BUDGET_MS`. The days a slice covers have their daily volume sets
 *     recomputed too (with the `volumes` option), once per tick unless the ingest marked the day again after that, and the
 *     AMM pools with a state row in the slice's ledgers are rebuilt (with the `ammPools` option; a slice is started whole, like
 *     its volume sets, so the batches of a slice with thousands of pools are not cut by the budget, only by the shutdown).
 *  6. **volume_backfill**: the closed days whose daily sets do not exist, final, for the current `version` of the markets config,
 *     newest first, under its own budget. A day is closed when it is before yesterday AND the ingest has passed it (the newest
 *     ledger closed an hour after its end): the wall clock alone would call a day final while its ledgers are still to come.
 *     A day is computed once; a new config version computes them all again; a set that keeps failing waits (5 minutes,
 *     doubling, until the config version changes) and the older days go on.
 *
 * Every slice and every set is idempotent (`recomputeStatsHourly`; a volume set is a complete set under a new version), which is
 * what lets this retry, resume and crash anywhere:
 *
 *  - **A failed slice or set is retried next tick.** The live job stops at the first failure (its slices are in order, and a
 *    later one would move the watermark past it); the dirty job leaves the range in the queue, keeps the progress it made, and
 *    goes on with the next range, until three ranges have failed in a tick; the volume jobs go on with the next set until three
 *    have failed. Errors are logged and counted, and never stop the loop.
 *  - **A range of years does not stall a tick.** Slices and sets are started until the budget of the job or of the tick
 *    (`AGGREGATOR_TICK_BUDGET_MS`) is spent. The unfinished `agg_dirty` range is replaced by one that starts where the work
 *    stopped (inserted first, then the old one deleted), with the `created_at` it had; the live window picks up from the
 *    watermark; the back-fill finds the days that are still missing.
 *  - **A mark is never lost.** A range is deleted only after all its slices succeeded, and only the marks made at or before
 *    the one that was read; a range that the ingest marked again meanwhile stays and is done again.
 *  - **No overlap.** A tick that finds the previous one still running is skipped and logged.
 *  - **Shutdown** (module destroy, or SIGTERM through `ShutdownSignals`): no tick starts after it; the signal of the slice or set
 *    in flight is aborted, so that its rows are not written; no change to `agg_dirty` is started after it (a narrowing that
 *    has inserted its row finishes its delete, so as not to leave the old row beside the new one). The stop waits for the
 *    tick for at most `AGGREGATOR_SHUTDOWN_WAIT_MS`, then abandons it and says so.
 */
@Injectable()
export class AggregatorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly tickBudgetMs: number;
  private readonly budgets: Record<AggregatorJobName, number>;
  private readonly volumes?: AggregatorVolumes;
  private readonly volumeFns: VolumeFunctions;
  private readonly ammPools?: AggregatorAmmPools;
  private readonly ammFns: AmmPoolsFunctions;
  /**
   * The cursor of `amm_pools`: every pool with a state row up to this ledger has been rebuilt. Unknown until the first tick
   * reads it from the tables (`ammPoolsWatermark`); it only moves past a batch that was written.
   */
  private ammWatermark?: number;
  /** The pools of `amm_pools` that failed on their own: when to try each again, and the wait after the next failure. */
  private readonly ammRetry = new Map<string, { until: number; delayMs: number }>();
  /** Whether the back-fill has announced that it is under way (so that it says so once, and once more when it is done). */
  private backfilling = false;
  /** The sets of `volume_live` and `volume_daily` (by job, then `<metric>/<period or day>`) whose last attempt failed. */
  private readonly failedLast = { volume_live: new Set<string>(), volume_daily: new Set<string>() };
  /** The sets (`<metric>/<day>@<config version>`) of the back-fill that failed: when to try each again, and the wait after the next failure. */
  private readonly backfillBackoff = new Map<string, { until: number; delayMs: number }>();
  /** The volume jobs that hit their budget in the run in progress, and the ones with a warning out (until a run in time). */
  private readonly budgetHit = new Set<string>();
  private readonly budgetWarned = new Set<string>();
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
    this.budgets = {
      volume_live: AGGREGATOR_VOLUME_LIVE_BUDGET_MS,
      volume_daily: AGGREGATOR_VOLUME_DAILY_BUDGET_MS,
      amm_pools: AGGREGATOR_AMM_POOLS_BUDGET_MS,
      stats_live: options.liveBudgetMs ?? AGGREGATOR_LIVE_BUDGET_MS,
      stats_dirty: AGGREGATOR_DIRTY_BUDGET_MS,
      volume_backfill: AGGREGATOR_VOLUME_BACKFILL_BUDGET_MS,
      ...options.budgetsMs,
    };
    this.volumes = options.volumes;
    this.volumeFns = {
      computeLiveSet: computeLiveVolumeSet,
      computeDailySet: computeDailyVolumeSet,
      daysDone: volumeDaysDone,
      liveVersions: liveSetVersions,
      dailyVersions: dailySetVersions,
      ...options.volumeFunctions,
    };
    this.ammPools = options.ammPools;
    this.ammFns = {
      watermark: ammPoolsWatermark,
      changedSince: poolsChangedSince,
      poolsClosedIn,
      recompute: recomputeAmmPools,
      ...options.ammPoolsFunctions,
    };
    this.logger = options.logger ?? new Logger(AggregatorService.name);
    this.clock = options.now ?? Date.now;
    this.recompute = options.recompute ?? recomputeStatsHourly;
    // The order is the priority (see `AggregatorJob.budgetMs`): what must be fresh at every tick, the live volumes, goes first;
    // the sweeps and the back-fill, which can run long, come after it and have budgets of their own.
    this.jobs = [
      ...(this.volumes
        ? [
            {
              name: 'volume_live',
              budgetMs: this.budgets.volume_live,
              run: (tick: AggregatorTick) => this.volumeLive(tick),
            },
            {
              name: 'volume_daily',
              budgetMs: this.budgets.volume_daily,
              run: (tick: AggregatorTick) => this.volumeDaily(tick),
            },
          ]
        : []),
      ...(this.ammPools
        ? [
            {
              name: 'amm_pools',
              budgetMs: this.budgets.amm_pools,
              run: (tick: AggregatorTick) => this.ammPoolsJob(tick),
            },
          ]
        : []),
      { name: 'stats_live', budgetMs: this.budgets.stats_live, run: (tick) => this.statsLive(tick) },
      { name: 'stats_dirty', budgetMs: this.budgets.stats_dirty, run: (tick) => this.statsDirty(tick) },
      ...(this.volumes
        ? [
            {
              name: 'volume_backfill',
              budgetMs: this.budgets.volume_backfill,
              run: (tick: AggregatorTick) => this.volumeBackfill(tick),
            },
          ]
        : []),
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
      } finally {
        // a run that did not hit its budget ends the streak the warning was said for
        if (!this.budgetHit.delete(job.name)) this.budgetWarned.delete(job.name);
      }
    }
  }

  /** Logs and counts a failure of a job (or of one slice of it); one that comes of the shutdown is neither. */
  private failed(job: string, err: unknown, where = ''): void {
    if (
      this.closing &&
      (err instanceof StatsRecomputeAborted ||
        err instanceof VolumeRecomputeAborted ||
        err instanceof AmmPoolsRecomputeAborted)
    ) {
      this.logger.log(`Dropped the ${job} slice in flight at shutdown`);
      return;
    }
    this.metrics?.aggregatorErrorsTotal.inc({ job });
    this.logger.error(`Aggregator job ${job} failed${where}: ${describe(err)}`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // amm_pools
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Rebuilds the pools whose state rows changed since the cursor, a batch at a time, until nothing is left, the budget of the job
   * is spent, or the shutdown begins; then tries again the pools that were set aside (`ammPoolsRetries`). A pool that fails on
   * its own does not stop the others (`recomputeAmmPools`); a batch that fails as a whole is the error of the job, which is
   * logged and counted as `amm_pools`, and the jobs after this one still run. It leaves the cursor where it was, so the next
   * tick asks for the same pools again.
   */
  private async ammPoolsJob(tick: AggregatorTick): Promise<void> {
    const amm = this.ammPools;
    if (!amm) return;
    this.ammWatermark ??= await this.ammFns.watermark(this.ch);
    await this.ammPoolsLive(tick);
    await this.ammPoolsRetries(tick);
  }

  /** The pools that changed since the cursor, a batch at a time. */
  private async ammPoolsLive(tick: AggregatorTick): Promise<void> {
    for (;;) {
      if (!this.mayStartSet(tick, 'amm_pools')) return;
      const ledger = this.ammWatermark as number;
      const { accounts, upTo } = await this.ammFns.changedSince(this.ch, ledger, AMM_POOLS_BATCH);
      if (this.closing || accounts.length === 0) return;
      await this.recomputeAmmBatch(accounts, tick, 'amm_pools');
      this.logger.debug(`amm_pools: ${accounts.length} pool(s) up to ledger ${upTo}`);
      // a cursor that does not move would ask for the same pools for ever
      if (upTo <= ledger) return;
      this.ammWatermark = upTo;
    }
  }

  /**
   * Rebuilds a batch of pools. When it fails, it is halved to find the pools that fail on their own (at most
   * `MAX_ISOLATED_POOLS_PER_BATCH`; a recompute of the others goes on), and those are set aside for a retry
   * (`AMM_POOL_RETRY_MS`), each counted as an error of `job`. When more fail, or the budget of the job is spent first, the
   * error of the batch is thrown and nothing is set aside. The pools that wait for a retry are left out: the retry rebuilds
   * them with everything they have by then.
   */
  private async recomputeAmmBatch(accounts: string[], tick: AggregatorTick, job: string): Promise<void> {
    const amm = this.ammPools as AggregatorAmmPools;
    const batch = accounts.filter((account) => !this.ammRetry.has(account));
    if (batch.length === 0) return;
    const recompute = (list: string[]) => this.ammFns.recompute(this.ch, amm.rates, list, { signal: tick.signal });
    try {
      await recompute(batch);
      return;
    } catch (err) {
      if (this.closing) throw err;
      const isolated: Array<{ account: string; err: unknown }> = [];
      const isolate = async (list: string[], failure: unknown): Promise<void> => {
        if (list.length === 1) {
          isolated.push({ account: list[0], err: failure });
          if (isolated.length > MAX_ISOLATED_POOLS_PER_BATCH) throw err;
          return;
        }
        const middle = Math.ceil(list.length / 2);
        for (const half of [list.slice(0, middle), list.slice(middle)]) {
          if (this.closing || this.clock() >= tick.deadline) throw err;
          try {
            await recompute(half);
          } catch (halfErr) {
            if (this.closing) throw halfErr;
            await isolate(half, halfErr);
          }
        }
      };
      await isolate(batch, err);
      for (const { account, err: failure } of isolated) {
        this.ammRetry.set(account, { until: this.clock() + AMM_POOL_RETRY_MS, delayMs: AMM_POOL_RETRY_MS });
        this.failed(job, failure, ` for pool ${account}, set aside to be tried again`);
      }
    }
  }

  /** The pools that were set aside and whose wait is over, one at a time, under the budget of the job. */
  private async ammPoolsRetries(tick: AggregatorTick): Promise<void> {
    const amm = this.ammPools as AggregatorAmmPools;
    const due = [...this.ammRetry].filter(([, retry]) => retry.until <= this.clock()).map(([account]) => account);
    for (const account of due) {
      if (!this.mayStartSet(tick, 'amm_pools')) return;
      try {
        await this.ammFns.recompute(this.ch, amm.rates, [account], { signal: tick.signal });
        this.ammRetry.delete(account);
        this.logger.log(`amm_pools: pool ${account} is rebuilt again`);
      } catch (err) {
        if (this.closing) throw err;
        const delayMs = Math.min((this.ammRetry.get(account)?.delayMs ?? AMM_POOL_RETRY_MS) * 2, AMM_POOL_MAX_RETRY_MS);
        this.ammRetry.set(account, { until: this.clock() + delayMs, delayMs });
        this.failed('amm_pools', err, ` for pool ${account}, tried again in ${Math.round(delayMs / 60_000)} min`);
      }
    }
  }

  /**
   * The pools with a state row in the ledgers that closed in the slice `[start, end)` of an `agg_dirty` range, rebuilt a batch at
   * a time (a pool that fails on its own is set aside like those of the live job; a slice most of whose pools fail fails the
   * slice). The slice is started whole (the budget is checked before a slice, as for its stats and volumes); only the shutdown
   * stops it between batches, and then the range is left as it is (`recomputeDirty` writes nothing to `agg_dirty` after it).
   */
  private async ammPoolsOfSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    const amm = this.ammPools;
    if (!amm) return;
    const accounts = await this.ammFns.poolsClosedIn(this.ch, amm.rates, new Date(start * 1000), new Date(end * 1000));
    for (let i = 0; i < accounts.length; i += AMM_POOLS_BATCH) {
      if (this.closing) return;
      await this.recomputeAmmBatch(accounts.slice(i, i + AMM_POOLS_BATCH), tick, 'amm_pools_dirty');
    }
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
    // the days whose volumes this tick has recomputed, and the clock reading when it began (see `volumesOfSlice`)
    const volumeDays = new Map<string, number>();
    let failedRanges = 0;
    for (const range of ranges) {
      if (this.closing) return;
      if (this.clock() >= tick.deadline) {
        this.logger.warn('Aggregator job stats_dirty reached the tick budget; the ranges left go on next tick');
        return;
      }
      const outcome = await this.recomputeDirty(range, tick, volumeDays);
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
  private async recomputeDirty(
    range: DirtyRange,
    tick: AggregatorTick,
    volumeDays: Map<string, number>,
  ): Promise<'done' | 'budget' | 'failed'> {
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
      try {
        await this.volumesOfSlice(start, end, range.created, volumeDays, tick);
      } catch (err) {
        this.failed('volume_dirty', err, ` in ${iso(start)} - ${iso(end)}`);
        outcome = 'failed';
        break;
      }
      try {
        await this.ammPoolsOfSlice(start, end, tick);
      } catch (err) {
        this.failed('amm_pools_dirty', err, ` in ${iso(start)} - ${iso(end)}`);
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

  /**
   * The daily volume sets of the days a slice `[start, end)` covers, both metrics, after its stats. A day is done once per
   * tick (`done` maps a day to the clock reading at which its recompute began), unless the range was marked after that: the
   * ingest wrote more ledgers into the day meanwhile, which that recompute may not have seen. A failure fails the slice, so
   * that the range stays in the queue and the day is done again next tick.
   */
  private async volumesOfSlice(
    start: number,
    end: number,
    marked: number,
    done: Map<string, number>,
    tick: AggregatorTick,
  ): Promise<void> {
    const volumes = this.volumes;
    if (!volumes) return;
    for (let dayStart = utcDayStart(start); dayStart < end; dayStart += DAY_SECONDS) {
      const key = dayKey(dayStart);
      const began = done.get(key);
      if (began !== undefined && began >= marked) continue;
      const startedAt = this.clock();
      for (const metric of VOLUME_METRICS) {
        if (this.closing) return;
        await this.volumeFns.computeDailySet(
          this.ch,
          volumes.rates,
          volumes.markets,
          metric,
          new Date(dayStart * 1000),
          {
            signal: tick.signal,
          },
        );
      }
      done.set(key, startedAt);
    }
  }

  /**
   * Whether a job that works in sets or batches (the volume jobs, `amm_pools`) may start another: not after the shutdown began,
   * and not past its budget. Running out of the budget
   * is how a long back-fill works, tick after tick, so it is said once (a warning) for as long as the runs of the job keep
   * hitting it, and at debug level after that; a run that finishes in time ends the streak.
   */
  private mayStartSet(tick: AggregatorTick, job: string): boolean {
    if (this.closing) return false;
    if (this.clock() < tick.deadline) return true;
    this.budgetHit.add(job);
    const text = `Aggregator job ${job} reached its budget; the sets left go on next tick`;
    if (this.budgetWarned.has(job)) {
      this.logger.debug(text);
    } else {
      this.budgetWarned.add(job);
      this.logger.warn(`${text} (said once until a tick finishes in time)`);
    }
    return false;
  }

  /**
   * The newest version of each set, for `staleFirst`; when the read fails the order is the default one (the failure is
   * logged and counted), so that a problem with this read cannot keep the sets from being written.
   */
  private async versionsOf(job: string, read: () => Promise<Map<string, number>>): Promise<Map<string, number>> {
    try {
      return await read();
    } catch (err) {
      this.failed(job, err, ' reading the versions of the sets');
      return new Map();
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // volume_live, volume_daily, volume_backfill
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The live sets of both metrics, every period, with the time of the tick, the STALEST first (the one written longest ago;
   * a set with no row at all is the stalest of all), so that with a budget that is too short for them all every set is
   * refreshed in turn, none always last. A set whose last attempt failed is started after the ones that did not fail (R87): it is the
   * stalest for as long as it fails, and would otherwise start first at every tick and keep the healthy ones from running.
   */
  private async volumeLive(tick: AggregatorTick): Promise<void> {
    const volumes = this.volumes;
    if (!volumes) return;
    const sets = VOLUME_METRICS.flatMap((metric) =>
      livePeriodsOf(metric).map((period) => ({ metric, period, key: `${metric}/${period}` })),
    );
    const versions = await this.versionsOf('volume_live', () => this.volumeFns.liveVersions(this.ch));
    const failedLast = this.failedLast.volume_live;
    let failed = 0;
    for (const { metric, period, key } of staleFirst(sets, versions, failedLast)) {
      if (!this.mayStartSet(tick, 'volume_live')) return;
      try {
        await this.volumeFns.computeLiveSet(this.ch, volumes.rates, volumes.markets, metric, period, tick.now, {
          signal: tick.signal,
        });
        failedLast.delete(key);
      } catch (err) {
        this.failed('volume_live', err, ` in ${metric} ${period}`);
        if (!this.closing) failedLast.add(key);
        if (++failed >= MAX_FAILED_VOLUME_SETS_PER_TICK) return;
      }
    }
  }

  /**
   * The daily sets of today and of yesterday (UTC), both metrics, the stalest first (as `volumeLive`): the day is not over,
   * or only just, so they change; and yesterday's are the ones that must be finalised after the midnight.
   */
  private async volumeDaily(tick: AggregatorTick): Promise<void> {
    const volumes = this.volumes;
    if (!volumes) return;
    const today = utcDayStart(Math.floor(tick.now.getTime() / 1000));
    const sets = [today, today - DAY_SECONDS].flatMap((dayStart) =>
      VOLUME_METRICS.map((metric) => ({ metric, dayStart, key: `${metric}/${dayKey(dayStart)}` })),
    );
    const versions = await this.versionsOf('volume_daily', () =>
      this.volumeFns.dailyVersions(this.ch, new Date((today - DAY_SECONDS) * 1000), new Date(today * 1000)),
    );
    // the memory of a failure does not outlive the day it was about
    const failedLast = this.failedLast.volume_daily;
    for (const key of failedLast) if (!sets.some((set) => set.key === key)) failedLast.delete(key);
    let failed = 0;
    for (const { metric, dayStart, key } of staleFirst(sets, versions, failedLast)) {
      if (!this.mayStartSet(tick, 'volume_daily')) return;
      try {
        await this.volumeFns.computeDailySet(
          this.ch,
          volumes.rates,
          volumes.markets,
          metric,
          new Date(dayStart * 1000),
          {
            signal: tick.signal,
          },
        );
        failedLast.delete(key);
      } catch (err) {
        this.failed('volume_daily', err, ` in ${metric} ${dayKey(dayStart)}`);
        if (!this.closing) failedLast.add(key);
        if (++failed >= MAX_FAILED_VOLUME_SETS_PER_TICK) return;
      }
    }
  }

  /**
   * The closed days that have no final daily set of the current config version, newest first, both metrics, for as long as
   * the budget of the job and of the tick last. A day is closed (a day to back-fill) when it is before yesterday AND the ingest
   * has passed it: the newest ingested ledger closed at least `VOLUME_DAY_SETTLE_MS` after the end of the day. By wall clock
   * alone a day would be taken for final while its ledgers are still to come (after an outage, or when the ingest started at an
   * old ledger), and the set made then would stay wrong; a set carries the same test (`computeDailyVolumeSet`), so a day
   * that was computed too early is computed again once the ingest has passed it. The sets that exist are found by one read
   * per metric (`volumeDaysDone`), so a day is computed once, and a new version of the config computes them all again;
   * whatever is left is found again next tick. A set that fails is left alone for a while (`VOLUME_BACKFILL_RETRY_MS`,
   * doubling; remembered per config version, so that a config change that may have fixed it retries it at once), so that the days
   * before it go on. It says when it starts and when it is done.
   */
  private async volumeBackfill(tick: AggregatorTick): Promise<void> {
    const volumes = this.volumes;
    if (!volumes) return;
    // the stats and the dirty queue before it may have used the tick up: do not even read what cannot be worked on
    if (this.closing || this.clock() >= tick.deadline) return;
    const [firstClose, newestClose] = await Promise.all([this.firstCloseTime(), this.latestCloseTime()]);
    if (firstClose === undefined || newestClose === undefined) return;
    const closedUntil = Math.min(
      utcDayStart(Math.floor(tick.now.getTime() / 1000)) - DAY_SECONDS,
      utcDayStart(newestClose - VOLUME_DAY_SETTLE_MS / 1000),
    );
    if (utcDayStart(firstClose) >= closedUntil) return;
    const first = utcDayStart(firstClose);
    const version = volumes.markets.version;

    const done = new Map<VolumeMetric, Set<string>>();
    for (const metric of VOLUME_METRICS) {
      done.set(
        metric,
        await this.volumeFns.daysDone(this.ch, metric, new Date(first * 1000), new Date(closedUntil * 1000), version),
      );
    }
    const missing: Array<{ metric: VolumeMetric; dayStart: number; key: string }> = [];
    for (let dayStart = closedUntil - DAY_SECONDS; dayStart >= first; dayStart -= DAY_SECONDS) {
      for (const metric of VOLUME_METRICS) {
        if (!done.get(metric)?.has(dayKey(dayStart)))
          missing.push({ metric, dayStart, key: `${metric}/${dayKey(dayStart)}@${version}` });
      }
    }
    // a set that is done (or is no longer wanted) has no failure to remember
    const wanted = new Set(missing.map((set) => set.key));
    for (const key of this.backfillBackoff.keys()) if (!wanted.has(key)) this.backfillBackoff.delete(key);
    if (missing.length === 0) {
      this.announceBackfill(false, 0);
      return;
    }
    this.announceBackfill(true, missing.length);

    let failed = 0;
    let waiting = 0;
    for (const { metric, dayStart, key } of missing) {
      const backoff = this.backfillBackoff.get(key);
      if (backoff !== undefined && backoff.until > this.clock()) {
        waiting++;
        continue;
      }
      if (!this.mayStartSet(tick, 'volume_backfill')) return;
      try {
        await this.volumeFns.computeDailySet(
          this.ch,
          volumes.rates,
          volumes.markets,
          metric,
          new Date(dayStart * 1000),
          {
            signal: tick.signal,
          },
        );
        this.backfillBackoff.delete(key);
      } catch (err) {
        this.failed('volume_backfill', err, ` in ${metric} ${dayKey(dayStart)}`);
        if (!this.closing) {
          const delayMs =
            backoff === undefined
              ? VOLUME_BACKFILL_RETRY_MS
              : Math.min(backoff.delayMs * 2, VOLUME_BACKFILL_MAX_RETRY_MS);
          this.backfillBackoff.set(key, { until: this.clock() + delayMs, delayMs });
        }
        if (++failed >= MAX_FAILED_VOLUME_SETS_PER_TICK) return;
      }
    }
    if (failed === 0 && waiting === 0 && !this.closing) this.announceBackfill(false, 0);
  }

  /** Says once that the back-fill is under way (and how much there is), and once that it is done. */
  private announceBackfill(under: boolean, sets: number): void {
    if (under && !this.backfilling) {
      this.backfilling = true;
      this.logger.log(`Volume back-fill: ${sets} daily sets to compute, newest day first`);
    } else if (!under && this.backfilling) {
      this.backfilling = false;
      this.logger.log('Volume back-fill is done: every closed day has its daily sets');
    }
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

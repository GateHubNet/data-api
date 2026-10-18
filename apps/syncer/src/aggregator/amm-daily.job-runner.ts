import {
  AMM_DAILY_CONFIG_VERSION,
  ammDailyVersions,
  ammDaysDone,
  ammFirstDay,
  computeAmmDaily,
  markAmmDayOwed,
  RatesService,
} from '@gatehub/data-api-shared';
import {
  AggregatorJobContext,
  AggregatorTick,
  Backoff,
  backoffAfterFailure,
  closedUntil,
  DAY_SECONDS,
  dayKey,
  MAX_FAILED_VOLUME_SETS_PER_TICK,
  staleFirst,
  utcDayStart,
} from './job-context';

/**
 * A closed day of `amm_daily` whose set failed is left alone for this long before the back-fill tries it again, and for twice
 * as long after each further failure, up to `AMM_DAILY_BACKFILL_MAX_RETRY_MS`, so that a day that fails every time does not
 * stop the back-fill of the older days (as `VOLUME_BACKFILL_RETRY_MS`). Kept in memory: a restart tries them all again.
 */
export const AMM_DAILY_BACKFILL_RETRY_MS = 5 * 60_000;
export const AMM_DAILY_BACKFILL_MAX_RETRY_MS = 60 * 60_000;

/** What the `amm_daily` job works with: the rates of the network, for the value of a pool at the end of a day. */
export interface AggregatorAmmDaily {
  rates: RatesService;
}

/** The functions of the shared package the `amm_daily` job calls; tests replace them. */
export interface AmmDailyFunctions {
  /** Recomputes the set of a UTC day. */
  compute: typeof computeAmmDaily;
  /** Which of some days have a final set of a config version. */
  daysDone: typeof ammDaysDone;
  /** The newest version of the set of each day of a range, keyed `YYYY-MM-DD`: the stalest is started first. */
  versions: typeof ammDailyVersions;
  /** When the first pool activity closed (unix seconds), none without any: where the back-fill starts. */
  firstDay: typeof ammFirstDay;
  /** Marks the set of a day owed a recompute in the tables (Ruling R-A27): the same rows, not final. */
  markOwed: typeof markAmmDayOwed;
}

/** The functions of the shared package, for what the options do not replace. */
export const AMM_DAILY_FUNCTIONS: AmmDailyFunctions = {
  compute: computeAmmDaily,
  daysDone: ammDaysDone,
  versions: ammDailyVersions,
  firstDay: ammFirstDay,
  markOwed: markAmmDayOwed,
};

/**
 * The `amm_daily` job of the aggregator (see `AggregatorService`, job 6), and its hook in the slices of `agg_dirty`: one set per
 * UTC day with the stats of every AMM pool, today and yesterday, then the back-fill of the closed days. Its state (the days that
 * failed and when to try them again) is its own; the database, the clock, the budgets and the rules of the tick are the
 * service's (`AggregatorJobContext`).
 */
export class AmmDailyJobRunner {
  /** Today and yesterday (`YYYY-MM-DD`) whose set failed last time: they are tried behind the other. */
  private readonly failedLast = new Set<string>();
  /**
   * The days of `amm_daily` (`YYYY-MM-DD`) that failed and wait to be tried again: closed days of the back-fill, and days that
   * failed on the dirty path (`owed`: Ruling R-A22). When to try each again, and the wait after the next failure.
   */
  private readonly backoff = new Map<string, Backoff>();

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly amm: AggregatorAmmDaily,
    private readonly fns: AmmDailyFunctions,
  ) {}

  /**
   * Today, and yesterday until its set is final (Ruling R-A21: `ammDaysDone`; the dirty path covers a rewrite after that), the
   * stalest first and a day that failed last time behind the other (R87: a day that keeps failing is the stalest for ever, and
   * would otherwise start first at every run); then the days that failed on the dirty path and are due again (`retries`);
   * then the back-fill of the closed days: all under the budget of the job, with a floor of one day for the run, which is the
   * first due owed day if there is one and the newest wanted closed day if not. A day that
   * fails is logged and counted once under `amm_daily` and tried again at the next run; it does not stop the other day or the
   * back-fill. A day is one set under one version: there is no isolation of a pool that fails on its own (as `amm_pools` has),
   * the whole day is tried again.
   */
  async run(tick: AggregatorTick): Promise<void> {
    const today = utcDayStart(Math.floor(tick.now.getTime() / 1000));
    const yesterday = today - DAY_SECONDS;
    const sets = [today, ...((await this.finalDay(yesterday)) ? [] : [yesterday])].map((dayStart) => ({
      dayStart,
      key: dayKey(dayStart),
    }));
    const versions = await this.ctx.versionsOf('amm_daily', () =>
      this.fns.versions(this.ctx.ch, new Date(yesterday * 1000), new Date(today * 1000)),
    );
    // the memory of a failure does not outlive the day it was about
    const failedLast = this.failedLast;
    for (const key of failedLast) if (!sets.some((set) => set.key === key)) failedLast.delete(key);
    for (const { dayStart, key } of staleFirst(sets, versions, failedLast)) {
      if (!this.ctx.mayStartSet(tick, 'amm_daily')) break;
      try {
        await this.compute('amm_daily', dayStart, tick);
        failedLast.delete(key);
        this.backoff.delete(key);
      } catch (err) {
        this.ctx.failed('amm_daily', err, ` in ${key}`);
        failedLast.add(key);
      }
    }
    // the floor of the run is one day that starts whatever is left of the budget: a due owed day if there is one, else the
    // newest wanted closed day
    const retried = await this.retries(tick, new Set(sets.map((set) => set.key)));
    await this.backfill(tick, retried === 0);
  }

  /**
   * Recomputes the set of the day that starts at `dayStart`, and warns when it took longer than the budget of `amm_daily`
   * (Ruling R-A25), whether it worked or not: the budget is checked between days, a day is never cut, so a day that takes
   * longer than the budget makes the tick run that much longer (and at worst past its interval, which skips the next tick).
   */
  private async compute(job: 'amm_daily' | 'amm_daily_dirty', dayStart: number, tick: AggregatorTick): Promise<void> {
    const began = this.ctx.clock();
    try {
      await this.fns.compute(this.ctx.ch, this.amm.rates, new Date(dayStart * 1000), { signal: tick.signal });
    } finally {
      const took = this.ctx.clock() - began;
      const budget = this.ctx.budgets.amm_daily;
      if (took > budget && !this.ctx.closing()) {
        this.ctx.logger.warn(
          `Aggregator job ${job}: the set of ${dayKey(dayStart)} took ${took} ms, more than the budget of amm_daily (${budget} ms): a day is never cut, so the tick ran that much longer`,
        );
      }
    }
  }

  /** Whether the set of a day is final, made by the current computation. A read that fails is logged and counted: no. */
  private async finalDay(dayStart: number): Promise<boolean> {
    try {
      const done = await this.fns.daysDone(this.ctx.ch, AMM_DAILY_CONFIG_VERSION, [new Date(dayStart * 1000)]);
      return done.has(dayKey(dayStart));
    } catch (err) {
      this.ctx.failed('amm_daily', err, ' reading the days done');
      return false;
    }
  }

  /**
   * The days that failed on the dirty path (Ruling R-A22) and whose wait is over, tried again under the budget of the job: the
   * ones that have failed fewer times first (R87: a day that keeps failing goes behind the others), then the ones due longest.
   * A day that works is forgotten; one that fails waits twice as long, up to an hour. `except` are the days this run has just
   * tried. The first due day starts whatever is left of the budget (the floor of the run, Ruling R-A23: while today alone takes
   * the budget, an owed day would never be tried); the others need what is left. Returns how many days it started.
   */
  private async retries(tick: AggregatorTick, except: ReadonlySet<string>): Promise<number> {
    let started = 0;
    const due = [...this.backoff]
      .filter(([key, wait]) => wait.owed && wait.until <= this.ctx.clock() && !except.has(key))
      .sort(([, a], [, b]) => a.delayMs - b.delayMs || a.until - b.until);
    for (const [key, wait] of due) {
      if (started > 0 && !this.ctx.mayStartSet(tick, 'amm_daily')) return started;
      started++;
      try {
        await this.compute('amm_daily', Date.parse(`${key}T00:00:00Z`) / 1000, tick);
        this.backoff.delete(key);
      } catch (err) {
        this.ctx.failed('amm_daily', err, ` in ${key}`);
        if (!this.ctx.closing()) {
          this.backoff.set(key, {
            ...backoffAfterFailure(
              wait,
              this.ctx.clock(),
              AMM_DAILY_BACKFILL_RETRY_MS,
              AMM_DAILY_BACKFILL_MAX_RETRY_MS,
            ),
            owed: true,
          });
        }
      }
    }
    return started;
  }

  /**
   * The closed days that have no final set of the current `AMM_DAILY_CONFIG_VERSION`, newest first, for as long as the budget of
   * the job and of the tick last, and, when the retries have not started a day, at least one day at each run (the floor: today
   * and yesterday may have used the budget up, and the back-fill would never move). A day is closed when it is before yesterday AND the ingest has passed it
   * (`closedUntil`), and the back-fill starts at the day of the first pool activity. The days that are done are found by one
   * read (`ammDaysDone`), so a day is computed once, and a new config version computes them all again. A day that fails is left
   * alone for a while (`AMM_DAILY_BACKFILL_RETRY_MS`, doubling), so that the days before it go on. It says when it starts and
   * when it is done.
   */
  private async backfill(tick: AggregatorTick, floor = true): Promise<void> {
    if (this.ctx.closing()) return;
    const [firstActivity, newestClose] = await Promise.all([
      this.fns.firstDay(this.ctx.ch),
      this.ctx.latestCloseTime(),
    ]);
    if (firstActivity === undefined || newestClose === undefined) return;
    const until = closedUntil(Math.floor(tick.now.getTime() / 1000), newestClose);
    const first = utcDayStart(firstActivity);
    if (first >= until) return;

    const days: number[] = [];
    for (let dayStart = until - DAY_SECONDS; dayStart >= first; dayStart -= DAY_SECONDS) days.push(dayStart);
    const done = await this.fns.daysDone(
      this.ctx.ch,
      AMM_DAILY_CONFIG_VERSION,
      days.map((dayStart) => new Date(dayStart * 1000)),
    );
    const missing = days.filter((dayStart) => !done.has(dayKey(dayStart)));
    // a day that is done (or is no longer wanted) has no failure to remember: if it is wanted and fails again, it waits afresh
    // (a day owed by the dirty path is kept: it is final, and not wanted here, but its recompute is due)
    const wanted = new Set(missing.map(dayKey));
    for (const [key, wait] of this.backoff) if (!wait.owed && !wanted.has(key)) this.backoff.delete(key);
    if (missing.length === 0) {
      this.ctx.announceBackfill('amm_daily', false, 0);
      return;
    }
    this.ctx.announceBackfill('amm_daily', true, missing.length);

    let started = 0;
    let failed = 0;
    let waiting = 0;
    for (const dayStart of missing) {
      const key = dayKey(dayStart);
      const backoff = this.backoff.get(key);
      // a day that waits, and a day that failed on the dirty path (the retries of the job take it when it is due), is left alone
      if (backoff !== undefined && (backoff.owed || backoff.until > this.ctx.clock())) {
        waiting++;
        continue;
      }
      // the first day of a run is the floor, unless the retries have started one: it starts whatever is left of the budget
      if ((started > 0 || !floor) && !this.ctx.mayStartSet(tick, 'amm_daily')) return;
      started++;
      try {
        await this.compute('amm_daily', dayStart, tick);
        this.backoff.delete(key);
      } catch (err) {
        this.ctx.failed('amm_daily', err, ` in ${key}`);
        if (!this.ctx.closing()) {
          this.backoff.set(
            key,
            backoffAfterFailure(
              backoff,
              this.ctx.clock(),
              AMM_DAILY_BACKFILL_RETRY_MS,
              AMM_DAILY_BACKFILL_MAX_RETRY_MS,
            ),
          );
        }
        if (++failed >= MAX_FAILED_VOLUME_SETS_PER_TICK) return;
      }
    }
    if (failed === 0 && waiting === 0 && !this.ctx.closing()) this.ctx.announceBackfill('amm_daily', false, 0);
  }

  /**
   * The `amm_daily` sets of the days a slice `[start, end)` covers, after its stats. A day is done once per tick (`done` maps a
   * day to the clock reading at which its recompute began), unless the range was marked after that: the ingest wrote more
   * ledgers into the day meanwhile, which that recompute may not have seen. A day that fails does not fail the slice (Ruling
   * R-A22): it is logged and counted under `amm_daily_dirty`, owed to the retries of the job (in memory: the fast path) and
   * marked owed in the tables (Ruling R-A27: its set again under a newer version that is not final, so that readers keep their
   * rows and the back-fill computes the day again, also after a restart, which forgets what is in memory), and the slice and its
   * range go on; it is not tried again in this tick. A mark that fails is logged and counted as well. Only the shutdown stops
   * the slice, and then the range stays.
   */
  async daysOfSlice(
    start: number,
    end: number,
    marked: number,
    done: Map<string, number>,
    tick: AggregatorTick,
  ): Promise<void> {
    for (let dayStart = utcDayStart(start); dayStart < end; dayStart += DAY_SECONDS) {
      const key = dayKey(dayStart);
      const began = done.get(key);
      if (began !== undefined && began >= marked) continue;
      if (this.ctx.closing()) return;
      const startedAt = this.ctx.clock();
      try {
        await this.compute('amm_daily_dirty', dayStart, tick);
        this.backoff.delete(key);
        done.set(key, startedAt);
      } catch (err) {
        if (this.ctx.closing()) throw err;
        this.ctx.failed('amm_daily_dirty', err, ` for ${key}, owed to the retries of amm_daily`);
        this.backoff.set(key, {
          ...backoffAfterFailure(
            this.backoff.get(key),
            this.ctx.clock(),
            AMM_DAILY_BACKFILL_RETRY_MS,
            AMM_DAILY_BACKFILL_MAX_RETRY_MS,
          ),
          owed: true,
        });
        done.set(key, Number.POSITIVE_INFINITY); // not again in this tick, whatever the marks
        await this.markOwed(dayStart);
      }
    }
  }

  /** Marks a day owed in the tables (`markAmmDayOwed`); a failure is logged and counted under `amm_daily_dirty`, and that is all. */
  private async markOwed(dayStart: number): Promise<void> {
    try {
      await this.fns.markOwed(this.ctx.ch, new Date(dayStart * 1000));
    } catch (err) {
      this.ctx.failed('amm_daily_dirty', err, ` marking ${dayKey(dayStart)} owed in the tables`);
    }
  }
}

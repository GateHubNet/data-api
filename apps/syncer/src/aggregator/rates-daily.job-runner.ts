import { LATEST_DAYS } from '@gatehub/data-api-shared';
import {
  AggregateFunctions,
  AggregateJobDeps,
  AggregatorAggregates,
  DAY_SECONDS,
  defaultAggregateFunctions,
  isoDay,
  MAX_FAILED_AGGREGATE_SETS_PER_TICK,
  newestFinalDay,
  SetBackoff,
  SetGate,
} from './aggregate-job-deps';
import type { AggregatorJob, AggregatorTick } from './aggregator.service';

/**
 * The `rates_daily` job of the aggregator (job 9 of a tick, see spec 3 and 3.1): the rate of every asset against the native
 * currency for each closed, final UTC day, in `native_rates_daily`, and the hook of the slices of `agg_dirty` (`ofSlice`). The
 * state of the job (the waits of the days that failed, the announcement it has made, the day of the first native trade) is its
 * own; the database, the clock, the budget and the rule of failure are the deps'.
 *
 * Per run, a day at a time, newest first: yesterday once it is final and has no valid set, then the closed final days that have
 * none, down to the day of the first trade against the native currency (read once, and again only while there is none). A
 * day is final once the newest committed ledger closed at least `VOLUME_DAY_SETTLE_MS` after its end, so today never is, and
 * yesterday only once the ingest has passed it. A day is valid when its newest sentinel is not stale and has the current config
 * version (`validRateDays`), which is why a correction (`ofSlice`) and a new config version both come back to the same list.
 * At least one day is computed per run, whatever is left of the budget (the readers value a day that has no set on read, and
 * that is the slow path); the others only while the deadline of the tick has not passed and the shutdown has not begun. A day
 * whose rate reads the trades of a range that `agg_dirty` still holds waits until the range is drained (`deferredDays`): its
 * hook would make a set computed now stale again.
 *
 * A day that fails is logged and counted (`deps.failed`), waits 5 minutes before it is tried again and twice as long after each
 * further failure, up to an hour, while the others go on; the run gives up after 3 days failed. The job says once that the
 * back-fill (the days older than yesterday) is under way and once that it is done, and `syncer_rates_daily_missing_days` is the
 * closed final days, from the first native trade, that have no valid set.
 */
export class RatesDailyJobRunner {
  private readonly fns: AggregateFunctions;
  private readonly backoff = new SetBackoff();
  private readonly gate: SetGate;
  /** The day of the first trade against the native currency (`YYYY-MM-DD`), read until there is one. */
  private firstDay?: string;
  /** Whether the back-fill has announced that it is under way (so that it says so once, and once more when it is done). */
  private backfilling = false;

  constructor(
    private readonly deps: AggregateJobDeps,
    private readonly aggregates: AggregatorAggregates,
    fns: Partial<AggregateFunctions> = {},
  ) {
    this.fns = { ...defaultAggregateFunctions(), ...fns };
    this.gate = new SetGate(deps, 'rates_daily');
  }

  job(): AggregatorJob {
    return { name: 'rates_daily', budgetMs: this.deps.budgetMs, run: (tick) => this.run(tick) };
  }

  private async run(tick: AggregatorTick): Promise<void> {
    try {
      await this.refresh(tick);
    } finally {
      this.gate.endRun();
    }
  }

  /**
   * The hook of `agg_dirty`: a slice `[start, end)` (unix seconds) that touches the days X to Y marks the days X to Y + 14
   * stale (the rate of a day reads the trades of the 14 days before it), each of them that has a valid set; the job computes
   * them again, newest first. A failure rejects: the caller fails the slice, which keeps its range, so a mark is never lost.
   * Nothing is started once the shutdown has begun.
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    if (this.deps.closing() || end <= start) return;
    const first = Math.floor(start / DAY_SECONDS) * DAY_SECONDS;
    const last = Math.floor((end - 1) / DAY_SECONDS) * DAY_SECONDS;
    const days: string[] = [];
    for (let day = first; day <= last + LATEST_DAYS * DAY_SECONDS; day += DAY_SECONDS) days.push(isoDay(day));
    const marked = await this.fns.markRatesStale(this.deps.ch, days, { signal: tick.signal });
    this.deps.logger.debug(
      `rates_daily: ${days[0]} - ${days[days.length - 1]}: ${marked} day(s) marked stale (agg_dirty)`,
    );
  }

  private async refresh(tick: AggregatorTick): Promise<void> {
    const { deps, fns } = this;
    if (deps.closing()) return;
    const [newest, firstDay] = await Promise.all([
      fns.newestLedgerClose(deps.ch),
      this.firstDay === undefined ? fns.firstNativeTradeDay(deps.ch, this.aggregates.rates.nativeCurrency) : undefined,
    ]);
    if (firstDay !== undefined) this.firstDay = firstDay;
    // a database without a ledger, or without a trade against the native currency, has no day to compute
    const newestFinal = newest === undefined ? undefined : newestFinalDay(newest, tick.now);
    if (newestFinal === undefined || this.firstDay === undefined || isoDay(newestFinal) < this.firstDay) {
      deps.metrics?.ratesDailyMissingDays.set(0);
      return;
    }
    if (deps.closing()) return;

    const valid = await fns.validRateDays(deps.ch, this.firstDay, isoDay(newestFinal));
    // the closed final days that have no valid set, newest first: yesterday (when it is final) is the first of them
    const due: string[] = [];
    for (let day = newestFinal; isoDay(day) >= this.firstDay; day -= DAY_SECONDS) {
      if (!valid.has(isoDay(day))) due.push(isoDay(day));
    }
    // a day that is done (or is no longer wanted) has no failure to remember
    this.backoff.keepOnly(new Set(due));
    const yesterday = isoDay(Math.floor(tick.now.getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS - DAY_SECONDS);
    const backfill = due.filter((day) => day !== yesterday).length;
    this.announceBackfill(backfill > 0, backfill);

    const deferred = await this.deferredDays(due);
    const done = await this.sweep(
      tick,
      due.filter((day) => !deferred.has(day)),
      deferred.size > 0,
    );
    // a deferred day is still missing
    deps.metrics?.ratesDailyMissingDays.set(due.length - done);
  }

  /**
   * The due days whose rate reads the trades of a range that `agg_dirty` still holds: for a pending range of the days X to Y,
   * the days X to Y + 14, which its hook (`ofSlice`) marks stale once the range is drained. A set computed now would be made
   * stale by that mark, so they wait for it (the readers value them on read meanwhile, as any day without a set). During a
   * long re-ingest that `stats_dirty` drains behind, this keeps the job from computing the same days again for every chunk.
   * One read of `agg_dirty`, and only when a day is due.
   */
  private async deferredDays(due: string[]): Promise<Set<string>> {
    if (due.length === 0) return new Set();
    const spans = (await this.fns.dirtyDaySpans(this.deps.ch)).map(({ first, last }) => ({
      first,
      through: isoDay(Date.parse(`${last}T00:00:00Z`) / 1000 + LATEST_DAYS * DAY_SECONDS),
    }));
    const deferred = due.filter((day) => spans.some(({ first, through }) => first <= day && day <= through));
    if (deferred.length > 0) {
      this.deps.logger.debug(
        `rates_daily: ${deferred.length} day(s) deferred (${deferred[deferred.length - 1]} - ${deferred[0]}): ` +
          'agg_dirty still has ranges of the trades they read',
      );
    }
    return new Set(deferred);
  }

  /**
   * The days of `due`, in order, as long as the deadline lasts (after the first one) and fewer than 3 have failed. Returns
   * how many were computed. The back-fill is done when none failed or waits, and no day was `deferred`.
   */
  private async sweep(tick: AggregatorTick, due: string[], deferred: boolean): Promise<number> {
    const { deps } = this;
    let computed = 0;
    let failed = 0;
    let waiting = 0;
    let started = 0;
    for (const day of due) {
      if (this.backoff.waiting(day, deps.clock())) {
        waiting++;
        continue;
      }
      // the first day of a run starts whatever the deadline says (but not after the shutdown began)
      const may = started === 0 ? !deps.closing() : this.gate.mayStart(tick.deadline);
      if (!may) return computed;
      started++;
      if (await this.compute(day, tick)) {
        computed++;
      } else if (++failed >= MAX_FAILED_AGGREGATE_SETS_PER_TICK) {
        return computed;
      }
    }
    if (failed === 0 && waiting === 0 && !deferred && !deps.closing()) this.announceBackfill(false, 0);
    return computed;
  }

  /** Computes the set of a day; false when it failed (logged and counted, and the day made to wait). */
  private async compute(day: string, tick: AggregatorTick): Promise<boolean> {
    const { deps } = this;
    try {
      const assets = await this.fns.computeRatesDailySet(deps.ch, this.aggregates.rates, new Date(`${day}T00:00:00Z`), {
        signal: tick.signal,
      });
      this.backoff.done(day);
      deps.logger.debug(`rates_daily: ${day}: ${assets} asset(s)`);
      return true;
    } catch (err) {
      deps.failed('rates_daily', err, ` in ${day}`);
      // a set that the shutdown aborted did not fail
      if (!deps.closing()) this.backoff.failed(day, deps.clock());
      return false;
    }
  }

  /** Says once that the back-fill is under way (and how much there is), and once that it is done. */
  private announceBackfill(under: boolean, days: number): void {
    if (under && !this.backfilling) {
      this.backfilling = true;
      this.deps.logger.log(`Rates back-fill: ${days} day(s) to compute, newest first`);
    } else if (!under && this.backfilling) {
      this.backfilling = false;
      this.deps.logger.log('Rates back-fill is done: every closed final day has its set');
    }
  }
}

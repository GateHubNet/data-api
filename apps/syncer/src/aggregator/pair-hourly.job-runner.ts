import { HOUR_SECONDS, PAIR_HOURLY_CONFIG_VERSION, PAIR_HOURLY_DAYS } from '@gatehub/data-api-shared';
import {
  AggregateFunctions,
  AggregateJobDeps,
  AggregatorAggregates,
  defaultAggregateFunctions,
  iso,
  MAX_FAILED_AGGREGATE_SETS_PER_TICK,
  SetBackoff,
  SetGate,
} from './aggregate-job-deps';
import type { AggregatorJob, AggregatorTick } from './aggregator.service';

const DAY_SECONDS = 86_400;
const floorHour = (seconds: number): number => Math.floor(seconds / HOUR_SECONDS) * HOUR_SECONDS;
const ceilHour = (seconds: number): number => Math.ceil(seconds / HOUR_SECONDS) * HOUR_SECONDS;
const floorDay = (seconds: number): number => Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;

/**
 * The `pair_hourly` job of the aggregator (job 4 of a tick, see spec 3 and 3.2): the hour sets of `pair_hourly`, the candle of
 * every pair in each hour, for the last `PAIR_HOURLY_DAYS` days, and the hook of the slices of `agg_dirty` (`ofSlice`). The
 * state of the job (the waits of the sets that failed, the warnings and the announcements it has made, the hour of the first
 * ledger) is its own; the database, the clock, the budget and the rule of failure are the deps'.
 *
 * Per run, a set at a time, each only while the deadline of the tick has not passed and the shutdown has not begun:
 *
 *  1. **The live hours**: the current hour (always, it is not over) and the previous hour until its set is final (a ledger that
 *     closed at or after its end was there, so no trade can still come), the stalest set first (an hour that has none is the
 *     stalest of all).
 *  2. **The back-fill**: the older hours of the last 31 days that have no final set of `PAIR_HOURLY_CONFIG_VERSION`, newest first
 *     (a new config version computes them all again; an hour whose set is not final is computed again once the ingest has passed
 *     it, and not before: nothing can have changed). A run of consecutive hours inside one UTC day is one call, so a day that has
 *     no set at all is one read of the trades and 24 inserts. No hour before the hour of the first ledger is computed.
 *
 * A set that fails is logged and counted (`deps.failed`), waits 5 minutes before it is tried again and twice as long after
 * each further failure, up to an hour, while the others go on; the run gives up after 3 sets failed. The hours of a call of
 * several that failed are tried alone next time, so that one bad hour does not keep the day. It says once that the back-fill is
 * under way and once that it is done, and `syncer_pair_hourly_missing_hours` is the hours of the last 31 days without a set of
 * the current config version.
 */
export class PairHourlyJobRunner {
  private readonly fns: AggregateFunctions;
  private readonly backoff = new SetBackoff();
  private readonly gate: SetGate;
  /**
   * The hour of the first ledger, read once it exists. Hours before it have no trade and no ledger, and are never computed.
   * (Ledgers older than it that are ingested later come through `agg_dirty`, which is what `ofSlice` is for.)
   */
  private firstHour?: number;
  /** The hours that failed inside a call of several hours: they are computed alone from then on, until they work. */
  private readonly solo = new Set<number>();
  /** Whether the back-fill has announced that it is under way (so that it says so once, and once more when it is done). */
  private backfilling = false;

  constructor(
    private readonly deps: AggregateJobDeps,
    private readonly aggregates: AggregatorAggregates,
    fns: Partial<AggregateFunctions> = {},
  ) {
    this.fns = { ...defaultAggregateFunctions(), ...fns };
    this.gate = new SetGate(deps, 'pair_hourly');
  }

  job(): AggregatorJob {
    return { name: 'pair_hourly', budgetMs: this.deps.budgetMs, run: (tick) => this.run(tick) };
  }

  private async run(tick: AggregatorTick): Promise<void> {
    try {
      await this.refresh(tick);
    } finally {
      this.gate.endRun();
    }
  }

  /**
   * The hook of `agg_dirty`: recomputes the hours of the slice `[start, end)` (unix seconds, widened to whole hours) that lie in
   * the last 31 days, a call for each UTC day. A set that fails rejects, and the sets after it are not started: the caller fails
   * the slice, which keeps its range for the next tick. Nothing is started once the shutdown has begun.
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    const currentHour = floorHour(Math.floor(tick.now.getTime() / 1000));
    let from = Math.max(floorHour(start), currentHour - PAIR_HOURLY_DAYS * DAY_SECONDS);
    const to = Math.min(ceilHour(end), currentHour + HOUR_SECONDS);
    while (from < to) {
      if (this.deps.closing()) return;
      const upTo = Math.min(to, floorDay(from) + DAY_SECONDS);
      await this.fns.computePairHourSets(this.deps.ch, this.aggregates.rates, from, upTo, { signal: tick.signal });
      this.deps.logger.debug(`pair_hourly: ${iso(from)} - ${iso(upTo)} (agg_dirty)`);
      from = upTo;
    }
  }

  private async refresh(tick: AggregatorTick): Promise<void> {
    const { deps, fns } = this;
    // the jobs before this one may have used the tick up: do not even read what cannot be worked on
    if (!this.gate.mayStart(tick.deadline)) return;
    const [newest, firstClose] = await Promise.all([
      fns.newestLedgerClose(deps.ch),
      this.firstHour === undefined ? fns.firstLedgerClose(deps.ch) : undefined,
    ]);
    if (firstClose !== undefined) this.firstHour = floorHour(firstClose);
    const currentHour = floorHour(Math.floor(tick.now.getTime() / 1000));
    // a database without a ledger has no hour to compute
    if (newest === undefined || this.firstHour === undefined || this.firstHour > currentHour) {
      deps.metrics?.pairHourlyMissingHours.set(0);
      return;
    }
    if (deps.closing()) return;
    const first = Math.max(currentHour - PAIR_HOURLY_DAYS * DAY_SECONDS, this.firstHour);

    const sets = await fns.pairHourSets(deps.ch, first, currentHour + HOUR_SECONDS);
    // the hours that have a set of the current config: what the gauge counts, and what the writes of this run add to
    const covered = new Set<number>();
    for (let hour = first; hour <= currentHour; hour += HOUR_SECONDS) {
      if (sets.get(hour)?.configVersion === PAIR_HOURLY_CONFIG_VERSION) covered.add(hour);
    }

    // 1. the live hours, the stalest first
    const previous = currentHour - HOUR_SECONDS;
    const live = [currentHour];
    if (previous >= first && !(covered.has(previous) && sets.get(previous)?.final)) live.push(previous);
    live.sort((a, b) => (sets.get(a)?.version ?? 0) - (sets.get(b)?.version ?? 0));

    // 2. the older hours without a final set of the current config, newest first. A set that is not final is due again only
    //    when the ingest has passed the hour since: until then a new set would be the same.
    const due: number[] = [];
    for (let hour = previous - HOUR_SECONDS; hour >= first; hour -= HOUR_SECONDS) {
      const set = sets.get(hour);
      if (!set || set.configVersion !== PAIR_HOURLY_CONFIG_VERSION || (!set.final && newest >= hour + HOUR_SECONDS)) {
        due.push(hour);
      }
    }
    // a set that is done (or is no longer wanted) has no failure to remember
    const wanted = new Set([...live, ...due]);
    this.backoff.keepOnly(new Set([...wanted].map(String)));
    for (const hour of this.solo) if (!wanted.has(hour)) this.solo.delete(hour);
    this.announceBackfill(due.length > 0, due.length);

    await this.sweep(tick, live, due, covered);
    deps.metrics?.pairHourlyMissingHours.set((currentHour - first) / HOUR_SECONDS + 1 - covered.size);
  }

  /** The live hours, then the back-fill, as long as the budget lasts and fewer than 3 sets have failed. */
  private async sweep(tick: AggregatorTick, live: number[], due: number[], covered: Set<number>): Promise<void> {
    const { deps } = this;
    let failed = 0;
    // whether the run may go on after a set: it may, until the third failure
    const attempt = async (from: number, to: number): Promise<boolean> =>
      (await this.compute(from, to, tick, covered)) || ++failed < MAX_FAILED_AGGREGATE_SETS_PER_TICK;

    for (const hour of live) {
      if (this.backoff.waiting(String(hour), deps.clock())) continue;
      if (!this.gate.mayStart(tick.deadline)) return;
      if (!(await attempt(hour, hour + HOUR_SECONDS))) return;
    }

    // the calls of the back-fill: consecutive hours inside one UTC day, newest first; an hour that waits breaks a run, and an
    // hour that failed inside a call of several is a call of its own
    const calls: Array<[from: number, to: number]> = [];
    let waiting = 0;
    for (const hour of due) {
      if (this.backoff.waiting(String(hour), deps.clock())) {
        waiting++;
        continue;
      }
      const last = calls[calls.length - 1];
      if (
        last &&
        last[0] === hour + HOUR_SECONDS &&
        floorDay(last[0]) === floorDay(hour) &&
        !this.solo.has(hour) &&
        !this.solo.has(last[0])
      ) {
        last[0] = hour;
      } else {
        calls.push([hour, hour + HOUR_SECONDS]);
      }
    }
    for (const [from, to] of calls) {
      if (!this.gate.mayStart(tick.deadline)) return;
      if (!(await attempt(from, to))) return;
    }
    if (failed === 0 && waiting === 0 && !deps.closing()) this.announceBackfill(false, 0);
  }

  /** Computes the sets of `[from, to)`; false when it failed (logged and counted, and the hours made to wait). */
  private async compute(from: number, to: number, tick: AggregatorTick, covered: Set<number>): Promise<boolean> {
    const { deps } = this;
    let written: number;
    try {
      written = await this.fns.computePairHourSets(deps.ch, this.aggregates.rates, from, to, { signal: tick.signal });
    } catch (err) {
      deps.failed('pair_hourly', err, ` in ${iso(from)} - ${iso(to)}`);
      // a set that the shutdown aborted did not fail
      if (!deps.closing()) {
        for (let hour = from; hour < to; hour += HOUR_SECONDS) {
          this.backoff.failed(String(hour), deps.clock());
          if (to - from > HOUR_SECONDS) this.solo.add(hour);
        }
      }
      return false;
    }
    for (let hour = from; hour < to; hour += HOUR_SECONDS) {
      this.backoff.done(String(hour));
      this.solo.delete(hour);
      covered.add(hour);
    }
    deps.logger.debug(`pair_hourly: ${iso(from)} - ${iso(to)}: ${written} set(s)`);
    return true;
  }

  /** Says once that the back-fill is under way (and how much there is), and once that it is done. */
  private announceBackfill(under: boolean, hours: number): void {
    if (under && !this.backfilling) {
      this.backfilling = true;
      this.deps.logger.log(`Pair-hourly back-fill: ${hours} hour(s) to compute, newest first`);
    } else if (!under && this.backfilling) {
      this.backfilling = false;
      this.deps.logger.log('Pair-hourly back-fill is done: every hour of the last 31 days has its set');
    }
  }
}

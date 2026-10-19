import { MARKETS_PERIODS, MarketsPeriod, MarketsSetOutcome } from '@gatehub/data-api-shared';
import {
  AggregateFunctions,
  AggregateJobDeps,
  AggregatorAggregates,
  defaultAggregateFunctions,
  SetBackoff,
  SetGate,
} from './aggregate-job-deps';
import type { AggregatorJob, AggregatorTick } from './aggregator.service';

/** The `7day` and `30day` sets are written on every this-many-th run of the job (the `day` set on every run). */
export const MARKETS_LONG_EVERY_TICKS = 5;

const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;

/**
 * The `markets_live` job of the aggregator (job 5 of a tick, see spec 3 and 3.3): the Markets set of each period, made from the
 * hour sets of `pair_hourly`. The `day` set is written on every run, the `7day` and `30day` sets on the 1st, 6th, 11th ... run
 * (`MARKETS_LONG_EVERY_TICKS`, counted here: the sets are heavier and their windows change by an hour at a time). A long
 * set that the budget kept from starting is the next run's, after the `day` set. The state of the job (the run counter, the
 * waits of the sets that failed, the gaps it has said, the warning of the budget) is its own.
 *
 * - A set that cannot be written (`written: false`: an hour of its window has no usable set in `pair_hourly`) leaves the
 *   previous set where it is; the first time of a gap it says so (once per period and gap). `syncer_pair_hourly_missing_hours` is
 *   what alerts.
 * - A set that fails is logged and counted as `markets_live` (`deps.failed`), waits 5 minutes before it is tried again and
 *   twice as long after each further failure, up to an hour, and the other periods go on.
 * - After its sets the job reads the `end_time` of the newest set of each period and sets `syncer_markets_live_age_seconds`.
 */
export class MarketsLiveJobRunner {
  private readonly fns: AggregateFunctions;
  private readonly backoff = new SetBackoff();
  private readonly gate: SetGate;
  /** How many runs have begun: the 1st, 6th, 11th ... are the long ones. */
  private runs = 0;
  /** The long periods that are due and not done yet (the budget ran out before them). */
  private readonly owed = new Set<MarketsPeriod>();
  /** The periods whose last set was skipped and said so: the gap is said once, until a set is written. */
  private readonly gaps = new Set<MarketsPeriod>();

  constructor(
    private readonly deps: AggregateJobDeps,
    private readonly aggregates: AggregatorAggregates,
    fns: Partial<AggregateFunctions> = {},
  ) {
    this.fns = { ...defaultAggregateFunctions(), ...fns };
    this.gate = new SetGate(deps, 'markets_live');
  }

  job(): AggregatorJob {
    return { name: 'markets_live', budgetMs: this.deps.budgetMs, run: (tick) => this.run(tick) };
  }

  private async run(tick: AggregatorTick): Promise<void> {
    try {
      await this.refresh(tick);
    } finally {
      this.gate.endRun();
    }
  }

  private async refresh(tick: AggregatorTick): Promise<void> {
    const { deps } = this;
    if (deps.closing()) return;
    if (this.runs++ % MARKETS_LONG_EVERY_TICKS === 0) {
      for (const period of MARKETS_PERIODS) if (period !== 'day') this.owed.add(period);
    }
    const periods = MARKETS_PERIODS.filter((period) => period === 'day' || this.owed.has(period));

    for (const period of periods) {
      if (this.backoff.waiting(period, deps.clock())) continue;
      if (!this.gate.mayStart(tick.deadline)) break;
      this.owed.delete(period);
      try {
        const outcome = await this.fns.computeMarketsSet(
          deps.ch,
          this.aggregates.rates.nativeCurrency,
          period,
          tick.now,
          {
            signal: tick.signal,
          },
        );
        this.backoff.done(period);
        this.report(period, outcome);
      } catch (err) {
        deps.failed('markets_live', err, ` in ${period}`);
        // a set that the shutdown aborted did not fail
        if (!deps.closing()) this.backoff.failed(period, deps.clock());
      }
    }
    await this.reportAges();
  }

  /** What a set came to: the first skip of a gap is said (a warning), a written set ends the gap. */
  private report(period: MarketsPeriod, outcome: MarketsSetOutcome): void {
    const { logger } = this.deps;
    if (outcome.written) {
      this.gaps.delete(period);
      logger.debug(
        `markets_live: ${period}: ${outcome.pairs} pair(s), ${iso(outcome.startTime)} - ${iso(outcome.endTime)}`,
      );
      return;
    }
    if (this.gaps.has(period)) return;
    this.gaps.add(period);
    const hours = outcome.missingHours;
    logger.warn(
      `Markets set of period ${period} not written: ${hours.length} hour(s) of pair_hourly have no usable set` +
        ` (${iso(Math.min(...hours))} - ${iso(Math.max(...hours))}); the previous set stays (said once per gap)`,
    );
  }

  /** `syncer_markets_live_age_seconds{period}`: now minus the `end_time` of the newest set of each period that has one. */
  private async reportAges(): Promise<void> {
    const { deps } = this;
    if (!deps.metrics || deps.closing()) return;
    let ends: Map<MarketsPeriod, number>;
    try {
      ends = await this.fns.marketsSetEndTimes(deps.ch);
    } catch (err) {
      deps.failed('markets_live', err, ' reading the age of the sets');
      return;
    }
    const now = deps.clock() / 1000;
    for (const [period, end] of ends) {
      deps.metrics.marketsLiveAgeSeconds.set({ period }, Math.max(0, Math.floor(now - end)));
    }
  }
}

import { MARKETS_PERIODS, MarketsPeriod, MarketsSetOutcome, RatesService } from '@gatehub/data-api-shared';
import { fakeDeps, FakeDeps, iso, NOW, unix } from '../../test/aggregate-job-fakes';
import { AggregateFunctions } from './aggregate-job-deps';
import { MARKETS_LONG_EVERY_TICKS, MarketsLiveJobRunner } from './markets-live.job-runner';

const NOW_SECONDS = NOW.getTime() / 1000;

interface Call {
  ch: unknown;
  native: string;
  period: MarketsPeriod;
  now: Date;
  signal?: AbortSignal;
}

/**
 * The shared functions of `markets_live` as the runner calls them: `computeMarketsSet` records its call, takes `callMs` of the
 * fake clock and answers what `outcomes` says for the period (a set written by default; an `Error` is thrown);
 * `marketsSetEndTimes` answers `ends`. `order` is what was called, in order.
 */
class FakeMarkets {
  calls: Call[] = [];
  outcomes = new Map<MarketsPeriod, MarketsSetOutcome | Error>();
  callMs = 0;
  /** The `end_time` of the newest set of each period. */
  ends = new Map<MarketsPeriod, number>();
  endsError?: Error;
  order: string[] = [];
  onCompute?: (period: MarketsPeriod) => void;

  fns(): Partial<AggregateFunctions> {
    return {
      computeMarketsSet: async (ch, native, period, now, options) => {
        this.calls.push({ ch, native, period, now, signal: options?.signal });
        this.order.push(period);
        this.onCompute?.(period);
        if (this.callMs > 0) jest.setSystemTime(Date.now() + this.callMs);
        const outcome = this.outcomes.get(period) ?? {
          written: true,
          pairs: 3,
          startTime: 0,
          endTime: 0,
          ammShareKnown: true,
        };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      marketsSetEndTimes: async () => {
        this.order.push('ends');
        if (this.endsError) throw this.endsError;
        return new Map(this.ends);
      },
    };
  }

  periods(): MarketsPeriod[] {
    return this.calls.map((c) => c.period);
  }
}

describe('MarketsLiveJobRunner', () => {
  let fake: FakeDeps;
  let markets: FakeMarkets;
  const aggregates = { rates: { nativeCurrency: 'XRP' } as unknown as RatesService, accountRollupMinRows: 0 };

  const runner = (deps = fake.deps): MarketsLiveJobRunner => new MarketsLiveJobRunner(deps, aggregates, markets.fns());
  const run = (r: MarketsLiveJobRunner, tick = fake.tick()): Promise<void> => r.job().run(tick);
  const minutes = (n: number): number => n * 60_000;
  const skipped = (...missingHours: number[]): MarketsSetOutcome => ({ written: false, missingHours });
  const skipWarnings = (): string[] =>
    fake.logger.warn.mock.calls.map((c) => c[0] as string).filter((t) => /not written/.test(t));

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fake = fakeDeps();
    markets = new FakeMarkets();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the job markets_live, with the budget of its deps', () => {
    const job = new MarketsLiveJobRunner(fakeDeps({ budgetMs: 1234 }).deps, aggregates, markets.fns()).job();
    expect(job.name).toBe('markets_live');
    expect(job.budgetMs).toBe(1234);
    expect(MARKETS_LONG_EVERY_TICKS).toBe(5);
  });

  it('writes the day set every run, and the 7day and 30day sets on its 1st, 6th, 11th … run', async () => {
    const r = runner();
    const perRun: MarketsPeriod[][] = [];
    for (let i = 1; i <= 11; i++) {
      markets.calls = [];
      await run(r);
      perRun.push(markets.periods());
    }
    const all: MarketsPeriod[] = ['day', '7day', '30day'];
    expect(perRun).toEqual([all, ['day'], ['day'], ['day'], ['day'], all, ['day'], ['day'], ['day'], ['day'], all]);
    expect(MARKETS_PERIODS).toEqual(all);
  });

  it('computes each set at the time of the tick, with the native currency and the signal of the tick', async () => {
    const tick = fake.tick(new Date('2026-10-16T12:30:00Z'));
    await run(runner(), tick);
    expect(markets.calls).toHaveLength(3);
    for (const call of markets.calls) {
      expect(call.ch).toBe(fake.deps.ch);
      expect(call.native).toBe('XRP');
      expect(call.now).toBe(tick.now);
      expect(call.signal).toBe(fake.abort.signal);
    }
  });

  it('a skipped set (written: false) is logged once per gap, and nothing replaces the previous set', async () => {
    const hourA = unix('2026-10-15T03:00:00Z');
    const hourB = unix('2026-10-15T04:00:00Z');
    for (const period of MARKETS_PERIODS) markets.outcomes.set(period, skipped(hourA, hourB));
    const r = runner();

    await run(r); // the 1st run: all three periods are skipped, one line each
    expect(skipWarnings()).toHaveLength(3);
    for (const period of MARKETS_PERIODS) {
      expect(skipWarnings().filter((t) => t.includes(`period ${period} `))).toHaveLength(1);
    }
    expect(skipWarnings()[0]).toContain('2 hour(s)');
    expect(skipWarnings()[0]).toContain(iso(hourA));
    expect(skipWarnings()[0]).toContain(iso(hourB));
    expect(skipWarnings()[0]).toContain('previous set stays');

    // the same gap on the next runs: not said again; a skip is not an error
    await run(r);
    await run(r);
    expect(skipWarnings()).toHaveLength(3);
    expect(fake.failures).toEqual([]);
    expect(fake.logger.error).not.toHaveBeenCalled();

    // the day set is written again: the gap is over, and the next one is said
    markets.outcomes.delete('day');
    await run(r);
    expect(skipWarnings()).toHaveLength(3);
    markets.outcomes.set('day', skipped(hourB));
    await run(r);
    expect(skipWarnings()).toHaveLength(4);
    expect(skipWarnings()[3]).toContain('period day ');
    expect(skipWarnings()[3]).toContain('1 hour(s)');
  });

  it("sets syncer_markets_live_age_seconds{period} to now minus each period's newest end_time", async () => {
    markets.ends = new Map<MarketsPeriod, number>([
      ['day', NOW_SECONDS - 120],
      ['7day', NOW_SECONDS - 3600],
      ['30day', NOW_SECONDS - 7200],
    ]);
    await run(runner());
    const gauge = fake.metrics.marketsLiveAgeSeconds.set;
    expect(gauge.mock.calls).toEqual([
      [{ period: 'day' }, 120],
      [{ period: '7day' }, 3600],
      [{ period: '30day' }, 7200],
    ]);
    // read after the sets of the run, once
    expect(markets.order).toEqual(['day', '7day', '30day', 'ends']);
  });

  it('measures the age by the clock, not by the time of the tick; a set from the future is as old as nothing', async () => {
    markets.ends = new Map<MarketsPeriod, number>([
      ['day', NOW_SECONDS - 120],
      ['7day', NOW_SECONDS + 30],
    ]);
    jest.setSystemTime(NOW.getTime() + minutes(1));
    const tick = fake.tick(NOW);
    await run(runner(), tick);
    const gauge = fake.metrics.marketsLiveAgeSeconds.set;
    expect(gauge.mock.calls).toEqual([
      [{ period: 'day' }, 180],
      [{ period: '7day' }, 30],
    ]);
  });

  it('leaves the gauge of a period without a set alone, and sets the age after every run (also when the budget cut it)', async () => {
    markets.ends = new Map<MarketsPeriod, number>([['day', NOW_SECONDS - 10]]);
    markets.callMs = 4000; // the first set takes more than the budget
    await run(runner());
    expect(markets.periods()).toEqual(['day']);
    expect(fake.metrics.marketsLiveAgeSeconds.set.mock.calls).toEqual([[{ period: 'day' }, 14]]);
  });

  it('reads no ages without metrics', async () => {
    await run(runner({ ...fake.deps, metrics: undefined }));
    expect(markets.order).toEqual(['day', '7day', '30day']);
  });

  it('counts a failure of the read of the ages as markets_live, and does not fail the run', async () => {
    markets.endsError = new Error('timeout');
    await expect(run(runner())).resolves.toBeUndefined();
    expect(fake.failures).toHaveLength(1);
    expect(fake.failures[0].job).toBe('markets_live');
    expect(fake.failures[0].where).toContain('age');
    expect(fake.metrics.marketsLiveAgeSeconds.set).not.toHaveBeenCalled();
  });

  it('a failing period is counted as markets_live, and the other periods still run', async () => {
    markets.outcomes.set('7day', new Error('memory limit'));
    markets.ends = new Map<MarketsPeriod, number>([['day', NOW_SECONDS - 5]]);
    await run(runner());
    expect(markets.periods()).toEqual(['day', '7day', '30day']);
    expect(fake.failures).toHaveLength(1);
    expect(fake.failures[0].job).toBe('markets_live');
    expect(fake.failures[0].where).toContain('7day');
    expect((fake.failures[0].err as Error).message).toBe('memory limit');
    // the ages are still read
    expect(fake.metrics.marketsLiveAgeSeconds.set).toHaveBeenCalledWith({ period: 'day' }, 5);
  });

  it('a period that keeps failing waits 5 min, then 10, while the others go on', async () => {
    markets.outcomes.set('day', new Error('memory limit'));
    const r = runner();
    await run(r); // the 1st run, a long one: day fails, the others are written
    expect(markets.periods()).toEqual(['day', '7day', '30day']);
    const dayCalls = (): number => markets.periods().filter((p) => p === 'day').length;
    expect(dayCalls()).toBe(1);

    let failedAt = Date.now();
    let attempts = 1;
    for (const wait of [5, 10, 20]) {
      jest.setSystemTime(failedAt + minutes(wait) - 1);
      await run(r);
      expect(dayCalls()).toBe(attempts);
      jest.setSystemTime(failedAt + minutes(wait));
      await run(r);
      expect(dayCalls()).toBe(++attempts);
      failedAt += minutes(wait);
    }
    expect(fake.failures).toHaveLength(attempts);
    expect(fake.failures.every((f) => f.job === 'markets_live')).toBe(true);

    // it works again: no wait is left
    markets.outcomes.delete('day');
    jest.setSystemTime(failedAt + minutes(40));
    await run(r);
    markets.calls = [];
    await run(r);
    expect(markets.periods()).toContain('day');
  });

  it('stops starting sets once its deadline has passed, warns once until a run finishes in time, and does the sets it left on the next run', async () => {
    markets.callMs = 2000; // the budget is 3 s: two sets start (at 0 and 2 s), the third would start at 4 s
    const r = runner();
    const budgetWarnings = (): number => fake.logger.warn.mock.calls.filter((c) => /budget/.test(c[0])).length;

    await run(r); // the 1st run: day and 7day
    expect(markets.periods()).toEqual(['day', '7day']);
    expect(budgetWarnings()).toBe(1);
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('markets_live'));

    // the 30day set that was left is the next run's, after the day set (it is not left to the 6th run)
    markets.calls = [];
    await run(r);
    expect(markets.periods()).toEqual(['day', '30day']);
    expect(budgetWarnings()).toBe(1);

    // a run that finishes in time ends the streak
    markets.calls = [];
    await run(r);
    expect(markets.periods()).toEqual(['day']);
    for (let i = 0; i < 2; i++) await run(r); // the 5th run, and then the 6th: long, with the budget hit again
    markets.calls = [];
    await run(r);
    expect(markets.periods()).toEqual(['day', '7day']);
    expect(budgetWarnings()).toBe(2);
  });

  it('starts no set when the deadline has passed before the run', async () => {
    const tick = fake.tick();
    jest.setSystemTime(tick.deadline);
    await run(runner(), tick);
    expect(markets.calls).toEqual([]);
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  it('starts nothing once closing() is true', async () => {
    fake.closing = true;
    const r = runner();
    await run(r);
    expect(markets.order).toEqual([]);
    expect(fake.logger.warn).not.toHaveBeenCalled();

    // a shutdown in the middle of a run: the sets after the one in flight are not started, nor the ages read
    fake.closing = false;
    markets.onCompute = () => {
      fake.closing = true;
    };
    await run(r);
    expect(markets.order).toEqual(['day']);
  });

  it('does not back a set off that the shutdown aborted', async () => {
    markets.outcomes.set('day', new Error('aborted'));
    markets.onCompute = (period) => {
      if (period === 'day') fake.closing = true;
    };
    const r = runner();
    await run(r);
    expect(fake.failures).toHaveLength(1); // `failed` is told, and drops what the shutdown aborted

    fake.closing = false;
    markets.onCompute = undefined;
    markets.outcomes.delete('day');
    markets.calls = [];
    await run(r);
    expect(markets.periods()).toContain('day');
  });
});

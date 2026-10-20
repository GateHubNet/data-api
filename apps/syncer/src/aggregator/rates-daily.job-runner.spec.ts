import { RatesService } from '@gatehub/data-api-shared';
import { DAY, fakeDeps, FakeDeps, NOW, unix } from '../../test/aggregate-job-fakes';
import { AGGREGATE_MAX_RETRY_MS, AGGREGATE_RETRY_MS, AggregateFunctions } from './aggregate-job-deps';
import { RatesDailyJobRunner } from './rates-daily.job-runner';

const NOW_SECONDS = NOW.getTime() / 1000;

/** One call of `computeRatesDailySet`. */
interface Call {
  ch: unknown;
  rates: unknown;
  day: string;
  signal?: AbortSignal;
}

/**
 * The shared functions of `rates_daily` as the runner calls them, over a map of the valid days: `computeRatesDailySet` records
 * its call, takes `callMs` of the fake clock and makes the day valid (or throws for a day in `failing`); the others answer
 * what the fields say, and record what they were asked.
 */
class FakeDays {
  /** The valid days and the version of the set of each. */
  valid = new Map<string, number>();
  /** The close time of the newest ledger, unix seconds; none for a database without a ledger. */
  newest: number | undefined = NOW_SECONDS - 3;
  /** The day of the first trade against the native currency; none while there is not one. */
  firstDay: string | undefined = '2026-10-09';
  calls: Call[] = [];
  failing = new Set<string>();
  callMs = 0;
  onCompute?: (day: string) => void;
  validReads: Array<[string, string]> = [];
  firstReads: string[] = [];
  newestReads = 0;
  /** The days `markRatesStale` was asked for, a list per call, with its options. */
  marks: Array<{ days: string[]; signal?: AbortSignal }> = [];
  markError?: Error;
  private version = 1000;

  fns(): Partial<AggregateFunctions> {
    return {
      computeRatesDailySet: async (ch, rates, day, options) => {
        const key = day.toISOString().slice(0, 10);
        this.calls.push({ ch, rates, day: key, signal: options?.signal });
        this.onCompute?.(key);
        if (this.callMs > 0) jest.setSystemTime(Date.now() + this.callMs);
        if (this.failing.has(key)) throw new Error('memory limit');
        this.valid.set(key, ++this.version);
        return 12;
      },
      validRateDays: async (_ch, from, through) => {
        this.validReads.push([from, through]);
        return new Map([...this.valid].filter(([day]) => day >= from && day <= through));
      },
      newestLedgerClose: async () => {
        this.newestReads++;
        return this.newest;
      },
      firstNativeTradeDay: async (_ch, native) => {
        this.firstReads.push(native);
        return this.firstDay;
      },
      markRatesStale: async (_ch, days, options) => {
        this.marks.push({ days, signal: options?.signal });
        if (this.markError) throw this.markError;
        return days.length;
      },
    };
  }

  /** Makes every day of `[from, through]` valid. */
  fill(from: string, through: string): void {
    for (let ms = Date.parse(from); ms <= Date.parse(through); ms += DAY * 1000) {
      this.valid.set(new Date(ms).toISOString().slice(0, 10), 1);
    }
  }

  days(): string[] {
    return this.calls.map((c) => c.day);
  }

  attempts(day: string): number {
    return this.calls.filter((c) => c.day === day).length;
  }
}

describe('RatesDailyJobRunner', () => {
  let fake: FakeDeps;
  let days: FakeDays;
  const aggregates = { rates: { nativeCurrency: 'XRP' } as unknown as RatesService, accountRollupMinRows: 0 };

  const runner = (deps = fake.deps): RatesDailyJobRunner => new RatesDailyJobRunner(deps, aggregates, days.fns());
  /** One run of the job, as the aggregator does it. */
  const run = (r: RatesDailyJobRunner): Promise<void> => r.job().run(fake.tick());
  const minutes = (n: number): number => n * 60_000;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fake = fakeDeps({ budgetMs: 8000 });
    days = new FakeDays();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the job rates_daily, with the budget of its deps', () => {
    const job = new RatesDailyJobRunner(fakeDeps({ budgetMs: 1234 }).deps, aggregates, days.fns()).job();
    expect(job.name).toBe('rates_daily');
    expect(job.budgetMs).toBe(1234);
  });

  it('computes yesterday once it is final and not valid, then the closed final days that are not valid, newest first, down to the first native trade day', async () => {
    // 2026-10-09 is the day of the first native trade; two of the days after it have a valid set
    days.valid.set('2026-10-14', 1);
    days.valid.set('2026-10-11', 1);
    // a valid day from before the first trade: it is not looked at
    days.valid.set('2026-10-08', 1);
    const r = runner();
    await run(r);
    expect(days.days()).toEqual(['2026-10-15', '2026-10-13', '2026-10-12', '2026-10-10', '2026-10-09']);
    // the shared pieces of the runner are what each call gets
    expect(days.calls[0].ch).toBe(fake.deps.ch);
    expect(days.calls[0].rates).toBe(aggregates.rates);
    expect(days.calls[0].signal).toBe(fake.abort.signal);
    // the valid days come from one read of the days of the back-fill
    expect(days.validReads).toEqual([['2026-10-09', '2026-10-15']]);
    expect(fake.failures).toEqual([]);

    // every closed final day is valid now: nothing is computed, and today and the days before the first trade never are
    days.calls = [];
    await run(r);
    expect(days.calls).toEqual([]);
  });

  it('computes yesterday first when it is the only day that is not valid', async () => {
    days.fill('2026-10-09', '2026-10-14');
    await run(runner());
    expect(days.days()).toEqual(['2026-10-15']);
  });

  it('a day is final once the newest ledger closed an hour after its end; today never is', async () => {
    days.firstDay = '2026-10-12';
    // 2026-10-15 ends at 2026-10-16T00:00:00Z: its set is final from 01:00:00, not a second before
    days.newest = unix('2026-10-16T00:59:59Z');
    await run(runner());
    expect(days.days()).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);

    days.calls = [];
    days.valid.clear();
    days.newest = unix('2026-10-16T01:00:00Z');
    await run(runner());
    expect(days.days()).toEqual(['2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);

    // an ingest that is days behind: the days it has not passed are not final, however long ago they ended
    days.calls = [];
    days.valid.clear();
    days.newest = unix('2026-10-14T10:00:00Z');
    await run(runner());
    expect(days.days()).toEqual(['2026-10-13', '2026-10-12']);

    // a ledger from the future (a clock that is ahead) does not make today final: nor does it the day after
    days.calls = [];
    days.valid.clear();
    days.newest = unix('2026-10-17T05:00:00Z');
    await run(runner());
    expect(days.days()).toEqual(['2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);
    expect(days.validReads[days.validReads.length - 1]).toEqual(['2026-10-12', '2026-10-15']);
  });

  it('computes at least one day per run, even past its deadline', async () => {
    const tick = fake.tick();
    jest.setSystemTime(tick.deadline + 5000); // the jobs before this one used the whole tick
    const r = runner();
    await r.job().run(tick);
    expect(days.days()).toEqual(['2026-10-15']);
    // it says the budget is out, because there were days left
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('rates_daily'));
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  it('stops starting days once its deadline has passed, after the one it must compute', async () => {
    days.callMs = 2000; // the budget is 8 s: four days start (at 0, 2, 4 and 6 s), the fifth would start at 8 s
    days.firstDay = '2026-09-01';
    await run(runner());
    expect(days.days()).toEqual(['2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);
  });

  it('starts nothing once closing() is true, and ends a run that was going', async () => {
    fake.closing = true;
    const r = runner();
    await run(r);
    await r.ofSlice(unix('2026-10-12T00:00:00Z'), unix('2026-10-12T01:00:00Z'), fake.tick());
    expect(days.calls).toEqual([]);
    expect(days.marks).toEqual([]);
    expect(days.newestReads).toBe(0);

    fake.closing = false;
    days.onCompute = () => {
      fake.closing = true;
    };
    await run(r);
    expect(days.calls).toHaveLength(1);
    expect(fake.logger.warn).not.toHaveBeenCalled();
  });

  it('reads firstNativeTradeDay once, and again only while it is undefined', async () => {
    days.firstDay = undefined;
    const r = runner();
    await run(r);
    await run(r);
    // nothing to compute without a first trade; the read is repeated, with the native currency of the network
    expect(days.firstReads).toEqual(['XRP', 'XRP']);
    expect(days.calls).toEqual([]);
    expect(fake.metrics.ratesDailyMissingDays.set).toHaveBeenLastCalledWith(0);

    days.firstDay = '2026-10-14';
    await run(r);
    expect(days.firstReads).toHaveLength(3);
    expect(days.days()).toEqual(['2026-10-15', '2026-10-14']);

    await run(r);
    await run(r);
    expect(days.firstReads).toHaveLength(3);
  });

  it('does nothing, and says nothing is missing, while the database has no ledger', async () => {
    days.newest = undefined;
    const r = runner();
    await run(r);
    expect(days.calls).toEqual([]);
    expect(days.validReads).toEqual([]);
    expect(fake.metrics.ratesDailyMissingDays.set).toHaveBeenLastCalledWith(0);

    // a ledger arrives later: the absence was not remembered
    days.newest = NOW_SECONDS - 3;
    await run(r);
    expect(days.days()).toHaveLength(7);
  });

  it('has nothing to compute before the first trade day is over, and when everything is valid it reads and writes nothing more', async () => {
    days.firstDay = '2026-10-16'; // today: no closed day is on or after it
    const r = runner();
    await run(r);
    expect(days.calls).toEqual([]);
    expect(days.validReads).toEqual([]);
    expect(fake.metrics.ratesDailyMissingDays.set).toHaveBeenLastCalledWith(0);

    days.firstDay = '2026-10-09';
    days.fill('2026-10-09', '2026-10-15');
    const reads = days.firstReads.length;
    await run(runner());
    expect(days.calls).toEqual([]);
    expect(days.validReads).toEqual([['2026-10-09', '2026-10-15']]);
    expect(days.firstReads.length).toBe(reads + 1); // a new runner reads it again, once
  });

  it('sets syncer_rates_daily_missing_days', async () => {
    const gauge = fake.metrics.ratesDailyMissingDays.set;
    days.firstDay = '2026-10-01';
    days.valid.set('2026-10-10', 1); // 15 closed final days, one of them valid
    days.callMs = 3000; // the budget is 8 s: three days start
    const r = runner();
    await run(r);
    expect(days.calls).toHaveLength(3);
    expect(gauge).toHaveBeenLastCalledWith(11); // 14 days without a valid set, 3 computed

    // the days that were done are valid, and the failing one is missing until it works
    days.callMs = 0;
    days.failing.add('2026-10-05');
    jest.setSystemTime(Date.now() + 1000);
    await run(r);
    expect(gauge).toHaveBeenLastCalledWith(1);

    days.failing.clear();
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    expect(gauge).toHaveBeenLastCalledWith(0);
  });

  it('runs without metrics', async () => {
    await run(new RatesDailyJobRunner({ ...fake.deps, metrics: undefined }, aggregates, days.fns()));
    expect(days.days()).toHaveLength(7);
  });

  it('a failing day backs off 5 min doubling to 1 h, counted as rates_daily; at most 3 failures a tick', async () => {
    days.fill('2026-10-09', '2026-10-15');
    const bad = '2026-10-12';
    const good = '2026-10-10';
    days.valid.delete(bad);
    days.valid.delete(good);
    days.failing.add(bad);
    const r = runner();

    await run(r);
    expect(fake.failures).toHaveLength(1);
    expect(fake.failures[0].job).toBe('rates_daily');
    expect(fake.failures[0].where).toContain(bad);
    expect((fake.failures[0].err as Error).message).toBe('memory limit');
    // the older day, after it, was computed
    expect(days.days()).toEqual([bad, good]);

    expect(AGGREGATE_RETRY_MS).toBe(minutes(5));
    expect(AGGREGATE_MAX_RETRY_MS).toBe(minutes(60));
    let failedAt = Date.now();
    let attempts = 1;
    for (const wait of [5, 10, 20, 40, 60, 60]) {
      jest.setSystemTime(failedAt + minutes(wait) - 1);
      await run(r);
      expect(days.attempts(bad)).toBe(attempts); // still waiting
      jest.setSystemTime(failedAt + minutes(wait));
      await run(r);
      expect(days.attempts(bad)).toBe(++attempts);
      failedAt += minutes(wait);
    }
    expect(fake.failures).toHaveLength(attempts);
    // the day that worked was not computed again
    expect(days.attempts(good)).toBe(1);

    // it works at last: the wait is forgotten, and nothing is left to compute
    days.failing.clear();
    jest.setSystemTime(failedAt + minutes(60));
    await run(r);
    expect(days.attempts(bad)).toBe(attempts + 1);
    days.calls = [];
    jest.setSystemTime(failedAt + minutes(60) + 1000);
    await run(r);
    expect(days.calls).toEqual([]);
  });

  it('gives up after 3 failures in a tick, and the days that failed do not count again while they wait', async () => {
    days.fill('2026-10-09', '2026-10-15');
    const bad = ['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10'];
    for (const day of bad) {
      days.valid.delete(day);
      days.failing.add(day);
    }
    const r = runner();

    await run(r);
    // newest first: three attempts, and the two older days were not started
    expect(fake.failures).toHaveLength(3);
    expect(bad.map((day) => days.attempts(day))).toEqual([1, 1, 1, 0, 0]);

    // the next tick: those three wait, the other two are tried
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    expect(fake.failures).toHaveLength(5);
    expect(bad.map((day) => days.attempts(day))).toEqual([1, 1, 1, 1, 1]);
  });

  it('forgets the wait of a day that is no longer wanted', async () => {
    days.fill('2026-10-09', '2026-10-15');
    const bad = '2026-10-12';
    days.valid.delete(bad);
    days.failing.add(bad);
    const r = runner();
    await run(r);
    expect(days.attempts(bad)).toBe(1); // it fails: it waits 5 min

    // the day is made valid by other means (a recompute of the slice's day) while it waits, then marked stale again
    days.failing.clear();
    days.valid.set(bad, 1);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    days.valid.delete(bad);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    expect(days.attempts(bad)).toBe(2); // tried at once: the old wait was forgotten
  });

  it('does not back off a day that the shutdown aborted', async () => {
    days.fill('2026-10-09', '2026-10-14');
    days.failing.add('2026-10-15');
    days.onCompute = () => {
      fake.closing = true;
    };
    const r = runner();
    await run(r);
    // `failed` is told (it drops what the shutdown aborted), and the day is not made to wait
    expect(fake.failures).toHaveLength(1);

    fake.closing = false;
    days.onCompute = undefined;
    days.failing.clear();
    await run(r);
    expect(days.attempts('2026-10-15')).toBe(2);
  });

  it('announces the back-fill once under way and once done', async () => {
    days.firstDay = '2026-10-06';
    days.callMs = 4000; // the budget is 8 s: two days start (at 0 and 4 s), the third would start at 8 s
    const r = runner();
    const said = (): string[] => fake.logger.log.mock.calls.map((c) => c[0]).filter((t) => /back-fill/i.test(t));

    await run(r); // 10-15 and 10-14 of the ten days; yesterday is not part of the back-fill
    expect(said()).toEqual([expect.stringMatching(/Rates back-fill: 9 day\(s\) to compute/)]);
    for (let i = 0; i < 3; i++) await run(r);
    expect(days.valid.size).toBe(8);
    expect(said()).toHaveLength(1);
    await run(r); // the last two
    expect(said()).toHaveLength(2);
    expect(said()[1]).toMatch(/Rates back-fill is done/);

    // the days that follow, and a run with nothing to do, say nothing
    await run(r);
    days.newest = unix('2026-10-17T01:00:00Z');
    jest.setSystemTime(unix('2026-10-17T01:00:10Z') * 1000);
    await r.job().run(fake.tick(new Date('2026-10-17T01:00:10Z'))); // a new yesterday: not a back-fill
    expect(days.attempts('2026-10-16')).toBe(1);
    expect(said()).toHaveLength(2);

    // a correction that makes a closed day invalid again starts a back-fill again
    days.valid.delete('2026-10-12');
    days.valid.delete('2026-10-11');
    jest.setSystemTime(unix('2026-10-17T02:00:00Z') * 1000);
    await r.job().run(fake.tick(new Date('2026-10-17T02:00:00Z')));
    expect(said()).toHaveLength(4);
    expect(said()[2]).toMatch(/Rates back-fill: 2 day\(s\) to compute/);
    expect(said()[3]).toMatch(/is done/);
  });

  it('does not say the back-fill is done while a day failed or waits', async () => {
    days.fill('2026-10-09', '2026-10-15');
    days.valid.delete('2026-10-12');
    days.failing.add('2026-10-12');
    const r = runner();
    await run(r);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r); // it waits
    expect(fake.logger.log.mock.calls.filter((c) => /done/.test(c[0]))).toEqual([]);
    days.failing.clear();
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    expect(fake.logger.log.mock.calls.filter((c) => /done/.test(c[0]))).toHaveLength(1);
  });

  describe('ofSlice', () => {
    const slice = (r: RatesDailyJobRunner, from: string, to: string): Promise<void> =>
      r.ofSlice(unix(from), unix(to), fake.tick());
    const range = (from: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * DAY * 1000).toISOString().slice(0, 10));

    it('of a slice in day X marks the days X..X+14 stale; a slice across midnight marks from its first day to its last day + 14; a failure rejects', async () => {
      const r = runner();
      await slice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z');
      expect(days.marks).toHaveLength(1);
      expect(days.marks[0].days).toEqual(range('2026-10-12', 15)); // 2026-10-12 .. 2026-10-26
      expect(days.marks[0].days[14]).toBe('2026-10-26');
      expect(days.marks[0].signal).toBe(fake.abort.signal);

      // across midnight: the 12th and the 13th, and the 14 days after the 13th
      days.marks = [];
      await slice(r, '2026-10-12T20:00:00Z', '2026-10-13T03:00:00Z');
      expect(days.marks).toHaveLength(1);
      expect(days.marks[0].days).toEqual(range('2026-10-12', 16));
      expect(days.marks[0].days[15]).toBe('2026-10-27');

      // a slice that ends at midnight is over with the day before: the end is not in it
      days.marks = [];
      await slice(r, '2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z');
      expect(days.marks[0].days).toEqual(range('2026-10-12', 15));

      // a slice that starts on the last second of a day is in two
      days.marks = [];
      await slice(r, '2026-10-12T23:59:59Z', '2026-10-13T00:00:01Z');
      expect(days.marks[0].days).toEqual(range('2026-10-12', 16));

      // a failure rejects: the caller fails the slice, which keeps its range; it is neither logged nor counted here
      days.markError = new Error('read only');
      await expect(slice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z')).rejects.toThrow('read only');
      expect(fake.failures).toEqual([]);
    });

    it('marks nothing for an empty slice, and reads nothing else', async () => {
      const r = runner();
      await slice(r, '2026-10-12T05:00:00Z', '2026-10-12T05:00:00Z');
      expect(days.marks).toEqual([]);
      expect(days.newestReads).toBe(0);
      expect(days.validReads).toEqual([]);
    });
  });
});

import { HourSet, PAIR_HOURLY_CONFIG_VERSION, RatesService } from '@gatehub/data-api-shared';
import { DAY, fakeDeps, FakeDeps, HOUR, iso, NOW, unix } from '../../test/aggregate-job-fakes';
import { AGGREGATE_MAX_RETRY_MS, AGGREGATE_RETRY_MS, AggregateFunctions } from './aggregate-job-deps';
import { PairHourlyJobRunner } from './pair-hourly.job-runner';

const NOW_SECONDS = NOW.getTime() / 1000;
/** 2026-10-16T12:00:00Z, the current hour of NOW; and the hour before it. */
const CURRENT = unix('2026-10-16T12:00:00Z');
const PREVIOUS = CURRENT - HOUR;
/** The first hour of the last 31 days: the current hour minus 31 days. */
const WINDOW_START = CURRENT - 31 * DAY;

/** One call of `computePairHourSets`. */
interface Call {
  ch: unknown;
  rates: unknown;
  from: number;
  to: number;
  signal?: AbortSignal;
  /** The clock when it began, in ms. */
  at: number;
}

/**
 * The shared functions of `pair_hourly` as the runner calls them, over a map of the hour sets: `computePairHourSets` records
 * its call, takes `callMs` of the fake clock and writes the sets it would (each a new version, final when the newest ledger
 * closed after the hour); the others read the map.
 */
class FakeHours {
  sets = new Map<number, HourSet>();
  /** The close time of the newest and of the first ledger, unix seconds; none for a database without a ledger. */
  newest: number | undefined = NOW_SECONDS - 3;
  first: number | undefined = unix('2026-01-01T00:00:00Z');
  calls: Call[] = [];
  /** The hours whose computation fails (any call that covers one). */
  failing = new Set<number>();
  /** Fake time one call takes. */
  callMs = 0;
  /** Runs when a call begins, before it can fail. */
  onCompute?: (from: number, to: number) => void;
  setReads: Array<[number, number]> = [];
  newestReads = 0;
  firstReads = 0;
  private version = 1000;

  /** A final set of the current config for every hour of `[from, to)`, as the runner leaves them. */
  fill(from: number, to: number, version = 1): void {
    for (let hour = from; hour < to; hour += HOUR) this.put(hour, { version });
  }

  put(hour: number, set: Partial<HourSet> = {}): void {
    this.sets.set(hour, {
      version: 1,
      final: this.newest !== undefined && this.newest >= hour + HOUR,
      configVersion: PAIR_HOURLY_CONFIG_VERSION,
      throughTime: hour,
      ...set,
    });
  }

  drop(from: number, to = from + HOUR): void {
    for (let hour = from; hour < to; hour += HOUR) this.sets.delete(hour);
  }

  fns(): Partial<AggregateFunctions> {
    return {
      computePairHourSets: async (ch, rates, from, to, options) => {
        this.calls.push({ ch, rates, from, to, signal: options?.signal, at: Date.now() });
        this.onCompute?.(from, to);
        if (this.callMs > 0) jest.setSystemTime(Date.now() + this.callMs);
        for (let hour = from; hour < to; hour += HOUR) {
          if (this.failing.has(hour)) throw new Error('memory limit');
        }
        for (let hour = from; hour < to; hour += HOUR) this.put(hour, { version: ++this.version });
        return (to - from) / HOUR;
      },
      pairHourSets: async (_ch, from, to) => {
        this.setReads.push([from, to]);
        return new Map([...this.sets].filter(([hour]) => hour >= from && hour < to));
      },
      newestLedgerClose: async () => {
        this.newestReads++;
        return this.newest;
      },
      firstLedgerClose: async () => {
        this.firstReads++;
        return this.first;
      },
    };
  }

  /** The calls as `[from, to]` texts, in the order they were made. */
  ranges(): [string, string][] {
    return this.calls.map((c) => [iso(c.from), iso(c.to)]);
  }

  /** How many calls began at `hour`. */
  attempts(hour: number): number {
    return this.calls.filter((c) => c.from === hour).length;
  }
}

describe('PairHourlyJobRunner', () => {
  let fake: FakeDeps;
  let hours: FakeHours;
  const aggregates = { rates: { nativeCurrency: 'XRP' } as unknown as RatesService, accountRollupMinRows: 0 };

  const runner = (deps = fake.deps): PairHourlyJobRunner => new PairHourlyJobRunner(deps, aggregates, hours.fns());
  /** One run of the job, as the aggregator does it. */
  const run = (r: PairHourlyJobRunner): Promise<void> => r.job().run(fake.tick());
  const minutes = (n: number): number => n * 60_000;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fake = fakeDeps();
    hours = new FakeHours();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the job pair_hourly, with the budget of its deps', () => {
    const job = new PairHourlyJobRunner(fakeDeps({ budgetMs: 1234 }).deps, aggregates, hours.fns()).job();
    expect(job.name).toBe('pair_hourly');
    expect(job.budgetMs).toBe(1234);
  });

  it('refreshes the current hour, and the previous hour until it is final, the stalest first', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR, 100);
    // the previous hour is not final yet and older than the current hour's set: it goes first
    hours.put(PREVIOUS, { version: 50, final: false });
    const r = runner();
    await run(r);
    expect(hours.ranges()).toEqual([
      [iso(PREVIOUS), iso(CURRENT)],
      [iso(CURRENT), iso(CURRENT + HOUR)],
    ]);
    // each call is one hour, with the shared pieces of the runner
    expect(hours.calls[0].ch).toBe(fake.deps.ch);
    expect(hours.calls[0].rates).toBe(aggregates.rates);
    expect(hours.calls[0].signal).toBe(fake.abort.signal);

    // the previous hour is final now (the newest ledger closed after its end): only the current hour is left
    hours.calls = [];
    await run(r);
    expect(hours.ranges()).toEqual([[iso(CURRENT), iso(CURRENT + HOUR)]]);

    // a current hour that has no set yet is the stalest of the two
    hours.calls = [];
    hours.put(PREVIOUS, { version: 50, final: false });
    hours.drop(CURRENT);
    await run(r);
    expect(hours.ranges()).toEqual([
      [iso(CURRENT), iso(CURRENT + HOUR)],
      [iso(PREVIOUS), iso(CURRENT)],
    ]);
  });

  it('computes a previous hour whose set has an older config version, final or not', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    hours.put(PREVIOUS, { configVersion: PAIR_HOURLY_CONFIG_VERSION - 1, final: true });
    await run(runner());
    expect(hours.attempts(PREVIOUS)).toBe(1);
  });

  it('an hour of the last 31 days whose newest set has config version 1 is due, final or not, newest first', async () => {
    expect(PAIR_HOURLY_CONFIG_VERSION).toBe(2);
    hours.fill(WINDOW_START, CURRENT + HOUR);
    // the hours D2 left: sets of config version 1, final and not final, among hours of version 2
    const final = unix('2026-10-14T07:00:00Z');
    const notFinal = unix('2026-10-13T03:00:00Z');
    const oldest = WINDOW_START;
    hours.put(final, { configVersion: 1, final: true });
    hours.put(notFinal, { configVersion: 1, final: false });
    hours.put(oldest, { configVersion: 1, final: true });

    const r = runner();
    await run(r);
    expect(hours.ranges()).toEqual([
      [iso(CURRENT), iso(CURRENT + HOUR)], // the current hour first
      [iso(final), iso(final + HOUR)],
      [iso(notFinal), iso(notFinal + HOUR)],
      [iso(oldest), iso(oldest + HOUR)],
    ]);
    expect(fake.failures).toEqual([]);
    // the hours were counted as missing until they were computed
    expect(fake.metrics.pairHourlyMissingHours.set).toHaveBeenLastCalledWith(0);

    // they are written at version 2 now: only the current hour is left
    hours.calls = [];
    await run(r);
    expect(hours.ranges()).toEqual([[iso(CURRENT), iso(CURRENT + HOUR)]]);
  });

  it('back-fills the hours of the last 31 days that have no final set of the current config version, newest first; a wholly missing UTC day is one call of 24 hours', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    // an hour of a set of the previous config version, and an hour whose set is not final though the ingest has passed it
    hours.put(unix('2026-10-14T07:00:00Z'), { configVersion: PAIR_HOURLY_CONFIG_VERSION - 1, final: true });
    hours.put(unix('2026-10-13T03:00:00Z'), { final: false });
    // single hours that have no set, and three hours across a midnight (a call never crosses one)
    hours.drop(unix('2026-10-12T05:00:00Z'));
    hours.drop(unix('2026-10-12T00:00:00Z'));
    hours.drop(unix('2026-10-11T22:00:00Z'), unix('2026-10-12T00:00:00Z'));
    // a whole UTC day
    hours.drop(unix('2026-10-10T00:00:00Z'), unix('2026-10-11T00:00:00Z'));

    await run(runner());
    expect(hours.ranges()).toEqual([
      ['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'], // the current hour first
      ['2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'],
      ['2026-10-13T03:00:00Z', '2026-10-13T04:00:00Z'],
      ['2026-10-12T05:00:00Z', '2026-10-12T06:00:00Z'],
      ['2026-10-12T00:00:00Z', '2026-10-12T01:00:00Z'],
      ['2026-10-11T22:00:00Z', '2026-10-12T00:00:00Z'],
      ['2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z'],
    ]);
    expect(fake.failures).toEqual([]);

    // everything is there now: only the current hour is computed
    hours.calls = [];
    await run(runner());
    expect(hours.ranges()).toEqual([['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z']]);
  });

  it('reads the sets of the last 31 days in one read, and the ledgers it needs once per run', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    await run(runner());
    expect(hours.setReads).toEqual([[WINDOW_START, CURRENT + HOUR]]);
    expect(hours.newestReads).toBe(1);
  });

  it('never computes an hour before the hour of the first ledger', async () => {
    hours.first = unix('2026-10-14T09:20:00Z');
    const r = runner();
    await run(r);
    expect(hours.ranges()).toEqual([
      ['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'],
      ['2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'],
      // the back-fill: a call inside one UTC day, newest first, down to the hour of the first ledger
      ['2026-10-16T00:00:00Z', '2026-10-16T11:00:00Z'],
      ['2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z'],
      ['2026-10-14T09:00:00Z', '2026-10-15T00:00:00Z'],
    ]);
    expect(hours.calls.every((c) => c.from >= unix('2026-10-14T09:00:00Z'))).toBe(true);
    expect(hours.setReads).toEqual([[unix('2026-10-14T09:00:00Z'), CURRENT + HOUR]]);

    // the hour of the first ledger is read once
    hours.calls = [];
    await run(r);
    expect(hours.firstReads).toBe(1);
    expect(hours.ranges()).toEqual([['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z']]);
  });

  it('does nothing, and says there is nothing missing, while the database has no ledger', async () => {
    hours.first = undefined;
    hours.newest = undefined;
    const r = runner();
    await run(r);
    expect(hours.calls).toEqual([]);
    expect(fake.metrics.pairHourlyMissingHours.set).toHaveBeenLastCalledWith(0);

    // the first ledger arrives later: the runner reads it again, and has not cached the absence
    hours.first = unix('2026-10-16T11:20:00Z');
    hours.newest = NOW_SECONDS - 3;
    await run(r);
    expect(hours.ranges()).toEqual([
      ['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'],
      ['2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'],
    ]);
  });

  it('leaves an hour alone while the ingest has not passed it (its set cannot become final), and finalises it after', async () => {
    // the ingest stopped at 09:30: the hours after it have a set that is not final, and cannot be
    hours.newest = unix('2026-10-16T09:30:00Z');
    hours.fill(WINDOW_START, CURRENT + HOUR);
    hours.put(unix('2026-10-16T09:00:00Z'), { final: false });
    hours.put(unix('2026-10-16T08:00:00Z'), { final: false }); // the ingest has passed this hour since its set was made
    const r = runner();
    await run(r);
    expect(hours.ranges()).toEqual([
      ['2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z'],
      ['2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'], // the previous hour: never final while the ingest is behind
      ['2026-10-16T08:00:00Z', '2026-10-16T09:00:00Z'],
    ]);
  });

  it('stops starting sets once its deadline has passed, and warns once until a run finishes in time', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    const days = ['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05'].map((d) =>
      unix(`${d}T00:00:00Z`),
    );
    for (const day of days) hours.drop(day, day + DAY);
    hours.callMs = 2000; // the budget is 3 s: two sets start (at 0 and 2 s), the third would start at 4 s
    const r = runner();
    const budgetWarnings = (): number => fake.logger.warn.mock.calls.filter((c) => /budget/.test(c[0])).length;

    await run(r);
    expect(hours.ranges()).toEqual([
      [iso(CURRENT), iso(CURRENT + HOUR)],
      [iso(days[0]), iso(days[0] + DAY)],
    ]);
    expect(budgetWarnings()).toBe(1);
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('pair_hourly'));

    // it hit the budget again: said once, the rest at debug level
    hours.calls = [];
    await run(r);
    expect(hours.ranges()).toEqual([
      [iso(CURRENT), iso(CURRENT + HOUR)],
      [iso(days[1]), iso(days[1] + DAY)],
    ]);
    expect(budgetWarnings()).toBe(1);
    expect(fake.logger.debug).toHaveBeenCalledWith(expect.stringContaining('budget'));

    // a run that finishes in time (what is left is quick) ends the streak ...
    hours.callMs = 0;
    hours.calls = [];
    await run(r);
    expect(hours.calls).toHaveLength(1 + 4);
    expect(budgetWarnings()).toBe(1);

    // ... so the next run that hits the budget warns again
    for (const day of days.slice(0, 3)) hours.drop(day, day + DAY);
    hours.callMs = 2000;
    hours.calls = [];
    await run(r);
    expect(hours.calls).toHaveLength(2);
    expect(budgetWarnings()).toBe(2);
  });

  it('starts no set when the deadline has passed before it reads anything', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    const tick = fake.tick();
    jest.setSystemTime(tick.deadline);
    await runner().job().run(tick);
    expect(hours.calls).toEqual([]);
    expect(hours.setReads).toEqual([]);
    expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  it('a failing hour is passed to failed("pair_hourly", …), waits 5 min, then 10, up to an hour, while the others go on', async () => {
    const bad = unix('2026-10-12T09:00:00Z');
    const good = unix('2026-10-12T05:00:00Z');
    hours.fill(WINDOW_START, CURRENT + HOUR);
    hours.drop(bad);
    hours.drop(good);
    hours.failing.add(bad);
    const r = runner();

    await run(r);
    expect(fake.failures).toHaveLength(1);
    expect(fake.failures[0].job).toBe('pair_hourly');
    expect(fake.failures[0].where).toContain(iso(bad));
    expect((fake.failures[0].err as Error).message).toBe('memory limit');
    expect(hours.attempts(bad)).toBe(1);
    // the older hour, after it, was computed
    expect(hours.attempts(good)).toBe(1);

    expect(AGGREGATE_RETRY_MS).toBe(minutes(5));
    expect(AGGREGATE_MAX_RETRY_MS).toBe(minutes(60));
    let failedAt = Date.now();
    let attempts = 1;
    for (const wait of [5, 10, 20, 40, 60, 60]) {
      jest.setSystemTime(failedAt + minutes(wait) - 1);
      await run(r);
      expect(hours.attempts(bad)).toBe(attempts); // still waiting
      jest.setSystemTime(failedAt + minutes(wait));
      await run(r);
      expect(hours.attempts(bad)).toBe(++attempts);
      failedAt += minutes(wait);
    }
    expect(fake.failures).toHaveLength(attempts);
    // the hour that worked was not computed again
    expect(hours.attempts(good)).toBe(1);

    // it works at last: the wait is forgotten and nothing is left to compute
    hours.failing.clear();
    jest.setSystemTime(failedAt + minutes(60));
    await run(r);
    expect(hours.attempts(bad)).toBe(attempts + 1);
    hours.calls = [];
    jest.setSystemTime(failedAt + minutes(60) + 1000);
    await run(r);
    expect(hours.attempts(bad)).toBe(0);
  });

  it('gives up after 3 failures in a tick, and the sets that failed do not count again while they wait', async () => {
    const bad = ['01', '03', '05', '07', '09'].map((h) => unix(`2026-10-12T${h}:00:00Z`));
    hours.fill(WINDOW_START, CURRENT + HOUR);
    for (const hour of bad) {
      hours.drop(hour);
      hours.failing.add(hour);
    }
    const r = runner();

    await run(r);
    // newest first: three attempts, and the two older hours were not started
    expect(fake.failures).toHaveLength(3);
    expect(bad.map((hour) => hours.attempts(hour))).toEqual([0, 0, 1, 1, 1]);

    // the next tick: those three wait, the other two are tried
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    expect(fake.failures).toHaveLength(5);
    expect(bad.map((hour) => hours.attempts(hour))).toEqual([1, 1, 1, 1, 1]);
  });

  it('a day that failed as one call is tried again an hour at a time, so that one bad hour does not keep the day', async () => {
    const day = unix('2026-10-10T00:00:00Z');
    hours.fill(WINDOW_START, CURRENT + HOUR);
    hours.drop(day, day + DAY);
    hours.failing.add(day + 5 * HOUR);
    const r = runner();

    await run(r);
    expect(hours.ranges()).toContainEqual([iso(day), iso(day + DAY)]);
    expect(fake.failures).toHaveLength(1);

    hours.calls = [];
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    const ofDay = hours.calls.filter((c) => c.from >= day && c.from < day + DAY);
    expect(ofDay).toHaveLength(24);
    expect(ofDay.every((c) => c.to - c.from === HOUR)).toBe(true);
    expect(fake.failures).toHaveLength(2);
    // 23 hours have their set; the bad one waits (10 min now)
    expect([...hours.sets.keys()].filter((h) => h >= day && h < day + DAY)).toHaveLength(23);
    hours.calls = [];
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    expect(hours.attempts(day + 5 * HOUR)).toBe(0);
  });

  it('forgets the wait of an hour that is no longer wanted', async () => {
    const bad = unix('2026-10-12T09:00:00Z');
    hours.fill(WINDOW_START, CURRENT + HOUR);
    hours.drop(bad);
    hours.failing.add(bad);
    const r = runner();
    await run(r);
    expect(hours.attempts(bad)).toBe(1); // it fails: it waits 5 min

    // the hour is computed by other means (the hook of agg_dirty) while it waits, then loses its set (a new config version)
    hours.failing.clear();
    hours.put(bad);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    hours.drop(bad);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r);
    expect(hours.attempts(bad)).toBe(2); // tried at once: the old wait was forgotten
  });

  it('sets syncer_pair_hourly_missing_hours', async () => {
    hours.first = unix('2026-10-14T09:20:00Z');
    hours.fill(unix('2026-10-14T09:00:00Z'), CURRENT + HOUR);
    const missing = unix('2026-10-15T03:00:00Z');
    const oldConfig = unix('2026-10-15T05:00:00Z');
    const notFinal = unix('2026-10-15T07:00:00Z'); // a set of the current config: not missing
    hours.drop(missing);
    hours.put(oldConfig, { configVersion: PAIR_HOURLY_CONFIG_VERSION - 1 });
    hours.put(notFinal, { final: false });
    hours.failing.add(missing);
    const gauge = fake.metrics.pairHourlyMissingHours.set;
    const r = runner();

    await run(r);
    // the old-config hour was written, the missing hour failed
    expect(gauge).toHaveBeenLastCalledWith(1);

    hours.failing.clear();
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    expect(gauge).toHaveBeenLastCalledWith(0);
  });

  it('counts the hours it did not get to in the gauge, and the hours of the last 31 days only', async () => {
    // a database with a year of history: only the last 31 days are counted (744 hours, and the current one)
    hours.callMs = 4000; // the current hour takes the whole budget
    const r = runner();
    await run(r);
    // every hour of the 31 days but the current one, which was written
    expect(fake.metrics.pairHourlyMissingHours.set).toHaveBeenLastCalledWith(31 * 24);
  });

  it('runs without metrics', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    await run(new PairHourlyJobRunner({ ...fake.deps, metrics: undefined }, aggregates, hours.fns()));
    expect(hours.attempts(CURRENT)).toBe(1);
  });

  it('says once that the back-fill is under way and once that it is done', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    const days = [unix('2026-10-10T00:00:00Z'), unix('2026-10-09T00:00:00Z')];
    for (const day of days) hours.drop(day, day + DAY);
    hours.callMs = 2000; // two sets a run
    const r = runner();
    const said = (): string[] => fake.logger.log.mock.calls.map((c) => c[0]).filter((t) => /back-fill/i.test(t));

    await run(r); // the current hour and the first day; the second day is left
    expect(said()).toEqual([expect.stringMatching(/Pair-hourly back-fill: 48 hour\(s\) to compute/)]);

    await run(r); // the current hour and the second day: done
    expect(said()).toHaveLength(2);
    expect(said()[1]).toMatch(/Pair-hourly back-fill is done/);

    await run(r);
    await run(r);
    expect(said()).toHaveLength(2);

    // a later gap starts a new announcement
    hours.drop(days[0], days[0] + DAY);
    await run(r);
    expect(said()).toHaveLength(4);
    expect(said()[2]).toMatch(/Pair-hourly back-fill: 24 hour\(s\) to compute/);
    expect(said()[3]).toMatch(/is done/);
  });

  it('does not say the back-fill is done while a set failed or waits', async () => {
    hours.fill(WINDOW_START, CURRENT + HOUR);
    const bad = unix('2026-10-12T05:00:00Z');
    hours.drop(bad);
    hours.failing.add(bad);
    const r = runner();
    await run(r);
    jest.setSystemTime(Date.now() + minutes(1));
    await run(r); // it waits
    expect(fake.logger.log.mock.calls.filter((c) => /done/.test(c[0]))).toEqual([]);
    hours.failing.clear();
    jest.setSystemTime(Date.now() + minutes(5));
    await run(r);
    expect(fake.logger.log.mock.calls.filter((c) => /done/.test(c[0]))).toHaveLength(1);
  });

  describe('ofSlice', () => {
    it('recomputes the hours of the slice inside the last 31 days only, split at UTC midnight, and rejects when a set fails', async () => {
      const r = runner();
      const tick = fake.tick();
      await r.ofSlice(unix('2026-10-15T20:00:00Z'), unix('2026-10-16T03:00:00Z'), tick);
      expect(hours.ranges()).toEqual([
        ['2026-10-15T20:00:00Z', '2026-10-16T00:00:00Z'],
        ['2026-10-16T00:00:00Z', '2026-10-16T03:00:00Z'],
      ]);
      expect(hours.calls.every((c) => c.signal === fake.abort.signal && c.rates === aggregates.rates)).toBe(true);
      // it reads nothing: the hours are the slice's
      expect(hours.setReads).toEqual([]);

      // a slice a day long
      hours.calls = [];
      await r.ofSlice(unix('2026-10-14T05:00:00Z'), unix('2026-10-15T05:00:00Z'), tick);
      expect(hours.ranges()).toEqual([
        ['2026-10-14T05:00:00Z', '2026-10-15T00:00:00Z'],
        ['2026-10-15T00:00:00Z', '2026-10-15T05:00:00Z'],
      ]);

      // the part of a slice older than the 31 days is left out, a slice wholly older is not computed
      hours.calls = [];
      await r.ofSlice(unix('2026-09-15T10:00:00Z'), unix('2026-09-15T14:00:00Z'), tick);
      expect(hours.ranges()).toEqual([['2026-09-15T12:00:00Z', '2026-09-15T14:00:00Z']]);
      hours.calls = [];
      await r.ofSlice(unix('2026-08-01T00:00:00Z'), unix('2026-08-02T00:00:00Z'), tick);
      expect(hours.calls).toEqual([]);

      // a slice that is not on the hours is widened to them
      await r.ofSlice(unix('2026-10-15T20:30:00Z'), unix('2026-10-15T22:10:00Z'), tick);
      expect(hours.ranges()).toEqual([['2026-10-15T20:00:00Z', '2026-10-15T23:00:00Z']]);

      // a set that fails fails the slice, and the sets after it are not started
      hours.calls = [];
      hours.failing.add(unix('2026-10-15T22:00:00Z'));
      await expect(r.ofSlice(unix('2026-10-15T20:00:00Z'), unix('2026-10-16T03:00:00Z'), tick)).rejects.toThrow(
        'memory limit',
      );
      expect(hours.ranges()).toEqual([['2026-10-15T20:00:00Z', '2026-10-16T00:00:00Z']]);
      // the failure is the caller's to log: the runner neither counts it nor backs the hours off
      expect(fake.failures).toEqual([]);
    });

    it('does not compute hours of the future', async () => {
      await runner().ofSlice(unix('2026-10-16T10:00:00Z'), unix('2026-10-17T10:00:00Z'), fake.tick());
      expect(hours.ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']]);
    });
  });

  describe('closing', () => {
    it('starts nothing once closing() is true', async () => {
      hours.first = unix('2026-10-14T09:20:00Z');
      fake.closing = true;
      const r = runner();
      await run(r);
      await r.ofSlice(unix('2026-10-15T20:00:00Z'), unix('2026-10-16T03:00:00Z'), fake.tick());
      expect(hours.calls).toEqual([]);
      expect(hours.setReads).toEqual([]);
      expect(fake.logger.warn).not.toHaveBeenCalled();

      // it ends a run that was going: the sets after the one in flight are not started
      fake.closing = false;
      hours.onCompute = () => {
        fake.closing = true;
      };
      await run(r);
      expect(hours.calls).toHaveLength(1);
    });

    it('does not back a set off that the shutdown aborted', async () => {
      const bad = unix('2026-10-12T05:00:00Z');
      hours.fill(WINDOW_START, CURRENT + HOUR);
      hours.drop(bad);
      hours.failing.add(bad);
      hours.onCompute = (from) => {
        if (from === bad) fake.closing = true;
      };
      const r = runner();
      await run(r);
      expect(hours.attempts(bad)).toBe(1);
      // `failed` is told (it drops what the shutdown aborted), and the set is not made to wait for it
      expect(fake.failures).toHaveLength(1);

      fake.closing = false;
      hours.onCompute = undefined;
      hours.failing.clear();
      await run(r);
      expect(hours.attempts(bad)).toBe(2);
    });
  });
});

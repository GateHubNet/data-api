import {
  AMM_DAILY_CONFIG_VERSION,
  AmmDailyRecomputeAborted,
  MarketsConfig,
  RatesService,
  VOLUME_DAY_SETTLE_MS,
} from '@gatehub/data-api-shared';
import { DAY, FakeClickHouse, iso, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_AMM_DAILY_BUDGET_MS,
  AGGREGATOR_INTERVAL_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AggregatorJob,
  AggregatorOptions,
  AggregatorService,
  AMM_DAILY_EVERY_TICKS,
} from './aggregator.service';
import { AMM_DAILY_BACKFILL_MAX_RETRY_MS, AMM_DAILY_BACKFILL_RETRY_MS } from './amm-daily.job-runner';

/**
 * The `amm_daily` job (`AmmDailyJobRunner`), driven through the `AggregatorService` it runs in: the cadence, today and
 * yesterday, the back-fill of the closed days, the hook of `agg_dirty` and the days it owes, and the shutdown.
 */

describe('AggregatorService amm_daily job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  /** The first UTC day with pool activity: the back-fill starts here. */
  const FIRST_ACTIVITY = unix('2026-10-10T08:00:00Z');
  /** The first day the ingest has passed at NOW, with the day before yesterday on the clock: 2026-10-14. */
  const NEWEST_CLOSED = '2026-10-14';

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What happened, in order: `amm_daily <day>`, `stats <from>`. */
  let events: string[];
  let statsRecompute: jest.Mock;
  let compute: jest.Mock;
  let daysDone: jest.Mock;
  let versions: jest.Mock;
  let firstDay: jest.Mock;
  /** The days the fake marked owed in the tables (Ruling R-A27). */
  let markOwed: jest.Mock;
  /** How long (fake milliseconds) the set of a day takes: a closed day, and today or yesterday. */
  let closedMs: number;
  let currentMs: number;
  /** The days (`YYYY-MM-DD`) the fake fails on, while they are in the set. */
  let failing: Set<string>;
  /** The days the fake has written a final set for, and the order of its writes (a counter, as the versions of the sets). */
  let finalDays: Set<string>;
  let writes: Map<string, number>;
  let seq: number;

  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const mark = (from: string, to: string, createdMs = 1000) => ({ from: unix(from), to: unix(to), created: createdMs });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const computed = (): string[] => events.filter((e) => e.startsWith('amm_daily')).map((e) => e.slice(10));
  const isClosed = (d: string): boolean => d < '2026-10-15';
  /** The newest ledger closed at half past midnight: the ingest has not passed yesterday by an hour, so its set is not final. */
  const behindYesterday = (): void => {
    ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-16T00:30:00Z')];
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    events = [];
    closedMs = 0;
    currentMs = 0;
    failing = new Set();
    finalDays = new Set();
    writes = new Map();
    seq = 0;
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      return 1;
    });
    // the fake job writes a final set when the newest ledger has passed the day by an hour, as the real one does
    compute = jest.fn(async (_ch: unknown, _rates: unknown, d: Date) => {
      const key = day(d);
      events.push(`amm_daily ${key}`);
      const ms = isClosed(key) ? closedMs : currentMs;
      if (ms > 0) jest.setSystemTime(Date.now() + ms);
      if (failing.has(key)) throw new Error(`DB::Exception: amm_daily ${key}`);
      writes.set(key, ++seq);
      const newest = ch.closes[ch.closes.length - 1];
      if (newest !== undefined && newest >= d.getTime() / 1000 + DAY + VOLUME_DAY_SETTLE_MS / 1000) finalDays.add(key);
      else finalDays.delete(key);
      return 0;
    });
    daysDone = jest.fn(async (_ch: unknown, _configVersion: number, days: Date[]) => {
      return new Set(days.map(day).filter((key) => finalDays.has(key)));
    });
    versions = jest.fn(async (_ch: unknown, from: Date, to: Date) => {
      const [a, b] = [day(from), day(to)];
      return new Map([...writes].filter(([k]) => k >= a && k <= b));
    });
    firstDay = jest.fn(async () => FIRST_ACTIVITY);
    // the fake marks a day owed as the real one does: its set is no longer final
    markOwed = jest.fn(async (_ch: unknown, d: Date) => {
      events.push(`owed ${day(d)}`);
      finalDays.delete(day(d));
    });
    // the stats are up to date: the live window is the last slice only
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: statsRecompute,
      ammDaily: { rates: RATES },
      ammDailyFunctions: { compute, daysDone, versions, firstDay, markOwed },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** Ticks `n` times, one minute apart, from NOW; the events and the metrics keep adding up. */
  async function ticks(svc: AggregatorService, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      jest.setSystemTime(NOW_SECONDS * 1000 + i * AGGREGATOR_INTERVAL_MS);
      await svc.tick();
    }
  }

  describe('the job in the tick', () => {
    it('comes after stats_dirty and before volume_backfill, with every other job registered', async () => {
      const volumeFunctions = {
        computeLiveSet: jest.fn(async () => 0),
        computeDailySet: jest.fn(async () => 0),
        daysDone: jest.fn(async () => new Set<string>()),
        liveVersions: jest.fn(async () => new Map<string, number>()),
        dailyVersions: jest.fn(async () => new Map<string, number>()),
      };
      const ammPoolsFunctions = {
        watermark: jest.fn(async () => 0),
        changedSince: jest.fn(async (_c: unknown, ledger: number) => ({ accounts: [], upTo: ledger })),
        poolsClosedIn: jest.fn(async () => []),
        recompute: jest.fn(async () => 0),
      };
      await service({
        volumes: { rates: RATES, markets: MARKETS },
        volumeFunctions,
        ammPools: { rates: RATES },
        ammPoolsFunctions,
      }).tick();
      expect(jobsRun()).toEqual([
        'volume_live',
        'volume_daily',
        'amm_pools',
        'stats_live',
        'stats_dirty',
        'amm_daily',
        'volume_backfill',
      ]);
    });

    it('is the job after the stats alone, without the volumes and the pools', async () => {
      await service().tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'amm_daily']);
    });

    it('does its days after the stats of the tick: the live work comes first', async () => {
      await service().tick();
      expect(events.findIndex((e) => e.startsWith('stats'))).toBeLessThan(
        events.findIndex((e) => e.startsWith('amm_daily')),
      );
    });

    it('is off without the option: nothing is asked of the AMM functions, and a dirty range is only the stats', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service({ ammDaily: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [compute, daysDone, versions, firstDay]) expect(fn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('has a budget of 4 s of its own and runs every fifth tick', () => {
      expect(AGGREGATOR_AMM_DAILY_BUDGET_MS).toBe(4000);
      expect(AMM_DAILY_EVERY_TICKS).toBe(5);
      expect(AMM_DAILY_BACKFILL_RETRY_MS).toBe(5 * 60_000);
      expect(AMM_DAILY_BACKFILL_MAX_RETRY_MS).toBe(60 * 60_000);
    });

    it('the budget can be changed per job', async () => {
      closedMs = 1000;
      currentMs = 1000;
      await service({ budgetsMs: { amm_daily: 1500 } }).tick();
      // today (1 s), then yesterday starts at 1 s < 1.5 s, then nothing at 2 s but the one closed day of the floor
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('the cadence: every fifth tick, the first one among them', () => {
    it('runs at the first tick, not at the four after it, and again at the sixth', async () => {
      const svc = service();
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      await ticks(svc, 5); // ticks 2-6 of the run
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1 + 1);
      expect(statsRecompute).toHaveBeenCalled();
    });

    it('counts a run in the metrics only when it ran, the other jobs at every tick', async () => {
      const svc = service();
      await ticks(svc, 11);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3); // ticks 1, 6 and 11
      expect(jobsRun().filter((j) => j === 'stats_live')).toHaveLength(11);
    });

    it('reads nothing on the ticks it skips', async () => {
      const svc = service();
      await ticks(svc, 1);
      versions.mockClear();
      firstDay.mockClear();
      daysDone.mockClear();
      compute.mockClear();
      await ticks(svc, 4);
      for (const fn of [versions, firstDay, daysDone, compute]) expect(fn).not.toHaveBeenCalled();
    });

    it('a tick skipped because the previous one was still running does not count towards the five', async () => {
      const svc = service();
      let release!: () => void;
      statsRecompute.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      );
      const first = svc.tick();
      await jest.advanceTimersByTimeAsync(0);
      const skipped = svc.tick(); // overlaps the first: it is the first one's promise, and no run of its own
      release();
      await Promise.all([first, skipped]);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      // four more ticks are not enough for the next run, the fifth is
      await ticks(svc, 4);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(2);
    });

    it('the number of ticks between runs can be set', async () => {
      const svc = service({ ammDailyEveryTicks: 2 });
      await ticks(svc, 5);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3); // ticks 1, 3 and 5
      const every = service({ ammDailyEveryTicks: 1 });
      metrics.aggregatorRunsTotal.inc.mockClear();
      await ticks(every, 3);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3);
    });
  });

  describe('today and yesterday', () => {
    it('are recomputed at each run, both, as the UTC days they are (the start of the day) with the signal of the shutdown', async () => {
      await service().tick();
      const days = compute.mock.calls
        .filter(([, , d]) => !isClosed(day(d)))
        .map(([chArg, ratesArg, d, options]) => [chArg, ratesArg, d.toISOString(), options]);
      expect(days).toHaveLength(2);
      for (const [chArg, ratesArg, , options] of days) {
        expect([chArg, ratesArg]).toEqual([ch, RATES]);
        expect(options).toEqual({ signal: expect.any(AbortSignal) });
      }
      expect(days.map(([, , d]) => d).sort()).toEqual(['2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z']);
    });

    it('moves on with the UTC midnight', async () => {
      jest.setSystemTime(new Date('2026-10-17T00:00:30Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-17T00:00:20Z')];
      await service().tick();
      expect(
        computed()
          .filter((d) => d >= '2026-10-16')
          .sort(),
      ).toEqual(['2026-10-16', '2026-10-17']);
    });

    it('start with the one written longest ago, and one never written first', async () => {
      behindYesterday(); // yesterday is computed at every run until its set is final
      writes.set('2026-10-16', 5);
      writes.set('2026-10-15', 9);
      await service().tick();
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);

      events.length = 0;
      writes.set('2026-10-16', 20);
      jest.setSystemTime(NOW);
      await ticks(service(), 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);

      events.length = 0;
      writes.delete('2026-10-16');
      writes.set('2026-10-15', 1);
      await ticks(service(), 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
    });

    it('read the versions of the two days once for the run, from yesterday to today', async () => {
      await service().tick();
      expect(versions).toHaveBeenCalledTimes(1);
      const [, from, to] = versions.mock.calls[0];
      expect([day(from), day(to)]).toEqual(['2026-10-15', '2026-10-16']);
    });

    it('go in the default order when the versions cannot be read, and the failure is logged and counted', async () => {
      versions.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reading the versions'));
    });

    it('a day that fails is logged and counted once, under amm_daily; the other day still runs', async () => {
      failing.add('2026-10-16');
      await service().tick();
      expect(computed().slice(0, 2).sort()).toEqual(['2026-10-15', '2026-10-16']);
      const errors = metrics.aggregatorErrorsTotal.inc.mock.calls.filter(([labels]) => labels.job === 'amm_daily');
      expect(errors).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_daily failed in 2026-10-16'));
      expect(jobsRun()).toContain('amm_daily'); // the job itself did not fail: only its day did
    });

    it('a day that failed is tried again at the next run (five ticks later), after the day that did not fail (R87)', async () => {
      // 2026-10-16 is the stalest (never written) but failed last time: it goes behind yesterday
      behindYesterday();
      failing.add('2026-10-16');
      const svc = service();
      await ticks(svc, 1);
      events.length = 0;
      failing.clear();
      await ticks(svc, 4);
      expect(computed()).toEqual([]); // nothing in between
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
    });

    it('a day that works again goes back in the order of its version: nothing keeps it behind', async () => {
      behindYesterday();
      failing.add('2026-10-16');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1); // 2026-10-16 fails (never written, the stalest), 2026-10-15 is written
      failing.clear();
      events.length = 0;
      await ticks(svc, 1); // behind yesterday because of the failure; it works now
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
      // 2026-10-15 was written longer ago than 2026-10-16 now: the stalest first again
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
      writes.set('2026-10-15', 999);
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
    });

    it('the memory of a failure goes with the day: it does not grow by a key a day', async () => {
      failing.add('2026-10-15');
      const svc = service({ ammDailyEveryTicks: 1 });
      const memory = (svc as unknown as { ammDaily: { failedLast: Set<string> } }).ammDaily.failedLast;
      await svc.tick();
      expect([...memory]).toEqual(['2026-10-15']);
      // three days on the failed day is neither today nor yesterday
      failing.clear();
      jest.setSystemTime(new Date('2026-10-18T12:00:00Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-18T11:59:00Z')];
      await svc.tick();
      expect([...memory]).toEqual([]);
    });

    it('a failing run does not use the budget of the next: the wait of a slow failure is part of this run only', async () => {
      failing.add('2026-10-16');
      currentMs = 3000;
      await service().tick();
      // the failure took 3 s of the 4: yesterday starts at 3 s; the back-fill has no time left but for the floor's one day
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('the back-fill of the closed days', () => {
    it('computes the closed days from the first day with pool activity to the day before yesterday, newest first', async () => {
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([
        '2026-10-14',
        '2026-10-13',
        '2026-10-12',
        '2026-10-11',
        '2026-10-10',
      ]);
    });

    it('asks which of the days are done in one read, for the config version, and does not repeat a final day', async () => {
      const svc = service();
      await ticks(svc, 1);
      // the days done: yesterday (is it final?), and the closed days in one read
      expect(daysDone).toHaveBeenCalledTimes(2);
      const [chArg, configVersion, days] = daysDone.mock.calls[1];
      expect([chArg, configVersion]).toEqual([ch, AMM_DAILY_CONFIG_VERSION]);
      expect((days as Date[]).map(day)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);

      events.length = 0;
      await ticks(svc, 5);
      // the next run: every closed day and yesterday are done; only today
      expect(computed()).toEqual(['2026-10-16']);
    });

    it('skips the days that are done, and computes only the others', async () => {
      finalDays.add('2026-10-14');
      finalDays.add('2026-10-12');
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-13', '2026-10-11', '2026-10-10']);
    });

    it('starts at the day of the first pool activity, not at the first ledger: the years before the AMM are not worth a set each', async () => {
      ch.closes = [unix('2015-01-01T00:00:00Z'), NOW_SECONDS - 3];
      firstDay.mockResolvedValue(unix('2026-10-12T20:00:00Z'));
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
    });

    it('does nothing for the closed days of a database without any pool activity, and still keeps today and yesterday', async () => {
      firstDay.mockResolvedValue(undefined);
      await service().tick();
      expect(computed().sort()).toEqual(['2026-10-15', '2026-10-16']);
      // only the read about yesterday: no closed days to ask about
      expect(daysDone).toHaveBeenCalledTimes(1);
      expect(daysDone.mock.calls[0][2]).toHaveLength(1);
    });

    it('does nothing without ledgers, and when the first activity is younger than the closed days', async () => {
      ch.closes = [];
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
      firstDay.mockResolvedValue(unix('2026-10-15T08:00:00Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
      events.length = 0;
      await ticks(service(), 1);
      expect(computed().filter(isClosed)).toEqual([]);
    });

    it('works under the budget of the job, and goes on where it stopped at the next run', async () => {
      closedMs = 1000;
      currentMs = 1000;
      const svc = service();
      await ticks(svc, 1);
      // today 0-1 s, yesterday 1-2 s, then 2026-10-14 at 2 s and 2026-10-13 at 3 s; at 4 s the budget is spent
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));

      events.length = 0;
      await ticks(svc, 5);
      // the next run: today again (yesterday is final), and the days after the ones that are done: with yesterday left
      // out there is time for three, at 1 s, 2 s and 3 s
      expect(computed().filter((d) => !isClosed(d))).toEqual(['2026-10-16']);
      expect(computed().filter(isClosed)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10']);
    });

    it('never takes the tick from the live work: whatever it has left to do, the tick ends within its budget', async () => {
      closedMs = 3000;
      currentMs = 3000;
      const svc = service();
      const start = Date.now();
      await ticks(svc, 1);
      // 4 s of budget and sets of 3 s: today (3 s), yesterday (starts at 3 s, ends at 6 s), and then the one closed day of the
      // floor (to 9 s) and no more: a run is its budget plus the set in flight plus the one the floor allows
      expect(Date.now() - start).toBeLessThanOrEqual(AGGREGATOR_AMM_DAILY_BUDGET_MS + 3000 + 3000);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']);
    });

    it('says when it starts, and when it is done: in the run that finishes the last day', async () => {
      closedMs = 1000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      // 5 closed days, 1 s each, 4 s of budget (today and yesterday are free here): four days now, one to go
      expect(logger.log).toHaveBeenCalledWith('AMM daily back-fill: 5 days to compute, newest day first');
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
      expect(computed().filter(isClosed)).toHaveLength(4);
      logger.log.mockClear();
      await ticks(svc, 1); // the next run does the last day, and says it is done
      expect(computed().filter(isClosed)).toHaveLength(5);
      expect(logger.log).toHaveBeenCalledWith('AMM daily back-fill is done: every closed day has its set');
      logger.log.mockClear();
      await ticks(svc, 2);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill'));
    });

    it('says it is done when the days that were left have been done meanwhile (the hook of agg_dirty, another run)', async () => {
      closedMs = 1000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1); // four of the five closed days
      logger.log.mockClear();
      finalDays.add('2026-10-10'); // the last one is done by something else
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual([]); // nothing is left to compute
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill is done'));
    });

    it('does not say it is done while a day waits for its retry, and says it when that day works', async () => {
      failing.add('2026-10-12');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill: 5 days to compute'));
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done')); // a day failed
      logger.log.mockClear();
      await ticks(svc, 1); // the failed day is waiting: the others are done, and it is not
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill is done'));
    });

    it('reads which days are wanted although the budget is spent, and starts the one closed day of the floor', async () => {
      currentMs = 5000;
      await service().tick();
      expect(daysDone).toHaveBeenCalledTimes(2); // yesterday, and the closed days
      expect(computed()).toEqual(['2026-10-16', '2026-10-14']);
    });

    it('does the same when today and yesterday used the budget up exactly', async () => {
      currentMs = 2000;
      await service({ budgetsMs: { amm_daily: 4000 } }).tick();
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });

    it('starts no day after the shutdown began', async () => {
      const svc = service();
      compute.mockImplementation(async (_c: unknown, _r: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        if (day(d) === '2026-10-14') void svc.stop();
        return 0;
      });
      await svc.tick();
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('a closed day is final once the ingest has passed it (Ruling R86)', () => {
    it('is back-filled only when the newest ingested ledger closed an hour after the end of the day, whatever the clock says', async () => {
      // an outage: the ingest is on 2026-10-14 at half past midnight, and the clock is two days on
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T00:30:00Z')];
      await service().tick();
      // the day of the newest ledger less the hour is 2026-10-13: the days before it are closed
      expect(computed().filter(isClosed)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10']);
    });

    it('the end of the day plus the settle time, to the second', async () => {
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T01:00:00Z') - 1];
      await service().tick();
      expect(computed().filter(isClosed)[0]).toBe('2026-10-12');

      events.length = 0;
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T01:00:00Z')];
      await ticks(service(), 1);
      expect(computed().filter(isClosed)[0]).toBe('2026-10-13');
    });

    it('a day computed before the ingest had passed it is computed again once it has', async () => {
      // today the ingest is a bit behind: the set for 2026-10-14 would not be final (the fake job knows the rule too)
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-15T00:30:00Z')];
      const svc = service();
      await ticks(svc, 1);
      expect(finalDays.has('2026-10-14')).toBe(false); // the fake wrote it in the today/yesterday pass or not at all
      expect(computed()).not.toContain(NEWEST_CLOSED); // it was not back-filled: the ingest has not passed it
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-15T01:00:00Z')];
      events.length = 0;
      await ticks(svc, 5);
      expect(computed()).toContain(NEWEST_CLOSED);
      expect(finalDays.has(NEWEST_CLOSED)).toBe(true);
    });

    it('yesterday is never a closed day, however far the ingest is past it', async () => {
      await service().tick();
      expect(computed().filter(isClosed)).not.toContain('2026-10-15');
      expect(daysDone.mock.calls[1][2].map(day)).not.toContain('2026-10-15'); // the read of the closed days (the first is yesterday's)
    });

    it('an ingest that started at an old ledger leaves no closed day to back-fill beyond its newest ledger', async () => {
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-10T09:00:00Z')];
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
    });
  });

  describe('a closed day that fails every time does not hold the back-fill up', () => {
    it('is skipped while it waits, so the older days go on; then it is tried again', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      const start = NOW_SECONDS * 1000;
      const closedOf = async (offsetMs: number): Promise<string[]> => {
        jest.setSystemTime(start + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().filter(isClosed);
      };
      expect(await closedOf(0)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);

      // within the wait the day is left alone and nothing else is missing
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS - 1000)).toEqual([]);
      // after it the day is tried again (and works now)
      failing.clear();
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS)).toEqual(['2026-10-14']);
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS + 60_000)).toEqual([]);
    });

    it('the wait doubles at every failure, up to an hour', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      let now = NOW_SECONDS * 1000;
      const attempts = async (at: number): Promise<number> => {
        jest.setSystemTime(at);
        events.length = 0;
        await svc.tick();
        return computed().filter((d) => d === '2026-10-14').length;
      };
      const minute = 60_000;
      for (const wait of [5, 10, 20, 40, 60, 60, 60]) {
        expect(await attempts(now)).toBe(1); // fails, and waits
        expect(await attempts(now + wait * minute - 1000)).toBe(0);
        now += wait * minute;
      }
      expect(AMM_DAILY_BACKFILL_RETRY_MS * 2 ** 4).toBeGreaterThan(AMM_DAILY_BACKFILL_MAX_RETRY_MS);
    });

    it('a day that works after a failure forgets it: if it fails again later, the wait starts at five minutes again', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      const start = NOW_SECONDS * 1000;
      const triedAt = async (offsetMs: number): Promise<boolean> => {
        jest.setSystemTime(start + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().includes('2026-10-14');
      };
      expect(await triedAt(0)).toBe(true); // fails: waits 5 minutes
      failing.clear();
      expect(await triedAt(AMM_DAILY_BACKFILL_RETRY_MS)).toBe(true); // works
      expect(finalDays.has('2026-10-14')).toBe(true);
      expect(await triedAt(AMM_DAILY_BACKFILL_RETRY_MS + 60_000)).toBe(false); // done: nothing to do
      // the day is wanted again (a new computation), and fails again: the wait is the first one, not the second
      finalDays.delete('2026-10-14');
      failing.add('2026-10-14');
      const again = AMM_DAILY_BACKFILL_RETRY_MS + 2 * 60_000;
      expect(await triedAt(again)).toBe(true); // fails
      expect(await triedAt(again + AMM_DAILY_BACKFILL_RETRY_MS - 1000)).toBe(false);
      expect(await triedAt(again + AMM_DAILY_BACKFILL_RETRY_MS)).toBe(true);
    });

    it('gives up after three days failed in a run, so that an outage does not log a line per day', async () => {
      for (const d of ['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']) failing.add(d);
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
    });

    it('does not wait on a day that failed because of the shutdown', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      compute.mockImplementation(async (_c: unknown, _r: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        if (day(d) === '2026-10-14') {
          void svc.stop();
          throw new AmmDailyRecomputeAborted();
        }
        return 0;
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      // and no wait is set for the day: a process that stops is not a day that failed
      expect((svc as unknown as { ammDaily: { backoff: Map<string, unknown> } }).ammDaily.backoff.size).toBe(0);
    });
  });

  describe('the days of agg_dirty ranges (the hook of stats_dirty)', () => {
    it('recomputes the day of a slice, after its stats, and removes the range', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      await service().tick();
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'amm_daily 2026-05-01']);
      // the first slice of the range is the day it starts in, the second the next one
      const dirtyDays = computed().filter((d) => d.startsWith('2026-05'));
      expect(dirtyDays).toEqual(['2026-05-01', '2026-05-02']);
      expect(ch.dirty).toEqual([]);
    });

    it('hands the shutdown signal to every day, like the other jobs', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      const call = compute.mock.calls.find(([, , d]) => day(d) === '2026-05-01');
      expect(call?.[1]).toBe(RATES);
      expect(call?.[3]).toEqual({ signal: expect.any(AbortSignal) });
    });

    it('a range of several days: each slice recomputes its own day, a day cut by two slices once more than needed is fine', async () => {
      ch.dirty = [mark('2026-05-01T12:00:00Z', '2026-05-03T06:00:00Z')];
      await service().tick();
      expect(computed().filter((d) => d.startsWith('2026-05'))).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
      expect(ch.dirty).toEqual([]);
    });

    it('computes a day once for the ranges of one tick, unless the ingest marked it again after that', async () => {
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 1000),
        mark('2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', 1000),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);

      events.length = 0;
      ch.dirty = [
        mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', 1000),
        // marked again after the tick has begun: the day is done again
        mark('2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', Date.now() + 10_000),
      ];
      await ticks(service(), 1);
      expect(computed().filter((d) => d === '2026-05-02')).toHaveLength(2);
    });

    it('a day that fails is counted under amm_daily_dirty and does not keep the range: it is owed to the retries of amm_daily', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z')];
      failing.add('2026-05-01');
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily_dirty' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_daily_dirty'));

      // the job tries it again when its five minutes are over
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      events.length = 0;
      await svc.tick();
      expect(computed()).toContain('2026-05-01');
    });

    it('does not touch the days without the option', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service({ ammDaily: undefined }).tick();
      expect(compute).not.toHaveBeenCalled();
    });

    it('a day cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });

    it('starts no day once the shutdown began', async () => {
      // a slice from 22:00 to 03:00 covers two UTC days; the range after it is a third day
      ch.dirty = [
        mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z'),
        mark('2026-05-04T00:00:00Z', '2026-05-04T03:00:00Z', 2000),
      ];
      const svc = service();
      compute.mockImplementationOnce(async () => {
        void svc.stop();
        return 0;
      });
      await svc.tick();
      expect(compute).toHaveBeenCalledTimes(1);
      expect(ch.dirty).toHaveLength(2);
    });

    it('a mark that arrives while a day is being computed makes it be computed again', async () => {
      closedMs = 1000; // the day takes a second
      const begins = NOW_SECONDS * 1000;
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 500),
        // marked half a second into it
        mark('2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', begins + 500),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(2);
    });

    it('a mark made at the very ms the day began does not: the recompute saw it', async () => {
      closedMs = 1000;
      const begins = NOW_SECONDS * 1000;
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 500),
        mark('2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', begins),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);
    });
  });

  describe('the cadence is a whole number of ticks (at registration)', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses ammDailyEveryTicks = %p', (every) => {
      expect(() => service({ ammDailyEveryTicks: every })).toThrow(/every.*tick|ticks/i);
    });

    it('refuses an extra job that wants to run every 0 ticks, however it is written', () => {
      const job: AggregatorJob = { name: 'never', everyTicks: 0, run: async () => undefined };
      expect(() => service({ ammDaily: undefined, extraJobs: [job] })).toThrow(/never/);
    });

    it('accepts 1 and the default', () => {
      expect(() => service({ ammDailyEveryTicks: 1 })).not.toThrow();
      expect(() => service()).not.toThrow();
    });
  });

  describe('yesterday is not computed again once its set is final (Ruling R-A21); today is, at every run', () => {
    const behind = behindYesterday;

    it('computes both at the first run, and only today at the next ones', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(
        computed()
          .filter((d) => !isClosed(d))
          .sort(),
      ).toEqual(['2026-10-15', '2026-10-16']);
      events.length = 0;
      await ticks(svc, 3);
      expect(computed().filter((d) => !isClosed(d))).toEqual(['2026-10-16', '2026-10-16', '2026-10-16']);
    });

    it('asks which of the two is done in one read, for yesterday and the config version of the job', async () => {
      await service().tick();
      const [chArg, configVersion, days] = daysDone.mock.calls[0];
      expect([chArg, configVersion, (days as Date[]).map(day)]).toEqual([ch, AMM_DAILY_CONFIG_VERSION, ['2026-10-15']]);
    });

    it('computes it at every run while its set is not final (the ingest has not passed the day, or the set is of another config)', async () => {
      behind();
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 3);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(3);
    });

    it('computes it again once the ingest has passed the day by an hour, and then leaves it', async () => {
      behind();
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 2);
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-16T01:00:00Z')];
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(1); // the last time, now final
      events.length = 0;
      await ticks(svc, 2);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(0);
    });

    it('a read of the days done that fails is logged and counted, and yesterday is computed', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      daysDone.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('days done'));
    });

    it('a day that failed last time is still tried behind the other when both are due (R87)', async () => {
      behind();
      failing.add('2026-10-16');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      events.length = 0;
      failing.clear();
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
    });
  });

  describe('a run whose current days used the budget still moves the back-fill on (the progress floor)', () => {
    it('starts one closed day, the newest, at each run, and goes on at the next runs', async () => {
      currentMs = 5000; // today takes more than the 4 s of the job
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 3);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
    });

    it('says what is wanted, although the budget is spent: the log is the days to compute', async () => {
      currentMs = 5000;
      await service().tick();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill: 5 days to compute'));
    });

    it('goes through the budget check of the job after that day: said once, and the job counts as having hit its budget', async () => {
      currentMs = 5000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']); // only the one the floor allows
      logger.warn.mockClear();
      await ticks(svc, 1); // a streak of runs that hit the budget is said once
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
    });

    it('adds nothing when nothing is wanted: no activity, or every closed day done', async () => {
      currentMs = 5000;
      firstDay.mockResolvedValue(undefined);
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill'));

      events.length = 0;
      firstDay.mockResolvedValue(FIRST_ACTIVITY);
      for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) finalDays.add(d);
      await ticks(service(), 1);
      expect(computed().filter(isClosed)).toEqual([]);
    });

    it('a day that waits for its retry is not the one the floor starts: the next wanted day is', async () => {
      failing.add('2026-10-14');
      closedMs = 1500; // 10-14 fails, 10-13 and 10-12 work, and the budget is gone: 10-11 and 10-10 are left
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
      currentMs = 5000;
      closedMs = 0;
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual(['2026-10-11']); // 10-14 waits; the floor takes the next wanted day
    });
  });

  describe('a day that fails on the dirty path does not hold its range (Ruling R-A22)', () => {
    const MIDDLE = '2026-05-02';
    const volumeFunctions = () => ({
      computeLiveSet: jest.fn(async () => 0),
      computeDailySet: jest.fn(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`volume ${metric} ${day(d)}`);
        return 0;
      }),
      daysDone: jest.fn(async () => new Set<string>()),
      liveVersions: jest.fn(async () => new Map<string, number>()),
      dailyVersions: jest.fn(async () => new Map<string, number>()),
    });
    const poolFunctions = () => ({
      watermark: jest.fn(async () => 0),
      changedSince: jest.fn(async (_c: unknown, ledger: number) => ({ accounts: [], upTo: ledger })),
      poolsClosedIn: jest.fn(async () => ['rA']),
      recompute: jest.fn(async () => {
        events.push('pools rA');
        return 1;
      }),
    });
    const withEverything = (extra: AggregatorOptions = {}): AggregatorOptions => ({
      volumes: { rates: RATES, markets: MARKETS },
      volumeFunctions: volumeFunctions(),
      ammPools: { rates: RATES },
      ammPoolsFunctions: poolFunctions(),
      ...extra,
    });
    const range = (): void => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-04T00:00:00Z')];
    };

    it('counts it once, goes on with the later slices (stats, volumes, pools, days), and the range is done', async () => {
      range();
      failing.add(MIDDLE);
      await service(withEverything()).tick();
      for (const d of ['2026-05-01', '2026-05-02', '2026-05-03']) {
        // every slice, in order: its stats, its volumes (three metrics), its pools, its day
        const at = events.indexOf(`stats ${d}T00:00:00Z`);
        expect(at).toBeGreaterThan(-1);
        expect(events.slice(at, at + 6)).toEqual([
          `stats ${d}T00:00:00Z`,
          `volume trade_volume ${d}`,
          `volume payment_volume ${d}`,
          `volume amm_volume ${d}`,
          'pools rA',
          `amm_daily ${d}`,
        ]);
      }
      expect(ch.dirty).toEqual([]);
      const errors = metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job);
      expect(errors).toEqual(['amm_daily_dirty']);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`amm_daily_dirty failed for ${MIDDLE}`));
    });

    it('marks the day owed in the tables, right after the failure: a restart finds it in the back-fill (Ruling R-A27)', async () => {
      range();
      failing.add(MIDDLE);
      await service(withEverything()).tick();
      expect(markOwed).toHaveBeenCalledTimes(1);
      expect(markOwed).toHaveBeenCalledWith(ch, new Date(`${MIDDLE}T00:00:00Z`));
      expect(events.indexOf(`owed ${MIDDLE}`)).toBe(events.indexOf(`amm_daily ${MIDDLE}`) + 1);
      // the days that worked are not marked
      expect(events.filter((e) => e.startsWith('owed'))).toEqual([`owed ${MIDDLE}`]);
    });

    it('a mark that fails is counted and logged too, and the slice and its range still go on', async () => {
      range();
      failing.add(MIDDLE);
      markOwed.mockRejectedValueOnce(new Error('DB::Exception: read-only'));
      await service(withEverything()).tick();
      expect(ch.dirty).toEqual([]);
      const errors = metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job);
      expect(errors).toEqual(['amm_daily_dirty', 'amm_daily_dirty']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `amm_daily_dirty failed marking ${MIDDLE} owed in the tables: DB::Exception: read-only`,
        ),
      );
      expect(computed().filter((d) => d.startsWith('2026-05'))).toEqual(['2026-05-01', MIDDLE, '2026-05-03']);
    });

    it('a day cut short by the shutdown is not marked owed either', async () => {
      range();
      compute.mockImplementation(async (_ch: unknown, _rates: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        const svc = created[created.length - 1];
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await service().tick();
      expect(markOwed).not.toHaveBeenCalled();
    });

    it('does not do the stats of the slice again at the next tick: the range is gone', async () => {
      range();
      failing.add(MIDDLE);
      const svc = service({ ammDailyEveryTicks: 1000 });
      await svc.tick();
      events.length = 0;
      await svc.tick();
      expect(events.filter((e) => e.startsWith('stats 2026-05'))).toEqual([]);
    });

    it('a day that fails in two ranges of one tick is tried once', async () => {
      ch.dirty = [
        mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', 1000),
        mark('2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', 1001),
      ];
      failing.add(MIDDLE);
      await service({ ammDailyEveryTicks: 1000 }).tick();
      expect(computed().filter((d) => d === MIDDLE)).toHaveLength(1);
      expect(ch.dirty).toEqual([]);
    });

    describe('and is tried again by the amm_daily job, on the back-off of the closed days', () => {
      const run = async (svc: AggregatorService, offsetMs: number): Promise<string[]> => {
        jest.setSystemTime(NOW_SECONDS * 1000 + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().filter((d) => d === MIDDLE);
      };

      it('after 5 minutes, then 10, 20, ... up to an hour, until it works', async () => {
        range();
        failing.add(MIDDLE);
        const svc = service({ ammDailyEveryTicks: 1 });
        expect(await run(svc, 0)).toHaveLength(1); // the dirty path
        const minute = 60_000;
        let at = 0;
        for (const wait of [5, 10, 20, 40, 60, 60]) {
          expect(await run(svc, at + wait * minute - 1000)).toEqual([]); // not due
          at += wait * minute;
          expect(await run(svc, at)).toHaveLength(1); // due, and fails again
        }
        failing.clear();
        at += 60 * minute;
        expect(await run(svc, at)).toHaveLength(1);
        expect(await run(svc, at + 61 * minute)).toEqual([]); // it worked: forgotten
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      });

      it('and forgets it when the day is computed some other way before', async () => {
        range();
        failing.add(MIDDLE);
        const svc = service({ ammDailyEveryTicks: 1 });
        await run(svc, 0);
        failing.clear();
        // the ingest marks the day again: the dirty path computes it, and it works
        ch.dirty = [mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', NOW_SECONDS * 1000 + 100_000)];
        expect(await run(svc, 120_000)).toHaveLength(1);
        expect(await run(svc, 6 * 60_000)).toEqual([]); // past the five minutes: nothing is owed any more
      });

      it('the one that has failed fewer times first (R87), whichever is due longer', async () => {
        const minute = 60_000;
        const svc = service({ ammDailyEveryTicks: 1 });
        failing.add('2026-05-01');
        failing.add('2026-05-02');
        // 05-01 fails on the dirty path at 0, and again at 5 minutes (a wait of 10: due at 15)
        ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')];
        await run(svc, 0);
        await run(svc, 5 * minute);
        // 05-02 fails on the dirty path at 12 minutes (a wait of 5: due at 17)
        ch.dirty = [mark('2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z', NOW_SECONDS * 1000 + 12 * minute - 1000)];
        await run(svc, 12 * minute);
        // at 18 both are due; 05-01 has been due longer, but it has failed twice
        events.length = 0;
        jest.setSystemTime(NOW_SECONDS * 1000 + 18 * minute);
        await svc.tick();
        expect(computed().filter((d) => d.startsWith('2026-05'))).toEqual(['2026-05-02', '2026-05-01']);
      });

      it('one day per budget: a day that takes the whole budget leaves the next to the next run', async () => {
        ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z')];
        failing.add('2026-05-01');
        failing.add('2026-05-02');
        const svc = service({ ammDailyEveryTicks: 1, budgetsMs: { amm_daily: 1000 } });
        await run(svc, 0);
        failing.clear();
        closedMs = 1500;
        events.length = 0;
        jest.setSystemTime(NOW_SECONDS * 1000 + 6 * 60_000);
        await svc.tick();
        expect(computed().filter((d) => d.startsWith('2026-05'))).toHaveLength(1);
      });
    });

    it('a closed day that is owed is not taken by the back-fill as well: the retries of the job have it', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12'); // it fails on the dirty path, and is not final: the back-fill wants it too
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-12')).toHaveLength(1); // the dirty path only
      expect(computed().filter(isClosed).sort()).toEqual([
        '2026-10-10',
        '2026-10-11',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
      ]);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done')); // a day is owed
      // when its wait is over it is the retries that try it
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      events.length = 0;
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-12')).toHaveLength(1);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
    });

    it('an owed day that the job computes with the current days is forgotten, and not tried a second time in that run', async () => {
      ch.dirty = [mark('2026-10-16T00:00:00Z', '2026-10-16T05:00:00Z')];
      failing.add('2026-10-16'); // today fails on the dirty path, and then in the loop of the job
      const svc = service({ ammDailyEveryTicks: 1 });
      const memory = (svc as unknown as { ammDaily: { backoff: Map<string, unknown> } }).ammDaily.backoff;
      await svc.tick();
      expect([...memory.keys()]).toEqual(['2026-10-16']);
      // its five minutes are over, and it still fails: the loop of the job tries it, and the retries do not try it again
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      // it works: the loop forgets it
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS + 1000);
      await svc.tick();
      expect(memory.size).toBe(0);
    });

    it('a day that fails on the dirty path again while it waits waits twice as long (the wait is not set afresh)', async () => {
      const minute = 60_000;
      failing.add('2026-05-01');
      const svc = service({ ammDailyEveryTicks: 1 });
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')];
      await svc.tick(); // fails: due in 5 minutes
      // marked again a minute later, and fails again: due in 10 more minutes (at 11), not in 5 (at 6)
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', NOW_SECONDS * 1000 + minute - 100)];
      jest.setSystemTime(NOW_SECONDS * 1000 + minute);
      await svc.tick();
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + 7 * minute);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-05-01')).toEqual([]);
      jest.setSystemTime(NOW_SECONDS * 1000 + 11 * minute);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);
    });

    it('when the budget is spent, the floor of the run takes a due owed day, and that is the only day of the floor (Ruling R-A23)', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12'); // owed
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      // the closed days after it are wanted again, and the owed day is due, with the budget gone
      for (const d of ['2026-10-14', '2026-10-13']) finalDays.delete(d);
      failing.clear();
      currentMs = 5000;
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-12']); // not 2026-10-14 as well
      // the next run has no owed day: the floor takes the newest wanted closed day
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS + 60_000);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']);
    });

    it('an owed day that is due and the budget not spent: it is tried with the others, and the back-fill has no floor of its own', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12');
      const svc = service({ ammDailyEveryTicks: 1, budgetsMs: { amm_daily: 1500 } });
      await svc.tick();
      for (const d of ['2026-10-14', '2026-10-13']) finalDays.delete(d);
      failing.clear();
      currentMs = 1000; // today takes 1 s of the 1.5 s: the owed day starts within the budget, takes 1 s, and the budget is spent
      closedMs = 1000;
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-12']);
    });

    it('a day cut short by the shutdown is not owed: it stays in its range as before', async () => {
      range();
      const svc = service({ ammDailyEveryTicks: 1 });
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect((svc as unknown as { ammDaily: { backoff: Map<string, unknown> } }).ammDaily.backoff.size).toBe(0);
    });
  });

  describe('the back-off of a closed day (as the volume back-fill)', () => {
    const backoffOf = (svc: AggregatorService): Map<string, unknown> =>
      (svc as unknown as { ammDaily: { backoff: Map<string, unknown> } }).ammDaily.backoff;

    it('is forgotten when the day is no longer wanted (something else made its set final)', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect([...backoffOf(svc).keys()]).toEqual(['2026-10-14']);
      failing.clear();
      finalDays.add('2026-10-14'); // another process, or the retries of a dirty range, did it
      await ticks(svc, 1);
      expect(backoffOf(svc).size).toBe(0);
    });

    it('is forgotten as soon as the day works, not at the run after', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect([...backoffOf(svc).keys()]).toEqual(['2026-10-14']);
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed()).toContain('2026-10-14');
      expect(backoffOf(svc).size).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun', async () => {
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [compute, daysDone, versions, firstDay]) expect(fn).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the day in flight and starts no day after it', async () => {
      let signalOfDay: AbortSignal | undefined;
      let release!: () => void;
      compute.mockImplementationOnce(
        (_c: unknown, _r: unknown, _d: Date, options?: { signal?: AbortSignal }) =>
          new Promise<number>((resolve) => {
            signalOfDay = options?.signal;
            release = () => resolve(0);
          }),
      );
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(signalOfDay?.aborted).toBe(false);

      const stopping = svc.stop();
      expect(signalOfDay?.aborted).toBe(true);
      release();
      await stopping;
      expect(compute).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('the floor day of the back-fill does not start once the shutdown has begun (parked 7)', async () => {
      const svc = service();
      // the shutdown begins while the back-fill reads where to start
      firstDay.mockImplementation(async () => {
        void svc.stop();
        return FIRST_ACTIVITY;
      });
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual([]);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('Dropped'));
    });

    it('nor does the first owed day, when the shutdown began during the days before it (parked 7)', async () => {
      // 2026-05-02 fails on the dirty path at the first tick, and is due five minutes later
      ch.dirty = [mark('2026-05-02T00:00:00Z', '2026-05-02T03:00:00Z')];
      failing.add('2026-05-02');
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      // the shutdown begins during today's set
      compute.mockImplementation(async (_ch: unknown, _rates: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        void svc.stop();
        return 0;
      });
      events.length = 0;
      await svc.tick();
      expect(computed()).toEqual(['2026-10-16']);
    });

    it('a day that was aborted at shutdown is neither an error nor counted', async () => {
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
  });

  describe('a day whose set takes longer than the budget of the job is warned about (Ruling R-A25)', () => {
    const overran = (): string[] =>
      logger.warn.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('more than the budget'));

    it('today: the set of one day is never cut, so the run went on that much longer than its budget', async () => {
      currentMs = AGGREGATOR_AMM_DAILY_BUDGET_MS + 500;
      await service().tick();
      expect(overran()).toEqual([
        `Aggregator job amm_daily: the set of 2026-10-16 took ${AGGREGATOR_AMM_DAILY_BUDGET_MS + 500} ms, more than the budget of amm_daily (${AGGREGATOR_AMM_DAILY_BUDGET_MS} ms): a day is never cut, so the tick ran that much longer`,
      ]);
    });

    it('not a day that takes the budget and no more', async () => {
      currentMs = AGGREGATOR_AMM_DAILY_BUDGET_MS;
      closedMs = AGGREGATOR_AMM_DAILY_BUDGET_MS;
      await service().tick();
      expect(computed().length).toBeGreaterThan(0);
      expect(overran()).toEqual([]);
    });

    it('a closed day of the back-fill, and a day of an agg_dirty slice (under its own job name), alike', async () => {
      closedMs = AGGREGATOR_AMM_DAILY_BUDGET_MS + 1;
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      expect(overran()).toEqual([
        expect.stringMatching(
          /^Aggregator job amm_daily_dirty: the set of 2026-05-01 took 4001 ms, more than the budget/,
        ),
        expect.stringMatching(/^Aggregator job amm_daily: the set of 2026-10-14 took 4001 ms, more than the budget/),
      ]);
    });

    it('also when the day fails after that long', async () => {
      currentMs = AGGREGATOR_AMM_DAILY_BUDGET_MS + 1;
      failing.add('2026-10-16');
      await service().tick();
      expect(overran()).toEqual([expect.stringContaining('the set of 2026-10-16 took 4001 ms')]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
    });
  });
});

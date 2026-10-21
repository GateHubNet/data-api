import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  AggregateSetAborted,
  ClickHouseService,
  LATEST_DAYS,
  MarketsConfig,
  RatesService,
  RollupState,
  Table,
} from '@gatehub/data-api-shared';
import { DAY, HOUR, iso, NOW, unix } from '../../test/aggregate-job-fakes';
import { AggregateFunctions } from './aggregate-job-deps';
import {
  AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS,
  AGGREGATOR_MARKETS_LIVE_BUDGET_MS,
  AGGREGATOR_PAIR_HOURLY_BUDGET_MS,
  AGGREGATOR_RATES_DAILY_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AGGREGATOR_TICK_BUDGET_MS,
  AggregatorOptions,
  AggregatorService,
  AmmDailyFunctions,
  AmmPoolsFunctions,
} from './aggregator.service';

/**
 * The order of a tick with the account and market jobs registered (and the AMM jobs), and what that order is for: the live
 * volume jobs are not starved, whatever the jobs after them are doing. The shared functions of the jobs, the volume
 * functions and the database are fakes; the services, the runners and their hooks in `agg_dirty` are the real ones.
 */

const NOW_SECONDS = NOW.getTime() / 1000;
const NOW_MS = NOW.getTime();
const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };

/** The jobs of a tick, in order, when every one is registered. */
const EVERY_JOB = [
  'volume_live',
  'volume_daily',
  'amm_pools',
  'pair_hourly',
  'markets_live',
  'stats_live',
  'stats_dirty',
  'amm_daily',
  'rates_daily',
  'account_rollups',
  'volume_backfill',
];

/** The jobs of D2 (the account and market jobs). */
const D2_JOBS = ['pair_hourly', 'markets_live', 'rates_daily', 'account_rollups'];

/** The range of `agg_dirty` of the tests of the hooks: two hours of a day inside the last 31 days. */
const DIRTY_FROM = '2026-10-14T20:00:00Z';
const DIRTY_TO = '2026-10-14T22:00:00Z';
const DIRTY_WHERE = ' in 2026-10-14T20:00:00Z - 2026-10-14T22:00:00Z';

interface DirtyRow {
  from: number;
  to: number;
  /** Milliseconds. */
  created: number;
}

/**
 * The database of the service itself (`stats_live`, `stats_dirty` and the ledgers the back-fill reads), with the semantics of
 * the real tables where they matter: the `agg_dirty` queue reads the newest row of a key, oldest first; the DELETE takes a key
 * and `created_at <= created`; the INSERT adds a row.
 */
class FakeClickHouse {
  watermark?: number;
  /** The close times of the ledgers, ascending. */
  closes: number[] = [];
  dirty: DirtyRow[] = [];

  query = jest.fn(async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    if (sql.includes(`FROM ${Table.StatsHourly}`)) {
      if (this.watermark === undefined || this.watermark >= Number(params.before)) return [];
      return [{ hour_start: this.watermark, ledger_count: 1 }];
    }
    if (sql.includes(`FROM ${Table.Ledgers}`)) {
      if (sql.includes('DESC'))
        return this.closes.length === 0 ? [] : [{ closed: this.closes[this.closes.length - 1] }];
      const found = sql.includes('close_time >=') ? this.closes.find((c) => c >= Number(params.from)) : this.closes[0];
      return found === undefined ? [] : [{ closed: found }];
    }
    if (sql.includes(`FROM ${Table.AggDirty}`)) {
      const newest = new Map<string, DirtyRow>();
      for (const row of this.dirty) {
        const key = `${row.from}-${row.to}`;
        const seen = newest.get(key);
        if (!seen || row.created > seen.created) newest.set(key, row);
      }
      return [...newest.values()]
        .sort((a, b) => a.created - b.created || a.from - b.from || a.to - b.to)
        .slice(0, Number(params.limit))
        .map((r) => ({ from_hour: r.from, to_hour: r.to, created_ms: r.created }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  async queryOne(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.query(sql, params))[0];
  }

  command = jest.fn(async (sql: string, params: Record<string, unknown> = {}): Promise<void> => {
    if (sql.startsWith(`DELETE FROM ${Table.AggDirty}`)) {
      this.dirty = this.dirty.filter(
        (r) => !(r.from === params.from && r.to === params.to && r.created <= Number(params.created)),
      );
    } else if (sql.startsWith(`INSERT INTO ${Table.AggDirty}`)) {
      this.dirty.push({ from: Number(params.from), to: Number(params.to), created: Number(params.created) });
    } else {
      throw new Error(`unexpected command: ${sql}`);
    }
  });

  asService(): ClickHouseService {
    return this as unknown as ClickHouseService;
  }
}

/**
 * The shared functions of the four account and market jobs, as their runners call them. By default the world is quiet: the
 * first ledger is the newest one, so there is no hour, day or partition to back-fill, and each job has its few sets of every
 * tick and no more. `busy()` gives every job far more to do than its budget lets it. Each call is noted as `<kind> <detail>`;
 * the sets (`pair_hourly`, `markets_live`, `rates_daily` days, the slices of partition recounts: `account_rollups_recount`)
 * take `setMs` of the fake clock. A test makes a kind fail, or abort as a shutdown does, by naming it in `throwOn` (the
 * function says for which call).
 */
class D2World {
  setMs = 0;
  newest = NOW_SECONDS - 3;
  firstLedger = NOW_SECONDS - 3;
  /** The day of the first trade against the native currency; the newest final day is the 15th, so there is no day to compute. */
  firstTradeDay = '2026-10-16';
  /** The ledgers of the account rollups' partitions (`RatesService.ledgersClosedIn`); none: no partition. */
  ledgers: { min: number; max: number } | null = null;
  states = new Map<string, RollupState>();
  throwOn = new Map<string, (detail: string) => Error | undefined>();

  constructor(private readonly note: (event: string) => void) {}

  /** Ten partitions to recount, 31 days of hours without a set, and 288 days without rates. */
  busy(setMs: number): void {
    this.setMs = setMs;
    this.firstLedger = unix('2026-01-01T00:00:00Z');
    this.firstTradeDay = '2026-01-01';
    this.ledgers = { min: 0, max: 99_999_999 };
  }

  private call(kind: string, detail: string, takes = false): void {
    this.note(`${kind} ${detail}`);
    if (takes && this.setMs > 0) jest.setSystemTime(Date.now() + this.setMs);
    const error = this.throwOn.get(kind)?.(detail);
    if (error) throw error;
  }

  fns(): Partial<AggregateFunctions> {
    return {
      newestLedgerClose: async () => this.newest,
      firstLedgerClose: async () => this.firstLedger,
      pairHourSets: async () => new Map(),
      computePairHourSets: async (_ch, _rates, from, to) => {
        this.call('pair_hourly', `${iso(from)} ${iso(to)}`, true);
        return (to - from) / HOUR;
      },
      computeMarketsSet: async (_ch, _native, period) => {
        this.call('markets_live', period, true);
        return { written: true, pairs: 1, startTime: this.newest - DAY, endTime: this.newest, ammShareKnown: true };
      },
      marketsSetEndTimes: async () => new Map(),
      firstNativeTradeDay: async () => this.firstTradeDay,
      validRateDays: async () => new Map(),
      computeRatesDailySet: async (_ch, _rates, day) => {
        this.call('rates_daily', day.toISOString().slice(0, 10), true);
        return 1;
      },
      markRatesStale: async (_ch, days) => {
        this.call('rates_daily_mark', `${days[0]}..${days[days.length - 1]}`);
        return days.length;
      },
      // which days rates_daily defers for the ranges of agg_dirty is its own spec's: here it defers none
      dirtyDaySpans: async () => [],
      partitionSetVersions: async () => new Map(),
      countPartitionSlice: async (_ch, partition, slice) => {
        this.call('account_rollups_recount', `${partition}/${slice}`, true);
        return [];
      },
      writePartitionSet: async (_ch, partition) => {
        this.call('account_rollups_partition_set', String(partition));
        return 0;
      },
      heavyAccounts: async () => new Map(),
      rollupStates: async () => new Map(this.states),
      writeRollupStates: async () => undefined,
      writeAccountRollups: async (_ch, _ranges, accounts, from) => {
        this.call('account_rollups', `${accounts.join(',')} ${from}`);
        return 1;
      },
    };
  }
}

/**
 * The functions of the AMM jobs, quiet: no pool has changed or is in a slice, and no pool was ever active, so `amm_pools`
 * rebuilds nothing and `amm_daily` writes the empty sets of today and yesterday (and of the days of a slice). Each set of
 * `amm_daily` is noted as `amm_daily <day>` and takes no time.
 */
function quietAmm(note: (event: string) => void): {
  pools: Partial<AmmPoolsFunctions>;
  daily: Partial<AmmDailyFunctions>;
} {
  return {
    pools: {
      watermark: async () => 0,
      changedSince: async (_ch, ledger) => ({ accounts: [], upTo: ledger }),
      poolsClosedIn: async () => [],
      recompute: async () => 0,
    },
    daily: {
      compute: async (_ch, _rates, day) => {
        note(`amm_daily ${day.toISOString().slice(0, 10)}`);
        return 0;
      },
      daysDone: async () => new Set<string>(),
      versions: async () => new Map<string, number>(),
      firstDay: async () => undefined,
      markOwed: async () => undefined,
    },
  };
}

describe('the schedule of the aggregator with the account and market jobs', () => {
  let ch: FakeClickHouse;
  let world: D2World;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let metrics: Record<
    | 'aggregatorRunsTotal'
    | 'aggregatorErrorsTotal'
    | 'aggregatorStatsLagSeconds'
    | 'pairHourlyMissingHours'
    | 'marketsLiveAgeSeconds'
    | 'ratesDailyMissingDays'
    | 'accountRollupsHeavyAccounts'
    | 'accountRollupsPendingAccounts',
    { inc: jest.Mock; set: jest.Mock }
  >;
  const created: AggregatorService[] = [];
  /** What the fakes were asked, in order, and when (the fake clock, ms). */
  let log: Array<{ event: string; at: number }>;
  /** How long a slice of `stats_live` or of `stats_dirty` takes (fake ms). */
  let statsMs: number;
  let recompute: jest.Mock;
  const rates = {
    nativeCurrency: 'XRP',
    ledgersClosedIn: async () => world.ledgers,
  } as unknown as RatesService;

  const note = (event: string): void => {
    log.push({ event, at: Date.now() });
  };
  const events = (): string[] => log.map((entry) => entry.event);
  /** The jobs that finished, in order of the runs counted. */
  const runs = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const count = (prefix: string): number => events().filter((event) => event.startsWith(prefix)).length;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    log = [];
    statsMs = 0;
    world = new D2World(note);
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn(), set: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn(), set: jest.fn() },
      aggregatorStatsLagSeconds: { inc: jest.fn(), set: jest.fn() },
      pairHourlyMissingHours: { inc: jest.fn(), set: jest.fn() },
      marketsLiveAgeSeconds: { inc: jest.fn(), set: jest.fn() },
      ratesDailyMissingDays: { inc: jest.fn(), set: jest.fn() },
      accountRollupsHeavyAccounts: { inc: jest.fn(), set: jest.fn() },
      accountRollupsPendingAccounts: { inc: jest.fn(), set: jest.fn() },
    };
    recompute = jest.fn(async (_ch: unknown, from: Date, to: Date) => {
      const f = from.getTime() / 1000;
      const t = to.getTime() / 1000;
      note(`stats ${iso(f)}`);
      if (statsMs > 0) jest.setSystemTime(Date.now() + statsMs);
      const hours = [...new Set(ch.closes.filter((c) => c >= f && c < t).map((c) => Math.floor(c / HOUR) * HOUR))];
      if (hours.length > 0) ch.watermark = Math.max(ch.watermark ?? 0, ...hours);
      return hours.length;
    });
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  /** A service with every job registered; the volume sets, the AMM sets and the account and market sets are the fakes above. */
  function service(options: AggregatorOptions = {}): AggregatorService {
    const amm = quietAmm(note);
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute,
      volumes: { rates, markets: MARKETS },
      volumeFunctions: {
        computeLiveSet: async (_ch, _rates, _markets, metric, period) => {
          note(`live ${metric} ${period}`);
          return 0;
        },
        computeDailySet: async (_ch, _rates, _markets, metric, day) => {
          note(`daily ${metric} ${day.toISOString().slice(0, 10)}`);
          return 0;
        },
        daysDone: async () => new Set(),
        liveVersions: async () => new Map(),
        dailyVersions: async () => new Map(),
      },
      ammPools: { rates },
      ammPoolsFunctions: amm.pools,
      ammDaily: { rates },
      ammDailyFunctions: amm.daily,
      // amm_daily at every tick, so that every tick of a test has every job
      ammDailyEveryTicks: 1,
      aggregates: { rates, accountRollupMinRows: 1_000_000 },
      aggregateFunctions: world.fns(),
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** The stats are up to date: the live window is the last slice only. */
  const caughtUp = (): void => {
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  };
  const markRange = (from = DIRTY_FROM, to = DIRTY_TO, created = 1000): void => {
    ch.dirty.push({ from: unix(from), to: unix(to), created });
  };
  /** The state of an account whose rollups cover the days of the range of the tests of the hooks. */
  const rolledAccount = (): void => {
    world.states.set('rAccount', {
      account: 'rAccount',
      rows: 2_000_000,
      firstDay: '2026-01-01',
      rolledFrom: '2026-10-01',
      rolledThrough: '2026-10-15',
      configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
    });
  };

  it('the jobs of a tick are volume_live, volume_daily, amm_pools, pair_hourly, markets_live, stats_live, stats_dirty, amm_daily, rates_daily, account_rollups, volume_backfill', async () => {
    caughtUp();
    await service().tick();
    expect(runs()).toEqual(EVERY_JOB);
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    // the account and market jobs sit where the volume jobs and the stats leave them: after the volume sets, before and
    // after the stats
    const at = (prefix: string): number => events().findIndex((event) => event.startsWith(prefix));
    expect(at('daily')).toBeLessThan(at('pair_hourly'));
    expect(at('markets_live')).toBeLessThan(at('stats'));
    // and amm_daily after the stats (its quiet sets of today and yesterday)
    expect(at('stats')).toBeLessThan(at('amm_daily'));
  });

  it('the account and market jobs keep their places without the volume jobs, and the volume jobs theirs without them', async () => {
    caughtUp();
    await service({ volumes: undefined }).tick();
    expect(runs()).toEqual([
      'amm_pools',
      'pair_hourly',
      'markets_live',
      'stats_live',
      'stats_dirty',
      'amm_daily',
      'rates_daily',
      'account_rollups',
    ]);
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ aggregates: undefined }).tick();
    expect(runs()).toEqual([
      'volume_live',
      'volume_daily',
      'amm_pools',
      'stats_live',
      'stats_dirty',
      'amm_daily',
      'volume_backfill',
    ]);
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ ammPools: undefined, ammDaily: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => !job.startsWith('amm_')));
  });

  it('every D2 job has a budget of its own, and budgetsMs changes it', async () => {
    expect([
      AGGREGATOR_PAIR_HOURLY_BUDGET_MS,
      AGGREGATOR_MARKETS_LIVE_BUDGET_MS,
      AGGREGATOR_RATES_DAILY_BUDGET_MS,
      AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS,
    ]).toEqual([3000, 3000, 8000, 8000]);

    caughtUp();
    world.busy(1000);
    await service({
      budgetsMs: { pair_hourly: 5500, markets_live: 1500, rates_daily: 1500, account_rollups: 2500 },
    }).tick();
    // a set at a time while the budget of the job is not spent: 1 s a set (a slice of a recount, for account_rollups)
    expect(count('pair_hourly')).toBe(6);
    expect(count('markets_live')).toBe(2);
    expect(count('rates_daily ')).toBe(2);
    expect(count('account_rollups_recount')).toBe(3);

    log.length = 0;
    jest.setSystemTime(NOW);
    await service().tick();
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);
    expect(count('rates_daily ')).toBe(AGGREGATOR_RATES_DAILY_BUDGET_MS / 1000);
    expect(count('account_rollups_recount')).toBe(AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS / 1000);
  });

  it('with every job registered and every D2 job using its whole budget, volume_live and volume_daily run first and finish in every one of 10 ticks, and a tick ends within AGGREGATOR_TICK_BUDGET_MS plus one set', async () => {
    // The most any tick can be asked for: 230 days of stats to catch up and 30 ranges of agg_dirty to drain, 4 s a slice, and
    // every D2 job with far more to do than its budget (1 s a set). The longest set is the slice of the stats.
    const SLICE_MS = 4000;
    statsMs = SLICE_MS;
    world.busy(1000);
    ch.watermark = unix('2026-03-01T00:00:00Z');
    ch.closes = Array.from({ length: 230 }, (_, i) => unix('2026-03-01T00:30:00Z') + i * DAY);
    ch.closes.push(NOW_SECONDS - 3);
    for (let i = 0; i < 30; i++) {
      ch.dirty.push({
        from: unix('2026-01-01T00:00:00Z') + i * DAY,
        to: unix('2026-01-02T00:00:00Z') + i * DAY,
        created: 1000 + i,
      });
    }
    const svc = service();

    for (let tickNo = 0; tickNo < 10; tickNo++) {
      const tickStart = NOW_MS + tickNo * 60_000;
      jest.setSystemTime(tickStart);
      log.length = 0;
      metrics.aggregatorRunsTotal.inc.mockClear();
      await svc.tick();

      // the twelve live sets and the six daily ones (amm_volume among them) are the first things the tick does, at its very start
      const first = log.slice(0, 18);
      expect(first.map((entry) => entry.event.split(' ')[0])).toEqual([
        ...Array(12).fill('live'),
        ...Array(6).fill('daily'),
      ]);
      expect(first.every((entry) => entry.at === tickStart)).toBe(true);
      // they finished (a run is counted when the job ends without throwing), and so did every job after them
      expect(runs()).toEqual(EVERY_JOB);
      // the jobs before the stats got their budgets, and the one with a set of its own guarantee got that
      expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);
      expect(count('markets_live')).toBeGreaterThanOrEqual(1);
      expect(count('rates_daily ')).toBeGreaterThanOrEqual(1);
      // the tick used its budget, and ended within it and the set in flight
      const took = Date.now() - tickStart;
      expect(took).toBeGreaterThanOrEqual(AGGREGATOR_TICK_BUDGET_MS);
      expect(took).toBeLessThanOrEqual(AGGREGATOR_TICK_BUDGET_MS + SLICE_MS);
    }
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    // the sweeps are what ran long: neither is over
    expect(ch.dirty.length).toBeGreaterThan(0);
    expect(ch.watermark).toBeLessThan(unix('2026-10-01T00:00:00Z'));
  });

  describe('a slice of agg_dirty runs the hooks of rates_daily, pair_hourly and account_rollups after its volume sets; a failing hook is failed("<job>_dirty", …), fails the slice and keeps the range', () => {
    const HOOKS = {
      rates_daily: `rates_daily_mark 2026-10-14..2026-10-${14 + LATEST_DAYS}`,
      pair_hourly: `pair_hourly ${DIRTY_FROM} ${DIRTY_TO}`,
      account_rollups: 'account_rollups rAccount 2026-10-14',
    } as const;

    it('runs them in this order, once the stats and the volumes of the slice are done, and then removes the range', async () => {
      caughtUp();
      markRange();
      rolledAccount();
      await service().tick();
      const at = events().indexOf(`stats ${DIRTY_FROM}`);
      // the volume sets of the slice's day, then the hooks of the AMM jobs (amm_pools finds no pool in the slice; the day's
      // amm_daily set), then D2's
      expect(events().slice(at, at + 8)).toEqual([
        `stats ${DIRTY_FROM}`,
        'daily trade_volume 2026-10-14',
        'daily payment_volume 2026-10-14',
        'daily amm_volume 2026-10-14',
        'amm_daily 2026-10-14',
        HOOKS.rates_daily,
        HOOKS.pair_hourly,
        HOOKS.account_rollups,
      ]);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('hands the created mark of the range to the account_rollups hook: ranges of one day, marked before the first roll, roll it once, and one marked after the roll began rolls it again', async () => {
      caughtUp();
      rolledAccount();
      const rolls = (): number => events().filter((event) => event === HOOKS.account_rollups).length;
      // two ranges of the 14th (their ingest chunks), both marked before the tick: one roll of the day answers both
      markRange('2026-10-14T20:00:00Z', '2026-10-14T21:00:00Z', 1000);
      markRange('2026-10-14T21:00:00Z', '2026-10-14T22:00:00Z', 1001);
      const svc = service();
      await svc.tick();
      expect(rolls()).toBe(1);
      expect(ch.dirty).toEqual([]);

      // the roll of the 14th began at the clock reading of the first tick: a range marked before it (NOW_MS - 1) needs no roll,
      // one marked after it (the ingest wrote more ledgers into the day meanwhile) rolls the day again
      log.length = 0;
      markRange('2026-10-14T22:00:00Z', '2026-10-14T23:00:00Z', NOW_MS - 1);
      markRange('2026-10-14T23:00:00Z', '2026-10-15T00:00:00Z', NOW_MS + 5000);
      await svc.tick();
      expect(rolls()).toBe(1);
      expect(ch.dirty).toEqual([]);
    });

    it.each(['rates_daily', 'pair_hourly', 'account_rollups'] as const)(
      'a failing %s hook is counted and logged as <job>_dirty, the hooks after it are not run, the range stays, and the next tick does it again',
      async (job) => {
        caughtUp();
        markRange();
        rolledAccount();
        const kind = {
          rates_daily: 'rates_daily_mark',
          pair_hourly: 'pair_hourly',
          account_rollups: 'account_rollups',
        }[job];
        // only the call of the slice fails (the job `pair_hourly` computes the current hour, not these)
        world.throwOn.set(kind, (detail) => (detail.includes('2026-10-14') ? new Error('memory limit') : undefined));
        const svc = service();
        await svc.tick();

        expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: `${job}_dirty` }]]);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(`Aggregator job ${job}_dirty failed${DIRTY_WHERE}: memory limit`);
        const order = ['rates_daily', 'pair_hourly', 'account_rollups'] as const;
        for (const [i, hook] of order.entries()) {
          expect(events().includes(HOOKS[hook])).toBe(i <= order.indexOf(job));
        }
        // the slice failed: the range is still there (nothing of it was done: it is not narrowed either)
        expect(ch.dirty).toEqual([{ from: unix(DIRTY_FROM), to: unix(DIRTY_TO), created: 1000 }]);
        // and the jobs of the tick that come after stats_dirty were not kept from running
        expect(runs()).toEqual(EVERY_JOB);

        world.throwOn.clear();
        metrics.aggregatorErrorsTotal.inc.mockClear();
        await svc.tick();
        expect(ch.dirty).toEqual([]);
        expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      },
    );

    it('a hook that fails in the second slice of a range keeps the progress of the first: the range is narrowed to it', async () => {
      caughtUp();
      markRange('2026-10-13T12:00:00Z', '2026-10-14T18:00:00Z');
      // slices [13th 12:00, 14th 12:00) and [14th 12:00, 14th 18:00): the days of the second start at the 14th
      world.throwOn.set('rates_daily_mark', (detail) =>
        detail.startsWith('2026-10-14') ? new Error('memory limit') : undefined,
      );
      await service().tick();
      expect(logger.error).toHaveBeenCalledWith(
        'Aggregator job rates_daily_dirty failed in 2026-10-14T12:00:00Z - 2026-10-14T18:00:00Z: memory limit',
      );
      expect(ch.dirty).toEqual([
        { from: unix('2026-10-14T12:00:00Z'), to: unix('2026-10-14T18:00:00Z'), created: 1000 },
      ]);
    });
  });

  describe('a D2 set cut short at shutdown (AggregateSetAborted) is neither an error nor counted', () => {
    /** The sets and the hooks that can be cut short, and what has to be set up for them to run: `busy` jobs, or a range. */
    const CASES: Array<{ what: string; kind: string; setup: 'busy' | 'range' }> = [
      { what: 'a pair_hourly set', kind: 'pair_hourly', setup: 'busy' },
      { what: 'a markets_live set', kind: 'markets_live', setup: 'busy' },
      { what: 'a rates_daily day', kind: 'rates_daily', setup: 'busy' },
      { what: 'an account_rollups partition', kind: 'account_rollups_recount', setup: 'busy' },
      { what: 'the rates_daily hook of a slice', kind: 'rates_daily_mark', setup: 'range' },
      { what: 'the pair_hourly hook of a slice', kind: 'pair_hourly', setup: 'range' },
      { what: 'the account_rollups hook of a slice', kind: 'account_rollups', setup: 'range' },
    ];

    it.each(CASES)('$what', async ({ kind, setup }) => {
      caughtUp();
      if (setup === 'busy') {
        world.busy(0);
      } else {
        markRange();
        rolledAccount();
      }
      const svc = service();
      // the shutdown begins while the set is being made, and the set refuses to write
      world.throwOn.set(kind, (detail) => {
        if (setup === 'range' && !detail.includes('2026-10-14')) return undefined;
        void svc.stop();
        return new AggregateSetAborted();
      });
      await svc.tick();

      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
      // and the range, whose slice was cut short, is left as it was
      if (setup === 'range') expect(ch.dirty).toEqual([{ from: unix(DIRTY_FROM), to: unix(DIRTY_TO), created: 1000 }]);
    });

    it('while a real failure of the same job still is an error', async () => {
      caughtUp();
      world.busy(0);
      const svc = service();
      world.throwOn.set('pair_hourly', () => {
        void svc.stop();
        return new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'pair_hourly' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
  });

  it('without aggregates no D2 job runs and no hook is called', async () => {
    caughtUp();
    markRange();
    rolledAccount();
    world.busy(0);
    await service({ aggregates: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => !D2_JOBS.includes(job)));
    expect(events().filter((event) => /^(pair_hourly|markets_live|rates_daily|account_rollups)/.test(event))).toEqual(
      [],
    );
    // the range of agg_dirty is drained all the same
    expect(ch.dirty).toEqual([]);
    for (const gauge of [
      'pairHourlyMissingHours',
      'marketsLiveAgeSeconds',
      'ratesDailyMissingDays',
      'accountRollupsHeavyAccounts',
      'accountRollupsPendingAccounts',
    ] as const) {
      expect(metrics[gauge].set).not.toHaveBeenCalled();
    }
  });
});

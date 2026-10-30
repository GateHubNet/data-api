import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  AggregateSetAborted,
  ClickHouseService,
  DailyRates,
  getNetworkProfile,
  LATEST_DAYS,
  MarketsConfig,
  NftKey,
  RatesService,
  RollupState,
  Table,
  TokenGenerationsRow,
  TokensAborted,
} from '@gatehub/data-api-shared';
import { DAY, HOUR, iso, NOW, unix } from '../../test/aggregate-job-fakes';
import { AggregateFunctions } from './aggregate-job-deps';
import {
  AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS,
  AGGREGATOR_AMM_POOLS_BUDGET_MS,
  AGGREGATOR_ESCROWS_BUDGET_MS,
  AGGREGATOR_MARKETS_LIVE_BUDGET_MS,
  AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS,
  AGGREGATOR_NFT_STATE_BUDGET_MS,
  AGGREGATOR_PAIR_HOURLY_BUDGET_MS,
  AGGREGATOR_RATES_DAILY_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AGGREGATOR_TICK_BUDGET_MS,
  AGGREGATOR_TOKENS_BUDGET_MS,
  AGGREGATOR_VOLUME_DAILY_BUDGET_MS,
  AGGREGATOR_VOLUME_LIVE_BUDGET_MS,
  AggregatorOptions,
  AggregatorService,
  AmmDailyFunctions,
  AmmPoolsFunctions,
  EscrowsFunctions,
  NFT_COLLECTIONS_EVERY_TICKS,
  NftCollectionsFunctions,
  NftStateFunctions,
  TokensFunctions,
} from './aggregator.service';

/**
 * The order of a tick with the account and market jobs registered (and the AMM jobs, the NFT jobs, the escrows job and the tokens job), and what that order is for: the live
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
  'nft_state',
  'escrows',
  'pair_hourly',
  'markets_live',
  'tokens',
  'stats_live',
  'stats_dirty',
  'amm_daily',
  'nft_collections',
  'rates_daily',
  'account_rollups',
  'volume_backfill',
];

/** The jobs of a tick `tickNo` (counted from 0), when every one is registered: `nft_collections` runs at the first tick and every fifth after it. */
const JOBS_OF_TICK = (tickNo: number): string[] =>
  tickNo % NFT_COLLECTIONS_EVERY_TICKS === 0 ? EVERY_JOB : EVERY_JOB.filter((job) => job !== 'nft_collections');

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
      marketsAmmShareKnown: async () => new Map(),
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

/**
 * The functions of `nft_state` and `nft_collections`, as their runners call them, and the ledgers of every slice. By default the
 * world is quiet: no NFT has changed, no range is dirty and no collection is behind. `busy()` gives `nft_state` far more to do
 * than its budget lets it (an NFT to rebuild at every ask, `rebuildMs` of the fake clock each), and `busyCollections()` gives
 * `nft_collections` a thousand collections to compute (`collectionsMs` of the fake clock a batch). A rebuild is noted as
 * `nft_rebuild`, a batch of collections as `nft_collections_recompute`, and the mark of a slice as `nft_state_mark <min> <max>`
 * (every slice has the ledgers 100 to 200), which a test makes fail by naming `markFails`.
 */
class NftWorld {
  rebuildMs = 0;
  collectionsMs = 0;
  private active = false;
  private collectionsActive = false;
  private collectionsRead: 'quiet' | 'slow' = 'quiet';
  private ledger = 0;
  markFails?: Error;
  readonly key: NftKey = { issuer: 'rSyntheticIssuer', taxon_key: 1, serial: 1, nft_id: '1'.padStart(64, '0') };

  constructor(private readonly note: (event: string) => void) {}

  busy(rebuildMs: number): void {
    this.active = true;
    this.rebuildMs = rebuildMs;
  }

  /** The read of the collections that are behind (`collectionsBehind`) never answers: a query that takes longer than the tick. */
  collectionsReadNeverAnswers(): void {
    this.collectionsRead = 'slow';
  }

  busyCollections(collectionsMs: number): void {
    this.collectionsActive = true;
    this.collectionsMs = collectionsMs;
  }

  /** The rates the NFT hook finds the ledgers of a slice with: ledgers 100 to 200 closed in every slice. */
  rates(): RatesService {
    return { nativeCurrency: 'XRP', ledgersClosedIn: async () => ({ min: 100, max: 200 }) } as unknown as RatesService;
  }

  fns(): Partial<NftStateFunctions> {
    return {
      watermark: async () => 0,
      changedSince: async (_ch, ledger) =>
        this.active ? { nfts: [this.key], upTo: ++this.ledger } : { nfts: [], upTo: ledger },
      inLedgers: async () => [],
      rebuild: async (_ch, nfts) => {
        this.note('nft_rebuild');
        if (this.rebuildMs > 0) jest.setSystemTime(Date.now() + this.rebuildMs);
        return { written: nfts.length, removed: 0, collections: [] };
      },
      markDirty: async (_ch, from, to) => {
        this.note(`nft_state_mark ${from} ${to}`);
        if (this.markFails) throw this.markFails;
      },
      oldestDirty: async () => undefined,
      narrowDirty: async () => undefined,
      deleteDirty: async () => undefined,
      dirtyLedgers: async () => 0,
      // a database with ledgers, the cursor within a window of the head: it is placed where the watermark is
      head: async () => 1000,
      firstLedger: async () => 1,
    };
  }

  collectionsFns(): Partial<NftCollectionsFunctions> {
    return {
      behind: () =>
        this.collectionsRead === 'slow'
          ? new Promise(() => undefined)
          : Promise.resolve(
              this.collectionsActive
                ? Array.from({ length: 1000 }, (_, taxon_key) => ({ issuer: 'rSyntheticIssuer', taxon_key }))
                : [],
            ),
      recompute: async (_ch, _rates, keys) => {
        this.note('nft_collections_recompute');
        if (this.collectionsMs > 0) jest.setSystemTime(Date.now() + this.collectionsMs);
        return { written: keys.length, removed: 0 };
      },
    };
  }
}

/**
 * The functions of the `escrows` job, as its runner calls them. By default the world is quiet: the head is 1000 and the step of a
 * tick moves the watermark to it. `busy()` gives the job far more to do than its budget lets it (a head that is never reached,
 * 1000 ledgers a step, `stepMs` of the fake clock each). A step is noted as `escrows_step`; the hook of a slice as `escrows_of
 * <min> <max>` (every slice has the ledgers 100 to 200), `escrows_recompute <upTo>` and `escrows_total`, which a test makes fail
 * by naming `recomputeFails`.
 */
class EscrowsWorld {
  stepMs = 0;
  recomputeFails?: Error;
  private head = 1000;
  private through = 0;

  constructor(private readonly note: (event: string) => void) {}

  busy(stepMs: number): void {
    this.stepMs = stepMs;
    this.head = 1_000_000_000;
  }

  fns(): Partial<EscrowsFunctions> {
    return {
      step: async () => {
        this.note('escrows_step');
        if (this.stepMs > 0) jest.setSystemTime(Date.now() + this.stepMs);
        const from = this.through;
        const to = Math.min(this.head, from + 1000);
        this.through = to;
        return {
          from,
          to,
          head: this.head,
          touched: 0,
          written: 0,
          removed: 0,
          setAside: [],
          escrowed: { drops: '0', open: 0, through_ledger: to },
        };
      },
      read: async () => ({ drops: '0', open: 0, through_ledger: this.through }),
      ofLedgers: async (_ch, min, max) => {
        this.note(`escrows_of ${min} ${max}`);
        return ['A'.repeat(64)];
      },
      recompute: async (_ch, _ids, { upTo }) => {
        this.note(`escrows_recompute ${upTo}`);
        if (this.recomputeFails) throw this.recomputeFails;
        return { written: 1, removed: 0, setAside: [] };
      },
      refreshTotal: async () => {
        this.note('escrows_total');
        return { drops: '0', open: 0, through_ledger: this.through };
      },
    };
  }
}

/**
 * The functions of the `tokens` job, as its runner calls them, over the rows of `token_generations` in memory. By default the world
 * is quiet: the head is 1000, the first run starts a generation, and its account pass has no account, so that it is live at once.
 * `busy()` gives the job far more to do than its budget lets it (an account at every ask of the pass, which never ends, `passMs` of
 * the fake clock each). A batch of the pass is noted as `tokens_pass`; the write of a row with a `repair_from` (the hook of a slice
 * is the only thing that sets one, and every slice has the ledgers 100 to 200) as `tokens_repair_from <ledger>`, which a test
 * makes fail by naming `markFails`.
 */
class TokensWorld {
  passMs = 0;
  markFails?: Error;
  readonly rows = new Map<number, TokenGenerationsRow>();
  private endless = false;
  private passes = 0;

  constructor(private readonly note: (event: string) => void) {}

  busy(passMs: number): void {
    this.passMs = passMs;
    this.endless = true;
  }

  fns(): Partial<TokensFunctions> {
    return {
      readTokenGenerations: async () => [...this.rows.values()],
      writeTokenGeneration: async (_ch, row) => {
        if (row.repair_from > 0) {
          this.note(`tokens_repair_from ${row.repair_from}`);
          if (this.markFails) throw this.markFails;
        }
        this.rows.set(row.generation, row);
      },
      stateCoverageStart: async () => 1,
      tokensVersionFloor: async () => '0',
      head: async () => 1000,
      nextPassAccounts: async () => {
        if (!this.endless) return [];
        this.note('tokens_pass');
        if (this.passMs > 0) jest.setSystemTime(Date.now() + this.passMs);
        return [`rAccount${++this.passes}`];
      },
      writePassLines: async () => undefined,
      passTokens: async () => [],
      touchesOfWindow: async (_ch, _from, head) => ({ to: head, lines: [], issuers: [] }),
      parserFloorOf: async () => null,
    };
  }
}

describe('the schedule of the aggregator with the account and market jobs', () => {
  let ch: FakeClickHouse;
  let world: D2World;
  let nftWorld: NftWorld;
  let escrowsWorld: EscrowsWorld;
  let tokensWorld: TokensWorld;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let metrics: Record<
    | 'aggregatorRunsTotal'
    | 'aggregatorErrorsTotal'
    | 'aggregatorStatsLagSeconds'
    | 'pairHourlyMissingHours'
    | 'marketsLiveAgeSeconds'
    | 'marketsLiveAmmShareKnown'
    | 'ratesDailyMissingDays'
    | 'accountRollupsHeavyAccounts'
    | 'accountRollupsPendingAccounts'
    | 'nftStateLagLedgers'
    | 'nftDirtyLedgers'
    | 'nftCollectionsPending'
    | 'escrowsLagLedgers'
    | 'escrowsOpen'
    | 'tokensLive'
    | 'tokensLagLedgers'
    | 'tokensBuilding'
    | 'tokensRepairLedgers',
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
    nftWorld = new NftWorld(note);
    escrowsWorld = new EscrowsWorld(note);
    tokensWorld = new TokensWorld(note);
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn(), set: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn(), set: jest.fn() },
      aggregatorStatsLagSeconds: { inc: jest.fn(), set: jest.fn() },
      pairHourlyMissingHours: { inc: jest.fn(), set: jest.fn() },
      marketsLiveAgeSeconds: { inc: jest.fn(), set: jest.fn() },
      marketsLiveAmmShareKnown: { inc: jest.fn(), set: jest.fn() },
      ratesDailyMissingDays: { inc: jest.fn(), set: jest.fn() },
      accountRollupsHeavyAccounts: { inc: jest.fn(), set: jest.fn() },
      accountRollupsPendingAccounts: { inc: jest.fn(), set: jest.fn() },
      nftStateLagLedgers: { inc: jest.fn(), set: jest.fn() },
      nftDirtyLedgers: { inc: jest.fn(), set: jest.fn() },
      nftCollectionsPending: { inc: jest.fn(), set: jest.fn() },
      escrowsLagLedgers: { inc: jest.fn(), set: jest.fn() },
      escrowsOpen: { inc: jest.fn(), set: jest.fn() },
      tokensLive: { inc: jest.fn(), set: jest.fn() },
      tokensLagLedgers: { inc: jest.fn(), set: jest.fn() },
      tokensBuilding: { inc: jest.fn(), set: jest.fn() },
      tokensRepairLedgers: { inc: jest.fn(), set: jest.fn() },
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

  /** A service with every job registered; the volume sets, the AMM sets, the NFT sets, the escrows, the tokens and the account and market sets are the fakes above. */
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
      nfts: { rates: nftWorld.rates(), dailyRates: {} as DailyRates },
      nftStateFunctions: nftWorld.fns(),
      nftCollectionsFunctions: nftWorld.collectionsFns(),
      escrows: { rates: nftWorld.rates(), nativeCurrency: 'XRP' },
      escrowsFunctions: escrowsWorld.fns(),
      tokens: { profile: getNetworkProfile('xrpl'), rates: nftWorld.rates() },
      tokensFunctions: tokensWorld.fns(),
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

  it('the jobs of a tick are volume_live, volume_daily, amm_pools, nft_state, escrows, pair_hourly, markets_live, tokens, stats_live, stats_dirty, amm_daily, nft_collections, rates_daily, account_rollups, volume_backfill', async () => {
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
      'nft_state',
      'escrows',
      'pair_hourly',
      'markets_live',
      'tokens',
      'stats_live',
      'stats_dirty',
      'amm_daily',
      'nft_collections',
      'rates_daily',
      'account_rollups',
    ]);
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ aggregates: undefined }).tick();
    expect(runs()).toEqual([
      'volume_live',
      'volume_daily',
      'amm_pools',
      'nft_state',
      'escrows',
      'tokens',
      'stats_live',
      'stats_dirty',
      'amm_daily',
      'nft_collections',
      'volume_backfill',
    ]);
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ ammPools: undefined, ammDaily: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => !job.startsWith('amm_')));
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ nfts: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => job !== 'nft_state' && job !== 'nft_collections'));
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ escrows: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => job !== 'escrows'));
    metrics.aggregatorRunsTotal.inc.mockClear();
    await service({ tokens: undefined }).tick();
    expect(runs()).toEqual(EVERY_JOB.filter((job) => job !== 'tokens'));
  });

  it('runs nft_state after amm_pools with its own budget, which it alone uses and which does not shorten the budgets of the jobs after it', async () => {
    expect(AGGREGATOR_NFT_STATE_BUDGET_MS).toBe(3000);
    caughtUp();
    world.busy(1000);
    nftWorld.busy(1000);
    await service().tick();
    // an NFT at a time while the budget of the job is not spent: 1 s a rebuild, the 3 s of the job
    expect(count('nft_rebuild')).toBe(AGGREGATOR_NFT_STATE_BUDGET_MS / 1000);
    // after amm_pools (a run is counted when the job ends), before escrows and pair_hourly, which have all of their own budgets all the same
    expect(runs().slice(0, 6)).toEqual([
      'volume_live',
      'volume_daily',
      'amm_pools',
      'nft_state',
      'escrows',
      'pair_hourly',
    ]);
    expect(events().findIndex((event) => event === 'nft_rebuild')).toBeLessThan(
      events().findIndex((event) => event.startsWith('pair_hourly')),
    );
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);

    log.length = 0;
    jest.setSystemTime(NOW);
    await service({ budgetsMs: { nft_state: 1500 } }).tick();
    expect(count('nft_rebuild')).toBe(2);
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);
  });

  it('runs escrows after nft_state with its own budget, which it alone uses and which does not shorten the budgets of the jobs after it', async () => {
    expect(AGGREGATOR_ESCROWS_BUDGET_MS).toBe(2000);
    caughtUp();
    world.busy(1000);
    escrowsWorld.busy(1000);
    await service().tick();
    // a step at a time while the budget of the job is not spent: 1 s a step, the 2 s of the job
    expect(count('escrows_step')).toBe(AGGREGATOR_ESCROWS_BUDGET_MS / 1000);
    // after nft_state (a run is counted when the job ends), before pair_hourly, which has all of its own budget all the same
    expect(runs().slice(0, 6)).toEqual([
      'volume_live',
      'volume_daily',
      'amm_pools',
      'nft_state',
      'escrows',
      'pair_hourly',
    ]);
    expect(events().findIndex((event) => event === 'escrows_step')).toBeLessThan(
      events().findIndex((event) => event.startsWith('pair_hourly')),
    );
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);

    log.length = 0;
    jest.setSystemTime(NOW);
    await service({ budgetsMs: { escrows: 1000 } }).tick();
    expect(count('escrows_step')).toBe(1);
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);
  });

  it('runs tokens after markets_live with its own budget, which it alone uses and which does not shorten the budgets of the jobs after it', async () => {
    expect(AGGREGATOR_TOKENS_BUDGET_MS).toBe(4000);
    caughtUp();
    world.busy(1000);
    tokensWorld.busy(1000);
    await service().tick();
    // a batch of the account pass at a time while the budget of the job is not spent: 1 s a batch, the 4 s of the job
    expect(count('tokens_pass')).toBe(AGGREGATOR_TOKENS_BUDGET_MS / 1000);
    // after markets_live (a run is counted when the job ends), before the stats
    expect(runs().slice(4, 9)).toEqual(['escrows', 'pair_hourly', 'markets_live', 'tokens', 'stats_live']);
    expect(events().findIndex((event) => event.startsWith('markets_live'))).toBeLessThan(
      events().findIndex((event) => event === 'tokens_pass'),
    );
    // the jobs after it have all of their own budgets all the same (3 + 3 + 4 s are gone when rates_daily starts)
    expect(count('rates_daily ')).toBe(AGGREGATOR_RATES_DAILY_BUDGET_MS / 1000);
    expect(count('account_rollups_recount')).toBe(AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS / 1000);
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();

    log.length = 0;
    jest.setSystemTime(NOW);
    await service({ budgetsMs: { tokens: 1000 } }).tick();
    expect(count('tokens_pass')).toBe(1);
    expect(count('rates_daily ')).toBe(AGGREGATOR_RATES_DAILY_BUDGET_MS / 1000);
  });

  it('the jobs before stats_live take 27 of the 30 s of the tick when each uses its whole budget, and stats_live gets the 3 s that are left', async () => {
    expect(
      AGGREGATOR_VOLUME_LIVE_BUDGET_MS +
        AGGREGATOR_VOLUME_DAILY_BUDGET_MS +
        AGGREGATOR_AMM_POOLS_BUDGET_MS +
        AGGREGATOR_NFT_STATE_BUDGET_MS +
        AGGREGATOR_ESCROWS_BUDGET_MS +
        AGGREGATOR_PAIR_HOURLY_BUDGET_MS +
        AGGREGATOR_MARKETS_LIVE_BUDGET_MS +
        AGGREGATOR_TOKENS_BUDGET_MS,
    ).toBe(27_000);
    expect(AGGREGATOR_TICK_BUDGET_MS).toBe(30_000);

    // every job before stats_live has far more to do than its budget, a second a set, and the stats have months to catch up on,
    // a second a slice
    const SET_MS = 1000;
    let poolLedger = 0;
    world.busy(SET_MS);
    nftWorld.busy(SET_MS);
    escrowsWorld.busy(SET_MS);
    tokensWorld.busy(SET_MS);
    statsMs = SET_MS;
    ch.watermark = unix('2026-03-01T00:00:00Z');
    ch.closes = Array.from({ length: 230 }, (_, i) => unix('2026-03-01T00:30:00Z') + i * DAY);
    ch.closes.push(NOW_SECONDS - 3);
    const takes = (kind: string): number => {
      note(kind);
      jest.setSystemTime(Date.now() + SET_MS);
      return 0;
    };
    await service({
      volumeFunctions: {
        computeLiveSet: async () => takes('live'),
        computeDailySet: async () => takes('daily'),
        daysDone: async () => new Set(),
        liveVersions: async () => new Map(),
        dailyVersions: async () => new Map(),
      },
      ammPoolsFunctions: {
        watermark: async () => 0,
        changedSince: async () => ({ accounts: ['rBusyPool'], upTo: ++poolLedger }),
        poolsClosedIn: async () => [],
        recompute: async () => takes('amm_pool'),
      },
    }).tick();

    // each of the jobs used its budget and no more
    expect(count('live')).toBe(AGGREGATOR_VOLUME_LIVE_BUDGET_MS / SET_MS);
    expect(count('daily')).toBe(AGGREGATOR_VOLUME_DAILY_BUDGET_MS / SET_MS);
    expect(count('amm_pool')).toBe(AGGREGATOR_AMM_POOLS_BUDGET_MS / SET_MS);
    expect(count('nft_rebuild')).toBe(AGGREGATOR_NFT_STATE_BUDGET_MS / SET_MS);
    expect(count('escrows_step')).toBe(AGGREGATOR_ESCROWS_BUDGET_MS / SET_MS);
    expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / SET_MS);
    expect(count('markets_live')).toBe(AGGREGATOR_MARKETS_LIVE_BUDGET_MS / SET_MS);
    expect(count('tokens_pass')).toBe(AGGREGATOR_TOKENS_BUDGET_MS / SET_MS);
    // so stats_live starts at 27 s with 3 s of the tick left, and starts a slice while there is time: three of them
    const firstStats = log.find((entry) => entry.event.startsWith('stats'));
    expect((firstStats?.at ?? 0) - NOW_MS).toBe(27_000);
    expect(count('stats')).toBe((AGGREGATOR_TICK_BUDGET_MS - 27_000) / SET_MS);
    expect(runs().slice(0, 8)).toEqual([
      'volume_live',
      'volume_daily',
      'amm_pools',
      'nft_state',
      'escrows',
      'pair_hourly',
      'markets_live',
      'tokens',
    ]);
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

  it('with every job registered, nft_state, escrows, tokens and every D2 job using its whole budget, volume_live and volume_daily run first and finish in every one of 10 ticks, and a tick ends within AGGREGATOR_TICK_BUDGET_MS plus one set', async () => {
    // The most any tick can be asked for: 230 days of stats to catch up and 30 ranges of agg_dirty to drain, 4 s a slice, and
    // every D2 job with far more to do than its budget (1 s a set). The longest set is the slice of the stats.
    const SLICE_MS = 4000;
    statsMs = SLICE_MS;
    world.busy(1000);
    nftWorld.busy(1000);
    escrowsWorld.busy(1000);
    tokensWorld.busy(1000);
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

      // the fifteen live sets and the eight daily ones (amm_volume and nft_volume among them) are the first things the tick does,
      // at its very start
      const first = log.slice(0, 23);
      expect(first.map((entry) => entry.event.split(' ')[0])).toEqual([
        ...Array(15).fill('live'),
        ...Array(8).fill('daily'),
      ]);
      expect(first.every((entry) => entry.at === tickStart)).toBe(true);
      // they finished (a run is counted when the job ends without throwing), and so did every job after them
      // (nft_collections is not one of them in the ticks that are not its own)
      expect(runs()).toEqual(JOBS_OF_TICK(tickNo));
      // the jobs before the stats got their budgets, and the one with a set of its own guarantee got that
      expect(count('pair_hourly')).toBe(AGGREGATOR_PAIR_HOURLY_BUDGET_MS / 1000);
      expect(count('nft_rebuild')).toBe(AGGREGATOR_NFT_STATE_BUDGET_MS / 1000);
      expect(count('escrows_step')).toBe(AGGREGATOR_ESCROWS_BUDGET_MS / 1000);
      expect(count('tokens_pass')).toBe(AGGREGATOR_TOKENS_BUDGET_MS / 1000);
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

  it("with nft_state and nft_collections registered and using their whole budgets, volume_live's fifteen sets and volume_daily finish in every one of 10 ticks", async () => {
    expect(AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS).toBe(3000);
    // nft_state has an NFT to rebuild at every ask and nft_collections a thousand collections to compute (1 s a batch of 50), far
    // more than their budgets of 3 s; nothing else has any work, so the time of a tick is theirs
    caughtUp();
    nftWorld.busy(1000);
    nftWorld.busyCollections(1000);
    const svc = service();

    for (let tickNo = 0; tickNo < 10; tickNo++) {
      const tickStart = NOW_MS + tickNo * 60_000;
      jest.setSystemTime(tickStart);
      log.length = 0;
      metrics.aggregatorRunsTotal.inc.mockClear();
      await svc.tick();

      // the fifteen live sets and the eight daily ones are the first things the tick does, at its very start
      const first = log.slice(0, 23);
      expect(first.map((entry) => entry.event.split(' ')[0])).toEqual([
        ...Array(15).fill('live'),
        ...Array(8).fill('daily'),
      ]);
      expect(first.every((entry) => entry.at === tickStart)).toBe(true);
      // and the jobs ran to the end, in order: volume_live and volume_daily first, nft_collections at its own ticks only
      expect(runs()).toEqual(JOBS_OF_TICK(tickNo));
      expect(runs().slice(0, 2)).toEqual(['volume_live', 'volume_daily']);
      // each of the two NFT jobs used the whole of its budget, and no more
      const ownTick = tickNo % NFT_COLLECTIONS_EVERY_TICKS === 0;
      expect(count('nft_rebuild')).toBe(AGGREGATOR_NFT_STATE_BUDGET_MS / 1000);
      expect(count('nft_collections')).toBe(ownTick ? AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS / 1000 : 0);
      expect(Date.now() - tickStart).toBe(
        AGGREGATOR_NFT_STATE_BUDGET_MS + (ownTick ? AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS : 0),
      );
    }
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    // the queue of collections was not drained: 3 batches of 50 at the first tick and at the fifth
    expect(metrics.nftCollectionsPending.set.mock.calls.map(([value]) => value)).toEqual([850, 700]);
  });

  it('does not starve the live sets with tokens registered', async () => {
    // the account pass of the generation that builds never ends (1 s a batch of accounts), far more than the 4 s of the job;
    // nothing else has any work, so the time of a tick is the job's
    caughtUp();
    tokensWorld.busy(1000);
    const svc = service();

    for (let tickNo = 0; tickNo < 10; tickNo++) {
      const tickStart = NOW_MS + tickNo * 60_000;
      jest.setSystemTime(tickStart);
      log.length = 0;
      metrics.aggregatorRunsTotal.inc.mockClear();
      await svc.tick();

      // the fifteen live sets and the eight daily ones are the first things the tick does, at its very start
      const first = log.slice(0, 23);
      expect(first.map((entry) => entry.event.split(' ')[0])).toEqual([
        ...Array(15).fill('live'),
        ...Array(8).fill('daily'),
      ]);
      expect(first.every((entry) => entry.at === tickStart)).toBe(true);
      // and the jobs ran to the end, in order, tokens among them
      expect(runs()).toEqual(JOBS_OF_TICK(tickNo));
      expect(runs().slice(0, 2)).toEqual(['volume_live', 'volume_daily']);
      // the job used the whole of its budget and no more
      expect(count('tokens_pass')).toBe(AGGREGATOR_TOKENS_BUDGET_MS / 1000);
      expect(Date.now() - tickStart).toBe(AGGREGATOR_TOKENS_BUDGET_MS);
    }
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    // the generation is still building: the job always has a batch more
    expect(metrics.tokensBuilding.set).toHaveBeenLastCalledWith(1);
    expect(metrics.tokensLive.set).toHaveBeenLastCalledWith(0);
  });

  it('a read of the collections that are behind that does not answer does not keep the jobs after nft_collections from running in that tick', async () => {
    caughtUp();
    world.busy(1000);
    nftWorld.collectionsReadNeverAnswers();
    let settled = false;
    const ticking = service().tick();
    void ticking.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    // the tick is over although the read has not answered (a tick that waited for it would never be)
    expect(settled).toBe(true);
    await ticking;

    // nft_collections did not wait for the read, and rates_daily, account_rollups and volume_backfill after it had their sets
    expect(runs()).toEqual(EVERY_JOB);
    expect(count('nft_collections')).toBe(0);
    expect(count('rates_daily ')).toBeGreaterThanOrEqual(1);
    expect(count('account_rollups_recount')).toBeGreaterThanOrEqual(1);
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
  });

  describe('a slice of agg_dirty runs the hooks of rates_daily, pair_hourly, account_rollups, nft_state, escrows and tokens after its volume sets; a failing hook is failed("<job>_dirty", …), fails the slice and keeps the range', () => {
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
      // amm_daily set), then D2's, then the mark of the ledgers of the slice in nft_dirty, then the escrows of the slice, and last
      // the mark of the slice for the repair of the generation of the tokens (the first ledger of the slice)
      expect(events().slice(at, at + 14)).toEqual([
        `stats ${DIRTY_FROM}`,
        'daily trade_volume 2026-10-14',
        'daily payment_volume 2026-10-14',
        'daily amm_volume 2026-10-14',
        'daily nft_volume 2026-10-14',
        'amm_daily 2026-10-14',
        HOOKS.rates_daily,
        HOOKS.pair_hourly,
        HOOKS.account_rollups,
        'nft_state_mark 100 200',
        'escrows_of 100 200',
        'escrows_recompute 1000',
        'escrows_total',
        'tokens_repair_from 100',
      ]);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('runs the hook of nft_state without the aggregates option, which only the other hooks need', async () => {
      caughtUp();
      markRange();
      await service({ aggregates: undefined }).tick();
      expect(events().filter((event) => event.startsWith('nft_state_mark'))).toEqual(['nft_state_mark 100 200']);
      expect(
        events().filter((event) => event.startsWith('rates_daily_mark') || event.startsWith('pair_hourly')),
      ).toEqual([]);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('runs the hook of escrows without the aggregates option and without the nfts option, which only the other hooks need', async () => {
      caughtUp();
      markRange();
      await service({ aggregates: undefined, nfts: undefined }).tick();
      expect(events().filter((event) => event.startsWith('escrows_of'))).toEqual(['escrows_of 100 200']);
      expect(events().filter((event) => event.startsWith('nft_state_mark'))).toEqual([]);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('runs the hook of tokens without the aggregates, nfts and escrows options, which only the other hooks need', async () => {
      caughtUp();
      markRange();
      await service({ aggregates: undefined, nfts: undefined, escrows: undefined }).tick();
      expect(events().filter((event) => event.startsWith('tokens_repair_from'))).toEqual(['tokens_repair_from 100']);
      expect(events().filter((event) => /^(nft_state_mark|escrows_of)/.test(event))).toEqual([]);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('writes nothing for a slice that would not lower the repair_from of a generation: two ranges with the same ledgers write one mark', async () => {
      caughtUp();
      markRange(DIRTY_FROM, DIRTY_TO, 1000);
      markRange('2026-10-14T22:00:00Z', '2026-10-14T23:00:00Z', 1001);
      await service().tick();
      // both slices reach the ledgers 100 to 200: the first sets repair_from to 100, and for the second it already is
      expect(events().filter((event) => event.startsWith('tokens_repair_from'))).toEqual(['tokens_repair_from 100']);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a failing nft_state hook is counted and logged as nft_state_dirty, fails the slice and keeps the range, after the hooks of D2 ran; the next tick does it again', async () => {
      caughtUp();
      markRange();
      rolledAccount();
      nftWorld.markFails = new Error('memory limit');
      const svc = service();
      await svc.tick();

      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_state_dirty' }]]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(`Aggregator job nft_state_dirty failed${DIRTY_WHERE}: memory limit`);
      for (const hook of Object.values(HOOKS)) expect(events()).toContain(hook);
      // and the hooks after it, the escrows' and the tokens', were not run
      expect(events().filter((event) => event.startsWith('escrows_of'))).toEqual([]);
      expect(events().filter((event) => event.startsWith('tokens_repair_from'))).toEqual([]);
      expect(ch.dirty).toEqual([{ from: unix(DIRTY_FROM), to: unix(DIRTY_TO), created: 1000 }]);
      // and the jobs of the tick that come after stats_dirty were not kept from running
      expect(runs()).toEqual(EVERY_JOB);

      nftWorld.markFails = undefined;
      metrics.aggregatorErrorsTotal.inc.mockClear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a failing escrows hook is counted and logged as escrows_dirty, fails the slice and keeps the range, after the hooks of D2 and nft_state ran; the next tick does it again', async () => {
      caughtUp();
      markRange();
      rolledAccount();
      escrowsWorld.recomputeFails = new Error('memory limit');
      const svc = service();
      await svc.tick();

      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'escrows_dirty' }]]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(`Aggregator job escrows_dirty failed${DIRTY_WHERE}: memory limit`);
      for (const hook of Object.values(HOOKS)) expect(events()).toContain(hook);
      expect(events()).toContain('nft_state_mark 100 200');
      // and the hook after it, the tokens', was not run: the mark of the slice waits in agg_dirty with the slice
      expect(events().filter((event) => event.startsWith('tokens_repair_from'))).toEqual([]);
      expect(ch.dirty).toEqual([{ from: unix(DIRTY_FROM), to: unix(DIRTY_TO), created: 1000 }]);
      expect(runs()).toEqual(EVERY_JOB);

      escrowsWorld.recomputeFails = undefined;
      metrics.aggregatorErrorsTotal.inc.mockClear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(events().filter((event) => event.startsWith('tokens_repair_from'))).toEqual(['tokens_repair_from 100']);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a failing tokens hook is counted and logged as tokens_dirty, fails the slice and keeps the range, after the hooks of D2, nft_state and escrows ran; the next tick does it again', async () => {
      caughtUp();
      markRange();
      rolledAccount();
      tokensWorld.markFails = new Error('memory limit');
      const svc = service();
      await svc.tick();

      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'tokens_dirty' }]]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(`Aggregator job tokens_dirty failed${DIRTY_WHERE}: memory limit`);
      for (const hook of Object.values(HOOKS)) expect(events()).toContain(hook);
      expect(events()).toContain('nft_state_mark 100 200');
      expect(events()).toContain('escrows_total');
      expect(ch.dirty).toEqual([{ from: unix(DIRTY_FROM), to: unix(DIRTY_TO), created: 1000 }]);
      expect(runs()).toEqual(EVERY_JOB);

      tokensWorld.markFails = undefined;
      metrics.aggregatorErrorsTotal.inc.mockClear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
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

    it('a TokensAborted, which the tokens job throws, is dropped at shutdown like the others (any job reaches the same rule)', async () => {
      caughtUp();
      world.busy(0);
      const svc = service();
      world.throwOn.set('pair_hourly', () => {
        void svc.stop();
        return new TokensAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('while a TokensAborted that the shutdown did not cause is an error, as any failure', async () => {
      caughtUp();
      world.busy(0);
      world.throwOn.set('pair_hourly', () => new TokensAborted());
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'pair_hourly' });
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

  it('without aggregates no D2 job runs and no hook is called (nft_state is not one of them)', async () => {
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
      'marketsLiveAmmShareKnown',
      'ratesDailyMissingDays',
      'accountRollupsHeavyAccounts',
      'accountRollupsPendingAccounts',
    ] as const) {
      expect(metrics[gauge].set).not.toHaveBeenCalled();
    }
  });
});

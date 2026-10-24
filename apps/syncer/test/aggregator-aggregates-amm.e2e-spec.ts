import {
  ACCOUNT_PARTITION_ROWS_FLOOR,
  buildLedgerRows,
  ClickHouseService,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  pairHourSets,
  parseContextFor,
  PARSER_VERSION,
  RatesService,
  rollupStates,
  runMigrations,
  Table,
  validRateDays,
} from '@gatehub/data-api-shared';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { readDirtyRanges } from '../src/aggregator/agg-dirty';
import { MARKETS_LONG_EVERY_TICKS } from '../src/aggregator/markets-live.job-runner';
import { rangeIngest } from '../src/cli/range-ingest';
import {
  aggregator,
  FakeMetrics,
  fakeMetrics,
  GENEROUS,
  rateSentinels,
  rollupSentinels,
  stopAggregators,
} from './aggregates-e2e-support';
import { ammTemplate, syntheticChain } from './synthetic-chain';

/**
 * A `range-ingest --reprocess` from parser 1 to parser 2 against the `AggregatorService` with the account and market
 * jobs, on a real ClickHouse (spec D2b.2 and D2b.5). What D2 computed from ledgers written before the AMM parser, with
 * no swaps, is corrected by the `agg_dirty` range the reprocess marks (the rate days marked stale and computed again,
 * the hours recomputed with `amm` rows, the heavy account's day rolled again), and the AMM fields of the markets sets
 * and the gauge appear once the window is made of parser-2 ledgers. The sets themselves are checked against oracles in
 * `packages/shared/test`; here it is the whole path that is on trial.
 *
 * The world. A chain of 26 ledgers made of recorded AMM ledgers, one every ten minutes from 22:00 on 2024-05-14 to
 * 02:10 on 2024-05-15 (twelve of them on the first UTC day, fourteen on the second), written by `range-ingest` and
 * then made what parser 1 wrote: no rows in the AMM tables, no swaps among the exchanges, `parser_version` 1. Two
 * ledgers without a transaction are beside it, outside the range that is reprocessed: an old one (so that the hours of
 * the last 31 days are computed, as on a database that has been running for a while) and one of the first day that
 * carries the balance changes of the heavy account, the taker of six of the template's swaps (a reprocess deletes the
 * rows of the ledgers it rewrites, balance changes included, so they must not be on the chain). The newest ledger
 * closed more than an hour after the first day ended, so that day is final.
 */

const ctx = parseContextFor(getNetworkProfile('xrpl'));

const unix = (text: string): number => Date.parse(text) / 1000;
const NOOP = (): void => undefined;
const QUIET = { log: NOOP, warn: NOOP, error: NOOP };
const PERIODS = ['day', '7day', '30day'] as const;
const FILTERS = ['include', 'exclude', 'only'] as const;

/** The two UTC days of the chain. */
const DAY_1 = '2024-05-14';
const DAY_2 = '2024-05-15';
/** The time of the ticks: half an hour after the newest ledger. */
const NOW = new Date('2024-05-15T02:40:00Z');
/** The hour before the chain's first one: no ledger of the reprocess closed in it. */
const NEIGHBOUR_HOUR = unix('2024-05-14T21:00:00Z');

/** The oldest ledger, with no trade, 34 days before the first day: the hour back-fill reaches back its full 31 days. */
const OLD_LEDGER = { index: 50_000_000, close: unix('2024-04-10T00:00:00Z') };
/** The ledger of the first day that carries the balance changes of the heavy account. */
const HEAVY_LEDGER = { index: 50_000_001, close: unix('2024-05-14T12:00:00Z') };
/** The taker of six of the template's swaps (against the pool rQpPooAzwPaKpb37skRnxikGenHrRLT1cM) in each ledger. */
const HEAVY = 'r9jMezJbUjTHoiF9zoMhrwd9HjgLkQNygD';

const CHAIN_FIRST = 50_000_002;
const CHAIN_LEDGERS = 26;
const CHAIN_LAST = CHAIN_FIRST + CHAIN_LEDGERS - 1;
const CHAIN_START = unix('2024-05-14T22:00:00Z');
const CHAIN_STEP_SECONDS = 600;
const closeOfChain = (index: number): number => CHAIN_START + (index - CHAIN_FIRST) * CHAIN_STEP_SECONDS;
/** The hours the chain's ledgers closed in: 22:00 and 23:00 of the first day, 00:00, 01:00 and 02:00 of the second. */
const CHAIN_HOURS = [0, 1, 2, 3, 4].map((h) => CHAIN_START + h * 3600);
/** The ledgers of the chain that closed on the first day. */
const CHAIN_LEDGERS_OF_DAY_1 = Array.from({ length: CHAIN_LEDGERS }, (_, k) => k).filter(
  (k) => CHAIN_START + k * CHAIN_STEP_SECONDS < unix(`${DAY_2}T00:00:00Z`),
).length;

const CHAIN = syntheticChain(CHAIN_FIRST, CHAIN_LEDGERS, { template: ammTemplate(), closeTime: closeOfChain });
const WITHOUT_TRANSACTIONS = { ...ammTemplate(), transactions: [] };
/** What the parser makes of one ledger of the chain (they are all the same transactions). */
const ROWS_OF_A_LEDGER = buildLedgerRows(CHAIN[0].raw, ctx);
const SWAPS_PER_LEDGER = ROWS_OF_A_LEDGER.exchanges.filter((e) => e.amm_account !== '').length;
const HEAVY_SWAPS_PER_LEDGER = ROWS_OF_A_LEDGER.accountExchanges.filter(
  (e) => e.account === HEAVY && e.amm_account !== '',
).length;

const AMM_TABLES = [
  Table.AmmPoolStates,
  Table.AmmPoolTouches,
  Table.AmmLiquidity,
  Table.AccountAmmLiquidity,
  Table.AmmGovernance,
];
/** Passed on every lightweight DELETE so that it returns once it has been applied. */
const SYNC_DELETE = { settings: { lightweight_deletes_sync: '2' } } as const;

/** Options that keep `range-ingest` quick and the output of the suite clean. */
const FAST = { retryBackoffMs: 1, quiescenceTimeoutMs: 5_000, maxTransientWaitMs: 0, logger: QUIET };

describe('AggregatorService after a range-ingest --reprocess from parser 1 to parser 2 (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    await stopAggregators();
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /**
   * A migrated database of its own with the world of parser 1: the old ledger, the heavy account's ledger and its
   * balance changes, and the chain ingested and then made what parser 1 wrote.
   */
  async function parserOneWorld(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_aggregates_amm_${++dbCounter}` };
    await runMigrations({ config, log: NOOP });
    const svc = new ClickHouseService(config);
    services.push(svc);
    // The ledgers are of 2024 and the server's clock is real: a TTL merge would drop the pair_hourly rows (45 days) as they come.
    await svc.command(`SYSTEM STOP TTL MERGES ${config.database}.${Table.PairHourly}`);
    // A merge keeps the newest version of a key only; the tests compare a set with the one it replaced.
    for (const table of [Table.PairHourly, Table.NativeRatesDaily, Table.AccountRollupDays]) {
      await svc.command(`SYSTEM STOP MERGES ${config.database}.${table}`);
    }

    const quiet = (ledger: { index: number; close: number }) =>
      syntheticChain(ledger.index, 1, { template: WITHOUT_TRANSACTIONS, closeTime: () => ledger.close })[0].raw;
    await new LedgerWriter(svc, ctx).write([quiet(OLD_LEDGER), quiet(HEAVY_LEDGER)]);
    await svc.command(
      `INSERT INTO ${Table.BalanceChanges}
         (account, ledger_index, tx_index, node_index, close_time, currency, counterparty, amount_change, final_balance, final_balance_f, change_type)
       SELECT {account:String}, {ledger:UInt32}, toUInt32(number), 0, toDateTime({close:UInt32}, 'UTC'),
              'USD', 'rIssuer', '1', toString(number), toFloat64(number), 'payment_destination'
         FROM numbers({n:UInt64})`,
      { account: HEAVY, ledger: HEAVY_LEDGER.index, close: HEAVY_LEDGER.close, n: ACCOUNT_PARTITION_ROWS_FLOOR },
    );

    await rangeIngest(new FixtureLedgerSource(CHAIN.map((l) => l.raw)), svc, ctx, {
      from: CHAIN_FIRST,
      to: CHAIN_LAST,
      ...FAST,
    });
    // What parser version 1 wrote: no rows in the AMM tables, no swaps among the exchanges, its version in `ledgers`.
    for (const table of AMM_TABLES) await svc.command(`DELETE FROM ${table} WHERE 1`, {}, SYNC_DELETE);
    for (const table of [Table.Exchanges, Table.AccountExchanges]) {
      await svc.command(`DELETE FROM ${table} WHERE amm_account != ''`, {}, SYNC_DELETE);
    }
    await svc.command(
      `ALTER TABLE ${Table.Ledgers} UPDATE parser_version = 1 WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}`,
      { first: CHAIN_FIRST, last: CHAIN_LAST },
      { settings: { mutations_sync: '2' } },
    );
    return svc;
  }

  const count = async (ch: ClickHouseService, table: Table, where = '1'): Promise<number> =>
    Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  /** The rates of the set of a day under one version, `currency/issuer` to the rate as it is stored. */
  async function storedRates(ch: ClickHouseService, day: string, version: number): Promise<Map<string, string>> {
    const rows = await ch.query<{ currency: string; issuer: string; rate: string }>(
      `SELECT currency, issuer, rate FROM ${Table.NativeRatesDaily}
        WHERE currency != '' AND day = {day:Date} AND version = {version:UInt64}`,
      { day, version },
    );
    return new Map(rows.map((r) => [`${r.currency}/${r.issuer}`, r.rate]));
  }

  /** What `rates_daily` would store for a day now: `dailyNativeRatesOfDay`, in the same shape as `storedRates`. */
  async function ratesNow(rates: RatesService, day: string): Promise<Map<string, string>> {
    const ofDay = await rates.dailyNativeRatesOfDay(new Date(`${day}T00:00:00Z`));
    return new Map([...ofDay.values()].map((r) => [`${r.asset.currency}/${r.asset.issuer ?? ''}`, r.rate.toString()]));
  }

  /** The trades the rollup set of an (account, day) under one version counts. */
  async function rolledTrades(ch: ClickHouseService, account: string, day: string, version: number): Promise<number> {
    const row = await ch.queryOne<{ n: number | string }>(
      `SELECT sum(count) AS n FROM ${Table.AccountTradesDaily}
        WHERE account = {account:String} AND day = {day:Date} AND version = {version:UInt64}`,
      { account, day, version },
    );
    return Number(row?.n ?? 0);
  }

  /** The version of the newest set of each hour in `hours`. */
  const versionsOfHours = async (ch: ClickHouseService, hours: number[]): Promise<Map<number, number>> =>
    new Map(
      [...(await pairHourSets(ch, Math.min(...hours), Math.max(...hours) + 3600))].map(([hour, set]) => [
        hour,
        set.version,
      ]),
    );

  /** The pair rows of an hour set under one version, of one source (the sentinel is not among them). */
  const hourRows = (ch: ClickHouseService, hour: number, version: number, source: 'book' | 'amm'): Promise<number> =>
    count(
      ch,
      Table.PairHourly,
      `hour = toDateTime(${hour}, 'UTC') AND version = ${version} AND source = '${source}' AND base_currency != ''`,
    );

  interface StoredSet {
    /** `total_amm_share` of the sentinel (null when not known). */
    total: string | null;
    /** The pairs of the set, `base/issuer counter/issuer`, with their `amm_share` and `amm_pool`. */
    pairs: Map<string, { share: string | null; pool: number | null }>;
  }

  /** The newest set (the rows of the highest version) of each filter of a period. */
  async function marketsSets(ch: ClickHouseService, period: string): Promise<Record<string, StoredSet>> {
    const sets: Record<string, StoredSet> = {};
    for (const amm of FILTERS) {
      const rows = await ch.query<{
        base_currency: string;
        base_issuer: string;
        counter_currency: string;
        counter_issuer: string;
        amm_share: string | null;
        amm_pool: number | string | null;
        total_amm_share: string | null;
      }>(
        `SELECT base_currency, base_issuer, counter_currency, counter_issuer, amm_share, amm_pool, total_amm_share
           FROM ${Table.MarketsLive}
          WHERE period = {period:String} AND amm = {amm:String}
            AND version = (SELECT max(version) FROM ${Table.MarketsLive} WHERE period = {period:String} AND amm = {amm:String})`,
        { period, amm },
      );
      const sentinel = rows.find((r) => r.base_currency === '' && r.counter_currency === '');
      sets[amm] = {
        total: sentinel?.total_amm_share ?? null,
        pairs: new Map(
          rows
            .filter((r) => r !== sentinel)
            .map((r) => [
              `${r.base_currency}/${r.base_issuer} ${r.counter_currency}/${r.counter_issuer}`,
              { share: r.amm_share, pool: r.amm_pool === null ? null : Number(r.amm_pool) },
            ]),
        ),
      };
    }
    return sets;
  }

  /** The values `syncer_markets_live_amm_share_known` was set to for a period, in order. */
  const gaugeOf = (metrics: FakeMetrics, period: string): number[] =>
    metrics.marketsLiveAmmShareKnown.set.mock.calls
      .filter(([labels]) => labels.period === period)
      .map(([, value]) => value);

  it('a reprocess from parser 1 to parser 2 marks the rates of its days stale and computes them with the swaps, recomputes the hours with amm rows and rolls the heavy account again', async () => {
    const ch = await parserOneWorld();
    const metrics = fakeMetrics();
    const { svc, errors } = aggregator(ch, metrics, GENEROUS);
    const rates = new RatesService(ch, 'XRP');

    let ticks = 0;
    const tick = async (): Promise<void> => {
      await svc.tick(NOW);
      ticks++;
    };
    /**
     * Ticks until `agg_dirty` is empty, and once more: `markets_live` runs before `stats_dirty`, so the hours a drain
     * recomputed are read by the sets of the next tick.
     */
    const settle = async (): Promise<void> => {
      let drained = false;
      for (let i = 0; i < 6 && !drained; i++) {
        await tick();
        drained = (await readDirtyRanges(ch, 10)).length === 0;
      }
      expect(drained).toBe(true);
      await tick();
    };

    // --- the world is what parser 1 wrote ---
    expect(
      await count(ch, Table.Ledgers, `ledger_index BETWEEN ${CHAIN_FIRST} AND ${CHAIN_LAST} AND parser_version = 1`),
    ).toBe(CHAIN_LEDGERS);
    expect(SWAPS_PER_LEDGER).toBeGreaterThan(0);
    expect(HEAVY_SWAPS_PER_LEDGER).toBeGreaterThan(0);
    expect(await count(ch, Table.Exchanges, "amm_account != ''")).toBe(0);
    expect(await count(ch, Table.AccountExchanges, "amm_account != ''")).toBe(0);
    for (const table of AMM_TABLES) expect([table, await count(ch, table)]).toEqual([table, 0]);

    // --- the aggregates of parser 1 ---
    await settle();
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();

    // the rates of the first day (the one that is over), without swaps
    const ratesBefore = await validRateDays(ch, DAY_1, DAY_2);
    expect([...ratesBefore.keys()]).toEqual([DAY_1]);
    const rateVersionBefore = ratesBefore.get(DAY_1) as number;
    expect(await rateSentinels(ch, DAY_1)).toEqual([[rateVersionBefore, 0]]);
    const ratesOfParserOne = await storedRates(ch, DAY_1, rateVersionBefore);
    expect(ratesOfParserOne.size).toBeGreaterThan(0);
    expect(ratesOfParserOne).toEqual(await ratesNow(rates, DAY_1));

    // the hours of the chain: no `amm` row anywhere
    const hoursBefore = await versionsOfHours(ch, CHAIN_HOURS);
    expect(hoursBefore.size).toBe(CHAIN_HOURS.length);
    expect(await count(ch, Table.PairHourly, "source = 'amm'")).toBe(0);
    const neighbourBefore = (await versionsOfHours(ch, [NEIGHBOUR_HOUR])).get(NEIGHBOUR_HOUR);
    expect(neighbourBefore).toBeDefined();
    for (const hour of CHAIN_HOURS)
      expect(await hourRows(ch, hour, hoursBefore.get(hour) as number, 'book')).toBeGreaterThan(0);

    // the heavy account's first day: rolled, with no swap in its trades
    const heavy = (await rollupStates(ch)).get(HEAVY);
    expect(heavy).toMatchObject({ firstDay: DAY_1, rolledFrom: DAY_1, rolledThrough: DAY_1 });
    const rollupBefore = await rollupSentinels(ch, HEAVY, DAY_1);
    expect(rollupBefore).toHaveLength(1);
    expect(await rolledTrades(ch, HEAVY, DAY_1, rollupBefore[0])).toBe(0);

    // the markets sets of the three periods have their pairs and no AMM field: the window holds ledgers of parser 1
    for (const period of PERIODS) {
      const sets = await marketsSets(ch, period);
      expect([period, sets.include.pairs.size > 0, sets.only.pairs.size]).toEqual([period, true, 0]);
      for (const filter of FILTERS) {
        expect([period, filter, sets[filter].total]).toEqual([period, filter, null]);
        for (const [pair, { share, pool }] of sets[filter].pairs)
          expect([period, filter, pair, share, pool]).toEqual([period, filter, pair, null, null]);
      }
      expect(gaugeOf(metrics, period).length).toBeGreaterThan(0);
      expect([period, ...new Set(gaugeOf(metrics, period))]).toEqual([period, 0]);
    }

    // --- the reprocess ---
    metrics.marketsLiveAmmShareKnown.set.mockClear();
    const result = await rangeIngest(new FixtureLedgerSource(CHAIN.map((l) => l.raw)), ch, ctx, {
      from: CHAIN_FIRST,
      to: CHAIN_LAST,
      reprocess: true,
      ...FAST,
    });
    expect(result.ledgers).toBe(CHAIN_LEDGERS);
    expect(
      await count(
        ch,
        Table.Ledgers,
        `ledger_index BETWEEN ${CHAIN_FIRST} AND ${CHAIN_LAST} AND parser_version = ${PARSER_VERSION}`,
      ),
    ).toBe(CHAIN_LEDGERS);
    expect(await count(ch, Table.Exchanges, "amm_account != ''")).toBe(CHAIN_LEDGERS * SWAPS_PER_LEDGER);
    expect(await readDirtyRanges(ch, 10)).toHaveLength(1);

    // the range is drained within a few ticks; then a tick that makes the long periods again. The markets runner counts its
    // runs from its first tick and makes them on the 1st, 6th, 11th ... (`MARKETS_LONG_EVERY_TICKS`): `ticks` counts the
    // same runs, as this aggregator ticks only through `tick()`, so the run after a multiple of it is a long one
    await settle();
    while (ticks % MARKETS_LONG_EVERY_TICKS !== 0) await tick();
    await tick();
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    expect(await readDirtyRanges(ch, 10)).toEqual([]);

    // --- the rates of the first day: marked stale, then computed again with the swaps ---
    const sentinels = await rateSentinels(ch, DAY_1);
    expect(sentinels.map(([, stale]) => stale)).toEqual([0, 1, 0]);
    expect(sentinels[0][0]).toBe(rateVersionBefore);
    expect(sentinels[1][0]).toBeGreaterThan(sentinels[0][0]);
    expect(sentinels[2][0]).toBeGreaterThan(sentinels[1][0]);
    expect([...(await validRateDays(ch, DAY_1, DAY_2))]).toEqual([[DAY_1, sentinels[2][0]]]);
    const ratesAfter = await storedRates(ch, DAY_1, sentinels[2][0]);
    expect(ratesAfter).toEqual(await ratesNow(rates, DAY_1));
    // the assets the swaps trade have rates now (the order-book ones are in both)
    expect(ratesAfter.size).toBeGreaterThan(ratesOfParserOne.size);

    // --- the hours of the chain: recomputed, with `amm` rows beside the `book` ones; the hour before it is not ---
    const hoursAfter = await versionsOfHours(ch, CHAIN_HOURS);
    for (const hour of CHAIN_HOURS) {
      const version = hoursAfter.get(hour) as number;
      expect([hour, version > (hoursBefore.get(hour) as number)]).toEqual([hour, true]);
      expect([hour, (await hourRows(ch, hour, version, 'amm')) > 0]).toEqual([hour, true]);
      expect([hour, (await hourRows(ch, hour, version, 'book')) > 0]).toEqual([hour, true]);
    }
    expect((await versionsOfHours(ch, [NEIGHBOUR_HOUR])).get(NEIGHBOUR_HOUR)).toBe(neighbourBefore);
    expect(await count(ch, Table.PairHourly, `source = 'amm' AND hour < toDateTime(${CHAIN_START}, 'UTC')`)).toBe(0);

    // --- the heavy account's first day: rolled again, and its trades are counted with the swaps ---
    const rollupAfter = await rollupSentinels(ch, HEAVY, DAY_1);
    expect(rollupAfter).toHaveLength(2);
    expect(rollupAfter[1]).toBeGreaterThan(rollupBefore[0]);
    expect(await rolledTrades(ch, HEAVY, DAY_1, rollupAfter[1])).toBe(HEAVY_SWAPS_PER_LEDGER * CHAIN_LEDGERS_OF_DAY_1);
    expect(
      await count(ch, Table.AccountExchanges, `account = '${HEAVY}' AND toDate(close_time, 'UTC') = '${DAY_1}'`),
    ).toBe(HEAVY_SWAPS_PER_LEDGER * CHAIN_LEDGERS_OF_DAY_1);
    expect((await rollupStates(ch)).get(HEAVY)).toMatchObject({ rolledFrom: DAY_1, rolledThrough: DAY_1 });

    // --- the markets sets: the AMM fields are there, and so is the gauge ---
    for (const period of PERIODS) {
      const sets = await marketsSets(ch, period);
      for (const filter of FILTERS) {
        expect([period, filter, sets[filter].total === null]).toEqual([period, filter, false]);
        // (`amm_pool` is only checked to be present: the `amm_pools` job is not run here, so every flag is 0)
        for (const [pair, { share, pool }] of sets[filter].pairs) {
          expect([period, filter, pair, share !== null, pool !== null]).toEqual([period, filter, pair, true, true]);
        }
      }
      expect([period, sets.only.pairs.size > 0]).toEqual([period, true]);
      expect([period, Number(sets.include.total) > 0]).toEqual([period, true]);
      // each pair is all swaps or all order book: share 1 in `only`, 0 in `exclude`, that of its set in `include`
      expect([...sets.include.pairs.keys()].sort()).toEqual(
        [...sets.exclude.pairs.keys(), ...sets.only.pairs.keys()].sort(),
      );
      for (const [pair, { share }] of sets.exclude.pairs)
        expect([period, pair, share]).toEqual([period, pair, '0.0000']);
      for (const [pair, { share }] of sets.only.pairs) expect([period, pair, share]).toEqual([period, pair, '1.0000']);
      for (const [pair, { share }] of sets.include.pairs) {
        expect([period, pair, share]).toEqual([period, pair, sets.only.pairs.has(pair) ? '1.0000' : '0.0000']);
      }
      expect([period, gaugeOf(metrics, period).pop()]).toEqual([period, 1]);
    }
  });
});

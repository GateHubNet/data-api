import BigNumber from 'bignumber.js';
import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import {
  computePairHourSets,
  PAIR_HOURLY_CONFIG_VERSION,
  PAIR_HOURLY_DAYS,
  pairHourSets,
} from '../src/aggregate/pair-hourly.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow, PairHourlyRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { Asset, canonicalPair } from '../src/query/asset';
import { sumOf } from '../src/query/decimal';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * The `pair_hourly` sets (`pair-hourly.job.ts`) on a real ClickHouse.
 *
 * The world is synthetic: ledgers and exchanges written straight into the tables, in three hours (3, 4 and 5) of
 * 2016-06-01 and one more ledger at 08:30:00, built so that every edge of an hourly candle is met: equal rates within an
 * hour (the key tells them apart), rates whose text sorts the other way than their value, several trades in one ledger
 * (told apart by their transaction and node), a trade at the first and one at the last second of an hour, the native
 * dust of 0.0005 on either side, a pair whose only trades in an hour are dust, and an amount of 1e40 that the exact
 * sums cannot hold. Some of the rows are swaps against a pool (`amm_account` set): in an hour that also has order-book
 * trades of the pair, in a pair of their own, and as native dust. An oracle written from the stored `exchanges` rows
 * says what every candle is, for each source apart.
 *
 * The hours are in 2016, long before the real clock of the ClickHouse server, so `pair_hourly` is stopped from merging
 * for TTL in each database the tests use (see `freshService`): its rows expire 45 days after their hour, and an expired
 * part would be dropped within milliseconds of its insert.
 */

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

/** Hour 0 of the world: 2016-06-01 00:00:00 UTC. */
const BASE = Date.UTC(2016, 5, 1) / SEC;
const hourAt = (hour: number): number => BASE + hour * HOUR;
const at = (hour: number, minute = 0, second = 0): number => BASE + hour * HOUR + minute * 60 + second;

const Wide = BigNumber.clone({ DECIMAL_PLACES: 200 });
const DUST = new BigNumber('0.0005');

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const issued = (currency: string): Asset => ({ currency, issuer: ISSUER });
const XRP: Asset = { currency: 'XRP' };

/** The pairs as they are stored (canonical order): USD sorts before the native currency, ZZZ after it. */
const USD_XRP = canonicalPair(issued('USD'), XRP); // the native currency is the counter
const XRP_ZZZ = canonicalPair(XRP, issued('ZZZ')); // the native currency is the base
const EUR_USD = canonicalPair(issued('EUR'), issued('USD'));
const BTC_USD = canonicalPair(issued('BTC'), issued('USD'));
const GBP_USD = canonicalPair(issued('GBP'), issued('USD')); // a pair of swaps only
type StoredPair = typeof USD_XRP;

const POOL_A = 'rPoolAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POOL_B = 'rPoolBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/**
 * A trade of a stored pair: its close time, its transaction and node, and its amounts as exact decimal text. A swap
 * against a pool has the pool's account; an order-book trade has none.
 */
interface Trade {
  pair: StoredPair;
  close: number;
  tx: number;
  node: number;
  base: string;
  counter: string;
  pool: string;
}
const trade = (
  pair: StoredPair,
  close: number,
  tx: number,
  node: number,
  base: string,
  counter: string,
  pool = '',
): Trade => ({
  pair,
  close,
  tx,
  node,
  base,
  counter,
  pool,
});
const swap = (
  pool: string,
  pair: StoredPair,
  close: number,
  tx: number,
  node: number,
  base: string,
  counter: string,
): Trade => trade(pair, close, tx, node, base, counter, pool);

function worldTrades(): Trade[] {
  return [
    // hour 3, the native currency as the base: every rate is 2.5, so the key tells the trades apart. The first ledger
    // (03:00:00, the first second of the hour) and the last (03:59:59) hold several trades each, told apart by (tx, node)
    trade(XRP_ZZZ, at(3, 0, 0), 9, 2, '20', '50'),
    trade(XRP_ZZZ, at(3, 0, 0), 2, 7, '4', '10'),
    trade(XRP_ZZZ, at(3, 0, 0), 2, 3, '8', '20'),
    trade(XRP_ZZZ, at(3, 30, 0), 4, 1, '10', '25'),
    trade(XRP_ZZZ, at(3, 59, 59), 1, 1, '6', '15'),
    trade(XRP_ZZZ, at(3, 59, 59), 1, 4, '2', '5'),
    // hour 3, rates 9, 100, 10, 100, 9 (the text of 9 sorts after the text of 100): the high and the low are each met
    // twice, in two ledgers, so the key picks (the ledger first, whatever the transaction index); the amounts are
    // decimals whose Float64 sum is not exact (0.1 + 0.2 + ...)
    trade(EUR_USD, at(3, 5, 0), 7, 1, '0.2', '1.8'),
    trade(EUR_USD, at(3, 15, 0), 5, 1, '0.1', '10'),
    trade(EUR_USD, at(3, 25, 0), 3, 2, '0.4', '4'),
    trade(EUR_USD, at(3, 35, 0), 3, 1, '0.3', '30'),
    trade(EUR_USD, at(3, 45, 0), 1, 1, '0.5', '4.5'),

    // hour 4, the native currency as the counter: dust (0.0005 or less) first and in the middle, kept trades from 0.00051
    trade(USD_XRP, at(4, 2, 0), 1, 1, '1000', '0.0005'),
    trade(USD_XRP, at(4, 3, 0), 1, 1, '1', '0.0004'),
    trade(USD_XRP, at(4, 4, 0), 1, 1, '1', '0.00051'),
    trade(USD_XRP, at(4, 30, 0), 1, 1, '2', '0.004'),
    trade(USD_XRP, at(4, 50, 0), 2, 1, '3', '0.0045'),
    // hour 4, the native currency as the base: one kept trade between two of dust
    trade(XRP_ZZZ, at(4, 10, 0), 1, 1, '0.0005', '3'),
    trade(XRP_ZZZ, at(4, 20, 0), 1, 1, '0.0006', '3'),
    trade(XRP_ZZZ, at(4, 40, 0), 1, 1, '0.0001', '3'),

    // hour 5: an amount of 1e40 (the exact sums hold amounts below 1e36)
    trade(BTC_USD, at(5, 10, 0), 1, 1, '1e+40', '5'),
    trade(BTC_USD, at(5, 20, 0), 1, 1, '2', '3'),
    trade(BTC_USD, at(5, 30, 0), 1, 1, '3.5', '1'),
    // hour 5: a pair whose only trade is dust has no row; one with a single trade is its own open, close, high and low
    trade(XRP_ZZZ, at(5, 5, 0), 1, 1, '0.0005', '3'),
    trade(EUR_USD, at(5, 59, 59), 1, 1, '7', '14'),
  ];
}

/**
 * The swaps of the world, in the hours and pairs of its order-book trades and apart from them:
 *  - XRP/ZZZ in hour 3 (six order-book trades, all of rate 2.5): three swaps of the rates 2, 3 and 3.5, two pools, the
 *    first in the ledger of 03:00:00 that holds order-book trades too;
 *  - EUR/USD in hour 5 (one order-book trade, at 05:59:59): a swap in the same ledger;
 *  - GBP/USD, a pair of swaps only: three in hour 4 (the rates 1.2, 1.5 and 1.2) and one in hour 5;
 *  - native dust: the base of 0.0005 in XRP/ZZZ in hour 4 (which has a kept order-book trade), the counter of 0.0004 in
 *    USD/XRP in hour 4, and the base of 0.0003 in XRP/ZZZ in hour 5 (whose only other trade is dust too).
 */
function worldSwaps(): Trade[] {
  return [
    swap(POOL_A, XRP_ZZZ, at(3, 0, 0), 5, 1, '4', '8'),
    swap(POOL_A, XRP_ZZZ, at(3, 10, 0), 1, 1, '5', '15'),
    swap(POOL_B, XRP_ZZZ, at(3, 40, 0), 3, 2, '10', '35'),
    swap(POOL_B, EUR_USD, at(5, 59, 59), 2, 1, '3', '9'),
    swap(POOL_B, GBP_USD, at(4, 6, 0), 1, 1, '10', '12'),
    swap(POOL_B, GBP_USD, at(4, 16, 0), 1, 1, '10', '15'),
    swap(POOL_B, GBP_USD, at(4, 26, 0), 1, 1, '10', '12'),
    swap(POOL_B, GBP_USD, at(5, 40, 0), 1, 1, '1', '1.1'),
    swap(POOL_A, XRP_ZZZ, at(4, 15, 0), 1, 1, '0.0005', '3'),
    swap(POOL_A, USD_XRP, at(4, 20, 0), 1, 1, '2', '0.0004'),
    swap(POOL_A, XRP_ZZZ, at(5, 6, 0), 1, 1, '0.0003', '2'),
  ];
}

/** The ledgers with no trade in them: the newest ledger of the world closes at 08:30:00. */
const EXTRA_LEDGERS = [at(8, 30, 0)];

function exchangeRowsOf(trades: Trade[], ledgerOf: Map<number, number>): ExchangesRow[] {
  return trades.map((t, i) => {
    const rate = new Wide(t.counter).dividedBy(t.base);
    return {
      ...SAMPLE_ROWS[Table.Exchanges],
      base_currency: t.pair.base.currency,
      base_issuer: t.pair.base.issuer ?? '',
      counter_currency: t.pair.counter.currency,
      counter_issuer: t.pair.counter.issuer ?? '',
      ledger_index: ledgerOf.get(t.close) as number,
      tx_index: t.tx,
      node_index: t.node,
      tx_hash: `${i}`.padStart(64, 'E'),
      // the sample row is a swap: an order-book trade has no pool
      amm_account: t.pool,
      close_time: t.close,
      base_amount: t.base,
      counter_amount: t.counter,
      base_amount_f: Number(t.base),
      counter_amount_f: Number(t.counter),
      rate: rate.toString(),
      rate_f: rate.toNumber(),
    };
  });
}

/** Writes a ledger for every second that has a trade (and the given ledgers) and the trades; returns the exchange rows. */
async function seedWorld(
  ch: ClickHouseService,
  trades: Trade[] = [...worldTrades(), ...worldSwaps()],
  ledgers: number[] = EXTRA_LEDGERS,
): Promise<ExchangesRow[]> {
  const closes = [...new Set([...trades.map((t) => t.close), ...ledgers])].sort((a, b) => a - b);
  const ledgerOf = new Map(closes.map((close, i) => [close, 2000 + i * 3]));
  await writeLedgers(ch, closes, ledgerOf);
  // the rows go in backwards: the order they are written in tells nothing about the order of their keys
  const rows = exchangeRowsOf(trades, ledgerOf);
  await ch.insert(Table.Exchanges, [...rows].reverse());
  return rows;
}

async function writeLedgers(ch: ClickHouseService, closes: number[], ledgerOf: Map<number, number>): Promise<void> {
  await ch.insert(
    Table.Ledgers,
    closes.map((close) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: ledgerOf.get(close) as number,
      ledger_hash: `${ledgerOf.get(close)}`.padStart(64, 'C'),
      close_time: close,
    })),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: what the stored rows say, in plain JavaScript.
// ---------------------------------------------------------------------------------------------------------------------

/** The candle of an hour and pair, as the table holds it (the sums as exact text, the Float64 sums apart). */
interface Candle {
  hour: number;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  source: 'book' | 'amm';
  count: number;
  unfit: number;
  base_sum: string;
  counter_sum: string;
  open_rate: string;
  open_ledger: number;
  open_tx: number;
  open_node: number;
  open_time: number;
  close_rate: string;
  close_ledger: number;
  close_tx: number;
  close_node: number;
  close_time: number;
  high_rate: string;
  high_rate_f: number;
  high_ledger: number;
  high_tx: number;
  high_node: number;
  low_rate: string;
  low_rate_f: number;
  low_ledger: number;
  low_tx: number;
  low_node: number;
}
interface FloatSums {
  base_sum_f: number;
  counter_sum_f: number;
}

const byKey = (a: ExchangesRow, b: ExchangesRow): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;

/** A swap against a pool is source amm, an order-book trade source book. */
const sourceOf = (r: ExchangesRow): 'book' | 'amm' => (r.amm_account !== '' ? 'amm' : 'book');

/** Both native legs above the dust: a side without an issuer is native. */
const kept = (r: ExchangesRow): boolean =>
  (r.base_issuer !== '' || new BigNumber(r.base_amount).gt(DUST)) &&
  (r.counter_issuer !== '' || new BigNumber(r.counter_amount).gt(DUST));

/** An amount the exact sums hold whole: below 1e36 and with at most 30 decimal places. */
const fits = (amount: string): boolean =>
  new BigNumber(amount).lt('1e36') && (new BigNumber(amount).decimalPlaces() ?? 0) <= 30;

const sumOfAmounts = (amounts: string[]): string =>
  amounts
    .filter(fits)
    .reduce((sum, a) => sum.plus(a), new BigNumber(0))
    .toFixed();

function oracle(rows: ExchangesRow[]): Array<Candle & FloatSums> {
  const groups = new Map<string, ExchangesRow[]>();
  for (const r of rows.filter(kept)) {
    const hour = Math.floor(r.close_time / HOUR) * HOUR;
    const key = [hour, r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer, sourceOf(r)].join('|');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([, group]) => {
    const sorted = [...group].sort(byKey);
    const open = sorted[0];
    const close = sorted[sorted.length - 1];
    // the highest and the lowest rate by value; the first by key of equal ones (the list is sorted by key, and a strict
    // comparison keeps the first)
    const high = sorted.reduce((best, r) => (r.rate_f > best.rate_f ? r : best));
    const low = sorted.reduce((best, r) => (r.rate_f < best.rate_f ? r : best));
    return {
      hour: Math.floor(open.close_time / HOUR) * HOUR,
      base_currency: open.base_currency,
      base_issuer: open.base_issuer,
      counter_currency: open.counter_currency,
      counter_issuer: open.counter_issuer,
      source: sourceOf(open),
      count: group.length,
      unfit: group.filter((r) => !fits(r.base_amount) || !fits(r.counter_amount)).length,
      base_sum: sumOfAmounts(group.map((r) => r.base_amount)),
      counter_sum: sumOfAmounts(group.map((r) => r.counter_amount)),
      base_sum_f: group.reduce((s, r) => s + r.base_amount_f, 0),
      counter_sum_f: group.reduce((s, r) => s + r.counter_amount_f, 0),
      open_rate: open.rate,
      open_ledger: open.ledger_index,
      open_tx: open.tx_index,
      open_node: open.node_index,
      open_time: open.close_time,
      close_rate: close.rate,
      close_ledger: close.ledger_index,
      close_tx: close.tx_index,
      close_node: close.node_index,
      close_time: close.close_time,
      high_rate: high.rate,
      high_rate_f: high.rate_f,
      high_ledger: high.ledger_index,
      high_tx: high.tx_index,
      high_node: high.node_index,
      low_rate: low.rate,
      low_rate_f: low.rate_f,
      low_ledger: low.ledger_index,
      low_tx: low.tx_index,
      low_node: low.node_index,
    };
  });
}

const candleOrder = (a: Candle, b: Candle): number =>
  a.hour - b.hour ||
  (a.base_currency + a.counter_currency < b.base_currency + b.counter_currency
    ? -1
    : a.base_currency + a.counter_currency > b.base_currency + b.counter_currency
      ? 1
      : 0) ||
  (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------

/** A stored row with the times as unix seconds and the 64-bit numbers as numbers. */
type Stored = Omit<PairHourlyRow, 'count' | 'version' | 'source'> & { count: number; version: number; source: string };

describe('the pair_hourly sets (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A migrated database of its own, with the TTL merges of `pair_hourly` stopped (the hours are far past its 45 days). */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `pair_hourly_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    await svc.command(`SYSTEM STOP TTL MERGES ${config.database}.${Table.PairHourly}`);
    return svc;
  }

  /** Keeps the parts of a table as they are written, so that rows written twice stay twice. */
  async function stopMerges(ch: ClickHouseService, table: Table): Promise<void> {
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await ch.command(`SYSTEM STOP MERGES ${database}.${table}`);
  }

  /** Every row of `pair_hourly` with these conditions (all of them without), in the order of the key and then the version. */
  async function storedRows(where = '1', params: Record<string, unknown> = {}): Promise<Stored[]> {
    const rows = await ch().query<Record<string, unknown>>(
      `SELECT toUnixTimestamp(hour) AS hour_secs, base_currency, base_issuer, counter_currency, counter_issuer,
              toString(source) AS source_text, toUInt64(count) AS count_n, base_sum, counter_sum, unfit, base_sum_f,
              counter_sum_f, open_rate, open_ledger, open_tx, open_node, toUnixTimestamp(open_time) AS open_secs,
              close_rate, close_ledger, close_tx, close_node, toUnixTimestamp(close_time) AS close_secs,
              high_rate, high_rate_f, high_ledger, high_tx, high_node,
              low_rate, low_rate_f, low_ledger, low_tx, low_node,
              is_final, config_version, toUnixTimestamp(through_time) AS through_secs, toUInt64(version) AS version_n
         FROM ${Table.PairHourly}
        WHERE ${where}
        ORDER BY hour, base_currency, base_issuer, counter_currency, counter_issuer, source, version`,
      params,
    );
    return rows.map((r) => {
      const { hour_secs, source_text, count_n, open_secs, close_secs, through_secs, version_n, ...rest } = r;
      return {
        ...rest,
        hour: Number(hour_secs),
        source: source_text,
        count: Number(count_n),
        open_time: Number(open_secs),
        close_time: Number(close_secs),
        through_time: Number(through_secs),
        version: Number(version_n),
      } as unknown as Stored;
    });
  }

  /** The service of the test in progress. */
  let current: ClickHouseService;
  const ch = (): ClickHouseService => current;

  const isSentinel = (r: Stored): boolean =>
    r.base_currency === '' && r.base_issuer === '' && r.counter_currency === '' && r.counter_issuer === '';

  /** The pair rows of a read, as candles (the sums as exact text, the empty pair and the fields of the set left out). */
  function candlesOf(rows: Stored[]): Array<Candle & FloatSums> {
    return rows
      .filter((r) => !isSentinel(r))
      .map(({ source, is_final, config_version, through_time, version, base_sum, counter_sum, ...candle }) => ({
        ...candle,
        source: source as Candle['source'],
        base_sum: new BigNumber(base_sum).toFixed(),
        counter_sum: new BigNumber(counter_sum).toFixed(),
      }))
      .sort(candleOrder);
  }

  /** The candles of the table are those of the oracle: every field, the Float64 sums to their rounding. */
  function expectCandles(have: Array<Candle & FloatSums>, want: Array<Candle & FloatSums>): void {
    expect(have).toHaveLength(want.length);
    const sortedWant = [...want].sort(candleOrder);
    have.forEach((h, i) => {
      const { base_sum_f, counter_sum_f, ...exact } = h;
      const { base_sum_f: wantBase, counter_sum_f: wantCounter, ...wantExact } = sortedWant[i];
      expect(exact).toEqual(wantExact);
      expect(base_sum_f).toBeCloseTo(wantBase, 9);
      expect(counter_sum_f).toBeCloseTo(wantCounter, 9);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('the sets of a world of synthetic trades', () => {
    let rates: RatesService;
    let exchanges: ExchangesRow[];

    beforeEach(async () => {
      current = await freshService();
      exchanges = await seedWorld(current);
      rates = new RatesService(current, 'XRP');
    });

    const compute = (from: number, to: number, signal?: AbortSignal): Promise<number> =>
      computePairHourSets(current, rates, from, to, { signal });

    it('the constants are 2 and 31', () => {
      expect(PAIR_HOURLY_CONFIG_VERSION).toBe(2);
      expect(PAIR_HOURLY_DAYS).toBe(31);
    });

    it('the world has the shape the tests rely on', async () => {
      // 24 order-book trades and 11 swaps in 29 ledgers; the dust and the 1e40 are in the table
      expect(exchanges).toHaveLength(35);
      expect(exchanges.filter((r) => r.amm_account === '')).toHaveLength(24);
      expect(exchanges.filter((r) => r.amm_account !== '')).toHaveLength(11);
      expect(new Set(exchanges.map((r) => r.ledger_index)).size).toBe(29);
      expect(exchanges.filter((r) => !kept(r))).toHaveLength(8);
      expect(exchanges.filter((r) => r.base_amount === '1e+40')).toHaveLength(1);
      // trades on the first second of an hour (three in one ledger, with a swap) and on the last second of an hour
      expect(exchanges.filter((r) => r.close_time % HOUR === 0)).toHaveLength(4);
      expect(exchanges.filter((r) => r.close_time % HOUR === HOUR - 1)).toHaveLength(4);
      // the text of the rates 9 and 100 sorts the other way than their value
      expect(['9', '100'].sort()).toEqual(['100', '9']);
      // the oracle has 6 candles of the order book and 4 of swaps, in 3 hours
      expect(oracle(exchanges.filter((r) => r.amm_account === ''))).toHaveLength(6);
      expect(oracle(exchanges.filter((r) => r.amm_account !== ''))).toHaveLength(4);
      expect(oracle(exchanges)).toHaveLength(10);
    });

    it('every pair of an hour is its candle', async () => {
      expect(await compute(hourAt(3), hourAt(6))).toBe(3);

      const rows = await storedRows();
      expectCandles(candlesOf(rows), oracle(exchanges));
      // one sentinel for each of the three hours
      expect(rows.filter(isSentinel).map((r) => r.hour)).toEqual([hourAt(3), hourAt(4), hourAt(5)]);

      // by hand, so that the oracle and the job cannot share a mistake. XRP/ZZZ in hour 3: six trades of rate 2.5, in
      // three ledgers. The first by key opens (the ledger of 03:00:00 holds three: (2, 3) is the first of them) and
      // the last closes ((1, 4) of the ledger of 03:59:59); the first of the equal rates is both high and low
      const ledgerAt = async (t: number): Promise<number> =>
        (
          await ch().query<{ ledger_index: number }>(
            `SELECT ledger_index FROM ${Table.Ledgers} WHERE close_time = toDateTime({t:UInt32}, 'UTC')`,
            { t },
          )
        )[0].ledger_index;
      const [ledger0300, ledger0359] = [await ledgerAt(at(3, 0, 0)), await ledgerAt(at(3, 59, 59))];
      const [zzz] = candlesOf(rows).filter(
        (c) => c.counter_currency === 'ZZZ' && c.hour === hourAt(3) && c.source === 'book',
      );
      expect(zzz).toMatchObject({
        count: 6,
        base_sum: '50',
        counter_sum: '125',
        open_rate: '2.5',
        open_ledger: ledger0300,
        open_tx: 2,
        open_node: 3,
        open_time: at(3, 0, 0),
        close_rate: '2.5',
        close_ledger: ledger0359,
        close_tx: 1,
        close_node: 4,
        close_time: at(3, 59, 59),
        high_rate: '2.5',
        high_rate_f: 2.5,
        high_ledger: ledger0300,
        high_tx: 2,
        high_node: 3,
        low_rate: '2.5',
        low_rate_f: 2.5,
        low_ledger: ledger0300,
        low_tx: 2,
        low_node: 3,
      });

      // EUR/USD in hour 3: rates 9, 100, 10, 100, 9 in the order of the keys. The high (rate 100: by value, its text
      // sorts before that of 9) is the trade of the earlier ledger, though the later one has the lower transaction
      // index; so is the low (rate 9)
      const [eur] = candlesOf(rows).filter(
        (c) => c.base_currency === 'EUR' && c.hour === hourAt(3) && c.source === 'book',
      );
      expect(eur).toMatchObject({
        count: 5,
        base_sum: '1.5', // 0.2 + 0.1 + 0.4 + 0.3 + 0.5, which a Float64 sum does not give
        counter_sum: '50.3',
        open_rate: '9',
        open_time: at(3, 5, 0),
        open_tx: 7,
        close_rate: '9',
        close_time: at(3, 45, 0),
        close_tx: 1,
        high_rate: '100',
        high_rate_f: 100,
        high_tx: 5,
        low_rate: '9',
        low_rate_f: 9,
        low_tx: 7,
      });
      // the hour of a trade is the hour of its close time: 03:00:00 is hour 3, and 05:59:59 is hour 5
      expect(
        candlesOf(rows).find((c) => c.base_currency === 'EUR' && c.hour === hourAt(5) && c.source === 'book'),
      ).toMatchObject({
        count: 1,
        open_time: at(5, 59, 59),
        close_time: at(5, 59, 59),
        open_rate: '2',
        close_rate: '2',
        high_rate: '2',
        low_rate: '2',
      });
    });

    it('native dust (0.0005 or less) is left out', async () => {
      await compute(hourAt(3), hourAt(6));
      const candles = candlesOf(await storedRows());
      const at4 = (currency: string) =>
        candles.find((c) => c.hour === hourAt(4) && c.base_currency === currency && c.source === 'book');

      // the native counter: 5 trades, 2 of dust (0.0005 and 0.0004); the open is the first kept trade (rate 0.00051), and
      // the low is that rate, not the rates of the dust (5e-7 and 0.0004), which are lower
      expect(at4('USD')).toMatchObject({
        count: 3,
        base_sum: '6',
        counter_sum: '0.00901',
        open_rate: '0.00051',
        open_time: at(4, 4, 0),
        close_rate: '0.0015',
        close_time: at(4, 50, 0),
        high_rate: '0.002',
        low_rate: '0.00051',
      });
      // the native base: three trades, the kept one between two of dust
      expect(at4('XRP')).toMatchObject({
        count: 1,
        base_sum: '0.0006',
        counter_sum: '3',
        open_rate: '5000',
        close_rate: '5000',
        high_rate: '5000',
        low_rate: '5000',
        open_time: at(4, 20, 0),
      });
      // a pair whose only trade in the hour is dust has no row there (nor a count of 0)
      expect(candles.filter((c) => c.hour === hourAt(5) && c.base_currency === 'XRP')).toEqual([]);
      // and the dust is in the table, so that this proves something
      const dust = await ch().query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.Exchanges}
          WHERE amm_account = '' AND ((base_issuer = '' AND base_amount_f <= 0.0005)
             OR (counter_issuer = '' AND counter_amount_f <= 0.0005))`,
      );
      expect(Number(dust[0].n)).toBe(5);
    });

    it('a swap is source amm and an order-book trade source book: a pair with both in an hour has a row of each, each the candle of its own trades', async () => {
      await compute(hourAt(3), hourAt(6));
      const rows = await storedRows();
      const candles = candlesOf(rows);

      // each source is the oracle over the trades of that source alone
      const bookTrades = exchanges.filter((r) => r.amm_account === '');
      const swaps = exchanges.filter((r) => r.amm_account !== '');
      expectCandles(
        candles.filter((c) => c.source === 'book'),
        oracle(bookTrades),
      );
      expectCandles(
        candles.filter((c) => c.source === 'amm'),
        oracle(swaps),
      );
      // a pair, an hour and a source have one row
      const keys = candles.map((c) => [c.hour, c.base_currency, c.counter_currency, c.source].join('|'));
      expect(new Set(keys).size).toBe(keys.length);

      // by hand, so that the oracle and the job cannot share a mistake. XRP/ZZZ in hour 3 has six order-book trades of
      // rate 2.5 (see 'every pair of an hour is its candle') and three swaps, of the rates 2 (03:00:00, in a ledger
      // that holds order-book trades too), 3 (03:10:00) and 3.5 (03:40:00, another pool): a row of each source
      const xrpZzz = candles.filter((c) => c.counter_currency === 'ZZZ' && c.hour === hourAt(3));
      expect(xrpZzz.map((c) => c.source)).toEqual(['amm', 'book']);
      const [amm, book] = xrpZzz;
      expect(book).toMatchObject({
        count: 6,
        base_sum: '50',
        counter_sum: '125',
        open_rate: '2.5',
        open_tx: 2,
        open_node: 3,
        close_rate: '2.5',
        high_rate: '2.5',
        low_rate: '2.5',
      });
      expect(amm).toMatchObject({
        count: 3,
        base_sum: '19',
        counter_sum: '58',
        open_rate: '2',
        open_time: at(3, 0, 0),
        open_tx: 5,
        open_node: 1,
        close_rate: '3.5',
        close_time: at(3, 40, 0),
        close_tx: 3,
        close_node: 2,
        high_rate: '3.5',
        high_tx: 3,
        low_rate: '2',
        low_tx: 5,
      });
      expect(amm.base_sum_f).toBe(19);
      expect(amm.counter_sum_f).toBe(58);

      // EUR/USD in hour 5: its one order-book trade (rate 2) and its one swap (rate 3), in the same ledger
      const eurUsd = candles.filter((c) => c.base_currency === 'EUR' && c.hour === hourAt(5));
      expect(eurUsd.map((c) => [c.source, c.count, c.open_rate])).toEqual([
        ['amm', 1, '3'],
        ['book', 1, '2'],
      ]);
      expect(eurUsd[0].open_ledger).toBe(eurUsd[1].open_ledger);

      // GBP/USD has swaps only: a row of source amm in hours 4 and 5, none of source book. Hour 4: the rates 1.2, 1.5,
      // 1.2; the low is the first of the two equal rates, by key
      const gbp = candles.filter((c) => c.base_currency === 'GBP');
      expect(gbp.map((c) => [c.hour, c.source, c.count])).toEqual([
        [hourAt(4), 'amm', 3],
        [hourAt(5), 'amm', 1],
      ]);
      expect(gbp[0]).toMatchObject({
        base_sum: '30',
        counter_sum: '39',
        open_rate: '1.2',
        open_time: at(4, 6, 0),
        close_rate: '1.2',
        close_time: at(4, 26, 0),
        high_rate: '1.5',
        low_rate: '1.2',
      });
      expect(gbp[0].low_ledger).toBe(gbp[0].open_ledger);
      expect(gbp[0].high_ledger).toBeGreaterThan(gbp[0].open_ledger);
    });

    it('a native-dust swap is left out like a dust trade', async () => {
      await compute(hourAt(3), hourAt(6));
      const candles = candlesOf(await storedRows());
      const sourcesOf = (hour: number, base: string): string[] =>
        candles.filter((c) => c.hour === hourAt(hour) && c.base_currency === base).map((c) => c.source);

      // the dust swaps are in the table, so that this proves something: a native leg of 0.0005 or less
      const dust = await ch().query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.Exchanges}
          WHERE amm_account != '' AND ((base_issuer = '' AND base_amount_f <= 0.0005)
             OR (counter_issuer = '' AND counter_amount_f <= 0.0005))`,
      );
      expect(Number(dust[0].n)).toBe(3);

      // XRP/ZZZ in hour 4 has a kept order-book trade and a swap of native dust (0.0005): a row of source book only
      expect(sourcesOf(4, 'XRP')).toEqual(['book']);
      // USD/XRP in hour 4: a swap with 0.0004 of the native counter is left out, the order-book trades stay
      expect(sourcesOf(4, 'USD')).toEqual(['book']);
      // XRP/ZZZ in hour 5: its order-book trade and its swap are both dust, so the pair has no row at all
      expect(sourcesOf(5, 'XRP')).toEqual([]);
      // of the 11 swaps, the 8 of kept amounts are counted
      expect(candles.filter((c) => c.source === 'amm').reduce((n, c) => n + c.count, 0)).toBe(8);
    });

    it('an amount the exact sums cannot hold makes the hour unfit, with its Float64 sums', async () => {
      await compute(hourAt(3), hourAt(6));
      const candles = candlesOf(await storedRows());
      const btc = candles.find((c) => c.base_currency === 'BTC') as Candle & FloatSums;
      expect(btc).toMatchObject({ hour: hourAt(5), count: 3, unfit: 1 });
      // the exact sums leave the amount out; the Float64 sums hold it, and a reader takes them (sumOf)
      expect(btc.base_sum).toBe('5.5');
      expect(btc.counter_sum).toBe('9');
      expect(btc.base_sum_f).toBe(1e40);
      expect(btc.counter_sum_f).toBe(9);
      expect(sumOf(btc.unfit, btc.base_sum, btc.base_sum_f).toNumber()).toBe(1e40);
      // no other pair is unfit
      expect(candles.filter((c) => c.base_currency !== 'BTC').map((c) => c.unfit)).toEqual(Array(9).fill(0));
      // the sums are plain decimal text, as ClickHouse wrote them
      for (const r of await storedRows()) {
        expect(r.base_sum).toMatch(/^\d+(\.\d+)?$/);
        expect(r.counter_sum).toMatch(/^\d+(\.\d+)?$/);
      }
    });

    it('a UTC day is one read of exchanges and 24 sets', async () => {
      await stopMerges(current, Table.PairHourly);
      const queries = jest.spyOn(current, 'query');
      const inserts = jest.spyOn(current, 'insert');
      const before = Date.now();

      expect(await compute(hourAt(0), hourAt(24))).toBe(24);

      const calls = queries.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
      const onExchanges = calls.filter(({ sql }) => sql.includes(`FROM ${Table.Exchanges}`));
      expect(onExchanges).toHaveLength(1);
      // each row once; every value bound, the table names from the enum, no FINAL
      expect(onExchanges[0].sql).toMatch(
        /LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index/,
      );
      for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b|2016/);
      expect(onExchanges[0].params).toMatchObject({ min: expect.any(Number), max: expect.any(Number) });

      // one insert per hour, in order, each of one hour and one version
      expect(inserts).toHaveBeenCalledTimes(24);
      const sets = inserts.mock.calls.map(([table, rows]) => {
        expect(table).toBe(Table.PairHourly);
        const list = rows as PairHourlyRow[];
        expect(new Set(list.map((r) => r.hour)).size).toBe(1);
        expect(new Set(list.map((r) => r.version)).size).toBe(1);
        return list;
      });
      expect(sets.map((rows) => rows[0].hour)).toEqual(Array.from({ length: 24 }, (_, h) => hourAt(h)));
      for (const rows of sets) expect(Math.abs(Number(rows[0].version) - before)).toBeLessThan(5 * 60_000);

      // an hour without a trade has its sentinel and nothing else: 10 pair rows (6 of the order book and 4 of swaps) in
      // hours 3 to 5, 24 sentinels
      const stored = await storedRows();
      expect(stored).toHaveLength(34);
      expect(stored.filter(isSentinel).map((r) => r.hour)).toEqual(Array.from({ length: 24 }, (_, h) => hourAt(h)));
      expect(sets.map((rows) => rows.length)).toEqual([...Array(3).fill(1), 4, 4, 5, ...Array(18).fill(1)]);
      // each set is one part: a reader sees all of it or none
      const parts = await ch().query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active ORDER BY rows`,
        { table: Table.PairHourly },
      );
      expect(parts).toHaveLength(24);
      expect(parts.map((p) => Number(p.rows)).reduce((a, b) => a + b, 0)).toBe(34);
    });

    it("is_final: once a ledger closed at or after the hour's end; through_time is the close time of the hour's newest ledger, or the hour's start when the hour has none", async () => {
      await compute(hourAt(0), hourAt(24));
      const sets = await pairHourSets(current, hourAt(0), hourAt(24));
      expect(sets.size).toBe(24);

      // the newest ledger closed at 08:30:00: the hours up to 7 have ended before it, hour 8 and the rest have not
      for (let h = 0; h < 24; h++) {
        expect([h, sets.get(hourAt(h))?.final]).toEqual([h, h <= 7]);
      }
      // the close time of the newest ledger of the hour (the trades close ledgers: 03:59:59, 04:50:00, 05:59:59, and the
      // ledger of 08:30:00 without a trade), the start of an hour with no ledger
      const through = (h: number): number | undefined => sets.get(hourAt(h))?.throughTime;
      expect(through(3)).toBe(at(3, 59, 59));
      expect(through(4)).toBe(at(4, 50, 0));
      expect(through(5)).toBe(at(5, 59, 59));
      expect(through(8)).toBe(at(8, 30, 0));
      for (const h of [0, 1, 2, 6, 7, 9, 23]) expect([h, through(h)]).toEqual([h, hourAt(h)]);
      for (const set of sets.values()) expect(set.configVersion).toBe(PAIR_HOURLY_CONFIG_VERSION);
    });

    it("the sentinel is source book, and every row carries the set's is_final, config_version (2) and through_time", async () => {
      await compute(hourAt(3), hourAt(9));
      const rows = await storedRows();
      expect(rows.length).toBeGreaterThan(6);
      expect(rows.filter(isSentinel)).toHaveLength(6);
      expect(new Set(rows.filter(isSentinel).map((r) => r.source))).toEqual(new Set(['book']));
      // the pair rows are of both sources
      expect(new Set(rows.filter((r) => !isSentinel(r)).map((r) => r.source))).toEqual(new Set(['book', 'amm']));
      const expected = new Map([
        [3, { is_final: 1, through_time: at(3, 59, 59) }],
        [4, { is_final: 1, through_time: at(4, 50, 0) }],
        [5, { is_final: 1, through_time: at(5, 59, 59) }],
        [6, { is_final: 1, through_time: hourAt(6) }],
        [7, { is_final: 1, through_time: hourAt(7) }],
        [8, { is_final: 0, through_time: at(8, 30, 0) }],
      ]);
      for (const [h, set] of expected) {
        const ofHour = rows.filter((r) => r.hour === hourAt(h));
        expect(ofHour.length).toBeGreaterThan(0);
        for (const r of ofHour)
          expect([h, r.is_final, r.config_version, r.through_time]).toEqual([h, set.is_final, 2, set.through_time]);
      }
      // the sentinel is the empty pair with zeros and empty rates, and its times are the hour
      const sentinel = rows.find((r) => isSentinel(r) && r.hour === hourAt(4)) as Stored;
      expect(sentinel).toMatchObject({
        source: 'book',
        count: 0,
        base_sum: '0',
        counter_sum: '0',
        unfit: 0,
        base_sum_f: 0,
        counter_sum_f: 0,
        open_rate: '',
        open_ledger: 0,
        open_tx: 0,
        open_node: 0,
        open_time: hourAt(4),
        close_rate: '',
        close_time: hourAt(4),
        high_rate: '',
        high_rate_f: 0,
        high_ledger: 0,
        low_rate: '',
        low_rate_f: 0,
        low_node: 0,
      });
    });

    it("pairHourSets gives each hour's newest set, and a set written twice once", async () => {
      await stopMerges(current, Table.PairHourly);
      await compute(hourAt(3), hourAt(6));
      const first = await pairHourSets(current, hourAt(0), hourAt(24));
      expect([...first.keys()]).toEqual([hourAt(3), hourAt(4), hourAt(5)]);
      const firstSet = first.get(hourAt(4)) as NonNullable<ReturnType<typeof first.get>>;
      expect(firstSet).toEqual({
        version: expect.any(Number),
        final: true,
        configVersion: PAIR_HOURLY_CONFIG_VERSION,
        throughTime: at(4, 50, 0),
      });

      // a set written twice (a second insert of the same rows, not deduplicated) counts once
      await current.command(
        `INSERT INTO ${Table.PairHourly} SELECT * FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
        { hour: hourAt(4) },
        { settings: { insert_deduplicate: 0 } },
      );
      expect(
        await storedRows("hour = toDateTime({hour:UInt32}, 'UTC') AND base_currency = ''", { hour: hourAt(4) }),
      ).toHaveLength(2);
      expect(await pairHourSets(current, hourAt(0), hourAt(24))).toEqual(first);

      // a recompute after a later ledger is a newer set, and it is the one that counts; the hours around it keep theirs
      const lastOfHour4 = (
        await ch().query<{ ledger_index: number }>(
          `SELECT max(ledger_index) AS ledger_index FROM ${Table.Ledgers} WHERE close_time < toDateTime({t:UInt32}, 'UTC')
            AND close_time >= toDateTime({from:UInt32}, 'UTC')`,
          { t: hourAt(5), from: hourAt(4) },
        )
      )[0].ledger_index;
      await writeLedgers(current, [at(4, 55, 0)], new Map([[at(4, 55, 0), lastOfHour4 + 1]]));
      await compute(hourAt(4), hourAt(5));
      const second = await pairHourSets(current, hourAt(0), hourAt(24));
      expect(second.get(hourAt(4))).toMatchObject({ final: true, throughTime: at(4, 55, 0) });
      expect((second.get(hourAt(4))?.version as number) > firstSet.version).toBe(true);
      expect(second.get(hourAt(3))).toEqual(first.get(hourAt(3)));
      expect(second.get(hourAt(5))).toEqual(first.get(hourAt(5)));
      // the two sets of hour 4 are in the table until a merge
      const versions = await ch().query<{ version: string }>(
        `SELECT DISTINCT toUInt64(version) AS version FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
        { hour: hourAt(4) },
      );
      expect(versions).toHaveLength(2);

      // the range is [from, to): hours outside it, and hours without a set, are not in it
      expect([...(await pairHourSets(current, hourAt(4), hourAt(5))).keys()]).toEqual([hourAt(4)]);
      expect([...(await pairHourSets(current, hourAt(4), hourAt(4))).keys()]).toEqual([]);
      expect([...(await pairHourSets(current, hourAt(6), hourAt(24))).keys()]).toEqual([]);
    });

    it('a version only goes up: a set from the future is beaten, and every hour has a version of its own', async () => {
      const future = Date.now() + 3_600_000;
      await current.insert(Table.PairHourly, [
        {
          ...SAMPLE_ROWS[Table.PairHourly],
          hour: hourAt(4),
          base_currency: '',
          base_issuer: '',
          counter_currency: '',
          counter_issuer: '',
          source: 'book',
          version: future,
        },
      ]);
      await compute(hourAt(4), hourAt(6));

      const sets = await pairHourSets(current, hourAt(4), hourAt(6));
      expect(sets.get(hourAt(4))?.version).toBe(future + 1);
      // hour 5 has no set before: the ClickHouse clock, which is well before the future of hour 4
      expect(sets.get(hourAt(5))?.version).toBeLessThan(future);
      expect(Math.abs((sets.get(hourAt(5))?.version as number) - Date.now())).toBeLessThan(5 * 60_000);
      // all the rows of the set of hour 4 have its version
      const rows = await storedRows("hour = toDateTime({hour:UInt32}, 'UTC') AND version > {old:UInt64}", {
        hour: hourAt(4),
        old: future,
      });
      expect(rows.length).toBeGreaterThan(1);
      expect(new Set(rows.map((r) => r.version))).toEqual(new Set([future + 1]));
    });

    it('a part of a day writes the sets of its hours only, from the trades of those hours only', async () => {
      const spy = jest.spyOn(current, 'query');
      expect(await compute(hourAt(4), hourAt(5))).toBe(1);
      // the read of the exchanges is of the ledgers of the hour: the first one that closed in it to the last one
      const [first, last] = await Promise.all(
        [at(4, 2, 0), at(4, 50, 0)].map(async (t) => {
          const [l] = await current.query<{ ledger_index: number }>(
            `SELECT ledger_index FROM ${Table.Ledgers} WHERE close_time = toDateTime({t:UInt32}, 'UTC')`,
            { t },
          );
          return l.ledger_index;
        }),
      );
      const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
      expect(reads).toHaveLength(1);
      expect(reads[0][1]).toEqual({ min: first, max: last });
      expect(String(reads[0][0])).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      const rows = await storedRows();
      expect(rows.filter(isSentinel).map((r) => r.hour)).toEqual([hourAt(4)]);
      expectCandles(
        candlesOf(rows),
        oracle(exchanges).filter((c) => c.hour === hourAt(4)),
      );
      expect(rows.map((r) => r.hour)).toEqual(Array(rows.length).fill(hourAt(4)));
    });

    it('rejects a range that is not whole hours of one UTC day', async () => {
      const queries = jest.spyOn(current, 'query');
      const inserts = jest.spyOn(current, 'insert');
      const bad: Array<[string, number, number]> = [
        ['a start that is not a whole hour', hourAt(3) + 1, hourAt(4)],
        ['an end that is not a whole hour', hourAt(3), hourAt(4) + 60],
        ['an empty range', hourAt(3), hourAt(3)],
        ['an end before the start', hourAt(4), hourAt(3)],
        ['two UTC days', hourAt(23), hourAt(25)],
        ['more than a day', hourAt(0) - HOUR, hourAt(24)],
        ['25 hours', hourAt(0), hourAt(25)],
        ['no number', NaN, hourAt(4)],
        ['infinity', hourAt(3), Infinity],
        ['a fraction of a second', hourAt(3) + 0.5, hourAt(4) + 0.5],
        ['a time before 1970', -HOUR, 0],
      ];
      for (const [label, from, to] of bad) {
        await expect([label, await computePairHourSets(current, rates, from, to).catch((e: unknown) => e)]).toEqual([
          label,
          expect.any(RangeError),
        ]);
      }
      // nothing was read and nothing was written
      expect(queries).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();

      // the hours of a day, the first one, the last one, and the whole day are fine
      expect(await compute(hourAt(0), hourAt(1))).toBe(1);
      expect(await compute(hourAt(23), hourAt(24))).toBe(1);
      expect(await compute(hourAt(22), hourAt(24))).toBe(2);
      expect(await compute(hourAt(0), hourAt(24))).toBe(24);
    });

    it('an aborted set writes nothing', async () => {
      const inserts = jest.spyOn(current, 'insert');
      const queries = jest.spyOn(current, 'query');

      // before the work: no read, no insert
      const aborted = new AbortController();
      aborted.abort();
      await expect(compute(hourAt(3), hourAt(6), aborted.signal)).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(queries).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();
      queries.mockRestore();

      // aborted while the sets are read: the check is made again right before the first insert
      const original = current.query.bind(current);
      const live = new AbortController();
      const spy = jest.spyOn(current, 'query').mockImplementation(async (sql, params, settings) => {
        const rows = await original(sql, params, settings);
        if (String(sql).includes(`FROM ${Table.Exchanges}`)) live.abort();
        return rows;
      });
      await expect(compute(hourAt(3), hourAt(6), live.signal)).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(inserts).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
      spy.mockRestore();

      // aborted between two sets: the set written whole stays, the next one is not written
      const between = new AbortController();
      const realInsert = ClickHouseService.prototype.insert.bind(current);
      inserts.mockImplementation(async (table, rows, opts) => {
        await realInsert(table, rows, opts);
        between.abort();
      });
      await expect(compute(hourAt(3), hourAt(6), between.signal)).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(inserts).toHaveBeenCalledTimes(1);
      expect([...new Set((await storedRows()).map((r) => r.hour))]).toEqual([hourAt(3)]);
    });

    it('works without a ledger in the range, and without any ledger at all', async () => {
      // the hours 9 to 11 have no ledger: sentinels only, not final (the newest ledger is at 08:30:00)
      expect(await compute(hourAt(9), hourAt(12))).toBe(3);
      const rows = await storedRows();
      expect(rows.map((r) => [r.hour, r.is_final, r.through_time, isSentinel(r)])).toEqual([
        [hourAt(9), 0, hourAt(9), true],
        [hourAt(10), 0, hourAt(10), true],
        [hourAt(11), 0, hourAt(11), true],
      ]);

      // a database without a ledger
      const empty = await freshService();
      expect(await computePairHourSets(empty, new RatesService(empty, 'XRP'), hourAt(3), hourAt(5))).toBe(2);
      const sets = await pairHourSets(empty, hourAt(0), hourAt(24));
      expect([...sets.entries()].map(([h, s]) => [h, s.final, s.throughTime])).toEqual([
        [hourAt(3), false, hourAt(3)],
        [hourAt(4), false, hourAt(4)],
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('is_final at the edge of an hour', () => {
    it("is final when a ledger closed at the hour's end, not one second before", async () => {
      const db = await freshService();
      current = db;
      const rates = new RatesService(db, 'XRP');
      // a ledger at 05:59:59: hour 5 is not over yet
      await writeLedgers(db, [at(5, 59, 59)], new Map([[at(5, 59, 59), 100]]));
      await computePairHourSets(db, rates, hourAt(4), hourAt(7));
      let sets = await pairHourSets(db, hourAt(4), hourAt(7));
      expect([...sets.entries()].map(([h, s]) => [h, s.final, s.throughTime])).toEqual([
        [hourAt(4), true, hourAt(4)],
        [hourAt(5), false, at(5, 59, 59)],
        [hourAt(6), false, hourAt(6)],
      ]);

      // a ledger at 06:00:00, the first second of hour 6: hour 5 ends there
      await writeLedgers(db, [at(6, 0, 0)], new Map([[at(6, 0, 0), 101]]));
      await computePairHourSets(db, rates, hourAt(4), hourAt(7));
      sets = await pairHourSets(db, hourAt(4), hourAt(7));
      expect([...sets.entries()].map(([h, s]) => [h, s.final, s.throughTime])).toEqual([
        [hourAt(4), true, hourAt(4)],
        [hourAt(5), true, at(5, 59, 59)],
        [hourAt(6), false, at(6, 0, 0)],
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rows written twice (a second insert without deduplication, the merges stopped)', () => {
    // `exchanges` is a ReplacingMergeTree and the sets never use FINAL, so until a merge a row can be there twice (the
    // syncer re-writes a ledger it is not sure about). Half of the ledgers are copied, so that the copies change the sums.
    it('counts each exchange once: the candles are those of the oracle', async () => {
      current = await freshService();
      const exchanges = await seedWorld(current);
      await stopMerges(current, Table.Exchanges);
      await current.command(
        `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index % 2 = 0`,
        {},
        { settings: { insert_deduplicate: 0 } },
      );
      const total = await current.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Exchanges}`);
      expect(Number(total[0].n)).toBeGreaterThan(exchanges.length + 5);
      // some swaps are there twice too, and they count once
      const swaps = exchanges.filter((r) => r.amm_account !== '');
      const copiedSwaps = swaps.filter((r) => r.ledger_index % 2 === 0);
      expect(copiedSwaps.length).toBeGreaterThan(2);
      const storedSwaps = await current.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.Exchanges} WHERE amm_account != ''`,
      );
      expect(Number(storedSwaps[0].n)).toBe(swaps.length + copiedSwaps.length);

      await computePairHourSets(current, new RatesService(current, 'XRP'), hourAt(3), hourAt(6));
      expectCandles(candlesOf(await storedRows()), oracle(exchanges));
    });
  });
});

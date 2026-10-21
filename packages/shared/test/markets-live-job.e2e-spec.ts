import BigNumber from 'bignumber.js';
import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import {
  computeMarketsSet,
  MARKETS_PERIOD_HOURS,
  MARKETS_PERIODS,
  MarketsPeriod,
  marketsSetEndTimes,
  MarketsSetOutcome,
  SPARKLINE_DAYS,
} from '../src/aggregate/markets-live.job';
import { computePairHourSets, PAIR_HOURLY_CONFIG_VERSION } from '../src/aggregate/pair-hourly.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow, PairHourlyRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { Asset, canonicalPair } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { marketsOracle, OracleMarket, OracleSet } from './markets-oracle';
import { SAMPLE_ROWS } from './sample-rows';
import { Wide } from './volume-oracle';

/**
 * The `markets_live` sets (`markets-live.job.ts`) on a real ClickHouse.
 *
 * The world is synthetic: 32 days of trades (from 2016-06-01 to 2016-07-02 10:42:17, the close time of the newest ledger)
 * written straight into `ledgers` and `exchanges`, then the hour sets of `pair_hourly` by `computePairHourSets`, and the
 * markets set by `computeMarketsSet`. The pairs are chosen so that every route to a native volume is met (a native side;
 * the base's rate, the counter's rate, no rate; two issuers of one currency, one with a rate), with equal rates (the keys
 * tell them apart), a 1e40 amount the exact sums cannot hold, native dust, trades on both edges of every window, and pairs
 * that traded only in the middle of the 30 days, only in the days before the 7 of the sparkline, or on two of them. An
 * oracle written from the stored `exchanges` rows (`markets-oracle.ts`) says what every market is.
 *
 * The hours are in 2016, long before the real clock of the ClickHouse server, so `pair_hourly` is stopped from merging for
 * TTL in each database the tests use (see `freshService`): its rows expire 45 days after their hour, and an expired part
 * would be dropped within milliseconds of its insert.
 */

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

/** Day 0 of the world: 2016-06-01 00:00:00 UTC. */
const BASE = Date.UTC(2016, 5, 1) / SEC;
const dayAt = (day: number, hour = 0, minute = 0, second = 0): number =>
  BASE + day * DAY + hour * HOUR + minute * 60 + second;
/** The newest ledger of the world, and so t: 2016-07-02 10:42:17. */
const NOW = dayAt(31, 10, 42, 17);
const CURRENT_HOUR = dayAt(31, 10);
/** The hours of the three periods. */
const PERIOD_HOURS: Record<MarketsPeriod, number> = { day: 24, '7day': 168, '30day': 720 };

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ISSUER2 = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const issued = (currency: string, issuer = ISSUER): Asset => ({ currency, issuer });
const XRP: Asset = { currency: 'XRP' };

/** The pairs as they are stored (canonical order): the native currency sorts between USD and ZZZ. */
const USD_XRP = canonicalPair(issued('USD'), XRP); // the native currency is the counter
const XRP_ZZZ = canonicalPair(XRP, issued('ZZZ')); // the native currency is the base
const USD_ZZZ = canonicalPair(issued('USD'), issued('ZZZ')); // both have a rate
const EUR_USD = canonicalPair(issued('EUR'), issued('USD')); // the EUR of ISSUER has no rate
const EUR_ZZZ = canonicalPair(issued('EUR'), issued('ZZZ'));
const BTC_EUR = canonicalPair(issued('BTC'), issued('EUR')); // neither has a rate
const BTC_USD = canonicalPair(issued('BTC'), issued('USD'));
const EUR2_XRP = canonicalPair(issued('EUR', ISSUER2), XRP); // the EUR of ISSUER2 has a rate, that of ISSUER has not
const GBP_XRP = canonicalPair(issued('GBP'), XRP);
const GBP_USD = canonicalPair(issued('GBP'), issued('USD'));
const JPY_USD = canonicalPair(issued('JPY'), issued('USD'));
const AUD_USD = canonicalPair(issued('AUD'), issued('USD'));
const CHF_USD = canonicalPair(issued('CHF'), issued('USD'));
const NZD_USD = canonicalPair(issued('NZD'), issued('USD'));
type StoredPair = typeof USD_XRP;

/**
 * A trade of a stored pair: its close time, its transaction and node, and its amounts as exact decimal text. Its rate is
 * the counter over the base, to 16 digits, unless the trade says what its text is.
 */
interface Trade {
  pair: StoredPair;
  close: number;
  tx: number;
  node: number;
  base: string;
  counter: string;
  rate?: string;
}
const trade = (pair: StoredPair, close: number, base: string, counter: string, tx = 1, node = 0): Trade => ({
  pair,
  close,
  tx,
  node,
  base,
  counter,
});

/** A small, fast, seeded generator (mulberry32): the same world every run. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A pair that trades in every hour of the days `fromDay` to `toDay`: up to `max` trades in an hour, each a base amount of
 * the list at a rate of the list (the counter is their product, exact), so that equal rates are everywhere.
 */
interface Stream {
  pair: StoredPair;
  max: number;
  bases: string[];
  rates: string[];
  fromDay?: number;
  toDay?: number;
}
const STREAMS: Stream[] = [
  { pair: USD_XRP, max: 3, bases: ['10', '20', '40', '100', '160'], rates: ['0.4', '0.5', '0.625', '0.8'] },
  { pair: XRP_ZZZ, max: 3, bases: ['4', '8', '10', '20', '50'], rates: ['2', '2.5', '4'] },
  { pair: USD_ZZZ, max: 2, bases: ['5', '10', '16', '40'], rates: ['4', '5', '6.25'] },
  { pair: EUR_USD, max: 2, bases: ['1', '2', '5', '8'], rates: ['9', '10', '12', '9.5'] },
  { pair: EUR_ZZZ, max: 1, bases: ['2', '4', '8'], rates: ['2.5', '5'] },
  { pair: BTC_EUR, max: 1, bases: ['0.5', '1', '2'], rates: ['20', '25'] },
  { pair: BTC_USD, max: 1, bases: ['0.5', '1', '2'], rates: ['20', '25'] },
  { pair: EUR2_XRP, max: 1, bases: ['5', '10', '20'], rates: ['0.5', '0.8'] },
  // days 20 to 23 only: in the 30 days, and not in the 7
  { pair: GBP_USD, max: 2, bases: ['10', '20'], rates: ['1.5', '2'], fromDay: 20, toDay: 23 },
];

/** The hours of the world: 0 to the one of the newest ledger (10:00 of day 31). */
const WORLD_HOURS = 31 * 24 + 11;

function randomTrades(): Trade[] {
  const next = prng(20_160_601);
  const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)];
  const trades: Trade[] = [];
  for (let h = 0; h < WORLD_HOURS; h++) {
    const day = Math.floor(h / 24);
    for (const s of STREAMS) {
      const count = Math.floor(next() * (s.max + 1));
      if (day < (s.fromDay ?? 0) || day > (s.toDay ?? 31)) continue;
      for (let i = 0; i < count; i++) {
        // seconds 1 to 3599 of the hour (never the first: the trades on the edge of a window are the explicit ones, and
        // none ties with them); the current hour stops at 10:30, so that the newest ledger is the one at NOW
        const sec = 1 + Math.floor(next() * ((h === WORLD_HOURS - 1 ? 1800 : 3600) - 1));
        const base = pick(s.bases);
        trades.push(
          trade(
            s.pair,
            BASE + h * HOUR + sec,
            base,
            new BigNumber(base).times(pick(s.rates)).toFixed(),
            1 + Math.floor(next() * 4),
            Math.floor(next() * 3),
          ),
        );
      }
    }
  }
  return trades;
}

/** The trades that are the point of a test, not of chance. */
function explicitTrades(): Trade[] {
  const edges: Trade[] = [];
  for (const hours of Object.values(PERIOD_HOURS)) {
    const start = CURRENT_HOUR - hours * HOUR;
    // the last second before the window (not in it) and its first second (in it)
    edges.push(trade(EUR_USD, start - 1, '1', '99'), trade(EUR_USD, start, '1', '3'));
  }
  return [
    ...edges,
    // the trade of the newest ledger, at t: in every window
    trade(EUR_USD, NOW, '1', '11'),
    // JPY/USD traded on two of the 7 days only: 06-29 (day 28) and 06-30 (day 29). The last trade of day 28 is on the last
    // second of the day, the first of day 29 on its first second; on day 29 two trades share a ledger: the one of the
    // higher transaction index is the last
    trade(JPY_USD, dayAt(28, 6), '10', '40'),
    trade(JPY_USD, dayAt(28, 23, 59, 59), '10', '50'),
    trade(JPY_USD, dayAt(29, 0, 0, 0), '10', '60'),
    trade(JPY_USD, dayAt(29, 12), '10', '80', 5),
    trade(JPY_USD, dayAt(29, 18), '10', '90', 2),
    trade(JPY_USD, dayAt(29, 18), '10', '70', 3),
    // AUD/USD: the last second of the day before the 7 (06-25, day 24), and then day 27: the first of the 7 days has no close
    // before it among them, and the trade before them does not count
    trade(AUD_USD, dayAt(24, 23, 59, 59), '10', '30'),
    trade(AUD_USD, dayAt(27, 12), '10', '40'),
    // an amount the exact sums cannot hold (1e36 and more), in the last day: that pair's volumes are the Float64 sums
    trade(BTC_USD, dayAt(31, 5), '1e+40', '5'),
    // two rates of one pair that are the same Float64 (so that they tie as the highest and as the lowest) with texts that
    // differ, in two hours: the first trade by key is the high and the low
    { ...trade(NZD_USD, dayAt(31, 8, 10), '1', '1'), rate: '1.00000000000000001' },
    { ...trade(NZD_USD, dayAt(31, 9, 10), '1', '1'), rate: '1' },
    // every amount fits the exact sums (below 1e36), but the Float64 sum of the hour reaches 1e36 (3 * 4e35): the hour is not
    // an exact one, and the volume is the Float64 sum (1.2e36) though the exact sum would be one unit more
    trade(CHF_USD, dayAt(31, 6, 10), '4e+35', '4'),
    trade(CHF_USD, dayAt(31, 6, 20), '4e+35', '4'),
    trade(CHF_USD, dayAt(31, 6, 30), '4e+35', '4'),
    trade(CHF_USD, dayAt(31, 6, 40), '1', '1'),
    // native dust (0.0005 or less on a native side) is left out; 0.00051 is kept
    trade(USD_XRP, dayAt(31, 2, 10), '1000', '0.0005'),
    trade(USD_XRP, dayAt(31, 2, 20), '1', '0.0004'),
    trade(XRP_ZZZ, dayAt(31, 3, 10), '0.0005', '3'),
    trade(XRP_ZZZ, dayAt(31, 3, 20), '0.00051', '3'),
  ];
}

/** The trades of the world that closed at `from` or later (the small worlds start in the middle). */
function worldTrades(from = BASE): Trade[] {
  const all = [...randomTrades(), ...explicitTrades()].filter((t) => t.close >= from);
  // a row of exchanges is told by its pair and its key: no two trades may share one
  const seen = new Set<string>();
  return all.map((t) => {
    let node = t.node;
    const key = (): string => [t.pair.base.currency, t.pair.counter.currency, t.close, t.tx, node].join('|');
    while (seen.has(key())) node++;
    seen.add(key());
    return { ...t, node };
  });
}

function exchangeRowsOf(trades: Trade[], ledgerOf: Map<number, number>): ExchangesRow[] {
  return trades.map((t, i) => {
    const rate = new BigNumber(t.rate ?? new Wide(t.counter).dividedBy(t.base).precision(16));
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

/** Writes a ledger for every second that has a trade (and the given ledgers) and the trades; returns the exchange rows. */
async function seedWorld(ch: ClickHouseService, trades: Trade[], ledgers: number[] = []): Promise<ExchangesRow[]> {
  const closes = [...new Set([...trades.map((t) => t.close), ...ledgers])].sort((a, b) => a - b);
  // the ledger indexes go up with the close time, three apart: a ledger can be added between two
  const ledgerOf = new Map(closes.map((close, i) => [close, 2000 + i * 3]));
  await writeLedgers(ch, closes, ledgerOf);
  const rows = exchangeRowsOf(trades, ledgerOf);
  // the rows go in backwards: the order they are written in tells nothing about the order of their keys
  await ch.insert(Table.Exchanges, [...rows].reverse());
  return rows;
}

/** The hour sets of the hours `firstHour` to `lastHour` (both included, unix seconds of whole hours), a UTC day at a time. */
async function writeHourSets(ch: ClickHouseService, firstHour: number, lastHour: number): Promise<void> {
  const rates = new RatesService(ch, 'XRP');
  for (let from = firstHour; from <= lastHour; ) {
    const to = Math.min((Math.floor(from / DAY) + 1) * DAY, lastHour + HOUR);
    await computePairHourSets(ch, rates, from, to);
    from = to;
  }
}

/** The newest ledger index of the database, for a ledger that comes after it. */
async function newestLedgerIndex(ch: ClickHouseService): Promise<number> {
  return Number((await ch.query<{ n: string }>(`SELECT max(ledger_index) AS n FROM ${Table.Ledgers}`))[0].n);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the table holds.
// ---------------------------------------------------------------------------------------------------------------------

/** A stored row of `markets_live`: the times as unix seconds, the 64-bit numbers as numbers. */
interface Stored extends OracleMarket {
  period: string;
  amm: string;
  amm_share: string | null;
  amm_pool: number | null;
  start_time: number;
  end_time: number;
  pairs_traded: number;
  total_count: number;
  total_native_volume: string;
  total_amm_share: string | null;
  version: number;
}

interface StoredSet {
  version: number;
  sentinel: Stored;
  markets: Stored[];
}

const isSentinel = (r: Stored): boolean =>
  r.base_currency === '' && r.base_issuer === '' && r.counter_currency === '' && r.counter_issuer === '';

const READ_ROWS = `SELECT period, toString(amm) AS amm_filter, base_currency, base_issuer, counter_currency, counter_issuer,
              toUInt64(count) AS count_n, base_volume, counter_volume, native_volume, open, high, low, last,
              toUnixTimestamp(open_time) AS open_secs, toUnixTimestamp(last_time) AS last_secs, closes, amm_share,
              amm_pool, toUnixTimestamp(start_time) AS start_secs, toUnixTimestamp(end_time) AS end_secs, pairs_traded,
              toUInt64(total_count) AS total_n, total_native_volume, total_amm_share, toUInt64(version) AS version_n
         FROM ${Table.MarketsLive}`;

function storedOf(r: Record<string, unknown>): Stored {
  return {
    period: r.period as string,
    amm: r.amm_filter as string,
    base_currency: r.base_currency as string,
    base_issuer: r.base_issuer as string,
    counter_currency: r.counter_currency as string,
    counter_issuer: r.counter_issuer as string,
    count: Number(r.count_n),
    base_volume: r.base_volume as string,
    counter_volume: r.counter_volume as string,
    native_volume: r.native_volume as string | null,
    open: r.open as string,
    high: r.high as string,
    low: r.low as string,
    last: r.last as string,
    open_time: Number(r.open_secs),
    last_time: Number(r.last_secs),
    closes: r.closes as Array<string | null>,
    amm_share: r.amm_share as string | null,
    amm_pool: r.amm_pool as number | null,
    start_time: Number(r.start_secs),
    end_time: Number(r.end_secs),
    pairs_traded: Number(r.pairs_traded),
    total_count: Number(r.total_n),
    total_native_volume: r.total_native_volume as string,
    total_amm_share: r.total_amm_share as string | null,
    version: Number(r.version_n),
  };
}

/** The newest set of a period (filter `include`), as a reader takes it: the rows of the highest version. */
async function storedSet(ch: ClickHouseService, period: string): Promise<StoredSet | undefined> {
  const rows = (
    await ch.query<Record<string, unknown>>(
      `${READ_ROWS}
        WHERE period = {period:String} AND amm = 'include'
          AND version = (SELECT max(version) FROM ${Table.MarketsLive} WHERE period = {period:String} AND amm = 'include')
        ORDER BY base_currency, base_issuer, counter_currency, counter_issuer`,
      { period },
    )
  ).map(storedOf);
  if (rows.length === 0) return undefined;
  const sentinel = rows.find(isSentinel);
  if (!sentinel) throw new Error(`The newest set of ${period} has no sentinel`);
  return { version: sentinel.version, sentinel, markets: rows.filter((r) => !isSentinel(r)) };
}

const marketOf = (r: Stored): OracleMarket => ({
  base_currency: r.base_currency,
  base_issuer: r.base_issuer,
  counter_currency: r.counter_currency,
  counter_issuer: r.counter_issuer,
  count: r.count,
  base_volume: r.base_volume,
  counter_volume: r.counter_volume,
  native_volume: r.native_volume,
  open: r.open,
  high: r.high,
  low: r.low,
  last: r.last,
  open_time: r.open_time,
  last_time: r.last_time,
  closes: r.closes,
});

/** `USD/XRP`; the currency of the second issuer has a star: `EUR*`. */
const labelOf = (m: { base_currency: string; base_issuer: string; counter_currency: string }): string =>
  `${m.base_currency}${m.base_issuer === ISSUER2 ? '*' : ''}/${m.counter_currency}`;

/** The set the table holds is the oracle's: every market, and the sentinel with the window and the totals. */
function expectSet(have: StoredSet | undefined, want: OracleSet): void {
  expect(have).toBeDefined();
  const set = have as StoredSet;
  expect(set.markets.map(marketOf)).toEqual(want.markets);
  expect(set.sentinel).toMatchObject({
    start_time: want.start_time,
    end_time: want.end_time,
    pairs_traded: want.pairs_traded,
    total_count: want.total_count,
    total_native_volume: want.total_native_volume,
  });
  // every row carries the window of the set
  for (const r of [set.sentinel, ...set.markets])
    expect([r.start_time, r.end_time]).toEqual([want.start_time, want.end_time]);
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the markets_live sets (e2e)', () => {
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
    const config = { ...container.config, database: `markets_live_${++dbCounter}` };
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

  /** The markets set of a period at `now` (default NOW) for the native currency XRP. */
  const compute = (
    ch: ClickHouseService,
    period: MarketsPeriod,
    now = NOW,
    signal?: AbortSignal,
  ): Promise<MarketsSetOutcome> => computeMarketsSet(ch, 'XRP', period, new Date(now * SEC), { signal });

  const oracleOf = (exchanges: ExchangesRow[], period: MarketsPeriod, t = NOW): OracleSet =>
    marketsOracle(exchanges, 'XRP', PERIOD_HOURS[period], t);

  const marketsInserts = (spy: jest.SpyInstance): unknown[][] =>
    spy.mock.calls.filter(([table]: unknown[]) => table === Table.MarketsLive);

  // -------------------------------------------------------------------------------------------------------------------
  describe('the constants', () => {
    it('are the three periods, their hours and the 7 days of the sparkline', () => {
      expect([...MARKETS_PERIODS]).toEqual(['day', '7day', '30day']);
      expect(MARKETS_PERIOD_HOURS).toEqual({ day: 24, '7day': 168, '30day': 720 });
      expect(SPARKLINE_DAYS).toBe(7);
      expect(PAIR_HOURLY_CONFIG_VERSION).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a world of 32 days of trades', () => {
    let ch: ClickHouseService;
    let exchanges: ExchangesRow[];

    beforeAll(async () => {
      ch = await freshService();
      exchanges = await seedWorld(ch, worldTrades());
      await writeHourSets(ch, dayAt(0), CURRENT_HOUR);
    }, 900_000);

    it('the world has the shape the tests rely on', () => {
      expect(exchanges.length).toBeGreaterThan(3000);
      expect(Math.min(...exchanges.map((r) => r.close_time))).toBeLessThan(dayAt(1));
      expect(Math.max(...exchanges.map((r) => r.close_time))).toBe(NOW);
      const day = oracleOf(exchanges, 'day');
      const week = oracleOf(exchanges, '7day');
      const month = oracleOf(exchanges, '30day');
      const labels = (set: OracleSet): string[] => set.markets.map(labelOf);

      // JPY/USD and AUD/USD traded in the days before today, GBP/USD in days 20 to 23: each only in the periods that reach it
      expect(labels(day)).not.toContain('JPY/USD');
      for (const label of ['JPY/USD', 'AUD/USD']) {
        expect(labels(week)).toContain(label);
        expect(labels(month)).toContain(label);
      }
      expect(labels(week)).not.toContain('GBP/USD');
      expect(labels(month)).toContain('GBP/USD');
      expect(labels(day).length).toBeGreaterThanOrEqual(8);
      expect(week.markets.length).toBeGreaterThan(day.markets.length);
      expect(month.markets.length).toBeGreaterThan(week.markets.length);
      // every route to a native volume is met, and no rate gives none
      const natives = (set: OracleSet): Map<string, string | null> =>
        new Map(set.markets.map((m) => [labelOf(m), m.native_volume]));
      expect(natives(day).get('BTC/EUR')).toBeNull();
      for (const label of ['USD/XRP', 'XRP/ZZZ', 'USD/ZZZ', 'EUR/USD', 'EUR*/XRP', 'BTC/USD']) {
        expect(natives(day).get(label)).not.toBeNull();
      }
      // the 1e40 amount is in the volumes (the Float64 sum), the dust is not in the count
      expect(day.markets.find((m) => labelOf(m) === 'BTC/USD')?.base_volume).toBe('1e+40');
      const inDay = exchanges.filter((r) => r.close_time >= day.start_time && r.close_time <= NOW);
      expect(day.total_count).toBe(inDay.length - 3);
      // the edges: the first second of a window is in it, the second before it is not
      for (const period of MARKETS_PERIODS) {
        const set = oracleOf(exchanges, period);
        expect(set.markets.find((m) => labelOf(m) === 'EUR/USD')?.open_time).toBe(set.start_time);
        expect(set.markets.find((m) => labelOf(m) === 'EUR/USD')?.last_time).toBe(NOW);
      }
    });

    it.each(MARKETS_PERIODS)(
      'the set equals an oracle computed straight from exchanges for the same hour-aligned window (%s)',
      async (period) => {
        const want = oracleOf(exchanges, period);
        const outcome = await compute(ch, period);
        expect(outcome).toEqual({
          written: true,
          pairs: want.markets.length,
          startTime: CURRENT_HOUR - PERIOD_HOURS[period] * HOUR,
          endTime: NOW,
        });
        expectSet(await storedSet(ch, period), want);
      },
    );

    it('closes are the last trade of each of the 7 UTC days ending with the day of t; a quiet day carries the close before it; a day with no close before it in the 7 days is null', async () => {
      await compute(ch, '30day');
      const set = (await storedSet(ch, '30day')) as StoredSet;
      const closes = (label: string): Array<string | null> | undefined =>
        set.markets.find((m) => labelOf(m) === label)?.closes;

      // the 7 days are 06-26 to 07-02 (days 25 to 31). JPY/USD: the last trade of day 28 is that of its last second (rate 5),
      // the first trade of day 29 is on its first second (rate 6), and the last of day 29 is the one of the higher
      // transaction index in the ledger of 18:00:00 (rate 7); days 30 and 31 have none and carry it; days 25 to 27 have no
      // close before them
      expect(closes('JPY/USD')).toEqual([null, null, null, '5', '7', '7', '7']);
      // AUD/USD traded on the last second of day 24, which is not one of the 7 days, and on day 27: the days before 27 are null
      expect(closes('AUD/USD')).toEqual([null, null, '4', '4', '4', '4', '4']);
      // GBP/USD traded only in days 20 to 23: nothing in the 7 days, so nothing to carry
      expect(closes('GBP/USD')).toEqual(Array(7).fill(null));
      // EUR/USD: the trade at t is the close of today
      expect(closes('EUR/USD')?.[6]).toBe('11');
      // every market has 7 closes, oldest first, and the sentinel none
      for (const m of set.markets) expect(m.closes).toHaveLength(SPARKLINE_DAYS);
      expect(set.sentinel.closes).toEqual([]);

      // and the oracle, which works the same days out from the trades, agrees with all of them
      expect(set.markets.map((m) => m.closes)).toEqual(oracleOf(exchanges, '30day').markets.map((m) => m.closes));
      // a quiet day carries the close before it: a pair that traded on some days of the 7 has a close in every day after
      // its first, and the closes only change on a day it traded
      for (const m of set.markets) {
        const firstClose = m.closes.findIndex((c) => c !== null);
        if (firstClose >= 0) for (const c of m.closes.slice(firstClose)) expect(c).not.toBeNull();
      }
    });

    it('an hour whose Float64 sum reaches 1e36 is not an exact one: its pair has the Float64 volumes', async () => {
      await compute(ch, 'day');
      const set = (await storedSet(ch, 'day')) as StoredSet;
      const chf = set.markets.find((m) => labelOf(m) === 'CHF/USD') as Stored;
      expect(chf.count).toBe(4);
      // not 1200000000000000000000000000000000001, the exact sum
      expect(chf.base_volume).toBe('1.2e+36');
      expect(chf.counter_volume).toBe('13');
    });

    it('high and low: of equal rates (the same Float64) the first trade by key, over all the hours', async () => {
      await compute(ch, 'day');
      const set = (await storedSet(ch, 'day')) as StoredSet;
      const nzd = set.markets.find((m) => labelOf(m) === 'NZD/USD') as Stored;
      expect(nzd).toMatchObject({
        count: 2,
        open: '1.00000000000000001',
        high: '1.00000000000000001',
        low: '1.00000000000000001',
        last: '1',
        open_time: dayAt(31, 8, 10),
        last_time: dayAt(31, 9, 10),
      });
    });

    it('D2 writes only amm = include, with amm_share, amm_pool and total_amm_share NULL', async () => {
      for (const period of MARKETS_PERIODS) await compute(ch, period);
      const rows = (await ch.query<Record<string, unknown>>(`${READ_ROWS}`)).map(storedOf);
      expect(rows.length).toBeGreaterThan(30);
      expect(new Set(rows.map((r) => r.amm))).toEqual(new Set(['include']));
      expect(new Set(rows.map((r) => r.period)).size).toBe(3);
      for (const r of rows) {
        expect([r.amm_share, r.amm_pool, r.total_amm_share]).toEqual([null, null, null]);
      }
    });

    it('reads pair_hourly in three reads (the sets, the window, the day closes), each row once, no FINAL, every value bound', async () => {
      const queries = jest.spyOn(ch, 'query');
      expect((await compute(ch, '30day')).written).toBe(true);

      const calls = queries.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
      for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b|2016/);
      const onHourly = calls.filter(({ sql }) => sql.includes(`FROM ${Table.PairHourly}`));
      expect(onHourly).toHaveLength(3);
      // the rows of the newest version of each hour, each once by the whole key, no sentinel
      const reads = onHourly.filter(({ sql }) => sql.includes('GROUP BY'));
      expect(reads).toHaveLength(2);
      for (const { sql, params } of reads) {
        expect(sql).toMatch(/LIMIT 1 BY hour, base_currency, base_issuer, counter_currency, counter_issuer, source/);
        expect(sql).toMatch(/\(hour, version\) IN/);
        expect(params).toMatchObject({ hours: expect.any(Array), versions: expect.any(Array) });
      }
    });

    it('rejects a period it does not know and a date that is none, before any work', async () => {
      const queries = jest.spyOn(ch, 'query');
      const inserts = jest.spyOn(ch, 'insert');
      await expect(compute(ch, 'hour' as MarketsPeriod)).rejects.toBeInstanceOf(RangeError);
      await expect(computeMarketsSet(ch, 'XRP', 'day', new Date(NaN))).rejects.toBeInstanceOf(RangeError);
      expect(queries).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();
    });

    it('an aborted set writes nothing', async () => {
      const before = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.MarketsLive}`);
      const inserts = jest.spyOn(ch, 'insert');
      const queries = jest.spyOn(ch, 'query');

      // before the work: no read, no insert
      const aborted = new AbortController();
      aborted.abort();
      await expect(compute(ch, 'day', NOW, aborted.signal)).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(queries).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();
      queries.mockRestore();

      // aborted while the rows are read: the check is made again right before the insert
      const original = ch.query.bind(ch);
      const live = new AbortController();
      jest.spyOn(ch, 'query').mockImplementation(async (sql, params, settings) => {
        const rows = await original(sql, params, settings);
        if (String(sql).includes('GROUP BY') && String(sql).includes(`FROM ${Table.PairHourly}`)) live.abort();
        return rows;
      });
      await expect(compute(ch, 'day', NOW, live.signal)).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(inserts).not.toHaveBeenCalled();
      jest.restoreAllMocks();
      expect(await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.MarketsLive}`)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('native volume, with the numbers worked out by hand', () => {
    const at = (day: number, hour: number, minute = 0): number => dayAt(day, hour, minute);
    /** What each trade is: a pair, its volume and what the rate of each asset has to be. See the expectations. */
    const trades: Trade[] = [
      trade(USD_XRP, at(30, 12), '300', '100'), // the rate of USD is 300 / 100 = 3 (USD per XRP)
      trade(XRP_ZZZ, at(30, 13), '7', '20'), // the rate of ZZZ is 20 / 7 = 2.857142857142857...
      trade(USD_ZZZ, at(31, 1), '10', '5'), // both have a rate: the base's is taken, 10 USD / 3
      trade(EUR_ZZZ, at(31, 2), '4', '10'), // EUR has none: 10 ZZZ / (20 / 7) = 3.5
      trade(EUR_USD, at(31, 3), '5', '10'), // EUR has none: 10 USD / 3
      trade(BTC_EUR, at(31, 4), '2', '3'), // neither has one; the EUR of the other issuer has a rate, which does not count
      trade(EUR2_XRP, at(31, 5), '8', '4'), // the rate of that EUR is 8 / 4 = 2
      trade(GBP_XRP, at(28, 12), '50', '10'), // three days ago: the rate of GBP is 5 in the 7 days, none in the day
      trade(GBP_USD, at(31, 6), '20', '9'), // in the day: 9 USD / 3 = 3; in the 7 days: 20 GBP / 5 = 4
      trade(USD_XRP, at(28, 12, 30), '30', '30'), // in the 7 days the rate of USD is (300 + 30) / (100 + 30)
      trade(XRP_ZZZ, at(31, 7), '0.0005', '1'), // native dust: not a trade
    ];
    let ch: ClickHouseService;
    let exchanges: ExchangesRow[];

    beforeAll(async () => {
      ch = await freshService();
      exchanges = await seedWorld(ch, trades, [NOW]);
      await writeHourSets(ch, CURRENT_HOUR - 168 * HOUR, CURRENT_HOUR);
    }, 300_000);

    const natives = (set: StoredSet): Record<string, string | null> =>
      Object.fromEntries(set.markets.map((m) => [labelOf(m), m.native_volume]));

    it('in the day: a native side is its own volume; else the base volume over the base rate, else the counter volume over the counter rate, cut to 17 significant digits; else NULL', async () => {
      expect((await compute(ch, 'day')).written).toBe(true);
      const set = (await storedSet(ch, 'day')) as StoredSet;
      expect(natives(set)).toEqual({
        'USD/XRP': '100', // the counter volume
        'XRP/ZZZ': '7', // the base volume: the dust is not in it
        'USD/ZZZ': '3.3333333333333333', // 10 / 3 by the base's rate (not 5 / (20 / 7) = 1.75 by the counter's)
        'EUR/ZZZ': '3.5', // 10 / (20 / 7) by the counter's rate
        'EUR/USD': '3.3333333333333333', // 10 / 3 by the counter's rate
        'BTC/EUR': null, // no rate on either side
        'EUR*/XRP': '4', // a native side
        'GBP/USD': '3', // GBP has no rate in the day: 9 / 3 by the counter's rate
      });
      expect(set.sentinel).toMatchObject({
        pairs_traded: 8,
        total_count: 8,
        total_native_volume: '124.1666666666666666',
      });
      // the volumes and the count of a pair with dust: only the kept trade
      expect(set.markets.find((m) => labelOf(m) === 'XRP/ZZZ')).toMatchObject({
        count: 1,
        base_volume: '7',
        counter_volume: '20',
      });
      expectSet(set, oracleOf(exchanges, 'day'));
    });

    it('in the 7 days: the rates are those of the 7 days, and a pair with a native side adds its volumes', async () => {
      expect((await compute(ch, '7day')).written).toBe(true);
      const set = (await storedSet(ch, '7day')) as StoredSet;
      expect(natives(set)).toEqual({
        'USD/XRP': '130', // (100 + 30) XRP
        'XRP/ZZZ': '7',
        'USD/ZZZ': '3.9393939393939394', // 10 / (330 / 130)
        'EUR/ZZZ': '3.5',
        'EUR/USD': '3.9393939393939394',
        'BTC/EUR': null,
        'EUR*/XRP': '4',
        'GBP/USD': '4', // GBP now has a rate (5): 20 / 5, the base's
        'GBP/XRP': '10',
      });
      expect(set.markets.find((m) => labelOf(m) === 'USD/XRP')).toMatchObject({
        count: 2,
        base_volume: '330',
        counter_volume: '130',
      });
      expect(set.sentinel).toMatchObject({
        pairs_traded: 9,
        total_count: 10,
        total_native_volume: '166.3787878787878788',
      });
      expectSet(set, oracleOf(exchanges, '7day'));
    });

    it('the total is the exact sum over the pairs that have a native volume, and 0 when none has', async () => {
      const lonely = await freshService();
      // BTC/EUR only: no rate on either side, so no native volume anywhere
      await seedWorld(lonely, [trade(BTC_EUR, at(31, 4), '2', '3')], [NOW]);
      await writeHourSets(lonely, dayAt(25), CURRENT_HOUR);
      expect((await compute(lonely, 'day')).written).toBe(true);
      const set = (await storedSet(lonely, 'day')) as StoredSet;
      expect(set.markets.map((m) => m.native_volume)).toEqual([null]);
      expect(set.sentinel).toMatchObject({ pairs_traded: 1, total_count: 1, total_native_volume: '0' });
    });

    it('a day with no trade at all is a set with a sentinel only', async () => {
      const quiet = await freshService();
      await seedWorld(quiet, [], [NOW]);
      await writeHourSets(quiet, dayAt(25), CURRENT_HOUR);
      expect(await compute(quiet, 'day')).toEqual({
        written: true,
        pairs: 0,
        startTime: CURRENT_HOUR - 24 * HOUR,
        endTime: NOW,
      });
      const set = (await storedSet(quiet, 'day')) as StoredSet;
      expect(set.markets).toEqual([]);
      expect(set.sentinel).toMatchObject({ pairs_traded: 0, total_count: 0, total_native_volume: '0' });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the sets of a week of trades', () => {
    let ch: ClickHouseService;
    let exchanges: ExchangesRow[];

    /** Trades from 08:00 of day 24 on, and the hour sets from the same hour: all the hours the day and the 7 days need. */
    beforeEach(async () => {
      ch = await freshService();
      // a mutation (the deletion of an hour) rewrites the parts it touches and applies the TTL to them, which has expired
      // for every hour of 2016: so this database has no TTL (that of the table is the migration's, and not what is tested)
      await ch.command(`ALTER TABLE ${Table.PairHourly} REMOVE TTL`);
      exchanges = await seedWorld(ch, worldTrades(dayAt(24, 8)));
      await writeHourSets(ch, dayAt(24, 8), CURRENT_HOUR);
    }, 300_000);

    const rates = (): RatesService => new RatesService(ch, 'XRP');
    /** The hour is computed again: a newer set that is final when a later ledger exists. */
    const restore = (hour: number): Promise<number> => computePairHourSets(ch, rates(), hour, hour + HOUR);
    const dropHour = (hour: number): Promise<void> =>
      ch.command(
        `ALTER TABLE ${Table.PairHourly} DELETE WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
        { hour },
        { settings: { mutations_sync: '2' } },
      );
    /** The newest set of an hour, written again as a newer version with these columns replaced (`0 AS is_final`). */
    const copyNewest = (hour: number, replace: string): Promise<void> =>
      ch.command(
        // (the rows come from a subquery: in the query itself `version` would be the replaced one)
        `INSERT INTO ${Table.PairHourly}
         SELECT * REPLACE (${replace}, version + 1 AS version)
           FROM (SELECT * FROM ${Table.PairHourly}
                  WHERE hour = toDateTime({hour:UInt32}, 'UTC')
                    AND version = (SELECT max(version) FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')))`,
        { hour },
        { settings: { insert_deduplicate: 0 } },
      );

    it('a missing hour, or a non-final one other than the last two, in the window or in the sparkline days skips the set and leaves the previous one', async () => {
      expect((await compute(ch, 'day')).written).toBe(true);
      expect((await compute(ch, '7day')).written).toBe(true);
      const previous = {
        day: (await storedSet(ch, 'day')) as StoredSet,
        '7day': (await storedSet(ch, '7day')) as StoredSet,
      };
      const inserts = jest.spyOn(ch, 'insert');

      /** The period's set is not written: the outcome lists the hours, and the set that is there is the previous one. */
      const expectSkipped = async (period: MarketsPeriod, missing: number[], now = NOW): Promise<void> => {
        inserts.mockClear();
        expect(await compute(ch, period, now)).toEqual({ written: false, missingHours: missing });
        expect(marketsInserts(inserts)).toEqual([]);
        expect(await storedSet(ch, period)).toEqual(previous[period as 'day' | '7day']);
      };
      /** The period's set is written (a newer one), and `previous` is that one from here on. */
      const expectWritten = async (period: 'day' | '7day'): Promise<void> => {
        expect((await compute(ch, period)).written).toBe(true);
        const set = (await storedSet(ch, period)) as StoredSet;
        expect(set.version).toBeGreaterThan(previous[period].version);
        previous[period] = set;
      };

      // an hour in the window of the 7 days (from 10:00 of day 24), not in that of the day nor among the 7 days of the
      // sparkline (from the start of day 25): the 7 days miss it, the day does not
      await dropHour(dayAt(24, 12));
      await expectSkipped('7day', [dayAt(24, 12)]);
      await expectWritten('day');
      await restore(dayAt(24, 12));

      // an hour of the sparkline days that is not in the window of the day (06-27 12:00 is before it): the day misses it, and so
      // do the 7 days, whose window holds it too
      await dropHour(dayAt(26, 12));
      await expectSkipped('day', [dayAt(26, 12)]);
      await expectSkipped('7day', [dayAt(26, 12)]);
      await restore(dayAt(26, 12));

      // an hour before the window and before the sparkline days (day 24 at 09:00, and day 24 at 08:00) is not needed
      await dropHour(dayAt(24, 9));
      await dropHour(dayAt(24, 8));
      await expectWritten('day');
      await expectWritten('7day');
      await restore(dayAt(24, 9));
      await restore(dayAt(24, 8));

      // the hour before the sparkline days (23:00 of day 24) is not needed by the day, and is by the 7 days (their window)
      await dropHour(dayAt(24, 23));
      await expectWritten('day');
      await expectSkipped('7day', [dayAt(24, 23)]);
      await restore(dayAt(24, 23));

      // every failing hour is listed, the first hour of the sparkline days, the first of the window and one hour near the end, in order
      const holes = [dayAt(25), dayAt(30, 10), dayAt(31, 7)];
      for (const hour of holes) await dropHour(hour);
      await expectSkipped('day', holes);
      for (const hour of holes) await restore(hour);

      // a set that is not final, in the middle of the window
      await copyNewest(dayAt(29, 12), '0 AS is_final');
      await expectSkipped('day', [dayAt(29, 12)]);
      await restore(dayAt(29, 12));

      // the current hour and the one before it may be non-final, the one before that may not
      await copyNewest(CURRENT_HOUR, '0 AS is_final');
      await copyNewest(CURRENT_HOUR - HOUR, '0 AS is_final');
      await expectWritten('day');
      await copyNewest(CURRENT_HOUR - 2 * HOUR, '0 AS is_final');
      await expectSkipped('day', [CURRENT_HOUR - 2 * HOUR]);
      await restore(CURRENT_HOUR - 2 * HOUR);
      await restore(CURRENT_HOUR - HOUR);

      // a set of another config version
      await copyNewest(dayAt(31, 3), `toUInt32(${PAIR_HOURLY_CONFIG_VERSION + 1}) AS config_version`);
      await expectSkipped('day', [dayAt(31, 3)]);
      await restore(dayAt(31, 3));
      await copyNewest(CURRENT_HOUR, 'toUInt32(0) AS config_version');
      await expectSkipped('day', [CURRENT_HOUR]);
      await restore(CURRENT_HOUR);

      // nothing the matter again: the hours that were put right count by their newest set
      await expectWritten('day');
      await expectWritten('7day');

      // the current hour has no set at all: that hour is the one that is missing
      await expectSkipped('day', [dayAt(31, 12)], dayAt(31, 12, 5));
      await expectSkipped('7day', [dayAt(31, 12)], dayAt(31, 12, 59));
    });

    it("window: start_time = floorHour(t) − P, end_time = t, where t is the through_time of the current hour's newest set", async () => {
      const day = await compute(ch, 'day');
      expect(day).toEqual({ written: true, pairs: expect.any(Number), startTime: dayAt(30, 10), endTime: NOW });
      // the window is at least P and at most P + 59:59 long
      for (const period of ['day', '7day'] as const) {
        await compute(ch, period);
        const { sentinel } = (await storedSet(ch, period)) as StoredSet;
        expect(sentinel.end_time - sentinel.start_time).toBeGreaterThanOrEqual(PERIOD_HOURS[period] * HOUR);
        expect(sentinel.end_time - sentinel.start_time).toBeLessThanOrEqual(PERIOD_HOURS[period] * HOUR + 3599);
        expect(sentinel.start_time).toBe(CURRENT_HOUR - PERIOD_HOURS[period] * HOUR);
      }

      // a later ledger of the same hour, and the hour's set made again: t is its close time, whatever `now` the run is given
      const index = (await newestLedgerIndex(ch)) + 3;
      await writeLedgers(ch, [dayAt(31, 10, 50)], new Map([[dayAt(31, 10, 50), index]]));
      await restore(CURRENT_HOUR);
      for (const now of [NOW, dayAt(31, 10, 59, 59), CURRENT_HOUR]) {
        await compute(ch, 'day', now);
        const { sentinel } = (await storedSet(ch, 'day')) as StoredSet;
        expect([sentinel.start_time, sentinel.end_time]).toEqual([dayAt(30, 10), dayAt(31, 10, 50)]);
      }
      expectSet(await storedSet(ch, 'day'), oracleOf(exchanges, 'day', dayAt(31, 10, 50)));

      // the next hour, which has no ledger yet: t is the hour's start, and the window is whole hours
      await restore(dayAt(31, 11));
      expect(await compute(ch, 'day', dayAt(31, 11, 5))).toEqual({
        written: true,
        pairs: expect.any(Number),
        startTime: dayAt(30, 11),
        endTime: dayAt(31, 11),
      });
      expectSet(await storedSet(ch, 'day'), oracleOf(exchanges, 'day', dayAt(31, 11)));
    });

    it('a set is one insert under one version; marketsSetEndTimes reads the newest', async () => {
      await stopMerges(ch, Table.MarketsLive);
      expect(await marketsSetEndTimes(ch)).toEqual(new Map());

      const inserts = jest.spyOn(ch, 'insert');
      const before = Date.now();
      const outcome = await compute(ch, 'day');
      expect(outcome.written).toBe(true);

      // one insert, of the pairs and the sentinel, under one version near the clock
      const sets = marketsInserts(inserts);
      expect(sets).toHaveLength(1);
      const rows = sets[0][1] as Array<{ version: number; period: string; amm: string }>;
      expect(rows).toHaveLength((outcome as { pairs: number }).pairs + 1);
      expect(new Set(rows.map((r) => r.version)).size).toBe(1);
      expect(Math.abs(rows[0].version - before)).toBeLessThan(5 * 60_000);
      expect(new Set(rows.map((r) => `${r.period}/${r.amm}`))).toEqual(new Set(['day/include']));
      // it is one part: a reader sees all of the set or none
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active`,
        { table: Table.MarketsLive },
      );
      expect(parts.map((p) => Number(p.rows))).toEqual([rows.length]);
      expect(await marketsSetEndTimes(ch)).toEqual(new Map([['day', NOW]]));

      // a later ledger and a later run: a new set under a higher version, and the newest is the one read
      const index = (await newestLedgerIndex(ch)) + 3;
      await writeLedgers(ch, [dayAt(31, 10, 50)], new Map([[dayAt(31, 10, 50), index]]));
      await restore(CURRENT_HOUR);
      expect((await compute(ch, 'day')).written).toBe(true);
      const versions = await ch.query<{ version: string }>(
        `SELECT DISTINCT toUInt64(version) AS version FROM ${Table.MarketsLive} ORDER BY version`,
      );
      expect(versions).toHaveLength(2);
      expect(Number(versions[1].version)).toBeGreaterThan(Number(versions[0].version));
      expect(await marketsSetEndTimes(ch)).toEqual(new Map([['day', dayAt(31, 10, 50)]]));
      // the sets of the other periods have their own end times
      expect((await compute(ch, '7day')).written).toBe(true);
      expect(await marketsSetEndTimes(ch)).toEqual(
        new Map([
          ['day', dayAt(31, 10, 50)],
          ['7day', dayAt(31, 10, 50)],
        ]),
      );

      // the newest set is the one of the highest version, not that of the latest end: a set from the future that ends earlier
      // wins, and a set of another filter does not count
      const future = Date.now() + 3_600_000;
      const row = (amm: 'include' | 'only', end: number, version: number) => ({
        ...SAMPLE_ROWS[Table.MarketsLive],
        period: 'day',
        amm,
        base_currency: '',
        base_issuer: '',
        counter_currency: '',
        counter_issuer: '',
        start_time: end - DAY,
        end_time: end,
        version,
      });
      await ch.insert(Table.MarketsLive, [row('only', dayAt(31, 12), future + 10)]);
      expect(await marketsSetEndTimes(ch)).toEqual(
        new Map([
          ['day', dayAt(31, 10, 50)],
          ['7day', dayAt(31, 10, 50)],
        ]),
      );
      await ch.insert(Table.MarketsLive, [row('include', dayAt(31, 9), future)]);
      expect((await marketsSetEndTimes(ch)).get('day')).toBe(dayAt(31, 9));
      // the next set goes one past it: a version only goes up
      expect((await compute(ch, 'day')).written).toBe(true);
      expect(((await storedSet(ch, 'day')) as StoredSet).version).toBe(future + 1);
    });

    it('an hour row written twice counts once, and an older version of an hour is not read', async () => {
      await stopMerges(ch, Table.PairHourly);
      expect((await compute(ch, 'day')).written).toBe(true);
      expectSet(await storedSet(ch, 'day'), oracleOf(exchanges, 'day'));
      const hourRows = async (hour: number): Promise<number> =>
        Number(
          (
            await ch.query<{ n: string }>(
              `SELECT count() AS n FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
              { hour },
            )
          )[0].n,
        );

      // every row of two hours written twice: the same set, and the same version
      for (const hour of [dayAt(31, 2), CURRENT_HOUR - HOUR]) {
        const once = await hourRows(hour);
        await ch.command(
          `INSERT INTO ${Table.PairHourly} SELECT * FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
          { hour },
          { settings: { insert_deduplicate: 0 } },
        );
        expect(await hourRows(hour)).toBe(once * 2);
        expect(once).toBeGreaterThan(2);
      }
      expect((await compute(ch, 'day')).written).toBe(true);
      expectSet(await storedSet(ch, 'day'), oracleOf(exchanges, 'day'));

      // a trade comes late into a ledger of an hour, and the hour's set is made again: the old set stays in the table, the
      // new one has its trade, and the markets take the new one alone (one trade more, not two sets of the rest)
      const hour = dayAt(31, 3);
      const sample = exchanges.find((r) => r.close_time >= hour && r.close_time < hour + HOUR) as ExchangesRow;
      const late: ExchangesRow = {
        ...SAMPLE_ROWS[Table.Exchanges],
        base_currency: EUR_USD.base.currency,
        base_issuer: EUR_USD.base.issuer ?? '',
        counter_currency: EUR_USD.counter.currency,
        counter_issuer: EUR_USD.counter.issuer ?? '',
        ledger_index: sample.ledger_index,
        tx_index: 99,
        node_index: 7,
        tx_hash: 'F'.repeat(64),
        close_time: sample.close_time,
        base_amount: '1',
        counter_amount: '9',
        base_amount_f: 1,
        counter_amount_f: 9,
        rate: '9',
        rate_f: 9,
      };
      await ch.insert(Table.Exchanges, [late]);
      const before = await hourRows(hour);
      await restore(hour);
      expect(await hourRows(hour)).toBeGreaterThan(before); // two versions of the hour are in the table
      // and a row of an older version of another hour, for a pair that has none in the newest: it is not read
      const [newest] = await ch.query<{ version: string }>(
        `SELECT toUInt64(max(version)) AS version FROM ${Table.PairHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC')`,
        { hour: dayAt(31, 4) },
      );
      const ghost: PairHourlyRow = {
        ...SAMPLE_ROWS[Table.PairHourly],
        hour: dayAt(31, 4),
        base_currency: 'GHO',
        base_issuer: ISSUER,
        counter_currency: 'USD',
        counter_issuer: ISSUER,
        source: 'book',
        count: 1000,
        is_final: 1,
        config_version: PAIR_HOURLY_CONFIG_VERSION,
        version: Number(newest.version) - 1,
      };
      await ch.insert(Table.PairHourly, [ghost]);

      const withLate = [...exchanges, late];
      expect((await compute(ch, 'day')).written).toBe(true);
      const set = (await storedSet(ch, 'day')) as StoredSet;
      expectSet(set, oracleOf(withLate, 'day'));
      expect(set.markets.map((m) => m.base_currency)).not.toContain('GHO');
      const eur = (s: StoredSet): number => s.markets.find((m) => labelOf(m) === 'EUR/USD')?.count ?? 0;
      expect(eur(set)).toBe(oracleOf(exchanges, 'day').markets.find((m) => labelOf(m) === 'EUR/USD')!.count + 1);
    });
  });
});

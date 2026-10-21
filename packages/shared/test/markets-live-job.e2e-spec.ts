import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import { recomputeAmmPools } from '../src/aggregate/amm-pools.job';
import {
  ammShareText,
  computeMarketsSet,
  MARKETS_AMM_FILTERS,
  MARKETS_PERIOD_HOURS,
  MARKETS_PERIODS,
  MarketsAmmFilter,
  marketsAmmShareKnown,
  MarketsPeriod,
  marketsSetEndTimes,
  MarketsSetOutcome,
  SPARKLINE_DAYS,
} from '../src/aggregate/markets-live.job';
import { computePairHourSets, PAIR_HOURLY_CONFIG_VERSION } from '../src/aggregate/pair-hourly.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import {
  AMM_PARSER_VERSION,
  AmmPoolsRow,
  ExchangesRow,
  MarketsLiveRow,
  PairHourlyRow,
  PARSER_VERSION,
} from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, canonicalPair } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { marketsOracle, OracleAmm, OracleMarket, OraclePool, OracleSet } from './markets-oracle';
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
 * that traded only in the middle of the 30 days, only in the days before the 7 of the sparkline, or on two of them. Some
 * of its trades are swaps against pools (`amm_account` set; the others are order-book trades, `amm_account` ''): XRP/ZZZ
 * trades only with its pool, USD/ZZZ and SEK/USD with the order book and a pool in the same hours (SEK/USD by hand, so that
 * its open, high, low and last come from one source or the other as the key says), and USD/XRP, the pair the rate of USD
 * comes from, only with the order book; `amm_pools` has a live pool of XRP/ZZZ and a deleted one of USD/ZZZ, each decided by
 * its newest row. Each period has three sets, one per filter (`include`, `exclude`, `only`). An oracle written from the
 * stored `exchanges` rows (`markets-oracle.ts`) says what every market of every filter is. Smaller worlds work the AMM
 * share out by hand, close the AMM fields by the parser gate and show them on Xahau, and the recorded mainnet ledgers of
 * `fixtures/xrpl/amm` are compared with the oracle as they were stored.
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
/** The account of a pool (only a name: nothing reads it as an address). */
const poolAccount = (name: string): string => `rPool${name}`.padEnd(34, '1');
const POOL_ZZZ = poolAccount('XrpZzz'); // XRP/ZZZ: live
const POOL_USD_ZZZ = poolAccount('UsdZzz'); // USD/ZZZ: deleted
const POOL_SEK = poolAccount('SekUsd'); // SEK/USD: no row in amm_pools

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
const SEK_USD = canonicalPair(issued('SEK'), issued('USD'));
type StoredPair = typeof USD_XRP;

/**
 * A trade of a stored pair: its close time, its transaction and node, and its amounts as exact decimal text. Its rate is
 * the counter over the base, to 16 digits, unless the trade says what its text is. A swap names its pool (`amm`); an
 * order-book trade has none.
 */
interface Trade {
  pair: StoredPair;
  close: number;
  tx: number;
  node: number;
  base: string;
  counter: string;
  rate?: string;
  amm?: string;
}
const trade = (pair: StoredPair, close: number, base: string, counter: string, tx = 1, node = 0): Trade => ({
  pair,
  close,
  tx,
  node,
  base,
  counter,
});
/** A swap against the pool `amm`. */
const swap = (
  amm: string,
  pair: StoredPair,
  close: number,
  base: string,
  counter: string,
  tx = 1,
  node = 0,
): Trade => ({
  ...trade(pair, close, base, counter, tx, node),
  amm,
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
 * the list at a rate of the list (the counter is their product, exact), so that equal rates are everywhere. The trades of
 * a stream with a pool (`amm`) are swaps against it.
 */
interface Stream {
  pair: StoredPair;
  max: number;
  bases: string[];
  rates: string[];
  fromDay?: number;
  toDay?: number;
  amm?: string;
}
const STREAMS: Stream[] = [
  // the order book only: the rate of USD (for every filter's sets) comes from here
  { pair: USD_XRP, max: 3, bases: ['10', '20', '40', '100', '160'], rates: ['0.4', '0.5', '0.625', '0.8'] },
  // swaps only: the rate of ZZZ comes from swaps
  { pair: XRP_ZZZ, max: 3, bases: ['4', '8', '10', '20', '50'], rates: ['2', '2.5', '4'], amm: POOL_ZZZ },
  { pair: USD_ZZZ, max: 2, bases: ['5', '10', '16', '40'], rates: ['4', '5', '6.25'] },
  { pair: EUR_USD, max: 2, bases: ['1', '2', '5', '8'], rates: ['9', '10', '12', '9.5'] },
  { pair: EUR_ZZZ, max: 1, bases: ['2', '4', '8'], rates: ['2.5', '5'] },
  { pair: BTC_EUR, max: 1, bases: ['0.5', '1', '2'], rates: ['20', '25'] },
  { pair: BTC_USD, max: 1, bases: ['0.5', '1', '2'], rates: ['20', '25'] },
  { pair: EUR2_XRP, max: 1, bases: ['5', '10', '20'], rates: ['0.5', '0.8'] },
  // days 20 to 23 only: in the 30 days, and not in the 7
  { pair: GBP_USD, max: 2, bases: ['10', '20'], rates: ['1.5', '2'], fromDay: 20, toDay: 23 },
  // USD/ZZZ swaps too, in the hours of its order-book trades and at the same rates (a tie between the sources is common)
  { pair: USD_ZZZ, max: 2, bases: ['4', '8', '20'], rates: ['4', '5', '6.25'], amm: POOL_USD_ZZZ },
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
        trades.push({
          ...trade(
            s.pair,
            BASE + h * HOUR + sec,
            base,
            new BigNumber(base).times(pick(s.rates)).toFixed(),
            1 + Math.floor(next() * 4),
            Math.floor(next() * 3),
          ),
          ...(s.amm !== undefined && { amm: s.amm }),
        });
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
    // native dust (0.0005 or less on a native side) is left out, a swap's too; 0.00051 is kept
    trade(USD_XRP, dayAt(31, 2, 10), '1000', '0.0005'),
    trade(USD_XRP, dayAt(31, 2, 20), '1', '0.0004'),
    swap(POOL_ZZZ, XRP_ZZZ, dayAt(31, 3, 10), '0.0005', '3'),
    swap(POOL_ZZZ, XRP_ZZZ, dayAt(31, 3, 20), '0.00051', '3'),
    ...sekUsdTrades(),
  ];
}

/**
 * SEK/USD: the order book and its pool in the same two hours of the last day, 6 SEK of order-book trades and 4 of swaps
 * (an AMM share of 0.4000). The open is a swap (the first by key); the highest rate, 3, is that of a trade of each source,
 * of texts that differ, and the first by key is the order book's; the lowest, 1.5, likewise, and the first by key is the
 * swap's; the last is a swap in the ledger of an order-book trade, after it by its transaction index.
 */
function sekUsdTrades(): Trade[] {
  return [
    { ...swap(POOL_SEK, SEK_USD, dayAt(31, 4, 5), '1', '2.5'), rate: '2.5' },
    { ...trade(SEK_USD, dayAt(31, 4, 10), '1', '2'), rate: '2' },
    { ...swap(POOL_SEK, SEK_USD, dayAt(31, 4, 15), '1', '1.5'), rate: '1.50000000000000001' },
    { ...trade(SEK_USD, dayAt(31, 4, 20), '1', '3'), rate: '3' },
    { ...swap(POOL_SEK, SEK_USD, dayAt(31, 4, 30), '1', '3'), rate: '3.00000000000000001' },
    { ...trade(SEK_USD, dayAt(31, 4, 45), '1', '1.5'), rate: '1.5' },
    { ...trade(SEK_USD, dayAt(31, 5, 10), '1', '2.2'), rate: '2.2' },
    { ...trade(SEK_USD, dayAt(31, 5, 20), '2', '5.2', 1), rate: '2.6' },
    { ...swap(POOL_SEK, SEK_USD, dayAt(31, 5, 20), '1', '2.4', 2), rate: '2.4' },
  ];
}

/**
 * The rows of `amm_pools` of the world, each pool decided by its newest row: the pool of XRP/ZZZ was deleted and is live
 * again, that of USD/ZZZ was live and is deleted. (SEK/USD has swaps and no pool row.)
 */
function worldPools(): AmmPoolsRow[] {
  const pool = (amm: string, pair: StoredPair, deleted: number, version: number): AmmPoolsRow => ({
    ...SAMPLE_ROWS[Table.AmmPools],
    amm_account: amm,
    base_currency: pair.base.currency,
    base_issuer: pair.base.issuer ?? '',
    counter_currency: pair.counter.currency,
    counter_issuer: pair.counter.issuer ?? '',
    deleted,
    version,
  });
  return [
    pool(POOL_ZZZ, XRP_ZZZ, 1, 10),
    pool(POOL_ZZZ, XRP_ZZZ, 0, 20),
    pool(POOL_USD_ZZZ, USD_ZZZ, 0, 10),
    pool(POOL_USD_ZZZ, USD_ZZZ, 1, 20),
  ];
}

/** The rows of `amm_pools` as the oracle takes them. */
const oraclePoolsOf = (rows: AmmPoolsRow[]): OraclePool[] =>
  rows.map((r) => ({
    amm_account: r.amm_account,
    base_currency: r.base_currency,
    base_issuer: r.base_issuer,
    counter_currency: r.counter_currency,
    counter_issuer: r.counter_issuer,
    deleted: r.deleted,
    version: Number(r.version),
  }));

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
      // (the sample row is a swap: an order-book trade has no pool)
      amm_account: t.amm ?? '',
    };
  });
}

/** Writes the ledgers, by the current parser unless `parserVersion` says another. */
async function writeLedgers(
  ch: ClickHouseService,
  closes: number[],
  ledgerOf: Map<number, number>,
  parserVersion = PARSER_VERSION,
): Promise<void> {
  await ch.insert(
    Table.Ledgers,
    closes.map((close) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: ledgerOf.get(close) as number,
      ledger_hash: `${ledgerOf.get(close)}`.padStart(64, 'C'),
      close_time: close,
      parser_version: parserVersion,
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

/** The newest set of a period and filter (`include` by default), as a reader takes it: the rows of the highest version. */
async function storedSet(
  ch: ClickHouseService,
  period: string,
  amm: MarketsAmmFilter = 'include',
): Promise<StoredSet | undefined> {
  const rows = (
    await ch.query<Record<string, unknown>>(
      `${READ_ROWS}
        WHERE period = {period:String} AND amm = {amm:String}
          AND version = (SELECT max(version) FROM ${Table.MarketsLive} WHERE period = {period:String} AND amm = {amm:String})
        ORDER BY base_currency, base_issuer, counter_currency, counter_issuer`,
      { period, amm },
    )
  ).map(storedOf);
  if (rows.length === 0) return undefined;
  const sentinel = rows.find(isSentinel);
  if (!sentinel) throw new Error(`The newest ${amm} set of ${period} has no sentinel`);
  return { version: sentinel.version, sentinel, markets: rows.filter((r) => !isSentinel(r)) };
}

/** The newest set of each filter of a period. */
async function storedSets(ch: ClickHouseService, period: string): Promise<Record<MarketsAmmFilter, StoredSet>> {
  const sets = {} as Record<MarketsAmmFilter, StoredSet>;
  for (const amm of MARKETS_AMM_FILTERS) {
    const set = await storedSet(ch, period, amm);
    if (!set) throw new Error(`No ${amm} set of ${period}`);
    sets[amm] = set;
  }
  return sets;
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
  amm_share: r.amm_share,
  amm_pool: r.amm_pool,
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
    total_amm_share: want.total_amm_share,
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

  const oracleOf = (exchanges: ExchangesRow[], period: MarketsPeriod, t = NOW, amm: OracleAmm = {}): OracleSet =>
    marketsOracle(exchanges, 'XRP', PERIOD_HOURS[period], t, amm);

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
    /** Every row written to `amm_pools`, older versions too. */
    const pools: AmmPoolsRow[] = [];

    /** Writes rows of `amm_pools`, one part each (its merges are stopped: every version of a pool stays to be read). */
    const writePools = async (rows: AmmPoolsRow[]): Promise<void> => {
      for (const row of rows) await ch.insert(Table.AmmPools, [row]);
      pools.push(...rows);
    };

    beforeAll(async () => {
      ch = await freshService();
      exchanges = await seedWorld(ch, worldTrades());
      await writeHourSets(ch, dayAt(0), CURRENT_HOUR);
      await stopMerges(ch, Table.AmmPools);
      // the newest rows first: what decides is the version, not the order of the writes
      await writePools([...worldPools()].reverse());
    }, 900_000);

    /** What the set of a period and filter has to be, the pools written so far included. */
    const want = (period: MarketsPeriod, filter: MarketsAmmFilter = 'include'): OracleSet =>
      oracleOf(exchanges, period, NOW, { filter, pools: oraclePoolsOf(pools) });

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

      // the swaps: XRP/ZZZ has only swaps, USD/XRP none, USD/ZZZ both sources in many hours of the day
      const tradesOf = (pair: StoredPair, from: number): ExchangesRow[] =>
        exchanges.filter(
          (r) =>
            r.base_currency === pair.base.currency &&
            r.counter_currency === pair.counter.currency &&
            r.base_issuer === (pair.base.issuer ?? '') &&
            r.close_time >= from,
        );
      expect(tradesOf(XRP_ZZZ, BASE).every((r) => r.amm_account === POOL_ZZZ)).toBe(true);
      expect(tradesOf(USD_XRP, BASE).every((r) => r.amm_account === '')).toBe(true);
      const hoursOf = (rows: ExchangesRow[]): Set<number> => new Set(rows.map((r) => Math.floor(r.close_time / HOUR)));
      const usdZzz = tradesOf(USD_ZZZ, day.start_time);
      const bothSources = [...hoursOf(usdZzz.filter((r) => r.amm_account === ''))].filter((h) =>
        hoursOf(usdZzz.filter((r) => r.amm_account === POOL_USD_ZZZ)).has(h),
      );
      expect(bothSources.length).toBeGreaterThan(5);
      // in each filter's sets but one: the order book's sets have no XRP/ZZZ, the pools' sets no USD/XRP
      expect(labels(want('day', 'exclude'))).not.toContain('XRP/ZZZ');
      expect(labels(want('day', 'only'))).not.toContain('USD/XRP');
      expect(labels(want('day', 'only'))).toEqual(['SEK/USD', 'USD/ZZZ', 'XRP/ZZZ']);
    });

    it.each(MARKETS_PERIODS)(
      'writes the three filter sets of a period, each equal to the oracle of its filter (%s)',
      async (period) => {
        const outcome = await compute(ch, period);
        expect(outcome).toEqual({
          written: true,
          pairs: want(period).markets.length,
          startTime: CURRENT_HOUR - PERIOD_HOURS[period] * HOUR,
          endTime: NOW,
          ammShareKnown: true,
        });
        const sets = await storedSets(ch, period);
        for (const filter of MARKETS_AMM_FILTERS) expectSet(sets[filter], want(period, filter));

        // the rates of the native volumes are those of every trade, whatever the filter: USD/ZZZ of the pools has the base
        // volume over the rate of USD (USD/XRP has no swap), and EUR/ZZZ of the order book the counter volume over the rate
        // of ZZZ (XRP/ZZZ has only swaps)
        const of = (set: StoredSet, label: string): Stored => set.markets.find((m) => labelOf(m) === label) as Stored;
        const usdXrp = of(sets.include, 'USD/XRP');
        const usdRate = new Wide(usdXrp.base_volume).dividedBy(usdXrp.counter_volume);
        const usdZzz = of(sets.only, 'USD/ZZZ');
        expect(usdZzz.native_volume).toBe(
          new BigNumber(new Wide(usdZzz.base_volume).dividedBy(usdRate)).precision(17).toString(),
        );
        const xrpZzz = of(sets.include, 'XRP/ZZZ');
        const zzzRate = new Wide(xrpZzz.counter_volume).dividedBy(xrpZzz.base_volume);
        const eurZzz = of(sets.exclude, 'EUR/ZZZ');
        expect(eurZzz.native_volume).toBe(
          new BigNumber(new Wide(eurZzz.counter_volume).dividedBy(zzzRate)).precision(17).toString(),
        );
      },
    );

    it('a pair of swaps only is in include and only, with amm_share 1.0000, and not in exclude', async () => {
      for (const period of MARKETS_PERIODS) {
        await compute(ch, period);
        const sets = await storedSets(ch, period);
        const xrpZzz = (set: StoredSet): Stored | undefined => set.markets.find((m) => labelOf(m) === 'XRP/ZZZ');
        expect(xrpZzz(sets.exclude)).toBeUndefined();
        expect(marketOf(xrpZzz(sets.only) as Stored)).toEqual(marketOf(xrpZzz(sets.include) as Stored));
        expect(xrpZzz(sets.include)).toMatchObject({ amm_share: '1.0000', amm_pool: 1 });
        // its dust swap is no trade, the one of 0.00051 is
        if (period === 'day') {
          const inDay = exchanges.filter(
            (r) => r.base_currency === 'XRP' && r.counter_currency === 'ZZZ' && r.close_time >= dayAt(30, 10),
          );
          expect(xrpZzz(sets.only)?.count).toBe(inDay.length - 1);
        }
      }
    });

    it('both sources in one hour: include combines them, open and last by key, high and low by rate with the key as tie-break', async () => {
      await compute(ch, 'day');
      const sets = await storedSets(ch, 'day');
      const sek = (set: StoredSet): Stored => set.markets.find((m) => labelOf(m) === 'SEK/USD') as Stored;
      const closesOf = (last: string): Array<string | null> => [null, null, null, null, null, null, last];
      // all nine trades: the open is the swap of 04:05; of the two rates of 3 the order book's of 04:20 (before the swap of
      // 04:30), of the two of 1.5 the swap's of 04:15 (before the order book's of 04:45); the last the swap of 05:20, whose
      // transaction comes after that of the order-book trade in the same ledger
      expect(sek(sets.include)).toMatchObject({
        count: 9,
        base_volume: '10',
        counter_volume: '23.3',
        open: '2.5',
        high: '3',
        low: '1.50000000000000001',
        last: '2.4',
        open_time: dayAt(31, 4, 5),
        last_time: dayAt(31, 5, 20),
        closes: closesOf('2.4'),
        amm_share: '0.4000',
      });
      expect(sek(sets.exclude)).toMatchObject({
        count: 5,
        base_volume: '6',
        counter_volume: '13.9',
        open: '2',
        high: '3',
        low: '1.5',
        last: '2.6',
        open_time: dayAt(31, 4, 10),
        last_time: dayAt(31, 5, 20),
        closes: closesOf('2.6'),
        amm_share: '0.4000',
      });
      expect(sek(sets.only)).toMatchObject({
        count: 4,
        base_volume: '4',
        counter_volume: '9.4',
        open: '2.5',
        high: '3.00000000000000001',
        low: '1.50000000000000001',
        last: '2.4',
        open_time: dayAt(31, 4, 5),
        last_time: dayAt(31, 5, 20),
        closes: closesOf('2.4'),
        amm_share: '0.4000',
      });
      // the hours of SEK/USD hold a row of each source
      const rows = await ch.query<{ hour: number; source: string }>(
        `SELECT toUnixTimestamp(hour) AS hour, toString(source) AS source FROM ${Table.PairHourly}
          WHERE base_currency = 'SEK' ORDER BY hour, source LIMIT 1 BY hour, source`,
      );
      expect(rows.map((r) => [Number(r.hour), r.source])).toEqual([
        [dayAt(31, 4), 'amm'],
        [dayAt(31, 4), 'book'],
        [dayAt(31, 5), 'amm'],
        [dayAt(31, 5), 'book'],
      ]);
    });

    it('amm_share is the AMM part of the base volume over the base volume, the same in every filter; a pair without swaps has 0.0000', async () => {
      for (const period of MARKETS_PERIODS) {
        await compute(ch, period);
        const sets = await storedSets(ch, period);
        const share = new Map(sets.include.markets.map((m) => [labelOf(m), m.amm_share]));
        // the share of a pair is the base volume of its swaps (the set `only`) over that of all its trades
        const swapBase = new Map(sets.only.markets.map((m) => [labelOf(m), m.base_volume]));
        for (const m of sets.include.markets) {
          expect([labelOf(m), m.amm_share]).toEqual([
            labelOf(m),
            ammShareText(new BigNumber(swapBase.get(labelOf(m)) ?? 0), new BigNumber(m.base_volume)),
          ]);
        }
        // and it is the same in the sets of the other filters
        for (const m of [...sets.exclude.markets, ...sets.only.markets]) {
          expect([labelOf(m), m.amm_share]).toEqual([labelOf(m), share.get(labelOf(m))]);
        }
        // a pair without swaps has 0.0000, one with both something between 0 and 1
        expect(share.get('USD/XRP')).toBe('0.0000');
        expect(share.get('EUR/USD')).toBe('0.0000');
        expect(Number(share.get('USD/ZZZ'))).toBeGreaterThan(0);
        expect(Number(share.get('USD/ZZZ'))).toBeLessThan(1);
      }
    });

    it('amm_pool says whether the newest row of a pool of the pair is not deleted', async () => {
      const poolsOf = async (period: MarketsPeriod): Promise<Map<string, number | null>> => {
        await compute(ch, period);
        const sets = await storedSets(ch, period);
        const all = MARKETS_AMM_FILTERS.flatMap((filter) =>
          sets[filter].markets.map((m) => [`${filter} ${labelOf(m)}`, m.amm_pool] as const),
        );
        return new Map(all);
      };
      // the pool of XRP/ZZZ is live by its newest row, that of USD/ZZZ deleted by its newest row, SEK/USD has swaps and no
      // pool row, the other pairs no pool at all
      const day = await poolsOf('day');
      expect(day.get('include XRP/ZZZ')).toBe(1);
      expect(day.get('only XRP/ZZZ')).toBe(1);
      for (const [key, pool] of day) {
        if (!key.endsWith(' XRP/ZZZ')) expect([key, pool]).toEqual([key, 0]);
      }
      expect(day.get('only USD/ZZZ')).toBe(0);
      expect(day.get('only SEK/USD')).toBe(0);

      // a newer row of the pool of USD/ZZZ that is not deleted: the pair has a live pool, in every filter's set
      await writePools([{ ...worldPools()[3], deleted: 0, version: 30 }]);
      const live = await poolsOf('day');
      for (const filter of MARKETS_AMM_FILTERS) expect(live.get(`${filter} USD/ZZZ`)).toBe(1);
      // a second pool of XRP/ZZZ, deleted: the live one still counts
      await writePools([{ ...worldPools()[1], amm_account: poolAccount('XrpZzz2'), deleted: 1, version: 40 }]);
      expect((await poolsOf('day')).get('include XRP/ZZZ')).toBe(1);
      // and deleted again
      await writePools([{ ...worldPools()[3], deleted: 1, version: 50 }]);
      expect((await poolsOf('day')).get('include USD/ZZZ')).toBe(0);
      expectSet(await storedSet(ch, 'day'), want('day'));
    });

    it('the three sets are written exclude, only, include, each under its own version, from the same hour versions', async () => {
      const previous = await storedSets(ch, 'day');
      const inserts = jest.spyOn(ch, 'insert');
      const queries = jest.spyOn(ch, 'query');
      const outcome = await compute(ch, 'day');

      const sets = marketsInserts(inserts) as Array<[Table, MarketsLiveRow[]]>;
      expect(sets.map(([, rows]) => [...new Set(rows.map((r) => `${r.period}/${r.amm}`))])).toEqual([
        ['day/exclude'],
        ['day/only'],
        ['day/include'],
      ]);
      expect(sets[2][1]).toHaveLength((outcome as { pairs: number }).pairs + 1);
      for (const [, rows] of sets) {
        const filter = rows[0].amm;
        // one version per set, past the set's previous one, and the version a reader then takes
        expect(new Set(rows.map((r) => r.version)).size).toBe(1);
        expect(Number(rows[0].version)).toBeGreaterThan(previous[filter].version);
        expect((await storedSet(ch, 'day', filter))?.version).toBe(Number(rows[0].version));
        expect(rows.filter((r) => r.base_currency === '' && r.counter_currency === '')).toHaveLength(1);
      }
      // each version is that of its own set
      const versionReads = queries.mock.calls
        .filter(([sql]) => String(sql).includes(`FROM ${Table.MarketsLive}`))
        .map(([, params]) => params);
      expect(versionReads).toEqual(expect.arrayContaining(MARKETS_AMM_FILTERS.map((amm) => ({ period: 'day', amm }))));
      // every read of hour rows takes the version the sets named for each hour: the same in all six
      const reads = queries.mock.calls
        .filter(([sql]) => String(sql).includes(`FROM ${Table.PairHourly}`) && String(sql).includes('GROUP BY'))
        .map(([, params]) => params as { hours: number[]; versions: number[]; sources: string[] });
      expect(reads).toHaveLength(6);
      const versionOf = new Map<number, number>();
      for (const { hours, versions } of reads) {
        hours.forEach((hour, i) => {
          expect(versions[i]).toBe(versionOf.get(hour) ?? versions[i]);
          versionOf.set(hour, versions[i]);
        });
      }
      // the window and the closes of each filter: both sources, the order book, the pools
      expect(reads.map((r) => r.sources.join(',')).sort()).toEqual(
        ['amm', 'amm', 'book', 'book', 'book,amm', 'book,amm'].sort(),
      );
    });

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

    it('reads pair_hourly in seven reads (the sets, then the window and the day closes of each filter), each row once, no FINAL, every value bound', async () => {
      const queries = jest.spyOn(ch, 'query');
      expect((await compute(ch, '30day')).written).toBe(true);

      const calls = queries.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
      for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b|2016/);
      const onHourly = calls.filter(({ sql }) => sql.includes(`FROM ${Table.PairHourly}`));
      expect(onHourly).toHaveLength(7);
      // the rows of the newest version of each hour and of the filter's sources, each once by the whole key, no sentinel
      const reads = onHourly.filter(({ sql }) => sql.includes('GROUP BY'));
      expect(reads).toHaveLength(6);
      for (const { sql, params } of reads) {
        expect(sql).toMatch(/LIMIT 1 BY hour, base_currency, base_issuer, counter_currency, counter_issuer, source/);
        expect(sql).toMatch(/\(hour, version\) IN/);
        expect(sql).toMatch(/source IN \{sources:Array\(String\)\}/);
        expect(params).toMatchObject({
          hours: expect.any(Array),
          versions: expect.any(Array),
          sources: expect.any(Array),
        });
      }
      // and one read each of the pools and of the ledgers of the window
      expect(calls.filter(({ sql }) => sql.includes(`FROM ${Table.AmmPools}`))).toHaveLength(1);
      const gate = calls.filter(({ sql }) => sql.includes(`FROM ${Table.Ledgers}`));
      expect(gate).toHaveLength(1);
      expect(gate[0].params).toEqual({ start: CURRENT_HOUR - 720 * HOUR, end: NOW });
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
        ammShareKnown: true,
      });
      const set = (await storedSet(quiet, 'day')) as StoredSet;
      expect(set.markets).toEqual([]);
      expect(set.sentinel).toMatchObject({
        pairs_traded: 0,
        total_count: 0,
        total_native_volume: '0',
        total_amm_share: '0.0000',
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the AMM fields, with the numbers worked out by hand', () => {
    const at = (day: number, hour: number, minute = 0): number => dayAt(day, hour, minute);
    const POOL_USD = poolAccount('UsdXrp');
    const POOL_EUR = poolAccount('EurXrp');
    const POOL_BTC = poolAccount('BtcEur');
    /**
     * USD/XRP has a native volume of 3000 and an AMM share of 4 / 100000 = 0.00004, EUR*\/XRP 1000 and 9 / 100000 =
     * 0.00009, BTC/EUR (swaps only, a share of 1) none. The total is (3000 × 0.00004 + 1000 × 0.00009) / 4000 =
     * 0.0000525, so 0.0001; with the shares rounded first it would be (3000 × 0 + 1000 × 0.0001) / 4000 = 0.000025, so
     * 0.0000; and with BTC/EUR counted (it has no native volume) something near 1.
     */
    const trades: Trade[] = [
      trade(USD_XRP, at(31, 1), '99996', '2999.88'),
      swap(POOL_USD, USD_XRP, at(31, 2), '4', '0.12'),
      trade(EUR2_XRP, at(31, 3), '99991', '999.91'),
      swap(POOL_EUR, EUR2_XRP, at(31, 4), '9', '0.09'),
      swap(POOL_BTC, BTC_EUR, at(31, 5), '2', '3'),
    ];

    /** A database with these trades, a ledger at t, and the hour sets of the 7 days and the window of the 7 days. */
    const worldOf = async (list: Trade[]): Promise<{ ch: ClickHouseService; exchanges: ExchangesRow[] }> => {
      const ch = await freshService();
      const exchanges = await seedWorld(ch, list, [NOW]);
      await writeHourSets(ch, CURRENT_HOUR - 168 * HOUR, CURRENT_HOUR);
      return { ch, exchanges };
    };

    /** The AMM fields of every row of the newest sets of a period, by filter and pair. */
    const ammFields = async (ch: ClickHouseService, period: MarketsPeriod): Promise<Array<[string, unknown[]]>> => {
      const sets = await storedSets(ch, period);
      return MARKETS_AMM_FILTERS.flatMap((filter) => [
        [`${filter} sentinel`, [sets[filter].sentinel.total_amm_share]] as [string, unknown[]],
        ...sets[filter].markets.map(
          (m) => [`${filter} ${labelOf(m)}`, [m.amm_share, m.amm_pool]] as [string, unknown[]],
        ),
      ]);
    };

    it('total_amm_share weights each share by the native volume, rounded once, the same on the three sentinels; 0.0000 without any native volume', async () => {
      const { ch, exchanges } = await worldOf(trades);
      expect((await compute(ch, 'day')).written).toBe(true);
      expect(await ammFields(ch, 'day')).toEqual([
        ['include sentinel', ['0.0001']],
        ['include BTC/EUR', ['1.0000', 0]],
        ['include EUR*/XRP', ['0.0001', 0]],
        ['include USD/XRP', ['0.0000', 0]],
        ['exclude sentinel', ['0.0001']],
        ['exclude EUR*/XRP', ['0.0001', 0]],
        ['exclude USD/XRP', ['0.0000', 0]],
        ['only sentinel', ['0.0001']],
        ['only BTC/EUR', ['1.0000', 0]],
        ['only EUR*/XRP', ['0.0001', 0]],
        ['only USD/XRP', ['0.0000', 0]],
      ]);
      const sets = await storedSets(ch, 'day');
      expect(sets.include.sentinel.total_native_volume).toBe('4000');
      expect(sets.only.sentinel.total_native_volume).toBe('0.21');
      for (const filter of MARKETS_AMM_FILTERS) expectSet(sets[filter], oracleOf(exchanges, 'day', NOW, { filter }));

      // BTC/EUR alone: a share of 1, and no native volume anywhere
      const lonely = await worldOf([trades[4]]);
      expect((await compute(lonely.ch, 'day')).written).toBe(true);
      expect(await ammFields(lonely.ch, 'day')).toEqual([
        ['include sentinel', ['0.0000']],
        ['include BTC/EUR', ['1.0000', 0]],
        ['exclude sentinel', ['0.0000']],
        ['only sentinel', ['0.0000']],
        ['only BTC/EUR', ['1.0000', 0]],
      ]);
    });

    it('the parser gate: one ledger of the window written by parser 1 leaves amm_share, amm_pool and total_amm_share NULL in all three sets; ammShareKnown says so', async () => {
      const { ch, exchanges } = await worldOf(trades);
      // the ledgers of the world are 2000, 2003, ... from 01:00 of day 31 (the first trade) on
      const parserOne = (close: number, index: number): Promise<void> =>
        writeLedgers(ch, [close], new Map([[close, index]]), AMM_PARSER_VERSION - 1);
      const outcome = async (period: MarketsPeriod): Promise<boolean> => {
        const result = await compute(ch, period);
        if (!result.written) throw new Error(`The ${period} set was not written`);
        return result.ammShareKnown;
      };
      expect(await outcome('day')).toBe(true);
      expect(await outcome('7day')).toBe(true);
      expect(await marketsAmmShareKnown(ch)).toEqual(
        new Map([
          ['day', true],
          ['7day', true],
        ]),
      );

      // a parser-1 ledger after t (end_time), and one before the window of the day (but in that of the 7 days)
      await parserOne(dayAt(31, 10, 50), (await newestLedgerIndex(ch)) + 3);
      expect(await outcome('day')).toBe(true);
      await parserOne(dayAt(30, 9, 59, 59), 1990);
      expect(await outcome('day')).toBe(true);
      expect((await ammFields(ch, 'day')).every(([, fields]) => fields.every((f) => f !== null))).toBe(true);
      expect(await outcome('7day')).toBe(false);
      for (const [key, fields] of await ammFields(ch, '7day'))
        expect([key, fields]).toEqual([key, fields.map(() => null)]);
      expect(await marketsAmmShareKnown(ch)).toEqual(
        new Map([
          ['day', true],
          ['7day', false],
        ]),
      );

      // one on the first second of the window of the day: in it
      await parserOne(dayAt(30, 10), 1995);
      expect(await outcome('day')).toBe(false);
      const closed = await ammFields(ch, 'day');
      expect(closed).toHaveLength(11);
      for (const [key, fields] of closed) expect([key, fields]).toEqual([key, fields.map(() => null)]);
      expect((await marketsAmmShareKnown(ch)).get('day')).toBe(false);
      // the rest of the sets is as it was
      const sets = await storedSets(ch, 'day');
      for (const filter of MARKETS_AMM_FILTERS) {
        expectSet(sets[filter], oracleOf(exchanges, 'day', NOW, { filter, known: false }));
      }
    });

    it('on Xahau the sets carry amm_share 0.0000, amm_pool false (0) and total_amm_share 0.0000', async () => {
      const XAH: Asset = { currency: 'XAH' };
      const USD_XAH = canonicalPair(issued('USD'), XAH);
      const XAH_ZZZ = canonicalPair(XAH, issued('ZZZ'));
      // the order book only (Xahau has no AMM): pairs with the native currency on either side, both rates, and no rate
      const { ch, exchanges } = await worldOf([
        trade(USD_XAH, at(30, 12), '300', '100'),
        trade(XAH_ZZZ, at(30, 13), '7', '20'),
        trade(USD_ZZZ, at(31, 1), '10', '5'),
        trade(BTC_EUR, at(31, 4), '2', '3'),
      ]);
      const outcome = await computeMarketsSet(ch, 'XAH', 'day', new Date(NOW * SEC));
      expect(outcome).toMatchObject({ written: true, pairs: 4, ammShareKnown: true });
      expect(await ammFields(ch, 'day')).toEqual([
        ['include sentinel', ['0.0000']],
        ['include BTC/EUR', ['0.0000', 0]],
        ['include USD/XAH', ['0.0000', 0]],
        ['include USD/ZZZ', ['0.0000', 0]],
        ['include XAH/ZZZ', ['0.0000', 0]],
        ['exclude sentinel', ['0.0000']],
        ['exclude BTC/EUR', ['0.0000', 0]],
        ['exclude USD/XAH', ['0.0000', 0]],
        ['exclude USD/ZZZ', ['0.0000', 0]],
        ['exclude XAH/ZZZ', ['0.0000', 0]],
        ['only sentinel', ['0.0000']],
      ]);
      const sets = await storedSets(ch, 'day');
      for (const filter of MARKETS_AMM_FILTERS) {
        expectSet(sets[filter], marketsOracle(exchanges, 'XAH', 24, NOW, { filter }));
      }
      expect(sets.include.markets.find((m) => labelOf(m) === 'USD/ZZZ')?.native_volume).toBe('3.3333333333333333');
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
      expect(day).toEqual({
        written: true,
        pairs: expect.any(Number),
        startTime: dayAt(30, 10),
        endTime: NOW,
        ammShareKnown: true,
      });
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
        ammShareKnown: true,
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

      // one insert per filter, each of its pairs and its sentinel under one version near the clock
      const sets = marketsInserts(inserts).map(
        ([, rows]) => rows as Array<{ version: number; period: string; amm: string }>,
      );
      expect(sets.map((rows) => [...new Set(rows.map((r) => `${r.period}/${r.amm}`))])).toEqual([
        ['day/exclude'],
        ['day/only'],
        ['day/include'],
      ]);
      expect(sets[2]).toHaveLength((outcome as { pairs: number }).pairs + 1);
      for (const rows of sets) {
        expect(new Set(rows.map((r) => r.version)).size).toBe(1);
        expect(Math.abs(rows[0].version - before)).toBeLessThan(5 * 60_000);
      }
      // each is one part: a reader sees all of a set or none
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active`,
        { table: Table.MarketsLive },
      );
      const sizes = (list: number[]): number[] => [...list].sort((a, b) => a - b);
      expect(sizes(parts.map((p) => Number(p.rows)))).toEqual(sizes(sets.map((rows) => rows.length)));
      expect(await marketsSetEndTimes(ch)).toEqual(new Map([['day', NOW]]));

      // a later ledger and a later run: a new set under a higher version, and the newest is the one read
      const index = (await newestLedgerIndex(ch)) + 3;
      await writeLedgers(ch, [dayAt(31, 10, 50)], new Map([[dayAt(31, 10, 50), index]]));
      await restore(CURRENT_HOUR);
      expect((await compute(ch, 'day')).written).toBe(true);
      const versions = await ch.query<{ version: string }>(
        `SELECT DISTINCT toUInt64(version) AS version FROM ${Table.MarketsLive} WHERE amm = 'include' ORDER BY version`,
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

    it('marketsAmmShareKnown reads the newest include sentinel of each period', async () => {
      await stopMerges(ch, Table.MarketsLive);
      expect(await marketsAmmShareKnown(ch)).toEqual(new Map());
      expect((await compute(ch, 'day')).written).toBe(true);
      expect(await marketsAmmShareKnown(ch)).toEqual(new Map([['day', true]]));

      // a newer include sentinel without total_amm_share: not known; a newer one of another filter with one does not count;
      // a newer row of a pair with an amm_share is no sentinel
      const sentinel = (amm: MarketsAmmFilter, totalAmmShare: string | null, version: number): MarketsLiveRow => ({
        ...SAMPLE_ROWS[Table.MarketsLive],
        period: 'day',
        amm,
        base_currency: '',
        base_issuer: '',
        counter_currency: '',
        counter_issuer: '',
        total_amm_share: totalAmmShare,
        version,
      });
      const newer = Date.now() + 3_600_000;
      await ch.insert(Table.MarketsLive, [sentinel('include', null, newer)]);
      expect(await marketsAmmShareKnown(ch)).toEqual(new Map([['day', false]]));
      await ch.insert(Table.MarketsLive, [sentinel('only', '0.5000', newer + 1)]);
      await ch.insert(Table.MarketsLive, [
        { ...SAMPLE_ROWS[Table.MarketsLive], period: 'day', amm: 'include', amm_share: '0.5000', version: newer + 2 },
      ]);
      expect(await marketsAmmShareKnown(ch)).toEqual(new Map([['day', false]]));
      // the next set is newer still, and has one; the other periods have their own
      expect((await compute(ch, 'day')).written).toBe(true);
      expect((await compute(ch, '7day')).written).toBe(true);
      expect(await marketsAmmShareKnown(ch)).toEqual(
        new Map([
          ['day', true],
          ['7day', true],
        ]),
      );
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
        amm_account: '',
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

  // -------------------------------------------------------------------------------------------------------------------
  describe('the AMM recordings', () => {
    const ctx = parseContextFor(getNetworkProfile('xrpl'));
    const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/amm')).list();
    const built = ledgers.map((raw) => buildLedgerRows(raw, ctx));
    /** The rows the ledger writer stores in `exchanges`. */
    const recorded = built.flatMap((b) => b.exchanges);
    /** t: the close time of the newest recorded ledger (2026-10-17 08:42:50); the run is a few minutes later. */
    const t = Math.max(...ledgers.map((l) => l.header.close_time));
    const currentHour = Math.floor(t / HOUR) * HOUR;
    /** Each pool as its newest state row has it, which is what the pools job writes to `amm_pools`. */
    const recordedPools = (): OraclePool[] => {
      const newest = new Map<string, (typeof built)[number]['ammPoolStates'][number]>();
      for (const state of built
        .flatMap((b) => b.ammPoolStates)
        .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index)) {
        newest.set(state.amm_account, state);
      }
      return [...newest.values()].map((state) => ({
        amm_account: state.amm_account,
        base_currency: state.base_currency,
        base_issuer: state.base_issuer,
        counter_currency: state.counter_currency,
        counter_issuer: state.counter_issuer,
        deleted: state.deleted,
        version: 1,
      }));
    };
    let ch: ClickHouseService;

    beforeAll(async () => {
      ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      await recomputeAmmPools(
        ch,
        new RatesService(ch, 'XRP'),
        recordedPools().map((pool) => pool.amm_account),
      );
      // the hours of the day's window and of its 7 sparkline days
      await writeHourSets(ch, Math.floor(currentHour / DAY) * DAY - (SPARKLINE_DAYS - 1) * DAY, currentHour);
    }, 300_000);

    it('the include, exclude and only sets of the day equal the oracle over the stored exchanges rows, and the recorded pools give amm_pool', async () => {
      expect(await computeMarketsSet(ch, 'XRP', 'day', new Date((t + 7 * 60) * SEC))).toEqual({
        written: true,
        pairs: expect.any(Number),
        startTime: currentHour - DAY,
        endTime: t,
        ammShareKnown: true,
      });
      const sets = await storedSets(ch, 'day');
      for (const filter of MARKETS_AMM_FILTERS) {
        expectSet(sets[filter], marketsOracle(recorded, 'XRP', 24, t, { filter, pools: recordedPools() }));
      }

      // the comparisons are not vacuous: the window has pairs of swaps only, of the order book only and of both, pairs
      // with a live pool and pairs without one, and pairs with a native volume
      const shares = sets.include.markets.map((m) => m.amm_share);
      expect(shares).toContain('1.0000');
      expect(shares).toContain('0.0000');
      expect(shares.some((share) => share !== '0.0000' && share !== '1.0000')).toBe(true);
      expect(new Set(sets.include.markets.map((m) => m.amm_pool))).toEqual(new Set([0, 1]));
      expect(sets.exclude.markets.length).toBeGreaterThan(0);
      expect(sets.only.markets.length).toBeGreaterThan(0);
      expect(sets.include.markets.some((m) => m.native_volume !== null)).toBe(true);
      expect(Number(sets.include.sentinel.total_amm_share)).toBeGreaterThan(0);
    });
  });
});

import BigNumber from 'bignumber.js';
import { ExchangesRow } from '../src/clickhouse/rows';
import { DUST, Wide } from './volume-oracle';

/**
 * The oracle of the markets tests: what the markets of a window have to be, worked out in plain JavaScript and BigNumber
 * straight from the rows the ledger writer stores in `exchanges` (spec 3.3), without `pair_hourly` and without the code
 * under test. The rules, as the spec has them:
 *
 * - the window holds the trades that closed from `floorHour(t) - period` up to `t` (the close time of the newest ledger of
 *   the current hour, which the hour's set was made at: no trade of the hour is later), native dust (0.0005 or less on a
 *   native side) left out;
 * - a pair has its `count`, the two volumes (exact sums, the Float64 sums when an hour holds an amount an exact sum cannot
 *   hold: 1e36 or more, or more than 30 decimal places, or its Float64 sum reaches 1e36), `open` and `last` (the first and
 *   last trade by `(ledger, tx, node)`), `high` and `low` (by rate, the first by key of equal ones) and their times;
 * - the native volume is that of the native side; else the base volume over the base's rate, else the counter volume over
 *   the counter's rate (an asset's rate is its volume over the native volume of its pair against the native currency in the
 *   window), the quotient cut to 17 significant digits; else none;
 * - the closes are the last trade of each of the 7 UTC days ending with the day of t, a quiet day carrying the close before
 *   it and a day with none before it (in those 7 days) having none.
 *
 * And the AMM part (spec D2b.1, with the plan's D3 to D5):
 *
 * - a set is of a filter: `include` takes every trade, `exclude` the order-book trades (`amm_account = ''`), `only` the
 *   swaps (`amm_account != ''`). The markets, their volumes, prices and closes and the totals are those of the filter's
 *   trades; the rates of the native volumes are those of every trade, whatever the filter;
 * - a pair's exact sums are per hour and source (a pair has an hour of order-book trades and an hour of swaps): one of them
 *   that does not fit makes the pair's volumes the Float64 sums;
 * - `amm_share` is the base volume of the pair's swaps over the base volume of all its trades, 4 decimals rounded half up,
 *   the same in every filter (none when that base volume is not above 0); `amm_pool` is 1 when the newest row (highest
 *   version) of a pool of the pair is not deleted, else 0; `total_amm_share` is the sum over every pair of the window with
 *   a native volume (all trades) of its native volume times its exact share, over the sum of those native volumes, rounded
 *   once, `0.0000` when no pair has a native volume;
 * - when a ledger of the window was written by a parser that knows no AMM (`known` false) the three are none.
 */

const HOUR = 3600;
const DAY = 86_400;
const SPARKLINE_DAYS = 7;
/** The significant digits of a quotient (the code under test calls it `QUOTIENT_DIGITS`). */
const QUOTIENT_DIGITS = 17;
/** Exact sums hold amounts below this and with at most 30 decimal places. */
const EXACT_LIMIT = new BigNumber('1e36');

export interface OracleMarket {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  count: number;
  base_volume: string;
  counter_volume: string;
  native_volume: string | null;
  open: string;
  high: string;
  low: string;
  last: string;
  open_time: number;
  last_time: number;
  closes: Array<string | null>;
  amm_share: string | null;
  amm_pool: number | null;
}

export interface OracleSet {
  start_time: number;
  end_time: number;
  pairs_traded: number;
  total_count: number;
  total_native_volume: string;
  total_amm_share: string | null;
  /** In the order of the pair key: base currency, base issuer, counter currency, counter issuer. */
  markets: OracleMarket[];
}

/** Which trades a set takes. */
export type OracleFilter = 'include' | 'exclude' | 'only';

/** A row of `amm_pools`: the pool, its pair (stored as the pairs of `exchanges` are), whether it is deleted, its version. */
export interface OraclePool {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  deleted: number;
  version: number;
}

export interface OracleAmm {
  /** The filter of the set; `include` when not given. */
  filter?: OracleFilter;
  /** The rows of `amm_pools`, every version of a pool. */
  pools?: OraclePool[];
  /** Whether every ledger of the window was written by a parser that knows AMM; true when not given. */
  known?: boolean;
}

const floorHour = (t: number): number => Math.floor(t / HOUR) * HOUR;
const floorDay = (t: number): number => Math.floor(t / DAY) * DAY;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The order of the pair key: base currency, base issuer, counter currency, counter issuer (not that of their joined text). */
const byPair = (a: ExchangesRow, b: ExchangesRow): number =>
  compare(a.base_currency, b.base_currency) ||
  compare(a.base_issuer, b.base_issuer) ||
  compare(a.counter_currency, b.counter_currency) ||
  compare(a.counter_issuer, b.counter_issuer);

const byKey = (a: ExchangesRow, b: ExchangesRow): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;

/** Both native legs above the dust: a side without an issuer is the native currency. */
const kept = (r: ExchangesRow): boolean =>
  (r.base_issuer !== '' || new BigNumber(r.base_amount).gt(DUST)) &&
  (r.counter_issuer !== '' || new BigNumber(r.counter_amount).gt(DUST));

/** An amount the exact sums hold whole. */
const fits = (amount: string): boolean =>
  new BigNumber(amount).lt(EXACT_LIMIT) && (new BigNumber(amount).decimalPlaces() ?? 0) <= 30;

const pairOf = (r: ExchangesRow): string =>
  [r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('|');
const assetKeyOf = (currency: string, issuer: string): string => `${currency}|${issuer}`;

const ratio = (a: BigNumber.Value, b: BigNumber.Value): BigNumber => new BigNumber(new Wide(a).dividedBy(b));
/** A share as text: 4 decimals, rounded half up from the (wide) quotient. */
const shareText = (part: BigNumber.Value, whole: BigNumber.Value): string =>
  new Wide(part).dividedBy(whole).toFixed(4, BigNumber.ROUND_HALF_UP);

const isSwap = (r: ExchangesRow): boolean => r.amm_account !== '';

/** The volumes of a pair's trades in the window: exact, or the Float64 sums when one of its hours of a source does not fit. */
function volumesOf(group: ExchangesRow[]): { base: BigNumber; counter: BigNumber } {
  const hours = new Map<string, ExchangesRow[]>();
  for (const r of group) {
    const hour = `${floorHour(r.close_time)}|${isSwap(r) ? 'amm' : 'book'}`;
    hours.set(hour, [...(hours.get(hour) ?? []), r]);
  }
  const floatSum = (rows: ExchangesRow[], column: 'base_amount_f' | 'counter_amount_f'): number =>
    rows.reduce((sum, r) => sum + r[column], 0);
  const unfit = [...hours.values()].some(
    (rows) =>
      rows.some((r) => !fits(r.base_amount) || !fits(r.counter_amount)) ||
      new BigNumber(floatSum(rows, 'base_amount_f')).gte(EXACT_LIMIT) ||
      new BigNumber(floatSum(rows, 'counter_amount_f')).gte(EXACT_LIMIT),
  );
  if (unfit) {
    return {
      base: new BigNumber(floatSum(group, 'base_amount_f')),
      counter: new BigNumber(floatSum(group, 'counter_amount_f')),
    };
  }
  return {
    base: group.reduce((sum, r) => sum.plus(r.base_amount), new BigNumber(0)),
    counter: group.reduce((sum, r) => sum.plus(r.counter_amount), new BigNumber(0)),
  };
}

/** The trades grouped by pair, in the order of the pair key, with their volumes. */
function pairsOf(
  rows: ExchangesRow[],
): Array<{ key: string; rows: ExchangesRow[]; base: BigNumber; counter: BigNumber }> {
  const groups = new Map<string, ExchangesRow[]>();
  for (const r of rows) groups.set(pairOf(r), [...(groups.get(pairOf(r)) ?? []), r]);
  return [...groups.entries()]
    .map(([key, group]) => ({ key, rows: group, ...volumesOf(group) }))
    .sort((a, b) => byPair(a.rows[0], b.rows[0]));
}

/**
 * The markets of the window of `periodHours` hours that ends with the current hour of `t`, of the filter `amm.filter`
 * (see the top of the file).
 */
export function marketsOracle(
  exchanges: ExchangesRow[],
  nativeCurrency: string,
  periodHours: number,
  t: number,
  amm: OracleAmm = {},
): OracleSet {
  const { filter = 'include', pools = [], known = true } = amm;
  const start = floorHour(t) - periodHours * HOUR;
  const isNative = (currency: string, issuer: string): boolean => issuer === '' && currency === nativeCurrency;
  const takes = (r: ExchangesRow): boolean => filter === 'include' || (filter === 'only') === isSwap(r);

  const inWindow = exchanges.filter((r) => kept(r) && r.close_time >= start && r.close_time <= t).sort(byKey);
  // every trade (the rates, the AMM share), the swaps (the AMM share), and the trades of the filter (everything else)
  const all = pairsOf(inWindow);
  const swapBase = new Map(pairsOf(inWindow.filter(isSwap)).map((p) => [p.key, p.base]));
  const pairs = pairsOf(inWindow.filter(takes));

  // how many units of an asset one native coin buys: its volume over the native volume of its pair against the native currency
  const rate = new Map<string, BigNumber>();
  for (const p of all) {
    const first = p.rows[0];
    if (isNative(first.counter_currency, first.counter_issuer) && p.counter.gt(0)) {
      rate.set(assetKeyOf(first.base_currency, first.base_issuer), ratio(p.base, p.counter));
    } else if (isNative(first.base_currency, first.base_issuer) && p.base.gt(0)) {
      rate.set(assetKeyOf(first.counter_currency, first.counter_issuer), ratio(p.counter, p.base));
    }
  }

  const nativeVolumeOf = (p: { rows: ExchangesRow[]; base: BigNumber; counter: BigNumber }): BigNumber | null => {
    const [first] = p.rows;
    if (isNative(first.counter_currency, first.counter_issuer)) return p.counter;
    if (isNative(first.base_currency, first.base_issuer)) return p.base;
    const baseRate = rate.get(assetKeyOf(first.base_currency, first.base_issuer));
    const counterRate = rate.get(assetKeyOf(first.counter_currency, first.counter_issuer));
    if (baseRate?.gt(0)) return ratio(p.base, baseRate).precision(QUOTIENT_DIGITS);
    if (counterRate?.gt(0)) return ratio(p.counter, counterRate).precision(QUOTIENT_DIGITS);
    return null;
  };

  // the AMM share of every pair, over all its trades (none when its base volume is not above 0); and the pairs that have
  // a pool whose newest row is not deleted
  const shares = new Map(all.map((p) => [p.key, p.base.gt(0) ? ratio(swapBase.get(p.key) ?? 0, p.base) : null]));
  const newestPools = new Map<string, OraclePool>();
  for (const pool of pools) {
    const seen = newestPools.get(pool.amm_account);
    if (!seen || pool.version > seen.version) newestPools.set(pool.amm_account, pool);
  }
  const pooled = new Set(
    [...newestPools.values()]
      .filter((pool) => pool.deleted === 0)
      .map((pool) => [pool.base_currency, pool.base_issuer, pool.counter_currency, pool.counter_issuer].join('|')),
  );
  // the total share: each pair's share weighted by its native volume, over the pairs with one
  let weighted = new BigNumber(0);
  let natives = new BigNumber(0);
  for (const p of all) {
    const native = nativeVolumeOf(p);
    if (native === null) continue;
    natives = natives.plus(native);
    weighted = weighted.plus(native.times(shares.get(p.key) ?? 0));
  }

  // the sparkline: the last trade of each UTC day, from the first of the 7 days up to t
  const sparkStart = floorDay(t) - (SPARKLINE_DAYS - 1) * DAY;
  const dayCloses = new Map<string, Map<number, string>>();
  for (const r of exchanges
    .filter((e) => takes(e) && kept(e) && e.close_time >= sparkStart && e.close_time <= t)
    .sort(byKey)) {
    const days = dayCloses.get(pairOf(r)) ?? new Map<number, string>();
    days.set(Math.floor((r.close_time - sparkStart) / DAY), r.rate); // the keys are in order: the last one wins
    dayCloses.set(pairOf(r), days);
  }

  const markets = pairs.map((p): OracleMarket => {
    const [first] = p.rows;
    const last = p.rows[p.rows.length - 1];
    // the highest and the lowest rate by value; of equal ones the first by key (the rows are in order of their keys)
    const high = p.rows.reduce((best, r) => (r.rate_f > best.rate_f ? r : best));
    const low = p.rows.reduce((best, r) => (r.rate_f < best.rate_f ? r : best));
    const nativeVolume = nativeVolumeOf(p);
    const share = shares.get(p.key);

    const closes: Array<string | null> = [];
    const days = dayCloses.get(p.key) ?? new Map<number, string>();
    let carried: string | null = null;
    for (let day = 0; day < SPARKLINE_DAYS; day++) {
      carried = days.get(day) ?? carried;
      closes.push(carried);
    }

    return {
      base_currency: first.base_currency,
      base_issuer: first.base_issuer,
      counter_currency: first.counter_currency,
      counter_issuer: first.counter_issuer,
      count: p.rows.length,
      base_volume: p.base.toString(),
      counter_volume: p.counter.toString(),
      native_volume: nativeVolume === null ? null : nativeVolume.toString(),
      open: first.rate,
      high: high.rate,
      low: low.rate,
      last: last.rate,
      open_time: first.close_time,
      last_time: last.close_time,
      closes,
      amm_share: known && share ? shareText(share, 1) : null,
      amm_pool: known ? (pooled.has(p.key) ? 1 : 0) : null,
    };
  });

  return {
    start_time: start,
    end_time: t,
    pairs_traded: markets.length,
    total_count: markets.reduce((sum, m) => sum + m.count, 0),
    total_native_volume: markets
      .reduce((sum, m) => (m.native_volume === null ? sum : sum.plus(m.native_volume)), new BigNumber(0))
      .toString(),
    total_amm_share: known ? (natives.gt(0) ? shareText(weighted, natives) : '0.0000') : null,
    markets,
  };
}

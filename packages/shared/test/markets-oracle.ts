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
}

export interface OracleSet {
  start_time: number;
  end_time: number;
  pairs_traded: number;
  total_count: number;
  total_native_volume: string;
  /** In the order of the pair key: base currency, base issuer, counter currency, counter issuer. */
  markets: OracleMarket[];
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

/** The volumes of a pair's trades in the window: exact, or the Float64 sums when one of its hours does not fit. */
function volumesOf(group: ExchangesRow[]): { base: BigNumber; counter: BigNumber } {
  const hours = new Map<number, ExchangesRow[]>();
  for (const r of group) hours.set(floorHour(r.close_time), [...(hours.get(floorHour(r.close_time)) ?? []), r]);
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

/** The markets of the window of `periodHours` hours that ends with the current hour of `t` (see the top of the file). */
export function marketsOracle(
  exchanges: ExchangesRow[],
  nativeCurrency: string,
  periodHours: number,
  t: number,
): OracleSet {
  const start = floorHour(t) - periodHours * HOUR;
  const isNative = (currency: string, issuer: string): boolean => issuer === '' && currency === nativeCurrency;

  const inWindow = exchanges.filter((r) => kept(r) && r.close_time >= start && r.close_time <= t).sort(byKey);
  const groups = new Map<string, ExchangesRow[]>();
  for (const r of inWindow) groups.set(pairOf(r), [...(groups.get(pairOf(r)) ?? []), r]);

  const pairs = [...groups.entries()]
    .map(([key, rows]) => ({ key, rows, ...volumesOf(rows) }))
    .sort((a, b) => byPair(a.rows[0], b.rows[0]));

  // how many units of an asset one native coin buys: its volume over the native volume of its pair against the native currency
  const rate = new Map<string, BigNumber>();
  for (const p of pairs) {
    const first = p.rows[0];
    if (isNative(first.counter_currency, first.counter_issuer) && p.counter.gt(0)) {
      rate.set(assetKeyOf(first.base_currency, first.base_issuer), ratio(p.base, p.counter));
    } else if (isNative(first.base_currency, first.base_issuer) && p.base.gt(0)) {
      rate.set(assetKeyOf(first.counter_currency, first.counter_issuer), ratio(p.counter, p.base));
    }
  }

  // the sparkline: the last trade of each UTC day, from the first of the 7 days up to t
  const sparkStart = floorDay(t) - (SPARKLINE_DAYS - 1) * DAY;
  const dayCloses = new Map<string, Map<number, string>>();
  for (const r of exchanges.filter((e) => kept(e) && e.close_time >= sparkStart && e.close_time <= t).sort(byKey)) {
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

    let nativeVolume: BigNumber | null = null;
    if (isNative(first.counter_currency, first.counter_issuer)) nativeVolume = p.counter;
    else if (isNative(first.base_currency, first.base_issuer)) nativeVolume = p.base;
    else {
      const baseRate = rate.get(assetKeyOf(first.base_currency, first.base_issuer));
      const counterRate = rate.get(assetKeyOf(first.counter_currency, first.counter_issuer));
      if (baseRate?.gt(0)) nativeVolume = ratio(p.base, baseRate).precision(QUOTIENT_DIGITS);
      else if (counterRate?.gt(0)) nativeVolume = ratio(p.counter, counterRate).precision(QUOTIENT_DIGITS);
    }

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
    markets,
  };
}

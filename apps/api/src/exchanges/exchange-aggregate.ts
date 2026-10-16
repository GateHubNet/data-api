import { Asset, exactAmount, ratio } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime, precision8 } from '../common/format';

/**
 * The aggregates of the exchanges of a pair: candles (`interval`) and the reduced row (`reduce`) of `getExchanges.js`.
 *
 * Both come from one aggregation in ClickHouse of the exchanges as they are stored (the pair in canonical order).
 *
 * The prices are the exact stored rates of the exchanges they name (open and close by the key of the exchange, high
 * and low by the rate), so they are eight significant digits of the exact text, as the raw `rate` is.
 *
 * The volumes are exact: the stored amounts (exact decimal text) are summed as `Decimal256(30)`. The original summed
 * `parseFloat`s and served the float's text (`50.00000000000001`, where the amounts add up to 50); a float sum also
 * depends on the order of its terms, which in ClickHouse depends on how the rows come in blocks, so the same request
 * could differ in its last digit from one answer to the next. The exact sum is the same every time and written as a
 * number's text was (exponent from 1e21 and below 1e-6).
 *
 * An amount is summed exactly only when the decimal holds it whole (`exactAmount`): at most 30 decimal places (a
 * `Decimal256(30)` silently drops the digits after them, so 1e-35 would count as 0) and below 1e36 (so that up to 1e10
 * of them stay below the 1e46 it holds; a sum past it wraps without an error). Issued amounts run from 1e-81 to 1e96,
 * and a stored amount is the difference of two ledger amounts, which can have more digits than either. An aggregation
 * that holds an amount outside that window falls back to the Float64 sums of the shadows, as the original's were.
 */

/** A price of nothing: `0.0000000`. */
const ZERO_PRICE = precision8(0);

/** One aggregation of exchanges as the query reads it (`AGGREGATE_COLUMNS`), in the stored orientation. */
export interface AggregateRow {
  /** How many exchanges. */
  n: number;
  /** The rate of the first exchange by `(ledger_index, tx_index, node_index)`, and of the last. */
  open_rate: string;
  close_rate: string;
  /** The rate of the exchange with the highest `rate_f`, and with the lowest (the first by key of equal ones). */
  high_rate: string;
  low_rate: string;
  /** Σ base amount and Σ counter amount, exact decimal text (`null`: no amount to sum). */
  base_sum: string | null;
  counter_sum: string | null;
  /** Σ base amount of the exchanges the taker bought (`buyer = taker`): the buy volume of the stored pair. */
  base_bought: string | null;
  /** Σ counter amount of those the taker sold (`seller = taker`): the buy volume of the inverted pair. */
  counter_bought: string | null;
  /** How many exchanges have an amount the exact sums cannot hold whole; if any, the Float64 sums below are used. */
  unfit: number;
  base_sum_f: number;
  counter_sum_f: number;
  base_bought_f: number;
  counter_bought_f: number;
  /** Unix seconds of the close time of the first ledger and of the last. */
  open_ts: number;
  close_ts: number;
}

/** A candle as the query reads it: an aggregation and the start of its bucket. */
export interface BucketRow extends AggregateRow {
  bucket: number;
}

/** The pair as the client asked for it: the currencies are written in the answer this way round. */
export interface RequestedPair {
  base: Asset;
  counter: Asset;
}

/**
 * The columns an aggregation reads from its subquery (see `AGGREGATE_SOURCE_COLUMNS`): the key, the close time, the
 * rates, the amounts as exact decimals (`NULL` when they do not fit) and as floats, and the parties.
 */
export const AGGREGATE_SOURCE_COLUMNS = [
  'ledger_index',
  'tx_index',
  'node_index',
  'close_time',
  'rate',
  'rate_f',
  `${exactAmount('base_amount')} AS base_exact`,
  `${exactAmount('counter_amount')} AS counter_exact`,
  'base_amount_f',
  'counter_amount_f',
  'buyer',
  'seller',
  'taker',
].join(', ');

/**
 * The expressions of an aggregation over the rows of `AGGREGATE_SOURCE_COLUMNS`. The aliases are none of the column
 * names, so that an expression over `close_time` (the bucket) still means the column. Every pick is deterministic:
 * equal rates are told apart by the key of the exchange, and decimal sums do not depend on the order of the rows.
 */
export const AGGREGATE_COLUMNS = [
  'toUInt32(count()) AS n',
  'argMin(rate, (ledger_index, tx_index, node_index)) AS open_rate',
  'argMax(rate, (ledger_index, tx_index, node_index)) AS close_rate',
  'argMax(rate, (rate_f, -toInt64(ledger_index), -toInt64(tx_index), -toInt32(node_index))) AS high_rate',
  'argMin(rate, (rate_f, ledger_index, tx_index, node_index)) AS low_rate',
  'toString(sum(base_exact)) AS base_sum',
  'toString(sum(counter_exact)) AS counter_sum',
  'toString(sumIf(base_exact, buyer = taker)) AS base_bought',
  'toString(sumIf(counter_exact, seller = taker)) AS counter_bought',
  'toUInt32(countIf(base_exact IS NULL OR counter_exact IS NULL)) AS unfit',
  'sumKahan(base_amount_f) AS base_sum_f',
  'sumKahan(counter_amount_f) AS counter_sum_f',
  'sumKahanIf(base_amount_f, buyer = taker) AS base_bought_f',
  'sumKahanIf(counter_amount_f, seller = taker) AS counter_bought_f',
  'toUnixTimestamp(min(close_time)) AS open_ts',
  'toUnixTimestamp(max(close_time)) AS close_ts',
].join(',\n         ');

/** A candle of `?interval=`: the keys of the HBase row of `agg_exchanges` (`d` family, sorted), then the pair. */
export interface CandleObject {
  base_volume: string;
  buy_volume: number;
  close: string;
  close_time: string;
  count: number;
  counter_volume: string;
  high: string;
  low: string;
  open: string;
  open_time: string;
  /** The start of the bucket. */
  start: string;
  vwap: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
}

/**
 * The row of `?reduce=true`: the keys of the literal of the original's `reduce`, then `start` and the pair. Without an
 * exchange the open and close times are left out (the original deleted the zeros).
 */
export interface ReducedObject {
  open: string;
  high: string;
  low: string;
  close: string;
  base_volume: string;
  counter_volume: string;
  buy_volume: number;
  count: number;
  open_time?: string;
  close_time?: string;
  vwap: string;
  /** The start of the window. */
  start: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
}

interface Figures {
  open: string;
  high: string;
  low: string;
  close: string;
  vwap: string;
  base_volume: string;
  counter_volume: string;
  buy_volume: number;
}

/** The four volumes of an aggregation as text: the exact sums, or the Float64 ones when an amount did not fit. */
function volumes(row: AggregateRow): { base: string; counter: string; baseBought: string; counterBought: string } {
  if (row.unfit > 0) {
    return {
      base: String(row.base_sum_f),
      counter: String(row.counter_sum_f),
      baseBought: String(row.base_bought_f),
      counterBought: String(row.counter_bought_f),
    };
  }
  // BigNumber writes a number as JavaScript does (exponent from 1e21 and below 1e-6), as the original's floats were
  const text = (sum: string | null): string => new BigNumber(sum ?? 0).toString();
  return {
    base: text(row.base_sum),
    counter: text(row.counter_sum),
    baseBought: text(row.base_bought),
    counterBought: text(row.counter_bought),
  };
}

/**
 * The vwap: counter volume over base volume, eight significant digits. A base volume of 0 (only an exchange with a zero
 * side can give one: the parser takes the rate from the book directory, which a zero amount does not change) has no
 * vwap: it is 0, the vwap of the original's reduce without volume, never the `Infinity` or `NaN` of a division by 0.
 */
function vwap(counter: string, base: string): string {
  return new BigNumber(base).isZero() ? ZERO_PRICE : precision8(ratio(counter, base));
}

/**
 * The prices and volumes of an aggregation, for the pair as it was asked for. Inverted (`invertPair` of the original):
 * the rates are 1/rate, so high is 1/low and low is 1/high; the volumes swap; the vwap is still counter over base. The
 * buy volume is that of the inverted exchanges (base where the buyer is the taker), which is the counter of the stored
 * exchanges the taker sold; the original's reduce computed it so, its candles multiplied the stored buy volume by the
 * vwap instead (the sell side, approximated), which is fixed here.
 */
function figures(row: AggregateRow, inverted: boolean): Figures {
  const v = volumes(row);
  if (!inverted) {
    return {
      open: precision8(row.open_rate),
      high: precision8(row.high_rate),
      low: precision8(row.low_rate),
      close: precision8(row.close_rate),
      vwap: vwap(v.counter, v.base),
      base_volume: v.base,
      counter_volume: v.counter,
      buy_volume: Number(v.baseBought),
    };
  }
  return {
    open: precision8(ratio(1, row.open_rate)),
    high: precision8(ratio(1, row.low_rate)),
    low: precision8(ratio(1, row.high_rate)),
    close: precision8(ratio(1, row.close_rate)),
    vwap: vwap(v.base, v.counter),
    base_volume: v.counter,
    counter_volume: v.base,
    buy_volume: Number(v.counterBought),
  };
}

/** The pair fields the route sets: the pair as asked for, the native currency (no issuer) without an issuer key. */
function pairFields(
  pair: RequestedPair,
): Pick<CandleObject, 'base_currency' | 'base_issuer' | 'counter_currency' | 'counter_issuer'> {
  return {
    base_currency: pair.base.currency,
    ...(pair.base.issuer ? { base_issuer: pair.base.issuer } : {}),
    counter_currency: pair.counter.currency,
    ...(pair.counter.issuer ? { counter_issuer: pair.counter.issuer } : {}),
  };
}

/** The candle of a bucket. `inverted` is a pair asked for the other way round than it is stored. */
export function toCandleObject(row: BucketRow, pair: RequestedPair, inverted: boolean): CandleObject {
  const f = figures(row, inverted);
  return {
    base_volume: f.base_volume,
    buy_volume: f.buy_volume,
    close: f.close,
    close_time: fmtTime(row.close_ts),
    count: row.n,
    counter_volume: f.counter_volume,
    high: f.high,
    low: f.low,
    open: f.open,
    open_time: fmtTime(row.open_ts),
    start: fmtTime(row.bucket),
    vwap: f.vwap,
    ...pairFields(pair),
  };
}

/**
 * The reduced row of a window. `start` is the start of the window: the original wrote the time of the request there
 * (`smoment(undefined)`, the reduced row has no start of its own), which says nothing about the data. No exchange (no
 * row, or a count of 0) is the original's row of zeros.
 */
export function toReducedObject(
  row: AggregateRow | undefined,
  pair: RequestedPair,
  inverted: boolean,
  start: Date,
): ReducedObject {
  if (row === undefined || row.n === 0) {
    return {
      open: ZERO_PRICE,
      high: ZERO_PRICE,
      low: ZERO_PRICE,
      close: ZERO_PRICE,
      base_volume: '0',
      counter_volume: '0',
      buy_volume: 0,
      count: 0,
      vwap: ZERO_PRICE,
      start: fmtTime(start),
      ...pairFields(pair),
    };
  }
  const f = figures(row, inverted);
  return {
    open: f.open,
    high: f.high,
    low: f.low,
    close: f.close,
    base_volume: f.base_volume,
    counter_volume: f.counter_volume,
    buy_volume: f.buy_volume,
    count: row.n,
    open_time: fmtTime(row.open_ts),
    close_time: fmtTime(row.close_ts),
    vwap: f.vwap,
    start: fmtTime(start),
    ...pairFields(pair),
  };
}

/**
 * The columns of the CSV of candles and of the reduced row. The original rewrote its first row into this list "to
 * ensure consistent order and inclusion of all fields" but forgot `buy_volume`: the first row lost it, and the column
 * came after `start` only when there was a second row. It is the last column of every row here.
 */
export const AGGREGATE_CSV_COLUMNS = [
  'open',
  'high',
  'low',
  'close',
  'vwap',
  'count',
  'base_currency',
  'base_issuer',
  'base_volume',
  'counter_currency',
  'counter_issuer',
  'counter_volume',
  'open_time',
  'close_time',
  'start',
  'buy_volume',
] as const;

export type AggregateCsvRow = Record<(typeof AGGREGATE_CSV_COLUMNS)[number], string | number | null>;

/** A candle or the reduced row as a row of the CSV: every column, `null` (an empty cell) for what it does not have. */
export function toAggregateCsvRow(aggregate: CandleObject | ReducedObject): AggregateCsvRow {
  const fields = aggregate as unknown as Record<string, string | number | undefined>;
  return Object.fromEntries(AGGREGATE_CSV_COLUMNS.map((column) => [column, fields[column] ?? null])) as AggregateCsvRow;
}

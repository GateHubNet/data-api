import BigNumber from 'bignumber.js';

/**
 * Exact sums of the amounts of `exchanges` and the ratios of them, shared by the exchange aggregates of the API and by
 * `RatesService`.
 *
 * The amounts are stored as exact decimal text (`base_amount`, `counter_amount`) with a Float64 shadow (`*_f`). A sum of
 * the shadows depends on the order of its terms (in ClickHouse on how the rows come in blocks), so the same request
 * could differ in its last digit from one answer to the next. A sum of `Decimal256(30)` is exact and does not, so it is
 * used wherever the decimal can hold every amount whole (`exactAmount`); a sum that holds an amount it cannot falls back
 * to the Float64 sums.
 */

/** The decimal places a `Decimal256` of the exact sums keeps. */
export const EXACT_SCALE = 30;

/** Amounts at or above this are not summed as decimals: up to 1e10 of them stay below the 1e46 a `Decimal256(30)` holds. */
export const EXACT_LIMIT = '1e36';

/**
 * The exact decimal of an amount column (`base_amount`, `counter_amount`: code, never input), or `NULL` when the
 * decimal cannot hold it whole. An amount is summed exactly only when it has at most 30 decimal places (a
 * `Decimal256(30)` silently drops the digits after them, so 1e-35 would count as 0) and is below 1e36 (so that up to
 * 1e10 of them stay below the 1e46 it holds; a sum past it wraps without an error). Issued amounts run from 1e-81 to
 * 1e96, and a stored amount is the difference of two ledger amounts, which can have more digits than either. The
 * decimal places are counted on the text, as BigNumber writes it: `123.456`, or a mantissa and an exponent,
 * `1.234567890123456e-25` (15 places, less the exponent: 40), `1e+21` (-21).
 */
export function exactAmount(column: 'base_amount' | 'counter_amount'): string {
  const places =
    `toInt64(if(position(${column}, '.') = 0, 0, length(splitByChar('e', ${column})[1]) - position(${column}, '.')))` +
    ` - toInt64OrZero(replaceOne(splitByChar('e', ${column})[2], '+', ''))`;
  return (
    `if(${places} <= ${EXACT_SCALE} AND ${column}_f < ${EXACT_LIMIT}, ` +
    `toDecimal256OrNull(${column}, ${EXACT_SCALE}), NULL)`
  );
}

// 1 / rate, with room for the rates the ledger allows: an amount runs from 1e-81 to 1e96, so a rate and its inverse
// need up to some 180 decimal places to keep eight significant digits. The default of 20 would turn the inverse of a
// rate above 1e12 into 0.
const Wide = BigNumber.clone({ DECIMAL_PLACES: 200 });

/**
 * `a / b` with the room of an inverse rate (see above): a rate, its inverse or a vwap keep their eight digits. The
 * quotient is an ordinary BigNumber (the value is copied as it is, not rounded again), so the caller's own arithmetic
 * does not inherit the 200 places.
 */
export function ratio(a: BigNumber.Value, b: BigNumber.Value): BigNumber {
  return new BigNumber(new Wide(a).dividedBy(b));
}

/**
 * The columns an aggregation of exchanges reads from its source: the amounts as exact decimals (`NULL` when they do not
 * fit) and as floats. Select them from `exchanges`; `VOLUME_COLUMNS` then sums them.
 */
export const VOLUME_SOURCE_COLUMNS = [
  `${exactAmount('base_amount')} AS base_exact`,
  `${exactAmount('counter_amount')} AS counter_exact`,
  'base_amount_f',
  'counter_amount_f',
].join(', ');

/**
 * The sums of `VOLUME_SOURCE_COLUMNS`, optionally only of the rows that meet `cond` (a condition on the columns of the
 * source, code and never input). Read the result with `volumesOf`.
 */
export function volumeColumns(cond?: string): string {
  const on = (agg: string, ...args: string[]): string =>
    cond === undefined ? `${agg}(${args.join(', ')})` : `${agg}If(${[...args, cond].join(', ')})`;
  const misfit = 'base_exact IS NULL OR counter_exact IS NULL';
  return [
    `toUInt32(${on('count')}) AS n`,
    `toString(${on('sum', 'base_exact')}) AS base_sum`,
    `toString(${on('sum', 'counter_exact')}) AS counter_sum`,
    `toUInt32(${cond === undefined ? `countIf(${misfit})` : `countIf((${cond}) AND (${misfit}))`}) AS unfit`,
    `${on('sumKahan', 'base_amount_f')} AS base_sum_f`,
    `${on('sumKahan', 'counter_amount_f')} AS counter_sum_f`,
  ].join(', ');
}

/** What `volumeColumns` selects. */
export interface VolumeSums {
  /** How many exchanges. */
  n: number;
  /** Σ base amount and Σ counter amount, exact decimal text (`null`: no amount to sum). */
  base_sum: string | null;
  counter_sum: string | null;
  /** How many exchanges have an amount the exact sums cannot hold whole; if any, the Float64 sums below are used. */
  unfit: number;
  base_sum_f: number | null;
  counter_sum_f: number | null;
}

/**
 * The two volumes of an aggregation: the exact sums, or the Float64 ones when an amount did not fit. BigNumber writes
 * a number as JavaScript does, so a volume prints as the original's float did.
 */
export function volumesOf(row: VolumeSums): { base: BigNumber; counter: BigNumber } {
  if (row.unfit > 0) {
    return { base: new BigNumber(row.base_sum_f ?? 0), counter: new BigNumber(row.counter_sum_f ?? 0) };
  }
  return { base: new BigNumber(row.base_sum ?? 0), counter: new BigNumber(row.counter_sum ?? 0) };
}

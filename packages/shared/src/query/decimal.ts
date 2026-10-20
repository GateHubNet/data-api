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
 * The exact decimal of an amount column (`base_amount`, `counter_amount` of `exchanges`, `delivered_amount` of
 * `account_payments`: code, never input; each has an `_f` shadow next to it), or `NULL` when the
 * decimal cannot hold it whole. An amount is summed exactly only when it has at most 30 decimal places (a
 * `Decimal256(30)` silently drops the digits after them, so 1e-35 would count as 0) and is below 1e36 (so that up to
 * 1e10 of them stay below the 1e46 it holds; a sum past it wraps without an error). Issued amounts run from 1e-81 to
 * 1e96, and a stored amount is the difference of two ledger amounts, which can have more digits than either. The
 * decimal places are counted on the text, as BigNumber writes it: `123.456`, or a mantissa and an exponent,
 * `1.234567890123456e-25` (15 places, less the exponent: 40), `1e+21` (-21).
 *
 * `amount_change` of `balance_changes` has no `_f` shadow, and its amounts are signed: the shadow is the float of its own
 * text (`toFloat64OrZero`, 0 for a text that is none, which the decimal then refuses) and the limit holds for the
 * magnitude, either way round.
 */
export function exactAmount(column: 'base_amount' | 'counter_amount' | 'delivered_amount' | 'amount_change'): string {
  const places =
    `toInt64(if(position(${column}, '.') = 0, 0, length(splitByChar('e', ${column})[1]) - position(${column}, '.')))` +
    ` - toInt64OrZero(replaceOne(splitByChar('e', ${column})[2], '+', ''))`;
  const belowLimit =
    column === 'amount_change' ? `abs(toFloat64OrZero(${column})) < ${EXACT_LIMIT}` : `${column}_f < ${EXACT_LIMIT}`;
  return `if(${places} <= ${EXACT_SCALE} AND ${belowLimit}, toDecimal256OrNull(${column}, ${EXACT_SCALE}), NULL)`;
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

const sumExpr = (fn: string, column: string, cond?: string): string =>
  cond === undefined ? `${fn}(${column})` : `${fn}If(${column}, ${cond})`;

/**
 * The exact sum of a column of exact decimals (`base_exact`, ...) as text, optionally of the rows that meet `cond` (a
 * condition on the columns of the source, code and never input). `sumOf` reads it back.
 */
export function exactSum(column: string, cond?: string): string {
  return `toString(${sumExpr('sum', column, cond)})`;
}

/** The Float64 sum of a shadow column (`base_amount_f`, ...), optionally of the rows that meet `cond`. `sumOf` reads it back. */
export function floatSum(column: string, cond?: string): string {
  return sumExpr('sumKahan', column, cond);
}

/**
 * The sums of `VOLUME_SOURCE_COLUMNS`, optionally only of the rows that meet `cond` (a condition on the columns of the
 * source, code and never input). Read the result with `volumesOf`.
 */
export function volumeColumns(cond?: string): string {
  const misfit = 'base_exact IS NULL OR counter_exact IS NULL';
  return [
    `toUInt32(${cond === undefined ? 'count()' : `countIf(${cond})`}) AS n`,
    `${exactSum('base_exact', cond)} AS base_sum`,
    `${exactSum('counter_exact', cond)} AS counter_sum`,
    `toUInt32(${cond === undefined ? `countIf(${misfit})` : `countIf((${cond}) AND (${misfit}))`}) AS unfit`,
    `${floatSum('base_amount_f', cond)} AS base_sum_f`,
    `${floatSum('counter_amount_f', cond)} AS counter_sum_f`,
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
 * A sum read back: the exact one, or the Float64 one when an amount did not fit a decimal (`unfit` > 0: the exact sums
 * left that amount out or cut it). This is the one place of that rule. BigNumber writes a number as JavaScript does, so
 * a volume prints as the original's float did.
 */
export function sumOf(unfit: number, exact: string | null, float: number | null): BigNumber {
  return unfit > 0 ? new BigNumber(float ?? 0) : new BigNumber(exact ?? 0);
}

/** The two volumes of an aggregation (`volumeColumns`), each by `sumOf`. */
export function volumesOf(row: VolumeSums): { base: BigNumber; counter: BigNumber } {
  return {
    base: sumOf(row.unfit, row.base_sum, row.base_sum_f),
    counter: sumOf(row.unfit, row.counter_sum, row.counter_sum_f),
  };
}

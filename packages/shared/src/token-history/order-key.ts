import BigNumber from 'bignumber.js';

/**
 * The order key of a holder's amount (spec 3.4): holders are ordered by it, then by holder, so the order is exact where a
 * double would tie. `orderKeySql` (`token-side.sql.ts`) is the same rule in SQL, and a property test pins the two together.
 */

/** An order key: compare `exp`, then `mant`. */
export interface OrderKey {
  exp: number;
  mant: bigint;
}

/** The key of 0, below every amount above 0. */
export const ZERO_ORDER_KEY: OrderKey = { exp: -32768, mant: 0n };

/** A ledger `STAmount`'s mantissa has 16 digits. */
const MANTISSA_DIGITS = 16;

/**
 * The order key of an amount of 0 or above. An issued amount above 0 is `(exponent, mantissa)` with the mantissa normalised to
 * `[10^15, 10^16)`, 0 is `(-32768, 0)`; an MPT amount (an integer below 2^64) is `(0, amount)`. Throws a `RangeError` for an
 * issued amount of more than 16 significant digits, which a ledger balance cannot have, and for a negative amount.
 */
export function orderKeyOf(amount: string, kind: 'issued' | 'mpt'): OrderKey {
  if (kind === 'mpt') {
    const mant = BigInt(amount);
    if (mant < 0n) throw new RangeError('amount is negative');
    return { exp: 0, mant };
  }
  const n = new BigNumber(amount);
  if (!n.isFinite()) throw new RangeError(`amount is not a number: '${amount}'`);
  if (n.isNegative() && !n.isZero()) throw new RangeError('amount is negative');
  if (n.isZero()) return ZERO_ORDER_KEY;
  if (n.sd() > MANTISSA_DIGITS) throw new RangeError('amount has more than 16 significant digits');
  // `e` is the exponent of the leading digit: the mantissa has its leading digit at 10^15
  const e = n.e!;
  return { exp: e - (MANTISSA_DIGITS - 1), mant: BigInt(n.shiftedBy(MANTISSA_DIGITS - 1 - e).toFixed()) };
}

/** The order of two keys: negative, 0 or positive, as `a` is below, equal to or above `b`. */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  if (a.exp !== b.exp) return a.exp < b.exp ? -1 : 1;
  return a.mant === b.mant ? 0 : a.mant < b.mant ? -1 : 1;
}

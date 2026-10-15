import BigNumber from 'bignumber.js';
import { dropsToXrp } from 'xrpl';

/**
 * Normalize an XRPL amount to a decimal value string in whole units.
 *
 * XRPL amounts come in three shapes:
 *  - XRP: a drops string/number (e.g. "100000000")           -> converted to XRP
 *  - IOU: an object { currency, issuer, value }              -> `value` (already whole units)
 *  - MPT: an object { mpt_issuance_id, value }               -> `value`
 *
 * Token-enabled escrows (and other token features active on testnet/mainnet) can put an
 * IOU/MPT object where older XRP-only code assumed a drops string. Passing such an object
 * to `dropsToXrp(new BigNumber(obj))` yields NaN and throws — this helper handles all three
 * shapes and returns `undefined` for missing/non-numeric input.
 */
export function amountToValueString(amount: unknown): string | undefined {
  if (amount === undefined || amount === null) return undefined;
  if (typeof amount === 'object') {
    const value = (amount as { value?: string }).value;
    return typeof value === 'string' ? value : undefined;
  }
  const bn = new BigNumber(amount as BigNumber.Value);
  if (bn.isNaN()) return undefined;
  return dropsToXrp(bn).toString();
}

const DROPS_PER_NATIVE = 1_000_000;

/**
 * Convert a drops amount of the network's native currency (XRP or XAH, both 6 decimals) to whole units, as an exact
 * decimal string. Same semantics as xrpl's `dropsToXrp`: the input must be a whole number of drops; anything else
 * throws.
 */
export function dropsToNative(drops: string | number | BigNumber): string {
  const value = new BigNumber(drops).toString(10);
  if (value.includes('.')) {
    throw new Error(`dropsToNative: value '${value}' has too many decimal places.`);
  }
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(
      `dropsToNative: invalid value '${String(drops)}', should be a BigNumber or string-encoded integer.`,
    );
  }
  return new BigNumber(value).dividedBy(DROPS_PER_NATIVE).toString(10);
}

/** True when an XRPL amount is a non-XRP token (IOU or MPT object), not XRP drops. */
export function isTokenAmount(amount: unknown): boolean {
  return typeof amount === 'object' && amount !== null;
}

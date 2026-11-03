/**
 * The fees a `SetFee` pseudo-transaction sets, from its `tx_json`. Shared by the validators' rounds (the fees in force at a round)
 * and the supply (the reserves in force at a ledger, when `network_state` has no row): one reading of the transaction, the
 * `...Drops` fields first, the digit and `UInt64` checks, the legacy forms.
 */

/** The fees in force, in drops as the text of their digits. */
export interface Fees {
  base_fee: string;
  reserve_base: string;
  reserve_inc: string;
}

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const DIGITS = /^\d+$/;
const HEX_UINT64 = /^[0-9A-Fa-f]{1,16}$/;

/** An amount of drops as the text of its digits: a whole number or a string of digits, at most a `UInt64`; else none. */
function dropsOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value === 'string' && DIGITS.test(value) && BigInt(value) <= MAX_UINT64) return BigInt(value).toString();
  return undefined;
}

/** A `UInt64` that a transaction writes as hex (the legacy `BaseFee`), as the text of its digits; else none. */
function hexDropsOf(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_UINT64.test(value) ? BigInt(`0x${value}`).toString() : undefined;
}

/** A fee of a `SetFee`: the `…Drops` field when it has one, else the legacy field; none when what is there is no amount. */
function feeOf(tx: Record<string, unknown>, drops: string, legacy: string, legacyIsHex = false): string | undefined {
  if (tx[drops] !== undefined) return dropsOf(tx[drops]);
  if (tx[legacy] === undefined) return undefined;
  return legacyIsHex ? hexDropsOf(tx[legacy]) : dropsOf(tx[legacy]);
}

/**
 * The fees a `SetFee` pseudo-transaction sets (spec 2.4 step 6), from its `tx_json`: `BaseFeeDrops`, `ReserveBaseDrops` and
 * `ReserveIncrementDrops`, or for a ledger before the XRPFees amendment the legacy `BaseFee` (hex), `ReserveBase` and
 * `ReserveIncrement`, each field from its drops form when it has both (the rule of the `FeeSettings` object, see
 * `networkStateRowFrom`). None when a fee is missing or is no amount, or the text is no transaction.
 */
export function feesOfSetFee(txJson: string): Fees | undefined {
  let tx: unknown;
  try {
    tx = JSON.parse(txJson);
  } catch {
    return undefined;
  }
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) return undefined;
  const fields = tx as Record<string, unknown>;
  const base = feeOf(fields, 'BaseFeeDrops', 'BaseFee', true);
  const reserveBase = feeOf(fields, 'ReserveBaseDrops', 'ReserveBase');
  const reserveInc = feeOf(fields, 'ReserveIncrementDrops', 'ReserveIncrement');
  if (base === undefined || reserveBase === undefined || reserveInc === undefined) return undefined;
  return { base_fee: base, reserve_base: reserveBase, reserve_inc: reserveInc };
}

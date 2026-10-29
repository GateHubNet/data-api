import { encodeAccountID } from 'ripple-address-codec';

/** An `MPTokenIssuanceID` is 24 bytes: 48 hex digits (the case does not matter). */
const MPT_ISSUANCE_ID = /^[0-9a-fA-F]{48}$/;

/** An MPT amount as the API answers it: the issuance ID is the currency, and the issuer is the one the ID encodes. */
export interface MptAmountObject {
  currency: string;
  issuer: string;
  /** The raw integer units, as the ledger writes them. */
  value: string;
  mpt_issuance_id: string;
}

/** Whether `text` is an `MPTokenIssuanceID`: 48 hex digits, in either case. */
export function isMptIssuanceId(text: string): boolean {
  return typeof text === 'string' && MPT_ISSUANCE_ID.test(text);
}

/**
 * The classic address of an issuance's issuer: an ID is `Sequence (4) | Issuer (20)` bytes. Throws a `RangeError` unless
 * `issuanceId` is 48 hex digits.
 */
export function mptIssuerOf(issuanceId: string): string {
  if (!isMptIssuanceId(issuanceId)) {
    throw new RangeError(`an MPTokenIssuanceID must be 48 hex digits: '${String(issuanceId)}'`);
  }
  return encodeAccountID(Buffer.from(issuanceId.slice(8, 48), 'hex'));
}

/** The MPT amount object of `value` units of an issuance, the ID in upper case. Throws like `mptIssuerOf`. */
export function mptAmountObject(issuanceId: string, value: string): MptAmountObject {
  const id = issuanceId.toUpperCase();
  return { currency: id, issuer: mptIssuerOf(id), value, mpt_issuance_id: id };
}

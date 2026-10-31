import { decodeAccountID, encodeAccountID } from 'ripple-address-codec';

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

/**
 * The `MPTokenIssuanceID` of an issuance, in upper case: its `Sequence` as a big-endian UInt32, then the issuer's AccountID.
 * `sequence` is the node's, never `tx.Sequence`: a create sent with a ticket has `tx.Sequence` 0. Throws on a sequence that is
 * not a UInt32 or an address that does not decode, so a parser guards what it reads from a ledger.
 */
export function mptIssuanceId(sequence: number, issuer: string): string {
  const id = Buffer.alloc(24);
  id.writeUInt32BE(sequence, 0);
  Buffer.from(decodeAccountID(issuer)).copy(id, 4);
  return id.toString('hex').toUpperCase();
}

/** The sequence and the issuer an ID holds. Throws `invalid mpt issuance id` unless `id` is 48 hex digits. */
export function decodeMptIssuanceId(id: string): { sequence: number; issuer: string } {
  if (!isMptIssuanceId(id)) throw new Error('invalid mpt issuance id');
  return { sequence: Number.parseInt(id.slice(0, 8), 16), issuer: mptIssuerOf(id) };
}

/** The MPT amount object of `value` units of an issuance, the ID in upper case. Throws like `mptIssuerOf`. */
export function mptAmountObject(issuanceId: string, value: string): MptAmountObject {
  const id = issuanceId.toUpperCase();
  return { currency: id, issuer: mptIssuerOf(id), value, mpt_issuance_id: id };
}

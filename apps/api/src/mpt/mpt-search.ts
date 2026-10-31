import { isMptIssuanceId } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';

/** What the search `q` of `kind=mpt` looks for (spec 7.1). */
export type MptSearch =
  | { by: 'issuer'; issuer: string }
  | { by: 'id'; id: string }
  | { by: 'text'; text: string; idPrefix?: string };

/** The start of an ID that a search looks for: fewer digits are as likely a ticker as the start of an ID. */
const ID_PREFIX = /^[0-9a-fA-F]{8,}$/;

/**
 * What `q` asks for, trimmed and length-checked by D6's `parseTokenListQuery`: a classic address is that issuer, 48 hex digits that
 * issuance, anything else text, which is also the start of an ID when it is 8 hex digits or more.
 */
export function mptSearchOf(q: string): MptSearch {
  if (isValidClassicAddress(q)) return { by: 'issuer', issuer: q };
  if (isMptIssuanceId(q)) return { by: 'id', id: q.toUpperCase() };
  return { by: 'text', text: q, ...(ID_PREFIX.test(q) && { idPrefix: q.toUpperCase() }) };
}

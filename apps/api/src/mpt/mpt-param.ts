import { isMptIssuanceId, MptTransferKind } from '@gatehub/data-api-shared';
import { badRequest } from '../common/errors';
import { decodeMarker, KeysetKey } from '../common/pagination';
import { first, Query } from '../common/params';
import { MPT_TRANSFER_KINDS } from './mpt-objects';

/** The IDs `GET /v2/mpt?ids=` answers at most. */
const MAX_IDS = 100;

/** An issuance ID of a route's path: 48 hex digits in either case, answered in upper case. Else 400 `invalid mpt issuance id`. */
export function parseIssuanceIdParam(raw: string): string {
  if (!isMptIssuanceId(raw)) throw badRequest('invalid mpt issuance id');
  return raw.toUpperCase();
}

/**
 * The `ids` of `GET /v2/mpt`, upper-cased, in request order, duplicates too. Checks, in order: 400 `ids is required` (missing or
 * empty), `too many ids` (more than 100, whatever they are), `invalid mpt issuance id` (an empty element too: `a,,b`).
 */
export function parseIdsParam(q: Query): string[] {
  const raw = first(q, 'ids');
  if (raw === undefined || raw === '') throw badRequest('ids is required');
  const ids = raw.split(',');
  if (ids.length > MAX_IDS) throw badRequest('too many ids');
  return ids.map(parseIssuanceIdParam);
}

/**
 * The `kind` of the transfers, a comma list of `MPT_TRANSFER_KINDS`, without repeats and in the order asked for. Missing or empty is
 * none (`undefined`); a member that is none of them (an empty one too: `lock,`) answers 400 with the kinds.
 */
export function parseKindsParam(q: Query): MptTransferKind[] | undefined {
  const raw = first(q, 'kind');
  if (raw === undefined || raw === '') return undefined;
  const kinds = raw.split(',');
  if (!kinds.every((kind) => (MPT_TRANSFER_KINDS as readonly string[]).includes(kind))) {
    throw badRequest(`invalid kind - use: ${MPT_TRANSFER_KINDS.join(', ')}`);
  }
  return [...new Set(kinds)] as MptTransferKind[];
}

/** The columns of the marker of the holders, as `decodeMarker` checks them: the balance as text, since it reaches 2^63 - 1. */
const HOLDERS_MARKER_KEYS: KeysetKey[] = [
  { column: 'balance', type: 'String' },
  { column: 'holder', type: 'String' },
];

/** A marker's balance: the digits of a `UInt64`, at most 2^63 - 1, the ledger's limit. */
const MARKER_BALANCE = /^\d{1,19}$/;
const MAX_BALANCE = 9_223_372_036_854_775_807n;

/**
 * `[balance, holder]` of a marker of the holders, or `undefined` for the first page. Anything else answers 400 `invalid marker`:
 * `decodeMarker`'s checks, and a balance that is not what a `UInt64` parameter of the read can take (ruling C21).
 */
export function decodeMptHoldersMarker(marker: string | undefined): [string, string] | undefined {
  const values = decodeMarker(marker, HOLDERS_MARKER_KEYS);
  if (values === undefined) return undefined;
  const balance = values[0] as string;
  if (!MARKER_BALANCE.test(balance) || BigInt(balance) > MAX_BALANCE) throw badRequest('invalid marker');
  return [balance, values[1] as string];
}

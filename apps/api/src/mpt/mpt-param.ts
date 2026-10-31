import { isMptIssuanceId } from '@gatehub/data-api-shared';
import { badRequest } from '../common/errors';
import { first, Query } from '../common/params';

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

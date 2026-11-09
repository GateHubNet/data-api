import { TOKEN_HISTORY_EXCLUDE_MAX } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { first, Query } from '../common/params';

/**
 * `exclude` (spec 5.0): 1 to 20 comma-separated classic addresses, sorted and without repeats; missing or empty is none. 400
 * `invalid ripple address` for an element that is none (an empty one too: `a,,b`), then `too many addresses to exclude` for more
 * than 20 distinct ones. The issuer itself, or an account that never held the token, is accepted: its figures are 0.
 */
export function parseExclude(q: Query): string[] | undefined {
  const raw = first(q, 'exclude');
  if (raw === undefined || raw === '') return undefined;
  const addresses = raw.split(',');
  if (!addresses.every((a) => isValidClassicAddress(a))) throw badRequest('invalid ripple address');
  const distinct = [...new Set(addresses)].sort();
  if (distinct.length > TOKEN_HISTORY_EXCLUDE_MAX) throw badRequest('too many addresses to exclude');
  return distinct;
}

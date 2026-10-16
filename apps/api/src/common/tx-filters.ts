import { BinaryCodecService } from './binary-codec.service';
import { badRequest } from './errors';
import { first, Query } from './params';

/**
 * The `type` and `result` filters of a transaction list (`GET /v2/transactions`, `GET /v2/accounts/:address/transactions`).
 *
 * Each is checked against the definitions of the network instead of the short lists the original kept in its route
 * files (8 types and 32 results, stale for anything newer): a type or result code the network knows is valid, so a
 * client can ask for `NFTokenMint` or `tecHOOK_REJECTED` where those exist. An empty value is no filter, and `type` is
 * checked before `result`, as in the original.
 */
export function transactionFilters(q: Query, codec: BinaryCodecService): { type?: string; result?: string } {
  const type = first(q, 'type') || undefined;
  if (type !== undefined && !codec.transactionTypes().includes(type)) {
    throw badRequest('invalid transaction type');
  }
  const result = first(q, 'result') || undefined;
  if (result !== undefined && !codec.transactionResults().includes(result)) {
    throw badRequest('invalid transaction result');
  }
  return { type, result };
}

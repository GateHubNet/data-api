import { DATE_TOO_OLD, ledgerSelector } from '../accounts/account-ledger';
import { badRequest } from '../common/errors';
import { first, Query } from '../common/params';

/** The live generation as the routes read it (`TokenHistoryService.live`). */
export interface LiveTokenHistory {
  generation: number;
  /** The ledger the answers are as of by default: the generation's `levels_through` (no reader reads past it, spec 2.5). */
  through: number;
  /** Unix seconds of `through`. */
  close_time: number;
  coverage_from: number;
}

/** The two reads a ledger of a request can need: the last stored ledger closed at or before a date, and the stored ledger of a hash. */
export interface LedgerLookups {
  atOrBefore(date: Date): Promise<number | undefined>;
  byHash(hash: string): Promise<number | undefined>;
}

/** The parameters that name a ledger, as `ledgerSelector` reads them. */
const LEDGER_PARAMS = ['ledger_index', 'ledger', 'ledger_hash', 'date', 'close_time'] as const;

/**
 * The ledger of a token history read (spec 5.0): `ledger_index` (alias `ledger`), `ledger_hash` or `date` (alias `close_time`), with
 * the trust-lines route's precedence and messages; none, or one of the node's words (`validated`, `closed`, `current`), is the
 * live generation's `through`. 400, in this order:
 *  - `a ledger is required`, for a route that needs one (`required`) and a request that names none;
 *  - the selector's own messages (`invalid date format`, `invalid ledger hash`), before any read;
 *  - `ledger is not in the token history yet`, above `through`;
 *  - `the date provided is too old`, below the generation's `coverage_from`, and for a date or a hash no stored ledger answers.
 */
export async function resolveTokenHistoryLedger(
  q: Query,
  live: LiveTokenHistory,
  lookups: LedgerLookups,
  opts: { required?: boolean } = {},
): Promise<number> {
  const required = opts.required === true;
  if (required && LEDGER_PARAMS.every((name) => !first(q, name))) throw badRequest('a ledger is required');
  const selector = ledgerSelector(q);

  let n: number | undefined;
  if (selector.hash !== undefined) {
    n = await lookups.byHash(selector.hash);
    if (n === undefined) throw badRequest(DATE_TOO_OLD);
  } else if (selector.date !== undefined) {
    n = await lookups.atOrBefore(selector.date);
    if (n === undefined) throw badRequest(DATE_TOO_OLD);
  } else if (typeof selector.index === 'number') {
    n = selector.index;
  } else if (selector.index !== undefined) {
    n = live.through;
  } else {
    if (required) throw badRequest('a ledger is required');
    n = live.through;
  }
  if (n > live.through) throw badRequest('ledger is not in the token history yet');
  if (n < live.coverage_from) throw badRequest(DATE_TOO_OLD);
  return n;
}

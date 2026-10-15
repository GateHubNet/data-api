import { badRequest, notFound } from '../common/errors';
import { endExclusive, first, parseDate, ParsedDate, Query } from '../common/params';

/**
 * Which ledger a request asks for. At most one field is set: `getLedger` of the original looks at the hash first, then
 * at the date, then at the index, and the parser has already made that choice. No field means the latest ledger.
 */
export interface LedgerId {
  index?: number;
  /** Upper case. */
  hash?: string;
  /** The ledger to serve is the last one that closed at or before this instant. */
  date?: Date;
}

const INDEX = /^\d+$/;
// `^(0x)?[0-9A-Fa-f]+$` of getLedger.js: a `0x` prefix passes the test (it is part of the text, so it is counted in the
// length and kept in the hash, which then matches no ledger).
const HEX = /^(0x)?[0-9A-Fa-f]+$/;

/** A parameter that is present: the original tests the text for truthiness, so an empty one is none. */
function given(q: Query, name: string): string | undefined {
  const value = first(q, name);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The last instant of the period a date names. The original ends its scan of the ledgers by close time one unit of the
 * precision of the text after the date (`smoment(...).hbaseFormatStopRow()`): `2015-01-14` means the ledgers up to the
 * end of that day, `2015-01-14T17:43` up to 17:43:59, and a full time up to that second.
 */
function lastInstant(date: ParsedDate): Date {
  return new Date(endExclusive(date).getTime() - 1);
}

/**
 * The ledger of a request to `/v2/ledgers/:ledger_param` as `getLedger.js` reads it.
 *
 * The path identifier is tested in this order:
 *  1. digits: a ledger index (so `2015` is the ledger 2015, not a year);
 *  2. a date (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm:ss`, ...): the ledger closed at or before it;
 *  3. even-length hex: a ledger hash, in upper case;
 *  4. anything else: 400 `invalid ledger identifier`.
 *
 * Without a path identifier the query parameters `ledger_index`, `ledger_hash` and `date` (400 `invalid date format`)
 * select the ledger. The path identifier replaces the query parameter of its own kind, and what is left is weighed as
 * the original does: `ledger_hash` first, then a date, then `ledger_index`. A `ledger_index` that is not a whole number
 * is 404 `ledger not found` (the original scanned an empty range of keys). Nothing selected: the latest ledger.
 */
export function parseLedgerIdentifier(param: string | undefined, q: Query): LedgerId {
  let index = given(q, 'ledger_index');
  let hash = given(q, 'ledger_hash');
  let date: Date | undefined;

  if (param !== undefined && param !== '') {
    if (INDEX.test(param)) {
      index = param;
    } else {
      const parsed = parseDate(param);
      if (parsed) {
        date = lastInstant(parsed);
      } else if (HEX.test(param) && param.length % 2 === 0) {
        hash = param;
      } else {
        throw badRequest('invalid ledger identifier');
      }
    }
  } else {
    const raw = given(q, 'date');
    if (raw !== undefined) {
      const parsed = parseDate(raw);
      if (!parsed) throw badRequest('invalid date format');
      date = lastInstant(parsed);
    }
  }

  if (hash !== undefined) return { hash: hash.toUpperCase() };
  if (date !== undefined) return { date };
  if (index !== undefined) {
    if (!INDEX.test(index)) throw notFound('ledger not found');
    return { index: Number(index) };
  }
  return {};
}

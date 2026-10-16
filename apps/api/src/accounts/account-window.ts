import { bool, dateParam, endExclusive, first, limitParam, Query } from '../common/params';

/**
 * What the lists under an account (`/payments`, `/exchanges`, `/balance_changes`) are asked for besides their own
 * filters; the values are already validated.
 */
export interface AccountWindow {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/**
 * The common parameters of those routes, read in the order of the originals' checks: `start` (2013-01-01 when missing
 * or empty), then `end`; each answers 400 when it is not a date. `limit` is 200 by default and at most 1000 (the
 * originals took a text that is not a number for the default, and below one is the default here: ruling R33).
 */
export function accountWindow(query: Query): AccountWindow {
  const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
  const end = dateParam(query, 'end', 'invalid end date format');
  return {
    start: start.date,
    ...(end && { endExclusive: endExclusive(end) }),
    descending: bool(query, 'descending'),
    limit: limitParam(query, { def: 200, max: 1000 }),
    marker: first(query, 'marker'),
  };
}

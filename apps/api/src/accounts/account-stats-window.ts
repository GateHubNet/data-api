import { badRequest } from '../common/errors';
import { decodeMarker, encodeMarker, KeysetKey } from '../common/pagination';
import { dateParam, Query } from '../common/params';

export const DAY_MS = 86_400_000;

/** The UTC days a stats request asks for: midnights (milliseconds), `from` included and `to` not. */
export interface StatsWindow {
  from: number;
  /** At or before `from` when no day lies in the window. */
  to: number;
}

const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
/** The first midnight at or after `ms` (`+ 0`: no `-0`). */
const ceilDay = (ms: number): number => Math.ceil(ms / DAY_MS) * DAY_MS + 0;
const floorSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

/**
 * The days of `GET /v2/accounts/:address/stats/:family`, read as `accountStats.js` and `getAccountStats` did.
 *
 * The original kept one row for each day under the key `<account>|YYYYMMDD000000` and scanned from the key of `start` up
 * to, but not including, the key of `end` (the stop row of an HBase scan is exclusive). So:
 *  - `start` (2013-01-01 when missing or empty) and `end` (now when missing) are instants, not periods: `end=2015-01-16`
 *    stops before that day, where the other routes read it as the whole day (and `end=2015-01` is 2015-01-01). A
 *    text that is not a date answers 400 `invalid start date format` or `invalid end date format`, the start first. An
 *    empty `end` is not a date either.
 *  - A day is in the window when its midnight is at or after the start and before the end, both read to the second (the
 *    key has no fractions): a start of 00:00:01 leaves that day out, an end of 00:00:01 includes it.
 *  - When the two are less than a whole day apart, either way round (`moment.diff(.., 'days')` cut toward zero), the start
 *    is cut back to the start of its day (`if (!days) start.startOf('day')`), so that `start=2015-01-14T05:00` with
 *    `end=2015-01-14T20:00` reads that day.
 */
export function statsWindow(query: Query, now: number): StatsWindow {
  let start = dateParam(query, 'start', 'invalid start date format', '2013-01-01').date.getTime();
  const end = dateParam(query, 'end', 'invalid end date format')?.date.getTime() ?? now;

  if (Math.trunc((end - start) / DAY_MS) === 0) start = startOfDay(start);
  return { from: ceilDay(floorSecond(start)), to: ceilDay(floorSecond(end)) };
}

/** The marker of a stats list holds the day of the last row of the page, as `YYYY-MM-DD`: the key of the list. */
const DAY_KEY: KeysetKey[] = [{ column: 'day', type: 'String' }];
const DAY = /^\d{4}-\d\d-\d\d$/;

/** The marker for the page that ends with the row of `day` (`YYYY-MM-DD`). */
export function dayMarker(day: string): string {
  return encodeMarker([day]);
}

/**
 * The day (`YYYY-MM-DD`) a marker holds, or `undefined` for the first page. Anything that is not a marker of a stats
 * list, or whose day does not exist, answers 400 `invalid marker`.
 */
export function markerDay(marker: string | undefined): string | undefined {
  const values = decodeMarker(marker, DAY_KEY);
  if (values === undefined) return undefined;
  const day = values[0] as string;
  if (
    !DAY.test(day) ||
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  ) {
    throw badRequest('invalid marker');
  }
  return day;
}

import { badRequest } from '../common/errors';
import { dateParam, parseDate, ParsedDate, Query } from '../common/params';

/** The longest a window of reports may be (`Math.abs(days) > 200` in `accountReports.js`). */
export const MAX_REPORT_DAYS = 200;

const DAY_MS = 86_400_000;

const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export interface ReportWindow {
  /** As the answer says it (`start`): the start of its day when the window is less than a day long. */
  start: Date;
  /** As the answer says it (`end`). */
  end: Date;
  /** The UTC days the window touches, oldest first, as `YYYY-MM-DD`; none when the end is before the start. */
  days: string[];
}

/**
 * The window of `GET /v2/accounts/:address/reports[/:date]`, read in the order of the checks of the original
 * (`prepareOptions` of `accountReports.js`):
 *  - `start` and `end` are each the moment of the request when missing; a text that is not a date is 400 `invalid date
 *    format` for `start` and `invalid end date format` for `end` (the start is checked first). An empty text is not a
 *    date either (the original parsed it). A date in the path replaces both, and is then the only thing parsed (a bad
 *    `start` is ignored); one that is not a date is `invalid date format`.
 *  - The length is the whole days between the two (`moment.diff(.., 'days')`, cut toward zero). Less than one day,
 *    either way round, cuts the start back to the start of its day; more than 200 is 400 `choose a date range less than
 *    200 days`.
 *
 * There is a report for each UTC day from the day of the start to the day of the end. The original made its row keys
 * from the start, a day apart, up to the end, so a start with a time of day (more than a day before the end) looked up
 * rows that do not exist and answered zeros for every day, dated at that time of day; the days are those of the
 * calendar here. An end before the start (by a day or more, or before the start of its day) has no day.
 */
export function reportWindow(query: Query, date: string | undefined, now: number): ReportWindow {
  let startDate: ParsedDate;
  let endDate: ParsedDate;
  if (date !== undefined) {
    const parsed = parseDate(date);
    if (!parsed) throw badRequest('invalid date format');
    startDate = endDate = parsed;
  } else {
    const instant: ParsedDate = { date: new Date(now), granularity: 'ms' };
    startDate = dateParam(query, 'start', 'invalid date format') ?? instant;
    endDate = dateParam(query, 'end', 'invalid end date format') ?? instant;
  }

  let start = startDate.date.getTime();
  const end = endDate.date.getTime();
  // `!days` of the original: 0, and -0 too
  const days = Math.trunc((end - start) / DAY_MS);
  if (days === 0) {
    start = startOfDay(start);
  } else if (Math.abs(days) > MAX_REPORT_DAYS) {
    throw badRequest('choose a date range less than 200 days');
  }

  const list: string[] = [];
  for (let day = startOfDay(start); day <= end; day += DAY_MS) list.push(new Date(day).toISOString().slice(0, 10));
  return { start: new Date(start), end: new Date(end), days: list };
}

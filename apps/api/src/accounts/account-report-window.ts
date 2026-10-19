import { badRequest } from '../common/errors';
import { dateParam, parseDate, ParsedDate, Query } from '../common/params';
import { bucketStart, dayText, nextBucket, VolumeInterval } from '../network/volume-buckets';

/**
 * The longest a window of reports may be, in buckets of its interval: 200 days (`Math.abs(days) > 200` in
 * `accountReports.js`), and with an `interval` 200 weeks or 200 months, counted from the bucket of the start to that of the
 * end.
 */
export const MAX_REPORT_DAYS = 200;

const DAY_MS = 86_400_000;

const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** How many buckets of `unit` the bucket of `to` is after the one of `from`; negative when it is before. */
function bucketsBetween(from: number, to: number, unit: 'week' | 'month'): number {
  const [first, last] = [bucketStart(from, unit), bucketStart(to, unit)];
  if (unit === 'week') return Math.round((last - first) / (7 * DAY_MS));
  const [a, b] = [new Date(first), new Date(last)];
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

export interface ReportWindow {
  /** As the answer says it (`start`): the start of its day when the window is less than a day long. */
  start: Date;
  /** As the answer says it (`end`). */
  end: Date;
  /**
   * The UTC days the reports are made of, oldest first, as `YYYY-MM-DD`. With `day`: the days the window touches, none when
   * the end is before the start. With `week` and `month`: every day of the buckets up to today (a bucket is whole though
   * the window ends in the middle of it, and the days to come have no payments).
   */
  days: string[];
  /** The bucket of a report: `day`, `week` (from Monday) or `month`, all UTC. */
  interval: VolumeInterval;
  /**
   * The start of each bucket, oldest first, as `YYYY-MM-DD`: with `day` the days of the window; else from the bucket of the
   * start to the one of the end (none when the second is before the first), those of the future included.
   */
  buckets: string[];
}

/**
 * The window of `GET /v2/accounts/:address/reports[/:date]`, read in the order of the checks of the original
 * (`prepareOptions` of `accountReports.js`), and `interval` ours:
 *  - `start` and `end` are each the moment of the request when missing; a text that is not a date is 400 `invalid date
 *    format` for `start` and `invalid end date format` for `end` (the start is checked first). An empty text is not a
 *    date either (the original parsed it). A date in the path replaces both, and is then the only thing parsed (a bad
 *    `start` is ignored); one that is not a date is `invalid date format`.
 *  - `interval` is asked for after the dates, and before the length, so that its own error comes after theirs and before
 *    that of a window that is too long (the controller gives it as a function: it is the controller's to parse).
 *  - The length is the whole days between the two (`moment.diff(.., 'days')`, cut toward zero). Less than one day,
 *    either way round, cuts the start back to the start of its day; more than 200 is 400 `choose a date range less than
 *    200 days`. With a `week` or a `month` the length is the number of buckets between the bucket of the start and that of
 *    the end (200 at most, either way round): `choose a date range less than 200 weeks` or `… 200 months`.
 *
 * With `day` there is a report for each UTC day from the day of the start to the day of the end. The original made its row
 * keys from the start, a day apart, up to the end, so a start with a time of day (more than a day before the end) looked
 * up rows that do not exist and answered zeros for every day, dated at that time of day; the days are those of the
 * calendar here. An end before the start (by a day or more, or before the start of its day) has no day. With `week` or
 * `month` there is a report for each bucket from the one that holds the start to the one that holds the end, whatever the
 * time of day or the order within a bucket, and none when the bucket of the end is before that of the start.
 */
export function reportWindow(
  query: Query,
  date: string | undefined,
  now: number,
  interval: (query: Query) => VolumeInterval = () => 'day',
): ReportWindow {
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
  const unit = interval(query);

  let start = startDate.date.getTime();
  const end = endDate.date.getTime();
  // `!days` of the original: 0, and -0 too
  const days = Math.trunc((end - start) / DAY_MS);
  if (days === 0) start = startOfDay(start);
  const length = unit === 'day' ? days : bucketsBetween(start, end, unit);
  if (Math.abs(length) > MAX_REPORT_DAYS) throw badRequest(`choose a date range less than ${MAX_REPORT_DAYS} ${unit}s`);

  const window = { start: new Date(start), end: new Date(end), interval: unit };
  const list: string[] = [];
  if (unit === 'day') {
    for (let day = startOfDay(start); day <= end; day += DAY_MS) list.push(dayText(day));
    return { ...window, days: list, buckets: list };
  }

  const buckets: string[] = [];
  const last = bucketStart(end, unit);
  for (let at = bucketStart(start, unit); at <= last; at = nextBucket(at, unit)) buckets.push(dayText(at));
  // the days of the buckets, up to today (a bucket that has not ended has days to come; those of the future have none)
  const today = startOfDay(now);
  const through = Math.min(nextBucket(last, unit) - DAY_MS, today);
  for (let day = bucketStart(start, unit); day <= through; day += DAY_MS) list.push(dayText(day));
  return { ...window, days: list, buckets };
}

import { DAY_GROUPS_EPOCH } from '@gatehub/data-api-shared';
import { badRequest } from '../common/errors';
import { dateParam, first, Query } from '../common/params';
import { bucketStart, ceilBucket, dayText, MAX_DAY_MS, nextBucket, VolumeInterval } from '../network/volume-buckets';

/**
 * The buckets of the routes that read an account through its day groups: a UTC day, a week from Monday (as `toMonday`),
 * a calendar month. They are the buckets of the historical volumes (`volume-buckets.ts`), named by their start.
 */
export const ANALYTICS_INTERVALS: readonly VolumeInterval[] = ['day', 'week', 'month'];

/**
 * The `interval` of a request: `undefined` when it is missing or empty, 400 `invalid interval - use: day, week, month`
 * when it is anything else.
 */
export function intervalParam(query: Query): VolumeInterval | undefined {
  const interval = first(query, 'interval');
  if (interval === undefined || interval === '') return undefined;
  if (!(ANALYTICS_INTERVALS as readonly string[]).includes(interval)) {
    throw badRequest('invalid interval - use: day, week, month');
  }
  return interval as VolumeInterval;
}

/** The SQL of the start of the bucket of a day, over the SQL of a `Date`. Code, chosen by the validated interval. */
const BUCKET_OF_DAY: Record<VolumeInterval, (day: string) => string> = {
  day: (day) => day,
  week: (day) => `toMonday(${day})`,
  month: (day) => `toStartOfMonth(${day})`,
};

/**
 * The SQL of the start of the bucket of a day: over a `Date` column named `day`, or over the SQL given as `day` (code of
 * the caller, never a value of the request), as `toDate(close_time, 'UTC')` for the rows of a table that has no day column.
 */
export function bucketOfDaySql(interval: VolumeInterval, day = 'day'): string {
  return BUCKET_OF_DAY[interval](day);
}

/** The buckets of a window: the starts (unix ms) of its first and of its last, both included. */
export interface BucketSpan {
  first: number;
  last: number;
}

/**
 * The buckets a window `[from, to)` (unix ms) holds: those whose START lies in it, from the first one that starts at or
 * after `from` to the last one that starts before `to`. A bucket that starts before `from` is not in it though it holds days
 * after `from`, and one that starts before `to` is whole though it ends after it. `undefined` when none starts in the
 * window. No bucket starts after the last day a ClickHouse `Date` holds.
 */
export function bucketSpan(interval: VolumeInterval, from: number, to: number): BucketSpan | undefined {
  const firstStart = ceilBucket(from, interval);
  const lastStart = Math.min(bucketStart(to - 1, interval), bucketStart(MAX_DAY_MS, interval));
  return firstStart <= lastStart ? { first: firstStart, last: lastStart } : undefined;
}

/**
 * The buckets of a span that a page after a marker can still hold: those after the bucket of the marker's day when the list
 * ascends, those before it when it descends (whatever interval the marker was made for: a day that is not a start is the
 * one of its bucket). `undefined` when none is left.
 */
export function narrowSpan(
  span: BucketSpan,
  interval: VolumeInterval,
  markerMs: number,
  descending: boolean,
): BucketSpan | undefined {
  if (descending) {
    const last = Math.min(span.last, bucketStart(bucketStart(markerMs, interval) - 1, interval));
    return span.first <= last ? { first: span.first, last } : undefined;
  }
  const firstStart = Math.max(span.first, nextBucket(markerMs, interval));
  return firstStart <= span.last ? { first: firstStart, last: span.last } : undefined;
}

/** The starts of the first `count` buckets of a span: oldest first, or newest first when `descending`. */
export function bucketStarts(span: BucketSpan, interval: VolumeInterval, descending: boolean, count: number): number[] {
  const starts: number[] = [];
  if (descending) {
    for (let at = span.last; at >= span.first && starts.length < count; at = bucketStart(at - 1, interval)) {
      starts.push(at);
    }
  } else {
    for (let at = span.first; at <= span.last && starts.length < count; at = nextBucket(at, interval)) {
      starts.push(at);
    }
  }
  return starts;
}

// ---------------------------------------------------------------------------------------------------------------------
// The window of the routes under `analytics/`.
// ---------------------------------------------------------------------------------------------------------------------

/** The most buckets an `interval` of an analytics route may ask for. */
export const MAX_ANALYTICS_BUCKETS = 1000;

const DAY_MS = 86_400_000;

/** The first day of the window's default `start`. */
const DEFAULT_START = '2013-01-01';

/** How the `interval` of a route is read: `default-day` is `day` when missing, `optional` none, `none` is not a parameter. */
export type AnalyticsIntervalMode = 'default-day' | 'optional' | 'none';

/**
 * The window of an analytics route: whole UTC days, widened to whole buckets when the route has an `interval`.
 */
export interface AnalyticsWindow {
  /** The end is before the start: there is nothing to read, and `start` and `end` are the same instant. */
  empty: boolean;
  /** The first day of the window (`YYYY-MM-DD`): the day of `start`, or the first day of its bucket. */
  fromDay: string;
  /** The last day of the window (`YYYY-MM-DD`), included: the day of `end`, or the last day of its bucket. */
  throughDay: string;
  /** As the answer says it: the start of the first day or bucket. */
  start: Date;
  /** As the answer says it: the start of the day or bucket after the last one, so exclusive. */
  end: Date;
  /** Only when the route has one and the request gave it (`default-day`: always). */
  interval?: VolumeInterval;
  /**
   * The start (unix ms) of each bucket, oldest first: with an `interval` those of that interval, else one per day. With an
   * interval a window that holds more than `MAX_ANALYTICS_BUCKETS` lists `MAX_ANALYTICS_BUCKETS + 1` of them, which is all
   * `checkBucketLimit` needs to refuse it. Without one, the days before `DAY_GROUPS_EPOCH` and after the last day a ClickHouse
   * `Date` holds are not listed: nothing is stored there. Empty for an empty window.
   */
  buckets: number[];
}

/**
 * The window of the routes under `analytics/`, read in the order of their errors: `start` (400 `invalid start date format`),
 * `end` (`invalid end date format`), then the `interval` (400 `invalid interval - use: day, week, month`), as `mode` says
 * (`none`: the route has no `interval`, so a request's is ignored, even a wrong one). The route's own parameter errors come
 * after these, and `checkBucketLimit` last.
 *
 * The window is the UTC days from the day of `start` (default 2013-01-01) to the day of `end` (default now), both whole,
 * whatever the time of day; with an interval they widen to the whole buckets that hold them. `start` is the first day or
 * bucket and `end` the start of the one after the last, so the answer's `end` is exclusive. An `end` on a day before the day
 * of `start` is `empty`, with `start` and `end` both the start of the first day or bucket of `start`.
 */
export function analyticsWindow(query: Query, now: number, mode: AnalyticsIntervalMode): AnalyticsWindow {
  const startMs = dateParam(query, 'start', 'invalid start date format', DEFAULT_START).date.getTime();
  const endMs = dateParam(query, 'end', 'invalid end date format')?.date.getTime() ?? now;
  const interval = mode === 'none' ? undefined : (intervalParam(query) ?? (mode === 'default-day' ? 'day' : undefined));

  const unit: VolumeInterval = interval ?? 'day';
  const from = bucketStart(startMs, unit);
  if (bucketStart(endMs, 'day') < bucketStart(startMs, 'day')) {
    return {
      empty: true,
      fromDay: dayText(from),
      throughDay: dayText(from),
      start: new Date(from),
      end: new Date(from),
      ...(interval !== undefined && { interval }),
      buckets: [],
    };
  }

  const end = nextBucket(endMs, unit);
  // With an interval a window that is over the limit is refused: its first buckets past the limit are all the check needs.
  // Without one there is no limit, and the days that cannot hold anything (before the day groups, past the last `Date`) are
  // not listed, so that a window of any size lists a bounded number of days.
  const [lo, hi, most] =
    interval === undefined
      ? [Math.max(from, Date.parse(DAY_GROUPS_EPOCH)), Math.min(end, MAX_DAY_MS + DAY_MS), Infinity]
      : [from, end, MAX_ANALYTICS_BUCKETS + 1];
  const buckets: number[] = [];
  for (let at = lo; at < hi && buckets.length < most; at = nextBucket(at, unit)) buckets.push(at);
  return {
    empty: false,
    fromDay: dayText(from),
    throughDay: dayText(end - DAY_MS),
    start: new Date(from),
    end: new Date(end),
    ...(interval !== undefined && { interval }),
    buckets,
  };
}

/** 400 `choose a date range of at most 1000 buckets` for a window with an interval that holds more. Without one, no limit. */
export function checkBucketLimit(w: AnalyticsWindow): void {
  if (w.interval !== undefined && w.buckets.length > MAX_ANALYTICS_BUCKETS) {
    throw badRequest(`choose a date range of at most ${MAX_ANALYTICS_BUCKETS} buckets`);
  }
}

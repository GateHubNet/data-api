import { badRequest } from '../common/errors';
import { first, Query } from '../common/params';
import { bucketStart, ceilBucket, MAX_DAY_MS, nextBucket, VolumeInterval } from '../network/volume-buckets';

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

/** The SQL of the start of the bucket of a day, over a `Date` column named `day`. Code, chosen by the validated interval. */
const BUCKET_OF_DAY: Record<VolumeInterval, string> = {
  day: 'day',
  week: 'toMonday(day)',
  month: 'toStartOfMonth(day)',
};

export function bucketOfDaySql(interval: VolumeInterval): string {
  return BUCKET_OF_DAY[interval];
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

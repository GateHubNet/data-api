/**
 * The buckets of the historical volume rows: a UTC day, a week from Monday (ISO), a calendar month. All times are unix
 * milliseconds, and a bucket is named by its start, which is always a UTC midnight.
 */

export type VolumeInterval = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

/** The last day a ClickHouse `Date` holds: 2149-06-06. */
export const MAX_DAY_MS = Date.UTC(2149, 5, 6);

/** The start of the bucket a time falls in. */
export function bucketStart(ms: number, unit: VolumeInterval): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  if (unit === 'day') return day;
  if (unit === 'week') {
    // 1970-01-01 was a Thursday: a Monday is 4 days after it, modulo a week
    const sinceMonday = (((day / DAY_MS + 3) % 7) + 7) % 7;
    return day - sinceMonday * DAY_MS;
  }
  const date = new Date(day);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The start of the bucket after the one a time falls in. */
export function nextBucket(ms: number, unit: VolumeInterval): number {
  const start = bucketStart(ms, unit);
  if (unit === 'day') return start + DAY_MS;
  if (unit === 'week') return start + 7 * DAY_MS;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The first start of a bucket at or after a time. */
export function ceilBucket(ms: number, unit: VolumeInterval): number {
  const start = bucketStart(ms, unit);
  return start === ms ? ms : nextBucket(ms, unit);
}

/** `YYYY-MM-DD` of the UTC day of a time: how the `Date` parameters of the queries are written. */
export function dayText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

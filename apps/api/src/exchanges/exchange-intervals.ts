/**
 * The `interval`s of the exchanges of a pair (`getExchanges.js`), and their buckets.
 *
 * The original served candles from `agg_exchanges`, which `lib/aggregation/exchanges.js` filled with one row per
 * bucket, aligned by `utils.getAlignedTime`: n minutes and n hours on the clock, n days counted from 2013-01-01, 7 days
 * the ISO week (from Monday), months and years the calendar ones, all in UTC. The buckets are computed here twice, on
 * purpose: `bucketExpr` groups the exchanges in ClickHouse, and `bucketStart` & co. turn the window of a request into
 * the buckets that start in it. Both are tested against each other and against the original's alignment.
 */

/** The intervals of `getExchanges.js`, in its order. `week` is read as `7day` (`readInterval`). */
export const EXCHANGE_INTERVALS = [
  '1minute',
  '5minute',
  '15minute',
  '30minute',
  '1hour',
  '2hour',
  '4hour',
  '1day',
  '3day',
  '7day',
  '1month',
  '1year',
] as const;

export type ExchangeInterval = (typeof EXCHANGE_INTERVALS)[number];

/** 2013-01-01T00:00:00Z, from which the n-day buckets are counted. */
export const DAY_BUCKETS_EPOCH = 1_356_998_400;

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

const BUCKETS: Record<ExchangeInterval, { n: number; unit: Unit }> = {
  '1minute': { n: 1, unit: 'minute' },
  '5minute': { n: 5, unit: 'minute' },
  '15minute': { n: 15, unit: 'minute' },
  '30minute': { n: 30, unit: 'minute' },
  '1hour': { n: 1, unit: 'hour' },
  '2hour': { n: 2, unit: 'hour' },
  '4hour': { n: 4, unit: 'hour' },
  '1day': { n: 1, unit: 'day' },
  '3day': { n: 3, unit: 'day' },
  '7day': { n: 1, unit: 'week' },
  '1month': { n: 1, unit: 'month' },
  '1year': { n: 1, unit: 'year' },
};

export function isExchangeInterval(value: string): value is ExchangeInterval {
  return (EXCHANGE_INTERVALS as readonly string[]).includes(value);
}

/**
 * The `interval` parameter as the original read it: lowercased, `week` is `7day`, missing or empty is no interval.
 * Whether it is one of the intervals is the caller's check (its message has this lowercased text).
 */
export function readInterval(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const interval = raw.toLowerCase();
  return interval === 'week' ? '7day' : interval;
}

/** The bucket of an interval; anything but an interval (or `week`) is a programming error. */
function bucketOf(interval: string): { n: number; unit: Unit } {
  const key = interval === 'week' ? '7day' : interval;
  if (!isExchangeInterval(key)) throw new Error(`not an exchange interval: ${JSON.stringify(interval)}`);
  return BUCKETS[key];
}

/**
 * The ClickHouse expression of the start of the bucket of `close_time` (a `DateTime('UTC')`), as a `DateTime`. It is
 * written from a fixed list: the text of a request never reaches it (anything but an interval throws).
 * - n minutes, n hours: `toStartOfInterval` (n divides the hour or the day, so the buckets are on the clock);
 * - n days: whole multiples of n days since 2013-01-01 (`intDiv` rounds towards zero, which is right because every
 *   ledger closed after it);
 * - 7 days: the Monday of the week; a month, a year: the first day of it.
 */
export function bucketExpr(interval: string): string {
  const { n, unit } = bucketOf(interval);
  switch (unit) {
    case 'minute':
      return `toStartOfInterval(close_time, INTERVAL ${n} MINUTE)`;
    case 'hour':
      return `toStartOfInterval(close_time, INTERVAL ${n} HOUR)`;
    case 'day':
      return `toDateTime('2013-01-01 00:00:00', 'UTC') + intDiv(toUInt32(close_time) - ${DAY_BUCKETS_EPOCH}, ${n * DAY}) * ${n * DAY}`;
    case 'week':
      return `toDateTime(toMonday(close_time), 'UTC')`;
    case 'month':
      return `toDateTime(toStartOfMonth(close_time), 'UTC')`;
    case 'year':
      return `toDateTime(toStartOfYear(close_time), 'UTC')`;
  }
}

/** `a mod b` for a positive `b`, never negative. */
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Unix seconds of the first day of a month in UTC (`Date.UTC` would read years below 100 as 19xx). */
function monthStart(year: number, month0: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month0, 1);
  return d.getTime() / 1000;
}

/** The start of the bucket of `interval` that holds `seconds` (unix seconds), what `bucketExpr` gives for that time. */
export function bucketStart(seconds: number, interval: string): number {
  const { n, unit } = bucketOf(interval);
  const t = Math.floor(seconds);
  switch (unit) {
    case 'minute':
      return t - mod(t, n * MINUTE);
    case 'hour':
      return t - mod(t, n * HOUR);
    case 'day':
      return t - mod(t - DAY_BUCKETS_EPOCH, n * DAY);
    case 'week': {
      // 1970-01-05, day 4 of the epoch, was a Monday
      const day = Math.floor(t / DAY);
      return (day - mod(day - 4, 7)) * DAY;
    }
    case 'month': {
      const d = new Date(t * 1000);
      return monthStart(d.getUTCFullYear(), d.getUTCMonth());
    }
    case 'year':
      return monthStart(new Date(t * 1000).getUTCFullYear(), 0);
  }
}

/** The start of the bucket after the one that starts at `start`. */
export function nextBucketStart(start: number, interval: string): number {
  const { n, unit } = bucketOf(interval);
  switch (unit) {
    case 'minute':
      return start + n * MINUTE;
    case 'hour':
      return start + n * HOUR;
    case 'day':
      return start + n * DAY;
    case 'week':
      return start + 7 * DAY;
    case 'month': {
      const d = new Date(start * 1000);
      return monthStart(d.getUTCFullYear(), d.getUTCMonth() + 1);
    }
    case 'year':
      return monthStart(new Date(start * 1000).getUTCFullYear() + 1, 0);
  }
}

/** The start of the first bucket that starts at or after `seconds`. */
export function firstBucketAtOrAfter(seconds: number, interval: string): number {
  const start = bucketStart(seconds, interval);
  return start >= seconds ? start : nextBucketStart(start, interval);
}

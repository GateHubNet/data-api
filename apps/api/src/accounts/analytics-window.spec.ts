import { RippleHttpError } from '../common/errors';
import {
  ANALYTICS_INTERVALS,
  analyticsWindow,
  bucketOfDaySql,
  bucketSpan,
  bucketStarts,
  checkBucketLimit,
  intervalParam,
  MAX_ANALYTICS_BUCKETS,
  narrowSpan,
} from './analytics-window';

function failure(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as RippleHttpError;
    return { status: e.getStatus(), message: (e.getResponse() as { message: string }).message };
  }
  throw new Error('did not fail');
}

const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const days = (starts: number[]): string[] => starts.map((s) => new Date(s).toISOString().slice(0, 10));

describe('ANALYTICS_INTERVALS', () => {
  it('is day, week and month', () => {
    expect(ANALYTICS_INTERVALS).toEqual(['day', 'week', 'month']);
  });
});

describe('intervalParam', () => {
  it('accepts day, week and month', () => {
    for (const interval of ['day', 'week', 'month']) expect(intervalParam({ interval })).toBe(interval);
  });

  it('is undefined for a missing or an empty interval', () => {
    expect(intervalParam({})).toBeUndefined();
    expect(intervalParam({ interval: '' })).toBeUndefined();
  });

  it('refuses any other text with 400 invalid interval', () => {
    for (const interval of ['year', 'hour', 'Week', ' week', 'weeks', 'raw', '0']) {
      expect([interval, failure(() => intervalParam({ interval }))]).toEqual([
        interval,
        { status: 400, message: 'invalid interval - use: day, week, month' },
      ]);
    }
  });

  it('takes the first value of a repeated parameter, as every parameter does', () => {
    expect(intervalParam({ interval: ['month', 'year'] })).toBe('month');
    expect(failure(() => intervalParam({ interval: ['year', 'month'] })).message).toBe(
      'invalid interval - use: day, week, month',
    );
  });
});

describe('bucketOfDaySql', () => {
  it('is the day itself, its Monday or the first of its month, over a Date column named day', () => {
    expect(bucketOfDaySql('day')).toBe('day');
    expect(bucketOfDaySql('week')).toBe('toMonday(day)');
    expect(bucketOfDaySql('month')).toBe('toStartOfMonth(day)');
  });

  it('is the same over the SQL of a date that is given', () => {
    const date = "toDate(close_time, 'UTC')";
    expect(bucketOfDaySql('day', date)).toBe(date);
    expect(bucketOfDaySql('week', date)).toBe("toMonday(toDate(close_time, 'UTC'))");
    expect(bucketOfDaySql('month', date)).toBe("toStartOfMonth(toDate(close_time, 'UTC'))");
  });
});

describe('bucketSpan', () => {
  it('is the first bucket that starts at or after from and the last that starts before to', () => {
    // 2020-02-04 is a Tuesday: the week of 02-03 starts before it
    expect(days(Object.values(bucketSpan('week', ms('2020-02-04'), ms('2020-03-30')) ?? {}))).toEqual([
      '2020-02-10',
      '2020-03-23',
    ]);
    expect(days(Object.values(bucketSpan('week', ms('2020-02-03'), ms('2020-03-31')) ?? {}))).toEqual([
      '2020-02-03',
      '2020-03-30',
    ]);
    expect(days(Object.values(bucketSpan('month', ms('2020-01-15'), ms('2020-04-01')) ?? {}))).toEqual([
      '2020-02-01',
      '2020-03-01',
    ]);
    expect(days(Object.values(bucketSpan('month', ms('2020-01-01'), ms('2020-04-02')) ?? {}))).toEqual([
      '2020-01-01',
      '2020-04-01',
    ]);
    expect(days(Object.values(bucketSpan('day', ms('2020-02-08'), ms('2020-02-14')) ?? {}))).toEqual([
      '2020-02-08',
      '2020-02-13',
    ]);
  });

  it('is none when no bucket starts in the window', () => {
    expect(bucketSpan('week', ms('2020-02-04'), ms('2020-02-10'))).toBeUndefined();
    expect(bucketSpan('month', ms('2020-01-02'), ms('2020-02-01'))).toBeUndefined();
    expect(bucketSpan('day', ms('2020-02-08'), ms('2020-02-08'))).toBeUndefined();
    expect(bucketSpan('day', ms('2020-02-09'), ms('2020-02-08'))).toBeUndefined();
  });

  it('is one bucket when only one starts in the window', () => {
    const span = bucketSpan('month', ms('2020-02-01'), ms('2020-02-02'));
    expect(span).toEqual({ first: ms('2020-02-01'), last: ms('2020-02-01') });
  });

  it('does not reach past the last day a ClickHouse Date holds', () => {
    const span = bucketSpan('day', ms('2149-06-01'), ms('2300-01-01'));
    expect(days(Object.values(span ?? {}))).toEqual(['2149-06-01', '2149-06-06']);
    expect(bucketSpan('month', ms('2200-01-01'), ms('2300-01-01'))).toBeUndefined();
  });
});

describe('narrowSpan', () => {
  const span = { first: ms('2020-01-13'), last: ms('2020-03-30') };

  it('ascending: starts with the bucket after the one that holds the marker day', () => {
    expect(days(Object.values(narrowSpan(span, 'week', ms('2020-02-10'), false) ?? {}))).toEqual([
      '2020-02-17',
      '2020-03-30',
    ]);
    // a day in the middle of a week is that week's
    expect(days(Object.values(narrowSpan(span, 'week', ms('2020-02-12'), false) ?? {}))).toEqual([
      '2020-02-17',
      '2020-03-30',
    ]);
    // a marker before the span changes nothing
    expect(narrowSpan(span, 'week', ms('2019-01-01'), false)).toEqual(span);
  });

  it('descending: stops before the bucket that holds the marker day', () => {
    expect(days(Object.values(narrowSpan(span, 'week', ms('2020-02-10'), true) ?? {}))).toEqual([
      '2020-01-13',
      '2020-02-03',
    ]);
    const months = { first: ms('2020-01-01'), last: ms('2020-03-01') };
    expect(days(Object.values(narrowSpan(months, 'month', ms('2020-02-20'), true) ?? {}))).toEqual([
      '2020-01-01',
      '2020-01-01',
    ]);
    // a marker after the span changes nothing
    expect(narrowSpan(span, 'week', ms('2021-01-01'), true)).toEqual(span);
  });

  it('is none when the marker leaves no bucket', () => {
    expect(narrowSpan(span, 'week', ms('2020-03-30'), false)).toBeUndefined();
    expect(narrowSpan(span, 'week', ms('2020-01-13'), true)).toBeUndefined();
    expect(narrowSpan(span, 'week', ms('2020-01-15'), true)).toBeUndefined();
  });
});

describe('bucketStarts', () => {
  const span = { first: ms('2020-01-13'), last: ms('2020-03-02') };

  it('lists the starts oldest first, at most count of them', () => {
    expect(days(bucketStarts(span, 'week', false, 3))).toEqual(['2020-01-13', '2020-01-20', '2020-01-27']);
    expect(days(bucketStarts(span, 'week', false, 100))).toEqual([
      '2020-01-13',
      '2020-01-20',
      '2020-01-27',
      '2020-02-03',
      '2020-02-10',
      '2020-02-17',
      '2020-02-24',
      '2020-03-02',
    ]);
  });

  it('lists them newest first from the last when descending', () => {
    expect(days(bucketStarts(span, 'week', true, 3))).toEqual(['2020-03-02', '2020-02-24', '2020-02-17']);
    expect(bucketStarts(span, 'week', true, 100)).toHaveLength(8);
  });

  it('steps over months of different lengths and over days', () => {
    expect(days(bucketStarts({ first: ms('2020-01-01'), last: ms('2020-06-01') }, 'month', false, 10))).toEqual([
      '2020-01-01',
      '2020-02-01',
      '2020-03-01',
      '2020-04-01',
      '2020-05-01',
      '2020-06-01',
    ]);
    expect(days(bucketStarts({ first: ms('2020-01-01'), last: ms('2020-06-01') }, 'month', true, 3))).toEqual([
      '2020-06-01',
      '2020-05-01',
      '2020-04-01',
    ]);
    expect(days(bucketStarts({ first: ms('2020-02-27'), last: ms('2020-03-02') }, 'day', false, 10))).toEqual([
      '2020-02-27',
      '2020-02-28',
      '2020-02-29',
      '2020-03-01',
      '2020-03-02',
    ]);
  });

  it('is none for none', () => {
    expect(bucketStarts(span, 'week', false, 0)).toEqual([]);
  });
});

describe('analyticsWindow', () => {
  // a Monday: 2026-10-19 is, and 2026-09-20 is the Sunday before the week of 2026-09-14
  const NOW = Date.parse('2026-10-19T12:34:56Z');
  const iso = (d: Date): string => d.toISOString();

  it('is the days from the day of start to the day of end, both whole; end is the start of the day after', () => {
    const w = analyticsWindow({ start: '2026-09-20', end: '2026-10-19' }, NOW, 'none');
    expect(w).toMatchObject({ empty: false, fromDay: '2026-09-20', throughDay: '2026-10-19' });
    expect(w.interval).toBeUndefined();
    expect(iso(w.start)).toBe('2026-09-20T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-10-20T00:00:00.000Z');
    // without an interval a bucket is a day: 30 of them
    expect(w.buckets).toHaveLength(30);
    expect(days(w.buckets.slice(0, 2))).toEqual(['2026-09-20', '2026-09-21']);
    expect(days(w.buckets.slice(-1))).toEqual(['2026-10-19']);
  });

  it('a time of day does not matter: the days are whole', () => {
    const w = analyticsWindow({ start: '2026-09-20T23:59:59Z', end: '2026-09-21T00:00:01Z' }, NOW, 'none');
    expect([w.fromDay, w.throughDay, iso(w.start), iso(w.end)]).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-20T00:00:00.000Z',
      '2026-09-22T00:00:00.000Z',
    ]);
    // the same day twice is one day, whatever the order of the two times within it
    const same = analyticsWindow({ start: '2026-09-20T18:00:00Z', end: '2026-09-20T06:00:00Z' }, NOW, 'none');
    expect([same.empty, same.fromDay, same.throughDay, same.buckets.length]).toEqual([
      false,
      '2026-09-20',
      '2026-09-20',
      1,
    ]);
  });

  it('defaults to 2013-01-01 and now', () => {
    const w = analyticsWindow({}, NOW, 'none');
    expect([w.fromDay, w.throughDay]).toEqual(['2013-01-01', '2026-10-19']);
    expect(iso(w.end)).toBe('2026-10-20T00:00:00.000Z');
    // an empty start is the default, as on the other routes; an empty end is not a date
    expect(analyticsWindow({ start: '' }, NOW, 'none').fromDay).toBe('2013-01-01');
    expect(failure(() => analyticsWindow({ end: '' }, NOW, 'none')).message).toBe('invalid end date format');
  });

  it('interval=week widens the days to whole weeks, from Monday: 09-14 to the Monday 10-26', () => {
    const w = analyticsWindow({ start: '2026-09-20', end: '2026-10-19', interval: 'week' }, NOW, 'optional');
    expect(w).toMatchObject({ empty: false, interval: 'week', fromDay: '2026-09-14', throughDay: '2026-10-25' });
    expect(iso(w.start)).toBe('2026-09-14T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-10-26T00:00:00.000Z');
    expect(days(w.buckets)).toEqual([
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
  });

  it('interval=month widens the days to whole months: 09-01 to 11-01', () => {
    const w = analyticsWindow({ start: '2026-09-20', end: '2026-10-19', interval: 'month' }, NOW, 'optional');
    expect(w).toMatchObject({ empty: false, interval: 'month', fromDay: '2026-09-01', throughDay: '2026-10-31' });
    expect(iso(w.start)).toBe('2026-09-01T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-11-01T00:00:00.000Z');
    expect(days(w.buckets)).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('interval=day is a bucket per day, as no interval, but the answer says it', () => {
    const w = analyticsWindow({ start: '2026-09-20', end: '2026-09-22', interval: 'day' }, NOW, 'optional');
    expect(w.interval).toBe('day');
    expect(days(w.buckets)).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });

  it('default-day: the interval is day when it is missing or empty, else the one asked for', () => {
    expect(analyticsWindow({}, NOW, 'default-day').interval).toBe('day');
    expect(analyticsWindow({ interval: '' }, NOW, 'default-day').interval).toBe('day');
    expect(analyticsWindow({ interval: 'month' }, NOW, 'default-day').interval).toBe('month');
  });

  it('optional: no interval when it is missing or empty', () => {
    expect(analyticsWindow({}, NOW, 'optional').interval).toBeUndefined();
    expect(analyticsWindow({ interval: '' }, NOW, 'optional').interval).toBeUndefined();
  });

  it('none: the interval is not a parameter, so it is ignored, even a wrong one', () => {
    for (const interval of ['week', 'year', 'x']) {
      const w = analyticsWindow({ start: '2026-09-20', end: '2026-09-22', interval }, NOW, 'none');
      expect([w.interval, w.fromDay, w.throughDay]).toEqual([undefined, '2026-09-20', '2026-09-22']);
    }
  });

  it('an end before start is empty: start and end are both the start of the first day of start', () => {
    const w = analyticsWindow({ start: '2026-10-19T08:00:00Z', end: '2026-10-18' }, NOW, 'none');
    expect(w.empty).toBe(true);
    expect(iso(w.start)).toBe('2026-10-19T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-10-19T00:00:00.000Z');
    expect(w.buckets).toEqual([]);
    // a start after now, with the default end
    expect(analyticsWindow({ start: '2026-10-20' }, NOW, 'none').empty).toBe(true);
  });

  it('an end before start with an interval: both are the start of the first bucket of start', () => {
    const week = analyticsWindow({ start: '2026-09-20', end: '2026-09-10', interval: 'week' }, NOW, 'optional');
    expect([week.empty, iso(week.start), iso(week.end), week.buckets]).toEqual([
      true,
      '2026-09-14T00:00:00.000Z',
      '2026-09-14T00:00:00.000Z',
      [],
    ]);
    const month = analyticsWindow({ start: '2026-09-20', end: '2026-08-31', interval: 'month' }, NOW, 'optional');
    expect([month.empty, iso(month.start), iso(month.end)]).toEqual([
      true,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
    // the days come first, the widening after: an end a day before start is empty though both are in one week
    const same = analyticsWindow({ start: '2026-09-20', end: '2026-09-16', interval: 'week' }, NOW, 'optional');
    expect([same.empty, iso(same.start), iso(same.end)]).toEqual([
      true,
      '2026-09-14T00:00:00.000Z',
      '2026-09-14T00:00:00.000Z',
    ]);
    // and the same day is one bucket
    expect(analyticsWindow({ start: '2026-09-20', end: '2026-09-20', interval: 'week' }, NOW, 'optional').empty).toBe(
      false,
    );
  });

  it('the errors come in the order start, end, interval', () => {
    const all = { start: 'nope', end: 'nope', interval: 'nope' };
    expect(failure(() => analyticsWindow(all, NOW, 'optional'))).toEqual({
      status: 400,
      message: 'invalid start date format',
    });
    expect(failure(() => analyticsWindow({ ...all, start: '2026-09-20' }, NOW, 'optional'))).toEqual({
      status: 400,
      message: 'invalid end date format',
    });
    expect(
      failure(() => analyticsWindow({ ...all, start: '2026-09-20', end: '2026-10-19' }, NOW, 'default-day')),
    ).toEqual({
      status: 400,
      message: 'invalid interval - use: day, week, month',
    });
    // an empty start is the default, not an error; the interval is checked even for an empty window
    expect(
      failure(() => analyticsWindow({ start: '2026-10-19', end: '2026-10-01', interval: 'x' }, NOW, 'optional'))
        .message,
    ).toBe('invalid interval - use: day, week, month');
  });

  it('a window of any size is a window: before the ledgers, or past the last date a ClickHouse Date holds', () => {
    const w = analyticsWindow({ start: '0001-01-01', end: '2400-12-31' }, NOW, 'none');
    expect([w.empty, w.fromDay, w.throughDay]).toEqual([false, '0001-01-01', '2400-12-31']);
    expect([iso(w.start), iso(w.end)]).toEqual(['0001-01-01T00:00:00.000Z', '2401-01-01T00:00:00.000Z']);
    // without an interval the days that cannot hold anything are not listed: from the epoch of the day groups to the last Date
    expect(days([w.buckets[0], w.buckets[w.buckets.length - 1]])).toEqual(['2000-01-01', '2149-06-06']);
    expect(w.buckets).toHaveLength((Date.UTC(2149, 5, 6) - Date.UTC(2000, 0, 1)) / 86_400_000 + 1);
    expect(analyticsWindow({ start: '0001-01-01', end: '1999-12-31' }, NOW, 'none').buckets).toEqual([]);
    expect(analyticsWindow({ start: '2150-01-01', end: '2400-12-31' }, NOW, 'none').buckets).toEqual([]);
    // a long window with an interval lists no more buckets than the limit can refuse
    const long = analyticsWindow({ start: '0001-01-01', end: '2400-12-31', interval: 'day' }, NOW, 'optional');
    expect(long.buckets).toHaveLength(MAX_ANALYTICS_BUCKETS + 1);
    expect(failure(() => checkBucketLimit(long)).message).toBe('choose a date range of at most 1000 buckets');
  });
});

describe('checkBucketLimit', () => {
  const NOW = Date.parse('2026-10-19T12:34:56Z');
  // 2020-01-01 and the 999 days after it are 1000 days
  const FROM = '2020-01-01';
  const dayAfter = (n: number): string =>
    new Date(Date.parse(`${FROM}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it('is 1000', () => {
    expect(MAX_ANALYTICS_BUCKETS).toBe(1000);
  });

  it('1000 day buckets are fine, 1001 are 400 choose a date range of at most 1000 buckets', () => {
    const ok = analyticsWindow({ start: FROM, end: dayAfter(999), interval: 'day' }, NOW, 'optional');
    expect(ok.buckets).toHaveLength(1000);
    expect(() => checkBucketLimit(ok)).not.toThrow();
    const over = analyticsWindow({ start: FROM, end: dayAfter(1000), interval: 'day' }, NOW, 'default-day');
    expect(over.buckets).toHaveLength(1001);
    expect(failure(() => checkBucketLimit(over))).toEqual({
      status: 400,
      message: 'choose a date range of at most 1000 buckets',
    });
  });

  it('counts the buckets of the interval, once widened: 1000 weeks, 1001 weeks', () => {
    // 2020-01-06 is a Monday; 1000 weeks end on the Sunday 999 weeks and 6 days after it
    const ok = analyticsWindow(
      { start: '2020-01-06', end: dayAfter(5 + 999 * 7 + 6 - 0), interval: 'week' },
      NOW,
      'optional',
    );
    expect(ok.buckets).toHaveLength(1000);
    expect(() => checkBucketLimit(ok)).not.toThrow();
    const over = analyticsWindow(
      { start: '2020-01-06', end: dayAfter(5 + 1000 * 7 + 6), interval: 'week' },
      NOW,
      'optional',
    );
    expect(over.buckets).toHaveLength(1001);
    expect(() => checkBucketLimit(over)).toThrow();
  });

  it('none and optional without an interval have no limit', () => {
    const long = { start: '2000-01-01', end: '2026-10-01' };
    const none = analyticsWindow(long, NOW, 'none');
    const optional = analyticsWindow(long, NOW, 'optional');
    expect(none.buckets.length).toBeGreaterThan(MAX_ANALYTICS_BUCKETS);
    expect(optional.buckets.length).toBe(none.buckets.length);
    expect(() => checkBucketLimit(none)).not.toThrow();
    expect(() => checkBucketLimit(optional)).not.toThrow();
    // none ignores the interval, even a long one
    expect(() => checkBucketLimit(analyticsWindow({ ...long, interval: 'day' }, NOW, 'none'))).not.toThrow();
  });

  it('an empty window has no buckets, so it is within the limit', () => {
    const empty = analyticsWindow({ start: '2026-10-19', end: '2000-01-01', interval: 'day' }, NOW, 'default-day');
    expect(empty.empty).toBe(true);
    expect(() => checkBucketLimit(empty)).not.toThrow();
  });
});

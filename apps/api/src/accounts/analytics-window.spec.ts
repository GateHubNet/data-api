import { RippleHttpError } from '../common/errors';
import {
  ANALYTICS_INTERVALS,
  bucketOfDaySql,
  bucketSpan,
  bucketStarts,
  intervalParam,
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

import {
  bucketExpr,
  bucketStart,
  EXCHANGE_INTERVALS,
  firstBucketAtOrAfter,
  isExchangeInterval,
  nextBucketStart,
  readInterval,
} from './exchange-intervals';

/** Unix seconds of a UTC time written without a zone. */
const t = (iso: string): number => Date.parse(`${iso}Z`) / 1000;

describe('exchange intervals', () => {
  it('are the intervals of getExchanges.js, in its order', () => {
    expect(EXCHANGE_INTERVALS).toEqual([
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
    ]);
    for (const i of EXCHANGE_INTERVALS) expect(isExchangeInterval(i)).toBe(true);
    for (const i of ['week', '3weeks', '1MINUTE', '', '1 day', '2day', '1week', '3month', '1minute ']) {
      expect([i, isExchangeInterval(i)]).toEqual([i, false]);
    }
  });

  describe('readInterval', () => {
    it('lowercases the text, as the original did, and reads week as 7day', () => {
      expect(readInterval('1HOUR')).toBe('1hour');
      expect(readInterval('Week')).toBe('7day');
      expect(readInterval('week')).toBe('7day');
      expect(readInterval('7DAY')).toBe('7day');
      // validity is checked by the caller, with the lowercased text in the message
      expect(readInterval('3WEEKS')).toBe('3weeks');
    });

    it('missing or empty is no interval', () => {
      expect(readInterval(undefined)).toBeUndefined();
      expect(readInterval('')).toBeUndefined();
    });
  });

  describe('bucketExpr', () => {
    it('is a fixed expression over close_time for every interval', () => {
      const day = (n: number): string =>
        `toDateTime('2013-01-01 00:00:00', 'UTC') + intDiv(toUInt32(close_time) - 1356998400, ${n * 86400}) * ${n * 86400}`;
      expect(Object.fromEntries(EXCHANGE_INTERVALS.map((i) => [i, bucketExpr(i)]))).toEqual({
        '1minute': 'toStartOfInterval(close_time, INTERVAL 1 MINUTE)',
        '5minute': 'toStartOfInterval(close_time, INTERVAL 5 MINUTE)',
        '15minute': 'toStartOfInterval(close_time, INTERVAL 15 MINUTE)',
        '30minute': 'toStartOfInterval(close_time, INTERVAL 30 MINUTE)',
        '1hour': 'toStartOfInterval(close_time, INTERVAL 1 HOUR)',
        '2hour': 'toStartOfInterval(close_time, INTERVAL 2 HOUR)',
        '4hour': 'toStartOfInterval(close_time, INTERVAL 4 HOUR)',
        '1day': day(1),
        '3day': day(3),
        '7day': "toDateTime(toMonday(close_time), 'UTC')",
        '1month': "toDateTime(toStartOfMonth(close_time), 'UTC')",
        '1year': "toDateTime(toStartOfYear(close_time), 'UTC')",
      });
    });

    it('week is 7day', () => {
      expect(bucketExpr('week')).toBe(bucketExpr('7day'));
    });

    it('takes nothing but the whitelist: any other text throws, so no text of a request reaches the SQL', () => {
      for (const i of ['3weeks', '1MINUTE', '', '1minute) FROM x --', "1day'", '2day', 'toString', '__proto__']) {
        expect(() => bucketExpr(i)).toThrow(/interval/);
      }
    });
  });

  describe('bucketStart', () => {
    it('one time in every interval', () => {
      const at = t('2015-01-14T18:27:20');
      expect(Object.fromEntries(EXCHANGE_INTERVALS.map((i) => [i, bucketStart(at, i)]))).toEqual({
        '1minute': t('2015-01-14T18:27:00'),
        '5minute': t('2015-01-14T18:25:00'),
        '15minute': t('2015-01-14T18:15:00'),
        '30minute': t('2015-01-14T18:00:00'),
        '1hour': t('2015-01-14T18:00:00'),
        '2hour': t('2015-01-14T18:00:00'),
        '4hour': t('2015-01-14T16:00:00'),
        '1day': t('2015-01-14T00:00:00'),
        '3day': t('2015-01-12T00:00:00'),
        '7day': t('2015-01-12T00:00:00'),
        '1month': t('2015-01-01T00:00:00'),
        '1year': t('2015-01-01T00:00:00'),
      });
    });

    it('n minutes and n hours are clock-aligned', () => {
      expect(bucketStart(t('2016-03-01T10:04:59'), '5minute')).toBe(t('2016-03-01T10:00:00'));
      expect(bucketStart(t('2016-03-01T10:05:00'), '5minute')).toBe(t('2016-03-01T10:05:00'));
      expect(bucketStart(t('2016-03-01T10:29:59'), '15minute')).toBe(t('2016-03-01T10:15:00'));
      expect(bucketStart(t('2016-03-01T10:29:59'), '30minute')).toBe(t('2016-03-01T10:00:00'));
      expect(bucketStart(t('2016-03-01T10:30:00'), '30minute')).toBe(t('2016-03-01T10:30:00'));
      expect(bucketStart(t('2016-03-01T03:59:59'), '4hour')).toBe(t('2016-03-01T00:00:00'));
      expect(bucketStart(t('2016-03-01T04:00:00'), '4hour')).toBe(t('2016-03-01T04:00:00'));
      expect(bucketStart(t('2016-03-01T23:59:59'), '2hour')).toBe(t('2016-03-01T22:00:00'));
    });

    it('3day buckets align to 2013-01-01', () => {
      expect(bucketStart(t('2013-01-01T00:00:00'), '3day')).toBe(t('2013-01-01T00:00:00'));
      expect(bucketStart(t('2013-01-03T23:59:59'), '3day')).toBe(t('2013-01-01T00:00:00'));
      expect(bucketStart(t('2013-01-04T00:00:00'), '3day')).toBe(t('2013-01-04T00:00:00'));
      // 2014-12-31 is day 729 since 2013-01-01, a multiple of 3
      expect(bucketStart(t('2014-12-31T00:00:00'), '3day')).toBe(t('2014-12-31T00:00:00'));
      expect(bucketStart(t('2015-01-02T23:59:59'), '3day')).toBe(t('2014-12-31T00:00:00'));
      expect(bucketStart(t('2015-01-03T00:00:00'), '3day')).toBe(t('2015-01-03T00:00:00'));
      // 1 day is the day itself
      expect(bucketStart(t('2015-01-02T23:59:59'), '1day')).toBe(t('2015-01-02T00:00:00'));
    });

    it('7day (week) is the ISO week, from Monday', () => {
      expect(bucketStart(t('2015-01-11T23:59:59'), '7day')).toBe(t('2015-01-05T00:00:00')); // a Sunday
      expect(bucketStart(t('2015-01-12T00:00:00'), '7day')).toBe(t('2015-01-12T00:00:00')); // a Monday
      expect(bucketStart(t('2013-01-01T00:00:00'), '7day')).toBe(t('2012-12-31T00:00:00')); // a Tuesday
      expect(bucketStart(t('1970-01-01T00:00:00'), '7day')).toBe(t('1969-12-29T00:00:00')); // a Thursday
      expect(bucketStart(t('2015-01-11T23:59:59'), 'week')).toBe(t('2015-01-05T00:00:00'));
    });

    it('months and years are the calendar ones', () => {
      expect(bucketStart(t('2015-01-31T23:59:59'), '1month')).toBe(t('2015-01-01T00:00:00'));
      expect(bucketStart(t('2015-02-01T00:00:00'), '1month')).toBe(t('2015-02-01T00:00:00'));
      expect(bucketStart(t('2016-02-29T12:00:00'), '1month')).toBe(t('2016-02-01T00:00:00'));
      expect(bucketStart(t('2014-12-31T23:59:59'), '1year')).toBe(t('2014-01-01T00:00:00'));
      expect(bucketStart(t('2015-01-01T00:00:00'), '1year')).toBe(t('2015-01-01T00:00:00'));
    });
  });

  describe('nextBucketStart and firstBucketAtOrAfter', () => {
    it('the bucket after a bucket', () => {
      expect(nextBucketStart(t('2015-01-14T18:25:00'), '5minute')).toBe(t('2015-01-14T18:30:00'));
      expect(nextBucketStart(t('2015-01-14T16:00:00'), '4hour')).toBe(t('2015-01-14T20:00:00'));
      expect(nextBucketStart(t('2015-01-12T00:00:00'), '3day')).toBe(t('2015-01-15T00:00:00'));
      expect(nextBucketStart(t('2015-01-12T00:00:00'), '7day')).toBe(t('2015-01-19T00:00:00'));
      expect(nextBucketStart(t('2016-02-01T00:00:00'), '1month')).toBe(t('2016-03-01T00:00:00'));
      expect(nextBucketStart(t('2015-12-01T00:00:00'), '1month')).toBe(t('2016-01-01T00:00:00'));
      expect(nextBucketStart(t('2015-01-01T00:00:00'), '1year')).toBe(t('2016-01-01T00:00:00'));
    });

    it('the first bucket that starts at or after a time', () => {
      // a time on a bucket start is that bucket
      expect(firstBucketAtOrAfter(t('2015-01-14T18:25:00'), '5minute')).toBe(t('2015-01-14T18:25:00'));
      expect(firstBucketAtOrAfter(t('2015-01-14T18:27:30'), '5minute')).toBe(t('2015-01-14T18:30:00'));
      expect(firstBucketAtOrAfter(t('2013-01-01T00:00:00'), '1day')).toBe(t('2013-01-01T00:00:00'));
      expect(firstBucketAtOrAfter(t('2013-01-01T00:00:00'), '3day')).toBe(t('2013-01-01T00:00:00'));
      // 2013-01-01 is a Tuesday: the first week that starts in 2013 starts on the 7th
      expect(firstBucketAtOrAfter(t('2013-01-01T00:00:00'), '7day')).toBe(t('2013-01-07T00:00:00'));
      expect(firstBucketAtOrAfter(t('2015-01-15T00:00:00'), '1month')).toBe(t('2015-02-01T00:00:00'));
      expect(firstBucketAtOrAfter(t('2015-01-15T00:00:00'), '1year')).toBe(t('2016-01-01T00:00:00'));
    });

    it('agree with bucketStart over a long run of times', () => {
      for (const interval of EXCHANGE_INTERVALS) {
        for (let at = t('2012-11-01T00:00:00'); at < t('2017-03-01T00:00:00'); at += 86_399 * 3 + 7_919) {
          const start = bucketStart(at, interval);
          const next = nextBucketStart(start, interval);
          expect([interval, at, start <= at && at < next]).toEqual([interval, at, true]);
          expect([interval, at, bucketStart(next, interval)]).toEqual([interval, at, next]);
          expect([interval, at, firstBucketAtOrAfter(at, interval)]).toEqual([interval, at, start === at ? at : next]);
        }
      }
    });
  });
});

import { RippleHttpError } from '../common/errors';
import { VolumeInterval } from '../network/volume-buckets';
import { MAX_REPORT_DAYS, reportWindow } from './account-report-window';

function failure(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as RippleHttpError;
    return { status: e.getStatus(), message: (e.getResponse() as { message: string }).message };
  }
  throw new Error('did not fail');
}

const NOW = Date.parse('2016-06-15T12:34:56.789Z');

/** The window as the tests read it: the two ends as the envelope writes them, and the days. */
function window(
  query: Record<string, unknown>,
  date?: string,
  now = NOW,
): { start: string; end: string; days: string[] } {
  const w = reportWindow(query, date, now);
  return { start: w.start.toISOString(), end: w.end.toISOString(), days: w.days };
}

describe('reportWindow', () => {
  it('has one day for no parameters: the day of now, from its start to now', () => {
    expect(window({})).toEqual({
      start: '2016-06-15T00:00:00.000Z',
      end: '2016-06-15T12:34:56.789Z',
      days: ['2016-06-15'],
    });
  });

  it('has a day for each UTC day from start to end, both included', () => {
    expect(window({ start: '2015-01-14', end: '2015-01-16' })).toEqual({
      start: '2015-01-14T00:00:00.000Z',
      end: '2015-01-16T00:00:00.000Z',
      days: ['2015-01-14', '2015-01-15', '2015-01-16'],
    });
  });

  it('includes the whole day of an end that is in the middle of it', () => {
    expect(window({ start: '2015-01-14', end: '2015-01-15T00:00:01' }).days).toEqual(['2015-01-14', '2015-01-15']);
    expect(window({ start: '2015-01-14', end: '2015-01-14T23:59:59' }).days).toEqual(['2015-01-14']);
  });

  it('cuts a start that is within a day of the end back to the start of its day, and says so in start', () => {
    expect(window({ start: '2015-01-14T05:00:00', end: '2015-01-14T20:00:00' })).toEqual({
      start: '2015-01-14T00:00:00.000Z',
      end: '2015-01-14T20:00:00.000Z',
      days: ['2015-01-14'],
    });
    // an end before the start, by less than a day, is the same: the day of the start
    expect(window({ start: '2015-01-14T20:00:00', end: '2015-01-14T05:00:00' }).days).toEqual(['2015-01-14']);
    // ... unless that day is after the end
    expect(window({ start: '2015-01-15T00:30:00', end: '2015-01-14T23:50:00' }).days).toEqual([]);
  });

  it('has the days a start with a time of day touches (the original looked up the wrong rows: all zero)', () => {
    expect(window({ start: '2015-01-14T05:00:00', end: '2015-01-16T03:00:00' })).toEqual({
      start: '2015-01-14T05:00:00.000Z',
      end: '2015-01-16T03:00:00.000Z',
      days: ['2015-01-14', '2015-01-15', '2015-01-16'],
    });
  });

  it('has no day for an end that is before the start by a day or more', () => {
    expect(window({ start: '2015-01-16', end: '2015-01-14' })).toEqual({
      start: '2015-01-16T00:00:00.000Z',
      end: '2015-01-14T00:00:00.000Z',
      days: [],
    });
  });

  it('takes now for the one that is missing', () => {
    expect(window({ start: '2016-06-13' }).days).toEqual(['2016-06-13', '2016-06-14', '2016-06-15']);
    expect(window({ end: '2016-06-15T00:00:00' }).days).toEqual(['2016-06-15']);
    // an end before now, by more than a day, gives no day
    expect(window({ end: '2016-06-13' })).toMatchObject({ start: '2016-06-15T12:34:56.789Z', days: [] });
  });

  it('is the one day of a date in the path, whatever start and end say', () => {
    expect(window({ start: 'bogus', end: '2020-01-01' }, '2015-01-14')).toEqual({
      start: '2015-01-14T00:00:00.000Z',
      end: '2015-01-14T00:00:00.000Z',
      days: ['2015-01-14'],
    });
    expect(window({}, '2015-01-14T12:30:00')).toEqual({
      start: '2015-01-14T00:00:00.000Z',
      end: '2015-01-14T12:30:00.000Z',
      days: ['2015-01-14'],
    });
    // a coarser date is its first moment; unix seconds work as they do for every date
    expect(window({}, '2015-01').days).toEqual(['2015-01-01']);
    expect(window({}, '2015').days).toEqual(['2015-01-01']);
    expect(window({}, String(Date.parse('2015-01-14T12:00:00Z') / 1000)).days).toEqual(['2015-01-14']);
  });

  it('allows 200 days, and refuses more, either way round', () => {
    expect(MAX_REPORT_DAYS).toBe(200);
    expect(window({ start: '2015-01-01', end: '2015-07-20' }).days).toHaveLength(201);
    for (const range of [
      { start: '2015-01-01', end: '2015-07-21' },
      { start: '2015-07-21', end: '2015-01-01' },
      { start: '2014-01-14', end: '2015-01-16' },
    ]) {
      expect([range, failure(() => window(range))]).toEqual([
        range,
        { status: 400, message: 'choose a date range less than 200 days' },
      ]);
    }
    // 200 days and 23 hours is still 200 days (days are counted whole)
    expect(window({ start: '2015-01-01', end: '2015-07-20T23:00:00' }).days).toHaveLength(201);
    // so is a start with a time of day, which may touch one day more
    expect(window({ start: '2015-01-01T23:00:00', end: '2015-07-21T01:00:00' }).days).toHaveLength(202);
  });

  it('refuses a date that is none: invalid date format for start and for a date in the path', () => {
    expect(failure(() => window({ start: '2015x' }))).toEqual({ status: 400, message: 'invalid date format' });
    expect(failure(() => window({ start: '2015x', end: '2015-01-16' }))).toEqual({
      status: 400,
      message: 'invalid date format',
    });
    expect(failure(() => window({}, '2015-01x'))).toEqual({ status: 400, message: 'invalid date format' });
    expect(failure(() => window({ start: '2015-02-30' })).message).toBe('invalid date format');
  });

  it('refuses an end that is none: invalid end date format', () => {
    expect(failure(() => window({ start: '2015-01-14', end: '2015x' }))).toEqual({
      status: 400,
      message: 'invalid end date format',
    });
  });

  it('checks the start before the end, and both before the length', () => {
    expect(failure(() => window({ start: 'a', end: 'b' })).message).toBe('invalid date format');
    expect(failure(() => window({ start: '2010-01-01', end: 'b' })).message).toBe('invalid end date format');
  });

  it('takes an empty start or end for a date that is none (the original parsed the empty text)', () => {
    expect(failure(() => window({ start: '' })).message).toBe('invalid date format');
    expect(failure(() => window({ start: '2015-01-14', end: '' })).message).toBe('invalid end date format');
  });

  it('takes the first of a repeated start or end', () => {
    expect(window({ start: ['2015-01-14', 'bogus'], end: ['2015-01-15', 'bogus'] }).days).toEqual([
      '2015-01-14',
      '2015-01-15',
    ]);
  });
});

describe('reportWindow with an interval', () => {
  const LATER = Date.parse('2024-01-10T12:00:00Z');

  /** The window of a request that asks for `interval`, and the time of the request. */
  const per = (interval: VolumeInterval, query: Record<string, unknown>, date?: string, now = LATER) =>
    reportWindow(query, date, now, () => interval);

  it('is the day, with the buckets the days, when there is no interval or it is day', () => {
    const plain = reportWindow({ start: '2015-01-14', end: '2015-01-16' }, undefined, NOW);
    expect(plain.interval).toBe('day');
    expect(plain.buckets).toEqual(['2015-01-14', '2015-01-15', '2015-01-16']);
    expect(plain.buckets).toEqual(plain.days);
    expect(per('day', { start: '2015-01-14', end: '2015-01-16' }, undefined, NOW)).toEqual(plain);
    // a day outside the 200 days of a day-by-day window is as it was: nothing is cut at today
    expect(per('day', { start: '2030-01-01', end: '2030-01-02' }, undefined, NOW).days).toEqual([
      '2030-01-01',
      '2030-01-02',
    ]);
  });

  describe('weeks', () => {
    it('has a bucket for each Monday from the one of the start to the one of the end, and every day of them', () => {
      const w = per('week', { start: '2020-01-08', end: '2020-01-21' });
      expect(w.interval).toBe('week');
      // 01-08 is a Wednesday, 01-21 a Tuesday
      expect(w.buckets).toEqual(['2020-01-06', '2020-01-13', '2020-01-20']);
      expect(w.days).toHaveLength(21);
      expect([w.days[0], w.days[6], w.days[7], w.days[20]]).toEqual([
        '2020-01-06',
        '2020-01-12',
        '2020-01-13',
        '2020-01-26',
      ]);
      // the envelope says what was asked for
      expect([w.start.toISOString(), w.end.toISOString()]).toEqual([
        '2020-01-08T00:00:00.000Z',
        '2020-01-21T00:00:00.000Z',
      ]);
    });

    it('is the one week of a Sunday, whose Monday is six days before', () => {
      const w = per('week', { start: '2020-01-12', end: '2020-01-12' });
      expect(w.buckets).toEqual(['2020-01-06']);
      expect(w.days).toHaveLength(7);
    });

    it('allows 200 weeks between the first bucket and the last, 2020-01-06 to 2023-11-06, and refuses one week more', () => {
      const ok = per('week', { start: '2020-01-06', end: '2023-11-06' });
      expect(ok.buckets).toHaveLength(201);
      expect([ok.buckets[0], ok.buckets[200]]).toEqual(['2020-01-06', '2023-11-06']);
      // counted in buckets, whatever the day of the week: the end is anywhere in its week
      expect(per('week', { start: '2020-01-12', end: '2023-11-12' }).buckets).toHaveLength(201);
      for (const range of [
        { start: '2020-01-06', end: '2023-11-13' },
        { start: '2020-01-05', end: '2023-11-06' },
        { start: '2023-11-13', end: '2020-01-06' },
      ]) {
        expect([range, failure(() => per('week', range))]).toEqual([
          range,
          { status: 400, message: 'choose a date range less than 200 weeks' },
        ]);
      }
    });

    it('has none for an end in a week before the one of the start, and one for an end earlier in the same week', () => {
      expect(per('week', { start: '2020-01-13', end: '2020-01-12' })).toMatchObject({ buckets: [], days: [] });
      expect(per('week', { start: '2020-01-15', end: '2020-01-14' }).buckets).toEqual(['2020-01-13']);
    });
  });

  describe('months', () => {
    it('has a bucket for each month from the one of the start to the one of the end, and every day of them', () => {
      const w = per('month', { start: '2020-01-31', end: '2020-03-01' });
      expect(w.interval).toBe('month');
      expect(w.buckets).toEqual(['2020-01-01', '2020-02-01', '2020-03-01']);
      // 31 + 29 + 31 days
      expect(w.days).toHaveLength(91);
      expect([w.days[0], w.days[90]]).toEqual(['2020-01-01', '2020-03-31']);
    });

    it('allows 200 months between the first bucket and the last, and refuses one month more', () => {
      const ok = per('month', { start: '2020-01-15', end: '2036-09-02' });
      expect(ok.buckets).toHaveLength(201);
      expect([ok.buckets[0], ok.buckets[200]]).toEqual(['2020-01-01', '2036-09-01']);
      for (const range of [
        { start: '2020-01-31', end: '2036-10-01' },
        { start: '2019-12-31', end: '2036-09-02' },
        { start: '2036-10-01', end: '2020-01-31' },
      ]) {
        expect([range, failure(() => per('month', range))]).toEqual([
          range,
          { status: 400, message: 'choose a date range less than 200 months' },
        ]);
      }
    });
  });

  describe('a date in the path', () => {
    it('is the one bucket that holds it, whole', () => {
      const month = per('month', { start: 'bogus' }, '2020-03-15');
      expect(month.buckets).toEqual(['2020-03-01']);
      expect(month.days).toHaveLength(31);
      expect([month.start.toISOString(), month.end.toISOString()]).toEqual([
        '2020-03-15T00:00:00.000Z',
        '2020-03-15T00:00:00.000Z',
      ]);
      const week = per('week', {}, '2020-03-04T12:30:00');
      expect(week.buckets).toEqual(['2020-03-02']);
      expect(week.days).toEqual([
        '2020-03-02',
        '2020-03-03',
        '2020-03-04',
        '2020-03-05',
        '2020-03-06',
        '2020-03-07',
        '2020-03-08',
      ]);
    });
  });

  describe('today', () => {
    it('is the last day of the days: a bucket that has not ended is read up to now, and is a bucket whole', () => {
      const now = Date.parse('2020-03-10T12:00:00Z');
      const month = per('month', { start: '2020-03-01', end: '2020-03-20' }, undefined, now);
      expect(month.buckets).toEqual(['2020-03-01']);
      expect([month.days[0], month.days[month.days.length - 1], month.days.length]).toEqual([
        '2020-03-01',
        '2020-03-10',
        10,
      ]);
      const week = per('week', { start: '2020-03-02', end: '2020-03-20' }, undefined, now);
      expect(week.buckets).toEqual(['2020-03-02', '2020-03-09', '2020-03-16']);
      expect(week.days[week.days.length - 1]).toBe('2020-03-10');
    });

    it('leaves the days empty for buckets that all begin after it, and keeps the buckets', () => {
      const w = per('month', { start: '2999-01-01', end: '2999-02-10' });
      expect(w.buckets).toEqual(['2999-01-01', '2999-02-01']);
      expect(w.days).toEqual([]);
    });
  });

  describe('the order of the checks', () => {
    const interval = jest.fn((): VolumeInterval => {
      throw new Error('interval');
    });
    beforeEach(() => interval.mockClear());

    it('is the dates, then the interval, then the length', () => {
      for (const query of [
        { start: 'bogus' },
        { start: '2015-01-01', end: 'bogus' },
        { start: '2015-01-01', end: '' },
      ]) {
        expect(() => reportWindow(query, undefined, NOW, interval)).toThrow(/invalid (end )?date format/);
        expect(interval).not.toHaveBeenCalled();
      }
      expect(() => reportWindow({}, 'bogus', NOW, interval)).toThrow('invalid date format');
      expect(interval).not.toHaveBeenCalled();
      // a window that is too long is checked after the interval
      expect(() => reportWindow({ start: '2010-01-01', end: '2015-01-01' }, undefined, NOW, interval)).toThrow(
        'interval',
      );
      expect(interval).toHaveBeenCalledTimes(1);
      expect(interval).toHaveBeenCalledWith({ start: '2010-01-01', end: '2015-01-01' });
    });

    it('asks the interval for a date in the path as well', () => {
      expect(() => reportWindow({}, '2015-01-14', NOW, interval)).toThrow('interval');
    });
  });
});

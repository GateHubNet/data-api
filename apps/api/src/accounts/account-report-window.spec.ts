import { RippleHttpError } from '../common/errors';
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

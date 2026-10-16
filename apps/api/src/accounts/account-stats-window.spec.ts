import { RippleHttpError } from '../common/errors';
import { dayMarker, markerDay, statsWindow } from './account-stats-window';

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

/** The window as the tests read it: the first day, and the day the window stops before (exclusive). */
function window(query: Record<string, unknown>, now = NOW): { from: string; to: string } {
  const w = statsWindow(query, now);
  return { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() };
}

describe('statsWindow', () => {
  it('starts on 2013-01-01 and runs to the day of now, which is included', () => {
    expect(window({})).toEqual({ from: '2013-01-01T00:00:00.000Z', to: '2016-06-16T00:00:00.000Z' });
  });

  it('has the days whose midnight is at or after the start and before the end (the stop row of the original)', () => {
    expect(window({ start: '2015-01-01', end: '2015-01-16' })).toEqual({
      from: '2015-01-01T00:00:00.000Z',
      to: '2015-01-16T00:00:00.000Z',
    });
  });

  it('does not extend the end by the precision of what was written: end=2015-01-16 stops before that day', () => {
    // other routes read `end=2015-01-16` as the whole day; here it is the instant, as in `accountStats.js`
    expect(window({ start: '2015-01-01', end: '2015-01-16' }).to).toBe('2015-01-16T00:00:00.000Z');
    expect(window({ start: '2015-01-01', end: '2015-01' }).to).toBe('2015-01-01T00:00:00.000Z');
    expect(window({ start: '2014-01-01', end: '2015' }).to).toBe('2015-01-01T00:00:00.000Z');
  });

  it('includes the day of an end that is after its midnight, by a second or more', () => {
    expect(window({ start: '2015-01-01', end: '2015-01-16T00:00:01' }).to).toBe('2015-01-17T00:00:00.000Z');
    expect(window({ start: '2015-01-01', end: '2015-01-16T23:59:59' }).to).toBe('2015-01-17T00:00:00.000Z');
  });

  it('leaves out the day of a start that is after its midnight', () => {
    expect(window({ start: '2015-01-14T00:00:01', end: '2015-01-20' }).from).toBe('2015-01-15T00:00:00.000Z');
    expect(window({ start: '2015-01-14T00:00:00', end: '2015-01-20' }).from).toBe('2015-01-14T00:00:00.000Z');
  });

  it('reads the row keys to the second: milliseconds of a start or an end are cut off', () => {
    // the key of a row is YYYYMMDDHHmmss; 00:00:00.500 is the key 000000, so the day starts there and stops there
    expect(window({ start: '2015-01-14T00:00:00.500Z', end: '2015-01-20' }).from).toBe('2015-01-14T00:00:00.000Z');
    expect(window({ start: '2015-01-10', end: '2015-01-14T00:00:00.500Z' }).to).toBe('2015-01-14T00:00:00.000Z');
  });

  it('cuts a start that is less than a day from the end back to the start of its day', () => {
    // `if (!days) start.startOf('day')` of the original
    expect(window({ start: '2015-01-14T05:00:00', end: '2015-01-14T20:00:00' })).toEqual({
      from: '2015-01-14T00:00:00.000Z',
      to: '2015-01-15T00:00:00.000Z',
    });
    // start and end the same instant at midnight: that day has no row before the stop, so nothing
    expect(window({ start: '2015-01-14', end: '2015-01-14' })).toEqual({
      from: '2015-01-14T00:00:00.000Z',
      to: '2015-01-14T00:00:00.000Z',
    });
    // an end before the start by less than a day is cut the same way
    expect(window({ start: '2015-01-14T20:00:00', end: '2015-01-14T05:00:00' })).toEqual({
      from: '2015-01-14T00:00:00.000Z',
      to: '2015-01-15T00:00:00.000Z',
    });
  });

  it('does not cut a start that is a day or more from the end (whole days are counted)', () => {
    expect(window({ start: '2015-01-14T05:00:00', end: '2015-01-15T05:00:00' }).from).toBe('2015-01-15T00:00:00.000Z');
    expect(window({ start: '2015-01-14T05:00:00', end: '2015-01-15T04:59:59' }).from).toBe('2015-01-14T00:00:00.000Z');
  });

  it('is empty (nothing before the stop) when the end is a day or more before the start', () => {
    const w = statsWindow({ start: '2015-01-20', end: '2015-01-10' }, NOW);
    expect(w.to).toBeLessThanOrEqual(w.from);
  });

  it('uses the start default for an empty start, and takes every format of a date the API accepts', () => {
    expect(window({ start: '' }).from).toBe('2013-01-01T00:00:00.000Z');
    expect(window({ start: '2015-01', end: '2015-03' })).toEqual({
      from: '2015-01-01T00:00:00.000Z',
      to: '2015-03-01T00:00:00.000Z',
    });
    expect(window({ start: '20150114000000', end: '20150116000000' })).toEqual({
      from: '2015-01-14T00:00:00.000Z',
      to: '2015-01-16T00:00:00.000Z',
    });
    expect(
      window({ start: String(Date.parse('2015-01-14T00:00:00Z') / 1000), end: '2015-01-16T00:00:00+00:00' }),
    ).toEqual({ from: '2015-01-14T00:00:00.000Z', to: '2015-01-16T00:00:00.000Z' });
    // a zone other than UTC is converted
    expect(window({ start: '2015-01-14T02:00:00+02:00', end: '2015-01-16' }).from).toBe('2015-01-14T00:00:00.000Z');
  });

  it('refuses a start or an end that is not a date, the start first', () => {
    expect(failure(() => window({ start: 'x2015-01-14T00:00' }))).toEqual({
      status: 400,
      message: 'invalid start date format',
    });
    expect(failure(() => window({ start: '2015-01-14T00:00', end: 'x2015-01-14T00:00' }))).toEqual({
      status: 400,
      message: 'invalid end date format',
    });
    expect(failure(() => window({ start: 'a', end: 'b' })).message).toBe('invalid start date format');
    // an empty end is not a date either (the original parsed it)
    expect(failure(() => window({ end: '' })).message).toBe('invalid end date format');
    expect(failure(() => window({ start: '2015-02-30' })).message).toBe('invalid start date format');
  });

  it('takes the first value of a repeated parameter', () => {
    expect(window({ start: ['2015-01-14', 'nope'], end: ['2015-01-16', 'nope'] })).toEqual({
      from: '2015-01-14T00:00:00.000Z',
      to: '2015-01-16T00:00:00.000Z',
    });
  });

  it('handles dates before 1970 and far ahead', () => {
    expect(window({ start: '1969-12-31T12:00:00', end: '1970-01-02' }).from).toBe('1970-01-01T00:00:00.000Z');
    expect(window({ start: '1969-12-30', end: '1970-01-02' })).toEqual({
      from: '1969-12-30T00:00:00.000Z',
      to: '1970-01-02T00:00:00.000Z',
    });
    expect(window({ start: '2030-01-01', end: '2031-01-01' }).from).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('the marker of a day', () => {
  it('is the base64url of the JSON array of the day', () => {
    expect(dayMarker('2015-01-14')).toBe(Buffer.from('["2015-01-14"]', 'utf8').toString('base64url'));
  });

  it('is read back as the day', () => {
    expect(markerDay(dayMarker('2015-01-14'))).toBe('2015-01-14');
    expect(markerDay(undefined)).toBeUndefined();
    expect(markerDay('')).toBeUndefined();
  });

  it('is refused (400 invalid marker) when it is none of ours or its day does not exist', () => {
    const marker = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const bad of [
      'not a marker!',
      marker('2015-01-14'),
      marker(['2015-01-14', 1]),
      marker([20150114]),
      marker(['2015-1-14']),
      marker(['2015-02-30']),
      marker(['2015-01-14T00:00:00Z']),
      marker([]),
    ]) {
      expect([bad, failure(() => markerDay(bad))]).toEqual([bad, { status: 400, message: 'invalid marker' }]);
    }
  });
});

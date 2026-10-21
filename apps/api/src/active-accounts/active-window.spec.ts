import { RippleHttpError } from '../common/errors';
import { parseDate } from '../common/params';
import { ACTIVE_PERIODS, activeWindow, periodOf } from './active-window';

function failure(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as RippleHttpError;
    return { status: e.getStatus(), message: (e.getResponse() as { message: string }).message };
  }
  throw new Error('did not fail');
}

const NOW = Date.parse('2016-06-15T12:00:00.600Z');

function window(period: (typeof ACTIVE_PERIODS)[number], date: string | undefined, now = NOW): string[] {
  const w = activeWindow(period, date === undefined ? undefined : parseDate(date), now);
  return [w.start.toISOString(), w.endExclusive.toISOString()];
}

describe('periodOf', () => {
  it('is 1day without a period, with an empty one, or with the first of several', () => {
    expect(periodOf({})).toBe('1day');
    expect(periodOf({ period: '' })).toBe('1day');
    expect(periodOf({ period: ['7day', 'bogus'] })).toBe('7day');
  });

  it('is one of 1day, 3day and 7day, exactly as written', () => {
    expect(ACTIVE_PERIODS).toEqual(['1day', '3day', '7day']);
    for (const p of ACTIVE_PERIODS) expect(periodOf({ period: p })).toBe(p);
    for (const bad of ['1DAY', '2day', '1 day', '1', '30day', '07day', ' 1day']) {
      expect([bad, failure(() => periodOf({ period: bad }))]).toEqual([
        bad,
        { status: 400, message: 'invalid period - use: 1day, 3day, 7day' },
      ]);
    }
  });
});

describe('activeWindow', () => {
  it('without a date: from the period before now to the end of the second of now, read to the second', () => {
    expect(window('1day', undefined)).toEqual(['2016-06-14T12:00:00.000Z', '2016-06-15T12:00:01.000Z']);
    expect(window('3day', undefined)).toEqual(['2016-06-12T12:00:00.000Z', '2016-06-15T12:00:01.000Z']);
    expect(window('7day', undefined)).toEqual(['2016-06-08T12:00:00.000Z', '2016-06-15T12:00:01.000Z']);
  });

  it('with a date: from it to the period after it, and then one unit of what the date names', () => {
    // a day: the whole of the day that is `period` after it is in (smoment.hbaseFormatStopRow of the end)
    expect(window('7day', '2015-01-14')).toEqual(['2015-01-14T00:00:00.000Z', '2015-01-22T00:00:00.000Z']);
    expect(window('1day', '2015-01-14')).toEqual(['2015-01-14T00:00:00.000Z', '2015-01-16T00:00:00.000Z']);
    expect(window('3day', '2015-01-14')).toEqual(['2015-01-14T00:00:00.000Z', '2015-01-18T00:00:00.000Z']);
    // an hour, a minute, a second
    expect(window('1day', '2015-01-14T18')).toEqual(['2015-01-14T18:00:00.000Z', '2015-01-15T19:00:00.000Z']);
    expect(window('1day', '2015-01-14T18:28')).toEqual(['2015-01-14T18:28:00.000Z', '2015-01-15T18:29:00.000Z']);
    expect(window('3day', '2015-01-14T18:28:40')).toEqual(['2015-01-14T18:28:40.000Z', '2015-01-17T18:28:41.000Z']);
    expect(window('3day', '2015-01-14T18:28:40+02:00')).toEqual([
      '2015-01-14T16:28:40.000Z',
      '2015-01-17T16:28:41.000Z',
    ]);
    expect(window('3day', '1421260120')).toEqual(['2015-01-14T18:28:40.000Z', '2015-01-17T18:28:41.000Z']);
    // a month and a year
    expect(window('1day', '2023-06')).toEqual(['2023-06-01T00:00:00.000Z', '2023-07-02T00:00:00.000Z']);
    expect(window('7day', '2023-01')).toEqual(['2023-01-01T00:00:00.000Z', '2023-02-08T00:00:00.000Z']);
    expect(window('1day', '2024')).toEqual(['2024-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z']);
  });

  it('is read to the second, like the keys of the scan: a start is cut, the end of a millisecond date is cut too', () => {
    // 12:00:00.500 + 3 days + 1 ms is :00.501, which the key (…120000) is not below
    expect(window('3day', '2022-06-10T12:00:00.500Z')).toEqual([
      '2022-06-10T12:00:00.000Z',
      '2022-06-13T12:00:00.000Z',
    ]);
    expect(window('3day', '2022-06-10T12:00:00.999Z')).toEqual([
      '2022-06-10T12:00:00.000Z',
      '2022-06-13T12:00:01.000Z',
    ]);
  });

  it('counts days of 24 hours in UTC, over a leap day too', () => {
    expect(window('3day', '2016-02-28')).toEqual(['2016-02-28T00:00:00.000Z', '2016-03-03T00:00:00.000Z']);
    expect(window('7day', '2015-12-30')).toEqual(['2015-12-30T00:00:00.000Z', '2016-01-07T00:00:00.000Z']);
  });
});

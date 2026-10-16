import { RippleHttpError } from '../common/errors';
import { FUTURE_TOLERANCE_MS, rateDate } from './rate-date';

const NOW = Date.parse('2016-06-15T12:00:00.600Z');

function failure(query: Record<string, unknown>): { status: number; message: string } {
  try {
    rateDate(query, NOW);
  } catch (err) {
    const e = err as RippleHttpError;
    return { status: e.getStatus(), message: (e.getResponse() as { message: string }).message };
  }
  throw new Error('did not fail');
}

describe('rateDate', () => {
  it('without a date it is now, and the period it names is the second of now', () => {
    const { date, endExclusive } = rateDate({}, NOW);
    expect([date.getTime(), endExclusive.toISOString()]).toEqual([NOW, '2016-06-15T12:00:01.000Z']);
  });

  it('a date names a period and the rates are read to the end of it', () => {
    const iso = (query: Record<string, unknown>): string[] => {
      const { date, endExclusive } = rateDate(query, NOW);
      return [date.toISOString(), endExclusive.toISOString()];
    };
    expect(iso({ date: '2015-01-14' })).toEqual(['2015-01-14T00:00:00.000Z', '2015-01-15T00:00:00.000Z']);
    expect(iso({ date: '2015-01' })).toEqual(['2015-01-01T00:00:00.000Z', '2015-02-01T00:00:00.000Z']);
    expect(iso({ date: '2015' })).toEqual(['2015-01-01T00:00:00.000Z', '2016-01-01T00:00:00.000Z']);
    expect(iso({ date: '2015-01-14T18' })).toEqual(['2015-01-14T18:00:00.000Z', '2015-01-14T19:00:00.000Z']);
    expect(iso({ date: '2015-01-14T18:28' })).toEqual(['2015-01-14T18:28:00.000Z', '2015-01-14T18:29:00.000Z']);
    expect(iso({ date: '2015-01-14T18:28:40Z' })).toEqual(['2015-01-14T18:28:40.000Z', '2015-01-14T18:28:41.000Z']);
    expect(iso({ date: '2015-01-14T18:28:40.250Z' })).toEqual(['2015-01-14T18:28:40.250Z', '2015-01-14T18:28:40.251Z']);
    expect(iso({ date: ['2015-01-14', '2016-01-01'] })).toEqual([
      '2015-01-14T00:00:00.000Z',
      '2015-01-15T00:00:00.000Z',
    ]);
    expect(iso({ date: '1421260120' })).toEqual(['2015-01-14T18:28:40.000Z', '2015-01-14T18:28:41.000Z']);
  });

  it('more than 10 ms ahead of now is a future date, 10 ms is not', () => {
    expect(FUTURE_TOLERANCE_MS).toBe(10);
    expect(failure({ date: '2016-06-15T12:00:01Z' })).toEqual({ status: 400, message: 'must not be a future date' });
    expect(failure({ date: '9999-01-01' })).toEqual({ status: 400, message: 'must not be a future date' });
    expect(() => rateDate({ date: '2016-06-15T12:00:00.610Z' }, NOW)).not.toThrow();
    expect(failure({ date: '2016-06-15T12:00:00.611Z' }).status).toBe(400);
    // the start of the period counts, not its end: today is not in the future
    expect(() => rateDate({ date: '2016-06-15' }, NOW)).not.toThrow();
    expect(failure({ date: '2016-06-16' }).status).toBe(400);
  });

  it('text that is not a date is 400 invalid date format, empty included', () => {
    for (const date of ['garbage', '2015-13-01', '2015-02-30', '', '20150114', 'now']) {
      expect([date, failure({ date })]).toEqual([date, { status: 400, message: 'invalid date format' }]);
    }
    // an object (a nested query parameter) is no date text: it counts as missing
    expect(rateDate({ date: { a: 1 } }, NOW).date.getTime()).toBe(NOW);
  });
});

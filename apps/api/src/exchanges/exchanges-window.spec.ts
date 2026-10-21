import { ammFilter } from '../common/params';
import { exchangesWindow } from './exchanges-window';

describe('exchangesWindow', () => {
  it('reads start (2013-01-01 when missing or empty), end, limit (200, at most 400) and the flags, as the exchange routes do', () => {
    const w = exchangesWindow({}, ammFilter);
    expect(w.start).toEqual(new Date('2013-01-01T00:00:00Z'));
    expect(w).toMatchObject({ limit: 200, amm: 'include', autobridged: false, descending: false });
    expect(w.endExclusive).toBeUndefined();
    expect(w.marker).toBeUndefined();
    expect(exchangesWindow({ start: '' }, ammFilter).start).toEqual(new Date('2013-01-01T00:00:00Z'));

    const all = exchangesWindow(
      {
        start: '2024-03-01',
        end: '2024-03-02',
        limit: '9999',
        amm: 'only',
        autobridged: 'true',
        descending: 'true',
        marker: 'm',
      },
      ammFilter,
    );
    expect(all).toEqual({
      start: new Date('2024-03-01T00:00:00Z'),
      endExclusive: new Date('2024-03-03T00:00:00Z'),
      autobridged: true,
      amm: 'only',
      descending: true,
      limit: 400,
      marker: 'm',
    });
  });

  it('answers the errors in the order start, end, limit, amm', () => {
    const message = (q: Record<string, string>): string => {
      try {
        exchangesWindow(q, ammFilter);
      } catch (err) {
        return (err as { response: { message: string } }).response.message;
      }
      return 'no error';
    };
    const all = { start: 'x', end: 'x', limit: 'x', amm: 'x' };
    expect(message(all)).toBe('invalid start date format');
    expect(message({ ...all, start: '2024' })).toBe('invalid end date format');
    expect(message({ ...all, start: '2024', end: '2024' })).toBe('invalid limit: NaN');
    expect(message({ ...all, start: '2024', end: '2024', limit: '5' })).toBe(
      'invalid amm filter - use: include, exclude, only',
    );
  });

  it('takes the amm filter from the function it is given, which can ignore the param (the swaps of a pool are always `only`)', () => {
    expect(exchangesWindow({ amm: 'exclude' }, () => 'only').amm).toBe('only');
    expect(() => exchangesWindow({ amm: 'bogus' }, () => 'only')).not.toThrow();
  });
});

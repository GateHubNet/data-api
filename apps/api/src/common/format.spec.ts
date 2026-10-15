import { compact, fmtCloseTimeHuman, fmtMillis, fmtTime, fmtTxDate, precision8 } from './format';

// Unix seconds, which is what moment.unix() in the original took: 2015-01-14 17:29:10 UTC.
const T = 1_421_256_550;

describe('fmtTime', () => {
  it('formats unix seconds as YYYY-MM-DDTHH:mm:ssZ', () => {
    expect(fmtTime(T)).toBe('2015-01-14T17:29:10Z');
    expect(fmtTime(0)).toBe('1970-01-01T00:00:00Z');
  });

  it('formats a Date, in UTC and without the milliseconds', () => {
    expect(fmtTime(new Date('2015-01-14T17:29:10.987Z'))).toBe('2015-01-14T17:29:10Z');
    expect(fmtTime(new Date('2015-01-14T23:59:59+02:00'))).toBe('2015-01-14T21:59:59Z');
  });

  it('cuts the fraction of a second rather than rounding up into the next one', () => {
    expect(fmtTime(T + 0.999)).toBe('2015-01-14T17:29:10Z');
  });
});

describe('fmtTxDate', () => {
  it('ends with the +00:00 of a UTC moment, not a Z', () => {
    expect(fmtTxDate(T)).toBe('2015-01-14T17:29:10+00:00');
    expect(fmtTxDate(T)).toMatch(/\+00:00$/);
  });
});

describe('fmtCloseTimeHuman', () => {
  it('is YYYY-MMM-DD HH:mm:ss', () => {
    expect(fmtCloseTimeHuman(1_421_256_550)).toBe('2015-Jan-14 17:29:10');
  });

  it('writes a 24-hour clock', () => {
    expect(fmtCloseTimeHuman(Date.UTC(2020, 5, 3, 0, 5, 9) / 1000)).toBe('2020-Jun-03 00:05:09');
    expect(fmtCloseTimeHuman(Date.UTC(2020, 5, 3, 23, 59, 59) / 1000)).toBe('2020-Jun-03 23:59:59');
  });

  it.each([
    [0, 'Jan'],
    [1, 'Feb'],
    [2, 'Mar'],
    [3, 'Apr'],
    [4, 'May'],
    [5, 'Jun'],
    [6, 'Jul'],
    [7, 'Aug'],
    [8, 'Sep'],
    [9, 'Oct'],
    [10, 'Nov'],
    [11, 'Dec'],
  ])('writes month index %i as %s', (month, name) => {
    expect(fmtCloseTimeHuman(Date.UTC(2016, month, 15, 12, 0, 0) / 1000)).toBe(`2016-${name}-15 12:00:00`);
  });
});

describe('fmtMillis', () => {
  it('formats a Date as YYYY-MM-DDTHH:mm:ss.SSSZ', () => {
    expect(fmtMillis(new Date('2015-01-14T17:29:10.987Z'))).toBe('2015-01-14T17:29:10.987Z');
    expect(fmtMillis(new Date('2015-01-14T17:29:10Z'))).toBe('2015-01-14T17:29:10.000Z');
  });

  it('reads a number as unix seconds like the other formats, with the fraction as milliseconds', () => {
    expect(fmtMillis(T)).toBe('2015-01-14T17:29:10.000Z');
    expect(fmtMillis(T + 0.987)).toBe('2015-01-14T17:29:10.987Z');
    expect(fmtMillis(1_421_256_550.123)).toBe('2015-01-14T17:29:10.123Z');
  });

  it('cuts below the millisecond, as moment.unix() did', () => {
    expect(fmtMillis(T + 0.0006)).toBe('2015-01-14T17:29:10.000Z');
  });
});

describe('precision8', () => {
  it('is BigNumber toPrecision(8): eight significant digits, zero padded', () => {
    expect(precision8('0.004')).toBe('0.0040000000');
    expect(precision8(1)).toBe('1.0000000');
    expect(precision8('0.5')).toBe('0.50000000');
  });

  it('rounds half up at the eighth digit', () => {
    expect(precision8('1.234567891')).toBe('1.2345679');
    expect(precision8('0.123456785')).toBe('0.12345679');
    expect(precision8('2.00000005')).toBe('2.0000001');
  });

  it('switches to exponents beyond eight integer digits, as BigNumber does', () => {
    expect(precision8('123456789')).toBe('1.2345679e+8');
  });

  it('takes a BigNumber or a number as well as a string', () => {
    expect(precision8(0.1)).toBe('0.10000000');
  });
});

describe('compact', () => {
  it('drops undefined and keeps everything else, null included', () => {
    expect(compact({ a: 1, b: undefined, c: null, d: 0, e: '', f: false, g: [] })).toEqual({
      a: 1,
      c: null,
      d: 0,
      e: '',
      f: false,
      g: [],
    });
  });

  it('removes the key itself, so that it is neither in the JSON nor in Object.keys', () => {
    const out = compact({ a: 1, b: undefined as number | undefined });
    expect(Object.keys(out)).toEqual(['a']);
    expect(JSON.stringify(out)).toBe('{"a":1}');
  });

  it('keeps the order of the keys', () => {
    expect(Object.keys(compact({ z: 1, y: undefined, x: 2, w: null, v: undefined }))).toEqual(['z', 'x', 'w']);
  });

  it('works on the surface only and does not change its input', () => {
    const nested = { inner: undefined as number | undefined };
    const input = Object.freeze({ a: undefined as number | undefined, nested });
    const out = compact(input);
    expect(out.nested).toBe(nested);
    expect(Object.keys(nested)).toEqual(['inner']);
    expect(Object.keys(input)).toEqual(['a', 'nested']);
  });
});

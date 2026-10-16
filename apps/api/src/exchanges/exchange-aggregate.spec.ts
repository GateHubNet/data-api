import { AggregateRow, BucketRow, toAggregateCsvRow, toCandleObject, toReducedObject } from './exchange-aggregate';

const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const USD_XRP = { base: { currency: 'USD', issuer: ISSUER }, counter: { currency: 'XRP' } };
const XRP_USD = { base: { currency: 'XRP' }, counter: { currency: 'USD', issuer: ISSUER } };

/** Three exchanges of USD/XRP as stored (USD base): two bought by the taker, one sold. */
const ROW: AggregateRow = {
  n: 3,
  open_rate: '68.16632582',
  close_rate: '68.49315073184462378893',
  high_rate: '68.49315073184462378893',
  low_rate: '64',
  base_sum: '72.5',
  counter_sum: '4950.25',
  base_bought: '50',
  counter_bought: '677.135773',
  unfit: 0,
  base_sum_f: 72.5,
  counter_sum_f: 4950.25,
  base_bought_f: 50,
  counter_bought_f: 677.135773,
  open_ts: 1421260040,
  close_ts: 1421261500,
};
const BUCKET: BucketRow = { ...ROW, bucket: 1421258400 };

const deepFreeze = <T>(o: T): T => {
  Object.freeze(o);
  for (const v of Object.values(o as object)) if (typeof v === 'object' && v !== null) deepFreeze(v);
  return o;
};

describe('toCandleObject', () => {
  it('has the keys of the HBase agg row (the d family sorted), then the pair the route sets', () => {
    const candle = toCandleObject(BUCKET, USD_XRP, false);
    expect(Object.keys(candle)).toEqual([
      'base_volume',
      'buy_volume',
      'close',
      'close_time',
      'count',
      'counter_volume',
      'high',
      'low',
      'open',
      'open_time',
      'start',
      'vwap',
      'base_currency',
      'base_issuer',
      'counter_currency',
    ]);
  });

  it('prices to 8 significant digits, volumes as text, buy volume and count as numbers, times as the API writes them', () => {
    expect(toCandleObject(BUCKET, USD_XRP, false)).toEqual({
      base_volume: '72.5',
      buy_volume: 50,
      close: '68.493151',
      close_time: '2015-01-14T18:51:40Z',
      count: 3,
      counter_volume: '4950.25',
      high: '68.493151',
      low: '64.000000',
      open: '68.166326',
      open_time: '2015-01-14T18:27:20Z',
      start: '2015-01-14T18:00:00Z',
      vwap: '68.279310',
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
    });
  });

  it('inverted: 1/open, 1/close, high is 1/low and low is 1/high, volumes swap, the buy volume is the other side', () => {
    const candle = toCandleObject(BUCKET, XRP_USD, true);
    expect(candle).toEqual({
      base_volume: '4950.25',
      // the counter (now base) of the exchanges in which the seller (now buyer) was the taker
      buy_volume: 677.135773,
      close: '0.014600000',
      close_time: '2015-01-14T18:51:40Z',
      count: 3,
      counter_volume: '72.5',
      high: '0.015625000',
      low: '0.014600000',
      open: '0.014670000',
      open_time: '2015-01-14T18:27:20Z',
      start: '2015-01-14T18:00:00Z',
      vwap: '0.014645725',
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
    });
    expect(Object.keys(candle).slice(-3)).toEqual(['base_currency', 'counter_currency', 'counter_issuer']);
  });

  it('inverts rates far from 1 without losing digits', () => {
    const wide = { ...BUCKET, open_rate: '1e30', close_rate: '2.5e100', high_rate: '1e-150', low_rate: '1e-30' };
    const candle = toCandleObject(wide, XRP_USD, true);
    expect(candle.open).toBe('1.0000000e-30');
    expect(candle.close).toBe('4.0000000e-101');
    expect(candle.high).toBe('1.0000000e+30');
    expect(candle.low).toBe('1.0000000e+150');
  });

  it('a vwap far from 1 keeps its digits', () => {
    const wide = { ...BUCKET, base_sum: '3e+20', counter_sum: '1e-20' };
    expect(toCandleObject(wide, USD_XRP, false).vwap).toBe('3.3333333e-41');
    expect(toCandleObject(wide, XRP_USD, true).vwap).toBe('3.0000000e+40');
  });

  it('volumes are the exact sums, written as a number is (exponent from 1e21 and below 1e-6)', () => {
    const candle = toCandleObject(
      { ...BUCKET, base_sum: '0.3', counter_sum: '1000000000000000000000', base_bought: '0.0000001' },
      USD_XRP,
      false,
    );
    expect(candle.base_volume).toBe('0.3');
    expect(candle.counter_volume).toBe('1e+21');
    expect(candle.buy_volume).toBe(1e-7);
    // a decimal sum comes with trailing zeros cut, or none at all (no amount bought)
    expect(toCandleObject({ ...BUCKET, base_bought: null, counter_sum: '12.50' }, USD_XRP, false)).toMatchObject({
      buy_volume: 0,
      counter_volume: '12.5',
    });
  });

  it('an amount the exact sums cannot hold: the Float64 sums, as the original had them', () => {
    const unfit = {
      ...BUCKET,
      unfit: 1,
      base_sum: '1',
      counter_sum: '1',
      base_bought: '1',
      counter_bought: '1',
      base_sum_f: 0.1 + 0.2,
      counter_sum_f: 2e40,
      base_bought_f: 0.25,
      counter_bought_f: 1e39,
    };
    expect(toCandleObject(unfit, USD_XRP, false)).toMatchObject({
      base_volume: '0.30000000000000004',
      counter_volume: '2e+40',
      buy_volume: 0.25,
      vwap: '6.6666667e+40',
    });
    expect(toCandleObject(unfit, XRP_USD, true)).toMatchObject({
      base_volume: '2e+40',
      counter_volume: '0.30000000000000004',
      buy_volume: 1e39,
    });
  });

  it('a base volume of 0 has a vwap of 0, never Infinity or NaN', () => {
    expect(toCandleObject({ ...BUCKET, base_sum: '0' }, USD_XRP, false).vwap).toBe('0.0000000');
    expect(toCandleObject({ ...BUCKET, base_sum: '0', counter_sum: '0' }, USD_XRP, false).vwap).toBe('0.0000000');
    // inverted, the stored counter is the base
    expect(toCandleObject({ ...BUCKET, counter_sum: '0' }, XRP_USD, true).vwap).toBe('0.0000000');
    expect(toCandleObject({ ...BUCKET, base_sum: '0' }, XRP_USD, true).vwap).toBe('0.0000000');
    // the float sums too
    expect(toCandleObject({ ...BUCKET, unfit: 1, base_sum_f: 0 }, USD_XRP, false).vwap).toBe('0.0000000');
    expect(toReducedObject({ ...ROW, base_sum: '0' }, USD_XRP, false, new Date(0)).vwap).toBe('0.0000000');
  });

  it('does not change its input', () => {
    const row = deepFreeze({ ...BUCKET });
    const pair = deepFreeze({ base: { ...USD_XRP.base }, counter: { ...USD_XRP.counter } });
    expect(() => toCandleObject(row, pair, true)).not.toThrow();
  });
});

describe('toReducedObject', () => {
  const START = new Date('2015-01-14T00:00:00Z');

  it('has the keys of the reduced row of the original: its literal, then start and the pair', () => {
    const reduced = toReducedObject(ROW, USD_XRP, false, START);
    expect(Object.keys(reduced)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'base_volume',
      'counter_volume',
      'buy_volume',
      'count',
      'open_time',
      'close_time',
      'vwap',
      'start',
      'base_currency',
      'base_issuer',
      'counter_currency',
    ]);
    expect(reduced).toEqual({
      open: '68.166326',
      high: '68.493151',
      low: '64.000000',
      close: '68.493151',
      base_volume: '72.5',
      counter_volume: '4950.25',
      buy_volume: 50,
      count: 3,
      open_time: '2015-01-14T18:27:20Z',
      close_time: '2015-01-14T18:51:40Z',
      vwap: '68.279310',
      // the start of the window (the original wrote the time of the request)
      start: '2015-01-14T00:00:00Z',
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
    });
  });

  it('inverted like a candle', () => {
    expect(toReducedObject(ROW, XRP_USD, true, START)).toMatchObject({
      open: '0.014670000',
      high: '0.015625000',
      low: '0.014600000',
      close: '0.014600000',
      base_volume: '4950.25',
      counter_volume: '72.5',
      buy_volume: 677.135773,
      vwap: '0.014645725',
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
    });
  });

  it('no exchange: the zeros of the original, without open and close time', () => {
    for (const row of [undefined, { ...ROW, n: 0, open_rate: '', close_rate: '', high_rate: '', low_rate: '' }]) {
      const reduced = toReducedObject(row, XRP_USD, true, START);
      expect(reduced).toEqual({
        open: '0.0000000',
        high: '0.0000000',
        low: '0.0000000',
        close: '0.0000000',
        base_volume: '0',
        counter_volume: '0',
        buy_volume: 0,
        count: 0,
        vwap: '0.0000000',
        start: '2015-01-14T00:00:00Z',
        base_currency: 'XRP',
        counter_currency: 'USD',
        counter_issuer: ISSUER,
      });
      expect(Object.keys(reduced).slice(0, 9)).toEqual([
        'open',
        'high',
        'low',
        'close',
        'base_volume',
        'counter_volume',
        'buy_volume',
        'count',
        'vwap',
      ]);
    }
  });
});

describe('toAggregateCsvRow', () => {
  it('the columns of the original in its order, and the buy volume it dropped from the first row at the end', () => {
    const csv = toAggregateCsvRow(toCandleObject(BUCKET, XRP_USD, true));
    expect(Object.keys(csv)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'vwap',
      'count',
      'base_currency',
      'base_issuer',
      'base_volume',
      'counter_currency',
      'counter_issuer',
      'counter_volume',
      'open_time',
      'close_time',
      'start',
      'buy_volume',
    ]);
    expect(csv).toMatchObject({
      base_currency: 'XRP',
      base_issuer: null,
      counter_issuer: ISSUER,
      buy_volume: 677.135773,
    });
  });

  it('a reduced row without exchanges has empty times', () => {
    const csv = toAggregateCsvRow(toReducedObject(undefined, USD_XRP, false, new Date(0)));
    expect(csv).toMatchObject({ open_time: null, close_time: null, count: 0, counter_issuer: null });
  });
});

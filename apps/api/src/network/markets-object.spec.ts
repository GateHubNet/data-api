import BigNumber from 'bignumber.js';
import {
  changePercent,
  convertedVolume,
  marketsAnswer,
  noMarketsAnswer,
  sparklineOf,
  StoredMarket,
  StoredMarketsSet,
} from './markets-object';

/** Freezes the whole structure: the functions are pure and a write to their input would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const OTHER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const sec = (text: string): number => Date.parse(text) / 1000;

/** The market of the example of the spec (USD of ISSUER against the native currency). */
const USD_XRP: StoredMarket = {
  base_currency: 'USD',
  base_issuer: ISSUER,
  counter_currency: 'XRP',
  counter_issuer: '',
  count: 18420,
  base_volume: '41200000',
  counter_volume: '16888000',
  native_volume: '16888000',
  open: '0.4199',
  high: '0.425',
  low: '0.401',
  last: '0.4099',
  open_time: sec('2026-10-18T11:00:03Z'),
  last_time: sec('2026-10-19T11:42:30Z'),
  closes: ['0.4123', '0.418', '0.418', '0.4201', '0.415', '0.4199', '0.4099'],
};

/** A pair that has no pair of its own with the native currency, and no rate: no native volume. */
const BTC_EUR: StoredMarket = {
  base_currency: 'BTC',
  base_issuer: ISSUER,
  counter_currency: 'EUR',
  counter_issuer: OTHER,
  count: 12,
  base_volume: '3',
  counter_volume: '60',
  native_volume: null,
  open: '20',
  high: '25',
  low: '20',
  last: '25',
  open_time: sec('2026-10-18T12:00:00Z'),
  last_time: sec('2026-10-19T09:00:00Z'),
  closes: [null, null, null, null, null, '20', '25'],
};

const SET: StoredMarketsSet = {
  start_time: sec('2026-10-18T11:00:00Z'),
  end_time: sec('2026-10-19T11:42:31Z'),
  pairs_traded: 1840,
  total_count: 61234,
  total_native_volume: '123456789.12',
  markets: [BTC_EUR, USD_XRP],
};

/** A market with the pair, the count and the native volume of a test: the other fields are of no interest. */
function market(
  base: string,
  counter: string,
  count: number,
  native: string | null,
  extra: Partial<StoredMarket> = {},
): StoredMarket {
  const [baseCurrency, baseIssuer = ''] = base.split('+');
  const [counterCurrency, counterIssuer = ''] = counter.split('+');
  return {
    ...USD_XRP,
    base_currency: baseCurrency,
    base_issuer: baseIssuer,
    counter_currency: counterCurrency,
    counter_issuer: counterIssuer,
    count,
    native_volume: native,
    ...extra,
  };
}

const answerOf = (markets: StoredMarket[], o: { minTrades?: number; limit?: number } = {}) =>
  marketsAnswer({
    period: 'day',
    set: { ...SET, markets },
    minTrades: o.minTrades ?? 1,
    limit: o.limit ?? 1000,
  });

/** The pairs of an answer, as `BASE/COUNTER`, in the order served. */
const pairsOf = (markets: { base_currency: string; counter_currency: string }[]): string[] =>
  markets.map((m) => `${m.base_currency}/${m.counter_currency}`);

// ---------------------------------------------------------------------------------------------------------------------

describe('change: (last / open - 1) * 100, exact, half up to 2 decimals', () => {
  it('open 0.41990000 and last 0.40990000 is -2.38', () => {
    expect(changePercent('0.41990000', '0.40990000')).toBe('-2.38');
    // the text of the stored rate is what counts, not its eight digits
    expect(changePercent('0.4199', '0.4099')).toBe('-2.38');
  });

  it('is always two decimals, whatever the sign', () => {
    expect(changePercent('0.5', '0.6')).toBe('20.00');
    expect(changePercent('0.6', '0.5')).toBe('-16.67');
    expect(changePercent('2', '2')).toBe('0.00');
    expect(changePercent('0.4', '0.40000000001')).toBe('0.00');
    expect(changePercent('10', '40')).toBe('300.00');
    expect(changePercent('4', '1')).toBe('-75.00');
  });

  it('is never "-0.00"', () => {
    expect(changePercent('1', '0.99999')).toBe('0.00');
    expect(changePercent('1', '0.9999')).toBe('-0.01');
  });

  it('rounds half up: a tie goes away from zero, a hair below one does not', () => {
    expect(changePercent('1', '1.00125')).toBe('0.13'); // 0.125
    expect(changePercent('1', '1.001249999999999999999999999')).toBe('0.12');
    expect(changePercent('1', '0.99875')).toBe('-0.13'); // -0.125
    expect(changePercent('1', '0.998750000000000000000000001')).toBe('-0.12');
    expect(changePercent('8', '8.01')).toBe('0.13'); // 0.125 again, from an open that is not 1
  });

  it('is exact where a quotient cut to 20 places would round twice', () => {
    // 1/3 - 1 is -66.666...%, and 100/3 never ends: the one rounding is the right one
    expect(changePercent('3', '1')).toBe('-66.67');
    // last / open is 1.001249999999999999999999 (24 places): cut to 20 it is 1.00125, a change of 0.125, which would go up
    expect(changePercent('1000000000000000000000000', '1001249999999999999999999')).toBe('0.12');
    expect(changePercent('1000000000000000000000000', '1001250000000000000000001')).toBe('0.13');
    // and the same for a fall: 0.998750000000000000000001 is cut to 0.99875, a change of -0.125, which would go down
    expect(changePercent('1000000000000000000000000', '998750000000000000000001')).toBe('-0.12');
    expect(changePercent('1000000000000000000000000', '998749999999999999999999')).toBe('-0.13');
  });

  it('holds for the largest and the smallest rates', () => {
    expect(changePercent('1e-50', '3e-50')).toBe('200.00');
    expect(changePercent('1e+50', '5e+49')).toBe('-50.00');
  });

  it('has none for an open that is not above 0', () => {
    expect(changePercent('0', '1')).toBeUndefined();
    expect(changePercent('0.00000000', '0.5')).toBeUndefined();
  });
});

describe('converted_volume: the native volume times the rate, to 17 significant digits', () => {
  it('cuts the exact product to 17 digits, half up', () => {
    // 1234567.12345678901234 * 2.5 = 3086417.80864197253085 (21 digits)
    expect(convertedVolume('1234567.12345678901234', new BigNumber('2.5'))).toBe('3086417.8086419725');
    // 0.99999999999999999999999 to 17 digits is 1
    expect(convertedVolume('3', new BigNumber('0.33333333333333333333333'))).toBe('1');
    // a tie at the 17th digit goes up
    expect(convertedVolume('1.00000000000000005', new BigNumber(1))).toBe('1.0000000000000001');
    expect(convertedVolume('1.00000000000000004', new BigNumber(1))).toBe('1');
  });

  it('is exact when it fits in 17 digits, and 0 for a rate of 0', () => {
    expect(convertedVolume('16888000', new BigNumber('0.5'))).toBe('8444000');
    expect(convertedVolume('16888000', new BigNumber(0))).toBe('0');
    expect(convertedVolume('0', new BigNumber('1.5'))).toBe('0');
  });

  it('takes the rate as it is, not as the 8 digits that are served', () => {
    const rate = new BigNumber('0.123456789');
    expect(convertedVolume('1000000000', rate)).toBe('123456789');
    expect(new BigNumber(rate).toPrecision(8)).toBe('0.12345679');
  });
});

describe('the sparkline: the 7 days that end with the day of end_time, close left out where there is none', () => {
  it('is a date and a close each, the dates the starts of the UTC days', () => {
    expect(sparklineOf(USD_XRP.closes, sec('2026-10-19T11:42:31Z'))).toEqual([
      { date: '2026-10-13T00:00:00Z', close: '0.41230000' },
      { date: '2026-10-14T00:00:00Z', close: '0.41800000' },
      { date: '2026-10-15T00:00:00Z', close: '0.41800000' },
      { date: '2026-10-16T00:00:00Z', close: '0.42010000' },
      { date: '2026-10-17T00:00:00Z', close: '0.41500000' },
      { date: '2026-10-18T00:00:00Z', close: '0.41990000' },
      { date: '2026-10-19T00:00:00Z', close: '0.40990000' },
    ]);
  });

  it('leaves out close for a null close, and the key with it', () => {
    const entries = sparklineOf([null, null, '0.5', null, '20', '1234.56789', '1e-9'], sec('2026-03-02T00:00:00Z'));
    expect(entries.map((e) => Object.keys(e))).toEqual([
      ['date'],
      ['date'],
      ['date', 'close'],
      ['date'],
      ['date', 'close'],
      ['date', 'close'],
      ['date', 'close'],
    ]);
    expect(entries.map((e) => e.date.slice(0, 10))).toEqual([
      '2026-02-24',
      '2026-02-25',
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    // eight significant digits, as the prices
    expect(entries.map((e) => e.close)).toEqual([
      undefined,
      undefined,
      '0.50000000',
      undefined,
      '20.000000',
      '1234.5679',
      '1.0000000e-9',
    ]);
  });

  it('ends with the day of the end, whichever second of it: the last second, the first second', () => {
    expect(sparklineOf(['1'], sec('2026-10-19T23:59:59Z'))[0].date).toBe('2026-10-19T00:00:00Z');
    expect(sparklineOf(['1'], sec('2026-10-19T00:00:00Z'))[0].date).toBe('2026-10-19T00:00:00Z');
    // across a month and a leap day
    expect(sparklineOf(Array(7).fill('1'), sec('2028-03-02T10:00:00Z'))[0].date).toBe('2028-02-25T00:00:00Z');
  });

  it('is empty for no closes', () => {
    expect(sparklineOf([], sec('2026-10-19T11:42:31Z'))).toEqual([]);
  });
});

describe('the answer', () => {
  const answer = marketsAnswer({ period: 'day', set: SET, minTrades: 10, limit: 1000 });

  it('is result, period, start_time, end_time, totals, count, markets', () => {
    expect(Object.keys(answer)).toEqual(['result', 'period', 'start_time', 'end_time', 'totals', 'count', 'markets']);
    expect(answer).toMatchObject({
      result: 'success',
      period: 'day',
      start_time: '2026-10-18T11:00:00Z',
      end_time: '2026-10-19T11:42:31Z',
      count: 2,
    });
  });

  it('has the totals pairs, pairs_traded, count, native_volume', () => {
    expect(Object.keys(answer.totals)).toEqual(['pairs', 'pairs_traded', 'count', 'native_volume']);
    expect(answer.totals).toEqual({ pairs: 2, pairs_traded: 1840, count: 61234, native_volume: '123456789.12' });
  });

  it('has the market keys in order: the issuers only where there are any, native_volume only where there is one', () => {
    const [usd, btc] = answer.markets;
    expect(Object.keys(btc)).toEqual([
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'count',
      'base_volume',
      'counter_volume',
      'open',
      'high',
      'low',
      'last',
      'change',
      'open_time',
      'last_time',
      'sparkline',
    ]);
    // the native currency has no issuer: the key is left out
    expect(Object.keys(usd)).toEqual([
      'base_currency',
      'base_issuer',
      'counter_currency',
      'count',
      'base_volume',
      'counter_volume',
      'native_volume',
      'open',
      'high',
      'low',
      'last',
      'change',
      'open_time',
      'last_time',
      'sparkline',
    ]);
  });

  it('serves the market of the example of the spec', () => {
    const usd = answer.markets.find((m) => m.base_currency === 'USD');
    expect(usd).toEqual({
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
      count: 18420,
      base_volume: '41200000',
      counter_volume: '16888000',
      native_volume: '16888000',
      open: '0.41990000',
      high: '0.42500000',
      low: '0.40100000',
      last: '0.40990000',
      change: '-2.38',
      open_time: '2026-10-18T11:00:03Z',
      last_time: '2026-10-19T11:42:30Z',
      sparkline: sparklineOf(USD_XRP.closes, SET.end_time as number),
    });
  });

  it('serves the prices with eight significant digits, the volumes as they are stored', () => {
    const [m] = answerOf([
      market('USD+' + ISSUER, 'XRP', 5, '12.5', {
        open: '0.4',
        high: '1234.567891234',
        low: '0.000000123456789',
        last: '25',
        base_volume: '1e+40',
        counter_volume: '0.000000000000000000000000000001',
      }),
    ]).markets;
    expect([m.open, m.high, m.low, m.last]).toEqual(['0.40000000', '1234.5679', '1.2345679e-7', '25.000000']);
    expect([m.base_volume, m.counter_volume, m.native_volume]).toEqual([
      '1e+40',
      '0.000000000000000000000000000001',
      '12.5',
    ]);
  });

  it('serves the counts as numbers, also where the database gave text', () => {
    const [m] = answerOf([market('USD+' + ISSUER, 'XRP', 7, '1', { count: '7' })]).markets;
    expect(m.count).toBe(7);
    const text = marketsAnswer({
      period: '7day',
      set: {
        ...SET,
        start_time: String(SET.start_time),
        end_time: String(SET.end_time),
        pairs_traded: '3',
        total_count: '99',
        markets: [market('USD+' + ISSUER, 'XRP', 7, '1', { open_time: '1', last_time: '2' })],
      },
      minTrades: 1,
      limit: 5,
    });
    expect(text.period).toBe('7day');
    expect([text.start_time, text.end_time]).toEqual(['2026-10-18T11:00:00Z', '2026-10-19T11:42:31Z']);
    expect(text.totals).toMatchObject({ pairs_traded: 3, count: 99 });
    expect(text.markets[0]).toMatchObject({ open_time: '1970-01-01T00:00:01Z', last_time: '1970-01-01T00:00:02Z' });
  });

  it('has no amm, amm_share or amm_pool key, whatever the stored rows carry', () => {
    const stored = {
      ...USD_XRP,
      amm_share: '0.25',
      amm_pool: 1,
      amm: 'include',
    } as StoredMarket;
    const full = marketsAnswer({
      period: 'day',
      set: { ...SET, markets: [stored], total_amm_share: '0.1', amm: 'include' } as StoredMarketsSet,
      minTrades: 1,
      limit: 10,
      display: { asset: { currency: 'USD', issuer: OTHER }, rate: new BigNumber('1.5') },
    });
    const text = JSON.stringify(full);
    expect(text).not.toMatch(/amm/);
    expect(Object.keys(full)).not.toContain('amm');
    expect(Object.keys(full.totals)).not.toContain('amm_share');
    expect(Object.keys(full.markets[0])).not.toContain('amm_share');
    expect(Object.keys(full.markets[0])).not.toContain('amm_pool');
  });

  it('does not change its input', () => {
    const frozen = deepFreeze({ ...SET, markets: [{ ...BTC_EUR }, { ...USD_XRP }] });
    expect(() => marketsAnswer({ period: 'day', set: frozen, minTrades: 1, limit: 10 })).not.toThrow();
  });

  it('serves change next to a price that never moved, and no change for an open that is 0', () => {
    const [flat, zero] = answerOf([
      market('AAA+' + ISSUER, 'XRP', 3, '1', { open: '0.5', last: '0.5' }),
      market('BBB+' + ISSUER, 'XRP', 3, '1', { open: '0', last: '0.5' }),
    ]).markets;
    expect(flat.change).toBe('0.00');
    expect(Object.keys(zero)).not.toContain('change');
  });
});

describe('the pairs that are listed', () => {
  const markets = [
    market('AAA+' + ISSUER, 'XRP', 1, '5'),
    market('BBB+' + ISSUER, 'XRP', 9, '5'),
    market('CCC+' + ISSUER, 'XRP', 10, '5'),
    market('DDD+' + ISSUER, 'XRP', 11, null),
    market('EEE+' + ISSUER, 'XRP', 1_000_000, '5'),
  ];

  it('are those with count >= min_trades; totals.pairs counts them whatever the limit', () => {
    const ten = answerOf(markets, { minTrades: 10, limit: 2 });
    expect(pairsOf(ten.markets)).toEqual(['CCC/XRP', 'EEE/XRP']);
    expect([ten.totals.pairs, ten.count]).toEqual([3, 2]);
    expect(answerOf(markets, { minTrades: 11 }).totals.pairs).toBe(2);
    expect(answerOf(markets, { minTrades: 12 }).totals.pairs).toBe(1);
    expect(answerOf(markets, { minTrades: 1 }).totals.pairs).toBe(5);
    expect(answerOf(markets, { minTrades: 1_000_001 }).totals.pairs).toBe(0);
    expect(answerOf(markets, { minTrades: 1_000_001 }).markets).toEqual([]);
  });

  it('leave the totals of the set as they are: pairs_traded, count and native_volume are over every traded pair', () => {
    for (const minTrades of [1, 10, 100]) {
      expect(answerOf(markets, { minTrades }).totals).toMatchObject({
        pairs_traded: 1840,
        count: 61234,
        native_volume: '123456789.12',
      });
    }
  });

  it('are the first `limit` of them, and count is the number served', () => {
    const answer = answerOf(markets, { limit: 3 });
    expect([answer.count, answer.markets.length, answer.totals.pairs]).toEqual([3, 3, 5]);
    expect(answerOf(markets, { limit: 1 }).count).toBe(1);
    expect(answerOf(markets, { limit: 5000 }).count).toBe(5);
  });
});

describe('the order of the markets', () => {
  it('is native_volume descending, compared as exact numbers, not as text', () => {
    const answer = answerOf([
      market('AAA+' + ISSUER, 'XRP', 20, '9'),
      market('BBB+' + ISSUER, 'XRP', 20, '10'),
      market('CCC+' + ISSUER, 'XRP', 20, '9007199254740993'),
      market('DDD+' + ISSUER, 'XRP', 20, '9007199254740992'),
      market('EEE+' + ISSUER, 'XRP', 20, '1.5e+25'),
      market('FFF+' + ISSUER, 'XRP', 20, '0.000001'),
    ]);
    expect(pairsOf(answer.markets)).toEqual(['EEE/XRP', 'CCC/XRP', 'DDD/XRP', 'BBB/XRP', 'AAA/XRP', 'FFF/XRP']);
  });

  it('breaks a tie of native_volume by the pair: base currency, base issuer, counter currency, counter issuer', () => {
    const answer = answerOf([
      market('ZZZ+' + OTHER, 'EUR+' + ISSUER, 5, '7'),
      market('ZZZ+' + ISSUER, 'XRP', 5, '7.0'),
      market('ZZZ+' + ISSUER, 'EUR+' + OTHER, 5, '7'),
      market('ZZZ+' + ISSUER, 'EUR+' + ISSUER, 5, '7'),
      market('AAA+' + OTHER, 'XRP', 5, '7'),
    ]);
    // OTHER (rMwj...) sorts before ISSUER (rhub...): capitals come first
    expect(answer.markets.map((m) => [m.base_currency, m.base_issuer, m.counter_currency, m.counter_issuer])).toEqual([
      ['AAA', OTHER, 'XRP', undefined],
      ['ZZZ', OTHER, 'EUR', ISSUER],
      ['ZZZ', ISSUER, 'EUR', OTHER],
      ['ZZZ', ISSUER, 'EUR', ISSUER],
      ['ZZZ', ISSUER, 'XRP', undefined],
    ]);
  });

  it('puts the pairs without a native volume last, by count descending, then the pair', () => {
    const answer = answerOf([
      market('NOV+' + ISSUER, 'XRP', 500, null),
      market('AAA+' + ISSUER, 'XRP', 30, '0'),
      market('BBB+' + ISSUER, 'EUR+' + ISSUER, 12, null),
      market('BBB+' + ISSUER, 'AAA+' + ISSUER, 12, null),
      market('CCC+' + ISSUER, 'XRP', 40, '1000'),
      market('DDD+' + ISSUER, 'XRP', 20, null),
    ]);
    expect(pairsOf(answer.markets)).toEqual(['CCC/XRP', 'AAA/XRP', 'NOV/XRP', 'DDD/XRP', 'BBB/AAA', 'BBB/EUR']);
    // a native volume of 0 is a volume: it sorts with the others, above the pairs that have none
    expect(answer.markets[1].native_volume).toBe('0');
  });

  it('does not depend on the order the rows come in', () => {
    const rows = [
      market('AAA+' + ISSUER, 'XRP', 20, '9'),
      market('BBB+' + ISSUER, 'XRP', 30, '9'),
      market('CCC+' + ISSUER, 'XRP', 10, null),
      market('DDD+' + ISSUER, 'XRP', 10, null),
      market('EEE+' + ISSUER, 'XRP', 1, '100'),
    ];
    const forward = pairsOf(answerOf(rows).markets);
    expect(forward).toEqual(['EEE/XRP', 'AAA/XRP', 'BBB/XRP', 'CCC/XRP', 'DDD/XRP']);
    expect(pairsOf(answerOf([...rows].reverse()).markets)).toEqual(forward);
  });

  it('is applied before the limit', () => {
    const answer = answerOf(
      [
        market('AAA+' + ISSUER, 'XRP', 20, '1'),
        market('BBB+' + ISSUER, 'XRP', 20, '3'),
        market('CCC+' + ISSUER, 'XRP', 20, '2'),
      ],
      { limit: 2 },
    );
    expect(pairsOf(answer.markets)).toEqual(['BBB/XRP', 'CCC/XRP']);
  });
});

describe('a display currency', () => {
  const display = { asset: { currency: 'EUR', issuer: OTHER }, rate: new BigNumber('0.3333333333333333333') };
  const shown = marketsAnswer({ period: 'day', set: SET, minTrades: 1, limit: 10, display });

  it('adds exchange and exchange_rate after end_time, and converted_volume to the totals', () => {
    expect(Object.keys(shown)).toEqual([
      'result',
      'period',
      'start_time',
      'end_time',
      'exchange',
      'exchange_rate',
      'totals',
      'count',
      'markets',
    ]);
    expect(Object.keys(shown.totals)).toEqual(['pairs', 'pairs_traded', 'count', 'native_volume', 'converted_volume']);
  });

  it('shows the currency with its issuer and the rate with eight significant digits', () => {
    expect(shown.exchange).toEqual({ currency: 'EUR', issuer: OTHER });
    expect(Object.keys(shown.exchange as object)).toEqual(['currency', 'issuer']);
    expect(shown.exchange_rate).toBe('0.33333333');
  });

  it('adds converted_volume after native_volume, for the markets that have a native volume only', () => {
    const [usd, btc] = shown.markets;
    // 16888000 * 0.3333333333333333333 = 5629333.3333333333327704, to 17 digits
    expect(usd.converted_volume).toBe('5629333.3333333333');
    expect(Object.keys(usd).slice(5, 9)).toEqual(['counter_volume', 'native_volume', 'converted_volume', 'open']);
    expect(Object.keys(btc)).not.toContain('converted_volume');
    expect(Object.keys(btc)).not.toContain('native_volume');
  });

  it('converts the total native volume, to 17 digits, with the rate unrounded', () => {
    // 123456789.12 * 0.3333333333333333333 = 41152263.039999999995884773696: the 17 digits end in 9s that round up
    expect(shown.totals.converted_volume).toBe('41152263.04');
  });

  it('is zeros for a rate of 0, with the rate shown as 0.0000000', () => {
    const zero = marketsAnswer({
      period: 'day',
      set: SET,
      minTrades: 1,
      limit: 10,
      display: { asset: display.asset, rate: new BigNumber(0) },
    });
    expect(zero.exchange_rate).toBe('0.0000000');
    expect(zero.totals.converted_volume).toBe('0');
    expect(zero.markets.map((m) => m.converted_volume)).toEqual(['0', undefined]);
  });

  it('shows no exchange key without one', () => {
    const plain = marketsAnswer({ period: 'day', set: SET, minTrades: 1, limit: 10 });
    expect(Object.keys(plain)).not.toContain('exchange');
    expect(Object.keys(plain)).not.toContain('exchange_rate');
    expect(Object.keys(plain.totals)).not.toContain('converted_volume');
  });
});

describe('no set yet', () => {
  it('is result, period, count and markets', () => {
    expect(noMarketsAnswer('7day')).toEqual({ result: 'success', period: '7day', count: 0, markets: [] });
    expect(Object.keys(noMarketsAnswer('day'))).toEqual(['result', 'period', 'count', 'markets']);
  });
});

import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { deepFreeze } from '../test-utils/deep-freeze';
import { Asset } from './asset';
import {
  combineRates,
  dailyWindow,
  latestWindow,
  periodWindow,
  RATE_PERIODS,
  RatePeriod,
  RatesService,
} from './rates.service';

const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const USD: Asset = { currency: 'USD', issuer: ISSUER };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER };
const XRP: Asset = { currency: 'XRP' };
const secs = (iso: string): number => Date.parse(iso) / 1000;
const ms = (iso: string): number => Date.parse(iso);

describe('the windows of a rate', () => {
  it('period: ends at the second of the date, begins a second and a period before it', () => {
    const date = new Date('2016-06-15T12:00:00.750Z');
    const expected: Record<RatePeriod, string> = {
      hour: '2016-06-15T10:59:59.000Z',
      day: '2016-06-14T11:59:59.000Z',
      '3day': '2016-06-12T11:59:59.000Z',
      '7day': '2016-06-08T11:59:59.000Z',
      '30day': '2016-05-16T11:59:59.000Z',
    };
    for (const period of RATE_PERIODS) {
      expect(periodWindow(date, period)).toEqual({
        from: ms(expected[period]),
        toExclusive: ms('2016-06-15T12:00:00Z'),
      });
    }
  });

  it('daily: from the start of the UTC day to the second after the date', () => {
    expect(dailyWindow(new Date('2015-01-14T18:28:40.250Z'))).toEqual({
      from: ms('2015-01-14T00:00:00Z'),
      toExclusive: ms('2015-01-14T18:28:41Z'),
    });
    // the very first second of the day
    expect(dailyWindow(new Date('2015-01-14T00:00:00Z'))).toEqual({
      from: ms('2015-01-14T00:00:00Z'),
      toExclusive: ms('2015-01-14T00:00:01Z'),
    });
  });

  it('daily: up to the end of the period the client wrote, but never past the day', () => {
    const date = new Date('2015-01-14T00:00:00Z');
    expect(dailyWindow(date, new Date('2015-01-15T00:00:00Z'))).toEqual({
      from: ms('2015-01-14T00:00:00Z'),
      toExclusive: ms('2015-01-15T00:00:00Z'),
    });
    expect(dailyWindow(date, new Date('2015-01-14T19:00:00Z')).toExclusive).toBe(ms('2015-01-14T19:00:00Z'));
    // a month or a year: only its first day (the original's `limit: 1` read the first day WITH trades of it, which is
    // another day when the first has none: a known deviation)
    expect(dailyWindow(date, new Date('2015-02-01T00:00:00Z')).toExclusive).toBe(ms('2015-01-15T00:00:00Z'));
  });

  it('latest: 14 days before the date, to the second after it or the end of the period', () => {
    const date = new Date('2015-01-14T18:28:40.900Z');
    expect(latestWindow(date)).toEqual({ from: ms('2014-12-31T18:28:40Z'), toExclusive: ms('2015-01-14T18:28:41Z') });
    expect(latestWindow(new Date('2015-01-14T00:00:00Z'), new Date('2015-01-15T00:00:00Z'))).toEqual({
      from: ms('2014-12-31T00:00:00Z'),
      toExclusive: ms('2015-01-15T00:00:00Z'),
    });
  });

  it('refuses a date that is not one', () => {
    expect(() => periodWindow(new Date(NaN), 'day')).toThrow(RangeError);
    expect(() => dailyWindow(new Date(NaN))).toThrow(RangeError);
    expect(() => latestWindow(new Date(0), new Date(NaN))).toThrow(RangeError);
  });
});

describe('combineRates', () => {
  it.each([
    ['2', '4', '3'],
    ['0', '4', '4'],
    ['2', '0', '0'],
    ['0', '0', '0'],
    ['1e-30', '3e-30', '2e-30'],
    ['1e+90', '3e+90', '2e+90'],
  ])('daily %s, latest %s -> %s', (daily, latest, expected) => {
    expect(combineRates(new BigNumber(daily), new BigNumber(latest)).toString()).toBe(
      new BigNumber(expected).toString(),
    );
  });

  it('the average is exact, not cut to 20 places', () => {
    const daily = new BigNumber('0.1234567890123456789012345678901');
    const latest = new BigNumber('0.1234567890123456789012345678903');
    expect(combineRates(daily, latest).toFixed()).toBe('0.1234567890123456789012345678902');
  });
});

/** A ClickHouse that answers from a script and remembers what it was asked. */
function fakeClickHouse(
  rows: (params: Record<string, unknown>) => Record<string, unknown>[],
  ledgers: (sql: string, params: Record<string, unknown>) => { ledger_index: number } | undefined = (sql) =>
    sql.includes('ORDER BY ledger_index ASC') ? { ledger_index: 100 } : { ledger_index: 200 },
) {
  const query = jest.fn(async (_sql: string, params: Record<string, unknown> = {}) =>
    // the read of the last trades also says how many it took and how many its inner read had (see `latest`)
    params.distinct_page_limit === undefined
      ? rows(params)
      : rows(params).map((row) => ({ taken: row.n, inner_read: row.n, ...row })),
  );
  const queryOne = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => ledgers(sql, params));
  return { ch: { query, queryOne } as unknown as ClickHouseService, query, queryOne };
}

const sums = (n: number, base: string, counter: string) => ({
  n,
  base_sum: base,
  counter_sum: counter,
  unfit: 0,
  base_sum_f: Number(base),
  counter_sum_f: Number(counter),
});

/**
 * The row of the read of the last trades (`distinct_page_limit` is the 50 it takes): the sums, how many it took (all
 * `n`, no noise left out) and how many its inner read had (fewer than its cap: the window ended).
 */
const latest = (n: number, base: string, counter: string) => ({ ...sums(n, base, counter), taken: n, inner_read: n });

describe('RatesService.exchangeRate', () => {
  const date = new Date('2016-06-15T12:00:00Z');

  it('the same asset is 1 without a query, with a period too', async () => {
    const { ch, query, queryOne } = fakeClickHouse(() => []);
    const rates = new RatesService(ch, 'XRP');
    expect((await rates.exchangeRate(USD, { ...USD })).toFixed()).toBe('1');
    expect((await rates.exchangeRate(XRP, { currency: 'XRP', issuer: '' }, { period: 'hour' })).toFixed()).toBe('1');
    expect([query.mock.calls.length, queryOne.mock.calls.length]).toEqual([0, 0]);
  });

  it('a window that holds no ledger is 0 and reads no trade', async () => {
    const { ch, query } = fakeClickHouse(
      () => [],
      () => undefined,
    );
    const rates = new RatesService(ch, 'XRP');
    expect((await rates.exchangeRate(USD, XRP, { date })).toFixed()).toBe('0');
    expect(query).not.toHaveBeenCalled();
  });

  it('a window whose ledgers are out of order (nothing between them) is 0', async () => {
    const { ch, query } = fakeClickHouse(
      () => [sums(1, '1', '1')],
      (sql) => (sql.includes('ORDER BY ledger_index ASC') ? { ledger_index: 200 } : { ledger_index: 100 }),
    );
    expect((await new RatesService(ch, 'XRP').exchangeRate(USD, XRP, { date })).toFixed()).toBe('0');
    expect(query).not.toHaveBeenCalled();
  });

  it('is the average of the daily and the latest vwap; the latest is the query that has a limit', async () => {
    const { ch, query } = fakeClickHouse((params) =>
      params.distinct_page_limit === undefined ? [sums(3, '10', '20')] : [latest(12, '10', '40')],
    );
    const rate = await new RatesService(ch, 'XRP').exchangeRate(USD, XRP, { date });
    // daily 20/10 = 2, latest 40/10 = 4
    expect(rate.toFixed()).toBe('3');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([, params]) => params?.distinct_page_limit).sort()).toEqual([50, undefined]);
  });

  it('the pair asked the other way round swaps the stored volumes: counter over base of that side', async () => {
    const { ch } = fakeClickHouse(() => [sums(12, '10', '40')]);
    const rates = new RatesService(ch, 'XRP');
    // stored USD/XRP: 10 USD for 40 XRP
    expect((await rates.exchangeRate(USD, XRP, { date, live: true })).toFixed()).toBe('4');
    expect((await rates.exchangeRate(XRP, USD, { date, live: true })).toFixed()).toBe('0.25');
  });

  it('reads the pair in its stored order, whichever way it was asked', async () => {
    const { ch, query } = fakeClickHouse(() => [sums(12, '10', '40')]);
    const rates = new RatesService(ch, 'XRP');
    await rates.exchangeRate(XRP, USD, { date, live: true });
    await rates.exchangeRate(USD, XRP, { date, live: true });
    for (const [, params] of query.mock.calls) {
      expect(params).toMatchObject({ pair0: 'USD', pair1: ISSUER, pair2: 'XRP', pair3: '' });
    }
  });

  it('strict: fewer than 10 trades make the latest rate 0, and with it the rate', async () => {
    const nine = fakeClickHouse((params) =>
      params.distinct_page_limit === undefined ? [sums(5, '10', '20')] : [latest(9, '10', '40')],
    );
    const rates = new RatesService(nine.ch, 'XRP');
    expect((await rates.exchangeRate(USD, XRP, { date })).toFixed()).toBe('0');
    expect((await rates.exchangeRate(USD, XRP, { date, strict: false })).toFixed()).toBe('3');
    const ten = fakeClickHouse((params) =>
      params.distinct_page_limit === undefined ? [sums(5, '10', '20')] : [latest(10, '10', '40')],
    );
    expect((await new RatesService(ten.ch, 'XRP').exchangeRate(USD, XRP, { date })).toFixed()).toBe('3');
  });

  it('no daily trade: the latest alone; live: the daily is not even read', async () => {
    const { ch, query } = fakeClickHouse((params) =>
      params.distinct_page_limit === undefined ? [sums(0, '0', '0')] : [latest(12, '10', '40')],
    );
    const rates = new RatesService(ch, 'XRP');
    expect((await rates.exchangeRate(USD, XRP, { date })).toFixed()).toBe('4');
    query.mockClear();
    await rates.exchangeRate(USD, XRP, { date, live: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatchObject({ distinct_page_limit: 50 });
  });

  it('the last trades: a plain LIMIT on the read, the dedupe outside it, read again when duplicates filled it (R106)', async () => {
    const reads: { sql: string; cap: unknown }[] = [];
    const { ch, query } = fakeClickHouse((params) => {
      if (params.distinct_page_limit === undefined) return [sums(0, '0', '0')];
      // the first read stopped at its cap of 100 rows with 30 trades: duplicates took the rest
      return params.distinct_page_cap === 100
        ? [{ ...sums(30, '10', '40'), taken: 30, inner_read: 100 }]
        : [latest(50, '10', '40')];
    });
    expect((await new RatesService(ch, 'XRP').exchangeRate(USD, XRP, { date, live: true })).toFixed()).toBe('4');
    for (const [sql, params] of query.mock.calls) reads.push({ sql: String(sql), cap: params?.distinct_page_cap });
    expect(reads.map((r) => r.cap)).toEqual([100, 250]);
    for (const { sql } of reads) {
      expect(sql).toMatch(/node_index DESC\s+LIMIT \{distinct_page_cap:UInt32\}\)/);
      expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index, node_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
    }
  });

  it('a base volume of 0 is a vwap of 0, never a division by 0', async () => {
    const { ch } = fakeClickHouse(() => [sums(12, '0', '40')]);
    expect((await new RatesService(ch, 'XRP').exchangeRate(USD, XRP, { date, live: true })).toFixed()).toBe('0');
  });

  it('a period is one query and ignores strict and live; the ledgers are those of its window', async () => {
    const { ch, query, queryOne } = fakeClickHouse(() => [sums(1, '10', '25')]);
    const rate = await new RatesService(ch, 'XRP').exchangeRate(USD, XRP, {
      date,
      period: 'hour',
      strict: true,
      live: true,
    });
    expect(rate.toFixed()).toBe('2.5');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]?.distinct_page_limit).toBeUndefined();
    // [11:00:00 - 1s - 1h... = 10:59:59, 12:00:00)
    const bounds = queryOne.mock.calls.map(([sql, params]) => [String(sql).includes('>='), params?.secs]);
    expect(bounds.sort()).toEqual([
      [false, secs('2016-06-15T12:00:00Z')],
      [true, secs('2016-06-15T10:59:59Z')],
    ]);
  });

  it('a year before the epoch and a year past 2106 do not break the binding', async () => {
    const { ch, queryOne } = fakeClickHouse(() => [sums(1, '1', '1')]);
    const rates = new RatesService(ch, 'XRP');
    await rates.exchangeRate(USD, XRP, { date: new Date('1960-01-01T00:00:00Z'), period: 'day' });
    // nothing closed before 1970: no ledger lookup is even needed for the end
    expect(queryOne.mock.calls.every(([, params]) => (params?.secs as number) >= 0)).toBe(true);
    queryOne.mockClear();
    expect(
      (await rates.exchangeRate(USD, XRP, { date: new Date('2300-01-01T00:00:00Z'), period: 'day' })).toFixed(),
    ).toBe('0');
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('does not change what it is given', async () => {
    const { ch } = fakeClickHouse(() => [sums(12, '10', '40')]);
    const asset = deepFreeze({ currency: 'USD', issuer: ISSUER });
    const other = deepFreeze({ currency: 'XRP' });
    const options = deepFreeze({ date: new Date('2016-06-15T12:00:00Z'), strict: false, live: false });
    await expect(new RatesService(ch, 'XRP').exchangeRate(asset, other, options)).resolves.toBeInstanceOf(BigNumber);
  });
});

describe('RatesService.vwap', () => {
  it('reads [from, toExclusive) to the second and reports the pair as asked for', async () => {
    const { ch, queryOne } = fakeClickHouse(() => [sums(2, '10', '25')]);
    const rates = new RatesService(ch, 'XRP');
    const w = await rates.vwap(EUR, USD, new Date('2016-06-15T10:00:00.900Z'), new Date('2016-06-15T11:00:00.100Z'));
    // EUR sorts before USD: stored as asked
    expect([w.count, w.baseVolume.toFixed(), w.counterVolume.toFixed(), w.vwap.toFixed()]).toEqual([
      2,
      '10',
      '25',
      '2.5',
    ]);
    const inverted = await rates.vwap(USD, EUR, new Date(0), new Date(1000));
    expect([inverted.baseVolume.toFixed(), inverted.counterVolume.toFixed(), inverted.vwap.toFixed()]).toEqual([
      '25',
      '10',
      '0.4',
    ]);
    const first = queryOne.mock.calls[0];
    expect([String(first[0]).includes('>='), first[1]?.secs]).toEqual([true, secs('2016-06-15T10:00:00Z')]);
  });

  it('a base volume of 0 is a vwap of 0; no trade is all zeros', async () => {
    const zero = await new RatesService(fakeClickHouse(() => [sums(1, '0', '5')]).ch, 'XRP').vwap(
      USD,
      XRP,
      new Date(0),
      new Date(1000),
    );
    expect([zero.vwap.toFixed(), zero.baseVolume.toFixed(), zero.counterVolume.toFixed(), zero.count]).toEqual([
      '0',
      '0',
      '5',
      1,
    ]);
    const none = await new RatesService(
      fakeClickHouse(() => [{ ...sums(0, '0', '0'), base_sum: null, counter_sum: null }]).ch,
      'XRP',
    ).vwap(USD, XRP, new Date(0), new Date(1000));
    expect([none.vwap.toFixed(), none.baseVolume.toFixed(), none.counterVolume.toFixed(), none.count]).toEqual([
      '0',
      '0',
      '0',
      0,
    ]);
  });

  it('refuses a date that is not one', async () => {
    const rates = new RatesService(fakeClickHouse(() => []).ch, 'XRP');
    await expect(rates.vwap(USD, XRP, new Date(NaN), new Date(0))).rejects.toThrow(RangeError);
    await expect(rates.vwap(USD, XRP, new Date(0), new Date(NaN))).rejects.toThrow(RangeError);
  });
});

describe('RatesService.normalize', () => {
  const date = new Date('2016-06-15T12:00:00Z');

  /** USD buys 2 XRP, EUR buys 4 XRP (live, so one query each). */
  function twoRates() {
    return fakeClickHouse((params) => {
      const currency = params.pair0 === 'EUR' ? 4 : 2;
      return [sums(12, '1', String(currency))];
    });
  }

  it('is rate(from -> native) / rate(to -> native); converted = amount * rate', async () => {
    const rates = new RatesService(twoRates().ch, 'XRP');
    const n = await rates.normalize(new BigNumber(10), USD, EUR, { date });
    expect([n.rate.toFixed(), n.converted.toFixed()]).toEqual(['0.5', '5']);
  });

  it('the native currency is 1 on either side and needs no query', async () => {
    const { ch, query } = twoRates();
    const rates = new RatesService(ch, 'XRP');
    const to = await rates.normalize(new BigNumber(10), USD, XRP, { date });
    expect([to.rate.toFixed(), to.converted.toFixed()]).toEqual(['2', '20']);
    const from = await rates.normalize(new BigNumber(10), XRP, EUR, { date });
    expect([from.rate.toFixed(), from.converted.toFixed()]).toEqual(['0.25', '2.5']);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('the same asset is 1 and the amount, without a query', async () => {
    const { ch, query, queryOne } = twoRates();
    const n = await new RatesService(ch, 'XRP').normalize(new BigNumber('7.25'), USD, { ...USD }, { date });
    expect([n.rate.toFixed(), n.converted.toFixed(), query.mock.calls.length, queryOne.mock.calls.length]).toEqual([
      '1',
      '7.25',
      0,
      0,
    ]);
  });

  it('no rate for the target is 0, not a division by 0', async () => {
    const { ch } = fakeClickHouse((params) => (params.pair0 === 'EUR' ? [sums(0, '0', '0')] : [sums(12, '1', '2')]));
    const n = await new RatesService(ch, 'XRP').normalize(new BigNumber(10), USD, EUR, { date });
    expect([n.rate.toFixed(), n.converted.toFixed()]).toEqual(['0', '0']);
  });

  it('XAH is native for a service of XAH: no query for it, and XRP is an asset like any other', async () => {
    const { ch, query } = twoRates();
    const rates = new RatesService(ch, 'XAH');
    const r = await rates.normalize(new BigNumber(1), USD, { currency: 'XAH' }, { date });
    expect(r.rate.toFixed()).toBe('2');
    expect(query).toHaveBeenCalledTimes(2);
    query.mockClear();
    await rates.normalize(new BigNumber(1), XRP, { currency: 'XAH' }, { date });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('RatesService.dailyNativeRates', () => {
  it('has an entry for every asset and day; the native currency is 1', async () => {
    const { ch } = fakeClickHouse(
      () => [],
      () => undefined,
    );
    const rates = new RatesService(ch, 'XRP');
    const out = await rates.dailyNativeRates(
      [XRP, USD, USD],
      new Date('2016-06-01T05:00:00Z'),
      new Date('2016-06-04T00:00:00Z'),
    );
    const days = ['2016-06-01', '2016-06-02', '2016-06-03'];
    expect([...out.keys()]).toEqual(['XRP', `USD.${ISSUER}`]);
    expect([...(out.get('XRP') as Map<string, BigNumber>)].map(([d, r]) => [d, r.toFixed()])).toEqual(
      days.map((d) => [d, '1']),
    );
    expect([...(out.get(`USD.${ISSUER}`) as Map<string, BigNumber>)].map(([d, r]) => [d, r.toFixed()])).toEqual(
      days.map((d) => [d, '0']),
    );
  });

  it('refuses more than ten years of days and dates that are not dates', async () => {
    const rates = new RatesService(fakeClickHouse(() => []).ch, 'XRP');
    await expect(rates.dailyNativeRates([USD], new Date(0), new Date('2100-01-01T00:00:00Z'))).rejects.toThrow(
      RangeError,
    );
    await expect(rates.dailyNativeRates([USD], new Date(NaN), new Date(0))).rejects.toThrow(RangeError);
    await expect(rates.dailyNativeRates([USD], new Date(0), new Date(NaN))).rejects.toThrow(RangeError);
  });

  it('a day the pair has a trade on, with the daily and latest rates read from the rows', async () => {
    const { ch, query } = fakeClickHouse((params) =>
      // the grouped read has `first_ledger`, the last-50 read has `distinct_page_limit`
      params.distinct_page_limit === undefined
        ? [{ ...sums(3, '10', '20'), day: '2016-06-02', first_ledger: 150, last_ledger: 160 }]
        : [latest(12, '10', '40')],
    );
    const out = await new RatesService(ch, 'XRP').dailyNativeRates(
      [USD],
      new Date('2016-06-01T00:00:00Z'),
      new Date('2016-06-04T00:00:00Z'),
    );
    const rates = [...(out.get(`USD.${ISSUER}`) as Map<string, BigNumber>)].map(([d, r]) => [d, r.toFixed()]);
    // XRP -> USD is stored as USD/XRP, inverted: the day's 10 USD for 20 XRP is 0.5 USD per XRP, the last 50 are 0.25
    // 2016-06-01: nothing yet; 06-02: (0.5 + 0.25) / 2; 06-03: the day has no trade, the latest alone
    expect(rates).toEqual([
      ['2016-06-01', '0'],
      ['2016-06-02', '0.375'],
      ['2016-06-03', '0.25'],
    ]);
    // one grouped read and one read of the last 50: the days 06-02 and 06-03 share their window of trades
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('RatesService.dailyNativeRatesOfDay', () => {
  const day = new Date('2016-06-02T00:00:00Z');
  const pair = (currency: string) => ({
    base_currency: currency,
    base_issuer: ISSUER,
    counter_currency: 'XRP',
    counter_issuer: '',
  });

  it('the rate of an asset is the average of its daily and its latest rate, read for the pairs that traded', async () => {
    const { ch, query } = fakeClickHouse((params) =>
      // the read of the pairs has no `latest`; the read of their trades has it
      params.latest === undefined
        ? [pair('USD')]
        : [
            { ...pair('USD'), part: 'daily', ...sums(3, '10', '20') },
            { ...pair('USD'), part: 'latest', ...sums(12, '10', '40') },
          ],
    );
    const out = await new RatesService(ch, 'XRP').dailyNativeRatesOfDay(day);
    // XRP -> USD is stored as USD/XRP, inverted: the day's 10 USD for 20 XRP is 0.5 USD per XRP, the last 50 are 0.25
    expect([...out.keys()]).toEqual([`USD.${ISSUER}`]);
    expect(out.get(`USD.${ISSUER}`)).toMatchObject({ dailyCount: 3, latestCount: 12 });
    expect(out.get(`USD.${ISSUER}`)?.rate.toFixed()).toBe('0.375');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('selects the pairs of its second read with a subquery of the exchanges: no pair is bound as a parameter, whatever their number', async () => {
    // 12,000 native pairs: as four arrays in the URL they were over the 1 MiB it is limited to
    const traded = Array.from({ length: 12_000 }, (_, i) => pair(`C${String(i).padStart(5, '0')}`));
    const { ch, query } = fakeClickHouse((params) => (params.latest === undefined ? traded : []));
    const out = await new RatesService(ch, 'XRP').dailyNativeRatesOfDay(day);
    expect(out.size).toBe(0);

    const [[read1, params1], [read2, rawParams2]] = query.mock.calls;
    const params2 = rawParams2 ?? {};
    expect(params1).toEqual({ native: 'XRP', min: 100, max: 200 });
    // the second read binds only what it needs, and the pairs come from the table, in the same range and with the same filter
    expect(Object.keys(params2).sort()).toEqual(['day_min', 'latest', 'max', 'min', 'native']);
    expect(Object.values(params2).some(Array.isArray)).toBe(false);
    expect(JSON.stringify(params2).length).toBeLessThan(200);
    expect(read2).not.toMatch(/arrayZip|\{pair\d:/);
    expect(read2).toMatch(
      /\(base_currency, base_issuer, counter_currency, counter_issuer\) IN \(\s*SELECT base_currency, base_issuer, counter_currency, counter_issuer\s+FROM exchanges\s+WHERE ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\} AND \(\(base_issuer = '' AND base_currency = \{native:String\}\)/,
    );
    expect(read1).toMatch(/GROUP BY base_currency, base_issuer, counter_currency, counter_issuer/);
  });

  it('asks nothing more when no native pair traded, and for a day without ledgers', async () => {
    const none = fakeClickHouse(() => []);
    expect((await new RatesService(none.ch, 'XRP').dailyNativeRatesOfDay(day)).size).toBe(0);
    expect(none.query).toHaveBeenCalledTimes(1);

    const noLedgers = fakeClickHouse(
      () => [pair('USD')],
      () => undefined,
    );
    expect((await new RatesService(noLedgers.ch, 'XRP').dailyNativeRatesOfDay(day)).size).toBe(0);
    expect(noLedgers.query).not.toHaveBeenCalled();
  });
});

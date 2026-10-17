import { Asset, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { FixtureExchange, fixtureExchanges } from './support/fixtures';

/**
 * `GET /v2/exchange_rates/:base/:counter` and `GET /v2/normalize` on a real ClickHouse, seeded with the 54 ledgers of the
 * original Ripple test suite (`ripple-mock`: 158 exchanges in 32 pairs, all but 4 of them on 2015-01-14 between 18:27
 * and 19:10).
 *
 * Ported from rippled-historical-database `test/test.exchangerates.js`, all 14 `it`s with their titles: 7 for the
 * exchange rate and 7 for the normalization. None is skipped: the expected values come from the mock ledgers (the
 * pair has two trades, so there is no rate in strict mode: `0.0000000`) or are validation errors.
 *
 * Added:
 *  - the rates of every pair of the mock ledgers, both ways round, against a float oracle written from
 *    `hbase.getExchangeRate`/`reduce` (the original summed floats): a pair of 10 trades or more has the vwap of its
 *    trades, a pair of fewer has none in strict mode and the same vwap with `strict=false`;
 *  - the order of the checks, the forms of the parameters, the formats of the date (a date names a period and the rates
 *    are read up to its end), `period`, `live`;
 *  - the two bug fixes: a date that is not a date answers 400 (the original failed with a 500), and a failure of
 *    `/v2/normalize` answers 500 (the original answered 200 with an error body);
 *  - `/v2/normalize` through the native currency on real pairs, amounts as JavaScript reads them, XAH on Xahau.
 */

const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const MWJ = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const KIC = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
const MAZ = 'rMAz5ZnK73nyNUL4foAvaxdreczCkG3vA6';
const USD_BITSTAMP = `USD+${BITSTAMP}`;

const RATE_PATH = (base: string, counter: string): string => `/v2/exchange_rates/${base}/${counter}`;

interface RateBody {
  result: string;
  rate: string;
}
interface NormalizeBody {
  result: string;
  amount: string;
  converted: string;
  rate: string;
}

/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

const pathOf = (a: Asset): string => (a.issuer ? `${a.currency}+${a.issuer}` : a.currency);
const assetOf = (currency: string, issuer: string): Asset => ({ currency, ...(issuer && { issuer }) });

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: the float arithmetic of the original (`reduce` of `hbase.getExchanges`, then `counter / base`)
// ---------------------------------------------------------------------------------------------------------------------

interface Pair {
  base: Asset;
  counter: Asset;
  rows: ExchangesRow[];
}

function pairsOf(exchanges: FixtureExchange[]): Pair[] {
  const pairs: Pair[] = [];
  for (const { row } of exchanges) {
    const base = assetOf(row.base_currency, row.base_issuer);
    const counter = assetOf(row.counter_currency, row.counter_issuer);
    let pair = pairs.find((p) => pathOf(p.base) === pathOf(base) && pathOf(p.counter) === pathOf(counter));
    if (!pair) pairs.push((pair = { base, counter, rows: [] }));
    pair.rows.push(row);
  }
  return pairs;
}

/**
 * The vwap of the trades of a pair that closed before `before` (unix seconds), as the original reduced them: the native
 * leg of 0.0005 or less is out, and the volumes are floats. `inverted` is the pair asked the other way round. 0 when
 * there is no volume. The trades are those of a single day and at most 50, so the daily rate and the last 50 are the
 * same trades and the rate is their vwap.
 */
function floatVwap(pair: Pair, inverted: boolean, before: number): { vwap: number; count: number } {
  const kept = pair.rows.filter(
    (r) =>
      r.close_time < before &&
      !(!pair.base.issuer && r.base_amount_f <= 0.0005) &&
      !(!pair.counter.issuer && r.counter_amount_f <= 0.0005),
  );
  const base = kept.reduce((total, r) => total + (inverted ? r.counter_amount_f : r.base_amount_f), 0);
  const counter = kept.reduce((total, r) => total + (inverted ? r.base_amount_f : r.counter_amount_f), 0);
  return { vwap: base ? counter / base : 0, count: kept.length };
}

const EPOCH_2015_01_15 = Date.parse('2015-01-15T00:00:00Z') / 1000;

/** The 32 pairs of the mock ledgers, with their exchanges as the syncer stores them. */
const pairs = pairsOf(fixtureExchanges('ripple-mock'));

/**
 * Asks the rate of every pair of the mock ledgers, both ways round, on 2015-01-14, in strict mode and with
 * `strict=false`, and compares it with the float oracle: the vwap of its trades with 10 or more, none with fewer (strict),
 * the vwap with `strict=false`. Returns how many of the rates were above 0, so that a caller can tell it was not a
 * comparison of zeros.
 */
async function expectEveryPairRate(api: ApiClient): Promise<{ strictRates: number; laxRates: number }> {
  const eight = (v: number): string => new BigNumber(v).toPrecision(8);
  const rate = async (b: Asset, c: Asset, params: Record<string, string | number | boolean>): Promise<string> =>
    (await api.ok<RateBody>(`${RATE_PATH(pathOf(b), pathOf(c))}${qs(params)}`, 'rate')).body.rate;
  let strictRates = 0;
  let laxRates = 0;
  for (const pair of pairs) {
    for (const inverted of [false, true]) {
      const [b, c] = inverted ? [pair.counter, pair.base] : [pair.base, pair.counter];
      const want = floatVwap(pair, inverted, EPOCH_2015_01_15);
      const path = RATE_PATH(pathOf(b), pathOf(c));
      const strict = await rate(b, c, { date: '2015-01-14' });
      const lax = await rate(b, c, { date: '2015-01-14', strict: false });
      expect([path, inverted, 'strict', strict]).toEqual([
        path,
        inverted,
        'strict',
        eight(want.count >= 10 ? want.vwap : 0),
      ]);
      expect([path, inverted, 'lax', lax]).toEqual([path, inverted, 'lax', eight(want.vwap)]);
      if (want.count >= 10 && want.vwap > 0) strictRates++;
      if (want.vwap > 0) laxRates++;
    }
  }
  return { strictRates, laxRates };
}

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange rates and normalize API endpoints', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const rateOf = async (
    base: string,
    counter: string,
    params: Record<string, string | number | boolean>,
  ): Promise<string> => (await api.ok<RateBody>(`${RATE_PATH(base, counter)}${qs(params)}`, 'rate')).body.rate;

  const error = async (path: string, status: number, message: string): Promise<void> => {
    const res = await get(path);
    expect([path, res.status, res.body]).toEqual([path, status, { result: 'error', message }]);
  };

  describe('exchanges rates API endpoint (test.exchangerates.js)', () => {
    it('should get exchange rate', async () => {
      const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}?date=2015-01-14`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.rate).toBe('0.0000000');
    });

    it('err on invalid period', async () => {
      const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}?date=2015-01-14&period=13week`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid period: 13week');
    });

    it('err on missing base issuer', async () => {
      const res = await get(`${RATE_PATH('USD', 'XRP')}?date=2015-01-14`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('base issuer is required');
    });

    it('err on missing counter issuer', async () => {
      const res = await get(`${RATE_PATH('XRP', 'USD')}?date=2015-01-14`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('counter issuer is required');
    });

    it('err on XRP with base issuer', async () => {
      const res = await get(`${RATE_PATH('XRP+zzz', 'USD+zzz')}?date=2015-01-14`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('XRP cannot have an issuer');
    });

    it('err on XRP with counter issuer', async () => {
      const res = await get(`${RATE_PATH('USD+zzz', 'XRP+zzz')}?date=2015-01-14`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('XRP cannot have an issuer');
    });

    it('err on future date', async () => {
      const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}?date=9999-01-01`);
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('must not be a future date');
    });
  });

  describe('normalization API endpoint (test.exchangerates.js)', () => {
    const normalize = (params: Record<string, string | number>) => get(`/v2/normalize${qs(params)}`);

    it('normalize to XRP', async () => {
      const res = await normalize({ amount: 10, date: '2015-01-14', currency: 'USD', issuer: BITSTAMP });
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.amount).toBe('10');
      expect(res.body.converted).toBe('0');
      expect(res.body.rate).toBe('0.0000000');
    });

    it('error on future date', async () => {
      const res = await normalize({ amount: 10, date: '9999-01-14', currency: 'USD', issuer: BITSTAMP });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'must not be a future date' }]);
    });

    it('error on invalid amount', async () => {
      const res = await normalize({ amount: 'zzzz', date: '2015-01-14', currency: 'USD', issuer: BITSTAMP });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid amount' }]);
    });

    it('error on missing issuer', async () => {
      const res = await normalize({ amount: '10', date: '2015-01-14', currency: 'USD' });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
    });

    it('error on XRP + issuer', async () => {
      const res = await normalize({ amount: '10', date: '2015-01-14', currency: 'XRP', issuer: 'ZZZ' });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'XRP cannot have an issuer' }]);
    });

    it('error on missing exchange issuer', async () => {
      const res = await normalize({ amount: '10', date: '2015-01-14', exchange_currency: 'USD' });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
    });

    it('error on XRP + exchange issuer', async () => {
      const res = await normalize({
        amount: '10',
        date: '2015-01-14',
        exchange_currency: 'XRP',
        exchange_issuer: 'ZZZ',
      });
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'XRP cannot have an issuer' }]);
    });
  });

  describe('exchange_rates', () => {
    it('the mock ledgers have the pairs the oracle works on', () => {
      expect(pairs).toHaveLength(32);
      expect(pairs.filter((p) => p.rows.length >= 10).length).toBeGreaterThanOrEqual(3);
      expect(pairs.filter((p) => p.rows.length < 10).length).toBeGreaterThanOrEqual(20);
    });

    it('same asset is 1, with a period or a future-less date, and the native currency too', async () => {
      expect(await rateOf(USD_BITSTAMP, USD_BITSTAMP, { date: '2015-01-14' })).toBe('1.0000000');
      expect(await rateOf(USD_BITSTAMP, USD_BITSTAMP, { date: '2015-01-14', period: 'hour' })).toBe('1.0000000');
      expect(await rateOf('XRP', 'xrp', {})).toBe('1.0000000');
      // the same currency under another issuer is another asset
      expect(await rateOf(USD_BITSTAMP, `USD+${MWJ}`, { date: '2015-01-14', strict: false })).toBe('0.0000000');
    });

    it('every pair, both ways round: the vwap of its trades with 10 or more, none with fewer (strict), strict=false has it', async () => {
      const { strictRates, laxRates } = await expectEveryPairRate(api);
      // not a vacuous comparison of zeros
      expect(strictRates).toBeGreaterThanOrEqual(6);
      expect(laxRates).toBeGreaterThanOrEqual(60);
    });

    it('strict with fewer than 10 trades is 0.0000000 and strict=false returns the latest', async () => {
      const usdMwj = pairs.find((p) => pathOf(p.base) === `USD+${MWJ}` && p.counter.currency === 'XRP') as Pair;
      expect(usdMwj.rows).toHaveLength(5);
      const want = new BigNumber(floatVwap(usdMwj, false, EPOCH_2015_01_15).vwap).toPrecision(8);
      expect(want).not.toBe('0.0000000');
      expect(await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14' })).toBe('0.0000000');
      expect(await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14', strict: false })).toBe(want);
      // the other way round is the vwap of the volumes the other way round, not the inverse of the rate
      expect(await rateOf('XRP', `USD+${MWJ}`, { date: '2015-01-14', strict: false })).toBe(
        new BigNumber(floatVwap(usdMwj, true, EPOCH_2015_01_15).vwap).toPrecision(8),
      );
    });

    it('the parameters: strict is false for /false/i, live is true for /true/i, the first of a repeated one wins', async () => {
      const path = RATE_PATH(`USD+${MWJ}`, 'XRP');
      const lax = (await api.ok<RateBody>(`${path}?date=2015-01-14&strict=false`)).body.rate;
      expect(lax).not.toBe('0.0000000');
      for (const strict of ['FALSE', 'False', 'xfalsex']) {
        expect([strict, await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14', strict })]).toEqual([strict, lax]);
      }
      // anything else is strict
      for (const strict of ['0', 'no', '', 'true']) {
        expect([strict, await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14', strict })]).toEqual([
          strict,
          '0.0000000',
        ]);
      }
      // the first of a repeated parameter
      expect((await api.ok<RateBody>(`${path}?date=2015-01-14&strict=false&strict=true`)).body.rate).toBe(lax);
      expect((await api.ok<RateBody>(`${path}?date=2015-01-14&strict=true&strict=false`)).body.rate).toBe('0.0000000');
      // live skips the daily rate; the mock trades are all of one day, so the latest alone is the same vwap
      expect(await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14', strict: false, live: 'TRUE' })).toBe(lax);
      // unknown parameters are ignored
      expect((await api.ok<RateBody>(`${path}?date=2015-01-14&strict=false&foo=bar`)).body.rate).toBe(lax);
    });

    it('the pair separators and the case of the currency: + | . and usd', async () => {
      const want = await rateOf(`USD+${MWJ}`, 'XRP', { date: '2015-01-14', strict: false });
      for (const base of [`USD|${MWJ}`, `USD.${MWJ}`, `usd+${MWJ}`, `Usd.${MWJ}`]) {
        expect([base, await rateOf(encodeURIComponent(base), 'xrp', { date: '2015-01-14', strict: false })]).toEqual([
          base,
          want,
        ]);
      }
    });

    it('checks in the order of the original: the pair, then the period, then the date', async () => {
      const bad = { period: '13week', date: '9999-01-01' };
      // the pair first, base before counter, the native currency with an issuer before a missing issuer
      await error(`${RATE_PATH('USD', 'XRP+zzz')}${qs(bad)}`, 400, 'XRP cannot have an issuer');
      await error(`${RATE_PATH('XRP', 'USD')}${qs(bad)}`, 400, 'counter issuer is required');
      // then the period (lowercased in the message), before the date
      await error(
        `${RATE_PATH('XRP', USD_BITSTAMP)}${qs({ ...bad, period: '13WEEK' })}`,
        400,
        'invalid period: 13week',
      );
      // then the date
      await error(`${RATE_PATH('XRP', USD_BITSTAMP)}${qs({ date: '9999-01-01' })}`, 400, 'must not be a future date');
      await error(`${RATE_PATH('XRP', USD_BITSTAMP)}${qs({ date: 'garbage' })}`, 400, 'invalid date format');
      // the issuers of the pair are addresses (ruling R33): after the checks of the original
      await error(`${RATE_PATH('XRP', 'USD+zzz')}${qs({ date: '2015-01-14' })}`, 400, 'invalid counter issuer address');
      await error(`${RATE_PATH('USD+zzz', 'XRP')}${qs({ date: '2015-01-14' })}`, 400, 'invalid base issuer address');
    });

    it('a currency is required on both sides', async () => {
      await error(`${RATE_PATH('+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 'XRP')}`, 400, 'base currency is required');
      await error(`${RATE_PATH('XRP', '+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B')}`, 400, 'counter currency is required');
    });

    it('a date that is not a date answers 400, not a failure (the original answered 500)', async () => {
      for (const date of [
        'garbage',
        '2015-13-01',
        '2015-02-30',
        '2015-01-14T25:00:00',
        '',
        '20150114',
        'yesterday',
        '12345',
      ]) {
        const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}${qs({ date })}`);
        expect([date, res.status, res.body]).toEqual([date, 400, { result: 'error', message: 'invalid date format' }]);
      }
    });

    it('a future date: more than 10 ms ahead; now and a date a moment ago are fine', async () => {
      const day = 24 * 3600 * 1000;
      for (const date of [
        new Date(Date.now() + day).toISOString().slice(0, 19),
        new Date(Date.now() + day).toISOString().slice(0, 10),
        '2999-12-31',
      ]) {
        await error(`${RATE_PATH('XRP', USD_BITSTAMP)}${qs({ date })}`, 400, 'must not be a future date');
      }
      for (const date of [new Date().toISOString().slice(0, 19), new Date(Date.now() - 1000).toISOString(), '']) {
        const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}${date === '' ? '' : qs({ date })}`);
        expect([date, res.status, res.body.result]).toEqual([date, 200, 'success']);
      }
    });

    it('the formats of a date and the period it names: a day reads to its end, a second to that second', async () => {
      const path = RATE_PATH(`USD+${MWJ}`, 'XRP');
      // USD+rMwj against XRP has 5 trades, at 18:27:20 (2), 18:28:40, 18:51:40 and 18:52:10, and each time moves the vwap
      const pair = pairs.find((p) => pathOf(p.base) === `USD+${MWJ}` && p.counter.currency === 'XRP') as Pair;
      expect(pair.rows.map((r) => new Date(r.close_time * 1000).toISOString().slice(11, 19))).toEqual([
        '18:27:20',
        '18:27:20',
        '18:28:40',
        '18:51:40',
        '18:52:10',
      ]);
      const at = (iso: string): number => Date.parse(iso) / 1000;
      const eight = (v: number): string => new BigNumber(v).toPrecision(8);
      // each case: the date, and where the period it names ends (exclusive); the trades up to there are the rate's.
      // 18:28:40 is a second with trades, so a date there tells reading to the second (they are in) from reading
      // before it (they are out)
      const cases: [string, string][] = [
        ['2015-01-14T18:28:40', '2015-01-14T18:28:41Z'], // seconds: up to and including 18:28:40
        ['2015-01-14T18:28:40Z', '2015-01-14T18:28:41Z'],
        // milliseconds: the period is the millisecond (date + 1 ms) and the original's row keys stop at the second, so a
        // .SSS date excludes the trades of its own second, unless the next millisecond is the next second (.999)
        ['2015-01-14T18:28:40.000Z', '2015-01-14T18:28:40Z'],
        ['2015-01-14T18:28:40.500Z', '2015-01-14T18:28:40Z'],
        ['2015-01-14T18:28:40.999Z', '2015-01-14T18:28:41Z'],
        ['2015-01-14T18:28', '2015-01-14T18:29:00Z'], // a minute: to the end of it
        ['2015-01-14T18', '2015-01-14T19:00:00Z'], // an hour
        ['2015-01-14', '2015-01-15T00:00:00Z'], // a day
        ['2015-01', '2015-02-01T00:00:00Z'], // a month: to the end of it
        ['2015', '2016-01-01T00:00:00Z'], // a year
        ['20150114182840', '2015-01-14T18:28:41Z'], // the compact form
        ['20150114182840000', '2015-01-14T18:28:40Z'], // the compact form with milliseconds
        [String(at('2015-01-14T18:28:40Z')), '2015-01-14T18:28:41Z'], // unix seconds
        ['2015-01-14T20:28:40+02:00', '2015-01-14T18:28:41Z'], // a zone
      ];
      const rates = new Map<string, string>();
      for (const [date, until] of cases) {
        const got = await rateOf(`USD+${MWJ}`, 'XRP', { date, strict: false, live: true });
        // live: only the last 50 trades in the 14 days before the date, to the end of the period it names
        const kept = pair.rows.filter((r) => r.close_time < at(until));
        const base = kept.reduce((t, r) => t + r.base_amount_f, 0);
        const counter = kept.reduce((t, r) => t + r.counter_amount_f, 0);
        const want = eight(base ? counter / base : 0);
        expect([path, date, got]).toEqual([path, date, want]);
        rates.set(date, got);
      }
      // the cases tell the periods apart: 2 trades (before :40), 3 (to :40), 5 (the hour on)
      expect(new Set(rates.values()).size).toBe(3);
      expect(rates.get('2015-01-14T18:28:40')).not.toBe(rates.get('2015-01-14T18:28:40.000Z'));
      expect(rates.get('2015-01-14T18:28:40')).not.toBe(rates.get('2015-01-14T18'));
      expect(rates.get('2015-01-14T18:28:40')).toBe(rates.get('2015-01-14T18:28'));
      expect(rates.get('2015-01-14T18:28:40.000Z')).toBe(rates.get('2015-01-14T18:28:40.500Z'));
      expect(rates.get('2015-01-14T18:28:40.999Z')).toBe(rates.get('2015-01-14T18:28:40'));
      expect(rates.get('2015-01-14T18:28:40')).toBe(rates.get('20150114182840'));
      expect(rates.get('2015-01-14T18:28:40.000Z')).toBe(rates.get('20150114182840000'));
    });

    it('period: a rolling window that ends a second before the date', async () => {
      const pair = pairs.find((p) => pathOf(p.base) === `CNY+${KIC}` && pathOf(p.counter) === `JPY+${MAZ}`) as Pair;
      const at = (iso: string): number => Date.parse(iso) / 1000;
      const eight = (v: number): string => new BigNumber(v).toPrecision(8);
      // [date - 1s - 1h, date): the whole activity of the pair (18:27:20 to 18:29:20) is in the hour before 19:00
      const vwap = (from: number, to: number): string => {
        const kept = pair.rows.filter((r) => r.close_time >= from && r.close_time < to);
        const base = kept.reduce((t, r) => t + r.base_amount_f, 0);
        const counter = kept.reduce((t, r) => t + r.counter_amount_f, 0);
        return eight(base ? counter / base : 0);
      };
      const rate = (params: Record<string, string>) => rateOf(`CNY+${KIC}`, `JPY+${MAZ}`, params);
      expect(await rate({ date: '2015-01-14T19:00:00', period: 'hour' })).toBe(
        vwap(at('2015-01-14T17:59:59Z'), at('2015-01-14T19:00:00Z')),
      );
      expect(await rate({ date: '2015-01-14T19:00:00', period: 'hour' })).not.toBe('0.0000000');
      // the window ends a second before the date: a date of 18:28:00 sees the trades up to 18:27:59
      expect(await rate({ date: '2015-01-14T18:28:00', period: 'hour' })).toBe(
        vwap(at('2015-01-14T17:27:59Z'), at('2015-01-14T18:28:00Z')),
      );
      // the hour before 19:30 starts at 18:29:59: only the trades from then on
      expect(await rate({ date: '2015-01-14T19:30:00', period: 'hour' })).toBe(
        vwap(at('2015-01-14T18:29:59Z'), at('2015-01-14T19:30:00Z')),
      );
      expect(await rate({ date: '2015-01-14T19:30:00', period: 'hour' })).toBe('0.0000000');
      // longer periods hold them all: [date - 1s - period, date)
      const SECONDS: Record<string, number> = { day: 86400, '3day': 3 * 86400, '7day': 7 * 86400, '30day': 30 * 86400 };
      for (const period of Object.keys(SECONDS)) {
        const end = at('2015-01-14T19:30:00Z');
        expect([period, await rate({ date: '2015-01-14T19:30:00', period })]).toEqual([
          period,
          vwap(end - 1 - SECONDS[period], end),
        ]);
      }
      // case, strict and live do not matter
      expect(await rate({ date: '2015-01-14T19:30:00', period: 'DAY', strict: 'false', live: 'true' })).toBe(
        await rate({ date: '2015-01-14T19:30:00', period: 'day' }),
      );
      // the same asset
      expect(await rateOf(`CNY+${KIC}`, `CNY+${KIC}`, { date: '2015-01-14T19:30:00', period: 'day' })).toBe(
        '1.0000000',
      );
    });

    it('with no date, now: nothing traded lately, no rate', async () => {
      expect((await api.ok<RateBody>(`${RATE_PATH(`CNY+${KIC}`, `JPY+${MAZ}`)}`, 'rate')).body).toEqual({
        result: 'success',
        rate: '0.0000000',
      });
    });

    it('a failure of the database answers 500 with the route message', async () => {
      jest.spyOn(h.ch, 'queryOne').mockRejectedValue(new Error('boom'));
      const res = await get(`${RATE_PATH('XRP', USD_BITSTAMP)}?date=2015-01-14`);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve exchanges' }]);
    });

    it('needs the API key', async () => {
      const res = await h.http().get(`${RATE_PATH('XRP', USD_BITSTAMP)}?date=2015-01-14`);
      expect(res.status).toBe(401);
    });
  });

  describe('normalize', () => {
    const normalize = async (params: Record<string, string | number | boolean>): Promise<NormalizeBody> =>
      (await api.ok<NormalizeBody>(`/v2/normalize${qs(params)}`, 'converted')).body;
    const fail = (params: Record<string, string | number | boolean>, status: number, message: string): Promise<void> =>
      error(`/v2/normalize${qs(params)}`, status, message);

    const date = '2015-01-14';
    // XRP per USD+rMwj (5 trades, so strict=false), per CNY+rKiC (13 trades) and per JPY+rMAz (the 38-trade pair's counter)
    const usdMwj = pairs.find((p) => pathOf(p.base) === `USD+${MWJ}` && p.counter.currency === 'XRP') as Pair;
    const cnyKic = pairs.find((p) => pathOf(p.base) === `CNY+${KIC}` && p.counter.currency === 'XRP') as Pair;

    it('to the native currency: converted = amount * rate, the rate is the vwap in XRP', async () => {
      const rate = floatVwap(usdMwj, false, EPOCH_2015_01_15).vwap;
      expect(rate).toBeGreaterThan(0);
      const res = await normalize({ amount: 10, date, currency: 'USD', issuer: MWJ, strict: false });
      expect([res.result, res.amount, res.rate]).toEqual(['success', '10', new BigNumber(rate).toPrecision(8)]);
      // the original multiplied floats, this multiplies the exact rate: the same number to the last digits
      expect(Number(res.converted)).toBeCloseTo(10 * rate, 9);
      expect(Math.abs(Number(res.converted) / (10 * rate) - 1)).toBeLessThan(1e-14);
      // in strict mode a pair of 5 trades has no rate
      const strict = await normalize({ amount: 10, date, currency: 'USD', issuer: MWJ });
      expect([strict.converted, strict.rate]).toEqual(['0', '0.0000000']);
    });

    it("from the native currency to an issued one: the rate is the inverse of that currency's rate", async () => {
      const rate = floatVwap(usdMwj, false, EPOCH_2015_01_15).vwap;
      const res = await normalize({ amount: 3, date, exchange_currency: 'USD', exchange_issuer: MWJ, strict: false });
      expect(res.rate).toBe(new BigNumber(1 / rate).toPrecision(8));
      expect(res.converted).toBe(String(3 / rate));
    });

    it('between two issued currencies, through the native one', async () => {
      const from = floatVwap(usdMwj, false, EPOCH_2015_01_15).vwap;
      const to = floatVwap(cnyKic, false, EPOCH_2015_01_15).vwap;
      const res = await normalize({
        amount: 100,
        date,
        currency: 'usd',
        issuer: MWJ,
        exchange_currency: 'cny',
        exchange_issuer: KIC,
        strict: false,
      });
      expect(res.rate).toBe(new BigNumber(from / to).toPrecision(8));
      expect(Number(res.converted)).toBeCloseTo((100 * from) / to, 9);
      expect(res.amount).toBe('100');
      // the other way round
      const back = await normalize({
        amount: 100,
        date,
        currency: 'CNY',
        issuer: KIC,
        exchange_currency: 'USD',
        exchange_issuer: MWJ,
        strict: false,
      });
      expect(back.rate).toBe(new BigNumber(to / from).toPrecision(8));
    });

    it('a currency without a rate gives 0: as the source or as the target', async () => {
      const none = { currency: 'EUR', issuer: BITSTAMP };
      const usd = { exchange_currency: 'USD', exchange_issuer: MWJ };
      const noFrom = await normalize({ amount: 10, date, strict: false, ...none, ...usd });
      expect([noFrom.converted, noFrom.rate]).toEqual(['0', '0.0000000']);
      const noTo = await normalize({
        amount: 10,
        date,
        strict: false,
        currency: 'USD',
        issuer: MWJ,
        exchange_currency: 'EUR',
        exchange_issuer: BITSTAMP,
      });
      expect([noTo.converted, noTo.rate]).toEqual(['0', '0.0000000']);
    });

    it('the same currency and issuer is rate 1, and needs no rate; so is the native currency by default', async () => {
      expect(
        await normalize({
          amount: 12.5,
          date,
          currency: 'EUR',
          issuer: BITSTAMP,
          exchange_currency: 'EUR',
          exchange_issuer: BITSTAMP,
        }),
      ).toEqual({
        result: 'success',
        amount: '12.5',
        converted: '12.5',
        rate: '1.0000000',
      });
      expect(await normalize({ amount: 5, date })).toEqual({
        result: 'success',
        amount: '5',
        converted: '5',
        rate: '1.0000000',
      });
      expect(await normalize({ amount: 5, date, currency: 'xrp', exchange_currency: 'XRP' })).toEqual({
        result: 'success',
        amount: '5',
        converted: '5',
        rate: '1.0000000',
      });
      // the same currency under another issuer is another asset (no trade of USD+rMAz...: no rate)
      const other = await normalize({
        amount: 5,
        date,
        strict: false,
        currency: 'USD',
        issuer: MWJ,
        exchange_currency: 'USD',
        exchange_issuer: MAZ,
      });
      expect([other.rate, other.converted]).toEqual(['0.0000000', '0']);
    });

    it('the amount is read as a JavaScript number: Number(text); missing, not a number, or infinite is invalid', async () => {
      const ok = async (amount: string): Promise<string> => (await normalize({ amount, date })).amount;
      expect(await ok('10')).toBe('10');
      expect(await ok('1e3')).toBe('1000');
      expect(await ok('0x10')).toBe('16');
      expect(await ok(' 7 ')).toBe('7');
      expect(await ok('-2.50')).toBe('-2.5');
      expect(await ok('.5')).toBe('0.5');
      expect(await ok('')).toBe('0'); // Number('') is 0 in the original too
      for (const amount of ['zzzz', '1,5', 'NaN', 'Infinity', '-Infinity', '1e999', '12abc', 'null']) {
        await fail({ amount, date }, 400, 'invalid amount');
      }
      await error(`/v2/normalize?date=${date}`, 400, 'invalid amount');
      // the first of a repeated amount
      const repeated = await api.ok<NormalizeBody>(`/v2/normalize?amount=3&amount=zz&date=${date}`, 'converted');
      expect(repeated.body.amount).toBe('3');
    });

    it('converted is what a JavaScript number prints, not a hundred digits of an exact product', async () => {
      const res = await normalize({ amount: '0.1', date, currency: 'USD', issuer: MWJ, strict: false });
      expect(res.converted).toMatch(/^[0-9.e+-]{1,24}$/);
      expect(Number.isFinite(Number(res.converted))).toBe(true);
    });

    it('checks in the order of the original: amount, currency, issuer, exchange currency, exchange issuer, then the date', async () => {
      const bad = { date: '9999-01-01' };
      await fail({ amount: 'x', currency: 'XRP', issuer: 'q', ...bad }, 400, 'invalid amount');
      await fail(
        { amount: 1, currency: 'XRP', issuer: 'q', exchange_currency: 'USD', ...bad },
        400,
        'XRP cannot have an issuer',
      );
      await fail(
        { amount: 1, currency: 'USD', exchange_currency: 'XRP', exchange_issuer: 'q', ...bad },
        400,
        'issuer is required',
      );
      await fail(
        { amount: 1, exchange_currency: 'XRP', exchange_issuer: 'q', ...bad },
        400,
        'XRP cannot have an issuer',
      );
      await fail({ amount: 1, exchange_currency: 'USD', ...bad }, 400, 'issuer is required');
      // then the addresses (ruling R33), then the date
      await fail({ amount: 1, currency: 'USD', issuer: 'zzz', ...bad }, 400, 'invalid issuer address');
      await fail(
        { amount: 1, exchange_currency: 'USD', exchange_issuer: 'zzz', ...bad },
        400,
        'invalid issuer address',
      );
      await fail({ amount: 1, currency: 'USD', issuer: MWJ, ...bad }, 400, 'must not be a future date');
      await fail({ amount: 1, currency: 'USD', issuer: MWJ, date: 'garbage' }, 400, 'invalid date format');
    });

    it('the same currency, even a future date, is a future date: the date is checked before the rate 1', async () => {
      await fail({ amount: 1, ...{ date: '9999-01-01' } }, 400, 'must not be a future date');
    });

    it('a failure answers 500 with the route message (the original answered 200 with that body)', async () => {
      jest.spyOn(h.ch, 'queryOne').mockRejectedValue(new Error('boom'));
      await fail({ amount: 10, date, currency: 'USD', issuer: MWJ }, 500, 'unable to retrieve exchanges');
    });

    it('unknown parameters are ignored, and it needs the API key', async () => {
      const res = await normalize({ amount: 1, date, foo: 'bar' });
      expect(res.rate).toBe('1.0000000');
      expect((await h.http().get(`/v2/normalize?amount=1`)).status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange rates when every exchange was written twice', () => {
  // `exchanges` is a ReplacingMergeTree and the rates never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about). One insert of a row twice would be collapsed by ClickHouse on the
  // way in (`optimize_on_insert`), so the copy is a second insert, without deduplication, with the merges stopped.
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const count = async (): Promise<number> =>
      Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Exchanges}`))[0].n);
    const once = await count();
    expect(once).toBe(158);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    // the table really holds every exchange twice
    expect(await count()).toBe(2 * once);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every pair, both ways round, has the rate of its exchanges counted once: 5 trades are not 10', async () => {
    const { strictRates, laxRates } = await expectEveryPairRate(api);
    expect(strictRates).toBeGreaterThanOrEqual(6);
    expect(laxRates).toBeGreaterThanOrEqual(60);
  });

  it('normalize counts them once too', async () => {
    // USD+rMwj has 5 exchanges: no rate in strict mode (twice written, it would have 10)
    const strict = await api.ok<NormalizeBody>(
      `/v2/normalize${qs({ amount: 10, date: '2015-01-14', currency: 'USD', issuer: MWJ })}`,
      'converted',
    );
    expect([strict.body.converted, strict.body.rate]).toEqual(['0', '0.0000000']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange rates on trades of the last hour (the default date is now)', () => {
  const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  let h: Harness;
  let api: ApiClient;
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    // 12 trades of USD against XRP in the last 12 minutes: 10 USD for 20 + i XRP
    const closes = Array.from({ length: 12 }, (_, i) => now - (12 - i) * 60);
    await h.ch.insert(
      Table.Ledgers,
      closes.map((close, i) => ({
        ledger_index: 70_000_000 + i,
        ledger_hash: `${i}`.padStart(64, 'C'),
        close_time: close,
      })),
    );
    await h.ch.insert(
      Table.Exchanges,
      closes.map(
        (close, i): ExchangesRow => ({
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XRP',
          counter_issuer: '',
          ledger_index: 70_000_000 + i,
          tx_index: 1,
          node_index: 1,
          tx_hash: `${i}`.padStart(64, 'A'),
          close_time: close,
          base_amount: '10',
          counter_amount: String(20 + i),
          base_amount_f: 10,
          counter_amount_f: 20 + i,
          rate: String((20 + i) / 10),
          rate_f: (20 + i) / 10,
          buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          offer_sequence: 1,
          amm_account: '',
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        }),
      ),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  // 12 trades: 120 USD for 20*12 + (0 + ... + 11) = 240 + 66 = 306 XRP: 2.55 XRP per USD, in the day and the latest alike
  // (when the 12 minutes fall in the day of now; just after midnight the day holds fewer of them and averages with the rest)
  const pathOf2 = `/v2/exchange_rates/USD+${ISSUER}/XRP`;

  it('without a date: as of now, the last trades count', async () => {
    const res = await api.ok<RateBody>(`${pathOf2}?live=true`, 'rate');
    expect(res.body).toEqual({ result: 'success', rate: '2.5500000' });
    const inverse = await api.ok<RateBody>(`/v2/exchange_rates/xrp/USD+${ISSUER}?live=true`, 'rate');
    expect(inverse.body.rate).toBe(new BigNumber(120).dividedBy(306).toPrecision(8));
  });

  it('with a period: the hour up to now', async () => {
    const res = await api.ok<RateBody>(`${pathOf2}?period=hour`, 'rate');
    expect(res.body.rate).toBe('2.5500000');
    // as of 6 minutes ago: the 7 trades up to then (20 ... 26 XRP for 10 USD each), the last trades alone
    const sixAgo = new Date((now - 6 * 60 + 1) * 1000).toISOString();
    const recent = await api.ok<RateBody>(`${pathOf2}?live=true&strict=false&date=${sixAgo}`, 'rate');
    expect(recent.body.rate).toBe('2.3000000');
  });

  it('normalize with no date: now', async () => {
    const res = await api.ok<NormalizeBody>(`/v2/normalize?amount=100&currency=USD&issuer=${ISSUER}`, 'converted');
    // the rate of the day and of the last trades: the average of two rates that hold the same trades unless it is just after midnight
    expect(res.body.amount).toBe('100');
    expect(Number(res.body.rate)).toBeGreaterThan(0);
    expect(Number(res.body.converted)).toBeCloseTo(100 * Number(res.body.rate), 4);
  });

  it('a date a few seconds ahead of the clock is a future date; one a moment ago is not', async () => {
    const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
    expect((await api.get(`${pathOf2}?live=true&date=${ahead(5_000)}`)).status).toBe(400);
    expect((await api.get(`${pathOf2}?live=true&date=${ahead(-1)}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange rates and normalize count the swaps against AMM pools', () => {
  // A swap against a pool is an exchange: the rate of a pair is the volume weighted price of ALL its exchanges, the
  // order-book ones and the swaps, and there is no parameter to leave the swaps out. The oracle adds up the exchanges
  // the syncer stored for the recorded AMM ledgers (138 swaps, 39 order-book exchanges, 2025 and 2026).
  const WIDE = BigNumber.clone({ DECIMAL_PLACES: 120 });
  const DAY = 86_400;
  const NATIVE_DUST = 0.0005;
  const pairs = pairsOf(fixtureExchanges('xrpl-amm'));
  const isSwap = (r: ExchangesRow): boolean => r.amm_account !== '';
  const keyOf = (r: ExchangesRow): number[] => [r.ledger_index, r.tx_index, r.node_index];
  const byKey = (a: ExchangesRow, b: ExchangesRow): number =>
    a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;
  const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
  const lastClose = (p: Pair): number => Math.max(...p.rows.map((r) => r.close_time));

  /** A native leg of 0.0005 or less is rounding noise. */
  const kept = (rows: ExchangesRow[], p: Pair): ExchangesRow[] =>
    rows.filter(
      (r) =>
        !(!p.base.issuer && new BigNumber(r.base_amount).lte(NATIVE_DUST)) &&
        !(!p.counter.issuer && new BigNumber(r.counter_amount).lte(NATIVE_DUST)),
    );
  /** counter per base of the exchanges (the pair asked the other way round: base per counter); 0 without volume. */
  function vwap(rows: ExchangesRow[], inverted: boolean): BigNumber {
    const sum = (pick: (r: ExchangesRow) => string): BigNumber =>
      rows.reduce((total, r) => total.plus(pick(r)), new WIDE(0));
    const base = sum((r) => (inverted ? r.counter_amount : r.base_amount));
    const counter = sum((r) => (inverted ? r.base_amount : r.counter_amount));
    return base.isZero() ? new WIDE(0) : counter.dividedBy(base);
  }
  /**
   * The rate of `/v2/exchange_rates` as of a second (`date` written to the second, so the window ends with it), for the
   * exchanges `rows`: with `period` the vwap of the window that ends a second before the date; else the average of the
   * daily vwap (the day of the date, up to it) and the latest (the last 50 exchanges of the 14 days before it, newest
   * first, then the noise out), the latest alone when the daily has none (or with `live`). Not strict: any count.
   */
  function rateOf(
    p: Pair,
    rows: ExchangesRow[],
    inverted: boolean,
    at: number,
    o: { live?: boolean; period?: number } = {},
  ) {
    const inWindow = (from: number, before: number): ExchangesRow[] =>
      rows.filter((r) => r.close_time >= from && r.close_time < before);
    if (o.period !== undefined) return vwap(kept(inWindow(at - 1 - o.period, at), p), inverted);
    const dayStart = at - (at % DAY);
    const daily = o.live ? new WIDE(0) : vwap(kept(inWindow(dayStart, Math.min(at + 1, dayStart + DAY)), p), inverted);
    const newest = inWindow(at - 14 * DAY, at + 1)
      .sort((a, b) => -byKey(a, b))
      .slice(0, 50);
    const latest = vwap(kept(newest, p), inverted);
    return daily.gt(0) && latest.gt(0) ? daily.plus(latest).times('0.5') : latest;
  }
  const p8 = (v: BigNumber.Value): string => new BigNumber(v).toPrecision(8);

  let h: Harness;
  let api: ApiClient;
  const rate = async (
    p: Pair,
    inverted: boolean,
    params: Record<string, string | number | boolean>,
  ): Promise<string> => {
    const [b, c] = inverted ? [p.counter, p.base] : [p.base, p.counter];
    return (await api.ok<RateBody>(`${RATE_PATH(pathOf(b), pathOf(c))}${qs(params)}`, 'rate')).body.rate;
  };

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  // the pair that has the most of both kinds, a pair of swaps only
  const both = [...pairs]
    .filter((p) => p.rows.some(isSwap) && p.rows.some((r) => !isSwap(r)))
    .sort((a, b) => b.rows.length - a.rows.length)[0];
  const swapsOnly = [...pairs].filter((p) => p.rows.every(isSwap)).sort((a, b) => b.rows.length - a.rows.length)[0];

  it('the data is as the tests assume: a pair of both kinds, a pair of swaps only', () => {
    expect([both.rows.filter(isSwap).length, both.rows.filter((r) => !isSwap(r)).length]).toEqual([4, 14]);
    expect(swapsOnly.rows.length).toBeGreaterThanOrEqual(6);
    expect(pairs.filter((p) => p.rows.some(isSwap)).length).toBeGreaterThan(50);
  });

  it('the latest rate of a pair is the vwap of its last exchanges, swaps included', async () => {
    const at = lastClose(both);
    const date = iso(at);
    for (const inverted of [false, true]) {
      const asked = await rate(both, inverted, { date, live: true, strict: false });
      const all = p8(rateOf(both, both.rows, inverted, at, { live: true }));
      const withoutSwaps = p8(
        rateOf(
          both,
          both.rows.filter((r) => !isSwap(r)),
          inverted,
          at,
          { live: true },
        ),
      );
      expect([inverted, asked]).toEqual([inverted, all]);
      // the swaps move the rate: this is not a comparison of equal numbers
      expect(withoutSwaps).not.toBe(all);
    }
  });

  it('the daily and the latest rate, the average of both, and the rate of a period, count the swaps', async () => {
    const at = lastClose(both);
    const date = iso(at);
    for (const inverted of [false, true]) {
      const average = await rate(both, inverted, { date, strict: false });
      expect([inverted, average]).toEqual([inverted, p8(rateOf(both, both.rows, inverted, at))]);
      for (const period of ['hour', 'day', '7day', '30day'] as const) {
        const seconds = { hour: 3600, day: DAY, '7day': 7 * DAY, '30day': 30 * DAY }[period];
        // a period ends a second before the date, so ask a second later to take the last exchange in
        const periodic = await rate(both, inverted, { date: iso(at + 1), period });
        expect([inverted, period, periodic]).toEqual([
          inverted,
          period,
          p8(rateOf(both, both.rows, inverted, at + 1, { period: seconds })),
        ]);
      }
    }
    // swaps are in the day and in the 14 days: the average differs from that of the order-book exchanges alone
    const book = both.rows.filter((r) => !isSwap(r));
    expect(p8(rateOf(both, book, false, at))).not.toBe(p8(rateOf(both, both.rows, false, at)));
  });

  it('a pair with swaps only has a rate, which is the vwap of its swaps (it has none without them)', async () => {
    const at = lastClose(swapsOnly);
    const date = iso(at);
    for (const inverted of [false, true]) {
      const asked = await rate(swapsOnly, inverted, { date, live: true, strict: false });
      expect([inverted, asked]).toEqual([
        inverted,
        p8(rateOf(swapsOnly, swapsOnly.rows, inverted, at, { live: true })),
      ]);
      expect(Number(asked)).toBeGreaterThan(0);
    }
    // in strict mode it still takes 10 exchanges, and the swaps count among them
    const strict = await rate(swapsOnly, false, { date, live: true });
    expect(strict).toBe(
      swapsOnly.rows.length >= 10 ? p8(rateOf(swapsOnly, swapsOnly.rows, false, at, { live: true })) : '0.0000000',
    );
  });

  it('every pair that has a swap, both ways round: the rate is that of all its exchanges as of its last one', async () => {
    let swapsMoved = 0;
    let compared = 0;
    for (const p of pairs.filter((x) => x.rows.some(isSwap))) {
      const at = lastClose(p);
      for (const inverted of [false, true]) {
        const asked = await rate(p, inverted, { date: iso(at), live: true, strict: false });
        const want = p8(rateOf(p, p.rows, inverted, at, { live: true }));
        expect([pathOf(p.base), pathOf(p.counter), inverted, asked]).toEqual([
          pathOf(p.base),
          pathOf(p.counter),
          inverted,
          want,
        ]);
        compared++;
        if (
          p8(
            rateOf(
              p,
              p.rows.filter((r) => !isSwap(r)),
              inverted,
              at,
              { live: true },
            ),
          ) !== want
        )
          swapsMoved++;
      }
    }
    expect(compared).toBeGreaterThan(100);
    // for most of them the swaps are all there is, or move the price
    expect(swapsMoved).toBeGreaterThan(compared / 2);
  });

  describe('normalize', () => {
    const normalize = async (params: Record<string, string | number | boolean>): Promise<NormalizeBody> =>
      (await api.ok<NormalizeBody>(`/v2/normalize${qs(params)}`, 'converted')).body;

    it('converts through the rate of the swaps: a currency that only a pool trades', async () => {
      const at = lastClose(swapsOnly);
      const date = iso(at);
      const wanted = rateOf(swapsOnly, swapsOnly.rows, false, at);
      expect(wanted.gt(0)).toBe(true);
      const res = await normalize({
        amount: 1000,
        date,
        currency: swapsOnly.base.currency,
        issuer: swapsOnly.base.issuer as string,
        strict: false,
      });
      expect([res.rate, Number(res.converted)]).toEqual([p8(wanted), expect.closeTo(1000 * wanted.toNumber(), 6)]);
      // and back into the currency from the native one
      const back = await normalize({
        amount: 3,
        date,
        exchange_currency: swapsOnly.base.currency,
        exchange_issuer: swapsOnly.base.issuer as string,
        strict: false,
      });
      expect(back.rate).toBe(p8(new WIDE(1).dividedBy(wanted)));
    });

    it('converts through the rate of both kinds: a pair of order-book exchanges and swaps', async () => {
      const at = lastClose(both);
      const date = iso(at);
      const wanted = rateOf(both, both.rows, false, at);
      const res = await normalize({
        amount: 10,
        date,
        currency: both.base.currency,
        issuer: both.base.issuer as string,
        strict: false,
      });
      expect(res.rate).toBe(p8(wanted));
      expect(res.rate).not.toBe(
        p8(
          rateOf(
            both,
            both.rows.filter((r) => !isSwap(r)),
            false,
            at,
          ),
        ),
      );
      expect(Math.abs(Number(res.converted) / (10 * wanted.toNumber()) - 1)).toBeLessThan(1e-12);
    });
  });
});

describe('exchange rates on Xahau (XAH is the native currency)', () => {
  const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  const D = Date.UTC(2020, 5, 15, 12, 0, 0) / 1000;
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    const closes = Array.from({ length: 12 }, (_, i) => D - (12 - i) * 60);
    await h.ch.insert(
      Table.Ledgers,
      closes.map((close, i) => ({ ledger_index: 100 + i, ledger_hash: `${i}`.padStart(64, 'C'), close_time: close })),
    );
    await h.ch.insert(
      Table.Exchanges,
      closes.map(
        (close, i): ExchangesRow => ({
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XAH',
          counter_issuer: '',
          ledger_index: 100 + i,
          tx_index: 1,
          node_index: 1,
          tx_hash: `${i}`.padStart(64, 'A'),
          close_time: close,
          base_amount: '10',
          counter_amount: '25',
          base_amount_f: 10,
          counter_amount_f: 25,
          rate: '2.5',
          rate_f: 2.5,
          buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          offer_sequence: 1,
          amm_account: '',
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        }),
      ),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  const date = '2020-06-15T12:00:00';

  it('the rate against XAH, either way round', async () => {
    expect((await api.ok<RateBody>(`/v2/exchange_rates/USD+${ISSUER}/XAH?date=${date}`, 'rate')).body.rate).toBe(
      '2.5000000',
    );
    expect((await api.ok<RateBody>(`/v2/exchange_rates/xah/USD+${ISSUER}?date=${date}`, 'rate')).body.rate).toBe(
      '0.40000000',
    );
  });

  it('XAH cannot have an issuer; XRP is an ordinary currency and needs one', async () => {
    const withIssuer = await api.get(`/v2/exchange_rates/XAH+${ISSUER}/USD+${ISSUER}`);
    expect([withIssuer.status, withIssuer.body]).toEqual([
      400,
      { result: 'error', message: 'XAH cannot have an issuer' },
    ]);
    const xrp = await api.get(`/v2/exchange_rates/USD+${ISSUER}/XRP`);
    expect([xrp.status, xrp.body]).toEqual([400, { result: 'error', message: 'counter issuer is required' }]);
  });

  it('normalize: the native currency by default is XAH', async () => {
    const toNative = await api.ok<NormalizeBody>(
      `/v2/normalize?amount=4&currency=USD&issuer=${ISSUER}&date=${date}`,
      'converted',
    );
    expect(toNative.body).toEqual({ result: 'success', amount: '4', converted: '10', rate: '2.5000000' });
    const same = await api.ok<NormalizeBody>(`/v2/normalize?amount=4&date=${date}`, 'converted');
    expect(same.body).toEqual({ result: 'success', amount: '4', converted: '4', rate: '1.0000000' });
    const bad = await api.get(`/v2/normalize?amount=4&currency=XAH&issuer=${ISSUER}`);
    expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'XAH cannot have an issuer' }]);
    const xrp = await api.get(`/v2/normalize?amount=4&currency=XRP`);
    expect([xrp.status, xrp.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
  });
});

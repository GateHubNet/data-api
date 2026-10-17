import {
  Asset,
  canonicalPair,
  computeDailyVolumes,
  computeLiveVolumes,
  ExchangesRow,
  getNetworkProfile,
  loadMarketsConfig,
  MarketsConfig,
  RatesService,
  Table,
  VolumeDailyRow,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import { SAMPLE_ROWS } from '../../../packages/shared/test/sample-rows';
import { ExpectedComponent, paymentOracle, tradeOracle } from '../../../packages/shared/test/volume-oracle';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureExchanges, fixturePayments } from './support/fixtures';

/**
 * `GET /v2/network/exchange_volume` and `GET /v2/network/payment_volume` on a real ClickHouse.
 *
 * The data is of three kinds, all in one database:
 *  1. the 54 mock ledgers of the original Ripple test suite (the ripple-mock seed) with the volume sets the syncer's volume jobs
 *     write for them (`computeLiveVolumes` at 2015-01-14T19:30Z, `computeDailyVolumes` for the days that have anything), checked
 *     against the oracle of `packages/shared/test/volume-oracle.ts` (an independent port of the original's aggregation scripts,
 *     over the rows the ledger writer stores);
 *  2. volume sets written by hand into `volume_daily` for February and March 2026, with numbers worked out on paper: weeks,
 *     months, days without a set, a day of zero volume, a day whose set was made twice (an older version holds a component that
 *     is gone), a set stored twice (real duplicate rows), a component whose sides swap on another day, a currency without a
 *     rate;
 *  3. trades of an invented currency (XYZ) against the native one, at known prices on 2026-03-03, 2026-03-09 and in the hour
 *     before the test runs, which the display currency conversion needs.
 *
 * Ported from rippled-historical-database `test/test.network.js` of the develop branch (a superset of master's): `network -
 * exchange volume` (its 10 `it`s) and `network - payment volume` (its 3), with the same titles. The expected values of the
 * original came from rows that its test loaded into HBase (`count 46933`); here they are the oracle's, so the assertions are of
 * shape and conversion, as the brief of this task says. Adapted or skipped:
 *  - develop's 'should error on invalid live period' expects the list `minute, hour, day, 3day, 7day, 30day`; the `minute`
 *    period is deliberately not supported (ruling R80), so it asserts the message of master's version of the `it`
 *    (`invalid period - use: hour, day, 3day, 7day, 30day`), and an added `it` checks that `live=minute` is refused;
 *  - `network - issued value` (another route, not part of this task) is skipped.
 */

// -- constants and helpers ---------------------------------------------------------------------------------------------------

const SEC = 1000;
const DAY = 86_400;
const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'shared', 'test', 'fixtures');
const unix = (text: string): number => Date.parse(text) / SEC;
const iso = (seconds: number): string => `${new Date(seconds * SEC).toISOString().slice(0, 19)}Z`;
const markerOf = (...key: (string | number)[]): string =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
const bn = (v: BigNumber.Value): BigNumber => new BigNumber(v);

const I1 = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const I2 = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const XRP: Asset = { currency: 'XRP' };
const XYZ: Asset = { currency: 'XYZ', issuer: I2 };
const BTC = { currency: 'BTC', issuer: I2 };

const LIVE_NOW = new Date('2015-01-14T19:30:00Z');

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Body {
  result: string;
  count: number;
  marker?: string;
  rows: Json[];
}

/** The keys of a row, a trade component and a payment component, in the order the original served them. */
const ROW_KEYS = ['components', 'count', 'exchange', 'total', 'exchange_rate', 'start_time', 'end_time'];
const TRADE_KEYS = ['count', 'rate', 'amount', 'base', 'counter', 'converted_amount'];
const PAYMENT_KEYS = ['currency', 'issuer', 'amount', 'count', 'rate', 'converted_amount'];

const p8 = (v: BigNumber.Value): string => bn(v).toPrecision(8);

// -- the expected output of a set, from the oracle ------------------------------------------------------------------------------

function tradeComponent(w: ExpectedComponent): Json {
  const converted = w.converted.toNumber();
  return {
    count: w.count,
    rate: p8(w.amount.toNumber() / converted),
    amount: w.amount.toString(),
    base: w.base.issuer ? { currency: w.base.currency, issuer: w.base.issuer } : { currency: w.base.currency },
    counter: w.counter.issuer
      ? { currency: w.counter.currency, issuer: w.counter.issuer }
      : { currency: w.counter.currency },
    converted_amount: String(converted),
  };
}

/** The row the API has to serve for the trades of a window, X = 1. */
function tradeRow(want: ExpectedComponent[], start: number, end?: number): Json {
  const total = want.reduce((sum, w) => sum + w.converted.toNumber(), 0);
  return {
    components: want.map(tradeComponent),
    count: want.reduce((n, w) => n + w.count, 0),
    exchange: { currency: 'XRP' },
    total: String(total),
    exchange_rate: '1.0000000',
    start_time: iso(start),
    ...(end !== undefined && { end_time: iso(end) }),
  };
}

type PaymentWant = Awaited<ReturnType<typeof paymentOracle>>;

function paymentRow(want: PaymentWant, start: number, end?: number): Json {
  const listed = want.filter((w) => w.converted.gt(0));
  const total = listed.reduce((sum, w) => sum + w.converted.toNumber(), 0);
  return {
    components: listed.map((w) => ({
      currency: w.asset.currency,
      ...(w.asset.issuer && { issuer: w.asset.issuer }),
      amount: w.amount.toString(),
      count: w.count,
      rate: p8(w.amount.toNumber() / w.converted.toNumber()),
      converted_amount: String(w.converted.toNumber()),
    })),
    count: want.reduce((n, w) => n + w.count, 0),
    exchange: { currency: 'XRP' },
    total: String(total),
    exchange_rate: '1.0000000',
    start_time: iso(start),
    ...(end !== undefined && { end_time: iso(end) }),
  };
}

/** Same keys, in the same order, down to the components: what `toEqual` does not look at. */
function expectSameShape(actual: Json, expected: Json): void {
  expect(actual).toEqual(expected);
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  actual.components.forEach((c: Json, i: number) => {
    expect(Object.keys(c)).toEqual(Object.keys(expected.components[i]));
    if (c.base) {
      expect(Object.keys(c.base)).toEqual(Object.keys(expected.components[i].base));
      expect(Object.keys(c.counter)).toEqual(Object.keys(expected.components[i].counter));
    }
  });
}

// -- sets written by hand ------------------------------------------------------------------------------------------------------

interface Part {
  component: string;
  base: Asset;
  counter?: Asset;
  amount: string;
  count: number;
  converted: number;
}

const part = (
  component: string,
  base: Asset,
  counter: Asset | undefined,
  amount: string,
  count: number,
  converted: number,
): Part => ({
  component,
  base,
  counter,
  amount,
  count,
  converted,
});

const USD1: Asset = { currency: 'USD', issuer: I1 };
const EUR1: Asset = { currency: 'EUR', issuer: I1 };
const FOO2: Asset = { currency: 'FOO', issuer: I2 };
const ZZZ1: Asset = { currency: 'ZZZ', issuer: I1 };
const A = `USD.${I1}/XRP`;
const B = `EUR.${I1}/XRP`;
const C = `EUR.${I1}/USD.${I1}`;
const D = `FOO.${I2}/USD.${I1}`;

/** The rows of a set: the sentinel, then the parts. */
function setRows(metric: string, day: string, version: number, parts: Part[], configVersion = 7): VolumeDailyRow[] {
  const row = (p?: Part): VolumeDailyRow => ({
    metric,
    day,
    component: p?.component ?? '',
    base_currency: p?.base.currency ?? '',
    base_issuer: p?.base.issuer ?? '',
    counter_currency: p?.counter?.currency ?? '',
    counter_issuer: p?.counter?.issuer ?? '',
    amount: p?.amount ?? '0',
    amount_f: p ? Number(p.amount) : 0,
    count: p?.count ?? 0,
    rate_f: p && p.converted ? Number(p.amount) / p.converted : 0,
    converted_f: p?.converted ?? 0,
    config_version: configVersion,
    version,
  });
  return [row(), ...parts.map(row)];
}

const V = 1_000_000_000_000;
const TRADE_DAYS: Record<string, Part[]> = {
  '2026-02-23': [part(A, USD1, XRP, '10', 1, 30), part(B, EUR1, XRP, '4', 2, 20)],
  '2026-02-25': [part(A, USD1, XRP, '5.5', 2, 15)],
  '2026-03-01': [part(A, USD1, XRP, '1', 1, 3), part(C, EUR1, USD1, '6', 1, 30)],
  '2026-03-02': [],
  '2026-03-03': [part(A, USD1, XRP, '2', 3, 6), part(D, USD1, FOO2, '10', 1, 30)],
  '2026-03-04': [part(D, FOO2, USD1, '100', 2, 25)],
  '2026-03-09': [part(A, USD1, XRP, '7', 4, 21)],
};
const PAYMENT_DAYS: Record<string, Part[]> = {
  '2026-02-24': [
    part('XRP', XRP, undefined, '10.5', 4, 10.5),
    part(`USD.${I1}`, USD1, undefined, '10', 3, 20),
    part(`ZZZ.${I1}`, ZZZ1, undefined, '9', 2, 0),
  ],
  // USD had no rate this day: its 2 payments are in the count of the row, and nowhere in the amount of its component
  '2026-02-26': [part('XRP', XRP, undefined, '1', 1, 1), part(`USD.${I1}`, USD1, undefined, '9', 2, 0)],
  '2026-03-03': [part('XRP', XRP, undefined, '2', 2, 2), part(`USD.${I1}`, USD1, undefined, '4', 1, 8)],
};

/** What a component of the expected rows looks like (written out, for the hand-made sets). */
const tc = (count: number, rate: string, amount: string, base: Json, counter: Json, converted: string): Json => ({
  count,
  rate,
  amount,
  base,
  counter,
  converted_amount: converted,
});
const usd = { currency: 'USD', issuer: I1 };
const eur = { currency: 'EUR', issuer: I1 };
const foo = { currency: 'FOO', issuer: I2 };
const xrp = { currency: 'XRP' };

/** A historical row of the hand-made sets: the bucket ends where the next one starts (a day, a week from Monday, a month). */
const base = (extra: Json, unit: 'day' | 'week' | 'month' = 'day'): Json => {
  const start = new Date(extra.start_time);
  const end =
    unit === 'month'
      ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
      : start.getTime() + (unit === 'week' ? 7 : 1) * DAY * SEC;
  return { exchange: xrp, exchange_rate: '1.0000000', ...extra, end_time: iso(end / SEC) };
};
// the rows of the hand-made trade sets, written out, per interval
const W1 = base(
  {
    components: [
      tc(4, p8(16.5 / 48), '16.5', usd, xrp, '48'),
      tc(1, p8(6 / 30), '6', eur, usd, '30'),
      tc(2, p8(4 / 20), '4', eur, xrp, '20'),
    ],
    count: 7,
    total: '98',
    start_time: '2026-02-23T00:00:00Z',
  },
  'week',
);
const W2 = base(
  {
    components: [
      tc(1, p8(10 / 30), '10', usd, foo, '30'),
      tc(2, p8(100 / 25), '100', foo, usd, '25'),
      tc(3, p8(2 / 6), '2', usd, xrp, '6'),
    ],
    count: 6,
    total: '61',
    start_time: '2026-03-02T00:00:00Z',
  },
  'week',
);
const W3 = base(
  {
    components: [tc(4, p8(7 / 21), '7', usd, xrp, '21')],
    count: 4,
    total: '21',
    start_time: '2026-03-09T00:00:00Z',
  },
  'week',
);
const FEB = base(
  {
    components: [tc(3, p8(15.5 / 45), '15.5', usd, xrp, '45'), tc(2, p8(4 / 20), '4', eur, xrp, '20')],
    count: 5,
    total: '65',
    start_time: '2026-02-01T00:00:00Z',
  },
  'month',
);
const MAR = base(
  {
    components: [
      tc(1, p8(6 / 30), '6', eur, usd, '30'),
      tc(1, p8(10 / 30), '10', usd, foo, '30'),
      tc(8, p8(10 / 30), '10', usd, xrp, '30'),
      tc(2, p8(100 / 25), '100', foo, usd, '25'),
    ],
    count: 12,
    total: '115',
    start_time: '2026-03-01T00:00:00Z',
  },
  'month',
);

describe('GET /v2/network/exchange_volume and /v2/network/payment_volume', () => {
  let h: Harness;
  let api: ApiClient;
  let rates: RatesService;
  let markets: MarketsConfig;
  const get = (path: string) => api.get(path);
  const ok = async (path: string): Promise<Body> => (await api.ok<Body>(path, 'rows')).body;

  const exchanges = fixtureExchanges('ripple-mock').map((e) => e.row);
  const payments = fixturePayments('ripple-mock').map((p) => p.row);
  const nowSeconds = Math.floor(Date.now() / SEC);

  /** The oracle's trade components of `[from, to)`, as the config of the fixtures lists the markets. */
  const tradesIn = (from: string | number, to: string | number): ExpectedComponent[] =>
    tradeOracle(
      markets,
      exchanges,
      typeof from === 'string' ? unix(from) : from,
      typeof to === 'string' ? unix(to) : to,
    );
  const paymentsIn = (from: number, to: number) => paymentOracle(markets, rates, payments, from, to, from);

  async function insertTrades(trades: { close: number; xrp: string; xyz: string }[]): Promise<void> {
    const stored = canonicalPair(XRP, XYZ);
    const sorted = [...trades].sort((a, b) => a.close - b.close);
    const ledgers = sorted.map((t, i) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: 95_000_000 + i,
      ledger_hash: String(95_000_000 + i).padStart(64, 'F'),
      close_time: t.close,
    }));
    const rows = sorted.map((t, i) => ({
      ...SAMPLE_ROWS[Table.Exchanges],
      base_currency: stored.base.currency,
      base_issuer: stored.base.issuer ?? '',
      counter_currency: stored.counter.currency,
      counter_issuer: stored.counter.issuer ?? '',
      ledger_index: 95_000_000 + i,
      tx_index: 0,
      node_index: 0,
      close_time: t.close,
      base_amount: stored.inverted ? t.xyz : t.xrp,
      counter_amount: stored.inverted ? t.xrp : t.xyz,
      base_amount_f: Number(stored.inverted ? t.xyz : t.xrp),
      counter_amount_f: Number(stored.inverted ? t.xrp : t.xyz),
    }));
    await h.ch.insert(Table.Ledgers, ledgers);
    await h.ch.insert(Table.Exchanges, rows);
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    markets = loadMarketsConfig(getNetworkProfile('xrpl'), join(FIXTURES, 'xrpl', 'volume-markets.json'));
    rates = new RatesService(h.ch, 'XRP');

    // 1. what the volume jobs write for the mock ledgers
    await computeLiveVolumes(h.ch, rates, markets, LIVE_NOW);
    for (const day of [
      '2013-06-11',
      '2013-10-25',
      '2015-01-13',
      '2015-01-14',
      '2015-01-15',
      '2015-02-09',
      '2016-03-28',
      '2017-05-12',
    ]) {
      await computeDailyVolumes(h.ch, rates, markets, new Date(`${day}T00:00:00Z`));
    }

    // 3. the trades of XYZ: 12 in the hour before now (10 XYZ for 20 XRP: 0.5 XYZ a coin), 5 on 2026-03-03 (10 for 40: 0.25),
    // 3 on 2026-03-09 (10 for 10: 1)
    await insertTrades([
      ...Array.from({ length: 12 }, (_, i) => ({ close: nowSeconds - 3600 + i, xrp: '20', xyz: '10' })),
      ...Array.from({ length: 5 }, (_, i) => ({ close: unix('2026-03-03T12:00:00Z') + i, xrp: '40', xyz: '10' })),
      ...Array.from({ length: 3 }, (_, i) => ({ close: unix('2026-03-09T12:00:00Z') + i, xrp: '10', xyz: '10' })),
    ]);

    // 2. the hand-made sets. Merges are stopped so that the older version and the duplicate stay where the reader can meet them.
    const database = (await h.ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await h.ch.command(`SYSTEM STOP MERGES ${database}.${Table.VolumeDaily}`);
    // an older version of 2026-02-23 with a component that is gone and other numbers
    await h.ch.insert(
      Table.VolumeDaily,
      setRows('trade_volume', '2026-02-23', V - 500, [
        part(A, USD1, XRP, '999', 99, 999),
        part(`ZZZ.${I1}/XRP`, ZZZ1, XRP, '1', 1, 1),
      ]),
    );
    for (const [day, parts] of Object.entries(TRADE_DAYS)) {
      await h.ch.insert(Table.VolumeDaily, setRows('trade_volume', day, V, parts));
    }
    for (const [day, parts] of Object.entries(PAYMENT_DAYS)) {
      await h.ch.insert(Table.VolumeDaily, setRows('payment_volume', day, V, parts));
    }
    // 2026-02-25 stored twice: the same set inserted a second time, without the deduplication of the server
    await h.ch.command(
      `INSERT INTO ${Table.VolumeDaily} SELECT * FROM ${Table.VolumeDaily} WHERE metric = 'trade_volume' AND day = '2026-02-25'`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it('the data is as the tests assume: sets for the mock days, the hand-made ones, and real duplicates', async () => {
    const dup = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.VolumeDaily} WHERE metric = 'trade_volume' AND day = '2026-02-25'`,
    );
    expect(Number(dup[0].n)).toBe(2 * 2);
    expect((await tradesIn('2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z')).length).toBeGreaterThan(8);
    expect(
      (await paymentsIn(unix('2015-01-14T00:00:00Z'), unix('2015-01-15T00:00:00Z'))).reduce((n, w) => n + w.count, 0),
    ).toBe(144);
  });

  // ===============================================================================================================
  describe('ported from test.network.js: network - exchange volume', () => {
    it('get live exchange volume', async () => {
      const res = await get('/v2/network/exchange_volume');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      // the original's mock row had 46933 trades; the mock ledgers have these in the last day
      const end = LIVE_NOW.getTime() / SEC;
      expect(res.body.rows[0].count).toBe(tradesIn(end - DAY, end).reduce((n, w) => n + w.count, 0));
      expect(res.body.rows[0].count).toBeGreaterThan(50);
    });

    it('get live exchange volume (hour)', async () => {
      const res = await get('/v2/network/exchange_volume?live=hour');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      const end = LIVE_NOW.getTime() / SEC;
      expect(res.body.rows[0].count).toBe(tradesIn(end - 3600, end).reduce((n, w) => n + w.count, 0));
    });

    it('get historical exchange volume', async () => {
      const res = await get('/v2/network/exchange_volume?start=2015-01-14T00:00&end=2015-01-14T00:00');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      expect(res.body.rows[0].count).toBe(
        tradesIn('2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z').reduce((n, w) => n + w.count, 0),
      );
      expect(res.body.rows[0].start_time).toBe('2015-01-14T00:00:00Z');
    });

    it('get exchange volume with exchange currency', async () => {
      const currency = 'BTC';
      const issuer = I2;
      const res = await get(
        `/v2/network/exchange_volume?exchange_currency=${currency}&exchange_issuer=${issuer}&start=2015-01-14T00:00&end=2015-01-14T00:00`,
      );
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      expect(res.body.rows[0].exchange.currency).toBe(currency);
      expect(res.body.rows[0].exchange.issuer).toBe(issuer);
      // BTC.rMwjY traded against XRP that day: the rate is the vwap of the day, the amounts are converted with it
      const btc = exchanges.filter(
        (e) =>
          e.base_currency === 'BTC' &&
          e.base_issuer === I2 &&
          e.counter_currency === 'XRP' &&
          e.close_time >= unix('2015-01-14T00:00:00Z'),
      );
      expect(btc.length).toBe(3);
      const x = btc
        .reduce((s, e) => s.plus(e.base_amount), bn(0))
        .dividedBy(btc.reduce((s, e) => s.plus(e.counter_amount), bn(0)));
      expect(res.body.rows[0].exchange_rate).toBe(p8(x));
    });

    it('should error on exchange currency without issuer', async () => {
      const res = await get('/v2/network/exchange_volume?exchange_currency=USD');
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('exchange currency must have an issuer');
    });

    it('should error on exchange XRP with issuer', async () => {
      const res = await get('/v2/network/exchange_volume?exchange_currency=XRP&exchange_issuer=zzz');
      expect(res.status).toBe(400);
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('XRP cannot have an issuer');
    });

    it('should error on invalid start date', async () => {
      const res = await get('/v2/network/exchange_volume?start=x2015-01-14T00:00&end=2015-01-14T00:00');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid start date format' });
    });

    it('should error on invalid end date', async () => {
      const res = await get('/v2/network/exchange_volume?start=2015-01-14T00:00&end=x2015-01-14T00:00');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid end date format' });
    });

    it('should error on invalid interval', async () => {
      const res = await get('/v2/network/exchange_volume?start=2015-01-14T00:00&end=2015-01-14T00:00&interval=years');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid interval - use: day, week, month' });
    });

    it('should error on invalid live period', async () => {
      const res = await get('/v2/network/exchange_volume?live=week');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid period - use: hour, day, 3day, 7day, 30day' });
    });

    it('should error on the minute period of the develop branch (deliberately not supported)', async () => {
      for (const route of ['exchange_volume', 'payment_volume']) {
        const res = await get(`/v2/network/${route}?live=minute`);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/^invalid period - use: hour, day/);
        expect(res.body.message).not.toContain('minute');
      }
    });
  });

  describe('ported from test.network.js: network - payment volume', () => {
    it('get live payments volume', async () => {
      const res = await get('/v2/network/payment_volume');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      const end = LIVE_NOW.getTime() / SEC;
      const want = await paymentsIn(end - DAY, end);
      expect(res.body.rows[0].count).toBe(want.reduce((n, w) => n + w.count, 0));
      expect(res.body.rows[0].count).toBeGreaterThan(100);
    });

    it('get live payments volume (hour)', async () => {
      const res = await get('/v2/network/payment_volume?live=hour');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      const end = LIVE_NOW.getTime() / SEC;
      expect(res.body.rows[0].count).toBe((await paymentsIn(end - 3600, end)).reduce((n, w) => n + w.count, 0));
    });

    it('get historical payment volume', async () => {
      const res = await get('/v2/network/payment_volume?start=2015-01-14T00:00&end=2015-01-14T00:00');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(1);
      expect(res.body.rows[0].count).toBe(144);
    });
  });

  // ===============================================================================================================
  describe('live mode', () => {
    const END = LIVE_NOW.getTime() / SEC;
    const SECONDS: Record<string, number> = {
      hour: 3600,
      day: DAY,
      '3day': 3 * DAY,
      '7day': 7 * DAY,
      '30day': 30 * DAY,
    };

    it.each(['hour', 'day', '3day', '7day', '30day'])(
      'exchange_volume live=%s is the row of the oracle, with the keys in the order of the original',
      async (period) => {
        const res = await ok(`/v2/network/exchange_volume?live=${period}`);
        expect(Object.keys(res)).toEqual(['result', 'count', 'rows']);
        expect(res.count).toBe(1);
        expectSameShape(res.rows[0], tradeRow(tradesIn(END - SECONDS[period], END), END - SECONDS[period], END));
        expect(Object.keys(res.rows[0])).toEqual(ROW_KEYS);
      },
    );

    it.each(['hour', 'day'])('payment_volume live=%s is the row of the oracle', async (period) => {
      const res = await ok(`/v2/network/payment_volume?live=${period}`);
      expect(res.count).toBe(1);
      expectSameShape(
        res.rows[0],
        paymentRow(await paymentsIn(END - SECONDS[period], END), END - SECONDS[period], END),
      );
    });

    it('live day row has components sorted by converted_amount desc (and live defaults to day)', async () => {
      const dflt = await ok('/v2/network/exchange_volume');
      const day = await ok('/v2/network/exchange_volume?live=day');
      expect(dflt).toEqual(day);
      const converted = dflt.rows[0].components.map((c: Json) => Number(c.converted_amount));
      expect(converted.length).toBeGreaterThan(8);
      expect(converted).toEqual([...converted].sort((a, b) => b - a));
      expect(dflt.rows[0].total).toBe(String(converted.reduce((s: number, v: number) => s + v, 0)));
    });

    it('the key order of a trade and of a payment component, and the types, as the original served them', async () => {
      const trade = (await ok('/v2/network/exchange_volume')).rows[0];
      for (const c of trade.components) {
        expect(Object.keys(c)).toEqual(TRADE_KEYS);
        expect(Object.keys(c.base)).toEqual(c.base.issuer ? ['currency', 'issuer'] : ['currency']);
        expect([typeof c.count, typeof c.rate, typeof c.amount, typeof c.converted_amount]).toEqual([
          'number',
          'string',
          'string',
          'string',
        ]);
      }
      expect(typeof trade.count).toBe('number');
      expect([typeof trade.total, typeof trade.exchange_rate]).toEqual(['string', 'string']);
      // every market is against the native currency or converted: a component whose counter is XRP has no issuer key
      expect(trade.components.some((c: Json) => c.counter.currency === 'XRP' && !('issuer' in c.counter))).toBe(true);

      const pay = (await ok('/v2/network/payment_volume')).rows[0];
      expect(pay.components.length).toBeGreaterThan(0);
      for (const c of pay.components) {
        expect(Object.keys(c)).toEqual(c.issuer ? PAYMENT_KEYS : PAYMENT_KEYS.filter((k) => k !== 'issuer'));
      }
      expect(pay.components.find((c: Json) => c.currency === 'XRP')).toBeDefined();
    });

    it('a component whose market has the native currency as its counter has rate = 1 / vwap and converted = counter volume', async () => {
      const row = (await ok('/v2/network/exchange_volume?live=day')).rows[0];
      const cny = row.components.find(
        (c: Json) =>
          c.base.currency === 'CNY' &&
          c.base.issuer === 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' &&
          c.counter.currency === 'XRP',
      );
      const trades = exchanges.filter(
        (e) =>
          e.base_currency === 'CNY' &&
          e.base_issuer === 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' &&
          e.counter_currency === 'XRP' &&
          bn(e.counter_amount).gt('0.0005'),
      );
      const baseVolume = trades.reduce((s, e) => s.plus(e.base_amount), bn(0));
      const counterVolume = trades.reduce((s, e) => s.plus(e.counter_amount), bn(0));
      expect(cny.amount).toBe(baseVolume.toString());
      expect(cny.count).toBe(trades.length);
      expect(cny.converted_amount).toBe(String(counterVolume.toNumber()));
      expect(cny.rate).toBe(p8(baseVolume.dividedBy(counterVolume)));
    });

    it('converted_amount = amount / rate for every component, whatever market it comes of', async () => {
      const row = (await ok('/v2/network/exchange_volume?live=30day')).rows[0];
      for (const c of row.components) {
        expect(Number(c.converted_amount)).toBeCloseTo(
          Number(c.amount) / Number(c.rate),
          -Math.max(0, Math.floor(Math.log10(Number(c.converted_amount))) - 6),
        );
      }
    });

    it('the unknown parameters, and the historical ones that mean nothing live, are ignored: descending, marker, limit', async () => {
      const plain = await ok('/v2/network/exchange_volume?live=day');
      for (const extra of [
        'foo=bar',
        'descending=true',
        `marker=${markerOf(1)}`,
        'limit=1',
        'format=json',
        'interval=week',
      ]) {
        expect(await ok(`/v2/network/exchange_volume?live=day&${extra}`)).toEqual(plain);
      }
    });

    it('the first value of a repeated parameter wins', async () => {
      const hour = await ok('/v2/network/exchange_volume?live=hour');
      expect(await ok('/v2/network/exchange_volume?live=hour&live=day')).toEqual(hour);
    });

    it('an empty live is the default, an empty start or end is no start or end', async () => {
      const day = await ok('/v2/network/exchange_volume?live=day');
      expect(await ok('/v2/network/exchange_volume?live=')).toEqual(day);
      expect(await ok('/v2/network/exchange_volume?start=&end=')).toEqual(day);
    });

    it('sets nothing in the Link header', async () => {
      const res = await get('/v2/network/exchange_volume');
      expect(res.headers.link).toBeUndefined();
    });

    it('a period with no set has no row: rows is empty and count 0', async () => {
      const other = await startHarness({ seed: 'none' });
      try {
        const res = await (await other.api()).ok<Body>('/v2/network/exchange_volume', 'rows');
        expect(res.body).toEqual({ result: 'success', count: 0, rows: [] });
      } finally {
        await other.close();
      }
    });
  });

  // ===============================================================================================================
  describe('historical mode', () => {
    it('day rows are the sets of the days, in order: the keys of the original, end_time the next midnight', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-02-23&end=2026-03-09');
      expect(res.count).toBe(7);
      expect(res.rows.map((r) => r.start_time)).toEqual([
        '2026-02-23T00:00:00Z',
        '2026-02-25T00:00:00Z',
        '2026-03-01T00:00:00Z',
        '2026-03-02T00:00:00Z',
        '2026-03-03T00:00:00Z',
        '2026-03-04T00:00:00Z',
        '2026-03-09T00:00:00Z',
      ]);
      for (const row of res.rows) expect(Object.keys(row)).toEqual(ROW_KEYS);
      expect(res.rows[0]).toEqual(
        base({
          components: [tc(1, p8(10 / 30), '10', usd, xrp, '30'), tc(2, p8(4 / 20), '4', eur, xrp, '20')],
          count: 3,
          total: '50',
          start_time: '2026-02-23T00:00:00Z',
        }),
      );
    });

    it('a day of zero volume (only the sentinel) is a row with no component; a day without a set is no row', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-03-02&end=2026-03-05');
      expect(res.rows.map((r) => r.start_time)).toEqual([
        '2026-03-02T00:00:00Z',
        '2026-03-03T00:00:00Z',
        '2026-03-04T00:00:00Z',
      ]);
      expect(res.rows[0]).toEqual({
        components: [],
        count: 0,
        exchange: xrp,
        total: '0',
        exchange_rate: '1.0000000',
        start_time: '2026-03-02T00:00:00Z',
        end_time: '2026-03-03T00:00:00Z',
      });
    });

    it('a component whose sides swapped is shown as it was stored, each day', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-03-03&end=2026-03-04');
      expect(res.rows[0].components[0]).toEqual(tc(1, p8(10 / 30), '10', usd, foo, '30'));
      expect(res.rows[1].components[0]).toEqual(tc(2, p8(100 / 25), '100', foo, usd, '25'));
    });

    it('historical week = sum of days, from Monday (UTC); a part of a week with a set counts, the whole week is the row', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-02-23&end=2026-03-09&interval=week');
      expect(res.rows).toEqual([W1, W2, W3]);
      for (const row of res.rows) expect(Object.keys(row)).toEqual(ROW_KEYS);
      // the week of the 14th of January 2015 starts on Monday the 12th
      const old = await ok('/v2/network/exchange_volume?start=2015-01-12&end=2015-01-12&interval=week');
      expect(old.rows.map((r) => r.start_time)).toEqual(['2015-01-12T00:00:00Z']);
      expect(old.rows[0].count).toBe(
        tradesIn('2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z').reduce((n, w) => n + w.count, 0),
      );
    });

    it('historical month = sum of days, the calendar month', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-02&end=2026-03&interval=month');
      expect(res.rows).toEqual([FEB, MAR]);
      for (const row of res.rows) expect(Object.keys(row)).toEqual(ROW_KEYS);
    });

    it('payment_volume: weeks and months add up the days; a currency with no converted amount is counted but not listed, and its amount is not in the rate of the days that had one', async () => {
      const days = await ok('/v2/network/payment_volume?start=2026-02-24&end=2026-03-03');
      expect(days.rows).toEqual([
        base({
          components: [
            { currency: 'USD', issuer: I1, amount: '10', count: 3, rate: p8(10 / 20), converted_amount: '20' },
            { currency: 'XRP', amount: '10.5', count: 4, rate: p8(1), converted_amount: '10.5' },
          ],
          count: 9,
          total: '30.5',
          start_time: '2026-02-24T00:00:00Z',
        }),
        base({
          components: [{ currency: 'XRP', amount: '1', count: 1, rate: p8(1), converted_amount: '1' }],
          count: 3,
          total: '1',
          start_time: '2026-02-26T00:00:00Z',
        }),
        base({
          components: [
            { currency: 'USD', issuer: I1, amount: '4', count: 1, rate: p8(4 / 8), converted_amount: '8' },
            { currency: 'XRP', amount: '2', count: 2, rate: p8(1), converted_amount: '2' },
          ],
          count: 3,
          total: '10',
          start_time: '2026-03-03T00:00:00Z',
        }),
      ]);
      const weeks = await ok('/v2/network/payment_volume?start=2026-02-23&end=2026-03-02&interval=week');
      expect(weeks.rows).toEqual([
        base(
          {
            components: [
              { currency: 'USD', issuer: I1, amount: '10', count: 3, rate: p8(10 / 20), converted_amount: '20' },
              { currency: 'XRP', amount: '11.5', count: 5, rate: p8(1), converted_amount: '11.5' },
            ],
            count: 12,
            total: '31.5',
            start_time: '2026-02-23T00:00:00Z',
          },
          'week',
        ),
        base(
          {
            components: [
              { currency: 'USD', issuer: I1, amount: '4', count: 1, rate: p8(4 / 8), converted_amount: '8' },
              { currency: 'XRP', amount: '2', count: 2, rate: p8(1), converted_amount: '2' },
            ],
            count: 3,
            total: '10',
            start_time: '2026-03-02T00:00:00Z',
          },
          'week',
        ),
      ]);
      const months = await ok('/v2/network/payment_volume?start=2026-02&end=2026-03&interval=month');
      expect(months.rows.map((r) => [r.start_time, r.count, r.total])).toEqual([
        ['2026-02-01T00:00:00Z', 12, '31.5'],
        ['2026-03-01T00:00:00Z', 3, '10'],
      ]);
    });

    it('the newest version of a set wins: the older one, with a component that is gone, is not shown', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-02-23&end=2026-02-23');
      expect(res.rows[0].components.map((c: Json) => c.amount)).toEqual(['10', '4']);
      expect(JSON.stringify(res.rows)).not.toContain('ZZZ');
      expect(res.rows[0].count).toBe(3);
    });

    it('a set stored twice (real duplicate rows) counts once', async () => {
      const res = await ok('/v2/network/exchange_volume?start=2026-02-25&end=2026-02-25');
      expect(res.rows[0].components).toEqual([tc(2, p8(5.5 / 15), '5.5', usd, xrp, '15')]);
      expect(res.rows[0].count).toBe(2);
      const week = await ok('/v2/network/exchange_volume?start=2026-02-23&end=2026-02-23&interval=week');
      expect(week.rows[0]).toEqual(W1);
    });

    describe('the window', () => {
      const starts = async (qs: string): Promise<string[]> =>
        (await ok(`/v2/network/exchange_volume?${qs}`)).rows.map((r) => r.start_time);

      it('start and end name periods: end=2026-03-03 reaches to the end of that day, end=2026-03 to the end of the month', async () => {
        expect(await starts('start=2026-03-01&end=2026-03-03')).toEqual([
          '2026-03-01T00:00:00Z',
          '2026-03-02T00:00:00Z',
          '2026-03-03T00:00:00Z',
        ]);
        expect(await starts('start=2026-03-03&end=2026-03-03T00:00')).toEqual(['2026-03-03T00:00:00Z']);
        expect(await starts('start=2026-03-01&end=2026-03')).toHaveLength(5);
        expect(await starts('start=2026-03-04&end=2026-03-08')).toEqual(['2026-03-04T00:00:00Z']);
      });

      it('a day is a row when it STARTS in the window: a start after midnight leaves the day out', async () => {
        expect(await starts('start=2026-03-03T00:00:01&end=2026-03-09')).toEqual([
          '2026-03-04T00:00:00Z',
          '2026-03-09T00:00:00Z',
        ]);
        expect(await starts('start=2026-03-03T00:00:00&end=2026-03-03T23:59:59')).toEqual(['2026-03-03T00:00:00Z']);
      });

      it('a week or a month is a row when it starts in the window, and is whole', async () => {
        expect(await starts('start=2026-02-24&end=2026-03-09&interval=week')).toEqual([
          '2026-03-02T00:00:00Z',
          '2026-03-09T00:00:00Z',
        ]);
        // the week of the 9th ends after `end`: still all of it
        const w3 = await ok('/v2/network/exchange_volume?start=2026-03-09&end=2026-03-09&interval=week');
        expect(w3.rows).toEqual([W3]);
        // February began before the 2nd, and March begins after the 28th: no month starts in the window
        expect(await starts('start=2026-02-02&end=2026-02-28&interval=month')).toEqual([]);
        expect(await starts('start=2026-02-01&end=2026-02-01&interval=month')).toEqual(['2026-02-01T00:00:00Z']);
      });

      it('a missing start is the epoch, a missing end is now', async () => {
        // the days the volume jobs computed for the mock ledgers (some of zero volume), then the hand-made ones
        const all = await ok('/v2/network/exchange_volume?end=2026-03-09');
        expect(all.rows.map((r) => r.start_time.slice(0, 10))).toEqual([
          '2013-06-11',
          '2013-10-25',
          '2015-01-13',
          '2015-01-14',
          '2015-01-15',
          '2015-02-09',
          '2016-03-28',
          '2017-05-12',
          '2026-02-23',
          '2026-02-25',
          '2026-03-01',
          '2026-03-02',
          '2026-03-03',
          '2026-03-04',
          '2026-03-09',
        ]);
        const upToNow = await ok('/v2/network/exchange_volume?start=2026-03-08');
        expect(upToNow.rows.map((r) => r.start_time)).toEqual(['2026-03-09T00:00:00Z']);
        // a start in the future leaves nothing, and so does a start after the end that is now
        expect((await ok('/v2/network/exchange_volume?start=2027-01-01')).rows).toEqual([]);
      });

      it('an empty range: count 0, rows empty, a 200 (a window in 2030, or before the first set)', async () => {
        for (const qs of [
          'start=2030-01-01&end=2030-02-01',
          'start=1990-01-01&end=1990-02-01',
          'start=2026-03-05&end=2026-03-08',
          'start=2300-01-01',
          'start=2026-03-10&end=2026-03-09',
        ]) {
          const res = await ok(`/v2/network/exchange_volume?${qs}`);
          expect(res).toEqual({ result: 'success', count: 0, rows: [] });
        }
      });

      it('the formats of dates the original takes: a year, a month, a day, an hour, a minute, a second, a zone, unix seconds', async () => {
        const expected = ['2026-03-03T00:00:00Z'];
        for (const [s, e] of [
          ['2026-03-03', '2026-03-03'],
          ['2026-03-03T00', '2026-03-03T00'],
          ['2026-03-03T00:00', '2026-03-03T00:00'],
          ['2026-03-03T00:00:00', '2026-03-03T00:00:00'],
          ['2026-03-03T00:00:00Z', '2026-03-03T00:00:00Z'],
          ['2026-03-03T01:00:00%2B01:00', '2026-03-03T01:00:00%2B01:00'],
          [String(unix('2026-03-03T00:00:00Z')), String(unix('2026-03-03T00:00:00Z'))],
        ]) {
          expect([s, await starts(`start=${s}&end=${e}`)]).toEqual([s, expected]);
        }
      });
    });

    describe('pages', () => {
      it.each([
        ['day', 7],
        ['week', 3],
        ['month', 2],
      ])(
        'interval=%s: marker pages concatenate to the unpaged list, and the marker is the start of the last bucket',
        async (interval, total) => {
          const path = `/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&interval=${interval}`;
          const whole = await ok(path);
          expect(whole.count).toBe(total);
          expect(whole.marker).toBeUndefined();
          for (const limit of [1, 2, 3]) {
            const pages = await api.pages<Body>(path, limit, 'rows');
            expect(pages.flatMap((p) => p.rows)).toEqual(whole.rows);
            for (const page of pages.slice(0, -1)) expect(page.rows).toHaveLength(limit);
            for (const page of pages) expect(page.count).toBe(page.rows.length);
            // a marker is the start of the last bucket of a page
            const first = pages[0];
            if (pages.length > 1) {
              expect(first.marker).toBe(markerOf(unix(first.rows[limit - 1].start_time)));
            } else {
              expect(first.marker).toBeUndefined();
            }
          }
        },
      );

      it('follows the Link header: the url of the request with the marker, and none on the last page', async () => {
        const res = await get('/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&limit=2');
        expect(res.status).toBe(200);
        const marker = markerOf(unix('2026-02-25T00:00:00Z'));
        expect(res.body.marker).toBe(marker);
        expect(res.headers.link).toMatch(
          /^<http:\/\/127\.0\.0\.1:\d+\/v2\/network\/exchange_volume\?start=2026-02-01&end=2026-03-31&limit=2&marker=[A-Za-z0-9_-]+>; rel="next"$/,
        );
        expect(res.headers.link).toContain(`marker=${marker}`);
        const last = await get(
          `/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&limit=2&marker=${markerOf(unix('2026-03-04T00:00:00Z'))}`,
        );
        expect(last.body.rows.map((r: Json) => r.start_time)).toEqual(['2026-03-09T00:00:00Z']);
        expect(last.headers.link).toBeUndefined();
      });

      it('a marker is the bucket it names: the next page starts after it, whatever the interval it was made for', async () => {
        const day = await ok(
          `/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&marker=${markerOf(unix('2026-03-03T00:00:00Z'))}`,
        );
        expect(day.rows.map((r) => r.start_time)).toEqual(['2026-03-04T00:00:00Z', '2026-03-09T00:00:00Z']);
        // a day in the middle of a week names that week
        const week = await ok(
          `/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&interval=week&marker=${markerOf(unix('2026-03-03T00:00:00Z'))}`,
        );
        expect(week.rows.map((r) => r.start_time)).toEqual(['2026-03-09T00:00:00Z']);
        const month = await ok(
          `/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&interval=month&marker=${markerOf(unix('2026-02-23T00:00:00Z'))}`,
        );
        expect(month.rows.map((r) => r.start_time)).toEqual(['2026-03-01T00:00:00Z']);
      });

      it('limit: 200 by default, at most 1000; zero, negative and text mean the default; a fraction is cut', async () => {
        const path = '/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&interval=day';
        expect((await ok(`${path}&limit=0`)).count).toBe(7);
        expect((await ok(`${path}&limit=-5`)).count).toBe(7);
        expect((await ok(`${path}&limit=abc`)).count).toBe(7);
        expect((await ok(`${path}&limit=2.9`)).count).toBe(2);
        expect((await ok(`${path}&limit=100000`)).count).toBe(7);
        expect((await ok(`${path}&limit=1`)).rows).toHaveLength(1);
      });

      it('an invalid marker is a 400', async () => {
        for (const marker of [
          '!!!',
          markerOf('x'),
          markerOf(1, 2),
          Buffer.from('not json').toString('base64url'),
          markerOf(-1),
        ]) {
          const res = await get(`/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&marker=${marker}`);
          expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
        }
      });

      it('descending is not a parameter of this route (the original ignored it): the order does not change', async () => {
        const path = '/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31';
        expect(await ok(`${path}&descending=true`)).toEqual(await ok(path));
      });
    });
  });

  // ===============================================================================================================
  describe('display currency', () => {
    const display = `exchange_currency=XYZ&exchange_issuer=${I2}`;

    it('live: X is the latest rate of the native currency against the display currency (the last trades, not the daily rate)', async () => {
      // 12 trades in the last hour at 0.5 XYZ a coin; the sets are of 2015, so the components keep their amounts
      const plain = (await ok('/v2/network/exchange_volume?live=day')).rows[0];
      const res = await ok(`/v2/network/exchange_volume?live=day&${display}`);
      const row = res.rows[0];
      expect(Object.keys(row)).toEqual(ROW_KEYS);
      expect(row.exchange).toEqual({ currency: 'XYZ', issuer: I2 });
      expect(row.exchange_rate).toBe('0.50000000');
      expect(row.total).toBe(String(Number(plain.total) * 0.5));
      expect(row.count).toBe(plain.count);
      expect(row.start_time).toBe(plain.start_time);
      expect(row.end_time).toBe(plain.end_time);
      row.components.forEach((c: Json, i: number) => {
        const p = plain.components[i];
        expect(Object.keys(c)).toEqual(TRADE_KEYS);
        expect(c.amount).toBe(p.amount);
        expect(c.count).toBe(p.count);
        expect(c.converted_amount).toBe(String(Number(p.converted_amount) * 0.5));
        // rate / X
        expect(c.rate).toBe(p8(Number(p.amount) / Number(p.converted_amount) / 0.5));
      });
    });

    it('display currency conversion keeps converted_amount = amount / rate', async () => {
      for (const route of ['exchange_volume', 'payment_volume']) {
        const row = (await ok(`/v2/network/${route}?live=day&${display}`)).rows[0];
        expect(row.components.length).toBeGreaterThan(0);
        for (const c of row.components) {
          const converted = Number(c.converted_amount);
          expect(converted).toBeCloseTo(
            Number(c.amount) / Number(c.rate),
            -Math.max(0, Math.floor(Math.log10(converted)) - 6),
          );
        }
      }
    });

    it('payment_volume live converts in the same way', async () => {
      const plain = (await ok('/v2/network/payment_volume?live=day')).rows[0];
      const row = (await ok(`/v2/network/payment_volume?live=day&${display}`)).rows[0];
      expect(row.exchange).toEqual({ currency: 'XYZ', issuer: I2 });
      expect(row.exchange_rate).toBe('0.50000000');
      expect(row.total).toBe(String(Number(plain.total) * 0.5));
      expect(row.components.map((c: Json) => c.converted_amount)).toEqual(
        plain.components.map((c: Json) => String(Number(c.converted_amount) * 0.5)),
      );
      expect(row.components.map((c: Json) => Object.keys(c))).toEqual(
        plain.components.map((c: Json) => Object.keys(c)),
      );
    });

    it('live: a display currency with no rate (no trade within 14 days) makes the row zeros, as the original: total "0", exchange_rate 0.0000000, rate "0"', async () => {
      const row = (await ok(`/v2/network/exchange_volume?live=day&exchange_currency=BTC&exchange_issuer=${I2}`))
        .rows[0];
      expect(row.exchange).toEqual(BTC);
      expect(row.total).toBe('0');
      expect(row.exchange_rate).toBe('0.0000000');
      expect(row.components.length).toBeGreaterThan(0);
      for (const c of row.components) {
        expect(c.rate).toBe('0');
        expect(c.converted_amount).toBe('0');
        expect(typeof c.converted_amount).toBe('string');
        expect(Object.keys(c)).toEqual(TRADE_KEYS);
      }
      expect(row.count).toBeGreaterThan(0);
    });

    it('historical: every row is converted with the vwap of the native currency against the display currency over ITS OWN bucket', async () => {
      const days = await ok(`/v2/network/exchange_volume?start=2026-03-01&end=2026-03-09&${display}`);
      const byStart = Object.fromEntries(days.rows.map((r) => [r.start_time, r]));
      // 03-03: 5 trades of 10 XYZ for 40 XRP: 0.25 XYZ a coin; 03-09: 10 for 10: 1; the other days have no trade of XYZ: 0
      expect(byStart['2026-03-03T00:00:00Z'].exchange_rate).toBe('0.25000000');
      expect(byStart['2026-03-09T00:00:00Z'].exchange_rate).toBe('1.0000000');
      for (const d of ['2026-03-01', '2026-03-02', '2026-03-04']) {
        expect(byStart[`${d}T00:00:00Z`].exchange_rate).toBe('0.0000000');
        expect(byStart[`${d}T00:00:00Z`].total).toBe('0');
      }
      const mar3 = byStart['2026-03-03T00:00:00Z'];
      expect(mar3.exchange).toEqual({ currency: 'XYZ', issuer: I2 });
      expect(mar3.total).toBe(String(36 * 0.25));
      expect(mar3.components.map((c: Json) => c.converted_amount)).toEqual([String(30 * 0.25), String(6 * 0.25)]);
      expect(mar3.components.map((c: Json) => c.rate)).toEqual([p8(10 / 30 / 0.25), p8(2 / 6 / 0.25)]);
      expect(Object.keys(mar3)).toEqual(ROW_KEYS);
      // the components of the days without a rate are kept, with zeros
      expect(byStart['2026-03-04T00:00:00Z'].components).toEqual([tc(2, '0', '100', foo, usd, '0')]);
    });

    it('historical weeks and months use the vwap of the whole bucket', async () => {
      const weeks = await ok(`/v2/network/exchange_volume?start=2026-02-23&end=2026-03-09&interval=week&${display}`);
      expect(weeks.rows.map((r) => r.exchange_rate)).toEqual(['0.0000000', '0.25000000', '1.0000000']);
      expect(weeks.rows[1].total).toBe(String(61 * 0.25));
      const months = await ok(`/v2/network/exchange_volume?start=2026-02&end=2026-03&interval=month&${display}`);
      // March: 80 XYZ for 230 XRP
      expect(months.rows.map((r) => r.exchange_rate)).toEqual(['0.0000000', p8(bn(80).dividedBy(230))]);
      expect(months.rows[1].total).toBe(String(115 * bn(80).dividedBy(230).toNumber()));
    });

    it('historical payment_volume converts per bucket as well', async () => {
      const res = await ok(`/v2/network/payment_volume?start=2026-03-03&end=2026-03-03&${display}`);
      expect(res.rows[0].exchange_rate).toBe('0.25000000');
      expect(res.rows[0].total).toBe(String(10 * 0.25));
      expect(res.rows[0].components.map((c: Json) => c.converted_amount)).toEqual([String(8 * 0.25), String(2 * 0.25)]);
    });

    it('the native currency as the display currency is no conversion; the currency is upper-cased', async () => {
      const plain = await ok('/v2/network/exchange_volume?live=hour');
      expect(await ok('/v2/network/exchange_volume?live=hour&exchange_currency=xrp')).toEqual(plain);
      const lower = await ok(`/v2/network/exchange_volume?live=hour&exchange_currency=xyz&exchange_issuer=${I2}`);
      expect(lower.rows[0].exchange).toEqual({ currency: 'XYZ', issuer: I2 });
    });

    it('is not asked for when there is nothing to convert: no rate query for an empty range', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await ok(`/v2/network/exchange_volume?start=2030-01-01&end=2030-02-01&${display}`);
      const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
      spy.mockRestore();
      expect(res.rows).toEqual([]);
      expect(reads).toHaveLength(0);
    });

    it('the display rates of a historical page are a single grouped read', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await ok(`/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&${display}`);
      const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
      spy.mockRestore();
      expect(reads).toHaveLength(1);
    });
  });

  // ===============================================================================================================
  describe('errors', () => {
    const msg = async (qs: string, route = 'exchange_volume'): Promise<[number, string]> => {
      const res = await get(`/v2/network/${route}${qs}`);
      expect(res.body.result).toBe('error');
      return [res.status, res.body.message];
    };

    it('exchange currency without an issuer; the native currency with one; an issuer that is no address', async () => {
      expect(await msg('?exchange_currency=USD')).toEqual([400, 'exchange currency must have an issuer']);
      expect(await msg('?exchange_currency=usd')).toEqual([400, 'exchange currency must have an issuer']);
      expect(await msg(`?exchange_issuer=${I2}`)).toEqual([400, 'XRP cannot have an issuer']);
      expect(await msg(`?exchange_currency=xrp&exchange_issuer=${I2}`)).toEqual([400, 'XRP cannot have an issuer']);
      expect(await msg('?exchange_currency=USD&exchange_issuer=notanaddress')).toEqual([
        400,
        'invalid exchange issuer address',
      ]);
      expect(await msg('?exchange_currency=USD&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59X')).toEqual([
        400,
        'invalid exchange issuer address',
      ]);
    });

    it('the checks come in the order of the original: exchange, start, end, interval, live', async () => {
      expect(await msg('?exchange_currency=USD&start=junk&end=junk&interval=x&live=x')).toEqual([
        400,
        'exchange currency must have an issuer',
      ]);
      expect(await msg('?start=junk&end=junk&interval=x&live=x')).toEqual([400, 'invalid start date format']);
      expect(await msg('?end=junk&interval=x&live=x')).toEqual([400, 'invalid end date format']);
      expect(await msg('?interval=x&live=x')).toEqual([400, 'invalid interval - use: day, week, month']);
      expect(await msg('?live=x')).toEqual([400, 'invalid period - use: hour, day, 3day, 7day, 30day']);
    });

    it('invalid live period → 400', async () => {
      for (const route of ['exchange_volume', 'payment_volume']) {
        const res = await get(`/v2/network/${route}?live=week`);
        expect(res.status).toBe(400);
        expect(res.body.result).toBe('error');
        expect(res.body.message).toMatch(/^invalid period - use: hour, day/);
      }
    });

    it('the periods of each route: payment volume has hour and day only', async () => {
      for (const live of ['3day', '7day', '30day', 'week', 'HOUR', 'Day', 'minute', '1']) {
        expect(await msg(`?live=${live}`, 'payment_volume')).toEqual([400, 'invalid period - use: hour, day']);
      }
      for (const live of ['week', 'HOUR', 'minute', '2day']) {
        expect(await msg(`?live=${live}`)).toEqual([400, 'invalid period - use: hour, day, 3day, 7day, 30day']);
      }
      expect((await get('/v2/network/payment_volume?live=3day')).status).toBe(400);
    });

    it('live is not checked when start or end is given', async () => {
      expect((await get('/v2/network/exchange_volume?live=week&start=2026-02-23&end=2026-02-23')).status).toBe(200);
      expect((await get('/v2/network/payment_volume?live=3day&end=2026-02-23')).status).toBe(200);
    });

    it('the interval is checked in live mode too, and case matters', async () => {
      expect(await msg('?interval=years')).toEqual([400, 'invalid interval - use: day, week, month']);
      expect(await msg('?interval=Day')).toEqual([400, 'invalid interval - use: day, week, month']);
      expect(await msg('?live=hour&interval=hour')).toEqual([400, 'invalid interval - use: day, week, month']);
      expect((await get('/v2/network/exchange_volume?interval=')).status).toBe(200);
    });

    it('dates: bad formats are 400s, with the formats the original takes accepted', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '20150114', '2015-1-1', '1e9']) {
        expect([start, ...(await msg(`?start=${start}`))]).toEqual([start, 400, 'invalid start date format']);
      }
      expect((await get('/v2/network/exchange_volume?start=20150114000000&end=20150114000000')).status).toBe(200);
    });

    it('needs an API key, and the error body is the Ripple one', async () => {
      const res = await h.http().get('/v2/network/exchange_volume');
      expect(res.status).toBe(401);
      expect(Object.keys(res.body)).toContain('result');
    });

    it('answers 500 "error getting data" when the database fails, and leaks nothing', async () => {
      for (const path of [
        '/v2/network/exchange_volume',
        '/v2/network/payment_volume?live=hour',
        '/v2/network/exchange_volume?start=2026-01-01',
        `/v2/network/exchange_volume?exchange_currency=XYZ&exchange_issuer=${I2}`,
      ]) {
        const spy = jest
          .spyOn(h.ch, 'query')
          .mockRejectedValue(new Error('DB::Exception: Cannot connect to the secret host'));
        const res = await get(path);
        spy.mockRestore();
        expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message: 'error getting data' }]);
      }
    });

    it('a failing rate lookup of the display currency is the same 500 (the original: unable to determine exchange rate)', async () => {
      const real = h.ch.query.bind(h.ch);
      const spy = jest.spyOn(h.ch, 'query').mockImplementation(async (sql, params, settings) => {
        if (String(sql).includes(`FROM ${Table.Exchanges}`))
          throw new Error('DB::Exception: memory limit (for query) exceeded');
        return real(sql, params, settings);
      });
      const live = await get(`/v2/network/exchange_volume?live=day&exchange_currency=XYZ&exchange_issuer=${I2}`);
      const history = await get(
        `/v2/network/exchange_volume?start=2026-03-03&end=2026-03-03&exchange_currency=XYZ&exchange_issuer=${I2}`,
      );
      spy.mockRestore();
      for (const res of [live, history]) {
        expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'error getting data' }]);
      }
    });
  });

  // ===============================================================================================================
  describe('CSV', () => {
    it('format=csv is the rows flattened, a file named after the metric: trade_volume.csv, payment_volume.csv', async () => {
      const res = await get('/v2/network/exchange_volume?start=2026-02-23&end=2026-02-23&format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('trade_volume'));
      const lines = res.text.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        [
          'components[0].count',
          'components[0].rate',
          'components[0].amount',
          'components[0].base.currency',
          'components[0].base.issuer',
          'components[0].counter.currency',
          'components[0].converted_amount',
          'components[1].count',
          'components[1].rate',
          'components[1].amount',
          'components[1].base.currency',
          'components[1].base.issuer',
          'components[1].counter.currency',
          'components[1].converted_amount',
          'count',
          'exchange.currency',
          'total',
          'exchange_rate',
          'start_time',
          'end_time',
        ]
          .map((h) => `"${h}"`)
          .join(','),
      );
      expect(lines[1]).toBe(
        [
          '1',
          p8(10 / 30),
          '10',
          'USD',
          I1,
          'XRP',
          '30',
          '2',
          p8(4 / 20),
          '4',
          'EUR',
          I1,
          'XRP',
          '20',
          '3',
          'XRP',
          '50',
          '1.0000000',
          '2026-02-23T00:00:00Z',
          '2026-02-24T00:00:00Z',
        ]
          .map((v) => `"${v}"`)
          .join(','),
      );

      const pay = await get('/v2/network/payment_volume?live=day&format=CSV');
      expect(pay.headers['content-disposition']).toBe(csvDisposition('payment_volume'));
      expect(pay.text.split('\n')[0]).toMatch(/^"components\[0\]\.currency"/);
    });

    it('every row has end_time in the header, live or not, and the Link header is set for a page with a next one', async () => {
      const live = await get('/v2/network/exchange_volume?format=csv');
      expect(live.text.split('\n')[0]).toMatch(/"start_time","end_time"$/);
      const week = await get('/v2/network/payment_volume?start=2026-02-23&end=2026-02-23&interval=week&format=csv');
      const [header, row] = week.text.trim().split('\n');
      expect(header).toMatch(/"exchange_rate","start_time","end_time"$/);
      expect(row).toMatch(/"2026-02-23T00:00:00Z","2026-03-02T00:00:00Z"$/);
      const paged = await get('/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&limit=2&format=csv');
      expect(paged.headers.link).toMatch(/rel="next"/);
      expect(paged.text.trim().split('\n')).toHaveLength(3);
    });

    it('an empty list is an empty file, and an error stays JSON', async () => {
      const empty = await get('/v2/network/exchange_volume?start=2030-01-01&end=2030-02-01&format=csv');
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      const bad = await get('/v2/network/exchange_volume?live=x&format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid period - use: hour, day, 3day, 7day, 30day' });
    });
  });

  // ===============================================================================================================
  describe('the queries', () => {
    const volumeQueries = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${Table.VolumeLive}|FROM ${Table.VolumeDaily}`).test(String(q)))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);
    const planOf = async (sql: string, params: Record<string, unknown>, kind: string): Promise<string> =>
      (await h.ch.query<{ explain: string }>(`EXPLAIN ${kind} ${sql}`, params)).map((r) => r.explain).join('\n');

    it('never uses FINAL, binds every value, and keeps the rows of the newest version of a set', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await ok('/v2/network/exchange_volume?live=3day');
      await ok('/v2/network/payment_volume?start=2026-02-23&end=2026-03-09&interval=week&limit=2');
      const all = volumeQueries(spy);
      spy.mockRestore();
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const [sql, params] of all) {
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).not.toMatch(/trade_volume|payment_volume|3day|2026/);
        expect(Object.keys(params).length).toBeGreaterThan(0);
      }
      // the reads of rows keep the newest version of a set; the one that only lists the buckets needs no version
      expect(all.filter(([sql]) => /max\(version\)/.test(sql))).toHaveLength(2);
      const live = all.find(([sql]) => sql.includes(`FROM ${Table.VolumeLive}`));
      expect(live?.[0]).toMatch(
        /version = \(SELECT max\(version\) FROM volume_live WHERE metric = \{metric:String\} AND period = \{period:String\}\)/,
      );
      expect(live?.[1]).toMatchObject({ metric: 'trade_volume', period: '3day' });
    });

    it('live: a read of one (metric, period) range of the primary key', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await ok('/v2/network/exchange_volume?live=hour');
      const [[sql, params]] = volumeQueries(spy);
      spy.mockRestore();
      expect(sql).toMatch(/ORDER BY metric, period, component/);
      const indexes = await planOf(sql, params, 'indexes = 1');
      expect(indexes).toMatch(/PrimaryKey\s+Keys:\s+metric\s+period/);
    });

    it.each([
      ['day', 'start=2026-02-01&end=2026-03-31&limit=3'],
      ['week', 'start=2026-02-01&end=2026-03-31&limit=2&interval=week'],
      ['month', 'start=2026-02-01&end=2026-03-31&limit=1&interval=month'],
      [
        'day, with a marker',
        `start=2026-02-01&end=2026-03-31&limit=2&marker=${markerOf(unix('2026-02-25T00:00:00Z'))}`,
      ],
    ])(
      'historical (%s): both reads are ranges of the primary key (metric, day), the buckets of the page are all it reads',
      async (_name, qs) => {
        const spy = jest.spyOn(h.ch, 'query');
        await ok(`/v2/network/exchange_volume?${qs}`);
        const queries = volumeQueries(spy);
        spy.mockRestore();
        // the buckets of the window, then the rows of the buckets of the page
        expect(queries).toHaveLength(2);
        const [buckets, rows] = queries;
        expect(buckets[0]).toMatch(/GROUP BY bucket\s+ORDER BY bucket ASC\s+LIMIT \{fetch:UInt32\}/);
        expect(rows[0]).toMatch(/ORDER BY metric, day, component\s+LIMIT 1 BY day, component/);
        expect(rows[0]).toMatch(/\(day, version\) IN \(\s*SELECT day, max\(version\)/);
        for (const [sql, params] of queries) {
          const indexes = await planOf(sql, params, 'indexes = 1');
          // a range of the primary key: the metric, then the days (the rows of a handful of days are found by exclusion)
          expect(indexes).toMatch(
            /PrimaryKey\s+Keys:\s+metric\s+day(\s+component)?\s+Condition: [^\n]*day in[^\n]*metric in \['trade_volume'[^\n]*\n\s+Parts: [^\n]*\n\s+Granules: [^\n]*\n\s+Search Algorithm: (binary search|generic exclusion search)/,
          );
          expect(sql).toMatch(/day >= \{from:Date\}|day >= \{a:Date\}/);
        }
        // the rows are read in the order of the key, for the buckets of the page only
        expect(rows[1]).toMatchObject({ metric: 'trade_volume' });
      },
    );

    it('a page costs its own buckets: the fetch limit is the page and one more', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await ok('/v2/network/exchange_volume?start=2026-02-01&end=2026-03-31&limit=3');
      const [[, params]] = volumeQueries(spy);
      spy.mockRestore();
      expect(params.fetch).toBe(4);
    });

    it('an end past the last day a Date holds, with a start in range, is not an error: the days are read up to 2149-06-06', async () => {
      // a start in range and an end of the year 2200: the reads must not bind a date past what ClickHouse's Date holds
      const spy = jest.spyOn(h.ch, 'query');
      const res = await ok('/v2/network/exchange_volume?start=2026-03-01&end=2200-01-01');
      const bound = volumeQueries(spy).flatMap(([, params]) =>
        Object.values(params).filter((v) => /^\d{4}-\d\d-\d\d$/.test(String(v))),
      );
      spy.mockRestore();
      expect(res.rows.map((r) => r.start_time.slice(0, 10))).toEqual([
        '2026-03-01',
        '2026-03-02',
        '2026-03-03',
        '2026-03-04',
        '2026-03-09',
      ]);
      expect(bound.length).toBeGreaterThan(0);
      expect([...bound].sort().pop()).toBe('2149-06-06');
      expect((await ok('/v2/network/payment_volume?start=2026-03-01&end=2999-12-31')).count).toBe(1);
      for (const interval of ['week', 'month']) {
        expect(
          (await ok(`/v2/network/exchange_volume?start=2026-03-01&end=2300-01-01&interval=${interval}`)).count,
        ).toBeGreaterThan(0);
      }
      // and with a display currency: the window of the rates is not bound as a Date
      expect(
        (
          await ok(
            `/v2/network/exchange_volume?start=2026-03-01&end=2200-01-01&exchange_currency=XYZ&exchange_issuer=${I2}`,
          )
        ).count,
      ).toBe(5);
    });

    it('the last day a Date holds is read, whatever the interval (a set of 2149-06-06; its week and month end past the Date range)', async () => {
      // (it stays: the merges are stopped, and a lightweight DELETE would wait for ever; the tests after this one end before 2149)
      await h.ch.insert(Table.VolumeDaily, setRows('trade_volume', '2149-06-06', V, [part(A, USD1, XRP, '3', 1, 9)]));
      const day = await ok('/v2/network/exchange_volume?start=2149-06-06&end=2200-01-01');
      expect(day.rows).toEqual([
        base({
          components: [tc(1, p8(3 / 9), '3', usd, xrp, '9')],
          count: 1,
          total: '9',
          start_time: '2149-06-06T00:00:00Z',
        }),
      ]);
      expect(day.rows[0].end_time).toBe('2149-06-07T00:00:00Z');
      // 2149-06-06 is a Friday: its week began on the 2nd and ends on the 9th, its month began on the 1st and ends on July 1st
      const week = await ok('/v2/network/exchange_volume?start=2149-06-02&end=2300-01-01&interval=week');
      expect(week.rows.map((r) => [r.start_time, r.end_time, r.count])).toEqual([
        ['2149-06-02T00:00:00Z', '2149-06-09T00:00:00Z', 1],
      ]);
      const month = await ok('/v2/network/exchange_volume?start=2149-06&end=2300-01-01&interval=month');
      expect(month.rows.map((r) => [r.start_time, r.end_time, r.count])).toEqual([
        ['2149-06-01T00:00:00Z', '2149-07-01T00:00:00Z', 1],
      ]);
      expect((await ok('/v2/network/exchange_volume?start=2149-06-07&end=2300-01-01')).rows).toEqual([]);
      expect((await ok('/v2/network/exchange_volume?start=2149-06-06&end=2149-06-06')).count).toBe(1);
    });

    it('a window past the last day a Date holds is empty without a query', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await ok('/v2/network/exchange_volume?start=2200-01-01&end=2300-01-01');
      expect(res.rows).toEqual([]);
      expect(volumeQueries(spy)).toHaveLength(0);
      spy.mockRestore();
      const early = await ok('/v2/network/exchange_volume?start=1900-01-01&end=1960-01-01');
      expect(early.rows).toEqual([]);
    });
  });
});

// ===============================================================================================================================
// Xahau, whose markets config is empty until Task 38
// ===============================================================================================================================

describe('GET /v2/network/*_volume on Xahau with an empty markets config', () => {
  let h: Harness;
  let api: ApiClient;
  let rates: RatesService;
  const empty: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };
  const rows = fixturePayments('xahau-recorded').map((p) => p.row);
  const first = Math.min(...rows.map((r) => r.close_time));
  const day = new Date(first * SEC).toISOString().slice(0, 10);
  const dayStart = unix(`${day}T00:00:00Z`);
  const NOW = new Date((dayStart + DAY - 60) * SEC);

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
    rates = new RatesService(h.ch, 'XAH');
    await computeLiveVolumes(h.ch, rates, empty, NOW);
    await computeDailyVolumes(h.ch, rates, empty, new Date(dayStart * SEC));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('the recorded ledgers hold XAH payments of one day', () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(new Set(rows.map((r) => new Date(r.close_time * SEC).toISOString().slice(0, 10)))).toEqual(new Set([day]));
    expect(new Set(rows.map((r) => `${r.currency}.${r.issuer}`))).toEqual(new Set(['XAH.']));
  });

  it('live exchange_volume: one row, no component, count 0, total "0", the exchange is XAH', async () => {
    const res = (await api.ok<Body>('/v2/network/exchange_volume?live=day', 'rows')).body;
    expect(res).toEqual({
      result: 'success',
      count: 1,
      rows: [
        {
          components: [],
          count: 0,
          exchange: { currency: 'XAH' },
          total: '0',
          exchange_rate: '1.0000000',
          start_time: iso(NOW.getTime() / SEC - DAY),
          end_time: iso(NOW.getTime() / SEC),
        },
      ],
    });
    expect(Object.keys(res.rows[0])).toEqual(ROW_KEYS);
  });

  it('every period of both routes has its row', async () => {
    for (const period of ['hour', 'day', '3day', '7day', '30day']) {
      expect((await api.ok<Body>(`/v2/network/exchange_volume?live=${period}`, 'rows')).body.count).toBe(1);
    }
    for (const period of ['hour', 'day']) {
      expect((await api.ok<Body>(`/v2/network/payment_volume?live=${period}`, 'rows')).body.count).toBe(1);
    }
  });

  it('payment_volume has the native currency, XAH, at rate 1: the day of the recorded ledgers', async () => {
    const res = (await api.ok<Body>(`/v2/network/payment_volume?start=${day}&end=${day}`, 'rows')).body;
    const sum = rows.reduce((s, r) => s.plus(r.delivered_amount), bn(0));
    expect(res.rows).toEqual([
      {
        components: [
          {
            currency: 'XAH',
            amount: sum.toString(),
            count: rows.length,
            rate: '1.0000000',
            converted_amount: String(sum.toNumber()),
          },
        ],
        count: rows.length,
        exchange: { currency: 'XAH' },
        total: String(sum.toNumber()),
        exchange_rate: '1.0000000',
        start_time: `${day}T00:00:00Z`,
        end_time: iso(dayStart + DAY),
      },
    ]);
  });

  it('exchange_volume of that day is a row with no component; the days around it have none', async () => {
    const res = (await api.ok<Body>(`/v2/network/exchange_volume?start=${day}&end=${day}`, 'rows')).body;
    expect(res.rows).toEqual([
      {
        components: [],
        count: 0,
        exchange: { currency: 'XAH' },
        total: '0',
        exchange_rate: '1.0000000',
        start_time: `${day}T00:00:00Z`,
        end_time: iso(dayStart + DAY),
      },
    ]);
    const week = (await api.ok<Body>(`/v2/network/exchange_volume?start=${day}&end=${day}&interval=week`, 'rows')).body;
    expect(week.rows).toHaveLength(0 + (new Date(dayStart * SEC).getUTCDay() === 1 ? 1 : 0));
  });

  it('the native currency of the network is XAH: XRP is an issued currency here, and the messages say XAH', async () => {
    const issuer = await api.get(
      '/v2/network/exchange_volume?exchange_currency=XAH&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
    );
    expect(issuer.body).toEqual({ result: 'error', message: 'XAH cannot have an issuer' });
    const xrp = await api.get('/v2/network/exchange_volume?exchange_currency=XRP');
    expect(xrp.body).toEqual({ result: 'error', message: 'exchange currency must have an issuer' });
    const same = await api.ok<Body>('/v2/network/exchange_volume?live=day&exchange_currency=xah', 'rows');
    expect(same.body.rows[0].exchange).toEqual({ currency: 'XAH' });
  });

  it('a display currency with no market makes zeros here too', async () => {
    const res = (
      await api.ok<Body>(
        `/v2/network/payment_volume?start=${day}&end=${day}&exchange_currency=USD&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`,
        'rows',
      )
    ).body;
    expect(res.rows[0].exchange).toEqual({ currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' });
    expect(res.rows[0].total).toBe('0');
    expect(res.rows[0].exchange_rate).toBe('0.0000000');
    expect(res.rows[0].components[0].converted_amount).toBe('0');
  });
});

describe('GET /v2/network/exchange_volume counts the swaps against AMM pools', () => {
  // A swap against a pool is an exchange: the trade volume of a market is that of ALL its exchanges, the order-book ones
  // and the swaps (`amm_volume`, the volume of the pools alone, is a metric of its own). The recorded AMM ledgers hold 138
  // swaps and 39 order-book exchanges; the markets are every pair they trade, so the jobs convert what they can.
  const rows = fixtureExchanges('xrpl-amm').map((e) => e.row);
  const isSwap = (r: ExchangesRow): boolean => r.amm_account !== '';
  const asMarket = (currency: string, issuer: string): Asset => ({ currency, ...(issuer && { issuer }) });
  const config: MarketsConfig = {
    version: 1,
    tradeMarkets: [
      ...new Map(
        rows.map((r) => [
          [r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('|'),
          { base: asMarket(r.base_currency, r.base_issuer), counter: asMarket(r.counter_currency, r.counter_issuer) },
        ]),
      ).values(),
    ],
    paymentCurrencies: [],
  };
  const DAYS = [
    ...new Set(rows.filter(isSwap).map((r) => new Date(r.close_time * 1000).toISOString().slice(0, 10))),
  ].sort();
  const NOW = new Date('2026-10-17T12:00:00Z');

  let h: Harness;
  let api: ApiClient;
  const ok = async (path: string): Promise<Body> => (await api.ok<Body>(path, 'rows')).body;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    const rates = new RatesService(h.ch, 'XRP');
    for (const day of DAYS) await computeDailyVolumes(h.ch, rates, config, new Date(`${day}T00:00:00Z`));
    await computeLiveVolumes(h.ch, rates, config, NOW);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the data is as the tests assume: days with swaps, markets of both kinds', () => {
    expect(DAYS.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter(isSwap)).toHaveLength(138);
    expect(config.tradeMarkets.length).toBeGreaterThan(50);
  });

  it('each day: the components, the count and the total are those of all the exchanges of the day, swaps included', async () => {
    let swapsCounted = 0;
    let daysChanged = 0;
    for (const day of DAYS) {
      const from = unix(`${day}T00:00:00Z`);
      const to = from + DAY;
      const all = tradeOracle(config, rows, from, to);
      const res = await ok(`/v2/network/exchange_volume?start=${day}&end=${day}`);
      expect([day, res.count]).toEqual([day, 1]);
      expectSameShape(res.rows[0], tradeRow(all, from, to));
      // the swaps of the day are in it: without them there are fewer trades (a swap in a market the job cannot convert
      // to the native currency is in no component, with or without the filter)
      const book = tradeOracle(
        config,
        rows.filter((r) => !isSwap(r)),
        from,
        to,
      );
      const counted = (list: ExpectedComponent[]): number => list.reduce((n, c) => n + c.count, 0);
      expect([day, counted(all) >= counted(book)]).toEqual([day, true]);
      swapsCounted += counted(all) - counted(book);
      if (counted(all) > counted(book)) daysChanged++;
    }
    expect(swapsCounted).toBeGreaterThan(50);
    expect(daysChanged).toBeGreaterThanOrEqual(6);
  });

  it('live=day: the last 24 hours, swaps included', async () => {
    const end = NOW.getTime() / SEC;
    const all = tradeOracle(config, rows, end - DAY, end);
    expect(all.reduce((n, c) => n + c.count, 0)).toBeGreaterThan(0);
    const res = await ok('/v2/network/exchange_volume?live=day');
    expectSameShape(res.rows[0], tradeRow(all, end - DAY, end));
    const book = tradeOracle(
      config,
      rows.filter((r) => !isSwap(r)),
      end - DAY,
      end,
    );
    expect(res.rows[0].count).toBeGreaterThan(book.reduce((n, c) => n + c.count, 0));
  });
});

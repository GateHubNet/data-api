import { Asset, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { FixtureExchange, fixtureExchanges, fixtureSource } from './support/fixtures';

/**
 * `GET /v2/exchanges/:base/:counter` (raw exchanges) and `GET /v2/exchanges` (every pair, a GateHub extra) on a real
 * ClickHouse, seeded with the 54 ledgers of the original Ripple test suite (`ripple-mock`: 158 exchanges in 32 pairs,
 * 5 of them USD+rMwj…/XRP) and with the XRPL ledgers recorded from a public node (`xrpl-recorded`: 20 exchanges, two
 * of them autobridged). The Xahau ledgers recorded from a public node hold no exchange, so the Xahau case seeds
 * synthetic rows.
 *
 * Ported from rippled-historical-database `test/test.exchanges.js`, the raw-trade `it`s (11 of 14, same titles):
 *  - 'should make sure exchanges handles pagination correctly' walks the pair with `limit=1` and compares each page with
 *    the unpaged list, as the original does; only the marker is this API's;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`USD|rMwj…|XRP||20150114182720|000011119603|00012|00004`, the first row of the next page); the marker of this API
 *    is `(ledger_index, tx_index, node_index)` of the last row of the page, so the test checks the Link around it and
 *    that the row the original named is the first of the next page.
 * Skipped, because the aggregated path (`interval`, `reduce`) is Task 23:
 *  - 'should should reduce exchanges to a single row'
 *  - 'should should get aggregate exchanges'
 *  - 'should return an error for an invalid interval'
 * The three missing-issuer / issuer-with-XRP `it`s pass `interval=3weeks` in the original and are ported as they are:
 * the pair is checked before the interval (it will stay so when Task 23 adds the interval checks).
 *
 * Added: the Exchange object (key order of the HBase row, types, what is left out), both orientations of every pair of
 * the mock ledgers, the order of the checks, limit, the markers, CSV, the SQL (full-key ORDER BY, plan read in order),
 * rows written twice, the all-pairs list and Xahau.
 */

const byKey = (a: FixtureExchange, b: FixtureExchange): number =>
  a.row.ledger_index - b.row.ledger_index || a.row.tx_index - b.row.tx_index || a.row.node_index - b.row.node_index;
/** Every mock exchange in the order of the all-pairs list, ascending. */
const ALL = [...fixtureExchanges('ripple-mock')].sort(byKey);

const USD = 'USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const USD_ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const PAIR = `${USD}/xrp`;

/** The path segment of an asset: `XRP`, `USD+rMwj…`. */
const pathOf = (a: Asset): string => (a.issuer ? `${a.currency}+${a.issuer}` : a.currency);

interface Market {
  base: Asset;
  counter: Asset;
  rows: FixtureExchange[];
}
/** The pairs of a set of exchanges, as stored (canonical orientation), each with its rows in key order. */
function marketsOf(exchanges: FixtureExchange[]): Market[] {
  const markets = new Map<string, Market>();
  for (const e of exchanges) {
    const r = e.row;
    const key = [r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('|');
    const market = markets.get(key) ?? {
      base: { currency: r.base_currency, ...(r.base_issuer && { issuer: r.base_issuer }) },
      counter: { currency: r.counter_currency, ...(r.counter_issuer && { issuer: r.counter_issuer }) },
      rows: [],
    };
    market.rows.push(e);
    markets.set(key, market);
  }
  return [...markets.values()];
}
const MARKETS = marketsOf(ALL);
const USD_XRP = MARKETS.find((m) => pathOf(m.base) === USD && m.counter.currency === 'XRP') as Market;

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** The exchanges of the ledgers that closed in `[from, before)`. */
const closedBetween = (rows: FixtureExchange[], from: string, before: string): FixtureExchange[] =>
  rows.filter((e) => e.row.close_time >= unix(from) && e.row.close_time < unix(before));
/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const executedTime = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** The marker of a row: `(ledger_index, tx_index, node_index)` as base64url JSON. */
const markerOf = (row: ExchangesRow): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index, row.node_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * The Exchange of a stored row, written out the way the original served it (`getExchanges.js` on the row
 * `lib/hbase/hbase-thrift/data.js` builds): the `d` family of the HBase row first, then the `f` family, each sorted by
 * name, and last the four currency/issuer fields that the route sets. `inverted` is a pair requested the other way
 * round: base and counter, buyer and seller swapped, the rate inverted. The client is not served.
 */
function exchangeOf(row: ExchangesRow, inverted = false): Record<string, unknown> {
  const rate = new BigNumber(row.rate);
  const fields: Record<string, unknown> = {
    base_amount: inverted ? row.counter_amount : row.base_amount,
    counter_amount: inverted ? row.base_amount : row.counter_amount,
    node_index: row.node_index,
    rate: (inverted ? new BigNumber(1).dividedBy(rate) : rate).toPrecision(8),
    tx_index: row.tx_index,
    autobridged_currency: row.autobridged_currency ?? undefined,
    autobridged_issuer: row.autobridged_issuer || undefined,
    buyer: inverted ? row.seller : row.buyer,
    executed_time: executedTime(row.close_time),
    ledger_index: row.ledger_index,
    offer_sequence: row.offer_sequence,
    provider: row.provider,
    seller: inverted ? row.buyer : row.seller,
    taker: row.taker,
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    base_currency: inverted ? row.counter_currency : row.base_currency,
    base_issuer: (inverted ? row.counter_issuer : row.base_issuer) || undefined,
    counter_currency: inverted ? row.base_currency : row.counter_currency,
    counter_issuer: (inverted ? row.base_issuer : row.counter_issuer) || undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
const exchangesOf = (list: FixtureExchange[], inverted = false): Record<string, unknown>[] =>
  list.map((e) => exchangeOf(e.row, inverted));

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  exchanges: Record<string, unknown>[];
}
const hashesIn = (body: ListBody): unknown[] => body.exchanges.map((e) => e.tx_hash);
const hashesOf = (list: FixtureExchange[]): string[] => list.map((e) => e.row.tx_hash);

/** The columns of the CSV of the raw exchanges, in the order `getExchanges.js` lists them. */
const CSV_COLUMNS = [
  'base_currency',
  'base_issuer',
  'base_amount',
  'counter_amount',
  'counter_currency',
  'counter_issuer',
  'rate',
  'executed_time',
  'ledger_index',
  'buyer',
  'seller',
  'taker',
  'provider',
  'autobridged_currency',
  'autobridged_issuer',
  'offer_sequence',
  'tx_type',
  'tx_index',
  'node_index',
  'tx_hash',
];

describe('exchanges API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.exchanges.js ----------------------------------------------------------------------------------------

  it('should should get individual exchanges', async () => {
    const res = await get(`/v2/exchanges/${PAIR}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.exchanges.length).toBe(5);
    let last = 0;
    for (const ex of (res.body as ListBody).exchanges) {
      expect(typeof ex.base_amount).toBe('string');
      expect(typeof ex.counter_amount).toBe('string');
      expect(typeof ex.rate).toBe('string');
      expect(typeof ex.offer_sequence).toBe('number');
      expect(typeof ex.ledger_index).toBe('number');
      expect(typeof ex.buyer).toBe('string');
      expect(typeof ex.seller).toBe('string');
      expect(typeof ex.taker).toBe('string');
      expect(typeof ex.provider).toBe('string');
      expect(typeof ex.executed_time).toBe('string');
      expect(typeof ex.tx_hash).toBe('string');
      expect(typeof ex.tx_type).toBe('string');

      expect(last).toBeLessThanOrEqual(ex.ledger_index as number);
      last = ex.ledger_index as number;
    }
  });

  it('should should get individual exchanges by date', async () => {
    const start = '2015-01-14T18:28:40Z';
    const end = '2015-01-14T18:51:40Z';
    const res = await get(`/v2/exchanges/${PAIR}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.exchanges.length).toBe(2);
    for (const ex of (res.body as ListBody).exchanges) {
      const time = Date.parse(ex.executed_time as string);
      expect(Date.parse(start) - time).toBeLessThanOrEqual(0); // executed time less than start time
      expect(Date.parse(end) - time).toBeGreaterThanOrEqual(0); // executed time greater than end time
    }
    // and they are the exchanges of the ledgers that closed in the window
    expect(hashesIn(res.body)).toEqual(
      hashesOf(closedBetween(USD_XRP.rows, '2015-01-14T18:28:40', '2015-01-14T18:51:41')),
    );
  });

  it('should should get exchanges in descending order', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?descending=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.count).toBe(5);
    let last = Infinity;
    for (const ex of (res.body as ListBody).exchanges) {
      expect(last).toBeGreaterThanOrEqual(ex.ledger_index as number);
      last = ex.ledger_index as number;
    }
  });

  it('should make sure exchanges handles pagination correctly', async () => {
    const url = `/v2/exchanges/${PAIR}?`;
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1); // must be at least 2

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}&limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.exchanges).toHaveLength(1);
      expect(res.body.exchanges[0].base_amount).toBe(ref.body.exchanges[i].base_amount);
      expect(res.body.exchanges[0].tx_hash).toBe(ref.body.exchanges[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should invert data when base and counter are inverted', async () => {
    const res1 = await get('/v2/exchanges/xrp/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q');
    const res2 = await get(`/v2/exchanges/${PAIR}`);
    const exchanges: ListBody['exchanges'] = res1.body.exchanges;
    const inverted: ListBody['exchanges'] = res2.body.exchanges;
    expect(exchanges).toHaveLength(5);
    exchanges.forEach((ex, i) => {
      expect(ex.base_amount === inverted[i].counter_amount).toBe(true); // base and counter not inverted
      expect(ex.counter_amount === inverted[i].base_amount).toBe(true); // counter and base not inverted
    });
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?start=2015x`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid end time', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?end=2015x`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should return an error for an missing base issuer', async () => {
    const res = await get('/v2/exchanges/USD/xrp?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('base issuer is required');
  });

  it('should return an error for an missing counter issuer', async () => {
    const res = await get('/v2/exchanges/xrp/USD?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('counter issuer is required');
  });

  it('should return an error for issuer with XRP', async () => {
    const res = await get('/v2/exchanges/USD/xrp+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('XRP cannot have an issuer');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?limit=1`);
    expect(res.status).toBe(200);
    // the marker of this API is the key of the last row of the page
    const marker = markerOf(USD_XRP.rows[0].row);
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/exchanges/${PAIR}?limit=1&marker=${marker}>; rel="next"`);
    // the original named the first row of the next page, 11119603 / 12 / 4, and following the Link starts there
    const next = await get(`/v2/exchanges/${PAIR}?limit=1&marker=${marker}`);
    expect(next.body.exchanges[0]).toMatchObject({ ledger_index: 11119603, tx_index: 12, node_index: 4 });
  });

  // -- the brief ----------------------------------------------------------------------------------------------------

  it('reversed pair returns inverted rows with identical tx_hash order', async () => {
    const forward = await get(`/v2/exchanges/${PAIR}`);
    const reversed = await get(`/v2/exchanges/xrp/${USD}`);
    expect(forward.body.count).toBe(5);
    expect(hashesIn(reversed.body)).toEqual(hashesIn(forward.body));
    expect(reversed.body.exchanges).toEqual(exchangesOf(USD_XRP.rows, true));
    reversed.body.exchanges.forEach((ex: Record<string, unknown>, i: number) => {
      const f = forward.body.exchanges[i];
      expect(ex).toMatchObject({
        base_currency: 'XRP',
        counter_currency: 'USD',
        counter_issuer: USD_ISSUER,
        base_amount: f.counter_amount,
        counter_amount: f.base_amount,
        buyer: f.seller,
        seller: f.buyer,
        taker: f.taker,
        provider: f.provider,
        tx_hash: f.tx_hash,
        ledger_index: f.ledger_index,
        executed_time: f.executed_time,
        offer_sequence: f.offer_sequence,
      });
      expect(ex).not.toHaveProperty('base_issuer');
      // 1/rate to 8 significant digits
      expect(ex.rate).toBe(new BigNumber(1).dividedBy(new BigNumber(f.rate as string)).toPrecision(8));
    });
  });

  it('limit=1000 is clamped to 400', async () => {
    const query = jest.spyOn(h.ch, 'query');
    const res = await get(`/v2/exchanges/${PAIR}?limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    const paging = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
    // one more than the page is asked for: the extra row tells whether there is a next page
    expect(paging).toHaveLength(1);
    expect(paging[0][1]).toMatchObject({ fetch: 401 });
    // 400 itself and below are kept
    jest.restoreAllMocks();
    const spy = jest.spyOn(h.ch, 'query');
    await get(`/v2/exchanges/${PAIR}?limit=400`);
    await get(`/v2/exchanges/${PAIR}?limit=399`);
    await get(`/v2/exchanges/${PAIR}?limit=401`);
    const fetches = spy.mock.calls
      .filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)))
      .map(([, params]) => (params as { fetch: number }).fetch);
    expect(fetches).toEqual([401, 400, 401]);
  });

  it('lowercase pair path works', async () => {
    const upper = await get(`/v2/exchanges/${PAIR}`);
    for (const path of [
      `usd+${USD_ISSUER}/xrp`,
      `Usd+${USD_ISSUER}/xRp`,
      `usd.${USD_ISSUER}/xrp`,
      `usd|${USD_ISSUER}/xrp`,
    ]) {
      const res = await get(`/v2/exchanges/${path}`);
      expect([path, res.status, res.body]).toEqual([path, 200, upper.body]);
    }
    const reversed = await get(`/v2/exchanges/xrp/usd+${USD_ISSUER}`);
    expect(reversed.body.exchanges).toEqual(exchangesOf(USD_XRP.rows, true));
  });

  // -- the Exchange -----------------------------------------------------------------------------------------------

  describe('the exchange object', () => {
    it('every exchange of every pair is served as the original formats it, in both orientations', async () => {
      expect(MARKETS).toHaveLength(32);
      let total = 0;
      for (const m of MARKETS) {
        const forward = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=400`;
        const reverse = `/v2/exchanges/${pathOf(m.counter)}/${pathOf(m.base)}?limit=400`;
        const f = await get(forward);
        expect([forward, f.status]).toEqual([forward, 200]);
        expect([forward, f.body.exchanges]).toEqual([forward, exchangesOf(m.rows)]);
        total += f.body.count;
        const r = await get(reverse);
        expect([reverse, r.status]).toEqual([reverse, 200]);
        expect([reverse, r.body.exchanges]).toEqual([reverse, exchangesOf(m.rows, true)]);
      }
      expect(total).toBe(158);
    });

    it('has the keys of the HBase row: the d family, the f family, then the currencies and issuers', async () => {
      // the pair with an issuer on both sides, and the pair with the native currency
      const both = MARKETS.find((m) => m.base.issuer && m.counter.issuer) as Market;
      const issued = await get(`/v2/exchanges/${pathOf(both.base)}/${pathOf(both.counter)}?limit=1`);
      expect(Object.keys(issued.body.exchanges[0])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
      ]);
      const native = await get(`/v2/exchanges/${PAIR}?limit=1`);
      expect(Object.keys(native.body.exchanges[0])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
      ]);
      // key order, not only the keys, for every row of the mock ledgers
      const all = await get(`/v2/exchanges/${pathOf(both.base)}/${pathOf(both.counter)}?limit=400`);
      (all.body as ListBody).exchanges.forEach((ex, i) =>
        expect([i, Object.keys(ex)]).toEqual([i, Object.keys(exchangeOf(both.rows[i].row))]),
      );
    });

    it('amounts, rate and times are strings, the indexes and the offer sequence numbers', async () => {
      for (const m of MARKETS.slice(0, 12)) {
        const res = await get(`/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=400`);
        for (const ex of (res.body as ListBody).exchanges) {
          for (const field of ['base_amount', 'counter_amount', 'rate', 'executed_time', 'tx_hash', 'tx_type']) {
            expect([field, typeof ex[field]]).toEqual([field, 'string']);
          }
          for (const field of ['ledger_index', 'tx_index', 'node_index', 'offer_sequence']) {
            expect([field, typeof ex[field]]).toEqual([field, 'number']);
          }
          expect(['Payment', 'OfferCreate']).toContain(ex.tx_type);
          // what is stored for the API's own use, or that the original dropped, is not served
          for (const stored of [
            'client',
            'close_time',
            'base_amount_f',
            'counter_amount_f',
            'rate_f',
            'rowkey',
            'time',
          ]) {
            expect(ex).not.toHaveProperty(stored);
          }
        }
      }
    });

    it('rate is the rate to 8 significant digits, as a string, trailing zeros kept', async () => {
      const cnyEur = MARKETS[0];
      expect(pathOf(cnyEur.base)).toBe('CNY+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
      expect(cnyEur.rows[0].row.rate).toBe('0.13661202185792351593');
      const forward = await get(`/v2/exchanges/${pathOf(cnyEur.base)}/${pathOf(cnyEur.counter)}?limit=1`);
      expect(forward.body.exchanges[0].rate).toBe('0.13661202');
      // 14.64 CNY for 2 EUR: 7.32 EUR per CNY, written with 8 significant digits
      const reversed = await get(`/v2/exchanges/${pathOf(cnyEur.counter)}/${pathOf(cnyEur.base)}?limit=1`);
      expect(reversed.body.exchanges[0].rate).toBe('7.3200000');
    });

    it('amounts are the exact decimal text that is stored', async () => {
      const res = await get(`/v2/exchanges/${pathOf(MARKETS[0].base)}/${pathOf(MARKETS[0].counter)}?limit=1`);
      expect(res.body.exchanges[0].base_amount).toBe(MARKETS[0].rows[0].row.base_amount);
      expect(res.body.exchanges[0].counter_amount).toBe(MARKETS[0].rows[0].row.counter_amount);
    });

    it('executed_time is the close time of the ledger, YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=1`);
      expect(res.body.exchanges[0].executed_time).toBe('2015-01-14T18:27:20Z');
      expect(res.body.exchanges[0].executed_time).toBe(executedTime(USD_XRP.rows[0].row.close_time));
    });

    it('the native currency has no issuer key, on either side', async () => {
      const res = await get(`/v2/exchanges/${PAIR}`);
      for (const ex of (res.body as ListBody).exchanges) expect(ex).not.toHaveProperty('counter_issuer');
      const inverted = await get(`/v2/exchanges/xrp/${USD}`);
      for (const ex of (inverted.body as ListBody).exchanges) {
        expect(ex).not.toHaveProperty('base_issuer');
        expect(ex.counter_issuer).toBe(USD_ISSUER);
      }
    });

    it('the pair of the answer is the pair of the request, whatever the order the exchanges are stored in', async () => {
      for (const m of MARKETS) {
        for (const [b, c] of [
          [m.base, m.counter],
          [m.counter, m.base],
        ]) {
          const res = await get(`/v2/exchanges/${pathOf(b)}/${pathOf(c)}?limit=1`);
          const ex = res.body.exchanges[0];
          expect([
            pathOf(b),
            pathOf(c),
            ex.base_currency,
            ex.base_issuer,
            ex.counter_currency,
            ex.counter_issuer,
          ]).toEqual([pathOf(b), pathOf(c), b.currency, b.issuer, c.currency, c.issuer]);
        }
      }
    });

    it('autobridged fields are left out when the exchange was not autobridged', async () => {
      const res = await get(`/v2/exchanges/${PAIR}`);
      for (const ex of (res.body as ListBody).exchanges) {
        expect(ex).not.toHaveProperty('autobridged_currency');
        expect(ex).not.toHaveProperty('autobridged_issuer');
      }
    });
  });

  // -- the envelope -------------------------------------------------------------------------------------------------

  describe('the response', () => {
    it('is result, count, marker, exchanges', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=2`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'exchanges']);
      const last = await get(`/v2/exchanges/${PAIR}?limit=400`);
      expect(Object.keys(last.body)).toEqual(['result', 'count', 'exchanges']);
    });

    it('is only result, count and exchanges for a pair without exchanges', async () => {
      const res = await get(`/v2/exchanges/USD+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y/XRP`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, exchanges: [] }]);
    });

    it('has no base or counter at the top, whatever the pair (the original never served them)', async () => {
      const res = await get(`/v2/exchanges/xrp/${USD}`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'exchanges']);
    });
  });

  // -- the pair -------------------------------------------------------------------------------------------------------

  describe('/v2/exchanges/:base/:counter', () => {
    it('lists the exchanges of the pair and no other, oldest first', async () => {
      // the same currency with another issuer, and the same issuer with another currency, are other pairs
      const cnyXrp = MARKETS.find(
        (m) =>
          m.base.currency === 'CNY' &&
          m.base.issuer === 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' &&
          m.counter.currency === 'XRP',
      ) as Market;
      const other = MARKETS.find(
        (m) => m.base.currency === 'CNY' && m.counter.currency === 'XRP' && m !== cnyXrp,
      ) as Market;
      const a = await get(`/v2/exchanges/${pathOf(cnyXrp.base)}/XRP`);
      const b = await get(`/v2/exchanges/${pathOf(other.base)}/XRP`);
      expect(a.body.count).toBe(13);
      expect(hashesIn(a.body)).toEqual(hashesOf(cnyXrp.rows));
      expect(hashesIn(b.body)).toEqual(hashesOf(other.rows));
      expect(hashesIn(a.body).filter((x) => hashesIn(b.body).includes(x))).toEqual([]);
    });

    it('a pair that has no exchanges, or does not exist → count 0', async () => {
      for (const path of [`USD+${USD_ISSUER}/GBP+${USD_ISSUER}`, `ABC+${USD_ISSUER}/XRP`, `XRP/ABC+${USD_ISSUER}`]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 200, { result: 'success', count: 0, exchanges: [] }]);
      }
    });

    it('the same currency on both sides is a pair of its own, and so is XRP/XRP (both empty)', async () => {
      const res = await get(`/v2/exchanges/XRP/XRP`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, exchanges: [] }]);
      const same = await get(`/v2/exchanges/${USD}/${USD}`);
      expect([same.status, same.body.count]).toEqual([200, 0]);
    });

    it('pages exchanges by the whole key of the pair, bound and read in order', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/exchanges/xrp/${USD}?limit=3`);
      expect(res.status).toBe(200);
      const paging = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
      expect(paging).toHaveLength(1);
      const sql = String(paging[0][0]);
      const params = paging[0][1] as Record<string, unknown>;
      // the pair is the stored one (USD before XRP), however it was asked for
      expect(params).toMatchObject({ fetch: 4 });
      expect(Object.values(params)).toEqual(expect.arrayContaining(['USD', USD_ISSUER, 'XRP', '']));
      // values are bound, never written into the SQL
      expect(sql).not.toContain(USD_ISSUER);
      expect(sql).toMatch(/base_currency = \{\w+:String\}/);
      expect(sql).toMatch(/counter_issuer = \{\w+:String\}/);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      // the whole key, in the order of the table, and a row that was written twice counts once
      const key = 'base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index';
      expect(sql).toContain(
        `ORDER BY ${key
          .split(', ')
          .map((c) => `${c} ASC`)
          .join(', ')}`,
      );
      expect(sql).toContain(`LIMIT 1 BY ${key}`);
      // a resumed page compares the whole key too
      jest.restoreAllMocks();
      const resumed = jest.spyOn(h.ch, 'query');
      await get(`/v2/exchanges/${PAIR}?limit=3&marker=${markerOf(USD_XRP.rows[1].row)}&descending=true`);
      const second = resumed.mock.calls.find(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
      expect(String(second?.[0])).toContain(`(${key}) < (`);
      expect(String(second?.[0])).toContain(
        `ORDER BY ${key
          .split(', ')
          .map((c) => `${c} DESC`)
          .join(', ')}`,
      );
    });

    it('reads the table in the order of its primary key, so that a page never sorts the whole range', async () => {
      // the pair is fixed by the query, so this is the order of the key; spelled out in full ClickHouse reads the table
      // in that order and stops after the page. With only `ledger_index, tx_index, node_index` it sorts every row of
      // the pair in the range first, and on the mock ledgers it does for half of the pairs (found in Task 21 for
      // payments_by_currency), so every pair is checked, in both directions and with a marker
      for (const descending of [false, true]) {
        for (const [i, m] of MARKETS.entries()) {
          // the first few also with the autobridged filter
          for (const extra of i < 3 ? ['', '&autobridged=true'] : ['']) {
            const query = jest.spyOn(h.ch, 'query');
            await get(
              `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=5&descending=${descending}${extra}&marker=${markerOf(m.rows[0].row)}`,
            );
            const calls = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
            expect(calls).toHaveLength(1);
            jest.restoreAllMocks();

            const [sql, params] = calls[0];
            const plan = await h.ch.query<{ explain: string }>(
              `EXPLAIN PIPELINE ${String(sql)}`,
              params as Record<string, unknown>,
            );
            const pipeline = plan.map((r) => r.explain).join('\n');
            const where = [pathOf(m.base), pathOf(m.counter), descending, extra];
            expect([where, pipeline]).toEqual([where, expect.stringContaining('ReadPoolInOrder')]);
            expect([where, pipeline.includes(descending ? 'InReverseOrder' : 'algorithm: InOrder')]).toEqual([
              where,
              true,
            ]);
            expect([where, pipeline.includes('PartialSortingTransform')]).toEqual([where, false]);
          }
        }
      }
    });
  });

  // -- the pair mistakes ----------------------------------------------------------------------------------------------

  describe('a pair that is not valid', () => {
    it('XRP with an issuer → 400, on either side', async () => {
      for (const path of [
        'XRP+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
        `${USD}/xrp.rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q`,
      ]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([
          path,
          400,
          { result: 'error', message: 'XRP cannot have an issuer' },
        ]);
      }
    });

    it('a currency other than XRP needs an issuer: base first, then counter', async () => {
      const cases: [string, string][] = [
        ['USD/XRP', 'base issuer is required'],
        ['XRP/USD', 'counter issuer is required'],
        ['USD/EUR', 'base issuer is required'],
        [`USD+/XRP`, 'base issuer is required'],
        ['XAH/XRP', 'base issuer is required'],
      ];
      for (const [path, message] of cases) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('a side without a currency → currency is required, base first', async () => {
      const issuer = USD_ISSUER;
      const cases: [string, string][] = [
        [`+${issuer}/XRP`, 'base currency is required'],
        [`XRP/+${issuer}`, 'counter currency is required'],
        [`+${issuer}/+${issuer}`, 'base currency is required'],
      ];
      for (const [path, message] of cases) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('an issuer that is not an address → invalid issuer address (the original answered an empty 200)', async () => {
      for (const [path, message] of [
        ['USD+abc/XRP', 'invalid base issuer address'],
        [`XRP/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2`, 'invalid counter issuer address'],
        [`USD+${USD_ISSUER}/EUR+0000000000000000000000000000000`, 'invalid counter issuer address'],
      ]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('the checks come in the order of the original: pair, start, end, limit, then the marker', async () => {
      const cases: [string, string][] = [
        [`/v2/exchanges/USD/XRP${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'base issuer is required'],
        [`/v2/exchanges/${PAIR}${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'invalid start date format'],
        [`/v2/exchanges/${PAIR}${qs({ end: 'y', limit: 'z', marker: '!' })}`, 'invalid end date format'],
        [`/v2/exchanges/${PAIR}${qs({ limit: 'z', marker: '!' })}`, 'invalid limit: NaN'],
        [`/v2/exchanges/${PAIR}${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
    });
  });

  // -- the shared list behaviour ---------------------------------------------------------------------------------

  describe('the list', () => {
    it('empty range → count 0', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?start=2030-01-01&end=2030-12-31`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      expect(res.headers.link).toBeUndefined();
    });

    it('a start after the last ledger → count 0; an end before the first → count 0', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?start=2018-01-01`)).body.count).toBe(0);
      expect((await get(`/v2/exchanges/${PAIR}?end=2013-06-01`)).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      // the three busiest pairs of the mock ledgers (38, 30 and 13 exchanges)
      for (const m of [...MARKETS].sort((a, b) => b.rows.length - a.rows.length).slice(0, 3)) {
        const path = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}`;
        const unpaged = await get(`${path}?limit=400`);
        expect(unpaged.body.count).toBeGreaterThan(9);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();

        const paged = await pages(path, 3);
        expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([path, paged.flatMap((p) => p.exchanges)]).toEqual([path, unpaged.body.exchanges]);
        // and the same pair the other way round
        const reversed = `/v2/exchanges/${pathOf(m.counter)}/${pathOf(m.base)}`;
        expect((await pages(reversed, 4)).flatMap((p) => p.exchanges)).toEqual(exchangesOf(m.rows, true));
      }
    });

    it('marker pages concatenate inside a window too', async () => {
      const busiest = MARKETS.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      // from the second close time of the pair to the one before its last: the first and last ledgers are left out
      const times = [...new Set(busiest.rows.map((e) => e.row.close_time))].sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(4);
      const first = times[1];
      const last = times[times.length - 2];
      const window = `/v2/exchanges/${pathOf(busiest.base)}/${pathOf(busiest.counter)}${qs({
        start: executedTime(first).slice(0, 19),
        end: executedTime(last).slice(0, 19),
      })}`;
      const expected = busiest.rows.filter((e) => e.row.close_time >= first && e.row.close_time <= last);
      expect(expected.length).toBeGreaterThan(5);
      expect(expected.length).toBeLessThan(busiest.rows.length);
      const paged = await pages(window, 4);
      expect(paged.flatMap(hashesIn)).toEqual(hashesOf(expected));
    });

    it('descending reverses order', async () => {
      for (const m of [...MARKETS].sort((a, b) => b.rows.length - a.rows.length).slice(0, 3)) {
        const path = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}`;
        const asc = await get(`${path}?limit=400`);
        const desc = await get(`${path}?limit=400&descending=true`);
        expect(asc.body.count).toBeGreaterThan(1);
        expect([path, desc.body.exchanges]).toEqual([path, [...asc.body.exchanges].reverse()]);
        // the markers of a descending list continue downwards
        const pagedDesc = await pages(`${path}?descending=true`, 4);
        expect([path, pagedDesc.flatMap((p) => p.exchanges)]).toEqual([path, desc.body.exchanges]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get(`/v2/exchanges/${PAIR}?limit=3`);
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/exchanges/${PAIR}?limit=3&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get(`/v2/exchanges/${PAIR}?limit=3&descending=true`);
      expect((await get(`/v2/exchanges/${PAIR}?limit=3&descending=TRUE`)).body).toEqual(desc.body);
      expect(hashesIn(desc.body)).toEqual(hashesOf(USD_XRP.rows.slice(-3).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get(`/v2/exchanges/${PAIR}?limit=3`);
      const res = await get(`/v2/exchanges/${PAIR}?limit=3&foo=bar`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=2&limit=50&descending=true&descending=false`);
      expect(res.body.count).toBe(2);
      expect(hashesIn(res.body)).toEqual(hashesOf(USD_XRP.rows.slice(-2).reverse()));
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-01-14', end: '2015-01-14' }, '2015-01-14T00:00:00', '2015-01-15T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:28:40Z' }, '2015-01-14T18:28:40', '2015-01-14T18:28:41'],
        [{ start: '2013' }, '2013-01-01T00:00:00', '2100-01-01T00:00:00'],
        [{ end: '2015-01' }, '2000-01-01T00:00:00', '2015-02-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const expected = closedBetween(USD_XRP.rows, from, before);
        const listed = (await pages(`/v2/exchanges/${PAIR}${qs(params)}`, 100)).flatMap(hashesIn);
        expect([params, listed]).toEqual([params, hashesOf(expected)]);
      }
      expect(closedBetween(USD_XRP.rows, '2015-01-14T18:28:40', '2015-01-14T18:28:41')).toHaveLength(1);
    });

    it('start defaults to 2013-01-01; an empty start is the default, an empty end is invalid', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?start=`)).body.count).toBe(5);
      const res = await get(`/v2/exchanges/${PAIR}?end=`);
      expect([res.status, res.body.message]).toEqual([400, 'invalid end date format']);
      // before the default: nothing is lost, the mock ledgers are all later
      expect((await get(`/v2/exchanges/${PAIR}?start=2012-01-01`)).body.count).toBe(5);
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`/v2/exchanges/${PAIR}${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
    });

    // -- limit --

    it('limit is 200 by default, at most 400; below one is the default, a decimal is cut, NaN is an error', async () => {
      const cases: [string, number][] = [
        ['', 200],
        ['limit=1', 1],
        ['limit=7', 7],
        ['limit=400', 400],
        ['limit=401', 400],
        ['limit=100000', 400],
        ['limit=Infinity', 400],
        ['limit=0', 200],
        ['limit=-5', 200],
        ['limit=', 200],
        ['limit=2.9', 2],
        ['limit=1e2', 100],
      ];
      for (const [query, rows] of cases) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/exchanges/${PAIR}?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
        expect([query, res.status, paging[0][1]]).toEqual([query, 200, expect.objectContaining({ fetch: rows + 1 })]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, 5)]);
        jest.restoreAllMocks();
      }
      for (const limit of ['abc', 'NaN', '12px', '1,5', '0x', 'one']) {
        const res = await get(`/v2/exchanges/${PAIR}?limit=${limit}`);
        expect([limit, res.status, res.body]).toEqual([limit, 400, { result: 'error', message: 'invalid limit: NaN' }]);
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const last = await get(`/v2/exchanges/${PAIR}?limit=400`);
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();

      // exactly as many as the limit: no marker either
      const exact = await get(`/v2/exchanges/${PAIR}?limit=5`);
      expect(exact.body.count).toBe(5);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      const more = await get(`/v2/exchanges/${PAIR}?limit=4`);
      expect(more.body.count).toBe(4);
      expect(more.body.marker).toBe(markerOf(USD_XRP.rows[3].row));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(`/v2/exchanges/${USD}/XRP${qs({ limit: 2, start: '2013-01-01T00:00:00+00:00' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}/v2/exchanges/${USD}/XRP?limit=2&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`/v2/exchanges/${PAIR}?limit=2&marker=${markerOf(USD_XRP.rows[3].row)}&descending=true`);
      expect(second.headers.link).toBe(
        `<${new URL(second.request.url).origin}/v2/exchanges/${PAIR}?limit=2&marker=${second.body.marker}&descending=true>; rel="next"`,
      );
    });

    // -- marker --

    it('tampered marker → 400 invalid marker', async () => {
      const bad = [
        'USD|rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q|XRP||20150114182720|000011119603|00012|00004',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2]').toString('base64url'),
        Buffer.from('[1,2,3,4]').toString('base64url'),
        Buffer.from('["a",1,2]').toString('base64url'),
        Buffer.from('[-1,0,0]').toString('base64url'),
        Buffer.from('[1,2,70000]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
        `${markerOf(USD_XRP.rows[3].row)}x!`,
      ];
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        for (const marker of bad) {
          const res = await get(`${path}?marker=${encodeURIComponent(marker)}`);
          expect([path, marker, res.status, res.body]).toEqual([
            path,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
    });

    it('a marker continues strictly after its row', async () => {
      const rows = USD_XRP.rows;
      const asc = await get(`/v2/exchanges/${PAIR}?limit=2&marker=${markerOf(rows[1].row)}`);
      expect(hashesIn(asc.body)).toEqual(hashesOf(rows.slice(2, 4)));
      const desc = await get(`/v2/exchanges/${PAIR}?limit=2&descending=true&marker=${markerOf(rows[3].row)}`);
      expect(hashesIn(desc.body)).toEqual(hashesOf([rows[2], rows[1]]));
      // a marker beyond the stored history is still a marker
      const beyond = await get(`/v2/exchanges/${PAIR}?marker=${Buffer.from('[999999999,0,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      // the node of the row is part of the key: two exchanges of one transaction
      const sameTx = USD_XRP.rows.filter((e) => e.row.ledger_index === 11119603);
      expect(sameTx).toHaveLength(2);
      const nextNode = await get(`/v2/exchanges/${PAIR}?limit=1&marker=${markerOf(sameTx[0].row)}`);
      expect(hashesIn(nextNode.body)).toEqual(hashesOf([sameTx[1]]));
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?start=2030-01-01&marker=${markerOf(USD_XRP.rows[1].row)}`);
      expect(res.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('is 500 unable to retrieve exchanges when the database fails', async () => {
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const res = await get(path);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve exchanges' });
      }
    });

    it('is 500 unable to retrieve exchanges when the page fails after the range was found', async () => {
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(Table.Exchanges) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([
          path,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- CSV --------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one row per exchange, the columns of the original in its order', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename=exchanges - USD-XRP.csv');
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 5);
      expect(rows[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      // the first row, cell by cell: what the pair does not have (the issuer of XRP, autobridging) is empty
      const e = USD_XRP.rows[0].row;
      const cells: Record<string, string | number> = {
        base_currency: 'USD',
        base_issuer: USD_ISSUER,
        base_amount: e.base_amount,
        counter_amount: e.counter_amount,
        counter_currency: 'XRP',
        counter_issuer: '',
        rate: new BigNumber(e.rate).toPrecision(8),
        executed_time: executedTime(e.close_time),
        ledger_index: e.ledger_index,
        buyer: e.buyer,
        seller: e.seller,
        taker: e.taker,
        provider: e.provider,
        autobridged_currency: '',
        autobridged_issuer: '',
        offer_sequence: e.offer_sequence,
        tx_type: e.tx_type,
        tx_index: e.tx_index,
        node_index: e.node_index,
        tx_hash: e.tx_hash,
      };
      expect(rows[1]).toBe(CSV_COLUMNS.map((c) => `"${cells[c]}"`).join(','));
    });

    it('is named after the pair as it was asked for: exchanges - BASE-COUNTER', async () => {
      const reversed = await get(`/v2/exchanges/xrp/${USD}?format=csv`);
      expect(reversed.headers['content-disposition']).toBe('attachment; filename=exchanges - XRP-USD.csv');
      // the first row is the same exchange, the other way round
      const header = lines(reversed.text)[0].split(',');
      expect(header).toEqual(CSV_COLUMNS.map((c) => `"${c}"`));
      const row = lines(reversed.text)[1].split(',');
      expect(row[0]).toBe('"XRP"');
      expect(row[1]).toBe('""');
      expect(row[4]).toBe('"USD"');
      expect(row[5]).toBe(`"${USD_ISSUER}"`);
      expect(row[2]).toBe(`"${USD_XRP.rows[0].row.counter_amount}"`);
    });

    it('has the columns of every row, whatever the first one has', async () => {
      // CNY/EUR has no autobridged exchanges, the pair of the first row may differ from the others in what it holds
      const m = MARKETS[0];
      const res = await get(`/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?format=csv&limit=400`);
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + m.rows.length);
      for (const row of rows.slice(1)) expect(row.split(',')).toHaveLength(CSV_COLUMNS.length);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/exchanges/${PAIR}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get(`/v2/exchanges/${PAIR}?format=csv&limit=2`);
      const json = await get(`/v2/exchanges/${PAIR}?limit=2`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/exchanges/${PAIR}?format=csv&limit=2&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 2);
      expect((await get(`/v2/exchanges/${PAIR}?format=csv&limit=400`)).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`/v2/exchanges/${PAIR}?format=csv&start=2030-01-01`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/exchanges/USD/XRP?format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'base issuer is required' });
    });
  });

  // -- every pair --------------------------------------------------------------------------------------------------

  describe('/v2/exchanges (all pairs)', () => {
    it('lists every exchange of the stored ledgers, oldest first, as stored (never inverted)', async () => {
      const res = await get('/v2/exchanges?limit=400');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(158);
      expect(res.body.marker).toBeUndefined();
      expect(res.body.exchanges).toEqual(exchangesOf(ALL));
      // the order is the one of the ledger, not that of the pairs
      const keys = (res.body as ListBody).exchanges.map((e) => [e.ledger_index, e.tx_index, e.node_index] as number[]);
      expect(keys).toEqual([...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
      expect(
        new Set((res.body as ListBody).exchanges.map((e) => `${e.base_currency}/${e.counter_currency}`)).size,
      ).toBeGreaterThan(10);
    });

    it('serves each exchange with the pair it is stored under: base and counter in canonical order', async () => {
      const res = await get('/v2/exchanges?limit=400');
      for (const [i, ex] of (res.body as ListBody).exchanges.entries()) {
        expect([i, ex.base_currency, ex.base_issuer, ex.counter_currency, ex.counter_issuer]).toEqual([
          i,
          ALL[i].row.base_currency,
          ALL[i].row.base_issuer || undefined,
          ALL[i].row.counter_currency,
          ALL[i].row.counter_issuer || undefined,
        ]);
      }
    });

    it('is result, count, marker, exchanges; the default page is 200', async () => {
      const first = await get('/v2/exchanges');
      expect(first.body.count).toBe(158);
      expect(Object.keys(first.body)).toEqual(['result', 'count', 'exchanges']);
      const paged = await get('/v2/exchanges?limit=10');
      expect(Object.keys(paged.body)).toEqual(['result', 'count', 'marker', 'exchanges']);
    });

    it('limit is 200 by default, at most 400; NaN is an error', async () => {
      for (const [query, rows] of [
        ['', 200],
        ['limit=7', 7],
        ['limit=1000', 400],
        ['limit=0', 200],
      ] as [string, number][]) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/exchanges?${query}`);
        const paging = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
        expect([query, res.status, paging[0][1]]).toEqual([query, 200, expect.objectContaining({ fetch: rows + 1 })]);
        jest.restoreAllMocks();
      }
      const bad = await get('/v2/exchanges?limit=abc');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid limit: NaN' }]);
    });

    it('marker pages concatenate to unpaged list', async () => {
      const unpaged = await get('/v2/exchanges?limit=400');
      const paged = await pages('/v2/exchanges', 7);
      expect(paged.slice(0, -1).every((p) => p.count === 7 && p.marker !== undefined)).toBe(true);
      expect(paged[paged.length - 1].marker).toBeUndefined();
      expect(paged.flatMap((p) => p.exchanges)).toEqual(unpaged.body.exchanges);
      // the marker is the key of the last row of the page
      expect(paged[0].marker).toBe(markerOf(ALL[6].row));
    });

    it('descending reverses order, and its markers continue downwards', async () => {
      const asc = await get('/v2/exchanges?limit=400');
      const desc = await get('/v2/exchanges?limit=400&descending=true');
      expect(desc.body.exchanges).toEqual([...asc.body.exchanges].reverse());
      const paged = await pages('/v2/exchanges?descending=true', 9);
      expect(paged.flatMap((p) => p.exchanges)).toEqual(desc.body.exchanges);
    });

    it('start and end select the ledgers that closed within them; empty range → count 0', async () => {
      const window = { start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:51:40Z' };
      const res = await get(`/v2/exchanges${qs({ ...window, limit: 400 })}`);
      const expected = closedBetween(ALL, '2015-01-14T18:28:40', '2015-01-14T18:51:41');
      expect(expected.length).toBeGreaterThan(5);
      expect(expected.length).toBeLessThan(ALL.length);
      expect(hashesIn(res.body)).toEqual(hashesOf(expected));
      expect((await pages(`/v2/exchanges${qs(window)}`, 5)).flatMap(hashesIn)).toEqual(hashesOf(expected));
      const none = await get('/v2/exchanges?start=2030-01-01&end=2030-12-31');
      expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('the checks: start, end, limit, then the marker; unknown params ignored', async () => {
      const cases: [string, string][] = [
        [`/v2/exchanges${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'invalid start date format'],
        [`/v2/exchanges${qs({ end: 'y', limit: 'z', marker: '!' })}`, 'invalid end date format'],
        [`/v2/exchanges${qs({ limit: 'z', marker: '!' })}`, 'invalid limit: NaN'],
        [`/v2/exchanges${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
      const plain = await get('/v2/exchanges?limit=5');
      expect((await get('/v2/exchanges?limit=5&foo=bar')).body).toEqual(plain.body);
    });

    it('reads exchanges in one query on the ledger range, ordered by the ledger key, without FINAL', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`/v2/exchanges?limit=3&marker=${markerOf(ALL[10].row)}`);
      const paging = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
      expect(paging).toHaveLength(1);
      const sql = String(paging[0][0]);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).toContain('(ledger_index, tx_index, node_index) > (');
      expect(sql).toContain('ORDER BY ledger_index ASC, tx_index ASC, node_index ASC');
      expect(sql).toContain('LIMIT 1 BY ledger_index, tx_index, node_index');
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(sql).not.toMatch(/base_currency =/);
      expect(paging[0][1]).toMatchObject({ fetch: 4 });
    });

    it('format=csv gives the same columns, named exchanges.csv', async () => {
      const res = await get('/v2/exchanges?format=csv&limit=400');
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename=exchanges.csv');
      const rows = res.text.split('\n');
      expect(rows).toHaveLength(1 + 158);
      expect(rows[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      const paged = await get('/v2/exchanges?format=csv&limit=3');
      expect(paged.headers.link).toBe(
        `<${new URL(paged.request.url).origin}/v2/exchanges?format=csv&limit=3&marker=${markerOf(ALL[2].row)}>; rel="next"`,
      );
    });
  });
});

describe('exchanges API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const counts = new Map<number, number>();
  for (const e of ALL) counts.set(e.row.ledger_index, (counts.get(e.row.ledger_index) ?? 0) + 1);
  const LEDGER = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const written = ALL.filter((e) => e.row.ledger_index === LEDGER);
  const closeTime = written[0].row.close_time;
  const second = new Date(closeTime * 1000).toISOString().slice(0, 19);
  const window = `?start=${second}&end=${second}`;
  const inWindow = closedBetween(ALL, second, new Date(closeTime * 1000 + 1000).toISOString().slice(0, 19));
  // the pair with the most exchanges in that ledger
  const pairCounts = marketsOf(written).sort((a, b) => b.rows.length - a.rows.length)[0];
  const market = MARKETS.find(
    (m) => pathOf(m.base) === pathOf(pairCounts.base) && pathOf(m.counter) === pathOf(pairCounts.counter),
  ) as Market;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
    );
    expect(Number(n)).toBe(written.length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every exchange of a pair once', async () => {
    expect(market.rows.filter((e) => e.row.ledger_index === LEDGER).length).toBeGreaterThan(1);
    const path = `/v2/exchanges/${pathOf(market.base)}/${pathOf(market.counter)}`;
    const unpaged = await get(`${path}?limit=400`);
    expect(unpaged.body.exchanges).toEqual(exchangesOf(market.rows));
    // and a page cut inside the duplicates neither repeats nor skips a row
    for (const limit of [1, 2, 3]) {
      const paged = (await pages(path, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(market.rows)]);
    }
    const desc = await pages(`${path}?descending=true`, 2);
    expect(desc.flatMap(hashesIn)).toEqual(hashesOf(market.rows).reverse());
    // the other way round too
    const inverted = await get(`/v2/exchanges/${pathOf(market.counter)}/${pathOf(market.base)}?limit=400`);
    expect(inverted.body.exchanges).toEqual(exchangesOf(market.rows, true));
  });

  it('lists every exchange of the window once, in all pairs', async () => {
    expect(written.length).toBeGreaterThan(2);
    const unpaged = await get(`/v2/exchanges${window}&limit=400`);
    expect(unpaged.body.exchanges).toEqual(exchangesOf(inWindow));
    for (const limit of [1, 2, 3, 5]) {
      const paged = (await pages(`/v2/exchanges${window}`, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(inWindow)]);
    }
  });

  it('counts every exchange once in the whole list', async () => {
    const res = await get('/v2/exchanges?limit=400');
    expect(res.body.count).toBe(158);
    expect(hashesIn(res.body)).toEqual(hashesOf(ALL));
  });
});

describe('exchanges API endpoint on the xrpl-recorded ledgers (autobridged exchanges)', () => {
  const seed = 'xrpl-recorded';
  const all = [...fixtureExchanges(seed)].sort(byKey);
  const markets = marketsOf(all);
  const autobridged = all.filter((e) => e.row.autobridged_currency !== null);
  // the pair that has both kinds
  const mixed = markets.find(
    (m) =>
      m.rows.some((e) => e.row.autobridged_currency !== null) &&
      m.rows.some((e) => e.row.autobridged_currency === null),
  ) as Market;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the recorded ledgers hold 20 exchanges, two of them autobridged', () => {
    expect(all).toHaveLength(20);
    expect(autobridged).toHaveLength(2);
    expect(mixed.rows.length).toBeGreaterThan(2);
  });

  it('serves the autobridged currency and issuer, in the place of the f family', async () => {
    const path = `/v2/exchanges/${pathOf(mixed.base)}/${pathOf(mixed.counter)}?limit=400`;
    const res = await get(path);
    expect(res.body.exchanges).toEqual(exchangesOf(mixed.rows));
    const bridged = (res.body as ListBody).exchanges.filter((e) => 'autobridged_currency' in e);
    expect(bridged).toHaveLength(1);
    expect(Object.keys(bridged[0]).slice(5, 8)).toEqual(['autobridged_currency', 'autobridged_issuer', 'buyer']);
    expect(bridged[0].autobridged_currency).toBe(
      mixed.rows.find((e) => e.row.autobridged_currency !== null)?.row.autobridged_currency,
    );
  });

  it('autobridged=true keeps only the exchanges that have an autobridged currency', async () => {
    const path = `/v2/exchanges/${pathOf(mixed.base)}/${pathOf(mixed.counter)}`;
    const on = await get(`${path}?autobridged=true`);
    const expected = mixed.rows.filter((e) => e.row.autobridged_currency !== null);
    expect(expected).toHaveLength(1);
    expect(on.body.exchanges).toEqual(exchangesOf(expected));
    // /true/i, like the other flags; anything else leaves them all
    expect((await get(`${path}?autobridged=TRUE`)).body.exchanges).toEqual(exchangesOf(expected));
    for (const flag of ['false', '1', '']) {
      expect([flag, (await get(`${path}?autobridged=${flag}`)).body.count]).toEqual([flag, mixed.rows.length]);
    }
    // inverted, and a pair without autobridged exchanges is empty
    expect(
      (await get(`/v2/exchanges/${pathOf(mixed.counter)}/${pathOf(mixed.base)}?autobridged=true`)).body.exchanges,
    ).toEqual(exchangesOf(expected, true));
    const plain = markets.find((m) => m.rows.every((e) => e.row.autobridged_currency === null)) as Market;
    const none = await get(`/v2/exchanges/${pathOf(plain.base)}/${pathOf(plain.counter)}?autobridged=true`);
    expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
  });

  it('autobridged=true pages: the marker continues inside the filtered rows', async () => {
    const both = (await pages('/v2/exchanges?autobridged=true', 1)).flatMap(hashesIn);
    expect(both).toEqual(hashesOf(autobridged));
    expect((await get('/v2/exchanges?autobridged=true&limit=400')).body.exchanges).toEqual(exchangesOf(autobridged));
  });

  it('the CSV has the autobridged columns filled for those rows only', async () => {
    const res = await get('/v2/exchanges?autobridged=true&format=csv');
    const rows = res.text.split('\n');
    expect(rows).toHaveLength(1 + 2);
    const header = rows[0].split(',');
    const at = header.indexOf('"autobridged_currency"');
    for (const [i, e] of autobridged.entries()) {
      const cells = rows[1 + i].split(',');
      expect(cells[at]).toBe(`"${e.row.autobridged_currency}"`);
      expect(cells[at + 1]).toBe(`"${e.row.autobridged_issuer}"`);
    }
  });

  it('hex currency codes are served as stored and found in any case', async () => {
    const hex = markets.find((m) => m.base.currency.length === 40) as Market;
    const path = `/v2/exchanges/${pathOf(hex.base)}/XRP?limit=400`;
    const res = await get(path);
    expect(res.body.exchanges).toEqual(exchangesOf(hex.rows));
    const lower = await get(`/v2/exchanges/${hex.base.currency.toLowerCase()}+${hex.base.issuer}/xrp?limit=400`);
    expect(lower.body.exchanges).toEqual(exchangesOf(hex.rows));
    // an issued currency that is called XAH is an ordinary currency on the XRP ledger
    const xah = await get(`/v2/exchanges/XAH+rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv/XRP`);
    expect(xah.body.count).toBe(1);
  });
});

describe('exchanges API endpoint on Xahau (synthetic rows: the recorded ledgers hold no exchange)', () => {
  const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  const ledgers = fixtureSource('xahau-recorded').list();
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const rows: ExchangesRow[] = [];

  /** An exchange of USD+ISSUER (base) for XAH (counter), the canonical order: 'usd…' sorts before 'xahundefined'. */
  function row(ledgerPos: number, txIndex: number, over: Partial<ExchangesRow> = {}): ExchangesRow {
    const ledger = ledgers[ledgerPos];
    return {
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XAH',
      counter_issuer: '',
      ledger_index: ledger.header.ledger_index,
      tx_index: txIndex,
      node_index: 2,
      tx_hash: `${txIndex}`.padStart(64, 'A'),
      close_time: ledger.header.close_time,
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
      offer_sequence: 12,
      autobridged_currency: null,
      autobridged_issuer: null,
      tx_type: 'OfferCreate',
      client: null,
      ...over,
    };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    rows.push(
      row(1, 3),
      row(1, 9, { rate: '4', base_amount: '5', counter_amount: '20' }),
      row(3, 1, { rate: '0.5', counter_amount: '5' }),
    );
    await h.ch.insert(Table.Exchanges, rows);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('XAH is the native currency of the pair: no issuer on it, and the reversed pair is inverted', async () => {
    const res = await api.ok<ListBody>(`/v2/exchanges/USD+${ISSUER}/XAH`, 'exchanges');
    expect(res.body.count).toBe(3);
    expect(hashesIn(res.body)).toEqual(rows.map((r) => r.tx_hash));
    expect(res.body.exchanges[0]).toMatchObject({
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XAH',
      base_amount: '10',
      counter_amount: '25',
      rate: '2.5000000',
    });
    expect(res.body.exchanges[0]).not.toHaveProperty('counter_issuer');
    const reversed = await api.ok<ListBody>(`/v2/exchanges/xah/USD+${ISSUER}`, 'exchanges');
    expect(hashesIn(reversed.body)).toEqual(rows.map((r) => r.tx_hash));
    expect(reversed.body.exchanges[0]).toMatchObject({
      base_currency: 'XAH',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      base_amount: '25',
      counter_amount: '10',
      buyer: rows[0].seller,
      seller: rows[0].buyer,
      rate: '0.40000000',
    });
    expect(reversed.body.exchanges[0]).not.toHaveProperty('base_issuer');
    expect(reversed.body.exchanges[1].rate).toBe('0.25000000');
    expect(reversed.body.exchanges[2].rate).toBe('2.0000000');
  });

  it('XAH takes the place of XRP: XRP needs an issuer, XAH cannot have one', async () => {
    const xrp = await get(`/v2/exchanges/USD+${ISSUER}/XRP`);
    expect([xrp.status, xrp.body]).toEqual([400, { result: 'error', message: 'counter issuer is required' }]);
    const withIssuer = await get(`/v2/exchanges/USD+${ISSUER}/XAH+${ISSUER}`);
    expect([withIssuer.status, withIssuer.body]).toEqual([
      400,
      { result: 'error', message: 'XAH cannot have an issuer' },
    ]);
    // an issued currency that is called XRP on Xahau is an ordinary (empty) market
    const issued = await get(`/v2/exchanges/USD+${ISSUER}/XRP+${ISSUER}`);
    expect([issued.status, issued.body.count]).toEqual([200, 0]);
  });

  it('a window of the recorded ledgers, the markers, the all-pairs list', async () => {
    const mid = rows[2].close_time;
    const from = executedTime(mid).slice(0, 19);
    const window = await get(`/v2/exchanges/USD+${ISSUER}/XAH?start=${from}`);
    expect(window.body.exchanges.map((e: { tx_hash: string }) => e.tx_hash)).toEqual([rows[2].tx_hash]);
    const paged = await api.pages<ListBody>(`/v2/exchanges/USD+${ISSUER}/XAH`, 1, 'exchanges');
    expect(paged.flatMap(hashesIn)).toEqual(rows.map((r) => r.tx_hash));
    const all = await get('/v2/exchanges');
    expect(all.body.count).toBe(3);
    expect(all.body.exchanges[0]).toMatchObject({ base_currency: 'USD', counter_currency: 'XAH' });
    expect((await get('/v2/exchanges?start=2030-01-01')).body.count).toBe(0);
  });

  it('format=csv is named after the pair', async () => {
    const res = await get(`/v2/exchanges/xah/USD+${ISSUER}?format=csv`);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename=exchanges - XAH-USD.csv');
    expect(res.text.split('\n')).toHaveLength(1 + 3);
  });
});

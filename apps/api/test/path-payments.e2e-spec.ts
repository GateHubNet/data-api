import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';

/**
 * `GET /v2/path_payments` on a real ClickHouse, seeded with the mainnet ledgers recorded around path payments
 * (`xrpl-path-payments`, see the fixtures README): one path payment of each kind and the payments that are not path
 * payments. Every expected row below was read off the metadata by hand (balances before and after, the fee taken out).
 *
 * A path payment (GLOSSARY.md) is a successful payment whose delivery used someone else's liquidity: an offer, an AMM
 * pool, or an account other than the delivered currency's issuer rippling between its trust lines.
 */

/** XRP for RLUSD through one order-book offer; an unfunded offer the payment removed on the way is not counted. */
const THROUGH_THE_BOOK = {
  hash: '2DD69A5FB706C325BEB11EF19B177EFEFE0597823E4474996BB3C35FE38715E3',
  ledger_index: 107872476,
  executed_time: '2026-10-24T13:45:51Z',
  source: 'rajCZLPm7AnGJrQRwiuJHN1xZw5KLAvQTe',
  destination: 'raJmzfum8TF4eR4cBkSiMAmKJHwAQKNZNT',
  delivered_amount: '0.2121364558499999',
  currency: '524C555344000000000000000000000000000000',
  issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
  source_amount: '0.165495',
  source_currency: 'XRP',
  offers_crossed: 1,
  amm_pools: [],
  rippled_through: [],
};

/** XRP for DIP through the XRP/DIP pool alone (the `Paths` field names the book, which the pool filled). */
const THROUGH_A_POOL = {
  hash: '8AFED3CFAFC890BF399AC789450A0122BB01293F4982C4CA67A25F33A776B6C9',
  ledger_index: 107873024,
  executed_time: '2026-10-24T14:21:42Z',
  source: 'rPP3R33zpehB5hTy2jSYZek5ntq3HQym68',
  destination: 'rUgpReijx3tRpW7s1AcP14uGvET3bxTtBj',
  delivered_amount: '16538.3324944',
  currency: 'DIP',
  issuer: 'rUmZDci9VKj9BgiBCE9TsLpypERU6jJqxR',
  source_amount: '0.075143',
  source_currency: 'XRP',
  offers_crossed: 0,
  amm_pools: ['rfjo7KfG7MepXCaFFxYT3B81auTKViu2kd'],
  rippled_through: [],
};

/**
 * USD of Bitstamp (rvYAf...) in, USD of SnapSwap (rMwj...) out: the market maker rP7J... holds both and ripples 1 USD
 * from one line to the other. Bitstamp, which only passes its own USD from the source to the market maker (0.2%
 * transfer fee included), is an issuer, not a market maker, and is not listed.
 */
const THROUGH_A_MARKET_MAKER = {
  hash: 'E362675D8230B1A615C9BF53BC0B288F3AAA36CDF8D4D3E3EE8A681966BE8397',
  ledger_index: 11999941,
  executed_time: '2015-03-01T11:13:10Z',
  source: 'rLD5UcXZYgnhp12ivLZvpRx3JBBmz9PrvA',
  destination: 'rGhsEo2jCEp2k46Zx1arv9t7U5KTTUr4QV',
  delivered_amount: '1',
  currency: 'USD',
  issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
  source_amount: '1.002',
  source_currency: 'USD',
  source_issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
  offers_crossed: 0,
  amm_pools: [],
  rippled_through: ['rP7JWWD4zgm3GX1szbghTi2NXUniitWAKV'],
};

/**
 * An arbitrage round trip to oneself through the XRP/WLV pool rEXkm..., in two payments of one ledger: XRP to WLV, then WLV
 * back to XRP. Each is a payment to oneself through a pool, which /v2/payments leaves out. In the second the WLV issuer
 * rMhk9... only passes its own currency from the source to the pool, so it is not listed as rippled through.
 */
const ROUND_TRIP_OUT = {
  hash: '4FA4CA051B7AADE70B5139570BEF9A7BE97659B6B6F670609E45AC11CD30F991',
  ledger_index: 107873048,
  executed_time: '2026-10-24T14:23:20Z',
  source: 'rNGUbAW6iVBN7nYgRUnmDrpBNHYGVT3j2M',
  destination: 'rNGUbAW6iVBN7nYgRUnmDrpBNHYGVT3j2M',
  delivered_amount: '494276.9094338',
  currency: '57424C5600000000000000000000000000000000',
  issuer: 'rMhk9GPrsoWWAgWB4ai9QrELm8G1rMDySM',
  source_amount: '0.962535',
  source_currency: 'XRP',
  offers_crossed: 0,
  amm_pools: ['rEXkmSGLAEi26qzbWWU1tKxb9HCrFAXsYh'],
  rippled_through: [],
};
const ROUND_TRIP_BACK = {
  hash: '04D90AD7ABB8FCED1FD5C6B4092EA534904BEEF2990D21A101DD6C661FD013B8',
  ledger_index: 107873048,
  executed_time: '2026-10-24T14:23:20Z',
  source: 'rNGUbAW6iVBN7nYgRUnmDrpBNHYGVT3j2M',
  destination: 'rNGUbAW6iVBN7nYgRUnmDrpBNHYGVT3j2M',
  delivered_amount: '0.956085',
  currency: 'XRP',
  source_amount: '494328.2283635',
  source_currency: '57424C5600000000000000000000000000000000',
  source_issuer: 'rMhk9GPrsoWWAgWB4ai9QrELm8G1rMDySM',
  offers_crossed: 0,
  amm_pools: ['rEXkmSGLAEi26qzbWWU1tKxb9HCrFAXsYh'],
  rippled_through: [],
};

/**
 * XRP to CNY of one issuer, to oneself (a conversion): the XRP/CNY offer of rh2K... and an offer of raX1... that turns
 * CNY of rPT7... into CNY of razq.... The owner of that offer has one CNY line go up and another go down, but it
 * traded through its offer: it is an offer crossed, not an account rippled through.
 */
const TO_ONESELF_ACROSS_ISSUERS = {
  hash: '91F75EC97B9BD4AA72E5E45C75AEBDA3251839C85F0BAE5736FF88B4F8B134B7',
  ledger_index: 37999837,
  executed_time: '2018-04-16T11:18:31Z',
  source: 'r9Gps6fB9YLuZ87rWx7M9TgLAGK2zsz5s6',
  destination: 'r9Gps6fB9YLuZ87rWx7M9TgLAGK2zsz5s6',
  delivered_amount: '630.7873456426324',
  currency: 'CNY',
  issuer: 'razqQKzJRdB4UxFPWf5NEpEG3WMkmwgcXA',
  source_amount: '149.933416',
  source_currency: 'XRP',
  offers_crossed: 2,
  amm_pools: [],
  rippled_through: [],
};

/** $LYNX from one holder to another through its issuer only, without `Paths`: not a path payment. */
const ONLY_THROUGH_THE_ISSUER = '5EA84EE8462DCCE5FEB0D9ED59A0B7D3C7EE6D532307ED12865DB28F0D78D3D4';
/**
 * BTC of razq... from one holder to another through that issuer only, although `Paths` offered routes through XRP order
 * books and three other BTC issuers: the delivery did not use them, so it is not a path payment either.
 */
const UNUSED_PATHS = '1761720BE5F12AE7E26992241E82A521AB3ED1B370C53C8971980E49501AEB10';

/** The keys of a row, in order; the issuers are absent for the native currency. */
const KEYS = [
  'hash',
  'ledger_index',
  'executed_time',
  'source',
  'destination',
  'delivered_amount',
  'currency',
  'issuer',
  'source_amount',
  'source_currency',
  'source_issuer',
  'offers_crossed',
  'amm_pools',
  'rippled_through',
];

interface Row {
  hash: string;
  ledger_index: number;
  executed_time: string;
  [key: string]: unknown;
}
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  path_payments: Row[];
}

/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
const hashesIn = (body: ListBody): string[] => body.path_payments.map((p) => p.hash);

describe('GET /v2/path_payments', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** Every path payment of the seeded ledgers, oldest first. */
  let all: Row[];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'path_payments');
  const find = (hash: string): Row | undefined => all.find((p) => p.hash === hash);

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-path-payments', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    all = (await api.ok<ListBody>('/v2/path_payments?limit=1000', 'path_payments')).body.path_payments;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('what is a path payment', () => {
    it('a payment through the order book, counting the offers it crossed', () => {
      expect(find(THROUGH_THE_BOOK.hash)).toEqual(THROUGH_THE_BOOK);
    });

    it('a payment through an AMM pool', () => {
      expect(find(THROUGH_A_POOL.hash)).toEqual(THROUGH_A_POOL);
    });

    it('a payment rippling through a market maker, which is listed; the issuers it passed are not', () => {
      expect(find(THROUGH_A_MARKET_MAKER.hash)).toEqual(THROUGH_A_MARKET_MAKER);
    });

    it('an arbitrage round trip to oneself through a pool: both payments to oneself are path payments', () => {
      expect(find(ROUND_TRIP_OUT.hash)).toEqual(ROUND_TRIP_OUT);
      expect(find(ROUND_TRIP_BACK.hash)).toEqual(ROUND_TRIP_BACK);
    });

    it('a payment to oneself, converting through offers; an offer between two issuers of a currency is no rippling', () => {
      expect(find(TO_ONESELF_ACROSS_ISSUERS.hash)).toEqual(TO_ONESELF_ACROSS_ISSUERS);
    });

    it('not a payment rippling only through the issuer of the delivered currency', () => {
      expect(find(ONLY_THROUGH_THE_ISSUER)).toBeUndefined();
    });

    it('not a payment whose Paths field went unused', () => {
      expect(find(UNUSED_PATHS)).toBeUndefined();
    });

    it('/v2/payments is unchanged: it lists the negatives and leaves the payments to oneself out', async () => {
      const listed = new Set<string>();
      for (const body of await api.pages<{ marker?: string; payments: { tx_hash: string }[] }>(
        '/v2/payments',
        1000,
        'payments',
      )) {
        for (const p of body.payments) listed.add(p.tx_hash);
      }
      for (const hash of [ONLY_THROUGH_THE_ISSUER, UNUSED_PATHS, THROUGH_THE_BOOK.hash, THROUGH_A_POOL.hash]) {
        expect([hash, listed.has(hash)]).toEqual([hash, true]);
      }
      for (const hash of [TO_ONESELF_ACROSS_ISSUERS.hash, ROUND_TRIP_OUT.hash, ROUND_TRIP_BACK.hash]) {
        expect([hash, listed.has(hash)]).toEqual([hash, false]);
      }
    });
  });

  describe('the row', () => {
    it('has the keys of the spec in order, the issuers left out for the native currency', () => {
      expect(Object.keys(find(THROUGH_A_MARKET_MAKER.hash)!)).toEqual(KEYS);
      expect(Object.keys(find(THROUGH_THE_BOOK.hash)!)).toEqual(KEYS.filter((k) => k !== 'source_issuer'));
      for (const row of all) {
        expect(Object.keys(row)).toEqual(
          KEYS.filter(
            (k) =>
              (k !== 'issuer' || row.currency !== 'XRP') && (k !== 'source_issuer' || row.source_currency !== 'XRP'),
          ),
        );
      }
    });

    it('amounts are strings, the counts numbers, the pools and the accounts lists', () => {
      for (const row of all) {
        expect(typeof row.delivered_amount).toBe('string');
        expect(typeof row.source_amount).toBe('string');
        expect(typeof row.ledger_index).toBe('number');
        expect(typeof row.offers_crossed).toBe('number');
        expect(Array.isArray(row.amm_pools)).toBe(true);
        expect(Array.isArray(row.rippled_through)).toBe(true);
        // and each used someone's liquidity
        expect(
          (row.offers_crossed as number) +
            (row.amm_pools as string[]).length +
            (row.rippled_through as string[]).length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('the list', () => {
    it('is result, count and path_payments, oldest first', async () => {
      const res = await get('/v2/path_payments?limit=1000');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'path_payments']);
      expect(res.body.count).toBe(all.length);
      expect(all.length).toBeGreaterThan(5);
      const ledgers = all.map((p) => p.ledger_index);
      expect(ledgers).toEqual([...ledgers].sort((a, b) => a - b));
      // the seeded ledgers in order: 2015 before 2026
      expect(all.findIndex((p) => p.hash === THROUGH_A_MARKET_MAKER.hash)).toBeLessThan(
        all.findIndex((p) => p.hash === THROUGH_THE_BOOK.hash),
      );
    });

    it('descending reverses the order', async () => {
      const res = await get('/v2/path_payments?limit=1000&descending=true');
      expect(hashesIn(res.body)).toEqual(all.map((p) => p.hash).reverse());
    });

    it('start and end are the ledgers that closed within them', async () => {
      // the ledger of the market maker holds a second, equal payment of the same source
      const res = await get(`/v2/path_payments${qs({ start: '2015-03-01T11:13:10Z', end: '2015-03-01T11:13:10Z' })}`);
      expect(res.body.count).toBe(2);
      expect(res.body.path_payments).toContainEqual(THROUGH_A_MARKET_MAKER);
      expect(hashesIn(res.body)).toEqual(all.filter((p) => p.ledger_index === 11999941).map((p) => p.hash));

      const recent = await get(`/v2/path_payments${qs({ start: '2026-10-24T14:21:42Z', limit: 1000 })}`);
      expect(hashesIn(recent.body)).toEqual(all.filter((p) => p.ledger_index >= 107873024).map((p) => p.hash));
      expect(hashesIn(recent.body)).toContain(THROUGH_A_POOL.hash);

      const empty = await get(`/v2/path_payments${qs({ start: '2020-01-01', end: '2020-12-31' })}`);
      expect(empty.body).toEqual({ result: 'success', count: 0, path_payments: [] });
    });

    it('marker pages concatenate to the unpaged list, with a Link header on every page but the last', async () => {
      for (const limit of [1, 7]) {
        const paged = (await pages('/v2/path_payments', limit)).flatMap(hashesIn);
        expect([limit, paged]).toEqual([limit, all.map((p) => p.hash)]);
      }
      const first = await get('/v2/path_payments?limit=2');
      expect(first.body.count).toBe(2);
      expect(first.body.marker).toEqual(expect.any(String));
      expect(first.headers.link).toContain(`marker=${first.body.marker}`);
      const last = await get(`/v2/path_payments${qs({ start: '2015-03-01T11:13:10Z', end: '2015-03-01T11:13:10Z' })}`);
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();
    });

    it('limit is 200 by default and at most 1000', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/path_payments');
      await get('/v2/path_payments?limit=5000');
      const limits = spy.mock.calls
        .filter(([sql]) => String(sql).includes(Table.PathPayments))
        .map(([, params]) => (params as Record<string, unknown>).distinct_page_limit);
      expect(limits).toEqual([201, 1001]);
    });

    it('rejects an invalid start, end or marker', async () => {
      expect((await get('/v2/path_payments?start=yesterday')).body).toEqual({
        result: 'error',
        message: 'invalid start date format',
      });
      expect((await get('/v2/path_payments?end=2015-13-01')).body).toEqual({
        result: 'error',
        message: 'invalid end date format',
      });
      const res = await get('/v2/path_payments?marker=nope');
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    });

    it('is 500 unable to retrieve path payments when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get('/v2/path_payments');
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve path payments' }]);
    });
  });

  describe('format=csv', () => {
    it('is the file path payments.csv, one row per path payment, the pools and accounts as one cell each', async () => {
      const res = await get(
        `/v2/path_payments${qs({ start: '2015-03-01T11:13:10Z', end: '2015-03-01T11:13:10Z', format: 'csv' })}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('path payments'));
      const lines = res.text.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(KEYS.map((k) => `"${k}"`).join(','));
      expect(lines).toContain(
        [
          THROUGH_A_MARKET_MAKER.hash,
          '11999941',
          '2015-03-01T11:13:10Z',
          'rLD5UcXZYgnhp12ivLZvpRx3JBBmz9PrvA',
          'rGhsEo2jCEp2k46Zx1arv9t7U5KTTUr4QV',
          '1',
          'USD',
          'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
          '1.002',
          'USD',
          'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
          '0',
          '',
          'rP7JWWD4zgm3GX1szbghTi2NXUniitWAKV',
        ]
          .map((cell) => `"${cell}"`)
          .join(','),
      );
    });

    it('has the same rows as the JSON', async () => {
      const res = await get('/v2/path_payments?limit=1000&format=CSV');
      const lines = res.text.split('\n');
      expect(lines.length - 1).toBe(all.length);
      const header = lines[0].split(',').map((c) => c.replace(/"/g, ''));
      const hashAt = header.indexOf('hash');
      expect(lines.slice(1).map((l) => l.split(',')[hashAt].replace(/"/g, ''))).toEqual(all.map((p) => p.hash));
    });
  });
});

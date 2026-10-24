import { Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';

/**
 * `GET /v2/accounts/{address}/path_payments` on a real ClickHouse, seeded with the mainnet ledgers recorded around path
 * payments (`xrpl-path-payments`, see the fixtures README). The rows are those of `GET /v2/path_payments` (whose own
 * suite checks them against the metadata), here the ones the account sent or received.
 */

/**
 * USD of Bitstamp to USD of SnapSwap, rippling through the market maker rP7J... and Bitstamp; its ledger holds a second,
 * equal one.
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
  rippled_through: ['rP7JWWD4zgm3GX1szbghTi2NXUniitWAKV', 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'],
};
const MARKET_MAKER_SOURCE = THROUGH_A_MARKET_MAKER.source;
const MARKET_MAKER_DESTINATION = THROUGH_A_MARKET_MAKER.destination;
const MARKET_MAKER = 'rP7JWWD4zgm3GX1szbghTi2NXUniitWAKV';

/**
 * An arbitrage bot that pays itself through a pool, among them a round trip in two payments of one ledger (107873048),
 * out and back.
 */
const ROUND_TRIPPER = 'rNGUbAW6iVBN7nYgRUnmDrpBNHYGVT3j2M';
const ROUND_TRIP_OUT = '4FA4CA051B7AADE70B5139570BEF9A7BE97659B6B6F670609E45AC11CD30F991';
const ROUND_TRIP_BACK = '04D90AD7ABB8FCED1FD5C6B4092EA534904BEEF2990D21A101DD6C661FD013B8';

interface Row {
  hash: string;
  ledger_index: number;
  source: string;
  destination: string;
  [key: string]: unknown;
}
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  path_payments: Row[];
}

const path = (address: string, query = ''): string => `/v2/accounts/${address}/path_payments${query}`;
const hashesOf = (rows: Row[]): string[] => rows.map((p) => p.hash);

describe('GET /v2/accounts/{address}/path_payments', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** Every path payment of the seeded ledgers, oldest first, from `GET /v2/path_payments`. */
  let all: Row[];
  /** The path payments `address` sent or received, as `GET /v2/path_payments` lists them. */
  const of = (address: string): Row[] => all.filter((p) => p.source === address || p.destination === address);

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-path-payments', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    all = (await api.ok<ListBody>('/v2/path_payments?limit=1000', 'path_payments')).body.path_payments;
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('the accounts of a path payment', () => {
    it('lists the path payments the account sent, as /v2/path_payments has them', async () => {
      const res = await get(path(MARKET_MAKER_SOURCE));
      expect(res.status).toBe(200);
      expect(res.body.path_payments).toContainEqual(THROUGH_A_MARKET_MAKER);
      expect(res.body.path_payments).toEqual(of(MARKET_MAKER_SOURCE));
      expect(res.body.count).toBe(2);
      expect(hashesOf(res.body.path_payments)).toContain(THROUGH_A_MARKET_MAKER.hash);
    });

    it('lists the path payments the account received', async () => {
      const res = await get(path(MARKET_MAKER_DESTINATION));
      expect(res.body.path_payments).toContainEqual(THROUGH_A_MARKET_MAKER);
      expect(res.body.path_payments).toEqual(of(MARKET_MAKER_DESTINATION));
    });

    it('lists a payment to oneself once', async () => {
      const res = await get(path(ROUND_TRIPPER));
      const hashes = hashesOf(res.body.path_payments);
      expect(res.body.path_payments).toEqual(of(ROUND_TRIPPER));
      expect(new Set(hashes).size).toBe(hashes.length);
      expect(hashes.filter((hash) => hash === ROUND_TRIP_OUT || hash === ROUND_TRIP_BACK)).toEqual([
        ROUND_TRIP_OUT,
        ROUND_TRIP_BACK,
      ]);
      for (const row of res.body.path_payments)
        expect([row.source, row.destination]).toEqual([ROUND_TRIPPER, ROUND_TRIPPER]);
    });

    it('does not list an account the payment only rippled through', async () => {
      const res = await get(path(MARKET_MAKER));
      expect(res.body).toEqual({ result: 'success', count: 0, path_payments: [] });
    });

    it('answers an empty list for an address that is none, as the other lists under an account', async () => {
      const res = await get(path('nope'));
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, path_payments: [] }]);
    });
  });

  describe('the list', () => {
    it('is result, count and path_payments, oldest first; descending reverses it', async () => {
      const res = await get(path(ROUND_TRIPPER));
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'path_payments']);
      const ledgers = res.body.path_payments.map((p: Row) => p.ledger_index);
      expect(ledgers).toEqual([...ledgers].sort((a, b) => a - b));
      expect(new Set(ledgers).size).toBeGreaterThan(1);
      const desc = await get(path(ROUND_TRIPPER, '?descending=true'));
      expect(hashesOf(desc.body.path_payments)).toEqual(hashesOf(res.body.path_payments).reverse());
    });

    it('start and end are the ledgers that closed within them', async () => {
      const at = (start: string, end: string) => get(path(ROUND_TRIPPER, `?start=${start}&end=${end}`));
      // the ledger of the round trip, 107873048, the newest seeded, closed at 14:23:20
      const inLedger = (await at('2026-10-24T14:23:20Z', '2026-10-24T14:23:20Z')).body.path_payments;
      expect(hashesOf(inLedger)).toEqual(hashesOf(of(ROUND_TRIPPER).filter((p) => p.ledger_index === 107873048)));
      expect(hashesOf(inLedger)).toEqual(expect.arrayContaining([ROUND_TRIP_OUT, ROUND_TRIP_BACK]));
      expect((await at('2026-10-24T14:23:21Z', '2026-10-25')).body).toEqual({
        result: 'success',
        count: 0,
        path_payments: [],
      });
      const before = (await at('2015-01-01', '2026-10-24T14:23:19Z')).body.path_payments;
      expect(hashesOf(before)).toEqual(hashesOf(of(ROUND_TRIPPER).filter((p) => p.ledger_index < 107873048)));
    });

    it('marker pages concatenate to the unpaged list, with a Link header on every page but the last', async () => {
      for (const address of [ROUND_TRIPPER, MARKET_MAKER_SOURCE]) {
        for (const descending of [false, true]) {
          const paged = (
            await api.pages<ListBody>(path(address, `?descending=${descending}`), 1, 'path_payments')
          ).flatMap((body) => hashesOf(body.path_payments));
          const whole = hashesOf(of(address));
          expect([address, descending, paged]).toEqual([address, descending, descending ? whole.reverse() : whole]);
        }
      }
      const first = await get(path(MARKET_MAKER_SOURCE, '?limit=1'));
      expect([first.body.count, hashesOf(first.body.path_payments)]).toEqual([
        1,
        hashesOf(of(MARKET_MAKER_SOURCE)).slice(0, 1),
      ]);
      expect(first.headers.link).toContain(`marker=${first.body.marker}`);
      const last = await get(path(MARKET_MAKER_SOURCE, `?limit=1&marker=${first.body.marker}`));
      expect(hashesOf(last.body.path_payments)).toEqual(hashesOf(of(MARKET_MAKER_SOURCE)).slice(1));
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();
    });

    it('limit is 200 by default and at most 1000', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      try {
        await get(path(ROUND_TRIPPER));
        await get(path(ROUND_TRIPPER, '?limit=5000'));
        const limits = spy.mock.calls
          .filter(([sql]) => String(sql).includes(Table.AccountPathPayments))
          .map(([, params]) => (params as Record<string, unknown>).distinct_page_limit);
        expect(limits).toEqual([201, 1001]);
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects an invalid start, end or marker', async () => {
      expect((await get(path(ROUND_TRIPPER, '?start=yesterday'))).body).toEqual({
        result: 'error',
        message: 'invalid start date format',
      });
      expect((await get(path(ROUND_TRIPPER, '?end=2015-13-01'))).body).toEqual({
        result: 'error',
        message: 'invalid end date format',
      });
      const res = await get(path(ROUND_TRIPPER, '?marker=nope'));
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    });

    it('is 500 unable to retrieve path payments when the database fails', async () => {
      const spy = jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await get(path(ROUND_TRIPPER));
        expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve path payments' }]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('format=csv', () => {
    it('is the file <address> - path payments.csv with the rows of the JSON, each list one cell', async () => {
      const res = await get(path(MARKET_MAKER_SOURCE, '?format=csv'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${MARKET_MAKER_SOURCE} - path payments`));
      const lines = res.text.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(
        Object.keys(THROUGH_A_MARKET_MAKER)
          .map((k) => `"${k}"`)
          .join(','),
      );
      expect(lines).toContain(
        Object.values(THROUGH_A_MARKET_MAKER)
          .map((v) => `"${Array.isArray(v) ? v.join(' ') : v}"`)
          .join(','),
      );
    });
  });
});

describe('GET /v2/accounts/{address}/path_payments, a ledger written twice', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-path-payments' });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists each path payment once', async () => {
    const api = await h.api();
    const before = (await api.ok<ListBody>(path(ROUND_TRIPPER), 'path_payments')).body;
    for (const table of [Table.AccountPathPayments, Table.PathPayments]) {
      await h.ch.command(`INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {index:UInt32}`, {
        index: 107873048,
      });
    }
    const after = (await api.ok<ListBody>(path(ROUND_TRIPPER), 'path_payments')).body;
    expect(after).toEqual(before);
    expect(hashesOf(after.path_payments)).toEqual(expect.arrayContaining([ROUND_TRIP_OUT, ROUND_TRIP_BACK]));
  });
});

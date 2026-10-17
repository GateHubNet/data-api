import { AccountExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureAccountExchanges, fixtureExchanges, fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead, innerRead } from './support/plans';

/**
 * `GET /v2/accounts/:address/exchanges[/:base[/:counter]]` on a real ClickHouse, seeded with the 54 ledgers of the
 * original Ripple test suite (`ripple-mock`: 158 exchanges, 316 rows of `account_exchanges` for 53 accounts, 6 of them
 * with a `client`) and with the Xahau ledgers recorded from a public node (no exchanges at all).
 *
 * Ported from rippled-historical-database `test/test.account.exchanges.js` (all 10 `it`s, none skipped). Eight keep
 * the original's title word for word; the two that share one title there ('should make sure
 * /accounts/:account/exhanges/:curr handles currency correctly', once for `jpy` and once for `BTC`) are told apart
 * here with a suffix, '(jpy)' and '(BTC)'. Three of them lean on HBase and are ported to what this API holds instead:
 *  - the two 'handles pagination correctly' walk the exchanges of the account one by one with `limit=1` and compare
 *    each with the unpaged list, as `utils.checkPagination` does; only the marker is this API's. The original ran the
 *    same walk twice, the second being "descending" in the title only (its URL never sent `descending=true`); this
 *    port's '(descending)' walk does send it, and also checks that it is the ascending list the other way round;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`rHsZ…|20150114185210|000011119940|00009|00001`); the marker of this API is the `(ledger_index, tx_index,
 *    node_index)` of the last row of the page.
 *
 * Fixed and added: `/:base` and `/:base/:counter` filter in either orientation (the original compared with the pair as
 * stored, so the reverse of a stored pair found nothing); the exchanges are those of `/v2/exchanges` (inverted the
 * same way when the asked-for side is the stored counter) plus the `client`; issuer addresses are validated (R33); the
 * shared list behaviour (empty range, marker pages, descending, unknown params, limits), CSV and its file name, the
 * query and its plan, rows that were written twice, the failure paths and Xahau.
 */

const MULTI = 'rfZ4YjC4CyaKFx9cgzYNKk4E2zTXRJif26'; // 15 exchanges in 12 pairs, as buyer and as seller
const REFERENCE = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg'; // the account of the original's tests: 5 exchanges
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';
const MWJ = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const KICE = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
const NUF = 'rnuF96W4SZoCJmbHYBFoJZpR8eCaxNvekK';

interface Key {
  ledger_index: number;
  tx_index: number;
  node_index: number;
}
const byKey = (a: Key, b: Key): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;
const keyOf = (r: Key): string => `${r.ledger_index}:${r.tx_index}:${r.node_index}`;

/** Every row of `account_exchanges`, in the order of the list. */
const ROWS = [...fixtureAccountExchanges('ripple-mock')].sort(
  (a, b) => byKey(a, b) || (a.account < b.account ? -1 : 1),
);
const STORED = fixtureExchanges('ripple-mock').map((e) => e.row);
const rowsOf = (account: string): AccountExchangesRow[] => ROWS.filter((r) => r.account === account);
const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))];
const CLIENT = new Map(STORED.map((r) => [keyOf(r), r.client]));
const WITH_CLIENT = ROWS.filter((r) => r.client !== null).map((r) => r.account);

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** `YYYY-MM-DDTHH:mm:ss` of unix seconds. */
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19);
const closedBetween = (rows: AccountExchangesRow[], from: string, before: string): AccountExchangesRow[] =>
  rows.filter((r) => r.close_time >= unix(from) && r.close_time < unix(before));

/** The marker of a row: `(ledger_index, tx_index, node_index)` as base64url JSON. */
const markerOf = (row: Key): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index, row.node_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

type Exchange = Record<string, unknown> & {
  tx_hash: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
};
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  exchanges: Exchange[];
}
const keysIn = (body: ListBody): string[] => body.exchanges.map((e) => keyOf(e));
const keysOf = (rows: Key[]): string[] => rows.map(keyOf);
const path = (account: string, filter = ''): string => `/v2/accounts/${account}/exchanges${filter}`;

/** An asset of a row, as the path writes it. */
const assetPath = (currency: string, issuer: string): string => (issuer === '' ? currency : `${currency}+${issuer}`);

interface Filter {
  currency?: string;
  issuer?: string;
}
type Side = { currency: string; issuer: string };
/** Whether an asset of a row is what the filter asks for (a part that is not given matches anything). */
const matches = (side: Side, f?: Filter): boolean =>
  f === undefined ||
  ((f.currency === undefined || side.currency === f.currency) && (f.issuer === undefined || side.issuer === f.issuer));
const baseOf = (r: AccountExchangesRow): Side => ({ currency: r.base_currency, issuer: r.base_issuer });
const counterOf = (r: AccountExchangesRow): Side => ({ currency: r.counter_currency, issuer: r.counter_issuer });

describe('account exchanges API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** Every exchange as `/v2/exchanges` serves it (the pair as stored), by key. */
  const stored = new Map<string, Exchange>();
  /** Every exchange as `/v2/exchanges/:counter/:base` serves it (inverted), by key. */
  const inverted = new Map<string, Exchange>();
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'exchanges');

  /** What the account route serves for a row: the exchange of `/v2/exchanges`, plus the client when it has one. */
  const served = (row: AccountExchangesRow, invert: boolean): Exchange => {
    const item = (invert ? inverted : stored).get(keyOf(row)) as Exchange;
    const client = CLIENT.get(keyOf(row));
    return { ...item, ...(client !== null && client !== undefined && { client }) };
  };
  /** The list the filter asks for: the rows that match it in either orientation, inverted when only the reverse does. */
  const expectedFor = (
    account: string,
    base?: Filter,
    counter?: Filter,
  ): { row: AccountExchangesRow; invert: boolean }[] =>
    rowsOf(account)
      .map((row) => ({
        row,
        asStored: matches(baseOf(row), base) && matches(counterOf(row), counter),
        reversed: matches(counterOf(row), base) && matches(baseOf(row), counter),
      }))
      .filter((r) => r.asStored || r.reversed)
      .map((r) => ({ row: r.row, invert: !r.asStored }));
  const itemsFor = (account: string, base?: Filter, counter?: Filter): Exchange[] =>
    expectedFor(account, base, counter).map((r) => served(r.row, r.invert));

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const page of await api.pages<ListBody>('/v2/exchanges', 400, 'exchanges')) {
      for (const e of page.exchanges) stored.set(keyOf(e), e);
    }
    expect(stored.size).toBe(STORED.length);
    // the exchanges of every stored pair, read from the other side
    const pairs = new Set(
      STORED.map(
        (r) => `${assetPath(r.counter_currency, r.counter_issuer)}/${assetPath(r.base_currency, r.base_issuer)}`,
      ),
    );
    for (const pair of pairs) {
      for (const page of await api.pages<ListBody>(`/v2/exchanges/${pair}`, 400, 'exchanges')) {
        for (const e of page.exchanges) inverted.set(keyOf(e), e);
      }
    }
    expect(inverted.size).toBe(STORED.length);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.account.exchanges.js -----------------------------------------------------------------------------------

  it('should make sure /accounts/:account/exhanges handles limit correctly', async () => {
    const res = await get(`${path(REFERENCE)}?limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    expect(res.body.exchanges.length).toBe(5);
  });

  it('should make sure /accounts/:account/exhanges handles dates correctly', async () => {
    const start = '2015-01-14T18:52:00';
    const end = '2015-01-14T19:00:00';
    const res = await get(`${path(REFERENCE)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(res.body.exchanges.length).not.toBe(0); // make sure we test something
    for (const exch of (res.body as ListBody).exchanges) {
      const d = Date.parse(exch.executed_time as string);
      expect(d > Date.parse(`${start}Z`) && d < Date.parse(`${end}Z`)).toBe(true);
    }
    expect(keysIn(res.body)).toEqual(keysOf(closedBetween(rowsOf(REFERENCE), start, '2015-01-14T19:00:01')));
    expect(res.body.count).toBe(3);
  });

  it('should make sure /accounts/:account/exhanges/:curr handles currency correctly (jpy)', async () => {
    const res = await get(`${path(REFERENCE, '/jpy')}`);
    expect(res.status).toBe(200);
    expect(res.body.exchanges.length).not.toBe(0); // make sure we test something
    for (const exch of (res.body as ListBody).exchanges) expect(exch.base_currency).toBe('JPY');
    expect(res.body.exchanges).toEqual(itemsFor(REFERENCE, { currency: 'JPY' }));
  });

  it('should make sure /accounts/:account/exhanges/:curr handles currency correctly (BTC)', async () => {
    const res = await get(`${path(REFERENCE, '/BTC')}`);
    expect(res.status).toBe(200);
    expect(res.body.exchanges.length).not.toBe(0);
    for (const exch of (res.body as ListBody).exchanges) expect(exch.base_currency).toBe('BTC');
    expect(res.body.exchanges).toEqual(itemsFor(REFERENCE, { currency: 'BTC' }));
    expect(res.body.count).toBe(3);
  });

  it('should make sure /accounts/:account/exhanges/:curr-iss/:counter handles parameters correctly', async () => {
    const res = await get(`${path(REFERENCE, `/USD+${MWJ}/xrp`)}`);
    expect(res.status).toBe(200);
    expect(res.body.exchanges.length).not.toBe(0);
    for (const exch of (res.body as ListBody).exchanges) {
      expect(exch.base_currency).toBe('USD');
      expect(exch.base_issuer).toBe(MWJ);
      expect(exch.counter_currency).toBe('XRP');
    }
    expect(res.body.count).toBe(1);
  });

  it('should make sure /accounts/:account/exhanges handles pagination correctly', async () => {
    const url = path(REFERENCE);
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1);

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}?limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.exchanges.length).toBe(1);
      expect(res.body.exchanges[0].base_amount).toBe(ref.body.exchanges[i].base_amount);
      expect(res.body.exchanges[0].base_currency).toBe(ref.body.exchanges[i].base_currency);
      expect(res.body.exchanges[0].tx_hash).toBe(ref.body.exchanges[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should make sure /accounts/:account/exhanges handles pagination correctly (descending)', async () => {
    const url = `${path(REFERENCE)}?descending=true`;
    const ref = await get(url);
    expect(ref.body.count).toBeGreaterThan(1);
    const walked = (await pages(url, 1)).flatMap((p) => p.exchanges);
    expect(walked.length).toBe(ref.body.count);
    walked.forEach((e, i) => {
      expect(e.base_amount).toBe(ref.body.exchanges[i].base_amount);
      expect(e.base_currency).toBe(ref.body.exchanges[i].base_currency);
      expect(e.tx_hash).toBe(ref.body.exchanges[i].tx_hash);
    });
    // and it is the ascending list the other way round
    const asc = await get(path(REFERENCE));
    expect(walked).toEqual([...asc.body.exchanges].reverse());
  });

  it('should make sure /accounts/:account/exchanges handles empty response correctly', async () => {
    const res = await get(path(NOBODY));
    expect(res.status).toBe(200);
    expect(res.body.exchanges.length).toBe(0);
    expect(res.body.count).toBe(0);
  });

  it('should include a link header when marker is present', async () => {
    const url = `${path(REFERENCE)}?limit=2`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(markerOf(rowsOf(REFERENCE)[1]));
    expect(res.headers.link).toBe(`<${new URL(res.request.url).origin}${url}&marker=${res.body.marker}>; rel="next"`);
  });

  // -- the Exchange ---------------------------------------------------------------------------------------------------

  describe('the exchanges of an account', () => {
    it('are the exchanges of /v2/exchanges plus the client, whole and in order, for every account of the ledgers', async () => {
      expect(ACCOUNTS.length).toBe(53);
      let total = 0;
      for (const account of ACCOUNTS) {
        const res = await get(`${path(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        const rows = rowsOf(account);
        expect([account, keysIn(res.body)]).toEqual([account, keysOf(rows)]);
        expect([account, res.body.exchanges]).toEqual([account, rows.map((r) => served(r, false))]);
        total += res.body.count;
      }
      // an exchange is listed under its buyer and under its seller (once when they are one)
      expect(total).toBe(ROWS.length);
      expect(ROWS.length).toBe(2 * STORED.length);
    });

    it('have the keys of the original: the d family, then the f family (the pair among them), each sorted by name', async () => {
      const res = await get(`${path(MULTI)}?limit=1000`);
      for (const e of (res.body as ListBody).exchanges) {
        expect(Object.keys(e)).toEqual(
          [
            'base_amount',
            'counter_amount',
            'node_index',
            'rate',
            'tx_index',
            'autobridged_currency',
            'autobridged_issuer',
            'base_currency',
            'base_issuer',
            'buyer',
            'counter_currency',
            'counter_issuer',
            'executed_time',
            'ledger_index',
            'offer_sequence',
            'provider',
            'seller',
            'taker',
            'tx_hash',
            'tx_type',
          ].filter((k) => k in e),
        );
      }
      // the pair is in the f family, not at the end as /v2/exchanges has it
      const keys = Object.keys(res.body.exchanges[0]);
      expect(keys.indexOf('base_currency')).toBeLessThan(keys.indexOf('buyer'));
      expect(keys.indexOf('counter_currency')).toBeGreaterThan(keys.indexOf('buyer'));
    });

    it('serve the client of an exchange that has one, and leave it out of the others', async () => {
      expect(new Set(WITH_CLIENT).size).toBe(6);
      for (const account of new Set(WITH_CLIENT)) {
        const res = await get(`${path(account)}?limit=1000`);
        const rows = rowsOf(account);
        expect(rows.some((r) => r.client !== null)).toBe(true);
        res.body.exchanges.forEach((e: Exchange, i: number) => {
          if (rows[i].client === null) expect(e).not.toHaveProperty('client');
          else expect(e.client).toBe(rows[i].client);
        });
      }
      // between the buyer and the f family order: after `buyer`, before `counter_currency`
      const clientRow = ROWS.find((r) => r.client !== null) as AccountExchangesRow;
      const res = await get(
        `${path(clientRow.account)}${qs({ start: iso(clientRow.close_time), end: iso(clientRow.close_time) })}`,
      );
      const keys = Object.keys(res.body.exchanges.find((e: Exchange) => 'client' in e));
      expect(keys.indexOf('client')).toBe(keys.indexOf('buyer') + 1);
      expect(keys.indexOf('client') + 1).toBe(keys.indexOf('counter_currency'));
    });

    it('amounts and rate are strings (the rate to eight digits), the indexes numbers, the time YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get(`${path(REFERENCE)}?limit=1000`);
      for (const e of (res.body as ListBody).exchanges) {
        for (const field of ['base_amount', 'counter_amount', 'rate']) expect(typeof e[field]).toBe('string');
        for (const field of ['ledger_index', 'tx_index', 'node_index', 'offer_sequence']) {
          expect(typeof e[field]).toBe('number');
        }
        expect(e.executed_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      }
      expect(res.body.exchanges[0]).toMatchObject({
        base_currency: 'JPY',
        base_issuer: 'r94s8px6kSw1uZ1MV98dhSRTvc6VMPoPcN',
        counter_currency: 'XRP',
        base_amount: '1.60832052',
        counter_amount: '0.8973',
        rate: '0.55791118',
        executed_time: '2015-01-14T18:28:00Z',
      });
      expect(res.body.exchanges[0]).not.toHaveProperty('counter_issuer');
    });

    it('have the envelope result, count, marker, exchanges', async () => {
      const res = await get(`${path(MULTI)}?limit=2`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'exchanges']);
      const all = await get(`${path(MULTI)}?limit=1000`);
      expect(Object.keys(all.body)).toEqual(['result', 'count', 'exchanges']);
    });

    it('an address that is none, or has no exchanges, is an empty list (the address is not checked)', async () => {
      for (const account of ['nonsense', NOBODY, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh']) {
        const res = await get(path(account));
        expect([account, res.status, res.body]).toEqual([account, 200, { result: 'success', count: 0, exchanges: [] }]);
      }
    });
  });

  // -- /:base and /:base/:counter ---------------------------------------------------------------------------------------

  describe('/:base and /:base/:counter', () => {
    it('a base alone lists the exchanges of the asset on either side, the asset always as the base', async () => {
      const cases: [string, Filter][] = [
        ['XRP', { currency: 'XRP' }],
        ['xrp', { currency: 'XRP' }],
        ['CNY', { currency: 'CNY' }],
        ['JPY', { currency: 'JPY' }],
        [`EUR+${MWJ}`, { currency: 'EUR', issuer: MWJ }],
        [`CNY+${NUF}`, { currency: 'CNY', issuer: NUF }],
        [`USD.${MWJ}`, { currency: 'USD', issuer: MWJ }],
        [`btc|${MWJ}`, { currency: 'BTC', issuer: MWJ }],
        ['NOPE', { currency: 'NOPE' }],
      ];
      for (const [asset, filter] of cases) {
        const res = await get(`${path(MULTI, `/${asset}`)}?limit=1000`);
        expect([asset, res.status]).toEqual([asset, 200]);
        expect([asset, res.body.exchanges]).toEqual([asset, itemsFor(MULTI, filter)]);
        // the asset is the base of every row, however it was stored
        for (const e of (res.body as ListBody).exchanges) expect(e.base_currency).toBe(filter.currency);
      }
      // both orientations really are there: EUR is the base of one stored pair and the counter of another
      const eur = await get(`${path(MULTI, `/EUR+${MWJ}`)}?limit=1000`);
      const sides = expectedFor(MULTI, { currency: 'EUR', issuer: MWJ }).map((r) => r.invert);
      expect(new Set(sides)).toEqual(new Set([true, false]));
      expect(eur.body.count).toBe(sides.length);
    });

    it('a pair lists the exchanges of the pair as asked for, inverted when it is stored the other way round', async () => {
      const usdXrp = { currency: 'USD', issuer: MWJ };
      const xrp = { currency: 'XRP' };
      const asStored = await get(`${path(MULTI, `/USD+${MWJ}/XRP`)}?limit=1000`);
      expect(asStored.body.count).toBe(2);
      expect(asStored.body.exchanges).toEqual(itemsFor(MULTI, usdXrp, xrp));
      for (const e of (asStored.body as ListBody).exchanges) {
        expect([e.base_currency, e.counter_currency]).toEqual(['USD', 'XRP']);
      }

      // the reverse of a stored pair: the original found nothing, now the same exchanges, inverted
      const reversed = await get(`${path(MULTI, `/XRP/USD+${MWJ}`)}?limit=1000`);
      expect(reversed.body.count).toBe(2);
      expect(reversed.body.exchanges).toEqual(itemsFor(MULTI, xrp, usdXrp));
      expect(keysIn(reversed.body)).toEqual(keysIn(asStored.body));
      reversed.body.exchanges.forEach((e: Exchange, i: number) => {
        const o = asStored.body.exchanges[i] as Exchange;
        expect([e.base_currency, e.counter_currency]).toEqual(['XRP', 'USD']);
        expect(e).not.toHaveProperty('base_issuer');
        expect(e.counter_issuer).toBe(MWJ);
        expect([e.base_amount, e.counter_amount]).toEqual([o.counter_amount, o.base_amount]);
        expect([e.buyer, e.seller]).toEqual([o.seller, o.buyer]);
        expect(e.taker).toBe(o.taker);
        expect(e.rate).not.toBe(o.rate);
      });
    });

    it('every pair of the account lists the same exchanges in both orders, one as stored and one inverted', async () => {
      const pairs = new Map<string, AccountExchangesRow>();
      for (const r of rowsOf(MULTI))
        pairs.set(`${assetPath(r.base_currency, r.base_issuer)}/${assetPath(r.counter_currency, r.counter_issuer)}`, r);
      expect(pairs.size).toBe(12);
      for (const [pair, row] of pairs) {
        const [base, counter] = pair.split('/');
        const direct = await get(`${path(MULTI, `/${pair}`)}?limit=1000`);
        const reverse = await get(`${path(MULTI, `/${counter}/${base}`)}?limit=1000`);
        const expected = rowsOf(MULTI).filter(
          (r) =>
            baseOf(r).currency === row.base_currency &&
            baseOf(r).issuer === row.base_issuer &&
            counterOf(r).currency === row.counter_currency &&
            counterOf(r).issuer === row.counter_issuer,
        );
        expect([pair, direct.body.exchanges]).toEqual([pair, expected.map((r) => served(r, false))]);
        expect([pair, reverse.body.exchanges]).toEqual([pair, expected.map((r) => served(r, true))]);
      }
    });

    it('a currency without its issuer is any issuer of it; both sides may do so', async () => {
      const cnyJpy = await get(`${path(MULTI, '/cny/jpy')}?limit=1000`);
      expect(cnyJpy.body.exchanges).toEqual(itemsFor(MULTI, { currency: 'CNY' }, { currency: 'JPY' }));
      expect(cnyJpy.body.count).toBe(3);
      const jpyCny = await get(`${path(MULTI, '/jpy/cny')}?limit=1000`);
      expect(jpyCny.body.exchanges).toEqual(itemsFor(MULTI, { currency: 'JPY' }, { currency: 'CNY' }));
      expect(keysIn(jpyCny.body)).toEqual(keysIn(cnyJpy.body));
      // one issuer of CNY against any JPY
      const kice = await get(`${path(MULTI, `/CNY+${KICE}/JPY`)}?limit=1000`);
      expect(kice.body.exchanges).toEqual(itemsFor(MULTI, { currency: 'CNY', issuer: KICE }, { currency: 'JPY' }));
      expect(kice.body.count).toBe(1);
    });

    it('a pair of one currency with two issuers is found in both orders', async () => {
      const a = { currency: 'CNY', issuer: KICE };
      const b = { currency: 'CNY', issuer: NUF };
      const stored$ = await get(`${path(MULTI, `/CNY+${KICE}/CNY+${NUF}`)}?limit=1000`);
      const reverse = await get(`${path(MULTI, `/CNY+${NUF}/CNY+${KICE}`)}?limit=1000`);
      expect(stored$.body.count).toBe(2);
      expect(stored$.body.exchanges).toEqual(itemsFor(MULTI, a, b));
      expect(reverse.body.exchanges).toEqual(itemsFor(MULTI, b, a));
      expect(keysIn(reverse.body)).toEqual(keysIn(stored$.body));
      for (const e of (reverse.body as ListBody).exchanges) expect(e.base_issuer).toBe(NUF);
    });

    it('a pair that the account has not traded, or never existed, is an empty list', async () => {
      for (const filter of [
        `/XRP/BTC+${NUF}`,
        '/XRP/XRP',
        `/USD+${KICE}/XRP`,
        '/NOPE/XRP',
        '/XRP/NOPE',
        // the native currency has no issuer: with one it matches nothing, and it is no 400 (a filter, not a pair)
        `/XRP+${KICE}`,
        `/USD+${MWJ}/XRP+${KICE}`,
      ]) {
        const res = await get(path(MULTI, filter));
        expect([filter, res.status, res.body]).toEqual([filter, 200, { result: 'success', count: 0, exchanges: [] }]);
      }
    });

    it('a currency alone or a pair is not required to name issuers (no "issuer is required")', async () => {
      for (const filter of ['/USD', '/USD/XRP', '/xrp/usd', '/USD/EUR']) {
        expect([filter, (await get(path(MULTI, filter))).status]).toEqual([filter, 200]);
      }
    });

    it('the paths split at +, | or . and the currencies are upper-cased; the issuer is as written', async () => {
      const plus = await get(`${path(MULTI, `/usd+${MWJ}/xrp`)}?limit=1000`);
      for (const sep of ['.', '|']) {
        const res = await get(`${path(MULTI, `/USD${sep === '|' ? '%7C' : sep}${MWJ}/xrp`)}?limit=1000`);
        expect([sep, res.body]).toEqual([sep, plus.body]);
      }
      expect(plus.body.count).toBe(2);
    });

    it('pages and windows work on a filtered list', async () => {
      const filter = '/XRP';
      const unpaged = await get(`${path(MULTI, filter)}?limit=1000`);
      expect(unpaged.body.count).toBeGreaterThan(5);
      expect((await pages(path(MULTI, filter), 2)).flatMap((p) => p.exchanges)).toEqual(unpaged.body.exchanges);
      const desc = await get(`${path(MULTI, filter)}?limit=1000&descending=true`);
      expect(desc.body.exchanges).toEqual([...unpaged.body.exchanges].reverse());
      expect((await pages(`${path(MULTI, filter)}?descending=true`, 3)).flatMap((p) => p.exchanges)).toEqual(
        desc.body.exchanges,
      );
      const window = `${path(MULTI, filter)}?start=2015-01-14T18:28:40&end=2015-01-14T18:28:40`;
      const inWindow = closedBetween(rowsOf(MULTI), '2015-01-14T18:28:40', '2015-01-14T18:28:41').filter(
        (r) => r.counter_currency === 'XRP' || r.base_currency === 'XRP',
      );
      expect(keysIn((await get(`${window}&limit=1000`)).body)).toEqual(keysOf(inWindow));
    });
  });

  // -- errors ----------------------------------------------------------------------------------------------------------

  describe('a request that is not valid', () => {
    it('an issuer that is not an address → invalid base/counter issuer address (R33)', async () => {
      const cases: [string, string][] = [
        ['/USD+nonsense', 'invalid base issuer address'],
        ['/USD+nonsense/XRP', 'invalid base issuer address'],
        [`/USD+${MWJ}/EUR+nonsense`, 'invalid counter issuer address'],
        ['/XRP/EUR+r', 'invalid counter issuer address'],
        ['/USD+nonsense/EUR+nonsense', 'invalid base issuer address'],
      ];
      for (const [filter, message] of cases) {
        const res = await get(path(MULTI, filter));
        expect([filter, res.status, res.body]).toEqual([filter, 400, { result: 'error', message }]);
      }
    });

    it("the checks come in the order of the original's routes: the pair, start, end, then the marker", async () => {
      const cases: [string, string, string][] = [
        ['/USD+nonsense', 'start=x&end=y&marker=!!!', 'invalid base issuer address'],
        ['', 'start=x&end=y&marker=!!!', 'invalid start date format'],
        ['', 'end=y&marker=!!!', 'invalid end date format'],
        ['', 'marker=!!!', 'invalid marker'],
      ];
      for (const [filter, query, message] of cases) {
        const res = await get(`${path(MULTI, filter)}?${query}`);
        expect([filter, query, res.status, res.body]).toEqual([filter, query, 400, { result: 'error', message }]);
      }
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`${path(MULTI)}${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
      const end = await get(`${path(MULTI)}?end=`);
      expect([end.status, end.body.message]).toEqual([400, 'invalid end date format']);
    });

    it('tampered marker → 400 invalid marker, also for a list that is empty', async () => {
      const bad = [
        'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg|20150114185210|000011119940|00009|00001',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1,2]').toString('base64url'),
        Buffer.from('[1,2,3,4]').toString('base64url'),
        Buffer.from('["a",1,1]').toString('base64url'),
        Buffer.from('[1,1,70000]').toString('base64url'),
        Buffer.from('[1,1,-1]').toString('base64url'),
      ];
      for (const account of [MULTI, NOBODY]) {
        for (const marker of bad) {
          const res = await get(`${path(account)}?marker=${encodeURIComponent(marker)}`);
          expect([account, marker, res.status, res.body]).toEqual([
            account,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
    });
  });

  // -- the list --------------------------------------------------------------------------------------------------------

  describe('the list', () => {
    const FILTERS = ['', '/XRP', `/USD+${MWJ}/XRP`];

    it('empty range → count 0', async () => {
      for (const filter of FILTERS) {
        const res = await get(`${path(MULTI, filter)}?start=2030-01-01&end=2030-12-31`);
        expect([filter, res.status, res.body]).toEqual([filter, 200, { result: 'success', count: 0, exchanges: [] }]);
        expect(res.headers.link).toBeUndefined();
      }
      expect((await get(`${path(MULTI)}?end=2013-06-01`)).body.count).toBe(0);
      expect((await get(`${path(MULTI)}?start=1015-01-14T18:00:00&end=1970-01-14T18:30:00`)).body.count).toBe(0);
      expect((await get(`${path(MULTI)}?start=2030-01-01&marker=${markerOf(ROWS[3])}`)).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      for (const filter of FILTERS) {
        const unpaged = await get(`${path(MULTI, filter)}?limit=1000`);
        expect(unpaged.body.count).toBeGreaterThan(1);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();
        const paged = await pages(path(MULTI, filter), 1);
        expect(paged.slice(0, -1).every((p) => p.count === 1 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([filter, paged.flatMap((p) => p.exchanges)]).toEqual([filter, unpaged.body.exchanges]);
      }
      const unpaged = await get(`${path(MULTI)}?limit=1000`);
      expect((await pages(path(MULTI), 4)).flatMap((p) => p.exchanges)).toEqual(unpaged.body.exchanges);
    });

    it('descending reverses order', async () => {
      for (const filter of FILTERS) {
        const asc = await get(`${path(MULTI, filter)}?limit=1000`);
        const desc = await get(`${path(MULTI, filter)}?limit=1000&descending=true`);
        expect([filter, desc.body.exchanges]).toEqual([filter, [...asc.body.exchanges].reverse()]);
      }
      const walked = await pages(`${path(MULTI)}?descending=true`, 4);
      expect(walked.flatMap(keysIn)).toEqual(keysOf(rowsOf(MULTI)).reverse());
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get(`${path(MULTI)}?limit=5`);
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`${path(MULTI)}?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get(`${path(MULTI)}?limit=5&descending=true`);
      expect((await get(`${path(MULTI)}?limit=5&descending=TRUE`)).body).toEqual(desc.body);
      expect(keysIn(desc.body)).toEqual(keysOf(rowsOf(MULTI).slice(-5).reverse()));
    });

    it('unknown params ignored (the exchange params of /v2/exchanges are not params of this route)', async () => {
      const plain = await get(`${path(MULTI)}?limit=5`);
      const res = await get(`${path(MULTI)}?limit=5&foo=bar&interval=day&reduce=true&autobridged=true`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get(`${path(MULTI)}?limit=3&limit=50&descending=true&descending=false`);
      expect(res.body.count).toBe(3);
      expect(keysIn(res.body)).toEqual(keysOf(rowsOf(MULTI).slice(-3).reverse()));
    });

    it('start defaults to 2013-01-01; an empty start is the default', async () => {
      const all = await get(`${path(MULTI)}?limit=1000`);
      expect((await get(`${path(MULTI)}?limit=1000&start=`)).body).toEqual(all.body);
      expect((await get(`${path(MULTI)}?limit=1000&start=2013-01-01`)).body).toEqual(all.body);
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-01-14T18:28:40', end: '2015-01-14T18:28:40' }, '2015-01-14T18:28:40', '2015-01-14T18:28:41'],
        [{ start: '2015-01-14T18:27:40Z' }, '2015-01-14T18:27:40', '2100-01-01T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ end: '2015-01' }, '2000-01-01T00:00:00', '2015-02-01T00:00:00'],
        [{ start: '2015-01-14', end: '2015-01-14' }, '2015-01-14T00:00:00', '2015-01-15T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const listed = (await pages(`${path(MULTI)}${qs(params)}`, 100)).flatMap(keysIn);
        const expected = closedBetween(rowsOf(MULTI), from, before);
        expect(expected.length).toBeGreaterThan(0);
        expect([params, listed]).toEqual([params, keysOf(expected)]);
      }
    });

    it('limit is 200 by default, at most 1000; below one or not a number it is the default (no "invalid limit")', async () => {
      const cases: [string, number][] = [
        ['', 200],
        ['limit=1', 1],
        ['limit=7', 7],
        ['limit=1000', 1000],
        ['limit=1001', 1000],
        ['limit=100000', 1000],
        ['limit=0', 200],
        ['limit=-5', 200],
        ['limit=abc', 200],
        ['limit=', 200],
        ['limit=2.9', 2],
      ];
      for (const [query, rows] of cases) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`${path(MULTI)}?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => String(q).includes(Table.AccountExchanges));
        expect([query, res.status, paging[0][1]]).toEqual([
          query,
          200,
          expect.objectContaining({ distinct_page_limit: rows + 1 }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, rowsOf(MULTI).length)]);
        jest.restoreAllMocks();
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const rows = rowsOf(MULTI);
      const exact = await get(`${path(MULTI)}?limit=${rows.length}`);
      expect(exact.body.count).toBe(rows.length);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();
      const more = await get(`${path(MULTI)}?limit=${rows.length - 1}`);
      expect(more.body.marker).toBe(markerOf(rows[rows.length - 2]));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the path with its filter, the params in their order, the marker in place or at the end', async () => {
      const filter = `/USD+${MWJ}/XRP`;
      const first = await get(`${path(MULTI, filter)}${qs({ limit: 1, start: '2013-01-01T00:00:00+00:00' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}${path(MULTI, filter)}?limit=1&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`${path(MULTI, filter)}?limit=1&marker=${first.body.marker}&descending=false`);
      expect(second.headers.link).toBeUndefined();
      const third = await get(`${path(MULTI)}?limit=2&marker=${markerOf(rowsOf(MULTI)[1])}&descending=true`);
      expect(third.headers.link).toBeUndefined();
      const fourth = await get(`${path(MULTI)}?limit=1&marker=${markerOf(rowsOf(MULTI)[4])}&descending=true`);
      expect(fourth.headers.link).toBe(
        `<${origin}${path(MULTI)}?limit=1&marker=${fourth.body.marker}&descending=true>; rel="next"`,
      );
    });

    it('a marker continues strictly after its row', async () => {
      const rows = rowsOf(MULTI);
      const at = rows[6];
      const asc = await get(`${path(MULTI)}?limit=3&marker=${markerOf(at)}`);
      expect(keysIn(asc.body)).toEqual(keysOf(rows.slice(7, 10)));
      const desc = await get(`${path(MULTI)}?limit=3&descending=true&marker=${markerOf(at)}`);
      expect(keysIn(desc.body)).toEqual(keysOf([rows[5], rows[4], rows[3]]));
      const beyond = await get(`${path(MULTI)}?marker=${Buffer.from('[999999999,0,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('the marker of a page cut inside a transaction continues with its next node', async () => {
      // two exchanges of one transaction differ in node_index only
      const shared = ROWS.filter((r) =>
        ROWS.some(
          (o) =>
            o.account === r.account &&
            o.ledger_index === r.ledger_index &&
            o.tx_index === r.tx_index &&
            o.node_index !== r.node_index,
        ),
      );
      expect(shared.length).toBeGreaterThan(0);
      const account = shared[0].account;
      const own = rowsOf(account);
      expect((await pages(path(account), 1)).flatMap(keysIn)).toEqual(keysOf(own));
      expect((await pages(`${path(account)}?descending=true`, 1)).flatMap(keysIn)).toEqual(keysOf(own).reverse());
      const [first, second] = own.filter(
        (r) => r.ledger_index === shared[0].ledger_index && r.tx_index === shared[0].tx_index,
      );
      const next = await get(`${path(account)}?limit=1&marker=${markerOf(first)}`);
      expect(keysIn(next.body)).toEqual([keyOf(second)]);
    });
  });

  // -- what is read ----------------------------------------------------------------------------------------------------

  describe('the query', () => {
    const paging = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => String(q).includes(Table.AccountExchanges))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);

    it('reads account_exchanges, which holds the whole row, and never the exchanges table', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`${path(MULTI, `/USD+${MWJ}/XRP`)}?limit=4`);
      expect(res.status).toBe(200);
      const calls = paging(spy);
      expect(calls).toHaveLength(1);
      const [sql, params] = calls[0];
      expect(sql).not.toMatch(new RegExp(`FROM ${Table.Exchanges}\\b`));
      expect(sql).toMatch(/account = \{account:String\}/);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      // read with a plain LIMIT, which stops the read after the page (Ruling R106); outside it a row that was written
      // twice counts once
      expect(sql).toMatch(/node_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}\)/);
      expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index, node_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toMatchObject({ account: MULTI, distinct_page_limit: 5 });
      // values are bound, never written into the SQL
      expect(sql).not.toContain(MULTI);
      expect(sql).not.toContain(MWJ);
      expect(Object.values(params)).toEqual(expect.arrayContaining(['USD', MWJ, 'XRP']));
    });

    it('applies the filter only when there is one', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(MULTI)}?limit=2`);
      const [[sql]] = paging(spy);
      expect(sql).not.toMatch(/base_currency =|counter_currency =|base_issuer =|counter_issuer =/);
    });

    it('spells out the whole key in the ORDER BY, ascending and descending', async () => {
      for (const descending of [false, true]) {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`${path(MULTI, '/XRP')}?limit=2&descending=${descending}`);
        const [[sql]] = paging(spy);
        jest.restoreAllMocks();
        const d = descending ? 'DESC' : 'ASC';
        expect(sql).toContain(`ORDER BY account ${d}, ledger_index ${d}, tx_index ${d}, node_index ${d}`);
      }
    });

    it('reads the table in the order of its primary key, so that a page never sorts the whole history', async () => {
      const middle = rowsOf(MULTI)[8];
      const variants = ['', '/XRP', `/USD+${MWJ}/XRP`, '/cny/jpy', `/EUR+${MWJ}`];
      const queries = [
        'limit=5',
        `limit=5&marker=${markerOf(middle)}`,
        'limit=5&start=2015-01-14T18:27:10&end=2015-01-14T18:28:40',
      ];
      for (const descending of [false, true]) {
        for (const filter of variants) {
          for (const query of queries) {
            const spy = jest.spyOn(h.ch, 'query');
            const res = await get(`${path(MULTI, filter)}?${query}&descending=${descending}`);
            expect(res.status).toBe(200);
            const [[sql, params]] = paging(spy);
            jest.restoreAllMocks();

            // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
            await expectBoundedInOrderRead(h, sql, params, descending, [descending, filter, query]);
          }
        }
      }
    });

    it('finds the account through the primary key, not by reading every account', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(MULTI)}?limit=5`);
      const [[sql, params]] = paging(spy);
      jest.restoreAllMocks();
      const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params);
      const text = indexes.map((r) => r.explain).join('\n');
      expect(text).toContain('PrimaryKey');
      expect(text).toMatch(/Keys:[\s│]+account/);
    });

    it('a request the client got wrong reads nothing', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      expect((await get(`${path(MULTI, '/USD+nonsense')}`)).status).toBe(400);
      expect(paging(spy)).toHaveLength(0);
    });
  });

  // -- failures --------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    it('is 500 unable to retrieve exchanges', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(path(MULTI));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve exchanges' }]);
    });

    it('also when the page fails after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql.includes(Table.AccountExchanges)
          ? Promise.reject(new Error('boom'))
          : (real as any)(sql, ...rest)) as never);
      for (const filter of ['', '/XRP', `/USD+${MWJ}/XRP`]) {
        const res = await get(path(MULTI, filter));
        expect([filter, res.status, res.body]).toEqual([
          filter,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
      }
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${path(MULTI)}?start=x`)).status).toBe(400);
      expect((await get(`${path(MULTI)}?marker=!!!`)).status).toBe(400);
      expect((await get(path(MULTI, '/USD+x'))).status).toBe(400);
    });
  });

  // -- CSV -------------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one row per exchange, the columns of /v2/exchanges and the client', async () => {
      const rows = rowsOf(MULTI);
      const res = await get(`${path(MULTI)}?format=csv&limit=1000`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(lines(res.text)).toHaveLength(1 + rows.length);
      // the columns of /v2/exchanges in the order of the original, for every row (an empty cell where it has none)
      expect(lines(res.text)[0].split(',')).toEqual(
        [
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
        ].map((c) => `"${c}"`),
      );
      expect(lines(res.text)[1]).toContain(`"${(stored.get(keyOf(rows[0])) as Exchange).tx_hash}"`);
    });

    it('has a client column when a row has a client, with an empty cell for the others', async () => {
      const account = WITH_CLIENT[0];
      const rows = rowsOf(account);
      expect(rows.some((r) => r.client === null)).toBe(true);
      const res = await get(`${path(account)}?format=csv&limit=1000`);
      const table = lines(res.text).map((l) => l.split(','));
      expect(table[0].at(-1)).toBe('"client"');
      expect(table).toHaveLength(1 + rows.length);
      rows.forEach((r, i) => expect(table[1 + i].at(-1)).toBe(r.client === null ? '""' : `"${r.client}"`));
    });

    it('is named after the account, then the currencies: <address> - exchanges - BASE-COUNTER', async () => {
      const cases: [string, string][] = [
        ['', `${MULTI} - exchanges`],
        ['/xrp', `${MULTI} - exchanges - XRP`],
        [`/usd+${MWJ}/xrp`, `${MULTI} - exchanges - USD-XRP`],
        [`/XRP/USD+${MWJ}`, `${MULTI} - exchanges - XRP-USD`],
      ];
      for (const [filter, name] of cases) {
        const res = await get(`${path(MULTI, filter)}?format=csv`);
        expect([filter, res.headers['content-type']]).toEqual([filter, expect.stringMatching(/^text\/csv/)]);
        expect([filter, res.headers['content-disposition']]).toEqual([filter, csvDisposition(`${name}`)]);
      }
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`${path(MULTI)}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${path(MULTI)}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page', async () => {
      const csv = await get(`${path(MULTI)}?format=csv&limit=3`);
      const json = await get(`${path(MULTI)}?limit=3`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}${path(MULTI)}?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      expect((await get(`${path(MULTI)}?format=csv&limit=1000`)).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`${path(MULTI)}?format=csv&start=2030-01-01`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get(`${path(MULTI, '/USD+x')}?format=csv`);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid base issuer address' });
    });
  });
});

describe('account exchanges API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const rows = rowsOf(MULTI);
  const LEDGER = rows[rows.length - 1].ledger_index;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'exchanges');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountExchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.AccountExchanges} SELECT * FROM ${Table.AccountExchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountExchanges} WHERE ledger_index = {index:UInt32} AND account = {account:String}`,
      { index: LEDGER, account: MULTI },
    );
    expect(Number(n)).toBe(rows.filter((r) => r.ledger_index === LEDGER).length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every exchange once, and a page cut inside the duplicates neither repeats nor skips a row', async () => {
    expect(rows.filter((r) => r.ledger_index === LEDGER).length).toBeGreaterThan(2);
    for (const filter of ['', '/XRP', '/CNY']) {
      const expected = (await get(`${path(MULTI, filter)}?limit=1000`)).body as ListBody;
      expect(expected.count).toBeGreaterThan(0);
      for (const limit of [1, 2, 3]) {
        const walked = (await pages(path(MULTI, filter), limit)).flatMap((p) => p.exchanges);
        expect([filter, limit, walked]).toEqual([filter, limit, expected.exchanges]);
      }
    }
    const all = await get(`${path(MULTI)}?limit=1000`);
    expect(keysIn(all.body)).toEqual(keysOf(rows));
    const desc = await pages(`${path(MULTI)}?descending=true`, 2);
    expect(desc.flatMap(keysIn)).toEqual(keysOf(rows).reverse());
  });
});

describe('account exchanges API endpoint: swaps against AMM pools (amm_account and the amm filter)', () => {
  // The mock ledgers of the original next to the recorded AMM ledgers: a swap is an exchange of its taker and of the
  // pool, and `amm_account` is the pool. The rows of `account_exchanges` are one per participating account.
  const SEED = 'ripple-mock+amm';
  const MODES = ['include', 'exclude', 'only'] as const;
  type Mode = (typeof MODES)[number];
  const MESSAGE = 'invalid amm filter - use: include, exclude, only';
  const ALL_ROWS = [...fixtureAccountExchanges(SEED)].sort(
    (a, b) => byKey(a, b) || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0),
  );
  const isSwap = (r: AccountExchangesRow): boolean => r.amm_account !== '';
  const own = (account: string): AccountExchangesRow[] => ALL_ROWS.filter((r) => r.account === account);
  const kept = (list: AccountExchangesRow[], mode?: Mode): AccountExchangesRow[] =>
    mode === 'exclude' ? list.filter((r) => !isSwap(r)) : mode === 'only' ? list.filter(isSwap) : list;
  const accounts = [...new Set(ALL_ROWS.map((r) => r.account))];
  /** The account that traded most in both ways: the most of the rarer kind, then the most rows. */
  const trader = [...accounts].sort((a, b) => {
    const score = (x: string): number => Math.min(kept(own(x), 'only').length, kept(own(x), 'exclude').length);
    return score(b) - score(a) || own(b).length - own(a).length || (a < b ? -1 : 1);
  })[0];
  /** A pool: every row it has is a swap. */
  const pool = [...new Set(ALL_ROWS.filter(isSwap).map((r) => r.amm_account))].sort(
    (a, b) => own(b).length - own(a).length || (a < b ? -1 : 1),
  )[0];

  const url = (base: string, ...params: string[]): string => {
    const given = params.filter((p) => p !== '');
    return given.length === 0 ? base : `${base}${base.includes('?') ? '&' : '?'}${given.join('&')}`;
  };
  const ammQuery = (mode?: string): string => (mode === undefined ? '' : `amm=${mode}`);

  /**
   * The exchange as the account route serves it, written out: the keys of the HBase row in order (the `d` family, then
   * the `f` family, each sorted by name, with the pair among them), the client when the transaction had one, and last the
   * pool of a swap. `inverted` is the pair asked for the other way round.
   */
  function exchangeOf(row: AccountExchangesRow, inverted = false): Record<string, unknown> {
    const rate = new BigNumber(row.rate);
    const fields: Record<string, unknown> = {
      base_amount: inverted ? row.counter_amount : row.base_amount,
      counter_amount: inverted ? row.base_amount : row.counter_amount,
      node_index: row.node_index,
      rate: (inverted ? new BigNumber(1).dividedBy(rate) : rate).toPrecision(8),
      tx_index: row.tx_index,
      autobridged_currency: row.autobridged_currency ?? undefined,
      autobridged_issuer: row.autobridged_issuer || undefined,
      base_currency: inverted ? row.counter_currency : row.base_currency,
      base_issuer: (inverted ? row.counter_issuer : row.base_issuer) || undefined,
      buyer: inverted ? row.seller : row.buyer,
      client: row.client ?? undefined,
      counter_currency: inverted ? row.base_currency : row.counter_currency,
      counter_issuer: (inverted ? row.base_issuer : row.counter_issuer) || undefined,
      executed_time: `${new Date(row.close_time * 1000).toISOString().slice(0, 19)}Z`,
      ledger_index: row.ledger_index,
      offer_sequence: row.offer_sequence,
      provider: row.provider,
      seller: inverted ? row.buyer : row.seller,
      taker: row.taker,
      tx_hash: row.tx_hash,
      tx_type: row.tx_type,
      amm_account: row.amm_account || undefined,
    };
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  }
  const exchangesOf = (rows: AccountExchangesRow[], inverted = false): Record<string, unknown>[] =>
    rows.map((r) => exchangeOf(r, inverted));

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'exchanges');
  const accountCalls = (spy: jest.SpyInstance): unknown[][] =>
    spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.AccountExchanges}\\b`).test(String(q)));

  beforeAll(async () => {
    h = await startHarness({ seed: SEED, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: an account that traded both ways, and a pool that only has swaps', () => {
    expect(kept(own(trader), 'only').length).toBeGreaterThanOrEqual(2);
    expect(kept(own(trader), 'exclude').length).toBeGreaterThanOrEqual(2);
    expect(own(pool).length).toBeGreaterThanOrEqual(3);
    expect(own(pool).every(isSwap)).toBe(true);
    // a swap is in the list of the pool: the pool is a party of it, and its provider
    for (const r of kept(own(pool))) expect([r.amm_account, r.provider]).toEqual([pool, pool]);
  });

  it('amm unset, include, exclude and only list the exchanges of the account, the order-book ones and the swaps', async () => {
    for (const account of [trader, pool, accounts.find((a) => own(a).every((r) => !isSwap(r))) as string]) {
      for (const mode of [undefined, ...MODES]) {
        const p = url(path(account), 'limit=1000', ammQuery(mode));
        const res = await get(p);
        const want = kept(own(account), mode);
        expect([p, res.status, res.body.count]).toEqual([p, 200, want.length]);
        expect([p, res.body.exchanges]).toEqual([p, exchangesOf(want)]);
      }
    }
    const sets = MODES.map((mode) => kept(own(trader), mode).length);
    expect(sets[0]).toBe(sets[1] + sets[2]);
  });

  it('a pool has no order-book exchange, an account that never swapped has no swap: empty lists', async () => {
    const empty = { result: 'success', count: 0, exchanges: [] };
    expect((await get(`${path(pool)}?amm=exclude`)).body).toEqual(empty);
    const neverSwapped = accounts.find((a) => own(a).every((r) => !isSwap(r))) as string;
    expect((await get(`${path(neverSwapped)}?amm=only`)).body).toEqual(empty);
    expect((await get(`${path(NOBODY)}?amm=only`)).body).toEqual(empty);
  });

  it('is include when amm is missing or empty, and the first of a repeated param counts', async () => {
    const plain = await get(`${path(trader)}?limit=1000`);
    for (const amm of ['amm=', 'amm=include']) {
      expect([amm, (await get(`${path(trader)}?limit=1000&${amm}`)).body]).toEqual([amm, plain.body]);
    }
    expect((await get(`${path(trader)}?amm=only&amm=exclude`)).body.exchanges).toEqual(
      exchangesOf(kept(own(trader), 'only')),
    );
    expect((await get(`${path(trader)}?amm=exclude&amm=nonsense`)).body.exchanges).toEqual(
      exchangesOf(kept(own(trader), 'exclude')),
    );
  });

  describe('the exchange object', () => {
    const D_FAMILY = ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index'];

    it('a swap has amm_account as its last key, after tx_type and the client; an order-book exchange has no such key', async () => {
      const res = await get(`${path(trader)}?limit=1000`);
      const rows = own(trader);
      (res.body as ListBody).exchanges.forEach((ex, i) => {
        const keys = Object.keys(ex);
        expect([i, keys]).toEqual([i, Object.keys(exchangeOf(rows[i]))]);
        expect([i, keys.includes('amm_account'), keys.at(-1) === 'amm_account']).toEqual([
          i,
          isSwap(rows[i]),
          isSwap(rows[i]),
        ]);
        expect([i, keys.at(-1)]).toEqual([i, isSwap(rows[i]) ? 'amm_account' : 'tx_type']);
      });
      // pinned: a swap of an issued currency against the native one
      const swap = kept(own(trader), 'only').find(
        (r) => r.base_issuer !== '' && r.counter_issuer === '',
      ) as AccountExchangesRow;
      const served = (await get(`${path(trader)}?limit=1000&amm=only`)).body as ListBody;
      const at = kept(own(trader), 'only').indexOf(swap);
      expect(Object.keys(served.exchanges[at])).toEqual([
        ...D_FAMILY,
        ...(swap.autobridged_currency !== null ? ['autobridged_currency', 'autobridged_issuer'] : []),
        'base_currency',
        'base_issuer',
        'buyer',
        'counter_currency',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'amm_account',
      ]);
    });

    it('is the same pool in both orientations of a pair filter, and last', async () => {
      const swap = kept(own(trader), 'only')[0];
      const base = `${swap.base_currency}${swap.base_issuer ? `+${swap.base_issuer}` : ''}`;
      const counter = `${swap.counter_currency}${swap.counter_issuer ? `+${swap.counter_issuer}` : ''}`;
      for (const [b, c, inverted] of [
        [base, counter, false],
        [counter, base, true],
      ] as const) {
        const res = await get(`${path(trader, `/${b}/${c}`)}?limit=1000&amm=only`);
        const served = (res.body as ListBody).exchanges;
        // the swaps of the pair, as asked: every stored row of this pair is as stored when asked as stored
        const want = kept(own(trader), 'only').filter(
          (r) =>
            `${r.base_currency}|${r.base_issuer}|${r.counter_currency}|${r.counter_issuer}` ===
            `${swap.base_currency}|${swap.base_issuer}|${swap.counter_currency}|${swap.counter_issuer}`,
        );
        expect(want.length).toBeGreaterThan(0);
        expect([b, c, served]).toEqual([b, c, exchangesOf(want, inverted)]);
        for (const ex of served) expect(Object.keys(ex).at(-1)).toBe('amm_account');
      }
    });

    it('amm=exclude serves every account as before AMM: no object has the key', async () => {
      for (const account of accounts.slice(0, 40)) {
        const res = await get(`${path(account)}?limit=1000&amm=exclude`);
        for (const ex of (res.body as ListBody).exchanges) expect(Object.keys(ex)).not.toContain('amm_account');
      }
    });
  });

  describe('the list', () => {
    it('composes with the pair filter, in either orientation', async () => {
      const swaps = kept(own(trader), 'only');
      const pairs = [
        ...new Set(swaps.map((r) => `${r.base_currency}+${r.base_issuer}/${r.counter_currency}+${r.counter_issuer}`)),
      ];
      expect(pairs.length).toBeGreaterThan(0);
      for (const mode of MODES) {
        // a currency alone, any issuer: the account's exchanges of it (base, or counter inverted)
        const currency = swaps[0].base_currency;
        const res = await get(url(path(trader, `/${currency}`), 'limit=1000', ammQuery(mode)));
        const want = kept(own(trader), mode)
          .map((row) => ({
            row,
            asStored: row.base_currency === currency,
            reversed: row.counter_currency === currency,
          }))
          .filter((r) => r.asStored || r.reversed)
          .map((r) => exchangeOf(r.row, !r.asStored));
        expect([mode, res.body.exchanges]).toEqual([mode, want]);
        expect(want.length).toBeGreaterThan(0);
      }
    });

    it('composes with the window and the pages, in both directions; the marker continues inside the filtered rows', async () => {
      for (const mode of MODES) {
        const want = keysOf(kept(own(trader), mode));
        for (const limit of [1, 3]) {
          const walked = (await pages(url(path(trader), ammQuery(mode)), limit)).flatMap(keysIn);
          expect([mode, limit, walked]).toEqual([mode, limit, want]);
        }
        const back = (await pages(url(path(trader), ammQuery(mode), 'descending=true'), 2)).flatMap(keysIn);
        expect([mode, 'descending', back]).toEqual([mode, 'descending', [...want].reverse()]);
      }
      // a window: the day of the first swap
      const swaps = kept(own(trader), 'only');
      const day = new Date(swaps[0].close_time * 1000).toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 19);
      const within = closedBetween(own(trader), `${day}T00:00:00`, next);
      for (const mode of MODES) {
        const res = await get(url(path(trader), `start=${day}`, `end=${day}`, 'limit=1000', ammQuery(mode)));
        expect([mode, keysIn(res.body)]).toEqual([mode, keysOf(kept(within, mode))]);
      }
      // the marker of an order-book row: the swaps after it
      const middle = kept(own(trader), 'exclude')[1];
      const after = swaps.filter((r) => byKey(r, middle) > 0);
      const res = await get(url(path(trader), 'amm=only', 'limit=1000', `marker=${markerOf(middle)}`));
      expect(keysIn(res.body)).toEqual(keysOf(after));
    });

    it('the Link header keeps the filter', async () => {
      const res = await get(`${path(trader)}?limit=1&amm=only`);
      expect(res.headers.link).toBe(
        `<${new URL(res.request.url).origin}${path(trader)}?limit=1&amm=only&marker=${markerOf(kept(own(trader), 'only')[0])}>; rel="next"`,
      );
    });
  });

  describe('an amm that is none of the three', () => {
    it('is 400 invalid amm filter - use: include, exclude, only, with or without a pair filter', async () => {
      for (const route of [
        path(trader),
        path(trader, '/XRP'),
        path(trader, `/USD+${MWJ}/XRP`),
        `${path(trader)}?format=csv`,
      ]) {
        for (const amm of ['nonsense', 'ONLY', 'Exclude', 'true', '1', 'none']) {
          const p = url(route, `amm=${amm}`);
          const res = await get(p);
          expect([p, res.status, res.body]).toEqual([p, 400, { result: 'error', message: MESSAGE }]);
        }
      }
    });

    it('is checked after the assets, start and end, and before the marker', async () => {
      const message = async (p: string): Promise<unknown> => (await get(p)).body.message;
      expect(await message(`${path(trader, '/USD+x')}?amm=nonsense`)).toBe('invalid base issuer address');
      expect(await message(`${path(trader)}?start=2015x&amm=nonsense`)).toBe('invalid start date format');
      expect(await message(`${path(trader)}?end=2015x&amm=nonsense`)).toBe('invalid end date format');
      expect(await message(`${path(trader)}?amm=nonsense&marker=garbage`)).toBe(MESSAGE);
      expect(await message(`${path(trader)}?amm=only&marker=garbage`)).toBe('invalid marker');
    });
  });

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');
    const COLUMNS = [
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

    it('amm_account is a last column when a swap is on the page, empty for the order-book rows', async () => {
      const res = await get(`${path(trader)}?format=csv&limit=1000`);
      const table = lines(res.text).map((l) => l.split(','));
      const rows = own(trader);
      expect(table).toHaveLength(1 + rows.length);
      // the client column comes before it, when some row has a client
      const expected = [...COLUMNS, ...(rows.some((r) => r.client !== null) ? ['client'] : []), 'amm_account'];
      expect(table[0]).toEqual(expected.map((c) => `"${c}"`));
      rows.forEach((r, i) => expect([i, table[1 + i].at(-1)]).toEqual([i, isSwap(r) ? `"${r.amm_account}"` : '""']));
    });

    it('a list of order-book exchanges has the columns it had before AMM', async () => {
      const res = await get(`${path(trader)}?format=csv&limit=1000&amm=exclude`);
      const header = lines(res.text)[0].split(',');
      expect(header.slice(0, COLUMNS.length)).toEqual(COLUMNS.map((c) => `"${c}"`));
      expect(header).not.toContain('"amm_account"');
      const swapsOnly = await get(`${path(trader)}?format=csv&limit=1000&amm=only`);
      expect(lines(swapsOnly.text)[0].split(',').at(-1)).toBe('"amm_account"');
    });
  });

  describe('the SQL', () => {
    it('the condition is inside the read that is capped, never after the page: bound, in order, whatever the direction', async () => {
      for (const [mode, condition] of [
        ['only', "amm_account != ''"],
        ['exclude', "amm_account = ''"],
      ] as const) {
        for (const descending of [false, true]) {
          for (const filter of ['', '/XRP']) {
            const query = jest.spyOn(h.ch, 'query');
            await get(
              `${path(trader, filter)}?limit=3&amm=${mode}&descending=${descending}&marker=${markerOf(own(trader)[1])}`,
            );
            const calls = accountCalls(query);
            jest.restoreAllMocks();
            const where = [mode, descending, filter];
            expect([...where, calls.length]).toEqual([...where, 1]);
            const [sql, params] = calls[0] as [string, Record<string, unknown>];
            expect([...where, innerRead(sql).includes(condition)]).toEqual([...where, true]);
            expect([...where, sql.split(condition).length - 1]).toEqual([...where, 1]);
            await expectBoundedInOrderRead(h, sql, params, descending, where);
          }
        }
      }
    });

    it('include adds no condition: amm=include reads what no amm reads', async () => {
      const readOf = async (query: string): Promise<string> => {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`${path(trader)}?limit=3${query}`);
        const calls = accountCalls(spy);
        jest.restoreAllMocks();
        expect(calls).toHaveLength(1);
        return String(calls[0][0]);
      };
      const include = await readOf('&amm=include');
      expect(include).not.toMatch(/amm_account\s*(!=|=)/);
      expect(await readOf('')).toBe(include);
    });
  });
});

describe('account exchanges API endpoint: swaps that were written twice (the amm filter)', () => {
  const SEED = 'ripple-mock+amm';
  const ALL_ROWS = [...fixtureAccountExchanges(SEED)].sort(
    (a, b) => byKey(a, b) || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0),
  );
  const isSwap = (r: AccountExchangesRow): boolean => r.amm_account !== '';
  // the account with most swaps in its busiest swap ledger
  const perLedger = new Map<string, number>();
  for (const r of ALL_ROWS.filter(isSwap)) {
    const key = `${r.account}|${r.ledger_index}`;
    perLedger.set(key, (perLedger.get(key) ?? 0) + 1);
  }
  const [busiest] = [...perLedger.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const [ACCOUNT, ledger] = busiest.split('|');
  const LEDGER = Number(ledger);
  const rows = ALL_ROWS.filter((r) => r.account === ACCOUNT);

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'exchanges');

  beforeAll(async () => {
    h = await startHarness({ seed: SEED, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountExchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.AccountExchanges} SELECT * FROM ${Table.AccountExchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountExchanges} WHERE ledger_index = {index:UInt32} AND account = {account:String} AND amm_account != ''`,
      { index: LEDGER, account: ACCOUNT },
    );
    expect(Number(n)).toBe(rows.filter((r) => r.ledger_index === LEDGER && isSwap(r)).length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every swap once, and a page cut inside the duplicates neither repeats nor skips a row', async () => {
    expect(rows.filter((r) => r.ledger_index === LEDGER && isSwap(r)).length).toBeGreaterThan(1);
    for (const mode of ['include', 'exclude', 'only'] as const) {
      const want = mode === 'exclude' ? rows.filter((r) => !isSwap(r)) : mode === 'only' ? rows.filter(isSwap) : rows;
      const unpaged = await get(`${path(ACCOUNT)}?limit=1000&amm=${mode}`);
      expect([mode, keysIn(unpaged.body)]).toEqual([mode, keysOf(want)]);
      for (const limit of [1, 2, 3]) {
        const walked = (await pages(`${path(ACCOUNT)}?amm=${mode}`, limit)).flatMap(keysIn);
        expect([mode, limit, walked]).toEqual([mode, limit, keysOf(want)]);
      }
      const desc = await pages(`${path(ACCOUNT)}?amm=${mode}&descending=true`, 2);
      expect([mode, desc.flatMap(keysIn)]).toEqual([mode, keysOf(want).reverse()]);
    }
  });
});

describe('account exchanges API endpoint on the xahau-recorded ledgers', () => {
  const EVERNODE = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8';
  const TRADER_X = 'rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj';
  const header = fixtureSource('xahau-recorded').list()[0].header;
  /** The recorded ledgers have no exchange: this one is an EVR/XAH trade written into the first of them, for TRADER_X. */
  const row: AccountExchangesRow = {
    account: TRADER_X,
    base_currency: 'EVR',
    base_issuer: EVERNODE,
    counter_currency: 'XAH',
    counter_issuer: '',
    ledger_index: header.ledger_index,
    tx_index: 0,
    node_index: 0,
    tx_hash: 'E'.repeat(64),
    close_time: header.close_time,
    base_amount: '10',
    counter_amount: '5',
    base_amount_f: 10,
    counter_amount_f: 5,
    rate: '0.5',
    rate_f: 0.5,
    buyer: TRADER_X,
    seller: EVERNODE,
    taker: TRADER_X,
    provider: EVERNODE,
    offer_sequence: 7,
    amm_account: '',
    autobridged_currency: null,
    autobridged_issuer: null,
    tx_type: 'OfferCreate',
    client: null,
  };
  let h: Harness;
  let get: ApiClient['get'];
  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.insert(Table.AccountExchanges, [row]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the recorded ledgers have no exchanges: every list is empty', async () => {
    expect(fixtureAccountExchanges('xahau-recorded')).toHaveLength(0);
    for (const filter of ['', '/XAH', `/EVR+${EVERNODE}/XAH`]) {
      const res = await get(path(EVERNODE, filter));
      expect([filter, res.status, res.body]).toEqual([filter, 200, { result: 'success', count: 0, exchanges: [] }]);
    }
  });

  it('XAH is the native currency of the filters: alone it matches the native side, with an issuer it matches nothing', async () => {
    const asStored = await get(`${path(TRADER_X)}?limit=1000`);
    expect(asStored.body.exchanges).toEqual([
      expect.objectContaining({
        base_currency: 'EVR',
        base_issuer: EVERNODE,
        counter_currency: 'XAH',
        tx_hash: row.tx_hash,
      }),
    ]);
    expect(asStored.body.exchanges[0]).not.toHaveProperty('counter_issuer');

    // XAH alone is the native currency, on either side: here the counter, so the trade is inverted
    const xah = await get(path(TRADER_X, '/xah'));
    expect(xah.body.count).toBe(1);
    expect(xah.body.exchanges[0]).toMatchObject({
      base_currency: 'XAH',
      counter_currency: 'EVR',
      counter_issuer: EVERNODE,
      base_amount: '5',
      counter_amount: '10',
      buyer: EVERNODE,
      seller: TRADER_X,
      rate: '2.0000000',
    });
    expect(xah.body.exchanges[0]).not.toHaveProperty('base_issuer');
    expect((await get(path(TRADER_X, `/XAH/EVR+${EVERNODE}`))).body.exchanges).toEqual(xah.body.exchanges);
    expect((await get(path(TRADER_X, `/EVR+${EVERNODE}/XAH`))).body.exchanges).toEqual(asStored.body.exchanges);

    // the native currency has no issuer, so XAH with one matches nothing; it is a filter, not a pair, so no 400
    for (const filter of [`/XAH+${EVERNODE}`, `/XAH+${EVERNODE}/EVR`, `/EVR/XAH+${EVERNODE}`]) {
      const res = await get(path(TRADER_X, filter));
      expect([filter, res.status, res.body]).toEqual([filter, 200, { result: 'success', count: 0, exchanges: [] }]);
    }
    // XRP is an ordinary currency on Xahau: this account never traded it
    for (const filter of ['/XRP', '/XRP/XAH', `/XAH/XRP`]) {
      expect([filter, (await get(path(TRADER_X, filter))).body.count]).toEqual([filter, 0]);
    }
  });

  it('the file name and the markers of a filtered list use XAH', async () => {
    const csv = await get(`${path(TRADER_X, '/xah/evr')}?format=csv`);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${TRADER_X} - exchanges - XAH-EVR`));
    expect(csv.text.split('\n')).toHaveLength(2);
    expect((await get(`${path(TRADER_X)}?start=2030-01-01`)).body.count).toBe(0);
    const before = await get(`${path(TRADER_X)}?marker=${markerOf(row)}`);
    expect(before.body.count).toBe(0);
  });
});

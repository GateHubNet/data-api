import { AccountPaymentsRow, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { fixtureAccountPayments, fixturePayments } from './support/fixtures';
import { expectBoundedInOrderRead, innerRead } from './support/plans';

/**
 * `GET /v2/accounts/:address/payments` on a real ClickHouse, seeded with the 54 ledgers of the original Ripple test
 * suite (`ripple-mock`: 182 payments, 364 rows of `account_payments`) and with the Xahau ledgers recorded from a
 * public node (172 payments, all XAH).
 *
 * Ported from rippled-historical-database `test/test.account.payments.js` (all 10 `it`s, none skipped). Eight keep
 * the original's title word for word; the two that share one title there ('should make sure
 * /accounts/:account/payments handles type correctly', once for `sent` and once for `received`) are told apart here
 * with a suffix, '(sent)' and '(received)'. Three of them lean on HBase and are ported to what this API holds instead:
 *  - the two 'handles pagination correctly' walk the payments of the account one by one with `limit=1` and compare
 *    each page with the unpaged list, as `utils.checkPagination` does; only the marker is this API's (the original
 *    ran the same walk twice, "the descending false version" being the same request: this port sends
 *    `descending=false` explicitly in the second);
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`rpjZ…|20150114185210|000011119940|00001`); the marker of this API is the `(ledger_index, tx_index)` of the last
 *    row of the page.
 *
 * Added: the items are exactly those of `/v2/payments` (for every account of the ledgers), `issuer` (the original read
 * it and ignored it), tags of 0 (R10), the order of the checks, the shared list behaviour (empty range, marker pages,
 * descending, unknown params, limits), CSV and its file name, the tables a page reads and their plan, rows that were
 * written twice, the failure paths and Xahau.
 */

const SENDER = 'rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx'; // sent 2 XRP payments
const RECEIVER = 'rGcSxmn1ibh5ZfCMAEu2iy7mnrb5nE6fbY'; // 1 sent, 4 received
const DESTINATION_TAGGED = 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj'; // 21 received, 8 with tag 223051
const SOURCE_TAGGED = 'rUeXUxaMTH1pELvD2EkiHTRcM9FsH3v4d7'; // 1 sent, source tag 1848687941
const TAG_ZERO_SENDER = 'rK5j9n8baXfL4gzUoZsfxBvvsv97P5swaV'; // two payments with source_tag 0
const MULTI = 'rwvLbHQtU16BwQJyrQb9cfFKvx13Ksbkja'; // 59 payments in EUR and CNY (and the busiest account)
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';

interface Key {
  ledger_index: number;
  tx_index: number;
}
const byKey = (a: Key, b: Key): number => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

/** Every row of `account_payments`, in the order of the list. */
const ROWS = [...fixtureAccountPayments('ripple-mock')].sort(byKey);
const PAYMENTS = [...fixturePayments('ripple-mock')].sort((a, b) => byKey(a.row, b.row));

/** The rows of an account, in the order of the list, ascending. */
const rowsOf = (account: string): AccountPaymentsRow[] => ROWS.filter((r) => r.account === account);
const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))];
const BUSIEST = ACCOUNTS.map((a) => ({ a, n: rowsOf(a).length })).sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : 1))[0]
  .a;

const keyOf = (r: Key): string => `${r.ledger_index}:${r.tx_index}`;
const HASH = new Map(PAYMENTS.map((p) => [keyOf(p.row), p.row.tx_hash]));
const hashesOfRows = (rows: Key[]): string[] => rows.map((r) => HASH.get(keyOf(r)) as string);

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** `YYYY-MM-DDTHH:mm:ss` of unix seconds. */
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19);
const closedBetween = (rows: AccountPaymentsRow[], from: string, before: string): AccountPaymentsRow[] =>
  rows.filter((r) => r.close_time >= unix(from) && r.close_time < unix(before));

/** The marker of a row: `(ledger_index, tx_index)` as base64url JSON. */
const markerOf = (row: Key): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

type Payment = Record<string, unknown> & { tx_hash: string };
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  payments: Payment[];
}
const hashesIn = (body: ListBody): string[] => body.payments.map((p) => p.tx_hash);
const path = (account: string): string => `/v2/accounts/${account}/payments`;

describe('account payments API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** Every payment as `/v2/payments` serves it, by transaction hash. */
  const served = new Map<string, Payment>();
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'payments');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const page of await api.pages<ListBody>('/v2/payments', 100, 'payments')) {
      for (const p of page.payments) served.set(p.tx_hash, p);
    }
    expect(served.size).toBe(PAYMENTS.length);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.account.payments.js -----------------------------------------------------------------------------------

  it('should make sure /accounts/:account/payments handles limit correctly', async () => {
    const res = await get(`${path(SENDER)}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.payments.length).toBe(2);
  });

  it('should make sure /accounts/:account/payments handles dates correctly', async () => {
    const start = '2015-01-14T18:01:00';
    const end = '2015-01-14T18:40:45';
    const res = await get(`${path(SENDER)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(res.body.payments.length).not.toBe(0); // make sure we test something
    for (const pay of (res.body as ListBody).payments) {
      const d = Date.parse(pay.executed_time as string);
      expect(d > Date.parse(`${start}Z`) && d < Date.parse(`${end}Z`)).toBe(true);
    }
    // the ledgers that closed within the window, and no others
    expect(hashesIn(res.body)).toEqual(hashesOfRows(closedBetween(rowsOf(SENDER), start, '2015-01-14T18:40:46')));
    expect(res.body.count).toBe(1);
  });

  it('should make sure /accounts/:account/payments handles type correctly (sent)', async () => {
    const res = await get(`${path(SENDER)}?type=sent`);
    expect(res.status).toBe(200);
    expect(res.body.payments.length).not.toBe(0);
    for (const pay of (res.body as ListBody).payments) expect(pay.source).toBe(SENDER);
    expect(res.body.count).toBe(2);
  });

  it('should make sure /accounts/:account/payments handles type correctly (received)', async () => {
    const res = await get(`${path(RECEIVER)}?type=received`);
    expect(res.status).toBe(200);
    expect(res.body.payments.length).not.toBe(0);
    for (const pay of (res.body as ListBody).payments) expect(pay.destination).toBe(RECEIVER);
    // 4 of its 5 payments were received
    expect(res.body.count).toBe(4);
    expect(hashesIn(res.body)).toEqual(hashesOfRows(rowsOf(RECEIVER).filter((r) => r.direction === 'received')));
  });

  it('should filter by destination tag', async () => {
    const tag = 223051;
    const res = await get(`${path(DESTINATION_TAGGED)}?destination_tag=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBe(8);
    for (const pay of (res.body as ListBody).payments) {
      expect(pay.destination).toBe(DESTINATION_TAGGED);
      expect(pay.destination_tag).toBe(tag);
    }
  });

  it('should filter by source tag', async () => {
    const tag = 1848687941;
    const res = await get(`${path(SOURCE_TAGGED)}?source_tag=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBe(1);
    for (const pay of (res.body as ListBody).payments) {
      expect(pay.source).toBe(SOURCE_TAGGED);
      expect(pay.source_tag).toBe(tag);
    }
  });

  it('should make sure /accounts/:account/payments handles pagination correctly', async () => {
    const url = path(SENDER);
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1);

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}?limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.payments.length).toBe(1);
      expect(res.body.payments[0].amount).toBe(ref.body.payments[i].amount);
      expect(res.body.payments[0].tx_hash).toBe(ref.body.payments[i].tx_hash);
      marker = res.body.marker;
    }
    // the last page has no marker
    expect(marker).toBeUndefined();
  });

  it('should make sure /accounts/:account/payments handles pagination correctly (the descending false version)', async () => {
    const url = `${path(SENDER)}?descending=false`;
    const ref = await get(url);
    expect(ref.body.count).toBeGreaterThan(1);
    const walked = (await pages(url, 1)).flatMap((p) => p.payments);
    expect(walked.length).toBe(ref.body.count);
    walked.forEach((p, i) => {
      expect(p.amount).toBe(ref.body.payments[i].amount);
      expect(p.tx_hash).toBe(ref.body.payments[i].tx_hash);
    });
  });

  it('should make sure /accounts/:account/payments handles empty response correctly', async () => {
    const res = await get(path(NOBODY));
    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBe(0);
    expect(res.body.count).toBe(0);
  });

  it('should include a link header when marker is present', async () => {
    const url = `${path(SENDER)}?limit=1`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(markerOf(rowsOf(SENDER)[0]));
    expect(res.headers.link).toBe(`<${new URL(res.request.url).origin}${url}&marker=${res.body.marker}>; rel="next"`);
  });

  // -- the Payment ----------------------------------------------------------------------------------------------------

  describe('the payments of an account', () => {
    it('are the payments of /v2/payments, whole and in order, for every account of the ledgers', async () => {
      expect(ACCOUNTS.length).toBeGreaterThan(100);
      expect(BUSIEST).toBe(MULTI);
      let total = 0;
      for (const account of ACCOUNTS) {
        const res = await get(`${path(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        const expected = rowsOf(account);
        expect([account, hashesIn(res.body)]).toEqual([account, hashesOfRows(expected)]);
        for (const pay of (res.body as ListBody).payments) expect(pay).toEqual(served.get(pay.tx_hash));
        total += res.body.count;
      }
      // a payment is listed under its source and under its destination
      expect(total).toBe(2 * PAYMENTS.length);
    });

    it('keep the key order of /v2/payments, and the client is not served', async () => {
      const res = await get(`${path(BUSIEST)}?limit=1`);
      const [pay] = (res.body as ListBody).payments;
      expect(Object.keys(pay)).toEqual(Object.keys(served.get(pay.tx_hash) as Payment));
      expect(pay).not.toHaveProperty('client');
      expect(pay).not.toHaveProperty('fee');
      expect(pay).toHaveProperty('transaction_cost');
    });

    it('have the envelope result, count, marker, payments', async () => {
      const res = await get(`${path(BUSIEST)}?limit=2`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'payments']);
      expect(res.body.result).toBe('success');
      const all = await get(`${path(BUSIEST)}?limit=1000`);
      expect(Object.keys(all.body)).toEqual(['result', 'count', 'payments']);
    });

    it('an address that is none, or has no payments, is an empty list (the address is not checked)', async () => {
      for (const account of ['nonsense', NOBODY, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh']) {
        const res = await get(path(account));
        expect([account, res.status, res.body]).toEqual([account, 200, { result: 'success', count: 0, payments: [] }]);
      }
    });
  });

  // -- filters ---------------------------------------------------------------------------------------------------------

  describe('the filters', () => {
    it('type is sent or received, in any case; an empty type is no filter', async () => {
      const received = rowsOf(RECEIVER).filter((r) => r.direction === 'received');
      const sent = rowsOf(RECEIVER).filter((r) => r.direction === 'sent');
      expect(received.length).toBe(4);
      expect(sent.length).toBe(1);
      for (const type of ['received', 'Received', 'RECEIVED']) {
        expect([type, hashesIn((await get(`${path(RECEIVER)}?type=${type}`)).body)]).toEqual([
          type,
          hashesOfRows(received),
        ]);
      }
      for (const type of ['sent', 'SENT']) {
        expect([type, hashesIn((await get(`${path(RECEIVER)}?type=${type}`)).body)]).toEqual([
          type,
          hashesOfRows(sent),
        ]);
      }
      expect((await get(`${path(RECEIVER)}?type=`)).body.count).toBe(5);
    });

    it('currency filters the currency of the payment, in any case', async () => {
      const cny = rowsOf(MULTI).filter((r) => r.currency === 'CNY');
      expect(cny.length).toBeGreaterThan(0);
      expect(cny.length).toBeLessThan(rowsOf(MULTI).length);
      for (const currency of ['CNY', 'cny', 'Cny']) {
        const res = await get(`${path(MULTI)}?currency=${currency}&limit=1000`);
        expect([currency, hashesIn(res.body)]).toEqual([currency, hashesOfRows(cny)]);
        for (const pay of (res.body as ListBody).payments) expect(pay.currency).toBe('CNY');
      }
      const eur = await get(`${path(MULTI)}?currency=eur&limit=1000`);
      expect(hashesIn(eur.body)).toEqual(hashesOfRows(rowsOf(MULTI).filter((r) => r.currency === 'EUR')));
      expect((await get(`${path(MULTI)}?currency=NOPE`)).body.count).toBe(0);
      // the native currency is a currency like the others
      const xrp = await get(`${path(RECEIVER)}?currency=xrp`);
      expect(hashesIn(xrp.body)).toEqual(hashesOfRows(rowsOf(RECEIVER)));
    });

    it('issuer filters the issuer of the payment (the original read it and ignored it)', async () => {
      const cnyIssuer = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
      const eurIssuer = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
      const all = rowsOf(MULTI);
      for (const issuer of [cnyIssuer, eurIssuer]) {
        const own = all.filter((r) => r.issuer === issuer);
        expect(own.length).toBeGreaterThan(0);
        expect(own.length).toBeLessThan(all.length);
        const res = await get(`${path(MULTI)}?issuer=${issuer}&limit=1000`);
        expect([issuer, hashesIn(res.body)]).toEqual([issuer, hashesOfRows(own)]);
        for (const pay of (res.body as ListBody).payments) expect(pay.issuer).toBe(issuer);
        // with its currency too
        const both = await get(`${path(MULTI)}?currency=${own[0].currency}&issuer=${issuer}&limit=1000`);
        expect(hashesIn(both.body)).toEqual(hashesOfRows(own));
      }
      // the currency of one issuer, asked for with the issuer of the other: nothing
      expect((await get(`${path(MULTI)}?currency=CNY&issuer=${eurIssuer}`)).body.count).toBe(0);
      expect((await get(`${path(MULTI)}?currency=EUR&issuer=${cnyIssuer}`)).body.count).toBe(0);
      // the native currency has no issuer to match; an issuer that is no address matches nothing
      expect((await get(`${path(MULTI)}?currency=XRP&issuer=${cnyIssuer}`)).body.count).toBe(0);
      expect((await get(`${path(MULTI)}?issuer=nonsense`)).body.count).toBe(0);
    });

    it('an empty currency or issuer is no filter', async () => {
      const all = await get(`${path(BUSIEST)}?limit=1000`);
      expect((await get(`${path(BUSIEST)}?limit=1000&currency=&issuer=`)).body).toEqual(all.body);
    });

    it('destination_tag and source_tag are exact numbers; a tag of 0 is a tag (R10)', async () => {
      const zero = await get(`${path(TAG_ZERO_SENDER)}?source_tag=0`);
      const expected = rowsOf(TAG_ZERO_SENDER).filter((r) => r.source_tag === 0);
      expect(expected).toHaveLength(2);
      expect(hashesIn(zero.body)).toEqual(hashesOfRows(expected));
      for (const pay of (zero.body as ListBody).payments) expect(pay.source_tag).toBe(0);
      // the payment without a tag is not a payment with tag 0
      expect((await get(`${path(SENDER)}?source_tag=0`)).body.count).toBe(0);
      expect((await get(`${path(SENDER)}?destination_tag=0`)).body.count).toBe(0);
    });

    it('a tag that is no number or is too large matches nothing; an empty one is no filter', async () => {
      for (const tag of ['abc', '-1', '1.5', '4294967296', '99999999999999999999', '0x10', ' 5']) {
        for (const name of ['destination_tag', 'source_tag']) {
          const res = await get(`${path(DESTINATION_TAGGED)}${qs({ [name]: tag })}`);
          expect([name, tag, res.status, res.body]).toEqual([
            name,
            tag,
            200,
            { result: 'success', count: 0, payments: [] },
          ]);
        }
      }
      const all = await get(`${path(DESTINATION_TAGGED)}?limit=1000`);
      expect((await get(`${path(DESTINATION_TAGGED)}?limit=1000&destination_tag=&source_tag=`)).body).toEqual(all.body);
      // the largest tag there is
      expect((await get(`${path(DESTINATION_TAGGED)}?destination_tag=4294967295`)).status).toBe(200);
    });

    it('the filters combine', async () => {
      const own = rowsOf(DESTINATION_TAGGED);
      const currency = own.find((r) => r.destination_tag === 223051)?.currency as string;
      const expected = own.filter(
        (r) => r.direction === 'received' && r.currency === currency && r.destination_tag === 223051,
      );
      expect(expected.length).toBe(8);
      const res = await get(
        `${path(DESTINATION_TAGGED)}?type=received&currency=${currency.toLowerCase()}&destination_tag=223051&issuer=${expected[0].issuer}`,
      );
      expect(hashesIn(res.body)).toEqual(hashesOfRows(expected));
      // a sent payment of the same account with the tag of a received one: nothing
      expect((await get(`${path(DESTINATION_TAGGED)}?type=sent&destination_tag=223051`)).body.count).toBe(0);
      // the same tag with another currency: nothing
      expect((await get(`${path(DESTINATION_TAGGED)}?currency=NOPE&destination_tag=223051`)).body.count).toBe(0);
    });

    it('the filters are applied before the page is cut, so a page of a filtered list is full', async () => {
      const received = rowsOf(DESTINATION_TAGGED).filter((r) => r.destination_tag === 223051);
      const walked = await pages(`${path(DESTINATION_TAGGED)}?destination_tag=223051`, 3);
      expect(walked.map((p) => p.count)).toEqual([3, 3, 2]);
      expect(walked.flatMap(hashesIn)).toEqual(hashesOfRows(received));
    });
  });

  // -- errors ----------------------------------------------------------------------------------------------------------

  describe('a request that is not valid', () => {
    it('type other than sent or received → 400 invalid type - use: sent, received', async () => {
      for (const type of ['both', 'send', 'receive', 'x', '0']) {
        const res = await get(`${path(SENDER)}?type=${type}`);
        expect([type, res.status, res.body]).toEqual([
          type,
          400,
          { result: 'error', message: 'invalid type - use: sent, received' },
        ]);
      }
    });

    it('the checks come in the order of the original: start, end, type, then the marker', async () => {
      const cases: [string, string][] = [
        ['start=x&end=y&type=z&marker=!!!', 'invalid start date format'],
        ['end=y&type=z&marker=!!!', 'invalid end date format'],
        ['type=z&marker=!!!', 'invalid type - use: sent, received'],
        ['marker=!!!', 'invalid marker'],
      ];
      for (const [query, message] of cases) {
        const res = await get(`${path(SENDER)}?${query}`);
        expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
      }
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`${path(SENDER)}${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
      const end = await get(`${path(SENDER)}?end=`);
      expect([end.status, end.body.message]).toEqual([400, 'invalid end date format']);
    });

    it('tampered marker → 400 invalid marker, also for a list that is empty', async () => {
      const bad = [
        'rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx|20150114185210|000011119940|00001',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2,3]').toString('base64url'),
        Buffer.from('["a",1]').toString('base64url'),
        Buffer.from('[-1,0]').toString('base64url'),
      ];
      for (const account of [SENDER, NOBODY]) {
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
    it('empty range → count 0', async () => {
      const res = await get(`${path(BUSIEST)}?start=2030-01-01&end=2030-12-31`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, payments: [] });
      expect(res.headers.link).toBeUndefined();
      // before the first ledger, and the upside-down window of the original's empty-response test
      expect((await get(`${path(BUSIEST)}?end=2013-06-01`)).body.count).toBe(0);
      expect((await get(`${path(BUSIEST)}?start=1015-01-14T18:00:00&end=1970-01-14T18:30:00`)).body.count).toBe(0);
      // the marker does not matter when there is nothing in the range
      expect((await get(`${path(BUSIEST)}?start=2030-01-01&marker=${markerOf(ROWS[3])}`)).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      for (const account of [BUSIEST, DESTINATION_TAGGED, RECEIVER]) {
        const unpaged = await get(`${path(account)}?limit=1000`);
        expect(unpaged.body.count).toBeGreaterThan(4);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();

        const paged = await pages(path(account), 3);
        expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([account, paged.flatMap((p) => p.payments)]).toEqual([account, unpaged.body.payments]);
      }
    });

    it('marker pages concatenate inside a window and with a filter', async () => {
      const window = `${path(BUSIEST)}?start=2015-01-14T18:28:40&end=2015-01-14T18:51:40&type=received`;
      const unpaged = await get(`${window}&limit=1000`);
      expect([unpaged.status, unpaged.body.count]).toEqual([200, expect.any(Number)]);
      expect((await pages(window, 2)).flatMap((p) => p.payments)).toEqual(unpaged.body.payments);
    });

    it('descending reverses order', async () => {
      for (const account of [BUSIEST, DESTINATION_TAGGED]) {
        const asc = await get(`${path(account)}?limit=1000`);
        const desc = await get(`${path(account)}?limit=1000&descending=true`);
        expect(asc.body.count).toBeGreaterThan(1);
        expect([account, desc.body.payments]).toEqual([account, [...asc.body.payments].reverse()]);
        // the markers of a descending list continue downwards
        const walked = await pages(`${path(account)}?descending=true`, 4);
        expect([account, walked.flatMap((p) => p.payments)]).toEqual([account, desc.body.payments]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get(`${path(BUSIEST)}?limit=5`);
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`${path(BUSIEST)}?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get(`${path(BUSIEST)}?limit=5&descending=true`);
      expect((await get(`${path(BUSIEST)}?limit=5&descending=TRUE`)).body).toEqual(desc.body);
      expect(hashesIn(desc.body)).toEqual(hashesOfRows(rowsOf(BUSIEST).slice(-5).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get(`${path(BUSIEST)}?limit=5`);
      const res = await get(`${path(BUSIEST)}?limit=5&foo=bar&interval=day&reduce=true&change_type=zzz`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get(
        `${path(BUSIEST)}?limit=3&limit=50&descending=true&descending=false&type=received&type=sent`,
      );
      expect(res.body.count).toBe(3);
      expect(hashesIn(res.body)).toEqual(
        hashesOfRows(
          rowsOf(BUSIEST)
            .filter((r) => r.direction === 'received')
            .slice(-3)
            .reverse(),
        ),
      );
    });

    it('start defaults to 2013-01-01; an empty start is the default, an empty end is invalid', async () => {
      const all = await get(`${path(BUSIEST)}?limit=1000`);
      expect((await get(`${path(BUSIEST)}?limit=1000&start=`)).body).toEqual(all.body);
      expect((await get(`${path(BUSIEST)}?limit=1000&start=2013-01-01`)).body).toEqual(all.body);
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const rows = rowsOf(BUSIEST);
      const mid = rows[Math.floor(rows.length / 2)].close_time;
      const second = iso(mid);
      const cases: [Record<string, string>, string, string][] = [
        [{ start: second, end: second }, second, iso(mid + 1)],
        [{ start: `${second}Z` }, second, '2100-01-01T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ end: '2015-01' }, '2000-01-01T00:00:00', '2015-02-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const listed = (await pages(`${path(BUSIEST)}${qs(params)}`, 100)).flatMap(hashesIn);
        expect([params, listed]).toEqual([params, hashesOfRows(closedBetween(rows, from, before))]);
      }
    });

    it('limit is 200 by default, at most 1000; below one or not a number it is the default', async () => {
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
        const res = await get(`${path(BUSIEST)}?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => String(q).includes(Table.AccountPayments));
        expect([query, res.status, paging[0][1]]).toEqual([
          query,
          200,
          expect.objectContaining({ distinct_page_limit: rows + 1 }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, rowsOf(BUSIEST).length)]);
        jest.restoreAllMocks();
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const rows = rowsOf(BUSIEST);
      const exact = await get(`${path(BUSIEST)}?limit=${rows.length}`);
      expect(exact.body.count).toBe(rows.length);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      const more = await get(`${path(BUSIEST)}?limit=${rows.length - 1}`);
      expect(more.body.count).toBe(rows.length - 1);
      expect(more.body.marker).toBe(markerOf(rows[rows.length - 2]));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(`${path(BUSIEST)}${qs({ limit: 2, start: '2013-01-01T00:00:00+00:00' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}${path(BUSIEST)}?limit=2&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`${path(BUSIEST)}?limit=2&marker=${markerOf(rowsOf(BUSIEST)[10])}&descending=true`);
      expect(second.headers.link).toBe(
        `<${origin}${path(BUSIEST)}?limit=2&marker=${second.body.marker}&descending=true>; rel="next"`,
      );
    });

    it('a marker continues strictly after its row', async () => {
      const rows = rowsOf(BUSIEST);
      const at = rows[6];
      const asc = await get(`${path(BUSIEST)}?limit=3&marker=${markerOf(at)}`);
      expect(hashesIn(asc.body)).toEqual(hashesOfRows(rows.slice(7, 10)));
      const desc = await get(`${path(BUSIEST)}?limit=3&descending=true&marker=${markerOf(at)}`);
      expect(hashesIn(desc.body)).toEqual(hashesOfRows([rows[5], rows[4], rows[3]]));
      // a marker beyond the stored history is still a marker
      const beyond = await get(`${path(BUSIEST)}?marker=${Buffer.from('[999999999,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, payments: [] });
    });
  });

  // -- what is read ----------------------------------------------------------------------------------------------------

  describe('the queries', () => {
    const paging = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => String(q).includes(Table.AccountPayments))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);

    it('pages account_payments for the keys, then reads the rows of the page from payments by their keys', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`${path(BUSIEST)}?limit=4&type=received&currency=XRP&issuer=&destination_tag=223051`);
      expect(res.status).toBe(200);

      const calls = paging(spy);
      expect(calls).toHaveLength(1);
      const [sql, params] = calls[0];
      expect(sql).toMatch(new RegExp(`FROM ${Table.AccountPayments}\\b`));
      expect(sql).toMatch(/account = \{account:String\}/);
      expect(sql).toMatch(/direction = \{direction:String\}/);
      expect(sql).toMatch(/currency = \{currency:String\}/);
      expect(sql).toMatch(/destination_tag = \{destination_tag:UInt32\}/);
      // read with a plain LIMIT, which stops the read after the page (Ruling R106); outside it a row that was written
      // twice counts once
      expect(sql).toMatch(/tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}\)/);
      expect(sql.match(/LIMIT 1 BY ledger_index, tx_index/g)).toHaveLength(1);
      expect(params).toMatchObject({
        account: BUSIEST,
        direction: 'received',
        currency: 'XRP',
        destination_tag: 223051,
        distinct_page_limit: 5,
      });
      // values are bound, never written into the SQL
      expect(sql).not.toContain(BUSIEST);
      expect(sql).not.toContain('223051');

      // the wide rows of a page, by their keys, from the ledgers of the page only
      spy.mockClear();
      const page = await get(`${path(BUSIEST)}?limit=4`);
      expect(page.body.count).toBe(4);
      const wide = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Payments}\\b`).test(String(q)));
      expect(wide).toHaveLength(1);
      expect(String(wide[0][0])).toMatch(/ledger_index BETWEEN \{lo:UInt32\} AND \{hi:UInt32\}/);
      expect(String(wide[0][0])).toMatch(/\(ledger_index, tx_index\) IN \(/);
      const keys = wide[0][1] as { ledgers: number[]; indexes: number[]; lo: number; hi: number };
      expect(keys.ledgers).toHaveLength(4);
      expect(keys.lo).toBe(Math.min(...keys.ledgers));
      expect(keys.hi).toBe(Math.max(...keys.ledgers));
    });

    it('applies only the filters that were asked for', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(BUSIEST)}?limit=2`);
      const [[sql, params]] = paging(spy);
      for (const filter of ['direction', 'currency', 'issuer', 'source_tag', 'destination_tag']) {
        expect(sql).not.toMatch(new RegExp(`\\b${filter} = \\{`));
        expect(params).not.toHaveProperty(filter);
      }
    });

    it('spells out the whole key in the ORDER BY of the narrow table, ascending and descending', async () => {
      for (const descending of [false, true]) {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`${path(BUSIEST)}?limit=2&descending=${descending}`);
        const [[sql]] = paging(spy);
        jest.restoreAllMocks();
        const d = descending ? 'DESC' : 'ASC';
        expect(sql).toContain(`ORDER BY account ${d}, ledger_index ${d}, tx_index ${d}`);
      }
    });

    it('reads the tables in the order of their primary key, so that a page never sorts the whole history', async () => {
      const middle = rowsOf(BUSIEST)[8];
      const variants = [
        'limit=5',
        `limit=5&marker=${markerOf(middle)}`,
        'limit=5&type=received&currency=XRP',
        'limit=5&start=2015-01-14T18:27:10&end=2015-01-14T18:51:40&destination_tag=223051',
      ];
      for (const descending of [false, true]) {
        for (const variant of variants) {
          const spy = jest.spyOn(h.ch, 'query');
          const res = await get(`${path(BUSIEST)}?${variant}&descending=${descending}`);
          expect(res.status).toBe(200);
          const [[sql, params]] = paging(spy);
          jest.restoreAllMocks();

          // the keys of the account, from the narrow table: in the order of the key, no sort, and a LIMIT on the read
          // itself, which stops it after the page
          await expectBoundedInOrderRead(h, sql, params, descending, [descending, variant]);
        }
      }
    });

    it('the keys of the account are found through the primary key, not by reading every account', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(BUSIEST)}?limit=5`);
      const [[sql, params]] = paging(spy);
      jest.restoreAllMocks();
      const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${innerRead(sql)}`, params);
      const text = indexes.map((r) => r.explain).join('\n');
      expect(text).toContain('PrimaryKey');
      expect(text).toMatch(/Keys:[\s│]+account/);
    });

    it('a request the client got wrong, or that cannot match, reads nothing', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      expect((await get(`${path(BUSIEST)}?type=bogus`)).status).toBe(400);
      expect((await get(`${path(BUSIEST)}?destination_tag=abc`)).body.count).toBe(0);
      expect(paging(spy)).toHaveLength(0);
    });
  });

  // -- failures --------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    it('is 500 unable to retrieve payments', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(path(BUSIEST));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve payments' });
    });

    it('also when the page fails after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql.includes(Table.AccountPayments)
          ? Promise.reject(new Error('boom'))
          : (real as any)(sql, ...rest)) as never);
      const res = await get(path(BUSIEST));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve payments' }]);
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${path(BUSIEST)}?type=x`)).status).toBe(400);
      expect((await get(`${path(BUSIEST)}?start=x`)).status).toBe(400);
      expect((await get(`${path(BUSIEST)}?marker=!!!`)).status).toBe(400);
    });
  });

  // -- CSV -------------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one flattened row per payment', async () => {
      const rows = rowsOf(BUSIEST);
      const res = await get(`${path(BUSIEST)}?format=csv&limit=1000`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(lines(res.text)).toHaveLength(1 + rows.length);
      const header = lines(res.text)[0].split(',');
      expect(header).toContain('"amount"');
      expect(header).toContain('"transaction_cost"');
      expect(header).toContain('"destination_balance_changes[0].value"');
      expect(header).not.toContain('"client"');
      expect(lines(res.text)[1]).toContain(`"${hashesOfRows(rows)[0]}"`);
    });

    it('is named after the account, then the type and the currency: <address> - payments sent XRP', async () => {
      const plain = await get(`${path(SENDER)}?format=csv`);
      expect(plain.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - payments.csv`);
      expect(lines(plain.text)).toHaveLength(1 + 2);

      const both = await get(`${path(SENDER)}?format=csv&type=Sent&currency=xrp`);
      expect(both.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - payments sent XRP.csv`);
      const typeOnly = await get(`${path(SENDER)}?format=csv&type=received`);
      expect(typeOnly.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - payments received.csv`);
      const currencyOnly = await get(`${path(SENDER)}?format=csv&currency=cny`);
      expect(currencyOnly.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - payments CNY.csv`);
      // the issuer and the tags do not name the file
      const issuer = await get(`${path(SENDER)}?format=csv&issuer=rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y&source_tag=1`);
      expect(issuer.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - payments.csv`);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`${path(BUSIEST)}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${path(BUSIEST)}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get(`${path(BUSIEST)}?format=csv&limit=3`);
      const json = await get(`${path(BUSIEST)}?limit=3`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}${path(BUSIEST)}?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      expect((await get(`${path(BUSIEST)}?format=csv&limit=1000`)).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`${path(BUSIEST)}?format=csv&start=2030-01-01`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get(`${path(BUSIEST)}?format=csv&type=nope`);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid type - use: sent, received' });
    });
  });
});

describe('account payments API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const LEDGER = ROWS.filter((r) => r.account === BUSIEST).sort((a, b) => b.ledger_index - a.ledger_index)[0]
    .ledger_index;
  const rows = rowsOf(BUSIEST);
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'payments');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const table of [Table.Payments, Table.AccountPayments]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
        { settings: { insert_deduplicate: 0 } },
      );
    }
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountPayments} WHERE ledger_index = {index:UInt32} AND account = {account:String}`,
      { index: LEDGER, account: BUSIEST },
    );
    expect(Number(n)).toBe(rows.filter((r) => r.ledger_index === LEDGER).length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every payment once, and a page cut inside the duplicates neither repeats nor skips a row', async () => {
    expect(rows.filter((r) => r.ledger_index === LEDGER).length).toBeGreaterThan(0);
    const unpaged = await get(`${path(BUSIEST)}?limit=1000`);
    expect(hashesIn(unpaged.body)).toEqual(hashesOfRows(rows));
    for (const limit of [1, 2, 3]) {
      expect([limit, (await pages(path(BUSIEST), limit)).flatMap(hashesIn)]).toEqual([limit, hashesOfRows(rows)]);
    }
    const desc = await pages(`${path(BUSIEST)}?descending=true`, 2);
    expect(desc.flatMap(hashesIn)).toEqual(hashesOfRows(rows).reverse());
    expect(unpaged.body.count).toBe(rows.length);
  });
});

describe('account payments API endpoint on the xahau-recorded ledgers', () => {
  const seed = 'xahau-recorded';
  const rows = [...fixtureAccountPayments(seed)].sort(byKey);
  const payments = fixturePayments(seed);
  const hashOf = new Map(payments.map((p) => [keyOf(p.row), p.row.tx_hash]));
  const mine = (account: string): AccountPaymentsRow[] => rows.filter((r) => r.account === account);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.account, (counts.get(r.account) ?? 0) + 1);
  const [PAYEE] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  beforeAll(async () => {
    h = await startHarness({ seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists the payments of an account, with XAH as the native currency', async () => {
    const res = await get(`${path(PAYEE)}?limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(mine(PAYEE).length);
    expect(hashesIn(res.body)).toEqual(mine(PAYEE).map((r) => hashOf.get(keyOf(r))));
    for (const p of (res.body as ListBody).payments) {
      expect(p.currency).toBe('XAH');
      expect(p).not.toHaveProperty('issuer');
      expect(p.source_currency).toBe('XAH');
    }
  });

  it('type, currency and the CSV name use XAH', async () => {
    const sent = mine(PAYEE).filter((r) => r.direction === 'sent');
    const received = mine(PAYEE).filter((r) => r.direction === 'received');
    expect(sent.length + received.length).toBe(mine(PAYEE).length);
    expect((await get(`${path(PAYEE)}?type=sent&limit=1000`)).body.count).toBe(sent.length);
    expect((await get(`${path(PAYEE)}?type=received&limit=1000`)).body.count).toBe(received.length);
    expect((await get(`${path(PAYEE)}?currency=xah&limit=1000`)).body.count).toBe(mine(PAYEE).length);
    // on Xahau an issued currency can be called XRP; the native one is not
    expect((await get(`${path(PAYEE)}?currency=XRP`)).body.count).toBe(0);
    const csv = await get(`${path(PAYEE)}?format=csv&currency=xah&type=received&limit=10`);
    expect(csv.headers['content-disposition']).toBe(`attachment; filename=${PAYEE} - payments received XAH.csv`);
    expect(csv.text.split('\n')).toHaveLength(1 + Math.min(10, received.length));
  });

  it('pages, windows and an empty range work as on XRPL', async () => {
    const walked = await api.pages<ListBody>(path(PAYEE), 7, 'payments');
    expect(walked.flatMap(hashesIn)).toEqual(mine(PAYEE).map((r) => hashOf.get(keyOf(r))));
    const mid = mine(PAYEE)[Math.floor(mine(PAYEE).length / 2)].close_time;
    const res = await get(`${path(PAYEE)}?limit=1000&start=${iso(mid)}`);
    expect(hashesIn(res.body)).toEqual(
      mine(PAYEE)
        .filter((r) => r.close_time >= mid)
        .map((r) => hashOf.get(keyOf(r))),
    );
    expect((await get(`${path(PAYEE)}?start=2030-01-01`)).body.count).toBe(0);
  });
});

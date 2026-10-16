import { PaymentsRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { FixturePayment, fixturePayments } from './support/fixtures';
import { expectBoundedInOrderRead, innerRead, isPageRead } from './support/plans';

/**
 * `GET /v2/payments` and `GET /v2/payments/:currency` on a real ClickHouse, seeded with the 54 ledgers of the original
 * Ripple test suite (`ripple-mock`: 182 payments, 99 of them XRP, 37 CNY of one issuer) and with the Xahau ledgers
 * recorded from a public node (172 payments, all XAH).
 *
 * Ported from rippled-historical-database `test/test.payments.js` (all 9 `it`s, same titles, none skipped). Two of them
 * lean on HBase and are ported to what this API holds instead:
 *  - 'should make sure exchanges handles pagination correctly' (sic) walks the CNY payments one by one with `limit=1`
 *    and compares each with the unpaged list, as the original does; only the marker is this API's;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`20130611200120|000001021029|00001`); the marker of this API is the `(ledger_index, tx_index)` of the last row.
 *
 * Added: the shape of a Payment (fields, key order, which fields are strings, which are left out when absent, tags of
 * 0 kept), the response envelope, every way to write the currency, the tables a list reads, `XRP+issuer` and the other
 * mistakes of the currency, the order of the checks, ordering, marker pages, limits, CSV, rows that were written twice
 * and the failure path.
 */

const byKey = (a: FixturePayment, b: FixturePayment): number =>
  a.row.ledger_index - b.row.ledger_index || a.row.tx_index - b.row.tx_index;
/** Every mock payment in the order of the list, ascending. */
const ALL = [...fixturePayments('ripple-mock')].sort(byKey);

const CNY = 'CNY+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
const isCny = (p: FixturePayment): boolean => p.row.currency === 'CNY' && p.row.issuer === CNY.split('+')[1];
const isNative = (p: FixturePayment): boolean => p.row.issuer === '' && p.row.currency === 'XRP';

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** The payments of the ledgers that closed in `[from, before)`. */
const closedBetween = (from: string, before: string): FixturePayment[] =>
  ALL.filter((p) => p.row.close_time >= unix(from) && p.row.close_time < unix(before));
/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const executedTime = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** The marker of a row: `(ledger_index, tx_index)` as base64url JSON. */
const markerOf = (row: PaymentsRow): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * The Payment of a stored row, written out the way the original served it (`getPayments.js` on the columns of
 * `data.js`): the `d` family of the HBase row first, then the `f` family, each sorted by name, and last the
 * `transaction_cost` that took the place of `fee`. Optional fields are left out when the row has none; a tag of 0 is
 * a tag (ruling R10).
 */
function paymentOf(row: PaymentsRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    amount: row.amount,
    delivered_amount: row.delivered_amount,
    destination_balance_changes: JSON.parse(row.destination_balance_changes),
    max_amount: row.max_amount ?? undefined,
    source_balance_changes: JSON.parse(row.source_balance_changes),
    tx_index: row.tx_index,
    currency: row.currency,
    destination: row.destination,
    destination_tag: row.destination_tag ?? undefined,
    executed_time: executedTime(row.close_time),
    invoice_id: row.invoice_id ?? undefined,
    issuer: row.issuer === '' ? undefined : row.issuer,
    ledger_index: row.ledger_index,
    source: row.source,
    source_currency: row.source_currency,
    source_tag: row.source_tag ?? undefined,
    tx_hash: row.tx_hash,
    transaction_cost: new BigNumber(row.fee).dividedBy(1_000_000).toString(10),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
const paymentsOf = (payments: FixturePayment[]): Record<string, unknown>[] => payments.map((p) => paymentOf(p.row));

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  payments: Record<string, unknown>[];
}
const hashesIn = (body: ListBody): unknown[] => body.payments.map((p) => p.tx_hash);
const hashesOf = (payments: FixturePayment[]): string[] => payments.map((p) => p.row.tx_hash);

describe('payments API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'payments');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.payments.js -----------------------------------------------------------------------------------------

  it('should should get individual payments', async () => {
    const res = await get('/v2/payments');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.payments.length).toBe(res.body.count);
    expect(res.body.payments.length).toBe(182);
  });

  it('should should get individual payments by date', async () => {
    const start = '2015-01-14T18:28:40Z';
    const end = '2015-01-14T18:51:40Z';
    const res = await get(`/v2/payments${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.payments.length).toBe(res.body.count);
    expect(res.body.payments.length).toBe(37);
    for (const p of (res.body as ListBody).payments) {
      const time = Date.parse(p.executed_time as string);
      expect(Date.parse(start) - time).toBeLessThanOrEqual(0); // executed time less than start time
      expect(Date.parse(end) - time).toBeGreaterThanOrEqual(0); // executed time greater than end time
    }
    // and they are the payments of the ledgers that closed in the window
    expect(hashesIn(res.body)).toEqual(hashesOf(closedBetween('2015-01-14T18:28:40', '2015-01-14T18:51:41')));
  });

  it('should should get exchanges in descending order', async () => {
    const res = await get('/v2/payments?descending=true');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.payments.length).toBe(res.body.count);
    expect(res.body.count).toBeGreaterThan(1);
    let last = Infinity;
    for (const p of (res.body as ListBody).payments) {
      expect(last).toBeGreaterThanOrEqual(p.ledger_index as number);
      last = p.ledger_index as number;
    }
  });

  it('should get payments by currency+issuer', async () => {
    const res = await get(`/v2/payments/${CNY}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.payments.length).toBe(res.body.count);
    expect(res.body.payments.length).toBe(37);
  });

  it('should make sure exchanges handles pagination correctly', async () => {
    const url = `/v2/payments/${CNY}?`;
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
      expect(res.body.payments).toHaveLength(1);
      expect(res.body.payments[0].amount).toBe(ref.body.payments[i].amount);
      expect(res.body.payments[0].tx_hash).toBe(ref.body.payments[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get('/v2/payments?start=2015x');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid end time', async () => {
    const res = await get('/v2/payments?end=2015x');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should return an error for missing issuer', async () => {
    const res = await get('/v2/payments/USD');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('issuer is required');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get('/v2/payments?limit=1');
    expect(res.status).toBe(200);
    // the marker of this API is the key of the last row of the page
    const marker = markerOf(ALL[0].row);
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/payments?limit=1&marker=${marker}>; rel="next"`);
  });

  // -- the Payment ------------------------------------------------------------------------------------------------

  describe('the payment object', () => {
    it('every payment of the mock ledgers is served, oldest first, as the original formats it', async () => {
      const res = await get('/v2/payments?limit=1000');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(182);
      expect(res.body.payments).toEqual(paymentsOf(ALL));
      // `toEqual` does not look at the order of the keys
      (res.body as ListBody).payments.forEach((p, i) =>
        expect([i, Object.keys(p)]).toEqual([i, Object.keys(paymentOf(ALL[i].row))]),
      );
    });

    it('has the fields of the spec: the d family, the f family, then transaction_cost', async () => {
      const full = ALL.find((p) => p.row.max_amount !== null && p.row.destination_tag !== null && p.row.issuer !== '');
      expect(full).toBeDefined();
      const res = await get(`/v2/payments?start=${executedTime((full as FixturePayment).row.close_time)}&limit=1000`);
      const served = (res.body as ListBody).payments.find((p) => p.tx_hash === (full as FixturePayment).row.tx_hash);
      expect(Object.keys(served as object)).toEqual([
        'amount',
        'delivered_amount',
        'destination_balance_changes',
        'max_amount',
        'source_balance_changes',
        'tx_index',
        'currency',
        'destination',
        'destination_tag',
        'executed_time',
        'issuer',
        'ledger_index',
        'source',
        'source_currency',
        'tx_hash',
        'transaction_cost',
      ]);
    });

    it('amounts and the cost are strings, the indexes and tags numbers, the balance changes arrays', async () => {
      const res = await get('/v2/payments?limit=1000');
      for (const p of (res.body as ListBody).payments) {
        expect(typeof p.amount).toBe('string');
        expect(typeof p.delivered_amount).toBe('string');
        expect(typeof p.transaction_cost).toBe('string');
        expect(typeof p.executed_time).toBe('string');
        expect(typeof p.ledger_index).toBe('number');
        expect(typeof p.tx_index).toBe('number');
        expect(Array.isArray(p.source_balance_changes)).toBe(true);
        expect(Array.isArray(p.destination_balance_changes)).toBe(true);
        if (p.max_amount !== undefined) expect(typeof p.max_amount).toBe('string');
        for (const tag of [p.source_tag, p.destination_tag]) {
          if (tag !== undefined) expect(typeof tag).toBe('number');
        }
        // the fee is not served under its stored name, nor the client or the Float64 shadow
        for (const stored of ['fee', 'client', 'delivered_amount_f', 'close_time', 'rowkey']) {
          expect(p).not.toHaveProperty(stored);
        }
      }
    });

    it('transaction_cost is the fee in whole units of the native currency', async () => {
      const first = ALL[0];
      expect(first.row.fee).toBe('10');
      const res = await get('/v2/payments?limit=1');
      expect(res.body.payments[0].transaction_cost).toBe('0.00001');
      // never in exponent notation, whatever the fee (the README of the original shows 1.0E-5)
      const all = await get('/v2/payments?limit=1000');
      for (const p of (all.body as ListBody).payments) expect(p.transaction_cost).toMatch(/^\d+(\.\d+)?$/);
    });

    it('executed_time is the close time of the ledger, YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get('/v2/payments?limit=1');
      expect(res.body.payments[0].executed_time).toBe('2013-06-11T20:01:20Z');
      expect(res.body.payments[0].executed_time).toBe(executedTime(ALL[0].row.close_time));
    });

    it('balance changes are the stored JSON, parsed back', async () => {
      const res = await get('/v2/payments?limit=1');
      expect(res.body.payments[0].source_balance_changes).toEqual([
        { counterparty: '', currency: 'XRP', value: '-1000' },
      ]);
      expect(res.body.payments[0].destination_balance_changes).toEqual([
        { counterparty: '', currency: 'XRP', value: '1000' },
      ]);
      expect(Object.keys(res.body.payments[0].source_balance_changes[0])).toEqual([
        'counterparty',
        'currency',
        'value',
      ]);
    });

    it('optional fields are left out when the payment has none', async () => {
      const res = await get('/v2/payments?limit=1000');
      const served = (res.body as ListBody).payments;
      const missing = (field: string, row: PaymentsRow): boolean =>
        field === 'issuer'
          ? row.issuer === ''
          : field === 'max_amount'
            ? row.max_amount === null
            : field === 'invoice_id'
              ? row.invoice_id === null
              : field === 'source_tag'
                ? row.source_tag === null
                : row.destination_tag === null;
      for (const field of ['issuer', 'max_amount', 'invoice_id', 'source_tag', 'destination_tag']) {
        const absent = ALL.filter((p) => missing(field, p.row));
        expect([field, absent.length]).not.toEqual([field, 0]);
        for (const p of absent) {
          const s = served.find((x) => x.tx_hash === p.row.tx_hash) as Record<string, unknown>;
          expect([field, p.row.tx_hash, field in s]).toEqual([field, p.row.tx_hash, false]);
        }
        // and present where the payment has it
        const present = ALL.filter((p) => !missing(field, p.row));
        expect([field, present.length]).not.toEqual([field, 0]);
      }
    });

    it('a tag of 0 is kept (R10): the original dropped it', async () => {
      const zero = ALL.filter((p) => p.row.source_tag === 0 || p.row.destination_tag === 0);
      expect(zero.length).toBeGreaterThan(0);
      const res = await get('/v2/payments?limit=1000');
      for (const p of zero) {
        const s = (res.body as ListBody).payments.find((x) => x.tx_hash === p.row.tx_hash) as Record<string, unknown>;
        if (p.row.source_tag === 0) expect(s.source_tag).toBe(0);
        if (p.row.destination_tag === 0) expect(s.destination_tag).toBe(0);
      }
    });

    it('an issued currency has its issuer, the native currency has none', async () => {
      const res = await get('/v2/payments?limit=1000');
      for (const p of (res.body as ListBody).payments) {
        if (p.currency === 'XRP') expect(p).not.toHaveProperty('issuer');
        else expect(typeof p.issuer).toBe('string');
      }
    });

    it('a payment with a SendMax has max_amount and the source currency of it', async () => {
      const sendMax = ALL.filter((p) => p.row.max_amount !== null);
      expect(sendMax.length).toBe(63);
      const res = await get('/v2/payments?limit=1000');
      for (const p of sendMax) {
        const s = (res.body as ListBody).payments.find((x) => x.tx_hash === p.row.tx_hash) as Record<string, unknown>;
        expect(s.max_amount).toBe(p.row.max_amount);
        expect(s.source_currency).toBe(p.row.source_currency);
      }
    });

    it('invoice_id is served when the payment has one', async () => {
      const withInvoice = ALL.find((p) => p.row.invoice_id !== null);
      expect(withInvoice).toBeDefined();
      const res = await get('/v2/payments?limit=1000');
      const s = (res.body as ListBody).payments.find((x) => x.tx_hash === withInvoice?.row.tx_hash);
      expect(s?.invoice_id).toBe(withInvoice?.row.invoice_id);
    });
  });

  // -- the envelope -------------------------------------------------------------------------------------------------

  describe('the response', () => {
    it('is result, count, marker, payments for all currencies', async () => {
      const res = await get('/v2/payments?limit=5');
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'payments']);
      const last = await get('/v2/payments?limit=1000');
      expect(Object.keys(last.body)).toEqual(['result', 'count', 'payments']);
    });

    it('has no currency or issuer at the top, whatever the path (the original never served them)', async () => {
      const keys = ['result', 'count', 'marker', 'payments'];
      for (const path of [
        `/v2/payments/${CNY}`,
        '/v2/payments/XRP',
        '/v2/payments/cny+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y',
      ]) {
        const res = await get(`${path}?limit=5`);
        expect([path, Object.keys(res.body)]).toEqual([path, keys]);
        expect(res.body).not.toHaveProperty('currency');
        expect(res.body).not.toHaveProperty('issuer');
      }
    });

    it('is only result, count and payments for a currency without payments', async () => {
      const res = await get('/v2/payments/USD+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
      expect(res.body).toEqual({ result: 'success', count: 0, payments: [] });
    });
  });

  // -- the currency -------------------------------------------------------------------------------------------------

  describe('/v2/payments/:currency', () => {
    it('lists the payments of the currency and issuer, oldest first', async () => {
      const cny = ALL.filter(isCny);
      expect(cny).toHaveLength(37);
      const res = await get(`/v2/payments/${CNY}`);
      expect(res.body.payments).toEqual(paymentsOf(cny));
    });

    it('lists the payments of the native currency without an issuer', async () => {
      const xrp = ALL.filter(isNative);
      expect(xrp).toHaveLength(99);
      const res = await get('/v2/payments/XRP');
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual(paymentsOf(xrp));
    });

    it('every currency of the mock ledgers lists exactly its payments', async () => {
      const assets = new Map<string, FixturePayment[]>();
      for (const p of ALL) {
        const key = p.row.issuer === '' ? p.row.currency : `${p.row.currency}+${p.row.issuer}`;
        assets.set(key, [...(assets.get(key) ?? []), p]);
      }
      expect(assets.size).toBe(6);
      let total = 0;
      for (const [path, expected] of assets) {
        const res = await get(`/v2/payments/${path}?limit=1000`);
        expect([path, res.status]).toEqual([path, 200]);
        expect([path, hashesIn(res.body)]).toEqual([path, hashesOf(expected)]);
        total += res.body.count;
      }
      expect(total).toBe(182);
    });

    it('the currency and the issuer are split at +, | or . and the currency is upper-cased', async () => {
      const cny = hashesOf(ALL.filter(isCny));
      const [currency, issuer] = CNY.split('+');
      for (const path of [CNY, `${currency}.${issuer}`, `${currency}%7C${issuer}`, `cny+${issuer}`, `Cny.${issuer}`]) {
        const res = await get(`/v2/payments/${path}`);
        expect([path, res.status, hashesIn(res.body)]).toEqual([path, 200, cny]);
      }
    });

    it('a currency or an issuer that has no payments → count 0', async () => {
      const issuer = CNY.split('+')[1];
      expect((await get(`/v2/payments/USD+${issuer}`)).body.count).toBe(0);
      expect((await get('/v2/payments/CNY+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q')).body.count).toBe(0);
    });

    it('pages payments_by_currency for the keys, then reads the rows of the page from payments by their keys', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/payments/${CNY}?limit=10`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(10);

      const paging = query.mock.calls.filter(([q]) => String(q).includes(Table.PaymentsByCurrency));
      expect(paging).toHaveLength(1);
      const sql = String(paging[0][0]);
      const params = paging[0][1];
      expect(sql).toMatch(/currency = \{currency:String\}/);
      expect(sql).toMatch(/issuer = \{issuer:String\}/);
      // read with a plain LIMIT, which stops the read after the page (Ruling R106); outside it a row that was written
      // twice counts once
      expect(sql).toMatch(/tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}\)/);
      expect(sql.match(/LIMIT 1 BY ledger_index, tx_index/g)).toHaveLength(1);
      expect(params).toMatchObject({ currency: 'CNY', issuer: CNY.split('+')[1], distinct_page_limit: 11 });
      // values are bound, never written into the SQL
      expect(sql).not.toContain(CNY.split('+')[1]);

      // the wide rows of the page (not the extra key), by their keys, from the ledgers of the page only
      const wide = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Payments}\\b`).test(String(q)));
      expect(wide).toHaveLength(1);
      expect(String(wide[0][0])).toMatch(/ledger_index BETWEEN \{lo:UInt32\} AND \{hi:UInt32\}/);
      expect((wide[0][1] as { ledgers: number[] }).ledgers).toHaveLength(10);
    });

    it('reads the tables in the order of their primary key, so that a page never sorts the whole range', async () => {
      // sorting the whole range is what an ORDER BY that is not a prefix of the key costs: with a currency in the way
      // (`currency, issuer, ledger_index, tx_index`) the narrow table has to be asked for the whole key. XRP is the
      // currency of the mock ledgers that spreads over parts, where ClickHouse does sort when it is not (CNY is read in
      // order either way)
      for (const descending of [false, true]) {
        const query = jest.spyOn(h.ch, 'query');
        await get(`/v2/payments/XRP?limit=5&descending=${descending}&marker=${markerOf(ALL[10].row)}`);
        await get(`/v2/payments?limit=5&descending=${descending}&marker=${markerOf(ALL[10].row)}`);
        // the keys of the currency from payments_by_currency, and the page of all currencies from payments
        const reads = query.mock.calls
          .filter(([q]) => isPageRead(String(q)))
          .map(([q, p]): [string, Record<string, unknown>] => [String(q), p as Record<string, unknown>]);
        jest.restoreAllMocks();
        expect(reads.map(([sql]) => /FROM (\w+)/.exec(innerRead(sql))?.[1])).toEqual([
          Table.PaymentsByCurrency,
          Table.Payments,
        ]);
        for (const [sql, params] of reads) {
          // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
          await expectBoundedInOrderRead(h, sql, params, descending, descending);
        }
      }
    });

    it('the native currency is looked up with the empty issuer', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get('/v2/payments/XRP?limit=2');
      const narrow = query.mock.calls.filter(([q]) => String(q).includes(Table.PaymentsByCurrency));
      expect(narrow[0][1]).toMatchObject({ currency: 'XRP', issuer: '' });
    });

    it('all currencies page payments itself and never read payments_by_currency', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/payments?limit=10');
      expect(res.body.count).toBe(10);
      const sql = query.mock.calls.map(([q]) => String(q));
      expect(sql.some((q) => q.includes(Table.PaymentsByCurrency))).toBe(false);
      expect(sql.some((q) => new RegExp(`FROM ${Table.Payments}\\b`).test(q))).toBe(true);
    });
  });

  // -- the currency mistakes ----------------------------------------------------------------------------------------

  describe('a currency that is not valid', () => {
    it('XRP with an issuer → 400 (the original searched for it and found nothing)', async () => {
      for (const path of ['XRP+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y', 'xrp.rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y']) {
        const res = await get(`/v2/payments/${path}`);
        expect([path, res.status, res.body]).toEqual([
          path,
          400,
          { result: 'error', message: 'XRP cannot have an issuer' },
        ]);
      }
    });

    it('a currency other than XRP needs an issuer', async () => {
      for (const path of ['USD', 'usd', 'CNY+', 'XAH']) {
        const res = await get(`/v2/payments/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message: 'issuer is required' }]);
      }
    });

    it('an issuer that is not an address → invalid issuer address', async () => {
      for (const path of ['USD+abc', 'USD+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432', 'CNY+0000000000000000000000000000000']) {
        const res = await get(`/v2/payments/${path}`);
        expect([path, res.status, res.body]).toEqual([
          path,
          400,
          { result: 'error', message: 'invalid issuer address' },
        ]);
      }
    });

    it('a path without a currency → 400 currency is required', async () => {
      const res = await get('/v2/payments/+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'currency is required' }]);
    });

    it('the checks come in the order of the original: issuer address, start, end, issuer, then the marker', async () => {
      const issuer = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
      const cases: [string, string][] = [
        [`/v2/payments/USD+bad${qs({ start: 'x', end: 'y', marker: '!' })}`, 'invalid issuer address'],
        [`/v2/payments/USD${qs({ start: 'x', end: 'y', marker: '!' })}`, 'invalid start date format'],
        [`/v2/payments/USD${qs({ end: 'y', marker: '!' })}`, 'invalid end date format'],
        [`/v2/payments/USD${qs({ marker: '!' })}`, 'issuer is required'],
        [`/v2/payments/USD+${issuer}${qs({ marker: '!' })}`, 'invalid marker'],
        [`/v2/payments${qs({ start: 'x', end: 'y', marker: '!' })}`, 'invalid start date format'],
        [`/v2/payments${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body.message]).toEqual([url, 400, message]);
      }
    });
  });

  // -- the shared list behaviour ---------------------------------------------------------------------------------

  describe('the list', () => {
    it('empty range → count 0', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`, '/v2/payments/XRP']) {
        const res = await get(`${path}?start=2030-01-01&end=2030-12-31`);
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body.payments).toEqual([]);
        expect(res.body.marker).toBeUndefined();
        expect(res.headers.link).toBeUndefined();
      }
      expect((await get('/v2/payments?start=2030-01-01&end=2030-12-31')).body).toEqual({
        result: 'success',
        count: 0,
        payments: [],
      });
    });

    it('a start after the last ledger → count 0; an end before the first → count 0', async () => {
      expect((await get('/v2/payments?start=2018-01-01')).body.count).toBe(0);
      expect((await get('/v2/payments?end=2013-06-01')).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`, '/v2/payments/XRP']) {
        const unpaged = await get(`${path}?limit=1000`);
        expect(unpaged.body.count).toBeGreaterThan(30);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();

        const paged = await pages(path, 3);
        expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([path, paged.flatMap((p) => p.payments)]).toEqual([path, unpaged.body.payments]);
      }
    });

    it('marker pages concatenate inside a window too', async () => {
      const window = '/v2/payments?start=2015-01-14T18:28:40&end=2015-01-14T18:51:40';
      const unpaged = await get(`${window}&limit=1000`);
      expect(unpaged.body.count).toBe(37);
      const paged = await pages(window, 4);
      expect(paged).toHaveLength(10);
      expect(paged.flatMap((p) => p.payments)).toEqual(unpaged.body.payments);
    });

    it('descending reverses order', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`, '/v2/payments/XRP']) {
        const asc = await get(`${path}?limit=1000`);
        const desc = await get(`${path}?limit=1000&descending=true`);
        expect(asc.body.count).toBeGreaterThan(1);
        expect([path, desc.body.payments]).toEqual([path, [...asc.body.payments].reverse()]);
        // the markers of a descending list continue downwards
        const pagedDesc = await pages(`${path}?descending=true`, 7);
        expect([path, pagedDesc.flatMap((p) => p.payments)]).toEqual([path, desc.body.payments]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get('/v2/payments?limit=5');
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/payments?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get('/v2/payments?limit=5&descending=true');
      expect((await get('/v2/payments?limit=5&descending=TRUE')).body).toEqual(desc.body);
      expect(hashesIn(desc.body)).toEqual(hashesOf(ALL.slice(-5).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get('/v2/payments?limit=5');
      const res = await get('/v2/payments?limit=5&foo=bar&interval=day&reduce=true');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get('/v2/payments?limit=3&limit=50&descending=true&descending=false');
      expect(res.body.count).toBe(3);
      expect(hashesIn(res.body)).toEqual(hashesOf(ALL.slice(-3).reverse()));
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-02-09', end: '2015-02-09' }, '2015-02-09T00:00:00', '2015-02-10T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ start: '2015-01-14T18:27:10Z', end: '2015-01-14T18:27:20Z' }, '2015-01-14T18:27:10', '2015-01-14T18:27:21'],
        [{ start: '2013' }, '2013-01-01T00:00:00', '2100-01-01T00:00:00'],
        [{ end: '2013-12' }, '2000-01-01T00:00:00', '2014-01-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const expected = closedBetween(from, before);
        expect(expected.length).toBeGreaterThan(0);
        const listed = (await pages(`/v2/payments${qs(params)}`, 100)).flatMap(hashesIn);
        expect([params, listed]).toEqual([params, hashesOf(expected)]);
      }
    });

    it('start defaults to the beginning of time; an empty start is the default, an empty end is invalid', async () => {
      expect((await get('/v2/payments?start=')).body.count).toBe(182);
      const res = await get('/v2/payments?end=');
      expect([res.status, res.body.message]).toEqual([400, 'invalid end date format']);
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`/v2/payments${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
    });

    // -- limit --

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
        const query$ = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/payments?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = query$.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Payments}\\b`).test(String(q)));
        expect([query, res.status, paging[0][1]]).toEqual([
          query,
          200,
          expect.objectContaining({ distinct_page_limit: rows + 1 }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, 182)]);
        jest.restoreAllMocks();
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const last = await get('/v2/payments?limit=1000');
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();

      // exactly as many as the limit: no marker either
      const exact = await get('/v2/payments?limit=182');
      expect(exact.body.count).toBe(182);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      const more = await get('/v2/payments?limit=181');
      expect(more.body.count).toBe(181);
      expect(more.body.marker).toBe(markerOf(ALL[180].row));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(`/v2/payments/${CNY}${qs({ limit: 2, start: '2013-01-01T00:00:00+00:00' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}/v2/payments/${CNY}?limit=2&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`/v2/payments?limit=2&marker=${first.body.marker}&descending=true`);
      expect(second.headers.link).toBe(
        `<${new URL(second.request.url).origin}/v2/payments?limit=2&marker=${second.body.marker}&descending=true>; rel="next"`,
      );
    });

    // -- marker --

    it('Link header present when marker present', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`]) {
        const res = await get(`${path}?limit=2`);
        expect(res.body.marker).toBeDefined();
        expect(res.headers.link).toBe(
          `<${new URL(res.request.url).origin}${path}?limit=2&marker=${res.body.marker}>; rel="next"`,
        );
        const rest = await get(`${path}?limit=1000&marker=${res.body.marker}`);
        expect(rest.body.marker).toBeUndefined();
        expect(rest.headers.link).toBeUndefined();
      }
    });

    it('tampered marker → 400 invalid marker', async () => {
      const bad = [
        '20130611200120|000001021029|00001',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2,3]').toString('base64url'),
        Buffer.from('["a",1]').toString('base64url'),
        Buffer.from('[-1,0]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
        `${markerOf(ALL[3].row)}x!`,
      ];
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`]) {
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
      const at = ALL[100];
      const asc = await get(`/v2/payments?limit=3&marker=${markerOf(at.row)}`);
      expect(hashesIn(asc.body)).toEqual(hashesOf(ALL.slice(101, 104)));
      const desc = await get(`/v2/payments?limit=3&descending=true&marker=${markerOf(at.row)}`);
      expect(hashesIn(desc.body)).toEqual(hashesOf([ALL[99], ALL[98], ALL[97]]));
      // a marker beyond the stored history is still a marker
      const beyond = await get(`/v2/payments?marker=${Buffer.from('[999999999,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, payments: [] });
      // a CNY list continues with the next CNY payment, not the next payment
      const cny = ALL.filter(isCny);
      const next = await get(`/v2/payments/${CNY}?limit=2&marker=${markerOf(cny[5].row)}`);
      expect(hashesIn(next.body)).toEqual(hashesOf(cny.slice(6, 8)));
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`/v2/payments?start=2030-01-01&marker=${markerOf(ALL[3].row)}`);
      expect(res.body).toEqual({ result: 'success', count: 0, payments: [] });
    });

    it('is 500 unable to retrieve payments when the database fails', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`]) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const res = await get(path);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve payments' });
      }
    });

    it('is 500 unable to retrieve payments when the page fails after the range was found', async () => {
      for (const path of ['/v2/payments', `/v2/payments/${CNY}`]) {
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(Table.Payments) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([
          path,
          500,
          { result: 'error', message: 'unable to retrieve payments' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- CSV --------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one flattened row per payment', async () => {
      const res = await get('/v2/payments?format=csv&limit=1000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('payments'));
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 182);
      // the columns are the keys of all rows in the order they first appear, nested ones joined with dots
      const header = rows[0].split(',');
      expect(header.slice(0, 5)).toEqual([
        '"amount"',
        '"delivered_amount"',
        '"destination_balance_changes[0].counterparty"',
        '"destination_balance_changes[0].currency"',
        '"destination_balance_changes[0].value"',
      ]);
      expect(header).toContain('"source_balance_changes[0].value"');
      expect(header).toContain('"transaction_cost"');
      expect(header).toContain('"executed_time"');
      expect(rows[1]).toContain(`"${ALL[0].row.tx_hash}"`);
      expect(rows[1]).toContain('"2013-06-11T20:01:20Z"');
    });

    it('is named after the currency and the issuer of the path: payments - CUR ISSUER', async () => {
      const cny = await get(`/v2/payments/${CNY}?format=csv`);
      expect(cny.headers['content-type']).toMatch(/^text\/csv/);
      expect(cny.headers['content-disposition']).toBe(
        csvDisposition('payments - CNY rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y'),
      );
      expect(lines(cny.text)).toHaveLength(1 + 37);

      const xrp = await get('/v2/payments/XRP?format=csv');
      expect(xrp.headers['content-disposition']).toBe(csvDisposition('payments - XRP'));
      expect(lines(xrp.text)).toHaveLength(1 + 99);

      // the currency in upper case, the issuer as written, whatever the separator
      const issuer = CNY.split('+')[1];
      for (const path of [`cny.${issuer}`, `Cny%7C${issuer}`]) {
        const res = await get(`/v2/payments/${path}?format=csv`);
        expect([path, res.headers['content-disposition']]).toEqual([path, csvDisposition(`payments - CNY ${issuer}`)]);
      }
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get('/v2/payments?format=CSV&limit=1')).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/payments?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get('/v2/payments?format=csv&limit=3');
      const json = await get('/v2/payments?limit=3');
      expect(csv.headers.link).toBeDefined();
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/payments?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      // the last page has none
      expect((await get('/v2/payments?format=csv&limit=1000')).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get('/v2/payments?format=csv&start=2030-01-01');
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/payments/USD?format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'issuer is required' });
    });
  });
});

describe('payments API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const counts = new Map<number, number>();
  for (const p of ALL) counts.set(p.row.ledger_index, (counts.get(p.row.ledger_index) ?? 0) + 1);
  const LEDGER = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const written = ALL.filter((p) => p.row.ledger_index === LEDGER);
  const closeTime = written[0].row.close_time;
  const second = new Date(closeTime * 1000).toISOString().slice(0, 19);
  // the window holds this ledger and any other that closed in the same second
  const inWindow = closedBetween(second, new Date(closeTime * 1000 + 1000).toISOString().slice(0, 19));
  const window = `/v2/payments?start=${second}&end=${second}`;
  // the most common currency of the ledger, for the list of a currency
  const sample = written[0].row;
  const samePath = sample.issuer === '' ? sample.currency : `${sample.currency}+${sample.issuer}`;
  const sameCurrency = ALL.filter((p) => p.row.currency === sample.currency && p.row.issuer === sample.issuer);

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'payments');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const table of [Table.Payments, Table.PaymentsByCurrency]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
        { settings: { insert_deduplicate: 0 } },
      );
    }
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Payments} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
    );
    expect(Number(n)).toBe(written.length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every payment once', async () => {
    expect(written.length).toBeGreaterThan(2);
    const unpaged = await get(`${window}&limit=1000`);
    expect(hashesIn(unpaged.body)).toEqual(hashesOf(inWindow));
    expect(unpaged.body.payments).toEqual(paymentsOf(inWindow));
    // and a page cut inside the duplicates neither repeats nor skips a row
    for (const limit of [1, 2, 3]) {
      const paged = (await pages(window, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(inWindow)]);
    }
  });

  it('lists every payment of a currency once', async () => {
    expect(sameCurrency.length).toBeGreaterThan(written.length);
    const unpaged = await get(`/v2/payments/${samePath}?limit=1000`);
    expect(hashesIn(unpaged.body)).toEqual(hashesOf(sameCurrency));
    for (const limit of [1, 2, 3]) {
      const paged = (await pages(`/v2/payments/${samePath}`, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(sameCurrency)]);
    }
    // descending too
    const desc = await pages(`/v2/payments/${samePath}?descending=true`, 2);
    expect(desc.flatMap(hashesIn)).toEqual(hashesOf(sameCurrency).reverse());
  });

  it('counts every payment once in the whole list', async () => {
    const res = await get('/v2/payments?limit=1000');
    expect(res.body.count).toBe(182);
    expect(hashesIn(res.body)).toEqual(hashesOf(ALL));
  });
});

describe('payments API endpoint on the xahau-recorded ledgers', () => {
  const seed = 'xahau-recorded';
  const all = [...fixturePayments(seed)].sort(byKey);
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'payments');
  beforeAll(async () => {
    h = await startHarness({ seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists the 172 payments of the recorded ledgers, with XAH as the native currency', async () => {
    expect(all).toHaveLength(172);
    const seen = (await pages('/v2/payments', 100)).flatMap((page) => page.payments);
    expect(seen).toEqual(paymentsOf(all));
    for (const p of seen) {
      expect(p.currency).toBe('XAH');
      expect(p).not.toHaveProperty('issuer');
      expect(p.source_currency).toBe('XAH');
    }
  });

  it('the cost of a payment is the fee in XAH; the balance changes are in XAH', async () => {
    const res = await get('/v2/payments?limit=1');
    const p = res.body.payments[0];
    expect(all[0].row.fee).toBe('7056');
    expect(p.transaction_cost).toBe('0.007056');
    expect(p.executed_time).toBe(executedTime(all[0].row.close_time));
    for (const change of [...p.source_balance_changes, ...p.destination_balance_changes]) {
      expect(change.currency).toBe('XAH');
      expect(change.counterparty).toBe('');
    }
  });

  it('/v2/payments/XAH lists the native payments, with no currency or issuer at the top', async () => {
    const res = await api.ok<ListBody>('/v2/payments/XAH?limit=1000', 'payments');
    expect(Object.keys(res.body)).toEqual(['result', 'count', 'payments']);
    expect(res.body.count).toBe(172);
    expect(res.body.payments).toEqual(paymentsOf(all));
    const paged = (await pages('/v2/payments/xah', 50)).flatMap(hashesIn);
    expect(paged).toEqual(hashesOf(all));
  });

  it('XAH takes the place of XRP: XRP needs an issuer, XAH cannot have one', async () => {
    const xrp = await get('/v2/payments/XRP');
    expect([xrp.status, xrp.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
    const issuer = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
    const withIssuer = await get(`/v2/payments/XAH+${issuer}`);
    expect([withIssuer.status, withIssuer.body]).toEqual([
      400,
      { result: 'error', message: 'XAH cannot have an issuer' },
    ]);
    // an issued currency that is called XRP on Xahau is an ordinary currency
    const issued = await get(`/v2/payments/XRP+${issuer}`);
    expect([issued.status, issued.body.count]).toEqual([200, 0]);
  });

  it('format=csv is named after XAH', async () => {
    const res = await get('/v2/payments/XAH?format=csv&limit=10');
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(csvDisposition('payments - XAH'));
    expect(res.text.split('\n')).toHaveLength(1 + 10);
    expect(res.headers.link).toBeDefined();
  });

  it('a window of the recorded ledgers, and an empty one', async () => {
    const mid = all[Math.floor(all.length / 2)].row.close_time;
    const from = executedTime(mid).slice(0, 19);
    const expected = all.filter((p) => p.row.close_time >= mid);
    const res = await get(`/v2/payments?limit=1000&start=${from}`);
    expect(hashesIn(res.body)).toEqual(hashesOf(expected));
    expect((await get('/v2/payments?start=2030-01-01')).body.count).toBe(0);
  });
});

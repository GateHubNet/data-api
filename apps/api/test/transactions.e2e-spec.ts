import { Table } from '@gatehub/data-api-shared';
import { Harness, startHarness } from './harness';
import { FixtureTx, fixtureTransaction, fixtureTransactions, transactionId } from './support/fixtures';
import { expectBoundedInOrderRead, isPageRead } from './support/plans';

/**
 * `GET /v2/transactions/:tx_hash` and `GET /v2/transactions` on a real ClickHouse, seeded with the 54 ledgers of the
 * original Ripple test suite (`ripple-mock`: 933 transactions, 188 of them Payments).
 *
 * Ported from rippled-historical-database `test/test.transactions.js` (all 17 `it`s, same titles, none skipped). Two of
 * them lean on HBase and are ported to what the mock ledgers hold instead:
 *  - 'should return transactions by time' asked for 100 of the transactions of a full HBase; the mock ledgers hold
 *    933, so the page is full all the same (count 100, with a marker);
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`20130611200120|000001021029|00001`); the marker of this API is the `(ledger_index, tx_index)` of the last row.
 *
 * Added: the hash rules (upper case, even length), the shape of the objects (no `ledger_hash` on a single
 * transaction, one on every list item), `type` and `result` against the definitions of the network instead of the
 * stale list of the original, the tables the list reads, ordering, marker pages, limits, rows that were written twice
 * and the failure paths. The original has no CSV for transactions, so `format=csv` is ignored.
 */

const MOCK_PAYMENT = '22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DA';

const byKey = (a: FixtureTx, b: FixtureTx): number =>
  a.row.ledger_index - b.row.ledger_index || a.row.tx_index - b.row.tx_index;
/** Every mock transaction in the order of the list, ascending. */
const ALL = [...fixtureTransactions('ripple-mock')].sort(byKey);
const LEDGER_HASH = new Map(ALL.map((t) => [t.row.ledger_index, t.ledger.header.ledger_hash]));
const hashesOf = (txs: FixtureTx[]): string[] => txs.map((t) => t.tx.hash);
const hashesIn = (body: ListBody): string[] => body.transactions.map((t) => t.hash);
/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** The transactions of the ledgers that closed in `[from, before)`. */
const closedBetween = (from: string, before: string): FixtureTx[] =>
  ALL.filter((t) => t.ledger.header.close_time >= unix(from) && t.ledger.header.close_time < unix(before));
/** `YYYY-MM-DDTHH:mm:ss+00:00` of unix seconds. */
const txDate = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}+00:00`;
/** The marker of a row: `(ledger_index, tx_index)` as base64url JSON. */
const markerOf = (t: FixtureTx): string =>
  Buffer.from(JSON.stringify([t.row.ledger_index, t.row.tx_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

function api(h: Harness) {
  return (path: string) => h.http().get(path).set('X-API-Key', h.key);
}

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  transactions: {
    hash: string;
    ledger_index: number;
    date: string;
    ledger_hash?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: any;
  }[];
}

describe('transactions API endpoint', () => {
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    get = api(h);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** Every page of a list, following the markers; the pages are returned in order. */
  async function pages(path: string, limit: number): Promise<ListBody[]> {
    const out: ListBody[] = [];
    let marker: string | undefined;
    do {
      const res = await get(
        `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${marker ? `&marker=${marker}` : ''}`,
      );
      expect(res.status).toBe(200);
      out.push(res.body as ListBody);
      marker = (res.body as ListBody).marker;
      expect(out.length).toBeLessThan(1000);
    } while (marker);
    return out;
  }

  // -- test.transactions.js: /v2/transactions/:tx_hash ----------------------------------------------------------

  it('should return a transaction given a transaction hash', async () => {
    const res = await get(`/v2/transactions/${MOCK_PAYMENT}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(typeof res.body.transaction).toBe('object');
    expect(res.body.transaction.hash).toBe(MOCK_PAYMENT);
    expect(typeof res.body.transaction.tx).toBe('object');
    expect(typeof res.body.transaction.meta).toBe('object');
    expect(res.body.transaction.meta.delivered_amount).toBe('300000000');
  });

  it('should return a transaction in binary', async () => {
    const res = await get(`/v2/transactions/${MOCK_PAYMENT}?binary=true`);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(typeof res.body.transaction).toBe('object');
    expect(res.body.transaction.hash).toBe(MOCK_PAYMENT);
    expect(typeof res.body.transaction.tx).toBe('string');
    expect(typeof res.body.transaction.meta).toBe('string');
  });

  it('should return an error if the transaction is not found', async () => {
    const res = await get('/v2/transactions/22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47DC');
    expect(res.status).toBe(404);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('transaction not found');
  });

  it('should return an error if the hash is invalid', async () => {
    const res = await get('/v2/transactions/22F26CE4E2270CE3CF4EB61C609E7ADEDCD41D4C1BA2D96D680A9B016C4F47D');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid hash');
  });

  // -- test.transactions.js: /v2/transactions -------------------------------------------------------------------

  it('should return transactions by time', async () => {
    const res = await get('/v2/transactions/?limit=100');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(100);
    expect(res.body.marker).not.toBeUndefined();
    expect(res.body.transactions.length).not.toBe(0);
    let prev: number | undefined;
    for (const t of (res.body as ListBody).transactions) {
      expect(t.hash).toBeTruthy();
      expect(t.date).toBeTruthy();
      expect(t.ledger_index).toBeTruthy();
      expect(t.tx).toBeTruthy();
      expect(t.meta).toBeTruthy();
      const date = Date.parse(t.date);
      if (prev !== undefined) expect(date - prev).toBeGreaterThanOrEqual(0);
      prev = date;
    }
  });

  it('should handle descending = false', async () => {
    const res = await get('/v2/transactions/?limit=100&descending=false');
    expect(res.body.transactions.length).not.toBe(0);
    let prev: number | undefined;
    for (const t of (res.body as ListBody).transactions) {
      const date = Date.parse(t.date);
      if (prev !== undefined) expect(date - prev).toBeGreaterThanOrEqual(0);
      prev = date;
    }
  });

  it('should return transactions in binary', async () => {
    const res = await get('/v2/transactions/?binary=true');
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.transactions.length).not.toBe(0);
    for (const t of (res.body as ListBody).transactions) {
      expect(t.hash).toBeTruthy();
      expect(t.date).toBeTruthy();
      expect(t.ledger_index).toBeTruthy();
      expect(typeof t.tx).toBe('string');
      expect(typeof t.meta).toBe('string');
    }
  });

  it('should restrict results based on time', async () => {
    const start = '2015-02-09T18:14:20+00:00';
    const end = '2015-02-09T18:14:50+00:00';
    const res = await get(`/v2/transactions/${qs({ start, end })}`);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.transactions).toHaveLength(11);
    for (const t of (res.body as ListBody).transactions) {
      const date = Date.parse(t.date);
      expect(date).toBeGreaterThan(Date.parse(start));
      expect(date).toBeLessThan(Date.parse(end));
    }
  });

  it('should handle pagination correctly', async () => {
    const url = `/v2/transactions${qs({ start: '2015-02-09T18:14:40', end: '2015-02-09T18:14:50' })}`;
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1);

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}&limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].hash).toBe(ref.body.transactions[i].hash);
      expect(res.body.transactions[0].ledger_index).toBe(ref.body.transactions[i].ledger_index);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should filter by transaction type', async () => {
    const type = 'OfferCreate';
    const res = await get(`/v2/transactions/?type=${type}`);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.transactions.length).not.toBe(0);
    for (const t of (res.body as ListBody).transactions) expect(t.tx.TransactionType).toBe(type);
  });

  it('should filter by transaction result', async () => {
    const result = 'tecUNFUNDED_OFFER';
    const res = await get(`/v2/transactions/?result=${result}`);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.transactions).toHaveLength(14);
    for (const t of (res.body as ListBody).transactions) expect(t.meta.TransactionResult).toBe(result);
  });

  it('should give an error for an invalid transaction result', async () => {
    const res = await get('/v2/transactions/?result=tecZ');
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('invalid transaction result');
  });

  it('should give an error for an invalid transaction type', async () => {
    const res = await get('/v2/transactions/?type=Transaction');
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('invalid transaction type');
  });

  it('should give an error for an invalid start date', async () => {
    const res = await get('/v2/transactions/?start=11111111a');
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should give an error for an invalid end date', async () => {
    const res = await get('/v2/transactions/?end=12-12-2014');
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get('/v2/transactions?limit=1');
    expect(res.status).toBe(200);
    // the marker of this API is the key of the last row of the page
    const marker = markerOf(ALL[0]);
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/transactions?limit=1&marker=${marker}>; rel="next"`);
  });

  // -- the single transaction -----------------------------------------------------------------------------------

  describe('/v2/transactions/:tx_hash', () => {
    it('hash is upper-cased', async () => {
      const res = await get(`/v2/transactions/${MOCK_PAYMENT.toLowerCase()}`);
      expect(res.status).toBe(200);
      expect(res.body.transaction.hash).toBe(MOCK_PAYMENT);
      const mixed = MOCK_PAYMENT.slice(0, 30).toLowerCase() + MOCK_PAYMENT.slice(30);
      expect((await get(`/v2/transactions/${mixed}`)).body).toEqual(res.body);
    });

    it('binary=true returns hex tx and meta', async () => {
      const res = await get(`/v2/transactions/${MOCK_PAYMENT}?binary=true`);
      expect(res.status).toBe(200);
      const { transaction } = res.body;
      expect(transaction.tx).toMatch(/^[0-9A-F]+$/);
      expect(transaction.meta).toMatch(/^[0-9A-F]+$/);
      // the hash of a transaction is the hash of its serialization
      expect(transactionId(transaction.tx)).toBe(MOCK_PAYMENT);
    });

    it('is a TxObject: hash, ledger_index, date, tx, meta, and no ledger_hash', async () => {
      const { ledger, row } = fixtureTransaction('ripple-mock', MOCK_PAYMENT);
      const res = await get(`/v2/transactions/${MOCK_PAYMENT}`);
      const tx = res.body.transaction;
      expect(Object.keys(res.body)).toEqual(['result', 'transaction']);
      expect(Object.keys(tx)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
      expect(tx.ledger_index).toBe(ledger.header.ledger_index);
      expect(tx.date).toBe(txDate(row.close_time));
      expect(tx.tx.TransactionType).toBe('Payment');
      expect(tx.meta.TransactionResult).toBe('tesSUCCESS');
    });

    it('every mock transaction is found by its hash', async () => {
      for (const t of ALL.filter((_, i) => i % 40 === 0)) {
        const res = await get(`/v2/transactions/${t.tx.hash}`);
        expect([t.tx.hash, res.status]).toEqual([t.tx.hash, 200]);
        expect(res.body.transaction.hash).toBe(t.tx.hash);
        expect(res.body.transaction.ledger_index).toBe(t.row.ledger_index);
      }
    });

    it('reads tx_by_hash for the key and the transactions table for the row', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`/v2/transactions/${MOCK_PAYMENT}`);
      const sql = query.mock.calls.map(([q]) => String(q));
      expect(sql).toHaveLength(2);
      expect(sql[0]).toContain(Table.TxByHash);
      expect(sql[1]).toContain(Table.Transactions);
      // the hash is bound, not written into the SQL
      expect(sql.join('\n')).not.toContain(MOCK_PAYMENT);
    });

    it('anything but an even number of hex digits → 400 invalid hash', async () => {
      const odd = MOCK_PAYMENT.slice(1);
      for (const hash of [odd, 'ABC', 'XYZ1', `0x${MOCK_PAYMENT}`, `${MOCK_PAYMENT}G0`, 'A', 'not-a-hash']) {
        const res = await get(`/v2/transactions/${hash}`);
        expect([hash, res.status, res.body]).toEqual([hash, 400, { result: 'error', message: 'invalid hash' }]);
      }
    });

    it('a well-formed hash of any even length that no transaction has → 404', async () => {
      for (const hash of ['AB', 'ABCD', 'AB'.repeat(32), 'ab'.repeat(40)]) {
        const res = await get(`/v2/transactions/${hash}`);
        expect([hash, res.status, res.body]).toEqual([
          hash,
          404,
          { result: 'error', message: 'transaction not found' },
        ]);
      }
    });

    it('binary is read as /true/i, like the original', async () => {
      for (const flag of ['TRUE', 'True', 'xtruex']) {
        const res = await get(`/v2/transactions/${MOCK_PAYMENT}?binary=${flag}`);
        expect([flag, typeof res.body.transaction.tx]).toEqual([flag, 'string']);
      }
      for (const flag of ['1', 'false', '']) {
        const res = await get(`/v2/transactions/${MOCK_PAYMENT}?binary=${flag}`);
        expect([flag, typeof res.body.transaction.tx]).toEqual([flag, 'object']);
      }
    });

    it('is 500 unable to retrieve transaction(s) when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(`/v2/transactions/${MOCK_PAYMENT}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve transaction(s)' });
    });
  });

  // -- the list ---------------------------------------------------------------------------------------------------

  describe('/v2/transactions', () => {
    it('lists the transactions of the whole history, oldest first, 20 by default', async () => {
      const res = await get('/v2/transactions');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'transactions']);
      expect(res.body.count).toBe(20);
      expect(hashesIn(res.body)).toEqual(hashesOf(ALL.slice(0, 20)));
      expect(res.body.marker).toBe(markerOf(ALL[19]));
    });

    it('each item is a TxObject with the ledger_hash of its ledger', async () => {
      const res = await get('/v2/transactions?limit=100&start=2015-01-14T18:27&end=2015-01-14T18:27');
      expect(res.body.count).toBe(100);
      for (const t of (res.body as ListBody).transactions) {
        expect(Object.keys(t)).toEqual(['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta']);
        expect(t.ledger_hash).toBe(LEDGER_HASH.get(t.ledger_index));
      }
      // a binary item too
      const binary = await get('/v2/transactions?limit=5&binary=true');
      for (const t of (binary.body as ListBody).transactions) {
        expect(Object.keys(t)).toEqual(['hash', 'ledger_index', 'date', 'ledger_hash', 'tx', 'meta']);
        expect(t.ledger_hash).toBe(LEDGER_HASH.get(t.ledger_index));
        expect(transactionId(t.tx)).toBe(t.hash);
      }
    });

    it('delivered_amount is worked out for a successful payment', async () => {
      const res = await get('/v2/transactions?type=Payment&limit=100');
      expect(res.body.count).toBe(100);
      for (const t of (res.body as ListBody).transactions) {
        if (t.meta.TransactionResult === 'tesSUCCESS') expect(t.meta.delivered_amount).toBeDefined();
        else expect(t.meta.delivered_amount).toBeUndefined();
      }
    });

    it('the date of an item is the close time of its ledger, YYYY-MM-DDTHH:mm:ss+00:00', async () => {
      const res = await get('/v2/transactions?limit=100&start=2015-02-09&end=2015-02-09');
      expect(res.body.count).toBe(30);
      for (const t of (res.body as ListBody).transactions) {
        const closed = ALL.find((x) => x.tx.hash === t.hash)?.ledger.header.close_time as number;
        expect(t.date).toBe(txDate(closed));
      }
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-02-09', end: '2015-02-09' }, '2015-02-09T00:00:00', '2015-02-10T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ start: '2015-01-14T18:27:10Z', end: '2015-01-14T18:27:20Z' }, '2015-01-14T18:27:10', '2015-01-14T18:27:21'],
        [{ start: '2016-03-28T18:24:21Z', end: '2016-03-28T18:24:21Z' }, '2016-03-28T18:24:21', '2016-03-28T18:24:22'],
        [{ start: '2017' }, '2017-01-01T00:00:00', '2100-01-01T00:00:00'],
        [{ end: '2013-12' }, '2000-01-01T00:00:00', '2014-01-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const expected = closedBetween(from, before);
        expect(expected.length).toBeGreaterThan(0);
        const listed = (await pages(`/v2/transactions${qs(params)}`, 100)).flatMap(hashesIn);
        expect([params, listed]).toEqual([params, hashesOf(expected)]);
      }
    });

    it('a start with milliseconds is the second it falls in, as the row keys of the original were (R54)', async () => {
      const second = closedBetween('2015-01-14T18:27:10', '2015-01-14T18:27:11');
      expect(second.length).toBeGreaterThan(0);
      const listed = (
        await pages(`/v2/transactions${qs({ start: '2015-01-14T18:27:10.750Z', end: '2015-01-14T18:27:20Z' })}`, 100)
      ).flatMap(hashesIn);
      expect(listed).toEqual(hashesOf(closedBetween('2015-01-14T18:27:10', '2015-01-14T18:27:21')));
    });

    it('start defaults to 2013-01-01', async () => {
      expect(hashesIn((await get('/v2/transactions?limit=5')).body)).toEqual(hashesOf(ALL.slice(0, 5)));
      expect(hashesIn((await get('/v2/transactions?limit=5&start=')).body)).toEqual(hashesOf(ALL.slice(0, 5)));
    });

    it('a start after the last ledger → count 0', async () => {
      const res = await get('/v2/transactions?start=2018-01-01');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    it('an end before the first ledger → count 0', async () => {
      const res = await get('/v2/transactions?end=2013-06-01');
      expect(res.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    // -- the shared list behaviour --

    it('empty range → count 0', async () => {
      for (const extra of ['', '&type=Payment', '&result=tesSUCCESS', '&type=Payment&result=tesSUCCESS']) {
        const res = await get(`/v2/transactions?start=2030-01-01&end=2030-12-31${extra}`);
        expect([extra, res.status, res.body]).toEqual([extra, 200, { result: 'success', count: 0, transactions: [] }]);
        expect(res.headers.link).toBeUndefined();
      }
    });

    it('marker pages concatenate to unpaged list', async () => {
      // 2015-02-09: 30 transactions in 8 ledgers
      const window = '/v2/transactions?start=2015-02-09&end=2015-02-09';
      const unpaged = await get(`${window}&limit=100`);
      expect(unpaged.body.count).toBe(30);
      expect(unpaged.body.marker).toBeUndefined();
      expect(unpaged.headers.link).toBeUndefined();

      const paged = await pages(window, 3);
      expect(paged).toHaveLength(10);
      expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
      expect(paged[paged.length - 1].marker).toBeUndefined();
      expect(paged.flatMap((p) => p.transactions)).toEqual(unpaged.body.transactions);
      expect(hashesIn(unpaged.body)).toEqual(hashesOf(closedBetween('2015-02-09T00:00:00', '2015-02-10T00:00:00')));
    });

    it('marker pages concatenate with type, with result and with both', async () => {
      const minute = closedBetween('2015-01-14T18:28:00', '2015-01-14T18:29:00');
      const lists: [string, FixtureTx[]][] = [
        ['type=Payment&start=2015-01-14T18:28&end=2015-01-14T18:28', minute.filter((t) => t.row.tx_type === 'Payment')],
        ['result=tecUNFUNDED_OFFER', ALL.filter((t) => t.row.result === 'tecUNFUNDED_OFFER')],
        [
          'type=OfferCreate&result=tecUNFUNDED_OFFER',
          ALL.filter((t) => t.row.tx_type === 'OfferCreate' && t.row.result === 'tecUNFUNDED_OFFER'),
        ],
        [
          'type=Payment&result=tesSUCCESS&start=2015-01-14T18:28&end=2015-01-14T18:28',
          minute.filter((t) => t.row.tx_type === 'Payment' && t.row.result === 'tesSUCCESS'),
        ],
      ];
      for (const [query, expected] of lists) {
        expect(expected.length).toBeGreaterThan(3);
        expect(expected.length).toBeLessThanOrEqual(100);
        const unpaged = await get(`/v2/transactions?${query}&limit=100`);
        expect([query, hashesIn(unpaged.body)]).toEqual([query, hashesOf(expected)]);
        const paged = await pages(`/v2/transactions?${query}`, 3);
        expect([query, paged.flatMap((p) => p.transactions)]).toEqual([query, unpaged.body.transactions]);
      }
    });

    it('descending reverses order', async () => {
      // 18:29 holds 76 transactions, 18 of them Payments; 14 failed with tecUNFUNDED_OFFER in all
      const minute = 'start=2015-01-14T18:29&end=2015-01-14T18:29';
      for (const query of [minute, `${minute}&type=Payment`, 'result=tecUNFUNDED_OFFER']) {
        const asc = await get(`/v2/transactions?${query}&limit=100`);
        const desc = await get(`/v2/transactions?${query}&limit=100&descending=true`);
        expect(asc.body.count).toBeGreaterThan(1);
        expect(asc.body.marker).toBeUndefined();
        expect([query, desc.body.transactions]).toEqual([query, [...asc.body.transactions].reverse()]);
        // the markers of a descending list continue downwards
        const pagedDesc = await pages(`/v2/transactions?${query}&descending=true`, 7);
        expect([query, pagedDesc.flatMap((p) => p.transactions)]).toEqual([query, desc.body.transactions]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get('/v2/transactions?limit=5');
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/transactions?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get('/v2/transactions?limit=5&descending=true');
      expect((await get('/v2/transactions?limit=5&descending=TRUE')).body).toEqual(desc.body);
      expect(hashesIn(desc.body)).toEqual(hashesOf(ALL.slice(-5).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get('/v2/transactions?limit=5');
      const res = await get('/v2/transactions?limit=5&foo=bar&currency=USD');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('format=csv is ignored: the original answers transactions in JSON only', async () => {
      const res = await get('/v2/transactions?limit=2&format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.count).toBe(2);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get('/v2/transactions?type=Payment&type=OfferCreate&limit=3&limit=50');
      expect(res.body.count).toBe(3);
      for (const t of (res.body as ListBody).transactions) expect(t.tx.TransactionType).toBe('Payment');
    });

    // -- limit --

    it('limit is 20 by default, at most 100; below one or not a number it is the default', async () => {
      const cases: [string, number][] = [
        ['', 20],
        ['limit=1', 1],
        ['limit=7', 7],
        ['limit=100', 100],
        ['limit=101', 100],
        ['limit=100000', 100],
        ['limit=0', 20],
        ['limit=-5', 20],
        ['limit=abc', 20],
        ['limit=', 20],
        ['limit=2.9', 2],
      ];
      for (const [query, count] of cases) {
        const res = await get(`/v2/transactions?${query}`);
        expect([query, res.status, res.body.count, res.body.transactions.length]).toEqual([query, 200, count, count]);
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const last = await get('/v2/transactions?limit=100&start=2017-01-01');
      expect(last.body.count).toBe(80);
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();

      // exactly as many as the limit: no marker either
      const exact = await get('/v2/transactions?limit=80&start=2017-01-01');
      expect(exact.body.count).toBe(80);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      const more = await get('/v2/transactions?limit=79&start=2017-01-01');
      expect(more.body.count).toBe(79);
      expect(more.body.marker).toBeDefined();
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(
        `/v2/transactions${qs({ limit: 2, type: 'Payment', start: '2013-01-01T00:00:00+00:00' })}`,
      );
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}/v2/transactions?limit=2&type=Payment&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`/v2/transactions?limit=2&marker=${first.body.marker}&type=Payment`);
      expect(second.headers.link).toBe(
        `<${new URL(second.request.url).origin}/v2/transactions?limit=2&marker=${second.body.marker}&type=Payment>; rel="next"`,
      );
    });

    // -- marker --

    it('a marker that is none of this list → 400 invalid marker', async () => {
      const bad = [
        '20130611200120|000001021029|00001',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2,3]').toString('base64url'),
        Buffer.from('["a",1]').toString('base64url'),
        Buffer.from('[-1,0]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
      ];
      for (const marker of bad) {
        const res = await get(`/v2/transactions?marker=${encodeURIComponent(marker)}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('a marker continues strictly after its row', async () => {
      const at = ALL[100];
      const asc = await get(`/v2/transactions?limit=3&marker=${markerOf(at)}`);
      expect(hashesIn(asc.body)).toEqual(hashesOf(ALL.slice(101, 104)));
      const desc = await get(`/v2/transactions?limit=3&descending=true&marker=${markerOf(at)}`);
      expect(hashesIn(desc.body)).toEqual(hashesOf([ALL[99], ALL[98], ALL[97]]));
      // a marker beyond the stored history is still a marker
      const beyond = await get(`/v2/transactions?marker=${Buffer.from('[999999999,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`/v2/transactions?start=2030-01-01&marker=${markerOf(ALL[3])}`);
      expect(res.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    // -- type and result --

    it('type=Payment uses tx_by_type', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/transactions?type=Payment&limit=100');
      expect(res.status).toBe(200);
      const paging = query.mock.calls.filter(([sql]) => String(sql).includes(Table.TxByType));
      expect(paging).toHaveLength(1);
      const [sql, params] = paging[0];
      expect(String(sql)).toMatch(/tx_type = \{type:String\}/);
      expect(params).toMatchObject({ type: 'Payment' });
      // the wide rows are read by key afterwards, never scanned for the type
      const wide = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Transactions}\\b`).test(String(q)));
      expect(wide).toHaveLength(1);
      expect(String(wide[0][0])).not.toMatch(/tx_type\s*=/);
      jest.restoreAllMocks();

      // and the 188 Payments of the fixtures come out
      const all = (await pages('/v2/transactions?type=Payment', 100)).flatMap((p) => p.transactions);
      expect(all).toHaveLength(188);
      expect(all.every((t) => t.tx.TransactionType === 'Payment')).toBe(true);
      expect(all.map((t) => t.hash)).toEqual(hashesOf(ALL.filter((t) => t.row.tx_type === 'Payment')));
    });

    it('reads both tables in the order of their whole key, and stops after the page (R106)', async () => {
      // tx_by_type is ORDER BY (tx_type, ledger_index, tx_index): the type is fixed, but the ORDER BY spells it out, or
      // ClickHouse sorts the whole range of the type (final review M11)
      const marker = markerOf(ALL[100]);
      for (const descending of [false, true]) {
        for (const variant of ['', '&type=Payment', '&type=OfferCreate&result=tesSUCCESS', `&marker=${marker}`]) {
          const query = jest.spyOn(h.ch, 'query');
          await get(`/v2/transactions?limit=5&descending=${descending}${variant}`);
          const calls = query.mock.calls.filter(([q]) => isPageRead(String(q)));
          jest.restoreAllMocks();
          expect(calls).toHaveLength(1);
          const [sql, params] = calls[0] as [string, Record<string, unknown>];
          const d = descending ? 'DESC' : 'ASC';
          expect(sql).toContain(
            variant.includes('type=')
              ? `ORDER BY tx_type ${d}, ledger_index ${d}, tx_index ${d}`
              : `ORDER BY ledger_index ${d}, tx_index ${d}`,
          );
          await expectBoundedInOrderRead(h, sql, params, descending, [descending, variant]);
        }
      }
    });

    it('no type pages the transactions table and never reads tx_by_type', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/transactions?result=tecUNFUNDED_OFFER&limit=100');
      expect(res.body.count).toBe(14);
      const sql = query.mock.calls.map(([q]) => String(q));
      expect(sql.some((q) => q.includes(Table.TxByType))).toBe(false);
      expect(sql.some((q) => /FROM transactions\b[\s\S]*result = \{result:String\}/.test(q))).toBe(true);
    });

    it('a type and a result filter together', async () => {
      const res = await get('/v2/transactions?type=Payment&result=tecPATH_DRY&limit=100');
      const expected = ALL.filter((t) => t.row.tx_type === 'Payment' && t.row.result === 'tecPATH_DRY');
      expect(expected.length).toBeGreaterThan(0);
      expect(hashesIn(res.body)).toEqual(hashesOf(expected));
      for (const t of (res.body as ListBody).transactions) {
        expect(t.tx.TransactionType).toBe('Payment');
        expect(t.meta.TransactionResult).toBe('tecPATH_DRY');
      }
    });

    it('every type of the mock ledgers filters to exactly its transactions', async () => {
      const types = [...new Set(ALL.map((t) => t.row.tx_type))];
      expect(types).toEqual(expect.arrayContaining(['Payment', 'OfferCreate', 'OfferCancel', 'AccountSet']));
      for (const type of types) {
        const expected = ALL.filter((t) => t.row.tx_type === type);
        const listed = (await pages(`/v2/transactions?type=${type}`, 100)).flatMap(hashesIn);
        expect([type, listed]).toEqual([type, hashesOf(expected)]);
      }
    });

    it('every result of the mock ledgers filters to exactly its transactions', async () => {
      const results = [...new Set(ALL.map((t) => t.row.result))];
      expect(results.length).toBeGreaterThan(3);
      for (const result of results) {
        const expected = ALL.filter((t) => t.row.result === result);
        const listed = (await pages(`/v2/transactions?result=${result}`, 100)).flatMap(hashesIn);
        expect([result, listed]).toEqual([result, hashesOf(expected)]);
      }
    });

    it('type and result are checked against the definitions of the network, not the list of the original', async () => {
      // not in the 17 types / 33 results of the original, but known to the network
      const known = [
        'type=NFTokenMint',
        'type=AMMCreate',
        'type=Clawback',
        'result=tecKILLED',
        'result=tecNO_PERMISSION',
      ];
      for (const query of known) {
        const res = await get(`/v2/transactions?${query}`);
        expect([query, res.status, res.body.result]).toEqual([query, 200, 'success']);
      }
      // in the original and known to the network, but with nothing in the mock ledgers
      expect((await get('/v2/transactions?type=SignerListSet')).body.count).toBe(0);
    });

    it('anything the network does not know → 400 invalid transaction type / result', async () => {
      for (const type of ['Transaction', 'payment', 'PAYMENT', 'Invalid', 'ClaimReward', 'Payment ', 'tesSUCCESS']) {
        const res = await get(`/v2/transactions${qs({ type })}`);
        expect([type, res.status, res.body]).toEqual([
          type,
          400,
          { result: 'error', message: 'invalid transaction type' },
        ]);
      }
      for (const result of [
        'tecZ',
        'tesSUCCES',
        'tessuccess',
        'Payment',
        'telLOCAL_ERROR_X',
        'tecNO_DST_INSUF_XRP2',
        'tecHOOK_REJECTED',
      ]) {
        const res = await get(`/v2/transactions${qs({ result })}`);
        expect([result, res.status, res.body]).toEqual([
          result,
          400,
          { result: 'error', message: 'invalid transaction result' },
        ]);
      }
    });

    it('an empty type or result is no filter', async () => {
      const plain = await get('/v2/transactions?limit=5');
      expect((await get('/v2/transactions?limit=5&type=&result=')).body).toEqual(plain.body);
    });

    it('the checks come in the order of the original: start, end, type, result, then the marker', async () => {
      const bad = { start: 'x', end: 'y', type: 'T', result: 'R', marker: '!' };
      const order = ['start', 'end', 'type', 'result', 'marker'] as const;
      const messages: string[] = [];
      for (let i = 0; i < order.length; i++) {
        const params = Object.fromEntries(order.slice(i).map((k) => [k, bad[k]]));
        messages.push((await get(`/v2/transactions${qs(params)}`)).body.message);
      }
      expect(messages).toEqual([
        'invalid start date format',
        'invalid end date format',
        'invalid transaction type',
        'invalid transaction result',
        'invalid marker',
      ]);
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00']) {
        const res = await get(`/v2/transactions${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
    });

    it('is 500 unable to retrieve transaction(s) when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get('/v2/transactions');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve transaction(s)' });
    });
  });
});

describe('transactions API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const LEDGER = 11616399;
  const written = ALL.filter((t) => t.row.ledger_index === LEDGER);
  // the window holds this ledger and 11616400, which closed in the same second
  const inWindow = closedBetween('2015-02-09T18:14:30', '2015-02-09T18:14:31');
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    get = api(h);
    for (const table of [Table.Transactions, Table.TxByType, Table.TxByHash]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
      );
      expect(Number(n)).toBe(written.length * 2);
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every transaction once', async () => {
    expect(written.length).toBeGreaterThan(2);
    expect(inWindow.length).toBeGreaterThan(written.length);
    const window = '/v2/transactions?start=2015-02-09T18:14:30&end=2015-02-09T18:14:30';
    const cases: [string, FixtureTx[]][] = [
      ['', inWindow],
      ['&type=Payment', inWindow.filter((t) => t.row.tx_type === 'Payment')],
    ];
    for (const [extra, expected] of cases) {
      const unpaged = await get(`${window}${extra}&limit=100`);
      expect([extra, hashesIn(unpaged.body)]).toEqual([extra, hashesOf(expected)]);
      // and a page cut inside the duplicates neither repeats nor skips a row
      const paged = (await pages(`${window}${extra}`, 2)).flatMap(hashesIn);
      expect([extra, paged]).toEqual([extra, hashesOf(expected)]);
    }
  });

  it('finds a duplicated transaction by its hash', async () => {
    const res = await get(`/v2/transactions/${written[0].tx.hash}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.hash).toBe(written[0].tx.hash);
  });

  /** Every page of a list, following the markers. */
  async function pages(path: string, limit: number): Promise<ListBody[]> {
    const out: ListBody[] = [];
    let marker: string | undefined;
    do {
      const res = await get(`${path}&limit=${limit}${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      out.push(res.body as ListBody);
      marker = (res.body as ListBody).marker;
      expect(out.length).toBeLessThan(100);
    } while (marker);
    return out;
  }
});

describe('transactions API endpoint on the xahau-recorded ledgers', () => {
  const seed = 'xahau-recorded';
  const all = [...fixtureTransactions(seed)].sort(byKey);
  let h: Harness;
  let get: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await startHarness({ seed });
    get = api(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('type and result are the ones of the Xahau definitions', async () => {
    const minted = all.filter((t) => t.row.tx_type === 'URITokenMint');
    expect(minted.length).toBeGreaterThan(0);
    const res = await get('/v2/transactions?type=URITokenMint&limit=100');
    expect(res.status).toBe(200);
    expect(hashesIn(res.body)).toEqual(hashesOf(minted));
    expect((await get('/v2/transactions?type=ClaimReward')).body.count).toBe(1);
    // a Xahau result code, which the XRPL harness above rejects
    expect((await get('/v2/transactions?result=tecHOOK_REJECTED')).status).toBe(200);
    expect((await get('/v2/transactions?type=Transaction')).status).toBe(400);
  });

  it('every transaction of the recorded ledgers is listed with its ledger hash, as JSON and as binary', async () => {
    for (const binary of [false, true]) {
      const seen: ListBody['transactions'] = [];
      let marker: string | undefined;
      do {
        const res = await get(`/v2/transactions?limit=100&binary=${binary}${marker ? `&marker=${marker}` : ''}`);
        expect(res.status).toBe(200);
        seen.push(...(res.body as ListBody).transactions);
        marker = res.body.marker;
      } while (marker);
      expect(seen.map((t) => t.hash)).toEqual(hashesOf(all));
      for (const [i, t] of seen.entries()) {
        expect(t.ledger_hash).toBe(all[i].ledger.header.ledger_hash);
        expect(typeof t.tx).toBe(binary ? 'string' : 'object');
      }
    }
  });

  it('a single transaction is found by its hash', async () => {
    const t = all[all.length - 1];
    const res = await get(`/v2/transactions/${t.tx.hash.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.hash).toBe(t.tx.hash);
    expect(res.body.transaction.ledger_index).toBe(t.row.ledger_index);
    expect(res.body.transaction).not.toHaveProperty('ledger_hash');
  });
});

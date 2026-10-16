import { AccountTransactionsRow, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import {
  FixtureTx,
  fixtureAccountTransactions,
  fixtureAccountTxBySequence,
  fixtureTransactions,
} from './support/fixtures';
import { expectBoundedInOrderRead, isPageRead } from './support/plans';

/**
 * `GET /v2/accounts/:address/transactions` and `GET /v2/accounts/:address/transactions/:sequence` on a real ClickHouse,
 * seeded with the 54 ledgers of the original Ripple test suite (`ripple-mock`: 933 transactions that touch 300
 * accounts, 2268 rows of `account_transactions`) and, for the Xahau case, with the recorded Xahau ledgers (364
 * transactions, 170 of them with hook executions, and an emitted-style `Sequence` 0 on three).
 *
 * Ported from rippled-historical-database `test/test.account.transactions.js` (all 15 `it`s, same titles, none
 * skipped). Four of them are ported to what this API holds instead of what HBase did:
 *  - 'should return the last 20 transactions for an account' is the first 20 of the history, ascending, as the
 *    original served it (the title says "last", the code never asked for `descending`);
 *  - 'should handle pagination correctly' walks the window one transaction at a time with `limit=1` and compares each
 *    page with the unpaged list, as `utils.checkPagination` does; only the marker is this API's;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`rvYAf…|20150114174310|000011119015|00001`); the marker of this API is `(ledger_index, tx_index)` of the last row
 *    of the page (in sequence mode `(sequence, ledger_index, tx_index)`);
 *  - 'should return account transactions by sequence' also checks the whole range (the original only looped over the
 *    rows it got, so it passed with none, and its scan dropped `max_sequence`: see below).
 *
 * Added: the shape of an item (no `ledger_hash`), the history of an account that only ever received (the old GateHub
 * implementation matched the sender only), type and result against the definitions of the network instead of the
 * stale lists of the original, the order of the checks, both modes (time and sequence) with their markers, ordering,
 * limits, `binary`, the single lookup (`invalid sequence number`, tickets, 404s), the tables and the plan of the
 * queries, rows that were written twice, the failure paths and Xahau. The original has no CSV for account
 * transactions, so `format=csv` is ignored.
 */

const ACCOUNT = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'; // only ever a recipient (offers and payments reach it)
const SENDER = 'rfZ4YjC4CyaKFx9cgzYNKk4E2zTXRJif26'; // 25 OfferCreates, 4 of them tecUNFUNDED_OFFER
const BUSY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // 179 transactions
const SEQUENCED = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg'; // sends with sequences 11368825 … 13299878
const RECIPIENT = 'rHTaDFHJng6YVtThvv522LmJfkocBVkK6Z'; // never sends; one payment reaches it
const PAYMENT_TO_RECIPIENT = 'E011E6D20BE1FAC7C37F2FA0D36F0811C404B118D936963051600796FF2C0CBC';

interface Key {
  ledger_index: number;
  tx_index: number;
}
const byKey = (a: Key, b: Key): number => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

const TRANSACTIONS = fixtureTransactions('ripple-mock');
const TRANSACTION = new Map(TRANSACTIONS.map((t) => [`${t.row.ledger_index}:${t.row.tx_index}`, t]));
const txOf = (key: Key): FixtureTx => TRANSACTION.get(`${key.ledger_index}:${key.tx_index}`) as FixtureTx;
/** Every row of `account_transactions`, in the order of the list. */
const AFFECTED = [...fixtureAccountTransactions('ripple-mock')].sort(byKey);
/** Every row of `account_tx_by_sequence`, in the order of the sequence list. */
const SENT = [...fixtureAccountTxBySequence('ripple-mock')].sort((a, b) => a.sequence - b.sequence || byKey(a, b));

/** The rows of the transactions that affect an account, in the order of the list. */
const historyOf = (account: string): AccountTransactionsRow[] => AFFECTED.filter((r) => r.account === account);
/** The rows of the transactions an account sent, in the order of the sequence list. */
const sentBy = (account: string) => SENT.filter((r) => r.account === account);
const hashesOfRows = (rows: Key[]): string[] => rows.map((r) => txOf(r).tx.hash);
const hashesIn = (body: ListBody): string[] => body.transactions.map((t) => t.hash);

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time); `2015-01` is its first day. */
const unix = (iso: string): number => {
  const full = /^\d{4}(-\d\d){0,2}$/.test(iso) ? `${(iso + '-01-01').slice(0, 10)}T00:00:00` : iso;
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(full) ? full : `${full}Z`) / 1000;
};
/** The history rows of an account whose ledger closed in `[from, before)`. */
const closedBetween = (account: string, from: string, before: string): AccountTransactionsRow[] =>
  historyOf(account).filter((r) => r.close_time >= unix(from) && r.close_time < unix(before));

/** The marker of a time list: `(ledger_index, tx_index)` as base64url JSON. */
const markerOf = (key: Key): string =>
  Buffer.from(JSON.stringify([key.ledger_index, key.tx_index]), 'utf8').toString('base64url');
/** The marker of a sequence list: `(sequence, ledger_index, tx_index)`. */
const sequenceMarkerOf = (row: Key & { sequence: number }): string =>
  Buffer.from(JSON.stringify([row.sequence, row.ledger_index, row.tx_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

interface Item {
  hash: string;
  ledger_index: number;
  date: string;
  ledger_hash?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any;
}
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  transactions: Item[];
}

const listPath = (account: string): string => `/v2/accounts/${account}/transactions`;

describe('account transactions API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** Every transaction as `/v2/transactions` serves it (without its `ledger_hash`), by hash. */
  const served = new Map<string, Item>();
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'transactions');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const page of await api.pages<ListBody>('/v2/transactions', 100, 'transactions')) {
      for (const { ledger_hash: _ledgerHash, ...item } of page.transactions) served.set(item.hash, item as Item);
    }
    expect(served.size).toBe(TRANSACTIONS.length);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.account.transactions.js ------------------------------------------------------------------------------

  it('should return the last 20 transactions for an account', async () => {
    const res = await get(listPath(ACCOUNT));
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(20);
    expect(res.body.transactions.length).toBe(20);
    for (const tx of (res.body as ListBody).transactions) {
      expect(typeof tx.meta).toBe('object');
      expect(typeof tx.tx).toBe('object');
    }
    // the first 20 of its history, oldest first
    expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(ACCOUNT).slice(0, 20)));
    expect(res.body.marker).toBe(markerOf(historyOf(ACCOUNT)[19]));
  });

  it('should return limit the returned transactions to 5', async () => {
    const res = await get(`${listPath(ACCOUNT)}?limit=5&offset=5`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(5);
    expect(res.body.transactions.length).toBe(5);
    // `offset` is not a parameter
    expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(ACCOUNT).slice(0, 5)));
  });

  it('should return return only specified transaction types', async () => {
    const res = await get(`${listPath(ACCOUNT)}?type=OfferCreate`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(20);
    for (const tx of (res.body as ListBody).transactions) {
      expect(['OfferCreate'].indexOf(tx.tx.TransactionType) !== -1).toBe(true);
    }
    expect(hashesIn(res.body)).toEqual(
      hashesOfRows(
        historyOf(ACCOUNT)
          .filter((r) => r.tx_type === 'OfferCreate')
          .slice(0, 20),
      ),
    );
  });

  it('should return return only specified transaction results', async () => {
    const result = 'tecUNFUNDED_OFFER';
    const res = await get(`${listPath(SENDER)}?limit=5&result=${result}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    for (const tx of (res.body as ListBody).transactions) expect(tx.meta.TransactionResult).toBe(result);
    // all four of them, and no more
    expect(res.body.count).toBe(4);
    expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(SENDER).filter((r) => r.result === result)));
  });

  it('should return transactions for a given date range', async () => {
    const start = '2015-01-14T18:27:10';
    const end = '2015-01-14T18:27:29';
    const res = await get(`${listPath(ACCOUNT)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(8);
    expect(res.body.transactions.length).toBe(8);
    for (const trans of (res.body as ListBody).transactions) {
      const d = Date.parse(trans.date);
      expect(d >= Date.parse(`${start}Z`) && d <= Date.parse(`${end}Z`)).toBe(true);
    }
    expect(hashesIn(res.body)).toEqual(hashesOfRows(closedBetween(ACCOUNT, start, '2015-01-14T18:27:30')));
  });

  it('should return transactions for a given date range (bis)', async () => {
    const start = '2015-01-14T18:27:10';
    const end = '2015-01-14T18:27:30';
    const res = await get(`${listPath(ACCOUNT)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(13);
    expect(res.body.transactions.length).toBe(13);
    for (const trans of (res.body as ListBody).transactions) {
      const d = Date.parse(trans.date);
      expect(d >= Date.parse(`${start}Z`) && d <= Date.parse(`${end}Z`)).toBe(true);
    }
    expect(hashesIn(res.body)).toEqual(hashesOfRows(closedBetween(ACCOUNT, start, '2015-01-14T18:27:31')));
  });

  it('should return results in binary form', async () => {
    const res = await get(`${listPath(SENDER)}?limit=5&binary=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.count).toBe(5);
    for (const tx of (res.body as ListBody).transactions) {
      expect(typeof tx.meta).toBe('string');
      expect(typeof tx.tx).toBe('string');
    }
  });

  it('should return results in ascending order', async () => {
    let last = Infinity;
    const res = await get(`${listPath(BUSY)}?descending=true&limit=50`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.transactions.length).toBe(50);
    for (const tx of (res.body as ListBody).transactions) {
      expect(last >= tx.ledger_index).toBe(true);
      last = tx.ledger_index;
    }
    expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(BUSY).slice(-50).reverse()));
  });

  it('should handle pagination correctly', async () => {
    const window = `${listPath(ACCOUNT)}?start=2015-01-14T18:27:20&end=2015-01-14T18:27:20`;
    const ref = await get(window);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1);
    expect(ref.body.count).toBe(6);

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${window}&limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.transactions.length).toBe(1);
      expect(res.body.transactions[0].hash).toBe(ref.body.transactions[i].hash);
      expect(res.body.transactions[0].ledger_index).toBe(ref.body.transactions[i].ledger_index);
      marker = res.body.marker;
    }
    // the last page of the window has no marker
    expect(marker).toBeUndefined();
  });

  it('should return a specific account transaction for a given sequence #', async () => {
    const sequence = 11370364;
    const res = await get(`${listPath(SEQUENCED)}/${sequence}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(typeof res.body.transaction).toBe('object');
    expect(typeof res.body.transaction.date).toBe('string');
    expect(typeof res.body.transaction.ledger_index).toBe('number');
    expect(typeof res.body.transaction.hash).toBe('string');
    expect(res.body.transaction.tx.Sequence).toBe(sequence);
  });

  it('should return account transactions by sequence', async () => {
    const max = 11370364;
    const min = 11370357;
    let last = min - 1;
    const res = await get(`${listPath(SEQUENCED)}${qs({ min_sequence: min, max_sequence: max })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    for (const tx of (res.body as ListBody).transactions) {
      expect(tx.tx.Sequence).toBe(last + 1);
      expect(tx.tx.Sequence <= max).toBe(true);
      expect(tx.tx.Sequence >= min).toBe(true);
      last = tx.tx.Sequence;
    }
    // every sequence of the range, both ends included (the HBase scan stopped before `max_sequence`)
    expect(res.body.transactions.map((t: Item) => t.tx.Sequence)).toEqual([
      11370357, 11370358, 11370359, 11370360, 11370361, 11370362, 11370363, 11370364,
    ]);
  });

  it('should return an error if the transaction is not found', async () => {
    const res = await get(`${listPath(SEQUENCED)}/10000`);
    expect(res.status).toBe(404);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('transaction not found');
  });

  it('should return an error for an invalid time', async () => {
    const res = await get(`${listPath(ACCOUNT)}${qs({ start: '2015x', end: '2015x' })}`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid max or min sequence', async () => {
    const res = await get(`${listPath(ACCOUNT)}${qs({ min_sequence: 'zzz2', max_sequence: 'zzz1' })}`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid min_sequence');
  });

  it('should include a link header when marker is present', async () => {
    const path = `${listPath(ACCOUNT)}?limit=1`;
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(markerOf(historyOf(ACCOUNT)[0]));
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}${path}&marker=${res.body.marker}>; rel="next"`);
  });

  // -- the item and the envelope ------------------------------------------------------------------------------------

  describe('the answer', () => {
    it('is {result, count, marker?, transactions} and each item is hash, ledger_index, date, tx, meta', async () => {
      const res = await get(`${listPath(SENDER)}?limit=3`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'transactions']);
      expect(res.body.count).toBe(3);
      for (const item of (res.body as ListBody).transactions) {
        expect(Object.keys(item)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
        expect(item.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
      }
      const last = await get(`${listPath(SENDER)}?limit=1000`);
      expect(Object.keys(last.body)).toEqual(['result', 'count', 'transactions']);
    });

    it('carries no ledger_hash, which /v2/transactions lists have and account transactions never had', async () => {
      const res = await get(`${listPath(BUSY)}?limit=100`);
      for (const item of (res.body as ListBody).transactions) expect(item).not.toHaveProperty('ledger_hash');
      const all = await get('/v2/transactions?limit=1');
      expect(all.body.transactions[0]).toHaveProperty('ledger_hash');
    });

    it('is the transaction of /v2/transactions, tx and meta included', async () => {
      const res = await get(`${listPath(BUSY)}?limit=1000`);
      expect(res.body.count).toBe(179);
      for (const item of (res.body as ListBody).transactions) expect(item).toEqual(served.get(item.hash));
    });

    it('with binary=true is the hex of /v2/transactions/:hash?binary=true', async () => {
      const binary = await get(`${listPath(SENDER)}?binary=true`);
      expect(binary.body.count).toBe(20);
      for (const item of (binary.body as ListBody).transactions) {
        const single = await get(`/v2/transactions/${item.hash}?binary=true`);
        expect(item).toEqual(single.body.transaction);
        expect(item.tx).toMatch(/^[0-9A-F]+$/);
        expect(item.meta).toMatch(/^[0-9A-F]+$/);
      }
      // and every flag spelling Ripple accepts (`/true/i`)
      expect((await get(`${listPath(SENDER)}?limit=1&binary=TRUE`)).body.transactions[0].tx).toMatch(/^[0-9A-F]+$/);
      for (const off of ['false', '0', '1', '']) {
        const res = await get(`${listPath(SENDER)}?limit=1&binary=${off}`);
        expect(typeof res.body.transactions[0].tx).toBe('object');
      }
    });
  });

  // -- a received-only transaction ----------------------------------------------------------------------------------

  describe('the transactions that affect the account, not only the ones it sent', () => {
    it('received-only payment appears in recipient history', async () => {
      // the old GateHub implementation matched the sender only: a recipient that never sends had no history at all
      expect(SENT.filter((r) => r.account === RECIPIENT)).toHaveLength(0);
      expect(historyOf(RECIPIENT).some((r) => r.is_initiator === 1)).toBe(false);

      const res = await get(listPath(RECIPIENT));
      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThanOrEqual(1);
      const payment = (res.body as ListBody).transactions.find((t) => t.hash === PAYMENT_TO_RECIPIENT);
      expect(payment).toBeDefined();
      expect(payment?.tx.TransactionType).toBe('Payment');
      expect(payment?.tx.Destination).toBe(RECIPIENT);
      expect(payment?.tx.Account).not.toBe(RECIPIENT);
      expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(RECIPIENT)));
    });

    it('lists a transaction under every account it affects: the sender and the recipient', async () => {
      const payment = txOf({ ledger_index: 1021029, tx_index: 0 });
      expect(payment.tx.hash).toBe(PAYMENT_TO_RECIPIENT);
      for (const account of [payment.row.account, RECIPIENT]) {
        const res = await get(`${listPath(account)}?limit=1000`);
        expect([account, hashesIn(res.body)]).toEqual([account, expect.arrayContaining([PAYMENT_TO_RECIPIENT])]);
      }
    });

    it('is the whole history, in the order of the ledgers, for an account that only ever received', async () => {
      expect(historyOf(ACCOUNT)).toHaveLength(125);
      expect(historyOf(ACCOUNT).every((r) => r.is_initiator === 0)).toBe(true);
      const res = await get(`${listPath(ACCOUNT)}?limit=1000`);
      expect(res.body.count).toBe(125);
      expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(ACCOUNT)));
    });

    it('lists a failed transaction (tec) under its sender', async () => {
      const failed = historyOf(SENDER).filter((r) => r.result === 'tecUNFUNDED_OFFER');
      expect(failed).toHaveLength(4);
      const res = await get(`${listPath(SENDER)}?limit=1000`);
      expect(hashesIn(res.body)).toEqual(expect.arrayContaining(hashesOfRows(failed)));
    });

    it('an address with no transactions has an empty history, not a 404', async () => {
      for (const account of ['rrrrrrrrrrrrrrrrrrrrBZbvji', 'not an address', 'r']) {
        const res = await get(`/v2/accounts/${encodeURIComponent(account)}/transactions`);
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          { result: 'success', count: 0, transactions: [] },
        ]);
      }
    });
  });

  // -- type and result ------------------------------------------------------------------------------------------

  describe('type and result', () => {
    it('type filters the history of the account, ascending, from account_transactions', async () => {
      for (const type of ['Payment', 'OfferCreate', 'OfferCancel']) {
        const expected = historyOf(BUSY).filter((r) => r.tx_type === type);
        expect(expected.length).toBeGreaterThan(0);
        const res = await get(`${listPath(BUSY)}?type=${type}&limit=1000`);
        expect([type, hashesIn(res.body)]).toEqual([type, hashesOfRows(expected)]);
      }
    });

    it('type and result together', async () => {
      const expected = historyOf(SENDER).filter((r) => r.tx_type === 'OfferCreate' && r.result === 'tesSUCCESS');
      const res = await get(`${listPath(SENDER)}?type=OfferCreate&result=tesSUCCESS&limit=1000`);
      expect(res.body.count).toBe(expected.length);
      expect(hashesIn(res.body)).toEqual(hashesOfRows(expected));
      expect((await get(`${listPath(SENDER)}?type=OfferCancel&result=tecUNFUNDED_OFFER`)).body.count).toBe(0);
    });

    it('a type or result the network has is valid, also where the original list was short', async () => {
      // the original knew 8 types and 32 results: EscrowCreate and tecNO_DST_INSUF_XRP... were not all in them
      const escrow = TRANSACTIONS.find((t) => t.row.tx_type === 'EscrowCreate') as FixtureTx;
      const res = await get(`${listPath(escrow.row.account)}?type=EscrowCreate`);
      expect(res.status).toBe(200);
      expect(hashesIn(res.body)).toEqual([escrow.tx.hash]);
      for (const result of ['tecKILLED', 'tecEXPIRED', 'tecDUPLICATE', 'tecHOOK_REJECTED', 'telINSUF_FEE_P']) {
        const ok = await get(`${listPath(SENDER)}?result=${result}`);
        expect([result, ok.status]).toEqual([result, result === 'tecHOOK_REJECTED' ? 400 : 200]);
      }
    });

    it('a type that is none → 400 invalid transaction type; a result that is none → 400 invalid transaction result', async () => {
      for (const type of ['payment', 'Transaction', 'Remit', 'ClaimReward', 'Payment,OfferCreate', '%20']) {
        const res = await get(`${listPath(SENDER)}?type=${encodeURIComponent(type)}`);
        expect([type, res.status, res.body]).toEqual([
          type,
          400,
          { result: 'error', message: 'invalid transaction type' },
        ]);
      }
      for (const result of ['tessuccess', 'success', 'tec', 'tecHOOK_REJECTED']) {
        const res = await get(`${listPath(SENDER)}?result=${result}`);
        expect([result, res.status, res.body]).toEqual([
          result,
          400,
          { result: 'error', message: 'invalid transaction result' },
        ]);
      }
    });

    it('an empty type or result is no filter', async () => {
      const plain = await get(`${listPath(SENDER)}?limit=1000`);
      const empty = await get(`${listPath(SENDER)}?limit=1000&type=&result=`);
      expect(empty.body).toEqual(plain.body);
      expect(empty.body.count).toBe(25);
    });

    it('a type or result with nothing for the account → count 0', async () => {
      expect((await get(`${listPath(SENDER)}?type=Payment`)).body).toEqual({
        result: 'success',
        count: 0,
        transactions: [],
      });
      expect((await get(`${listPath(RECIPIENT)}?result=tecPATH_DRY`)).body.count).toBe(0);
    });

    it('filters before paging: a page is full of matches, not of the rows that were looked at', async () => {
      const expected = historyOf(BUSY).filter((r) => r.tx_type === 'OfferCancel');
      expect(expected.length).toBeGreaterThan(3);
      const walked = (await pages(`${listPath(BUSY)}?type=OfferCancel`, 3)).flatMap(hashesIn);
      expect(walked).toEqual(hashesOfRows(expected));
      const first = await get(`${listPath(BUSY)}?type=OfferCancel&limit=3`);
      expect(first.body.count).toBe(3);
      expect(first.body.marker).toBe(markerOf(expected[2]));
    });
  });

  // -- the order of the checks ----------------------------------------------------------------------------------

  describe('the order of the checks', () => {
    const message = async (query: string, path = listPath(SENDER)): Promise<[number, string | undefined]> => {
      const res = await get(`${path}${query}`);
      return [res.status, res.body.message];
    };

    it('start, then end, then type, then result', async () => {
      expect(await message('?start=nope&end=nope&type=Bogus&result=Bogus')).toEqual([400, 'invalid start date format']);
      expect(await message('?end=nope&type=Bogus&result=Bogus')).toEqual([400, 'invalid end date format']);
      expect(await message('?type=Bogus&result=Bogus')).toEqual([400, 'invalid transaction type']);
      expect(await message('?result=Bogus')).toEqual([400, 'invalid transaction result']);
    });

    it('min_sequence, then max_sequence, then type, then result; start and end are not read', async () => {
      expect(await message('?min_sequence=x&max_sequence=y&type=Bogus&start=nope')).toEqual([
        400,
        'invalid min_sequence',
      ]);
      expect(await message('?min_sequence=1&max_sequence=y&type=Bogus')).toEqual([400, 'invalid max_sequence']);
      expect(await message('?min_sequence=&max_sequence=y&type=Bogus')).toEqual([400, 'invalid max_sequence']);
      expect(await message('?max_sequence=1&type=Bogus&result=Bogus&start=nope')).toEqual([
        400,
        'invalid transaction type',
      ]);
      expect(await message('?min_sequence=1&result=Bogus&start=nope&end=nope')).toEqual([
        400,
        'invalid transaction result',
      ]);
      expect((await get(`${listPath(SENDER)}?min_sequence=1&start=nope&end=nope`)).status).toBe(200);
    });

    it('a sequence that is not digits: no sign, no decimal point, no exponent, no hex', async () => {
      for (const bad of ['-1', '1.5', '1e3', '0x10', ' 1', '1 ', '+1', 'ten']) {
        for (const name of ['min_sequence', 'max_sequence']) {
          const res = await get(`${listPath(SENDER)}?${name}=${encodeURIComponent(bad)}`);
          expect([name, bad, res.status, res.body]).toEqual([
            name,
            bad,
            400,
            { result: 'error', message: `invalid ${name}` },
          ]);
        }
      }
    });

    it('an empty start is the beginning of time; an empty end is an invalid date, as in the original', async () => {
      const all = await get(`${listPath(SENDER)}?limit=1000`);
      const empty = await get(`${listPath(SENDER)}?limit=1000&start=`);
      expect(empty.body).toEqual(all.body);
      expect(await message('?end=')).toEqual([400, 'invalid end date format']);
    });

    it('empty min_sequence and max_sequence are no sequence query: the list is the time one', async () => {
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=&max_sequence=&limit=1000`);
      expect(res.body.count).toBe(108);
      expect(hashesIn(res.body)).toEqual(hashesOfRows(historyOf(SEQUENCED)));
    });

    it('the dates take the formats of the other lists', async () => {
      for (const start of ['2015', '2015-01', '2015-01-14', '2015-01-14T18', '2015-01-14T18:27', '20150114182710']) {
        expect([start, (await get(`${listPath(ACCOUNT)}?start=${start}&limit=1`)).status]).toEqual([start, 200]);
      }
      expect((await get(`${listPath(ACCOUNT)}?start=2015-13-45`)).status).toBe(400);
    });
  });

  // -- limit, order, markers ----------------------------------------------------------------------------------------

  describe('limit, order and markers', () => {
    it('limit: 20 by default, 1000 at most, a whole number of one or more', async () => {
      const cases: [string, number][] = [
        ['', 20],
        ['?limit=1', 1],
        ['?limit=2.7', 2],
        ['?limit=0', 20],
        ['?limit=-5', 20],
        ['?limit=abc', 20],
        ['?limit=', 20],
        ['?limit=2&limit=5', 2],
        ['?limit=1000', 125],
        ['?limit=1001', 125],
        ['?limit=999999999999', 125],
      ];
      for (const [query, count] of cases) {
        const res = await get(`${listPath(ACCOUNT)}${query}`);
        expect([query, res.status, res.body.count]).toEqual([query, 200, count]);
      }
    });

    it('a page of exactly the limit that ends the history has no marker and no Link', async () => {
      const exact = await get(`${listPath(ACCOUNT)}?limit=125`);
      expect(exact.body.count).toBe(125);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();
      const more = await get(`${listPath(ACCOUNT)}?limit=124`);
      expect(more.body.count).toBe(124);
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('descending reverses the order of the list', async () => {
      const asc = await get(`${listPath(BUSY)}?limit=1000`);
      const desc = await get(`${listPath(BUSY)}?limit=1000&descending=true`);
      expect(hashesIn(desc.body)).toEqual(hashesIn(asc.body).reverse());
      expect(hashesIn(asc.body)).toEqual(hashesOfRows(historyOf(BUSY)));
      // the spellings of true
      for (const on of ['TRUE', 'True', 'xtruex']) {
        const res = await get(`${listPath(BUSY)}?limit=1000&descending=${on}`);
        expect([on, hashesIn(res.body)]).toEqual([on, hashesIn(desc.body)]);
      }
      for (const off of ['false', '0', '1', '']) {
        const res = await get(`${listPath(BUSY)}?limit=1000&descending=${off}`);
        expect([off, hashesIn(res.body)]).toEqual([off, hashesIn(asc.body)]);
      }
    });

    it('marker pages concatenate to the unpaged list, ascending and descending', async () => {
      for (const descending of [false, true]) {
        const suffix = descending ? '?descending=true' : '';
        const unpaged = await get(`${listPath(BUSY)}${suffix}${suffix ? '&' : '?'}limit=1000`);
        expect(unpaged.body.count).toBe(179);
        for (const limit of [3, 50, 178]) {
          const walked = await pages(`${listPath(BUSY)}${suffix}`, limit);
          expect([descending, limit, walked.flatMap(hashesIn)]).toEqual([descending, limit, hashesIn(unpaged.body)]);
          expect(walked.slice(0, -1).every((p) => p.count === limit)).toBe(true);
          expect(walked[walked.length - 1].marker).toBeUndefined();
        }
      }
    });

    it('a marker continues strictly after its row', async () => {
      const rows = historyOf(BUSY);
      const asc = await get(`${listPath(BUSY)}?limit=3&marker=${markerOf(rows[100])}`);
      expect(hashesIn(asc.body)).toEqual(hashesOfRows(rows.slice(101, 104)));
      const desc = await get(`${listPath(BUSY)}?limit=3&descending=true&marker=${markerOf(rows[100])}`);
      expect(hashesIn(desc.body)).toEqual(hashesOfRows([rows[99], rows[98], rows[97]]));
      // a marker of a row that is not in this history is still a place in it
      const probe = { ledger_index: rows[10].ledger_index, tx_index: rows[10].tx_index + 1 };
      const between = await get(`${listPath(BUSY)}?limit=2&marker=${markerOf(probe)}`);
      expect(hashesIn(between.body)).toEqual(hashesOfRows(rows.filter((r) => byKey(r, probe) > 0).slice(0, 2)));
      const beyond = await get(`${listPath(BUSY)}?marker=${Buffer.from('[999999999,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    it('a marker that is none of this list → 400 invalid marker', async () => {
      const bad = [
        `${ACCOUNT}|20150114174310|000011119015|00001`, // the HBase row key of the original
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2,3]').toString('base64url'), // a sequence marker is not a time marker
        Buffer.from('["a",1]').toString('base64url'),
        Buffer.from('[-1,0]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
      ];
      for (const marker of bad) {
        const res = await get(`${listPath(BUSY)}?marker=${encodeURIComponent(marker)}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`${listPath(BUSY)}?start=2030-01-01&marker=${markerOf(historyOf(BUSY)[3])}`);
      expect(res.body).toEqual({ result: 'success', count: 0, transactions: [] });
    });

    it('the Link header keeps the request and puts the marker in place or last', async () => {
      const first = await get(
        `${listPath(BUSY)}${qs({ limit: 2, type: 'OfferCreate', start: '2013-01-01T00:00:00+00:00' })}`,
      );
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}${listPath(BUSY)}?limit=2&type=OfferCreate&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`${listPath(BUSY)}?limit=2&marker=${first.body.marker}&type=OfferCreate`);
      expect(second.headers.link).toBe(
        `<${new URL(second.request.url).origin}${listPath(BUSY)}?limit=2&marker=${second.body.marker}&type=OfferCreate>; rel="next"`,
      );
    });

    it('following the Link header walks the whole history', async () => {
      const seen: string[] = [];
      let path: string | undefined = `${listPath(BUSY)}?limit=60&descending=true`;
      for (let i = 0; path && i < 10; i++) {
        const res: { body: ListBody; headers: Record<string, string | undefined> } = await api.ok<ListBody>(
          path,
          'transactions',
        );
        seen.push(...hashesIn(res.body));
        const link = res.headers.link;
        path = link ? /^<[^/]+\/\/[^/]+(.*)>; rel="next"$/.exec(link)?.[1] : undefined;
      }
      expect(seen).toEqual(hashesOfRows([...historyOf(BUSY)].reverse()));
    });
  });

  // -- shared list behaviour ----------------------------------------------------------------------------------------

  describe('the list', () => {
    it('empty range → count 0', async () => {
      for (const window of ['start=2030-01-01&end=2030-12-31', 'start=2030-01-01', 'start=2000-01-01&end=2001-01-01']) {
        const res = await get(`${listPath(BUSY)}?${window}`);
        expect([window, res.status, res.body]).toEqual([
          window,
          200,
          { result: 'success', count: 0, transactions: [] },
        ]);
      }
    });

    it('unknown params ignored', async () => {
      const plain = await get(listPath(SENDER));
      const res = await get(`${listPath(SENDER)}?foo=bar&offset=3&ledger_min=5&format=csv&api_key=x`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('format=csv is ignored: the original has no CSV for account transactions', async () => {
      const res = await get(`${listPath(SENDER)}?format=csv&limit=2`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body.count).toBe(2);
    });

    it('a window is the ledgers that closed in it, the end second included', async () => {
      const cases: [string, string, string][] = [
        ['2015-01-14T18:27:10', '2015-01-14T18:27:29', '2015-01-14T18:27:30'],
        ['2015-01-14T18:27', '2015-01-14T18:27', '2015-01-14T18:28'],
        ['2015-01-14', '2015-01-14', '2015-01-15'],
        ['2015-01', '2015-02', '2015-03'],
      ];
      for (const [start, end, before] of cases) {
        const res = await get(`${listPath(ACCOUNT)}${qs({ start, end, limit: 1000 })}`);
        expect([start, end, hashesIn(res.body)]).toEqual([
          start,
          end,
          hashesOfRows(closedBetween(ACCOUNT, start, before)),
        ]);
      }
    });

    it('end alone and start alone', async () => {
      const upTo = await get(`${listPath(ACCOUNT)}?end=2015-01-14T18:27:09&limit=1000`);
      expect(hashesIn(upTo.body)).toEqual(hashesOfRows(closedBetween(ACCOUNT, '1970-01-01', '2015-01-14T18:27:10')));
      const from = await get(`${listPath(ACCOUNT)}?start=2015-01-14T18:27:10&limit=1000`);
      expect(hashesIn(from.body)).toEqual(
        hashesOfRows(historyOf(ACCOUNT).filter((r) => r.close_time >= unix('2015-01-14T18:27:10'))),
      );
    });

    it('a window with a marker and a type walks the matches of the window only', async () => {
      const expected = closedBetween(BUSY, '2015-01-14T18:27:00', '2015-01-14T18:28:00').filter(
        (r) => r.tx_type === 'OfferCreate',
      );
      expect(expected.length).toBeGreaterThan(2);
      const walked = (
        await pages(
          `${listPath(BUSY)}?start=2015-01-14T18:27:00&end=2015-01-14T18:27:59&type=OfferCreate&descending=true`,
          2,
        )
      ).flatMap(hashesIn);
      expect(walked).toEqual(hashesOfRows([...expected].reverse()));
    });
  });

  // -- by sequence --------------------------------------------------------------------------------------------------

  describe('min_sequence and max_sequence', () => {
    const sequencesIn = (body: ListBody): number[] => body.transactions.map((t) => t.tx.Sequence);
    const sent = sentBy(SEQUENCED);

    it('page the sequences the account sent, both ends included, ascending', async () => {
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=11370355&max_sequence=11370368`);
      const expected = sent.filter((r) => r.sequence >= 11370355 && r.sequence <= 11370368);
      expect(expected).toHaveLength(14);
      expect(sequencesIn(res.body)).toEqual(expected.map((r) => r.sequence));
      expect(hashesIn(res.body)).toEqual(hashesOfRows(expected));
      expect(res.body.marker).toBeUndefined();
    });

    it('min_sequence alone runs to the end and max_sequence alone from the start, both limit 20', async () => {
      const fromMin = await get(`${listPath(SEQUENCED)}?min_sequence=11371000&limit=1000`);
      expect(sequencesIn(fromMin.body)).toEqual(sent.filter((r) => r.sequence >= 11371000).map((r) => r.sequence));
      const upToMax = await get(`${listPath(SEQUENCED)}?max_sequence=11368935`);
      expect(sequencesIn(upToMax.body)).toEqual([11368825, 11368933, 11368934, 11368935]);
      const lowest = await get(`${listPath(SEQUENCED)}?max_sequence=99999999999`);
      expect(lowest.body.count).toBe(20);
      expect(sequencesIn(lowest.body)).toEqual(sent.slice(0, 20).map((r) => r.sequence));
    });

    it('min_sequence=0 is a sequence query, not the time one', async () => {
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=1000`);
      // 106 transactions it sent, not the 108 that touch it
      expect(res.body.count).toBe(106);
      expect(sequencesIn(res.body)).toEqual(sent.map((r) => r.sequence));
      const max = await get(`${listPath(SEQUENCED)}?max_sequence=0`);
      expect(max.body.count).toBe(0);
    });

    it('is the transactions the account sent: a recipient has none', async () => {
      expect(historyOf(RECIPIENT)).toHaveLength(1);
      expect((await get(`${listPath(RECIPIENT)}?min_sequence=0`)).body).toEqual({
        result: 'success',
        count: 0,
        transactions: [],
      });
      expect((await get(`${listPath(ACCOUNT)}?min_sequence=0&max_sequence=99999999`)).body.count).toBe(0);
      // the time list of the same account has them
      expect((await get(listPath(ACCOUNT))).body.count).toBe(20);
    });

    it('descending runs from the highest sequence down, both ends included', async () => {
      const asc = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364`);
      const desc = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364&descending=true`);
      expect(sequencesIn(desc.body)).toEqual(sequencesIn(asc.body).reverse());
      expect(sequencesIn(desc.body)).toEqual([
        11370364, 11370363, 11370362, 11370361, 11370360, 11370359, 11370358, 11370357,
      ]);
    });

    it('ignores start and end, whatever they are', async () => {
      const plain = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364`);
      for (const extra of ['start=2030-01-01', 'end=2000-01-01', 'start=nope&end=nope', 'start=2030&end=2031']) {
        const res = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364&${extra}`);
        expect([extra, res.status, res.body]).toEqual([extra, 200, plain.body]);
      }
    });

    it('marker pages concatenate to the unpaged list, ascending and descending', async () => {
      for (const descending of [false, true]) {
        const base = `${listPath(SEQUENCED)}?min_sequence=0${descending ? '&descending=true' : ''}`;
        const unpaged = await get(`${base}&limit=1000`);
        expect(unpaged.body.count).toBe(106);
        for (const limit of [1, 7, 105]) {
          const walked = await pages(base, limit);
          expect([descending, limit, walked.flatMap(hashesIn)]).toEqual([descending, limit, hashesIn(unpaged.body)]);
        }
      }
    });

    it('the marker is (sequence, ledger_index, tx_index) and continues strictly after its row', async () => {
      const page = await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=5`);
      expect(page.body.marker).toBe(sequenceMarkerOf(sent[4]));
      const next = await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=3&marker=${sequenceMarkerOf(sent[10])}`);
      expect(hashesIn(next.body)).toEqual(hashesOfRows(sent.slice(11, 14)));
      const back = await get(
        `${listPath(SEQUENCED)}?min_sequence=0&limit=3&descending=true&marker=${sequenceMarkerOf(sent[10])}`,
      );
      expect(hashesIn(back.body)).toEqual(hashesOfRows([sent[9], sent[8], sent[7]]));
    });

    it('a time marker is not a sequence marker and the other way round → 400 invalid marker', async () => {
      const time = markerOf(historyOf(SEQUENCED)[3]);
      const sequence = sequenceMarkerOf(sent[3]);
      const a = await get(`${listPath(SEQUENCED)}?min_sequence=0&marker=${time}`);
      expect([a.status, a.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
      const b = await get(`${listPath(SEQUENCED)}?marker=${sequence}`);
      expect([b.status, b.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    });

    it('type and result filter the sequence list too, as they did in the original', async () => {
      const cancels = sent.filter((r) => txOf(r).row.tx_type === 'OfferCancel');
      expect(cancels.length).toBeGreaterThan(2);
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=0&type=OfferCancel&limit=1000`);
      expect(sequencesIn(res.body)).toEqual(cancels.map((r) => r.sequence));
      const walked = (await pages(`${listPath(SEQUENCED)}?min_sequence=0&type=OfferCancel&descending=true`, 2)).flatMap(
        hashesIn,
      );
      expect(walked).toEqual(hashesOfRows([...cancels].reverse()));
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0&type=Payment`)).body.count).toBe(0);
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0&result=tesSUCCESS&limit=1000`)).body.count).toBe(106);
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0&result=tecPATH_DRY`)).body.count).toBe(0);
    });

    it('an empty range and a range beyond the sequences → count 0', async () => {
      for (const query of [
        'min_sequence=1&max_sequence=11368000',
        'min_sequence=13299879',
        // alone, a bound above the highest sequence leaves nothing: it is not swapped with a missing other bound
        'min_sequence=4294967296',
        'min_sequence=99999999999999999999999',
        // both beyond, in either order
        'min_sequence=4294967296&max_sequence=4294967297',
        'min_sequence=99999999999999999999999&max_sequence=4294967296',
        'min_sequence=13299879&max_sequence=13299880',
      ]) {
        const res = await get(`${listPath(SEQUENCED)}?${query}`);
        expect([query, res.status, res.body]).toEqual([query, 200, { result: 'success', count: 0, transactions: [] }]);
      }
    });

    it('a reversed range (min_sequence > max_sequence) is the range between them, both ends in (R57)', async () => {
      // the HBase scan of the original swapped its ends when they came upside down and served what lies between
      const ordinary = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364`);
      const expected = [11370357, 11370358, 11370359, 11370360, 11370361, 11370362, 11370363, 11370364];
      expect(sequencesIn(ordinary.body)).toEqual(expected);

      const reversed = await get(`${listPath(SEQUENCED)}?min_sequence=11370364&max_sequence=11370357`);
      expect(reversed.status).toBe(200);
      expect(reversed.body).toEqual(ordinary.body);
      const descending = await get(
        `${listPath(SEQUENCED)}?min_sequence=11370364&max_sequence=11370357&descending=true`,
      );
      expect(sequencesIn(descending.body)).toEqual([...expected].reverse());

      // with pages, in both directions, and with a filter
      for (const dir of ['', '&descending=true']) {
        const base = `${listPath(SEQUENCED)}?min_sequence=11370364&max_sequence=11370357${dir}`;
        const walked = (await pages(base, 3)).flatMap(sequencesIn);
        expect([dir, walked]).toEqual([dir, dir ? [...expected].reverse() : expected]);
      }
      const typed = await get(`${listPath(SEQUENCED)}?min_sequence=11370364&max_sequence=11370357&type=OfferCreate`);
      expect(sequencesIn(typed.body)).toEqual(expected);
      // equal bounds are one sequence
      const one = await get(`${listPath(SEQUENCED)}?min_sequence=11370360&max_sequence=11370360`);
      expect(sequencesIn(one.body)).toEqual([11370360]);
    });

    it('a reversed range with one bound beyond what a sequence can be: from the other bound up (R57)', async () => {
      // 1e23 is clamped to the highest sequence after the swap
      for (const query of [
        'min_sequence=99999999999999999999999&max_sequence=13299872',
        'min_sequence=13299872&max_sequence=99999999999999999999999',
        'min_sequence=4294967296&max_sequence=13299872',
      ]) {
        const res = await get(`${listPath(SEQUENCED)}?${query}`);
        expect([query, sequencesIn(res.body)]).toEqual([query, [13299872, 13299878]]);
      }
      // swapped down to zero: sequences 0 to 11368933
      const low = await get(`${listPath(SEQUENCED)}?min_sequence=11368933&max_sequence=0`);
      expect(sequencesIn(low.body)).toEqual([11368825, 11368933]);
    });

    it('a max_sequence beyond what a sequence can be is the highest sequence', async () => {
      for (const max of ['4294967295', '4294967296', '99999999999999999999999']) {
        const res = await get(`${listPath(SEQUENCED)}?min_sequence=13299870&max_sequence=${max}`);
        expect([max, sequencesIn(res.body)]).toEqual([max, [13299872, 13299878]]);
      }
    });

    it('limit: 20 by default, 1000 at most', async () => {
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0`)).body.count).toBe(20);
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=5000`)).body.count).toBe(106);
      expect((await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=0`)).body.count).toBe(20);
    });

    it('binary=true serves hex, the Link header carries the sequence marker', async () => {
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=0&limit=2&binary=true`);
      expect(res.body.transactions.map((t: Item) => typeof t.tx)).toEqual(['string', 'string']);
      const origin = new URL(res.request.url).origin;
      expect(res.headers.link).toBe(
        `<${origin}${listPath(SEQUENCED)}?min_sequence=0&limit=2&binary=true&marker=${res.body.marker}>; rel="next"`,
      );
    });
  });

  // -- one transaction by sequence ------------------------------------------------------------------------------

  describe('/:sequence', () => {
    const target = sentBy(SEQUENCED).find((r) => r.sequence === 11370364) as Key & { sequence: number };

    it('is {result, transaction}, the object of /v2/transactions/:hash', async () => {
      const res = await get(`${listPath(SEQUENCED)}/11370364`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['result', 'transaction']);
      expect(res.body.result).toBe('success');
      expect(res.body.transaction.hash).toBe(txOf(target).tx.hash);
      expect(res.body.transaction.ledger_index).toBe(11119600);
      expect(Object.keys(res.body.transaction)).toEqual(['hash', 'ledger_index', 'date', 'tx', 'meta']);
      expect(res.body.transaction.tx.Account).toBe(SEQUENCED);
      const single = await get(`/v2/transactions/${txOf(target).tx.hash}`);
      expect(res.body.transaction).toEqual(single.body.transaction);
    });

    it('every sequence the account sent finds its transaction, and no other', async () => {
      for (const row of sentBy(SEQUENCED).slice(0, 25)) {
        const res = await get(`${listPath(SEQUENCED)}/${row.sequence}`);
        expect([row.sequence, res.status, res.body.transaction?.hash]).toEqual([row.sequence, 200, txOf(row).tx.hash]);
      }
    });

    it('binary=true serves tx and meta as hex', async () => {
      const res = await get(`${listPath(SEQUENCED)}/11370364?binary=true`);
      expect(res.status).toBe(200);
      expect(typeof res.body.transaction.tx).toBe('string');
      expect(typeof res.body.transaction.meta).toBe('string');
      const single = await get(`/v2/transactions/${txOf(target).tx.hash}?binary=true`);
      expect(res.body.transaction).toEqual(single.body.transaction);
      expect(typeof (await get(`${listPath(SEQUENCED)}/11370364?binary=false`)).body.transaction.tx).toBe('object');
    });

    it('leading zeros are the same sequence (the original padded the number to 12 digits)', async () => {
      const res = await get(`${listPath(SEQUENCED)}/000011370364`);
      expect(res.status).toBe(200);
      expect(res.body.transaction.hash).toBe(txOf(target).tx.hash);
    });

    it('a sequence that is not digits → 400 invalid sequence number', async () => {
      for (const bad of ['abc', '1.5', '-1', '+1', '1e3', '0x10', '12abc', 'NaN', '%20', '1%20', '１２']) {
        const res = await get(`${listPath(SEQUENCED)}/${encodeURIComponent(bad)}`);
        expect([bad, res.status, res.body]).toEqual([
          bad,
          400,
          { result: 'error', message: 'invalid sequence number' },
        ]);
      }
    });

    it('a sequence the account never used → 404 transaction not found', async () => {
      for (const sequence of ['10000', '0', '11370369', '4294967295', '4294967296', '99999999999999999999999']) {
        const res = await get(`${listPath(SEQUENCED)}/${sequence}`);
        expect([sequence, res.status, res.body]).toEqual([
          sequence,
          404,
          { result: 'error', message: 'transaction not found' },
        ]);
      }
    });

    it('the sequence of another account, an account that never sent and an unknown address → 404', async () => {
      // the sequence is the account's: 10905 is SENDER's
      expect((await get(`${listPath(SENDER)}/10905`)).status).toBe(200);
      expect((await get(`${listPath(SEQUENCED)}/10905`)).status).toBe(404);
      // a recipient has the transaction in its history, but not under a sequence
      const received = historyOf(ACCOUNT)[0];
      const sequence = txOf(received).row.sequence;
      expect((await get(`${listPath(ACCOUNT)}/${sequence}`)).status).toBe(404);
      for (const account of ['rrrrrrrrrrrrrrrrrrrrBZbvji', 'nonsense']) {
        const res = await get(`/v2/accounts/${account}/transactions/1`);
        expect([account, res.status, res.body]).toEqual([
          account,
          404,
          { result: 'error', message: 'transaction not found' },
        ]);
      }
    });

    it('an invalid sequence is refused before the database is asked', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`${listPath(SEQUENCED)}/abc`);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('a sequence beyond what a sequence can be does not reach the database as one', async () => {
      const query = jest.spyOn(h.ch, 'query');
      expect((await get(`${listPath(SEQUENCED)}/99999999999999999999999`)).status).toBe(404);
      expect(query).not.toHaveBeenCalled();
    });

    it('the list is not read for a lookup: one row of account_tx_by_sequence, then the transaction', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`${listPath(SEQUENCED)}/11370364`);
      const sql = query.mock.calls.map(([q]) => String(q));
      expect(sql).toHaveLength(2);
      expect(sql[0]).toContain(Table.AccountTxBySequence);
      expect(sql[0]).toMatch(/LIMIT 1\b/);
      expect(sql[1]).toContain(Table.Transactions);
      expect(query.mock.calls[0][1]).toEqual({ account: SEQUENCED, sequence: 11370364 });
    });
  });

  // -- the storage ----------------------------------------------------------------------------------------------

  describe('the tables and the plan of the queries', () => {
    const paging = (spy: jest.SpyInstance, table: string): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${table}\\b`).test(String(q)) && isPageRead(String(q)))
        .map(([q, params]) => [String(q), params as Record<string, unknown>]);

    it('time mode pages account_transactions for the keys and reads the rows from transactions', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`${listPath(BUSY)}?limit=10&type=OfferCreate&result=tesSUCCESS`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(10);

      const [[sql, params]] = paging(query, Table.AccountTransactions);
      expect(paging(query, Table.AccountTxBySequence)).toHaveLength(0);
      expect(sql).toMatch(/account = \{account:String\}/);
      expect(sql).toMatch(/tx_type = \{type:String\}/);
      expect(sql).toMatch(/result = \{result:String\}/);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      // the whole key, equality prefix included, and a row that was written twice counts once
      // read with a plain LIMIT, which stops the read after the page (Ruling R106) ...
      expect(sql).toMatch(/ORDER BY account ASC, ledger_index ASC, tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}/);
      // ... and outside it a row that was written twice counts once
      expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
      expect(params).toMatchObject({
        account: BUSY,
        type: 'OfferCreate',
        result: 'tesSUCCESS',
        distinct_page_limit: 11,
      });
      // values are bound, never written into the SQL
      expect(sql).not.toContain(BUSY);
      // the wide rows: transactions, by key, without FINAL
      const wide = query.mock.calls
        .map(([q]) => String(q))
        .filter((q) => new RegExp(`FROM ${Table.Transactions}\\b`).test(q));
      expect(wide).toHaveLength(1);
      expect(wide[0]).not.toMatch(/FINAL/);
    });

    it('sequence mode pages account_tx_by_sequence for the keys', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`${listPath(SEQUENCED)}?min_sequence=11370357&max_sequence=11370364&limit=4`);
      expect(res.body.count).toBe(4);
      const [[sql, params]] = paging(query, Table.AccountTxBySequence);
      expect(paging(query, Table.AccountTransactions)).toHaveLength(0);
      expect(sql).toMatch(/account = \{account:String\}/);
      expect(sql).toMatch(/sequence BETWEEN \{min_sequence:UInt32\} AND \{max_sequence:UInt32\}/);
      expect(sql).toMatch(/ORDER BY account ASC, sequence ASC, ledger_index ASC, tx_index ASC/);
      expect(sql).toMatch(/LIMIT 1 BY sequence, ledger_index, tx_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
      expect(sql).not.toContain(SEQUENCED);
      expect(params).toMatchObject({
        account: SEQUENCED,
        min_sequence: 11370357,
        max_sequence: 11370364,
        distinct_page_limit: 5,
      });
      // and no ledger range: the dates are not read in this mode
      expect(query.mock.calls.map(([q]) => String(q)).some((q) => /FROM ledgers\b/.test(q))).toBe(false);
    });

    it('sequence mode filters type and result through the sender rows of account_transactions', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`${listPath(SEQUENCED)}?min_sequence=0&type=OfferCancel&result=tesSUCCESS&limit=2`);
      const [[sql, params]] = paging(query, Table.AccountTxBySequence);
      expect(sql).toMatch(
        new RegExp(
          `\\(ledger_index, tx_index\\) IN \\(\\s*SELECT ledger_index, tx_index FROM ${Table.AccountTransactions}\\s+WHERE account = \\{account:String\\}`,
        ),
      );
      expect(sql).toMatch(/tx_type = \{type:String\}/);
      expect(params).toMatchObject({ type: 'OfferCancel', result: 'tesSUCCESS' });
    });

    it('reads the tables in the order of their primary key, so that a page never sorts the whole history', async () => {
      // The plan shows the key is read in order and never sorted. It does not prove the ORDER BY spells `account`:
      // ClickHouse reads in order here with or without it, because `account = const` fixes that prefix. The
      // 'time mode pages ...' and 'sequence mode pages ...' tests assert the ORDER BY text for that rule (a
      // suffix-only ORDER BY can force a full sort on other layouts).
      const middle = historyOf(BUSY)[100];
      const sentMiddle = sentBy(SEQUENCED)[40];
      const variants: [string, string, string][] = [
        ['time', BUSY, `limit=5`],
        ['time', BUSY, `limit=5&marker=${markerOf(middle)}`],
        ['time', BUSY, `limit=5&type=OfferCancel&result=tesSUCCESS`],
        ['time', BUSY, `limit=5&start=2015-01-14T18:27:10&end=2015-01-14T18:27:29&marker=${markerOf(middle)}`],
        ['sequence', SEQUENCED, `limit=5&min_sequence=0`],
        ['sequence', SEQUENCED, `limit=5&min_sequence=11370357&max_sequence=11370364`],
        ['sequence', SEQUENCED, `limit=5&min_sequence=0&marker=${sequenceMarkerOf(sentMiddle)}`],
        ['sequence', SEQUENCED, `limit=5&min_sequence=0&type=OfferCreate`],
      ];
      for (const descending of [false, true]) {
        for (const [mode, account, variant] of variants) {
          const query = jest.spyOn(h.ch, 'query');
          const res = await get(`${listPath(account)}?${variant}&descending=${descending}`);
          expect(res.status).toBe(200);
          const calls = paging(query, mode === 'time' ? Table.AccountTransactions : Table.AccountTxBySequence);
          jest.restoreAllMocks();
          expect(calls).toHaveLength(1);

          const [sql, params] = calls[0];
          // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
          await expectBoundedInOrderRead(h, sql, params, descending, [descending, variant]);
        }
      }
    });

    it('the keys of the account are found through the primary key, not by reading every account', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`${listPath(BUSY)}?limit=5`);
      const [[sql, params]] = paging(query, Table.AccountTransactions);
      jest.restoreAllMocks();
      const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params);
      const text = indexes.map((r) => r.explain).join('\n');
      expect(text).toContain('PrimaryKey');
      expect(text).toMatch(/Keys:[\s│]+account/);
    });
  });

  // -- failures -------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    it('the list is 500 unable to retrieve transactions, the lookup 500 unable to retrieve transaction', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql.includes(Table.AccountTransactions) || sql.includes(Table.AccountTxBySequence)
          ? Promise.reject(new Error('boom'))
          : (real as any)(sql, ...rest)) as never);
      const cases: [string, string][] = [
        [listPath(SEQUENCED), 'unable to retrieve transactions'],
        [`${listPath(SEQUENCED)}?min_sequence=0`, 'unable to retrieve transactions'],
        [`${listPath(SEQUENCED)}/11370364`, 'unable to retrieve transaction'],
      ];
      for (const [path, message] of cases) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message }]);
      }
    });

    it('also when the rows fail to load after the keys were found', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        /FROM transactions\b/.test(sql) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
      const cases: [string, string][] = [
        [listPath(SEQUENCED), 'unable to retrieve transactions'],
        [`${listPath(SEQUENCED)}/11370364`, 'unable to retrieve transaction'],
      ];
      for (const [path, message] of cases) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message }]);
      }
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${listPath(SEQUENCED)}/abc`)).status).toBe(400);
      expect((await get(`${listPath(SEQUENCED)}?type=Bogus`)).status).toBe(400);
      expect((await get(`${listPath(SEQUENCED)}?marker=!!!`)).status).toBe(400);
    });
  });
});

describe('account transactions API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const LEDGER = 11119600;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'transactions');
  const inLedger = (rows: Key[]): Key[] => rows.filter((r) => r.ledger_index === LEDGER);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const table of [Table.Transactions, Table.AccountTransactions, Table.AccountTxBySequence]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      const [{ n: before }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
      );
      await h.ch.command(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${table} WHERE ledger_index = {index:UInt32}`,
        { index: LEDGER },
      );
      expect(Number(n)).toBe(Number(before) * 2);
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every transaction once, and a page cut inside the duplicates neither repeats nor skips a row', async () => {
    const history = historyOf(SEQUENCED);
    const sent = sentBy(SEQUENCED);
    expect(inLedger(history).length).toBeGreaterThan(5);
    expect(inLedger(sent).length).toBeGreaterThan(5);
    // the window holds the written-twice ledger (and what closed in the same second); the sequences are its own
    const closed = new Date(txOf(inLedger(history)[0]).ledger.header.close_time * 1000).toISOString().slice(0, 19);
    const inWindow = closedBetween(SEQUENCED, closed, new Date(unix(closed) * 1000 + 1000).toISOString().slice(0, 19));
    const sequences = sent.filter((r) => r.sequence >= 11370356 && r.sequence <= 11370364);
    const window = `start=${closed}&end=${closed}`;
    const range = 'min_sequence=11370356&max_sequence=11370364';
    expect(inWindow.length).toBeGreaterThanOrEqual(inLedger(history).length);
    expect(sequences).toHaveLength(9);

    const cases: [string, Key[]][] = [
      [window, inWindow],
      [`${window}&descending=true`, [...inWindow].reverse()],
      [`${window}&type=OfferCreate`, inWindow.filter((r) => r.tx_type === 'OfferCreate')],
      [range, sequences],
      [`${range}&descending=true`, [...sequences].reverse()],
      [`${range}&type=OfferCreate`, sequences.filter((r) => txOf(r).row.tx_type === 'OfferCreate')],
    ];
    for (const [query, expected] of cases) {
      const base = `${listPath(SEQUENCED)}?${query}`;
      const unpaged = await get(`${base}&limit=1000`);
      expect([query, hashesIn(unpaged.body)]).toEqual([query, hashesOfRows(expected)]);
      for (const limit of [1, 2, 3]) {
        const paged = (await pages(base, limit)).flatMap(hashesIn);
        expect([query, limit, paged]).toEqual([query, limit, hashesOfRows(expected)]);
      }
    }
  });

  it('finds a duplicated transaction by its sequence', async () => {
    const row = sentBy(SEQUENCED).find((r) => r.ledger_index === LEDGER) as Key & { sequence: number };
    const res = await get(`${listPath(SEQUENCED)}/${row.sequence}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.hash).toBe(txOf(row).tx.hash);
  });
});

describe('account transactions API endpoint with tickets', () => {
  // A ticketed transaction has Sequence 0 (the ticket is not a sequence), so an account can have many rows under
  // sequence 0. The original kept the last one written under `account|sequence`; the list shows all of them.
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'transactions');
  const own = sentBy(SENDER);
  // three transactions of the account, as if they were ticketed
  const ticketed = [own[2], own[9], own[17]];

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.insert(
      Table.AccountTxBySequence,
      ticketed.map((r) => ({ account: SENDER, sequence: 0, ledger_index: r.ledger_index, tx_index: r.tx_index })),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  it('/:sequence 0 is the latest of them, as the row that was written last was in the original', async () => {
    const res = await get(`${listPath(SENDER)}/0`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.hash).toBe(txOf(ticketed[2]).tx.hash);
  });

  it('the sequence list has all of them, in the order of their ledgers, before the sequences', async () => {
    const res = await get(`${listPath(SENDER)}?min_sequence=0&max_sequence=0`);
    expect(hashesIn(res.body)).toEqual(hashesOfRows(ticketed));
    const all = await get(`${listPath(SENDER)}?min_sequence=0&limit=1000`);
    expect(all.body.count).toBe(25 + 3);
    expect(hashesIn(all.body).slice(0, 3)).toEqual(hashesOfRows(ticketed));
    expect(hashesIn(all.body).slice(3)).toEqual(hashesOfRows(own));
  });

  it('pages one at a time across the rows of sequence 0, in both directions', async () => {
    for (const descending of [false, true]) {
      const base = `${listPath(SENDER)}?min_sequence=0&max_sequence=0${descending ? '&descending=true' : ''}`;
      const walked = await pages(base, 1);
      expect(walked.map((p) => p.count)).toEqual([1, 1, 1]);
      const expected = hashesOfRows(descending ? [...ticketed].reverse() : ticketed);
      expect([descending, walked.flatMap(hashesIn)]).toEqual([descending, expected]);
    }
    const first = await get(`${listPath(SENDER)}?min_sequence=0&max_sequence=0&limit=1`);
    expect(first.body.marker).toBe(sequenceMarkerOf({ ...ticketed[0], sequence: 0 }));
  });

  it('their own sequences still find them', async () => {
    for (const row of ticketed) {
      const res = await get(`${listPath(SENDER)}/${row.sequence}`);
      expect([row.sequence, res.body.transaction?.hash]).toEqual([row.sequence, txOf(row).tx.hash]);
    }
  });
});

describe('account transactions API endpoint on Xahau', () => {
  const seed = 'xahau-recorded';
  const transactions = fixtureTransactions(seed);
  const byTx = new Map(transactions.map((t) => [`${t.row.ledger_index}:${t.row.tx_index}`, t]));
  const xtx = (key: Key): FixtureTx => byTx.get(`${key.ledger_index}:${key.tx_index}`) as FixtureTx;
  const affected = [...fixtureAccountTransactions(seed)].sort(byKey);
  const sent = [...fixtureAccountTxBySequence(seed)].sort((a, b) => a.sequence - b.sequence || byKey(a, b));
  const history = (account: string): AccountTransactionsRow[] => affected.filter((r) => r.account === account);
  const hashes = (rows: Key[]): string[] => rows.map((r) => xtx(r).tx.hash);

  // hook-heavy accounts: payments through hooks, an Evernode host, a hook account
  const PAYEE = 'rmv53yu8Wid6kj6AC6NvmiwSXNxRa8vTH'; // 68, only ever a recipient
  const EVERNODE = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'; // 46: Remit and URITokenBuy
  const HOOKED = 'rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto'; // 44
  const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'; // GenesisMint, Sequence 0
  const REMITTER = 'rDripFkNyrKz7XUEWKCa18aTeGQ9mi7afj'; // Remit, Sequence 0
  const ZERO = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'; // Cron: a pseudo account no metadata names

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const served = new Map<string, Item>();
  const servedBinary = new Map<string, Item>();
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'transactions');

  beforeAll(async () => {
    h = await startHarness({ seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    for (const [map, binary] of [
      [served, false],
      [servedBinary, true],
    ] as const) {
      for (const page of await pages(`/v2/transactions?binary=${binary}`, 100)) {
        for (const { ledger_hash: _ledgerHash, ...item } of page.transactions) map.set(item.hash, item as Item);
      }
      expect(map.size).toBe(transactions.length);
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every hook-heavy history is the transactions that affect the account, in JSON and in binary', async () => {
    let withHooks = 0;
    for (const account of [PAYEE, EVERNODE, HOOKED]) {
      const expected = history(account);
      expect(expected.length).toBeGreaterThan(40);
      for (const binary of [false, true]) {
        const walked = (await pages(`${listPath(account)}?binary=${binary}`, 25)).flatMap((p) => p.transactions);
        expect([account, binary, walked.map((t) => t.hash)]).toEqual([account, binary, hashes(expected)]);
        for (const item of walked) {
          expect(item).toEqual((binary ? servedBinary : served).get(item.hash));
          expect(item).not.toHaveProperty('ledger_hash');
          expect(typeof item.tx).toBe(binary ? 'string' : 'object');
          if (!binary && JSON.stringify(item.meta).includes('HookExecutions')) withHooks++;
        }
      }
    }
    expect(withHooks).toBeGreaterThan(50);
  });

  it('a recipient that never sends has its history', async () => {
    expect(sent.some((r) => r.account === PAYEE)).toBe(false);
    const res = await get(`${listPath(PAYEE)}?limit=1000`);
    expect(res.body.count).toBe(68);
    expect(res.body.transactions.every((t: Item) => t.tx.TransactionType === 'Payment')).toBe(true);
    expect((await get(`${listPath(PAYEE)}?min_sequence=0`)).body.count).toBe(0);
  });

  it('type and result are the ones of the Xahau definitions', async () => {
    const remits = history(EVERNODE).filter((r) => r.tx_type === 'Remit');
    expect(remits.length).toBeGreaterThan(0);
    const res = await get(`${listPath(EVERNODE)}?type=Remit`);
    expect(res.status).toBe(200);
    expect(hashesIn(res.body)).toEqual(hashes(remits));
    const buys = await get(`${listPath(EVERNODE)}?type=URITokenBuy&limit=1000`);
    expect(hashesIn(buys.body)).toEqual(hashes(history(EVERNODE).filter((r) => r.tx_type === 'URITokenBuy')));
    expect((await get(`${listPath(GENESIS)}?type=GenesisMint`)).body.count).toBe(1);
    expect((await get(`${listPath(EVERNODE)}?result=tecHOOK_REJECTED`)).status).toBe(200);
    expect((await get(`${listPath(EVERNODE)}?type=SetFee`)).status).toBe(200);
    expect((await get(`${listPath(EVERNODE)}?type=Transaction`)).status).toBe(400);
    expect((await get(`${listPath(EVERNODE)}?result=tecPATH_DRY`)).status).toBe(200);
  });

  it('the window, the direction and the pages work as on XRPL', async () => {
    const unpaged = await get(`${listPath(HOOKED)}?limit=1000`);
    expect(unpaged.body.count).toBe(44);
    expect(hashesIn(unpaged.body)).toEqual(hashes(history(HOOKED)));
    expect(hashesIn((await get(`${listPath(HOOKED)}?descending=true&limit=1000`)).body)).toEqual(
      hashesIn(unpaged.body).reverse(),
    );
    expect(hashesIn(unpaged.body)).toEqual((await pages(listPath(HOOKED), 7)).flatMap(hashesIn));
    expect((await get(`${listPath(HOOKED)}?start=2030-01-01`)).body.count).toBe(0);
    // the window of one ledger
    const target = history(HOOKED)[10];
    const close = unixOf(xtx(target).ledger.header.close_time);
    const window = history(HOOKED).filter((r) => r.close_time === target.close_time);
    const res = await get(`${listPath(HOOKED)}?start=${close}&end=${close}&limit=1000`);
    expect(hashesIn(res.body)).toEqual(hashes(window));
    expect(res.body.count).toBeGreaterThan(0);
  });

  it('the sequence queries: Sequence 0 is shared by the transactions that have none', async () => {
    const withSequence = sent.filter((r) => r.sequence > 0);
    expect(withSequence.length).toBeGreaterThan(0);
    const holder = withSequence[0].account;
    const own = sent.filter((r) => r.account === holder);
    const res = await get(`${listPath(holder)}?min_sequence=0&limit=1000`);
    expect(hashesIn(res.body)).toEqual(hashes(own));
    const first = own.find((r) => r.sequence > 0) as Key & { sequence: number };
    const one = await get(`${listPath(holder)}/${first.sequence}`);
    expect(one.body.transaction.hash).toBe(xtx(first).tx.hash);
    expect(one.body.transaction.tx.Sequence).toBe(first.sequence);

    for (const [account, type] of [
      [GENESIS, 'GenesisMint'],
      [REMITTER, 'Remit'],
    ]) {
      const zero = await get(`${listPath(account)}/0`);
      expect([account, zero.status, zero.body.transaction?.tx.TransactionType]).toEqual([account, 200, type]);
      expect(zero.body.transaction.tx.Sequence).toBe(0);
    }
  });

  it('the pseudo account of a Cron has the transaction by sequence but no history', async () => {
    expect(history(ZERO)).toHaveLength(0);
    expect((await get(listPath(ZERO))).body.count).toBe(0);
    const cron = transactions.find((t) => t.row.tx_type === 'Cron') as FixtureTx;
    const res = await get(`${listPath(ZERO)}/0`);
    expect(res.body.transaction.hash).toBe(cron.tx.hash);
    expect(hashesIn((await get(`${listPath(ZERO)}?min_sequence=0`)).body)).toEqual([cron.tx.hash]);
  });
});

/** `YYYY-MM-DDTHH:mm:ss` of a ledger close time in unix seconds, for a window of exactly that second. */
function unixOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19);
}

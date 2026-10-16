import { BalanceChangesRow, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { fixtureBalanceChanges } from './support/fixtures';

/**
 * `GET /v2/accounts/:address/balance_changes` on a real ClickHouse, seeded with the 54 ledgers of the original Ripple
 * test suite (`ripple-mock`: 2321 balance changes of 283 accounts, the largest being the 215 of an issuer) and with the
 * Xahau ledgers recorded from a public node (909: XAH, the EVR token, and the changes of GenesisMint, Cron, Remit
 * and URITokenBuy that have no change type).
 *
 * Ported from rippled-historical-database `test/test.account.balanceChanges.js` (all 13 `it`s, same titles, none
 * skipped). Four of them lean on HBase and are ported to what this API holds instead:
 *  - the two 'should handle pagination correctly' walk the changes of the account one by one with `limit=1` and compare
 *    each with the unpaged list, as `utils.checkPagination` does; only the marker is this API's. The original compared
 *    `.change`, a field no row has (the field is `amount_change`), so it compared undefined with undefined; here
 *    `amount_change` is compared;
 *  - 'include a link header when marker is present' expected the HBase row key as the marker
 *    (`rpjZ…|20150114182720|000011119603|00004|00001`); the marker of this API is the `(ledger_index, tx_index,
 *    node_index)` of the last row of the page;
 *  - 'should handle empty response correctly' passes a start of year 1015 and an end of 1970: nothing is stored there.
 *
 * Added: the shape of an item (field names, key order, what is left out when absent), `issuer` and `type` as aliases,
 * the values of `change_type`, the checks and their order, the shared list behaviour (empty range, marker pages,
 * descending, unknown params, limits), CSV and its file name, the query and its plan, rows that were written twice, the
 * failure paths and Xahau.
 */

const SENDER = 'rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx'; // 4 changes: the fee and the payment, twice
const TRADER = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg'; // 116 changes, 106 of them fees
const GATEWAY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // 90 changes
const ESCROWER = 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB'; // 2 changes: the fee and an EscrowCreate
const PAYEE = 'rnNzy3iPc7gPEAJbAdXwxY1UTBamBqTYhR'; // 4 changes: two PaymentChannelClaims paid out to it
const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';

interface Key {
  ledger_index: number;
  tx_index: number;
  node_index: number;
}
const byKey = (a: Key, b: Key): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;
const keyOf = (r: Key): string => `${r.ledger_index}:${r.tx_index}:${r.node_index}`;

/** Every row of `balance_changes`, in the order of the list. */
const ROWS = [...fixtureBalanceChanges('ripple-mock')].sort((a, b) => byKey(a, b) || (a.account < b.account ? -1 : 1));
const rowsOf = (account: string): BalanceChangesRow[] => ROWS.filter((r) => r.account === account);
const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))];

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** `YYYY-MM-DDTHH:mm:ss` of unix seconds. */
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19);
const closedBetween = (rows: BalanceChangesRow[], from: string, before: string): BalanceChangesRow[] =>
  rows.filter((r) => r.close_time >= unix(from) && r.close_time < unix(before));

/** The marker of a row: `(ledger_index, tx_index, node_index)` as base64url JSON. */
const markerOf = (row: Key): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index, row.node_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * The balance change of a stored row, written out the way the original served it (`accountBalanceChanges.js` on the
 * columns of `data.js`): the `d` family of the HBase row first, then the `f` family, each sorted by name, without the
 * account and the client. Fields the row does not have are left out: the node of the fee (-1), the counterparty of the
 * native currency, an empty change type, the escrow and the payment channel fields of the other rows.
 */
function changeOf(r: BalanceChangesRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    amount_change: r.amount_change,
    escrow_balance_change: r.escrow_balance_change ?? undefined,
    final_balance: r.final_balance,
    node_index: r.node_index === -1 ? undefined : r.node_index,
    paychannel_balance_change: r.paychannel_balance_change ?? undefined,
    paychannel_final_balance: r.paychannel_final_balance ?? undefined,
    paychannel_fund_change: r.paychannel_fund_change ?? undefined,
    paychannel_fund_final_balance: r.paychannel_fund_final_balance ?? undefined,
    tx_index: r.tx_index,
    change_type: r.change_type === '' ? undefined : r.change_type,
    counterparty: r.counterparty === '' ? undefined : r.counterparty,
    currency: r.currency,
    escrow_counterparty: r.escrow_counterparty ?? undefined,
    executed_time: `${iso(r.close_time)}Z`,
    ledger_index: r.ledger_index,
    paychannel_counterparty: r.paychannel_counterparty ?? undefined,
    tx_hash: r.tx_hash,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
const changesOf = (rows: BalanceChangesRow[]): Record<string, unknown>[] => rows.map(changeOf);

type Change = Record<string, unknown> & {
  tx_hash: string;
  ledger_index: number;
  tx_index: number;
  node_index?: number;
};
interface ListBody {
  result: string;
  count: number;
  marker?: string;
  balance_changes: Change[];
}
const hashesIn = (body: ListBody): string[] => body.balance_changes.map((c) => c.tx_hash);
const hashesOf = (rows: BalanceChangesRow[]): string[] => rows.map((r) => r.tx_hash);
const path = (account: string): string => `/v2/accounts/${account}/balance_changes`;

describe('account balance changes API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'balance_changes');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.account.balanceChanges.js ----------------------------------------------------------------------------------

  it('should include escrow details', async () => {
    const res = await get(path(ESCROWER));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.balance_changes.length).toBe(2);
    expect(res.body.balance_changes[1].change_type).toBe('escrow_create');
    expect(res.body.balance_changes[1].escrow_balance_change).toBe('100');
    expect(res.body.balance_changes[1].escrow_counterparty).toBe('rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB');
    expect(res.body.balance_changes).toEqual(changesOf(rowsOf(ESCROWER)));
  });

  it('should handle limit correctly', async () => {
    const res = await get(`${path(SENDER)}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.balance_changes.length).toBe(2);
  });

  it('should handle currency correctly', async () => {
    const res = await get(`${path(SENDER)}?currency=xrp`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).not.toBe(0);
    for (const bch of (res.body as ListBody).balance_changes) expect(bch.currency).toBe('XRP');
    expect(res.body.count).toBe(4);
  });

  it('should handle counterparty correctly', async () => {
    const counterparty = BITSTAMP;
    const res = await get(`${path(TRADER)}?currency=btc&counterparty=${counterparty}`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).not.toBe(0);
    for (const bch of (res.body as ListBody).balance_changes) {
      expect(bch.currency).toBe('BTC');
      expect(bch.counterparty).toBe(counterparty);
    }
    expect(res.body.balance_changes).toEqual(
      changesOf(rowsOf(TRADER).filter((r) => r.currency === 'BTC' && r.counterparty === counterparty)),
    );
    expect(res.body.count).toBe(1);
  });

  it('should limit results by change type', async () => {
    const res = await get(`${path(TRADER)}?change_type=transaction_cost&limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).not.toBe(0);
    for (const bch of (res.body as ListBody).balance_changes) {
      expect(bch.currency).toBe('XRP');
      expect(bch.change_type).toBe('transaction_cost');
    }
    expect(res.body.count).toBe(106);
  });

  it('should handle pagination correctly', async () => {
    const url = path(SENDER);
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.count).toBeGreaterThan(1);

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}?limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.balance_changes.length).toBe(1);
      expect(res.body.balance_changes[0].amount_change).toBe(ref.body.balance_changes[i].amount_change);
      expect(res.body.balance_changes[0].currency).toBe(ref.body.balance_changes[i].currency);
      expect(res.body.balance_changes[0].tx_hash).toBe(ref.body.balance_changes[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should handle pagination correctly (descending)', async () => {
    const url = `${path(SENDER)}?descending=true`;
    const ref = await get(url);
    expect(ref.body.count).toBeGreaterThan(1);
    const walked = (await pages(url, 1)).flatMap((p) => p.balance_changes);
    expect(walked.length).toBe(ref.body.count);
    walked.forEach((c, i) => {
      expect(c.amount_change).toBe(ref.body.balance_changes[i].amount_change);
      expect(c.currency).toBe(ref.body.balance_changes[i].currency);
      expect(c.tx_hash).toBe(ref.body.balance_changes[i].tx_hash);
    });
    expect(walked).toEqual(changesOf(rowsOf(SENDER)).reverse());
  });

  it('should handle dates correctly', async () => {
    const start = '2015-01-14T18:00:00';
    const end = '2015-01-14T18:30:00';
    const res = await get(`${path(SENDER)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).not.toBe(0);
    for (const bch of (res.body as ListBody).balance_changes) {
      const d = Date.parse(bch.executed_time as string);
      expect(d > Date.parse(`${start}Z`) && d < Date.parse(`${end}Z`)).toBe(true);
    }
    expect(res.body.balance_changes).toEqual(changesOf(closedBetween(rowsOf(SENDER), start, '2015-01-14T18:30:01')));
    expect(res.body.count).toBe(2);
  });

  it('should handle descending correctly', async () => {
    const res = await get(`${path(GATEWAY)}?descending=true`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).not.toBe(0);
    let last: number | undefined;
    for (const bch of (res.body as ListBody).balance_changes) {
      const d = Date.parse(bch.executed_time as string);
      if (last !== undefined) expect(last - d).toBeGreaterThanOrEqual(0);
      last = d;
    }
    expect(res.body.balance_changes).toEqual(changesOf(rowsOf(GATEWAY)).reverse());
  });

  it('should handle empty response correctly', async () => {
    const start = '1015-01-14T18:00:00';
    const end = '1970-01-14T18:30:00';
    const res = await get(`${path(SENDER)}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(res.body.balance_changes.length).toBe(0);
    expect(res.body.count).toBe(0);
  });

  it('should handle invalid params correctly', async () => {
    const res = await get(`${path(NOBODY)}?counterparty=${SENDER}&currency=Xrp`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ result: 'error', message: 'counterparty cannot be specified for XRP' });
  });

  it('should handle invalid change_type', async () => {
    const res = await get(`${path(TRADER)}?change_type=zzz`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      result: 'error',
      message:
        'invalid change_type - use: transaction_cost, exchange, intermediary, payment_source, payment_destination',
    });
  });

  it('include a link header when marker is present', async () => {
    const url = `${path(SENDER)}?limit=1`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(markerOf(rowsOf(SENDER)[0]));
    expect(res.headers.link).toBe(`<${new URL(res.request.url).origin}${url}&marker=${res.body.marker}>; rel="next"`);
  });

  // -- the balance change ----------------------------------------------------------------------------------------------

  describe('the balance changes of an account', () => {
    it('are every row of balance_changes of the account, whole and in order, for every account of the ledgers', async () => {
      expect(ACCOUNTS.length).toBe(283);
      let total = 0;
      for (const account of ACCOUNTS) {
        const res = await get(`${path(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        const rows = rowsOf(account);
        expect([account, res.body.balance_changes]).toEqual([account, changesOf(rows)]);
        total += res.body.count;
      }
      expect(total).toBe(ROWS.length);
    });

    it('have the field names of the spec; the account and the client are not served', async () => {
      const res = await get(`${path(TRADER)}?limit=1000`);
      const keys = new Set<string>();
      for (const c of (res.body as ListBody).balance_changes) {
        for (const k of Object.keys(c)) keys.add(k);
        expect(c).not.toHaveProperty('account');
        expect(c).not.toHaveProperty('client');
        expect(c).not.toHaveProperty('change');
        expect(c).not.toHaveProperty('final_balance_f');
      }
      expect([...keys].sort()).toEqual(
        [
          'amount_change',
          'change_type',
          'counterparty',
          'currency',
          'executed_time',
          'final_balance',
          'ledger_index',
          'node_index',
          'tx_hash',
          'tx_index',
        ].sort(),
      );
    });

    it('keep the key order of the original: the d family, then the f family, each sorted by name', async () => {
      const res = await get(`${path(TRADER)}?limit=1000`);
      const order = [
        'amount_change',
        'final_balance',
        'node_index',
        'tx_index',
        'change_type',
        'counterparty',
        'currency',
        'executed_time',
        'ledger_index',
        'tx_hash',
      ];
      for (const c of (res.body as ListBody).balance_changes) {
        expect(Object.keys(c)).toEqual(order.filter((k) => k in c));
      }
      // with everything an item can have
      const channel = await get(`${path(PAYEE)}?limit=1000`);
      expect(Object.keys(channel.body.balance_changes[1])).toEqual([
        'amount_change',
        'final_balance',
        'node_index',
        'paychannel_balance_change',
        'paychannel_final_balance',
        'paychannel_fund_final_balance',
        'tx_index',
        'change_type',
        'currency',
        'executed_time',
        'ledger_index',
        'paychannel_counterparty',
        'tx_hash',
      ]);
      const escrow = await get(path(ESCROWER));
      expect(Object.keys(escrow.body.balance_changes[1])).toEqual([
        'amount_change',
        'escrow_balance_change',
        'final_balance',
        'node_index',
        'tx_index',
        'change_type',
        'currency',
        'escrow_counterparty',
        'executed_time',
        'ledger_index',
        'tx_hash',
      ]);
    });

    it('amounts and balances are exact strings, the indexes numbers, the time YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get(`${path(SENDER)}?limit=1000`);
      expect(res.body.balance_changes[0]).toEqual({
        amount_change: '-0.015',
        final_balance: expect.any(String),
        tx_index: 4,
        change_type: 'transaction_cost',
        currency: 'XRP',
        executed_time: '2015-01-14T18:27:20Z',
        ledger_index: 11119603,
        tx_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
      });
      for (const c of (res.body as ListBody).balance_changes) {
        for (const field of ['amount_change', 'final_balance']) expect(typeof c[field]).toBe('string');
        for (const field of ['ledger_index', 'tx_index']) expect(typeof c[field]).toBe('number');
        expect(c.executed_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      }
    });

    it('the fee has no node_index; every other change has one', async () => {
      const rows = rowsOf(SENDER);
      expect(rows.map((r) => r.node_index)).toEqual([-1, 1, -1, 1]);
      const res = await get(path(SENDER));
      expect(res.body.balance_changes.map((c: Change) => c.node_index)).toEqual([undefined, 1, undefined, 1]);
      expect(res.body.balance_changes[0]).not.toHaveProperty('node_index');
      // a transaction's fee comes before its other changes (node -1 sorts first), also going down the other way
      const desc = await get(`${path(SENDER)}?descending=true`);
      expect(desc.body.balance_changes.map((c: Change) => c.node_index)).toEqual([1, undefined, 1, undefined]);
    });

    it('the native currency has no counterparty; an issued currency has its counterparty', async () => {
      const res = await get(`${path(TRADER)}?limit=1000`);
      let native = 0;
      let issued = 0;
      for (const c of (res.body as ListBody).balance_changes) {
        if (c.currency === 'XRP') {
          native++;
          expect(c).not.toHaveProperty('counterparty');
        } else {
          issued++;
          expect(typeof c.counterparty).toBe('string');
          expect(c.counterparty).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
        }
      }
      expect([native, issued]).toEqual([110, 6]);
    });

    it('change_type is as stored: transaction_cost, exchange, ..., and none is left out', async () => {
      const types = new Map<string, number>();
      for (const r of ROWS) types.set(r.change_type, (types.get(r.change_type) ?? 0) + 1);
      expect([...types.keys()].sort()).toEqual(
        [
          'escrow_create',
          'exchange',
          'intermediary',
          'paychannel_payout',
          'payment_destination',
          'payment_source',
          'transaction_cost',
        ].sort(),
      );
      const served = new Map<string, number>();
      for (const account of [TRADER, GATEWAY, SENDER, ESCROWER, PAYEE]) {
        for (const c of (await get(`${path(account)}?limit=1000`)).body.balance_changes as Change[]) {
          const type = c.change_type as string;
          served.set(type, (served.get(type) ?? 0) + 1);
        }
      }
      expect([...served.keys()].sort()).toEqual(
        ['escrow_create', 'exchange', 'intermediary', 'paychannel_payout', 'payment_source', 'transaction_cost'].sort(),
      );
    });

    it('escrow and payment channel fields are served when the row has them and left out otherwise', async () => {
      const escrow = (await get(path(ESCROWER))).body.balance_changes as Change[];
      expect(escrow[0]).not.toHaveProperty('escrow_balance_change');
      expect(escrow[0]).not.toHaveProperty('escrow_counterparty');
      expect(escrow[1]).toMatchObject({ escrow_balance_change: '100', escrow_counterparty: ESCROWER });

      const channel = (await get(`${path(PAYEE)}?limit=1000`)).body.balance_changes as Change[];
      const payout = rowsOf(PAYEE).filter((r) => r.change_type === 'paychannel_payout');
      expect(payout).toHaveLength(2);
      channel
        .filter((c) => c.change_type === 'paychannel_payout')
        .forEach((c, i) => {
          expect(c).toMatchObject({
            paychannel_counterparty: payout[i].paychannel_counterparty,
            paychannel_balance_change: payout[i].paychannel_balance_change,
            paychannel_final_balance: payout[i].paychannel_final_balance,
            paychannel_fund_final_balance: payout[i].paychannel_fund_final_balance,
          });
          expect(c).not.toHaveProperty('paychannel_fund_change');
          expect(c).not.toHaveProperty('escrow_counterparty');
        });
    });

    it('have the envelope result, count, marker, balance_changes', async () => {
      const res = await get(`${path(TRADER)}?limit=2`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'balance_changes']);
      const all = await get(`${path(SENDER)}?limit=1000`);
      expect(Object.keys(all.body)).toEqual(['result', 'count', 'balance_changes']);
    });

    it('an address that is none, or has no changes, is an empty list (the address is not checked)', async () => {
      for (const account of ['nonsense', NOBODY, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh']) {
        const res = await get(path(account));
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          { result: 'success', count: 0, balance_changes: [] },
        ]);
      }
    });
  });

  // -- filters ---------------------------------------------------------------------------------------------------------

  describe('the filters', () => {
    it('currency is upper-cased', async () => {
      const btc = rowsOf(TRADER).filter((r) => r.currency === 'BTC');
      expect(btc.length).toBe(3);
      for (const currency of ['BTC', 'btc', 'Btc']) {
        const res = await get(`${path(TRADER)}?currency=${currency}`);
        expect([currency, res.body.balance_changes]).toEqual([currency, changesOf(btc)]);
      }
      expect((await get(`${path(TRADER)}?currency=NOPE`)).body.count).toBe(0);
      expect((await get(`${path(TRADER)}?currency=`)).body.count).toBe(rowsOf(TRADER).length);
    });

    it('counterparty and its alias issuer are exact addresses', async () => {
      const counterparty = GATEWAY;
      const expected = rowsOf(TRADER).filter((r) => r.counterparty === counterparty);
      expect(expected.length).toBe(4);
      for (const name of ['counterparty', 'issuer']) {
        const res = await get(`${path(TRADER)}${qs({ [name]: counterparty })}`);
        expect([name, res.body.balance_changes]).toEqual([name, changesOf(expected)]);
      }
      // counterparty wins over issuer when both are given, as in the original (`counterparty || issuer`)
      const both = await get(`${path(TRADER)}${qs({ counterparty: BITSTAMP, issuer: counterparty })}`);
      expect(both.body.balance_changes).toEqual(changesOf(rowsOf(TRADER).filter((r) => r.counterparty === BITSTAMP)));
      // an empty counterparty is none
      const empty = await get(`${path(TRADER)}${qs({ counterparty: '', issuer: counterparty })}`);
      expect(empty.body.balance_changes).toEqual(changesOf(expected));
      // the address is not checked: a counterparty that is none has no changes
      expect((await get(`${path(TRADER)}?counterparty=nonsense`)).body.count).toBe(0);
    });

    it('currency and counterparty together', async () => {
      const usd = rowsOf(TRADER).filter((r) => r.currency === 'USD' && r.counterparty === GATEWAY);
      expect(usd.length).toBe(2);
      const res = await get(`${path(TRADER)}?currency=usd&issuer=${GATEWAY}`);
      expect(res.body.balance_changes).toEqual(changesOf(usd));
      expect((await get(`${path(TRADER)}?currency=EUR&issuer=${GATEWAY}`)).body.count).toBe(0);
    });

    it('change_type and its alias type', async () => {
      const exchange = rowsOf(TRADER).filter((r) => r.change_type === 'exchange');
      expect(exchange.length).toBe(10);
      for (const name of ['change_type', 'type']) {
        const res = await get(`${path(TRADER)}${qs({ [name]: 'exchange' })}`);
        expect([name, res.body.balance_changes]).toEqual([name, changesOf(exchange)]);
      }
      // change_type wins over type when both are given (`change_type || type`)
      const both = await get(`${path(TRADER)}?change_type=transaction_cost&type=exchange&limit=1000`);
      expect(both.body.count).toBe(106);
      // an empty one is none
      expect((await get(`${path(TRADER)}?change_type=&type=exchange`)).body.count).toBe(10);
      expect((await get(`${path(TRADER)}?change_type=&type=`)).body.count).toBe(rowsOf(TRADER).length);
    });

    it('every change type the original lists can be asked for', async () => {
      const all = [...ROWS.filter((r) => r.account === GATEWAY), ...rowsOf(TRADER), ...rowsOf(SENDER)];
      const seen = new Set<string>();
      for (const type of ['transaction_cost', 'exchange', 'intermediary', 'payment_source', 'payment_destination']) {
        for (const account of [GATEWAY, TRADER, SENDER, BITSTAMP, 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj']) {
          const res = await get(`${path(account)}?change_type=${type}&limit=1000`);
          expect([account, type, res.status]).toEqual([account, type, 200]);
          expect(res.body.balance_changes).toEqual(changesOf(rowsOf(account).filter((r) => r.change_type === type)));
          if (res.body.count > 0) seen.add(type);
        }
      }
      expect(all.length).toBeGreaterThan(0);
      expect([...seen].sort()).toEqual(
        ['exchange', 'intermediary', 'payment_destination', 'payment_source', 'transaction_cost'].sort(),
      );
    });

    it('the types the original does not list are rejected, even ones the data has (escrow, payment channel)', async () => {
      for (const type of ['escrow_create', 'paychannel_payout', 'fee', 'network fee', 'Exchange', 'EXCHANGE']) {
        const res = await get(`${path(ESCROWER)}${qs({ change_type: type })}`);
        expect([type, res.status, res.body]).toEqual([
          type,
          400,
          {
            result: 'error',
            message:
              'invalid change_type - use: transaction_cost, exchange, intermediary, payment_source, payment_destination',
          },
        ]);
      }
    });

    it('the filters combine, and are applied before the page is cut', async () => {
      const expected = rowsOf(TRADER).filter(
        (r) => r.currency === 'USD' && r.counterparty === GATEWAY && r.change_type === 'exchange',
      );
      expect(expected.length).toBe(2);
      const res = await get(`${path(TRADER)}?currency=USD&counterparty=${GATEWAY}&change_type=exchange&limit=1`);
      expect(res.body.balance_changes).toEqual(changesOf(expected.slice(0, 1)));
      expect(res.body.marker).toBe(markerOf(expected[0]));
      const walked = await pages(`${path(TRADER)}?type=transaction_cost`, 20);
      expect(walked.map((p) => p.count)).toEqual([20, 20, 20, 20, 20, 6]);
    });
  });

  // -- errors ----------------------------------------------------------------------------------------------------------

  describe('a request that is not valid', () => {
    it('a counterparty with the native currency → 400 counterparty cannot be specified for XRP', async () => {
      for (const query of [
        `currency=XRP&counterparty=${BITSTAMP}`,
        `currency=xrp&issuer=${BITSTAMP}`,
        `currency=Xrp&counterparty=${BITSTAMP}&issuer=${GATEWAY}`,
        'currency=xrp&counterparty=nonsense',
      ]) {
        const res = await get(`${path(TRADER)}?${query}`);
        expect([query, res.status, res.body]).toEqual([
          query,
          400,
          { result: 'error', message: 'counterparty cannot be specified for XRP' },
        ]);
      }
      // without a counterparty, without a currency, or with another currency, there is nothing wrong
      for (const query of [
        'currency=xrp',
        `counterparty=${BITSTAMP}`,
        `currency=xrp&counterparty=`,
        `currency=btc&counterparty=${BITSTAMP}`,
      ]) {
        expect([query, (await get(`${path(TRADER)}?${query}`)).status]).toEqual([query, 200]);
      }
    });

    it('the checks come in the order of the original: start, end, the counterparty, the change type, then the marker', async () => {
      const bad = `currency=xrp&counterparty=${BITSTAMP}&change_type=zzz&marker=!!!`;
      const cases: [string, string][] = [
        [`start=x&end=y&${bad}`, 'invalid start date format'],
        [`end=y&${bad}`, 'invalid end date format'],
        [bad, 'counterparty cannot be specified for XRP'],
        [
          'change_type=zzz&marker=!!!',
          'invalid change_type - use: transaction_cost, exchange, intermediary, payment_source, payment_destination',
        ],
        ['marker=!!!', 'invalid marker'],
      ];
      for (const [query, message] of cases) {
        const res = await get(`${path(TRADER)}?${query}`);
        expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
      }
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`${path(TRADER)}${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
      const end = await get(`${path(TRADER)}?end=`);
      expect([end.status, end.body.message]).toEqual([400, 'invalid end date format']);
    });

    it('tampered marker → 400 invalid marker, also for a list that is empty', async () => {
      const bad = [
        'rpjZUBy92h6worVCYERZcVCzgzgmHb17Dx|20150114182720|000011119603|00004|00001',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1,2]').toString('base64url'),
        Buffer.from('[1,2,3,4]').toString('base64url'),
        Buffer.from('["a",1,1]').toString('base64url'),
        Buffer.from('[1,1,40000]').toString('base64url'),
        Buffer.from('[1,1,-40000]').toString('base64url'),
      ];
      for (const account of [TRADER, NOBODY]) {
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
      // -1 is a node: the fee
      expect((await get(`${path(TRADER)}?marker=${Buffer.from('[1,0,-1]').toString('base64url')}`)).status).toBe(200);
    });
  });

  // -- the list --------------------------------------------------------------------------------------------------------

  describe('the list', () => {
    const QUERIES = ['', 'currency=BTC', 'change_type=exchange', `counterparty=${GATEWAY}`];

    it('empty range → count 0', async () => {
      const res = await get(`${path(TRADER)}?start=2030-01-01&end=2030-12-31`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, balance_changes: [] });
      expect(res.headers.link).toBeUndefined();
      expect((await get(`${path(TRADER)}?end=2013-06-01`)).body.count).toBe(0);
      expect((await get(`${path(TRADER)}?start=2030-01-01&marker=${markerOf(ROWS[3])}`)).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      for (const query of QUERIES) {
        const base = `${path(TRADER)}?${query}`;
        const unpaged = await get(`${base}&limit=1000`);
        expect(unpaged.body.count).toBeGreaterThan(2);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();
        const paged = await pages(base, 3);
        expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([query, paged.flatMap((p) => p.balance_changes)]).toEqual([query, unpaged.body.balance_changes]);
      }
    });

    it('descending reverses order', async () => {
      for (const query of QUERIES) {
        const base = `${path(TRADER)}?${query}`;
        const asc = await get(`${base}&limit=1000`);
        const desc = await get(`${base}&limit=1000&descending=true`);
        expect([query, desc.body.balance_changes]).toEqual([query, [...asc.body.balance_changes].reverse()]);
        const walked = await pages(`${base}&descending=true`, 7);
        expect([query, walked.flatMap((p) => p.balance_changes)]).toEqual([query, desc.body.balance_changes]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get(`${path(TRADER)}?limit=5`);
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`${path(TRADER)}?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get(`${path(TRADER)}?limit=5&descending=true`);
      expect((await get(`${path(TRADER)}?limit=5&descending=TRUE`)).body).toEqual(desc.body);
      expect(desc.body.balance_changes).toEqual(changesOf(rowsOf(TRADER).slice(-5).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get(`${path(TRADER)}?limit=5`);
      const res = await get(`${path(TRADER)}?limit=5&foo=bar&interval=day&reduce=true&autobridged=true`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get(
        `${path(TRADER)}?limit=3&limit=50&descending=true&descending=false&currency=BTC&currency=USD`,
      );
      expect(res.body.count).toBe(3);
      expect(res.body.balance_changes).toEqual(
        changesOf(
          rowsOf(TRADER)
            .filter((r) => r.currency === 'BTC')
            .slice(-3)
            .reverse(),
        ),
      );
    });

    it('start defaults to 2013-01-01; an empty start is the default', async () => {
      const all = await get(`${path(TRADER)}?limit=1000`);
      expect((await get(`${path(TRADER)}?limit=1000&start=`)).body).toEqual(all.body);
      expect((await get(`${path(TRADER)}?limit=1000&start=2013-01-01`)).body).toEqual(all.body);
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const rows = rowsOf(TRADER);
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-01-14T18:28:40', end: '2015-01-14T18:28:40' }, '2015-01-14T18:28:40', '2015-01-14T18:28:41'],
        [{ start: '2015-01-14T18:28:40Z' }, '2015-01-14T18:28:40', '2100-01-01T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ end: '2015-01' }, '2000-01-01T00:00:00', '2015-02-01T00:00:00'],
        [{ start: '2015-01-14', end: '2015-01-14' }, '2015-01-14T00:00:00', '2015-01-15T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const listed = (await pages(`${path(TRADER)}${qs(params)}`, 50)).flatMap((p) => p.balance_changes);
        const expected = closedBetween(rows, from, before);
        expect(expected.length).toBeGreaterThan(0);
        expect([params, listed]).toEqual([params, changesOf(expected)]);
      }
    });

    it('limit is 200 by default, at most 1000; below one or not a number it is the default (no "invalid limit")', async () => {
      const gateway = rowsOf('rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
      expect(gateway.length).toBe(215);
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
        const res = await get(`${path('rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y')}?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => String(q).includes(Table.BalanceChanges));
        expect([query, res.status, paging[0][1]]).toEqual([query, 200, expect.objectContaining({ fetch: rows + 1 })]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, gateway.length)]);
        jest.restoreAllMocks();
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const rows = rowsOf(TRADER);
      const exact = await get(`${path(TRADER)}?limit=${rows.length}`);
      expect(exact.body.count).toBe(rows.length);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();
      const more = await get(`${path(TRADER)}?limit=${rows.length - 1}`);
      expect(more.body.marker).toBe(markerOf(rows[rows.length - 2]));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(
        `${path(TRADER)}${qs({ limit: 2, start: '2013-01-01T00:00:00+00:00', issuer: GATEWAY })}`,
      );
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}${path(TRADER)}?limit=2&start=2013-01-01T00:00:00%2B00:00&issuer=${GATEWAY}&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`${path(TRADER)}?limit=2&marker=${first.body.marker}&descending=true`);
      expect(second.headers.link).toBe(
        `<${origin}${path(TRADER)}?limit=2&marker=${second.body.marker}&descending=true>; rel="next"`,
      );
    });

    it('a marker continues strictly after its row, also in the middle of a transaction', async () => {
      const rows = rowsOf(TRADER);
      const at = rows[6];
      const asc = await get(`${path(TRADER)}?limit=3&marker=${markerOf(at)}`);
      expect(asc.body.balance_changes).toEqual(changesOf(rows.slice(7, 10)));
      const desc = await get(`${path(TRADER)}?limit=3&descending=true&marker=${markerOf(at)}`);
      expect(desc.body.balance_changes).toEqual(changesOf([rows[5], rows[4], rows[3]]));
      const beyond = await get(`${path(TRADER)}?marker=${Buffer.from('[999999999,0,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, balance_changes: [] });
      // a transaction has a fee row (-1) and others: the page may end between them
      const sameTx = rows.filter((r) =>
        rows.some((o) => o !== r && o.ledger_index === r.ledger_index && o.tx_index === r.tx_index),
      );
      expect(sameTx.length).toBeGreaterThan(2);
      const [fee, next] = sameTx;
      expect(fee.node_index).toBe(-1);
      const resumed = await get(`${path(TRADER)}?limit=1&marker=${markerOf(fee)}`);
      expect(resumed.body.balance_changes).toEqual(changesOf([next]));
    });
  });

  // -- what is read ----------------------------------------------------------------------------------------------------

  describe('the query', () => {
    const paging = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => String(q).includes(Table.BalanceChanges))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);

    it('reads balance_changes, which holds the whole row, with the filters bound', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`${path(TRADER)}?limit=4&currency=usd&issuer=${GATEWAY}&type=exchange`);
      expect(res.status).toBe(200);
      const calls = paging(spy);
      expect(calls).toHaveLength(1);
      const [sql, params] = calls[0];
      expect(sql).toMatch(/account = \{account:String\}/);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).toMatch(/currency = \{currency:String\}/);
      expect(sql).toMatch(/counterparty = \{counterparty:String\}/);
      expect(sql).toMatch(/change_type = \{change_type:String\}/);
      // a row that was written twice counts once
      expect(sql).toContain('LIMIT 1 BY ledger_index, tx_index, node_index');
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toMatchObject({
        account: TRADER,
        currency: 'USD',
        counterparty: GATEWAY,
        change_type: 'exchange',
        fetch: 5,
      });
      expect(sql).not.toContain(TRADER);
      expect(sql).not.toContain(GATEWAY);
    });

    it('applies only the filters that were asked for', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(TRADER)}?limit=2`);
      const [[sql, params]] = paging(spy);
      for (const filter of ['currency', 'counterparty', 'change_type']) {
        expect(sql).not.toMatch(new RegExp(`\\b${filter} = \\{`));
        expect(params).not.toHaveProperty(filter);
      }
    });

    it('spells out the whole key in the ORDER BY, ascending and descending', async () => {
      for (const descending of [false, true]) {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`${path(TRADER)}?limit=2&descending=${descending}`);
        const [[sql]] = paging(spy);
        jest.restoreAllMocks();
        const d = descending ? 'DESC' : 'ASC';
        expect(sql).toContain(`ORDER BY account ${d}, ledger_index ${d}, tx_index ${d}, node_index ${d}`);
      }
    });

    it('reads the table in the order of its primary key, so that a page never sorts the whole history', async () => {
      const middle = rowsOf(TRADER)[40];
      const variants = [
        'limit=5',
        `limit=5&marker=${markerOf(middle)}`,
        'limit=5&currency=BTC',
        `limit=5&counterparty=${GATEWAY}&change_type=exchange`,
        'limit=5&start=2015-01-14T18:27:10&end=2015-01-14T18:28:40',
      ];
      for (const descending of [false, true]) {
        for (const variant of variants) {
          const spy = jest.spyOn(h.ch, 'query');
          const res = await get(`${path(TRADER)}?${variant}&descending=${descending}`);
          expect(res.status).toBe(200);
          const [[sql, params]] = paging(spy);
          jest.restoreAllMocks();

          const plan = await h.ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${sql}`, params);
          const pipeline = plan.map((r) => r.explain).join('\n');
          expect([descending, variant, pipeline]).toEqual([
            descending,
            variant,
            expect.stringContaining('ReadPoolInOrder'),
          ]);
          expect(pipeline).toContain(descending ? 'InReverseOrder' : 'algorithm: InOrder');
          expect(pipeline).not.toContain('PartialSortingTransform');
        }
      }
    });

    it('finds the account through the primary key, not by reading every account', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path(TRADER)}?limit=5`);
      const [[sql, params]] = paging(spy);
      jest.restoreAllMocks();
      const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params);
      const text = indexes.map((r) => r.explain).join('\n');
      expect(text).toContain('PrimaryKey');
      expect(text).toMatch(/Keys:\s+account/);
    });

    it('a request the client got wrong reads nothing', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      expect((await get(`${path(TRADER)}?change_type=zzz`)).status).toBe(400);
      expect((await get(`${path(TRADER)}?currency=xrp&issuer=${GATEWAY}`)).status).toBe(400);
      expect(paging(spy)).toHaveLength(0);
    });
  });

  // -- failures --------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    it('is 500 unable to retrieve balance changes', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(path(TRADER));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve balance changes' }]);
    });

    it('also when the page fails after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sql.includes(Table.BalanceChanges) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
      const res = await get(path(TRADER));
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve balance changes' }]);
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${path(TRADER)}?start=x`)).status).toBe(400);
      expect((await get(`${path(TRADER)}?marker=!!!`)).status).toBe(400);
      expect((await get(`${path(TRADER)}?type=x`)).status).toBe(400);
    });
  });

  // -- CSV -------------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one row per change, the columns in the order they first appear', async () => {
      const rows = rowsOf(SENDER);
      const res = await get(`${path(SENDER)}?format=csv&limit=1000`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(lines(res.text)).toHaveLength(1 + rows.length);
      // the fee has no node_index, but the second row does, so the column is there, empty for the fee
      expect(lines(res.text)[0].split(',')).toEqual(
        [
          'amount_change',
          'final_balance',
          'tx_index',
          'change_type',
          'currency',
          'executed_time',
          'ledger_index',
          'tx_hash',
          'node_index',
        ].map((c) => `"${c}"`),
      );
      expect(lines(res.text)[1].split(',').at(-1)).toBe('""');
      expect(lines(res.text)[2].split(',').at(-1)).toBe('"1"');
      expect(lines(res.text)[1]).toContain(`"${rows[0].tx_hash}"`);
    });

    it('is named after the account, then the currency in upper case: <address> - balance changes XRP', async () => {
      const plain = await get(`${path(SENDER)}?format=csv`);
      expect(plain.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - balance changes.csv`);
      const currency = await get(`${path(SENDER)}?format=csv&currency=xrp`);
      expect(currency.headers['content-disposition']).toBe(`attachment; filename=${SENDER} - balance changes XRP.csv`);
      expect(lines(currency.text)).toHaveLength(1 + 4);
      // the counterparty and the type do not name the file
      const other = await get(`${path(TRADER)}?format=csv&type=exchange&issuer=${GATEWAY}&limit=2`);
      expect(other.headers['content-disposition']).toBe(`attachment; filename=${TRADER} - balance changes.csv`);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`${path(TRADER)}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${path(TRADER)}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page', async () => {
      const csv = await get(`${path(TRADER)}?format=csv&limit=3`);
      const json = await get(`${path(TRADER)}?limit=3`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}${path(TRADER)}?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      expect((await get(`${path(TRADER)}?format=csv&limit=1000`)).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`${path(TRADER)}?format=csv&start=2030-01-01`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get(`${path(TRADER)}?format=csv&type=nope`);
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/^invalid change_type/);
    });
  });
});

describe('account balance changes API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const rows = rowsOf(TRADER);
  const LEDGER = rows[Math.floor(rows.length / 2)].ledger_index;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'balance_changes');

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.BalanceChanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.BalanceChanges} SELECT * FROM ${Table.BalanceChanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.BalanceChanges} WHERE ledger_index = {index:UInt32} AND account = {account:String}`,
      { index: LEDGER, account: TRADER },
    );
    expect(Number(n)).toBe(rows.filter((r) => r.ledger_index === LEDGER).length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every change once, and a page cut inside the duplicates neither repeats nor skips a row', async () => {
    expect(rows.filter((r) => r.ledger_index === LEDGER).length).toBeGreaterThan(2);
    for (const query of ['', 'currency=XRP', 'change_type=transaction_cost']) {
      const base = `${path(TRADER)}?${query}`;
      const expected = (await get(`${base}&limit=1000`)).body as ListBody;
      expect(expected.count).toBeGreaterThan(0);
      for (const limit of [1, 2, 3]) {
        const walked = (await pages(base, limit)).flatMap((p) => p.balance_changes);
        expect([query, limit, walked]).toEqual([query, limit, expected.balance_changes]);
      }
    }
    const all = await get(`${path(TRADER)}?limit=1000`);
    expect(all.body.balance_changes).toEqual(changesOf(rows));
    const desc = await pages(`${path(TRADER)}?descending=true`, 2);
    expect(desc.flatMap((p) => p.balance_changes)).toEqual(changesOf(rows).reverse());
    expect(all.body.count).toBe(rows.length);
  });
});

describe('account balance changes API endpoint on the xahau-recorded ledgers', () => {
  const seed = 'xahau-recorded';
  const rows = [...fixtureBalanceChanges(seed)].sort((a, b) => byKey(a, b) || (a.account < b.account ? -1 : 1));
  const mine = (account: string): BalanceChangesRow[] => rows.filter((r) => r.account === account);
  const accounts = [...new Set(rows.map((r) => r.account))];
  const EVERNODE = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'; // 92 changes, all EVR
  const untyped = rows.filter((r) => r.change_type === '');
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

  it('every account of the recorded ledgers lists its changes, in XAH', async () => {
    expect(accounts.length).toBeGreaterThan(50);
    let total = 0;
    for (const account of accounts) {
      const res = await get(`${path(account)}?limit=1000`);
      expect([account, res.status]).toEqual([account, 200]);
      expect([account, res.body.balance_changes]).toEqual([account, changesOf(mine(account))]);
      total += res.body.count;
    }
    expect(total).toBe(rows.length);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(['XAH', 'EVR', 'RVN', 'XXX']));
  });

  it('a change without a change type (GenesisMint, Cron, Remit, URITokenBuy) has no change_type', async () => {
    expect(untyped.length).toBe(203);
    for (const account of new Set(untyped.map((r) => r.account))) {
      const res = await get(`${path(account)}?limit=1000`);
      const expected = mine(account);
      res.body.balance_changes.forEach((c: Change, i: number) => {
        if (expected[i].change_type === '') expect(c).not.toHaveProperty('change_type');
        else expect(c.change_type).toBe(expected[i].change_type);
      });
    }
    // a change that has a type is not affected, and the types the original lists still filter
    const fees = await get(`${path(EVERNODE)}?change_type=transaction_cost&limit=1000`);
    expect(fees.body.count).toBe(mine(EVERNODE).filter((r) => r.change_type === 'transaction_cost').length);
  });

  it('XAH takes the place of XRP: a counterparty is an error for XAH, not for XRP (an ordinary currency here)', async () => {
    const res = await get(`${path(EVERNODE)}?currency=xah&counterparty=${EVERNODE}`);
    expect([res.status, res.body]).toEqual([
      400,
      { result: 'error', message: 'counterparty cannot be specified for XAH' },
    ]);
    expect((await get(`${path(EVERNODE)}?currency=XRP&counterparty=${EVERNODE}`)).status).toBe(200);
    expect((await get(`${path(EVERNODE)}?currency=xah`)).status).toBe(200);
  });

  it('currency and counterparty filter the EVR token; the native changes have no counterparty', async () => {
    const [evr] = rows.filter((r) => r.currency === 'EVR' && r.account !== EVERNODE);
    const res = await get(`${path(evr.account)}?currency=evr&counterparty=${EVERNODE}&limit=1000`);
    expect(res.body.balance_changes).toEqual(
      changesOf(mine(evr.account).filter((r) => r.currency === 'EVR' && r.counterparty === EVERNODE)),
    );
    expect(res.body.count).toBeGreaterThan(0);
    const xah = await get(`${path(evr.account)}?currency=XAH&limit=1000`);
    for (const c of (xah.body as ListBody).balance_changes) expect(c).not.toHaveProperty('counterparty');
  });

  it('pages, windows, descending and the CSV name work as on XRPL', async () => {
    const list = mine(EVERNODE);
    const walked = await api.pages<ListBody>(path(EVERNODE), 11, 'balance_changes');
    expect(walked.flatMap((p) => p.balance_changes)).toEqual(changesOf(list));
    const desc = await api.pages<ListBody>(`${path(EVERNODE)}?descending=true`, 11, 'balance_changes');
    expect(desc.flatMap((p) => p.balance_changes)).toEqual(changesOf(list).reverse());
    const mid = list[Math.floor(list.length / 2)].close_time;
    const res = await get(`${path(EVERNODE)}?limit=1000&start=${iso(mid)}`);
    expect(res.body.balance_changes).toEqual(changesOf(list.filter((r) => r.close_time >= mid)));
    expect((await get(`${path(EVERNODE)}?start=2030-01-01`)).body.count).toBe(0);
    const csv = await get(`${path(EVERNODE)}?format=csv&currency=evr&limit=5`);
    expect(csv.headers['content-disposition']).toBe(`attachment; filename=${EVERNODE} - balance changes EVR.csv`);
    expect(csv.text.split('\n')).toHaveLength(1 + 5);
  });
});

import { AccountTransactionsRow, BalanceChangesRow, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureAccountTransactions, fixtureBalanceChanges, fixtureExchanges } from './support/fixtures';

/**
 * `GET /v2/accounts/:address/stats/:family` on a real ClickHouse, seeded with the 54 ledgers of the original Ripple test
 * suite (`ripple-mock`: 2268 `account_transactions` of 300 accounts and 2321 balance changes of 283, on seven days
 * between 2013 and 2017), with synthetic ledgers whose every number is worked out by hand, and with the Xahau ledgers
 * recorded from a public node.
 *
 * Ported from rippled-historical-database `test/test.account.stats.js`: all 9 `it`s with their titles, none skipped.
 * The original ran against two HBase tables that an outside job filled (`agg_account_stats`,
 * `agg_account_balance_changes`) from the mock files `account-stats-tx.json` and `account-stats-value.json`: twenty
 * consecutive days of one account (`r3fRiC42…`), 15 of them in the window of the first test. Those rows are not in the
 * ledgers (the account has one payment in them), so what the ported tests assert is what holds of the rows of the
 * ledgers instead, and these values of the mock files are NOT asserted: the 15 and 20 rows (the mock files had a row
 * for each of 20 days; here a day has a row when the account was active, and an account of the mock ledgers has two to
 * four), and every number in them (`transaction_count`, `account_value`, `balance_change_count`). What is kept is the
 * shape each row has (an object for `type` and `result`, a string `account_value`, a number `balance_change_count`),
 * `date >= start` and `date < end`, the descending order, the Link header and the paging with `limit=1`
 * (`utils.checkPagination`), and the three errors.
 *
 * Added:
 *  - an oracle, written from the rows the syncer stores, for every account of the mock ledgers: the transactions the
 *    account SENT (`is_initiator`, as the documentation of the original says) per UTC day with their result and type
 *    counts, and its value per day (exact decimal arithmetic, carried balances, rates of the day for the issued
 *    currencies it holds);
 *  - the window of the original (`end` is the instant the scan stops before, not a period; a start less than a day from
 *    the end is cut back to its day) and the order of its checks;
 *  - the shared list behaviour (empty range, marker pages, descending, unknown params, repeated params, limits) and CSV;
 *  - the tables a request reads and their plan, rows that were written twice, the failure paths;
 *  - synthetic ledgers: UTC day boundaries, a fee-only day, balances carried from before the window and across days,
 *    an issued currency at the rate of each day (and none), what the account owes, a gap of more than ten years;
 *  - Xahau, where the native currency is XAH.
 */

const TRADER = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg'; // sent 106 of the 108 transactions that touch it, on 2015-01-14 and 2015-02-09
const MULTI = 'rwvLbHQtU16BwQJyrQb9cfFKvx13Ksbkja'; // sent 23 EUR and received 36 CNY on 2015-01-14: 23 of its 59 transactions are its own
const GATEWAY = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q'; // an issuer: 87 of its balances are negative
const KIC = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y'; // the issuer of CNY: 217 transactions touch it, it sent none
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';
const TWO_VALUE = 'rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj'; // changes of balances on 2015-01-14 and 2015-02-09
const THREE_TX = 'rBZgggUbdV7wHF1d7BRu1BLsxQqKHX3SN4'; // sent transactions on 2015-01-14, 2015-02-09 and 2016-03-28
const FEE_CARRY = 'rfCFLzNJYvvnoGHWQYACmJpTgkLUaugLEw'; // sent on 2015-01-14 and 2016-03-28; the 14th is only fees

const DAY_MS = 86_400_000;
const NATIVE = 'XRP';

/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

const path = (account: string, family = 'transactions'): string => `/v2/accounts/${account}/stats/${family}`;

/** The marker of the page that ends with a day: the base64url of the JSON array of the day. */
const markerOf = (day: string): string => Buffer.from(JSON.stringify([day]), 'utf8').toString('base64url');

const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

interface TxRow {
  date: string;
  transaction_count: number;
  result: Record<string, number>;
  type: Record<string, number>;
}
interface ValueRow {
  date: string;
  account_value: string;
  balance_change_count: number;
}
interface Body<R> {
  result: string;
  count: number;
  marker?: string;
  rows: R[];
}

const sortedByKey = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---------------------------------------------------------------------------------------------------------------------
// The oracles: the rows the syncer stores, grouped by hand
// ---------------------------------------------------------------------------------------------------------------------

/** The transactions an account sent, a row per UTC day with their results and types. */
function expectedTransactions(rows: AccountTransactionsRow[]): TxRow[] {
  const days = new Map<string, TxRow>();
  for (const r of rows) {
    if (!r.is_initiator) continue;
    const day = dayOf(r.close_time);
    const row = days.get(day) ?? { date: `${day}T00:00:00Z`, transaction_count: 0, result: {}, type: {} };
    row.transaction_count++;
    row.result[r.result] = (row.result[r.result] ?? 0) + 1;
    row.type[r.tx_type] = (row.type[r.tx_type] ?? 0) + 1;
    days.set(day, row);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, row]) => ({ ...row, result: sortedByKey(row.result), type: sortedByKey(row.type) }));
}

/** Units of an issued currency per native coin on a day (see `rateOf` of the mock oracle below). */
type RateOf = (currency: string, issuer: string, day: string) => BigNumber;

interface Key {
  ledger_index: number;
  tx_index: number;
  node_index: number;
}
const byKey = (a: Key, b: Key): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;

/**
 * The value of an account per UTC day, from its balance changes in the order of their keys: a row for each day with a
 * change besides the fee, the sum of what it holds then (the native balance; each issued currency over the rate of the
 * day; what is owed is not held), and the number of those changes.
 */
function expectedValue(rows: BalanceChangesRow[], rateOf: RateOf): { date: string; value: BigNumber; count: number }[] {
  const byDay = new Map<string, BalanceChangesRow[]>();
  for (const r of rows) byDay.set(dayOf(r.close_time), [...(byDay.get(dayOf(r.close_time)) ?? []), r]);
  const lines = new Map<string, BigNumber>();
  const out: { date: string; value: BigNumber; count: number }[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayRows = byDay.get(day) as BalanceChangesRow[];
    for (const r of dayRows) lines.set(`${r.currency}|${r.counterparty}`, new BigNumber(r.final_balance));
    const count = dayRows.filter((r) => r.change_type !== 'transaction_cost').length;
    if (count === 0) continue;
    let value = new BigNumber(0);
    for (const [line, balance] of lines) {
      if (!balance.gt(0)) continue;
      const [currency, issuer] = line.split('|');
      if (issuer === '') value = value.plus(balance);
      else {
        const rate = rateOf(currency, issuer, day);
        if (rate.gt(0)) value = value.plus(balance.dividedBy(rate));
      }
    }
    out.push({ date: `${day}T00:00:00Z`, value, count });
  }
  return out;
}

/** A value of the endpoint is the oracle's to a relative 1e-12 (the oracle divides with 20 places, the endpoint keeps 17 digits). */
function expectValue(row: ValueRow, expected: { date: string; value: BigNumber; count: number }): void {
  expect(row.date).toBe(expected.date);
  expect(row.balance_change_count).toBe(expected.count);
  expect(typeof row.account_value).toBe('string');
  const diff = new BigNumber(row.account_value).minus(expected.value).abs();
  expect([
    row.date,
    row.account_value,
    expected.value.toString(),
    diff.lte(expected.value.abs().times('1e-12')),
  ]).toEqual([row.date, row.account_value, expected.value.toString(), true]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The mock ledgers
// ---------------------------------------------------------------------------------------------------------------------

const TX_ROWS = fixtureAccountTransactions('ripple-mock');
const BC_ROWS = [...fixtureBalanceChanges('ripple-mock')].sort(
  (a, b) => byKey(a, b) || (a.account < b.account ? -1 : 1),
);
const EXCHANGES = fixtureExchanges('ripple-mock').map((e) => e.row);

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}
const txOf = groupBy(TX_ROWS, (r) => r.account);
const bcOf = groupBy(BC_ROWS, (r) => r.account);
const sentOf = (account: string): TxRow[] => expectedTransactions(txOf.get(account) ?? []);

/**
 * Units of an issued currency per native coin on a day: the volume weighted average price of its trades against the
 * native currency that day, 0 when there are fewer than 10 (strict). In the mock ledgers every pair with 10 trades or
 * more has them all on one day, and no balance is changed within 14 days after it (the "latest 50 trades" of a later
 * day would still reach it): both are checked by the first `it` below.
 */
const mockRate: RateOf = (currency, issuer, day) => {
  const trades = EXCHANGES.filter(
    (e) =>
      e.base_currency === currency &&
      e.base_issuer === issuer &&
      e.counter_currency === NATIVE &&
      e.counter_amount_f > 0.0005 &&
      dayOf(e.close_time) === day,
  );
  if (trades.length < 10) return new BigNumber(0);
  const base = trades.reduce((total, e) => total.plus(e.base_amount), new BigNumber(0));
  const counter = trades.reduce((total, e) => total.plus(e.counter_amount), new BigNumber(0));
  return counter.isZero() ? new BigNumber(0) : base.dividedBy(counter);
};
const valueOf = (account: string): ReturnType<typeof expectedValue> => expectedValue(bcOf.get(account) ?? [], mockRate);

const MOCK_ACCOUNTS = [...new Set([...TX_ROWS.map((r) => r.account), ...BC_ROWS.map((r) => r.account)])];

// ---------------------------------------------------------------------------------------------------------------------

describe('account stats API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <R>(p: string, limit: number): Promise<Body<R>[]> => api.pages<Body<R>>(p, limit, 'rows');

  beforeAll(async () => {
    h = await startHarness({
      seed: 'ripple-mock',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  // the rates computed on read are kept for a minute: a test that counts the reads of the trades starts without them
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  /** The queries the harness's ClickHouse service ran while `fn` ran. */
  async function queriesOf(fn: () => Promise<unknown>): Promise<{ sql: string; params: Record<string, unknown> }[]> {
    const spy = jest.spyOn(h.ch, 'query');
    await fn();
    const calls = spy.mock.calls.map(([sql, params]) => ({
      sql: String(sql),
      params: (params ?? {}) as Record<string, unknown>,
    }));
    spy.mockRestore();
    return calls;
  }

  it('the mock ledgers are what the oracles assume: the pairs with 10 trades or more are on one day, with no balance change within 14 days after it', () => {
    const traded = new Map<string, { days: Set<string>; trades: number }>();
    for (const e of EXCHANGES) {
      if (e.counter_currency !== NATIVE) continue;
      const key = `${e.base_currency}.${e.base_issuer}`;
      const pair = traded.get(key) ?? { days: new Set<string>(), trades: 0 };
      pair.days.add(dayOf(e.close_time));
      pair.trades++;
      traded.set(key, pair);
    }
    const rated = [...traded.entries()].filter(([, pair]) => pair.trades >= 10);
    expect(rated.map(([key]) => key)).toEqual([`CNY.${KIC}`]);
    expect([...rated[0][1].days]).toEqual(['2015-01-14']);
    for (const r of BC_ROWS) {
      const days = (Date.parse(dayOf(r.close_time)) - Date.parse('2015-01-14')) / DAY_MS;
      expect(days <= 0 || days > 14).toBe(true);
    }
    // 300 accounts in account_transactions, 283 in balance_changes; seven days
    expect(new Set(TX_ROWS.map((r) => r.account)).size).toBe(300);
    expect(new Set(BC_ROWS.map((r) => r.account)).size).toBe(283);
    expect(new Set(BC_ROWS.map((r) => dayOf(r.close_time)))).toEqual(
      new Set(['2013-06-11', '2013-10-25', '2015-01-14', '2015-02-09', '2016-03-28', '2017-04-18', '2017-05-12']),
    );
  });

  // -- test.account.stats.js ----------------------------------------------------------------------------------------

  it('should get transaction stats by date range', async () => {
    const start = Date.parse('2015-01-01T00:00:00Z');
    const end = Date.parse('2015-02-10T00:00:00Z');
    const res = await get(
      `${path(TRADER, 'transactions')}${qs({ start: '2015-01-01T00:00:00Z', end: '2015-02-10T00:00:00Z' })}`,
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.rows.length).toBe(res.body.count);
    expect(res.body.rows.length).toBe(2); // the original: 15 days of the mock file; here the days the account was active
    for (const r of (res.body as Body<TxRow>).rows) {
      expect(typeof r.type).toBe('object');
      expect(typeof r.result).toBe('object');
      expect(start - Date.parse(r.date)).toBeLessThanOrEqual(0);
      expect(end - Date.parse(r.date)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should get transaction stats in descending order', async () => {
    const res = await get(`${path(TRADER, 'transactions')}?descending=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.rows.length).toBe(res.body.count);
    expect(res.body.rows.length).toBe(2); // the original: 20 days of the mock file
    let date: number | undefined;
    for (const r of (res.body as Body<TxRow>).rows) {
      if (date !== undefined) expect(date - Date.parse(r.date)).toBeGreaterThan(0);
      date = Date.parse(r.date);
    }
  });

  it('should get value stats by date range', async () => {
    const start = Date.parse('2015-01-01T00:00:00Z');
    const end = Date.parse('2015-02-10T00:00:00Z');
    const res = await get(
      `${path(TWO_VALUE, 'value')}${qs({ start: '2015-01-01T00:00:00Z', end: '2015-02-10T00:00:00Z' })}`,
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.rows.length).toBe(res.body.count);
    expect(res.body.rows.length).toBe(2); // the original: 15 days of the mock file
    for (const r of (res.body as Body<ValueRow>).rows) {
      expect(typeof r.account_value).toBe('string');
      expect(typeof r.balance_change_count).toBe('number');
      expect(start - Date.parse(r.date)).toBeLessThanOrEqual(0);
      expect(end - Date.parse(r.date)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should get value stats in descending order', async () => {
    const res = await get(`${path(TWO_VALUE, 'value')}?descending=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.rows.length).toBe(res.body.count);
    expect(res.body.rows.length).toBe(2); // the original: 20 days of the mock file
    let date: number | undefined;
    for (const r of (res.body as Body<ValueRow>).rows) {
      if (date !== undefined) expect(date - Date.parse(r.date)).toBeGreaterThan(0);
      date = Date.parse(r.date);
    }
  });

  it('should include a link header when marker is present', async () => {
    // the original compared the whole header, with the HBase row key `<account>|20150106000000` as the marker; the
    // marker of this API is the day of the last row of the page
    const url = `${path(TRADER, 'transactions')}?limit=1`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(markerOf('2015-01-14'));
    expect(res.headers.link).toBe(`<${new URL(res.request.url).origin}${url}&marker=${res.body.marker}>; rel="next"`);
  });

  it('should handle pagination correctly', async () => {
    // utils.checkPagination: the unpaged list has more than one row, then limit=1 walks it a row at a time
    for (const family of ['transactions', 'value']) {
      const url = path(family === 'transactions' ? TRADER : TWO_VALUE, family);
      const ref = await get(url);
      expect(ref.body.count).toBeGreaterThan(1);
      let marker: string | undefined;
      for (let i = 0; i < ref.body.count; i++) {
        const res = await get(`${url}?limit=1${marker ? `&marker=${marker}` : ''}`);
        expect(res.status).toBe(200);
        expect(res.body.result).toBe('success');
        expect(res.body.rows.length).toBe(1);
        expect(res.body.rows[0].date).toBe(ref.body.rows[i].date);
        if (family === 'transactions') {
          expect(res.body.rows[0].transaction_count).toBe(ref.body.rows[i].transaction_count);
        } else {
          expect(res.body.rows[0].account_value).toBe(ref.body.rows[i].account_value);
        }
        marker = res.body.marker;
      }
      expect(marker).toBeUndefined();
    }
  });

  it('should error on invalid family', async () => {
    const res = await get(`/v2/accounts/${TRADER}/stats/foo`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid family');
  });

  it('should error on invalid start date', async () => {
    const res = await get(`${path(TRADER)}?start=x2015-01-14T00:00&end=2015-01-14T00:00`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should error on invalid end date', async () => {
    const res = await get(`${path(TRADER)}?start=2015-01-14T00:00&end=x2015-01-14T00:00`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  // -- stats/transactions -------------------------------------------------------------------------------------------

  describe('stats/transactions', () => {
    it('is, for every account of the ledgers, a row per day with the transactions it sent and their results and types', async () => {
      expect(MOCK_ACCOUNTS.length).toBe(300);
      let withRows = 0;
      let rows = 0;
      for (const account of MOCK_ACCOUNTS) {
        const res = await get(`${path(account)}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expect([account, res.body.rows]).toEqual([account, sentOf(account)]);
        expect(res.body.count).toBe(sentOf(account).length);
        withRows += res.body.count > 0 ? 1 : 0;
        rows += res.body.count;
      }
      expect(withRows).toBeGreaterThan(30);
      expect(rows).toBeGreaterThan(60);
    });

    it('counts the transactions the account sent, not those that only touch it', async () => {
      // 59 transactions affect it: 23 sent EUR, 36 received CNY
      expect((txOf.get(MULTI) ?? []).length).toBe(59);
      const res = await get(path(MULTI));
      expect(res.body.rows).toEqual([
        {
          date: '2015-01-14T00:00:00Z',
          transaction_count: 23,
          result: { tesSUCCESS: 23 },
          type: { Payment: 23 },
        },
      ]);
      // the issuer of CNY: 217 transactions touch it, it sent none
      expect((txOf.get(KIC) ?? []).length).toBe(217);
      expect(await get(path(KIC)).then((r) => r.body)).toEqual({ result: 'success', count: 0, rows: [] });
    });

    it('counts a transaction that failed with a tec code by its code', async () => {
      const failed = TX_ROWS.filter((r) => r.is_initiator && r.result.startsWith('tec'));
      expect(failed.length).toBeGreaterThan(10);
      const accounts = [...new Set(failed.map((r) => r.account))];
      for (const account of accounts) {
        const res = await get(path(account));
        const codes = new Set(res.body.rows.flatMap((r: TxRow) => Object.keys(r.result)));
        for (const code of new Set(failed.filter((r) => r.account === account).map((r) => r.result))) {
          expect([account, code, codes.has(code)]).toEqual([account, code, true]);
        }
        for (const r of res.body.rows as TxRow[]) {
          const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
          expect([sum(r.result), sum(r.type)]).toEqual([r.transaction_count, r.transaction_count]);
        }
      }
    });

    it('has the fields of the original in its order, and the keys of result and type sorted', async () => {
      const res = await get(path(TRADER));
      expect(res.body.rows.length).toBeGreaterThan(0);
      for (const r of res.body.rows as TxRow[]) {
        expect(Object.keys(r)).toEqual(['date', 'transaction_count', 'result', 'type']);
        expect(r.date).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
        expect(typeof r.transaction_count).toBe('number');
        expect(Object.keys(r.type)).toEqual([...Object.keys(r.type)].sort());
        expect(Object.keys(r.result)).toEqual([...Object.keys(r.result)].sort());
      }
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'rows']);
      // 106 sent in all, on two days
      expect((res.body.rows as TxRow[]).reduce((n, r) => n + r.transaction_count, 0)).toBe(106);
      expect(Object.keys((res.body.rows as TxRow[])[0].type)).toEqual(['OfferCancel', 'OfferCreate']);
    });

    it('has no row for a day without a transaction of the account, and none for an account that never sent one', async () => {
      const res = await get(`${path(TRADER)}?start=2015-01-15&end=2015-02-09`);
      expect(res.body).toEqual({ result: 'success', count: 0, rows: [] });
      expect((await get(path(NOBODY))).body).toEqual({ result: 'success', count: 0, rows: [] });
      expect((await get(path('not an address'))).body.count).toBe(0);
    });
  });

  // -- stats/value --------------------------------------------------------------------------------------------------

  describe('stats/value', () => {
    it('is, for every account of the ledgers, a row per day with a balance change and the value of the account then', async () => {
      let rows = 0;
      let withIssued = 0;
      for (const account of MOCK_ACCOUNTS) {
        const expected = valueOf(account);
        const res = await get(`${path(account, 'value')}?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expect([account, res.body.count]).toEqual([account, expected.length]);
        (res.body.rows as ValueRow[]).forEach((row, i) => expectValue(row, expected[i]));
        rows += expected.length;
        withIssued += (bcOf.get(account) ?? []).some((r) => r.counterparty !== '') ? 1 : 0;
      }
      expect(rows).toBeGreaterThan(200);
      expect(withIssued).toBeGreaterThan(50);
    });

    it('is exactly the native balance for an account that holds only the native currency: a string, as the ledger wrote it', async () => {
      const nativeOnly = [...bcOf.entries()].filter(([, rows]) => rows.every((r) => r.counterparty === ''));
      expect(nativeOnly.length).toBeGreaterThan(150);
      for (const [account, rows] of nativeOnly) {
        const res = await get(`${path(account, 'value')}?limit=1000`);
        const expected = valueOf(account);
        expect([account, res.body.rows.map((r: ValueRow) => r.account_value)]).toEqual([
          account,
          expected.map((e) => e.value.toString()),
        ]);
        // the last change of the last active day leaves the balance (unless that day only paid the fee)
        if (expected.length > 0) {
          const day = expected[expected.length - 1].date.slice(0, 10);
          const last = rows.filter((r) => dayOf(r.close_time) <= day).pop() as BalanceChangesRow;
          expect(res.body.rows[res.body.rows.length - 1].account_value).toBe(
            new BigNumber(last.final_balance).toString(),
          );
        }
      }
    });

    it('has the fields of the original in their order: date, account_value (a string), balance_change_count (a number)', async () => {
      const res = await get(path(TWO_VALUE, 'value'));
      expect(res.body.rows).toHaveLength(2);
      for (const r of res.body.rows as ValueRow[]) {
        expect(Object.keys(r)).toEqual(['date', 'account_value', 'balance_change_count']);
        expect(r.date).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
        expect(typeof r.account_value).toBe('string');
        expect(typeof r.balance_change_count).toBe('number');
      }
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'rows']);
    });

    it('counts the changes of a day without the fee: 116 rows of the account, 106 of them fees, 10 changes', async () => {
      expect((bcOf.get(TRADER) ?? []).length).toBe(116);
      expect((bcOf.get(TRADER) ?? []).filter((r) => r.change_type === 'transaction_cost').length).toBe(106);
      const res = await get(path(TRADER, 'value'));
      expect((res.body.rows as ValueRow[]).reduce((n, r) => n + r.balance_change_count, 0)).toBe(10);
    });

    it('has no row for a day on which the account only paid the fee: it has one for its transactions, and the later balance has the fee', async () => {
      // TRADER only paid fees on 2015-02-09 (54 transactions of offers that moved no balance), 10 changes on the 14th
      const days = groupBy(bcOf.get(TRADER) ?? [], (r) => dayOf(r.close_time));
      const kinds = [...days.entries()].map(([day, rows]) => [
        day,
        rows.every((r) => r.change_type === 'transaction_cost'),
      ]);
      expect(kinds).toEqual([
        ['2015-01-14', false],
        ['2015-02-09', true],
      ]);
      expect((await get(path(TRADER, 'value'))).body.rows.map((r: ValueRow) => r.date)).toEqual([
        '2015-01-14T00:00:00Z',
      ]);
      expect((await get(path(TRADER, 'transactions'))).body.rows.map((r: TxRow) => r.date)).toEqual([
        '2015-01-14T00:00:00Z',
        '2015-02-09T00:00:00Z',
      ]);
      // and the other way round: fees on the 14th, then a change on 2016-03-28 whose value has them (and what was held)
      const carry = groupBy(bcOf.get(FEE_CARRY) ?? [], (r) => dayOf(r.close_time));
      expect(
        [...carry.entries()].map(([day, rows]) => [day, rows.every((r) => r.change_type === 'transaction_cost')]),
      ).toEqual([
        ['2015-01-14', true],
        ['2016-03-28', false],
      ]);
      const value = (await get(path(FEE_CARRY, 'value'))).body.rows as ValueRow[];
      expect(value.map((r) => r.date)).toEqual(['2016-03-28T00:00:00Z']);
      expectValue(value[0], valueOf(FEE_CARRY)[0]);
      expect((await get(path(FEE_CARRY, 'transactions'))).body.rows.map((r: TxRow) => r.date)).toEqual([
        '2015-01-14T00:00:00Z',
        '2016-03-28T00:00:00Z',
      ]);
    });

    it('does not count what the account owes: an issuer is worth its native balance', async () => {
      const rows = bcOf.get(GATEWAY) ?? [];
      expect(rows.filter((r) => r.counterparty !== '' && new BigNumber(r.final_balance).lt(0)).length).toBe(87);
      const res = await get(path(GATEWAY, 'value'));
      const native = new Map<string, string>();
      for (const r of rows) if (r.counterparty === '') native.set(dayOf(r.close_time), r.final_balance);
      expect(res.body.rows.length).toBeGreaterThan(0);
      for (const r of res.body.rows as ValueRow[]) {
        // positive holdings of the issuer are rated 0 here (no trades), so its value is its native balance
        expect(new BigNumber(r.account_value).gte(0)).toBe(true);
      }
      expect(res.body.rows.map((r: ValueRow) => r.account_value)).toEqual(
        valueOf(GATEWAY).map((e) => e.value.toString()),
      );
    });

    it('counts an issued currency at the rate of the day: 36 CNY of the issuer KIC on the day of its trades', async () => {
      const res = await get(path(MULTI, 'value'));
      expect(res.body.rows).toHaveLength(1);
      const cny = (bcOf.get(MULTI) ?? []).filter((r) => r.currency === 'CNY').pop();
      const native = (bcOf.get(MULTI) ?? []).filter((r) => r.currency === NATIVE).pop();
      expect(cny?.counterparty).toBe(KIC);
      const rate = mockRate('CNY', KIC, '2015-01-14');
      expect(rate.gt(0)).toBe(true);
      const expected = new BigNumber(native?.final_balance ?? 0).plus(
        new BigNumber(cny?.final_balance ?? 0).dividedBy(rate),
      );
      expect(new BigNumber(res.body.rows[0].account_value).minus(expected).abs().lt('1e-9')).toBe(true);
      // the value is more than the native balance alone: the CNY counts
      expect(new BigNumber(res.body.rows[0].account_value).gt(native?.final_balance ?? 0)).toBe(true);
    });
  });

  // -- the window ---------------------------------------------------------------------------------------------------

  describe('the window', () => {
    // the days of TRADER (transactions) and of TWO_VALUE (value): 2015-01-14 and 2015-02-09
    const days = (body: Body<{ date: string }>): string[] => body.rows.map((r) => r.date.slice(0, 10));
    const account = (family: string): string => (family === 'transactions' ? TRADER : TWO_VALUE);

    it('end is the instant the days stop before: end=2015-02-09 leaves that day out, a second later includes it', async () => {
      for (const family of ['transactions', 'value']) {
        const base = path(account(family), family);
        expect(days((await get(`${base}?end=2015-02-09`)).body)).toEqual(['2015-01-14']);
        expect(days((await get(`${base}?end=2015-02-09T00:00:00`)).body)).toEqual(['2015-01-14']);
        expect(days((await get(`${base}?end=2015-02-09T00:00:01`)).body)).toEqual(['2015-01-14', '2015-02-09']);
        expect(days((await get(`${base}?end=2015-02-10`)).body)).toEqual(['2015-01-14', '2015-02-09']);
        // the other routes read end=2015-01-14 as the whole day; this one does not
        expect(days((await get(`${base}?end=2015-01-14`)).body)).toEqual([]);
        expect(days((await get(`${base}?end=2015-01`)).body)).toEqual([]);
        expect(days((await get(`${base}?end=2015-02`)).body)).toEqual(['2015-01-14']);
      }
    });

    it('start is included from its midnight on: a start after the midnight of a day leaves that day out', async () => {
      for (const family of ['transactions', 'value']) {
        const base = path(account(family), family);
        expect(days((await get(`${base}?start=2015-01-14`)).body)).toEqual(['2015-01-14', '2015-02-09']);
        expect(days((await get(`${base}?start=2015-01-14T00:00:00`)).body)).toEqual(['2015-01-14', '2015-02-09']);
        expect(days((await get(`${base}?start=2015-01-14T00:00:01`)).body)).toEqual(['2015-02-09']);
        expect(days((await get(`${base}?start=2015-02-09T00:00:01`)).body)).toEqual([]);
        expect(days((await get(`${base}?start=2015-01-15&end=2015-02-09`)).body)).toEqual([]);
      }
    });

    it('a start less than a day from the end is cut back to its day', async () => {
      for (const family of ['transactions', 'value']) {
        const base = path(account(family), family);
        expect(days((await get(`${base}?start=2015-01-14T05:00:00&end=2015-01-14T20:00:00`)).body)).toEqual([
          '2015-01-14',
        ]);
        // an end before the start by less than a day is cut the same way
        expect(days((await get(`${base}?start=2015-01-14T20:00:00&end=2015-01-14T05:00:00`)).body)).toEqual([
          '2015-01-14',
        ]);
        // a day or more apart is not
        expect(days((await get(`${base}?start=2015-01-14T05:00:00&end=2015-01-15T05:00:00`)).body)).toEqual([]);
        expect(days((await get(`${base}?start=2015-01-14T05:00:00&end=2015-01-15T04:59:59`)).body)).toEqual([
          '2015-01-14',
        ]);
        // start=end at midnight: the day is not before the end
        expect(days((await get(`${base}?start=2015-01-14&end=2015-01-14`)).body)).toEqual([]);
      }
    });

    it('an end before the start is no days', async () => {
      for (const family of ['transactions', 'value']) {
        const res = await get(`${path(account(family), family)}?start=2015-03-01&end=2015-01-01`);
        expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, rows: [] }]);
      }
    });

    it('takes every format of a date the API accepts, and unix seconds', async () => {
      const unix = String(Date.parse('2015-01-14T00:00:00Z') / 1000);
      for (const start of [
        '2015-01-14',
        '2015-01-14T00:00:00Z',
        '2015-01-14T00:00:00+00:00',
        '20150114000000',
        unix,
        '2015-01',
      ]) {
        const res = await get(`${path(TRADER)}${qs({ start, end: '2015-01-15' })}`);
        expect([start, res.status, days(res.body)]).toEqual([start, 200, ['2015-01-14']]);
      }
    });

    it('a day is the UTC day: a time zone moves the instant, not the day', async () => {
      // 2015-01-14T01:00:00+02:00 is 2015-01-13T23:00:00Z
      const res = await get(
        `${path(TRADER)}${qs({ start: '2015-01-14T01:00:00+02:00', end: '2015-01-14T23:00:00+00:00' })}`,
      );
      expect(days(res.body)).toEqual(['2015-01-14']);
    });

    it('checks the start, then the end, then the family, then the marker', async () => {
      const message = async (url: string): Promise<string> => (await get(url)).body.message;
      expect(await message(`/v2/accounts/${TRADER}/stats/foo?start=nope&end=nope&marker=!!`)).toBe(
        'invalid start date format',
      );
      expect(await message(`/v2/accounts/${TRADER}/stats/foo?end=nope&marker=!!`)).toBe('invalid end date format');
      expect(await message(`/v2/accounts/${TRADER}/stats/foo?marker=!!`)).toBe('invalid family');
      expect(await message(`${path(TRADER)}?marker=!!`)).toBe('invalid marker');
      expect(await message(`${path(TRADER, 'value')}?marker=!!`)).toBe('invalid marker');
      // an empty end is not a date (the original parsed it), an empty start is the default
      expect(await message(`${path(TRADER)}?end=`)).toBe('invalid end date format');
      expect((await get(`${path(TRADER)}?start=`)).status).toBe(200);
    });

    it('only transactions and value are families, in lower case', async () => {
      for (const family of ['foo', 'Transactions', 'VALUE', 'exchanges', 'payments', '']) {
        const res = await get(`/v2/accounts/${TRADER}/stats/${family}`);
        expect([family, res.status]).toEqual([family, family === '' ? 404 : 400]);
        if (family !== '') expect(res.body).toEqual({ result: 'error', message: 'invalid family' });
      }
    });
  });

  // -- the list -----------------------------------------------------------------------------------------------------

  describe('the list', () => {
    const FAMILIES = ['transactions', 'value'] as const;
    /** An account with the most days in each family (the rows are days; the ledgers hold seven). */
    const busiest = (rowsOf: (a: string) => unknown[]): string =>
      [...MOCK_ACCOUNTS].sort((a, b) => rowsOf(b).length - rowsOf(a).length)[0];
    const MOST: Record<(typeof FAMILIES)[number], string> = {
      transactions: busiest((a) => sentOf(a)),
      value: busiest((a) => valueOf(a)),
    };

    it('the busiest accounts have several days to page through', () => {
      expect(MOST.transactions).toBe(THREE_TX);
      expect(sentOf(MOST.transactions).length).toBe(3);
      expect(valueOf(MOST.value).length).toBe(2);
    });

    it('empty range → count 0', async () => {
      for (const family of FAMILIES) {
        const res = await get(`${path(TRADER, family)}?start=2030-01-01&end=2030-12-31`);
        expect([family, res.status, res.body]).toEqual([family, 200, { result: 'success', count: 0, rows: [] }]);
        expect(res.headers.link).toBeUndefined();
        expect((await get(`${path(TRADER, family)}?end=2013-06-01`)).body.count).toBe(0);
        expect(
          (await get(`${path(TRADER, family)}?start=2030-01-01&marker=${markerOf('2015-01-14')}`)).body.count,
        ).toBe(0);
      }
    });

    it('marker pages concatenate to unpaged list', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const unpaged = await get(`${base}?limit=1000`);
        expect(unpaged.body.count).toBeGreaterThanOrEqual(2);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();
        for (const limit of [1, 2, 3]) {
          const paged = await pages<TxRow | ValueRow>(base, limit);
          expect(paged).toHaveLength(Math.ceil(unpaged.body.count / limit));
          expect(paged.slice(0, -1).every((p) => p.count === limit && p.marker !== undefined)).toBe(true);
          expect(paged[paged.length - 1].marker).toBeUndefined();
          expect([family, limit, paged.flatMap((p) => p.rows)]).toEqual([family, limit, unpaged.body.rows]);
        }
      }
    });

    it('marker pages of every account concatenate to its unpaged list', async () => {
      for (const family of FAMILIES) {
        let walked = 0;
        for (const account of MOCK_ACCOUNTS) {
          const rows = family === 'transactions' ? sentOf(account) : valueOf(account);
          if (rows.length < 2) continue;
          const paged = await pages<TxRow | ValueRow>(path(account, family), 1);
          expect([family, account, paged.map((p) => p.rows[0].date)]).toEqual([
            family,
            account,
            (family === 'transactions' ? sentOf(account) : valueOf(account)).map((r) => r.date),
          ]);
          walked++;
        }
        expect(walked).toBeGreaterThanOrEqual(family === 'transactions' ? 10 : 5);
      }
    });

    it('descending reverses order', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const asc = await get(`${base}?limit=1000`);
        const desc = await get(`${base}?limit=1000&descending=true`);
        expect([family, desc.body.rows]).toEqual([family, [...asc.body.rows].reverse()]);
        for (const limit of [1, 2]) {
          const walked = await pages<TxRow | ValueRow>(`${base}?descending=true`, limit);
          expect([family, limit, walked.flatMap((p) => p.rows)]).toEqual([family, limit, desc.body.rows]);
        }
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const asc = await get(`${base}?limit=2`);
        for (const flag of ['false', '1', '0', '']) {
          expect((await get(`${base}?limit=2&descending=${flag}`)).body).toEqual(asc.body);
        }
        const desc = await get(`${base}?limit=2&descending=true`);
        expect((await get(`${base}?limit=2&descending=TRUE`)).body).toEqual(desc.body);
        expect(desc.body.rows.map((r: { date: string }) => r.date)).toEqual(
          (family === 'transactions' ? sentOf(MOST[family]) : valueOf(MOST[family]))
            .map((r) => r.date)
            .slice(-2)
            .reverse(),
        );
      }
    });

    it('unknown params ignored', async () => {
      for (const family of FAMILIES) {
        const plain = await get(`${path(TRADER, family)}?limit=5`);
        const res = await get(`${path(TRADER, family)}?limit=5&foo=bar&granularity=day&reduce=true&autobridged=true`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(plain.body);
      }
    });

    it('a repeated param: the first value wins', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const res = await get(`${base}?limit=1&limit=50&descending=true&descending=false&start=2013-01-01&start=nope`);
        expect(res.body.count).toBe(1);
        const all = (family === 'transactions' ? sentOf(MOST[family]) : valueOf(MOST[family])).map((r) => r.date);
        expect(res.body.rows[0].date).toBe(all[all.length - 1]);
      }
    });

    it('limit is 200 by default, at most 1000; below one or not a number it is the default (no "invalid limit")', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const all = await get(`${base}?limit=1000`);
        for (const limit of ['0', '-3', 'x', '', '0.5', '5000', '1000.9']) {
          const res = await get(`${base}?limit=${limit}`);
          expect([family, limit, res.status, res.body]).toEqual([family, limit, 200, all.body]);
        }
        expect((await get(`${base}?limit=1.9`)).body.count).toBe(1);
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const total = (await get(`${base}?limit=1000`)).body.count;
        const exact = await get(`${base}?limit=${total}`);
        expect(exact.body.count).toBe(total);
        expect(exact.body.marker).toBeUndefined();
        expect(exact.headers.link).toBeUndefined();
        const more = await get(`${base}?limit=${total - 1}`);
        expect(more.body.marker).toBe(markerOf(more.body.rows[more.body.rows.length - 1].date.slice(0, 10)));
        expect(more.headers.link).toContain(`marker=${more.body.marker}`);
      }
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const base = path(MOST.transactions);
      const first = await get(`${base}${qs({ limit: 1, start: '2013-01-01T00:00:00+00:00', foo: 'bar' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}${base}?limit=1&start=2013-01-01T00:00:00%2B00:00&foo=bar&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`${base}?limit=1&marker=${first.body.marker}&descending=false`);
      expect(second.headers.link).toBe(
        `<${origin}${base}?limit=1&marker=${second.body.marker}&descending=false>; rel="next"`,
      );
    });

    it('a marker continues strictly after its day, whichever way the list goes', async () => {
      for (const family of FAMILIES) {
        const base = path(MOST[family], family);
        const days = (await get(`${base}?limit=1000`)).body.rows.map((r: { date: string }) =>
          r.date.slice(0, 10),
        ) as string[];
        const middle = days[1];
        const asc = await get(`${base}?marker=${markerOf(middle)}`);
        expect(asc.body.rows.map((r: { date: string }) => r.date.slice(0, 10))).toEqual(days.slice(2));
        const desc = await get(`${base}?descending=true&marker=${markerOf(middle)}`);
        expect(desc.body.rows.map((r: { date: string }) => r.date.slice(0, 10))).toEqual(days.slice(0, 1));
        // a day with no row is a marker too: the rows after it
        expect((await get(`${base}?marker=${markerOf('2000-01-01')}`)).body.rows.length).toBe(days.length);
        expect((await get(`${base}?marker=${markerOf('2099-01-01')}`)).body.rows.length).toBe(0);
      }
    });

    it('a marker that is none of ours → 400 invalid marker, also for an empty list', async () => {
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
      for (const family of FAMILIES) {
        for (const account of [TRADER, NOBODY]) {
          for (const marker of [
            '!!!',
            'e30',
            encode(['2015-02-30']),
            encode(['2015-01-14', 1]),
            encode('2015-01-14'),
            encode([20150114]),
          ]) {
            const res = await get(`${path(account, family)}?marker=${marker}`);
            expect([family, account, marker, res.status, res.body]).toEqual([
              family,
              account,
              marker,
              400,
              { result: 'error', message: 'invalid marker' },
            ]);
          }
        }
      }
    });

    it('an empty marker is the first page', async () => {
      for (const family of FAMILIES) {
        const plain = await get(`${path(TRADER, family)}?limit=1`);
        expect((await get(`${path(TRADER, family)}?limit=1&marker=`)).body).toEqual(plain.body);
      }
    });
  });

  // -- format=csv ---------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('transactions → text/csv, one row per day, result and type flattened into columns', async () => {
      const rows = sentOf(TRADER);
      const res = await get(`${path(TRADER)}?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(lines(res.text)).toHaveLength(1 + rows.length);
      const header = lines(res.text)[0]
        .split(',')
        .map((c) => c.replace(/"/g, ''));
      expect(header.slice(0, 2)).toEqual(['date', 'transaction_count']);
      expect(header).toEqual(
        expect.arrayContaining(['result.tesSUCCESS', ...Object.keys(rows[0].type).map((t) => `type.${t}`)]),
      );
      expect(lines(res.text)[1]).toContain('"2015-01-14T00:00:00Z"');
    });

    it('value → text/csv with date, account_value, balance_change_count', async () => {
      const expected = valueOf(TRADER);
      const res = await get(`${path(TRADER, 'value')}?format=csv`);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(lines(res.text)).toHaveLength(1 + expected.length);
      expect(lines(res.text)[0]).toBe('"date","account_value","balance_change_count"');
      const body = (await get(path(TRADER, 'value'))).body.rows as ValueRow[];
      expect(lines(res.text)[1]).toBe(`"${body[0].date}","${body[0].account_value}","${body[0].balance_change_count}"`);
    });

    it('is named <address> - stats.<family>', async () => {
      for (const family of ['transactions', 'value']) {
        const res = await get(`${path(TRADER, family)}?format=csv`);
        expect(res.headers['content-disposition']).toBe(csvDisposition(`${TRADER} - stats.${family}`));
      }
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`${path(TRADER)}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${path(TRADER)}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and honours limit and descending', async () => {
      for (const [family, account] of [
        ['transactions', TRADER],
        ['value', TWO_VALUE],
      ]) {
        const csv = await get(`${path(account, family)}?format=csv&limit=1`);
        const json = await get(`${path(account, family)}?limit=1`);
        expect(json.body.marker).toBeDefined();
        expect(csv.headers.link).toBe(
          `<${new URL(csv.request.url).origin}${path(account, family)}?format=csv&limit=1&marker=${json.body.marker}>; rel="next"`,
        );
        expect(lines(csv.text)).toHaveLength(1 + 1);
        expect((await get(`${path(account, family)}?format=csv&limit=1000`)).headers.link).toBeUndefined();
        const desc = await get(`${path(account, family)}?format=csv&descending=true`);
        const jsonDesc = await get(`${path(account, family)}?descending=true`);
        expect(lines(desc.text)[1]).toContain(`"${jsonDesc.body.rows[0].date}"`);
        expect(jsonDesc.body.rows[0].date).toBe('2015-02-09T00:00:00Z');
      }
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      for (const family of ['transactions', 'value']) {
        const empty = await get(`${path(TRADER, family)}?format=csv&start=2030-01-01`);
        expect(empty.status).toBe(200);
        expect(empty.headers['content-type']).toMatch(/^text\/csv/);
        expect(empty.text).toBe('');
        const bad = await get(`${path(TRADER, family)}?format=csv&start=nope`);
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ result: 'error', message: 'invalid start date format' });
      }
      const family = await get(`/v2/accounts/${TRADER}/stats/foo?format=csv`);
      expect([family.status, family.body.message]).toEqual([400, 'invalid family']);
    });
  });

  // -- what is read -------------------------------------------------------------------------------------------------

  describe('the tables a request reads', () => {
    const of = (calls: { sql: string; params: Record<string, unknown> }[], table: Table) =>
      calls.filter((c) => c.sql.includes(`FROM ${table}`));
    /** The ledgers of the day 2015-01-14 are the whole range the TRADER has between 2015-01-01 and 2015-02-01. */
    const WINDOW = '?start=2015-01-01&end=2015-02-01';

    it('transactions reads account_transactions only, by a range of ledgers found once, with every value bound', async () => {
      const calls = await queriesOf(() => api.ok(`${path(TRADER)}${WINDOW}`, 'rows'));
      const reads = of(calls, Table.AccountTransactions);
      expect(reads).toHaveLength(1);
      const [{ sql, params }] = reads;
      expect(sql).toContain('account = {account:String}');
      expect(sql).toContain('ledger_index BETWEEN {min:UInt32} AND {max:UInt32}');
      expect(sql).toContain('is_initiator = 1');
      expect(sql).toContain('LIMIT 1 BY ledger_index, tx_index');
      expect(sql).toContain('ORDER BY account, ledger_index, tx_index');
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(sql).not.toContain(TRADER);
      expect(params).toMatchObject({ account: TRADER, fetch: 201 });
      expect(params.min).toBeLessThanOrEqual(params.max as number);
      for (const table of [Table.Transactions, Table.Payments, Table.BalanceChanges, Table.Exchanges]) {
        expect(of(calls, table)).toHaveLength(0);
      }
    });

    it('value reads balance_changes twice (the days, then the balances) and no exchanges for a native-only account', async () => {
      const [NATIVE_ONLY] = [...bcOf.entries()].find(
        ([account, rows]) =>
          rows.every((r) => r.counterparty === '') && valueOf(account).some((v) => v.date === '2015-01-14T00:00:00Z'),
      ) as [string, BalanceChangesRow[]];
      const calls = await queriesOf(() => api.ok(`${path(NATIVE_ONLY, 'value')}${WINDOW}`, 'rows'));
      const reads = of(calls, Table.BalanceChanges);
      expect(reads).toHaveLength(2);
      const [days, balances] = reads;
      expect(days.sql).toContain("change_type != 'transaction_cost'");
      expect(days.sql).toContain('LIMIT 1 BY ledger_index, tx_index, node_index');
      expect(days.sql).toContain('ORDER BY account, ledger_index, tx_index, node_index');
      expect(balances.sql).toContain('argMax(final_balance, (ledger_index, tx_index, node_index))');
      expect(balances.sql).not.toContain('final_balance_f');
      for (const { sql, params } of reads) {
        expect(sql).toContain('account = {account:String}');
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).not.toContain(NATIVE_ONLY);
        expect(params).toMatchObject({ account: NATIVE_ONLY });
      }
      expect(of(calls, Table.Exchanges)).toHaveLength(0);
      expect(of(calls, Table.AccountTransactions)).toHaveLength(0);
    });

    it('value asks for the rates of the issued currencies the account holds, and only those', async () => {
      const held = await queriesOf(() => api.ok(`${path(MULTI, 'value')}${WINDOW}`, 'rows'));
      const values = of(held, Table.Exchanges).flatMap((c) =>
        Object.values(c.params).filter((v) => typeof v === 'string'),
      );
      expect(values).toContain(KIC);
      // an issuer holds nothing issued by others that it has a rate for: its own debts are not rated
      const owed = await queriesOf(() => api.ok(`${path(GATEWAY, 'value')}?start=2015-02-01&end=2015-03-01`, 'rows'));
      const owedValues = of(owed, Table.Exchanges).flatMap((c) =>
        Object.values(c.params).filter((v) => typeof v === 'string'),
      );
      expect(owedValues).not.toContain(GATEWAY);
    });

    it('a request that is wrong, or that has no day in it, reads no table of the account', async () => {
      const bad = await queriesOf(async () => {
        await get(`${path(TRADER)}?start=nope`);
        await get(`/v2/accounts/${TRADER}/stats/foo`);
        await get(`${path(TRADER, 'value')}?marker=!!`);
      });
      expect(bad).toHaveLength(0);
      const empty = await queriesOf(async () => {
        await get(`${path(TRADER)}?start=2015-03-01&end=2015-01-01`);
        await get(`${path(TRADER, 'value')}?start=2015-03-01&end=2015-01-01`);
      });
      expect(empty).toHaveLength(0);
      const none = await queriesOf(() => get(`${path(TRADER, 'value')}?start=2030-01-01&end=2031-01-01`));
      expect(none.some((c) => c.sql.includes(Table.BalanceChanges))).toBe(false);
    });

    it('read through the primary key of the account, in the order of the key, with no sort of the rows', async () => {
      const explain = async (what: string, sql: string, params: Record<string, unknown>): Promise<string> =>
        (await h.ch.query<{ explain: string }>(`${what} ${sql}`, params)).map((r) => r.explain).join('\n');
      /** The read under `LIMIT 1 BY` of a query: it has no sort, that is all the dedupe needs. */
      const inner = (sql: string): string =>
        /FROM \(\s*(SELECT[\s\S]*?LIMIT 1 BY [a-z_, ]+)\s*\)/.exec(sql)?.[1] ?? sql;

      for (const descending of [false, true]) {
        const variants = ['', '&limit=1', `&marker=${markerOf('2015-01-14')}`, '&start=2015-01-14&end=2015-02-01'];
        for (const variant of variants) {
          for (const family of ['transactions', 'value']) {
            const calls = await queriesOf(() =>
              api.ok(`${path(TRADER, family)}?descending=${descending}${variant}`, 'rows'),
            );
            const reads = calls.filter((c) => /FROM (account_transactions|balance_changes)\b/.test(c.sql));
            expect(reads.length).toBeGreaterThanOrEqual(1);
            for (const { sql, params } of reads) {
              const read = inner(sql);
              if (sql.includes('LIMIT 1 BY')) {
                // the rows are read in the order of the key and not sorted
                const pipeline = await explain('EXPLAIN PIPELINE', read, params);
                expect([family, descending, variant, pipeline.includes('ReadPoolInOrder')]).toEqual([
                  family,
                  descending,
                  variant,
                  true,
                ]);
                expect(pipeline).not.toContain('PartialSortingTransform');
                expect(pipeline).not.toContain('MergeSortingTransform');
              }
              // the account is found through the primary key, not by reading every account
              const indexes = await explain('EXPLAIN indexes = 1', read, params);
              expect(indexes).toContain('PrimaryKey');
              expect(indexes).toMatch(/Keys:\s+account/);
            }
          }
        }
      }
    });

    it('spells out the whole key in the ORDER BY of the dedupe', async () => {
      const tx = (await queriesOf(() => api.ok(path(TRADER), 'rows'))).find((c) =>
        c.sql.includes(Table.AccountTransactions),
      );
      expect(tx?.sql).toMatch(/ORDER BY account, ledger_index, tx_index\s+LIMIT 1 BY ledger_index, tx_index/);
      const value = (await queriesOf(() => api.ok(path(TRADER, 'value'), 'rows'))).find((c) =>
        c.sql.includes('LIMIT 1 BY'),
      );
      expect(value?.sql).toMatch(
        /ORDER BY account, ledger_index, tx_index, node_index\s+LIMIT 1 BY ledger_index, tx_index, node_index/,
      );
    });
  });

  // -- failures -----------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    // the original answered every failure with the message of the route it was copied from
    const FAILURE = { result: 'error', message: 'unable to retrieve exchanges' };

    it('is 500 unable to retrieve exchanges (the message of the original), for both families', async () => {
      for (const family of ['transactions', 'value']) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const res = await get(path(TRADER, family));
        expect([family, res.status, res.body]).toEqual([family, 500, FAILURE]);
      }
    });

    it('also when a later query fails, after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      for (const [family, table] of [
        ['transactions', Table.AccountTransactions],
        ['value', Table.BalanceChanges],
      ] as const) {
        jest
          .spyOn(h.ch, 'query')
          .mockImplementation(((sql: string, ...rest: unknown[]) =>
            sql.includes(table)
              ? Promise.reject(new Error('boom'))
              : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as typeof h.ch.query);
        const res = await get(path(TRADER, family));
        expect([family, res.status, res.body]).toEqual([family, 500, FAILURE]);
        jest.restoreAllMocks();
      }
    });

    it('also when the rates fail', async () => {
      const real = h.ch.query.bind(h.ch);
      jest
        .spyOn(h.ch, 'query')
        .mockImplementation(((sql: string, ...rest: unknown[]) =>
          sql.includes(`FROM ${Table.Exchanges}`)
            ? Promise.reject(new Error('boom'))
            : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as typeof h.ch.query);
      const res = await get(path(MULTI, 'value'));
      expect([res.status, res.body]).toEqual([500, FAILURE]);
      // an account with no issued currency needs none
      const [native] = [...bcOf.entries()].find(
        ([account, rows]) => rows.every((r) => r.counterparty === '') && valueOf(account).length > 0,
      ) as [string, BalanceChangesRow[]];
      expect((await get(path(native, 'value'))).status).toBe(200);
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${path(TRADER)}?start=x`)).status).toBe(400);
      expect((await get(`${path(TRADER)}?end=x`)).status).toBe(400);
      expect((await get(`/v2/accounts/${TRADER}/stats/foo`)).status).toBe(400);
      expect((await get(`${path(TRADER)}?marker=!!!`)).status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account stats API endpoint when rows were written twice', () => {
  // `account_transactions` and `balance_changes` are ReplacingMergeTree and the stats never use FINAL, so until a merge a
  // row can be there twice (the syncer re-writes a ledger it is not sure about). One insert of a row twice would be
  // collapsed by ClickHouse on the way in (`optimize_on_insert`), so the copy is a second insert, without deduplication,
  // with the merges stopped.
  let h: Harness;
  let api: ApiClient;
  const requests = [
    ...[TRADER, MULTI, FEE_CARRY, THREE_TX, TWO_VALUE, GATEWAY, KIC].flatMap((account) => [
      `${path(account, 'transactions')}?limit=1000`,
      `${path(account, 'value')}?limit=1000`,
    ]),
    `${path(TRADER, 'transactions')}?descending=true&limit=1`,
    `${path(TRADER, 'value')}?descending=true&limit=1`,
    `${path(TRADER, 'transactions')}?start=2015-01-15`,
    `${path(TRADER, 'value')}?start=2015-01-15`,
  ];
  let once: Body<unknown>[] = [];

  const count = async (table: Table): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    once = [];
    for (const url of requests) once.push((await api.ok<Body<unknown>>(url, 'rows')).body);
    for (const table of [Table.AccountTransactions, Table.BalanceChanges]) {
      const rows = await count(table);
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
      // the table really holds every row twice
      expect(await count(table)).toBe(2 * rows);
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the answers before the copy are the oracles', () => {
    expect(once[0].rows).toEqual(sentOf(TRADER));
    expect((once[1].rows as ValueRow[]).map((r) => r.account_value)).toEqual(
      valueOf(TRADER).map((e) => e.value.toString()),
    );
    expect((once[0].rows as TxRow[]).reduce((n, r) => n + r.transaction_count, 0)).toBe(106);
    expect((once[1].rows as ValueRow[]).reduce((n, r) => n + r.balance_change_count, 0)).toBe(10);
  });

  it('counts every transaction and every change once: the same rows as before the copy', async () => {
    for (const [i, url] of requests.entries()) {
      expect([url, (await api.ok<Body<unknown>>(url, 'rows')).body]).toEqual([url, once[i]]);
    }
  });

  it('counts a transaction once in the maps of results and types as well as in the count', async () => {
    const res = (await api.ok<Body<TxRow>>(`${path(MULTI)}`, 'rows')).body.rows[0];
    expect(res).toEqual({
      date: '2015-01-14T00:00:00Z',
      transaction_count: 23,
      result: { tesSUCCESS: 23 },
      type: { Payment: 23 },
    });
  });

  it('takes the balance of a day from the last change once: the value is that of the single copy, rated or not', async () => {
    for (const account of [TRADER, MULTI, GATEWAY]) {
      const rows = (await api.ok<Body<ValueRow>>(`${path(account, 'value')}`, 'rows')).body.rows as ValueRow[];
      const expected = valueOf(account);
      expect(rows).toHaveLength(expected.length);
      rows.forEach((row, i) => expectValue(row, expected[i]));
    }
  });

  it('pages cut between the days neither repeat nor skip one', async () => {
    for (const [account, family] of [
      [THREE_TX, 'transactions'],
      [TWO_VALUE, 'value'],
    ]) {
      const expected = (await api.ok<Body<unknown>>(`${path(account, family)}?limit=1000`, 'rows')).body
        .rows as unknown[];
      expect(expected.length).toBeGreaterThanOrEqual(2);
      for (const limit of [1, 2]) {
        const walked = (await api.pages<Body<unknown>>(path(account, family), limit, 'rows')).flatMap((p) => p.rows);
        expect([account, family, limit, walked]).toEqual([account, family, limit, expected]);
      }
      const desc = (await api.pages<Body<unknown>>(`${path(account, family)}?descending=true`, 1, 'rows')).flatMap(
        (p) => p.rows,
      );
      expect(desc).toEqual([...expected].reverse());
    }
    // THREE_TX before the copy
    expect(once[requests.indexOf(`${path(THREE_TX, 'transactions')}?limit=1000`)].rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account stats computed from synthetic ledgers', () => {
  const A = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
  const B = 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7';
  const C = 'rPcQaiyDxMwLr7Q9eFmn5VnVx2RN57MUmN'; // a gap of more than ten years between its two days
  const D = 'rGmFH7pyrKs7E84MkGmgKc1gnsx6ZbWDwB'; // owes an issued currency and holds nothing else
  const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
  const ISSUER2 = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

  // -- transactions: [time, tx_index, type, result, sent by A] ----------------------------------------------------
  type Tx = [time: string, txIndex: number, type: string, result: string, sent: boolean];
  const A_TX: Tx[] = [
    ['2020-03-01T10:00:00Z', 1, 'Payment', 'tesSUCCESS', false], // received: not counted
    ['2020-03-02T08:00:00Z', 1, 'TrustSet', 'tesSUCCESS', true],
    ['2020-03-02T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
    ['2020-03-02T23:59:59Z', 1, 'OfferCreate', 'tecUNFUNDED_OFFER', true],
    ['2020-03-03T00:00:00Z', 1, 'OfferCreate', 'tesSUCCESS', true], // the next UTC day
    ['2020-03-03T09:00:00Z', 1, 'Payment', 'tecPATH_DRY', true],
    ['2020-03-03T09:00:00Z', 2, 'Payment', 'tesSUCCESS', true], // two in one ledger
    ['2020-03-10T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
    ['2020-03-12T09:00:00Z', 1, 'AccountSet', 'tesSUCCESS', true],
    ['2020-03-15T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
    ['2020-03-20T09:00:00Z', 1, 'OfferCancel', 'tesSUCCESS', false], // only touches it
    ['2020-03-30T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  ];
  const B_TX: Tx[] = [['2020-03-02T10:00:00Z', 2, 'Payment', 'tesSUCCESS', true]];

  const TX_ROWS_A: TxRow[] = [
    {
      date: '2020-03-02T00:00:00Z',
      transaction_count: 3,
      result: { tecUNFUNDED_OFFER: 1, tesSUCCESS: 2 },
      type: { OfferCreate: 1, Payment: 1, TrustSet: 1 },
    },
    {
      date: '2020-03-03T00:00:00Z',
      transaction_count: 3,
      result: { tecPATH_DRY: 1, tesSUCCESS: 2 },
      type: { OfferCreate: 1, Payment: 2 },
    },
    { date: '2020-03-10T00:00:00Z', transaction_count: 1, result: { tesSUCCESS: 1 }, type: { Payment: 1 } },
    { date: '2020-03-12T00:00:00Z', transaction_count: 1, result: { tesSUCCESS: 1 }, type: { AccountSet: 1 } },
    { date: '2020-03-15T00:00:00Z', transaction_count: 1, result: { tesSUCCESS: 1 }, type: { Payment: 1 } },
    { date: '2020-03-30T00:00:00Z', transaction_count: 1, result: { tesSUCCESS: 1 }, type: { Payment: 1 } },
  ];

  // -- balance changes: [account, time, tx_index, node_index, currency, counterparty, final_balance, change, type] ---
  type Change = [string, string, number, number, string, string, string, string, string];
  const XRP = (
    acct: string,
    time: string,
    tx: number,
    node: number,
    final: string,
    change: string,
    type: string,
  ): Change => [acct, time, tx, node, 'XRP', '', final, change, type];
  const FEE = (acct: string, time: string, tx: number, final: string): Change =>
    XRP(acct, time, tx, -1, final, '-0.000012', 'transaction_cost');
  const IOU = (
    acct: string,
    time: string,
    tx: number,
    node: number,
    cp: string,
    final: string,
    change: string,
    type: string,
  ): Change => [acct, time, tx, node, 'USD', cp, final, change, type];
  const CHANGES: Change[] = [
    XRP(A, '2020-03-01T10:00:00Z', 1, 1, '100', '100', 'payment_destination'),
    FEE(A, '2020-03-02T08:00:00Z', 1, '99.999988'),
    IOU(A, '2020-03-02T08:00:00Z', 1, 4, ISSUER, '10', '10', 'payment_destination'),
    FEE(A, '2020-03-02T09:00:00Z', 1, '99.999976'),
    XRP(A, '2020-03-02T09:00:00Z', 1, 2, '89.999976', '-10', 'payment_source'),
    FEE(A, '2020-03-03T09:00:00Z', 1, '89.999964'), // the fee alone: no row for the day
    IOU(A, '2020-03-04T09:00:00Z', 1, 3, ISSUER2, '-5', '-5', 'intermediary'), // what A owes
    IOU(A, '2020-03-06T09:00:00Z', 1, 5, ISSUER, '30', '20', 'payment_destination'),
    IOU(A, '2020-03-06T09:00:00Z', 1, 6, ISSUER2, '7', '12', 'payment_destination'), // no trades: no rate
    FEE(A, '2020-03-10T09:00:00Z', 1, '89.999952'),
    XRP(A, '2020-03-10T09:00:00Z', 1, 2, '50', '-39.999952', 'payment_source'),
    IOU(A, '2020-03-18T09:00:00Z', 1, 4, ISSUER, '24', '-6', 'exchange'), // no trades within 14 days: no rate
    XRP(A, '2020-03-20T09:00:00Z', 1, 2, '51', '1', 'payment_destination'),
    IOU(A, '2020-03-25T09:00:00Z', 1, 4, ISSUER, '27', '3', 'payment_destination'),
    // B: another account on the same days
    XRP(B, '2020-03-02T08:30:00Z', 1, 1, '1000', '1000', 'payment_destination'),
    // C: 10 USD in 2005, then 3 XRP in 2020: the days are more than ten years apart
    IOU(C, '2005-06-01T10:00:00Z', 1, 1, ISSUER, '10', '10', 'payment_destination'),
    XRP(C, '2020-03-02T10:00:00Z', 1, 1, '3', '3', 'payment_destination'),
    // D: owes 5 USD to ISSUER, holds nothing
    IOU(D, '2020-03-02T10:30:00Z', 1, 1, ISSUER, '-5', '-5', 'intermediary'),
  ];
  /** What `A` is worth at the end of each day it had a change, worked out by hand. */
  const A_VALUE: ValueRow[] = [
    { date: '2020-03-01T00:00:00Z', account_value: '100', balance_change_count: 1 }, // 100 XRP
    { date: '2020-03-02T00:00:00Z', account_value: '94.999976', balance_change_count: 2 }, // 89.999976 + 10 USD / 2
    { date: '2020-03-04T00:00:00Z', account_value: '94.999964', balance_change_count: 1 }, // 89.999964 (03-03's fee) + 10 / 2; -5 owed is 0
    { date: '2020-03-06T00:00:00Z', account_value: '104.999964', balance_change_count: 2 }, // 89.999964 + 30 / 2; 7 USD of ISSUER2 has no rate
    { date: '2020-03-10T00:00:00Z', account_value: '65', balance_change_count: 1 }, // 50 + 30 / 2 (no trade that day: the last 50 of 14 days)
    { date: '2020-03-18T00:00:00Z', account_value: '50', balance_change_count: 1 }, // 50 + 24 USD with no rate in 14 days
    { date: '2020-03-20T00:00:00Z', account_value: '59', balance_change_count: 1 }, // 51 + 24 / 3
    { date: '2020-03-25T00:00:00Z', account_value: '60', balance_change_count: 1 }, // 51 + 27 / 3
  ];

  // 12 trades of 10 USD against 5 XRP (2 USD per XRP) on 2020-03-02, 12 of 30 USD against 10 XRP (3 per XRP) on 2020-03-20
  const TRADES = [
    ...Array.from({ length: 12 }, (_, i) => ({
      time: Date.parse('2020-03-02T12:30:00Z') + i * 1000,
      usd: '10',
      xrp: '5',
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      time: Date.parse('2020-03-20T12:30:00Z') + i * 1000,
      usd: '30',
      xrp: '10',
    })),
  ];

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  const rows = async <R>(url: string): Promise<R[]> => (await api.ok<Body<R>>(url, 'rows')).body.rows;
  const A_TX_URL = path(A, 'transactions');
  const A_VALUE_URL = path(A, 'value');

  beforeAll(async () => {
    h = await startHarness({
      seed: 'none',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;

    const times = [
      ...new Set([
        ...A_TX.map(([t]) => Date.parse(t)),
        ...B_TX.map(([t]) => Date.parse(t)),
        ...CHANGES.map(([, t]) => Date.parse(t)),
        ...TRADES.map((t) => t.time),
      ]),
    ].sort((a, b) => a - b);
    const ledgerOf = new Map(times.map((t, i) => [t, 5_000_000 + i]));
    await h.ch.insert(
      Table.Ledgers,
      times.map((t) => ({
        ledger_index: ledgerOf.get(t),
        ledger_hash: `${ledgerOf.get(t)}`.padStart(64, 'C'),
        close_time: t / 1000,
      })),
    );

    const txRows = (account: string, list: Tx[]): AccountTransactionsRow[] =>
      list.map(([time, tx_index, tx_type, result, sent]) => ({
        account,
        ledger_index: ledgerOf.get(Date.parse(time)) as number,
        tx_index,
        tx_type,
        result,
        is_initiator: sent ? 1 : 0,
        close_time: Date.parse(time) / 1000,
      }));
    await h.ch.insert(Table.AccountTransactions, [...txRows(A, A_TX), ...txRows(B, B_TX)]);

    await h.ch.insert(
      Table.BalanceChanges,
      CHANGES.map(
        ([
          account,
          time,
          tx_index,
          node_index,
          currency,
          counterparty,
          final_balance,
          amount_change,
          change_type,
        ]): BalanceChangesRow => ({
          account,
          ledger_index: ledgerOf.get(Date.parse(time)) as number,
          tx_index,
          node_index,
          tx_hash: `${tx_index}`.padStart(64, 'A'),
          close_time: Date.parse(time) / 1000,
          currency,
          counterparty,
          amount_change,
          final_balance,
          final_balance_f: Number(final_balance),
          change_type,
          escrow_counterparty: null,
          escrow_balance_change: null,
          paychannel_counterparty: null,
          paychannel_fund_change: null,
          paychannel_fund_final_balance: null,
          paychannel_final_balance: null,
          paychannel_balance_change: null,
          client: null,
        }),
      ),
    );

    await h.ch.insert(
      Table.Exchanges,
      TRADES.map(
        (t, i): ExchangesRow => ({
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XRP',
          counter_issuer: '',
          ledger_index: ledgerOf.get(t.time) as number,
          tx_index: 100 + i,
          node_index: 1,
          tx_hash: `${100 + i}`.padStart(64, 'B'),
          close_time: t.time / 1000,
          base_amount: t.usd,
          counter_amount: t.xrp,
          base_amount_f: Number(t.usd),
          counter_amount_f: Number(t.xrp),
          rate: String(Number(t.xrp) / Number(t.usd)),
          rate_f: Number(t.xrp) / Number(t.usd),
          buyer: B,
          seller: B,
          taker: B,
          provider: B,
          offer_sequence: 1,
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        }),
      ),
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  describe('stats/transactions', () => {
    it('is a row for each UTC day the account sent a transaction, with the counts of its results and types', async () => {
      expect(await rows(A_TX_URL)).toEqual(TX_ROWS_A);
    });

    it('counts a transaction on the UTC day it closed: 23:59:59 on one day, 00:00:00 on the next', async () => {
      const found = await rows<TxRow>(A_TX_URL);
      expect(found[0].type).toEqual({ OfferCreate: 1, Payment: 1, TrustSet: 1 });
      expect(found[1].type).toEqual({ OfferCreate: 1, Payment: 2 });
    });

    it('leaves out what only touches the account (is_initiator = 0) and the days that holds only that', async () => {
      const found = await rows<TxRow>(A_TX_URL);
      expect(found.map((r) => r.date.slice(0, 10))).not.toContain('2020-03-01');
      expect(found.map((r) => r.date.slice(0, 10))).not.toContain('2020-03-20');
    });

    it('is not the stats of another account', async () => {
      expect(await rows(path(B, 'transactions'))).toEqual([
        { date: '2020-03-02T00:00:00Z', transaction_count: 1, result: { tesSUCCESS: 1 }, type: { Payment: 1 } },
      ]);
    });

    it('window: start and end cut the days, end excluded', async () => {
      expect(
        (await rows<TxRow>(`${A_TX_URL}?start=2020-03-03&end=2020-03-12`)).map((r) => r.date.slice(0, 10)),
      ).toEqual(['2020-03-03', '2020-03-10']);
      expect(
        (await rows<TxRow>(`${A_TX_URL}?start=2020-03-03&end=2020-03-12T00:00:01`)).map((r) => r.date.slice(0, 10)),
      ).toEqual(['2020-03-03', '2020-03-10', '2020-03-12']);
    });

    it('pages of 2: the marker is the day of the last row, the next page starts on the day after it', async () => {
      const first = await get(`${A_TX_URL}?limit=2`);
      expect(first.body.rows).toEqual(TX_ROWS_A.slice(0, 2));
      expect(first.body.marker).toBe(markerOf('2020-03-03'));
      const second = await get(`${A_TX_URL}?limit=2&marker=${first.body.marker}`);
      expect(second.body.rows).toEqual(TX_ROWS_A.slice(2, 4));
      expect(second.body.marker).toBe(markerOf('2020-03-12'));
      const third = await get(`${A_TX_URL}?limit=2&marker=${second.body.marker}`);
      expect(third.body.rows).toEqual(TX_ROWS_A.slice(4));
      expect(third.body.marker).toBeUndefined();
      // newest first: the page stops before the day of the marker
      const desc = await get(`${A_TX_URL}?limit=2&descending=true`);
      expect(desc.body.rows).toEqual(TX_ROWS_A.slice(4).reverse());
      expect(desc.body.marker).toBe(markerOf('2020-03-15'));
      const desc2 = await get(`${A_TX_URL}?limit=2&descending=true&marker=${desc.body.marker}`);
      expect(desc2.body.rows).toEqual(TX_ROWS_A.slice(2, 4).reverse());
    });

    it('limits the days read to the window: a marker narrows the range of ledgers', async () => {
      const marker = markerOf('2020-03-10');
      const calls: { params: Record<string, unknown> }[] = [];
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${A_TX_URL}?marker=${marker}`);
      for (const [sql, params] of spy.mock.calls)
        if (String(sql).includes(Table.AccountTransactions)) calls.push({ params: params as Record<string, unknown> });
      spy.mockRestore();
      expect(calls).toHaveLength(1);
      const [{ params }] = calls;
      const ledgers = await h.ch.query<{ ledger_index: number; close_time: string }>(
        `SELECT ledger_index, toString(close_time) AS close_time FROM ${Table.Ledgers} ORDER BY ledger_index`,
      );
      const firstOfDay = ledgers.find((l) => l.close_time >= '2020-03-11')?.ledger_index;
      expect(params.min).toBe(firstOfDay);
    });
  });

  describe('stats/value', () => {
    it('is a row for each UTC day with a change besides the fee, with the value at the end of the day', async () => {
      expect(await rows(A_VALUE_URL)).toEqual(A_VALUE);
    });

    it('has no row for 2020-03-03 (the fee alone) nor for the days with nothing, and the fee is kept in the balance', async () => {
      const dates = (await rows<ValueRow>(A_VALUE_URL)).map((r) => r.date.slice(0, 10));
      expect(dates).not.toContain('2020-03-03');
      expect(dates).not.toContain('2020-03-05');
      // 03-02 ends at 89.999976, 03-03 pays 0.000012 more: 03-04 has 89.999964 + 10 / 2
      expect((await rows<ValueRow>(A_VALUE_URL))[2].account_value).toBe('94.999964');
    });

    it('is exact: 89.999976 + 5 is 94.999976 and not 94.99997599999999', async () => {
      expect((await rows<ValueRow>(`${A_VALUE_URL}?start=2020-03-02&end=2020-03-03`))[0].account_value).toBe(
        '94.999976',
      );
    });

    it('carries the balances from before the window: a window that starts later has the same values', async () => {
      for (const start of [
        '2020-03-02',
        '2020-03-04',
        '2020-03-05',
        '2020-03-10',
        '2020-03-11',
        '2020-03-19',
        '2020-03-25',
      ]) {
        const expected = A_VALUE.filter((r) => r.date.slice(0, 10) >= start);
        expect([start, await rows(`${A_VALUE_URL}?start=${start}`)]).toEqual([start, expected]);
      }
    });

    it('has no row after the last change, though the account still holds the same', async () => {
      expect(await rows(`${A_VALUE_URL}?start=2020-03-26`)).toEqual([]);
      expect(await rows(`${A_VALUE_URL}?start=2021-01-01`)).toEqual([]);
    });

    it('stops before the end: a day is not in the window whose midnight is not before the end', async () => {
      expect((await rows<ValueRow>(`${A_VALUE_URL}?end=2020-03-06`)).map((r) => r.date.slice(0, 10))).toEqual([
        '2020-03-01',
        '2020-03-02',
        '2020-03-04',
      ]);
      expect((await rows<ValueRow>(`${A_VALUE_URL}?end=2020-03-06T00:00:01`)).map((r) => r.date.slice(0, 10))).toEqual([
        '2020-03-01',
        '2020-03-02',
        '2020-03-04',
        '2020-03-06',
      ]);
    });

    it('counts an issued currency at the rate of each day: the same 24 USD are worth 0 on the 18th and 8 on the 20th', async () => {
      const found = await rows<ValueRow>(A_VALUE_URL);
      const at = (day: string): string => found.find((r) => r.date.startsWith(day))?.account_value ?? '';
      expect([at('2020-03-18'), at('2020-03-20')]).toEqual(['50', '59']);
    });

    it('counts what the account holds, not what it owes: -5 USD is worth 0, and an account that owes only is worth 0', async () => {
      expect(await rows(path(D, 'value'))).toEqual([
        { date: '2020-03-02T00:00:00Z', account_value: '0', balance_change_count: 1 },
      ]);
      expect((await rows<ValueRow>(A_VALUE_URL))[2].account_value).toBe('94.999964');
    });

    it('is not the value of another account', async () => {
      expect(await rows(path(B, 'value'))).toEqual([
        { date: '2020-03-02T00:00:00Z', account_value: '1000', balance_change_count: 1 },
      ]);
    });

    it('handles days more than ten years apart: the rates are asked for in runs a call takes', async () => {
      const res = await get(`${path(C, 'value')}?start=2000-01-01`);
      expect([res.status, res.body.rows]).toEqual([
        200,
        [
          // 10 USD in 2005 have no rate
          { date: '2005-06-01T00:00:00Z', account_value: '0', balance_change_count: 1 },
          // 3 XRP + 10 USD at 2 USD per XRP
          { date: '2020-03-02T00:00:00Z', account_value: '8', balance_change_count: 1 },
        ],
      ]);
    });

    it('pages of 3: values do not depend on the page, ascending or descending, and markers are the last day', async () => {
      const first = await get(`${A_VALUE_URL}?limit=3`);
      expect(first.body.rows).toEqual(A_VALUE.slice(0, 3));
      expect(first.body.marker).toBe(markerOf('2020-03-04'));
      const walked = await api.pages<Body<ValueRow>>(A_VALUE_URL, 3, 'rows');
      expect(walked.map((p) => p.count)).toEqual([3, 3, 2]);
      expect(walked.flatMap((p) => p.rows)).toEqual(A_VALUE);
      const desc = await api.pages<Body<ValueRow>>(`${A_VALUE_URL}?descending=true`, 3, 'rows');
      expect(desc.map((p) => p.count)).toEqual([3, 3, 2]);
      expect(desc.flatMap((p) => p.rows)).toEqual([...A_VALUE].reverse());
      expect(desc[0].marker).toBe(markerOf('2020-03-18'));
      for (const limit of [1, 2, 4, 5, 8]) {
        expect((await api.pages<Body<ValueRow>>(A_VALUE_URL, limit, 'rows')).flatMap((p) => p.rows)).toEqual(A_VALUE);
      }
    });

    it('asks the rates only when the account holds an issued currency, and only for the currencies it holds', async () => {
      const exchanges = async (account: string, query = ''): Promise<unknown[][]> => {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`${path(account, 'value')}${query}`);
        const calls = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
        spy.mockRestore();
        return calls.map(([, params]) => Object.values((params ?? {}) as Record<string, unknown>));
      };
      expect(await exchanges(B)).toEqual([]); // native only
      expect(await exchanges(D)).toEqual([]); // owes only
      expect(await exchanges(A, '?end=2020-03-02')).toEqual([]); // A holds no issued currency before the 2nd
      const held = await exchanges(A);
      expect(held.length).toBeGreaterThan(0);
      expect(held.flat()).toContain(ISSUER);
      expect(held.flat()).toContain(ISSUER2);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account stats on Xahau (XAH is the native currency)', () => {
  const seed = 'xahau-recorded';
  const TX = fixtureAccountTransactions(seed);
  const BC = [...fixtureBalanceChanges(seed)].sort((a, b) => byKey(a, b) || (a.account < b.account ? -1 : 1));
  const txByAccount = groupBy(TX, (r) => r.account);
  const bcByAccount = groupBy(BC, (r) => r.account);
  const accounts = [...new Set([...TX.map((r) => r.account), ...BC.map((r) => r.account)])];
  const EVERNODE = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'; // 92 changes, all EVR
  const BUSY = 'rmv53yu8Wid6kj6AC6NvmiwSXNxRa8vTH'; // 68 payments of XAH on 2026-10-15
  const SENDER = [...txByAccount.entries()]
    .map(([account, rows]) => [account, rows.filter((r) => r.is_initiator).length] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const DAY = '2026-10-15';
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({
      network: 'xahau',
      seed,
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  it('the recorded ledgers have no trades, so an issued currency has no rate: the value is the XAH an account holds', () => {
    expect(fixtureExchanges(seed)).toHaveLength(0);
    expect(new Set(BC.map((r) => r.currency))).toEqual(new Set(['XAH', 'EVR', 'RVN', 'XXX']));
    expect(new Set(BC.map((r) => dayOf(r.close_time)))).toEqual(new Set([DAY]));
  });

  it('transactions: every account has the transactions it sent on the day, by result and type', async () => {
    expect(accounts.length).toBeGreaterThan(50);
    let rows = 0;
    for (const account of accounts) {
      const res = await get(`${path(account)}?limit=1000`);
      expect([account, res.status]).toEqual([account, 200]);
      expect([account, res.body.rows]).toEqual([account, expectedTransactions(txByAccount.get(account) ?? [])]);
      rows += res.body.count;
    }
    expect(rows).toBeGreaterThan(30);
    // the account that sent most, and the transaction types of Xahau
    const types = new Set((await get(path(SENDER))).body.rows.flatMap((r: TxRow) => Object.keys(r.type)));
    expect(types.size).toBeGreaterThan(0);
    expect(expectedTransactions(txByAccount.get(SENDER) ?? [])[0].transaction_count).toBeGreaterThanOrEqual(2);
  });

  it('value: the XAH balance at the end of the day, in XAH, for every account', async () => {
    let rows = 0;
    for (const account of accounts) {
      const expected = expectedValue(bcByAccount.get(account) ?? [], () => new BigNumber(0));
      const res = await get(`${path(account, 'value')}?limit=1000`);
      expect([account, res.status]).toEqual([account, 200]);
      expect([account, res.body.rows.map((r: ValueRow) => r.account_value)]).toEqual([
        account,
        expected.map((e) => e.value.toString()),
      ]);
      expect(res.body.rows.map((r: ValueRow) => r.balance_change_count)).toEqual(expected.map((e) => e.count));
      rows += res.body.count;
    }
    expect(rows).toBeGreaterThan(50);
  });

  it('needs no rate for XAH, and an EVR token has none: the token holder is worth its XAH', async () => {
    const holder = BC.find(
      (r) => r.currency === 'EVR' && r.account !== EVERNODE && new BigNumber(r.final_balance).gt(0),
    );
    expect(holder).toBeDefined();
    const account = holder?.account as string;
    const spy = jest.spyOn(h.ch, 'query');
    const res = await get(`${path(account, 'value')}`);
    const asked = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
    spy.mockRestore();
    expect(res.status).toBe(200);
    // EVR is asked for (it is an issued currency the account holds), and has no trades
    expect(asked.length).toBeGreaterThan(0);
    const native = (bcByAccount.get(account) ?? []).filter((r) => r.currency === 'XAH').pop();
    expect(res.body.rows[0].account_value).toBe(new BigNumber(native?.final_balance ?? 0).toString());
  });

  it('pages, windows, descending and the CSV name work as on XRPL', async () => {
    expect((await get(`${path(SENDER)}?end=${DAY}`)).body.rows).toEqual([]);
    expect((await get(`${path(SENDER)}?end=2026-10-16`)).body.rows).toEqual(
      expectedTransactions(txByAccount.get(SENDER) ?? []),
    );
    expect((await get(`${path(SENDER)}?start=2026-10-16`)).body.rows).toEqual([]);
    const csv = await get(`${path(BUSY, 'value')}?format=csv`);
    expect(csv.headers['content-disposition']).toBe(csvDisposition(`${BUSY} - stats.value`));
    expect(csv.text.split('\n')).toHaveLength(2);
    expect(csv.text).not.toContain('XRP');
  });
});

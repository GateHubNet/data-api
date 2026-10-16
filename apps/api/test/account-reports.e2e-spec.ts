import { AccountPaymentsRow, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureAccountPayments, fixtureExchanges, fixtureSource } from './support/fixtures';

/**
 * `GET /v2/accounts/:address/reports[/:date]` on a real ClickHouse, seeded with the 54 ledgers of the original Ripple
 * test suite (`ripple-mock`: payments on five days between 2013 and 2017, 164 active account-days) and with the Xahau
 * ledgers recorded from a public node (all XAH, one day).
 *
 * Ported from rippled-historical-database `test/test.account.reports.js`: all 9 `it`s with their titles, none skipped.
 * The original ran against the HBase aggregates its importer filled; the expectations are the shapes it checked, and
 * here they hold for the report of the same account and days computed from the mock ledgers. Added:
 *  - the value of the reports: an oracle written from `lib/aggregation/accountPayments.js` (float arithmetic, a bucket
 *    per account and day, the sender's and the receiver's side, a rate of the day for an issued currency) is compared
 *    with the report of every account and every active day of the mock ledgers;
 *  - the zero fill, the envelope, the window rules (a start within a day of the end, a start with a time of day, an end
 *    before the start, the 200 days), the flags and their aliases, the payments of a report;
 *  - an issued currency with a rate, without one, and without an issuer (counts as 0);
 *  - exact arithmetic, rates of the day, midnight, a payment to oneself, amounts a decimal cannot hold, on synthetic
 *    ledgers;
 *  - `format=csv` gives the rows, not the envelope (the original flattened `{rows: [...]}` into one wide row);
 *  - the tables a request reads and their plan, rows that were written twice, the failure paths and Xahau.
 */

const SINGLE = 'r3fRiC42XCDHFkE4vLdJUhsVcx7hFbE5gU'; // the account of the original's tests: one payment received, 500 XRP
const SINGLE_PEER = 'rJMQ7DdLdrcLXaSyhBnhHUSvsKVJG4pLep'; // the one that sent it (checked against the ledgers below)
const MULTI = 'rwvLbHQtU16BwQJyrQb9cfFKvx13Ksbkja'; // sent 23 EUR, received 36 CNY, on 2015-01-14
const CNY_SENDER = 'rJAeQMhtr89PvFPnAZXkdgJgScZ1YuB9UR'; // sent 36 CNY on 2015-01-14
const EUR_ONLY = 'r4L6ZLHkTytPqDR81H1ysCr6qGv9oJJAKi'; // received the 23 EUR
const NOBODY = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';
const MWJ = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const KIC = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';

const DAY_MS = 86_400_000;

/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

const path = (account: string, date?: string): string => `/v2/accounts/${account}/reports${date ? `/${date}` : ''}`;

interface ReportPayment {
  tx_hash: string;
  amount: string;
  currency: string;
  issuer?: string;
  type: 'sent' | 'received';
}
interface Report {
  account: string;
  date: string;
  high_value_received: string;
  high_value_sent: string;
  total_value_received: string;
  total_value_sent: string;
  total_value: string;
  payments_sent: number;
  payments_received: number;
  receiving_counterparties: number | string[];
  sending_counterparties: number | string[];
  payments?: ReportPayment[];
}
interface Body {
  result: string;
  start: string;
  end: string;
  count: number;
  reports: Report[];
}

/** A 200 answer of the reports with its body typed (`ApiClient.ok` types the body `any`). */
interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  body: Body;
}
const okBody = async (api: ApiClient, url: string, key?: string): Promise<Answer> =>
  (await api.ok(url, key)) as unknown as Answer;

const ZERO_REPORT = (account: string, date: string): Report => ({
  account,
  date,
  high_value_received: '0',
  high_value_sent: '0',
  total_value_received: '0',
  total_value_sent: '0',
  total_value: '0',
  payments_sent: 0,
  payments_received: 0,
  receiving_counterparties: 0,
  sending_counterparties: 0,
});

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: `accountPayments.js` of the original, in floats, with the rate of the day
// ---------------------------------------------------------------------------------------------------------------------

interface Key {
  ledger_index: number;
  tx_index: number;
}
const byKey = (a: Key, b: Key): number => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;
const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

const ROWS = [...fixtureAccountPayments('ripple-mock')].sort(byKey);
const EXCHANGES = fixtureExchanges('ripple-mock').map((e) => e.row);

const rowsOf = (account: string, day: string): AccountPaymentsRow[] =>
  ROWS.filter((r) => r.account === account && dayOf(r.close_time) === day);

/** The (account, day) pairs with a payment, which is where a report is not zero. */
const ACTIVE: { account: string; day: string }[] = [
  ...new Map(
    ROWS.map((r) => [`${r.account}|${dayOf(r.close_time)}`, { account: r.account, day: dayOf(r.close_time) }]),
  ).values(),
];

/**
 * Units of an issued currency per native coin on a day: the volume weighted average price of its trades against the
 * native currency that day, 0 when there are fewer than 10 (strict). In the mock ledgers every pair with 10 trades or
 * more has them all on one day, and no payment in such a currency falls within 14 days after it (the "latest 50
 * trades" of a later day would still reach it): both are checked by the first `it` below.
 */
function oracleRate(currency: string, issuer: string, day: string): number {
  const trades = EXCHANGES.filter(
    (e) =>
      e.base_currency === currency &&
      e.base_issuer === issuer &&
      e.counter_currency === 'XRP' &&
      e.counter_amount_f > 0.0005,
  );
  const onDay = trades.filter((e) => dayOf(e.close_time) === day);
  if (onDay.length < 10) return 0;
  const base = onDay.reduce((total, e) => total + e.base_amount_f, 0);
  const counter = onDay.reduce((total, e) => total + e.counter_amount_f, 0);
  return counter ? base / counter : 0;
}

interface Expected {
  report: Omit<
    Report,
    'high_value_received' | 'high_value_sent' | 'total_value_received' | 'total_value_sent' | 'total_value'
  >;
  values: { high_received: number; high_sent: number; total_received: number; total_sent: number; total: number };
  list: string[]; // the tx hashes, in order
  receiving: string[];
  sending: string[];
}

function expectedReport(account: string, day: string): Expected {
  const values = { high_received: 0, high_sent: 0, total_received: 0, total_sent: 0, total: 0 };
  const receiving: string[] = [];
  const sending: string[] = [];
  const payments: ReportPayment[] = [];
  let sent = 0;
  let received = 0;
  for (const r of rowsOf(account, day)) {
    const amount = Number(r.delivered_amount);
    const rate = r.currency === 'XRP' ? 1 : r.issuer ? oracleRate(r.currency, r.issuer, day) : 0;
    const normalized = r.currency === 'XRP' ? amount : rate ? amount / rate : 0;
    payments.push({
      tx_hash: r.tx_hash,
      amount: r.delivered_amount,
      currency: r.currency,
      ...(r.issuer && { issuer: r.issuer }),
      type: r.direction,
    });
    values.total += normalized;
    if (r.direction === 'sent') {
      sent++;
      values.total_sent += normalized;
      values.high_sent = Math.max(values.high_sent, normalized);
      if (!receiving.includes(r.counterparty)) receiving.push(r.counterparty);
    } else {
      received++;
      values.total_received += normalized;
      values.high_received = Math.max(values.high_received, normalized);
      if (!sending.includes(r.counterparty)) sending.push(r.counterparty);
    }
  }
  return {
    report: {
      account,
      date: `${day}T00:00:00Z`,
      payments_sent: sent,
      payments_received: received,
      receiving_counterparties: receiving.length,
      sending_counterparties: sending.length,
      payments,
    },
    values,
    list: payments.map((p) => p.tx_hash),
    receiving,
    sending,
  };
}

/** A value of a report is the float oracle's to 1e-9 (floats add in a different order, and the rate is a quotient). */
function expectNear(actual: string, expected: number, what: string): void {
  expect(typeof actual).toBe('string');
  const a = Number(actual);
  expect([what, Math.abs(a - expected) <= 1e-9 * Math.max(1, Math.abs(expected))]).toEqual([what, true]);
}

/** A report against the oracle's: the counts and the lists exactly, the values near. */
function expectMatches(actual: Report, e: Expected, what: string): void {
  const { payments, ...counts } = e.report;
  expect([what, { ...actual, payments: undefined }]).toEqual([
    what,
    expect.objectContaining({
      ...counts,
      receiving_counterparties: e.receiving,
      sending_counterparties: e.sending,
      payments: undefined,
    }),
  ]);
  expect([what, actual.payments]).toEqual([what, payments]);
  expectNear(actual.high_value_received, e.values.high_received, `${what} high_value_received`);
  expectNear(actual.high_value_sent, e.values.high_sent, `${what} high_value_sent`);
  expectNear(actual.total_value_received, e.values.total_received, `${what} total_value_received`);
  expectNear(actual.total_value_sent, e.values.total_sent, `${what} total_value_sent`);
  expectNear(actual.total_value, e.values.total, `${what} total_value`);
}

// ---------------------------------------------------------------------------------------------------------------------

describe('account reports API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

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

  it('the mock ledgers are what the oracle assumes: pairs of 10 trades or more are on one day, with no payment near it', () => {
    expect(ACTIVE).toHaveLength(164);
    // the trades of each currency against the native one, and the days they are on
    const ratedPairs = new Map<string, { days: Set<string>; trades: number }>();
    for (const e of EXCHANGES) {
      if (e.counter_currency !== 'XRP') continue;
      const key = `${e.base_currency}.${e.base_issuer}`;
      const pair = ratedPairs.get(key) ?? { days: new Set<string>(), trades: 0 };
      pair.days.add(dayOf(e.close_time));
      pair.trades++;
      ratedPairs.set(key, pair);
    }
    const rated = [...ratedPairs.entries()].filter(([, pair]) => pair.trades >= 10);
    expect(rated.map(([key]) => key)).toEqual([`CNY.${KIC}`]);
    expect([...rated[0][1].days]).toEqual(['2015-01-14']);
    for (const r of ROWS.filter((row) => `${row.currency}.${row.issuer}` === `CNY.${KIC}`)) {
      const days = (Date.parse(dayOf(r.close_time)) - Date.parse('2015-01-14')) / DAY_MS;
      expect(days === 0 || days > 14).toBe(true);
    }
  });

  // -- test.account.reports.js ------------------------------------------------------------------------------------

  it('should get reports by date range', async () => {
    const start = Date.parse('2015-01-14T00:00:00Z');
    const end = Date.parse('2015-01-16T00:00:00Z');
    const res = await get(`${path(SINGLE)}${qs({ start: '2015-01-14T00:00:00Z', end: '2015-01-16T00:00:00Z' })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.reports.length).toBe(res.body.count);
    expect(res.body.reports.length).toBe(3);
    for (const r of (res.body as Body).reports) {
      expect(typeof r.date).toBe('string');
      expect(typeof r.high_value_received).toBe('string');
      expect(typeof r.high_value_sent).toBe('string');
      expect(typeof r.payments_received).toBe('number');
      expect(typeof r.payments_sent).toBe('number');
      expect(typeof r.receiving_counterparties).toBe('number');
      expect(typeof r.sending_counterparties).toBe('number');
      expect(typeof r.total_value).toBe('string');
      expect(typeof r.total_value_received).toBe('string');
      expect(typeof r.total_value_sent).toBe('string');
      expect(start - Date.parse(r.date)).toBeLessThanOrEqual(0); // date less than start time
      expect(end - Date.parse(r.date)).toBeGreaterThanOrEqual(0); // date greater than end time
    }
  });

  it('should get reports in descending order', async () => {
    const end = '2015-02-16T00:00:00Z';
    const res = await get(`${path(SINGLE)}${qs({ start: '2015-01-14T00:00:00Z', end, descending: true })}`);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.reports).toHaveLength(34);
    let last = Date.parse(end);
    for (const r of (res.body as Body).reports) {
      expect(last - Date.parse(r.date)).toBeGreaterThanOrEqual(0);
      last = Date.parse(r.date);
    }
    expect(res.body.reports[0].date).toBe('2015-02-16T00:00:00Z');
    expect(res.body.reports[33].date).toBe('2015-01-14T00:00:00Z');
  });

  it('should get reports with counterparties', async () => {
    const res = await get(
      `${path(SINGLE)}${qs({ accounts: true, start: '2015-01-14T00:00:00Z', end: '2015-01-16T00:00:00Z' })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.reports).toHaveLength(3);
    for (const a of (res.body as Body).reports) {
      expect(Array.isArray(a.receiving_counterparties)).toBe(true);
      expect(Array.isArray(a.sending_counterparties)).toBe(true);
    }
    // the one payment of the account: received on the 14th from another account
    expect(res.body.reports[0].sending_counterparties).toEqual([SINGLE_PEER]);
    expect(res.body.reports[0].receiving_counterparties).toEqual([]);
  });

  it('should get reports with individual payments', async () => {
    const res = await get(
      `${path(SINGLE)}${qs({ payments: true, start: '2015-01-14T00:00:00Z', end: '2015-01-16T00:00:00Z' })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    for (const a of (res.body as Body).reports) {
      expect(Array.isArray(a.payments)).toBe(true);
      expect(a.payments?.length).toBe(a.payments_received + a.payments_sent);
    }
    expect(res.body.reports[0].payments).toEqual([
      { tx_hash: expect.stringMatching(/^[0-9A-F]{64}$/), amount: '500', currency: 'XRP', type: 'received' },
    ]);
  });

  it('should get reports for a single date', async () => {
    const res = await get(path(SINGLE, '2015-01-14'));
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.reports.length).toBe(res.body.count);
    expect(res.body.reports.length).toBe(1);
    expect(res.body.reports[0]).toEqual({
      account: SINGLE,
      date: '2015-01-14T00:00:00Z',
      high_value_received: '500',
      high_value_sent: '0',
      total_value_received: '500',
      total_value_sent: '0',
      total_value: '500',
      payments_sent: 0,
      payments_received: 1,
      receiving_counterparties: 0,
      sending_counterparties: 1,
    });
  });

  it('should return an error if the date range is greater than 200', async () => {
    const res = await get(`${path(SINGLE)}${qs({ start: '2014-01-14T00:00:00Z', end: '2015-01-16T00:00:00Z' })}`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('choose a date range less than 200 days');
  });

  it('should return an error for an invalid date', async () => {
    const res = await get(path(SINGLE, '2015-01x'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ result: 'error', message: 'invalid date format' });
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get(`${path(SINGLE)}${qs({ start: '2015x', end: '2015-01-16' })}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ result: 'error', message: 'invalid date format' });
  });

  it('should return an error for an invalid end date', async () => {
    const res = await get(`${path(SINGLE)}${qs({ start: '2015-01-14', end: '2015x' })}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ result: 'error', message: 'invalid end date format' });
  });

  // -- the envelope and the window ----------------------------------------------------------------------------------

  describe('the answer', () => {
    it('is {result, start, end, count, reports}, with start and end as the original wrote them', async () => {
      const res = await okBody(
        api,
        `${path(SINGLE)}${qs({ start: '2015-01-14', end: '2015-01-16T12:30:45.678Z' })}`,
        'reports',
      );
      expect(Object.keys(res.body)).toEqual(['result', 'start', 'end', 'count', 'reports']);
      expect(res.body).toMatchObject({
        result: 'success',
        start: '2015-01-14T00:00:00Z',
        end: '2015-01-16T12:30:45Z',
        count: 3,
      });
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers.link).toBeUndefined();
    });

    it('has the keys of a report in the order of the route, and no payments unless asked for', async () => {
      const res = await okBody(api, path(SINGLE, '2015-01-14'), 'reports');
      expect(Object.keys(res.body.reports[0])).toEqual(Object.keys(ZERO_REPORT(SINGLE, '2015-01-14T00:00:00Z')));
      const withPayments = await okBody(api, `${path(SINGLE, '2015-01-14')}?payments=true`, 'reports');
      expect(Object.keys(withPayments.body.reports[0]).pop()).toBe('payments');
    });

    it('has a report for each day of the window, with zeros where nothing happened', async () => {
      const res = await okBody(api, `${path(SINGLE)}${qs({ start: '2015-01-12', end: '2015-01-17' })}`, 'reports');
      expect(res.body.count).toBe(6);
      expect(res.body.reports.map((r) => r.date)).toEqual([
        '2015-01-12T00:00:00Z',
        '2015-01-13T00:00:00Z',
        '2015-01-14T00:00:00Z',
        '2015-01-15T00:00:00Z',
        '2015-01-16T00:00:00Z',
        '2015-01-17T00:00:00Z',
      ]);
      for (const r of res.body.reports) {
        if (r.date.startsWith('2015-01-14')) expect(r.total_value).toBe('500');
        else expect(r).toEqual(ZERO_REPORT(SINGLE, r.date));
      }
    });

    it('is all zeros for an account that has no payment, for days with no ledger, and for days before the first', async () => {
      const unknown = await okBody(api, `${path(NOBODY)}${qs({ start: '2015-01-14', end: '2015-01-15' })}`, 'reports');
      expect(unknown.body.reports).toEqual([
        ZERO_REPORT(NOBODY, '2015-01-14T00:00:00Z'),
        ZERO_REPORT(NOBODY, '2015-01-15T00:00:00Z'),
      ]);
      // years the ledgers do not reach, before them and after
      for (const start of ['2005-03-01', '2030-01-01']) {
        const res = await okBody(api, `${path(SINGLE)}${qs({ start, end: start })}`, 'reports');
        expect(res.body.reports).toEqual([ZERO_REPORT(SINGLE, `${start}T00:00:00Z`)]);
      }
    });

    it('is the shared list behaviour: an empty window is zeros, unknown parameters are ignored, the first of a repeated one wins', async () => {
      const plain = await okBody(api, path(SINGLE, '2015-01-14'), 'reports');
      expect((await okBody(api, `${path(SINGLE, '2015-01-14')}?foo=bar`, 'reports')).body).toEqual(plain.body);
      expect(
        (
          await okBody(
            api,
            `${path(SINGLE, '2015-01-14')}?descending=true&descending=false&limit=1&marker=x`,
            'reports',
          )
        ).body,
      ).toEqual(plain.body);
      const repeated = await okBody(
        api,
        `${path(SINGLE)}?start=2015-01-14&start=bogus&end=2015-01-15&end=bogus`,
        'reports',
      );
      expect(repeated.body.count).toBe(2);
    });

    it('with descending, is the same reports the other way round', async () => {
      const window = { start: '2015-01-10', end: '2015-02-12' };
      const up = await okBody(api, `${path(MULTI)}${qs(window)}&accounts=true&payments=true`, 'reports');
      const down = await okBody(
        api,
        `${path(MULTI)}${qs({ ...window, descending: 'TRUE' })}&accounts=true&payments=true`,
        'reports',
      );
      expect(up.body.count).toBe(34);
      expect(down.body.reports).toEqual([...up.body.reports].reverse());
      expect(down.body.start).toBe(up.body.start);
      for (const flag of ['false', '0', '1', 'yes', '']) {
        const res = await okBody(api, `${path(MULTI)}${qs({ ...window, descending: flag })}`, 'reports');
        expect(res.body.reports.map((r) => r.date)).toEqual(up.body.reports.map((r) => r.date));
      }
    });

    it('without start and end, is the day of now', async () => {
      const today = (): string => new Date().toISOString().slice(0, 10);
      const before = today();
      const res = await okBody(api, path(SINGLE), 'reports');
      const after = today();
      expect(res.body.count).toBe(1);
      expect([before, after]).toContain(res.body.reports[0].date.slice(0, 10));
      expect(res.body.start).toBe(`${res.body.reports[0].date.slice(0, 10)}T00:00:00Z`);
      expect(Date.parse(res.body.end)).toBeLessThanOrEqual(Date.now());
      expect(res.body.reports[0]).toEqual(ZERO_REPORT(SINGLE, res.body.reports[0].date));
    });

    it('with a start and no end, runs to now', async () => {
      const start = new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10);
      const res = await okBody(api, `${path(SINGLE)}?start=${start}`, 'reports');
      expect(res.body.count).toBe(3);
      expect(res.body.reports.map((r) => r.date.slice(0, 10))[0]).toBe(start);
    });
  });

  describe('the window', () => {
    it('is cut back to the start of the day of the start when it is less than a day long', async () => {
      const res = await okBody(
        api,
        `${path(SINGLE)}${qs({ start: '2015-01-14T05:00:00', end: '2015-01-14T20:00:00' })}`,
        'reports',
      );
      expect(res.body).toMatchObject({ start: '2015-01-14T00:00:00Z', end: '2015-01-14T20:00:00Z', count: 1 });
      expect(res.body.reports[0].total_value).toBe('500');
      // an end before the start, by less than a day, is the same
      const backwards = await okBody(
        api,
        `${path(SINGLE)}${qs({ start: '2015-01-14T20:00:00', end: '2015-01-14T05:00:00' })}`,
        'reports',
      );
      expect(backwards.body.count).toBe(1);
      // ... but not when the day of the start is after the end
      const earlier = await okBody(
        api,
        `${path(SINGLE)}${qs({ start: '2015-01-15T00:30:00', end: '2015-01-14T23:50:00' })}`,
        'reports',
      );
      expect(earlier.body).toMatchObject({ count: 0, reports: [] });
    });

    it('has the reports of the UTC days it touches when the start has a time of day (the original gave zeros for all)', async () => {
      const res = await okBody(
        api,
        `${path(SINGLE)}${qs({ start: '2015-01-14T05:00:00', end: '2015-01-16T03:00:00' })}`,
        'reports',
      );
      expect(res.body.start).toBe('2015-01-14T05:00:00Z');
      expect(res.body.reports.map((r) => [r.date, r.total_value])).toEqual([
        ['2015-01-14T00:00:00Z', '500'],
        ['2015-01-15T00:00:00Z', '0'],
        ['2015-01-16T00:00:00Z', '0'],
      ]);
    });

    it('has no reports when the end is a day or more before the start', async () => {
      const res = await okBody(api, `${path(SINGLE)}${qs({ start: '2015-01-16', end: '2015-01-14' })}`, 'reports');
      expect(res.body).toMatchObject({
        result: 'success',
        count: 0,
        reports: [],
        start: '2015-01-16T00:00:00Z',
        end: '2015-01-14T00:00:00Z',
      });
    });

    it('is at most 200 days: 201 reports, and 400 for more, whichever way round', async () => {
      const ok = await okBody(api, `${path(SINGLE)}${qs({ start: '2015-01-01', end: '2015-07-20' })}`, 'reports');
      expect(ok.body.count).toBe(201);
      expect(ok.body.reports.find((r) => r.date.startsWith('2015-01-14'))?.total_value).toBe('500');
      for (const range of [
        { start: '2015-01-01', end: '2015-07-21' },
        { start: '2015-07-21', end: '2015-01-01' },
      ]) {
        const res = await get(`${path(SINGLE)}${qs(range)}`);
        expect([range, res.status, res.body]).toEqual([
          range,
          400,
          { result: 'error', message: 'choose a date range less than 200 days' },
        ]);
      }
    });

    it('takes every format of a date the API accepts, and unix seconds, for the date in the path', async () => {
      for (const date of [
        '2015-01-14',
        '2015-01-14T12:30:00',
        '2015-01-14T12:30:00Z',
        '2015-01-14T12:30:00.000Z',
        '2015-01-14T12',
        '20150114123000',
        '1421238600',
      ]) {
        const res = await okBody(api, path(SINGLE, date), 'reports');
        expect([date, res.body.reports.map((r) => r.date)]).toEqual([date, ['2015-01-14T00:00:00Z']]);
      }
      expect((await okBody(api, path(SINGLE, '2015-01'), 'reports')).body.reports[0].date).toBe('2015-01-01T00:00:00Z');
      expect((await okBody(api, path(SINGLE, '2015'), 'reports')).body.reports[0].date).toBe('2015-01-01T00:00:00Z');
    });

    it('is the one day of the date in the path, whatever start and end say (even when they are not dates)', async () => {
      const res = await okBody(api, `${path(SINGLE, '2015-01-14')}${qs({ start: 'bogus', end: '1999' })}`, 'reports');
      expect(res.body).toMatchObject({ count: 1, start: '2015-01-14T00:00:00Z', end: '2015-01-14T00:00:00Z' });
    });

    it('answers the checks in the order of the original: start, end, then the length', async () => {
      const message = async (query: Record<string, string>): Promise<string> =>
        (await get(`${path(SINGLE)}${qs(query)}`)).body.message;
      expect(await message({ start: 'a', end: 'b' })).toBe('invalid date format');
      expect(await message({ start: '2010-01-01', end: 'b' })).toBe('invalid end date format');
      expect(await message({ start: '', end: '2015-01-15' })).toBe('invalid date format');
      expect(await message({ start: '2015-01-15', end: '' })).toBe('invalid end date format');
      expect(await message({ start: '2015-02-30', end: '2015-03-01' })).toBe('invalid date format');
    });

    it('reads nothing for a request that is wrong, or that has no day', async () => {
      const wrong = await queriesOf(async () => {
        await get(`${path(SINGLE)}?start=nope`);
        await get(`${path(SINGLE)}${qs({ start: '2014-01-01', end: '2015-01-01' })}`);
        await get(`${path(SINGLE)}${qs({ start: '2015-01-16', end: '2015-01-14' })}`);
      });
      expect(wrong).toEqual([]);
    });
  });

  // -- the flags ----------------------------------------------------------------------------------------------------

  describe('accounts and payments', () => {
    const DAY = '2015-01-14';

    it('accounts gives the counterparties themselves, in the order they first appear; the count otherwise', async () => {
      const counted = (await okBody(api, path(MULTI, DAY), 'reports')).body.reports[0];
      const listed = (await okBody(api, `${path(MULTI, DAY)}?accounts=true`, 'reports')).body.reports[0];
      const expected = expectedReport(MULTI, DAY);
      expect(counted).toMatchObject({
        receiving_counterparties: expected.receiving.length,
        sending_counterparties: expected.sending.length,
      });
      expect(listed).toMatchObject({
        receiving_counterparties: expected.receiving,
        sending_counterparties: expected.sending,
      });
      expect(listed.receiving_counterparties).toEqual([EUR_ONLY]);
      expect(listed.sending_counterparties).toEqual([CNY_SENDER]);
    });

    it('counterparties is an alias of accounts', async () => {
      const accounts = await okBody(api, `${path(MULTI, DAY)}?accounts=true`, 'reports');
      const alias = await okBody(api, `${path(MULTI, DAY)}?counterparties=true`, 'reports');
      expect(alias.body).toEqual(accounts.body);
      // accounts=false does not stop the alias, as the original read them
      const both = await okBody(api, `${path(MULTI, DAY)}?accounts=false&counterparties=true`, 'reports');
      expect(Array.isArray(both.body.reports[0].sending_counterparties)).toBe(true);
    });

    it('a flag is on when its text has "true" in it, in any case, as in the original', async () => {
      for (const [flag, on] of [
        ['true', true],
        ['TRUE', true],
        ['True', true],
        ['xtruex', true],
        ['1', false],
        ['yes', false],
        ['false', false],
        ['', false],
      ] as const) {
        const res = await okBody(api, `${path(MULTI, DAY)}${qs({ accounts: flag, payments: flag })}`, 'reports');
        expect([
          flag,
          Array.isArray(res.body.reports[0].sending_counterparties),
          res.body.reports[0].payments !== undefined,
        ]).toEqual([flag, on, on]);
      }
    });

    it('payments gives each payment of the day as {tx_hash, amount, currency, issuer, type}, in the order of the ledgers', async () => {
      const res = (await okBody(api, `${path(MULTI, DAY)}?payments=true`, 'reports')).body.reports[0];
      expect(res.payments).toHaveLength(36 + 23);
      expect(res.payments?.map((p) => p.type)).toEqual(expectedReport(MULTI, DAY).report.payments?.map((p) => p.type));
      const cny = res.payments?.find((p) => p.currency === 'CNY');
      expect(cny).toEqual({
        tx_hash: expect.stringMatching(/^[0-9A-F]{64}$/),
        amount: expect.any(String),
        currency: 'CNY',
        issuer: KIC,
        type: 'received',
      });
      expect(Object.keys(cny ?? {})).toEqual(['tx_hash', 'amount', 'currency', 'issuer', 'type']);
      // the amount is the delivered amount, as a string, and the native currency has no issuer
      const xrp = (await okBody(api, `${path(SINGLE, DAY)}?payments=true`, 'reports')).body.reports[0].payments?.[0];
      expect(xrp).not.toHaveProperty('issuer');
      expect(typeof xrp?.amount).toBe('string');
    });

    it('payments_sent and payments_received count the payments of the list', async () => {
      const res = (await okBody(api, `${path(MULTI, DAY)}?payments=true`, 'reports')).body.reports[0];
      expect(res.payments_sent).toBe(23);
      expect(res.payments_received).toBe(36);
      expect(res.payments?.filter((p) => p.type === 'sent')).toHaveLength(23);
    });
  });

  // -- the values ---------------------------------------------------------------------------------------------------

  describe('the values of a report', () => {
    it('are, for every account and every active day of the mock ledgers, those of the oracle of accountPayments.js', async () => {
      expect(ACTIVE.length).toBe(164);
      let issued = 0;
      let rated = 0;
      for (const { account, day } of ACTIVE) {
        const res = await okBody(api, `${path(account, day)}?accounts=true&payments=true`, 'reports');
        expect(res.body.count).toBe(1);
        const expected = expectedReport(account, day);
        expectMatches(res.body.reports[0], expected, `${account} ${day}`);
        if (expected.report.payments?.some((p) => p.issuer)) issued++;
        if (
          expected.values.total > 0 &&
          expected.report.payments?.some((p) => p.currency === 'CNY' && p.issuer === KIC) &&
          day === '2015-01-14'
        )
          rated++;
      }
      // the comparison was not of zeros
      expect(issued).toBeGreaterThanOrEqual(5);
      expect(rated).toBe(2);
    });

    it('add up the native payments exactly', async () => {
      // 2 + 1 XRP payments of the busiest XRP account of the day; the sum has no float noise
      const day = '2015-01-14';
      const xrp = ACTIVE.filter((a) => a.day === day)
        .map(({ account }) => ({ account, rows: rowsOf(account, day).filter((r) => r.currency === 'XRP') }))
        .sort((a, b) => b.rows.length - a.rows.length)[0];
      const res = (await okBody(api, path(xrp.account, day), 'reports')).body.reports[0];
      const sum = (direction: string): BigNumber =>
        xrp.rows
          .filter((r) => r.direction === direction)
          .reduce((total, r) => total.plus(r.delivered_amount), new BigNumber(0));
      expect(res.total_value_sent).toBe(sum('sent').toString());
      expect(res.total_value_received).toBe(sum('received').toString());
      expect(res.total_value).toBe(sum('sent').plus(sum('received')).toString());
    });

    it('count an issued currency by its rate of the day: the payments of CNY on the day of its trades', async () => {
      // the 13 trades of CNY for XRP, but for the ones of 0.0005 XRP or less, which no rate counts (rounding noise)
      const all = EXCHANGES.filter(
        (e) => e.base_currency === 'CNY' && e.base_issuer === KIC && e.counter_currency === 'XRP',
      );
      expect(all).toHaveLength(13);
      const trades = all.filter((e) => e.counter_amount_f > 0.0005);
      expect(trades.length).toBeGreaterThanOrEqual(10);
      const cny = trades.reduce((total, e) => total.plus(e.base_amount), new BigNumber(0));
      const xrp = trades.reduce((total, e) => total.plus(e.counter_amount), new BigNumber(0));
      const sent = (await okBody(api, path(CNY_SENDER, '2015-01-14'), 'reports')).body.reports[0];
      const amounts = rowsOf(CNY_SENDER, '2015-01-14').map((r) => new BigNumber(r.delivered_amount));
      // total = Σ amount / (CNY per XRP) = Σ amount * XRP / CNY
      const total = amounts
        .reduce((t, a) => t.plus(a), new BigNumber(0))
        .times(xrp)
        .dividedBy(cny);
      const high = BigNumber.max(...amounts)
        .times(xrp)
        .dividedBy(cny);
      expect(new BigNumber(sent.total_value_sent).minus(total).abs().toNumber()).toBeLessThan(1e-12);
      expect(new BigNumber(sent.high_value_sent).minus(high).abs().toNumber()).toBeLessThan(1e-12);
      expect(sent.total_value).toBe(sent.total_value_sent);
      expect(Number(sent.total_value_sent)).toBeGreaterThan(0);
      expect(sent).toMatchObject({ high_value_received: '0', total_value_received: '0', payments_sent: 36 });
    });

    it('count an issued currency with no rate as 0, and still count its payments', async () => {
      // 23 EUR from an issuer whose pair has 2 trades: no rate in strict mode
      const res = (await okBody(api, path(EUR_ONLY, '2015-01-14'), 'reports')).body.reports[0];
      expect(res).toMatchObject({
        high_value_received: '0',
        high_value_sent: '0',
        total_value_received: '0',
        total_value_sent: '0',
        total_value: '0',
        payments_received: 23,
        payments_sent: 0,
        sending_counterparties: 1,
      });
      // CCK has no trades at all, and 2017's CNY none within days of it
      const cck = (await okBody(api, path('rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj', '2015-02-09'), 'reports')).body
        .reports[0];
      expect(cck).toMatchObject({ total_value: '0', payments_received: 20 });
      const later = (await okBody(api, path('rPcQaiyDxMwLr7Q9eFmn5VnVx2RN57MUmN', '2017-05-12'), 'reports')).body
        .reports[0];
      expect(later).toMatchObject({ total_value: '0', payments_sent: 1 });
    });

    it('add the native payments to those of the currencies that have a rate', async () => {
      const res = (await okBody(api, `${path(MULTI)}${qs({ start: '2015-01-13', end: '2015-01-15' })}`, 'reports')).body
        .reports;
      expect(res.map((r) => r.payments_sent + r.payments_received)).toEqual([0, 59, 0]);
      expect(res[1].total_value).toBe(
        new BigNumber(res[1].total_value_received).plus(res[1].total_value_sent).toString(),
      );
      expect(Number(res[1].total_value_received)).toBeGreaterThan(0);
    });
  });

  // -- CSV ----------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('is text/csv with a row for each report (the original wrote the envelope as one wide row), named after the account', async () => {
      const res = await get(`${path(SINGLE)}${qs({ start: '2015-01-13', end: '2015-01-15', format: 'csv' })}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${SINGLE} - reports`));
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 3);
      expect(rows[0].split(',')).toEqual([
        '"account"',
        '"date"',
        '"high_value_received"',
        '"high_value_sent"',
        '"total_value_received"',
        '"total_value_sent"',
        '"total_value"',
        '"payments_sent"',
        '"payments_received"',
        '"receiving_counterparties"',
        '"sending_counterparties"',
      ]);
      expect(rows[2].split(',')).toEqual([
        `"${SINGLE}"`,
        '"2015-01-14T00:00:00Z"',
        '"500"',
        '"0"',
        '"500"',
        '"0"',
        '"500"',
        '"0"',
        '"1"',
        '"0"',
        '"1"',
      ]);
      expect(res.text).not.toContain('reports[0]');
      expect(res.text).not.toContain('"result"');
    });

    it('joins the counterparties with a comma and a space with accounts', async () => {
      const res = await get(`${path(MULTI, '2015-01-14')}?accounts=true&format=csv`);
      const [header, row] = lines(res.text);
      const columns = header.split('","');
      expect(columns[columns.length - 2]).toBe('receiving_counterparties');
      expect(row).toContain(`"${EUR_ONLY}"`);
      expect(row.endsWith(`"${CNY_SENDER}"`)).toBe(true);
      // more than one counterparty in a cell
      const busy = ACTIVE.map((a) => ({ ...a, e: expectedReport(a.account, a.day) })).find(
        (a) => a.e.receiving.length > 1,
      );
      if (busy) {
        const text = (await get(`${path(busy.account, busy.day)}?accounts=true&format=csv`)).text;
        expect(text).toContain(`"${busy.e.receiving.join(', ')}"`);
      }
    });

    it('flattens the payments into columns of their own', async () => {
      const res = await get(`${path(SINGLE, '2015-01-14')}?payments=true&format=csv`);
      const [header, row] = lines(res.text);
      expect(header.split(',')).toEqual(
        expect.arrayContaining([
          '"payments[0].tx_hash"',
          '"payments[0].amount"',
          '"payments[0].currency"',
          '"payments[0].type"',
        ]),
      );
      expect(header).not.toContain('payments[0].issuer');
      expect(row).toContain('"500"');
    });

    it('descending reverses the rows, and the format is not case-sensitive; anything else is JSON', async () => {
      const window = { start: '2015-01-13', end: '2015-01-15' };
      const up = lines((await get(`${path(SINGLE)}${qs({ ...window, format: 'CSV' })}`)).text);
      const down = lines((await get(`${path(SINGLE)}${qs({ ...window, format: 'csv', descending: true })}`)).text);
      expect(down.slice(1)).toEqual(up.slice(1).reverse());
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${path(SINGLE, '2015-01-14')}${qs({ format })}`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('an error is still JSON', async () => {
      const res = await get(`${path(SINGLE)}?start=nope&format=csv`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ result: 'error', message: 'invalid date format' });
    });

    it('with no day is an empty CSV', async () => {
      const res = await get(`${path(SINGLE)}${qs({ start: '2015-01-16', end: '2015-01-14', format: 'csv' })}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.text).toBe('');
    });
  });

  // -- what is read -------------------------------------------------------------------------------------------------

  describe('the tables a request reads', () => {
    const DAY = '2015-01-14';

    /** The first ledger that closed on the day and the last one that did. */
    const ledgersOf = (day: string): { min: number; max: number } => {
      const start = Date.parse(`${day}T00:00:00Z`) / 1000;
      const inDay = fixtureSource('ripple-mock')
        .list()
        .filter((l) => l.header.close_time >= start && l.header.close_time < start + 86_400)
        .map((l) => l.header.ledger_index);
      return { min: Math.min(...inDay), max: Math.max(...inDay) };
    };

    it('are account_payments by a range of ledgers found once, and exchanges only for the issued currencies seen', async () => {
      const calls = await queriesOf(() => api.ok(`${path(CNY_SENDER, DAY)}?accounts=true&payments=true`, 'reports'));
      const payments = calls.filter((c) => c.sql.includes(Table.AccountPayments));
      expect(payments.length).toBeGreaterThanOrEqual(1);
      for (const call of payments) {
        expect(call.params).toMatchObject({ account: CNY_SENDER, ...ledgersOf(DAY) });
        expect(call.sql).toContain('ledger_index BETWEEN {min:UInt32} AND {max:UInt32}');
        expect(call.sql).not.toMatch(/\bFINAL\b/);
        expect(call.sql).not.toContain(CNY_SENDER);
      }
      // the ledgers table is asked for the range, and the exchanges for the rate of CNY alone
      const exchanges = calls.filter((c) => c.sql.includes(`FROM ${Table.Exchanges}`));
      expect(exchanges.length).toBeGreaterThanOrEqual(1);
      const values = exchanges.flatMap((c) => Object.values(c.params).filter((v) => typeof v === 'string'));
      expect(values).toContain(KIC);
      expect(values).not.toContain(MWJ);
      expect(calls.some((c) => new RegExp(`FROM (${Table.Payments}|${Table.Transactions})\\b`).test(c.sql))).toBe(
        false,
      );
    });

    it('are no exchanges when only the native currency is seen, nor a day with no payments', async () => {
      const native = await queriesOf(() => api.ok(path(SINGLE, DAY), 'reports'));
      expect(native.some((c) => c.sql.includes(Table.AccountPayments))).toBe(true);
      expect(native.some((c) => c.sql.includes(Table.Exchanges))).toBe(false);
      const empty = await queriesOf(() => api.ok(path(CNY_SENDER, '2015-01-20'), 'reports'));
      expect(empty.some((c) => c.sql.includes(Table.Exchanges))).toBe(false);
    });

    it('do not hold the rows of the payments or the counterparties unless asked for', async () => {
      const plain = await queriesOf(() => api.ok(path(MULTI, DAY), 'reports'));
      const full = await queriesOf(() => api.ok(`${path(MULTI, DAY)}?accounts=true&payments=true`, 'reports'));
      const reads = (calls: typeof plain): number => calls.filter((c) => c.sql.includes(Table.AccountPayments)).length;
      expect(reads(plain)).toBe(2);
      expect(reads(full)).toBe(3);
      expect(plain.filter((c) => c.sql.includes('tx_hash')).length).toBe(0);
    });

    it('read account_payments through the primary key, in the order of the key, with no sort of the rows', async () => {
      const calls = await queriesOf(() => api.ok(`${path(MULTI, DAY)}?accounts=true&payments=true`, 'reports'));
      const payments = calls.filter((c) => c.sql.includes(Table.AccountPayments));
      expect(payments).toHaveLength(3);
      const explain = async (what: string, sql: string, params: Record<string, unknown>): Promise<string> =>
        (await h.ch.query<{ explain: string }>(`${what} ${sql}`, params)).map((r) => r.explain).join('\n');
      for (const call of payments) {
        // the rows are read in the order of the key of the table ...
        const whole = await explain('EXPLAIN PIPELINE', call.sql, call.params);
        expect(whole).toContain('ReadPoolInOrder');
        expect(whole).toContain('algorithm: InOrder');
        // ... which is all `LIMIT 1 BY` needs: the read itself (the subquery of the aggregates, or the whole query of the
        // payments) has no sort. (The counterparties are sorted after they are grouped: one row for each of them.)
        const read = /FROM \(\s*(SELECT[\s\S]*?LIMIT 1 BY ledger_index, tx_index)\s*\)/.exec(call.sql)?.[1] ?? call.sql;
        const pipeline = await explain('EXPLAIN PIPELINE', read, call.params);
        expect(pipeline).toContain('ReadPoolInOrder');
        expect(pipeline).not.toContain('PartialSortingTransform');
        expect(pipeline).not.toContain('MergeSortingTransform');
        const indexes = await explain('EXPLAIN indexes = 1', read, call.params);
        expect(indexes).toContain('PrimaryKey');
        expect(indexes).toMatch(/Keys:\s+account/);
      }
    });
  });

  // -- failures -----------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    const FAILURE = { result: 'error', message: 'unable to retrieve payments' };

    it('is 500 unable to retrieve payments (the message of the original)', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
      const res = await get(path(SINGLE, '2015-01-14'));
      expect([res.status, res.body]).toEqual([500, FAILURE]);
    });

    it('also when a later query fails, after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      jest
        .spyOn(h.ch, 'query')
        .mockImplementation(((sql: string, ...rest: unknown[]) =>
          sql.includes(Table.AccountPayments)
            ? Promise.reject(new Error('boom'))
            : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as typeof h.ch.query);
      const res = await get(`${path(MULTI, '2015-01-14')}?accounts=true&payments=true`);
      expect([res.status, res.body]).toEqual([500, FAILURE]);
    });

    it('also when the rates fail', async () => {
      const real = h.ch.query.bind(h.ch);
      jest
        .spyOn(h.ch, 'query')
        .mockImplementation(((sql: string, ...rest: unknown[]) =>
          sql.includes(`FROM ${Table.Exchanges}`)
            ? Promise.reject(new Error('boom'))
            : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as typeof h.ch.query);
      const res = await get(path(CNY_SENDER, '2015-01-14'));
      expect([res.status, res.body]).toEqual([500, FAILURE]);
      // the native-only day does not need them
      expect((await get(path(SINGLE, '2015-01-14'))).status).toBe(200);
    });

    it('a request that is wrong stays a 400 of its own', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      expect((await get(`${path(SINGLE)}?start=nope`)).status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account reports API endpoint when rows were written twice', () => {
  // `account_payments` and `exchanges` are ReplacingMergeTree and the reports never use FINAL, so until a merge a row can
  // be there twice (the syncer re-writes a ledger it is not sure about). One insert of a row twice would be collapsed by
  // ClickHouse on the way in (`optimize_on_insert`), so the copy is a second insert, without deduplication, with the
  // merges stopped.
  let h: Harness;
  let api: ApiClient;
  const requests = [
    `${path(MULTI)}${qs({ start: '2015-01-13', end: '2015-01-15' })}&accounts=true&payments=true`,
    `${path(CNY_SENDER, '2015-01-14')}?payments=true`,
    `${path(SINGLE)}${qs({ start: '2015-01-12', end: '2015-01-17' })}`,
    `${path('rBeToNo4AwHaNbRX2n4BNCYKtpTyFLQwkj', '2015-02-09')}?accounts=true`,
  ];
  let once: Body[] = [];

  const count = async (table: Table): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    once = [];
    for (const url of requests) once.push((await okBody(api, url, 'reports')).body);
    for (const table of [Table.AccountPayments, Table.Exchanges]) {
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

  it('counts every payment once: the same reports as before the copy', async () => {
    expect(once[0].reports[1].payments_sent + once[0].reports[1].payments_received).toBe(59);
    for (const [i, url] of requests.entries()) {
      expect([url, (await okBody(api, url, 'reports')).body]).toEqual([url, once[i]]);
    }
  });

  it('counts every exchange of the rate once: 13 trades are not 26 (and 5 are not 10)', async () => {
    const res = (await okBody(api, requests[1], 'reports')).body.reports[0];
    expect(Number(res.total_value_sent)).toBeGreaterThan(0);
    expect(res).toEqual(once[1].reports[0]);
  });

  it('counts the counterparties and the payments of a day once, in their order', async () => {
    const res = (await okBody(api, `${path(MULTI, '2015-01-14')}?accounts=true&payments=true`, 'reports')).body
      .reports[0];
    expect(res.payments).toHaveLength(59);
    expect(new Set(res.payments?.map((p) => p.tx_hash)).size).toBe(59);
    expect(res.receiving_counterparties).toEqual([EUR_ONLY]);
    expect(res.sending_counterparties).toEqual([CNY_SENDER]);
  });

  it('makes a rate of the exchanges once: 6 trades written twice are 6, not the 10 strict mode asks for', async () => {
    const issuer = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
    const payee = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
    const closes = Array.from({ length: 6 }, (_, i) => Date.UTC(2021, 5, 1, 12, 0, i) / 1000);
    const paid = Date.UTC(2021, 5, 1, 13, 0, 0) / 1000;
    await h.ch.insert(Table.Ledgers, [
      ...closes.map((close_time, i) => ({
        ledger_index: 90_000_000 + i,
        ledger_hash: `${i}`.padStart(64, 'C'),
        close_time,
      })),
      { ledger_index: 90_000_100, ledger_hash: 'D'.repeat(64), close_time: paid },
    ]);
    await h.ch.insert(
      Table.Exchanges,
      closes.map(
        (close_time, i): ExchangesRow => ({
          base_currency: 'USD',
          base_issuer: issuer,
          counter_currency: 'XRP',
          counter_issuer: '',
          ledger_index: 90_000_000 + i,
          tx_index: 1,
          node_index: 1,
          tx_hash: `${i}`.padStart(64, 'A'),
          close_time,
          base_amount: '10',
          counter_amount: '5',
          base_amount_f: 10,
          counter_amount_f: 5,
          rate: '0.5',
          rate_f: 0.5,
          buyer: payee,
          seller: payee,
          taker: payee,
          provider: payee,
          offer_sequence: 1,
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        }),
      ),
    );
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE base_issuer = {issuer:String}`,
      { issuer },
      { settings: { insert_deduplicate: 0 } },
    );
    const trades = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Exchanges} WHERE base_issuer = {issuer:String}`,
      { issuer },
    );
    expect(Number(trades[0].n)).toBe(12);
    await h.ch.insert(Table.AccountPayments, [
      {
        account: payee,
        ledger_index: 90_000_100,
        tx_index: 1,
        tx_hash: 'E'.repeat(64),
        close_time: paid,
        direction: 'received',
        counterparty: issuer,
        currency: 'USD',
        issuer,
        delivered_amount: '10',
        delivered_amount_f: 10,
        source_tag: null,
        destination_tag: null,
      } satisfies AccountPaymentsRow,
    ]);

    const report = (await okBody(api, path(payee, '2021-06-01'), 'reports')).body.reports[0];
    expect(report).toMatchObject({ payments_received: 1, total_value_received: '0', total_value: '0' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account reports computed from synthetic ledgers', () => {
  const A = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
  const B = 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7';
  const C = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  const D = 'rPcQaiyDxMwLr7Q9eFmn5VnVx2RN57MUmN';
  const E = 'rGmFH7pyrKs7E84MkGmgKc1gnsx6ZbWDwB';
  const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

  interface Pay {
    time: string;
    from: string;
    to: string;
    currency: string;
    issuer?: string;
    amount: string;
  }
  const PAYS: Pay[] = [
    { time: '2020-03-01T10:00:00Z', from: B, to: A, currency: 'USD', issuer: ISSUER, amount: '10' }, // before any rate
    { time: '2020-03-02T08:00:00Z', from: A, to: C, currency: 'USD', issuer: ISSUER, amount: '4' },
    { time: '2020-03-02T09:00:00Z', from: B, to: A, currency: 'USD', issuer: ISSUER, amount: '6' },
    { time: '2020-03-02T10:00:00Z', from: A, to: C, currency: 'XRP', amount: '0.1' },
    { time: '2020-03-02T11:00:00Z', from: A, to: C, currency: 'XRP', amount: '0.2' },
    { time: '2020-03-02T12:00:00Z', from: A, to: D, currency: 'XRP', amount: '0.2' },
    { time: '2020-03-04T12:00:00Z', from: A, to: A, currency: 'XRP', amount: '5' }, // to itself
    { time: '2020-03-04T13:00:00Z', from: A, to: B, currency: 'USD', amount: '100' }, // an issued currency without an issuer
    { time: '2020-03-04T23:59:59Z', from: A, to: E, currency: 'XRP', amount: '1' },
    { time: '2020-03-05T00:00:00Z', from: E, to: A, currency: 'XRP', amount: '2' },
    { time: '2020-03-20T10:00:00Z', from: B, to: A, currency: 'USD', issuer: ISSUER, amount: '7' },
    { time: '2020-03-21T10:00:00Z', from: B, to: A, currency: 'XRP', amount: '1e+40' }, // more than a decimal holds
    { time: '2020-03-21T11:00:00Z', from: B, to: A, currency: 'XRP', amount: '0.5' },
  ];
  // 12 trades of 10 USD against 5 XRP (2 USD per XRP) on 2020-03-02, and 12 of 10 USD against 10 XRP on 2020-03-20
  const TRADES = [
    ...Array.from({ length: 12 }, (_, i) => ({ time: Date.parse('2020-03-02T12:30:00Z') + i * 1000, xrp: '5' })),
    ...Array.from({ length: 12 }, (_, i) => ({ time: Date.parse('2020-03-20T12:30:00Z') + i * 1000, xrp: '10' })),
  ];

  let h: Harness;
  let api: ApiClient;

  const window = { start: '2020-03-01', end: '2020-03-21' };
  const reportsOf = async (extra = ''): Promise<Report[]> =>
    (await okBody(api, `${path(A)}${qs(window)}${extra}`, 'reports')).body.reports;
  const dayReport = async (day: string, extra = ''): Promise<Report> =>
    (await okBody(api, `${path(A, day)}${extra}`, 'reports')).body.reports[0];

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    // ledger indexes follow close times
    const times = [...new Set([...PAYS.map((p) => Date.parse(p.time)), ...TRADES.map((t) => t.time)])].sort(
      (a, b) => a - b,
    );
    const ledgerOf = new Map(times.map((t, i) => [t, 5_000_000 + i]));
    await h.ch.insert(
      Table.Ledgers,
      times.map((t) => ({
        ledger_index: ledgerOf.get(t),
        ledger_hash: `${ledgerOf.get(t)}`.padStart(64, 'C'),
        close_time: t / 1000,
      })),
    );
    const rows: AccountPaymentsRow[] = PAYS.flatMap((p, i) => {
      const shared = {
        ledger_index: ledgerOf.get(Date.parse(p.time)) as number,
        tx_index: i + 1,
        tx_hash: `${i + 1}`.padStart(64, 'A'),
        close_time: Date.parse(p.time) / 1000,
        currency: p.currency,
        issuer: p.issuer ?? '',
        delivered_amount: p.amount,
        delivered_amount_f: Number(p.amount),
        source_tag: null,
        destination_tag: null,
      };
      return [
        { account: p.from, direction: 'sent' as const, counterparty: p.to, ...shared },
        { account: p.to, direction: 'received' as const, counterparty: p.from, ...shared },
      ];
    });
    await h.ch.insert(Table.AccountPayments, rows);
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
          base_amount: '10',
          counter_amount: t.xrp,
          base_amount_f: 10,
          counter_amount_f: Number(t.xrp),
          rate: String(Number(t.xrp) / 10),
          rate_f: Number(t.xrp) / 10,
          buyer: B,
          seller: C,
          taker: C,
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

  it('has a report for each of the 21 days, in order, and zeros where nothing happened', async () => {
    const reports = await reportsOf();
    expect(reports).toHaveLength(21);
    expect(reports[0].date).toBe('2020-03-01T00:00:00Z');
    expect(reports[20].date).toBe('2020-03-21T00:00:00Z');
    for (const day of ['2020-03-03', '2020-03-10', '2020-03-19']) {
      expect(reports.find((r) => r.date.startsWith(day))).toEqual(ZERO_REPORT(A, `${day}T00:00:00Z`));
    }
  });

  it('counts an issued currency before its first trades as 0, and still counts the payment', async () => {
    expect(await dayReport('2020-03-01')).toEqual({
      ...ZERO_REPORT(A, '2020-03-01T00:00:00Z'),
      payments_received: 1,
      sending_counterparties: 1,
    });
  });

  it('adds the issued currency at the rate of its day to exact native amounts: 0.1 + 0.2 + 0.2 is 0.5, not 0.5000000000000001', async () => {
    // 4 USD sent at 2 USD per XRP are 2 XRP, 0.5 XRP more are sent in three payments; 6 USD received are 3 XRP
    expect(await dayReport('2020-03-02', '?accounts=true')).toEqual({
      account: A,
      date: '2020-03-02T00:00:00Z',
      high_value_received: '3',
      high_value_sent: '2',
      total_value_received: '3',
      total_value_sent: '2.5',
      total_value: '5.5',
      payments_sent: 4,
      payments_received: 1,
      // C first (it was paid first, in USD), then D; the payments of the other accounts are not the account's
      receiving_counterparties: [C, D],
      sending_counterparties: [B],
    });
  });

  it('counts a payment to oneself once, as sent, with the account among its own counterparties', async () => {
    const report = await dayReport('2020-03-04', '?accounts=true&payments=true');
    // 5 XRP to oneself and 1 XRP to E, and 100 of an issued currency without an issuer, which count as 0
    expect(report).toMatchObject({
      high_value_sent: '5',
      total_value_sent: '6',
      total_value: '6',
      payments_sent: 3,
      payments_received: 0,
      receiving_counterparties: [A, B, E],
      sending_counterparties: [],
    });
    expect(report.payments?.map((p) => [p.type, p.currency, p.amount])).toEqual([
      ['sent', 'XRP', '5'],
      ['sent', 'USD', '100'],
      ['sent', 'XRP', '1'],
    ]);
    expect(report.payments?.[1]).not.toHaveProperty('issuer');
  });

  it('puts a payment on the UTC day it closed: 23:59:59 on one, 00:00:00 on the next', async () => {
    expect(await dayReport('2020-03-04')).toMatchObject({ total_value_sent: '6', total_value_received: '0' });
    expect(await dayReport('2020-03-05')).toEqual({
      ...ZERO_REPORT(A, '2020-03-05T00:00:00Z'),
      high_value_received: '2',
      total_value_received: '2',
      total_value: '2',
      payments_received: 1,
      sending_counterparties: 1,
    });
  });

  it('uses the rate of the day: the same currency, another day, another rate', async () => {
    // 2020-03-20: 12 trades of 10 USD for 10 XRP, 1 USD per XRP
    expect(await dayReport('2020-03-20')).toMatchObject({
      high_value_received: '7',
      total_value_received: '7',
      total_value: '7',
    });
  });

  it('adds up amounts a decimal cannot hold as floats', async () => {
    // 1e40 XRP and 0.5 XRP: the float sum is 1e40
    expect(await dayReport('2020-03-21')).toMatchObject({
      high_value_received: '1e+40',
      total_value_received: '1e+40',
      payments_received: 2,
    });
  });

  it('is the same for a day on its own and for the day within a window', async () => {
    const reports = await reportsOf('&accounts=true&payments=true');
    for (const day of ['2020-03-01', '2020-03-02', '2020-03-04', '2020-03-05', '2020-03-20', '2020-03-21']) {
      expect(reports.find((r) => r.date.startsWith(day))).toEqual(await dayReport(day, '?accounts=true&payments=true'));
    }
  });

  it('asks the rates for the issued currencies seen: none for a day of XRP only', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    await api.ok(path(A, '2020-03-05'), 'reports');
    expect(spy.mock.calls.some(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`))).toBe(false);
    spy.mockClear();
    await api.ok(path(A, '2020-03-20'), 'reports');
    expect(spy.mock.calls.some(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`))).toBe(true);
    spy.mockRestore();
  });

  it('is not the report of another account', async () => {
    const b = (await okBody(api, `${path(B)}${qs(window)}`, 'reports')).body.reports.find((r) =>
      r.date.startsWith('2020-03-02'),
    );
    expect(b).toMatchObject({ payments_sent: 1, payments_received: 0, total_value_sent: '3' });
  });

  it('counts a payment to oneself the same, once and as sent, after a merge: both of its rows are kept (R112)', async () => {
    // the original counted it as the sender's only (`payment.account === payment.data.source` is tested first, and the
    // receiver's side is what is left): so does the report, whichever of the two rows it reads
    const before = await dayReport('2020-03-04', '?accounts=true&payments=true');
    await h.ch.command(`OPTIMIZE TABLE ${Table.AccountPayments} FINAL`);
    const tx = PAYS.findIndex((p) => p.from === p.to) + 1;
    const stored = await h.ch.query<{ direction: string }>(
      `SELECT direction FROM ${Table.AccountPayments} WHERE account = {account:String} AND tx_index = {tx:UInt32}
        ORDER BY direction`,
      { account: A, tx },
    );
    expect(stored.map((r) => r.direction)).toEqual(['sent', 'received']);

    const after = await dayReport('2020-03-04', '?accounts=true&payments=true');
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      payments_sent: 3,
      payments_received: 0,
      receiving_counterparties: [A, B, E],
      sending_counterparties: [],
    });
    expect(after.payments?.map((p) => [p.type, p.currency, p.amount])).toEqual([
      ['sent', 'XRP', '5'],
      ['sent', 'USD', '100'],
      ['sent', 'XRP', '1'],
    ]);
    // the side of the other days did not move either
    expect(await dayReport('2020-03-05')).toMatchObject({ payments_received: 1, payments_sent: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('account reports on Xahau (XAH is the native currency)', () => {
  const rows = fixtureAccountPayments('xahau-recorded');
  const BUSY = 'rmv53yu8Wid6kj6AC6NvmiwSXNxRa8vTH'; // 68 payments of XAH on 2026-10-15
  const DAY = '2026-10-15';
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('counts XAH as itself, summed exactly', async () => {
    const mine = rows.filter((r) => r.account === BUSY);
    expect(mine).toHaveLength(68);
    expect(new Set(mine.map((r) => r.currency))).toEqual(new Set(['XAH']));
    const sum = (direction: string): BigNumber =>
      mine
        .filter((r) => r.direction === direction)
        .reduce((total, r) => total.plus(r.delivered_amount), new BigNumber(0));
    const max = (direction: string): BigNumber =>
      BigNumber.max(0, ...mine.filter((r) => r.direction === direction).map((r) => new BigNumber(r.delivered_amount)));
    const report = (await okBody(api, path(BUSY, DAY), 'reports')).body.reports[0];
    expect(report).toMatchObject({
      account: BUSY,
      date: `${DAY}T00:00:00Z`,
      total_value_sent: sum('sent').toString(),
      total_value_received: sum('received').toString(),
      total_value: sum('sent').plus(sum('received')).toString(),
      high_value_sent: max('sent').toString(),
      high_value_received: max('received').toString(),
      payments_sent: mine.filter((r) => r.direction === 'sent').length,
      payments_received: mine.filter((r) => r.direction === 'received').length,
    });
    expect(Number(report.total_value)).toBeGreaterThan(0);
  });

  it('needs no rate for the native currency, and names XAH in the payments', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    const report = (await okBody(api, `${path(BUSY, DAY)}?payments=true&accounts=true`, 'reports')).body.reports[0];
    expect(spy.mock.calls.some(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`))).toBe(false);
    spy.mockRestore();
    expect(report.payments).toHaveLength(68);
    for (const p of report.payments ?? []) {
      expect(p.currency).toBe('XAH');
      expect(p).not.toHaveProperty('issuer');
    }
  });

  it('has a report for each day, with the rest zero', async () => {
    const res = await okBody(api, `${path(BUSY)}${qs({ start: '2026-10-14', end: '2026-10-16' })}`, 'reports');
    expect(res.body.reports.map((r) => [r.date, r.payments_sent + r.payments_received])).toEqual([
      ['2026-10-14T00:00:00Z', 0],
      ['2026-10-15T00:00:00Z', 68],
      ['2026-10-16T00:00:00Z', 0],
    ]);
  });
});

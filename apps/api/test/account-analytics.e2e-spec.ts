import { NativeRatesDailyRow, nativeValue, RatesService, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { bucketStart } from '../src/network/volume-buckets';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import {
  AnalyticsWorld,
  COUNTERPARTY,
  HOLDER,
  ISSUER,
  ISSUER2,
  MANY_LINES,
  manyCurrency,
  seedAnalyticsWorld,
  TYPICAL,
} from './support/analytics-world';
import { csvDisposition } from './support/csv';
import { fixtureBalanceChanges } from './support/fixtures';
import { BULK_BASES, BULK_PER_PART, BULK_TX_INDEX, bulkLedger, insertBulk, readsOf } from './support/read-rows';
import { rollUp } from './support/rollups';

/**
 * `GET /v2/accounts/:address/analytics/balances` and `.../analytics/balance_changes` on the hand-worked world of
 * `support/analytics-world.ts` (read its header: every number below is worked out from the rows listed there), on the
 * ripple-mock seed, and on the Xahau ledgers.
 *
 * The window is whole UTC days, widened to whole buckets with an interval; `end` is the start of the bucket after the last,
 * so the answer's `end` of `end=2020-06-30` is `2020-07-01T00:00:00Z`. The rates of the days of the world are those the
 * trades give on read (USD of the issuer: 2 on 02-10 to 02-24, 4 on 04-20 to 05-04, none on any other day); a suite that
 * needs stored sets of rates writes them into a database of its own.
 */

interface Line {
  currency: string;
  counterparty?: string;
  balance: string;
}
interface BalanceRow extends Line {
  date: string;
}
interface BalancesBody {
  result: string;
  start: string;
  end: string;
  interval: string;
  lines_total: number;
  lines: Line[];
  count: number;
  rows: BalanceRow[];
}
interface Total {
  change_type?: string;
  count: number;
  in_value: string;
  out_value: string;
  net_value: string;
}
interface AssetRow {
  change_type?: string;
  currency: string;
  issuer?: string;
  count: number;
  in: string;
  out: string;
  in_value: string;
  out_value: string;
}
interface BucketRow {
  date: string;
  change_type?: string;
  count: number;
  in_value: string;
  out_value: string;
}
interface ChangesBody {
  result: string;
  start: string;
  end: string;
  interval?: string;
  totals: Total[];
  count: number;
  rows: (AssetRow | BucketRow)[];
}

/** The accounts of the world, by the letters the numbers below are worked out with. */
const A = TYPICAL;
const CP = COUNTERPARTY;
const H = HOLDER;

const BALANCES = (account: string): string => `/v2/accounts/${account}/analytics/balances`;
const CHANGES = (account: string): string => `/v2/accounts/${account}/analytics/balance_changes`;

const T = (day: string): string => `${day}T00:00:00Z`;

/** A line, or a row of a bucket (`date` given): the counterparty is left out for the native currency. */
const line = (currency: string, balance: string, counterparty?: string): Line => ({
  currency,
  ...(counterparty !== undefined && { counterparty }),
  balance,
});
const row = (date: string, currency: string, balance: string, counterparty?: string): BalanceRow => ({
  date: T(date),
  currency,
  ...(counterparty !== undefined && { counterparty }),
  balance,
});

const total = (type: string | undefined, count: number, inValue: string, outValue: string, net: string): Total => ({
  ...(type !== undefined && { change_type: type }),
  count,
  in_value: inValue,
  out_value: outValue,
  net_value: net,
});
const assetRow = (
  type: string | undefined,
  currency: string,
  issuer: string | undefined,
  count: number,
  inn: string,
  out: string,
  inValue: string,
  outValue: string,
): AssetRow => ({
  ...(type !== undefined && { change_type: type }),
  currency,
  ...(issuer !== undefined && { issuer }),
  count,
  in: inn,
  out,
  in_value: inValue,
  out_value: outValue,
});
const bucketRow = (
  date: string,
  type: string | undefined,
  count: number,
  inValue: string,
  outValue: string,
): BucketRow => ({
  date: T(date),
  ...(type !== undefined && { change_type: type }),
  count,
  in_value: inValue,
  out_value: outValue,
});

/** The statements among `calls` that read a table, in the order they ran. */
const reading = <C extends { sql: string }>(calls: C[], table: Table): C[] =>
  calls.filter((c) => c.sql.includes(`FROM ${table}`));

/** The queries the harness's ClickHouse service ran while `fn` ran. */
async function queriesOf(
  h: Harness,
  fn: () => Promise<unknown>,
): Promise<{ sql: string; params: Record<string, unknown> }[]> {
  const spy = jest.spyOn(h.ch, 'query');
  try {
    await fn();
    return spy.mock.calls.map(([sql, params]) => ({
      sql: String(sql),
      params: (params ?? {}) as Record<string, unknown>,
    }));
  } finally {
    spy.mockRestore();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------------------------------

describe('analytics/balances and analytics/balance_changes, on the hand-worked world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let world: AnalyticsWorld;

  const balances = async (account: string, query: string): Promise<BalancesBody> =>
    (await api.ok<BalancesBody>(`${BALANCES(account)}?${query}`, 'lines')).body;
  const changes = async (account: string, query = ''): Promise<ChangesBody> =>
    (await api.ok<ChangesBody>(`${CHANGES(account)}?${query}`, 'totals')).body;
  const failure = async (url: string): Promise<{ status: number; body: unknown }> => {
    const res = await get(url);
    return { status: res.status, body: res.body };
  };
  const bad = (message: string): { status: number; body: unknown } => ({
    status: 400,
    body: { result: 'error', message },
  });

  beforeAll(async () => {
    h = await startHarness({
      seed: 'none',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
    world = await seedAnalyticsWorld(h);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  // what the app computed on read (the rates, kept for a minute; the coverage of the rollups) is not what the next test asks about
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  // -- balances ---------------------------------------------------------------------------------------------------

  describe('balances', () => {
    /** The typical account, by month, with the lines it has at the end of June: the native line, then by |balance|. */
    const A_LINES = [
      line('XRP', '84.999976'),
      line('USD', '20', ISSUER),
      line('USD', '7', ISSUER2),
      line('CAD', '-5', CP),
    ];
    const A_MONTHS: BalanceRow[] = [
      row('2020-01-01', 'XRP', '100'),
      row('2020-02-01', 'XRP', '79.999988'),
      row('2020-02-01', 'USD', '10', ISSUER),
      row('2020-03-01', 'XRP', '79.999976'), // the fee alone, in the last second of March
      row('2020-03-01', 'USD', '40', ISSUER),
      row('2020-04-01', 'XRP', '84.999976'),
      row('2020-04-01', 'USD', '20', ISSUER),
      row('2020-05-01', 'XRP', '84.999976'),
      row('2020-05-01', 'USD', '20', ISSUER),
      row('2020-05-01', 'CAD', '-5', CP), // what it owes: negative
      row('2020-06-01', 'XRP', '84.999976'),
      row('2020-06-01', 'USD', '20', ISSUER),
      row('2020-06-01', 'USD', '7', ISSUER2),
      row('2020-06-01', 'CAD', '-5', CP),
    ];

    /** The holder, by month from February to May: seven lines, ranked by |balance| (no rate), JPY changed before the window. */
    const H_LINES = [
      line('XRP', '409.999988'),
      line('GBP', '1000', ISSUER2),
      line('JPY', '1000', ISSUER2),
      line('USD', '150', ISSUER),
      line('EUR', '30', ISSUER),
      line('CAD', '-8', CP),
      line('BTC', '0', ISSUER),
    ];
    const H_MONTHS: BalanceRow[] = [
      row('2020-02-01', 'XRP', '399.999988'), // the fee, then the payment of 100, in one ledger: the payment is the last
      row('2020-02-01', 'GBP', '1000', ISSUER2),
      row('2020-02-01', 'JPY', '1000', ISSUER2), // changed on 01-20: before the window, so it has a row for the first bucket
      row('2020-02-01', 'USD', '100', ISSUER),
      row('2020-02-01', 'BTC', '5', ISSUER),
      row('2020-03-01', 'XRP', '409.999988'),
      row('2020-03-01', 'GBP', '1000', ISSUER2),
      row('2020-03-01', 'JPY', '1000', ISSUER2),
      row('2020-03-01', 'USD', '150', ISSUER),
      row('2020-03-01', 'EUR', '30', ISSUER), // its first change: no row for February
      row('2020-03-01', 'BTC', '5', ISSUER),
      row('2020-04-01', 'XRP', '409.999988'), // +2 and -2 on 04-10 and 04-11: back where it was
      row('2020-04-01', 'GBP', '1000', ISSUER2),
      row('2020-04-01', 'JPY', '1000', ISSUER2),
      row('2020-04-01', 'USD', '150', ISSUER),
      row('2020-04-01', 'EUR', '30', ISSUER),
      row('2020-04-01', 'BTC', '0', ISSUER), // back at 0: it keeps its rows
      row('2020-05-01', 'XRP', '409.999988'),
      row('2020-05-01', 'GBP', '1000', ISSUER2),
      row('2020-05-01', 'JPY', '1000', ISSUER2),
      row('2020-05-01', 'USD', '150', ISSUER),
      row('2020-05-01', 'EUR', '30', ISSUER),
      row('2020-05-01', 'CAD', '-8', CP), // owed
      row('2020-05-01', 'BTC', '0', ISSUER),
    ];

    it('rows: per bucket the line\'s last balance up to then, carried; from the bucket of its first change, or the window\'s first; a line back at 0 keeps rows of "0"; an owed balance is negative', async () => {
      const a = await balances(A, 'start=2020-01-01&end=2020-06-30&interval=month');
      expect(a).toEqual({
        result: 'success',
        start: T('2020-01-01'),
        end: T('2020-07-01'),
        interval: 'month',
        lines_total: 4,
        lines: A_LINES,
        count: 14,
        rows: A_MONTHS,
      });
      // USD of the issuer has no row for January (its first change is in February) and no row of CAD before May

      const holder = await balances(H, 'start=2020-02-01&end=2020-05-31&interval=month');
      expect(holder).toEqual({
        result: 'success',
        start: T('2020-02-01'),
        end: T('2020-06-01'),
        interval: 'month',
        lines_total: 7,
        lines: H_LINES,
        count: 24,
        rows: H_MONTHS,
      });
    });

    it('the issuer: what it owes is a negative balance, a line for each of its trust lines', async () => {
      const body = await balances(ISSUER, 'start=2020-01-01&end=2020-06-30&interval=month');
      expect(body.lines).toEqual([
        line('XRP', '1000'),
        line('USD', '-40', A),
        line('USD', '-5', CP),
        line('EUR', '-3', CP),
      ]);
      expect(body.rows.filter((r) => r.date === T('2020-02-01'))).toEqual([
        row('2020-02-01', 'XRP', '1000'),
        row('2020-02-01', 'USD', '-10', A),
        row('2020-02-01', 'USD', '-5', CP),
      ]);
      expect(body.rows.filter((r) => r.date === T('2020-04-01')).map((r) => r.balance)).toEqual([
        '1000',
        '-40',
        '-5',
        '-3',
      ]);
      expect(body.count).toBe(1 + 3 + 3 + 4 + 4 + 4);
    });

    it('interval=day and interval=week: the last balance of the day, a Sunday is in the week that began on the Monday before', async () => {
      // the fee of 02-20 (node -1) and the payment of that ledger (node 2): the balance of the day is the payment's
      const day = await balances(H, 'start=2020-02-19&end=2020-02-21&interval=day');
      expect(day).toMatchObject({
        start: T('2020-02-19'),
        end: T('2020-02-22'),
        interval: 'day',
        lines_total: 5,
        count: 15,
      });
      expect(day.lines).toEqual([
        line('XRP', '399.999988'),
        line('GBP', '1000', ISSUER2),
        line('JPY', '1000', ISSUER2),
        line('USD', '100', ISSUER),
        line('BTC', '5', ISSUER),
      ]);
      const xrp = day.rows.filter((r) => r.currency === 'XRP').map((r) => [r.date, r.balance]);
      expect(xrp).toEqual([
        [T('2020-02-19'), '500'], // before the window: the last of the days before it
        [T('2020-02-20'), '399.999988'],
        [T('2020-02-21'), '399.999988'],
      ]);

      // the weeks of 02-17, 02-24 and 03-02: EUR changed on Sunday 03-01, which is in the week of 02-24
      const week = await balances(H, 'start=2020-02-17&end=2020-03-02&interval=week');
      expect(week).toMatchObject({
        start: T('2020-02-17'),
        end: T('2020-03-09'),
        interval: 'week',
        lines_total: 6,
        count: 17,
      });
      expect(week.rows.filter((r) => r.currency === 'EUR')).toEqual([
        row('2020-02-24', 'EUR', '30', ISSUER),
        row('2020-03-02', 'EUR', '30', ISSUER),
      ]);
      expect(week.rows.filter((r) => r.date === T('2020-02-17')).map((r) => r.currency)).toEqual([
        'XRP',
        'GBP',
        'JPY',
        'USD',
        'BTC',
      ]);
    });

    it('a window that starts later is carried from before it: the same balances', async () => {
      // 03-15 is inside March: the bucket is March, whole; the balances of January and February are carried into it
      const body = await balances(A, 'start=2020-03-15&end=2020-04-02&interval=month');
      expect(body.start).toBe(T('2020-03-01'));
      expect(body.rows).toEqual(A_MONTHS.filter((r) => r.date === T('2020-03-01') || r.date === T('2020-04-01')));
      // before everything: nothing is made up for the buckets before a line's first change
      const early = await balances(A, 'start=2019-01-01&end=2020-01-31&interval=month');
      expect(early.rows).toEqual([row('2020-01-01', 'XRP', '100')]);
      expect(early.lines).toEqual([line('XRP', '100')]);
    });

    it('rows are ordered by date, then the order of lines; count is the number of rows', async () => {
      for (const [account, query] of [
        [A, 'start=2020-01-01&end=2020-06-30&interval=month'],
        [H, 'start=2020-02-01&end=2020-05-31&interval=month'],
        [H, 'start=2020-03-05&end=2020-03-25&interval=week'],
        [ISSUER, 'start=2020-02-01&end=2020-04-30&interval=month'],
      ]) {
        const body = await balances(account, query);
        expect(body.count).toBe(body.rows.length);
        const order = body.lines.map((l) => `${l.currency}|${l.counterparty ?? ''}`);
        let last = { date: '', at: -1 };
        for (const r of body.rows) {
          const at = order.indexOf(`${r.currency}|${r.counterparty ?? ''}`);
          expect(at).toBeGreaterThanOrEqual(0);
          if (r.date === last.date) expect(at).toBeGreaterThan(last.at);
          else expect(r.date > last.date).toBe(true);
          last = { date: r.date, at };
        }
      }
    });

    it('the keys: a line is currency, counterparty?, balance and a row date, currency, counterparty?, balance; the native currency has no counterparty', async () => {
      const body = await balances(A, 'start=2020-06-01&end=2020-06-30&interval=month');
      expect(Object.keys(body)).toEqual([
        'result',
        'start',
        'end',
        'interval',
        'lines_total',
        'lines',
        'count',
        'rows',
      ]);
      expect(body.lines.map((l) => Object.keys(l))).toEqual([
        ['currency', 'balance'],
        ['currency', 'counterparty', 'balance'],
        ['currency', 'counterparty', 'balance'],
        ['currency', 'counterparty', 'balance'],
      ]);
      expect(Object.keys(body.rows[0])).toEqual(['date', 'currency', 'balance']);
      expect(Object.keys(body.rows[1])).toEqual(['date', 'currency', 'counterparty', 'balance']);
      expect(typeof body.lines_total).toBe('number');
      expect(typeof body.count).toBe('number');
    });

    it('interval defaults to day, and an empty one is none', async () => {
      const plain = await balances(H, 'start=2020-02-19&end=2020-02-21');
      expect(plain.interval).toBe('day');
      expect(plain).toEqual(await balances(H, 'start=2020-02-19&end=2020-02-21&interval=day'));
      expect(await balances(H, 'start=2020-02-19&end=2020-02-21&interval=')).toEqual(plain);
    });

    it('currency (upper-cased) and counterparty (alias issuer) filter the lines; counterparty with currency=XRP is 400 counterparty cannot be specified for XRP', async () => {
      const window = 'start=2020-01-01&end=2020-06-30&interval=month';
      // the rows are those of the lines that are left
      const usd = await balances(A, `${window}&currency=usd`);
      expect(usd.lines).toEqual([line('USD', '20', ISSUER), line('USD', '7', ISSUER2)]);
      expect(usd.lines_total).toBe(2);
      expect(usd.rows).toEqual(A_MONTHS.filter((r) => r.currency === 'USD'));
      expect(usd.count).toBe(usd.rows.length);

      const issuer2 = await balances(A, `${window}&counterparty=${ISSUER2}`);
      expect(issuer2.lines).toEqual([line('USD', '7', ISSUER2)]);
      expect(issuer2.rows).toEqual([row('2020-06-01', 'USD', '7', ISSUER2)]);
      // the alias gives the same answer
      expect(await balances(A, `${window}&issuer=${ISSUER2}`)).toEqual(issuer2);
      // counterparty wins over its alias
      expect(await balances(A, `${window}&counterparty=${ISSUER2}&issuer=${ISSUER}`)).toEqual(issuer2);
      // both
      const cad = await balances(A, `${window}&currency=cad&counterparty=${CP}`);
      expect(cad.lines).toEqual([line('CAD', '-5', CP)]);
      expect(cad.lines_total).toBe(1);
      // the native currency alone: its line has no counterparty
      const xrp = await balances(A, `${window}&currency=XRP`);
      expect(xrp.lines).toEqual([line('XRP', '84.999976')]);
      expect(xrp.rows).toEqual(A_MONTHS.filter((r) => r.currency === 'XRP'));
      // no line is no row
      const none = await balances(A, `${window}&currency=EUR`);
      expect(none).toMatchObject({ lines_total: 0, lines: [], count: 0, rows: [] });
      // an empty counterparty is none
      expect((await balances(A, `${window}&counterparty=`)).lines_total).toBe(4);

      for (const query of [
        `currency=XRP&counterparty=${ISSUER}`,
        `currency=xrp&counterparty=${ISSUER}`,
        `currency=xrp&issuer=${ISSUER}`,
      ]) {
        expect([query, await failure(`${BALANCES(A)}?${window}&${query}`)]).toEqual([
          query,
          bad('counterparty cannot be specified for XRP'),
        ]);
      }
      // a counterparty with any other currency is fine, and so is a currency of another case on its own
      expect((await get(`${BALANCES(A)}?${window}&currency=usd&counterparty=${ISSUER}`)).status).toBe(200);
    });

    it('the errors come in order: start, end, interval, counterparty, the bucket limit', async () => {
      const url = (query: string): string => `${BALANCES(A)}?${query}`;
      const all = `start=nope&end=nope&interval=nope&currency=XRP&counterparty=${ISSUER}`;
      expect(await failure(url(all))).toEqual(bad('invalid start date format'));
      expect(await failure(url(all.replace('start=nope', 'start=2013-01-01')))).toEqual(bad('invalid end date format'));
      expect(
        await failure(url(all.replace('start=nope', 'start=2013-01-01').replace('end=nope', 'end=2020-01-02'))),
      ).toEqual(bad('invalid interval - use: day, week, month'));
      const rest = `start=2013-01-01&end=2020-01-02&interval=day&currency=XRP&counterparty=${ISSUER}`;
      // the counterparty before the bucket limit (2,557 days)
      expect(await failure(url(rest))).toEqual(bad('counterparty cannot be specified for XRP'));
      expect(await failure(url(rest.replace('&currency=XRP', '')))).toEqual(
        bad('choose a date range of at most 1000 buckets'),
      );
      // the default window is 2013-01-01 to now: more than 1000 days, so a day interval needs a start
      expect(await failure(url(''))).toEqual(bad('choose a date range of at most 1000 buckets'));
      // an interval of weeks or months of the same window is fine
      expect((await get(url('interval=week'))).status).toBe(200);
      expect((await get(url('interval=month'))).status).toBe(200);
      // no table is read for an error
      const calls = await queriesOf(h, async () => {
        await get(url(all));
        await get(url(rest));
      });
      expect(calls).toHaveLength(0);
    });

    it('the bucket limit is 1000: 1000 days are fine, 1001 are 400', async () => {
      // 2020-01-01 and the 999 days after it
      expect((await get(`${BALANCES(A)}?start=2020-01-01&end=2022-09-26&interval=day`)).status).toBe(200);
      expect(await failure(`${BALANCES(A)}?start=2020-01-01&end=2022-09-27&interval=day`)).toEqual(
        bad('choose a date range of at most 1000 buckets'),
      );
      // the buckets are those of the widened window: 2020-01-06 is a Monday, and 1000 weeks end on the Sunday 6,999 days after it
      const day = (n: number): string =>
        new Date(Date.parse('2020-01-06T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
      expect((await get(`${BALANCES(A)}?start=2020-01-06&end=${day(6999)}&interval=week`)).status).toBe(200);
      expect(await failure(`${BALANCES(A)}?start=2020-01-06&end=${day(7000)}&interval=week`)).toEqual(
        bad('choose a date range of at most 1000 buckets'),
      );
      // a start in the middle of a week counts the whole week: the Wednesday 2020-01-08 and the Sunday 6,998 days after it
      expect((await get(`${BALANCES(A)}?start=2020-01-08&end=${day(6999)}&interval=week`)).status).toBe(200);
    });

    it('serves no row for a bucket that has not begun: rows stop at the bucket that holds now, whatever the end', async () => {
      const month = (ms: number): string => new Date(bucketStart(ms, 'month')).toISOString().slice(0, 10);
      const before = Date.now();
      const body = await balances(A, 'start=2026-01-01&end=2100-01-01&interval=month');
      const after = Date.now();
      // the answer says the window it was asked for
      expect(body).toMatchObject({ start: T('2026-01-01'), end: T('2100-02-01'), interval: 'month', lines_total: 4 });
      const dates = [...new Set(body.rows.map((r) => r.date.slice(0, 10)))];
      const expected = (now: number): string[] => {
        const out: string[] = [];
        for (
          let m = Date.parse('2026-01-01T00:00:00Z');
          m <= now;
          m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)
        ) {
          out.push(month(m));
        }
        return out;
      };
      expect([expected(before), expected(after)]).toContainEqual(dates);
      // every one of the four lines has a row in each of them
      expect(body.count).toBe(dates.length * 4);
      expect(body.rows[body.rows.length - 1]).toMatchObject({ currency: 'CAD', balance: '-5' });

      // a day interval, with an end three days from now
      const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
      const d0 = Date.now();
      const soon = await balances(A, `start=${day(d0 - 86_400_000)}&end=${day(d0 + 3 * 86_400_000)}&interval=day`);
      const d1 = Date.now();
      const got = [...new Set(soon.rows.map((r) => r.date.slice(0, 10)))];
      expect([
        [day(d0 - 86_400_000), day(d0)],
        [day(d1 - 86_400_000), day(d1)],
      ]).toContainEqual(got);
      expect(soon.end).toBe(T(day(d0 + 4 * 86_400_000)));
      // a window that has not begun has lines (what the account has at its end) and no row
      const future = await balances(A, 'start=2100-01-01&end=2100-03-01&interval=month');
      expect(future).toMatchObject({
        start: T('2100-01-01'),
        end: T('2100-04-01'),
        lines_total: 4,
        count: 0,
        rows: [],
      });
      expect(future.lines).toEqual(A_LINES);
    });

    it('an account that has nothing, or none, is an empty answer: no line, no row', async () => {
      for (const account of [world.stranger, 'notanaddress']) {
        const res = await get(`${BALANCES(account)}?start=2020-01-01&end=2020-06-30&interval=month`);
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          {
            result: 'success',
            start: T('2020-01-01'),
            end: T('2020-07-01'),
            interval: 'month',
            lines_total: 0,
            lines: [],
            count: 0,
            rows: [],
          },
        ]);
      }
      // a window before the account's first change: no line has a change up to its end
      const early = await balances(A, 'start=2019-01-01&end=2019-12-31&interval=month');
      expect(early).toMatchObject({ lines_total: 0, lines: [], count: 0, rows: [] });
      const old = await balances(A, 'start=1960-01-01&end=1999-12-31&interval=month');
      expect(old).toMatchObject({ lines_total: 0, rows: [] });
    });

    it('an empty window (end before start) is an empty answer, with start and end the start of the first bucket, and reads nothing', async () => {
      const calls = await queriesOf(h, async () => {
        const res = await get(`${BALANCES(A)}?start=2020-06-30&end=2020-01-01&interval=month`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          result: 'success',
          start: T('2020-06-01'),
          end: T('2020-06-01'),
          interval: 'month',
          lines_total: 0,
          lines: [],
          count: 0,
          rows: [],
        });
        const week = await get(`${BALANCES(A)}?start=2020-02-20&end=2020-02-10&interval=week`);
        expect([week.body.start, week.body.end, week.body.count]).toEqual([T('2020-02-17'), T('2020-02-17'), 0]);
      });
      expect(calls).toHaveLength(0);
    });
  });

  // -- balance_changes --------------------------------------------------------------------------------------------

  describe('balance_changes', () => {
    const A_TOTALS = [
      total('transaction_cost', 2, '0', '0.000024', '-0.000024'),
      total('payment_destination', 4, '105', '0', '105'), // 100 XRP, 10 USD at the rate of 2, 30 USD and 7 USD2 at none
      total('payment_source', 1, '0', '20', '-20'),
      total('exchange', 2, '5', '5', '0'), // 5 XRP in, 20 USD out at the rate of 4
      total('intermediary', 1, '0', '0', '0'), // the 5 CAD it owes have no rate
    ];
    const A_ROWS = [
      assetRow('transaction_cost', 'XRP', undefined, 2, '0', '0.000024', '0', '0.000024'),
      assetRow('payment_destination', 'XRP', undefined, 1, '100', '0', '100', '0'),
      assetRow('payment_destination', 'USD', ISSUER, 2, '40', '0', '5', '0'),
      assetRow('payment_destination', 'USD', ISSUER2, 1, '7', '0', '0', '0'),
      assetRow('payment_source', 'XRP', undefined, 1, '0', '20', '0', '20'),
      // 5 and 5: USD before XRP by currency
      assetRow('exchange', 'USD', ISSUER, 1, '0', '20', '0', '5'),
      assetRow('exchange', 'XRP', undefined, 1, '5', '0', '5', '0'),
      assetRow('intermediary', 'CAD', A, 1, '0', '5', '0', '0'),
    ];
    const H_TOTALS = [
      total('transaction_cost', 1, '0', '0.000012', '-0.000012'),
      total('payment_destination', 8, '560', '0', '560'), // 510 XRP and the 100 USD of 02-12 at the rate of 2
      total('payment_source', 2, '0', '100', '-100'),
      total('intermediary', 1, '0', '0', '0'),
      total(undefined, 2, '2', '2', '0'),
    ];
    const H_ROWS = [
      assetRow('transaction_cost', 'XRP', undefined, 1, '0', '0.000012', '0', '0.000012'),
      assetRow('payment_destination', 'XRP', undefined, 2, '510', '0', '510', '0'),
      assetRow('payment_destination', 'USD', ISSUER, 2, '150', '0', '50', '0'),
      // the rest are worth 0: by currency
      assetRow('payment_destination', 'BTC', ISSUER, 1, '5', '0', '0', '0'),
      assetRow('payment_destination', 'EUR', ISSUER, 1, '30', '0', '0', '0'),
      assetRow('payment_destination', 'GBP', ISSUER2, 1, '1000', '0', '0', '0'),
      assetRow('payment_destination', 'JPY', ISSUER2, 1, '1000', '0', '0', '0'),
      assetRow('payment_source', 'XRP', undefined, 1, '0', '100', '0', '100'),
      assetRow('payment_source', 'BTC', ISSUER, 1, '0', '5', '0', '0'),
      assetRow('intermediary', 'CAD', H, 1, '0', '8', '0', '0'),
      assetRow(undefined, 'XRP', undefined, 2, '2', '2', '2', '2'),
    ];

    it('totals: one per change type with a change, in CHANGE_TYPE_ORDER, the unclassified without change_type last; count, in_value, out_value, net_value', async () => {
      const a = await changes(A, 'end=2020-06-30');
      expect(a.totals).toEqual(A_TOTALS);
      // the holder has a type of every kind but the escrows and channels, and two changes that have none: they come last
      const holder = await changes(H, 'end=2020-06-30');
      expect(holder.totals).toEqual(H_TOTALS);
      expect(Object.keys(holder.totals[4])).toEqual(['count', 'in_value', 'out_value', 'net_value']);
      expect(Object.keys(holder.totals[0])).toEqual(['change_type', 'count', 'in_value', 'out_value', 'net_value']);
      // net is in minus out, for the issuer too
      expect((await changes(ISSUER, 'end=2020-06-30')).totals).toEqual([
        total('payment_destination', 1, '1000', '0', '1000'),
        total('intermediary', 4, '0', '7.5', '-7.5'),
      ]);
    });

    it('rows without interval: per change type and asset, by type then in_value + out_value descending then currency and issuer; in and out exact; the fees (transaction_cost) count', async () => {
      const a = await changes(A, 'end=2020-06-30');
      expect(a).toMatchObject({ start: T('2013-01-01'), end: T('2020-07-01'), count: 8 });
      expect(a.rows).toEqual(A_ROWS);
      const holder = await changes(H, 'end=2020-06-30');
      expect(holder.rows).toEqual(H_ROWS);
      expect(holder.count).toBe(11);
      // the keys
      expect(Object.keys(a)).toEqual(['result', 'start', 'end', 'totals', 'count', 'rows']);
      expect(Object.keys(a.rows[0])).toEqual([
        'change_type',
        'currency',
        'count',
        'in',
        'out',
        'in_value',
        'out_value',
      ]);
      expect(Object.keys(a.rows[2])).toEqual([
        'change_type',
        'currency',
        'issuer',
        'count',
        'in',
        'out',
        'in_value',
        'out_value',
      ]);
      expect(Object.keys(holder.rows[10])).toEqual(['currency', 'count', 'in', 'out', 'in_value', 'out_value']);
      // the fee rows are counted: two fees of 0.000012 are 0.000024, exactly
      expect(a.rows[0]).toMatchObject({ count: 2, out: '0.000024' });
      // the totals are the sums of the rows
      for (const body of [a, holder]) {
        const rows = body.rows as AssetRow[];
        expect(body.totals.reduce((n, t) => n + t.count, 0)).toBe(rows.reduce((n, r) => n + r.count, 0));
      }
    });

    it("an owed line's change is valued as the account's own IOU (issuer = the account)", async () => {
      // the issuer owes USD to three lines; its USD has a rate of 2 on 02-10 and 02-20, none on 03-05; folded into one asset,
      // the issuer being the account itself
      const issuer = await changes(ISSUER, 'end=2020-06-30');
      expect(issuer.rows).toEqual([
        assetRow('payment_destination', 'XRP', undefined, 1, '1000', '0', '1000', '0'),
        // 10 / 2 on 02-10, 5 / 2 on 02-20, 30 at no rate on 03-05
        assetRow('intermediary', 'USD', ISSUER, 3, '0', '45', '0', '7.5'),
        assetRow('intermediary', 'EUR', ISSUER, 1, '0', '3', '0', '0'),
      ]);
      // the typical account owes CAD to the counterparty: its asset is (CAD, the account)
      expect((await changes(A, 'end=2020-06-30')).rows).toContainEqual(
        assetRow('intermediary', 'CAD', A, 1, '0', '5', '0', '0'),
      );
      // what it holds is of the counterparty it has the line with: the USD of the typical account are USD of the issuer
      expect((await changes(A, 'end=2020-06-30')).rows).toContainEqual(
        assetRow('payment_destination', 'USD', ISSUER, 2, '40', '0', '5', '0'),
      );
    });

    it('rows with interval: per bucket and change type, by date then type', async () => {
      const month = await changes(A, 'end=2020-06-30&interval=month');
      expect(month).toMatchObject({ start: T('2013-01-01'), end: T('2020-07-01'), interval: 'month', count: 9 });
      expect(Object.keys(month)).toEqual(['result', 'start', 'end', 'interval', 'totals', 'count', 'rows']);
      expect(month.rows).toEqual([
        bucketRow('2020-01-01', 'payment_destination', 1, '100', '0'),
        bucketRow('2020-02-01', 'transaction_cost', 1, '0', '0.000012'),
        bucketRow('2020-02-01', 'payment_destination', 1, '5', '0'),
        bucketRow('2020-02-01', 'payment_source', 1, '0', '20'),
        bucketRow('2020-03-01', 'transaction_cost', 1, '0', '0.000012'),
        bucketRow('2020-03-01', 'payment_destination', 1, '0', '0'),
        bucketRow('2020-04-01', 'exchange', 2, '5', '5'),
        bucketRow('2020-05-01', 'intermediary', 1, '0', '0'),
        bucketRow('2020-06-01', 'payment_destination', 1, '0', '0'),
      ]);
      expect(Object.keys(month.rows[0])).toEqual(['date', 'change_type', 'count', 'in_value', 'out_value']);
      // the totals do not depend on the interval
      expect(month.totals).toEqual(A_TOTALS);

      // a week: 02-10 is a Monday; the window widens to the whole week, to the Sunday 02-16
      const week = await changes(A, 'start=2020-02-12&end=2020-02-14&interval=week');
      expect(week).toMatchObject({ start: T('2020-02-10'), end: T('2020-02-17'), interval: 'week' });
      expect(week.rows).toEqual([
        bucketRow('2020-02-10', 'transaction_cost', 1, '0', '0.000012'),
        bucketRow('2020-02-10', 'payment_destination', 1, '5', '0'),
        bucketRow('2020-02-10', 'payment_source', 1, '0', '20'),
      ]);
      // a day: one row per day and type
      const day = await changes(H, 'start=2020-04-09&end=2020-04-12&interval=day');
      expect(day.rows).toEqual([
        bucketRow('2020-04-10', undefined, 1, '2', '0'),
        bucketRow('2020-04-11', undefined, 1, '0', '2'),
      ]);
      expect(Object.keys(day.rows[0])).toEqual(['date', 'count', 'in_value', 'out_value']);
      // interval=day is the days, and an empty interval is none
      expect(await changes(H, 'start=2020-04-09&end=2020-04-12&interval=')).toMatchObject({
        count: 1,
        rows: [assetRow(undefined, 'XRP', undefined, 2, '2', '2', '2', '2')],
      });
      expect((await changes(H, 'start=2020-04-09&end=2020-04-12&interval=')).interval).toBeUndefined();
    });

    it('a window of whole days: the day of start and the day of end, whatever the time of day', async () => {
      // 02-12 09:00 is the fee and the payment of A; a window that ends the second before it still has the whole day
      const day = await changes(A, 'start=2020-02-12T23:59:59&end=2020-02-12T00:00:01');
      expect(day.start).toBe(T('2020-02-12'));
      expect(day.end).toBe(T('2020-02-13'));
      expect(day.totals).toEqual([
        total('transaction_cost', 1, '0', '0.000012', '-0.000012'),
        total('payment_source', 1, '0', '20', '-20'),
      ]);
      // the window is from the start of the day of start: 02-10 is in
      expect((await changes(A, 'start=2020-02-10T23:59:59&end=2020-02-10T23:59:59')).totals).toEqual([
        total('payment_destination', 1, '5', '0', '5'),
      ]);
      // and the end is included
      expect((await changes(A, 'start=2020-02-11&end=2020-02-12')).count).toBe(2);
      expect((await changes(A, 'start=2020-02-11&end=2020-02-11')).count).toBe(0);
    });

    it('is the answer of a window before the ledgers, or past the last date a ClickHouse Date holds', async () => {
      expect(await changes(A, 'start=1900-01-01&end=2200-01-01')).toMatchObject({
        start: T('1900-01-01'),
        end: T('2200-01-02'),
        totals: A_TOTALS,
        count: 8,
      });
      expect(await changes(A, 'start=1960-01-01&end=2020-06-30&interval=month')).toMatchObject({
        start: T('1960-01-01'),
        interval: 'month',
        count: 9,
      });
      expect((await changes(A, 'start=1900-01-01&end=1999-12-31')).totals).toEqual([]);
      expect((await changes(A, 'start=2300-01-01&end=2400-01-01')).totals).toEqual([]);
      expect((await changes(A, 'start=0001-01-01&end=0002-01-01')).totals).toEqual([]);
    });

    it('the errors: start, end, interval, and the bucket limit only with an interval', async () => {
      const url = (query: string): string => `${CHANGES(A)}?${query}`;
      expect(await failure(url('start=nope&end=nope&interval=nope'))).toEqual(bad('invalid start date format'));
      expect(await failure(url('end=nope&interval=nope'))).toEqual(bad('invalid end date format'));
      expect(await failure(url('interval=nope'))).toEqual(bad('invalid interval - use: day, week, month'));
      expect(await failure(url('start=2013-01-01&interval=day'))).toEqual(
        bad('choose a date range of at most 1000 buckets'),
      );
      expect(await failure(url('start=2020-01-01&end=2022-09-27&interval=day'))).toEqual(
        bad('choose a date range of at most 1000 buckets'),
      );
      expect((await get(url('start=2020-01-01&end=2022-09-26&interval=day'))).status).toBe(200);
      // no interval, no limit: the whole history in one answer
      expect((await get(url('start=2013-01-01'))).status).toBe(200);
      expect((await get(url('start=2013-01-01&interval=week'))).status).toBe(200);
    });
  });

  // -- both -------------------------------------------------------------------------------------------------------

  describe('both routes', () => {
    it('an empty window and an unknown address are empty answers', async () => {
      for (const account of [world.stranger, 'notanaddress']) {
        const res = await get(`${CHANGES(account)}?end=2020-06-30`);
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          { result: 'success', start: T('2013-01-01'), end: T('2020-07-01'), totals: [], count: 0, rows: [] },
        ]);
        const month = await get(`${CHANGES(account)}?end=2020-06-30&interval=month`);
        expect(month.body).toEqual({
          result: 'success',
          start: T('2013-01-01'),
          end: T('2020-07-01'),
          interval: 'month',
          totals: [],
          count: 0,
          rows: [],
        });
      }
      const calls = await queriesOf(h, async () => {
        const res = await get(`${CHANGES(A)}?start=2020-06-30&end=2020-01-01`);
        expect(res.body).toEqual({
          result: 'success',
          start: T('2020-06-30'),
          end: T('2020-06-30'),
          totals: [],
          count: 0,
          rows: [],
        });
        const week = await get(`${CHANGES(A)}?start=2020-02-20&end=2020-02-10&interval=week`);
        expect(week.body).toMatchObject({ start: T('2020-02-17'), end: T('2020-02-17'), interval: 'week', rows: [] });
      });
      expect(calls).toHaveLength(0);
    });

    it('unknown parameters are ignored, Cache-Control is private, max-age=60', async () => {
      const plain = await get(`${BALANCES(H)}?start=2020-02-19&end=2020-02-21&interval=day`);
      const extra = await get(
        `${BALANCES(H)}?start=2020-02-19&end=2020-02-21&interval=day&foo=bar&amm=exclude&marker=x&sort=count&descending=true`,
      );
      expect(plain.status).toBe(200);
      expect(extra.body).toEqual(plain.body);
      expect(plain.headers['cache-control']).toBe('private, max-age=60');
      expect(extra.headers['cache-control']).toBe('private, max-age=60');
      // a repeated parameter: the first value wins
      expect((await get(`${BALANCES(H)}?start=2020-02-19&end=2020-02-21&interval=day&interval=week`)).body).toEqual(
        plain.body,
      );

      const changesPlain = await get(`${CHANGES(A)}?end=2020-06-30&interval=month`);
      const changesExtra = await get(
        `${CHANGES(A)}?end=2020-06-30&interval=month&foo=bar&amm=include&limit=1&currency=USD`,
      );
      expect(changesExtra.body).toEqual(changesPlain.body);
      expect(changesPlain.headers['cache-control']).toBe('private, max-age=60');
      // an error is not cached
      expect((await get(`${CHANGES(A)}?interval=year`)).headers['cache-control']).toBe('no-store');
    });

    it('format=csv gives the rows as <address> - balance history.csv and <address> - balance change totals.csv', async () => {
      const history = await get(`${BALANCES(H)}?start=2020-02-01&end=2020-03-31&interval=month&format=csv`);
      expect(history.status).toBe(200);
      expect(history.headers['content-type']).toMatch(/^text\/csv/);
      expect(history.headers['content-disposition']).toBe(csvDisposition(`${H} - balance history`));
      const lines = history.text.split('\n');
      // the rows of February and March: 5 + 6
      expect(lines).toHaveLength(1 + 11);
      expect(lines[0].split(',')).toEqual(['"date"', '"currency"', '"balance"', '"counterparty"']);
      // the native line has no counterparty: an empty cell
      expect(lines[1]).toBe('"2020-02-01T00:00:00Z","XRP","399.999988",""');
      expect(lines[2]).toBe(`"2020-02-01T00:00:00Z","GBP","1000","${ISSUER2}"`);

      const totals = await get(`${CHANGES(A)}?end=2020-06-30&format=csv`);
      expect(totals.headers['content-disposition']).toBe(csvDisposition(`${A} - balance change totals`));
      const csv = totals.text.split('\n');
      expect(csv).toHaveLength(1 + 8);
      expect(csv[0].split(',')).toEqual([
        '"change_type"',
        '"currency"',
        '"count"',
        '"in"',
        '"out"',
        '"in_value"',
        '"out_value"',
        '"issuer"',
      ]);
      // a row of the native currency has no issuer: an empty cell
      expect(csv[1]).toBe('"transaction_cost","XRP","2","0","0.000024","0","0.000024",""');
      // with an interval the rows are the buckets
      const monthly = await get(`${CHANGES(A)}?end=2020-06-30&interval=month&format=csv`);
      expect(monthly.text.split('\n')[0]).toBe('"date","change_type","count","in_value","out_value"');
      expect(monthly.text.split('\n')).toHaveLength(1 + 9);
    });

    it('a failing query is 500 unable to retrieve balance history / unable to retrieve balance changes', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const history = await get(`${BALANCES(A)}?start=2020-01-01&end=2020-06-30&interval=month`);
      expect([history.status, history.body]).toEqual([
        500,
        { result: 'error', message: 'unable to retrieve balance history' },
      ]);
      const changes = await get(`${CHANGES(A)}?end=2020-06-30`);
      expect([changes.status, changes.body]).toEqual([
        500,
        { result: 'error', message: 'unable to retrieve balance changes' },
      ]);
      const monthly = await get(`${CHANGES(A)}?end=2020-06-30&interval=month`);
      expect([monthly.status, monthly.body.message]).toEqual([500, 'unable to retrieve balance changes']);
      jest.restoreAllMocks();
      // and it is the same route that answers when the database is back
      expect((await get(`${CHANGES(A)}?end=2020-06-30`)).status).toBe(200);
    });

    it('the routes are the handlers of analytics/, and leave the other routes of an account as they were', async () => {
      expect((await get(`/v2/accounts/${A}/balance_changes?limit=1`)).body).toHaveProperty('balance_changes');
      expect((await get(`/v2/accounts/${A}/stats/value?end=2020-02-01`)).body).toHaveProperty('rows');
      expect((await get(`/v2/accounts/${A}/reports?start=2020-02-12&end=2020-02-12`)).body).toHaveProperty('reports');
      expect((await get(`/v2/accounts/${A}/transactions?limit=1`)).body).toHaveProperty('transactions');
      expect((await get(`/v2/accounts/${A}/payments?limit=1`)).body).toHaveProperty('payments');
      expect((await get(`/v2/accounts/${A}/exchanges/USD+${ISSUER}/XRP`)).status).toBe(200);
      // an unknown route under analytics is not one of ours
      expect((await get(`/v2/accounts/${A}/analytics/nothing`)).status).toBe(404);
      expect((await get(`/v2/accounts/${A}/analytics`)).status).toBe(404);
    });
  });

  // -- what is read -----------------------------------------------------------------------------------------------

  describe('what is read', () => {
    it('balances: the day groups of the account once for the ranking and once for the chosen lines, no FINAL, only the lines served', async () => {
      const calls = await queriesOf(h, () => balances(H, 'start=2020-02-01&end=2020-05-31&interval=month&limit=3'));
      const groups = reading(calls, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'));
      expect(groups).toHaveLength(2);
      for (const { sql, params } of groups) {
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).toContain('LIMIT 1 BY');
        expect(sql).toContain('ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32}');
        expect(params.dg_account).toBe(H);
      }
      // the ranking: ordered and limited in SQL, with the count of all the lines
      const [ranking, chosen] = groups;
      expect(ranking.sql).toContain('count() OVER ()');
      expect(ranking.sql).toMatch(/LIMIT \{limit:UInt32\}/);
      expect(ranking.params.limit).toBe(3);
      // the chosen lines: only the lines served leave the database
      expect(chosen.params).toMatchObject({
        line_currencies: ['XRP', 'GBP', 'JPY'],
        line_counterparties: ['', ISSUER2, ISSUER2],
      });
      // no rates are read for a window with no valid day
      expect(reading(calls, Table.Exchanges)).toHaveLength(0);
    });

    it('balance_changes: one read of the day groups of the window, grouped by day, change type and asset', async () => {
      const calls = await queriesOf(h, () => changes(A, 'start=2020-02-10&end=2020-04-30'));
      const groups = reading(calls, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'));
      expect(groups).toHaveLength(1);
      expect(groups[0].sql).not.toMatch(/\bFINAL\b/);
      expect(groups[0].sql).toMatch(/GROUP BY day, change_type, currency, issuer/);
      // the window: 02-10 to 04-30, the ledgers of those days only
      expect(groups[0].params.dg_min0).toBe(world.ledgerAt('2020-02-10T10:00:00Z'));
      expect(groups[0].params.dg_max0).toBe(world.ledgerAt('2020-04-20T12:30:11Z'));
      // the rates of the issued assets that moved, once, for the days they moved on
      const rated = calls.filter(
        (c) => c.sql.includes(`FROM ${Table.NativeRatesDaily}`) && c.sql.includes("currency = ''"),
      );
      expect(rated).toHaveLength(1);
      expect(rated[0].params).toMatchObject({ from: '2020-02-10', through: '2020-04-20' });
    });

    it('asks for no rate when only the native currency moved', async () => {
      const calls = await queriesOf(h, () => changes(A, 'start=2020-01-01&end=2020-01-31&interval=month'));
      expect(calls.some((c) => c.sql.includes(Table.NativeRatesDaily) || c.sql.includes(Table.Exchanges))).toBe(false);
    });
  });

  // -- the same answer rolled up (keep it last: it writes rollups, which the reads after it would use) ---------------

  describe('the same answer rolled up', () => {
    it('the same answer rolled up', async () => {
      const urls = [
        ...['day', 'week', 'month'].flatMap((interval) => [
          `${BALANCES(A)}?start=2020-01-01&end=2020-06-30&interval=${interval}&limit=50`,
          `${BALANCES(H)}?start=2020-01-15&end=2020-05-31&interval=${interval}`,
          `${BALANCES(ISSUER)}?start=2020-02-01&end=2020-04-30&interval=${interval}&limit=2`,
          `${CHANGES(A)}?start=2020-01-01&end=2020-06-30&interval=${interval}`,
          `${CHANGES(H)}?start=2020-01-01&end=2020-06-30&interval=${interval}`,
          `${CHANGES(ISSUER)}?start=2020-01-01&end=2020-06-30&interval=${interval}`,
        ]),
        `${CHANGES(A)}?end=2020-06-30`,
        `${CHANGES(H)}?end=2020-06-30`,
        `${CHANGES(ISSUER)}`,
        `${CHANGES(A)}?start=2020-02-11&end=2020-05-06`,
        `${BALANCES(A)}?start=2020-03-01&end=2020-05-31&interval=month&currency=usd`,
        `${BALANCES(H)}?start=2020-03-01&end=2020-05-31&interval=month&counterparty=${ISSUER2}`,
        `${BALANCES(A)}?start=2019-01-01&interval=month`,
      ];
      const bodies = async (): Promise<unknown[]> => {
        const out: unknown[] = [];
        for (const url of urls) {
          const res = await get(url);
          expect([url, res.status]).toEqual([url, 200]);
          out.push(res.body);
        }
        return out;
      };
      const raw = await bodies();
      expect(raw).toHaveLength(urls.length);
      // the answers are not empty ones
      expect((raw[0] as BalancesBody).count).toBeGreaterThan(10);

      const accounts = [A, H, ISSUER];
      // complete coverage of the world: the groups come from the rollups, and the rest of the window from nothing
      for (const account of accounts) await rollUp(h, api, account, { from: '2020-01-01', through: '2020-07-31' });
      const complete = await queriesOf(h, async () => expect(await bodies()).toEqual(raw));
      expect(reading(complete, Table.AccountLinesDaily).length).toBeGreaterThan(0);
      expect(reading(complete, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'))).toHaveLength(
        0,
      );

      // coverage from 2020-03-01: January and February come from the raw rows, the rest from the rollups
      for (const account of accounts) await rollUp(h, api, account, { from: '2020-03-01', through: '2020-07-31' });
      const partial = await queriesOf(h, async () => expect(await bodies()).toEqual(raw));
      expect(reading(partial, Table.AccountLinesDaily).length).toBeGreaterThan(0);
      expect(
        reading(partial, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}')).length,
      ).toBeGreaterThan(0);

      // coverage that ends in the middle of the world: the days after it are raw
      for (const account of accounts) await rollUp(h, api, account, { from: '2020-02-01', through: '2020-04-30' });
      expect(await bodies()).toEqual(raw);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Stored rates
// ---------------------------------------------------------------------------------------------------------------------

describe('analytics/balances ranked by value, and balance_changes valued, with stored sets of rates', () => {
  let h: Harness;
  let api: ApiClient;
  let world: AnalyticsWorld;

  const sentinel = (day: string, version: number, over: Partial<NativeRatesDailyRow> = {}): NativeRatesDailyRow => ({
    currency: '',
    issuer: '',
    day,
    rate: '0',
    rate_f: 0,
    daily_count: 0,
    latest_count: 0,
    config_version: 1,
    stale: 0,
    version,
    ...over,
  });
  const rate = (
    day: string,
    version: number,
    currency: string,
    rateText: string,
    over: Partial<NativeRatesDailyRow> = {},
  ) =>
    sentinel(day, version, {
      currency,
      issuer: ISSUER,
      rate: rateText,
      rate_f: Number(rateText),
      daily_count: 12,
      latest_count: 12,
      ...over,
    });

  const lines = async (account: string, query: string): Promise<Line[]> =>
    (await api.ok<BalancesBody>(`${BALANCES(account)}?${query}`, 'lines')).body.lines;

  beforeAll(async () => {
    h = await startHarness({
      seed: 'none',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    world = await seedAnalyticsWorld(h);
    await h.ch.insert(Table.NativeRatesDaily, [
      // two days that value the changes of the holder: 7 USD per XRP, so that a quotient has more than 17 digits
      sentinel('2020-02-12', 1_000),
      rate('2020-02-12', 1_000, 'USD', '7'),
      sentinel('2020-03-10', 1_001),
      rate('2020-03-10', 1_001, 'USD', '7'),
      // 03-15: USD is worth 100 to the XRP, EUR 0.5
      sentinel('2020-03-15', 1_002),
      rate('2020-03-15', 1_002, 'USD', '100'),
      rate('2020-03-15', 1_002, 'EUR', '0.5'),
      // 06-01: USD 2, EUR 0.5, BTC 1
      sentinel('2020-06-01', 1_003),
      rate('2020-06-01', 1_003, 'USD', '2'),
      rate('2020-06-01', 1_003, 'EUR', '0.5'),
      rate('2020-06-01', 1_003, 'BTC', '1'),
      // 06-10 is stale and 06-20 is of another config version: neither is a valid day, and USD would be worth 1000 on 06-20
      sentinel('2020-06-10', 1_004, { stale: 1 }),
      sentinel('2020-06-20', 1_005, { config_version: 2 }),
      rate('2020-06-20', 1_005, 'USD', '1000', { config_version: 2 }),
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });
  afterEach(() => jest.restoreAllMocks());

  it("lines: the native line first, then the lines with a rate by |balance| ÷ rate (the rate of the newest valid day at or before the window's end, asset (currency, counterparty)), then the others by |balance|, then the key; limit 10 by default, 50 at most; lines_total counts them all", async () => {
    // the window is the one day `end`: the lines it has at the end of that day, the rates of the newest valid day up to it
    const window = (end: string): string => `start=${end}&end=${end}&interval=day`;

    // the end is 06-30: the newest valid day is 06-01 (06-10 is stale, 06-20 has another config version). USD 150 / 2 = 75,
    // EUR 30 / 0.5 = 60, BTC 0 / 1 = 0: three lines with a rate, the last of them worth nothing but still before the lines
    // without one: GBP and JPY (1000, the key breaks the tie), CAD (|-8|)
    const june = await api.ok<BalancesBody>(`${BALANCES(H)}?${window('2020-06-30')}`, 'lines');
    expect(june.body.lines).toEqual([
      line('XRP', '409.999988'),
      line('USD', '150', ISSUER),
      line('EUR', '30', ISSUER),
      line('BTC', '0', ISSUER),
      line('GBP', '1000', ISSUER2),
      line('JPY', '1000', ISSUER2),
      line('CAD', '-8', CP),
    ]);
    expect(june.body.lines_total).toBe(7);

    // the end is 04-30: the newest valid day is 03-15, USD 150 / 100 = 1.5 and EUR 30 / 0.5 = 60; BTC has no rate there
    expect((await lines(H, window('2020-04-30'))).map((l) => l.currency)).toEqual([
      'XRP',
      'EUR',
      'USD',
      'GBP',
      'JPY',
      'BTC',
    ]);
    // the end is 03-12: the newest valid day is 03-10, USD 150 / 7 = 21.4…, nothing else has a rate
    expect((await lines(H, window('2020-03-12'))).map((l) => l.currency)).toEqual([
      'XRP',
      'USD',
      'GBP',
      'JPY',
      'EUR',
      'BTC',
    ]);
    // the end is 02-20: the newest valid day is 02-12
    expect((await lines(H, window('2020-02-20'))).map((l) => l.currency)).toEqual(['XRP', 'USD', 'GBP', 'JPY', 'BTC']);
    // the end is 02-11: no valid day is at or before it, so no line has a rate: by |balance|
    expect((await lines(H, window('2020-02-11'))).map((l) => l.currency)).toEqual(['XRP', 'JPY', 'BTC']);

    // a filter leaves the lines it keeps, ranked the same way
    const filtered = await lines(H, `${window('2020-06-30')}&currency=usd`);
    expect(filtered).toEqual([line('USD', '150', ISSUER)]);

    // limit: 10 by default, 50 at most, lines_total counts them all (the native line and 55 others)
    const many = world.many;
    const def = await api.ok<BalancesBody>(`${BALANCES(many)}?start=2020-03-12&end=2020-03-13&interval=day`, 'lines');
    expect(def.body.lines_total).toBe(MANY_LINES + 1);
    expect(def.body.lines).toHaveLength(10);
    expect(def.body.lines[0]).toEqual(line('XRP', '1'));
    // |balance| descending: C54 has 55, C46 has 47
    expect(def.body.lines.slice(1)).toEqual(
      Array.from({ length: 9 }, (_, i) => line(manyCurrency(MANY_LINES - 1 - i), String(MANY_LINES - i), ISSUER2)),
    );
    // 2 days of rows for each of the 10 lines
    expect(def.body.count).toBe(20);
    for (const [limit, expected] of [
      ['50', 50],
      ['100', 50],
      ['1000000', 50],
      ['3', 3],
      ['2.9', 2],
      ['0', 10],
      ['-4', 10],
      ['abc', 10],
      ['', 10],
    ] as const) {
      const body = (
        await api.ok<BalancesBody>(
          `${BALANCES(many)}?start=2020-03-12&end=2020-03-12&interval=day&limit=${limit}`,
          'lines',
        )
      ).body;
      expect([limit, body.lines.length, body.lines_total, body.count]).toEqual([
        limit,
        expected,
        MANY_LINES + 1,
        expected,
      ]);
    }
    const fifty = (
      await api.ok<BalancesBody>(`${BALANCES(many)}?start=2020-03-12&end=2020-03-12&interval=day&limit=50`, 'lines')
    ).body;
    expect(fifty.lines[49]).toEqual(line(manyCurrency(MANY_LINES - 49), String(MANY_LINES - 48), ISSUER2));
  });

  it('the rate of a line is that of the asset (currency, counterparty), not of the issuer an owed line is valued as', async () => {
    // USD and EUR of the issuer are rated on 06-01 (2 and 0.5). The issuer's own lines are the ones it owes on, (USD, the
    // typical account), (USD, the counterparty) and (EUR, the counterparty): none of those assets has a rate, so they are
    // ranked by |balance|. Ranked as its own IOU they would be worth 20, 2.5 and 6, and EUR would come before the second USD.
    const body = await api.ok<BalancesBody>(
      `${BALANCES(ISSUER)}?start=2020-01-01&end=2020-06-30&interval=month`,
      'lines',
    );
    expect(body.body.lines.map((l: Line) => `${l.currency}:${l.balance}`)).toEqual([
      'XRP:1000',
      'USD:-40',
      'USD:-5',
      'EUR:-3',
    ]);
  });

  it("values are per (group, day) at the day's rate, 17 digits, 0 without a rate", async () => {
    // the holder's USD: 100 on 02-12 at the stored rate of 7 and 50 on 03-10 at 7; each quotient is cut to 17 digits on its
    // own (14.285714285714286 and 7.1428571428571429), and the sum is exact: not 150 / 7 = 21.428571428571429
    const body = (await api.ok<ChangesBody>(`${CHANGES(H)}?end=2020-06-30`, 'totals')).body;
    const usd = (body.rows as AssetRow[]).find((r) => r.change_type === 'payment_destination' && r.currency === 'USD');
    expect(usd).toEqual(assetRow('payment_destination', 'USD', ISSUER, 2, '150', '0', '21.4285714285714289', '0'));
    // BTC and EUR changed on days that have no set and no trades: 0; GBP and JPY have no rate at all
    const rest = (body.rows as AssetRow[]).filter(
      (r) => r.change_type === 'payment_destination' && r.currency !== 'USD' && r.currency !== 'XRP',
    );
    expect(rest.map((r) => [r.currency, r.in_value])).toEqual([
      ['BTC', '0'],
      ['EUR', '0'],
      ['GBP', '0'],
      ['JPY', '0'],
    ]);
    // the total is the exact sum of the values: 510 + 21.4285714285714289
    expect(body.totals[1]).toEqual(
      total('payment_destination', 8, '531.4285714285714289', '0', '531.4285714285714289'),
    );
    // by month the days of a bucket are added the same way
    const feb = (await api.ok<ChangesBody>(`${CHANGES(H)}?start=2020-02-01&end=2020-03-31&interval=month`, 'totals'))
      .body;
    expect(feb.rows.filter((r: BucketRow) => r.change_type === 'payment_destination')).toEqual([
      bucketRow('2020-02-01', 'payment_destination', 4, '514.285714285714286', '0'),
      bucketRow('2020-03-01', 'payment_destination', 3, '17.1428571428571429', '0'),
    ]);
    // a stored rate of the day wins over what the trades give on read: 02-12 is 7, not 2
    const day = (await api.ok<ChangesBody>(`${CHANGES(H)}?start=2020-02-12&end=2020-02-12&interval=day`, 'totals'))
      .body;
    expect(day.rows).toEqual([bucketRow('2020-02-12', 'payment_destination', 1, '14.285714285714286', '0')]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The ripple-mock seed
// ---------------------------------------------------------------------------------------------------------------------

describe('analytics/balance_changes on the ripple-mock seed', () => {
  const ROWS = fixtureBalanceChanges('ripple-mock');
  const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))].sort();
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("on the ripple-mock seed, for every account, the balance_changes totals' counts and in/out sums equal an oracle from its stored rows", async () => {
    expect(ACCOUNTS.length).toBe(283);

    // the oracle: the stored rows of each account, grouped in the test with BigNumber (a change on a line the account owes on
    // is a change of its own IOU), and valued with the rates of `RatesService` (what the table-less read of `DailyRates`
    // computes), by the same rule: the quotient of a (type, asset, day) group cut to 17 digits
    const rates = new RatesService(h.ch, 'XRP');
    const days = ROWS.map((r) => new Date(r.close_time * 1000).toISOString().slice(0, 10)).sort();
    const from = new Date(`${days[0]}T00:00:00Z`);
    const toExclusive = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000);
    const issued = new Map<string, { currency: string; issuer: string }>();
    for (const r of ROWS) {
      if (r.counterparty === '') continue;
      const owes = new BigNumber(r.final_balance).lt(0);
      const asset = { currency: r.currency, issuer: owes ? r.account : r.counterparty };
      issued.set(`${asset.currency}.${asset.issuer}`, asset);
    }
    const rateOf = await rates.dailyNativeRates([...issued.values()], from, toExclusive);

    let rated = 0;
    let checked = 0;
    for (const account of ACCOUNTS) {
      const mine = ROWS.filter((r) => r.account === account);
      const types = new Map<string, { count: number; inValue: BigNumber; outValue: BigNumber }>();
      const assets = new Map<
        string,
        { type: string; currency: string; issuer: string; count: number; inn: BigNumber; out: BigNumber }
      >();
      const perDay = new Map<
        string,
        { type: string; asset: { currency: string; issuer?: string }; day: string; inn: BigNumber; out: BigNumber }
      >();
      for (const r of mine) {
        const amount = new BigNumber(r.amount_change);
        const owes = r.counterparty !== '' && new BigNumber(r.final_balance).lt(0);
        const issuer = r.counterparty === '' ? '' : owes ? account : r.counterparty;
        const day = new Date(r.close_time * 1000).toISOString().slice(0, 10);
        const key = `${r.change_type}|${r.currency}|${issuer}`;
        const a = assets.get(key) ?? {
          type: r.change_type,
          currency: r.currency,
          issuer,
          count: 0,
          inn: new BigNumber(0),
          out: new BigNumber(0),
        };
        a.count += 1;
        if (amount.gt(0)) a.inn = a.inn.plus(amount);
        if (amount.lt(0)) a.out = a.out.plus(amount.negated());
        assets.set(key, a);
        const d = perDay.get(`${key}|${day}`) ?? {
          type: r.change_type,
          asset: issuer === '' ? { currency: r.currency } : { currency: r.currency, issuer },
          day,
          inn: new BigNumber(0),
          out: new BigNumber(0),
        };
        if (amount.gt(0)) d.inn = d.inn.plus(amount);
        if (amount.lt(0)) d.out = d.out.plus(amount.negated());
        perDay.set(`${key}|${day}`, d);
      }
      for (const d of perDay.values()) {
        const t = types.get(d.type) ?? { count: 0, inValue: new BigNumber(0), outValue: new BigNumber(0) };
        const inValue = nativeValue(d.inn, d.asset, d.day, rateOf, 'XRP');
        const outValue = nativeValue(d.out, d.asset, d.day, rateOf, 'XRP');
        if (d.asset.issuer !== undefined && (inValue.gt(0) || outValue.gt(0))) rated += 1;
        t.inValue = t.inValue.plus(inValue);
        t.outValue = t.outValue.plus(outValue);
        types.set(d.type, t);
      }
      for (const a of assets.values()) {
        const t = types.get(a.type) as { count: number };
        t.count += a.count;
      }

      const body = (await api.ok<ChangesBody>(`${CHANGES(account)}`, 'totals')).body;
      const served = new Map(body.totals.map((t: Total): [string, Total] => [t.change_type ?? '', t]));
      expect([account, [...served.keys()].sort()]).toEqual([account, [...types.keys()].sort()]);
      for (const [type, t] of types) {
        const s = served.get(type) as Total;
        expect([account, type, s.count, s.in_value, s.out_value, s.net_value]).toEqual([
          account,
          type,
          t.count,
          t.inValue.toString(),
          t.outValue.toString(),
          t.inValue.minus(t.outValue).toString(),
        ]);
      }
      // the exact sums of every asset of every type
      const servedRows = (body.rows as AssetRow[])
        .map((r) => `${r.change_type ?? ''}|${r.currency}|${r.issuer ?? ''}|${r.count}|${r.in}|${r.out}`)
        .sort();
      const oracleRows = [...assets.values()]
        .map((a) => `${a.type}|${a.currency}|${a.issuer}|${a.count}|${a.inn.toString()}|${a.out.toString()}`)
        .sort();
      expect([account, servedRows]).toEqual([account, oracleRows]);
      expect(body.count).toBe(assets.size);
      checked += mine.length;
    }
    expect(checked).toBe(ROWS.length);
    // the oracle is not made of zeros: some issued amounts of the mock were valued
    expect(rated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A light account on a table that is not light
// ---------------------------------------------------------------------------------------------------------------------

describe("a light account's All reads within its own rows", () => {
  /** An account of the mock with 2 changes: the fee and an EscrowCreate. */
  const LIGHT = 'rGhDCgik9CwiNpcNnYHkEHcMgw2dkLgtNB';
  /** The rows ClickHouse reads for a granule of the primary index. */
  const GRANULE = 8192;
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    // four parts of 200,000 changes of the busiest account, in ledger ranges between the mock ledgers: the table has
    // 800,000 rows that are not the light account's
    const [busiest] = await h.ch.query<{ account: string }>(
      `SELECT account FROM ${Table.BalanceChanges} GROUP BY account ORDER BY count() DESC, account LIMIT 1`,
    );
    await insertBulk(
      h,
      Table.BalanceChanges,
      `SELECT * FROM ${Table.BalanceChanges} WHERE account = {account:String} AND change_type != 'transaction_cost'
        ORDER BY ledger_index, tx_index LIMIT 1`,
      { account: busiest.account },
      (base) => `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index`,
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });

  it("a light account's All reads within its own rows", async () => {
    expect(BULK_BASES.length * BULK_PER_PART).toBe(800_000);
    const [own] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.BalanceChanges} WHERE account = {account:String}`,
      { account: LIGHT },
    );
    expect(Number(own.n)).toBe(2);
    // the rows of the account, to the granule, in each part that holds them
    const bound = Number(own.parts) * (Math.ceil(Number(own.n) / GRANULE) + 1) * GRANULE;
    expect(bound).toBeLessThan(40_000);

    for (const [name, url] of [
      ['balance_changes', CHANGES(LIGHT)],
      ['balance_changes with an interval', `${CHANGES(LIGHT)}?interval=month`],
      ['balances', `${BALANCES(LIGHT)}?interval=month`],
      [
        'balances, with the rest of the parameters',
        `${BALANCES(LIGHT)}?interval=week&start=2014-01-01&limit=50&currency=XRP`,
      ],
    ] as const) {
      let body: { count?: number; totals?: unknown[]; lines?: unknown[] } = {};
      const reads = await readsOf(h, Table.BalanceChanges, async () => {
        body = (await api.ok(url)).body;
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads)
        expect([name, read.read_rows <= bound ? 'bounded' : read.read_rows]).toEqual([name, 'bounded']);
      // the answer is the account's: 2 changes
      expect([name, (body.totals ?? body.lines)?.length]).toEqual([
        name,
        name.startsWith('balance_changes') ? 2 : expect.any(Number),
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Xahau
// ---------------------------------------------------------------------------------------------------------------------

describe('analytics/balances on the xahau-recorded ledgers', () => {
  const ROWS = fixtureBalanceChanges('xahau-recorded');
  const EVERNODE = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'; // the issuer of EVR, which has no XAH line of its own to speak of
  const [EVR] = ROWS.filter((r) => r.currency === 'EVR' && r.account !== EVERNODE);
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('currency (upper-cased) and counterparty (alias issuer) filter the lines; counterparty with currency=XAH is 400 counterparty cannot be specified for XAH', async () => {
    const window = 'start=2013-01-01&interval=month';
    for (const query of [`currency=XAH&counterparty=${EVERNODE}`, `currency=xah&issuer=${EVERNODE}`]) {
      const res = await api.get(`${BALANCES(EVR.account)}?${window}&${query}`);
      expect([query, res.status, res.body]).toEqual([
        query,
        400,
        { result: 'error', message: 'counterparty cannot be specified for XAH' },
      ]);
    }
    // XRP is an ordinary currency on Xahau: a counterparty is fine
    expect((await api.get(`${BALANCES(EVR.account)}?${window}&currency=XRP&counterparty=${EVERNODE}`)).status).toBe(
      200,
    );

    // the native line is XAH: first, with no counterparty, and the balance of its last change
    const mine = ROWS.filter((r) => r.account === EVR.account);
    const lastXah = [...mine]
      .filter((r) => r.currency === 'XAH')
      .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index)
      .pop();
    const all = (await api.ok(`${BALANCES(EVR.account)}?${window}`, 'lines')).body as BalancesBody;
    expect(all.lines[0]).toEqual(line('XAH', (lastXah as { final_balance: string }).final_balance));
    expect(all.lines.slice(1).map((l) => l.currency)).not.toContain('XAH');
    expect(all.lines).toContainEqual(expect.objectContaining({ currency: 'EVR', counterparty: EVERNODE }));
    expect(all.lines_total).toBe(new Set(mine.map((r) => `${r.currency}|${r.counterparty}`)).size);
    // the filters
    const evr = (await api.ok(`${BALANCES(EVR.account)}?${window}&currency=evr&issuer=${EVERNODE}`, 'lines'))
      .body as BalancesBody;
    expect(evr.lines.map((l) => [l.currency, l.counterparty])).toEqual([['EVR', EVERNODE]]);
    const xah = (await api.ok(`${BALANCES(EVR.account)}?${window}&currency=xah`, 'lines')).body as BalancesBody;
    expect(xah.lines).toEqual([line('XAH', (lastXah as { final_balance: string }).final_balance)]);
    expect(xah.rows.every((r) => r.counterparty === undefined)).toBe(true);
  });
});

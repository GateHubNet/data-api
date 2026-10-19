import { AccountPaymentsRow, NativeRatesDailyRow, Table } from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { AnalyticsWorld, seedAnalyticsWorld } from './support/analytics-world';

/**
 * `GET /v2/accounts/:address/reports[/:date]?interval=day|week|month` on the hand-worked world of
 * `support/analytics-world.ts` (read it for its ledgers and the rates), with the payments below written into
 * `account_payments` at times that world has a ledger for.
 *
 * With `interval` a report is a bucket: the totals are the sums of its days' values (each payment at the rate of its day),
 * the highs the largest of the days', the payment counts sums, and the counterparties are counted (or listed in the order of
 * their first payment in the bucket) over the whole bucket. A bucket is whole, though the window ends in the middle of it.
 *
 * The rates of the world: USD of the issuer is worth 2 per XRP on 2020-02-10 to 02-24 and 4 on 04-20 to 05-04, and has none
 * on any other day.
 */

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
  payments?: { tx_hash: string; amount: string; currency: string; issuer?: string; type: string }[];
}
interface Body {
  result: string;
  start: string;
  end: string;
  count: number;
  reports: Report[];
}

const path = (account: string): string => `/v2/accounts/${account}/reports`;

// -- the payments of the typical account (A): [time, tx_index, direction, counterparty, amount, currency] ----------------
//
// S is the stranger, B the counterparty and I the issuer of the world. `USD` is the issuer's.

type Who = 'S' | 'B' | 'I';
type PaymentSpec = [string, number, 'sent' | 'received', Who, string, 'XRP' | 'USD'];

const PAYMENTS: PaymentSpec[] = [
  ['2020-01-16T09:00:00Z', 1, 'sent', 'S', '10', 'XRP'], // week 01-13, January
  ['2020-01-17T09:00:00Z', 1, 'sent', 'B', '5', 'XRP'],
  ['2020-01-17T09:00:00Z', 2, 'sent', 'S', '2', 'XRP'], // S again, a day later: once in the week
  ['2020-01-17T09:00:00Z', 3, 'received', 'I', '7', 'XRP'],
  ['2020-01-31T12:00:00Z', 1, 'sent', 'B', '3', 'XRP'], // week 01-27, still January: B has been paid in the month
  ['2020-02-03T09:00:00Z', 1, 'received', 'S', '1', 'XRP'], // week 02-03, February
  ['2020-02-10T11:00:00Z', 1, 'received', 'I', '20', 'USD'], // week 02-10: 20 USD at 2 are 10
  ['2020-02-12T09:00:00Z', 1, 'received', 'B', '10', 'USD'], // 5
  ['2020-02-12T09:00:00Z', 2, 'sent', 'I', '4', 'XRP'],
  ['2020-02-14T09:00:00Z', 1, 'received', 'S', '8', 'USD'], // 4
  ['2020-03-01T09:00:00Z', 1, 'received', 'I', '6', 'USD'], // a Sunday, the week of 02-24, March: no rate that day, so 0
  ['2020-03-31T23:59:59Z', 1, 'sent', 'B', '1', 'XRP'], // the week of 03-30, March
  ['2020-04-01T00:00:00Z', 1, 'sent', 'B', '2', 'XRP'], // the same week, April
  ['2020-04-20T12:00:00Z', 1, 'sent', 'S', '40', 'USD'], // 40 USD at 4 are 10
  ['2020-06-15T09:00:00Z', 1, 'received', 'B', '9', 'XRP'], // week 06-15, June
];

/** What a bucket's report is, the counterparties as lists (their number is the length). */
interface Bucket {
  hr: string; // high_value_received
  hs: string;
  tr: string; // total_value_received
  ts: string;
  total: string;
  ps: number; // payments_sent
  pr: number;
  rc: Who[]; // receiving_counterparties: the accounts A paid
  sc: Who[]; // sending_counterparties: the ones that paid A
}
const ZERO: Bucket = { hr: '0', hs: '0', tr: '0', ts: '0', total: '0', ps: 0, pr: 0, rc: [], sc: [] };

/** The weeks of A, by their Monday, worked out from PAYMENTS. */
const WEEKS: Record<string, Bucket> = {
  '2020-01-13': { hr: '7', hs: '10', tr: '7', ts: '17', total: '24', ps: 3, pr: 1, rc: ['S', 'B'], sc: ['I'] },
  '2020-01-20': ZERO,
  '2020-01-27': { ...ZERO, hs: '3', ts: '3', total: '3', ps: 1, rc: ['B'] },
  '2020-02-03': { ...ZERO, hr: '1', tr: '1', total: '1', pr: 1, sc: ['S'] },
  // 10 + 5 + 4 received (the USD at the rate of their days), 4 sent; the senders in the order of their first payment
  '2020-02-10': { hr: '10', hs: '4', tr: '19', ts: '4', total: '23', ps: 1, pr: 3, rc: ['I'], sc: ['I', 'B', 'S'] },
  '2020-02-17': ZERO,
  '2020-02-24': { ...ZERO, pr: 1, sc: ['I'] }, // 6 USD on the Sunday, which has no rate
  '2020-03-30': { ...ZERO, hs: '2', ts: '3', total: '3', ps: 2, rc: ['B'] }, // B paid on two days: once
  '2020-04-06': ZERO,
  '2020-04-13': ZERO,
  '2020-04-20': { ...ZERO, hs: '10', ts: '10', total: '10', ps: 1, rc: ['S'] },
  '2020-06-15': { ...ZERO, hr: '9', tr: '9', total: '9', pr: 1, sc: ['B'] },
};

/** The months of A, by their first day. */
const MONTHS: Record<string, Bucket> = {
  // S and B were paid on 3 and 4 days between them: 2 accounts, S first, as it was paid first
  '2020-01-01': { hr: '7', hs: '10', tr: '7', ts: '20', total: '27', ps: 4, pr: 1, rc: ['S', 'B'], sc: ['I'] },
  '2020-02-01': { hr: '10', hs: '4', tr: '20', ts: '4', total: '24', ps: 1, pr: 4, rc: ['I'], sc: ['S', 'I', 'B'] },
  '2020-03-01': { ...ZERO, hs: '1', ts: '1', total: '1', ps: 1, pr: 1, rc: ['B'], sc: ['I'] },
  '2020-04-01': { ...ZERO, hs: '10', ts: '12', total: '12', ps: 2, rc: ['B', 'S'] },
  '2020-05-01': ZERO,
  '2020-06-01': { ...ZERO, hr: '9', tr: '9', total: '9', pr: 1, sc: ['B'] },
};

describe('account reports with an interval, on the hand-worked world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let world: AnalyticsWorld;
  let A: string;
  let who: Record<Who, string>;

  beforeAll(async () => {
    h = await startHarness({
      seed: 'none',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    get = api.get;
    world = await seedAnalyticsWorld(h);
    A = world.typical;
    who = { S: world.stranger, B: world.counterparty, I: world.issuer };

    await h.ch.insert(
      Table.AccountPayments,
      PAYMENTS.map(
        ([time, tx_index, direction, counterparty, amount, currency], i) =>
          ({
            account: A,
            ledger_index: world.ledgerAt(time) as number,
            tx_index,
            tx_hash: (i + 1).toString(16).toUpperCase().padStart(64, '0'),
            close_time: Date.parse(time) / 1000,
            direction,
            counterparty: who[counterparty],
            currency,
            issuer: currency === 'XRP' ? '' : world.issuer,
            delivered_amount: amount,
            delivered_amount_f: Number(amount),
            source_tag: null,
            destination_tag: null,
          }) satisfies AccountPaymentsRow,
      ),
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  // the rates computed on read are kept for a minute: a test that reads the sets or the trades starts without them
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  /** The report of a bucket as the route says it, with the counterparties listed (`accounts`) or counted. */
  const report = (date: string, b: Bucket, accounts: boolean): Report => ({
    account: A,
    date: `${date}T00:00:00Z`,
    high_value_received: b.hr,
    high_value_sent: b.hs,
    total_value_received: b.tr,
    total_value_sent: b.ts,
    total_value: b.total,
    payments_sent: b.ps,
    payments_received: b.pr,
    receiving_counterparties: accounts ? b.rc.map((w) => who[w]) : b.rc.length,
    sending_counterparties: accounts ? b.sc.map((w) => who[w]) : b.sc.length,
  });
  const reports = (buckets: Record<string, Bucket>, dates: string[], accounts: boolean): Report[] =>
    dates.map((date) => report(date, buckets[date], accounts));

  const body = async (query: string, date?: string): Promise<Body> =>
    (await api.ok(`${path(A)}${date ? `/${date}` : ''}?${query}`, 'reports')).body as Body;
  const failure = async (query: string, date?: string): Promise<{ status: number; body: unknown }> => {
    const res = await get(`${path(A)}${date ? `/${date}` : ''}?${query}`);
    return { status: res.status, body: res.body };
  };
  const bad = (message: string) => ({ status: 400, body: { result: 'error', message } });

  /** The queries the harness's ClickHouse service ran while `fn` ran. */
  async function queriesOf(fn: () => Promise<unknown>): Promise<{ sql: string; params: Record<string, unknown> }[]> {
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

  it('week and month give a report per bucket from the bucket of start to that of end', async () => {
    // 01-15 is a Wednesday, and 02-26 one too: the first week begins before start and the last one holds days after end
    const weeks = await body('interval=week&start=2020-01-15&end=2020-02-26');
    expect(weeks).toEqual({
      result: 'success',
      start: '2020-01-15T00:00:00Z',
      end: '2020-02-26T00:00:00Z',
      count: 7,
      reports: reports(
        WEEKS,
        ['2020-01-13', '2020-01-20', '2020-01-27', '2020-02-03', '2020-02-10', '2020-02-17', '2020-02-24'],
        false,
      ),
    });
    // the last week holds Sunday 03-01, after the end of the window: its 6 USD are counted (at no rate: 0 in value)
    expect(weeks.reports[6]).toMatchObject({ payments_received: 1, sending_counterparties: 1, total_value: '0' });

    const months = await body('interval=month&start=2020-01-31&end=2020-06-30');
    expect(months.count).toBe(6);
    expect(months.reports).toEqual(
      reports(MONTHS, ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01', '2020-05-01', '2020-06-01'], false),
    );
    // an end a second into April makes April a report too, whole: the payment of 04-20 is in it
    expect((await body('interval=month&start=2020-03-15&end=2020-04-01T00:00:01')).reports.map((r) => r.date)).toEqual([
      '2020-03-01T00:00:00Z',
      '2020-04-01T00:00:00Z',
    ]);
    expect((await body('interval=month&start=2020-03-15&end=2020-04-01T00:00:01')).reports[1].total_value_sent).toBe(
      '12',
    );
  });

  it('a week and a month are cut at the UTC midnight: 23:59:59 on the 31st is March, 00:00:00 on the 1st is April, in one week', async () => {
    const months = (await body('interval=month&start=2020-03-01&end=2020-04-30')).reports;
    expect(months.map((r) => [r.date, r.total_value_sent])).toEqual([
      ['2020-03-01T00:00:00Z', '1'],
      ['2020-04-01T00:00:00Z', '12'],
    ]);
    const weeks = (await body('interval=week&start=2020-03-30&end=2020-04-05')).reports;
    expect(weeks).toEqual(reports(WEEKS, ['2020-03-30'], false));
    expect(weeks[0]).toMatchObject({ total_value_sent: '3', payments_sent: 2, receiving_counterparties: 1 });
  });

  it('a counterparty paid on two days of a week counts once in it; with accounts they are listed in the order of their first payment in the bucket', async () => {
    // S was paid on 01-16 and 01-17, B on 01-17: two accounts in the week, S first. Day by day the same payments give 1 and 2
    const [week] = (await body('interval=week&start=2020-01-13&end=2020-01-19&accounts=true')).reports;
    expect(week.receiving_counterparties).toEqual([who.S, who.B]);
    expect(week.sending_counterparties).toEqual([who.I]);
    const [counted] = (await body('interval=week&start=2020-01-13&end=2020-01-19')).reports;
    expect([counted.receiving_counterparties, counted.sending_counterparties]).toEqual([2, 1]);
    const days = (await body('interval=day&start=2020-01-16&end=2020-01-17')).reports;
    expect(days.map((r) => r.receiving_counterparties)).toEqual([1, 2]);
    // a day lists its accounts by their first payment too: B (tx 1) before S (tx 2) on 01-17, the other way round in the week
    const day = (await body('interval=day&start=2020-01-17&end=2020-01-17&accounts=true')).reports[0];
    expect(day.receiving_counterparties).toEqual([who.B, who.S]);

    // the month holds four payments to the two of them: still two, and S and B are in the order of their first payment
    const [jan] = (await body('interval=month&start=2020-01-01&end=2020-01-31&accounts=true')).reports;
    expect(jan.receiving_counterparties).toEqual([who.S, who.B]);
    const [janCounted] = (await body('interval=month&start=2020-01-01&end=2020-01-31')).reports;
    expect([janCounted.receiving_counterparties, janCounted.payments_sent]).toEqual([2, 4]);

    // February's senders are S (02-03 and again 02-14), I (02-10) and B (02-12): not alphabetical, not the last week's order
    const [feb] = (await body('interval=month&start=2020-02-01&end=2020-02-29&accounts=true')).reports;
    expect(feb.sending_counterparties).toEqual([who.S, who.I, who.B]);
    const [week0210] = (await body('interval=week&start=2020-02-10&end=2020-02-16&accounts=true')).reports;
    expect(week0210.sending_counterparties).toEqual([who.I, who.B, who.S]);
  });

  it('adds the days of a bucket up: values at the rate of each day, the highs the largest of the days, the counts summed', async () => {
    // week 02-10: 20 USD (02-10), 10 (02-12) and 8 (02-14), all at 2, and 4 XRP sent; the highs are 10 USD / 2 and 4 XRP
    const [week] = (await body('interval=week&start=2020-02-10&end=2020-02-10')).reports;
    expect(week).toMatchObject({
      high_value_received: '10',
      high_value_sent: '4',
      total_value_received: '19',
      total_value_sent: '4',
      total_value: '23',
      payments_received: 3,
      payments_sent: 1,
    });
    // the 6 USD of 03-01 have no rate that day (that of 02-10 to 02-24 is gone), whatever the rate of the week before
    const [after] = (await body('interval=week&start=2020-02-24&end=2020-02-24')).reports;
    expect([after.total_value_received, after.payments_received]).toEqual(['0', 1]);
    // the same USD at another rate: 40 USD on 04-20 at 4
    expect((await body('interval=month&start=2020-04-01&end=2020-04-01')).reports[0]).toMatchObject({
      high_value_sent: '10',
      total_value_sent: '12',
    });
  });

  it('has the keys of a report in the order of the route, whatever the interval', async () => {
    const keys = [
      'account',
      'date',
      'high_value_received',
      'high_value_sent',
      'total_value_received',
      'total_value_sent',
      'total_value',
      'payments_sent',
      'payments_received',
      'receiving_counterparties',
      'sending_counterparties',
    ];
    for (const interval of ['day', 'week', 'month']) {
      const [first] = (await body(`interval=${interval}&start=2020-02-10&end=2020-02-10`)).reports;
      expect(Object.keys(first)).toEqual(keys);
    }
  });

  it('interval=day is the answer without interval', async () => {
    const window = 'start=2020-01-16&end=2020-02-14&accounts=true&payments=true';
    const plain = await api.ok(`${path(A)}?${window}`, 'reports');
    const daily = await api.ok(`${path(A)}?interval=day&${window}`, 'reports');
    expect(plain.body.count).toBe(30);
    expect(daily.body).toEqual(plain.body);
    expect(plain.body.reports.filter((r: Report) => (r.payments ?? []).length > 0)).toHaveLength(7);
    // an empty interval is none
    expect((await api.ok(`${path(A)}?interval=&${window}`, 'reports')).body).toEqual(plain.body);
    // payments are listed with day
    expect(daily.body.reports[1].payments).toEqual([
      expect.objectContaining({ amount: '5', currency: 'XRP', type: 'sent' }),
      expect.objectContaining({ amount: '2', currency: 'XRP', type: 'sent' }),
      expect.objectContaining({ amount: '7', currency: 'XRP', type: 'received' }),
    ]);
  });

  it('payments=true with week is 400 payments can only be listed with interval day, after the window check', async () => {
    const message = 'payments can only be listed with interval day';
    expect(await failure('interval=week&payments=true')).toEqual(bad(message));
    expect(await failure('interval=month&payments=true&start=2020-01-01&end=2020-02-01')).toEqual(bad(message));
    expect(await failure('interval=month&payments=TRUE', '2020-02-14')).toEqual(bad(message));
    // the checks before it come first: the dates, the interval, the length
    expect(await failure('interval=week&payments=true&start=bogus')).toEqual(bad('invalid date format'));
    expect(await failure('interval=week&payments=true&start=2020-01-01&end=bogus')).toEqual(
      bad('invalid end date format'),
    );
    expect(await failure('interval=year&payments=true')).toEqual(bad('invalid interval - use: day, week, month'));
    expect(await failure('interval=week&payments=true&start=2010-01-01&end=2020-01-01')).toEqual(
      bad('choose a date range less than 200 weeks'),
    );
    expect(await failure('interval=month&payments=true&start=1990-01-01&end=2020-01-01')).toEqual(
      bad('choose a date range less than 200 months'),
    );
    // not asked for, or asked with day: no error
    expect((await get(`${path(A)}?interval=week&payments=false`)).status).toBe(200);
    expect((await get(`${path(A)}?interval=day&payments=true`)).status).toBe(200);
  });

  it('an invalid interval is 400 after the dates', async () => {
    const message = 'invalid interval - use: day, week, month';
    expect(await failure('interval=year')).toEqual(bad(message));
    expect(await failure('interval=weeks&start=2020-01-01&end=2020-01-31')).toEqual(bad(message));
    expect(await failure('interval=Week')).toEqual(bad(message));
    // the dates are read first, a date in the path too
    expect(await failure('interval=year&start=bogus')).toEqual(bad('invalid date format'));
    expect(await failure('interval=year&start=2020-01-01&end=bogus')).toEqual(bad('invalid end date format'));
    expect(await failure('interval=year', 'bogus')).toEqual(bad('invalid date format'));
    expect(await failure('interval=year', '2020-02-14')).toEqual(bad(message));
    // and the interval is read before the length
    expect(await failure('interval=year&start=2010-01-01&end=2020-01-01')).toEqual(bad(message));
    // the first of a repeated one counts
    expect((await get(`${path(A)}?interval=week&interval=year`)).status).toBe(200);
  });

  it('allows 200 buckets between the first and the last, and refuses one more: days, weeks and months', async () => {
    expect((await body('start=2020-01-01&end=2020-07-19')).count).toBe(201);
    expect(await failure('start=2020-01-01&end=2020-07-20')).toEqual(bad('choose a date range less than 200 days'));
    expect((await body('interval=week&start=2020-01-06&end=2023-11-06')).count).toBe(201);
    expect(await failure('interval=week&start=2020-01-06&end=2023-11-13')).toEqual(
      bad('choose a date range less than 200 weeks'),
    );
    expect((await body('interval=month&start=2020-01-01&end=2036-09-30')).count).toBe(201);
    expect(await failure('interval=month&start=2020-01-01&end=2036-10-01')).toEqual(
      bad('choose a date range less than 200 months'),
    );
    // the limit of an interval of day is the one of days
    expect(await failure('interval=day&start=2020-01-01&end=2020-07-20')).toEqual(
      bad('choose a date range less than 200 days'),
    );
  });

  it('a date in the path with month is the one bucket that holds it', async () => {
    const res = await body('interval=month', '2020-02-14');
    expect(res).toEqual({
      result: 'success',
      start: '2020-02-14T00:00:00Z',
      end: '2020-02-14T00:00:00Z',
      count: 1,
      reports: reports(MONTHS, ['2020-02-01'], false),
    });
    expect((await body('interval=week&accounts=true', '2020-02-12')).reports).toEqual(
      reports(WEEKS, ['2020-02-10'], true),
    );
  });

  it('descending lists the newest bucket first', async () => {
    const up = await body('interval=week&start=2020-01-13&end=2020-02-02&accounts=true');
    const down = await body('interval=week&start=2020-01-13&end=2020-02-02&accounts=true&descending=true');
    expect(up.reports.map((r) => r.date)).toEqual([
      '2020-01-13T00:00:00Z',
      '2020-01-20T00:00:00Z',
      '2020-01-27T00:00:00Z',
    ]);
    expect(down.reports).toEqual([...up.reports].reverse());
  });

  it('is a report of zeros for a bucket in the future, with nothing read', async () => {
    const calls = await queriesOf(async () => {
      const res = await body('interval=month&start=2999-01-01&end=2999-02-10');
      expect(res.reports.map((r) => [r.date, r.total_value, r.payments_sent, r.receiving_counterparties])).toEqual([
        ['2999-01-01T00:00:00Z', '0', 0, 0],
        ['2999-02-01T00:00:00Z', '0', 0, 0],
      ]);
    });
    expect(calls.some((c) => c.sql.includes(Table.AccountPayments))).toBe(false);
  });

  it('is zeros for an account with no payment, and for a bucket the account did not pay in', async () => {
    const res = await api.ok(`${path(world.stranger)}?interval=week&start=2020-01-13&end=2020-01-26`, 'reports');
    expect(res.body.reports).toEqual([
      expect.objectContaining({ date: '2020-01-13T00:00:00Z', total_value: '0', payments_sent: 0 }),
      expect.objectContaining({ date: '2020-01-20T00:00:00Z', total_value: '0', payments_sent: 0 }),
    ]);
  });

  it('reads the payments of the days of the buckets once, grouped by day, and the counterparties by bucket', async () => {
    const calls = await queriesOf(() => body('interval=week&start=2020-02-10&end=2020-02-10&accounts=true'));
    const reads = calls.filter((c) => c.sql.includes(Table.AccountPayments));
    expect(reads).toHaveLength(2);
    // the groups stay per day, so that each day is valued at its rate; the counterparties are the whole bucket's
    const groups = reads.find((c) => c.sql.includes('amount_sum'));
    expect(groups?.sql).toContain("toString(toDate(close_time, 'UTC')) AS day");
    const list = reads.find((c) => !c.sql.includes('amount_sum'));
    expect(list?.sql).toContain("toString(toMonday(toDate(close_time, 'UTC'))) AS day");
    expect(reads.every((c) => c.params.account === A)).toBe(true);
  });

  it('values through DailyRates: the rates of the days with an issued payment, and no others', async () => {
    const calls = await queriesOf(() => body('interval=month&start=2020-02-01&end=2020-02-01'));
    // the days of February that have a payment in USD: 02-10, 02-12 and 02-14 (02-03 and the other XRP days need none)
    const valid = calls.filter((c) => c.sql.includes(`FROM ${Table.NativeRatesDaily}`));
    expect(valid.length).toBeGreaterThanOrEqual(1);
    expect(valid[0].params).toMatchObject({ from: '2020-02-10', through: '2020-02-14' });
    const trades = calls.filter((c) => c.sql.includes(`FROM ${Table.Exchanges}`));
    expect(trades.length).toBeGreaterThanOrEqual(1);
  });

  it('asks for no rate when a bucket has only native payments', async () => {
    const calls = await queriesOf(() => body('interval=month&start=2020-01-01&end=2020-01-01'));
    expect(calls.some((c) => c.sql.includes(Table.NativeRatesDaily) || c.sql.includes(Table.Exchanges))).toBe(false);
  });

  // keep it last: it writes a set of rates that the days after it are valued by
  it('values a day that has a stored set of rates by it', async () => {
    const version = 1_000;
    const sentinel: NativeRatesDailyRow = {
      currency: '',
      issuer: '',
      day: '2020-02-12',
      rate: '0',
      rate_f: 0,
      daily_count: 0,
      latest_count: 0,
      config_version: 1,
      stale: 0,
      version,
    };
    await h.ch.insert(Table.NativeRatesDaily, [
      sentinel,
      { ...sentinel, currency: 'USD', issuer: world.issuer, rate: '10', rate_f: 10, daily_count: 12, latest_count: 12 },
    ]);
    // 10 USD on 02-12 are 1 now, not 5; the other days of the month are valued on read, at 2, as before
    const [feb] = (await body('interval=month&start=2020-02-01&end=2020-02-01')).reports;
    expect(feb).toMatchObject({ total_value_received: '16', total_value: '20', high_value_received: '10' });
  });
});

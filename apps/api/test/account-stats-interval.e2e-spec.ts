import { Table } from '@gatehub/data-api-shared';
import { bucketStart, ceilBucket, nextBucket, VolumeInterval } from '../src/network/volume-buckets';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { AnalyticsWorld, seedAnalyticsWorld } from './support/analytics-world';
import { csvDisposition } from './support/csv';
import { rollUp } from './support/rollups';

/**
 * `GET /v2/accounts/:address/stats/:family?interval=day|week|month` on the hand-worked world of
 * `support/analytics-world.ts` (read it for the rows these numbers are worked out from).
 *
 * With `interval` the rows are buckets: a bucket is a row when its start is at or after `start` and before `end`; `date` is
 * its start, and the marker is that day. `transactions` has a row for each bucket in which the account sent a transaction
 * (with the counts of the whole bucket); `value` has a row for every bucket from the first one in which the account had a
 * balance to the last before `end`, valued at the end of the bucket's last day (the current bucket: now).
 *
 * The days of the world are in 2020, so a window that ends before 2020-07-01 holds all of it; without an `end` the window
 * runs to now and `value` has a row for each bucket since.
 */

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

/** The marker of the page that ends with a bucket: the base64url of the JSON array of its day. */
const markerOf = (day: string): string => Buffer.from(JSON.stringify([day]), 'utf8').toString('base64url');

const tx = (day: string, n: number, result: Record<string, number>, type: Record<string, number>): TxRow => ({
  date: `${day}T00:00:00Z`,
  transaction_count: n,
  result,
  type,
});
const value = (day: string, account_value: string, balance_change_count: number): ValueRow => ({
  date: `${day}T00:00:00Z`,
  account_value,
  balance_change_count,
});

// -- what the typical account sent, by bucket (worked out from TXS of the world) ----------------------------------------

const TX_MONTHS: Record<string, TxRow> = {
  jan: tx('2020-01-01', 4, { tecUNFUNDED_OFFER: 1, tesSUCCESS: 3 }, { OfferCreate: 1, Payment: 2, TrustSet: 1 }),
  feb: tx('2020-02-01', 3, { tecPATH_DRY: 1, tesSUCCESS: 2 }, { Payment: 3 }),
  mar: tx('2020-03-01', 2, { tesSUCCESS: 2 }, { AccountSet: 1, Payment: 1 }),
  apr: tx('2020-04-01', 2, { tesSUCCESS: 2 }, { OfferCreate: 2 }),
  jun: tx('2020-06-01', 1, { tesSUCCESS: 1 }, { Payment: 1 }),
};
const TX_WEEKS: Record<string, TxRow> = {
  '0113': tx('2020-01-13', 3, { tesSUCCESS: 3 }, { Payment: 2, TrustSet: 1 }),
  '0127': tx('2020-01-27', 1, { tecUNFUNDED_OFFER: 1 }, { OfferCreate: 1 }),
  '0203': tx('2020-02-03', 1, { tesSUCCESS: 1 }, { Payment: 1 }),
  '0210': tx('2020-02-10', 2, { tecPATH_DRY: 1, tesSUCCESS: 1 }, { Payment: 2 }),
  '0224': tx('2020-02-24', 1, { tesSUCCESS: 1 }, { AccountSet: 1 }), // the Sunday 03-01 is in this week
  '0330': tx('2020-03-30', 2, { tesSUCCESS: 2 }, { OfferCreate: 1, Payment: 1 }), // 03-31 and 04-01
  '0420': tx('2020-04-20', 1, { tesSUCCESS: 1 }, { OfferCreate: 1 }),
  '0615': tx('2020-06-15', 1, { tesSUCCESS: 1 }, { Payment: 1 }),
};
const ALL_TX_MONTHS = Object.values(TX_MONTHS);
const ALL_TX_WEEKS = Object.values(TX_WEEKS);

// -- what the typical account is worth at the end of each bucket (worked out from CHANGES and the rates of the world) --

/**
 * USD of the issuer has a rate of 2 on 02-10 to 02-24 and of 4 on 04-20 to 05-04, none on any other day (see the world).
 * The month ends 01-31, 02-29, 03-31, 04-30, 05-31 and 06-30 are valued at those days' rates: only April's has one.
 */
const VALUE_MONTHS: ValueRow[] = [
  value('2020-01-01', '100', 1), // 100 XRP
  value('2020-02-01', '79.999988', 2), // 79.999988 XRP; 10 USD have no rate on 02-29
  value('2020-03-01', '79.999976', 1), // the fee of 03-31 23:59:59 is in the balance; 40 USD have no rate
  value('2020-04-01', '89.999976', 2), // 84.999976 + 20 USD / 4
  value('2020-05-01', '84.999976', 1), // 20 USD have no rate on 05-31; 5 CAD owed and 7 USD of issuer2 are worth 0
  value('2020-06-01', '84.999976', 1),
];

/** The weeks, from the Monday 01-13 to the Monday 06-29, each valued on its Sunday. */
const VALUE_WEEKS: ValueRow[] = [
  value('2020-01-13', '100', 1),
  value('2020-01-20', '100', 0),
  value('2020-01-27', '100', 0),
  value('2020-02-03', '100', 0),
  value('2020-02-10', '84.999988', 2), // 79.999988 + 10 USD / 2 (the rate of 02-16)
  value('2020-02-17', '84.999988', 0), // the rate of 02-23 is still 2
  value('2020-02-24', '79.999988', 0), // the rate of 03-01 is gone: the same balances are worth less
  value('2020-03-02', '79.999988', 1),
  value('2020-03-09', '79.999988', 0),
  value('2020-03-16', '79.999988', 0),
  value('2020-03-23', '79.999988', 0),
  value('2020-03-30', '79.999976', 0), // the fee alone
  value('2020-04-06', '79.999976', 0),
  value('2020-04-13', '79.999976', 0),
  value('2020-04-20', '89.999976', 2), // 84.999976 + 20 USD / 4
  value('2020-04-27', '89.999976', 0), // the rate of 05-03 is 4
  value('2020-05-04', '84.999976', 1), // the rate of 05-10 is gone
  value('2020-05-11', '84.999976', 0),
  value('2020-05-18', '84.999976', 0),
  value('2020-05-25', '84.999976', 0),
  value('2020-06-01', '84.999976', 0),
  value('2020-06-08', '84.999976', 1),
  value('2020-06-15', '84.999976', 0),
  value('2020-06-22', '84.999976', 0),
  value('2020-06-29', '84.999976', 0),
];

/** The issuer holds 1000 XRP (01-10) and owes USD and EUR: what it owes is worth 0, though its USD has a rate some days. */
const ISSUER_MONTHS: ValueRow[] = [
  value('2020-01-01', '1000', 1),
  value('2020-02-01', '1000', 2),
  value('2020-03-01', '1000', 1),
  value('2020-04-01', '1000', 1),
  value('2020-05-01', '1000', 0),
  value('2020-06-01', '1000', 0),
];

const END = 'end=2020-07-01';

/** The statements among `calls` that read a table, in the order they ran. */
const reading = <T extends { sql: string }>(calls: T[], table: Table): T[] =>
  calls.filter((c) => c.sql.includes(`FROM ${table}`));
const path = (account: string, family: string): string => `/v2/accounts/${account}/stats/${family}`;

/** The starts of the buckets from the first one that starts at or after `from` to the one of `now`, as `YYYY-MM-DD`. */
function bucketsUntilNow(from: string, interval: VolumeInterval, now: number): string[] {
  const out: string[] = [];
  for (let at = ceilBucket(Date.parse(`${from}T00:00:00Z`), interval); at <= now; at = nextBucket(at, interval)) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

describe('account stats with interval, on the hand-worked world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let world: AnalyticsWorld;
  let A: string;
  let ISSUER: string;

  const rows = async <R>(url: string): Promise<R[]> => (await api.ok<Body<R>>(url, 'rows')).body.rows;

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
    ISSUER = world.issuer;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  // what the app computed on read (the rates, kept for a minute) is not what the next test asks about
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  /** The queries the harness's ClickHouse service ran while `fn` ran, with the rows each returned. */
  async function queriesOf(
    fn: () => Promise<unknown>,
  ): Promise<{ sql: string; params: Record<string, unknown>; rows: Record<string, unknown>[] }[]> {
    const real = h.ch.query.bind(h.ch) as unknown as (
      sql: string,
      params?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
    const log: { sql: string; params: Record<string, unknown>; rows: Record<string, unknown>[] }[] = [];
    const spy = jest.spyOn(h.ch, 'query').mockImplementation((async (sql: string, params?: Record<string, unknown>) => {
      const found = await real(sql, params);
      log.push({ sql: String(sql), params: params ?? {}, rows: found });
      return found;
    }) as never);
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return log;
  }

  // -- transactions -----------------------------------------------------------------------------------------------

  describe('transactions', () => {
    it('transactions?interval=week|month: a row per bucket in which the account sent a transaction, with the counts of the whole bucket; date is the bucket start', async () => {
      expect(await rows(`${path(A, 'transactions')}?interval=month&${END}`)).toEqual(ALL_TX_MONTHS);
      expect(await rows(`${path(A, 'transactions')}?interval=week&${END}`)).toEqual(ALL_TX_WEEKS);
      // no row for May (nothing sent), and the transactions the account only received are in no count: 01-15, 02-10, 03-05
      expect((await rows<TxRow>(`${path(A, 'transactions')}?interval=month&${END}`)).map((r) => r.date)).not.toContain(
        '2020-05-01T00:00:00Z',
      );
      // the keys, in the order of the days
      const [jan] = await rows<TxRow>(`${path(A, 'transactions')}?interval=month&${END}`);
      expect(Object.keys(jan)).toEqual(['date', 'transaction_count', 'result', 'type']);
      expect(Object.keys(jan.result)).toEqual(['tecUNFUNDED_OFFER', 'tesSUCCESS']);
    });

    it('a week and a month are cut at the UTC midnight: 23:59:59 on the 31st is March, 00:00:00 on the 1st is April, a Sunday is in the week that began on the Monday before', async () => {
      const months = await rows<TxRow>(`${path(A, 'transactions')}?interval=month&${END}`);
      expect(months.find((r) => r.date.startsWith('2020-03'))?.type).toEqual({ AccountSet: 1, Payment: 1 });
      expect(months.find((r) => r.date.startsWith('2020-04'))?.type).toEqual({ OfferCreate: 2 });
      const weeks = await rows<TxRow>(`${path(A, 'transactions')}?interval=week&${END}`);
      expect(weeks.find((r) => r.date.startsWith('2020-02-24'))?.type).toEqual({ AccountSet: 1 });
      expect(weeks.find((r) => r.date.startsWith('2020-03-30'))?.type).toEqual({ OfferCreate: 1, Payment: 1 });
    });

    it('interval=day is the days, as no interval', async () => {
      const plain = await api.ok<Body<TxRow>>(`${path(A, 'transactions')}?${END}`, 'rows');
      const daily = await api.ok<Body<TxRow>>(`${path(A, 'transactions')}?interval=day&${END}`, 'rows');
      expect(daily.body).toEqual(plain.body);
      expect(plain.body.count).toBe(11); // the 11 days on which it sent something
      // an empty interval is none
      expect((await api.ok<Body<TxRow>>(`${path(A, 'transactions')}?interval=&${END}`, 'rows')).body).toEqual(
        plain.body,
      );
    });

    it('a bucket is a row when its start is at or after start and before end', async () => {
      const url = path(A, 'transactions');
      // 02-04 is a Tuesday: the week of 02-03 starts before it, so it is no row though it holds days after start; the week
      // of 03-30 starts at the end: no row
      expect(await rows(`${url}?interval=week&start=2020-02-04&end=2020-03-30`)).toEqual([
        TX_WEEKS['0210'],
        TX_WEEKS['0224'],
      ]);
      // a second after the midnight of 03-30 makes its week a row, with the counts of all of it, past the end
      expect(await rows(`${url}?interval=week&start=2020-02-04&end=2020-03-30T00:00:01`)).toEqual([
        TX_WEEKS['0210'],
        TX_WEEKS['0224'],
        TX_WEEKS['0330'],
      ]);
      expect(await rows(`${url}?interval=month&start=2020-01-15&end=2020-04-01`)).toEqual([
        TX_MONTHS.feb,
        TX_MONTHS.mar,
      ]);
      expect(await rows(`${url}?interval=month&start=2020-01-15&end=2020-04-01T00:00:01`)).toEqual([
        TX_MONTHS.feb,
        TX_MONTHS.mar,
        TX_MONTHS.apr,
      ]);
      // the start is included, the end is not
      expect(await rows(`${url}?interval=month&start=2020-01-01&end=2020-02-01`)).toEqual([TX_MONTHS.jan]);
      expect(await rows(`${url}?interval=week&start=2020-02-03&end=2020-02-10`)).toEqual([TX_WEEKS['0203']]);
      // no bucket starts in the window
      expect(await rows(`${url}?interval=week&start=2020-02-04&end=2020-02-10`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=2020-01-02&end=2020-02-01`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=2020-03-01&end=2020-02-01`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=2020-07-01`)).toEqual([]);
    });

    it('is the answer of an account that sent nothing, or that is none: no rows', async () => {
      for (const account of [world.stranger, world.issuer2, 'notanaddress']) {
        const res = await get(`${path(account, 'transactions')}?interval=month`);
        expect([account, res.status, res.body.rows, res.body.count]).toEqual([account, 200, [], 0]);
      }
      // the counterparty only received
      expect(await rows(`${path(world.counterparty, 'transactions')}?interval=month&${END}`)).toEqual([]);
      // the issuer sent a payment in each of four months
      expect(
        (await rows<TxRow>(`${path(ISSUER, 'transactions')}?interval=month&${END}`)).map((r) => [
          r.date.slice(0, 7),
          r.transaction_count,
        ]),
      ).toEqual([
        ['2020-02', 2],
        ['2020-03', 1],
        ['2020-04', 1],
      ]);
    });

    it('does not fail for a window of any size: before the ledgers began, or past the last date the database holds', async () => {
      const url = path(A, 'transactions');
      expect(await rows(`${url}?interval=month&start=1900-01-01&end=2200-01-01`)).toEqual(ALL_TX_MONTHS);
      expect(await rows(`${url}?interval=week&start=1969-12-31&end=2020-07-01`)).toEqual(ALL_TX_WEEKS);
      expect(await rows(`${url}?interval=day&start=2300-01-01&end=2400-01-01`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=1000-01-01&end=1100-01-01`)).toEqual([]);
    });
  });

  // -- value ------------------------------------------------------------------------------------------------------

  describe('value', () => {
    it('value?interval=…: a row for every bucket from the first bucket with a balance to the last before end, active or not', async () => {
      expect(await rows(`${path(A, 'value')}?interval=month&${END}`)).toEqual(VALUE_MONTHS);
      expect(await rows(`${path(A, 'value')}?interval=week&${END}`)).toEqual(VALUE_WEEKS);
      // the first bucket is the one of the first change (01-15), not the one of an earlier start
      expect((await rows<ValueRow>(`${path(A, 'value')}?interval=month&start=2019-01-01&${END}`))[0]).toEqual(
        VALUE_MONTHS[0],
      );
      expect((await rows<ValueRow>(`${path(A, 'value')}?interval=week&start=2000-01-01&${END}`))[0]).toEqual(
        VALUE_WEEKS[0],
      );
      // an inactive bucket has no change and the value carried: May of the week list has three
      const quiet = VALUE_WEEKS.filter((r) => r.balance_change_count === 0);
      expect(quiet.length).toBeGreaterThan(15);
      expect(Object.keys(VALUE_WEEKS[0])).toEqual(['date', 'account_value', 'balance_change_count']);
      const res = await get(`${path(A, 'value')}?interval=month&${END}`);
      expect(typeof res.body.rows[0].account_value).toBe('string');
    });

    it('the first bucket of a window that starts later is carried from before it: the same values', async () => {
      expect(await rows(`${path(A, 'value')}?interval=month&start=2020-02-01&end=2020-05-01`)).toEqual(
        VALUE_MONTHS.slice(1, 4),
      );
      // 02-02 is after the start of February: the first bucket is March, whose balances come from February and January
      expect(await rows(`${path(A, 'value')}?interval=month&start=2020-02-02&end=2020-05-01`)).toEqual(
        VALUE_MONTHS.slice(2, 4),
      );
      expect(await rows(`${path(A, 'value')}?interval=week&start=2020-04-27&end=2020-05-25`)).toEqual(
        VALUE_WEEKS.slice(15, 19),
      );
    });

    it('a bucket is a row when its start is at or after start and before end', async () => {
      const url = path(A, 'value');
      expect(await rows(`${url}?interval=week&start=2020-02-04&end=2020-03-02`)).toEqual(VALUE_WEEKS.slice(4, 7));
      expect(await rows(`${url}?interval=week&start=2020-02-04&end=2020-03-02T00:00:01`)).toEqual(
        VALUE_WEEKS.slice(4, 8),
      );
      expect(await rows(`${url}?interval=month&start=2020-01-15&end=2020-04-01`)).toEqual(VALUE_MONTHS.slice(1, 3));
      expect(await rows(`${url}?interval=month&start=2020-02-01&end=2020-03-01`)).toEqual(VALUE_MONTHS.slice(1, 2));
      expect(await rows(`${url}?interval=month&start=2020-02-02&end=2020-03-01`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=2020-03-01&end=2020-02-01`)).toEqual([]);
      // before the first balance there is nothing, and nothing is made up for it
      expect(await rows(`${url}?interval=month&start=2019-01-01&end=2020-01-01`)).toEqual([]);
      expect(await rows(`${url}?interval=week&start=2019-01-01&end=2020-01-13`)).toEqual([]);
    });

    it('value?interval=day has a row for every day, unlike no interval', async () => {
      const window = 'start=2020-02-08&end=2020-02-14';
      expect(await rows(`${path(A, 'value')}?${window}`)).toEqual([
        value('2020-02-10', '105', 1),
        value('2020-02-12', '84.999988', 1),
      ]);
      expect(await rows(`${path(A, 'value')}?interval=day&${window}`)).toEqual([
        value('2020-02-08', '100', 0),
        value('2020-02-09', '100', 0),
        value('2020-02-10', '105', 1), // 100 XRP + 10 USD at the rate of 2 on the day of the trades
        value('2020-02-11', '105', 0),
        value('2020-02-12', '84.999988', 1), // the fee is not a change, the payment is
        value('2020-02-13', '84.999988', 0),
      ]);
      // from the day of the first change, not from the start
      expect(await rows(`${path(A, 'value')}?interval=day&start=2020-01-01&end=2020-01-17`)).toEqual([
        value('2020-01-15', '100', 1),
        value('2020-01-16', '100', 0),
      ]);
    });

    it('the issuer: what it owes is worth 0', async () => {
      expect(await rows(`${path(ISSUER, 'value')}?interval=month&${END}`)).toEqual(ISSUER_MONTHS);
      // USD of the issuer has a rate on 02-10: the 10 USD it owes are no more worth anything on that day
      expect(await rows(`${path(ISSUER, 'value')}?interval=day&start=2020-02-10&end=2020-02-12`)).toEqual([
        value('2020-02-10', '1000', 1),
        value('2020-02-11', '1000', 0),
      ]);
      // an issuer's owed lines are not read into the answer, and no rate is asked for them
      const calls = await queriesOf(() => api.ok(`${path(ISSUER, 'value')}?interval=month&${END}`, 'rows'));
      expect(calls.some((c) => c.sql.includes(Table.NativeRatesDaily) || c.sql.includes(Table.Exchanges))).toBe(false);
      const lines = calls.find((c) => c.sql.includes('LIMIT 1 BY ledger_index, tx_index, node_index'));
      const kept = new Set(lines?.rows.map((r) => `${r.currency}`));
      expect([...kept].sort()).toEqual(['', 'XRP']);
    });

    it('keeps the lines that are above 0 on some day and the native one, and counts the changes of the others', async () => {
      const calls = await queriesOf(() => api.ok(`${path(A, 'value')}?interval=month&${END}`, 'rows'));
      const lines = calls.find((c) => c.sql.includes('LIMIT 1 BY ledger_index, tx_index, node_index'));
      const kept = new Set(lines?.rows.filter((r) => r.currency !== '').map((r) => `${r.currency}.${r.counterparty}`));
      // 5 CAD owed to the counterparty was never above 0: not read into the answer; its change is counted in May
      expect([...kept].sort()).toEqual([`USD.${world.issuer}`, `USD.${world.issuer2}`, 'XRP.'].sort());
      expect(VALUE_MONTHS[4].balance_change_count).toBe(1);
      // only the lines that are held are asked a rate for
      const asked = calls
        .filter((c) => c.sql.includes(Table.Exchanges))
        .flatMap((c) => Object.values(c.params).filter((v) => typeof v === 'string'));
      expect(asked).toEqual(expect.arrayContaining([world.issuer, world.issuer2]));
      expect(asked).not.toContain(world.counterparty);
    });

    it("paging with interval: limit, descending, and the marker is the bucket's day", async () => {
      const url = `${path(A, 'value')}?interval=week&start=2020-01-13&end=2020-03-02`;
      const expected = VALUE_WEEKS.slice(0, 7);
      const first = await get(`${url}&limit=3`);
      expect(first.body.rows).toEqual(expected.slice(0, 3));
      expect(first.body.count).toBe(3);
      expect(first.body.marker).toBe(markerOf('2020-01-27'));
      const second = await get(`${url}&limit=3&marker=${first.body.marker}`);
      expect(second.body.rows).toEqual(expected.slice(3, 6));
      expect(second.body.marker).toBe(markerOf('2020-02-17'));
      const third = await get(`${url}&limit=3&marker=${second.body.marker}`);
      expect(third.body.rows).toEqual(expected.slice(6));
      expect(third.body.marker).toBeUndefined();
      // the next page's link keeps the interval
      expect(first.headers.link).toContain('interval=week');
      expect(first.headers.link).toContain(`marker=${first.body.marker}`);

      const desc = await get(`${url}&limit=3&descending=true`);
      expect(desc.body.rows).toEqual(expected.slice(4, 7).reverse());
      expect(desc.body.marker).toBe(markerOf('2020-02-10'));
      const desc2 = await get(`${url}&limit=3&descending=true&marker=${desc.body.marker}`);
      expect(desc2.body.rows).toEqual(expected.slice(1, 4).reverse());
      expect(desc2.body.marker).toBe(markerOf('2020-01-20'));
      const desc3 = await get(`${url}&limit=3&descending=true&marker=${desc2.body.marker}`);
      expect(desc3.body.rows).toEqual(expected.slice(0, 1));
      expect(desc3.body.marker).toBeUndefined();

      // whatever the page, a bucket has the same value: every size, both ways
      for (const limit of [1, 2, 4, 7, 8]) {
        const walked = await api.pages<Body<ValueRow>>(url, limit, 'rows');
        expect([limit, walked.flatMap((p) => p.rows)]).toEqual([limit, expected]);
        const back = await api.pages<Body<ValueRow>>(`${url}&descending=true`, limit, 'rows');
        expect([limit, back.flatMap((p) => p.rows)]).toEqual([limit, [...expected].reverse()]);
      }
      // a marker that is any day of a week is that week's
      const mid = await get(`${url}&limit=2&marker=${markerOf('2020-02-12')}`);
      expect(mid.body.rows).toEqual(expected.slice(5, 7));
    });

    it("paging transactions with interval: limit, descending, and the marker is the bucket's day", async () => {
      const url = `${path(A, 'transactions')}?interval=week&${END}`;
      const first = await get(`${url}&limit=3`);
      expect(first.body.rows).toEqual(ALL_TX_WEEKS.slice(0, 3));
      expect(first.body.marker).toBe(markerOf('2020-02-03'));
      const second = await get(`${url}&limit=3&marker=${first.body.marker}`);
      expect(second.body.rows).toEqual(ALL_TX_WEEKS.slice(3, 6));
      expect(second.body.marker).toBe(markerOf('2020-03-30'));
      const third = await get(`${url}&limit=3&marker=${second.body.marker}`);
      expect(third.body.rows).toEqual(ALL_TX_WEEKS.slice(6));
      expect(third.body.marker).toBeUndefined();

      const desc = await get(`${url}&limit=3&descending=true`);
      expect(desc.body.rows).toEqual(ALL_TX_WEEKS.slice(5).reverse());
      expect(desc.body.marker).toBe(markerOf('2020-03-30'));
      const desc2 = await get(`${url}&limit=3&descending=true&marker=${desc.body.marker}`);
      expect(desc2.body.rows).toEqual(ALL_TX_WEEKS.slice(2, 5).reverse());
      for (const limit of [1, 2, 5, 8]) {
        expect((await api.pages<Body<TxRow>>(url, limit, 'rows')).flatMap((p) => p.rows)).toEqual(ALL_TX_WEEKS);
        expect((await api.pages<Body<TxRow>>(`${url}&descending=true`, limit, 'rows')).flatMap((p) => p.rows)).toEqual(
          [...ALL_TX_WEEKS].reverse(),
        );
      }
      // a marker of the month list: the next page is the buckets after its month
      const month = await get(`${path(A, 'transactions')}?interval=month&${END}&limit=2`);
      expect(month.body.rows).toEqual(ALL_TX_MONTHS.slice(0, 2));
      expect(month.body.marker).toBe(markerOf('2020-02-01'));
      const monthNext = await get(
        `${path(A, 'transactions')}?interval=month&${END}&limit=2&marker=${month.body.marker}`,
      );
      expect(monthNext.body.rows).toEqual(ALL_TX_MONTHS.slice(2, 4));
    });

    it('the current bucket is valued now: the rates are asked for the day of today, never a day that has not come', async () => {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      for (const interval of ['week', 'month'] as const) {
        const url = `${path(A, 'value')}?interval=${interval}&start=2026-01-01`;
        const calls = await queriesOf(() => api.ok(url, 'rows'));
        const body: Body<ValueRow> = (await api.ok<Body<ValueRow>>(url, 'rows')).body;
        const current = new Date(bucketStart(now, interval)).toISOString().slice(0, 10);
        expect(body.rows[body.rows.length - 1].date).toBe(`${current}T00:00:00Z`);
        // the balances of the last change: 84.999976 XRP and USD that have no rate today
        expect(body.rows[body.rows.length - 1]).toEqual(value(current, '84.999976', 0));
        const valid = calls.filter((c) => c.sql.includes(Table.NativeRatesDaily) && c.sql.includes("currency = ''"));
        expect(valid).toHaveLength(1);
        expect(valid[0].params.through).toBe(today);
        // a row for every bucket from the start of 2026 to now
        expect(body.rows.map((r) => r.date.slice(0, 10))).toEqual(bucketsUntilNow('2026-01-01', interval, now));
      }
    });

    it('a window that ends in the future has a row for each bucket before the end, valued as now', async () => {
      const rows2 = await rows<ValueRow>(`${path(A, 'value')}?interval=month&start=2100-01-01&end=2100-04-01`);
      expect(rows2).toEqual([
        value('2100-01-01', '84.999976', 0),
        value('2100-02-01', '84.999976', 0),
        value('2100-03-01', '84.999976', 0),
      ]);
    });

    it('is no row for an account without a balance change, or for a window before its first', async () => {
      for (const account of [world.stranger, 'notanaddress']) {
        const res = await get(`${path(account, 'value')}?interval=month`);
        expect([account, res.status, res.body.rows, res.body.count]).toEqual([account, 200, [], 0]);
      }
      expect(await rows(`${path(world.counterparty, 'value')}?interval=month&start=2020-01-01&end=2020-02-01`)).toEqual(
        [],
      );
      // the counterparty's first change is on 02-12: February is its first bucket
      expect((await rows<ValueRow>(`${path(world.counterparty, 'value')}?interval=month&${END}`))[0]).toEqual(
        value('2020-02-01', '20', 2),
      );
    });

    it('does not fail for a window of any size', async () => {
      const url = path(A, 'value');
      expect(await rows(`${url}?interval=month&start=1900-01-01&end=2020-07-01`)).toEqual(VALUE_MONTHS);
      // past the last date a ClickHouse Date holds there is no bucket
      expect(await rows(`${url}?interval=day&start=2300-01-01&end=2300-01-03`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=1000-01-01&end=1100-01-01`)).toEqual([]);
      expect(await rows(`${url}?interval=month&start=0001-01-01&end=0002-01-01`)).toEqual([]);
    });
  });

  // -- the parameters ---------------------------------------------------------------------------------------------

  describe('the parameters', () => {
    it('interval is checked after the family and before the marker', async () => {
      const wrongFamily = await get(`/v2/accounts/${A}/stats/foo?interval=year`);
      expect([wrongFamily.status, wrongFamily.body]).toEqual([400, { result: 'error', message: 'invalid family' }]);
      for (const family of ['transactions', 'value']) {
        const wrong = await get(`${path(A, family)}?interval=year&marker=!!`);
        expect([family, wrong.status, wrong.body]).toEqual([
          family,
          400,
          { result: 'error', message: 'invalid interval - use: day, week, month' },
        ]);
        const marker = await get(`${path(A, family)}?interval=week&marker=!!`);
        expect([family, marker.status, marker.body]).toEqual([
          family,
          400,
          { result: 'error', message: 'invalid marker' },
        ]);
        // the dates come first
        const start = await get(`${path(A, family)}?interval=year&start=nope`);
        expect([family, start.status, start.body.message]).toEqual([family, 400, 'invalid start date format']);
        const end = await get(`${path(A, family)}?interval=year&end=nope`);
        expect([family, end.status, end.body.message]).toEqual([family, 400, 'invalid end date format']);
      }
      // a wrong request reads no table
      const calls = await queriesOf(async () => {
        await get(`${path(A, 'value')}?interval=year`);
        await get(`${path(A, 'transactions')}?interval=week&marker=!!`);
        await get(`/v2/accounts/${A}/stats/foo?interval=year`);
      });
      expect(calls).toHaveLength(0);
    });

    it('is the CSV of the buckets, named as without interval', async () => {
      const res = await get(`${path(A, 'value')}?interval=month&${END}&format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${A} - stats.value`));
      const lines = res.text.split('\n');
      expect(lines[0]).toBe('"date","account_value","balance_change_count"');
      expect(lines).toHaveLength(1 + VALUE_MONTHS.length);
      expect(lines[2]).toBe('"2020-02-01T00:00:00Z","79.999988","2"');
    });

    it('answers a failure of the database with the message of the route', async () => {
      for (const family of ['transactions', 'value']) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const res = await get(`${path(A, family)}?interval=month&${END}`);
        expect([family, res.status, res.body]).toEqual([
          family,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- what is read -----------------------------------------------------------------------------------------------

  describe('what is read', () => {
    it('with interval the reads are day groups, a key range of the account, with no FINAL', async () => {
      const explain = async (what: string, sql: string, params: Record<string, unknown>): Promise<string> =>
        (await h.ch.query<{ explain: string }>(`${what} ${sql}`, params)).map((r) => r.explain).join('\n');

      for (const [family, table] of [
        ['transactions', Table.AccountTransactions],
        ['value', Table.BalanceChanges],
      ] as const) {
        for (const interval of ['day', 'week', 'month']) {
          const calls = await queriesOf(() => api.ok(`${path(A, family)}?interval=${interval}&${END}`, 'rows'));
          const reads = reading(calls, table);
          expect(reads.length).toBeGreaterThanOrEqual(1);
          for (const { sql, params } of reads) {
            expect(sql).not.toMatch(/\bFINAL\b/);
            expect(sql).not.toContain(A);
            const ofAccount = sql.includes('{dg_account:String}') || sql.includes('{account:String}');
            expect([family, interval, ofAccount]).toEqual([family, interval, true]);
            expect(Object.values(params)).toContain(A);
          }
          // the day groups: each row of the account once, in a subquery ordered by the whole key, then grouped by day
          const groups = reads.filter((c) => c.sql.includes('{dg_account:String}'));
          expect(groups).toHaveLength(1);
          const { sql, params } = groups[0];
          expect(sql).toContain('LIMIT 1 BY');
          expect(sql).toContain('ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32}');
          expect(sql).toContain('GROUP BY');
          // the account is found through the primary key, and the table is not read in full
          const indexes = await explain('EXPLAIN indexes = 1', sql, params);
          expect(indexes).toContain('PrimaryKey');
          expect(indexes).toMatch(/Keys:\s+account/);
          // no rollup was read: the account has none
          expect(
            calls.some((c) => c.sql.includes(Table.AccountLinesDaily) || c.sql.includes(Table.AccountTxDaily)),
          ).toBe(false);
        }
      }
    });

    it('reads the day groups of value from the epoch to the last day valued, once, in one statement', async () => {
      const calls = await queriesOf(() => api.ok(`${path(A, 'value')}?interval=month&${END}`, 'rows'));
      const groups = reading(calls, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'));
      expect(groups).toHaveLength(1);
      const { params } = groups[0];
      // the ledgers from the first to the last of the world: the window starts at 2000-01-01 and ends 2020-06-30
      expect(params.dg_min0).toBe(world.ledgerAt('2020-01-10T09:00:00Z'));
      expect(params.dg_max0).toBe(world.ledgerAt('2020-06-15T09:00:00Z'));
    });

    it('does not read what an empty window cannot hold', async () => {
      const calls = await queriesOf(async () => {
        await get(`${path(A, 'transactions')}?interval=week&start=2020-02-04&end=2020-02-10`);
        await get(`${path(A, 'value')}?interval=month&start=2020-03-01&end=2020-02-01`);
        await get(`${path(A, 'value')}?interval=month&start=2019-01-01&end=2020-01-01`);
      });
      expect(reading(calls, Table.AccountTransactions)).toHaveLength(0);
      expect(reading(calls, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'))).toHaveLength(0);
    });
  });

  // -- rolled up --------------------------------------------------------------------------------------------------

  describe('the same answer rolled up', () => {
    it('the same answer rolled up', async () => {
      const urls = [
        ...['day', 'week', 'month'].flatMap((interval) => [
          `${path(A, 'transactions')}?interval=${interval}&${END}`,
          `${path(A, 'value')}?interval=${interval}&${END}`,
          `${path(ISSUER, 'value')}?interval=${interval}&${END}`,
          `${path(ISSUER, 'transactions')}?interval=${interval}&${END}`,
        ]),
        `${path(A, 'value')}?interval=week&start=2020-02-04&end=2020-05-25&limit=5&descending=true`,
        `${path(A, 'transactions')}?interval=month&start=2020-02-04&end=2020-05-25`,
        `${path(A, 'value')}?interval=month`,
      ];
      const bodies = async (): Promise<unknown[]> => {
        const out: unknown[] = [];
        for (const url of urls) out.push((await api.ok(url, 'rows')).body);
        return out;
      };
      const raw = await bodies();
      expect(raw.length).toBe(urls.length);

      // complete coverage of the world: the groups come from the rollups, and the rest of the window (no ledger) from nothing
      for (const account of [A, ISSUER]) await rollUp(h, api, account, { from: '2020-01-01', through: '2020-07-31' });
      const complete = await queriesOf(async () => expect(await bodies()).toEqual(raw));
      expect(reading(complete, Table.AccountLinesDaily).length).toBeGreaterThan(0);
      expect(reading(complete, Table.AccountTxDaily).length).toBeGreaterThan(0);
      expect(reading(complete, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}'))).toHaveLength(
        0,
      );

      // coverage from 2020-03-01: January and February come from the raw rows, the rest from the rollups
      for (const account of [A, ISSUER]) await rollUp(h, api, account, { from: '2020-03-01', through: '2020-07-31' });
      const partial = await queriesOf(async () => expect(await bodies()).toEqual(raw));
      expect(reading(partial, Table.AccountLinesDaily).length).toBeGreaterThan(0);
      expect(reading(partial, Table.AccountTxDaily).length).toBeGreaterThan(0);
      expect(
        reading(partial, Table.BalanceChanges).filter((c) => c.sql.includes('{dg_account:String}')).length,
      ).toBeGreaterThan(0);
      expect(reading(partial, Table.AccountTransactions).length).toBeGreaterThan(0);

      // coverage that ends in the middle of the world: the days after it are raw
      for (const account of [A, ISSUER]) await rollUp(h, api, account, { from: '2020-02-01', through: '2020-04-30' });
      expect(await bodies()).toEqual(raw);

      // the days of the world that no rollup covers, and an account that is rolled up and has no rows in a window
      expect(await rows(`${path(A, 'value')}?interval=month&start=2020-05-01&end=2020-07-01`)).toEqual(
        VALUE_MONTHS.slice(4, 6),
      );
    });
  });
});

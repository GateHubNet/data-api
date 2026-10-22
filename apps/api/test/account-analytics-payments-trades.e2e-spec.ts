import { NativeRatesDailyRow, nativeValue, RatesService, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import {
  AnalyticsWorld,
  COUNTERPARTY,
  HOLDER,
  ISSUER,
  ISSUER2,
  PaymentSpec,
  seedAccountPayments,
  seedAccountTrades,
  seedAnalyticsWorld,
  STRANGER,
  TradeSpec,
  TYPICAL,
} from './support/analytics-world';
import { csvDisposition } from './support/csv';
import { fixtureAccountExchanges, fixtureAccountPayments } from './support/fixtures';
import { rollUp } from './support/rollups';

/**
 * `GET /v2/accounts/:address/analytics/counterparties` and `.../analytics/exchanges` on the hand-worked world of
 * `support/analytics-world.ts` (read its header for the ledgers and the rates), with the payments and the trades below
 * written into `account_payments` and `account_exchanges` at times that world has a ledger for, and on the ripple-mock seed.
 *
 * The window is whole UTC days, as on the other routes under `analytics/`; these two have no `interval`. The rates of the
 * world are those the trades give on read: USD of the issuer is worth 2 per XRP on 2020-02-10 to 02-24 and 4 on 04-20 to
 * 05-04, and has none on any other day; a suite that needs stored sets of rates writes them into a database of its own.
 */

interface Counterparty {
  account: string;
  sent_value: string;
  received_value: string;
  total_value: string;
  payments_sent: number;
  payments_received: number;
  first: string;
  last: string;
}
interface CounterpartiesBody {
  result: string;
  start: string;
  end: string;
  sort: string;
  total: number;
  count: number;
  counterparties: Counterparty[];
}
interface Pair {
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
  count: number;
  base_volume: string;
  counter_volume: string;
  bought: string;
  sold: string;
  bought_counter: string;
  sold_counter: string;
  native_volume?: string;
}
interface ExchangesBody {
  result: string;
  start: string;
  end: string;
  total: number;
  count: number;
  pairs: Pair[];
}

/** The accounts of the world, by the letters the numbers below are worked out with. */
const A = TYPICAL;
const B = COUNTERPARTY;
const S = STRANGER;
const I = ISSUER;
const I2 = ISSUER2;
const H = HOLDER;

const COUNTERPARTIES = (account: string): string => `/v2/accounts/${account}/analytics/counterparties`;
const EXCHANGES = (account: string): string => `/v2/accounts/${account}/analytics/exchanges`;

const T = (day: string): string => `${day}T00:00:00Z`;

const cp = (
  account: string,
  sent: string,
  received: string,
  total: string,
  paymentsSent: number,
  paymentsReceived: number,
  first: string,
  last: string,
): Counterparty => ({
  account,
  sent_value: sent,
  received_value: received,
  total_value: total,
  payments_sent: paymentsSent,
  payments_received: paymentsReceived,
  first,
  last,
});

/** A pair of the answer; `base` and `counter` as the URLs write an asset (`XRP`, `USD+rIssuer`). */
const pair = (
  base: string,
  counter: string,
  count: number,
  baseVolume: string,
  counterVolume: string,
  bought: string,
  sold: string,
  boughtCounter: string,
  soldCounter: string,
  nativeVolume?: string,
): Pair => {
  const [baseCurrency, baseIssuer] = base.split('+');
  const [counterCurrency, counterIssuer] = counter.split('+');
  return {
    base_currency: baseCurrency,
    ...(baseIssuer !== undefined && { base_issuer: baseIssuer }),
    counter_currency: counterCurrency,
    ...(counterIssuer !== undefined && { counter_issuer: counterIssuer }),
    count,
    base_volume: baseVolume,
    counter_volume: counterVolume,
    bought,
    sold,
    bought_counter: boughtCounter,
    sold_counter: soldCounter,
    ...(nativeVolume !== undefined && { native_volume: nativeVolume }),
  };
};

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

/** The statements among `calls` that read a table, in the order they ran. */
const reading = <C extends { sql: string }>(calls: C[], table: Table): C[] =>
  calls.filter((c) => c.sql.includes(`FROM ${table}`));

// -- the payments of the typical account (A) --------------------------------------------------------------------------
//
// B is the counterparty, S the stranger, I the issuer and H the holder of the world; `USD` is the issuer's. The values
// are at the rates of the world: 2 USD per XRP on 02-10 to 02-24, 4 on 04-20, none on 03-01.

const USD = `USD+${I}`;
const EUR = `EUR+${I}`;

const PAYMENTS_A: PaymentSpec[] = [
  ['2020-01-16T09:00:00Z', 1, 'sent', B, '10', 'XRP'],
  ['2020-01-17T09:00:00Z', 1, 'sent', B, '5', 'XRP'],
  ['2020-01-17T09:00:00Z', 2, 'sent', S, '2', 'XRP'],
  ['2020-01-17T09:00:00Z', 3, 'received', I, '7', 'XRP'],
  // H: four payments sent and two received, of a drop each
  ...[1, 2, 3, 4].map((tx): PaymentSpec => ['2020-02-03T09:00:00Z', tx, 'sent', H, '0.000001', 'XRP']),
  ...[5, 6].map((tx): PaymentSpec => ['2020-02-03T09:00:00Z', tx, 'received', H, '0.000001', 'XRP']),
  ['2020-02-10T11:00:00Z', 1, 'received', B, '20', USD], // 20 USD at 2: 10
  ['2020-02-12T09:00:00Z', 1, 'received', B, '10', USD], // 5
  ['2020-02-12T09:00:00Z', 2, 'sent', S, '4', 'XRP'],
  ['2020-02-14T09:00:00Z', 1, 'sent', S, '8', USD], // 4
  ['2020-03-01T09:00:00Z', 1, 'received', S, '6', USD], // no rate that day: 0
  // a payment to oneself has a row of each side, and counts once, as sent
  ['2020-03-10T10:00:00Z', 1, 'sent', A, '3', 'XRP'],
  ['2020-03-10T10:00:00Z', 1, 'received', A, '3', 'XRP'],
  ['2020-04-20T12:00:00Z', 1, 'sent', S, '40', USD], // 40 USD at 4: 10
  ['2020-06-15T09:00:00Z', 1, 'received', B, '9', 'XRP'],
];

/** What A has with each account over the whole of its payments, by value. */
const A_B = cp(B, '15', '24', '39', 2, 3, '2020-01-16T09:00:00Z', '2020-06-15T09:00:00Z');
const A_S = cp(S, '20', '0', '20', 4, 1, '2020-01-17T09:00:00Z', '2020-04-20T12:00:00Z');
const A_I = cp(I, '0', '7', '7', 0, 1, '2020-01-17T09:00:00Z', '2020-01-17T09:00:00Z');
const A_SELF = cp(A, '3', '0', '3', 1, 0, '2020-03-10T10:00:00Z', '2020-03-10T10:00:00Z');
const A_H = cp(H, '0.000004', '0.000002', '0.000006', 4, 2, '2020-02-03T09:00:00Z', '2020-02-03T09:00:00Z');

// -- the trades of the typical account (A) ----------------------------------------------------------------------------
//
// The pairs are in the canonical stored order. A buys when it is the buyer (it receives the base and pays the counter).

const TRADES_A: TradeSpec[] = [
  // USD / XRP: a native counter
  ['2020-02-10T12:30:00Z', 1, USD, 'XRP', '10', '5', A, B],
  ['2020-03-05T10:00:00Z', 1, USD, 'XRP', '4.5', '3', A, B],
  ['2020-03-10T10:00:00Z', 1, USD, 'XRP', '1', '0.25', A, A], // with itself: bought and sold
  ['2020-04-20T12:30:00Z', 1, USD, 'XRP', '20', '5', B, A],
  // EUR / USD: no native side; EUR has no rate on any day
  ['2020-02-12T09:00:00Z', 5, EUR, USD, '30', '60', A, B], // the counter: 60 USD at 2 are 30
  ['2020-02-20T10:00:00Z', 1, EUR, USD, '5', '10', B, A], // 10 USD at 2: 5
  ['2020-03-01T09:00:00Z', 1, EUR, USD, '100', '7', A, B], // USD has no rate that day: nothing
  ['2020-04-20T12:00:00Z', 2, EUR, USD, '4', '8', B, A], // 8 USD at 4: 2
  // XRP / ZAR: a native base
  ['2020-01-15T10:00:00Z', 1, 'XRP', `ZAR+${I2}`, '5', '100', A, B],
  // AUD / NZD and CAD / GBP: no native side, and neither side has a rate
  ['2020-02-01T10:00:00Z', 1, `AUD+${I}`, `NZD+${I}`, '1', '1.1', A, B],
  ['2020-02-03T09:00:00Z', 1, `AUD+${I}`, `NZD+${I}`, '2', '2.2', B, A],
  ['2020-05-06T09:00:00Z', 1, `AUD+${I}`, `NZD+${I}`, '3', '3.3', A, B],
  ['2020-05-06T10:00:00Z', 1, `CAD+${B}`, `GBP+${I2}`, '5', '3', A, B],
  ['2020-06-10T08:00:00Z', 1, `CAD+${B}`, `GBP+${I2}`, '2', '1', B, A],
];

const A_USD_XRP = pair(USD, 'XRP', 4, '35.5', '13.25', '15.5', '21', '8.25', '5.25', '13.25');
const A_EUR_USD = pair(EUR, USD, 4, '139', '85', '130', '9', '67', '18', '37');
const A_XRP_ZAR = pair('XRP', `ZAR+${I2}`, 1, '5', '100', '5', '0', '100', '0', '5');
const A_AUD_NZD = pair(`AUD+${I}`, `NZD+${I}`, 3, '6', '6.6', '4', '2', '4.4', '2.2');
const A_CAD_GBP = pair(`CAD+${B}`, `GBP+${I2}`, 2, '7', '4', '5', '2', '3', '1');

/** A's pairs by native volume: 37, 13.25, 5, then the two without one by count. */
const A_PAIRS = [A_EUR_USD, A_USD_XRP, A_XRP_ZAR, A_AUD_NZD, A_CAD_GBP];

// -- the swaps of a taker (W) and of the pool it swaps with (P) ---------------------------------------------------------
//
// A swap against a pool is a row of `account_exchanges` for the taker and one for the pool, each with `amm_account` the pool
// (a swap is a trade of its pair, D2b.2); the buyer received the base, the pool when base flowed into it. W also trades by
// offers with B in the same pair, on the days it swaps on. The rates of the world are those of the offers of `exchanges`
// (the swaps are not among them): USD is worth 2 per XRP on 02-12.

/** A taker, and a pool: addresses of the sample rows. */
const W = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const P = 'rJ8pBKtDeSyHAUhrjZGfUQJdE1MVxrZEXp';

const SWAPS_W: TradeSpec[] = [
  // USD / XRP: W buys 10 USD for 5 XRP from the pool, on the day it sells 1 USD for 0.5 XRP to B
  ['2020-02-10T12:30:00Z', 1, USD, 'XRP', '10', '5', W, P, P],
  ['2020-02-10T12:30:00Z', 3, USD, 'XRP', '1', '0.5', B, W],
  // EUR / USD, no native side: W buys 30 EUR for 60 USD from the pool; the counter's rate of the day: 60 / 2
  ['2020-02-12T09:00:00Z', 6, EUR, USD, '30', '60', W, P, P],
  // W sells 4 USD to the pool for 3 XRP (the pool is the buyer), then buys 2 from B for 1
  ['2020-03-05T10:00:00Z', 2, USD, 'XRP', '4', '3', P, W, P],
  ['2020-03-10T10:00:00Z', 2, USD, 'XRP', '2', '1', W, B],
  ['2020-05-06T09:00:00Z', 4, USD, 'XRP', '5', '4', P, W, P],
];
/** The pool's side of the swaps above: the other row of each. */
const SWAPS_P: TradeSpec[] = SWAPS_W.filter((spec) => spec[8] === P);

const W_USD_XRP = pair(USD, 'XRP', 5, '22', '13.5', '12', '10', '6', '7.5', '13.5');
const W_EUR_USD = pair(EUR, USD, 1, '30', '60', '30', '0', '60', '0', '30');
const W_PAIRS = [W_EUR_USD, W_USD_XRP];
const P_USD_XRP = pair(USD, 'XRP', 3, '19', '12', '9', '10', '7', '5', '12');
const P_EUR_USD = pair(EUR, USD, 1, '30', '60', '0', '30', '0', '60', '30');
const P_PAIRS = [P_EUR_USD, P_USD_XRP];

// -- the limits: an account with 1005 counterparties and 1005 pairs ------------------------------------------------------

const MANY_COUNT = 1005;
const pad4 = (i: number): string => String(i).padStart(4, '0');
/** The counterparty paid `i` XRP, the pair is paid `i` XRP: the larger `i`, the larger the value. */
const manyCounterparty = (i: number): string => `rMany${pad4(i)}`;

// -- two counterparties whose Float64 values tie and whose exact values do not (the account is I2) ---------------------

/** 2^53 and 2^53 + 1: the same double. The account of the higher one comes last in the order of accounts. */
const TIE_LOW = 'rAtieAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TIE_HIGH = 'rZtieZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const TIE_MID = 'rMtieMMMMMMMMMMMMMMMMMMMMMMMMMMMM';

describe('analytics/counterparties and analytics/exchanges, on the hand-worked world', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let world: AnalyticsWorld;

  const counterparties = async (account: string, query = ''): Promise<CounterpartiesBody> =>
    (await api.ok<CounterpartiesBody>(`${COUNTERPARTIES(account)}?${query}`, 'counterparties')).body;
  const exchanges = async (account: string, query = ''): Promise<ExchangesBody> =>
    (await api.ok<ExchangesBody>(`${EXCHANGES(account)}?${query}`, 'pairs')).body;
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
    await seedAccountPayments(h, world, A, PAYMENTS_A);
    // a payment to oneself that has only the row of the receiving side: it is the account's own all the same
    await seedAccountPayments(h, world, H, [['2020-03-10T10:00:00Z', 7, 'received', H, '2', 'XRP']]);
    await seedAccountPayments(h, world, I2, [
      ['2020-03-12T10:00:00Z', 1, 'sent', TIE_LOW, '9007199254740992', 'XRP'],
      ['2020-03-12T10:00:00Z', 2, 'sent', TIE_HIGH, '9007199254740993', 'XRP'],
      ['2020-03-12T10:00:00Z', 3, 'sent', TIE_MID, '5', 'XRP'],
    ]);
    await seedAccountPayments(
      h,
      world,
      world.many,
      Array.from({ length: MANY_COUNT }, (_, n): PaymentSpec => {
        const i = n + 1;
        return ['2020-03-12T10:00:00Z', i, 'sent', manyCounterparty(i), String(i), 'XRP'];
      }),
    );
    await seedAccountTrades(h, world, A, TRADES_A);
    await seedAccountTrades(h, world, W, SWAPS_W);
    await seedAccountTrades(h, world, P, SWAPS_P);
    await seedAccountTrades(
      h,
      world,
      world.many,
      Array.from({ length: MANY_COUNT }, (_, n): TradeSpec => {
        const i = n + 1;
        return ['2020-03-12T10:00:00Z', i, `P${pad4(i)}+${I2}`, 'XRP', '1', String(i), world.many, B];
      }),
    );
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());
  // what the app computed on read (the rates, kept for a minute; the coverage of the rollups) is not what the next test asks about
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });

  // -- counterparties ---------------------------------------------------------------------------------------------

  describe('counterparties', () => {
    it("per counterparty: sent_value and received_value of the delivered amounts at their day's rate, payments_sent and payments_received, first and last in the window", async () => {
      const body = await counterparties(A, 'end=2020-06-30');
      expect(body).toEqual({
        result: 'success',
        start: T('2013-01-01'),
        end: T('2020-07-01'),
        sort: 'value',
        total: 5,
        count: 5,
        // B: 15 XRP sent in 2 payments, and 20 USD (10) + 10 USD (5) + 9 XRP received in 3; S: 2 + 4 XRP, 8 USD (4) and
        // 40 USD (10) sent in 4, 6 USD received on a day without a rate (0); I: 7 XRP received; A paid itself 3; H: drops
        counterparties: [A_B, A_S, A_I, A_SELF, A_H],
      });
      for (const c of body.counterparties) {
        expect(Object.keys(c)).toEqual([
          'account',
          'sent_value',
          'received_value',
          'total_value',
          'payments_sent',
          'payments_received',
          'first',
          'last',
        ]);
      }
      expect(Object.keys(body)).toEqual(['result', 'start', 'end', 'sort', 'total', 'count', 'counterparties']);
    });

    it('a window of whole days: first and last are the ones in it, and a counterparty with no payment in it is not there', async () => {
      // February and March: B paid in USD only, S has sent 4 + 4 and been paid in USD at no rate, I has none
      const feb = await counterparties(A, 'start=2020-02-01&end=2020-03-31');
      expect(feb.counterparties).toEqual([
        cp(B, '0', '15', '15', 0, 2, '2020-02-10T11:00:00Z', '2020-02-12T09:00:00Z'),
        cp(S, '8', '0', '8', 2, 1, '2020-02-12T09:00:00Z', '2020-03-01T09:00:00Z'),
        cp(A, '3', '0', '3', 1, 0, '2020-03-10T10:00:00Z', '2020-03-10T10:00:00Z'),
        cp(H, '0.000004', '0.000002', '0.000006', 4, 2, '2020-02-03T09:00:00Z', '2020-02-03T09:00:00Z'),
      ]);
      expect([feb.start, feb.end]).toEqual([T('2020-02-01'), T('2020-04-01')]);
      // the whole day of the end: 06-15 is the day of B's last payment, whatever the time of day
      const last = await counterparties(A, 'start=2020-06-15&end=2020-06-15');
      expect(last.counterparties).toEqual([cp(B, '0', '9', '9', 0, 1, '2020-06-15T09:00:00Z', '2020-06-15T09:00:00Z')]);
      // and the day of the start is whole too
      const first = await counterparties(A, 'start=2020-01-17&end=2020-01-17');
      expect(first.counterparties.map((c) => c.account)).toEqual([I, B, S]);
    });

    it('the side rule of reports: a payment to oneself would be sent', async () => {
      const body = await counterparties(A, 'start=2020-03-10&end=2020-03-10');
      // one payment sent whose counterparty is the account, though it has a row of each side
      expect(body).toEqual({
        result: 'success',
        start: T('2020-03-10'),
        end: T('2020-03-11'),
        sort: 'value',
        total: 1,
        count: 1,
        counterparties: [A_SELF],
      });
      expect(body.counterparties[0].payments_received).toBe(0);
      // with only the row of the receiving side the side is the same: the counterparty is the account itself
      expect((await counterparties(H, 'end=2020-06-30')).counterparties).toEqual([
        cp(H, '2', '0', '2', 1, 0, '2020-03-10T10:00:00Z', '2020-03-10T10:00:00Z'),
      ]);
      // reports counts it the same way: one payment sent, none received
      const report = (await api.ok(`/v2/accounts/${A}/reports?start=2020-03-10&end=2020-03-10`, 'reports')).body
        .reports[0];
      expect([report.payments_sent, report.payments_received]).toEqual([1, 0]);
    });

    it('total is the distinct counterparties of the window', async () => {
      // B has paid and been paid, and counts once
      expect((await counterparties(A, 'end=2020-06-30')).total).toBe(5);
      expect((await counterparties(A, 'start=2020-02-01&end=2020-03-31')).total).toBe(4);
      const january = await counterparties(A, 'start=2020-01-01&end=2020-01-31');
      expect(january.total).toBe(3);
      expect(january.counterparties.map((c) => c.account)).toEqual([B, I, S]);
      // total is of all of them, count of those served
      const one = await counterparties(A, 'end=2020-06-30&limit=2');
      expect([one.total, one.count, one.counterparties.length]).toEqual([5, 2, 2]);
      expect((await counterparties(A, 'start=2020-06-16')).total).toBe(0);
    });

    it('sort=value (default) and sort=count, largest first, then the account; anything else is 400 invalid sort - use: value, count', async () => {
      // by value: 39, 20, 7, 3 and a few drops
      const byValue = await counterparties(A, 'end=2020-06-30');
      expect(byValue.counterparties.map((c) => c.account)).toEqual([B, S, I, A, H]);
      expect((await counterparties(A, 'end=2020-06-30&sort=value')).counterparties).toEqual(byValue.counterparties);
      expect((await counterparties(A, 'end=2020-06-30&sort=')).sort).toBe('value');
      // by count: H has 6 payments (a drop each), B and S 5 (the account breaks the tie), A and I 1 (the same)
      const byCount = await counterparties(A, 'end=2020-06-30&sort=count');
      expect(byCount.sort).toBe('count');
      expect(byCount.counterparties.map((c) => c.account)).toEqual([H, B, S, A, I]);
      expect(byCount.counterparties.map((c) => c.payments_sent + c.payments_received)).toEqual([6, 5, 5, 1, 1]);
      // the entries are the same, only in another order
      expect(byCount.counterparties).toEqual([A_H, A_B, A_S, A_SELF, A_I]);
      expect(
        (await counterparties(A, 'end=2020-06-30&sort=count&limit=2')).counterparties.map((c) => c.account),
      ).toEqual([H, B]);
      // a repeated parameter: the first value wins
      expect((await counterparties(A, 'end=2020-06-30&sort=count&sort=value')).sort).toBe('count');

      for (const sort of ['amount', 'VALUE', 'Count', 'values', ' value', 'total_value', '0']) {
        expect([sort, await failure(`${COUNTERPARTIES(A)}?sort=${encodeURIComponent(sort)}`)]).toEqual([
          sort,
          bad('invalid sort - use: value, count'),
        ]);
      }
    });

    it('limit 20 by default, 1000 at most', async () => {
      const m = world.many;
      const def = await counterparties(m);
      expect([def.total, def.count, def.counterparties.length]).toEqual([MANY_COUNT, 20, 20]);
      // the largest values first: the counterparty paid `i` XRP
      expect(def.counterparties.map((c) => c.account)).toEqual(
        Array.from({ length: 20 }, (_, n) => manyCounterparty(MANY_COUNT - n)),
      );
      expect(def.counterparties[0]).toEqual(
        cp(manyCounterparty(MANY_COUNT), '1005', '0', '1005', 1, 0, '2020-03-12T10:00:00Z', '2020-03-12T10:00:00Z'),
      );
      for (const [limit, expected] of [
        ['1000', 1000],
        ['1001', 1000],
        ['1000000', 1000],
        ['3', 3],
        ['2.9', 2],
        ['1', 1],
        ['0', 20],
        ['-4', 20],
        ['abc', 20],
        ['', 20],
      ] as const) {
        const body = await counterparties(m, `limit=${limit}`);
        expect([limit, body.count, body.counterparties.length, body.total]).toEqual([
          limit,
          expected,
          expected,
          MANY_COUNT,
        ]);
      }
      // the 1000 are the 1000 best: the least of them is the one that paid 6 XRP
      const most = await counterparties(m, 'limit=5000');
      expect(most.counterparties[999].account).toBe(manyCounterparty(MANY_COUNT - 999));
      // by count every counterparty has one payment: the account decides
      const byCount = await counterparties(m, 'sort=count&limit=3');
      expect(byCount.counterparties.map((c) => c.account)).toEqual([
        manyCounterparty(1),
        manyCounterparty(2),
        manyCounterparty(3),
      ]);
    });

    it('the exact order wins over the Float64 preselection', async () => {
      // the doubles of 9007199254740992 and 9007199254740993 are the same, so the database ties the two and keeps the
      // account first; the exact values differ by one, and the larger is first
      const [{ f_low, f_high }] = await h.ch.query<{ f_low: number; f_high: number }>(
        `SELECT toFloat64('9007199254740992') AS f_low, toFloat64('9007199254740993') AS f_high`,
      );
      expect(f_low).toBe(f_high);

      const both = await counterparties(I2, 'limit=3');
      expect(both.counterparties.map((c) => [c.account, c.total_value])).toEqual([
        [TIE_HIGH, '9007199254740993'],
        [TIE_LOW, '9007199254740992'],
        [TIE_MID, '5'],
      ]);
      // and with room for one only, it is the one with the larger exact value that is served, not the first account
      const one = await counterparties(I2, 'limit=1');
      expect(one.total).toBe(3);
      expect(one.counterparties.map((c) => c.account)).toEqual([TIE_HIGH]);
      expect(one.counterparties[0].sent_value).toBe('9007199254740993');
    });

    it('reads the payments three times, each a payment once and in the order of its key, and keeps a few more than the limit', async () => {
      const calls = await queriesOf(h, () => counterparties(A, 'end=2020-06-30&limit=2'));
      const reads = reading(calls, Table.AccountPayments);
      expect(reads).toHaveLength(3);
      for (const { sql, params } of reads) {
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).toContain('ORDER BY account, ledger_index, tx_index, direction');
        expect(sql).toContain('LIMIT 1 BY ledger_index, tx_index');
        expect(params).toMatchObject({
          account: A,
          min: world.ledgerAt('2020-01-10T09:00:00Z'),
          max: world.ledgerAt('2020-06-15T09:00:00Z'),
        });
      }
      const [assets, ranking, exact] = reads;
      // the side is the account's own for a payment to oneself, in the reads that count by side
      for (const { sql } of [ranking, exact]) {
        expect(sql).toContain("if(counterparty = account, 'sent', toString(direction))");
      }
      // (1) the issued assets and the days: nothing for the native currency
      expect(assets.sql).toContain("issuer != ''");
      expect(assets.sql).toContain('GROUP BY currency, issuer, day');
      // (2) the ranking is in SQL: ordered, limited to the limit and ten more, with the number of all the counterparties
      expect(ranking.sql).toContain('count() OVER ()');
      expect(ranking.sql).toMatch(/ORDER BY total_f DESC, counterparty\s+LIMIT \{kept:UInt32\}/);
      expect(ranking.params.kept).toBe(12);
      // (3) the exact sums of those only
      expect(exact.sql).toContain('counterparty IN {counterparties:Array(String)}');
      expect((exact.params.counterparties as string[]).length).toBe(5);
      // by count the order is the count
      const byCount = reading(await queriesOf(h, () => counterparties(A, 'sort=count')), Table.AccountPayments)[1];
      expect(byCount.sql).toMatch(/ORDER BY payments_sent \+ payments_received DESC, counterparty\s+LIMIT/);
    });

    it('format=csv gives the counterparties as <address> - counterparties.csv', async () => {
      const res = await get(`${COUNTERPARTIES(A)}?end=2020-06-30&format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${A} - counterparties`));
      const lines = res.text.split('\n');
      expect(lines).toHaveLength(1 + 5);
      expect(lines[0].split(',')).toEqual([
        '"account"',
        '"sent_value"',
        '"received_value"',
        '"total_value"',
        '"payments_sent"',
        '"payments_received"',
        '"first"',
        '"last"',
      ]);
      expect(lines[1]).toBe(`"${B}","15","24","39","2","3","2020-01-16T09:00:00Z","2020-06-15T09:00:00Z"`);
      // a JSON answer stays one when the format is anything else
      expect((await get(`${COUNTERPARTIES(A)}?end=2020-06-30&format=json`)).body).toHaveProperty('counterparties');
    });

    it('the errors come in order: start, end, then sort', async () => {
      const url = (query: string): string => `${COUNTERPARTIES(A)}?${query}`;
      expect(await failure(url('start=nope&end=nope&sort=nope'))).toEqual(bad('invalid start date format'));
      expect(await failure(url('end=nope&sort=nope'))).toEqual(bad('invalid end date format'));
      expect(await failure(url('start=2020-01-01&end=nope&sort=nope'))).toEqual(bad('invalid end date format'));
      expect(await failure(url('start=2020-01-01&end=2020-02-01&sort=nope'))).toEqual(
        bad('invalid sort - use: value, count'),
      );
      // the interval is not a parameter of the route: a wrong one is not an error
      expect(await failure(url('sort=nope&interval=year'))).toEqual(bad('invalid sort - use: value, count'));
      expect((await get(url('interval=year'))).status).toBe(200);
      // an error is not cached
      expect((await get(url('sort=nope'))).headers['cache-control']).toBe('no-store');
    });

    it('is an empty answer for an empty window, an account with none, and an address that is none', async () => {
      for (const account of [S, 'notanaddress']) {
        const res = await get(`${COUNTERPARTIES(account)}?end=2020-06-30`);
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          {
            result: 'success',
            start: T('2013-01-01'),
            end: T('2020-07-01'),
            sort: 'value',
            total: 0,
            count: 0,
            counterparties: [],
          },
        ]);
      }
      // a window with no ledger
      expect((await counterparties(A, 'start=2021-01-01&end=2021-01-31')).counterparties).toEqual([]);
      // an end before the start: nothing is read, and start and end are the start of the first day
      const calls = await queriesOf(h, async () => {
        const res = await get(`${COUNTERPARTIES(A)}?start=2020-06-30&end=2020-01-01&sort=count`);
        expect(res.body).toEqual({
          result: 'success',
          start: T('2020-06-30'),
          end: T('2020-06-30'),
          sort: 'count',
          total: 0,
          count: 0,
          counterparties: [],
        });
      });
      expect(calls).toHaveLength(0);
    });

    it('interval is not a parameter of these routes: ignored, even interval=year', async () => {
      const plain = await get(`${COUNTERPARTIES(A)}?end=2020-06-30`);
      for (const interval of ['year', 'week', 'month', 'day', '']) {
        const res = await get(`${COUNTERPARTIES(A)}?end=2020-06-30&interval=${interval}`);
        expect([interval, res.status, res.body]).toEqual([interval, 200, plain.body]);
      }
      expect(plain.body).not.toHaveProperty('interval');
      // the window is not widened to a bucket: the end is the day after the last day
      const week = await get(`${COUNTERPARTIES(A)}?start=2020-02-12&end=2020-02-12&interval=week`);
      expect([week.body.start, week.body.end]).toEqual([T('2020-02-12'), T('2020-02-13')]);

      const exchangesPlain = await get(`${EXCHANGES(A)}?end=2020-06-30`);
      for (const interval of ['year', 'week', 'month', 'day', '']) {
        const res = await get(`${EXCHANGES(A)}?end=2020-06-30&interval=${interval}`);
        expect([interval, res.status, res.body]).toEqual([interval, 200, exchangesPlain.body]);
      }
      expect(exchangesPlain.body).not.toHaveProperty('interval');
      const exchangesWeek = await get(`${EXCHANGES(A)}?start=2020-02-12&end=2020-02-12&interval=month`);
      expect([exchangesWeek.body.start, exchangesWeek.body.end]).toEqual([T('2020-02-12'), T('2020-02-13')]);
    });

    it('unknown parameters are ignored, and Cache-Control is private, max-age=60', async () => {
      const plain = await get(`${COUNTERPARTIES(A)}?end=2020-06-30`);
      const extra = await get(`${COUNTERPARTIES(A)}?end=2020-06-30&foo=bar&amm=exclude&marker=x&currency=USD`);
      expect(extra.body).toEqual(plain.body);
      expect(plain.headers['cache-control']).toBe('private, max-age=60');
      expect(extra.headers['cache-control']).toBe('private, max-age=60');
    });

    it('a failing query is 500 unable to retrieve counterparties', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(`${COUNTERPARTIES(A)}?end=2020-06-30`);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve counterparties' }]);
      jest.restoreAllMocks();
      // and it is the same route that answers when the database is back
      expect((await get(`${COUNTERPARTIES(A)}?end=2020-06-30`)).status).toBe(200);
    });
  });

  // -- exchanges --------------------------------------------------------------------------------------------------

  describe('exchanges', () => {
    it('per pair in the canonical stored order: count, base_volume, counter_volume, bought (base it received as buyer), sold (base it gave as seller), bought_counter and sold_counter (the counter of those trades); a self-trade is in both', async () => {
      const body = await exchanges(A, 'end=2020-06-30');
      expect(body).toEqual({
        result: 'success',
        start: T('2013-01-01'),
        end: T('2020-07-01'),
        total: 5,
        count: 5,
        pairs: A_PAIRS,
      });
      expect(Object.keys(body)).toEqual(['result', 'start', 'end', 'total', 'count', 'pairs']);
      // USD / XRP: it bought 10 + 4.5 + 1 for 5 + 3 + 0.25, and sold 1 + 20 for 0.25 + 5; the self-trade (1 for 0.25) is in both
      expect(body.pairs.find((p) => p.counter_currency === 'XRP' && p.base_currency === 'USD')).toEqual(A_USD_XRP);
      // the keys of a pair, in order; the issuer of a native side is left out, and so is native_volume of a pair without one
      expect(Object.keys(body.pairs[1])).toEqual([
        'base_currency',
        'base_issuer',
        'counter_currency',
        'count',
        'base_volume',
        'counter_volume',
        'bought',
        'sold',
        'bought_counter',
        'sold_counter',
        'native_volume',
      ]);
      expect(Object.keys(body.pairs[0])).toEqual([
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'count',
        'base_volume',
        'counter_volume',
        'bought',
        'sold',
        'bought_counter',
        'sold_counter',
        'native_volume',
      ]);
      expect(Object.keys(body.pairs[4])).not.toContain('native_volume');
      expect(Object.keys(body.pairs[2])).toEqual(expect.not.arrayContaining(['base_issuer']));
    });

    it('analytics/exchanges counts a swap as a trade of its pair, bought and sold by side, and carries no AMM field', async () => {
      // the taker: 5 trades of USD / XRP, 3 of them swaps, and the swap of EUR / USD; its native volume is that of the counter
      // (13.5 XRP), and 60 USD at 2 (30) where the pair has no native side
      const taker = await exchanges(W, 'end=2020-06-30');
      expect(taker).toEqual({
        result: 'success',
        start: T('2013-01-01'),
        end: T('2020-07-01'),
        total: 2,
        count: 2,
        pairs: W_PAIRS,
      });
      // W bought 10 and 2 USD (the swap from the pool and the offer of B), sold 1 to B and 4 and 5 to the pool
      expect(taker.pairs[1]).toMatchObject({ bought: '12', sold: '10', bought_counter: '6', sold_counter: '7.5' });
      // the pool is on the other side of each swap: it sold 10 USD and bought 4 and 5, and it has no offer's trade
      const pool = await exchanges(P, 'end=2020-06-30');
      expect(pool.pairs).toEqual(P_PAIRS);
      expect([pool.total, pool.count]).toEqual([2, 2]);
      expect(pool.pairs[1]).toMatchObject({ bought: '9', sold: '10', bought_counter: '7', sold_counter: '5' });

      // a window of whole days adds up the days in it: a swap with an offer's trade of the same day, and a swap alone
      expect((await exchanges(W, 'start=2020-02-10&end=2020-02-10')).pairs).toEqual([
        pair(USD, 'XRP', 2, '11', '5.5', '10', '1', '5', '0.5', '5.5'),
      ]);
      expect((await exchanges(W, 'start=2020-03-05&end=2020-03-05')).pairs).toEqual([
        pair(USD, 'XRP', 1, '4', '3', '0', '4', '0', '3', '3'),
      ]);

      // no AMM field in the answers: not in the body, not in a pair, not in the CSV; the amm filter of the markets is none here
      const keysOf = (value: unknown): string[] =>
        value !== null && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
          : [];
      for (const body of [taker, pool]) {
        expect(keysOf(body).filter((key) => /amm|pool|swap|source/i.test(key))).toEqual([]);
        expect(Object.keys(body)).toEqual(['result', 'start', 'end', 'total', 'count', 'pairs']);
        for (const p of body.pairs) {
          expect(Object.keys(p)).toEqual([
            'base_currency',
            'base_issuer',
            'counter_currency',
            ...(p.counter_issuer === undefined ? [] : ['counter_issuer']),
            'count',
            'base_volume',
            'counter_volume',
            'bought',
            'sold',
            'bought_counter',
            'sold_counter',
            'native_volume',
          ]);
        }
      }
      const csv = await get(`${EXCHANGES(W)}?end=2020-06-30&format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.text.split('\n')[0]).not.toMatch(/amm|pool|swap/i);
      expect(csv.text.split('\n')).toHaveLength(1 + 2);
      for (const amm of ['exclude', 'only', 'include']) {
        expect((await get(`${EXCHANGES(W)}?end=2020-06-30&amm=${amm}`)).body).toEqual(taker);
      }
    });

    it('a window of whole days adds up the days in it', async () => {
      // March: USD / XRP twice (4.5 for 3 bought, and the self-trade), EUR / USD once, on a day USD has no rate
      const march = await exchanges(A, 'start=2020-03-01&end=2020-03-31');
      expect(march.total).toBe(2);
      expect(march.pairs).toEqual([
        pair(USD, 'XRP', 2, '5.5', '3.25', '5.5', '1', '3.25', '0.25', '3.25'),
        pair(EUR, USD, 1, '100', '7', '100', '0', '7', '0'),
      ]);
      expect([march.start, march.end]).toEqual([T('2020-03-01'), T('2020-04-01')]);
      // the whole day of the end, and of the start
      const day = await exchanges(A, 'start=2020-04-20&end=2020-04-20');
      expect(day.pairs.map((p) => [p.base_currency, p.counter_currency, p.count, p.native_volume])).toEqual([
        ['USD', 'XRP', 1, '5'],
        ['EUR', 'USD', 1, '2'],
      ]);
    });

    it("native_volume: the native side's volume; else per day the base volume over the base's rate, else the counter volume over the counter's rate, summed; left out when no day of the pair had a rate", async () => {
      const byPair = (body: ExchangesBody): Record<string, string | undefined> =>
        Object.fromEntries(body.pairs.map((p) => [`${p.base_currency}/${p.counter_currency}`, p.native_volume]));
      expect(byPair(await exchanges(A, 'end=2020-06-30'))).toEqual({
        // the native counter: 5 + 3 + 0.25 + 5
        'USD/XRP': '13.25',
        // the native base
        'XRP/ZAR': '5',
        // neither side native: EUR has no rate; the counter's rate of the day: 60 / 2 on 02-12, 10 / 2 on 02-20, 8 / 4 on
        // 04-20, and nothing on 03-01, when USD has none either
        'EUR/USD': '37',
        // no rate on any day
        'AUD/NZD': undefined,
        'CAD/GBP': undefined,
      });
      // a window that only has the day without a rate: nothing to value, so no native_volume though the pair has volume
      const noRate = await exchanges(A, 'start=2020-03-01&end=2020-03-01');
      expect(noRate.pairs).toEqual([pair(EUR, USD, 1, '100', '7', '100', '0', '7', '0')]);
      expect(Object.keys(noRate.pairs[0])).not.toContain('native_volume');
    });

    it('sorted by native_volume descending, the pairs without one last by count, then the pair key; total and count; limit 20 by default, 1000 at most', async () => {
      // 37, 13.25, 5, then the two without a native volume: 3 trades, then 2
      const sorted = await exchanges(A, 'end=2020-06-30');
      expect(sorted.pairs.map((p) => [p.base_currency, p.counter_currency, p.native_volume, p.count])).toEqual([
        ['EUR', 'USD', '37', 4],
        ['USD', 'XRP', '13.25', 4],
        ['XRP', 'ZAR', '5', 1],
        ['AUD', 'NZD', undefined, 3],
        ['CAD', 'GBP', undefined, 2],
      ]);
      const limited = await exchanges(A, 'end=2020-06-30&limit=2');
      expect([limited.total, limited.count]).toEqual([5, 2]);
      expect(limited.pairs).toEqual(A_PAIRS.slice(0, 2));

      const m = world.many;
      const def = await exchanges(m);
      expect([def.total, def.count, def.pairs.length]).toEqual([MANY_COUNT, 20, 20]);
      // the largest native volume first: the pair P<i> of XRP has `i`
      expect(def.pairs.map((p) => p.base_currency)).toEqual(
        Array.from({ length: 20 }, (_, n) => `P${pad4(MANY_COUNT - n)}`),
      );
      // the account is the buyer: it received 1 P1005 for 1005 XRP
      expect(def.pairs[0]).toEqual(pair(`P1005+${I2}`, 'XRP', 1, '1', '1005', '1', '0', '1005', '0', '1005'));
      for (const [limit, expected] of [
        ['1000', 1000],
        ['1001', 1000],
        ['1000000', 1000],
        ['3', 3],
        ['2.9', 2],
        ['0', 20],
        ['-4', 20],
        ['abc', 20],
        ['', 20],
      ] as const) {
        const body = await exchanges(m, `limit=${limit}`);
        expect([limit, body.count, body.pairs.length, body.total]).toEqual([limit, expected, expected, MANY_COUNT]);
      }
      expect((await exchanges(m, 'limit=5000')).pairs[999].base_currency).toBe(`P${pad4(MANY_COUNT - 999)}`);
    });

    it('reads the day groups of the trades once, and asks for the rates of the issued sides of the pairs without a native side only', async () => {
      const calls = await queriesOf(h, () => exchanges(A, 'start=2020-01-01&end=2020-06-30'));
      const groups = reading(calls, Table.AccountExchanges).filter((c) => c.sql.includes('{dg_account:String}'));
      expect(groups).toHaveLength(1);
      expect(groups[0].sql).not.toMatch(/\bFINAL\b/);
      expect(groups[0].sql).toContain('LIMIT 1 BY');
      expect(groups[0].sql).toMatch(/GROUP BY day, base_currency, base_issuer, counter_currency, counter_issuer/);
      expect(groups[0].params.dg_account).toBe(A);
      // the rates are asked for the days of the pairs without a native side only: from 02-01 (AUD / NZD) to 06-10 (CAD / GBP),
      // not from 01-15, when A traded XRP / ZAR; one read of the valid days of that range
      const valid = calls.filter(
        (c) => c.sql.includes(`FROM ${Table.NativeRatesDaily}`) && c.sql.includes("currency = ''"),
      );
      expect(valid).toHaveLength(1);
      expect(valid[0].params).toMatchObject({ from: '2020-02-01', through: '2020-06-10' });

      // a window with native pairs only asks for no rate at all
      const native = await queriesOf(h, () => exchanges(A, 'start=2020-01-15&end=2020-01-15'));
      expect(
        native.some((c) => c.sql.includes(Table.NativeRatesDaily) || c.sql.includes(`FROM ${Table.Exchanges}`)),
      ).toBe(false);
    });

    it('format=csv gives the pairs as <address> - exchange pairs.csv', async () => {
      const res = await get(`${EXCHANGES(A)}?end=2020-06-30&format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${A} - exchange pairs`));
      const lines = res.text.split('\n');
      expect(lines).toHaveLength(1 + 5);
      expect(lines[0].split(',')).toEqual([
        '"base_currency"',
        '"base_issuer"',
        '"counter_currency"',
        '"counter_issuer"',
        '"count"',
        '"base_volume"',
        '"counter_volume"',
        '"bought"',
        '"sold"',
        '"bought_counter"',
        '"sold_counter"',
        '"native_volume"',
      ]);
      expect(lines[1]).toBe(`"EUR","${I}","USD","${I}","4","139","85","130","9","67","18","37"`);
      // a native side has no issuer: an empty cell
      expect(lines[2]).toBe(`"USD","${I}","XRP","","4","35.5","13.25","15.5","21","8.25","5.25","13.25"`);
    });

    it('the errors come in order: start, then end', async () => {
      expect(await failure(`${EXCHANGES(A)}?start=nope&end=nope`)).toEqual(bad('invalid start date format'));
      expect(await failure(`${EXCHANGES(A)}?end=nope`)).toEqual(bad('invalid end date format'));
      // there is no sort, and no interval: they are no errors
      expect((await get(`${EXCHANGES(A)}?sort=nope&interval=year`)).status).toBe(200);
      expect((await get(`${EXCHANGES(A)}?end=nope`)).headers['cache-control']).toBe('no-store');
    });

    it('is an empty answer for an empty window, an account with none, and an address that is none', async () => {
      for (const account of [S, 'notanaddress']) {
        const res = await get(`${EXCHANGES(account)}?end=2020-06-30`);
        expect([account, res.status, res.body]).toEqual([
          account,
          200,
          { result: 'success', start: T('2013-01-01'), end: T('2020-07-01'), total: 0, count: 0, pairs: [] },
        ]);
      }
      expect((await exchanges(A, 'start=2021-01-01&end=2021-01-31')).pairs).toEqual([]);
      const calls = await queriesOf(h, async () => {
        const res = await get(`${EXCHANGES(A)}?start=2020-06-30&end=2020-01-01`);
        expect(res.body).toEqual({
          result: 'success',
          start: T('2020-06-30'),
          end: T('2020-06-30'),
          total: 0,
          count: 0,
          pairs: [],
        });
      });
      expect(calls).toHaveLength(0);
    });

    it('unknown parameters are ignored, and Cache-Control is private, max-age=60', async () => {
      const plain = await get(`${EXCHANGES(A)}?end=2020-06-30`);
      const extra = await get(`${EXCHANGES(A)}?end=2020-06-30&foo=bar&amm=exclude&sort=count&marker=x`);
      expect(extra.body).toEqual(plain.body);
      expect(plain.headers['cache-control']).toBe('private, max-age=60');
    });

    it('a failing query is 500 unable to retrieve exchanges', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(`${EXCHANGES(A)}?end=2020-06-30`);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve exchanges' }]);
      jest.restoreAllMocks();
      expect((await get(`${EXCHANGES(A)}?end=2020-06-30`)).status).toBe(200);
    });
  });

  it('the routes are the handlers of analytics/, and leave the other routes of an account as they were', async () => {
    expect((await get(`/v2/accounts/${A}/payments?limit=1`)).body).toHaveProperty('payments');
    expect((await get(`/v2/accounts/${A}/exchanges/USD+${I}/XRP`)).status).toBe(200);
    expect((await get(`/v2/accounts/${A}/analytics/nothing`)).status).toBe(404);
  });

  // -- the same answer rolled up (keep it last: it writes rollups, which the reads after it would use) ----------------

  describe('the same answer rolled up', () => {
    it('the same answer rolled up', async () => {
      const urls = [
        `${EXCHANGES(A)}?end=2020-06-30`,
        `${EXCHANGES(A)}`,
        `${EXCHANGES(A)}?start=2020-03-01&end=2020-03-31`,
        `${EXCHANGES(A)}?start=2020-02-11&end=2020-05-06`,
        `${EXCHANGES(A)}?start=2020-04-20&end=2020-04-20`,
        `${EXCHANGES(A)}?end=2020-06-30&limit=2`,
        `${EXCHANGES(A)}?start=2019-01-01`,
        `${EXCHANGES(world.many)}?limit=1000`,
        // the taker and the pool of the swaps: the whole of it, a window that cuts the first day out, one day with a swap and an
        // offer's trade, and the days of a swap alone
        `${EXCHANGES(W)}?end=2020-06-30`,
        `${EXCHANGES(W)}`,
        `${EXCHANGES(W)}?start=2020-02-11&end=2020-05-06`,
        `${EXCHANGES(W)}?start=2020-02-10&end=2020-02-10`,
        `${EXCHANGES(W)}?start=2020-03-05&end=2020-03-05`,
        `${EXCHANGES(P)}?end=2020-06-30`,
        `${EXCHANGES(P)}?start=2020-03-01&end=2020-04-30`,
        // the counterparties are read on read from the payments, whatever the rollups hold
        `${COUNTERPARTIES(A)}?end=2020-06-30`,
        `${COUNTERPARTIES(A)}?end=2020-06-30&sort=count`,
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
      expect((raw[0] as ExchangesBody).pairs).toEqual(A_PAIRS);
      // the swaps are in the raw answers: those of the taker and of the pool
      expect((raw[urls.indexOf(`${EXCHANGES(W)}?end=2020-06-30`)] as ExchangesBody).pairs).toEqual(W_PAIRS);
      expect((raw[urls.indexOf(`${EXCHANGES(P)}?end=2020-06-30`)] as ExchangesBody).pairs).toEqual(P_PAIRS);

      const accounts = [A, world.many, W, P];
      // complete coverage of the world: the groups come from the rollups, and the rest of the window from nothing
      for (const account of accounts) await rollUp(h, api, account, { from: '2020-01-01', through: '2020-07-31' });
      const complete = await queriesOf(h, async () => expect(await bodies()).toEqual(raw));
      expect(reading(complete, Table.AccountTradesDaily).length).toBeGreaterThan(0);
      expect(
        reading(complete, Table.AccountExchanges).filter((c) => c.sql.includes('{dg_account:String}')),
      ).toHaveLength(0);
      // the payments are read as they were
      expect(reading(complete, Table.AccountPayments).length).toBeGreaterThan(0);

      // coverage from 2020-03-01: January and February come from the raw rows, the rest from the rollups
      for (const account of accounts) await rollUp(h, api, account, { from: '2020-03-01', through: '2020-07-31' });
      const partial = await queriesOf(h, async () => expect(await bodies()).toEqual(raw));
      expect(reading(partial, Table.AccountTradesDaily).length).toBeGreaterThan(0);
      expect(
        reading(partial, Table.AccountExchanges).filter((c) => c.sql.includes('{dg_account:String}')).length,
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

describe('analytics/counterparties and analytics/exchanges valued with stored sets of rates', () => {
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
      issuer: I,
      rate: rateText,
      rate_f: Number(rateText),
      daily_count: 12,
      latest_count: 12,
      ...over,
    });

  beforeAll(async () => {
    h = await startHarness({
      seed: 'none',
      env: NO_RATE_LIMIT,
      controllers: async () => (await import('./cache-controllers')).CACHE_CONTROLLERS,
    });
    api = await h.api();
    world = await seedAnalyticsWorld(h);
    await seedAccountPayments(h, world, A, PAYMENTS_A);
    await seedAccountTrades(h, world, A, TRADES_A);
    await h.ch.insert(Table.NativeRatesDaily, [
      // 02-12: USD is worth 5 to the XRP here (the trades give 2), EUR 0.5; an older set of the day had 99 and is not the one
      sentinel('2020-02-12', 900),
      rate('2020-02-12', 900, 'USD', '99'),
      sentinel('2020-02-12', 1_000),
      rate('2020-02-12', 1_000, 'USD', '5'),
      rate('2020-02-12', 1_000, 'EUR', '0.5'),
      // 02-14: a valid set that has no USD: it has no rate that day, though the trades would give 2
      sentinel('2020-02-14', 1_001),
      rate('2020-02-14', 1_001, 'EUR', '1'),
      // 03-01: USD is worth 3 (the trades give none)
      sentinel('2020-03-01', 1_002),
      rate('2020-03-01', 1_002, 'USD', '3'),
      // 04-20 was marked stale after its set was made: the trades give 4 (the 100 of the set is not read)
      sentinel('2020-04-20', 1_003),
      rate('2020-04-20', 1_003, 'USD', '100'),
      sentinel('2020-04-20', 1_004, { stale: 1 }),
      // 02-20 is of another config version: the trades give 2
      sentinel('2020-02-20', 1_005, { config_version: 2 }),
      rate('2020-02-20', 1_005, 'USD', '1000', { config_version: 2 }),
    ]);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await api.ok('/v2/test-cache/clear', 'result');
  });
  afterEach(() => jest.restoreAllMocks());

  it('counterparties: the rates of the valid days are the table rows of the version of their sentinel, those of the other days are computed on read', async () => {
    const calls = await queriesOf(h, async () => {
      const body: CounterpartiesBody = (
        await api.ok<CounterpartiesBody>(`${COUNTERPARTIES(A)}?end=2020-06-30`, 'counterparties')
      ).body;
      // B: received 20 USD on 02-10 (no set: 2 from the trades, 10), 10 USD on 02-12 (the set: 5, so 2) and 9 XRP, sent 15;
      // S: sent 2 + 4 XRP, 8 USD on 02-14 (a set without USD: 0) and 40 USD on 04-20 (stale: 4 from the trades, 10); it
      // was paid 6 USD on 03-01 (the set: 3, so 2)
      expect(body.counterparties).toEqual([
        cp(B, '15', '21', '36', 2, 3, '2020-01-16T09:00:00Z', '2020-06-15T09:00:00Z'),
        cp(S, '16', '2', '18', 4, 1, '2020-01-17T09:00:00Z', '2020-04-20T12:00:00Z'),
        A_I,
        A_SELF,
        A_H,
      ]);
    });

    const [, ranking] = reading(calls, Table.AccountPayments);
    const { params } = ranking;
    // the days with a payment of an issued asset: 02-10, 02-12, 02-14, 03-01 and 04-20; the valid ones are 02-12, 02-14, 03-01
    expect(params.dr_read_days).toEqual(['2020-02-10', '2020-04-20']);
    // only what was computed on read is passed per day: USD on 02-10 and on 04-20
    expect(params).toMatchObject({
      dr_currencies: ['USD', 'USD'],
      dr_issuers: [I, I],
      dr_days: ['2020-02-10', '2020-04-20'],
      dr_rates: [2, 4],
    });
    // and no list holds a valid day
    for (const value of Object.values(params)) {
      if (!Array.isArray(value)) continue;
      expect(value).not.toContain('2020-02-12');
      expect(value).not.toContain('2020-02-14');
      expect(value).not.toContain('2020-03-01');
    }
    // the rows of the valid days are read by the statement itself, from the sentinels
    expect(ranking.sql).toContain(`FROM ${Table.NativeRatesDaily}`);
    expect(ranking.sql).toContain('(day, version) IN');
    expect(ranking.sql).toContain('UNION ALL');
    expect(ranking.sql).not.toMatch(/\bFINAL\b/);
  });

  it('counterparties: the same by count, and for a window of valid days only', async () => {
    const byCount: CounterpartiesBody = (
      await api.ok<CounterpartiesBody>(`${COUNTERPARTIES(A)}?end=2020-06-30&sort=count`, 'counterparties')
    ).body;
    expect(byCount.counterparties.map((c) => c.account)).toEqual([H, B, S, A, I]);
    // 02-12 to 03-01: every day with an issued payment has a set
    const sets: CounterpartiesBody = (
      await api.ok<CounterpartiesBody>(`${COUNTERPARTIES(A)}?start=2020-02-12&end=2020-03-01`, 'counterparties')
    ).body;
    expect(sets.counterparties).toEqual([
      cp(S, '4', '2', '6', 2, 1, '2020-02-12T09:00:00Z', '2020-03-01T09:00:00Z'),
      cp(B, '0', '2', '2', 0, 1, '2020-02-12T09:00:00Z', '2020-02-12T09:00:00Z'),
    ]);
  });

  it("exchanges: per day the base volume over the base's rate, else the counter volume over the counter's rate", async () => {
    const body: ExchangesBody = (await api.ok<ExchangesBody>(`${EXCHANGES(A)}?end=2020-06-30`, 'pairs')).body;
    // EUR / USD: on 02-12 the base has a rate (0.5): 30 / 0.5 is 60, not the counter's 60 / 5; on 02-20 (another config
    // version) the trades give USD 2: 10 / 2 is 5; on 03-01 the set gives USD 3: 7 / 3, cut to 17 digits; on 04-20 (stale)
    // the trades give 4: 8 / 4 is 2
    expect(body.pairs[0]).toEqual(pair(EUR, USD, 4, '139', '85', '130', '9', '67', '18', '69.3333333333333333'));
    // the pairs with a native side do not depend on the rates
    expect(body.pairs.slice(1)).toEqual([A_USD_XRP, A_XRP_ZAR, A_AUD_NZD, A_CAD_GBP]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The ripple-mock seed
// ---------------------------------------------------------------------------------------------------------------------

describe('analytics/counterparties and analytics/exchanges on the ripple-mock seed', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
  const ZERO = new BigNumber(0);

  it("on the ripple-mock seed, for every account, the pairs' counts and volumes equal an oracle from its account_exchanges rows", async () => {
    const ROWS = fixtureAccountExchanges('ripple-mock');
    const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))].sort();
    expect(ACCOUNTS.length).toBeGreaterThan(10);

    // the rates the oracle values with: what `RatesService` computes, which is what `DailyRates` falls back on
    const rates = new RatesService(h.ch, 'XRP');
    const days = ROWS.map((r) => day(r.close_time)).sort();
    const from = new Date(`${days[0]}T00:00:00Z`);
    const toExclusive = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000);
    const issued = new Map<string, { currency: string; issuer: string }>();
    for (const r of ROWS) {
      if (r.base_issuer !== '')
        issued.set(`${r.base_currency}.${r.base_issuer}`, { currency: r.base_currency, issuer: r.base_issuer });
      if (r.counter_issuer !== '')
        issued.set(`${r.counter_currency}.${r.counter_issuer}`, {
          currency: r.counter_currency,
          issuer: r.counter_issuer,
        });
    }
    const rateOf = await rates.dailyNativeRates([...issued.values()], from, toExclusive);

    interface Oracle {
      row: (typeof ROWS)[number];
      count: number;
      base: BigNumber;
      counter: BigNumber;
      bought: BigNumber;
      sold: BigNumber;
      boughtCounter: BigNumber;
      soldCounter: BigNumber;
      perDay: Map<string, { base: BigNumber; counter: BigNumber }>;
    }
    let valued = 0;
    let both = 0;
    let checked = 0;
    for (const account of ACCOUNTS) {
      const pairs = new Map<string, Oracle>();
      for (const r of ROWS.filter((row) => row.account === account)) {
        const key = [r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('|');
        const o = pairs.get(key) ?? {
          row: r,
          count: 0,
          base: ZERO,
          counter: ZERO,
          bought: ZERO,
          sold: ZERO,
          boughtCounter: ZERO,
          soldCounter: ZERO,
          perDay: new Map(),
        };
        const base = new BigNumber(r.base_amount);
        const counter = new BigNumber(r.counter_amount);
        o.count += 1;
        o.base = o.base.plus(base);
        o.counter = o.counter.plus(counter);
        if (r.buyer === account) {
          o.bought = o.bought.plus(base);
          o.boughtCounter = o.boughtCounter.plus(counter);
        }
        if (r.seller === account) {
          o.sold = o.sold.plus(base);
          o.soldCounter = o.soldCounter.plus(counter);
        }
        const d = day(r.close_time);
        const perDay = o.perDay.get(d) ?? { base: ZERO, counter: ZERO };
        o.perDay.set(d, { base: perDay.base.plus(base), counter: perDay.counter.plus(counter) });
        pairs.set(key, o);
      }

      // the native volume of a pair: the native side; else per day the base over its rate, else the counter over its rate
      const nativeVolume = (o: Oracle): BigNumber | undefined => {
        const r = o.row;
        if (r.base_currency === 'XRP' && r.base_issuer === '') return o.base;
        if (r.counter_currency === 'XRP' && r.counter_issuer === '') return o.counter;
        const baseAsset = { currency: r.base_currency, issuer: r.base_issuer };
        const counterAsset = { currency: r.counter_currency, issuer: r.counter_issuer };
        const key = (a: { currency: string; issuer: string }): string => `${a.currency}.${a.issuer}`;
        let total: BigNumber | undefined;
        for (const [d, v] of o.perDay) {
          const baseRate = rateOf.get(key(baseAsset))?.get(d);
          const counterRate = rateOf.get(key(counterAsset))?.get(d);
          let value: BigNumber | undefined;
          if (baseRate?.gt(0)) value = nativeValue(v.base, baseAsset, d, rateOf, 'XRP');
          else if (counterRate?.gt(0)) value = nativeValue(v.counter, counterAsset, d, rateOf, 'XRP');
          if (value !== undefined) total = (total ?? ZERO).plus(value);
        }
        return total;
      };

      const body: ExchangesBody = (await api.ok<ExchangesBody>(`${EXCHANGES(account)}?limit=1000`, 'pairs')).body;
      const served = new Map(
        body.pairs.map((p): [string, Pair] => [
          [p.base_currency, p.base_issuer ?? '', p.counter_currency, p.counter_issuer ?? ''].join('|'),
          p,
        ]),
      );
      expect([account, [...served.keys()].sort()]).toEqual([account, [...pairs.keys()].sort()]);
      expect(body.total).toBe(pairs.size);
      expect(body.count).toBe(pairs.size);
      for (const [key, o] of pairs) {
        const p = served.get(key) as Pair;
        const native = nativeVolume(o);
        expect([
          account,
          key,
          p.count,
          p.base_volume,
          p.counter_volume,
          p.bought,
          p.sold,
          p.bought_counter,
          p.sold_counter,
          p.native_volume,
        ]).toEqual([
          account,
          key,
          o.count,
          o.base.toString(),
          o.counter.toString(),
          o.bought.toString(),
          o.sold.toString(),
          o.boughtCounter.toString(),
          o.soldCounter.toString(),
          native?.toString(),
        ]);
        if (native !== undefined && o.row.base_issuer !== '' && o.row.counter_issuer !== '') both += 1;
        if (native !== undefined) valued += 1;
        checked += o.count;
      }
      // the order: by native_volume, the largest first, those without last by count, then the pair
      const order = [...pairs.entries()]
        .map(([key, o]) => ({ key, o, native: nativeVolume(o) }))
        .sort((a, b) => {
          if (a.native && b.native) return b.native.comparedTo(a.native) || (a.key < b.key ? -1 : 1);
          if (a.native || b.native) return a.native ? -1 : 1;
          return b.o.count - a.o.count || (a.key < b.key ? -1 : 1);
        })
        .map((x) => x.key);
      expect([
        account,
        body.pairs.map((p) =>
          [p.base_currency, p.base_issuer ?? '', p.counter_currency, p.counter_issuer ?? ''].join('|'),
        ),
      ]).toEqual([account, order]);
    }
    expect(checked).toBe(ROWS.length);
    // the oracle is not made of one case: pairs with a native volume, among them some of two issued sides, valued by rates
    expect(valued).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(0);
  });

  it("on the ripple-mock seed, for every account, the counterparties' counts, first and last, and values equal an oracle from its account_payments rows", async () => {
    const ROWS = fixtureAccountPayments('ripple-mock');
    const ACCOUNTS = [...new Set(ROWS.map((r) => r.account))].sort();
    expect(ACCOUNTS.length).toBeGreaterThan(10);

    const rates = new RatesService(h.ch, 'XRP');
    const days = ROWS.map((r) => day(r.close_time)).sort();
    const from = new Date(`${days[0]}T00:00:00Z`);
    const toExclusive = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000);
    const issued = new Map<string, { currency: string; issuer: string }>();
    for (const r of ROWS)
      if (r.issuer !== '') issued.set(`${r.currency}.${r.issuer}`, { currency: r.currency, issuer: r.issuer });
    const rateOf = await rates.dailyNativeRates([...issued.values()], from, toExclusive);

    let rated = 0;
    let checked = 0;
    for (const account of ACCOUNTS) {
      // each payment once (a payment to oneself has two rows), the side as reports have it: to oneself is sent
      const payments = new Map<string, (typeof ROWS)[number]>();
      for (const r of ROWS.filter((row) => row.account === account)) {
        const key = `${r.ledger_index}|${r.tx_index}`;
        const kept = payments.get(key);
        if (kept === undefined || (r.counterparty === account && r.direction === 'sent')) payments.set(key, r);
      }
      interface Entry {
        sent: number;
        received: number;
        first: number;
        last: number;
        // (side, asset, day) -> amount
        sums: Map<
          string,
          { side: string; asset: { currency: string; issuer?: string }; day: string; amount: BigNumber }
        >;
      }
      const perCounterparty = new Map<string, Entry>();
      for (const r of payments.values()) {
        const side = r.counterparty === account ? 'sent' : r.direction;
        const e = perCounterparty.get(r.counterparty) ?? {
          sent: 0,
          received: 0,
          first: Infinity,
          last: 0,
          sums: new Map(),
        };
        if (side === 'sent') e.sent += 1;
        else e.received += 1;
        e.first = Math.min(e.first, r.close_time);
        e.last = Math.max(e.last, r.close_time);
        const d = day(r.close_time);
        const k = `${side}|${r.currency}|${r.issuer}|${d}`;
        const s = e.sums.get(k) ?? {
          side,
          asset: r.issuer === '' ? { currency: r.currency } : { currency: r.currency, issuer: r.issuer },
          day: d,
          amount: ZERO,
        };
        s.amount = s.amount.plus(new BigNumber(r.delivered_amount));
        e.sums.set(k, s);
        perCounterparty.set(r.counterparty, e);
        checked += 1;
      }
      const expected = [...perCounterparty.entries()]
        .map(([counterparty, e]) => {
          let sent = ZERO;
          let received = ZERO;
          for (const s of e.sums.values()) {
            const value = nativeValue(s.amount, s.asset, s.day, rateOf, 'XRP');
            if (s.asset.issuer !== undefined && value.gt(0)) rated += 1;
            if (s.side === 'sent') sent = sent.plus(value);
            else received = received.plus(value);
          }
          return { counterparty, e, sent, received, total: sent.plus(received) };
        })
        .sort((a, b) => b.total.comparedTo(a.total) || (a.counterparty < b.counterparty ? -1 : 1));

      const body: CounterpartiesBody = (
        await api.ok<CounterpartiesBody>(`${COUNTERPARTIES(account)}?limit=1000`, 'counterparties')
      ).body;
      expect([account, body.total, body.count]).toEqual([account, expected.length, expected.length]);
      expect([account, body.counterparties]).toEqual([
        account,
        expected.map(({ counterparty, e, sent, received, total }) => ({
          account: counterparty,
          sent_value: sent.toString(),
          received_value: received.toString(),
          total_value: total.toString(),
          payments_sent: e.sent,
          payments_received: e.received,
          first: new Date(e.first * 1000).toISOString().slice(0, 19) + 'Z',
          last: new Date(e.last * 1000).toISOString().slice(0, 19) + 'Z',
        })),
      ]);
    }
    expect(checked).toBeGreaterThan(0);
    // the oracle is not made of zeros: some issued amounts of the mock were valued
    expect(rated).toBeGreaterThan(0);
  });
});

import { Asset, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { FixtureExchange, fixtureExchanges } from './support/fixtures';

/**
 * `GET /v2/active_accounts/:base/:counter` on a real ClickHouse, seeded with the 54 ledgers of the original Ripple test
 * suite (`ripple-mock`: 158 exchanges in 32 pairs, 5 of them USD+rMwj…/XRP) and, for the cases the mock ledgers cannot
 * make, with synthetic ledgers and exchanges.
 *
 * Ported from rippled-historical-database `test/test.active_accounts.js`, all 8 `it`s, same titles:
 *  - 'should error when XRP has issuer (base)' is the title of two `it`s in the original and stays so (the second
 *    one is the counter side);
 *  - 'should error when date is invalid' asks for `USD+zzz/XRP` in the original. The issuers of a pair are addresses
 *    here (ruling R33), checked before the period and the date, so the port uses a real issuer, and the address is a
 *    case of its own below.
 *
 * Added:
 *  - the accounts of every pair of the mock ledgers, both ways round, in two windows, against an oracle written from
 *    `organizeData` of the original (a pass over the exchanges in key order, the seller and then the buyer of each,
 *    sorted by base volume with the order of first appearance kept for equal ones; the volumes are added up exactly
 *    here, the original added floats), key order and types included;
 *  - 'inverted pair swaps buy/sell volumes', `include_exchanges` (the exchanges the way `hbase.getExchanges` left them
 *    in the original: no pair fields, `executed_time` with milliseconds), 'CSV works' (the original crashed on an
 *    undefined `utils`), the order of the checks, and the 500 for a failed database (the original never answered);
 *  - the window of the original: `date` and the period after it with the end named by the granularity of the date
 *    (`smoment.hbaseFormatStopRow`), now minus the period without a `date`;
 *  - synthetic ledgers on both networks: ties, a self trade, native legs of 0.0005, amounts an exact sum cannot hold,
 *    Xahau;
 *  - every exchange written twice, the SQL (bound values, the whole key, no FINAL) and its plan.
 */

const MWJ = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const KIC = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';
const USD_MWJ = `USD+${MWJ}`;

const pathOf = (a: Asset): string => (a.issuer ? `${a.currency}+${a.issuer}` : a.currency);
const assetOf = (currency: string, issuer: string): Asset => ({ currency, ...(issuer && { issuer }) });
const active = (base: string, counter: string): string => `/v2/active_accounts/${base}/${counter}`;
/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
/** Unix seconds of a time without a zone, which is UTC. */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;

interface Side {
  base_volume: string;
  counter_volume: string;
  count: number;
}
interface AccountBody {
  buy: Side;
  sell: Side;
  account: string;
  base_volume: string;
  counter_volume: string;
  count: number;
  exchanges?: Record<string, unknown>[];
}
interface ActiveBody {
  result: string;
  count: number;
  exchanges_count: number;
  accounts: AccountBody[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: `organizeData` of activeAccounts.js on the exchanges as stored
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The exchange the way `hbase.getExchanges` left it for `activeAccounts.js`: the keys of the HBase row in order (the `d`
 * family, then the `f` family, each sorted by name), without the four fields of the pair (`formatExchanges` deletes them
 * and this route does not set them again), with the `client` when the transaction had one (this route deletes only the
 * row key and the time, `getExchanges.js` the client too), with `executed_time` as `toISOString()` writes it.
 * `inverted` is a pair asked for the other way round: the amounts, the buyer and the seller swap and the rate is
 * inverted; the client is of the transaction and stays.
 */
function exchangeOf(row: ExchangesRow, inverted: boolean): Record<string, unknown> {
  const rate = new BigNumber(row.rate);
  const fields: Record<string, unknown> = {
    base_amount: inverted ? row.counter_amount : row.base_amount,
    counter_amount: inverted ? row.base_amount : row.counter_amount,
    node_index: row.node_index,
    rate: (inverted ? new BigNumber(1).dividedBy(rate) : rate).toPrecision(8),
    tx_index: row.tx_index,
    autobridged_currency: row.autobridged_currency ?? undefined,
    autobridged_issuer: row.autobridged_issuer || undefined,
    buyer: inverted ? row.seller : row.buyer,
    client: row.client || undefined,
    executed_time: new Date(row.close_time * 1000).toISOString(),
    ledger_index: row.ledger_index,
    offer_sequence: row.offer_sequence,
    provider: row.provider,
    seller: inverted ? row.buyer : row.seller,
    taker: row.taker,
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    // a swap against an AMM pool names the pool, last
    amm_account: row.amm_account || undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

interface Tally {
  base: BigNumber;
  counter: BigNumber;
  count: number;
}
const zero = (): Tally => ({ base: new BigNumber(0), counter: new BigNumber(0), count: 0 });
const sideOf = (t: Tally): Side => ({
  base_volume: t.base.toString(),
  counter_volume: t.counter.toString(),
  count: t.count,
});

/** The accounts of the exchanges of a pair (stored rows in key order) for the pair as asked for. */
function oracle(rows: ExchangesRow[], inverted: boolean, withExchanges = false): AccountBody[] {
  const accounts = new Map<string, { buy: Tally; sell: Tally; exchanges: Record<string, unknown>[] }>();
  const entry = (account: string) => {
    let e = accounts.get(account);
    if (!e) accounts.set(account, (e = { buy: zero(), sell: zero(), exchanges: [] }));
    return e;
  };
  for (const r of rows) {
    const seller = inverted ? r.buyer : r.seller;
    const buyer = inverted ? r.seller : r.buyer;
    const base = new BigNumber(inverted ? r.counter_amount : r.base_amount);
    const counter = new BigNumber(inverted ? r.base_amount : r.counter_amount);
    const add = (t: Tally): void => {
      t.base = t.base.plus(base);
      t.counter = t.counter.plus(counter);
      t.count++;
    };
    add(entry(seller).sell);
    add(entry(buyer).buy);
    if (withExchanges) {
      const exchange = exchangeOf(r, inverted);
      entry(seller).exchanges.push(exchange);
      entry(buyer).exchanges.push(exchange);
    }
  }
  const list = [...accounts].map(([account, e]) => ({
    account,
    e,
    base: e.buy.base.plus(e.sell.base),
    counter: e.buy.counter.plus(e.sell.counter),
    count: e.buy.count + e.sell.count,
  }));
  // `Array.prototype.sort` is stable: accounts of equal volume stay in the order they were first met
  list.sort((a, b) => b.base.comparedTo(a.base) ?? 0);
  return list.map((a) => ({
    buy: sideOf(a.e.buy),
    sell: sideOf(a.e.sell),
    account: a.account,
    base_volume: a.base.toString(),
    counter_volume: a.counter.toString(),
    count: a.count,
    ...(withExchanges && { exchanges: a.e.exchanges }),
  }));
}

const expectedBody = (rows: ExchangesRow[], inverted: boolean, withExchanges = false): Omit<ActiveBody, 'result'> => {
  const accounts = oracle(rows, inverted, withExchanges);
  return { count: accounts.length, exchanges_count: rows.length, accounts };
};

/** GET that must answer 200 with `accounts`; the body is typed (the body of a supertest response is `any`). */
async function accountsOf(api: ApiClient, path: string): Promise<{ body: ActiveBody }> {
  const res = await api.ok(path, 'accounts');
  return { body: res.body as ActiveBody };
}

/** The body as text: `toEqual` does not see the order of the keys, the text does. */
const text = (body: unknown): string => JSON.stringify(body);

// ---------------------------------------------------------------------------------------------------------------------
// The mock ledgers
// ---------------------------------------------------------------------------------------------------------------------

const byKey = (a: ExchangesRow, b: ExchangesRow): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;

interface Market {
  base: Asset;
  counter: Asset;
  rows: ExchangesRow[];
}
/** The pairs of a set of exchanges, as stored (canonical orientation), each with its rows in key order. */
function marketsOf(exchanges: FixtureExchange[]): Market[] {
  const markets = new Map<string, Market>();
  for (const { row } of exchanges) {
    const key = [row.base_currency, row.base_issuer, row.counter_currency, row.counter_issuer].join('|');
    const market = markets.get(key) ?? {
      base: assetOf(row.base_currency, row.base_issuer),
      counter: assetOf(row.counter_currency, row.counter_issuer),
      rows: [],
    };
    market.rows.push(row);
    markets.set(key, market);
  }
  for (const m of markets.values()) m.rows.sort(byKey);
  return [...markets.values()];
}
const MARKETS = marketsOf(fixtureExchanges('ripple-mock'));
const USD_XRP = MARKETS.find((m) => pathOf(m.base) === USD_MWJ && m.counter.currency === 'XRP') as Market;

/** The rows of a market that closed in `[from, before)`. */
const closedBetween = (rows: ExchangesRow[], from: string, before: string): ExchangesRow[] =>
  rows.filter((r) => r.close_time >= unix(from) && r.close_time < unix(before));

/**
 * The two windows the pairs are compared in. The window of a date that names a day runs to the end of the day that is
 * `period` after it: `date=2015-01-14&period=7day` reads through 2015-01-21 (see the window tests below).
 */
const WINDOWS = [
  { query: { date: '2015-01-14', period: '7day' }, from: '2015-01-14T00:00:00', before: '2015-01-22T00:00:00' },
  { query: { date: '2016-03-28', period: '1day' }, from: '2016-03-28T00:00:00', before: '2016-03-30T00:00:00' },
];

// ---------------------------------------------------------------------------------------------------------------------

describe('active accounts API endpoint', () => {
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
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- the tests of the original ----------------------------------------------------------------------------------

  describe('the tests of test.active_accounts.js', () => {
    const issuer = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

    it('get active accounts data', async () => {
      const res = await get(`/v2/active_accounts/xrp/USD+${issuer}?date=2015-01-14&period=7day`);
      expect(res.status).toBe(200);
      const body = res.body as ActiveBody;
      expect(typeof body).toBe('object');
      expect(body.result).toBe('success');
      expect(body.count).toBe(body.accounts.length);
      expect(Array.isArray(body.accounts)).toBe(true);
      let counted = 0;
      for (const d of body.accounts) {
        expect(typeof d.buy).toBe('object');
        expect(typeof d.sell).toBe('object');
        expect(typeof d.account).toBe('string');
        expect(typeof d.base_volume).toBe('string');
        expect(typeof d.counter_volume).toBe('string');
        expect(typeof d.count).toBe('number');
        counted += d.count;
      }
      expect(body.exchanges_count).toBe(counted / 2);
      // the five exchanges of USD+rMwj…/XRP and the seven accounts that traded them
      expect([body.exchanges_count, body.count]).toEqual([5, 7]);
    });

    it('get active accounts data with exchanges', async () => {
      const res = await get(`/v2/active_accounts/xrp/USD+${issuer}?date=2015-01-14&period=7day&include_exchanges=true`);
      expect(res.status).toBe(200);
      const body = res.body as ActiveBody;
      expect(typeof body).toBe('object');
      expect(body.result).toBe('success');
      expect(Array.isArray(body.accounts)).toBe(true);
      for (const d of body.accounts) expect(Array.isArray(d.exchanges)).toBe(true);
    });

    const failing = async (path: string, status: number, message: string): Promise<void> => {
      const res = await get(path);
      expect(res.status).toBe(status);
      expect(typeof res.body).toBe('object');
      expect(res.body).toEqual({ result: 'error', message });
    };

    it('should error when base currency has no issuer', async () => {
      await failing('/v2/active_accounts/USD/XRP?include_exchanges=true', 400, 'base issuer is required');
    });

    it('should error when counter currency has no issuer', async () => {
      await failing('/v2/active_accounts/XRP/USD?include_exchanges=true', 400, 'counter issuer is required');
    });

    it('should error when XRP has issuer (base)', async () => {
      await failing('/v2/active_accounts/XRP+zzzz/USD+zzzz?include_exchanges=true', 400, 'XRP cannot have an issuer');
    });

    it('should error when XRP has issuer (base)', async () => {
      await failing('/v2/active_accounts/USD+zzzz/XRP+zzzz?include_exchanges=true', 400, 'XRP cannot have an issuer');
    });

    it('should error when period is invalid', async () => {
      await failing(
        `/v2/active_accounts/xrp/USD+${BITSTAMP}?period=1234`,
        400,
        'invalid period - use: 1day, 3day, 7day',
      );
    });

    it('should error when date is invalid', async () => {
      await failing(
        `/v2/active_accounts/USD+${issuer}/XRP?include_exchanges=true&date=zzzz`,
        400,
        'invalid date format',
      );
    });
  });

  // -- the accounts ------------------------------------------------------------------------------------------------

  describe('the accounts of a pair', () => {
    const PAIR = active(USD_MWJ, 'xrp');
    const WINDOW = '?date=2015-01-14&period=7day';

    it('USD+rMwj…/XRP: seven accounts, volumes added up exactly, sorted by base volume', async () => {
      const res = await accountsOf(api, `${PAIR}${WINDOW}`);
      // rUZjA… bought twice (9.886182279 and 124.7435370355 USD for 677.135773 and 8544.077885 XRP)
      expect(res.body.accounts[0]).toEqual({
        buy: { base_volume: '134.6297193145', counter_volume: '9221.213658', count: 2 },
        sell: { base_volume: '0', counter_volume: '0', count: 0 },
        account: 'rUZjAUwatwbS2WHGYNNwbcv8QvYYq8QLC3',
        base_volume: '134.6297193145',
        counter_volume: '9221.213658',
        count: 2,
      });
      // rwmUa… sold twice: 49.99600000000001 + 0.00399999999999 USD (the original's floats added up to 50.00000000000001),
      // 3408.043626 + 0.272665 XRP
      expect(res.body.accounts.find((a) => a.account === 'rwmUaXsWtXU4Z843xSYwgt1is97bgY8yj6')).toEqual({
        buy: { base_volume: '0', counter_volume: '0', count: 0 },
        sell: { base_volume: '50', counter_volume: '3408.316291', count: 2 },
        account: 'rwmUaXsWtXU4Z843xSYwgt1is97bgY8yj6',
        base_volume: '50',
        counter_volume: '3408.316291',
        count: 2,
      });
      expect(res.body.accounts.map((a) => a.base_volume)).toEqual([
        '134.6297193145',
        '124.7435370355',
        '50',
        '49.99600000000001',
        '22.14061005922957',
        '22.13661005922958',
        '9.886182279',
      ]);
      expect(res.body.exchanges_count).toBe(5);
      expect(text(Object.keys(res.body))).toBe(text(['result', 'count', 'exchanges_count', 'accounts']));
    });

    it('the keys of an account come in the order of the original, and the volumes are strings', async () => {
      const res = await accountsOf(api, `${PAIR}${WINDOW}`);
      for (const a of res.body.accounts) {
        expect(Object.keys(a)).toEqual(['buy', 'sell', 'account', 'base_volume', 'counter_volume', 'count']);
        for (const s of [a.buy, a.sell]) {
          expect(Object.keys(s)).toEqual(['base_volume', 'counter_volume', 'count']);
          expect([typeof s.base_volume, typeof s.counter_volume, typeof s.count]).toEqual([
            'string',
            'string',
            'number',
          ]);
        }
        expect(a.count).toBe(a.buy.count + a.sell.count);
      }
    });

    it('inverted pair swaps buy/sell volumes', async () => {
      const straight = (await accountsOf(api, `${PAIR}${WINDOW}`)).body;
      const inverted = (await accountsOf(api, `${active('xrp', USD_MWJ)}${WINDOW}`)).body;
      expect(inverted.exchanges_count).toBe(straight.exchanges_count);
      expect(inverted.count).toBe(straight.count);
      const byAccount = new Map(straight.accounts.map((a) => [a.account, a]));
      for (const a of inverted.accounts) {
        const s = byAccount.get(a.account) as AccountBody;
        // what was bought of USD was sold for XRP: the sides swap, and so do the currencies of the volumes
        expect(a.buy).toEqual({
          base_volume: s.sell.counter_volume,
          counter_volume: s.sell.base_volume,
          count: s.sell.count,
        });
        expect(a.sell).toEqual({
          base_volume: s.buy.counter_volume,
          counter_volume: s.buy.base_volume,
          count: s.buy.count,
        });
        expect([a.base_volume, a.counter_volume, a.count]).toEqual([s.counter_volume, s.base_volume, s.count]);
      }
      // the seller of two (50 USD for 3408.316291 XRP) is the buyer of the XRP
      expect(inverted.accounts.find((a) => a.account === 'rwmUaXsWtXU4Z843xSYwgt1is97bgY8yj6')).toEqual({
        buy: { base_volume: '3408.316291', counter_volume: '50', count: 2 },
        sell: { base_volume: '0', counter_volume: '0', count: 0 },
        account: 'rwmUaXsWtXU4Z843xSYwgt1is97bgY8yj6',
        base_volume: '3408.316291',
        counter_volume: '50',
        count: 2,
      });
      // sorted by the XRP now: rUZjA… sold 9221.213658 XRP worth
      expect(inverted.accounts[0].account).toBe('rUZjAUwatwbS2WHGYNNwbcv8QvYYq8QLC3');
      expect(inverted.accounts[0].sell).toEqual({
        base_volume: '9221.213658',
        counter_volume: '134.6297193145',
        count: 2,
      });
    });

    it('every pair of the mock ledgers, both ways round, in two windows, is what the original made of its exchanges', async () => {
      let accounts = 0;
      let windows = 0;
      for (const window of WINDOWS) {
        for (const market of MARKETS) {
          const rows = closedBetween(market.rows, window.from, window.before);
          if (rows.length === 0) continue;
          windows++;
          for (const inverted of [false, true]) {
            const [b, c] = inverted ? [market.counter, market.base] : [market.base, market.counter];
            const path = `${active(pathOf(b), pathOf(c))}${qs(window.query)}`;
            const res = await accountsOf(api, path);
            const want = { result: 'success', ...expectedBody(rows, inverted) };
            expect([path, text(res.body)]).toEqual([path, text(want)]);
            accounts += res.body.count;
          }
        }
      }
      // the 2015 window holds 31 pairs (all but USD+rhub8…/XRP), the 2016 one 2 (USD+rvYAf…/XRP and USD+rhub8…/XRP)
      expect(windows).toBe(33);
      expect(accounts).toBeGreaterThan(100);
    });

    it('the same with include_exchanges: the exchanges of every account, in the order they were scanned', async () => {
      let exchanges = 0;
      for (const window of WINDOWS) {
        for (const market of MARKETS) {
          const rows = closedBetween(market.rows, window.from, window.before);
          if (rows.length === 0) continue;
          for (const inverted of [false, true]) {
            const [b, c] = inverted ? [market.counter, market.base] : [market.base, market.counter];
            const path = `${active(pathOf(b), pathOf(c))}${qs({ ...window.query, include_exchanges: true })}`;
            const res = await accountsOf(api, path);
            const want = { result: 'success', ...expectedBody(rows, inverted, true) };
            expect([path, text(res.body)]).toEqual([path, text(want)]);
            exchanges += res.body.accounts.reduce((n, a) => n + (a.exchanges?.length ?? 0), 0);
          }
        }
      }
      // every exchange is in the lists of its seller and of its buyer
      expect(exchanges).toBe(2 * 2 * 158);
    });

    it('include_exchanges: an exchange has no pair fields, the time has milliseconds, a rate eight digits', async () => {
      const res = await accountsOf(api, `${PAIR}${WINDOW}&include_exchanges=true`);
      const first = USD_XRP.rows[0];
      const mine = res.body.accounts.find((a) => a.account === first.seller) as AccountBody;
      expect(mine.exchanges?.[0]).toEqual(exchangeOf(first, false));
      expect(Object.keys(mine.exchanges?.[0] ?? {})).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
      ]);
      expect(mine.exchanges?.[0].executed_time).toBe('2015-01-14T18:27:20.000Z');
      // the exchange of two accounts is the same exchange in the list of each
      const buyer = res.body.accounts.find((a) => a.account === first.buyer) as AccountBody;
      expect(buyer.exchanges?.find((e) => e.tx_hash === first.tx_hash)).toEqual(mine.exchanges?.[0]);
    });

    it('include_exchanges asked the other way round inverts the exchanges: amounts, buyer, seller and rate', async () => {
      const res = await accountsOf(api, `${active('xrp', USD_MWJ)}${WINDOW}&include_exchanges=true`);
      const first = USD_XRP.rows[0];
      const mine = res.body.accounts.find((a) => a.account === first.buyer) as AccountBody;
      const exchange = mine.exchanges?.[0] as Record<string, unknown>;
      expect(exchange).toEqual(exchangeOf(first, true));
      expect(exchange).toMatchObject({
        base_amount: first.counter_amount,
        counter_amount: first.base_amount,
        buyer: first.seller,
        seller: first.buyer,
      });
    });

    it('include_exchanges: the client of the transaction is kept (getExchanges.js deletes it, this route does not)', async () => {
      // the three exchanges of the mock ledgers with a client
      const withClient = MARKETS.flatMap((m) => m.rows.filter((r) => r.client !== null));
      expect(withClient.map((r) => [r.base_currency, r.ledger_index, r.client])).toEqual([
        ['CNY', 11119618, 'rt1.2.1'],
        ['BTC', 11120176, 'rt1.2.1'],
        ['USD', 20005122, 'rt1.5.6-12-g1b8c0ed'],
      ]);
      const keys = [
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'client',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
      ];
      const found: unknown[] = [];
      for (const row of withClient) {
        const window = WINDOWS.find(
          (w) => closedBetween([row], w.from, w.before).length > 0,
        ) as (typeof WINDOWS)[number];
        for (const inverted of [false, true]) {
          const [b, c] = inverted
            ? [assetOf(row.counter_currency, row.counter_issuer), assetOf(row.base_currency, row.base_issuer)]
            : [assetOf(row.base_currency, row.base_issuer), assetOf(row.counter_currency, row.counter_issuer)];
          const path = `${active(pathOf(b), pathOf(c))}${qs({ ...window.query, include_exchanges: true })}`;
          const res = await accountsOf(api, path);
          const all = res.body.accounts.flatMap((a) => a.exchanges ?? []);
          const mine = all.filter((e) => e.tx_hash === row.tx_hash);
          // in the list of its seller and of its buyer, the same either way round
          expect([path, mine.length]).toEqual([path, 2]);
          for (const e of mine) {
            expect(Object.keys(e)).toEqual(keys);
            expect(e.client).toBe(row.client);
          }
          expect(mine[0]).toEqual(exchangeOf(row, inverted));
          // the others of the window have none, and no key for it
          expect(all.filter((e) => e.tx_hash !== row.tx_hash).some((e) => 'client' in e)).toBe(false);
          found.push([row.ledger_index, inverted, mine[0].client]);
        }
      }
      expect(found).toEqual([
        [11119618, false, 'rt1.2.1'],
        [11119618, true, 'rt1.2.1'],
        [11120176, false, 'rt1.2.1'],
        [11120176, true, 'rt1.2.1'],
        [20005122, false, 'rt1.5.6-12-g1b8c0ed'],
        [20005122, true, 'rt1.5.6-12-g1b8c0ed'],
      ]);
    });

    it('USD+rvYAf…/XRP on 2016-03-28: the exchange of ledger 20005122 has its client', async () => {
      for (const [base, counter] of [
        [`USD+${BITSTAMP}`, 'xrp'],
        ['xrp', `USD+${BITSTAMP}`],
      ]) {
        const res = await accountsOf(
          api,
          `${active(base, counter)}?date=2016-03-28&period=1day&include_exchanges=true`,
        );
        const exchanges = res.body.accounts
          .flatMap((a) => a.exchanges ?? [])
          .filter((e) => e.ledger_index === 20005122);
        expect([base, exchanges.map((e) => e.client)]).toEqual([base, ['rt1.5.6-12-g1b8c0ed', 'rt1.5.6-12-g1b8c0ed']]);
      }
    });

    it('include_exchanges is any text that is not empty, even false or 0', async () => {
      for (const value of ['true', 'false', '0', 'x']) {
        const res = await accountsOf(api, `${PAIR}${WINDOW}&include_exchanges=${value}`);
        expect([value, res.body.accounts.every((a) => Array.isArray(a.exchanges))]).toEqual([value, true]);
      }
      for (const query of ['&include_exchanges=', '']) {
        const res = await accountsOf(api, `${PAIR}${WINDOW}${query}`);
        expect([query, res.body.accounts.some((a) => 'exchanges' in a)]).toEqual([query, false]);
      }
    });

    it('a pair without an exchange in the window, or none at all, has no account', async () => {
      const none = { result: 'success', count: 0, exchanges_count: 0, accounts: [] };
      expect((await api.ok(`${PAIR}?date=2030-01-01&period=7day`, 'accounts')).body).toEqual(none);
      expect(
        (await api.ok(`${active(`USD+${BITSTAMP}`, 'xrp')}?date=2015-01-20&period=1day`, 'accounts')).body,
      ).toEqual(none);
      expect((await api.ok(`${active('GBP+' + MWJ, 'xrp')}?date=2015-01-14`, 'accounts')).body).toEqual(none);
      expect((await api.ok(`${PAIR}?date=2030-01-01&include_exchanges=true`, 'accounts')).body).toEqual(none);
    });

    it('the currency may be in any case, the issuer is as written; "+", "|" and "." split a pair', async () => {
      const want = text((await accountsOf(api, `${PAIR}${WINDOW}`)).body);
      for (const [b, c] of [
        [`usd+${MWJ}`, 'XRP'],
        [`USD.${MWJ}`, 'xrp'],
        [`USD|${MWJ}`, 'Xrp'],
      ]) {
        expect([b, text((await api.ok(`${active(b, c)}${WINDOW}`, 'accounts')).body)]).toEqual([b, want]);
      }
    });

    it('unknown parameters are ignored, a repeated one is read by its first value', async () => {
      const want = text((await accountsOf(api, `${PAIR}${WINDOW}`)).body);
      // the route has no pages: limit, marker and descending are unknown to it
      expect(text((await api.ok(`${PAIR}${WINDOW}&foo=bar&limit=1&marker=x&descending=true`, 'accounts')).body)).toBe(
        want,
      );
      expect(text((await api.ok(`${PAIR}${WINDOW}&period=7day&period=bogus`, 'accounts')).body)).toBe(want);
      expect(text((await api.ok(`${PAIR}?date=2015-01-14&date=bogus&period=7day`, 'accounts')).body)).toBe(want);
    });

    it('needs the API key', async () => {
      expect((await h.http().get(`${PAIR}${WINDOW}`)).status).toBe(401);
    });
  });

  // -- the checks ------------------------------------------------------------------------------------------------------

  describe('the checks come in the order of the original', () => {
    const error = async (path: string, message: string, status = 400): Promise<void> => {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, status, { result: 'error', message }]);
    };

    it('currencies, then XRP with an issuer, then a missing issuer, the addresses, the period, the date', async () => {
      const bad = '?period=1234&date=zzzz';
      await error(`/v2/active_accounts/+${MWJ}/+${MWJ}${bad}`, 'base currency is required');
      await error(`/v2/active_accounts/USD+${MWJ}/+${MWJ}${bad}`, 'counter currency is required');
      // both sides wrong: the native currency with an issuer comes before a missing issuer, whichever side
      await error(`/v2/active_accounts/USD/XRP+${MWJ}${bad}`, 'XRP cannot have an issuer');
      await error(`/v2/active_accounts/XRP+${MWJ}/USD${bad}`, 'XRP cannot have an issuer');
      await error(`/v2/active_accounts/USD/EUR${bad}`, 'base issuer is required');
      await error(`/v2/active_accounts/USD+${MWJ}/EUR${bad}`, 'counter issuer is required');
      // the issuers are addresses (ruling R33), after the above and before the period
      await error(`/v2/active_accounts/USD+zzz/XRP${bad}`, 'invalid base issuer address');
      await error(`/v2/active_accounts/USD+${MWJ}/EUR+zzz${bad}`, 'invalid counter issuer address');
      await error(`/v2/active_accounts/USD+${MWJ}/XRP${bad}`, 'invalid period - use: 1day, 3day, 7day');
      await error(`/v2/active_accounts/USD+${MWJ}/XRP?date=zzzz`, 'invalid date format');
    });

    it('the period is one of 1day, 3day and 7day, written so', async () => {
      const path = `/v2/active_accounts/USD+${MWJ}/XRP`;
      for (const period of ['1DAY', '2day', '1 day', '1', 'day', '30day', '1days', '07day', 'null']) {
        await error(`${path}${qs({ period })}`, 'invalid period - use: 1day, 3day, 7day');
      }
      for (const period of ['1day', '3day', '7day', '']) {
        expect([period, (await get(`${path}${qs({ period })}`)).status]).toEqual([period, 200]);
      }
    });

    it('a date that is not a date is 400, whatever the period; an empty one is no date', async () => {
      const path = `/v2/active_accounts/USD+${MWJ}/XRP`;
      for (const date of ['zzzz', '2015-13-01', '2015-02-30', '2015/01/14', '14-01-2015', 'yesterday', '1e9', '123']) {
        await error(`${path}${qs({ date })}`, 'invalid date format');
      }
      // the original failed on an empty date with a 500 (no end for the scan); it counts as none, as its own check did
      expect((await get(`${path}?date=`)).status).toBe(200);
    });

    it('a request the client got wrong reads nothing', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      for (const path of [
        '/v2/active_accounts/USD/XRP',
        `/v2/active_accounts/USD+${MWJ}/XRP?period=2day`,
        `/v2/active_accounts/USD+${MWJ}/XRP?date=zzzz`,
        '/v2/active_accounts/USD+nonsense/XRP',
      ]) {
        expect((await get(path)).status).toBe(400);
      }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -- CSV ------------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (t: string): string[] => t.split('\n');
    const PAIR = active(USD_MWJ, 'xrp');
    const WINDOW = 'date=2015-01-14&period=7day';
    const BASE_COLUMNS = [
      'buy.base_volume',
      'buy.counter_volume',
      'buy.count',
      'sell.base_volume',
      'sell.counter_volume',
      'sell.count',
      'account',
      'base_volume',
      'counter_volume',
      'count',
    ];

    it('CSV works', async () => {
      const res = await get(`${PAIR}?${WINDOW}&format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('active_accounts'));
      const rows = lines(res.text);
      const accounts = oracle(USD_XRP.rows, false);
      expect(rows).toHaveLength(1 + 7);
      // the nested objects are flattened, as `utils.flattenJSON` of the original did, and every cell is quoted
      expect(rows[0]).toBe(BASE_COLUMNS.map((c) => `"${c}"`).join(','));
      const a = accounts[0];
      expect(rows[1]).toBe(
        [
          a.buy.base_volume,
          a.buy.counter_volume,
          a.buy.count,
          a.sell.base_volume,
          a.sell.counter_volume,
          a.sell.count,
          a.account,
          a.base_volume,
          a.counter_volume,
          a.count,
        ]
          .map((c) => `"${c}"`)
          .join(','),
      );
    });

    it('the rows are the accounts of the JSON, in the same order, whichever way the pair is asked', async () => {
      for (const pair of [PAIR, active('xrp', USD_MWJ)]) {
        const json = (await accountsOf(api, `${pair}?${WINDOW}`)).body;
        const csv = lines((await get(`${pair}?${WINDOW}&format=csv`)).text);
        expect(csv.slice(1).map((row) => row.split(',')[6])).toEqual(json.accounts.map((a) => `"${a.account}"`));
        expect(csv.slice(1).map((row) => row.split(',')[7])).toEqual(json.accounts.map((a) => `"${a.base_volume}"`));
      }
    });

    it('with include_exchanges the exchanges are columns too: exchanges[0].base_amount, ...', async () => {
      const res = await get(`${PAIR}?${WINDOW}&include_exchanges=true&format=csv`);
      expect(res.status).toBe(200);
      const header = lines(res.text)[0].split(',');
      expect(header.slice(0, 10)).toEqual(BASE_COLUMNS.map((c) => `"${c}"`));
      expect(header.slice(10, 24)).toEqual(
        [
          'base_amount',
          'counter_amount',
          'node_index',
          'rate',
          'tx_index',
          'buyer',
          'executed_time',
          'ledger_index',
          'offer_sequence',
          'provider',
          'seller',
          'taker',
          'tx_hash',
          'tx_type',
        ].map((c) => `"exchanges[0].${c}"`),
      );
      // the account of two exchanges has a second set of columns
      expect(header).toContain('"exchanges[1].tx_hash"');
      expect(header).not.toContain('"exchanges[0].base_currency"');
      expect(lines(res.text)).toHaveLength(1 + 7);
    });

    it('with include_exchanges the client of an exchange is a column too: exchanges[i].client', async () => {
      // CNY+rKiCet…/XRP has one exchange with a client (ledger 11119618)
      const pair = active(`CNY+${KIC}`, 'xrp');
      const json = (await accountsOf(api, `${pair}?${WINDOW}&include_exchanges=true`)).body;
      const csv = lines((await get(`${pair}?${WINDOW}&include_exchanges=true&format=csv`)).text);
      const header = csv[0].split(',');
      // a CSV has a column for every key found in any row, in the order of first appearance: the column of the client
      // of an exchange comes where the first row that has one puts it, and is empty in the rows that have none
      let withClient = 0;
      json.accounts.forEach((account, row) => {
        const cells = csv[1 + row].split(',');
        (account.exchanges ?? []).forEach((e, i) => {
          const column = header.indexOf(`"exchanges[${i}].client"`);
          const cell = column < 0 ? '""' : cells[column];
          expect([account.account, i, cell]).toEqual([account.account, i, `"${e.client ?? ''}"`]);
          if (e.client !== undefined) withClient++;
        });
      });
      // the exchange is in the list of its seller and of its buyer
      expect(withClient).toBe(2);
      expect(header.filter((c) => /^"exchanges\[\d+\]\.client"$/.test(c)).length).toBeGreaterThan(0);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`${PAIR}?${WINDOW}&format=CSV`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`${PAIR}?${WINDOW}&format=${format}`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('an empty window is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`${PAIR}?date=2030-01-01&format=csv`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/active_accounts/USD/XRP?format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'base issuer is required' });
    });
  });

  // -- failures ------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    const path = `${active(USD_MWJ, 'xrp')}?date=2015-01-14&period=7day`;

    it('is 500 unable to retrieve exchanges (the original never answered)', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(path);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message: 'unable to retrieve exchanges' }]);
    });

    it('also when the accounts fail after the ledgers were found, and when the exchanges of include_exchanges fail', async () => {
      const real = h.ch.query.bind(h.ch);
      // the nth read of `exchanges` fails; the lookup of the ledgers (it may be cached) is not counted
      for (const [url, nth] of [
        [path, 1],
        [`${path}&include_exchanges=true`, 2],
        [`${path}&format=csv`, 1],
      ] as const) {
        let reads = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) => {
          if (/FROM exchanges\b/.test(sql) && ++reads === nth) return Promise.reject(new Error('boom'));
          return (real as (...a: unknown[]) => Promise<unknown>)(sql, ...rest);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any);
        const res = await get(url);
        expect([url, reads, res.status, res.body]).toEqual([
          url,
          nth,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- the SQL -----------------------------------------------------------------------------------------------------

  describe('the SQL', () => {
    const path = `${active('xrp', USD_MWJ)}?date=2015-01-14&period=7day`;
    const readsOfExchanges = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls.filter(([sql]: [string]) => /FROM exchanges\b/.test(sql));

    it('one query for the accounts, a second for the exchanges only when they are asked for', async () => {
      let spy = jest.spyOn(h.ch, 'query');
      await get(path);
      expect(readsOfExchanges(spy)).toHaveLength(1);
      jest.restoreAllMocks();
      spy = jest.spyOn(h.ch, 'query');
      await get(`${path}&include_exchanges=true`);
      expect(readsOfExchanges(spy)).toHaveLength(2);
    });

    it('reads the pair as a range of the primary key, each exchange once, with every value bound', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`${path}&include_exchanges=true`);
      expect(readsOfExchanges(spy)).toHaveLength(2);
      for (const [sql, params] of readsOfExchanges(spy)) {
        expect(sql).toMatch(/base_currency = \{pair0:String\}/);
        expect(sql).toMatch(/counter_issuer = \{pair3:String\}/);
        expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
        // the tables are not collapsed before a merge and no FINAL is used: a row written twice counts once
        expect(sql).toContain(
          'LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index',
        );
        expect(sql).toContain(
          'ORDER BY base_currency ASC, base_issuer ASC, counter_currency ASC, counter_issuer ASC, ledger_index ASC, tx_index ASC, node_index ASC',
        );
        expect(sql).not.toMatch(/\bFINAL\b/);
        // the pair is read as it is stored: USD+rMwj… first, whichever way it was asked for
        expect([params.pair0, params.pair1, params.pair2, params.pair3]).toEqual(['USD', MWJ, 'XRP', '']);
        expect(sql).not.toContain(MWJ);
      }
    });

    it('reads the table in the order of its primary key, so that no window sorts a pair', async () => {
      for (const query of ['', '&include_exchanges=true', '&date=2016-03-28&period=1day']) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`${active(USD_MWJ, 'xrp')}?date=2015-01-14&period=7day${query}`);
        expect(res.status).toBe(200);
        const reads = readsOfExchanges(spy);
        jest.restoreAllMocks();
        for (const [sql, params] of reads) {
          const plan = await h.ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${sql}`, params);
          const pipeline = plan.map((r) => r.explain).join('\n');
          expect([query, pipeline]).toEqual([query, expect.stringContaining('ReadPoolInOrder')]);
          expect(pipeline).not.toContain('PartialSortingTransform');

          const indexes = await h.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params);
          const keys = indexes.map((r) => r.explain).join('\n');
          expect(keys).toContain('PrimaryKey');
          expect(keys).toMatch(
            /Keys:\s+base_currency\s+base_issuer\s+counter_currency\s+counter_issuer\s+ledger_index/,
          );
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Every exchange written twice
// ---------------------------------------------------------------------------------------------------------------------

describe('active accounts when every exchange was written twice', () => {
  // `exchanges` is a ReplacingMergeTree and the accounts never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about). One insert of a row twice would be collapsed by ClickHouse on the
  // way in (`optimize_on_insert`), so the copy is a second insert, without deduplication, with the merges stopped.
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const count = async (): Promise<number> =>
      Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Exchanges}`))[0].n);
    const once = await count();
    expect(once).toBe(158);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    // the table really holds every exchange twice
    expect(await count()).toBe(2 * once);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every pair, both ways round, has its accounts counted once: 5 exchanges are not 10', async () => {
    let checked = 0;
    for (const window of WINDOWS) {
      for (const market of MARKETS) {
        const rows = closedBetween(market.rows, window.from, window.before);
        if (rows.length === 0) continue;
        for (const inverted of [false, true]) {
          const [b, c] = inverted ? [market.counter, market.base] : [market.base, market.counter];
          for (const withExchanges of [false, true]) {
            const path = `${active(pathOf(b), pathOf(c))}${qs({ ...window.query, ...(withExchanges && { include_exchanges: true }) })}`;
            const res = await accountsOf(api, path);
            expect([path, text(res.body)]).toEqual([
              path,
              text({ result: 'success', ...expectedBody(rows, inverted, withExchanges) }),
            ]);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(33 * 2 * 2);
  });

  it('USD+rMwj…/XRP: 5 exchanges, 10 counts, not 20', async () => {
    const res = await accountsOf(api, `${active(USD_MWJ, 'xrp')}?date=2015-01-14&period=7day`);
    expect(res.body.exchanges_count).toBe(5);
    expect(res.body.accounts.reduce((n, a) => n + a.count, 0)).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Swaps against AMM pools
// ---------------------------------------------------------------------------------------------------------------------

describe('active accounts count the swaps against AMM pools', () => {
  // A swap against a pool is an exchange, between its taker and the pool: both are active accounts of the pair, and the
  // route has no parameter to leave swaps out. The oracle is the one of the mock ledgers, run on the recorded AMM ledgers
  // (138 swaps and 39 order-book exchanges, 2025 and 2026).
  const isSwap = (r: ExchangesRow): boolean => r.amm_account !== '';
  const markets = marketsOf(fixtureExchanges('xrpl-amm'));
  const withSwaps = markets.filter((m) => m.rows.some(isSwap));
  const DAY_S = 86_400;
  /** `YYYY-MM-DD` of the UTC day of a close time. */
  const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
  const plusDays = (day: string, n: number): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_S * 1000).toISOString().slice(0, 19);
  /** The windows to ask a pair for: each day on which it has a swap, with `period=1day` (`date` to the end of the next day). */
  const windowsOf = (m: Market): { day: string; rows: ExchangesRow[] }[] =>
    [...new Set(m.rows.filter(isSwap).map((r) => dayOf(r.close_time)))].sort().map((day) => ({
      day,
      rows: closedBetween(m.rows, `${day}T00:00:00`, plusDays(day, 2)),
    }));

  let h: Harness;
  let api: ApiClient;
  const get = (p: string) => api.get(p);
  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the data is as the tests assume', () => {
    expect(withSwaps.length).toBeGreaterThan(50);
    expect(withSwaps.flatMap((m) => m.rows).filter(isSwap)).toHaveLength(138);
    expect(withSwaps.some((m) => m.rows.some((r) => !isSwap(r)))).toBe(true);
  });

  it('every pair that has a swap, both ways round, on each day it has one: the accounts of all its exchanges', async () => {
    let windows = 0;
    let poolsListed = 0;
    for (const m of withSwaps) {
      for (const { day, rows } of windowsOf(m)) {
        windows++;
        for (const inverted of [false, true]) {
          const [b, c] = inverted ? [m.counter, m.base] : [m.base, m.counter];
          const path = `${active(pathOf(b), pathOf(c))}${qs({ date: day, period: '1day' })}`;
          const res = await accountsOf(api, path);
          expect([path, text(res.body)]).toEqual([path, text({ result: 'success', ...expectedBody(rows, inverted) })]);
          // the pools are accounts of the pair, with their own volumes
          for (const pool of new Set(rows.filter(isSwap).map((r) => r.amm_account))) {
            expect([path, res.body.accounts.some((a) => a.account === pool)]).toEqual([path, true]);
            poolsListed++;
          }
        }
      }
    }
    expect(windows).toBeGreaterThan(50);
    expect(poolsListed).toBeGreaterThan(100);
  });

  it('the swaps change the answer for a pair that has order-book exchanges too', async () => {
    const m = [...withSwaps]
      .filter((x) => x.rows.some((r) => !isSwap(r)))
      .sort((a, b) => b.rows.length - a.rows.length)[0];
    const { day, rows } = windowsOf(m).sort((a, b) => b.rows.length - a.rows.length)[0];
    expect(rows.some(isSwap) && rows.some((r) => !isSwap(r))).toBe(true);
    const res = await accountsOf(api, `${active(pathOf(m.base), pathOf(m.counter))}?date=${day}&period=1day`);
    expect(res.body.exchanges_count).toBe(rows.length);
    expect(res.body.exchanges_count).toBeGreaterThan(rows.filter((r) => !isSwap(r)).length);
    const bookOnly = expectedBody(
      rows.filter((r) => !isSwap(r)),
      false,
    );
    expect(text(res.body.accounts)).not.toBe(text(bookOnly.accounts));
  });

  it('include_exchanges: the exchanges of the accounts are the exchanges of the API, a swap with amm_account last', async () => {
    let swaps = 0;
    for (const m of withSwaps) {
      for (const { day, rows } of windowsOf(m)) {
        for (const inverted of [false, true]) {
          const [b, c] = inverted ? [m.counter, m.base] : [m.base, m.counter];
          const path = `${active(pathOf(b), pathOf(c))}${qs({ date: day, period: '1day', include_exchanges: true })}`;
          const res = await accountsOf(api, path);
          expect([path, text(res.body)]).toEqual([
            path,
            text({ result: 'success', ...expectedBody(rows, inverted, true) }),
          ]);
          for (const a of res.body.accounts) {
            for (const ex of a.exchanges ?? []) {
              const keys = Object.keys(ex);
              expect([path, keys.at(-1) === 'amm_account', keys.includes('amm_account')]).toEqual([
                path,
                ex.amm_account !== undefined,
                ex.amm_account !== undefined,
              ]);
              if (ex.amm_account !== undefined) swaps++;
            }
          }
        }
      }
    }
    // each swap is in the list of its seller and of its buyer
    expect(swaps).toBeGreaterThan(300);
  });

  it('CSV: the swaps are rows of the accounts, with the pool as a column of their exchanges', async () => {
    const m = [...withSwaps].sort((a, b) => b.rows.length - a.rows.length)[0];
    const { day, rows } = windowsOf(m)[0];
    const res = await get(`${active(pathOf(m.base), pathOf(m.counter))}?date=${day}&period=1day&format=csv`);
    expect(res.status).toBe(200);
    expect(res.text.split('\n')).toHaveLength(1 + expectedBody(rows, false).count);
    const withExchanges = await get(
      `${active(pathOf(m.base), pathOf(m.counter))}?date=${day}&period=1day&include_exchanges=true&format=csv`,
    );
    expect(withExchanges.text.split('\n')[0]).toContain('"exchanges[0].amm_account"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic ledgers, on both networks
// ---------------------------------------------------------------------------------------------------------------------

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

/** A trade of `CUR+ISSUER` against the native currency (the canonical order of such a pair: 'cur…' sorts first). */
interface Trade {
  cur: string;
  /** Unix seconds. */
  close: number;
  buyer: string;
  seller: string;
  base: string;
  counter: string;
  /** Trades with the same `ledger` are in one ledger (they must have the same `close`). */
  ledger?: string;
  tx?: number;
  node?: number;
}

const trade = (
  cur: string,
  at: string | number,
  buyer: string,
  seller: string,
  base = '10',
  counter = '20',
  extra: Partial<Trade> = {},
): Trade => ({ cur, close: typeof at === 'number' ? at : unix(at), buyer, seller, base, counter, ...extra });

/** A trade with its own buyer, `rBuyer<label>`: whether the buyer is in the answer tells whether the trade is. */
const labelled = (cur: string, at: string | number, label: string): Trade =>
  trade(cur, at, `rBuyer${label}`, 'rSeller');

/**
 * The windows. A `date` names a period (`smoment`'s granularity): the window runs from its start to the end of the
 * period that is `period` days after it, so `2020-06-10` with `1day` is `[2020-06-10, 2020-06-12)`.
 */
function windowTrades(): Trade[] {
  return [
    // WDY: date=2020-06-10 (a day), 1day: [2020-06-10T00:00:00, 2020-06-12T00:00:00)
    labelled('WDY', '2020-06-09T23:59:59', 'before'),
    labelled('WDY', '2020-06-10T00:00:00', 'start'),
    labelled('WDY', '2020-06-10T12:00:00', 'mid'),
    labelled('WDY', '2020-06-11T23:59:59', 'last'),
    labelled('WDY', '2020-06-12T00:00:00', 'after'),
    // WHR: date=2021-06-10T12 (an hour), 1day: [2021-06-10T12:00:00, 2021-06-11T13:00:00)
    labelled('WHR', '2021-06-10T11:59:59', 'before'),
    labelled('WHR', '2021-06-10T12:00:00', 'start'),
    labelled('WHR', '2021-06-11T12:59:59', 'last'),
    labelled('WHR', '2021-06-11T13:00:00', 'after'),
    // WSC: date=2022-06-10T12:00:00 (a second), 3day: [2022-06-10T12:00:00, 2022-06-13T12:00:01)
    labelled('WSC', '2022-06-10T11:59:59', 'before'),
    labelled('WSC', '2022-06-10T12:00:00', 'start'),
    labelled('WSC', '2022-06-13T12:00:00', 'last'),
    labelled('WSC', '2022-06-13T12:00:01', 'after'),
    // WMO: date=2023-06 (a month), 1day: [2023-06-01, 2023-07-02)
    labelled('WMO', '2023-05-31T23:59:59', 'before'),
    labelled('WMO', '2023-06-01T00:00:00', 'start'),
    labelled('WMO', '2023-07-01T23:59:59', 'last'),
    labelled('WMO', '2023-07-02T00:00:00', 'after'),
    // WYR: date=2024 (a year), 1day: [2024-01-01, 2025-01-02)
    labelled('WYR', '2023-12-31T23:59:59', 'before'),
    labelled('WYR', '2024-01-01T00:00:00', 'start'),
    labelled('WYR', '2025-01-01T23:59:59', 'last'),
    labelled('WYR', '2025-01-02T00:00:00', 'after'),
  ];
}

/** Trades round now, 10 minutes inside or outside the edges of 1, 3 and 7 days. */
function recentTrades(now: number): Trade[] {
  const day = 86_400;
  const slack = 600;
  return [
    labelled('REC', now + 3600, 'future'),
    labelled('REC', now - 30, 'recent'),
    labelled('REC', now - day + slack, 'd1'),
    labelled('REC', now - day - slack, 'd1out'),
    labelled('REC', now - 3 * day + slack, 'd3'),
    labelled('REC', now - 3 * day - slack, 'd3out'),
    labelled('REC', now - 7 * day + slack, 'd7'),
    labelled('REC', now - 7 * day - slack, 'd7out'),
  ];
}

const D = '2019-03-01';
/** The cases that are about the accounts, all on 2019-03-01. */
function accountTrades(): Trade[] {
  return [
    // TIE: every account has 10 of base, except rB1 who has 20: ties are told by who was met first
    trade('TIE', `${D}T10:00:00`, 'rB1', 'rS1', '10', '5', { ledger: 'l1', tx: 1 }),
    trade('TIE', `${D}T10:00:00`, 'rB2', 'rS2', '10', '7', { ledger: 'l1', tx: 2 }),
    trade('TIE', `${D}T10:05:00`, 'rB1', 'rS3', '10', '1'),
    // SLF: a trade of an account with itself, and one of it with rBob
    trade('SLF', `${D}T11:00:00`, 'rSelf', 'rSelf', '10', '4'),
    trade('SLF', `${D}T11:01:00`, 'rBob', 'rSelf', '3', '1.5'),
    // TNY: the native leg of 0.0005 and less is not left out here, as it is in the candles
    trade('TNY', `${D}T12:00:00`, 'rA', 'rB', '1', '0.0005'),
    trade('TNY', `${D}T12:01:00`, 'rA', 'rB', '2', '0.0001'),
    // UNF: amounts a decimal sum cannot hold whole (1e-35 has 35 places, 1e40 is over 1e36)
    trade('UNF', `${D}T12:10:00`, 'rA', 'rB', '1e-35', '2'),
    trade('UNF', `${D}T12:11:00`, 'rC', 'rD', '1e+40', '3'),
    // MIX: one account has both a tiny amount and ordinary ones
    trade('MIX', `${D}T12:20:00`, 'rA', 'rB', '1e-35', '2'),
    trade('MIX', `${D}T12:21:00`, 'rA', 'rC', '1.5', '3'),
    trade('MIX', `${D}T12:22:00`, 'rD', 'rA', '0.25', '1'),
  ];
}

interface World {
  ledgers: { ledger_index: number; ledger_hash: string; close_time: number }[];
  rows: ExchangesRow[];
}

/** The ledgers (in the order of their close times) and exchanges of a set of trades against `native`. */
function worldOf(trades: Trade[], native: string): World {
  const keyOf = (t: Trade, i: number): string => `${t.close}/${t.ledger ?? `#${i}`}`;
  const ledgerKeys = [
    ...new Set(
      trades
        .map((t, i) => [t.close, keyOf(t, i)] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, k]) => k),
    ),
  ];
  const ledgers = ledgerKeys.map((key, i) => ({
    ledger_index: 1000 + i,
    ledger_hash: `${i}`.padStart(64, 'C'),
    close_time: Number(key.split('/')[0]),
  }));
  const rows = trades.map((t, i): ExchangesRow => {
    const rate = new BigNumber(t.counter).dividedBy(t.base).toString();
    return {
      base_currency: t.cur,
      base_issuer: ISSUER,
      counter_currency: native,
      counter_issuer: '',
      ledger_index: 1000 + ledgerKeys.indexOf(keyOf(t, i)),
      tx_index: t.tx ?? 1,
      node_index: t.node ?? 1,
      tx_hash: `${i}`.padStart(64, 'A'),
      close_time: t.close,
      base_amount: t.base,
      counter_amount: t.counter,
      base_amount_f: Number(t.base),
      counter_amount_f: Number(t.counter),
      rate,
      rate_f: Number(rate),
      buyer: t.buyer,
      seller: t.seller,
      taker: t.seller,
      provider: t.buyer,
      offer_sequence: 7,
      amm_account: '',
      autobridged_currency: null,
      autobridged_issuer: null,
      tx_type: 'OfferCreate',
      client: null,
    };
  });
  return { ledgers, rows };
}

describe.each([
  ['xrpl', 'XRP'],
  ['xahau', 'XAH'],
] as const)('active accounts on synthetic ledgers (%s)', (network, NATIVE) => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let now: number;
  let world: World;

  const rowsOf = (cur: string): ExchangesRow[] => world.rows.filter((r) => r.base_currency === cur).sort(byKey);
  const pair = (cur: string, inverted = false): string =>
    inverted ? active(NATIVE, `${cur}+${ISSUER}`) : active(`${cur}+${ISSUER}`, NATIVE);
  /** The labels of the trades a window reads (`labelled`). */
  const labels = async (url: string): Promise<string[]> => {
    const res = await accountsOf(api, url);
    return res.body.accounts
      .map((a) => a.account)
      .filter((a) => a.startsWith('rBuyer'))
      .map((a) => a.slice('rBuyer'.length))
      .sort();
  };

  beforeAll(async () => {
    now = Math.floor(Date.now() / 1000);
    world = worldOf([...windowTrades(), ...recentTrades(now), ...accountTrades()], NATIVE);
    h = await startHarness({ network, seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.insert(Table.Ledgers, world.ledgers);
    await h.ch.insert(Table.Exchanges, world.rows);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- the window ------------------------------------------------------------------------------------------------

  describe('the window of a date', () => {
    it('a day: from the start of the date to the end of the day that is the period after it', async () => {
      // `smoment(date).add(1, 'day')` is the stop row of the scan: the whole of 2020-06-11 is in
      expect(await labels(`${pair('WDY')}?date=2020-06-10&period=1day`)).toEqual(['last', 'mid', 'start']);
      expect(await labels(`${pair('WDY')}?date=2020-06-10`)).toEqual(['last', 'mid', 'start']);
      expect(await labels(`${pair('WDY')}?date=2020-06-09&period=1day`)).toEqual(['before', 'mid', 'start']);
      expect(await labels(`${pair('WDY')}?date=2020-06-08&period=3day`)).toEqual(['before', 'last', 'mid', 'start']);
      expect(await labels(`${pair('WDY')}?date=2020-06-09&period=3day`)).toEqual([
        'after',
        'before',
        'last',
        'mid',
        'start',
      ]);
      expect(await labels(`${pair('WDY', true)}?date=2020-06-10&period=1day`)).toEqual(['last', 'mid', 'start']);
    });

    it('an hour: to the end of the hour that is the period after it', async () => {
      expect(await labels(`${pair('WHR')}?date=2021-06-10T12&period=1day`)).toEqual(['last', 'start']);
      expect(await labels(`${pair('WHR')}?date=2021-06-10T11&period=1day`)).toEqual(['before', 'start']);
    });

    it('a second, a unix time, a time with a zone: one second past the period', async () => {
      const second = unix('2022-06-10T12:00:00');
      for (const date of ['2022-06-10T12:00:00', '2022-06-10T12:00:00Z', '2022-06-10T14:00:00+02:00', String(second)]) {
        expect([date, await labels(`${pair('WSC')}${qs({ date, period: '3day' })}`)]).toEqual([
          date,
          ['last', 'start'],
        ]);
      }
      expect(await labels(`${pair('WSC')}?date=2022-06-10T11:59:59&period=3day`)).toEqual(['before', 'start']);
    });

    it('milliseconds are cut: the start is the second, and the second of the end is out', async () => {
      // the end is 2022-06-13T12:00:00.500 + 1 ms, read to the second like the keys of the scan: 12:00:00 is not before it
      expect(await labels(`${pair('WSC')}?date=2022-06-10T12:00:00.500Z&period=3day`)).toEqual(['start']);
    });

    it('a month and a year', async () => {
      expect(await labels(`${pair('WMO')}?date=2023-06&period=1day`)).toEqual(['last', 'start']);
      expect(await labels(`${pair('WYR')}?date=2024&period=1day`)).toEqual(['last', 'start']);
    });

    it('a date in the future reads nothing; the answer is no accounts, not an error', async () => {
      const res = await accountsOf(api, `${pair('WDY')}?date=2999-01-01`);
      expect(res.body).toEqual({ result: 'success', count: 0, exchanges_count: 0, accounts: [] });
    });
  });

  describe('without a date: the period before now', () => {
    it('1day by default; 3day and 7day reach further back; an exchange after now is not read', async () => {
      expect(await labels(`${pair('REC')}`)).toEqual(['d1', 'recent']);
      expect(await labels(`${pair('REC')}?period=1day`)).toEqual(['d1', 'recent']);
      expect(await labels(`${pair('REC')}?period=3day`)).toEqual(['d1', 'd1out', 'd3', 'recent']);
      expect(await labels(`${pair('REC')}?period=7day`)).toEqual(['d1', 'd1out', 'd3', 'd3out', 'd7', 'recent']);
      expect(await labels(`${pair('REC', true)}?period=7day`)).toEqual(['d1', 'd1out', 'd3', 'd3out', 'd7', 'recent']);
    });

    it('also with include_exchanges, and in CSV', async () => {
      const res = await accountsOf(api, `${pair('REC')}?period=3day&include_exchanges=true`);
      expect(res.body.exchanges_count).toBe(4);
      expect(res.body.accounts.reduce((n, a) => n + (a.exchanges?.length ?? 0), 0)).toBe(8);
      const csv = await get(`${pair('REC')}?period=3day&format=csv`);
      expect(csv.text.split('\n')).toHaveLength(1 + 5);
    });
  });

  // -- the accounts ------------------------------------------------------------------------------------------------

  describe('the accounts', () => {
    const W = `?date=${D}&period=1day`;

    it('equal volumes are told by who was met first: the seller before the buyer, in the order of the key', async () => {
      const res = await accountsOf(api, `${pair('TIE')}${W}`);
      // rB1 has two buys of 10; the rest have 10 each: rS1 and rB1 of the first exchange, rS2 and rB2 of the second, rS3
      expect(res.body.accounts.map((a) => a.account)).toEqual(['rB1', 'rS1', 'rS2', 'rB2', 'rS3']);
      expect(text(res.body)).toBe(text({ result: 'success', ...expectedBody(rowsOf('TIE'), false) }));
    });

    it('asked the other way round, the seller is the buyer, and the volumes are those of the counter', async () => {
      const res = await accountsOf(api, `${pair('TIE', true)}${W}`);
      // the volumes are XRP now: rB2 and rS2 have 7, rB1 has 5 + 1, rS1 5, rS3 1; the buyer is met first
      expect(res.body.accounts.map((a) => [a.account, a.base_volume])).toEqual([
        ['rB2', '7'],
        ['rS2', '7'],
        ['rB1', '6'],
        ['rS1', '5'],
        ['rS3', '1'],
      ]);
      expect(text(res.body)).toBe(text({ result: 'success', ...expectedBody(rowsOf('TIE'), true) }));
    });

    it('a trade of an account with itself counts on both sides: twice, as in the original', async () => {
      const res = await accountsOf(api, `${pair('SLF')}${W}&include_exchanges=true`);
      expect(res.body.exchanges_count).toBe(2);
      expect(res.body.accounts.map((a) => a.account)).toEqual(['rSelf', 'rBob']);
      const [self, bob] = res.body.accounts;
      expect({ ...self, exchanges: undefined }).toEqual({
        buy: { base_volume: '10', counter_volume: '4', count: 1 },
        sell: { base_volume: '13', counter_volume: '5.5', count: 2 },
        account: 'rSelf',
        base_volume: '23',
        counter_volume: '9.5',
        count: 3,
        exchanges: undefined,
      });
      expect(bob.count).toBe(1);
      // its own trade is twice in its list (once as the seller, once as the buyer), the other trade once
      expect(self.exchanges?.map((e) => e.tx_hash)).toEqual([
        rowsOf('SLF')[0].tx_hash,
        rowsOf('SLF')[0].tx_hash,
        rowsOf('SLF')[1].tx_hash,
      ]);
      expect(text(res.body)).toBe(text({ result: 'success', ...expectedBody(rowsOf('SLF'), false, true) }));
    });

    it('a native leg of 0.0005 or less is counted: the original did not leave it out of its scan', async () => {
      const res = await accountsOf(api, `${pair('TNY')}${W}`);
      expect(res.body.exchanges_count).toBe(2);
      expect(res.body.accounts.find((a) => a.account === 'rA')).toEqual({
        buy: { base_volume: '3', counter_volume: '0.0006', count: 2 },
        sell: { base_volume: '0', counter_volume: '0', count: 0 },
        account: 'rA',
        base_volume: '3',
        counter_volume: '0.0006',
        count: 2,
      });
      const inverted = await accountsOf(api, `${pair('TNY', true)}${W}`);
      // rA is the seller of the XRP now, and is met first
      expect(inverted.body.accounts[0]).toMatchObject({ account: 'rA', base_volume: '0.0006', counter_volume: '3' });
    });

    it('an amount the exact sum cannot hold is not summed as zero: 1e-35 and 1e40 are served as they are', async () => {
      const res = await accountsOf(api, `${pair('UNF')}${W}`);
      const byName = new Map(res.body.accounts.map((a) => [a.account, a]));
      expect(byName.get('rA')).toMatchObject({ base_volume: '1e-35', counter_volume: '2', count: 1 });
      expect(byName.get('rB')).toMatchObject({ base_volume: '1e-35', counter_volume: '2' });
      expect(byName.get('rC')).toMatchObject({ base_volume: '1e+40', counter_volume: '3' });
      expect(res.body.accounts[0].account).toMatch(/^r[CD]$/);
      // asked the other way round, the tiny amount is the counter volume
      const inverted = await accountsOf(api, `${pair('UNF', true)}${W}`);
      expect(inverted.body.accounts.find((a) => a.account === 'rA')).toMatchObject({
        base_volume: '2',
        counter_volume: '1e-35',
      });
    });

    it('one tiny amount makes the sums of its account floats, the account of ordinary ones stays exact', async () => {
      const res = await accountsOf(api, `${pair('MIX')}${W}`);
      const byName = new Map(res.body.accounts.map((a) => [a.account, a]));
      // rA: 1e-35 bought (unfit), 1.5 bought, 0.25 sold: the float sums
      expect(byName.get('rA')).toEqual({
        buy: { base_volume: '1.5', counter_volume: '5', count: 2 },
        sell: { base_volume: '0.25', counter_volume: '1', count: 1 },
        account: 'rA',
        base_volume: '1.75',
        counter_volume: '6',
        count: 3,
      });
      // rD bought 0.25 exactly
      expect(byName.get('rD')).toMatchObject({ base_volume: '0.25', counter_volume: '1' });
    });
  });

  // -- the pair ------------------------------------------------------------------------------------------------------

  describe('the pair', () => {
    it(`the native currency is ${NATIVE}: it cannot have an issuer, and the other one is an ordinary currency that needs one`, async () => {
      const native = await get(`/v2/active_accounts/${NATIVE}+${ISSUER}/USD+${ISSUER}`);
      expect([native.status, native.body]).toEqual([
        400,
        { result: 'error', message: `${NATIVE} cannot have an issuer` },
      ]);
      const other = NATIVE === 'XRP' ? 'XAH' : 'XRP';
      const issuerless = await get(`/v2/active_accounts/USD+${ISSUER}/${other}`);
      expect([issuerless.status, issuerless.body]).toEqual([
        400,
        { result: 'error', message: 'counter issuer is required' },
      ]);
      const issued = await get(`/v2/active_accounts/${other}+${ISSUER}/USD+${ISSUER}?date=2019-03-01`);
      expect([issued.status, issued.body.count]).toEqual([200, 0]);
    });

    it('the pair against the native currency, either way round', async () => {
      const straight = await accountsOf(api, `${pair('TIE')}?date=${D}`);
      const inverted = await accountsOf(api, `${pair('TIE', true)}?date=${D}`);
      expect([straight.body.exchanges_count, inverted.body.exchanges_count]).toEqual([3, 3]);
      expect(inverted.body.accounts[0].counter_volume).toBe(
        straight.body.accounts.find((a) => a.account === inverted.body.accounts[0].account)?.base_volume,
      );
    });

    it('format=csv is named active_accounts', async () => {
      const res = await get(`${pair('TIE')}?date=${D}&format=csv`);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('active_accounts'));
      expect(res.text.split('\n')).toHaveLength(1 + 5);
    });
  });
});

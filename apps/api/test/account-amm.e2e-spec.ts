import {
  AmmLiquidityRow,
  AmmPoolStatesRow,
  BalanceChangesRow,
  buildLedgerRows,
  getNetworkProfile,
  parseContextFor,
  Table,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, compare, defined, hashOf, iso, primaryKeys, qs, served } from './support/amm';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead, explain, innerRead, isPageRead } from './support/plans';
import {
  BULK_BASES,
  BULK_LEDGERS,
  BULK_TX_INDEX,
  bulkLedger,
  insertBulk,
  markerOf,
  readsOf,
} from './support/read-rows';

/**
 * The account routes of the AMM data on a real ClickHouse: `GET /v2/accounts/:address/amm_liquidity` (the liquidity events
 * of a provider, across pools) and `GET /v2/accounts/:address/amm_positions` (its LP-token balances, as shares of their
 * pools, at a date).
 *
 * Four kinds of data:
 *  - the recorded AMM ledgers (`xrpl-amm`: 8 liquidity events, and the LP-token lines of their providers in `balance_changes`),
 *    with an oracle in plain JavaScript over the rows the parser builds (`buildLedgerRows`) and over the raw metadata of the
 *    `lp_token_transfer` case, not from the code under test. The aggregator has NOT run;
 *  - rows made by hand for the cases the recordings do not hold: a filter that matches one row in seven, lines of every
 *    kind that is not a position, a pool deleted later, a supply of 0, a value that is only in a state far back, more pools
 *    than one batch of the fill-forward holds;
 *  - a bulk of four parts for the reads (`read_rows` and EXPLAIN, as `paged-reads.e2e-spec.ts`);
 *  - the Xahau ledgers (no AMM there).
 */

type Obj = Record<string, unknown>;
const lines = (text: string): string[] => text.split('\n');
const decodeMarker = (marker: string): unknown => JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
const cells = (line: string): string[] => line.split(',');

/** The pinned key order of the objects (written out here once more, apart from the code under test). */
const LIQUIDITY_KEYS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'executed_time',
  'account',
  'initiator',
  'event',
  'mode',
  'base_amount',
  'counter_amount',
  'lp_tokens',
];
const POSITION_KEYS = ['pool', 'lp_currency', 'lp_balance', 'share', 'base_amount', 'counter_amount'];

function expectOrdered(objects: Obj[], order: string[], label: unknown = ''): void {
  objects.forEach((object, i) => {
    const keys = Object.keys(object);
    expect([label, i, keys]).toEqual([label, i, order.filter((k) => keys.includes(k))]);
  });
}

const liquidityOf = (r: AmmLiquidityRow): Obj =>
  defined({
    amm_account: r.amm_account,
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    tx_hash: r.tx_hash,
    executed_time: iso(r.close_time),
    account: r.account,
    initiator: r.initiator,
    event: r.event,
    mode: r.mode === '' ? undefined : r.mode,
    base_amount: r.base_amount,
    counter_amount: r.counter_amount,
    lp_tokens: r.lp_tokens,
  });

/** A decimal as the API writes a share or an amount of a position: 30 significant digits, plain, trailing zeros dropped. */
const Wide = BigNumber.clone({ DECIMAL_PLACES: 300 });
const digits30 = (value: BigNumber): string => new BigNumber(value).precision(30).toFixed();

/** The position the spec describes: the share of the supply, and the same share of each reserve. */
function positionOf(
  pool: string,
  currency: string,
  balance: string,
  supply: string,
  reserveBase: string | null,
  reserveCounter: string | null,
): Obj {
  const lp = new Wide(balance);
  return defined({
    pool,
    lp_currency: currency,
    lp_balance: new BigNumber(balance).toFixed(),
    share: digits30(lp.dividedBy(supply)),
    base_amount: reserveBase === null ? undefined : digits30(lp.times(reserveBase).dividedBy(supply)),
    counter_amount: reserveCounter === null ? undefined : digits30(lp.times(reserveCounter).dividedBy(supply)),
  });
}

const byKey = (a: { ledger_index: number; tx_index: number }, b: { ledger_index: number; tx_index: number }): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

// =====================================================================================================================
// The oracle: the provider events, the LP-token lines and the pools of the recorded ledgers

const CONTEXT = parseContextFor(getNetworkProfile('xrpl'));
const BUILT = fixtureSource('xrpl-amm')
  .list()
  .map((ledger) => buildLedgerRows(ledger, CONTEXT));
const LIQUIDITY = BUILT.flatMap((b) => b.accountAmmLiquidity).sort(byKey);
const STATES = BUILT.flatMap((b) => b.ammPoolStates);
const BALANCES = BUILT.flatMap((b) => b.balanceChanges);
const LP_LINES = BALANCES.filter((c) => /^03[0-9A-F]{38}$/.test(c.currency));
const ROWS_OF = new Map<string, AmmPoolStatesRow[]>();
for (const row of STATES) ROWS_OF.set(row.amm_account, [...(ROWS_OF.get(row.amm_account) ?? []), row].sort(byKey));
/** The ledgers of the recordings and when they closed. */
const LEDGERS = BUILT.map((b) => ({ index: b.ledger.ledger_index, time: b.ledger.close_time })).sort(
  (a, b) => a.index - b.index,
);

/** The state of a pool at the end of a ledger: every column the newest non-null value of the rows up to it. */
function poolAt(pool: string, ledger: number): Obj | undefined {
  const rows = (ROWS_OF.get(pool) ?? []).filter((r) => r.ledger_index <= ledger);
  if (rows.length === 0) return undefined;
  const last = rows[rows.length - 1];
  const newest = <K extends keyof AmmPoolStatesRow>(k: K): AmmPoolStatesRow[K] | null =>
    [...rows].reverse().find((r) => r[k] !== null && r[k] !== undefined)?.[k] ?? null;
  return {
    lp_currency: newest('lp_currency'),
    lp_supply: newest('lp_supply'),
    reserve_base: newest('reserve_base'),
    reserve_counter: newest('reserve_counter'),
    deleted: last.deleted === 1,
  };
}

/** The positions of an account at a ledger, from the lines and the pools as the oracle has them. */
function positionsAt(account: string, ledger: number): Obj[] {
  const latest = new Map<string, BalanceChangesRow>();
  const mine = LP_LINES.filter((c) => c.account === account && c.ledger_index <= ledger).sort(
    (a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index,
  );
  for (const line of mine) latest.set(`${line.currency}|${line.counterparty}`, line);
  const out: Obj[] = [];
  for (const line of latest.values()) {
    const pool = poolAt(line.counterparty, ledger);
    if (pool === undefined || pool.deleted || pool.lp_currency !== line.currency) continue;
    if (
      new BigNumber(line.final_balance).isZero() ||
      pool.lp_supply === null ||
      new BigNumber(pool.lp_supply as string).isZero()
    ) {
      continue;
    }
    out.push(
      positionOf(
        line.counterparty,
        line.currency,
        line.final_balance,
        pool.lp_supply as string,
        pool.reserve_base as string | null,
        pool.reserve_counter as string | null,
      ),
    );
  }
  return out.sort((a, b) => compare(a.pool as string, b.pool as string));
}

/** The holders of an LP token in the recordings: the accounts of its lines that are no pool. */
const HOLDERS = [...new Set(LP_LINES.map((c) => c.account))].filter((a) => !ROWS_OF.has(a)).sort(compare);

interface PageBody {
  result: string;
  count: number;
  marker?: string;
  liquidity?: Obj[];
}

// =====================================================================================================================
describe('the account AMM routes over the recorded AMM ledgers', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);
  const head = LEDGERS[LEDGERS.length - 1].index;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: 8 provider events of 8 accounts, 11 LP-token lines of holders, pools that carry their LP currency', () => {
    expect(LIQUIDITY).toHaveLength(8);
    expect(new Set(LIQUIDITY.map((l) => l.account)).size).toBe(8);
    expect(HOLDERS.length).toBeGreaterThanOrEqual(10);
    expect([...ROWS_OF.keys()].filter((p) => poolAt(p, head)?.lp_currency != null).length).toBeGreaterThanOrEqual(8);
    expect(LEDGERS).toHaveLength(16);
  });

  // -- amm_liquidity ---------------------------------------------------------------------------------------------------

  describe('GET /v2/accounts/:address/amm_liquidity', () => {
    it('serves the events of every provider as the oracle has them, with the pool in each, in the pinned key order', async () => {
      for (const event of LIQUIDITY) {
        const res = await get(`/v2/accounts/${event.account}/amm_liquidity`);
        expect([event.account, res.status]).toEqual([event.account, 200]);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Object.keys(res.body)).toEqual(['result', 'count', 'liquidity']);
        expect(res.body.count).toBe(1);
        expect([event.account, res.body.liquidity]).toEqual([event.account, [liquidityOf(event)]]);
        expectOrdered(res.body.liquidity, LIQUIDITY_KEYS, event.account);
      }
    });

    it('is the same event as the list of the pool: the pool route and the account route agree', async () => {
      for (const event of LIQUIDITY) {
        const viaPool = (await get(`/v2/amm/pools/${event.amm_account}/liquidity?account=${event.account}`)).body
          .liquidity;
        const viaAccount = (await get(`/v2/accounts/${event.account}/amm_liquidity`)).body.liquidity;
        expect(viaAccount).toEqual(viaPool);
      }
    });

    it('is an empty list, not a 404, for an account with no events and for a text that is no address', async () => {
      for (const address of [accountAt(0xfeed), 'rnotanaddress', 'x']) {
        const res = await get(`/v2/accounts/${address}/amm_liquidity`);
        expect([address, res.status, res.body]).toEqual([address, 200, { result: 'success', count: 0, liquidity: [] }]);
      }
    });

    it('filters by pool, which must be an address (400 invalid pool) but need not be a pool that exists', async () => {
      const event = LIQUIDITY[0];
      const mine = (pool: string): Promise<Obj[]> =>
        get(`/v2/accounts/${event.account}/amm_liquidity?pool=${pool}`).then((r) => r.body.liquidity);
      expect(await mine(event.amm_account)).toEqual([liquidityOf(event)]);
      expect(await mine(LIQUIDITY[1].amm_account)).toEqual([]);
      expect(await mine(accountAt(0xdead))).toEqual([]);
      const empty = await get(`/v2/accounts/${event.account}/amm_liquidity?pool=`);
      expect(empty.body.liquidity).toEqual([liquidityOf(event)]);
      for (const pool of ['rnotanaddress', 'x', `${event.amm_account}x`]) {
        const res = await get(`/v2/accounts/${event.account}/amm_liquidity?pool=${pool}`);
        expect([pool, res.status, res.body]).toEqual([pool, 400, { result: 'error', message: 'invalid pool' }]);
      }
    });

    it('filters by event, which must be one the parser writes (400 invalid event)', async () => {
      for (const event of LIQUIDITY) {
        for (const kind of ['create', 'deposit', 'withdraw', 'clawback', 'delete']) {
          const res = await get(`/v2/accounts/${event.account}/amm_liquidity?event=${kind}`);
          expect([event.account, kind, res.body.liquidity]).toEqual([
            event.account,
            kind,
            event.event === kind ? [liquidityOf(event)] : [],
          ]);
        }
      }
      for (const kind of ['DEPOSIT', 'swap', 'vote', 'depositx']) {
        const res = await get(`/v2/accounts/${LIQUIDITY[0].account}/amm_liquidity?event=${kind}`);
        expect([kind, res.status, res.body]).toEqual([kind, 400, { result: 'error', message: 'invalid event' }]);
      }
    });

    it('start and end are dates: the events of the ledgers that closed in them', async () => {
      const event = LIQUIDITY[0];
      const at = (shift: number): string => iso(event.close_time + shift);
      const cases: [Record<string, string>, boolean][] = [
        [{ start: at(0) }, true],
        [{ start: at(1) }, false],
        [{ end: at(0) }, true],
        [{ end: at(-1) }, false],
        [{ start: at(0), end: at(0) }, true],
        [{ start: '2030-01-01' }, false],
      ];
      for (const [params, found] of cases) {
        const res = await get(`/v2/accounts/${event.account}/amm_liquidity${qs(params)}`);
        expect([params, res.status, res.body.liquidity]).toEqual([params, 200, found ? [liquidityOf(event)] : []]);
      }
    });

    it('answers the errors in the order start, end, limit, pool, event, marker', async () => {
      const address = LIQUIDITY[0].account;
      const cases: [string, string][] = [
        ['start=x&end=x&pool=x&event=x&marker=!', 'invalid start date format'],
        ['end=x&pool=x&event=x&marker=!', 'invalid end date format'],
        ['pool=x&event=x&marker=!', 'invalid pool'],
        ['event=x&marker=!', 'invalid event'],
        ['marker=!', 'invalid marker'],
      ];
      for (const [query, message] of cases) {
        const res = await get(`/v2/accounts/${address}/amm_liquidity?${query}`);
        expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
      }
    });

    it('sets the Link header on a page with a next one, and format=csv names the file after the account', async () => {
      const address = LIQUIDITY[0].account;
      const csv = await get(`/v2/accounts/${address}/amm_liquidity?format=csv`);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toBe(csvDisposition(`${address} - amm liquidity`));
      const table = lines(csv.text).map(cells);
      expect(table[0]).toEqual(LIQUIDITY_KEYS.map((c) => `"${c}"`));
      expect(table).toHaveLength(2);
      expect((await get(`/v2/accounts/${address}/amm_liquidity`)).headers.link).toBeUndefined();
      const empty = await get(`/v2/accounts/${accountAt(0xfeed)}/amm_liquidity?format=csv`);
      expect([empty.status, empty.text]).toEqual([200, '']);
    });

    it('ignores the params it does not know', async () => {
      const event = LIQUIDITY[0];
      const res = await get(`/v2/accounts/${event.account}/amm_liquidity?nothing=1&interval=day&amm=only`);
      expect(res.body.liquidity).toEqual([liquidityOf(event)]);
    });
  });

  // -- amm_positions ---------------------------------------------------------------------------------------------------

  describe('GET /v2/accounts/:address/amm_positions', () => {
    it('serves the positions of every holder at the end of the recordings as the oracle has them: the share of the supply and of each reserve', async () => {
      let total = 0;
      for (const account of HOLDERS) {
        const res = await get(`/v2/accounts/${account}/amm_positions`);
        expect([account, res.status]).toEqual([account, 200]);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Object.keys(res.body)).toEqual(['result', 'positions']);
        expect(res.body.result).toBe('success');
        expect([account, res.body.positions]).toEqual([account, positionsAt(account, head)]);
        expectOrdered(res.body.positions, POSITION_KEYS, account);
        total += res.body.positions.length;
      }
      // the creator of a pool holds all of its supply: a share of one, and the reserves of the pool
      const creator = LIQUIDITY.find((l) => l.event === 'create')!;
      const positions = (await get(`/v2/accounts/${creator.account}/amm_positions`)).body.positions as Obj[];
      expect(positions).toEqual([
        {
          pool: creator.amm_account,
          lp_currency: '036D9072B9D0C769D60E61FCC2E38D12E1C6BD27',
          lp_balance: '22360679.77499789',
          share: '1',
          base_amount: '1000000',
          counter_amount: '500',
        },
      ]);
      expect(total).toBeGreaterThanOrEqual(6);
    });

    it('serves the positions as of a date: the lines and the pools as they were at the last ledger that closed at or before it', async () => {
      for (const account of HOLDERS) {
        for (const ledger of LEDGERS) {
          const res = await get(`/v2/accounts/${account}/amm_positions${qs({ date: iso(ledger.time) })}`);
          expect([account, ledger.index, res.status]).toEqual([account, ledger.index, 200]);
          expect([account, ledger.index, res.body.positions]).toEqual([
            account,
            ledger.index,
            positionsAt(account, ledger.index),
          ]);
        }
      }
      // a date between two ledgers is the earlier one; one before the first has no position
      const second = LEDGERS[1];
      const between = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions${qs({ date: iso(second.time + 1) })}`);
      expect(between.body.positions).toEqual(positionsAt(HOLDERS[0], second.index));
      const before = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions${qs({ date: iso(LEDGERS[0].time - 1) })}`);
      expect([before.status, before.body]).toEqual([200, { result: 'success', positions: [] }]);
      // the date formats of the API are all dates; a day is its first second
      const day = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions?date=2030-01-01`);
      expect(day.body.positions).toEqual(positionsAt(HOLDERS[0], head));
    });

    it('omits a zero balance, and a position in a pool whose LP currency the states do not tell', async () => {
      // the sender of the LP-token transfer holds 0 after it; the receiver holds the tokens of a pool whose LP currency the
      // recordings do not carry (a swap says nothing of it)
      for (const account of [
        'rXPMxDRxMM6JLk8AMVh569iap3TtnjaF3',
        'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV',
        'rHjzfruAe7qbEPjzvdfQ4zvjoZnQHcomwP',
      ]) {
        const res = await get(`/v2/accounts/${account}/amm_positions`);
        expect([account, res.status, res.body]).toEqual([account, 200, { result: 'success', positions: [] }]);
      }
    });

    it('is an empty list for an account with no LP tokens, for a pool (whose lines are those of its holders) and for a text that is no address', async () => {
      for (const address of [accountAt(0xfeed), 'rnotanaddress', LIQUIDITY[0].amm_account, LIQUIDITY[1].amm_account]) {
        const res = await get(`/v2/accounts/${address}/amm_positions`);
        expect([address, res.status, res.body]).toEqual([address, 200, { result: 'success', positions: [] }]);
      }
    });

    it('answers 400 invalid date format for a text that is no date, before any read', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const date of ['x', '2024-13-01', '1', 'yesterday']) {
        const res = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions?date=${date}`);
        expect([date, res.status, res.body]).toEqual([date, 400, { result: 'error', message: 'invalid date format' }]);
      }
      // an empty date is none
      jest.restoreAllMocks();
      const none = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions?date=`);
      expect(none.body.positions).toEqual(positionsAt(HOLDERS[0], head));
    });

    it('ignores the params it does not know, and has no paging: the answer is the account and the date', async () => {
      const res = await get(`/v2/accounts/${HOLDERS[0]}/amm_positions?limit=1&marker=x&format=csv&pool=x`);
      expect(res.status).toBe(200);
      expect(res.body.positions).toEqual(positionsAt(HOLDERS[0], head));
      expect(res.headers.link).toBeUndefined();
    });

    it('reads no state at all for an account with no LP line, and only the pools of its lines for one that has them', async () => {
      const real = h.ch.query.bind(h.ch);
      const seen: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) => {
        seen.push(sql);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (real as any)(sql, ...rest);
      }) as never);
      await api.ok(`/v2/accounts/${accountAt(0xfeed)}/amm_positions`);
      expect(seen.filter((sql) => sql.includes(Table.AmmPoolStates))).toHaveLength(0);
      expect(seen.filter((sql) => sql.includes(Table.BalanceChanges))).toHaveLength(1);
      seen.length = 0;
      await api.ok(`/v2/accounts/${HOLDERS[0]}/amm_positions`);
      expect(seen.filter((sql) => sql.includes(Table.BalanceChanges))).toHaveLength(1);
      expect(seen.filter((sql) => sql.includes(Table.AmmPoolStates)).length).toBeGreaterThanOrEqual(1);
      // and never the tables of the pools the aggregator writes
      expect(seen.some((sql) => sql.includes(Table.AmmPools) || sql.includes(Table.AmmDaily))).toBe(false);
    });
  });

  describe('when the database fails', () => {
    const address = LIQUIDITY[0].account;
    const cases: [string, string, string][] = [
      ['the liquidity', `/v2/accounts/${address}/amm_liquidity`, 'unable to retrieve liquidity'],
      ['the positions', `/v2/accounts/${address}/amm_positions`, 'unable to retrieve positions'],
    ];

    it.each(cases)('%s is a 500 with its own message', async (_name, path, message) => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(path);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
    });

    it.each([Table.AccountAmmLiquidity, Table.BalanceChanges, Table.AmmPoolStates])(
      'also when only the read of %s fails',
      async (table) => {
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(`FROM ${table}`) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const path =
          table === Table.AccountAmmLiquidity
            ? `/v2/accounts/${address}/amm_liquidity`
            : `/v2/accounts/${HOLDERS.find((a) => positionsAt(a, head).length > 0)}/amm_positions`;
        const res = await get(path);
        expect([table, res.status]).toEqual([table, 500]);
      },
    );

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const path of [
        `/v2/accounts/${address}/amm_liquidity?pool=x`,
        `/v2/accounts/${address}/amm_liquidity?event=x`,
        `/v2/accounts/${address}/amm_liquidity?marker=!!!`,
        `/v2/accounts/${address}/amm_liquidity?start=x`,
        `/v2/accounts/${address}/amm_positions?date=x`,
      ]) {
        expect([path, (await get(path)).status]).toEqual([path, 400]);
      }
    });
  });

  it('the account AMM routes are served with the API key, like every route', async () => {
    for (const route of ['amm_liquidity', 'amm_positions']) {
      expect((await h.http().get(`/v2/accounts/${HOLDERS[0]}/${route}`)).status).toBe(401);
    }
  });

  it('reads the narrow index by account, never the table ordered by pool', async () => {
    const real = h.ch.query.bind(h.ch);
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) => {
      seen.push(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real as any)(sql, ...rest);
    }) as never);
    await api.ok(`/v2/accounts/${LIQUIDITY[0].account}/amm_liquidity`, 'liquidity');
    // by the account prefix of the narrow index, never the table ordered by pool
    expect(seen.some((sql) => sql.includes(`FROM ${Table.AccountAmmLiquidity}`))).toBe(true);
    expect(seen.some((sql) => new RegExp(`FROM ${Table.AmmLiquidity}\\b`).test(sql))).toBe(false);
  });
});

// =====================================================================================================================
describe('the account liquidity list over events made by hand', () => {
  const closeOf = (ledger: number): number => 1_762_843_711 + (ledger - 100_132_150);
  const POOLS = [accountAt(0xc1), accountAt(0xc2), accountAt(0xc3)];
  const ME = accountAt(0xd1);
  const OTHER = accountAt(0xd2);

  const row = (
    account: string,
    pool: string,
    ledger: number,
    tx: number,
    over: Partial<AmmLiquidityRow> = {},
  ): AmmLiquidityRow => ({
    amm_account: pool,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: closeOf(ledger),
    account,
    initiator: account,
    event: 'deposit',
    mode: 'two_asset',
    base_amount: '1',
    counter_amount: '2',
    lp_tokens: '3',
    base_amount_f: 1,
    counter_amount_f: 2,
    lp_tokens_f: 3,
    ...over,
  });

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);
  let head: number;

  // 15 events of one account over three pools; two of them at the same transaction of different pools (a synthetic case:
  // the key of the narrow index ends with the pool). Every seventh is a clawback.
  const mine: AmmLiquidityRow[] = Array.from({ length: 15 }, (_, i) => {
    const ledger = 100_700_001 + Math.floor(i / 3);
    const event = i % 7 === 6 ? 'clawback' : i % 2 === 0 ? 'deposit' : 'withdraw';
    return row(ME, POOLS[i % 3], ledger, i % 3 === 0 ? 0 : 1, {
      event,
      mode: event === 'clawback' ? '' : 'single_asset',
      initiator: event === 'clawback' ? accountAt(0xaa) : ME,
      base_amount: String(i),
    });
  });
  // the keys must be unique: (ledger, tx, pool)
  const keys = new Set(mine.map((r) => `${r.ledger_index}|${r.tx_index}|${r.amm_account}`));
  const sorted = [...mine].sort(
    (a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || compare(a.amm_account, b.amm_account),
  );

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const [{ latest }] = await h.ch.query<{ latest: number }>(
      `SELECT max(ledger_index) AS latest FROM ${Table.Ledgers}`,
    );
    head = Number(latest);
    await h.ch.insert(Table.AccountAmmLiquidity, [
      ...mine,
      row(OTHER, POOLS[0], 100_700_001, 0, { base_amount: '999' }),
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: 15 events with 15 different keys, the same ledger and transaction in different pools', () => {
    expect(keys.size).toBe(15);
    expect(new Set(mine.map((r) => `${r.ledger_index}|${r.tx_index}`)).size).toBeLessThan(15);
  });

  it('lists the events of the account in the order of (ledger_index, tx_index, pool), and not those of another account', async () => {
    const res = await get(`/v2/accounts/${ME}/amm_liquidity?limit=1000`);
    expect(res.body.liquidity).toEqual(sorted.map(liquidityOf));
    expectOrdered(res.body.liquidity, LIQUIDITY_KEYS);
    expect((res.body.liquidity as Obj[]).every((e) => e.account === ME)).toBe(true);
    const desc = await get(`/v2/accounts/${ME}/amm_liquidity?limit=1000&descending=true`);
    expect(desc.body.liquidity).toEqual(sorted.map(liquidityOf).reverse());
    const other = await get(`/v2/accounts/${OTHER}/amm_liquidity`);
    expect(other.body.liquidity).toEqual([liquidityOf(row(OTHER, POOLS[0], 100_700_001, 0, { base_amount: '999' }))]);
  });

  it('lists a clawback under the holder, not under the issuer who sent it', async () => {
    const clawed = (await get(`/v2/accounts/${ME}/amm_liquidity?event=clawback`)).body.liquidity as Obj[];
    expect(clawed.length).toBeGreaterThan(0);
    expect(clawed.every((e) => e.account === ME && e.initiator === accountAt(0xaa))).toBe(true);
    expect((await get(`/v2/accounts/${accountAt(0xaa)}/amm_liquidity`)).body.liquidity).toEqual([]);
  });

  it('pages by 1, 2 and 4 through rows that share a ledger and a transaction, a marker with the pool in it, both ways', async () => {
    for (const descending of [false, true]) {
      for (const limit of [1, 2, 4]) {
        const walked = await pages<PageBody>(
          `/v2/accounts/${ME}/amm_liquidity?descending=${descending}`,
          limit,
          'liquidity',
        );
        const want = sorted.map(liquidityOf);
        expect([descending, limit, walked.flatMap((p) => p.liquidity)]).toEqual([
          descending,
          limit,
          descending ? want.reverse() : want,
        ]);
        expect(walked.slice(0, -1).every((p) => p.count === limit)).toBe(true);
        expect(walked[walked.length - 1].marker).toBeUndefined();
      }
    }
    const first = (await get(`/v2/accounts/${ME}/amm_liquidity?limit=2`)).body as PageBody;
    expect(decodeMarker(first.marker!)).toEqual([sorted[1].ledger_index, sorted[1].tx_index, sorted[1].amm_account]);
    // a marker is the key of the row: ledger, transaction and pool
    for (const bad of [markerOf([1, 2]), markerOf([1, 2, 3]), markerOf(['a', 2, 'b'])]) {
      const res = await get(`/v2/accounts/${ME}/amm_liquidity?marker=${bad}`);
      expect([bad, res.status, res.body]).toEqual([bad, 400, { result: 'error', message: 'invalid marker' }]);
    }
  });

  it('filters inside the read: a pool that holds one event in three, an event that holds one in seven, both together', async () => {
    for (const pool of POOLS) {
      const want = sorted.filter((r) => r.amm_account === pool).map(liquidityOf);
      for (const descending of [false, true]) {
        const walked = await pages<PageBody>(
          `/v2/accounts/${ME}/amm_liquidity?pool=${pool}&descending=${descending}`,
          2,
          'liquidity',
        );
        expect([pool, descending, walked.flatMap((p) => p.liquidity)]).toEqual([
          pool,
          descending,
          descending ? [...want].reverse() : want,
        ]);
        expect(walked.slice(0, -1).every((p) => p.count === 2)).toBe(true);
      }
    }
    const clawbacks = sorted.filter((r) => r.event === 'clawback');
    expect(clawbacks).toHaveLength(2);
    for (const descending of [false, true]) {
      const walked = await pages<PageBody>(
        `/v2/accounts/${ME}/amm_liquidity?event=clawback&descending=${descending}`,
        1,
        'liquidity',
      );
      expect(walked.map((p) => p.count)).toEqual([1, 1]);
      expect(walked.flatMap((p) => p.liquidity)).toEqual(
        descending ? clawbacks.map(liquidityOf).reverse() : clawbacks.map(liquidityOf),
      );
    }
    const both = sorted.filter((r) => r.event === 'withdraw' && r.amm_account === POOLS[1]);
    const together = await pages<PageBody>(
      `/v2/accounts/${ME}/amm_liquidity?pool=${POOLS[1]}&event=withdraw`,
      1,
      'liquidity',
    );
    expect(together.flatMap((p) => p.liquidity)).toEqual(both.map(liquidityOf));
    expect(together.every((p) => p.count === 1)).toBe(true);
  });

  it('never serves a row above the committed head, and serves a window of dates', async () => {
    const lonely = accountAt(0xd3);
    await h.ch.insert(Table.AccountAmmLiquidity, [
      row(lonely, POOLS[0], head, 0),
      row(lonely, POOLS[0], head + 1, 0, { event: 'withdraw' }),
    ]);
    const res = await get(`/v2/accounts/${lonely}/amm_liquidity`);
    expect((res.body.liquidity as Obj[]).map((e) => e.ledger_index)).toEqual([head]);
  });

  it('a row written twice is listed once, and a page cut inside the duplicates neither repeats nor skips one', async () => {
    const dup = accountAt(0xd4);
    const events = [
      row(dup, POOLS[0], 100_710_001, 0),
      row(dup, POOLS[1], 100_710_001, 0),
      row(dup, POOLS[0], 100_710_001, 1),
      row(dup, POOLS[2], 100_710_002, 0),
    ];
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AccountAmmLiquidity}`);
    await h.ch.insert(Table.AccountAmmLiquidity, events);
    await h.ch.command(
      `INSERT INTO ${Table.AccountAmmLiquidity} SELECT * FROM ${Table.AccountAmmLiquidity} WHERE account = {a:String}`,
      { a: dup },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.AccountAmmLiquidity} WHERE account = {a:String}`,
      { a: dup },
    );
    expect(Number(n)).toBe(8);
    const want = [...events]
      .sort(
        (a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || compare(a.amm_account, b.amm_account),
      )
      .map(liquidityOf);
    for (const descending of [false, true]) {
      for (const limit of [1, 2, 3, 10]) {
        const walked = await pages<PageBody>(
          `/v2/accounts/${dup}/amm_liquidity?descending=${descending}`,
          limit,
          'liquidity',
        );
        expect([descending, limit, walked.flatMap((p) => p.liquidity)]).toEqual([
          descending,
          limit,
          descending ? [...want].reverse() : want,
        ]);
      }
    }
  });

  it('does not need the pool to exist: a pool filter of an address with no state is an empty list, not a 404', async () => {
    const res = await get(`/v2/accounts/${ME}/amm_liquidity?pool=${accountAt(0xdead)}`);
    expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, liquidity: [] }]);
  });
});

// =====================================================================================================================
describe('the positions over lines made by hand', () => {
  const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
  /**
   * One second a ledger from the recorded ledger 93663334 back (it closed at 1737679022) and from 100132150 on (1762843711, before
   * the next recorded one, 102186243): the order of the ledgers is the order of the times.
   */
  const closeOf = (ledger: number): number =>
    ledger <= 93_663_334 ? 1_737_679_022 + (ledger - 93_663_334) : 1_762_843_711 + (ledger - 100_132_150);
  const lp = (n: number): string => `03${n.toString(16).toUpperCase().padStart(38, '0')}`;
  const ME = accountAt(0x1000);

  const state = (pool: string, ledger: number, tx: number, over: Partial<AmmPoolStatesRow> = {}): AmmPoolStatesRow => ({
    amm_account: pool,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: closeOf(ledger),
    tx_type: 'AMMDeposit',
    base_currency: 'AAA',
    base_issuer: ISSUER,
    counter_currency: 'XRP',
    counter_issuer: '',
    reserve_base: null,
    reserve_counter: null,
    lp_supply: null,
    lp_currency: null,
    reserve_base_f: null,
    reserve_counter_f: null,
    lp_supply_f: null,
    trading_fee: null,
    auction_holder: null,
    auction_price: null,
    auction_price_f: null,
    auction_discounted_fee: null,
    auction_expiration: null,
    deleted: 0,
    ...over,
  });

  const line = (
    account: string,
    pool: string,
    currency: string,
    ledger: number,
    tx: number,
    node: number,
    balance: string,
  ): BalanceChangesRow => ({
    account,
    ledger_index: ledger,
    tx_index: tx,
    node_index: node,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: closeOf(ledger),
    currency,
    counterparty: pool,
    amount_change: balance,
    final_balance: balance,
    final_balance_f: Number(balance),
    change_type: 'exchange',
    escrow_counterparty: null,
    escrow_balance_change: null,
    paychannel_counterparty: null,
    paychannel_fund_change: null,
    paychannel_fund_final_balance: null,
    paychannel_final_balance: null,
    paychannel_balance_change: null,
    client: null,
  });

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  let head: number;

  /** A ledger row, so that a date can name the ledger. */
  async function addLedger(ledger: number): Promise<void> {
    await h.ch.command(
      `INSERT INTO ${Table.Ledgers}
       SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, toDateTime({time:UInt32}, 'UTC') AS close_time,
                             {hash:String} AS ledger_hash)
         FROM (SELECT * FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1) AS tpl`,
      { ledger, time: closeOf(ledger), hash: hashOf(ledger) },
    );
  }
  const positions = async (account: string, query = ''): Promise<Obj[]> => {
    const res = await get(`/v2/accounts/${account}/amm_positions${query}`);
    expect([account, query, res.status]).toEqual([account, query, 200]);
    return res.body.positions as Obj[];
  };
  const at = (ledger: number): string => `?date=${encodeURIComponent(iso(closeOf(ledger)))}`;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const [{ latest }] = await h.ch.query<{ latest: number }>(
      `SELECT max(ledger_index) AS latest FROM ${Table.Ledgers}`,
    );
    head = Number(latest);
    for (const ledger of [100_800_000, 100_800_100, 100_800_500, 100_801_000]) await addLedger(ledger);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the LP-token transfer of the recordings', () => {
    // 141,421,356.2373095 LP tokens of the TUJ/XRP pool went from rXPM... to rKqSPj... in ledger 93663334; the recordings hold
    // no state of the pool that names its LP currency or its supply, so those are made here: the pool had four times as
    // many tokens at first, three times as many from ledger 100,000,000 on
    const POOL = 'rGuYK1v7kyrKEa86wPN2M9CHpT9LiWFr5m';
    const RECEIVER = 'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV';
    const SENDER = 'rXPMxDRxMM6JLk8AMVh569iap3TtnjaF3';
    const TOKEN = '03F5BC4D66B44AEAD668A84F094E08C8C13F5EE2';
    const TRANSFER = 93_663_334;

    /** What the recording says the account holds after the transfer, worked out from the raw metadata of the transaction. */
    function balanceAfterTransfer(account: string): string {
      const ledger = fixtureSource('xrpl-amm')
        .list()
        .find((l) => l.header.ledger_index === TRANSFER)!;
      const tx = ledger.transactions.find((t) => t.hash.startsWith('6C6B9070'))!;
      const nodes = (tx.meta.AffectedNodes as Record<string, { LedgerEntryType: string; FinalFields?: Obj }>[]).map(
        (n) => Object.values(n)[0],
      );
      for (const node of nodes) {
        const f = node.FinalFields as
          | {
              Balance: { currency: string; value: string };
              LowLimit: { issuer: string };
              HighLimit: { issuer: string };
            }
          | undefined;
        if (node.LedgerEntryType !== 'RippleState' || f?.Balance.currency !== TOKEN) continue;
        // the balance is the low account's: the high account holds the negative of it
        if (f.HighLimit.issuer === account) return new BigNumber(f.Balance.value).negated().toFixed();
        if (f.LowLimit.issuer === account) return f.Balance.value;
      }
      throw new Error(`no line of ${account} in the transfer`);
    }

    /** The reserves the pool had after its last swap of the ledger 93663334, from the rows the parser builds. */
    const lastSwapState = (): AmmPoolStatesRow =>
      ROWS_OF.get(POOL)!
        .filter((r) => r.ledger_index === TRANSFER)
        .slice(-1)[0];

    beforeAll(async () => {
      // before the transfer, 100,000 XRP and 500 of the other asset, 565,685,424.949238 LP tokens (a quarter is 141,421,356.2373095)
      await addLedger(93_663_000);
      await h.ch.insert(Table.AmmPoolStates, [
        state(POOL, 93_663_000, 0, {
          lp_currency: TOKEN,
          lp_supply: '565685424.949238',
          reserve_base: '100000',
          reserve_counter: '500',
          trading_fee: 500,
        }),
        state(POOL, 100_000_000, 0, { lp_supply: '424264068.7119285' }),
      ]);
      // what the sender held before the transfer
      await h.ch.insert(Table.BalanceChanges, [line(SENDER, POOL, TOKEN, 93_663_000, 0, 0, '141421356.2373095')]);
    });

    it('the recording says the receiver holds the tokens and the sender nothing', () => {
      expect(balanceAfterTransfer(RECEIVER)).toBe('141421356.2373095');
      expect(balanceAfterTransfer(SENDER)).toBe('0');
      expect(lastSwapState().reserve_base).not.toBeNull();
      expect(lastSwapState().lp_supply).toBeNull();
    });

    it('serves the receiver a quarter of the pool at the transfer, from the supply of the state before it and the reserves of the swaps', async () => {
      const last = lastSwapState();
      const share = await positions(RECEIVER, '?date=2025-06-01');
      expect(share).toEqual([
        positionOf(
          POOL,
          TOKEN,
          balanceAfterTransfer(RECEIVER),
          '565685424.949238',
          last.reserve_base,
          last.reserve_counter,
        ),
      ]);
      expect(share[0]).toMatchObject({
        pool: POOL,
        lp_currency: TOKEN,
        lp_balance: '141421356.2373095',
        share: '0.25',
      });
      // a quarter of the reserves: exact
      expect(share[0].base_amount).toBe(new BigNumber(last.reserve_base!).dividedBy(4).toFixed());
      expect(share[0].counter_amount).toBe(new BigNumber(last.reserve_counter!).dividedBy(4).toFixed());
      expect(Object.keys(share[0])).toEqual(POSITION_KEYS);
    });

    it('serves a third of the pool once the supply is three times the balance: the share that does not end is cut at 30 digits', async () => {
      const last = lastSwapState();
      const later = await positions(RECEIVER, '?date=2025-12-01');
      expect(later).toEqual([
        positionOf(POOL, TOKEN, '141421356.2373095', '424264068.7119285', last.reserve_base, last.reserve_counter),
      ]);
      expect(later[0].share).toBe('0.333333333333333333333333333333');
      // the default date is now: the same
      expect(await positions(RECEIVER)).toEqual(later);
    });

    it('serves nothing for the sender: it holds 0 after the transfer', async () => {
      expect(await positions(SENDER)).toEqual([]);
      expect(await positions(SENDER, '?date=2025-12-01')).toEqual([]);
    });

    it('serves the sender its position at a date before the transfer, with the reserves and the supply of that date; the receiver has none', async () => {
      const before = at(93_663_000);
      const sender = await positions(SENDER, before);
      expect(sender).toEqual([positionOf(POOL, TOKEN, '141421356.2373095', '565685424.949238', '100000', '500')]);
      expect(sender[0]).toMatchObject({ share: '0.25', base_amount: '25000', counter_amount: '125' });
      expect(await positions(RECEIVER, before)).toEqual([]);
      // the minute before the first ledger has nothing
      expect(await positions(SENDER, `?date=${encodeURIComponent(iso(closeOf(93_663_000) - 1))}`)).toEqual([]);
    });
  });

  describe('which lines are positions', () => {
    const NORMAL = accountAt(0x2001);
    const DELETED = accountAt(0x2002);
    const EMPTY_SUPPLY = accountAt(0x2003);
    const NOT_A_POOL = accountAt(0x2004);
    const OTHER_TOKEN = accountAt(0x2005);
    const WITHDRAWN = accountAt(0x2006);
    const NOT_LP = [accountAt(0x2007), accountAt(0x2017), accountAt(0x2027), accountAt(0x2037)];
    // currencies that are no LP tokens, each the "LP currency" of its pool: a 03-prefixed code of 38 digits, another prefix, a
    // plain code, a code of 41 digits
    const ODD = [`03${'A'.repeat(36)}`, `04${'A'.repeat(38)}`, 'USD', `03${'A'.repeat(39)}`];
    const ABOVE_HEAD = accountAt(0x2008);
    const LATE_STATE = accountAt(0x2009);
    const SLOW = accountAt(0x200a);
    const HOLDER = accountAt(0x3001);
    const L0 = 100_800_000;
    const L1 = 100_800_100;
    const L2 = 100_800_500;
    const L3 = 100_801_000;

    beforeAll(async () => {
      await h.ch.insert(Table.AmmPoolStates, [
        state(NORMAL, L0, 0, { lp_currency: lp(1), lp_supply: '1000', reserve_base: '200', reserve_counter: '50' }),
        // deleted at L1: the supply is 0 and the pool is gone
        state(DELETED, L0, 0, { lp_currency: lp(2), lp_supply: '1000', reserve_base: '200', reserve_counter: '50' }),
        state(DELETED, L1, 0, { lp_supply: '0', reserve_base: '0', reserve_counter: '0', deleted: 1 }),
        // a supply of 0 and not deleted
        state(EMPTY_SUPPLY, L0, 0, { lp_currency: lp(3), lp_supply: '0', reserve_base: '5', reserve_counter: '5' }),
        // the pool of OTHER_TOKEN has another LP currency than the line says
        state(OTHER_TOKEN, L0, 0, { lp_currency: lp(5), lp_supply: '10', reserve_base: '1', reserve_counter: '1' }),
        state(WITHDRAWN, L0, 0, { lp_currency: lp(6), lp_supply: '100', reserve_base: '10', reserve_counter: '10' }),
        ...NOT_LP.map((pool, i) =>
          state(pool, L0, 0, { lp_currency: ODD[i], lp_supply: '100', reserve_base: '10', reserve_counter: '10' }),
        ),
        // the pool exists only in a ledger above the head
        state(ABOVE_HEAD, head + 1, 0, {
          lp_currency: lp(8),
          lp_supply: '100',
          reserve_base: '10',
          reserve_counter: '10',
        }),
        // the supply and the currency far back, the reserves in a newer state: both are needed, from far apart
        state(LATE_STATE, 100_200_000, 0, { lp_currency: lp(9), lp_supply: '400' }),
        state(LATE_STATE, L2, 0, { reserve_base: '40', reserve_counter: '10' }),
        // a pool of which only the reserve of one side is ever known
        state(SLOW, L0, 0, { lp_currency: lp(10), lp_supply: '8', reserve_base: '16' }),
      ]);
      // the key of a line is (account, ledger, transaction, node): each line of the holder gets a node of its own
      let node = 0;
      const lineOf = (pool: string, currency: string, ledger: number, balance: string): BalanceChangesRow =>
        line(HOLDER, pool, currency, ledger, 0, node++, balance);
      await h.ch.insert(Table.BalanceChanges, [
        lineOf(NORMAL, lp(1), L0, '100'),
        lineOf(DELETED, lp(2), L0, '5'),
        lineOf(EMPTY_SUPPLY, lp(3), L0, '5'),
        // a line against an account that is no pool
        lineOf(NOT_A_POOL, lp(4), L0, '5'),
        // a line of the pool's own LP currency is a position; the line of another code with the pool is not
        lineOf(OTHER_TOKEN, lp(55), L0, '5'),
        // 5, then 0: the latest is what counts
        lineOf(WITHDRAWN, lp(6), L0, '5'),
        lineOf(WITHDRAWN, lp(6), L1, '0'),
        ...NOT_LP.map((pool, i) => lineOf(pool, ODD[i], L0, '5')),
        lineOf(ABOVE_HEAD, lp(8), L0, '5'),
        lineOf(LATE_STATE, lp(9), L0, '100'),
        lineOf(SLOW, lp(10), L0, '2'),
      ]);
    });

    it('serves the lines that are positions and no other, sorted by the pool, with the exact decimals', async () => {
      const served = await positions(HOLDER);
      expect(served).toEqual(
        [
          positionOf(NORMAL, lp(1), '100', '1000', '200', '50'),
          positionOf(LATE_STATE, lp(9), '100', '400', '40', '10'),
          positionOf(SLOW, lp(10), '2', '8', '16', null),
        ].sort((a, b) => compare(a.pool as string, b.pool as string)),
      );
      expect(served.map((p) => p.pool)).toEqual([NORMAL, LATE_STATE, SLOW].sort(compare));
      expectOrdered(served, POSITION_KEYS);
      const normal = served.find((p) => p.pool === NORMAL)!;
      expect(normal).toEqual({
        pool: NORMAL,
        lp_currency: lp(1),
        lp_balance: '100',
        share: '0.1',
        base_amount: '20',
        counter_amount: '5',
      });
      // the pool of which one reserve is never known: that amount has no key
      const slow = served.find((p) => p.pool === SLOW)!;
      expect(slow).toEqual({ pool: SLOW, lp_currency: lp(10), lp_balance: '2', share: '0.25', base_amount: '4' });
      expect(slow).not.toHaveProperty('counter_amount');
    });

    it('takes the values of a pool from the states far back, as far as it takes (a supply and a currency 600,000 ledgers before the reserves)', async () => {
      const late = (await positions(HOLDER)).find((p) => p.pool === LATE_STATE)!;
      expect(late).toMatchObject({ share: '0.25', base_amount: '10', counter_amount: '2.5' });
    });

    it('leaves out a deleted pool, a supply of 0, a non-pool, another LP code, a balance back at 0, and lines that are no LP tokens', async () => {
      const pools = (await positions(HOLDER)).map((p) => p.pool);
      for (const left of [DELETED, EMPTY_SUPPLY, NOT_A_POOL, OTHER_TOKEN, WITHDRAWN, ...NOT_LP, ABOVE_HEAD]) {
        expect([left, pools.includes(left)]).toEqual([left, false]);
      }
    });

    it('as of a date: the deleted pool, the balance not yet withdrawn and the state not yet there are as they were', async () => {
      // at L0 the deleted pool is alive and the withdrawn line still holds 5; LATE_STATE has no reserves yet
      const atL0 = await positions(HOLDER, at(L0));
      expect(atL0).toEqual(
        [
          positionOf(NORMAL, lp(1), '100', '1000', '200', '50'),
          positionOf(DELETED, lp(2), '5', '1000', '200', '50'),
          positionOf(WITHDRAWN, lp(6), '5', '100', '10', '10'),
          positionOf(LATE_STATE, lp(9), '100', '400', null, null),
          positionOf(SLOW, lp(10), '2', '8', '16', null),
        ].sort((a, b) => compare(a.pool as string, b.pool as string)),
      );
      // at L1 the pool is deleted and the line is back at 0
      const atL1 = (await positions(HOLDER, at(L1))).map((p) => p.pool);
      expect(atL1).not.toContain(DELETED);
      expect(atL1).not.toContain(WITHDRAWN);
      expect(atL1).toContain(NORMAL);
      // at L2 the reserves of LATE_STATE are there
      const atL2 = (await positions(HOLDER, at(L2))).find((p) => p.pool === LATE_STATE)!;
      expect(atL2).toMatchObject({ base_amount: '10', counter_amount: '2.5' });
      // a date past every ledger is the head
      expect(await positions(HOLDER, '?date=2099-01-01')).toEqual(await positions(HOLDER));
    });

    it('never counts a line or a state above the committed head', async () => {
      const lonely = accountAt(0x4001);
      await h.ch.insert(Table.BalanceChanges, [
        line(lonely, NORMAL, lp(1), L0, 0, 0, '10'),
        line(lonely, NORMAL, lp(1), head + 1, 0, 0, '900'),
      ]);
      expect(await positions(lonely)).toEqual([positionOf(NORMAL, lp(1), '10', '1000', '200', '50')]);
    });

    it('the latest line of a pool is the one of the highest ledger, then transaction, then node, whatever order they were written in', async () => {
      const account = accountAt(0x4002);
      await h.ch.insert(Table.BalanceChanges, [
        line(account, NORMAL, lp(1), L1, 0, 2, '30'),
        line(account, NORMAL, lp(1), L1, 0, 1, '20'),
        line(account, NORMAL, lp(1), L0, 7, 9, '999'),
        line(account, NORMAL, lp(1), L1, 0, 0, '10'),
      ]);
      expect(await positions(account)).toEqual([positionOf(NORMAL, lp(1), '30', '1000', '200', '50')]);
      // by transaction before node, ledger before transaction
      const other = accountAt(0x4003);
      await h.ch.insert(Table.BalanceChanges, [
        line(other, NORMAL, lp(1), L1, 1, 0, '40'),
        line(other, NORMAL, lp(1), L1, 0, 5, '50'),
        line(other, NORMAL, lp(1), L0, 9, 9, '60'),
      ]);
      expect(await positions(other)).toEqual([positionOf(NORMAL, lp(1), '40', '1000', '200', '50')]);
    });

    it('a line written twice is one line', async () => {
      const account = accountAt(0x4004);
      const rows = [line(account, NORMAL, lp(1), L1, 0, 0, '77')];
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.BalanceChanges}`);
      await h.ch.insert(Table.BalanceChanges, rows);
      await h.ch.command(
        `INSERT INTO ${Table.BalanceChanges} SELECT * FROM ${Table.BalanceChanges} WHERE account = {a:String}`,
        { a: account },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.BalanceChanges} WHERE account = {a:String}`,
        { a: account },
      );
      expect(Number(n)).toBe(2);
      expect(await positions(account)).toEqual([positionOf(NORMAL, lp(1), '77', '1000', '200', '50')]);
    });

    it('writes the balance as a plain decimal even when it is stored in the exponent form', async () => {
      const account = accountAt(0x4005);
      await h.ch.insert(Table.BalanceChanges, [line(account, NORMAL, lp(1), L1, 0, 0, '1.5e-7')]);
      const [position] = await positions(account);
      expect(position.lp_balance).toBe('0.00000015');
      expect(position.share).toBe('0.00000000015');
      expect(JSON.stringify(position)).not.toMatch(/e[+-]/i);
    });

    it('serves a position of every pool when there are more pools than one batch of the state read holds (200)', async () => {
      const account = accountAt(0x5000);
      const count = 215;
      const pools = Array.from({ length: count }, (_, i) => accountAt(0x6000 + i));
      await h.ch.insert(
        Table.AmmPoolStates,
        pools.map((pool, i) =>
          state(pool, L0, i % 5, {
            lp_currency: lp(1000 + i),
            lp_supply: '100',
            reserve_base: String(i + 1),
            reserve_counter: '10',
          }),
        ),
      );
      await h.ch.insert(
        Table.BalanceChanges,
        pools.map((pool, i) => line(account, pool, lp(1000 + i), L0, 0, i, '10')),
      );
      const served = await positions(account);
      expect(served).toHaveLength(count);
      expect(served.map((p) => p.pool)).toEqual([...pools].sort(compare));
      const byPool = new Map(pools.map((pool, i) => [pool, i]));
      for (const p of served) {
        const i = byPool.get(p.pool as string)!;
        expect(p).toEqual(positionOf(p.pool as string, lp(1000 + i), '10', '100', String(i + 1), '10'));
      }
      // the states were read in more than one batch
      const spy = jest.spyOn(h.ch, 'query');
      await api.ok(`/v2/accounts/${account}/amm_positions`);
      const stateReads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.AmmPoolStates}`));
      spy.mockRestore();
      // the batches of the fill-forward (the reads by one account are the look for older rows of a pool)
      const batches = stateReads.filter(([, params]) => Array.isArray((params as Obj).accounts));
      expect(batches.length).toBeGreaterThanOrEqual(2);
      for (const [, params] of batches) {
        expect(((params as Obj).accounts as string[]).length).toBeLessThanOrEqual(200);
      }
      expect(new Set(batches.flatMap(([, params]) => (params as Obj).accounts as string[])).size).toBe(count);
    });
  });

  it('serves an empty list for an unknown account, with exactly the keys result and positions', async () => {
    const res = await get(`/v2/accounts/${accountAt(0x9999)}/amm_positions`);
    expect([res.status, res.body]).toEqual([200, { result: 'success', positions: [] }]);
  });
});

// =====================================================================================================================
describe('the account reads over a bulk of four parts (read_rows and the plans)', () => {
  // The lines of an account are a range of the primary key of `balance_changes` (the account, then its ledgers), however many
  // accounts the table holds: a bulk of copies of real rows in four parts (`support/read-rows.ts`), 800,000 rows of other
  // accounts and 80,000 of the account's own in the same four parts. The events of an account are a range of the key of
  // `account_amm_liquidity`.
  const GRANULE = 8192;
  const OWN_PER_PART = 20_000;
  const OWN = BULK_BASES.length * OWN_PER_PART;
  const MID = BULK_BASES[1] + BULK_LEDGERS / 2;
  const RECEIVER = 'rKqSPjN6okYt7iPk3xzWvuW9oN1Nk7vSUV';
  const TOKEN = '03F5BC4D66B44AEAD668A84F094E08C8C13F5EE2';
  const POOL = 'rGuYK1v7kyrKEa86wPN2M9CHpT9LiWFr5m';

  let h: Harness;
  let api: ApiClient;
  let provider: string;
  let providerPool: string;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock+amm', env: NO_RATE_LIMIT });
    api = await h.api();
    // the pool names its LP currency: so the line of the receiver is a position
    await h.ch.insert(Table.AmmPoolStates, [
      {
        amm_account: POOL,
        ledger_index: 93_663_000,
        tx_index: 0,
        tx_hash: hashOf(1),
        close_time: 1_737_678_962,
        tx_type: 'AMMDeposit',
        base_currency: 'TUJ',
        base_issuer: RECEIVER,
        counter_currency: 'XRP',
        counter_issuer: '',
        reserve_base: '96889257.2089944',
        reserve_counter: '207.307133',
        lp_supply: '565685424.949238',
        lp_currency: TOKEN,
        reserve_base_f: null,
        reserve_counter_f: null,
        lp_supply_f: null,
        trading_fee: 500,
        auction_holder: null,
        auction_price: null,
        auction_price_f: null,
        auction_discounted_fee: null,
        auction_expiration: null,
        deleted: 0,
      } satisfies AmmPoolStatesRow,
    ]);
    // the lines of other accounts: 800,000 rows in four parts (one account each), below the recorded ledgers
    const template = `SELECT * FROM ${Table.BalanceChanges} WHERE account = {account:String} AND currency = {currency:String} ORDER BY ledger_index, tx_index, node_index LIMIT 1`;
    const params = { account: RECEIVER, currency: TOKEN };
    await insertBulk(
      h,
      Table.BalanceChanges,
      template,
      params,
      (base) =>
        `concat('rBulk', toString(${base} + n.number)) AS account, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index`,
    );
    // the account's own: 80,000 lines of other currencies in the same four ranges of ledgers
    await insertBulk(
      h,
      Table.BalanceChanges,
      template,
      params,
      (base) =>
        `'USD' AS currency, toString(n.number) AS counterparty, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, toInt16(n.number % 7) AS node_index`,
      OWN_PER_PART,
    );
    // the states of other pools: 800,000 rows in four parts, below the recorded ledgers
    await insertBulk(
      h,
      Table.AmmPoolStates,
      `SELECT * FROM ${Table.AmmPoolStates} ORDER BY amm_account, ledger_index, tx_index LIMIT 1`,
      {},
      (base) =>
        `concat('rBulk', toString(${base} + n.number)) AS amm_account, ${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, hex(rand64()) AS tx_hash`,
    );
    // the events of the provider: 800,000 rows of other accounts and the real ones
    const [event] = await h.ch.query<{ account: string; amm_account: string }>(
      `SELECT account, amm_account FROM ${Table.AccountAmmLiquidity} WHERE event = 'deposit' ORDER BY account, ledger_index LIMIT 1`,
    );
    provider = event.account;
    providerPool = event.amm_account;
    await insertBulk(
      h,
      Table.AccountAmmLiquidity,
      `SELECT * FROM ${Table.AccountAmmLiquidity} WHERE account = {provider:String} AND event = 'deposit' ORDER BY ledger_index, tx_index LIMIT 1`,
      { provider },
      (base) => `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index`,
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: 800,000 lines of other accounts and 80,000 of the account in four parts, 800,000 events of the provider', async () => {
    const [others] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.BalanceChanges} WHERE startsWith(account, 'rBulk')`,
    );
    expect([Number(others.n), Number(others.parts)]).toEqual([800_000, BULK_BASES.length]);
    const [own] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.BalanceChanges}
        WHERE account = {account:String} AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${BULK_BASES[3] + BULK_LEDGERS}`,
      { account: RECEIVER },
    );
    expect([Number(own.n), Number(own.parts)]).toEqual([OWN, BULK_BASES.length]);
    const [events] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AccountAmmLiquidity}
        WHERE account = {provider:String} AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${BULK_BASES[3] + BULK_LEDGERS}`,
      { provider },
    );
    expect([Number(events.n), Number(events.parts)]).toEqual([800_000, BULK_BASES.length]);
  });

  it('the positions of an account read its own range of balance_changes: the lines of the account, not the 800,000 of the others', async () => {
    const path = `/v2/accounts/${RECEIVER}/amm_positions`;
    const { reads, statements, body } = await served(h, api, Table.BalanceChanges, path, 'positions');
    expect(reads).toHaveLength(1);
    // the own lines, 20,000 a part, and about a granule at either end of the account's range in each of the five parts
    expect(reads[0].read_rows).toBeLessThanOrEqual(OWN + (BULK_BASES.length + 1) * 2 * GRANULE);
    const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.BalanceChanges}`);
    expect(reads[0].read_rows).toBeLessThan(Number(n) / 4);
    expect((body.positions as Obj[]).map((p) => p.pool)).toEqual([POOL]);
    // the plan: the account and the ledgers up to the head are a range of the primary key
    const [sql, params] = statements[0];
    const [primary] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
    expect(primary.keys).toEqual(['account', 'ledger_index']);
    expect(primary.condition).toContain(`account in ['${RECEIVER}'`);
    expect(primary.condition).toContain('ledger_index in');
    expect(primary.granules[0]).toBeLessThanOrEqual(5 * Math.ceil(OWN / GRANULE) + 10);
    expect(primary.granules[1]).toBeGreaterThan(100);
    expect(sql).not.toMatch(/\bFINAL\b/i);
    // the LP currencies are filtered in the read, and the answer is grouped there: a handful of rows come out
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).toMatch(/match\(currency/);
  });

  it('the state of the pool of a line is a range of the key of amm_pool_states among 800,000 states of other pools: a granule of each part', async () => {
    const path = `/v2/accounts/${RECEIVER}/amm_positions`;
    const { reads } = await served(h, api, Table.AmmPoolStates, path, 'positions');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual((BULK_BASES.length + 2) * GRANULE);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;

    it.each([
      ['', ''],
      ['event', '&event=deposit'],
      ['pool', '&pool=POOL'],
    ])(
      'the page of the events of an account with 800,000 events reads about the granules of its page (%s)',
      async (_name, filter) => {
        for (const marker of [markerOf([MID, 1, providerPool]), markerOf([BULK_BASES[3] + 5, 2, providerPool])]) {
          const path = `/v2/accounts/${provider}/amm_liquidity?limit=5&${direction}&marker=${marker}${filter.replace('POOL', providerPool)}`;
          const { reads, body } = await served(h, api, Table.AccountAmmLiquidity, path, 'liquidity');
          for (const read of reads) {
            expect([path, read.read_rows <= (BULK_BASES.length + 2) * GRANULE ? 'bounded' : read.read_rows]).toEqual([
              path,
              'bounded',
            ]);
          }
          expect([path, (body.liquidity as Obj[]).length]).toEqual([path, 5]);
        }
      },
    );

    it('the page read of the events is read in the order of the key, stops after its rows, holds the filters inside, and uses the key of the account', async () => {
      const path = `/v2/accounts/${provider}/amm_liquidity?limit=5&${direction}&event=deposit&pool=${providerPool}&marker=${markerOf([MID, 1, providerPool])}`;
      const { statements } = await served(h, api, Table.AccountAmmLiquidity, path, 'liquidity');
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      await expectBoundedInOrderRead(h, sql, params, descending, path);
      const inner = innerRead(sql);
      expect(inner).toContain('event = {event:String}');
      expect(inner).toContain('amm_account = {pool:String}');
      expect(sql).not.toMatch(/\bFINAL\b/i);
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', inner, params));
      expect(primary.keys.slice(0, 2)).toEqual(['account', 'ledger_index']);
      expect(primary.condition).toContain(`account in ['${provider}'`);
      expect(primary.condition).toContain('ledger_index in');
    });
  });

  it('reads no more of balance_changes for a second request than for the first: no state is kept between requests', async () => {
    const path = `/v2/accounts/${RECEIVER}/amm_positions`;
    const first = await readsOf(h, Table.BalanceChanges, async () => {
      await api.ok(path, 'positions');
    });
    const second = await readsOf(h, Table.BalanceChanges, async () => {
      await api.ok(path, 'positions');
    });
    expect(second.map((r) => r.read_rows)).toEqual(first.map((r) => r.read_rows));
  });
});

// =====================================================================================================================
describe('the account AMM routes on Xahau', () => {
  // There is no AMM on Xahau: no liquidity event and no pool, so no position.
  let h: Harness;
  let get: ApiClient['get'];
  const ADDRESS = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers an empty liquidity list, for every filter, in JSON and CSV', async () => {
    for (const query of ['', '?limit=5', `?pool=${ADDRESS}`, '?event=deposit', '?start=2020-01-01&descending=true']) {
      const res = await get(`/v2/accounts/${ADDRESS}/amm_liquidity${query}`);
      expect([query, res.status, res.body]).toEqual([query, 200, { result: 'success', count: 0, liquidity: [] }]);
    }
    const csv = await get(`/v2/accounts/${ADDRESS}/amm_liquidity?format=csv`);
    expect([csv.status, csv.text]).toEqual([200, '']);
  });

  it('answers empty positions, at any date', async () => {
    for (const query of ['', '?date=2020-01-01', '?date=2099-01-01']) {
      const res = await get(`/v2/accounts/${ADDRESS}/amm_positions${query}`);
      expect([query, res.status, res.body]).toEqual([query, 200, { result: 'success', positions: [] }]);
    }
    // the accounts of the recordings too
    const [row] = await h.ch.query<{ account: string }>(`SELECT account FROM ${Table.BalanceChanges} LIMIT 1`);
    const res = await get(`/v2/accounts/${row.account}/amm_positions`);
    expect([res.status, res.body]).toEqual([200, { result: 'success', positions: [] }]);
  });

  it('answers the errors of the request first', async () => {
    const cases: [string, string][] = [
      [`/v2/accounts/${ADDRESS}/amm_liquidity?pool=x`, 'invalid pool'],
      [`/v2/accounts/${ADDRESS}/amm_liquidity?event=nope`, 'invalid event'],
      [`/v2/accounts/${ADDRESS}/amm_positions?date=nope`, 'invalid date format'],
    ];
    for (const [path, message] of cases) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
    }
  });
});

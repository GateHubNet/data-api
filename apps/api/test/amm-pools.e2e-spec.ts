import {
  AmmDailyRow,
  AmmPoolsRow,
  AmmPoolStatesRow,
  buildLedgerRows,
  computeAmmDaily,
  getNetworkProfile,
  parseContextFor,
  RatesService,
  recomputeAmmPools,
  Table,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { encodeAccountID } from 'ripple-address-codec';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead, explain, innerRead, isPageRead } from './support/plans';
import {
  BULK_BASES,
  BULK_LEDGERS,
  BULK_PER_PART,
  BULK_TX_INDEX,
  bulkLedger,
  insertBulk,
  LoggedRead,
  markerOf,
  readsOf,
} from './support/read-rows';

/**
 * The AMM pool routes on a real ClickHouse: `GET /v2/amm/pools` (the list), `/v2/amm/pools/:pool` and
 * `/v2/amm/pools/:base/:counter` (a pool by its account and by its pair), `/v2/amm/pools/:pool/history` (every state of the
 * pool, and with `interval=day` its days).
 *
 * Four kinds of data:
 *  - the recorded AMM ledgers (`xrpl-amm`: 16 mainnet ledgers, 148 state rows of 102 pools, one of them deleted), with the
 *    aggregator's jobs run over them (`recomputeAmmPools`, `computeAmmDaily`). The expected pools and states come from an
 *    oracle in plain JavaScript over the state rows the parser builds (`buildLedgerRows`), not from the code under test;
 *  - rows made by hand for the cases the recordings do not hold: two pools for one pair, a pool whose newest version is a
 *    deleted one, pools of equal value, a set of days that no longer holds a pool, a row written twice, a state above the
 *    committed head;
 *  - a bulk of four parts for the reads (`read_rows` and EXPLAIN, as `paged-reads.e2e-spec.ts`);
 *  - the Xahau ledgers (no AMM there).
 */

const NATIVE = 'XRP';
const RIPPLE_EPOCH = 946_684_800;
const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** The same object without the keys that are undefined or null: what the API leaves out. */
const defined = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
/**
 * A value of a pool as the API writes it: a plain decimal of eight significant digits, never the exponent form, trailing
 * zeros dropped (123 is "123", 99999999.5 is "100000000", 1e-7 is "0.0000001"). Worked out here with `precision()` of
 * BigNumber, apart from the code under test.
 */
const fixed8 = (n: number | string): string => new BigNumber(n).precision(8).toFixed();
const side = (currency: string, issuer: string): string => (issuer ? `${currency}+${issuer}` : currency);
/** `?a=1&b=2`, encoded. */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
const accountAt = (n: number): string => encodeAccountID(Buffer.from(n.toString(16).padStart(40, '0'), 'hex'));
const hashOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Inserts each group of rows as its own insert, so as its own part. Rows of one insert with the same key are collapsed on
 * insert (`optimize_on_insert` runs the merge of a ReplacingMergeTree over the block), so the versions of one pool or pool-day
 * that a reader has to choose between (they exist until a merge) have to come in different inserts.
 */
async function insertParts(h: Harness, table: Table, ...parts: unknown[][]): Promise<void> {
  for (const rows of parts) await h.ch.insert(table, rows);
}

/** The pinned key order of the objects (written out here once more, apart from the code under test). */
const POOL_KEYS = [
  'amm_account',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'lp_currency',
  'trading_fee',
  'auction_slot',
  'value_native',
  'created_ledger',
  'created_by',
  'last_ledger',
  'deleted',
];
const SLOT_KEYS = ['holder', 'price', 'discounted_fee', 'expiration'];
const STATE_KEYS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'tx_type',
  'executed_time',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'lp_currency',
  'trading_fee',
  'auction_slot',
  'deleted',
];
const DAY_KEYS = [
  'amm_account',
  'date',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'swap_count',
  'volume_base',
  'volume_counter',
  'fees_base_est',
  'fees_counter_est',
  'deposit_count',
  'withdraw_count',
  'liquidity_in_base',
  'liquidity_in_counter',
  'liquidity_out_base',
  'liquidity_out_counter',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'value_native',
];

type Obj = Record<string, unknown>;

/** The keys of an object are those of `order` that it has, in that order (a key that is not in `order` is a failure). */
function keyOrderOf(object: Obj, order: string[]): { keys: string[]; expected: string[] } {
  const keys = Object.keys(object);
  const expected = order.filter((k) => keys.includes(k));
  return { keys, expected };
}

/** Objects equal to the expected ones, key by key and in the pinned order of the keys (also inside `auction_slot`). */
function expectObjects(actual: Obj[], expected: Obj[], order: string[], label: unknown = ''): void {
  expect([label, actual]).toEqual([label, expected]);
  actual.forEach((object, i) => {
    const { keys, expected: ordered } = keyOrderOf(object, order);
    expect([label, i, keys]).toEqual([label, i, ordered]);
    const slot = object.auction_slot as Obj | undefined;
    if (slot !== undefined) {
      const slotKeys = keyOrderOf(slot, SLOT_KEYS);
      expect([label, i, slotKeys.keys]).toEqual([label, i, slotKeys.expected]);
    }
  });
}

// =====================================================================================================================
// The oracle: the pools of the recorded ledgers, in plain JavaScript

const FILL = [
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'lp_currency',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
] as const;
type FillKey = (typeof FILL)[number];
type Values = Record<FillKey, string | number | null>;
const NO_VALUES = Object.fromEntries(FILL.map((k) => [k, null])) as Values;
type Filled = Omit<AmmPoolStatesRow, FillKey> & Values;

const byKey = (a: { ledger_index: number; tx_index: number }, b: { ledger_index: number; tx_index: number }): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

/** Every row with the value of each filled column its own, or else the newest earlier one: oldest first. */
function carried(rows: AmmPoolStatesRow[], before: Values = NO_VALUES): Filled[] {
  let current = { ...before };
  return [...rows].sort(byKey).map((row) => {
    current = Object.fromEntries(FILL.map((k) => [k, row[k] ?? current[k]])) as Values;
    return { ...row, ...current };
  });
}

const slotOf = (v: Values): Obj | undefined => {
  const slot = defined({
    holder: v.auction_holder,
    price: v.auction_price,
    discounted_fee: v.auction_discounted_fee,
    expiration: v.auction_expiration === null ? null : iso(RIPPLE_EPOCH + Number(v.auction_expiration)),
  });
  return Object.keys(slot).length === 0 ? undefined : slot;
};

/** The state the API serves for a row whose values are already carried forward. */
function stateOf(r: Filled): Obj {
  return defined({
    amm_account: r.amm_account,
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    tx_hash: r.tx_hash,
    tx_type: r.tx_type,
    executed_time: iso(r.close_time),
    base_currency: r.base_currency,
    base_issuer: r.base_issuer || undefined,
    counter_currency: r.counter_currency,
    counter_issuer: r.counter_issuer || undefined,
    reserve_base: r.reserve_base,
    reserve_counter: r.reserve_counter,
    lp_supply: r.lp_supply,
    lp_currency: r.lp_currency,
    trading_fee: r.trading_fee,
    auction_slot: slotOf(r),
    deleted: r.deleted === 1,
  });
}

/** The pool as the API serves it, from its carried rows (the last one is the pool) and the value the jobs wrote. */
function poolOf(
  rows: Filled[],
  created: { created_ledger: number; created_by: string } | undefined,
  value: number | null,
): Obj {
  const last = rows[rows.length - 1];
  return defined({
    amm_account: last.amm_account,
    base_currency: last.base_currency,
    base_issuer: last.base_issuer || undefined,
    counter_currency: last.counter_currency,
    counter_issuer: last.counter_issuer || undefined,
    reserve_base: last.reserve_base,
    reserve_counter: last.reserve_counter,
    lp_supply: last.lp_supply,
    lp_currency: last.lp_currency,
    trading_fee: last.trading_fee,
    auction_slot: slotOf(last),
    value_native: last.deleted === 1 || value === null ? undefined : fixed8(value),
    created_ledger: created?.created_ledger,
    created_by: created?.created_by,
    last_ledger: last.ledger_index,
    deleted: last.deleted === 1,
  });
}

const CONTEXT = parseContextFor(getNetworkProfile('xrpl'));
const BUILT = fixtureSource('xrpl-amm')
  .list()
  .map((ledger) => buildLedgerRows(ledger, CONTEXT));
const STATES = BUILT.flatMap((b) => b.ammPoolStates);
const CREATES = BUILT.flatMap((b) => b.ammLiquidity)
  .filter((l) => l.event === 'create')
  .sort(byKey);
const ROWS_OF = new Map<string, AmmPoolStatesRow[]>();
for (const row of STATES) ROWS_OF.set(row.amm_account, [...(ROWS_OF.get(row.amm_account) ?? []), row]);
for (const rows of ROWS_OF.values()) rows.sort(byKey);
const ACCOUNTS = [...ROWS_OF.keys()].sort(compare);
const DELETED = ACCOUNTS.filter((a) => ROWS_OF.get(a)!.at(-1)!.deleted === 1);
const createdOf = (account: string): { created_ledger: number; created_by: string } | undefined => {
  const made = CREATES.find((c) => c.amm_account === account);
  return made ? { created_ledger: made.ledger_index, created_by: made.account } : undefined;
};
const DAYS = [...new Set(STATES.map((s) => new Date(s.close_time * 1000).toISOString().slice(0, 10)))].sort();

/** A pool with several rows in one ledger (the same ledger holds several of its transactions). */
const sameLedger = (rows: AmmPoolStatesRow[]): number => {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.ledger_index, (counts.get(r.ledger_index) ?? 0) + 1);
  return Math.max(...counts.values());
};
/** The pool with most rows in one ledger, then most rows. */
const BUSY = [...ACCOUNTS].sort(
  (a, b) =>
    sameLedger(ROWS_OF.get(b)!) - sameLedger(ROWS_OF.get(a)!) ||
    ROWS_OF.get(b)!.length - ROWS_OF.get(a)!.length ||
    compare(a, b),
)[0];
/** The pool with most rows in the most ledgers: its nulls differ from row to row (deposits, withdrawals, bids, swaps). */
const LONG = [...ACCOUNTS].sort(
  (a, b) =>
    new Set(ROWS_OF.get(b)!.map((r) => r.ledger_index)).size -
      new Set(ROWS_OF.get(a)!.map((r) => r.ledger_index)).size || compare(a, b),
)[0];

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  pools: Obj[];
}
interface HistoryBody {
  result: string;
  count: number;
  marker?: string;
  history: Obj[];
}
interface DaysBody {
  result: string;
  count: number;
  marker?: string;
  days: Obj[];
}

/** The base64url JSON marker of a key. */
const decodeMarker = (marker: string): unknown => JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
const lines = (text: string): string[] => text.split('\n');

/** What an `EXPLAIN indexes = 1` says about the primary key of each read of a MergeTree table, in plan order. */
interface PrimaryKeyIndex {
  keys: string[];
  condition: string;
  parts: [number, number];
  granules: [number, number];
}
function primaryKeys(plan: string): PrimaryKeyIndex[] {
  const text = plan.replace(/[│├└─]/g, ' ');
  return [
    ...text.matchAll(
      /PrimaryKey\s+Keys:\s+((?:\w+\s+)+?)Condition: ([^\n]*)\n\s+Parts: (\d+)\/(\d+)\n\s+Granules: (\d+)\/(\d+)/g,
    ),
  ].map((m) => ({
    keys: m[1].trim().split(/\s+/),
    condition: m[2],
    parts: [Number(m[3]), Number(m[4])],
    granules: [Number(m[5]), Number(m[6])],
  }));
}

// =====================================================================================================================
describe('the AMM pool routes over the recorded AMM ledgers', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  /** The value the job wrote for each pool, and the days it computed. */
  const values = new Map<string, number | null>();
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);

  /** The pools as the API should list them with the default filter: newest state of each, by value then account. */
  function expectedPools(include: (account: string) => boolean = () => true): Obj[] {
    const all = ACCOUNTS.filter(include).map((account) => {
      const rows = carried(ROWS_OF.get(account)!);
      const last = rows[rows.length - 1];
      const native =
        last.base_currency === NATIVE && last.base_issuer === ''
          ? 'base'
          : last.counter_currency === NATIVE && last.counter_issuer === ''
            ? 'counter'
            : '';
      const reserve = native === 'base' ? last.reserve_base : native === 'counter' ? last.reserve_counter : null;
      const value: number | null =
        last.deleted === 1
          ? null
          : native !== '' && reserve !== null
            ? new BigNumber(reserve as string).times(2).toNumber()
            : (values.get(account) ?? null);
      return { account, value, object: poolOf(rows, createdOf(account), value) };
    });
    all.sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? compare(a.account, b.account) : a.value === null ? 1 : -1;
      }
      return b.value - a.value || compare(a.account, b.account);
    });
    return all.map((p) => p.object);
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const rates = new RatesService(h.ch, NATIVE);
    expect(await recomputeAmmPools(h.ch, rates, ACCOUNTS)).toBe(ACCOUNTS.length);
    for (const day of DAYS) await computeAmmDaily(h.ch, rates, new Date(`${day}T00:00:00Z`));
    const written = await h.ch.query<{ amm_account: string; value_native: number | null }>(
      `SELECT amm_account, argMax(value_native, version) AS value_native FROM ${Table.AmmPools} GROUP BY amm_account`,
    );
    for (const w of written) values.set(w.amm_account, w.value_native);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: 102 pools, one deleted, some with a value and some without, rows of one ledger', () => {
    expect(ACCOUNTS).toHaveLength(102);
    expect(DELETED).toHaveLength(1);
    expect(values.size).toBe(102);
    const live = ACCOUNTS.filter((a) => !DELETED.includes(a));
    expect(live.filter((a) => values.get(a) === null).length).toBeGreaterThanOrEqual(1);
    expect(live.filter((a) => values.get(a) !== null).length).toBeGreaterThanOrEqual(20);
    expect(sameLedger(ROWS_OF.get(BUSY)!)).toBeGreaterThanOrEqual(3);
    expect(ROWS_OF.get(BUSY)!.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ROWS_OF.get(LONG)!.map((r) => r.ledger_index)).size).toBeGreaterThanOrEqual(5);
    // the nulls of a long pool differ from row to row: the carry-forward has something to do
    const long = ROWS_OF.get(LONG)!;
    expect(long.some((r) => r.lp_supply === null) && long.some((r) => r.lp_supply !== null)).toBe(true);
    expect(DAYS.length).toBeGreaterThanOrEqual(8);
  });

  // -- the list --------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools', () => {
    it('lists the pools that are not deleted, by value (the pools without one last) and then account, as the oracle has them', async () => {
      const res = await get('/v2/amm/pools?limit=1000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const expected = expectedPools((a) => !DELETED.includes(a));
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(101);
      expect(res.body).not.toHaveProperty('marker');
      expectObjects(res.body.pools, expected, POOL_KEYS);
      // the order itself: value descending, the pools without a value last, ties by account
      const served = (res.body as ListBody).pools.map((p) => p.value_native as string | undefined);
      const firstWithout = served.findIndex((v) => v === undefined);
      expect(firstWithout).toBeGreaterThan(0);
      expect(served.slice(firstWithout).every((v) => v === undefined)).toBe(true);
    });

    it('include_deleted lists the deleted pool too, last (it has no value), and as a deleted pool', async () => {
      for (const flag of ['true', 'TRUE', 'xtruex']) {
        const res = await get(`/v2/amm/pools?limit=1000&include_deleted=${flag}`);
        expect([flag, res.status, res.body.count]).toEqual([flag, 200, 102]);
        expectObjects(res.body.pools, expectedPools(), POOL_KEYS, flag);
        const gone = (res.body as ListBody).pools.find((p) => p.amm_account === DELETED[0]);
        expect(gone).toMatchObject({ deleted: true });
        expect(gone).not.toHaveProperty('value_native');
      }
      for (const flag of ['false', '', '1', 'yes', '0']) {
        const res = await get(`/v2/amm/pools?limit=1000&include_deleted=${flag}`);
        expect([flag, res.body.count]).toEqual([flag, 101]);
      }
    });

    it('serves every pool with deleted a boolean and no key that is null', async () => {
      const res = await get('/v2/amm/pools?limit=1000&include_deleted=true');
      for (const pool of (res.body as ListBody).pools) {
        expect(typeof pool.deleted).toBe('boolean');
        expect(Object.values(pool).every((v) => v !== null && v !== undefined)).toBe(true);
      }
    });

    it('pages with the marker: the pages concatenate to the whole list, for any limit, and the marker is (value, account)', async () => {
      const whole = (await get('/v2/amm/pools?limit=1000&include_deleted=true')).body as ListBody;
      for (const limit of [1, 2, 7, 50, 101]) {
        const walked = await pages<ListBody>('/v2/amm/pools?include_deleted=true', limit, 'pools');
        expect([limit, walked.flatMap((p) => p.pools)]).toEqual([limit, whole.pools]);
        expect([limit, walked.map((p) => p.count)]).toEqual([
          limit,
          walked.map((_, i) => (i < walked.length - 1 ? limit : whole.pools.length - limit * i)),
        ]);
        expect(walked[walked.length - 1].marker).toBeUndefined();
      }
      // the marker names the last pool of the page by its value as stored and its account, in this order
      const first = (await get('/v2/amm/pools?limit=3')).body as ListBody;
      const lastOfPage = first.pools[2];
      expect(decodeMarker(first.marker as string)).toEqual([
        values.get(lastOfPage.amm_account as string),
        lastOfPage.amm_account,
      ]);
      // and past the pool without a value it names that
      const withoutValue = whole.pools.filter((p) => p.value_native === undefined && p.deleted === false);
      expect(withoutValue.length).toBeGreaterThan(2);
      const atNull = (await get(`/v2/amm/pools?limit=${whole.pools.indexOf(withoutValue[0]) + 1}`)).body as ListBody;
      expect(decodeMarker(atNull.marker as string)).toEqual([null, withoutValue[0].amm_account]);
    });

    it('a page that ends inside a run of pools without a value, or between two of equal value, continues exactly', async () => {
      const whole = (await get('/v2/amm/pools?limit=1000')).body as ListBody;
      const index = whole.pools.findIndex((p) => p.value_native === undefined);
      for (const at of [index - 1, index, index + 1, index + 2]) {
        const head = (await get(`/v2/amm/pools?limit=${at}`)).body as ListBody;
        const rest = (await get(`/v2/amm/pools?limit=1000&marker=${head.marker}`)).body as ListBody;
        expect([at, [...head.pools, ...rest.pools]]).toEqual([at, whole.pools]);
      }
    });

    it('sets the Link header on a page with a next one, for JSON and CSV, and none on the last page', async () => {
      const page = await get('/v2/amm/pools?limit=5&asset=XRP');
      expect(page.headers.link).toBe(
        `<${new URL(page.request.url).origin}/v2/amm/pools?limit=5&asset=XRP&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get('/v2/amm/pools?limit=5&asset=XRP&format=csv');
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/amm/pools?limit=5&asset=XRP&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get('/v2/amm/pools?limit=1000')).headers.link).toBeUndefined();
      expect((await get('/v2/amm/pools?limit=1000&format=csv')).headers.link).toBeUndefined();
    });

    it('filters by asset: the pools that have it on either side', async () => {
      const wanted = expectedPools((a) => !DELETED.includes(a));
      const has = (pool: Obj, currency: string, issuer: string): boolean =>
        (pool.base_currency === currency && (pool.base_issuer ?? '') === issuer) ||
        (pool.counter_currency === currency && (pool.counter_issuer ?? '') === issuer);
      const usd = wanted.find((p) => p.base_currency === 'USD' || p.counter_currency === 'USD')!;
      const usdSide = usd.base_currency === 'USD' ? 'base' : 'counter';
      const usdIssuer = usd[`${usdSide}_issuer`] as string;
      const cases: [string, (p: Obj) => boolean][] = [
        ['asset=XRP', (p) => has(p, 'XRP', '')],
        [`asset=USD+${usdIssuer}`, (p) => has(p, 'USD', usdIssuer)],
        [`asset=${usdSide === 'base' ? 'usd' : 'USD'}+${usdIssuer}`, (p) => has(p, 'USD', usdIssuer)],
        [`asset2=USD+${usdIssuer}`, (p) => has(p, 'USD', usdIssuer)],
        [`asset=XRP&asset2=USD+${usdIssuer}`, (p) => has(p, 'XRP', '') && has(p, 'USD', usdIssuer)],
        [`asset=USD+${usdIssuer}&asset2=XRP`, (p) => has(p, 'XRP', '') && has(p, 'USD', usdIssuer)],
        ['asset=XRP&asset2=XRP', (p) => has(p, 'XRP', '')],
        ['asset=EUR+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', () => false],
        ['asset=&asset2=', () => true],
      ];
      for (const [query, keep] of cases) {
        const res = await get(`/v2/amm/pools?limit=1000&${query.replace(/\+/g, '%2B')}`);
        const expected = wanted.filter(keep);
        expect([query, res.status, res.body.count]).toEqual([query, 200, expected.length]);
        expect([query, res.body.pools]).toEqual([query, expected]);
      }
      // the set is not trivial
      const xrp = (await get('/v2/amm/pools?limit=1000&asset=XRP')).body as ListBody;
      expect(xrp.count).toBeGreaterThan(20);
      expect(xrp.count).toBeLessThan(101);
      expect(
        ((await get(`/v2/amm/pools?asset=XRP&asset2=USD%2B${usdIssuer}`)).body as ListBody).count,
      ).toBeGreaterThanOrEqual(1);
      // a filter that matches nothing is an empty list, not an error
      const none = await get('/v2/amm/pools?asset=EUR%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q');
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ result: 'success', count: 0, pools: [] });
    });

    it('a filter applies to the deleted pool only with include_deleted, and pages like the whole list', async () => {
      const gone = expectedPools().find((p) => p.deleted === true)!;
      const asset = encodeURIComponent(
        side(gone.base_currency as string, (gone.base_issuer as string | undefined) ?? ''),
      );
      const without = (await get(`/v2/amm/pools?limit=1000&asset=${asset}`)).body as ListBody;
      const withIt = (await get(`/v2/amm/pools?limit=1000&asset=${asset}&include_deleted=true`)).body as ListBody;
      expect(without.pools.some((p) => p.amm_account === gone.amm_account)).toBe(false);
      expect(withIt.pools.some((p) => p.amm_account === gone.amm_account)).toBe(true);
      expect(withIt.count).toBe(without.count + 1);
      const walked = await pages<ListBody>(`/v2/amm/pools?asset=${asset}&include_deleted=true`, 2, 'pools');
      expect(walked.flatMap((p) => p.pools)).toEqual(withIt.pools);
    });

    it('answers the asset errors of the exchange routes for an asset that is none', async () => {
      const cases: [string, string][] = [
        ['asset=USD', 'issuer is required'],
        ['asset=XRP%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', 'XRP cannot have an issuer'],
        ['asset=USD%2Bnonsense', 'invalid issuer address'],
        ['asset2=USD', 'issuer is required'],
        ['asset2=XRP%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', 'XRP cannot have an issuer'],
        ['asset2=USD%2Bnonsense', 'invalid issuer address'],
        ['asset=%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', 'currency is required'],
        ['asset=XRP&asset2=USD', 'issuer is required'],
      ];
      for (const [query, message] of cases) {
        const res = await get(`/v2/amm/pools?${query}`);
        expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
      }
    });

    it('ignores the params it does not know, and takes the first of a repeated one', async () => {
      const plain = (await get('/v2/amm/pools?limit=4')).body;
      const noisy = (await get('/v2/amm/pools?limit=4&whatever=1&descending=true&interval=day&start=nonsense&limit=9'))
        .body;
      expect(noisy).toEqual(plain);
      const twice = (await get('/v2/amm/pools?limit=4&limit=9&asset=XRP&asset=EUR')).body as ListBody;
      expect(twice.count).toBe(4);
      expect(twice.pools.every((p) => p.base_currency === 'XRP' || p.counter_currency === 'XRP')).toBe(true);
    });

    it('limit: default 200, a decimal is cut, below one is the default, over 1000 is 1000, a text is the default', async () => {
      const count = async (limit: string): Promise<number> =>
        ((await get(`/v2/amm/pools?include_deleted=true&limit=${limit}`)).body as ListBody).count;
      expect(await count('2.9')).toBe(2);
      expect(await count('1')).toBe(1);
      for (const limit of ['0', '-3', 'abc', '', '5000', '1000', 'all']) {
        expect([limit, await count(limit)]).toEqual([limit, 102]);
      }
      expect(((await get('/v2/amm/pools?include_deleted=true')).body as ListBody).count).toBe(102);
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      const bad = [
        '!!!',
        Buffer.from('nope').toString('base64url'),
        markerOf([1]),
        markerOf([1, 'rA', 3]),
        markerOf(['1', 'rA']),
        markerOf([1, 2]),
        Buffer.from('[true,"rA"]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
      ];
      for (const marker of bad) {
        const res = await get(`/v2/amm/pools?marker=${marker}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('a marker past the last pool is an empty page', async () => {
      const res = await get(`/v2/amm/pools?marker=${markerOf([0, 'rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'])}&limit=1000`);
      // the pools without a value follow a value of 0, so only they are left
      expect(res.status).toBe(200);
      expect((res.body as ListBody).pools.every((p) => p.value_native === undefined)).toBe(true);
      const end = await get(
        `/v2/amm/pools?marker=${Buffer.from(JSON.stringify([null, 'rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'])).toString('base64url')}`,
      );
      expect(end.body).toEqual({ result: 'success', count: 0, pools: [] });
    });

    it('format=csv: text/csv, one row a pool, the same columns for every page, the slot as four columns', async () => {
      const res = await get('/v2/amm/pools?format=csv&limit=1000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('amm pools'));
      const table = lines(res.text).map((l) => l.split(','));
      expect(table).toHaveLength(1 + 101);
      const header = [
        'amm_account',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'reserve_base',
        'reserve_counter',
        'lp_supply',
        'lp_currency',
        'trading_fee',
        'auction_slot.holder',
        'auction_slot.price',
        'auction_slot.discounted_fee',
        'auction_slot.expiration',
        'value_native',
        'created_ledger',
        'created_by',
        'last_ledger',
        'deleted',
      ].map((c) => `"${c}"`);
      expect(table[0]).toEqual(header);
      const expected = expectedPools((a) => !DELETED.includes(a));
      expect(table[1][0]).toBe(`"${expected[0].amm_account}"`);
      expect(table[1].at(-1)).toBe('"false"');
      // every page of a walk has the same header, whichever pools it holds
      for (const limit of [3]) {
        let marker: string | undefined;
        let page = 0;
        do {
          const part = await get(`/v2/amm/pools?format=csv&limit=${limit}${marker ? `&marker=${marker}` : ''}`);
          expect([page, lines(part.text)[0].split(',')]).toEqual([page, header]);
          marker = ((await get(`/v2/amm/pools?limit=${limit}${marker ? `&marker=${marker}` : ''}`)).body as ListBody)
            .marker;
          page += 1;
        } while (marker && page < 40);
      }
    });

    it('an empty CSV is empty; an error is still JSON; any other format is JSON', async () => {
      const empty = await get('/v2/amm/pools?format=csv&asset=EUR%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q');
      expect([empty.status, empty.text]).toEqual([200, '']);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      const bad = await get('/v2/amm/pools?format=csv&asset=USD');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'issuer is required' }]);
      expect((await get('/v2/amm/pools?format=CSV&limit=1')).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        expect((await get(`/v2/amm/pools?format=${format}&limit=1`)).headers['content-type']).toMatch(
          /application\/json/,
        );
      }
    });
  });

  // -- one pool --------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool', () => {
    it('serves the pool, as the list does and as the oracle has it, deleted ones too', async () => {
      const expected = new Map(expectedPools().map((p) => [p.amm_account as string, p]));
      expect(expected.size).toBe(102);
      for (const account of ACCOUNTS) {
        const res = await get(`/v2/amm/pools/${account}`);
        expect([account, res.status, res.body.result]).toEqual([account, 200, 'success']);
        expect(Object.keys(res.body)).toEqual(['result', 'pool']);
        expectObjects([res.body.pool], [expected.get(account)!], POOL_KEYS, account);
      }
      const gone = (await get(`/v2/amm/pools/${DELETED[0]}`)).body.pool as Obj;
      expect(gone.deleted).toBe(true);
      expect(gone).not.toHaveProperty('value_native');
    });

    it('serves the newest state of the pool: reserves from the last swap, the fee from the last vote, the slot from the last bid', async () => {
      const rows = carried(ROWS_OF.get(LONG)!);
      const last = rows[rows.length - 1];
      const own = ROWS_OF.get(LONG)!;
      // some value of the pool comes from a row older than the newest one
      expect(FILL.some((k) => own[own.length - 1][k] === null && last[k] !== null)).toBe(true);
      const pool = (await get(`/v2/amm/pools/${LONG}`)).body.pool as Obj;
      expect(pool).toMatchObject(
        defined({ reserve_base: last.reserve_base, lp_supply: last.lp_supply, trading_fee: last.trading_fee }),
      );
    });

    it('is 404 pool not found for an address that is no pool, and 400 invalid pool for a text that is no address', async () => {
      const unknown = await get('/v2/amm/pools/rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q');
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      for (const bad of [
        'rnotanaddress',
        'XRP',
        ACCOUNTS[0].slice(0, -1),
        ACCOUNTS[0].toLowerCase(),
        `${ACCOUNTS[0]}x`,
        '0',
      ]) {
        const res = await get(`/v2/amm/pools/${bad}`);
        expect([bad, res.status, res.body]).toEqual([bad, 400, { result: 'error', message: 'invalid pool' }]);
      }
      // a valid address with a checksum slip
      const slip = `${ACCOUNTS[0].slice(0, 5)}${ACCOUNTS[0][5] === 'a' ? 'b' : 'a'}${ACCOUNTS[0].slice(6)}`;
      expect((await get(`/v2/amm/pools/${slip}`)).status).toBe(400);
    });
  });

  // -- the pair --------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:base/:counter', () => {
    it('serves the pool of the pair in either order, the same pool as by its account', async () => {
      const expected = new Map(expectedPools().map((p) => [p.amm_account as string, p]));
      for (const account of ACCOUNTS) {
        const pool = expected.get(account)!;
        const base = side(pool.base_currency as string, (pool.base_issuer as string | undefined) ?? '');
        const counter = side(pool.counter_currency as string, (pool.counter_issuer as string | undefined) ?? '');
        for (const path of [`/v2/amm/pools/${base}/${counter}`, `/v2/amm/pools/${counter}/${base}`]) {
          const res = await get(path);
          expect([path, res.status]).toEqual([path, 200]);
          expect(Object.keys(res.body)).toEqual(['result', 'pool']);
          expect([path, res.body.pool]).toEqual([path, pool]);
        }
      }
    });

    it('the pair of a pool that was deleted resolves to it, as there is no other', async () => {
      const gone = (await get(`/v2/amm/pools/${DELETED[0]}`)).body.pool as Obj;
      const base = side(gone.base_currency as string, (gone.base_issuer as string | undefined) ?? '');
      const counter = side(gone.counter_currency as string, (gone.counter_issuer as string | undefined) ?? '');
      const res = await get(`/v2/amm/pools/${counter}/${base}`);
      expect([res.status, res.body.pool]).toEqual([200, gone]);
    });

    it('is 404 pool not found for a pair no pool has, and a pair is checked as the exchange routes check it', async () => {
      const missing = await get('/v2/amm/pools/EUR+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/XRP');
      expect([missing.status, missing.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const same = await get('/v2/amm/pools/XRP/XRP');
      expect([same.status, same.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const issuer = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
      const cases: [string, string][] = [
        ['/USD/XRP', 'base issuer is required'],
        ['/XRP/USD', 'counter issuer is required'],
        [`/XRP+${issuer}/USD+${issuer}`, 'XRP cannot have an issuer'],
        [`/USD+${issuer}/XRP+${issuer}`, 'XRP cannot have an issuer'],
        ['/USD+nonsense/XRP', 'invalid base issuer address'],
        [`/XRP/USD+nonsense`, 'invalid counter issuer address'],
        [`/%2B${issuer}/XRP`, 'base currency is required'],
      ];
      for (const [path, message] of cases) {
        const res = await get(`/v2/amm/pools${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });
  });

  // -- the history -----------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool/history', () => {
    const everyState = (account: string): Obj[] => carried(ROWS_OF.get(account)!).map(stateOf);

    it('serves every state of every pool with the values carried forward, as the oracle has them', async () => {
      for (const account of ACCOUNTS) {
        const res = await get(`/v2/amm/pools/${account}/history?limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'count', 'history']);
        expect(res.body.count).toBe(ROWS_OF.get(account)!.length);
        expectObjects(res.body.history, everyState(account), STATE_KEYS, account);
      }
    });

    it('carries a value forward from an older row; a row that has one of its own keeps it', async () => {
      const rows = ROWS_OF.get(LONG)!;
      const history = ((await get(`/v2/amm/pools/${LONG}/history`)).body as HistoryBody).history;
      // the oracle must have something to carry: a row with a null whose served value is not null
      const carriedSomething = rows.some((r, i) =>
        FILL.some((k) => r[k] === null && history[i][k === 'auction_holder' ? 'auction_slot' : k] !== undefined),
      );
      expect(carriedSomething).toBe(true);
      history.forEach((state, i) => {
        // the reserves of a swap row are its own, whatever the older rows say
        if (rows[i].reserve_base !== null) expect(state.reserve_base).toBe(rows[i].reserve_base);
        if (rows[i].lp_supply !== null) expect(state.lp_supply).toBe(rows[i].lp_supply);
      });
    });

    it('is ascending by default and descending with descending=true, the same states the other way round', async () => {
      for (const account of [BUSY, LONG]) {
        const asc = ((await get(`/v2/amm/pools/${account}/history?limit=1000`)).body as HistoryBody).history;
        const desc = ((await get(`/v2/amm/pools/${account}/history?limit=1000&descending=true`)).body as HistoryBody)
          .history;
        expect([account, desc]).toEqual([account, [...asc].reverse()]);
        // each state has its values carried in the order of time, whichever way the list runs
        expectObjects(desc, everyState(account).reverse(), STATE_KEYS, account);
      }
    });

    it('pages with the marker (ledger_index, tx_index): pages of 1, 2 and 4 concatenate to the whole, both ways, several rows to a ledger', async () => {
      expect(sameLedger(ROWS_OF.get(BUSY)!)).toBeGreaterThanOrEqual(3);
      for (const account of [BUSY, LONG, ACCOUNTS.find((a) => !DELETED.includes(a) && ROWS_OF.get(a)!.length === 1)!]) {
        for (const descending of [false, true]) {
          const whole = everyState(account);
          const expected = descending ? [...whole].reverse() : whole;
          for (const limit of [1, 2, 4]) {
            const walked = await pages<HistoryBody>(
              `/v2/amm/pools/${account}/history?descending=${descending}`,
              limit,
              'history',
            );
            expect([account, descending, limit, walked.flatMap((p) => p.history)]).toEqual([
              account,
              descending,
              limit,
              expected,
            ]);
            for (const [i, page] of walked.entries()) {
              expect(page.count).toBe(page.history.length);
              expect([account, limit, i, page.marker === undefined]).toEqual([
                account,
                limit,
                i,
                i === walked.length - 1,
              ]);
            }
          }
        }
      }
    });

    it('the marker is the (ledger_index, tx_index) of the last row of the page', async () => {
      const rows = [...ROWS_OF.get(BUSY)!];
      const first = (await get(`/v2/amm/pools/${BUSY}/history?limit=2`)).body as HistoryBody;
      expect(decodeMarker(first.marker as string)).toEqual([rows[1].ledger_index, rows[1].tx_index]);
      const desc = (await get(`/v2/amm/pools/${BUSY}/history?limit=2&descending=true`)).body as HistoryBody;
      const last = rows[rows.length - 2];
      expect(decodeMarker(desc.marker as string)).toEqual([last.ledger_index, last.tx_index]);
    });

    it('a page that starts inside a ledger carries the rows of that ledger before it, and the older ledgers before those', async () => {
      const rows = carried(ROWS_OF.get(BUSY)!);
      for (let cut = 1; cut < rows.length; cut++) {
        const after = rows[cut - 1];
        const marker = markerOf([after.ledger_index, after.tx_index]);
        const asc = ((await get(`/v2/amm/pools/${BUSY}/history?limit=2&marker=${marker}`)).body as HistoryBody).history;
        expect([cut, asc]).toEqual([cut, rows.slice(cut, cut + 2).map(stateOf)]);
      }
      for (let cut = 1; cut < rows.length; cut++) {
        const before = rows[cut];
        const marker = markerOf([before.ledger_index, before.tx_index]);
        const desc = (
          (await get(`/v2/amm/pools/${BUSY}/history?limit=2&descending=true&marker=${marker}`)).body as HistoryBody
        ).history;
        expect([cut, desc]).toEqual([
          cut,
          rows
            .slice(Math.max(0, cut - 2), cut)
            .reverse()
            .map(stateOf),
        ]);
      }
    });

    it('start and end are dates: the states of the ledgers that closed in them, with the values of the states before start', async () => {
      const rows = carried(ROWS_OF.get(LONG)!);
      const ledgers = [...new Set(rows.map((r) => r.ledger_index))];
      expect(ledgers.length).toBeGreaterThanOrEqual(5);
      const closeOf = (ledger: number): number => rows.find((r) => r.ledger_index === ledger)!.close_time;
      const when = (ledger: number, shift = 0): string => iso(closeOf(ledger) + shift).replace('Z', '+00:00');
      for (const [from, to] of [
        [1, 3],
        [2, 4],
        [3, ledgers.length - 1],
        [1, 1],
      ]) {
        const query = qs({ start: when(ledgers[from]), end: when(ledgers[to]), limit: 1000 });
        const res = await get(`/v2/amm/pools/${LONG}/history${query}`);
        const expected = rows
          .filter((r) => r.ledger_index >= ledgers[from] && r.ledger_index <= ledgers[to])
          .map(stateOf);
        expect([from, to, res.status, res.body.history]).toEqual([from, to, 200, expected]);
      }
      // start alone, end alone; end is exclusive of the next second
      const startOnly = await get(`/v2/amm/pools/${LONG}/history${qs({ start: when(ledgers[3]), limit: 1000 })}`);
      expect(startOnly.body.history).toEqual(rows.filter((r) => r.ledger_index >= ledgers[3]).map(stateOf));
      const endBefore = await get(`/v2/amm/pools/${LONG}/history${qs({ end: when(ledgers[2], -1), limit: 1000 })}`);
      expect(endBefore.body.history).toEqual(rows.filter((r) => r.ledger_index < ledgers[2]).map(stateOf));
      // a window without a ledger holds no state, and the pool is still there
      const empty = await get(`/v2/amm/pools/${LONG}/history?start=2030-01-01`);
      expect([empty.status, empty.body]).toEqual([200, { result: 'success', count: 0, history: [] }]);
    });

    it('a window that starts after the first rows still serves the carried values (they come from before start)', async () => {
      const rows = carried(ROWS_OF.get(LONG)!);
      const ledgers = [...new Set(rows.map((r) => r.ledger_index))];
      // find the first ledger from which a served value comes from an earlier ledger
      const target = ledgers.find((l, i) => {
        if (i === 0) return false;
        const own = ROWS_OF.get(LONG)!.filter((r) => r.ledger_index === l);
        const out = rows.filter((r) => r.ledger_index === l);
        return FILL.some((k) => own.every((r) => r[k] === null) && out.every((r) => r[k] !== null));
      });
      expect(target).toBeDefined();
      const start = iso(rows.find((r) => r.ledger_index === target)!.close_time);
      const res = await get(`/v2/amm/pools/${LONG}/history${qs({ start, limit: 1000 })}`);
      const expected = rows.filter((r) => r.ledger_index >= (target as number)).map(stateOf);
      expectObjects(res.body.history, expected, STATE_KEYS);
    });

    it('sets the Link header on a page with a next one, for JSON and CSV', async () => {
      const page = await get(`/v2/amm/pools/${LONG}/history?limit=2&descending=true`);
      expect(page.headers.link).toBe(
        `<${new URL(page.request.url).origin}/v2/amm/pools/${LONG}/history?limit=2&descending=true&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get(`/v2/amm/pools/${LONG}/history?limit=2&descending=true&format=csv`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/amm/pools/${LONG}/history?limit=2&descending=true&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get(`/v2/amm/pools/${LONG}/history?limit=1000`)).headers.link).toBeUndefined();
    });

    it('format=csv: one row a state with the same columns for every page; named after the pool', async () => {
      const res = await get(`/v2/amm/pools/${LONG}/history?format=csv&limit=1000`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${LONG} - amm history`));
      const table = lines(res.text).map((l) => l.split(','));
      expect(table).toHaveLength(1 + ROWS_OF.get(LONG)!.length);
      const header = [
        'amm_account',
        'ledger_index',
        'tx_index',
        'tx_hash',
        'tx_type',
        'executed_time',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'reserve_base',
        'reserve_counter',
        'lp_supply',
        'lp_currency',
        'trading_fee',
        'auction_slot.holder',
        'auction_slot.price',
        'auction_slot.discounted_fee',
        'auction_slot.expiration',
        'deleted',
      ].map((c) => `"${c}"`);
      expect(table[0]).toEqual(header);
      for (const limit of [1, 2]) {
        const parts = await Promise.all(
          ROWS_OF.get(LONG)!.map(async (row) => {
            const text = (
              await get(
                `/v2/amm/pools/${LONG}/history?format=csv&limit=${limit}&marker=${markerOf([row.ledger_index, row.tx_index])}`,
              )
            ).text;
            return text === '' ? undefined : lines(text)[0].split(',');
          }),
        );
        for (const first of parts.filter((p) => p !== undefined)) expect(first).toEqual(header);
      }
      const empty = await get(`/v2/amm/pools/${LONG}/history?format=csv&start=2030-01-01`);
      expect([empty.status, empty.text]).toEqual([200, '']);
    });

    it('is 404 pool not found for an address that is no pool; 400 invalid pool; the path is not read as a pair', async () => {
      const unknown = await get('/v2/amm/pools/rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/history');
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const bad = await get('/v2/amm/pools/rnotanaddress/history');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid pool' }]);
      const asPair = await get('/v2/amm/pools/XRP/history');
      expect([asPair.status, asPair.body]).toEqual([400, { result: 'error', message: 'invalid pool' }]);
      // the pair route still takes a two-segment path that is no history
      const pair = await get(`/v2/amm/pools/${ACCOUNTS[0]}/rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q`);
      expect(pair.status).toBe(400);
      expect(pair.body.message).toBe('base issuer is required');
      // and a pool's history is its history, not its detail
      const history = await get(`/v2/amm/pools/${LONG}/history?limit=1`);
      expect(Object.keys(history.body)).toEqual(['result', 'count', 'marker', 'history']);
    });

    it('answers the parameter errors in the order start, end, limit (a number), interval, then marker', async () => {
      const cases: [string, number, string][] = [
        ['start=nonsense', 400, 'invalid start date format'],
        ['end=nonsense', 400, 'invalid end date format'],
        ['start=nonsense&end=nonsense', 400, 'invalid start date format'],
        ['interval=week', 400, 'invalid interval'],
        ['interval=hour', 400, 'invalid interval'],
        ['interval=DAY', 400, 'invalid interval'],
        ['interval=days', 400, 'invalid interval'],
        ['interval=week&start=nonsense', 400, 'invalid start date format'],
        ['marker=!!!', 400, 'invalid marker'],
        [`marker=${markerOf(['x', 1])}`, 400, 'invalid marker'],
        [`marker=${markerOf([1])}`, 400, 'invalid marker'],
        [`interval=day&marker=${markerOf([1, 2])}`, 400, 'invalid marker'],
        ['interval=day&marker=!!!', 400, 'invalid marker'],
        ['interval=week&marker=!!!', 400, 'invalid interval'],
      ];
      for (const [query, status, message] of cases) {
        const res = await get(`/v2/amm/pools/${LONG}/history?${query}`);
        expect([query, res.status, res.body]).toEqual([query, status, { result: 'error', message }]);
      }
      // an empty interval is none
      expect((await get(`/v2/amm/pools/${LONG}/history?interval=&limit=1`)).body).toHaveProperty('history');
      // the errors come before the pool is looked up
      expect((await get('/v2/amm/pools/rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/history?interval=week')).status).toBe(400);
    });

    it('ignores the params it does not know', async () => {
      const plain = (await get(`/v2/amm/pools/${LONG}/history?limit=3`)).body;
      expect((await get(`/v2/amm/pools/${LONG}/history?limit=3&asset=nonsense&include_deleted=true&x=1`)).body).toEqual(
        plain,
      );
    });

    it('limit: default 200, a decimal is cut, below one is the default, over 1000 is 1000, a text is the default', async () => {
      const all = ROWS_OF.get(BUSY)!.length;
      expect(all).toBeGreaterThanOrEqual(6);
      const count = async (limit: string, mode = ''): Promise<number> =>
        ((await get(`/v2/amm/pools/${BUSY}/history?limit=${limit}${mode}`)).body as HistoryBody).count;
      expect(await count('2.9')).toBe(2);
      expect(await count('1')).toBe(1);
      for (const limit of ['0', '-3', 'abc', '', '5000', '1000', 'all']) {
        expect([limit, await count(limit)]).toEqual([limit, all]);
      }
      expect(((await get(`/v2/amm/pools/${BUSY}/history`)).body as HistoryBody).count).toBe(all);
      // the days take the same limit: this pool has days, and the first page holds exactly one
      const days = await h.ch.query<{ day: string }>(
        `SELECT DISTINCT day FROM ${Table.AmmDaily} WHERE amm_account = {pool:String}`,
        { pool: BUSY },
      );
      expect(days.length).toBeGreaterThanOrEqual(1);
      expect(await count('1', '&interval=day')).toBe(1);
      expect(await count('1000', '&interval=day')).toBe(days.length);
    });
  });

  // -- the days --------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool/history?interval=day', () => {
    /** The rows of `amm_daily` that count for a pool: those of the version of the day's sentinel, as a plain SELECT. */
    async function storedDays(account: string): Promise<AmmDailyRow[]> {
      const rows = await h.ch.query<AmmDailyRow & { day_text: string }>(
        `SELECT toString(day) AS day_text, base_currency, base_issuer, counter_currency, counter_issuer, swap_count, volume_base, volume_counter,
                fees_base_est, fees_counter_est, deposit_count, withdraw_count, liquidity_in_base, liquidity_in_counter,
                liquidity_out_base, liquidity_out_counter, reserve_base, reserve_counter, lp_supply, trading_fee, value_native
           FROM ${Table.AmmDaily}
          WHERE amm_account = {account:String}
            AND (day, version) IN (SELECT day, max(version) FROM ${Table.AmmDaily} WHERE amm_account = '' GROUP BY day)
          ORDER BY day`,
        { account },
      );
      return rows.map((r) => ({ ...r, day: r.day_text }));
    }
    const dayOf = (account: string, r: Partial<AmmDailyRow> & { day: string }): Obj =>
      defined({
        amm_account: account,
        date: `${r.day}T00:00:00Z`,
        base_currency: r.base_currency,
        base_issuer: r.base_issuer || undefined,
        counter_currency: r.counter_currency,
        counter_issuer: r.counter_issuer || undefined,
        swap_count: Number(r.swap_count),
        volume_base: r.volume_base,
        volume_counter: r.volume_counter,
        fees_base_est: r.fees_base_est,
        fees_counter_est: r.fees_counter_est,
        deposit_count: Number(r.deposit_count),
        withdraw_count: Number(r.withdraw_count),
        liquidity_in_base: r.liquidity_in_base,
        liquidity_in_counter: r.liquidity_in_counter,
        liquidity_out_base: r.liquidity_out_base,
        liquidity_out_counter: r.liquidity_out_counter,
        reserve_base: r.reserve_base,
        reserve_counter: r.reserve_counter,
        lp_supply: r.lp_supply,
        trading_fee: r.trading_fee,
        value_native: r.value_native === null || r.value_native === undefined ? undefined : fixed8(r.value_native),
      });

    let swapper: string;
    beforeAll(async () => {
      const [busiest] = await h.ch.query<{ amm_account: string }>(
        `SELECT amm_account FROM ${Table.AmmDaily} WHERE amm_account != '' AND swap_count > 0
          GROUP BY amm_account ORDER BY count() DESC, amm_account LIMIT 1`,
      );
      swapper = busiest.amm_account;
    });

    it('serves the days of a pool from amm_daily: the amounts as stored, the counts as numbers, the sentinel never', async () => {
      const stored = await storedDays(swapper);
      expect(stored.length).toBeGreaterThanOrEqual(2);
      expect(stored.some((d) => Number(d.swap_count) > 0)).toBe(true);
      const res = await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1000`);
      expect([res.status, res.body.count]).toEqual([200, stored.length]);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'days']);
      expectObjects(
        res.body.days,
        stored.map((d) => dayOf(swapper, d)),
        DAY_KEYS,
      );
      expect((res.body as DaysBody).days.every((d) => d.amm_account === swapper)).toBe(true);
    });

    it('every pool with days serves them, as the SELECT has them, and the days of a pool are only its own', async () => {
      const withDays = await h.ch.query<{ amm_account: string }>(
        `SELECT DISTINCT amm_account FROM ${Table.AmmDaily} WHERE amm_account != '' ORDER BY amm_account`,
      );
      expect(withDays.length).toBeGreaterThanOrEqual(50);
      for (const { amm_account: account } of withDays) {
        const stored = await storedDays(account);
        const res = await get(`/v2/amm/pools/${account}/history?interval=day&limit=1000`);
        expect([account, res.status]).toEqual([account, 200]);
        expectObjects(
          res.body.days,
          stored.map((d) => dayOf(account, d)),
          DAY_KEYS,
          account,
        );
      }
    });

    it('is ascending by day by default and descending with descending=true; pages by day with the marker', async () => {
      const stored = (await storedDays(swapper)).map((d) => dayOf(swapper, d));
      for (const descending of [false, true]) {
        const expected = descending ? [...stored].reverse() : stored;
        for (const limit of [1, 2]) {
          const walked = await pages<DaysBody>(
            `/v2/amm/pools/${swapper}/history?interval=day&descending=${descending}`,
            limit,
            'days',
          );
          expect([descending, limit, walked.flatMap((p) => p.days)]).toEqual([descending, limit, expected]);
        }
      }
      const first = (await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1`)).body as DaysBody;
      // the marker names the day: unix seconds of its start
      expect(decodeMarker(first.marker as string)).toEqual([
        Date.parse(`${(await storedDays(swapper))[0].day}T00:00:00Z`) / 1000,
      ]);
    });

    it('start and end are dates: the days that start within them, whole', async () => {
      const stored = await storedDays(swapper);
      const days = stored.map((d) => d.day);
      expect(days.length).toBeGreaterThanOrEqual(2);
      const objects = new Map(stored.map((d) => [d.day, dayOf(swapper, d)]));
      const at = async (query: string): Promise<string[]> =>
        ((await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1000&${query}`)).body as DaysBody).days.map(
          (d) => String(d.date).slice(0, 10),
        );
      expect(await at(`start=${days[0]}`)).toEqual(days);
      expect(await at(`start=${days[1]}`)).toEqual(days.slice(1));
      // a start in the middle of a day leaves that day out: it started before
      expect(await at(`start=${days[0]}T12:00:00`)).toEqual(days.slice(1));
      expect(await at(`end=${days[0]}`)).toEqual(days.slice(0, 1));
      // an end at the very start of a day still has it (the end is exclusive of the next second)
      expect(await at(`end=${days[1]}T00:00:00Z`)).toEqual(days.slice(0, 2));
      expect(await at(`end=${days[1]}T00:00:00.000Z`)).toEqual(days.slice(0, 2));
      expect(await at(`start=${days[0]}&end=${days[0]}`)).toEqual(days.slice(0, 1));
      expect(await at('start=2030-01-01')).toEqual([]);
      expect(await at('end=2001-01-01')).toEqual([]);
      const one = await get(`/v2/amm/pools/${swapper}/history?interval=day&start=${days[1]}&end=${days[1]}`);
      expect(one.body.days).toEqual([objects.get(days[1])]);
    });

    it('sets the Link header on a page with a next one, and CSV has the days with the same columns on every page', async () => {
      const page = await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1`);
      expect(page.headers.link).toBe(
        `<${new URL(page.request.url).origin}/v2/amm/pools/${swapper}/history?interval=day&limit=1&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1&format=csv`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/amm/pools/${swapper}/history?interval=day&limit=1&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toBe(csvDisposition(`${swapper} - amm history`));
      const header = DAY_KEYS.map((c) => `"${c}"`);
      expect(lines(csv.text)[0].split(',')).toEqual(header);
      const stored = await storedDays(swapper);
      const all = await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1000&format=csv`);
      expect(lines(all.text)).toHaveLength(1 + stored.length);
      expect(lines(all.text)[0].split(',')).toEqual(header);
      expect((await get(`/v2/amm/pools/${swapper}/history?interval=day&limit=1000`)).headers.link).toBeUndefined();
    });

    it('a pool that has states and no days has none; a pool that is not one is 404', async () => {
      // a pool with a state in a committed ledger (a copy of a row of another pool) and no row in amm_daily
      const quiet = accountAt(0xd000);
      const [copy] = await h.ch.query<Record<string, unknown>>(
        `SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {from:String} ORDER BY ledger_index, tx_index LIMIT 1`,
        { from: LONG },
      );
      await h.ch.insert(Table.AmmPoolStates, [{ ...copy, amm_account: quiet }]);
      const [{ days }] = await h.ch.query<{ days: string }>(
        `SELECT count() AS days FROM ${Table.AmmDaily} WHERE amm_account = {quiet:String}`,
        { quiet },
      );
      const [{ states }] = await h.ch.query<{ states: string }>(
        `SELECT count() AS states FROM ${Table.AmmPoolStates} WHERE amm_account = {quiet:String}`,
        { quiet },
      );
      expect([Number(states), Number(days)]).toEqual([1, 0]);
      const res = await get(`/v2/amm/pools/${quiet}/history?interval=day`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, days: [] }]);
      const unknown = await get('/v2/amm/pools/rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/history?interval=day');
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const bad = await get('/v2/amm/pools/rnotanaddress/history?interval=day');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid pool' }]);
    });
  });

  // -- failures --------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    const cases: [string, string, string][] = [
      ['the list', '/v2/amm/pools', 'unable to retrieve pools'],
      ['the detail', `/v2/amm/pools/${ACCOUNTS[0]}`, 'unable to retrieve pool'],
      [
        'the pair',
        `/v2/amm/pools/${side(STATES[0].base_currency, STATES[0].base_issuer)}/${side(STATES[0].counter_currency, STATES[0].counter_issuer)}`,
        'unable to retrieve pool',
      ],
      ['the history', `/v2/amm/pools/${ACCOUNTS[0]}/history`, 'unable to retrieve pool history'],
      ['the days', `/v2/amm/pools/${ACCOUNTS[0]}/history?interval=day`, 'unable to retrieve pool history'],
    ];

    it.each(cases)('%s is a 500 with its own message', async (_name, path, message) => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(path);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
    });

    it('also when the page fails after the range was found', async () => {
      const real = h.ch.query.bind(h.ch);
      for (const table of [Table.AmmPoolStates, Table.AmmDaily, Table.AmmPools]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(table) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const path =
          table === Table.AmmPools
            ? '/v2/amm/pools'
            : `/v2/amm/pools/${LONG}/history${table === Table.AmmDaily ? '?interval=day' : ''}`;
        const res = await get(path);
        expect([table, res.status]).toEqual([table, 500]);
        jest.restoreAllMocks();
      }
    });

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const path of [
        '/v2/amm/pools?asset=USD',
        '/v2/amm/pools?marker=!!!',
        '/v2/amm/pools/rnotanaddress',
        '/v2/amm/pools/USD/XRP',
        `/v2/amm/pools/${LONG}/history?interval=week`,
        `/v2/amm/pools/${LONG}/history?start=x`,
        `/v2/amm/pools/${LONG}/history?marker=!!!`,
      ]) {
        expect([path, (await get(path)).status]).toEqual([path, 400]);
      }
    });
  });

  it('the pool routes are served with the API key, like every route', async () => {
    const res = await h.http().get('/v2/amm/pools');
    expect(res.status).toBe(401);
  });
});

// =====================================================================================================================
describe('the pool routes over pools made by hand', () => {
  // The cases the recordings do not hold. `amm_pools` and `amm_pool_states` are written directly, as the aggregator and
  // the ledger writer would.
  const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
  const ISSUER_2 = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
  const LP = '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6';

  const poolRow = (account: string, over: Partial<AmmPoolsRow> = {}): AmmPoolsRow => ({
    amm_account: account,
    base_currency: 'EUR',
    base_issuer: ISSUER,
    counter_currency: 'USD',
    counter_issuer: ISSUER_2,
    lp_currency: LP,
    created_ledger: null,
    created_by: null,
    last_ledger: 1000,
    reserve_base: '1000',
    reserve_counter: '500',
    lp_supply: '700',
    trading_fee: 500,
    auction_holder: null,
    auction_price: null,
    auction_discounted_fee: null,
    auction_expiration: null,
    deleted: 0,
    value_native: 2000,
    version: 1,
    ...over,
  });

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    // the older versions of a pool stay where they are written, as they are between two merges
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmmPools}`);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** A fresh pair for each case: `(currency, ISSUER)` against the native currency, so that cases do not meet. */
  let pairNo = 0;
  const freshPair = (): { currency: string; path: string } => {
    pairNo += 1;
    const currency = `P${String(pairNo).padStart(2, '0')}`;
    return { currency, path: `${currency}+${ISSUER}/XRP` };
  };
  const xrpPool = (account: string, currency: string, over: Partial<AmmPoolsRow> = {}): AmmPoolsRow =>
    // the canonical order of the pair: the key is the currency and the issuer in lower case, 'p01…' before 'xrpundefined'
    poolRow(account, {
      base_currency: currency,
      base_issuer: ISSUER,
      counter_currency: 'XRP',
      counter_issuer: '',
      ...over,
    });

  describe('two pools for one pair (a pool deleted and created again with a new account)', () => {
    it('the pair form resolves to the live pool, whichever is older, in either order', async () => {
      const { currency, path } = freshPair();
      const dead = accountAt(0x1000);
      const live = accountAt(0x1001);
      await insertParts(
        h,
        Table.AmmPools,
        // the old pool: live in version 1, deleted in version 2, at the later ledger
        [xrpPool(dead, currency, { version: 1, last_ledger: 500 })],
        [
          xrpPool(dead, currency, {
            version: 2,
            last_ledger: 9000,
            deleted: 1,
            value_native: null,
            reserve_base: null,
            reserve_counter: null,
          }),
          xrpPool(live, currency, { version: 1, last_ledger: 100, value_native: 10 }),
        ],
      );
      for (const route of [`/v2/amm/pools/${path}`, `/v2/amm/pools/XRP/${currency}+${ISSUER}`]) {
        const res = await get(route);
        expect([route, res.status, res.body.pool?.amm_account, res.body.pool?.deleted]).toEqual([
          route,
          200,
          live,
          false,
        ]);
      }
      // the account routes stay per account: the deleted pool is still its own
      expect(((await get(`/v2/amm/pools/${dead}`)).body.pool as Obj).deleted).toBe(true);
      expect(((await get(`/v2/amm/pools/${live}`)).body.pool as Obj).deleted).toBe(false);
    });

    it('the deleted pool is returned only when there is no live one, the one deleted last', async () => {
      const { currency, path } = freshPair();
      const first = accountAt(0x2000);
      const second = accountAt(0x2001);
      const third = accountAt(0x2002);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(first, currency, { deleted: 1, last_ledger: 300, value_native: null }),
        xrpPool(second, currency, { deleted: 1, last_ledger: 900, value_native: null }),
        xrpPool(third, currency, { deleted: 1, last_ledger: 600, value_native: null }),
      ]);
      const res = await get(`/v2/amm/pools/${path}`);
      expect([res.status, res.body.pool?.amm_account, res.body.pool?.last_ledger]).toEqual([200, second, 900]);
      // the other way round, and with the accounts in the other order, so that it is the ledger that decides
      const other = freshPair();
      const low = accountAt(0x2100);
      const high = accountAt(0x2101);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(low, other.currency, { deleted: 1, last_ledger: 100, value_native: null }),
        xrpPool(high, other.currency, { deleted: 1, last_ledger: 800, value_native: null }),
      ]);
      expect((await get(`/v2/amm/pools/${other.path}`)).body.pool.amm_account).toBe(high);
      const swapped = freshPair();
      await h.ch.insert(Table.AmmPools, [
        xrpPool(low, swapped.currency, { deleted: 1, last_ledger: 800, value_native: null }),
        xrpPool(high, swapped.currency, { deleted: 1, last_ledger: 100, value_native: null }),
      ]);
      expect((await get(`/v2/amm/pools/${swapped.path}`)).body.pool.amm_account).toBe(low);
    });

    it('a live pool wins over a deleted one that was deleted later (its last_ledger is higher)', async () => {
      const { currency, path } = freshPair();
      const live = accountAt(0x3000);
      const dead = accountAt(0x3001);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(live, currency, { last_ledger: 50 }),
        xrpPool(dead, currency, { deleted: 1, last_ledger: 99999, value_native: null }),
      ]);
      expect((await get(`/v2/amm/pools/${path}`)).body.pool.amm_account).toBe(live);
      expect((await get(`/v2/amm/pools/${path.split('/').reverse().join('/')}`)).body.pool.amm_account).toBe(live);
    });

    it('both are in the list when deleted ones are asked for, and the pair filter finds both', async () => {
      const { currency } = freshPair();
      const dead = accountAt(0x4000);
      const live = accountAt(0x4001);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(dead, currency, { deleted: 1, last_ledger: 90, value_native: null }),
        xrpPool(live, currency, { last_ledger: 100, value_native: 77 }),
      ]);
      const filter = `asset=${currency}%2B${ISSUER}&asset2=XRP`;
      const live_only = (await get(`/v2/amm/pools?${filter}`)).body as ListBody;
      expect(live_only.pools.map((p) => p.amm_account)).toEqual([live]);
      const both = (await get(`/v2/amm/pools?${filter}&include_deleted=true`)).body as ListBody;
      expect(both.pools.map((p) => p.amm_account)).toEqual([live, dead]);
    });
  });

  describe('the newest version of a pool is the pool', () => {
    it('the list, the detail and the pair serve the version with the highest version, whatever order they were written in', async () => {
      const { currency, path } = freshPair();
      const account = accountAt(0x5000);
      await insertParts(
        h,
        Table.AmmPools,
        [xrpPool(account, currency, { version: 7, last_ledger: 700, reserve_base: '7', trading_fee: 7 })],
        [xrpPool(account, currency, { version: 9, last_ledger: 900, reserve_base: '9', trading_fee: 9 })],
        [xrpPool(account, currency, { version: 8, last_ledger: 800, reserve_base: '8', trading_fee: 8 })],
      );
      const detail = (await get(`/v2/amm/pools/${account}`)).body.pool as Obj;
      expect(detail).toMatchObject({ last_ledger: 900, reserve_base: '9', trading_fee: 9 });
      expect((await get(`/v2/amm/pools/${path}`)).body.pool).toEqual(detail);
      const listed = ((await get(`/v2/amm/pools?asset=${currency}%2B${ISSUER}`)).body as ListBody).pools;
      expect(listed).toEqual([detail]);
    });

    it('a pool whose newest version is deleted is hidden from the list, though an older version was live', async () => {
      const { currency } = freshPair();
      const account = accountAt(0x5100);
      await insertParts(
        h,
        Table.AmmPools,
        [xrpPool(account, currency, { version: 1, deleted: 0, value_native: 5000 })],
        [xrpPool(account, currency, { version: 2, deleted: 1, value_native: null })],
      );
      const filter = `asset=${currency}%2B${ISSUER}`;
      expect(((await get(`/v2/amm/pools?${filter}`)).body as ListBody).pools).toEqual([]);
      const withDeleted = ((await get(`/v2/amm/pools?${filter}&include_deleted=true`)).body as ListBody).pools;
      expect(withDeleted).toHaveLength(1);
      expect(withDeleted[0]).toMatchObject({ amm_account: account, deleted: true });
    });

    it('a pool that was deleted in an old version and is live in the newest is listed once, live', async () => {
      const { currency } = freshPair();
      const account = accountAt(0x5200);
      await insertParts(
        h,
        Table.AmmPools,
        [xrpPool(account, currency, { version: 5, deleted: 0, value_native: 10 })],
        [xrpPool(account, currency, { version: 3, deleted: 1, value_native: null })],
      );
      const filter = `asset=${currency}%2B${ISSUER}`;
      const listed = ((await get(`/v2/amm/pools?${filter}&include_deleted=true`)).body as ListBody).pools;
      expect(listed.map((p) => [p.amm_account, p.deleted])).toEqual([[account, false]]);
    });

    it('the value of an old version does not rank the pool: only the newest version has a place in the order', async () => {
      const { currency } = freshPair();
      const a = accountAt(0x5300);
      const b = accountAt(0x5301);
      await insertParts(
        h,
        Table.AmmPools,
        [
          xrpPool(a, currency, { version: 1, value_native: 9_000_000 }),
          xrpPool(b, currency, { version: 1, value_native: 2 }),
        ],
        [xrpPool(a, currency, { version: 2, value_native: 1 })],
      );
      const listed = ((await get(`/v2/amm/pools?asset=${currency}%2B${ISSUER}`)).body as ListBody).pools;
      expect(listed.map((p) => p.amm_account)).toEqual([b, a]);
    });

    it('a real duplicate (the same version stored twice) is listed once', async () => {
      const { currency } = freshPair();
      const account = accountAt(0x5400);
      const row = xrpPool(account, currency, { version: 4, value_native: 33 });
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmmPools}`);
      await h.ch.insert(Table.AmmPools, [row]);
      await h.ch.command(
        `INSERT INTO ${Table.AmmPools} SELECT * FROM ${Table.AmmPools} WHERE amm_account = {a:String}`,
        { a: account },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AmmPools} WHERE amm_account = {a:String}`,
        { a: account },
      );
      expect(Number(n)).toBe(2);
      const filter = `asset=${currency}%2B${ISSUER}`;
      expect(((await get(`/v2/amm/pools?${filter}`)).body as ListBody).count).toBe(1);
      expect((await get(`/v2/amm/pools/${account}`)).status).toBe(200);
    });
  });

  describe('the order of the list', () => {
    it('pools of equal value are in account order, pools without a value last in account order, and any page boundary continues exactly', async () => {
      const { currency } = freshPair();
      const filter = `asset=${currency}%2B${ISSUER}`;
      const accounts = [0x6007, 0x6003, 0x6005, 0x6001, 0x6006, 0x6002, 0x6004, 0x6000].map(accountAt);
      const values: Array<number | null> = [100, 100, 100.5, 0.1 + 0.2, null, 100, null, 0.3];
      await h.ch.insert(
        Table.AmmPools,
        accounts.map((account, i) => xrpPool(account, currency, { value_native: values[i] })),
      );
      const ranked = accounts
        .map((account, i) => ({ account, value: values[i] }))
        .sort((a, b) => {
          if (a.value === null || b.value === null)
            return a.value === b.value ? compare(a.account, b.account) : a.value === null ? 1 : -1;
          return b.value - a.value || compare(a.account, b.account);
        });
      const whole = (await get(`/v2/amm/pools?${filter}&limit=1000`)).body as ListBody;
      expect(whole.pools.map((p) => p.amm_account)).toEqual(ranked.map((r) => r.account));
      // 0.1 + 0.2 and 0.3 are different numbers: they must not be taken for each other, nor lost at a page boundary
      expect(whole.pools.map((p) => p.value_native)).toEqual(
        ranked.map((r) => (r.value === null ? undefined : fixed8(r.value))),
      );
      for (const limit of [1, 2, 3, 5]) {
        const walked = await pages<ListBody>(`/v2/amm/pools?${filter}`, limit, 'pools');
        expect([limit, walked.flatMap((p) => p.pools.map((x) => x.amm_account))]).toEqual([
          limit,
          ranked.map((r) => r.account),
        ]);
      }
    });

    it('a deleted pool is never ranked by a value: it comes after the pools with one', async () => {
      const { currency } = freshPair();
      const filter = `asset=${currency}%2B${ISSUER}&include_deleted=true`;
      const live = accountAt(0x6100);
      const noValue = accountAt(0x6101);
      const dead = accountAt(0x6102);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(live, currency, { value_native: 4 }),
        xrpPool(noValue, currency, { value_native: null }),
        xrpPool(dead, currency, { deleted: 1, value_native: null }),
      ]);
      const listed = ((await get(`/v2/amm/pools?${filter}`)).body as ListBody).pools.map((p) => p.amm_account);
      // the two pools without a value are in the order of their accounts, the deleted one among them
      expect(listed).toEqual([live, ...[noValue, dead].sort(compare)]);
    });
  });

  describe('the objects', () => {
    it('serve the pool in the shape of the contract: flat pair, strings for amounts, the slot grouped, deleted a boolean', async () => {
      const { currency, path } = freshPair();
      const account = accountAt(0x7000);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(account, currency, {
          created_ledger: 93663334,
          created_by: ISSUER_2,
          last_ledger: 107713744,
          reserve_base: '14055257.09731275',
          reserve_counter: '178.019159',
          lp_supply: '49919.30511225182',
          trading_fee: 0,
          auction_holder: ISSUER_2,
          auction_price: '0',
          auction_discounted_fee: 0,
          auction_expiration: 814_000_000,
          value_native: 28_110_514.1946255,
        }),
      ]);
      const expected = {
        amm_account: account,
        base_currency: currency,
        base_issuer: ISSUER,
        counter_currency: 'XRP',
        reserve_base: '14055257.09731275',
        reserve_counter: '178.019159',
        lp_supply: '49919.30511225182',
        lp_currency: LP,
        trading_fee: 0,
        auction_slot: { holder: ISSUER_2, price: '0', discounted_fee: 0, expiration: '2025-10-17T07:06:40Z' },
        value_native: '28110514',
        created_ledger: 93663334,
        created_by: ISSUER_2,
        last_ledger: 107713744,
        deleted: false,
      };
      const res = await get(`/v2/amm/pools/${path}`);
      expectObjects([res.body.pool], [expected], POOL_KEYS);
    });

    it('serve value_native as a plain decimal of eight significant digits: never the exponent form, at either end', async () => {
      const { currency } = freshPair();
      const cases: Array<[number | null, string | undefined]> = [
        [2.5e11, '250000000000'],
        [123_456_789.5, '123456790'],
        [99_999_999.5, '100000000'],
        [28_110_514.1946255, '28110514'],
        [42, '42'],
        [12.5, '12.5'],
        [0.1 + 0.2, '0.3'],
        [1e-7, '0.0000001'],
        [3.2e-8, '0.000000032'],
        [0, '0'],
        [null, undefined],
      ];
      const accounts = cases.map((_, i) => accountAt(0x7100 + i));
      await h.ch.insert(
        Table.AmmPools,
        cases.map(([value], i) => xrpPool(accounts[i], currency, { value_native: value })),
      );
      const filter = `asset=${currency}%2B${ISSUER}`;
      // by value, descending, the pool without one last: the order the cases are written in
      const whole = (await get(`/v2/amm/pools?${filter}&limit=1000`)).body as ListBody;
      expect(whole.pools.map((p) => [p.amm_account, p.value_native])).toEqual(
        cases.map(([, text], i) => [accounts[i], text]),
      );
      for (const pool of whole.pools) expect(String(pool.value_native ?? '')).not.toMatch(/e/i);
      // a marker holds the value as the double it is stored as (1e-7 and 2.5e11 are not written in plain digits in JSON)
      for (const limit of [1, 2, 3]) {
        const walked = await pages<ListBody>(`/v2/amm/pools?${filter}`, limit, 'pools');
        expect([limit, walked.flatMap((p) => p.pools)]).toEqual([limit, whole.pools]);
      }
      const detail = (await get(`/v2/amm/pools/${accounts[7]}`)).body.pool as Obj;
      expect(detail.value_native).toBe('0.0000001');
    });

    it('serve a pool with nothing known as the bare pool: no key that is null', async () => {
      const { currency } = freshPair();
      const account = accountAt(0x7001);
      await h.ch.insert(Table.AmmPools, [
        xrpPool(account, currency, {
          lp_currency: null,
          reserve_base: null,
          reserve_counter: null,
          lp_supply: null,
          trading_fee: null,
          value_native: null,
        }),
      ]);
      const pool = (await get(`/v2/amm/pools/${account}`)).body.pool as Obj;
      expect(pool).toEqual({
        amm_account: account,
        base_currency: currency,
        base_issuer: ISSUER,
        counter_currency: 'XRP',
        last_ledger: 1000,
        deleted: false,
      });
    });
  });
});

// =====================================================================================================================
describe('the pool history over states made by hand', () => {
  const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
  const HOLDER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
  const LP = '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6';
  const closeOf = (ledger: number): number => 1_700_000_000 + ledger - 100_000_000;

  const stateRow = (
    account: string,
    ledger: number,
    tx: number,
    over: Partial<AmmPoolStatesRow> = {},
  ): AmmPoolStatesRow => ({
    amm_account: account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: closeOf(ledger),
    tx_type: 'Payment',
    base_currency: 'XRP',
    base_issuer: '',
    counter_currency: 'EUR',
    counter_issuer: ISSUER,
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

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);
  /** The ledgers the harness holds: 16 recorded AMM ledgers, the first 93663334 and the last (the head) 107713744. */
  let head: number;
  let closeAt: Map<number, number>;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const ledgers = await h.ch.query<{ ledger_index: number; t: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} ORDER BY ledger_index`,
    );
    closeAt = new Map(ledgers.map((l) => [Number(l.ledger_index), Number(l.t)]));
    head = Math.max(...closeAt.keys());
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const viaApi = async (account: string, query = ''): Promise<Obj[]> =>
    ((await get(`/v2/amm/pools/${account}/history?limit=1000${query}`)).body as HistoryBody).history;

  describe('the carry-forward', () => {
    // Z: rows in three ledgers, with the nulls of a swap (reserves only), a creation or deposit (everything but the slot),
    // a vote (the fee) and a bid (the slot).
    const Z = accountAt(0x9000);
    const rows = [
      stateRow(Z, 100_500_000, 1, {
        tx_type: 'AMMCreate',
        reserve_base: '100',
        reserve_counter: '10',
        lp_supply: '50',
        lp_currency: LP,
        trading_fee: 500,
      }),
      stateRow(Z, 100_500_000, 2, { reserve_base: '101' }),
      stateRow(Z, 100_500_000, 3, { tx_type: 'AMMVote', reserve_counter: '9.9', trading_fee: 0 }),
      stateRow(Z, 100_500_010, 0, {
        tx_type: 'AMMBid',
        lp_supply: '60',
        auction_holder: HOLDER,
        auction_price: '5',
        auction_discounted_fee: 50,
        auction_expiration: 100,
      }),
      stateRow(Z, 100_500_010, 5, { reserve_base: '110' }),
      stateRow(Z, 102_500_000, 1, {
        tx_type: 'AMMWithdraw',
        reserve_base: '0',
        reserve_counter: '0',
        lp_supply: '0',
        deleted: 1,
      }),
    ];
    // and one above the committed head, which does not exist yet as far as the API can tell
    const ABOVE = 107_999_000;

    beforeAll(async () => {
      await h.ch.insert(Table.AmmPoolStates, [...rows, stateRow(Z, ABOVE, 1, { reserve_base: '999' })]);
      expect(ABOVE).toBeGreaterThan(head);
    });

    const expected = (): Obj[] => carried(rows).map(stateOf);

    it('fills the nulls from the newest earlier row, and keeps a fee of 0 and a reserve of 0 as values', async () => {
      const history = await viaApi(Z);
      expect(history).toHaveLength(6);
      expectObjects(history, expected(), STATE_KEYS);
      // spot checks, written out
      expect(history[1]).toMatchObject({
        reserve_base: '101',
        reserve_counter: '10',
        lp_supply: '50',
        trading_fee: 500,
      });
      expect(history[2]).toMatchObject({ reserve_base: '101', reserve_counter: '9.9', trading_fee: 0 });
      expect(history[2]).not.toHaveProperty('auction_slot');
      expect(history[4]).toMatchObject({
        reserve_base: '110',
        lp_supply: '60',
        trading_fee: 0,
        auction_slot: { holder: HOLDER, price: '5', discounted_fee: 50 },
      });
      expect(history[5]).toMatchObject({ deleted: true, reserve_base: '0', lp_supply: '0', trading_fee: 0 });
    });

    it('never reads past the committed head: a state above it is not served', async () => {
      for (const query of ['', '&descending=true', '&end=2099-01-01', '&start=2000-01-01&end=2099-01-01']) {
        const history = await viaApi(Z, query);
        expect([query, history.some((s) => s.ledger_index === ABOVE)]).toEqual([query, false]);
        expect([query, history.length]).toEqual([query, 6]);
      }
      // the page that holds the last state below the head has no next page
      const page = (await get(`/v2/amm/pools/${Z}/history?limit=6`)).body as HistoryBody;
      expect(page.marker).toBeUndefined();
      // and the SQL asks for no ledger past the head
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/amm/pools/${Z}/history?limit=6`);
      const statements = spy.mock.calls.filter(([sql]) =>
        new RegExp(`FROM ${Table.AmmPoolStates}\\b`).test(String(sql)),
      );
      expect(statements.length).toBeGreaterThan(0);
      for (const [sql, params] of statements) {
        const p = params as Record<string, unknown>;
        const ledgers = Object.entries(p)
          .filter(([k, v]) => typeof v === 'number' && /^(max|fill_up_to)$/.test(k))
          .map(([, v]) => v as number);
        expect([String(sql).slice(0, 40), ledgers.every((v) => v <= head)]).toEqual([String(sql).slice(0, 40), true]);
      }
    });

    it('pages of 1 and 2, in both directions, concatenate to the whole: a page starts from the carried state of the rows before it', async () => {
      for (const descending of [false, true]) {
        const want = descending ? [...expected()].reverse() : expected();
        for (const limit of [1, 2, 3]) {
          const walked = await pages<HistoryBody>(
            `/v2/amm/pools/${Z}/history?descending=${descending}`,
            limit,
            'history',
          );
          expect([descending, limit, walked.flatMap((p) => p.history)]).toEqual([descending, limit, want]);
        }
      }
    });

    it('a marker in the middle of a ledger: the rows of the ledger before it are carried in', async () => {
      const want = expected();
      for (const [i, row] of rows.entries()) {
        if (i === rows.length - 1) continue;
        const marker = markerOf([row.ledger_index, row.tx_index]);
        const asc = (await get(`/v2/amm/pools/${Z}/history?limit=2&marker=${marker}`)).body as HistoryBody;
        expect([i, asc.history]).toEqual([i, want.slice(i + 1, i + 3)]);
      }
      for (let i = 1; i < rows.length; i++) {
        const marker = markerOf([rows[i].ledger_index, rows[i].tx_index]);
        const desc = (await get(`/v2/amm/pools/${Z}/history?limit=2&descending=true&marker=${marker}`))
          .body as HistoryBody;
        expect([i, desc.history]).toEqual([i, want.slice(Math.max(0, i - 2), i).reverse()]);
      }
    });

    it('a window that starts later carries the values from before start, from as far back as they are (past the first window)', async () => {
      // start at the ledger 102186243 (the recorded ledger after 100.5M): only the last row is in, with everything carried
      const start = iso(closeAt.get(102186243) as number).replace('Z', '+00:00');
      const history = await viaApi(Z, `&start=${encodeURIComponent(start)}`);
      expect(history).toEqual(carried(rows).slice(5).map(stateOf));
      expect(history[0]).toMatchObject({ trading_fee: 0, deleted: true });
      // and a window that ends before the last row serves the others, whatever comes after
      const end = iso(closeAt.get(102186243) as number).replace('Z', '+00:00');
      expect(await viaApi(Z, `&end=${encodeURIComponent(end)}`)).toEqual(carried(rows).slice(0, 5).map(stateOf));
    });

    /** The reads of the fill-forward of a request: the window of the state before the page, and the steps back from it. */
    /** The first window of the carry-in: 2048 ledgers (`AMM_HISTORY_CARRY_LEDGERS`, written out here to pin it). */
    const WINDOW = 2048;
    const fillReads = (spy: jest.SpyInstance): Array<{ from: number; upTo: number }> =>
      spy.mock.calls
        .filter(([sql]) => String(sql).includes('argMaxIf(reserve_base'))
        .map(([, params]) => {
          const p = params as { fill_from: number; fill_up_to: number };
          return { from: p.fill_from, upTo: p.fill_up_to };
        });

    it('the first page of a pool reads the window before it once: there is nothing before the pool, so no walk back', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const page = await get(`/v2/amm/pools/${Z}/history?limit=2`);
      expect(page.status).toBe(200);
      expect(fillReads(spy)).toEqual([{ from: 100_500_000 - 1 - WINDOW + 1, upTo: 100_500_000 - 1 }]);
    });

    it('a page after a gap walks back for the values it lacks and stops at the rows that have them, not at the first ledger', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const start = iso(closeAt.get(102186243) as number).replace('Z', '+00:00');
      const history = await viaApi(Z, `&start=${encodeURIComponent(start)}`);
      expect(history).toHaveLength(1);
      const reads = fillReads(spy);
      // the window, then doubling steps, each older than the one before; the row that has the values is 2,000,000 ledgers back
      expect(reads.length).toBeGreaterThan(5);
      expect(Math.min(...reads.map((r) => r.from))).toBeGreaterThan(0);
      expect(Math.min(...reads.map((r) => r.from))).toBeLessThanOrEqual(100_500_000);
      for (let i = 1; i < reads.length; i++) expect(reads[i].upTo).toBeLessThan(reads[i - 1].from);
    });

    it('a window that holds nothing is an empty list for a pool that exists, 404 for one that does not', async () => {
      const empty = await get(`/v2/amm/pools/${Z}/history?start=2099-01-01`);
      expect([empty.status, empty.body]).toEqual([200, { result: 'success', count: 0, history: [] }]);
      const unknown = await get(`/v2/amm/pools/${accountAt(0x9fff)}/history?start=2099-01-01`);
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      // a pool with states only above the head does not exist yet
      const futureOnly = accountAt(0x9ffe);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(futureOnly, 107_999_100, 1, { reserve_base: '1' })]);
      const none = await get(`/v2/amm/pools/${futureOnly}/history`);
      expect([none.status, none.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
    });
  });

  describe('a state is read from the pool it belongs to', () => {
    it('two pools of one pair have their own history, and no value passes from the one to the other', async () => {
      const dead = accountAt(0xa000);
      const live = accountAt(0xa001);
      await h.ch.insert(Table.AmmPoolStates, [
        stateRow(dead, 100_600_000, 1, {
          tx_type: 'AMMCreate',
          reserve_base: '10',
          reserve_counter: '1',
          lp_supply: '5',
          lp_currency: LP,
          trading_fee: 300,
          auction_holder: HOLDER,
          auction_price: '1',
          auction_discounted_fee: 30,
          auction_expiration: 7,
        }),
        stateRow(dead, 100_600_010, 1, {
          tx_type: 'AMMWithdraw',
          reserve_base: '0',
          reserve_counter: '0',
          lp_supply: '0',
          deleted: 1,
        }),
        stateRow(live, 100_700_000, 1, {
          tx_type: 'AMMCreate',
          reserve_base: '20',
          reserve_counter: '2',
          trading_fee: 700,
        }),
        stateRow(live, 100_700_010, 1, { reserve_base: '21' }),
      ]);
      const deadHistory = await viaApi(dead);
      const liveHistory = await viaApi(live);
      expect(deadHistory.map((s) => s.amm_account)).toEqual([dead, dead]);
      expect(liveHistory.map((s) => s.amm_account)).toEqual([live, live]);
      expect(deadHistory[0]).toMatchObject({ trading_fee: 300 });
      expect(liveHistory.map((s) => s.trading_fee)).toEqual([700, 700]);
      // the live pool never had a slot or an LP token: the dead one's do not come to it
      for (const state of liveHistory) {
        expect(state).not.toHaveProperty('auction_slot');
        expect(state).not.toHaveProperty('lp_currency');
        expect(state).not.toHaveProperty('lp_supply');
      }
      expect(liveHistory[1]).toMatchObject({ reserve_base: '21', reserve_counter: '2' });
      // a page of the live pool that starts after its first row still sees only its own past
      const second = (await get(`/v2/amm/pools/${live}/history?limit=1&marker=${markerOf([100_700_000, 1])}`))
        .body as HistoryBody;
      expect(second.history).toHaveLength(1);
      expect(second.history[0]).toMatchObject({ reserve_counter: '2', trading_fee: 700 });
      expect(second.history[0]).not.toHaveProperty('auction_slot');
    });
  });

  describe('a state written twice', () => {
    it('is served once, and a page cut inside the duplicates neither repeats nor skips a state', async () => {
      const account = accountAt(0xb000);
      const rows = [
        stateRow(account, 100_800_000, 1, { reserve_base: '1', lp_supply: '9', trading_fee: 100 }),
        stateRow(account, 100_800_000, 2, { reserve_base: '2' }),
        stateRow(account, 100_800_000, 3, { reserve_counter: '3' }),
        stateRow(account, 100_800_001, 1, { reserve_base: '4' }),
      ];
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmmPoolStates}`);
      await h.ch.insert(Table.AmmPoolStates, rows);
      await h.ch.command(
        `INSERT INTO ${Table.AmmPoolStates} SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {a:String}`,
        { a: account },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AmmPoolStates} WHERE amm_account = {a:String}`,
        { a: account },
      );
      expect(Number(n)).toBe(8);
      const want = carried(rows).map(stateOf);
      expect(await viaApi(account)).toEqual(want);
      for (const descending of [false, true]) {
        for (const limit of [1, 2, 3]) {
          const walked = await pages<HistoryBody>(
            `/v2/amm/pools/${account}/history?descending=${descending}`,
            limit,
            'history',
          );
          expect([descending, limit, walked.flatMap((p) => p.history)]).toEqual([
            descending,
            limit,
            descending ? [...want].reverse() : want,
          ]);
        }
      }
    });
  });

  describe('interval=day over sets made by hand', () => {
    // A day is a version set: its pool rows and its sentinel carry one version. A pool-day of an older set that the newest
    // set does not hold has no place in the history.
    const dayRow = (account: string, day: string, version: number, over: Partial<AmmDailyRow> = {}): AmmDailyRow => ({
      amm_account: account,
      day,
      base_currency: 'XRP',
      base_issuer: '',
      counter_currency: 'EUR',
      counter_issuer: ISSUER,
      swap_count: 3,
      volume_base: '30',
      volume_counter: '3',
      fees_base_est: '0.09',
      fees_counter_est: '0.009',
      deposit_count: 1,
      withdraw_count: 0,
      liquidity_in_base: '10',
      liquidity_in_counter: '1',
      liquidity_out_base: '0',
      liquidity_out_counter: '0',
      reserve_base: '1000',
      reserve_counter: '100',
      lp_supply: '300',
      trading_fee: 300,
      value_native: 2000,
      final: 0,
      config_version: 1,
      version,
      ...over,
    });
    const sentinel = (day: string, version: number): AmmDailyRow =>
      dayRow('', day, version, {
        base_currency: '',
        counter_currency: '',
        counter_issuer: '',
        swap_count: 0,
        volume_base: '0',
        volume_counter: '0',
        fees_base_est: '0',
        fees_counter_est: '0',
        deposit_count: 0,
        withdraw_count: 0,
        liquidity_in_base: '0',
        liquidity_in_counter: '0',
        liquidity_out_base: '0',
        liquidity_out_counter: '0',
        reserve_base: null,
        reserve_counter: null,
        lp_supply: null,
        trading_fee: null,
        value_native: null,
        final: 1,
      });
    const dayObject = (r: AmmDailyRow): Obj =>
      defined({
        amm_account: r.amm_account,
        date: `${r.day}T00:00:00Z`,
        base_currency: r.base_currency,
        counter_currency: r.counter_currency,
        counter_issuer: r.counter_issuer,
        swap_count: Number(r.swap_count),
        volume_base: r.volume_base,
        volume_counter: r.volume_counter,
        fees_base_est: r.fees_base_est,
        fees_counter_est: r.fees_counter_est,
        deposit_count: Number(r.deposit_count),
        withdraw_count: Number(r.withdraw_count),
        liquidity_in_base: r.liquidity_in_base,
        liquidity_in_counter: r.liquidity_in_counter,
        liquidity_out_base: r.liquidity_out_base,
        liquidity_out_counter: r.liquidity_out_counter,
        reserve_base: r.reserve_base,
        reserve_counter: r.reserve_counter,
        lp_supply: r.lp_supply,
        trading_fee: r.trading_fee,
        value_native: r.value_native === null ? undefined : fixed8(r.value_native),
      });
    // a merge of ReplacingMergeTree(version) would drop the older rows of a pool-day by itself: the sets stay as written
    beforeAll(async () => {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmmDaily}`);
    });

    const daysOf = async (account: string, query = ''): Promise<Obj[]> =>
      ((await get(`/v2/amm/pools/${account}/history?interval=day&limit=1000${query}`)).body as DaysBody).days;

    it('keeps the pool rows of the version of the sentinel of their day: a vanished pool-day, an older set and a newer pool row do not show', async () => {
      const A = accountAt(0xc000);
      const B = accountAt(0xc001);
      // the sets are inserted in two steps, the older ones first, and each step is its own part (a merge is stopped, so the
      // rows of the older sets that a newer set does not replace are still there, as they are between two merges)
      const older = [
        // day 1: the older set (v10) holds A
        sentinel('2026-03-01', 10),
        dayRow(A, '2026-03-01', 10, { swap_count: 10, volume_base: '100' }),
        // day 2: the older set (v30) holds A, and the newer one will not
        sentinel('2026-03-02', 30),
        dayRow(A, '2026-03-02', 30, { swap_count: 5 }),
        // day 3: the sentinel of the day is v50, there is no pool row of that version
        sentinel('2026-03-03', 50),
        // day 4: the older set (v70)
        sentinel('2026-03-04', 70),
        dayRow(A, '2026-03-04', 70, { swap_count: 1 }),
      ];
      const newer = [
        // day 1: the newest set (v20) holds A and B: the row of A of v10 is not the day's
        sentinel('2026-03-01', 20),
        dayRow(A, '2026-03-01', 20, { swap_count: 20, volume_base: '200' }),
        dayRow(B, '2026-03-01', 20, { swap_count: 7 }),
        // day 2: the newest set (v40) does not hold A any more (a vanished pool-day): the row of v30 is stale
        sentinel('2026-03-02', 40),
        dayRow(B, '2026-03-02', 40, { swap_count: 8 }),
        // day 3: a row newer than the sentinel of its day is not of the set of the day
        dayRow(A, '2026-03-03', 60, { swap_count: 99 }),
        // day 4: the newest sentinel (v80) decides, not the older one (v70)
        sentinel('2026-03-04', 80),
        dayRow(A, '2026-03-04', 80, { swap_count: 2 }),
        // day 5: a day with only a sentinel (a set with no pool)
        sentinel('2026-03-05', 90),
        // day 6: a day with a pool row and no sentinel at all: no set, no day
        dayRow(A, '2026-03-06', 100, { swap_count: 4 }),
      ];
      await insertParts(h, Table.AmmDaily, older, newer);
      // the pools have states, so they exist
      await h.ch.insert(Table.AmmPoolStates, [
        stateRow(A, 100_900_000, 1, { reserve_base: '1' }),
        stateRow(B, 100_900_000, 2, { reserve_base: '1' }),
      ]);

      const forA = await daysOf(A);
      expect(forA.map((d) => [d.date, d.swap_count])).toEqual([
        ['2026-03-01T00:00:00Z', 20],
        ['2026-03-04T00:00:00Z', 2],
      ]);
      expect(forA[0]).toMatchObject({ volume_base: '200' });
      expect((await daysOf(B)).map((d) => [d.date, d.swap_count])).toEqual([
        ['2026-03-01T00:00:00Z', 7],
        ['2026-03-02T00:00:00Z', 8],
      ]);
      // never the sentinel, whichever pool is asked for
      for (const account of [A, B]) expect((await daysOf(account)).every((d) => d.amm_account === account)).toBe(true);
      const all = await get(`/v2/amm/pools/${A}/history?interval=day&limit=1000`);
      expect(all.body.count).toBe(2);
      expectObjects(
        all.body.days,
        [
          dayRow(A, '2026-03-01', 20, { swap_count: 20, volume_base: '200' }),
          dayRow(A, '2026-03-04', 80, { swap_count: 2 }),
        ].map(dayObject),
        DAY_KEYS,
      );
    });

    it('pages by day through a gap left by a vanished pool-day, in both directions, without a short or an empty page in the middle', async () => {
      const A = accountAt(0xc100);
      const days = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07'];
      const rows: AmmDailyRow[] = [];
      for (const [i, day] of days.entries()) {
        rows.push(sentinel(day, 200 + i));
        // days 2, 3 and 5 (0-based 1, 2, 4) are vanished pool-days: the pool row is of an older set
        if ([1, 2, 4].includes(i)) rows.push(dayRow(A, day, 100, { swap_count: 1000 + i }));
        else rows.push(dayRow(A, day, 200 + i, { swap_count: i }));
      }
      await h.ch.insert(Table.AmmDaily, rows);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(A, 100_910_000, 1, { reserve_base: '1' })]);
      const live = [0, 3, 5, 6];
      const want = live.map((i) => ['2026-04-0' + (i + 1) + 'T00:00:00Z', i]);
      expect((await daysOf(A, '&start=2026-04-01&end=2026-04-07')).map((d) => [d.date, d.swap_count])).toEqual(want);
      for (const descending of [false, true]) {
        for (const limit of [1, 2, 3]) {
          const walked = await pages<DaysBody>(
            `/v2/amm/pools/${A}/history?interval=day&start=2026-04-01&end=2026-04-07&descending=${descending}`,
            limit,
            'days',
          );
          const got = walked.flatMap((p) => p.days.map((d) => [d.date, d.swap_count]));
          expect([descending, limit, got]).toEqual([descending, limit, descending ? [...want].reverse() : want]);
          for (const [i, page] of walked.entries()) {
            expect([descending, limit, i, page.days.length > 0]).toEqual([descending, limit, i, true]);
            expect(page.marker === undefined).toBe(i === walked.length - 1);
          }
        }
      }
    });

    it('a row written twice (the same version) is one day', async () => {
      const A = accountAt(0xc200);
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmmDaily}`);
      await h.ch.insert(Table.AmmDaily, [
        sentinel('2026-05-01', 300),
        dayRow(A, '2026-05-01', 300, { swap_count: 4 }),
        sentinel('2026-05-02', 301),
        dayRow(A, '2026-05-02', 301, { swap_count: 6 }),
      ]);
      await h.ch.command(
        `INSERT INTO ${Table.AmmDaily} SELECT * FROM ${Table.AmmDaily} WHERE day IN ('2026-05-01', '2026-05-02')`,
        {},
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AmmDaily} WHERE amm_account = {a:String}`,
        { a: A },
      );
      expect(Number(n)).toBe(4);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(A, 100_920_000, 1, { reserve_base: '1' })]);
      expect((await daysOf(A)).map((d) => d.swap_count)).toEqual([4, 6]);
      for (const limit of [1, 2]) {
        const walked = await pages<DaysBody>(`/v2/amm/pools/${A}/history?interval=day`, limit, 'days');
        expect([limit, walked.flatMap((p) => p.days.map((d) => d.swap_count))]).toEqual([limit, [4, 6]]);
      }
    });

    it('serves the value of a day as a plain decimal of eight significant digits, never the exponent form', async () => {
      const A = accountAt(0xc500);
      const cases: Array<[string, number | null, string | undefined]> = [
        ['2026-08-01', 123_456_789.5, '123456790'],
        ['2026-08-02', 99_999_999.5, '100000000'],
        ['2026-08-03', 1e-7, '0.0000001'],
        ['2026-08-04', 3.2e-8, '0.000000032'],
        ['2026-08-05', 12.5, '12.5'],
        ['2026-08-06', 0, '0'],
        ['2026-08-07', null, undefined],
      ];
      await h.ch.insert(Table.AmmDaily, [
        ...cases.map(([day, ,]) => sentinel(day, 700)),
        ...cases.map(([day, value]) => dayRow(A, day, 700, { value_native: value })),
      ]);
      const days = await daysOf(A, '&start=2026-08-01&end=2026-08-07');
      expect(days.map((d) => [d.date, d.value_native])).toEqual(
        cases.map(([day, , text]) => [`${day}T00:00:00Z`, text]),
      );
    });

    it('a pool whose days were all replaced has none, and the pool is still there (200, not 404)', async () => {
      const A = accountAt(0xc300);
      await h.ch.insert(Table.AmmDaily, [sentinel('2026-06-01', 500), dayRow(A, '2026-06-01', 400)]);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(A, 100_930_000, 1, { reserve_base: '1' })]);
      const res = await get(`/v2/amm/pools/${A}/history?interval=day&start=2026-06-01&end=2026-06-30`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, days: [] }]);
    });

    it('the days of a pool never come from a state read: interval=day reads amm_daily and the pool check only', async () => {
      const A = accountAt(0xc400);
      await h.ch.insert(Table.AmmDaily, [sentinel('2026-07-01', 600), dayRow(A, '2026-07-01', 600)]);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(A, 100_940_000, 1, { reserve_base: '1' })]);
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/amm/pools/${A}/history?interval=day`);
      expect(res.body.count).toBe(1);
      const sql = spy.mock.calls.map(([q]) => String(q));
      expect(sql.some((q) => new RegExp(`FROM ${Table.AmmDaily}\\b`).test(q))).toBe(true);
      // a page with days needs no look at the states
      expect(sql.some((q) => new RegExp(`FROM ${Table.AmmPoolStates}\\b`).test(q))).toBe(false);
    });
  });
});

// =====================================================================================================================
describe('the pool reads over a bulk of four parts (read_rows and the plans)', () => {
  // Every read is a primary-key read of the pool (and a range of its ledgers or days), however much the table holds: a
  // bulk of copies of real rows in four parts of 200,000 rows (`support/read-rows.ts`). The list is the one exception
  // (Ruling R-A4): it reads the table's newest versions, so its bound is the table.
  /** ClickHouse reads whole granules of 8192 rows. */
  const GRANULE = 8192;
  /**
   * The states of the pool are in 5 parts (the 4 of the bulk and the real one): a read in the order of the key takes about a
   * granule of each, and the page its own rows. The table holds 800,000 of them.
   */
  const STATE_READ_BOUND = (BULK_BASES.length + 2) * GRANULE;
  const MID = BULK_BASES[1] + BULK_LEDGERS / 2;
  const closeTimeOf = (ledger: string): string => `toDateTime({t0:UInt32} + (${ledger} - ${BULK_BASES[0]}), 'UTC')`;
  /** The days of the real pool are in the 5 parts of the month (4 of bulk pools): a granule of each at most. */
  const DAILY_READ_BOUND = (BULK_BASES.length + 2) * GRANULE;

  let h: Harness;
  let api: ApiClient;
  let pool: string;
  let t0: number;
  let swapper: string;
  let monthStart: string;
  let monthEnd: string;

  /** The reads of `table` while `path` was served, and the SQL (with its params) of the requests. */
  async function served(
    table: Table,
    path: string,
  ): Promise<{ reads: LoggedRead[]; statements: [string, Record<string, unknown>][]; body: Record<string, unknown> }> {
    const spy = jest.spyOn(h.ch, 'query');
    let body: Record<string, unknown> = {};
    const reads = await readsOf(h, table, async () => {
      body = (await api.ok(path)).body as Record<string, unknown>;
    });
    const statements = spy.mock.calls
      .filter(([sql]) => new RegExp(`FROM ${table}\\b`).test(String(sql)))
      .map(
        ([sql, params]) =>
          [String(sql), (params ?? {}) as Record<string, unknown>] as [string, Record<string, unknown>],
      );
    spy.mockRestore();
    return { reads, statements, body };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock+amm', env: NO_RATE_LIMIT });
    api = await h.api();
    const rates = new RatesService(h.ch, NATIVE);
    const accounts = [...ROWS_OF.keys()].sort(compare);
    await recomputeAmmPools(h.ch, rates, accounts);
    for (const day of DAYS) await computeAmmDaily(h.ch, rates, new Date(`${day}T00:00:00Z`));
    const times = await h.ch.query<{ ledger_index: number; t: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers}
        WHERE ledger_index IN (20005122, 29136413) ORDER BY ledger_index`,
    );
    t0 = Number(times[0].t) + 86_400;
    expect(t0 + (BULK_BASES[3] + BULK_PER_PART - BULK_BASES[0])).toBeLessThan(Number(times[1].t));
    const timed = { t0 };

    // ledger rows for the four ranges, so that the dates resolve across them
    await insertBulk(
      h,
      Table.Ledgers,
      `SELECT * FROM ${Table.Ledgers} WHERE ledger_index = 20005122 LIMIT 1`,
      timed,
      (base) => {
        const ledger = `toUInt32(${base} + n.number)`;
        return `${ledger} AS ledger_index, ${closeTimeOf(ledger)} AS close_time`;
      },
    );

    // the states of one pool: a row whose values are all there, copied into four ledger ranges below the real ones
    const [template] = await h.ch.query<{ amm_account: string }>(
      `SELECT amm_account FROM ${Table.AmmPoolStates}
        WHERE lp_supply IS NOT NULL AND trading_fee IS NOT NULL AND reserve_base IS NOT NULL AND reserve_counter IS NOT NULL
          AND lp_currency IS NOT NULL AND auction_holder IS NOT NULL AND auction_price IS NOT NULL
          AND auction_discounted_fee IS NOT NULL AND auction_expiration IS NOT NULL AND deleted = 0
        ORDER BY amm_account, ledger_index, tx_index LIMIT 1`,
    );
    expect(template).toBeDefined();
    pool = template.amm_account;
    await insertBulk(
      h,
      Table.AmmPoolStates,
      `SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {pool:String} AND lp_supply IS NOT NULL AND trading_fee IS NOT NULL
          AND reserve_base IS NOT NULL AND reserve_counter IS NOT NULL AND lp_currency IS NOT NULL AND auction_holder IS NOT NULL
          AND auction_price IS NOT NULL AND auction_discounted_fee IS NOT NULL AND auction_expiration IS NOT NULL AND deleted = 0
        ORDER BY ledger_index, tx_index LIMIT 1`,
      { pool, t0 },
      (base) =>
        `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, ${closeTimeOf(bulkLedger(base))} AS close_time, hex(rand64()) AS tx_hash`,
    );

    // the pools: bulk pools beside the real ones
    await insertBulk(
      h,
      Table.AmmPools,
      `SELECT * FROM ${Table.AmmPools} ORDER BY amm_account LIMIT 1`,
      {},
      (base) => `concat('rBulk', toString(${base} + n.number)) AS amm_account`,
    );

    // the days: bulk pools beside a real pool with swaps, in the month of that pool's newest day (one partition, four parts)
    const [busiest] = await h.ch.query<{ amm_account: string; latest: string }>(
      `SELECT amm_account, toString(max(day)) AS latest FROM ${Table.AmmDaily} WHERE amm_account != ''
        GROUP BY amm_account ORDER BY count() DESC, amm_account LIMIT 1`,
    );
    swapper = busiest.amm_account;
    const latest = new Date(`${busiest.latest}T00:00:00Z`);
    monthStart = `${busiest.latest.slice(0, 8)}01`;
    monthEnd = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await insertBulk(
      h,
      Table.AmmDaily,
      `SELECT * FROM ${Table.AmmDaily} WHERE amm_account = {swapper:String} ORDER BY day LIMIT 1`,
      { swapper, month: monthStart },
      (base) =>
        `concat('rBulk', toString(${base} + n.number)) AS amm_account, addDays(toDate({month:String}), n.number % 28) AS day, toUInt64(1000) AS version`,
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the seed is as assumed: the states of one pool in four parts, bulk pools, days in four parts', async () => {
    const [states] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AmmPoolStates} WHERE amm_account = {pool:String} AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${BULK_BASES[3] + BULK_LEDGERS}`,
      { pool },
    );
    expect([Number(states.n), Number(states.parts)]).toEqual([BULK_PER_PART * BULK_BASES.length, BULK_BASES.length]);
    const [pools] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AmmPools}`,
    );
    expect(Number(pools.n)).toBeGreaterThanOrEqual(BULK_PER_PART * BULK_BASES.length);
    expect(Number(pools.parts)).toBeGreaterThanOrEqual(BULK_BASES.length);
    const [days] = await h.ch.query<{ n: string; parts: string }>(
      `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AmmDaily} WHERE startsWith(amm_account, 'rBulk')`,
    );
    expect([Number(days.n), Number(days.parts)]).toEqual([BULK_PER_PART * BULK_BASES.length, BULK_BASES.length]);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;

    it('the history page of a pool with 800,000 states reads about the granules of its page and the window before it', async () => {
      for (const marker of [markerOf([MID, 1]), markerOf([BULK_BASES[3] + 5, 2]), markerOf([BULK_BASES[0] + 3, 0])]) {
        const path = `/v2/amm/pools/${pool}/history?limit=5&${direction}&marker=${marker}`;
        const { reads, body } = await served(Table.AmmPoolStates, path);
        // the page, and the window of the state before it (one read when the window holds every value)
        expect(reads.length).toBeGreaterThanOrEqual(2);
        for (const read of reads) {
          expect([
            path,
            read.query.slice(0, 60),
            read.read_rows <= STATE_READ_BOUND ? 'bounded' : read.read_rows,
          ]).toEqual([path, read.query.slice(0, 60), 'bounded']);
        }
        const history = body.history as Obj[];
        expect([path, history.length]).toEqual([path, 5]);
        // the states of the bulk are copies of one row: every value is there, from the page or from the window
        for (const state of history) expect(state).toMatchObject({ amm_account: pool, deleted: false });
        expect(history.every((s) => s.lp_supply !== undefined && s.auction_slot !== undefined)).toBe(true);
      }
    });

    it('the page read of the states is read in the order of the key, and stops after its rows', async () => {
      const path = `/v2/amm/pools/${pool}/history?limit=5&${direction}&marker=${markerOf([MID, 1])}`;
      const { statements } = await served(Table.AmmPoolStates, path);
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      await expectBoundedInOrderRead(h, sql, params, descending, path);
      // the primary key is used for the pool and a range of its ledgers
      const [primary] = primaryKeys(await explain(h, 'indexes = 1', innerRead(sql), params));
      expect(primary.keys).toEqual(['amm_account', 'ledger_index']);
      expect(primary.condition).toContain(`amm_account in ['${pool}'`);
      expect(primary.condition).toContain('ledger_index in');
      // the pool is most of the table, so the index leaves most granules: it is the LIMIT that stops the read
      expect(primary.parts[0]).toBe(primary.parts[1]);
    });

    it('the page of days reads the pool by its key among 800,000 rows of other pools, and the sentinels of the window', async () => {
      const window = `start=${monthStart}&end=${monthEnd}`;
      const path = `/v2/amm/pools/${swapper}/history?interval=day&limit=5&${direction}&${window}`;
      const { reads, statements, body } = await served(Table.AmmDaily, path);
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(DAILY_READ_BOUND);
      // the days are the pool's own, as a plain SELECT has them
      const expected = await h.ch.query<{ day_text: string }>(
        `SELECT toString(day) AS day_text FROM ${Table.AmmDaily}
          WHERE amm_account = {swapper:String} AND day BETWEEN {a:Date} AND {b:Date}
            AND (day, version) IN (SELECT day, max(version) FROM ${Table.AmmDaily} WHERE amm_account = '' GROUP BY day)
          ORDER BY day ${descending ? 'DESC' : 'ASC'} LIMIT 5`,
        { swapper, a: monthStart, b: monthEnd },
      );
      expect(expected.length).toBeGreaterThanOrEqual(1);
      expect((body.days as Obj[]).map((d) => String(d.date).slice(0, 10))).toEqual(expected.map((d) => d.day_text));

      // the plan: the rows of the pool are a range of the primary key (the pool, then its days), the page is read in the
      // order of the key and stops after its rows
      const page = statements.filter(([sql]) => isPageRead(sql));
      expect(page).toHaveLength(1);
      const [sql, params] = page[0];
      const plan = await explain(h, 'indexes = 1', sql, params);
      const [pageRead] = primaryKeys(plan);
      expect(pageRead.keys).toEqual(['amm_account', 'day']);
      expect(pageRead.condition).toContain(`amm_account in ['${swapper}'`);
      expect(pageRead.granules[0]).toBeLessThanOrEqual(2);
      expect(pageRead.granules[1]).toBeGreaterThan(40);
      expect(plan).toMatch(descending ? /Read type: InReverseOrder/ : /Read type: InOrder/);
      expect(plan).toMatch(/Limit \d+/);
      // and the sentinels are a prefix of it: the account '' and the days of the window
      const sentinels = /IN \((SELECT day, max\(version\)[\s\S]*?GROUP BY day)\)/.exec(sql)?.[1];
      expect(sentinels).toBeDefined();
      const [prefix] = primaryKeys(await explain(h, 'indexes = 1', sentinels as string, params));
      expect(prefix.keys).toEqual(['amm_account', 'day']);
      expect(prefix.condition).toContain("amm_account in ['', '']");
      // and only the days of the window: a range of the second column of the key
      expect(prefix.condition).toContain('day in [');
      expect(prefix.condition).toContain('day in (-Inf');
      expect(prefix.granules[0]).toBeLessThanOrEqual(2);
      expect(prefix.granules[1]).toBeGreaterThan(40);
    });
  });

  it('the pool by its account is a primary-key read: one granule out of the 800,000 pools', async () => {
    const path = `/v2/amm/pools/${pool}`;
    const { reads, statements } = await served(Table.AmmPools, path);
    expect(reads).toHaveLength(1);
    expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    const [sql, params] = statements[0];
    const [primary] = primaryKeys(await explain(h, 'indexes = 1', sql, params));
    expect(primary.keys).toEqual(['amm_account']);
    expect(primary.condition).toContain(`amm_account in ['${pool}'`);
    expect(primary.granules[0]).toBeLessThanOrEqual(2);
    expect(primary.granules[1]).toBeGreaterThan(80);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it('the list reads amm_pools and nothing else: no more rows than the table has, one pass, no FINAL', async () => {
    const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.AmmPools}`);
    for (const path of ['/v2/amm/pools?limit=200', '/v2/amm/pools?limit=200&asset=XRP&include_deleted=true']) {
      const spy = jest.spyOn(h.ch, 'query');
      await api.ok(path, 'pools');
      const sql = spy.mock.calls.map(([q]) => String(q));
      spy.mockRestore();
      const reads = await readsOf(h, Table.AmmPools, async () => {
        await api.ok(path, 'pools');
      });
      // one statement, over the table of the pools
      expect(sql).toHaveLength(1);
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(Number(n));
      expect(sql[0]).toContain(Table.AmmPools);
      expect(sql[0]).not.toMatch(/\bFINAL\b/i);
      for (const other of Object.values(Table)) {
        if (other !== Table.AmmPools)
          expect([path, new RegExp(`\\b(FROM|JOIN)\\s+${other}\\b`).test(sql[0])]).toEqual([path, false]);
      }
    }
  });

  it('the pair by its assets reads amm_pools alone, in one pass', async () => {
    const [stored] = await h.ch.query<Record<string, string>>(
      `SELECT base_currency, base_issuer, counter_currency, counter_issuer FROM ${Table.AmmPools} WHERE amm_account = {pool:String} LIMIT 1`,
      { pool },
    );
    const path = `/v2/amm/pools/${side(stored.base_currency, stored.base_issuer)}/${side(stored.counter_currency, stored.counter_issuer)}`;
    const { reads, statements, body } = await served(Table.AmmPools, path);
    expect(statements).toHaveLength(1);
    expect(reads).toHaveLength(1);
    expect((body.pool as Obj).amm_account).toBe(pool);
  });
});

// =====================================================================================================================
describe('the pool routes on Xahau', () => {
  // There is no AMM on Xahau: the list is empty and a pool is not found.
  let h: Harness;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers an empty list, for every filter, in JSON and CSV', async () => {
    for (const query of [
      '',
      '?include_deleted=true',
      '?asset=XAH',
      '?limit=5&asset=XAH&asset2=USD%2BrMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
    ]) {
      const res = await get(`/v2/amm/pools${query}`);
      expect([query, res.status, res.body]).toEqual([query, 200, { result: 'success', count: 0, pools: [] }]);
    }
    const csv = await get('/v2/amm/pools?format=csv');
    expect([csv.status, csv.text]).toEqual([200, '']);
  });

  it('answers 404 pool not found for the detail, the pair and the history', async () => {
    const issuer = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
    for (const path of [
      `/v2/amm/pools/${issuer}`,
      `/v2/amm/pools/XAH/USD+${issuer}`,
      `/v2/amm/pools/USD+${issuer}/XAH`,
      `/v2/amm/pools/${issuer}/history`,
      `/v2/amm/pools/${issuer}/history?interval=day`,
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'pool not found' }]);
    }
  });

  it('answers the errors of the request first, with the native currency of the network', async () => {
    const issuer = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
    const cases: [string, string][] = [
      ['/v2/amm/pools/rnotanaddress', 'invalid pool'],
      ['/v2/amm/pools/rnotanaddress/history', 'invalid pool'],
      [`/v2/amm/pools/XAH+${issuer}/USD+${issuer}`, 'XAH cannot have an issuer'],
      ['/v2/amm/pools/XRP/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q', 'base issuer is required'],
      [`/v2/amm/pools/${issuer}/history?interval=week`, 'invalid interval'],
      ['/v2/amm/pools?asset=XRP', 'issuer is required'],
    ];
    for (const [path, message] of cases) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
    }
  });
});

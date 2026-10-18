import {
  AmmGovernanceRow,
  AmmLiquidityRow,
  AmmPoolStatesRow,
  buildLedgerRows,
  ExchangesRow,
  getNetworkProfile,
  parseContextFor,
  Table,
} from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { accountAt, defined, hashOf, iso, primaryKeys, qs, served } from './support/amm';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead, explain, innerRead, isPageRead } from './support/plans';
import {
  BULK_BASES,
  BULK_LEDGERS,
  BULK_TX_INDEX,
  bulkLedger,
  insertBulk,
  LoggedRead,
  markerOf,
} from './support/read-rows';

/**
 * The event routes of a pool on a real ClickHouse: `GET /v2/amm/pools/:pool/swaps` (its exchange rows), `/liquidity` (its
 * creations, deposits, withdrawals, clawbacks and deletions) and `/governance` (its votes and bids).
 *
 * Four kinds of data:
 *  - the recorded AMM ledgers (`xrpl-amm`: 138 swaps, 8 liquidity events, a vote and a bid), with an oracle in plain
 *    JavaScript over the rows the parser builds (`buildLedgerRows`), not from the code under test. The aggregator has NOT run:
 *    `amm_pools` is empty, and the pools are found by their state rows;
 *  - rows made by hand for the cases the recordings do not hold: a filter that matches one row in seven, two pools for one
 *    pair beside order-book rows, a row written twice, a row above the committed head, a pool that has events and no state;
 *  - a bulk of four parts for the reads (`read_rows` and EXPLAIN, as `paged-reads.e2e-spec.ts`);
 *  - the Xahau ledgers (no AMM there).
 */

type Obj = Record<string, unknown>;
const RIPPLE_EPOCH = 946_684_800;
const side = (currency: string, issuer: string): string => (issuer ? `${currency}+${issuer}` : currency);
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
const VOTE_KEYS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'executed_time',
  'type',
  'account',
  'fee_voted',
  'trading_fee_after',
];
const BID_KEYS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'executed_time',
  'type',
  'account',
  'bid_min',
  'bid_max',
  'price_paid',
  'auction_slot',
];
const SLOT_KEYS = ['holder', 'discounted_fee', 'expiration', 'auth_accounts'];
const EVENTS = ['create', 'deposit', 'withdraw', 'clawback', 'delete'];

/** The keys of an object are those of `order` that it has, in that order (a key that is not in `order` is a failure). */
function expectOrdered(objects: Obj[], order: (o: Obj) => string[], label: unknown = ''): void {
  objects.forEach((object, i) => {
    const keys = Object.keys(object);
    expect([label, i, keys]).toEqual([label, i, order(object).filter((k) => keys.includes(k))]);
  });
}
const governanceOrder = (o: Obj): string[] => (o.type === 'bid' ? BID_KEYS : VOTE_KEYS);
function expectGovernanceOrdered(objects: Obj[], label: unknown = ''): void {
  expectOrdered(objects, governanceOrder, label);
  objects.forEach((o, i) => {
    if (o.auction_slot !== undefined) {
      const keys = Object.keys(o.auction_slot as Obj);
      expect([label, i, keys]).toEqual([label, i, SLOT_KEYS.filter((k) => keys.includes(k))]);
    }
  });
}

// =====================================================================================================================
// The oracle: the events of the recorded ledgers, in plain JavaScript

/** The object the API serves for a liquidity row. */
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

/** The object the API serves for a governance row: a vote, or a bid with the slot after it. */
function governanceOf(r: AmmGovernanceRow): Obj {
  const head = {
    amm_account: r.amm_account,
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    tx_hash: r.tx_hash,
    executed_time: iso(r.close_time),
    type: r.kind,
    account: r.account,
  };
  if (r.kind === 'vote') return defined({ ...head, fee_voted: r.fee_voted, trading_fee_after: r.trading_fee_after });
  const slot = defined({
    holder: r.slot_holder,
    discounted_fee: r.slot_discounted_fee,
    expiration: r.slot_expiration === null ? undefined : iso(RIPPLE_EPOCH + r.slot_expiration),
  });
  const known = Object.keys(slot).length > 0 || r.auth_accounts.length > 0;
  return defined({
    ...head,
    bid_min: r.bid_min,
    bid_max: r.bid_max,
    price_paid: r.price_paid,
    auction_slot: known ? { ...slot, auth_accounts: [...r.auth_accounts] } : undefined,
  });
}

const byKey = (a: { ledger_index: number; tx_index: number }, b: { ledger_index: number; tx_index: number }): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

const CONTEXT = parseContextFor(getNetworkProfile('xrpl'));
const BUILT = fixtureSource('xrpl-amm')
  .list()
  .map((ledger) => buildLedgerRows(ledger, CONTEXT));
const LIQUIDITY = BUILT.flatMap((b) => b.ammLiquidity).sort(byKey);
const GOVERNANCE = BUILT.flatMap((b) => b.ammGovernance).sort(byKey);
const SWAPS = BUILT.flatMap((b) => b.exchanges).filter((e) => e.amm_account !== '');
const STATES = BUILT.flatMap((b) => b.ammPoolStates);
const group = <T extends { amm_account: string }>(rows: T[]): Map<string, T[]> => {
  const by = new Map<string, T[]>();
  for (const row of rows) by.set(row.amm_account, [...(by.get(row.amm_account) ?? []), row]);
  return by;
};
const LIQUIDITY_OF = group(LIQUIDITY);
const GOVERNANCE_OF = group(GOVERNANCE);
const SWAPS_OF = group(SWAPS);
const STATES_OF = group(STATES);
/** The XRP/RLUSD pool of the recordings: two deposits and a withdrawal, and swaps. */
const RHW = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
/** The TUJ/XRP pool: six swaps in one ledger, on a pair of its own. */
const TUJ = 'rGuYK1v7kyrKEa86wPN2M9CHpT9LiWFr5m';
const pairOf = (pool: string): { base: string; counter: string } => {
  const s = STATES_OF.get(pool)![0];
  return { base: side(s.base_currency, s.base_issuer), counter: side(s.counter_currency, s.counter_issuer) };
};

interface PageBody {
  result: string;
  count: number;
  marker?: string;
  liquidity?: Obj[];
  governance?: Obj[];
  exchanges?: Obj[];
}

// =====================================================================================================================
describe('the AMM event routes over the recorded AMM ledgers', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);
  /** The closing time of a ledger of the recordings. */
  const closeOf = (ledger: number): number => STATES.find((s) => s.ledger_index === ledger)!.close_time;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: 8 liquidity events of 6 pools, a vote and a bid, 138 swaps, and no pool row yet', async () => {
    expect(LIQUIDITY).toHaveLength(8);
    expect(LIQUIDITY_OF.size).toBe(6);
    expect(LIQUIDITY_OF.get(RHW)).toHaveLength(3);
    expect(new Set(LIQUIDITY.map((l) => l.event))).toEqual(new Set(['create', 'deposit', 'withdraw']));
    expect(LIQUIDITY.some((l) => l.mode === '')).toBe(true);
    expect(GOVERNANCE.map((g) => g.kind).sort()).toEqual(['bid', 'vote']);
    expect(GOVERNANCE_OF.size).toBe(2);
    expect(SWAPS).toHaveLength(138);
    expect(SWAPS_OF.get(TUJ)).toHaveLength(6);
    expect(STATES.filter((s) => !LIQUIDITY_OF.has(s.amm_account)).length).toBeGreaterThan(0);
    const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.AmmPools}`);
    expect(Number(n)).toBe(0);
  });

  // -- liquidity -------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool/liquidity', () => {
    it('serves the events of every pool as the oracle has them, in the pinned key order', async () => {
      for (const [pool, rows] of LIQUIDITY_OF) {
        const res = await get(`/v2/amm/pools/${pool}/liquidity`);
        expect([pool, res.status]).toEqual([pool, 200]);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Object.keys(res.body)).toEqual(['result', 'count', 'liquidity']);
        expect(res.body.result).toBe('success');
        expect(res.body.count).toBe(rows.length);
        expect([pool, res.body.liquidity]).toEqual([pool, rows.map(liquidityOf)]);
        expectOrdered(res.body.liquidity, () => LIQUIDITY_KEYS, pool);
      }
    });

    it('serves the amounts signed from the point of view of the pool, and the mode only where there is one', async () => {
      const all = (await get(`/v2/amm/pools/${RHW}/liquidity`)).body.liquidity as Obj[];
      expect(all.map((e) => e.event)).toEqual(['deposit', 'deposit', 'withdraw']);
      expect(all.map((e) => e.mode)).toEqual(['single_asset', 'two_asset', 'single_asset']);
      expect(String(all[2].lp_tokens).startsWith('-')).toBe(true);
      const created = (await get(`/v2/amm/pools/${LIQUIDITY.find((l) => l.event === 'create')!.amm_account}/liquidity`))
        .body.liquidity as Obj[];
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ event: 'create' });
      expect(created[0]).not.toHaveProperty('mode');
    });

    it('a pool that has states and no liquidity events has an empty list, not a 404', async () => {
      const quiet = STATES.find((s) => !LIQUIDITY_OF.has(s.amm_account))!.amm_account;
      const res = await get(`/v2/amm/pools/${quiet}/liquidity`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, liquidity: [] }]);
    });

    it('is found as soon as its ledger is committed: the detail, which reads what the aggregator writes, still says 404', async () => {
      expect((await get(`/v2/amm/pools/${RHW}/liquidity`)).status).toBe(200);
      expect((await get(`/v2/amm/pools/${RHW}/governance`)).status).toBe(200);
      expect((await get(`/v2/amm/pools/${RHW}/swaps`)).status).toBe(200);
      const detail = await get(`/v2/amm/pools/${RHW}`);
      expect([detail.status, detail.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
    });

    it('is ascending by default and descending with descending=true, the same events the other way round', async () => {
      const rows = LIQUIDITY_OF.get(RHW)!.map(liquidityOf);
      const asc = await get(`/v2/amm/pools/${RHW}/liquidity?descending=false`);
      const desc = await get(`/v2/amm/pools/${RHW}/liquidity?descending=true`);
      expect(asc.body.liquidity).toEqual(rows);
      expect(desc.body.liquidity).toEqual([...rows].reverse());
    });

    it('pages with the marker (ledger_index, tx_index): pages of 1 and 2 concatenate to the whole, both ways', async () => {
      const rows = LIQUIDITY_OF.get(RHW)!.map(liquidityOf);
      for (const descending of [false, true]) {
        for (const limit of [1, 2]) {
          const walked = await pages<PageBody>(
            `/v2/amm/pools/${RHW}/liquidity?descending=${descending}`,
            limit,
            'liquidity',
          );
          const expected = descending ? [...rows].reverse() : rows;
          expect([descending, limit, walked.flatMap((p) => p.liquidity)]).toEqual([descending, limit, expected]);
          walked.forEach((page, i) => {
            expect(page.count).toBe(page.liquidity!.length);
            expect([limit, i, page.marker === undefined]).toEqual([limit, i, i === walked.length - 1]);
          });
        }
      }
      const first = (await get(`/v2/amm/pools/${RHW}/liquidity?limit=2`)).body as PageBody;
      const second = LIQUIDITY_OF.get(RHW)![1];
      expect(decodeMarker(first.marker!)).toEqual([second.ledger_index, second.tx_index]);
      const desc = (await get(`/v2/amm/pools/${RHW}/liquidity?limit=2&descending=true`)).body as PageBody;
      const middle = LIQUIDITY_OF.get(RHW)![1];
      expect(decodeMarker(desc.marker!)).toEqual([middle.ledger_index, middle.tx_index]);
    });

    it('start and end are dates: the events of the ledgers that closed in them', async () => {
      const rows = LIQUIDITY_OF.get(RHW)!;
      const [a, b, c] = rows;
      const at = (row: AmmLiquidityRow, shift = 0): string => iso(closeOf(row.ledger_index) + shift);
      const cases: [Record<string, string>, AmmLiquidityRow[]][] = [
        [{ start: at(b) }, [b, c]],
        [{ end: at(b) }, [a, b]],
        [{ end: at(b, -1) }, [a]],
        [{ start: at(b), end: at(b) }, [b]],
        [{ start: at(a), end: at(c) }, [a, b, c]],
        [{ start: at(c, 1) }, []],
        [{ start: '2030-01-01' }, []],
        [{ end: '2001-01-01' }, []],
      ];
      for (const [params, expected] of cases) {
        const res = await get(`/v2/amm/pools/${RHW}/liquidity${qs(params)}`);
        expect([params, res.status, res.body.liquidity]).toEqual([params, 200, expected.map(liquidityOf)]);
      }
    });

    it('filters by event and by account, which can be combined', async () => {
      const rows = LIQUIDITY_OF.get(RHW)!;
      for (const event of EVENTS) {
        const res = await get(`/v2/amm/pools/${RHW}/liquidity?event=${event}`);
        expect([event, res.status, res.body.liquidity]).toEqual([
          event,
          200,
          rows.filter((r) => r.event === event).map(liquidityOf),
        ]);
      }
      const account = rows[0].account;
      const mine = await get(`/v2/amm/pools/${RHW}/liquidity?account=${account}`);
      expect(mine.body.liquidity).toEqual(rows.filter((r) => r.account === account).map(liquidityOf));
      const both = await get(`/v2/amm/pools/${RHW}/liquidity?account=${account}&event=withdraw`);
      expect(both.body.liquidity).toEqual(
        rows.filter((r) => r.account === account && r.event === 'withdraw').map(liquidityOf),
      );
      expect((await get(`/v2/amm/pools/${RHW}/liquidity?account=${accountAt(0xf0f0)}`)).body.liquidity).toEqual([]);
      // an empty filter is none
      const empty = await get(`/v2/amm/pools/${RHW}/liquidity?event=&account=`);
      expect(empty.body.liquidity).toEqual(rows.map(liquidityOf));
      // the first of a repeated one wins
      const twice = await get(`/v2/amm/pools/${RHW}/liquidity?event=withdraw&event=deposit`);
      expect(twice.body.liquidity).toEqual(rows.filter((r) => r.event === 'withdraw').map(liquidityOf));
    });

    it('answers 400 invalid event for an event the parser does not write, in any other case or spelling', async () => {
      for (const event of ['DEPOSIT', 'Deposit', 'swap', 'vote', 'deposit%20', '%20deposit', 'depositx', '0']) {
        const res = await get(`/v2/amm/pools/${RHW}/liquidity?event=${event}`);
        expect([event, res.status, res.body]).toEqual([event, 400, { result: 'error', message: 'invalid event' }]);
      }
    });

    it('answers 400 invalid pool for a text that is no address, and 404 pool not found for an address that is no pool', async () => {
      for (const pool of ['rnotanaddress', 'x', RHW.slice(0, -1), `${RHW}x`]) {
        const res = await get(`/v2/amm/pools/${pool}/liquidity`);
        expect([pool, res.status, res.body]).toEqual([pool, 400, { result: 'error', message: 'invalid pool' }]);
      }
      const unknown = await get(`/v2/amm/pools/${accountAt(0xdead)}/liquidity`);
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
    });

    it('answers the errors in the order pool, start, end, limit, event, marker, then the 404', async () => {
      const unknown = accountAt(0xdead);
      const cases: [string, string, number, string][] = [
        ['rnotanaddress', 'start=x&end=x&event=x&marker=!', 400, 'invalid pool'],
        [unknown, 'start=x&end=x&event=x&marker=!', 400, 'invalid start date format'],
        [unknown, 'end=x&event=x&marker=!', 400, 'invalid end date format'],
        [unknown, 'event=x&marker=!', 400, 'invalid event'],
        [unknown, 'marker=!', 400, 'invalid marker'],
        [unknown, '', 404, 'pool not found'],
      ];
      for (const [pool, query, status, message] of cases) {
        const res = await get(`/v2/amm/pools/${pool}/liquidity?${query}`);
        expect([pool, query, res.status, res.body]).toEqual([pool, query, status, { result: 'error', message }]);
      }
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      for (const marker of [
        '!!!',
        'e30',
        markerOf([1]),
        markerOf([1, 2, 3]),
        markerOf(['a', 'b']),
        markerOf([-1, 0]),
      ]) {
        const res = await get(`/v2/amm/pools/${RHW}/liquidity?marker=${marker}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
      // a marker past the last event is an empty page
      const past = await get(`/v2/amm/pools/${RHW}/liquidity?marker=${markerOf([999_999_999, 0])}`);
      expect([past.status, past.body]).toEqual([200, { result: 'success', count: 0, liquidity: [] }]);
    });

    it('sets the Link header on a page with a next one, for JSON and CSV, and none on the last page', async () => {
      const page = await get(`/v2/amm/pools/${RHW}/liquidity?limit=1&event=deposit`);
      const origin = new URL(page.request.url).origin;
      expect(page.headers.link).toBe(
        `<${origin}/v2/amm/pools/${RHW}/liquidity?limit=1&event=deposit&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get(`/v2/amm/pools/${RHW}/liquidity?limit=1&event=deposit&format=csv`);
      expect(csv.headers.link).toBe(
        `<${origin}/v2/amm/pools/${RHW}/liquidity?limit=1&event=deposit&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get(`/v2/amm/pools/${RHW}/liquidity`)).headers.link).toBeUndefined();
      expect((await get(`/v2/amm/pools/${RHW}/liquidity?format=csv`)).headers.link).toBeUndefined();
    });

    it('format=csv: text/csv named after the pool, one row an event, the same columns for every page', async () => {
      const res = await get(`/v2/amm/pools/${RHW}/liquidity?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${RHW} - amm liquidity`));
      const table = lines(res.text).map(cells);
      expect(table).toHaveLength(1 + 3);
      const header = LIQUIDITY_KEYS.map((c) => `"${c}"`);
      expect(table[0]).toEqual(header);
      expect(table[1][0]).toBe(`"${RHW}"`);
      // a creation has no mode: the column is there, empty
      const created = LIQUIDITY.find((l) => l.event === 'create')!;
      const row = lines((await get(`/v2/amm/pools/${created.amm_account}/liquidity?format=csv`)).text).map(cells);
      expect(row[0]).toEqual(header);
      expect(row[1][LIQUIDITY_KEYS.indexOf('mode')]).toBe('""');
      expect(row[1][LIQUIDITY_KEYS.indexOf('event')]).toBe('"create"');
      // every page of a walk has the same header
      let marker: string | undefined;
      let page = 0;
      do {
        const more = marker ? `&marker=${marker}` : '';
        const part = await get(`/v2/amm/pools/${RHW}/liquidity?format=csv&limit=1${more}`);
        expect([page, lines(part.text)[0].split(',')]).toEqual([page, header]);
        marker = ((await get(`/v2/amm/pools/${RHW}/liquidity?limit=1${more}`)).body as PageBody).marker;
        page += 1;
      } while (marker && page < 10);
      expect(page).toBe(3);
      const empty = await get(`/v2/amm/pools/${RHW}/liquidity?format=csv&event=delete`);
      expect([empty.status, empty.text]).toEqual([200, '']);
      const bad = await get(`/v2/amm/pools/${RHW}/liquidity?format=csv&event=nope`);
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid event' }]);
    });

    it('ignores the params it does not know, and limits like the other lists: 200 by default, at most 1000', async () => {
      const rows = LIQUIDITY_OF.get(RHW)!.map(liquidityOf);
      expect((await get(`/v2/amm/pools/${RHW}/liquidity?nothing=1&interval=day`)).body.liquidity).toEqual(rows);
      for (const [limit, count] of [
        ['1', 1],
        ['2.9', 2],
        ['0', 3],
        ['-5', 3],
        ['abc', 3],
        ['', 3],
        ['5000', 3],
      ] as const) {
        const res = await get(`/v2/amm/pools/${RHW}/liquidity?limit=${limit}`);
        expect([limit, res.status, res.body.count]).toEqual([limit, 200, count]);
      }
    });
  });

  // -- governance ------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool/governance', () => {
    it('serves the votes and bids of every pool as the oracle has them, in the pinned key order', async () => {
      for (const [pool, rows] of GOVERNANCE_OF) {
        const res = await get(`/v2/amm/pools/${pool}/governance`);
        expect([pool, res.status]).toEqual([pool, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'count', 'governance']);
        expect(res.body.count).toBe(rows.length);
        expect([pool, res.body.governance]).toEqual([pool, rows.map(governanceOf)]);
        expectGovernanceOrdered(res.body.governance, pool);
      }
      const bid = GOVERNANCE.find((g) => g.kind === 'bid')!;
      const bids = (await get(`/v2/amm/pools/${bid.amm_account}/governance`)).body.governance as Obj[];
      expect(bids[0]).toMatchObject({ type: 'bid', price_paid: bid.price_paid });
      expect((bids[0].auction_slot as Obj).auth_accounts).toEqual([]);
      const vote = GOVERNANCE.find((g) => g.kind === 'vote')!;
      const votes = (await get(`/v2/amm/pools/${vote.amm_account}/governance`)).body.governance as Obj[];
      expect(votes[0]).toMatchObject({ type: 'vote', fee_voted: vote.fee_voted });
      expect(votes[0]).not.toHaveProperty('auction_slot');
    });

    it('filters by type, and answers 400 invalid type for anything else', async () => {
      const bid = GOVERNANCE.find((g) => g.kind === 'bid')!;
      const mine = (type: string): Obj[] =>
        GOVERNANCE_OF.get(bid.amm_account)!
          .filter((g) => g.kind === type)
          .map(governanceOf);
      expect((await get(`/v2/amm/pools/${bid.amm_account}/governance?type=bid`)).body.governance).toEqual(mine('bid'));
      expect((await get(`/v2/amm/pools/${bid.amm_account}/governance?type=vote`)).body.governance).toEqual(
        mine('vote'),
      );
      expect((await get(`/v2/amm/pools/${bid.amm_account}/governance?type=`)).body.governance).toEqual(
        GOVERNANCE_OF.get(bid.amm_account)!.map(governanceOf),
      );
      for (const type of ['BID', 'Vote', 'bids', 'kind', 'deposit', '0']) {
        const res = await get(`/v2/amm/pools/${bid.amm_account}/governance?type=${type}`);
        expect([type, res.status, res.body]).toEqual([type, 400, { result: 'error', message: 'invalid type' }]);
      }
    });

    it('start and end are dates; a pool with states and no votes or bids has an empty list; an unknown pool is 404', async () => {
      const bid = GOVERNANCE.find((g) => g.kind === 'bid')!;
      const before = await get(`/v2/amm/pools/${bid.amm_account}/governance${qs({ end: iso(bid.close_time - 1) })}`);
      expect(before.body.governance).toEqual([]);
      const around = await get(
        `/v2/amm/pools/${bid.amm_account}/governance${qs({ start: iso(bid.close_time), end: iso(bid.close_time) })}`,
      );
      expect(around.body.governance).toEqual([governanceOf(bid)]);
      const quiet = STATES.find((s) => !GOVERNANCE_OF.has(s.amm_account))!.amm_account;
      const none = await get(`/v2/amm/pools/${quiet}/governance`);
      expect([none.status, none.body]).toEqual([200, { result: 'success', count: 0, governance: [] }]);
      const unknown = await get(`/v2/amm/pools/${accountAt(0xdead)}/governance`);
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const invalid = await get('/v2/amm/pools/rnotanaddress/governance');
      expect([invalid.status, invalid.body]).toEqual([400, { result: 'error', message: 'invalid pool' }]);
    });

    it('answers the errors in the order pool, start, end, limit, type, marker, then the 404', async () => {
      const unknown = accountAt(0xdead);
      const cases: [string, string, string][] = [
        ['rnotanaddress', 'start=x&end=x&type=x&marker=!', 'invalid pool'],
        [unknown, 'start=x&end=x&type=x&marker=!', 'invalid start date format'],
        [unknown, 'end=x&type=x&marker=!', 'invalid end date format'],
        [unknown, 'type=x&marker=!', 'invalid type'],
        [unknown, 'marker=!', 'invalid marker'],
        [unknown, '', 'pool not found'],
      ];
      for (const [pool, query, message] of cases) {
        const res = await get(`/v2/amm/pools/${pool}/governance?${query}`);
        expect([pool, query, res.body]).toEqual([pool, query, { result: 'error', message }]);
      }
    });

    it('format=csv: named after the pool, the same columns for a vote and for a bid, the slot in four columns', async () => {
      const header = [
        'amm_account',
        'ledger_index',
        'tx_index',
        'tx_hash',
        'executed_time',
        'type',
        'account',
        'fee_voted',
        'trading_fee_after',
        'bid_min',
        'bid_max',
        'price_paid',
        'auction_slot.holder',
        'auction_slot.discounted_fee',
        'auction_slot.expiration',
        'auction_slot.auth_accounts',
      ].map((c) => `"${c}"`);
      for (const row of GOVERNANCE) {
        const res = await get(`/v2/amm/pools/${row.amm_account}/governance?format=csv`);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toBe(csvDisposition(`${row.amm_account} - amm governance`));
        const table = lines(res.text).map(cells);
        expect([row.kind, table[0]]).toEqual([row.kind, header]);
        expect(table).toHaveLength(2);
        expect(table[1][header.indexOf('"type"')]).toBe(`"${row.kind}"`);
        // what the row does not have is an empty cell
        expect(table[1][header.indexOf('"fee_voted"')]).toBe(row.kind === 'vote' ? `"${row.fee_voted}"` : '""');
        expect(table[1][header.indexOf('"price_paid"')]).toBe(row.kind === 'bid' ? `"${row.price_paid}"` : '""');
      }
    });

    it('sets the Link header on a page with a next one; there is none on the last page', async () => {
      // one pool, so one row: no next page
      const bid = GOVERNANCE.find((g) => g.kind === 'bid')!;
      expect((await get(`/v2/amm/pools/${bid.amm_account}/governance?limit=1`)).headers.link).toBeUndefined();
    });
  });

  // -- swaps -----------------------------------------------------------------------------------------------------------

  describe('GET /v2/amm/pools/:pool/swaps', () => {
    /** The exchange route's answer for the pair of the pool: the swaps of that pair, reduced to the pool's own. */
    async function viaExchanges(pool: string, query = ''): Promise<Obj[]> {
      const { base, counter } = pairOf(pool);
      const res = await get(`/v2/exchanges/${base}/${counter}?amm=only&limit=400${query}`);
      expect(res.status).toBe(200);
      return (res.body.exchanges as Obj[]).filter((e) => e.amm_account === pool);
    }

    it('serves the swaps of every pool exactly as /v2/exchanges/:base/:counter?amm=only serves them, filtered to the pool', async () => {
      let total = 0;
      for (const [pool, rows] of SWAPS_OF) {
        const res = await get(`/v2/amm/pools/${pool}/swaps?limit=400`);
        expect([pool, res.status]).toEqual([pool, 200]);
        expect(Object.keys(res.body)).toEqual(['result', 'count', 'exchanges']);
        expect(res.body.count).toBe(rows.length);
        expect([pool, res.body.exchanges]).toEqual([pool, await viaExchanges(pool)]);
        total += res.body.exchanges.length;
        for (const exchange of res.body.exchanges as Obj[]) {
          expect(Object.keys(exchange).at(-1)).toBe('amm_account');
          expect(exchange.provider).toBe(pool);
          expect(exchange.offer_sequence).toBe(0);
        }
      }
      expect(total).toBe(138);
    });

    it('serves the pair in the canonical order of the pool, whatever the rows are asked in: base and counter are the stored ones', async () => {
      const exchanges = (await get(`/v2/amm/pools/${TUJ}/swaps`)).body.exchanges as Obj[];
      const state = STATES_OF.get(TUJ)![0];
      expect(exchanges.length).toBe(6);
      for (const e of exchanges) {
        expect(e).toMatchObject({ base_currency: state.base_currency, counter_currency: state.counter_currency });
        expect(e.base_issuer).toBe(state.base_issuer || undefined);
      }
      // the rows are the stored ones: the oracle's amounts and rate for the first
      const first = SWAPS_OF.get(TUJ)!.sort(byKey)[0];
      expect(exchanges[0]).toMatchObject({
        base_amount: first.base_amount,
        counter_amount: first.counter_amount,
        node_index: first.node_index,
        tx_hash: first.tx_hash,
      });
    });

    it('pages exactly as the exchange route does: the same pages, the same markers, both ways', async () => {
      // the TUJ/XRP pair has this pool alone, so a page of the exchange route is a page of the swaps
      const { base, counter } = pairOf(TUJ);
      for (const descending of [false, true]) {
        for (const limit of [1, 2, 4]) {
          const swaps = await pages<PageBody>(
            `/v2/amm/pools/${TUJ}/swaps?descending=${descending}`,
            limit,
            'exchanges',
          );
          const exchanges = await pages<PageBody>(
            `/v2/exchanges/${base}/${counter}?amm=only&descending=${descending}`,
            limit,
            'exchanges',
          );
          expect([descending, limit, swaps]).toEqual([descending, limit, exchanges]);
          expect(swaps).toHaveLength(Math.ceil(6 / limit));
        }
      }
      const first = (await get(`/v2/amm/pools/${TUJ}/swaps?limit=2`)).body as PageBody;
      const second = SWAPS_OF.get(TUJ)!.sort(byKey)[1];
      expect(decodeMarker(first.marker!)).toEqual([second.ledger_index, second.tx_index, second.node_index]);
    });

    it('lists a pool of a pair with many pools only by its own account', async () => {
      // RHW swaps are among the XRP/RLUSD ones: the exchange route of the pair lists them with the swaps of other pools
      const { base, counter } = pairOf(RHW);
      const all = await get(`/v2/exchanges/${base}/${counter}?amm=only&limit=400`);
      expect(all.body.exchanges.every((e: Obj) => e.amm_account !== undefined)).toBe(true);
      const own = await get(`/v2/amm/pools/${RHW}/swaps?limit=400`);
      expect(own.body.exchanges.length).toBe(SWAPS_OF.get(RHW)!.length);
      expect(own.body.exchanges.every((e: Obj) => e.amm_account === RHW)).toBe(true);
    });

    it('takes start, end, descending and autobridged like the exchange route', async () => {
      const rows = SWAPS_OF.get(RHW)!.sort(byKey);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const ledgers = [...new Set(rows.map((r) => r.ledger_index))];
      const closeOfLedger = (ledger: number): number => rows.find((r) => r.ledger_index === ledger)!.close_time;
      const window = { start: iso(closeOfLedger(ledgers[1])), end: iso(closeOfLedger(ledgers[ledgers.length - 1])) };
      const q = qs({ ...window, limit: 400 });
      const swaps = (await get(`/v2/amm/pools/${RHW}/swaps${q}`)).body.exchanges;
      expect(swaps).toEqual(await viaExchanges(RHW, `&start=${window.start}&end=${window.end}`));
      expect(swaps.length).toBeGreaterThan(0);
      expect(swaps.length).toBeLessThan(rows.length);
      expect((await get(`/v2/amm/pools/${RHW}/swaps?descending=true&limit=400`)).body.exchanges).toEqual(
        await viaExchanges(RHW, '&descending=true'),
      );
      const bridged = (await get(`/v2/amm/pools/${RHW}/swaps?autobridged=true&limit=400`)).body.exchanges as Obj[];
      expect(bridged).toEqual(await viaExchanges(RHW, '&autobridged=true'));
      expect(bridged.length).toBeGreaterThan(0);
      expect(bridged.length).toBeLessThan(rows.length);
      expect(bridged.every((e) => e.autobridged_currency !== undefined)).toBe(true);
      // a window without a swap is empty
      const none = await get(`/v2/amm/pools/${RHW}/swaps?start=2030-01-01`);
      expect([none.status, none.body]).toEqual([200, { result: 'success', count: 0, exchanges: [] }]);
    });

    it('is always the swaps of the pool: the amm param is ignored, whatever it says', async () => {
      const own = (await get(`/v2/amm/pools/${RHW}/swaps?limit=400`)).body.exchanges;
      for (const amm of ['exclude', 'include', 'only', 'bogus', '']) {
        const res = await get(`/v2/amm/pools/${RHW}/swaps?limit=400&amm=${amm}`);
        expect([amm, res.status, res.body.exchanges]).toEqual([amm, 200, own]);
      }
    });

    it('limits as the exchange route does: 200 by default, at most 400, a text that is no number is 400', async () => {
      expect((await get(`/v2/amm/pools/${RHW}/swaps?limit=2`)).body.count).toBe(2);
      expect((await get(`/v2/amm/pools/${RHW}/swaps?limit=0`)).body.count).toBe(SWAPS_OF.get(RHW)!.length);
      expect((await get(`/v2/amm/pools/${RHW}/swaps?limit=100000`)).body.count).toBe(SWAPS_OF.get(RHW)!.length);
      const bad = await get(`/v2/amm/pools/${RHW}/swaps?limit=abc`);
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid limit: NaN' }]);
    });

    it('format=csv: the columns of the exchange CSV and amm_account, named after the pool; the Link header on JSON and CSV', async () => {
      const res = await get(`/v2/amm/pools/${TUJ}/swaps?format=csv`);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition(`${TUJ} - amm swaps`));
      const table = lines(res.text).map(cells);
      expect(table).toHaveLength(1 + 6);
      expect(table[0].at(-1)).toBe('"amm_account"');
      expect(table[0].slice(0, 3)).toEqual(['"base_currency"', '"base_issuer"', '"base_amount"']);
      expect(table.slice(1).every((r) => r.at(-1) === `"${TUJ}"`)).toBe(true);
      const exchangeCsv = await get(`/v2/exchanges/${pairOf(TUJ).base}/${pairOf(TUJ).counter}?amm=only&format=csv`);
      expect(res.text).toBe(exchangeCsv.text);

      const page = await get(`/v2/amm/pools/${TUJ}/swaps?limit=2`);
      const origin = new URL(page.request.url).origin;
      expect(page.headers.link).toBe(
        `<${origin}/v2/amm/pools/${TUJ}/swaps?limit=2&marker=${page.body.marker}>; rel="next"`,
      );
      const csvPage = await get(`/v2/amm/pools/${TUJ}/swaps?limit=2&format=csv`);
      expect(csvPage.headers.link).toBe(
        `<${origin}/v2/amm/pools/${TUJ}/swaps?limit=2&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get(`/v2/amm/pools/${TUJ}/swaps`)).headers.link).toBeUndefined();
      const empty = await get(`/v2/amm/pools/${TUJ}/swaps?format=csv&start=2030-01-01`);
      expect([empty.status, empty.text]).toEqual([200, '']);
    });

    it('is not read as the pair form: /pools/<pool>/swaps is the swaps, /pools/<base>/<counter> is still the pair', async () => {
      const swaps = await get(`/v2/amm/pools/${RHW}/swaps`);
      expect(swaps.status).toBe(200);
      expect(swaps.body).toHaveProperty('exchanges');
      // the pair form needs the aggregator's pools, which are not there: a pair is 404, never the swaps
      const pair = await get(`/v2/amm/pools/${pairOf(RHW).base}/${pairOf(RHW).counter}`);
      expect([pair.status, pair.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
      const odd = await get(`/v2/amm/pools/${RHW}/history`);
      expect(odd.status).toBe(200);
    });

    it('answers 400 invalid pool, and 404 pool not found for an address that is no pool', async () => {
      const invalid = await get('/v2/amm/pools/rnotanaddress/swaps');
      expect([invalid.status, invalid.body]).toEqual([400, { result: 'error', message: 'invalid pool' }]);
      const unknown = await get(`/v2/amm/pools/${accountAt(0xdead)}/swaps`);
      expect([unknown.status, unknown.body]).toEqual([404, { result: 'error', message: 'pool not found' }]);
    });

    it('answers the errors in the order pool, start, end, limit, marker, then the 404', async () => {
      const unknown = accountAt(0xdead);
      const cases: [string, string, string][] = [
        ['rnotanaddress', 'start=x&end=x&limit=x&marker=!', 'invalid pool'],
        [unknown, 'start=x&end=x&limit=x&marker=!', 'invalid start date format'],
        [unknown, 'end=x&limit=x&marker=!', 'invalid end date format'],
        [unknown, 'limit=x&marker=!', 'invalid limit: NaN'],
        [unknown, 'marker=!', 'invalid marker'],
        [unknown, '', 'pool not found'],
      ];
      for (const [pool, query, message] of cases) {
        const res = await get(`/v2/amm/pools/${pool}/swaps?${query}`);
        expect([pool, query, res.body]).toEqual([pool, query, { result: 'error', message }]);
      }
    });

    it('answers 400 invalid marker for a marker that is none of its own', async () => {
      for (const marker of ['!!!', markerOf([1, 2]), markerOf(['a', 'b', 'c'])]) {
        const res = await get(`/v2/amm/pools/${RHW}/swaps?marker=${marker}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });
  });

  // -- failures --------------------------------------------------------------------------------------------------------

  describe('when the database fails', () => {
    const cases: [string, string, string][] = [
      ['the swaps', `/v2/amm/pools/${RHW}/swaps`, 'unable to retrieve swaps'],
      ['the liquidity', `/v2/amm/pools/${RHW}/liquidity`, 'unable to retrieve liquidity'],
      ['the governance', `/v2/amm/pools/${RHW}/governance`, 'unable to retrieve governance'],
    ];

    it.each(cases)('%s is a 500 with its own message', async (_name, path, message) => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      const res = await get(path);
      expect([res.status, res.body]).toEqual([500, { result: 'error', message }]);
    });

    it.each([Table.AmmLiquidity, Table.AmmGovernance, Table.Exchanges])(
      'also when only the read of %s fails, after the pool was found',
      async (table) => {
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(table) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const path = {
          [Table.AmmLiquidity]: `/v2/amm/pools/${RHW}/liquidity`,
          [Table.AmmGovernance]: `/v2/amm/pools/${RHW}/governance`,
          [Table.Exchanges]: `/v2/amm/pools/${RHW}/swaps`,
        }[table as string]!;
        const res = await get(path);
        expect([table, res.status]).toEqual([table, 500]);
      },
    );

    it('a mistake of the client stays a 400 while the database is down', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const path of [
        '/v2/amm/pools/rnotanaddress/swaps',
        `/v2/amm/pools/${RHW}/swaps?start=x`,
        `/v2/amm/pools/${RHW}/swaps?marker=!!!`,
        '/v2/amm/pools/rnotanaddress/liquidity',
        `/v2/amm/pools/${RHW}/liquidity?event=nope`,
        `/v2/amm/pools/${RHW}/liquidity?marker=!!!`,
        `/v2/amm/pools/${RHW}/governance?type=nope`,
        `/v2/amm/pools/${RHW}/governance?end=x`,
      ]) {
        expect([path, (await get(path)).status]).toEqual([path, 400]);
      }
    });
  });

  it('the event routes are served with the API key, like every route', async () => {
    for (const route of ['swaps', 'liquidity', 'governance']) {
      expect((await h.http().get(`/v2/amm/pools/${RHW}/${route}`)).status).toBe(401);
    }
  });
});

// =====================================================================================================================
describe('the event routes over events made by hand', () => {
  const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
  /** Between the close times of the recorded ledgers 100132150 and 102186243, one second a ledger: the order of the ledgers is the order of the times. */
  const closeOf = (ledger: number): number => 1_762_843_711 + (ledger - 100_132_150);
  const ACCOUNTS = [accountAt(0xa1), accountAt(0xa2), accountAt(0xa3)];

  const stateRow = (account: string, ledger: number, tx: number, over: Partial<AmmPoolStatesRow> = {}) =>
    ({
      amm_account: account,
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
    }) satisfies AmmPoolStatesRow;

  const liquidityRow = (
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
    account: ACCOUNTS[0],
    initiator: ACCOUNTS[0],
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

  const governanceRow = (
    pool: string,
    ledger: number,
    tx: number,
    over: Partial<AmmGovernanceRow> = {},
  ): AmmGovernanceRow => ({
    amm_account: pool,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: closeOf(ledger),
    kind: 'vote',
    account: ACCOUNTS[0],
    fee_voted: 500,
    trading_fee_after: 500,
    bid_min: null,
    bid_max: null,
    price_paid: null,
    slot_holder: null,
    slot_discounted_fee: null,
    slot_expiration: null,
    auth_accounts: [],
    ...over,
  });

  /** An exchange row of a pool (or, with no pool, of the order book) on the pair AAA/XRP. */
  const exchangeRow = (
    ledger: number,
    tx: number,
    node: number,
    pool = '',
    over: Partial<ExchangesRow> = {},
  ): ExchangesRow => ({
    base_currency: 'AAA',
    base_issuer: ISSUER,
    counter_currency: 'XRP',
    counter_issuer: '',
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx * 10 + node),
    node_index: node,
    close_time: closeOf(ledger),
    base_amount: '10',
    counter_amount: '5',
    base_amount_f: 10,
    counter_amount_f: 5,
    rate: '0.5',
    rate_f: 0.5,
    buyer: ACCOUNTS[0],
    seller: pool === '' ? ACCOUNTS[1] : pool,
    taker: ACCOUNTS[0],
    provider: pool === '' ? ACCOUNTS[1] : pool,
    offer_sequence: pool === '' ? 77 : 0,
    amm_account: pool,
    autobridged_currency: null,
    autobridged_issuer: null,
    tx_type: 'Payment',
    client: null,
    ...over,
  });

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = <T extends { marker?: string }>(p: string, limit: number, key: string): Promise<T[]> =>
    api.pages<T>(p, limit, key);
  let head: number;

  beforeAll(async () => {
    h = await startHarness({ seed: 'xrpl-amm', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    const [{ latest }] = await h.ch.query<{ latest: number }>(
      `SELECT max(ledger_index) AS latest FROM ${Table.Ledgers}`,
    );
    head = Number(latest);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a filter on the events of a pool', () => {
    // 14 events of one pool, two to a ledger; every seventh is a clawback, and the accounts take turns.
    const POOL = accountAt(0xe000);
    const EVENT = (i: number): string => (i % 7 === 6 ? 'clawback' : i % 2 === 0 ? 'deposit' : 'withdraw');
    const rows = Array.from({ length: 14 }, (_, i) =>
      liquidityRow(POOL, 100_500_001 + Math.floor(i / 2), i % 2, {
        event: EVENT(i),
        mode: EVENT(i) === 'clawback' ? '' : 'single_asset',
        account: ACCOUNTS[i % 3],
        initiator: EVENT(i) === 'clawback' ? accountAt(0xaa) : ACCOUNTS[i % 3],
        base_amount: String(i),
        lp_tokens: i % 2 === 0 ? String(i) : `-${i}`,
      }),
    );
    const asObjects = (list: AmmLiquidityRow[]): Obj[] => list.map(liquidityOf);

    beforeAll(async () => {
      await h.ch.insert(Table.AmmPoolStates, [stateRow(POOL, 100_500_000, 0)]);
      await h.ch.insert(Table.AmmLiquidity, rows);
    });

    it('serves every event, ascending by (ledger_index, tx_index) with two to a ledger, and the same the other way', async () => {
      const res = await get(`/v2/amm/pools/${POOL}/liquidity?limit=1000`);
      expect(res.body.liquidity).toEqual(asObjects(rows));
      expectOrdered(res.body.liquidity, () => LIQUIDITY_KEYS);
      const desc = await get(`/v2/amm/pools/${POOL}/liquidity?limit=1000&descending=true`);
      expect(desc.body.liquidity).toEqual(asObjects(rows).reverse());
      // a clawback is the holder's, started by the issuer
      const clawback = (res.body.liquidity as Obj[]).find((e) => e.event === 'clawback')!;
      expect(clawback.initiator).toBe(accountAt(0xaa));
      expect(clawback).not.toHaveProperty('mode');
    });

    it('pages by one and by three through the ledgers, a page cut inside a ledger continues with its next row', async () => {
      for (const descending of [false, true]) {
        for (const limit of [1, 3]) {
          const walked = await pages<PageBody>(
            `/v2/amm/pools/${POOL}/liquidity?descending=${descending}`,
            limit,
            'liquidity',
          );
          const want = descending ? asObjects(rows).reverse() : asObjects(rows);
          expect([descending, limit, walked.flatMap((p) => p.liquidity)]).toEqual([descending, limit, want]);
          expect(walked.slice(0, -1).every((p) => p.count === limit)).toBe(true);
        }
      }
      const inside = await get(`/v2/amm/pools/${POOL}/liquidity?limit=2&marker=${markerOf([100_500_001, 0])}`);
      expect((inside.body.liquidity as Obj[]).map((e) => [e.ledger_index, e.tx_index])).toEqual([
        [100_500_001, 1],
        [100_500_002, 0],
      ]);
    });

    it('a filter that matches one row in seven is applied inside the read: every page of the walk is full, in both directions', async () => {
      const want = rows.filter((r) => r.event === 'clawback');
      expect(want).toHaveLength(2);
      for (const descending of [false, true]) {
        const walked = await pages<PageBody>(
          `/v2/amm/pools/${POOL}/liquidity?event=clawback&descending=${descending}`,
          1,
          'liquidity',
        );
        const expected = descending ? asObjects(want).reverse() : asObjects(want);
        expect([descending, walked.flatMap((p) => p.liquidity)]).toEqual([descending, expected]);
        // no empty page in the middle, and no page that is short but has a next one
        expect(walked.map((p) => p.count)).toEqual([1, 1]);
        expect(walked[0].marker).toBeDefined();
        expect(walked[1].marker).toBeUndefined();
      }
      // the account filter: every third row, and the two filters together
      const mine = rows.filter((r) => r.account === ACCOUNTS[1]);
      const byAccount = await pages<PageBody>(`/v2/amm/pools/${POOL}/liquidity?account=${ACCOUNTS[1]}`, 2, 'liquidity');
      expect(byAccount.flatMap((p) => p.liquidity)).toEqual(asObjects(mine));
      expect(byAccount.slice(0, -1).every((p) => p.count === 2)).toBe(true);
      const both = rows.filter((r) => r.account === ACCOUNTS[1] && r.event === 'withdraw');
      const together = await pages<PageBody>(
        `/v2/amm/pools/${POOL}/liquidity?account=${ACCOUNTS[1]}&event=withdraw`,
        1,
        'liquidity',
      );
      expect(together.flatMap((p) => p.liquidity)).toEqual(asObjects(both));
      expect(together.every((p) => p.count === 1)).toBe(true);
    });

    it('a filter that matches nothing is an empty list, and so is a window without a match', async () => {
      const none = await get(`/v2/amm/pools/${POOL}/liquidity?event=create`);
      expect([none.status, none.body]).toEqual([200, { result: 'success', count: 0, liquidity: [] }]);
      const noMarker = await get(`/v2/amm/pools/${POOL}/liquidity?event=delete&limit=1`);
      expect(noMarker.body).not.toHaveProperty('marker');
    });
  });

  describe('which pool the events belong to', () => {
    it('lists the events of the pool and no other, and finds a pool by its states alone', async () => {
      const first = accountAt(0xe100);
      const second = accountAt(0xe101);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(first, 100_510_000, 0), stateRow(second, 100_510_000, 1)]);
      await h.ch.insert(Table.AmmLiquidity, [
        liquidityRow(first, 100_510_001, 0),
        liquidityRow(second, 100_510_001, 1),
        liquidityRow(first, 100_510_002, 0, { event: 'withdraw' }),
      ]);
      await h.ch.insert(Table.AmmGovernance, [
        governanceRow(first, 100_510_003, 0),
        governanceRow(second, 100_510_003, 1, { fee_voted: 7 }),
      ]);
      const own = (await get(`/v2/amm/pools/${first}/liquidity`)).body.liquidity as Obj[];
      expect(own.map((e) => [e.amm_account, e.ledger_index, e.event])).toEqual([
        [first, 100_510_001, 'deposit'],
        [first, 100_510_002, 'withdraw'],
      ]);
      const other = (await get(`/v2/amm/pools/${second}/liquidity`)).body.liquidity as Obj[];
      expect(other.map((e) => e.amm_account)).toEqual([second]);
      const governance = (await get(`/v2/amm/pools/${second}/governance`)).body.governance as Obj[];
      expect(governance.map((e) => [e.amm_account, e.fee_voted])).toEqual([[second, 7]]);
    });

    it('is 404 for an address that has events but no state in a committed ledger, and 200 empty for one that has only a state', async () => {
      const ghost = accountAt(0xe200);
      await h.ch.insert(Table.AmmLiquidity, [liquidityRow(ghost, 100_520_001, 0)]);
      await h.ch.insert(Table.AmmGovernance, [governanceRow(ghost, 100_520_001, 0)]);
      const above = accountAt(0xe201);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(above, head + 10, 0)]);
      const stateOnly = accountAt(0xe202);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(stateOnly, 100_520_000, 0)]);
      for (const route of ['liquidity', 'governance', 'swaps']) {
        for (const pool of [ghost, above]) {
          const res = await get(`/v2/amm/pools/${pool}/${route}`);
          expect([route, pool, res.status, res.body]).toEqual([
            route,
            pool,
            404,
            { result: 'error', message: 'pool not found' },
          ]);
        }
        const empty = await get(`/v2/amm/pools/${stateOnly}/${route}`);
        expect([route, empty.status, empty.body.count]).toEqual([route, 200, 0]);
      }
    });

    it('never serves a row above the committed head', async () => {
      const pool = accountAt(0xe300);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(pool, 100_530_000, 0)]);
      await h.ch.insert(Table.AmmLiquidity, [
        liquidityRow(pool, 100_530_001, 0),
        liquidityRow(pool, head + 1, 0, { event: 'withdraw' }),
      ]);
      await h.ch.insert(Table.AmmGovernance, [
        governanceRow(pool, 100_530_001, 0),
        governanceRow(pool, head + 1, 0, { kind: 'bid', fee_voted: null }),
      ]);
      await h.ch.insert(Table.Exchanges, [exchangeRow(100_530_001, 0, 0, pool), exchangeRow(head + 1, 0, 0, pool)]);
      expect(
        ((await get(`/v2/amm/pools/${pool}/liquidity`)).body.liquidity as Obj[]).map((e) => e.ledger_index),
      ).toEqual([100_530_001]);
      expect(
        ((await get(`/v2/amm/pools/${pool}/governance`)).body.governance as Obj[]).map((e) => e.ledger_index),
      ).toEqual([100_530_001]);
      expect(((await get(`/v2/amm/pools/${pool}/swaps`)).body.exchanges as Obj[]).map((e) => e.ledger_index)).toEqual([
        100_530_001,
      ]);
    });
  });

  describe('an event written twice', () => {
    it('is served once, and a page cut inside the duplicates neither repeats nor skips an event', async () => {
      const pool = accountAt(0xe400);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(pool, 100_540_000, 0)]);
      const events = [
        liquidityRow(pool, 100_540_001, 0, { base_amount: '1' }),
        liquidityRow(pool, 100_540_001, 1, { base_amount: '2' }),
        liquidityRow(pool, 100_540_001, 2, { base_amount: '3' }),
        liquidityRow(pool, 100_540_002, 0, { base_amount: '4' }),
      ];
      const votes = [
        governanceRow(pool, 100_540_001, 0, { fee_voted: 1 }),
        governanceRow(pool, 100_540_001, 1, { fee_voted: 2 }),
        governanceRow(pool, 100_540_002, 0, { fee_voted: 3 }),
      ];
      for (const [table, rows] of [
        [Table.AmmLiquidity, events],
        [Table.AmmGovernance, votes],
      ] as const) {
        await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
        await h.ch.insert(table, rows as unknown[]);
        await h.ch.command(
          `INSERT INTO ${table} SELECT * FROM ${table} WHERE amm_account = {a:String}`,
          { a: pool },
          { settings: { insert_deduplicate: 0 } },
        );
        const [{ n }] = await h.ch.query<{ n: string }>(
          `SELECT count() AS n FROM ${table} WHERE amm_account = {a:String}`,
          { a: pool },
        );
        expect(Number(n)).toBe(rows.length * 2);
      }
      const want = events.map(liquidityOf);
      expect((await get(`/v2/amm/pools/${pool}/liquidity`)).body.liquidity).toEqual(want);
      for (const descending of [false, true]) {
        for (const limit of [1, 2, 3]) {
          const walked = await pages<PageBody>(
            `/v2/amm/pools/${pool}/liquidity?descending=${descending}`,
            limit,
            'liquidity',
          );
          expect([descending, limit, walked.flatMap((p) => p.liquidity)]).toEqual([
            descending,
            limit,
            descending ? [...want].reverse() : want,
          ]);
          const gov = await pages<PageBody>(
            `/v2/amm/pools/${pool}/governance?descending=${descending}`,
            limit,
            'governance',
          );
          expect([descending, limit, gov.flatMap((p) => p.governance).map((v) => v!.fee_voted)]).toEqual([
            descending,
            limit,
            descending ? [3, 2, 1] : [1, 2, 3],
          ]);
        }
      }
    });
  });

  describe('governance', () => {
    const POOL = accountAt(0xe500);
    const SLOT_END = 840_000_000;
    const rows = [
      governanceRow(POOL, 100_550_001, 0, { fee_voted: 0, trading_fee_after: 0 }),
      governanceRow(POOL, 100_550_002, 0, {
        kind: 'bid',
        account: ACCOUNTS[1],
        fee_voted: null,
        trading_fee_after: null,
        bid_min: '10',
        bid_max: '12.5',
        price_paid: '11',
        slot_holder: ACCOUNTS[1],
        slot_discounted_fee: 0,
        slot_expiration: SLOT_END,
        auth_accounts: [accountAt(0xb1), accountAt(0xb2)],
      }),
      governanceRow(POOL, 100_550_003, 0, { account: ACCOUNTS[2], fee_voted: 650, trading_fee_after: 600 }),
      governanceRow(POOL, 100_550_003, 1, {
        kind: 'bid',
        fee_voted: null,
        trading_fee_after: null,
        bid_min: null,
        bid_max: null,
        price_paid: '0',
        slot_holder: ACCOUNTS[0],
        slot_discounted_fee: 22,
        slot_expiration: SLOT_END + 1,
        auth_accounts: [],
      }),
    ];

    beforeAll(async () => {
      await h.ch.insert(Table.AmmPoolStates, [stateRow(POOL, 100_550_000, 0)]);
      await h.ch.insert(Table.AmmGovernance, rows);
    });

    it('serves votes and bids in one list in the order of the ledger, a fee of 0 and a price of 0 as values, the keys pinned', async () => {
      const res = await get(`/v2/amm/pools/${POOL}/governance`);
      expect(res.body.governance).toEqual(rows.map(governanceOf));
      expectGovernanceOrdered(res.body.governance);
      const [vote, bid, , bareBid] = res.body.governance as Obj[];
      expect(vote).toMatchObject({ type: 'vote', fee_voted: 0, trading_fee_after: 0 });
      expect(bid).toMatchObject({
        type: 'bid',
        bid_min: '10',
        bid_max: '12.5',
        price_paid: '11',
        auction_slot: { holder: ACCOUNTS[1], discounted_fee: 0, expiration: iso(RIPPLE_EPOCH + SLOT_END) },
      });
      expect(((bid.auction_slot as Obj).auth_accounts as string[]).length).toBe(2);
      // a bid without BidMin and BidMax has neither key
      expect(Object.keys(bareBid)).toEqual([
        'amm_account',
        'ledger_index',
        'tx_index',
        'tx_hash',
        'executed_time',
        'type',
        'account',
        'price_paid',
        'auction_slot',
      ]);
    });

    it('filters by type inside the read: a walk by one has full pages, both ways', async () => {
      for (const type of ['bid', 'vote']) {
        const want = rows.filter((r) => r.kind === type).map(governanceOf);
        for (const descending of [false, true]) {
          const walked = await pages<PageBody>(
            `/v2/amm/pools/${POOL}/governance?type=${type}&descending=${descending}`,
            1,
            'governance',
          );
          expect([type, descending, walked.flatMap((p) => p.governance)]).toEqual([
            type,
            descending,
            descending ? [...want].reverse() : want,
          ]);
          expect(walked.map((p) => p.count)).toEqual([1, 1]);
        }
      }
    });

    it('pages through a ledger of two rows without repeating or skipping one', async () => {
      const want = rows.map(governanceOf);
      for (const limit of [1, 2, 3]) {
        const walked = await pages<PageBody>(`/v2/amm/pools/${POOL}/governance`, limit, 'governance');
        expect([limit, walked.flatMap((p) => p.governance)]).toEqual([limit, want]);
      }
      const first = (await get(`/v2/amm/pools/${POOL}/governance?limit=3`)).body as PageBody;
      expect(decodeMarker(first.marker!)).toEqual([100_550_003, 0]);
    });

    it('sets the Link header on a page with a next one, for JSON and CSV, and none on the last page', async () => {
      const page = await get(`/v2/amm/pools/${POOL}/governance?limit=1&type=bid`);
      const origin = new URL(page.request.url).origin;
      expect(page.headers.link).toBe(
        `<${origin}/v2/amm/pools/${POOL}/governance?limit=1&type=bid&marker=${page.body.marker}>; rel="next"`,
      );
      const csv = await get(`/v2/amm/pools/${POOL}/governance?limit=1&type=bid&format=csv`);
      expect(csv.headers.link).toBe(
        `<${origin}/v2/amm/pools/${POOL}/governance?limit=1&type=bid&format=csv&marker=${page.body.marker}>; rel="next"`,
      );
      expect((await get(`/v2/amm/pools/${POOL}/governance`)).headers.link).toBeUndefined();
      expect((await get(`/v2/amm/pools/${POOL}/governance?limit=2&type=bid`)).headers.link).toBeUndefined();
    });

    it('format=csv: one header for the votes and the bids of a page, the accounts of the slot in one cell', async () => {
      const res = await get(`/v2/amm/pools/${POOL}/governance?format=csv`);
      const table = lines(res.text).map(cells);
      expect(table).toHaveLength(1 + 4);
      const slotAccounts = table[0].indexOf('"auction_slot.auth_accounts"');
      expect(slotAccounts).toBeGreaterThan(0);
      expect(table.every((r) => r.length === table[0].length)).toBe(true);
      expect(table[2][slotAccounts]).toBe(`"${accountAt(0xb1)};${accountAt(0xb2)}"`);
      expect(table[1][slotAccounts]).toBe('""');
      expect(table[4][slotAccounts]).toBe('""');
    });
  });

  describe('swaps of two pools of one pair beside the order book', () => {
    const ONE = accountAt(0xe600);
    const TWO = accountAt(0xe601);
    // the pair AAA/XRP: the book trades and both pools' swaps interleave over the ledgers
    const book = [100_560_001, 100_560_003, 100_560_005, 100_560_007].map((l) => exchangeRow(l, 0, 0));
    const ones = [100_560_002, 100_560_003, 100_560_004, 100_560_006, 100_560_007].map((l, i) =>
      exchangeRow(l, 1, i % 2 === 0 ? 0 : 2, ONE, {
        base_amount: String(i + 1),
        tx_type: i === 3 ? 'OfferCreate' : 'Payment',
      }),
    );
    const twos = [100_560_002, 100_560_005, 100_560_006].map((l) => exchangeRow(l, 2, 0, TWO, { base_amount: '40' }));

    beforeAll(async () => {
      await h.ch.insert(Table.AmmPoolStates, [stateRow(ONE, 100_559_000, 0), stateRow(TWO, 100_559_000, 1)]);
      await h.ch.insert(Table.Exchanges, [...book, ...ones, ...twos]);
      // the dates of the window test are those of the ledgers: a ledger row for each ledger of the pool's swaps
      for (const ledger of new Set(ones.map((r) => r.ledger_index))) {
        await h.ch.command(
          `INSERT INTO ${Table.Ledgers}
           SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, toDateTime({time:UInt32}, 'UTC') AS close_time,
                                 {hash:String} AS ledger_hash)
             FROM (SELECT * FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1) AS tpl`,
          { ledger, time: closeOf(ledger), hash: hashOf(ledger) },
        );
      }
    });

    const keyOf = (e: Obj): unknown[] => [e.ledger_index, e.tx_index, e.node_index];

    it('lists the swaps of its own pool only, though the pair has the book and another pool', async () => {
      const mine = (await get(`/v2/amm/pools/${ONE}/swaps`)).body.exchanges as Obj[];
      expect(mine.map(keyOf)).toEqual(ones.map((r) => [r.ledger_index, r.tx_index, r.node_index]));
      expect(mine.every((e) => e.amm_account === ONE && e.provider === ONE)).toBe(true);
      const theirs = (await get(`/v2/amm/pools/${TWO}/swaps`)).body.exchanges as Obj[];
      expect(theirs.map(keyOf)).toEqual(twos.map((r) => [r.ledger_index, r.tx_index, r.node_index]));
      // the pair route sees all of it (the rows of the other cases of this suite are in other ledgers)
      const everything = (await get(`/v2/exchanges/AAA+${ISSUER}/XRP?limit=400`)).body.exchanges as Obj[];
      const all = everything.filter(
        (e) => Number(e.ledger_index) >= 100_560_000 && Number(e.ledger_index) < 100_570_000,
      );
      expect(all).toHaveLength(book.length + ones.length + twos.length);
      expect(all.filter((e) => e.amm_account === ONE)).toEqual(mine);
      expect(all.filter((e) => e.amm_account === TWO)).toEqual(theirs);
    });

    it('pages cut through ledgers that hold the swaps of both pools and the book neither repeat nor skip one, both ways', async () => {
      for (const pool of [ONE, TWO]) {
        const own = (await get(`/v2/amm/pools/${pool}/swaps?limit=400`)).body.exchanges as Obj[];
        for (const descending of [false, true]) {
          for (const limit of [1, 2]) {
            const walked = await pages<PageBody>(
              `/v2/amm/pools/${pool}/swaps?descending=${descending}`,
              limit,
              'exchanges',
            );
            expect([pool, descending, limit, walked.flatMap((p) => p.exchanges)]).toEqual([
              pool,
              descending,
              limit,
              descending ? [...own].reverse() : own,
            ]);
            // the filter is inside the read: no page is short while there is a next one
            expect(walked.slice(0, -1).every((p) => p.count === limit)).toBe(true);
          }
        }
      }
    });

    it('applies start and end to the pool rows, and the amm param does not change what it lists', async () => {
      const ledgers = ones.map((r) => r.ledger_index);
      const from = iso(closeOf(ledgers[2]));
      const to = iso(closeOf(ledgers[3]));
      const res = await get(`/v2/amm/pools/${ONE}/swaps${qs({ start: from, end: to })}`);
      expect((res.body.exchanges as Obj[]).map((e) => e.ledger_index)).toEqual([ledgers[2], ledgers[3]]);
      expect((await get(`/v2/amm/pools/${ONE}/swaps?amm=exclude`)).body.count).toBe(ones.length);
    });

    it('is the exchange route restricted to the pool, key by key: the same objects, in the same order', async () => {
      const mine = (await get(`/v2/amm/pools/${ONE}/swaps`)).body.exchanges as Obj[];
      const via = (await get(`/v2/exchanges/AAA+${ISSUER}/XRP?amm=only&limit=400`)).body.exchanges as Obj[];
      expect(mine).toEqual(via.filter((e) => e.amm_account === ONE));
      for (const [i, e] of mine.entries())
        expect([i, Object.keys(e)]).toEqual([i, Object.keys(via.filter((x) => x.amm_account === ONE)[i])]);
    });

    it('a swap written twice is listed once', async () => {
      const dup = accountAt(0xe610);
      await h.ch.insert(Table.AmmPoolStates, [stateRow(dup, 100_570_000, 0)]);
      const rows = [100_570_001, 100_570_002, 100_570_003].map((l) => exchangeRow(l, 0, 0, dup));
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
      await h.ch.insert(Table.Exchanges, rows);
      await h.ch.command(
        `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE amm_account = {a:String}`,
        { a: dup },
        { settings: { insert_deduplicate: 0 } },
      );
      const [{ n }] = await h.ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.Exchanges} WHERE amm_account = {a:String}`,
        { a: dup },
      );
      expect(Number(n)).toBe(6);
      const walked = await pages<PageBody>(`/v2/amm/pools/${dup}/swaps`, 1, 'exchanges');
      expect(walked.flatMap((p) => p.exchanges!).map((e) => e.ledger_index)).toEqual([
        100_570_001, 100_570_002, 100_570_003,
      ]);
    });
  });
});

// =====================================================================================================================
describe('the event reads over a bulk of four parts (read_rows and the plans)', () => {
  // The events of a pool are a range of the primary key of its table (the pool, then its ledgers): a bulk of copies of real
  // rows in four parts of 200,000 (`support/read-rows.ts`) must cost about the granules of the page, not the 800,000.
  const GRANULE = 8192;
  /** The rows of the pool are in 5 parts (the 4 of the bulk and the real one): about a granule of each, and the page. */
  const READ_BOUND = (BULK_BASES.length + 2) * GRANULE;
  const MID = BULK_BASES[1] + BULK_LEDGERS / 2;

  let h: Harness;
  let api: ApiClient;
  let liquidityPool: string;
  let governancePool: string;
  let account: string;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock+amm', env: NO_RATE_LIMIT });
    api = await h.api();
    // the real rows are the templates, copied into four ranges of ledgers below the recorded ones
    const [liquidity] = await h.ch.query<{ amm_account: string; account: string }>(
      `SELECT amm_account, account FROM ${Table.AmmLiquidity} WHERE event = 'deposit' ORDER BY amm_account, ledger_index LIMIT 1`,
    );
    liquidityPool = liquidity.amm_account;
    account = liquidity.account;
    await insertBulk(
      h,
      Table.AmmLiquidity,
      `SELECT * FROM ${Table.AmmLiquidity} WHERE amm_account = {pool:String} AND event = 'deposit' ORDER BY ledger_index, tx_index LIMIT 1`,
      { pool: liquidityPool },
      (base) => `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, hex(rand64()) AS tx_hash`,
    );
    const [governance] = await h.ch.query<{ amm_account: string }>(
      `SELECT amm_account FROM ${Table.AmmGovernance} WHERE kind = 'bid' ORDER BY amm_account, ledger_index LIMIT 1`,
    );
    governancePool = governance.amm_account;
    await insertBulk(
      h,
      Table.AmmGovernance,
      `SELECT * FROM ${Table.AmmGovernance} WHERE amm_account = {pool:String} AND kind = 'bid' ORDER BY ledger_index, tx_index LIMIT 1`,
      { pool: governancePool },
      (base) => `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, hex(rand64()) AS tx_hash`,
    );
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const COUNT = 800_000;

  it('the seed is as assumed: 800,000 events of a pool in four parts', async () => {
    for (const [table, pool] of [
      [Table.AmmLiquidity, liquidityPool],
      [Table.AmmGovernance, governancePool],
    ] as const) {
      const [row] = await h.ch.query<{ n: string; parts: string }>(
        `SELECT count() AS n, uniqExact(_part) AS parts FROM ${table}
          WHERE amm_account = {pool:String} AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${BULK_BASES[3] + BULK_LEDGERS}`,
        { pool },
      );
      expect([table, Number(row.n), Number(row.parts)]).toEqual([table, COUNT, BULK_BASES.length]);
    }
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;

    it.each([
      ['liquidity', () => liquidityPool, Table.AmmLiquidity, 'liquidity', ''],
      ['liquidity', () => liquidityPool, Table.AmmLiquidity, 'liquidity', '&event=deposit'],
      ['liquidity', () => liquidityPool, Table.AmmLiquidity, 'liquidity', '&event=deposit&account=ACCOUNT'],
      ['governance', () => governancePool, Table.AmmGovernance, 'governance', ''],
      ['governance', () => governancePool, Table.AmmGovernance, 'governance', '&type=bid'],
    ] as const)(
      'the %s page of a pool with 800,000 events reads about the granules of its page (%#)',
      async (route, pool, table, key, filter) => {
        for (const marker of [markerOf([MID, 1]), markerOf([BULK_BASES[3] + 5, 2]), markerOf([BULK_BASES[0] + 3, 0])]) {
          const path = `/v2/amm/pools/${pool()}/${route}?limit=5&${direction}&marker=${marker}${filter.replace('ACCOUNT', account)}`;
          const { reads, body } = await served(h, api, table, path, key);
          expect(reads.length).toBeGreaterThanOrEqual(1);
          for (const read of reads) {
            expect([path, read.read_rows <= READ_BOUND ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
          }
          expect([path, (body[key] as Obj[]).length]).toEqual([path, 5]);
        }
      },
    );

    it.each([
      ['liquidity', () => liquidityPool, Table.AmmLiquidity, '&event=deposit&account=ACCOUNT'],
      ['governance', () => governancePool, Table.AmmGovernance, '&type=bid'],
    ] as const)(
      'the page read of the %s is read in the order of the key, stops after its rows, and holds the filters inside',
      async (route, pool, table, filter) => {
        const path = `/v2/amm/pools/${pool()}/${route}?limit=5&${direction}&marker=${markerOf([MID, 1])}${filter.replace('ACCOUNT', account)}`;
        const { statements } = await served(h, api, table, path, route);
        const page = statements.filter(([sql]) => isPageRead(sql));
        expect(page).toHaveLength(1);
        const [sql, params] = page[0];
        await expectBoundedInOrderRead(h, sql, params, descending, path);
        // the filters are conditions of the inner read, which the cap counts: never a step after the page
        const inner = innerRead(sql);
        if (route === 'liquidity') {
          expect(inner).toContain('event = {event:String}');
          expect(inner).toContain('account = {account:String}');
        } else {
          expect(inner).toContain('kind = {kind:String}');
        }
        expect(sql).not.toMatch(/\bFINAL\b/i);
        // the primary key is used for the pool and a range of its ledgers
        const [primary] = primaryKeys(await explain(h, 'indexes = 1', inner, params));
        expect(primary.keys).toEqual(['amm_account', 'ledger_index']);
        expect(primary.condition).toContain(`amm_account in ['${pool()}'`);
        expect(primary.condition).toContain('ledger_index in');
      },
    );
  });

  it('limit: 200 by default, a decimal is cut, below one is the default, over 1000 is 1000 (800,000 events to fill them)', async () => {
    for (const [route, pool, key] of [
      ['liquidity', liquidityPool, 'liquidity'],
      ['governance', governancePool, 'governance'],
    ] as const) {
      for (const [limit, count] of [
        ['', 200],
        ['0', 200],
        ['-3', 200],
        ['abc', 200],
        ['7.9', 7],
        ['1000', 1000],
        ['5000', 1000],
        ['all', 200],
      ] as const) {
        const res = await api.ok(`/v2/amm/pools/${pool}/${route}?limit=${limit}`, key);
        expect([route, limit, res.body.count, (res.body[key] as Obj[]).length]).toEqual([route, limit, count, count]);
        expect(res.body.marker).toBeDefined();
      }
    }
  });

  it('the existence of a pool is one read of the key of its states: a granule out of the table', async () => {
    const path = `/v2/amm/pools/${liquidityPool}/liquidity?limit=1`;
    const { reads } = await served(h, api, Table.AmmPoolStates, path, 'liquidity');
    expect(reads).toHaveLength(1);
    expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
  });
});

// =====================================================================================================================
describe('the swaps read over 100,000 order-book rows and the swaps of two pools (read_rows and the plans)', () => {
  // The swaps of a pool are the pair read of `/v2/exchanges/:base/:counter` with the pool's account: the pair key, then the
  // skip index on `amm_account`, never a scan across pairs. The pair has 100,000 order-book rows in four parts, and the
  // swaps of two pools, each in a part of its own in the same range of the key.
  const BOOK_PER_PART = 25_000;
  const SWAP_COUNT = 10;
  const SWAP_BASES = [25_000_000, 26_000_000];
  const ONE = accountAt(0xf001);
  const TWO = accountAt(0xf002);
  const GRANULE_DEFAULT = 8192;

  let h: Harness;
  let api: ApiClient;
  let t0: number;
  let granule: number;
  let holding: number;
  let pairPath: string;

  const closeTimeOf = (ledger: string): string => `toDateTime({t0:UInt32} + (${ledger} - ${BULK_BASES[0]}), 'UTC')`;

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    const [first] = await h.ch.query<{ t: number }>(
      `SELECT toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} WHERE ledger_index = 20005122`,
    );
    t0 = Number(first.t) + 86_400;
    const keyed = (base: number): string =>
      `${bulkLedger(base)} AS ledger_index, ${BULK_TX_INDEX} AS tx_index, ${closeTimeOf(bulkLedger(base))} AS close_time`;
    const [pair] = await h.ch.query<Record<string, string>>(
      `SELECT base_currency, base_issuer, counter_currency, counter_issuer, any(node_index) AS node_index
         FROM ${Table.Exchanges}
        GROUP BY base_currency, base_issuer, counter_currency, counter_issuer
        ORDER BY count() DESC, base_currency, counter_currency LIMIT 1`,
    );
    pairPath = `${side(pair.base_currency, pair.base_issuer)}/${side(pair.counter_currency, pair.counter_issuer)}`;
    const pairRow = `SELECT * FROM ${Table.Exchanges}
        WHERE base_currency = {base_currency:String} AND base_issuer = {base_issuer:String}
          AND counter_currency = {counter_currency:String} AND counter_issuer = {counter_issuer:String}
          AND node_index = {node_index:UInt16}
        ORDER BY ledger_index, tx_index LIMIT 1`;
    await insertBulk(h, Table.Exchanges, pairRow, { ...pair, t0 }, (base) => keyed(base), BOOK_PER_PART);
    // the swaps of each pool: one part each
    for (const [pool, base] of [
      [ONE, SWAP_BASES[0]],
      [TWO, SWAP_BASES[1]],
    ] as const) {
      await h.ch.command(
        `INSERT INTO ${Table.Exchanges}
         SELECT tpl.* REPLACE (${closeTimeOf(`toUInt32(${base} + n.number)`)} AS close_time,
                  toUInt32(${base} + n.number) AS ledger_index, toUInt32(0) AS tx_index,
                  {pool:String} AS amm_account, {pool:String} AS provider, toUInt32(0) AS offer_sequence)
           FROM (${pairRow}) AS tpl CROSS JOIN numbers(${SWAP_COUNT}) AS n`,
        { ...pair, t0, pool },
        { settings: { insert_deduplicate: 0 } },
      );
      // the pool exists: a state row with the pair, in a ledger that is committed
      await h.ch.command(
        `INSERT INTO ${Table.AmmPoolStates}
         (amm_account, ledger_index, tx_index, tx_hash, close_time, tx_type, base_currency, base_issuer, counter_currency, counter_issuer, deleted)
         VALUES ({pool:String}, 20005122, 0, {hash:String}, toDateTime({t0:UInt32}, 'UTC'), 'Payment',
                 {base_currency:String}, {base_issuer:String}, {counter_currency:String}, {counter_issuer:String}, 0)`,
        { pool, hash: hashOf(1), t0, ...pair },
      );
    }
    const [ddl] = await h.ch.query<{ ddl: string }>(
      `SELECT create_table_query AS ddl FROM system.tables WHERE database = {db:String} AND name = {table:String}`,
      { db: h.database, table: Table.Exchanges },
    );
    granule = Number(/index_granularity\s*=\s*(\d+)/.exec(ddl.ddl)?.[1] ?? GRANULE_DEFAULT);
    const [row] = await h.ch.query<{ granules: string }>(
      `SELECT uniqExact(_part, intDiv(_part_offset, {granule:UInt32})) AS granules FROM ${Table.Exchanges} WHERE amm_account = {pool:String}`,
      { granule, pool: ONE },
    );
    holding = Number(row.granules);
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  /** The granules of the pool's swaps, and two more: the rows of a read that finds them through the skip index. */
  const bound = (): number => (holding + 2) * granule;

  it('the seed is as assumed: 100,000 order-book rows in four parts, ten swaps of each pool in at most two granules', async () => {
    const [row] = await h.ch.query<{ book: string; ones: string; twos: string }>(
      `SELECT countIf(amm_account = '' AND ledger_index >= ${BULK_BASES[0]} AND ledger_index < ${SWAP_BASES[0]}) AS book,
              countIf(amm_account = {one:String}) AS ones, countIf(amm_account = {two:String}) AS twos
         FROM ${Table.Exchanges}`,
      { one: ONE, two: TWO },
    );
    expect([Number(row.book), Number(row.ones), Number(row.twos)]).toEqual([
      BULK_BASES.length * BOOK_PER_PART,
      SWAP_COUNT,
      SWAP_COUNT,
    ]);
    expect(holding).toBeLessThanOrEqual(2);
    expect(bound()).toBeLessThan(BULK_BASES.length * BOOK_PER_PART);
  });

  describe.each([false, true])('descending=%s', (descending) => {
    const direction = `descending=${descending}`;

    it('/v2/amm/pools/:pool/swaps reads the granules that hold the swaps of the pool, in at most (granules + 2) x index_granularity rows', async () => {
      for (const limit of [200, 5]) {
        const path = `/v2/amm/pools/${ONE}/swaps?limit=${limit}&${direction}`;
        const { reads, body } = await served(h, api, Table.Exchanges, path, 'exchanges');
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads) {
          expect([path, read.read_rows <= bound() ? 'bounded' : read.read_rows]).toEqual([path, 'bounded']);
        }
        const exchanges = body.exchanges as Obj[];
        expect([path, exchanges.length, exchanges.every((e) => e.amm_account === ONE)]).toEqual([
          path,
          Math.min(limit, SWAP_COUNT),
          true,
        ]);
      }
    });

    it('the plan reads the pair by its key, uses the skip index on amm_account, and is read in order and capped', async () => {
      const path = `/v2/amm/pools/${ONE}/swaps?limit=5&${direction}`;
      const { statements } = await served(h, api, Table.Exchanges, path, 'exchanges');
      expect(statements).toHaveLength(1);
      const [sql, params] = statements[0];
      const inner = innerRead(sql);
      expect(inner).toContain('amm_account = {amm_account:String}');
      const plan = await explain(h, 'indexes = 1', inner, params);
      const found = /Name: amm_account_set[\s\S]*?Granules: (\d+)\/(\d+)/.exec(plan);
      expect(found).not.toBeNull();
      // the granules of this pool's swaps out of those of all the parts of the pair, and not those of the other pool
      expect(Number(found![1])).toBeLessThanOrEqual(holding);
      expect(Number(found![2])).toBeGreaterThan((BULK_BASES.length * BOOK_PER_PART) / granule);
      // the primary key is used for the pair: its four columns and a range of ledgers
      const [primary] = primaryKeys(plan);
      expect(primary.keys.slice(0, 4)).toEqual(['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer']);
      expect(primary.condition).toContain('ledger_index in');
      await expectBoundedInOrderRead(h, sql, params, descending, path);
    });

    it('a pool reads nothing of the swaps of the other pool of the pair: the other is as cheap', async () => {
      const total = (reads: LoggedRead[]): number => reads.reduce((n, r) => n + r.read_rows, 0);
      const { reads: one } = await served(
        h,
        api,
        Table.Exchanges,
        `/v2/amm/pools/${ONE}/swaps?limit=200&${direction}`,
        'exchanges',
      );
      const { reads: two, body } = await served(
        h,
        api,
        Table.Exchanges,
        `/v2/amm/pools/${TWO}/swaps?limit=200&${direction}`,
        'exchanges',
      );
      expect((body.exchanges as Obj[]).every((e) => e.amm_account === TWO)).toBe(true);
      expect(total(two)).toBeLessThanOrEqual(bound());
      expect(total(one)).toBeLessThanOrEqual(bound());
    });
  });

  it('the pool is found by its states: one read of their key, not of the pair', async () => {
    const { reads } = await served(h, api, Table.AmmPoolStates, `/v2/amm/pools/${ONE}/swaps?limit=1`, 'exchanges');
    expect(reads).toHaveLength(1);
    expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE_DEFAULT);
    // and the exchange route of the pair is the same book (the control that the pair is the one served)
    const pair = await api.ok(`/v2/exchanges/${pairPath}?amm=only&limit=400`, 'exchanges');
    expect((pair.body.exchanges as Obj[]).length).toBe(2 * SWAP_COUNT);
  });
});

// =====================================================================================================================
describe('the event routes on Xahau', () => {
  // There is no AMM on Xahau: no pool is found, so every route of a pool is 404.
  let h: Harness;
  let get: ApiClient['get'];
  const POOL = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers 404 pool not found for the swaps, the liquidity and the governance of any pool, in JSON and CSV', async () => {
    for (const route of ['swaps', 'liquidity', 'governance']) {
      for (const query of ['', '?limit=5', '?format=csv', '?start=2020-01-01&descending=true']) {
        const res = await get(`/v2/amm/pools/${POOL}/${route}${query}`);
        expect([route, query, res.status, res.body]).toEqual([
          route,
          query,
          404,
          { result: 'error', message: 'pool not found' },
        ]);
      }
    }
  });

  it('answers the errors of the request first', async () => {
    const cases: [string, string][] = [
      ['/v2/amm/pools/rnotanaddress/swaps', 'invalid pool'],
      [`/v2/amm/pools/${POOL}/liquidity?event=nope`, 'invalid event'],
      [`/v2/amm/pools/${POOL}/governance?type=nope`, 'invalid type'],
      [`/v2/amm/pools/${POOL}/swaps?marker=!`, 'invalid marker'],
    ];
    for (const [path, message] of cases) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
    }
  });
});

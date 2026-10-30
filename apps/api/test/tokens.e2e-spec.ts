import { STATE_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import { TOKEN_LIST_KEYS } from '../src/tokens/token-list';
import { ISSUED_TOKEN_ROW_KEYS, ISSUED_TOTALS_KEYS } from '../src/tokens/token-objects';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { cells, decodeMarker, iso, lines } from './support/amm';
import { csvDisposition } from './support/csv';
import { HandPair, handSet } from './support/markets-world';
import { markerOf, readsOf } from './support/read-rows';
import {
  BUILDING,
  BUILDING_ONLY,
  DEAD,
  DEMURRAGE_HEX,
  generationRow,
  HOLDERS,
  ISSUER_A,
  ISSUER_B,
  ISSUER_C,
  ISSUER_D,
  LIST_ORDER,
  LIVE,
  LIVE_NEW_ROWS,
  LIVE_OLD_ROWS,
  LIVE_PARTS,
  LIVE_TOKENS,
  NPUSD_HEX,
  RETIRED,
  RETIRED_BULK_PARTS,
  RETIRED_BULK_PER_PART,
  RETIRED_ONLY,
  SeedToken,
  seedTokensWorld,
  THROUGH,
  THROUGH_CLOSE,
} from './support/tokens-seed';
import { ledgerRow } from './support/validators-seed';

/**
 * `GET /v2/tokens` (D6, spec 5.1) on a real ClickHouse.
 *
 * The first suite runs on the world of `support/tokens-seed.ts` (read its header: three generations side by side, the live one with
 * 15 tokens in older and newest versions, a deleted one, and their lines) and on the markets world of `markets-world.ts` for the
 * `day` and `30day` sets (every price and volume below is worked out from the trades of its header). The second suite has no live
 * generation yet, the third has tokens and no markets, then sets written by hand, and the last two are the other networks.
 *
 * The order of the list is holders descending, then the issuer, then the currency (a text compare): the issuer `rMwj…` (B) is below
 * `rrrr…` (C, D) below `rvYA…` (A). The 15 tokens of the live generation, by key, are in `LIST_ORDER`.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;
const GRANULE = 8192;

type Obj = Record<string, unknown>;

/** `entry` has the keys of `order` it has, and in that order: none out of place, none made up. */
function expectKeysInOrder(entry: object, order: readonly string[]): void {
  const keys = Object.keys(entry);
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));
}

/** The test key (`usd`) of a row of an answer. */
function keyOf(row: Obj): string {
  const found = LIVE_TOKENS.find((t) => t.issuer === row.issuer && t.currency === row.currency);
  if (found === undefined) throw new Error(`not a token of the world: ${JSON.stringify(row)}`);
  return found.key;
}

/** An answer without what changes from page to page: its tokens, their count and the marker. */
const envelopeOf = (body: Obj): Obj =>
  Object.fromEntries(Object.entries(body).filter(([key]) => !['tokens', 'count', 'marker'].includes(key)));
const keysOf = (body: Obj): string[] => (body.tokens as Obj[]).map(keyOf);
const ranksOf = (body: Obj): number[] => (body.tokens as Obj[]).map((row) => Number(row.rank));
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const seed = (key: string): SeedToken => LIVE_TOKENS.find((t) => t.key === key) as SeedToken;

/** What the totals are, whatever the filters (the whole kind). */
const WHOLE = { tokens: 15, tokens_with_10_holders: 9, holders: HOLDERS, native_volume: '243.5' };

/**
 * The price and volume of each token of the markets world, worked out from its trades (`markets-world.ts`, `network-markets.e2e-spec.ts`
 * has the pairs): the day set, else the 30day set for the price. A token that has no pair in the day set has "0" and 0.
 *  - USD is the base of USD/N (last 0.4 from an open of 0.5), USD/ZZZ and the counter of EUR/USD: 65 + 60 + 25 native, 13 + 12 + 10 trades.
 *  - ZZZ is the counter of N/ZZZ (2 N per ZZZ ... N/ZZZ stores ZZZ per N, so the price is its inverse, 0.5) and of USD/ZZZ: 55 + 60, 11 + 12.
 *  - EUR and GBP and BTC have no pair against the native currency, EUR/USD alone has a native volume (25).
 *  - JPY traded only in the 30 days (12 x (100, 1) on the 20th day before, the last at 14:11): the price 1/100 of the 30day set, no change.
 */
const FACTS: Record<string, Obj> = {
  usd: {
    price: '0.40000000',
    price_change: '-20.00',
    price_time: '2020-07-02T10:42:17Z',
    native_volume: '150',
    trades: 35,
  },
  zzz: {
    price: '0.50000000',
    price_change: '0.00',
    price_time: '2020-07-02T03:10:00Z',
    native_volume: '115',
    trades: 23,
  },
  eur: { native_volume: '25', trades: 35 },
  btc: { native_volume: '0', trades: 22 },
  jpy: { price: '0.010000000', price_time: '2020-06-12T14:11:00Z', native_volume: '0', trades: 0 },
  aud: {
    price: '0.25000000',
    price_change: '0.00',
    price_time: '2020-07-02T07:09:00Z',
    native_volume: '10',
    trades: 10,
  },
  cad: {
    price: '0.12500000',
    price_change: '0.00',
    price_time: '2020-07-02T07:39:00Z',
    native_volume: '10',
    trades: 10,
  },
  nzd: {
    price: '0.50000000',
    price_change: '0.00',
    price_time: '2020-07-02T08:30:00Z',
    native_volume: '0.5',
    trades: 1,
  },
  chf: {
    price: '0.20000000',
    price_change: '0.00',
    price_time: '2020-07-02T08:08:00Z',
    native_volume: '18',
    trades: 9,
  },
  gbp: { native_volume: '0', trades: 25 },
  usd2: { native_volume: '0', trades: 0 },
  npusd: { native_volume: '0', trades: 0 },
  hex: { native_volume: '0', trades: 0 },
  xyz: { native_volume: '0', trades: 0 },
  old: { native_volume: '0', trades: 0 },
};

/** The row of the list for a token of the world at a place: its stored facts, then its market facts. */
function rowOf(key: string, rank: number, facts: Obj = FACTS[key]): Obj {
  const t = seed(key);
  const supply = new BigNumber(t.holders).times(t.holders + 2).dividedBy(2); // 1.5 + 2.5 + ... : h (h + 2) / 2
  return {
    rank,
    currency: t.currency,
    ...(t.code !== '' && { code: t.code }),
    issuer: t.issuer,
    holders: t.holders,
    trust_lines: t.trustLines,
    supply: supply.toFixed(),
    ...facts,
    ...(t.domain !== undefined && { domain: t.domain }),
    listed: t.listed === true,
    ...(t.name !== undefined && { name: t.name }),
  };
}

// =====================================================================================================================
// the world
// =====================================================================================================================

describe('GET /v2/tokens on the world of tokens-seed.ts', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await seedTokensWorld(h);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const list = async (query = ''): Promise<Obj> => (await api.ok(`/v2/tokens${query}`, 'tokens')).body as Obj;
  const clearCache = async (): Promise<void> => {
    await api.ok('/v2/test-cache/clear', 'result');
  };

  it('the data is as the tests assume', async () => {
    // the rows of each generation's partition, and the parts they are in
    const partitions = await h.ch.query<{ partition: string; parts: string; rows: string }>(
      `SELECT partition, count() AS parts, sum(rows) AS rows FROM system.parts
        WHERE database = {db:String} AND table = {table:String} AND active GROUP BY partition ORDER BY partition`,
      { db: h.database, table: Table.Tokens },
    );
    expect(partitions.map((p) => [Number(p.partition), Number(p.parts), Number(p.rows)])).toEqual([
      [RETIRED, 1 + RETIRED_BULK_PARTS, 2 + RETIRED_BULK_PARTS * RETIRED_BULK_PER_PART],
      [LIVE, LIVE_PARTS, LIVE_OLD_ROWS + LIVE_NEW_ROWS],
      [BUILDING, 1, 1],
    ]);
    // more than two granules in each part of the bulk: a read of the whole retired partition could not stay below the bound
    expect(RETIRED_BULK_PER_PART).toBeGreaterThan(2 * GRANULE);
    const [lineCount] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.TokenLines}`);
    expect(Number(lineCount.n)).toBe(LIVE_TOKENS.reduce((n, t) => n + t.trustLines, 0));
    // the generation the list serves, and the ledger it names
    const [ledger] = await h.ch.query<{ t: string }>(
      `SELECT toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`,
      { l: THROUGH },
    );
    expect(Number(ledger.t)).toBe(THROUGH_CLOSE);
  });

  // -- the list ---------------------------------------------------------------------------------------------------------

  it('lists the live generation only, by holders, issuer, currency, with ranks', async () => {
    const res = await api.ok('/v2/tokens', 'tokens');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    const body = res.body as Obj;
    // result, coverage, kind, ledger_index, close_time, totals, total, count, tokens: no total_below without min_holders, no marker on the last page
    expect(Object.keys(body)).toEqual([
      'result',
      'coverage',
      'kind',
      'ledger_index',
      'close_time',
      'totals',
      'total',
      'count',
      'tokens',
    ]);
    expectKeysInOrder(body, TOKEN_LIST_KEYS);
    expect(body.result).toBe('success');
    // the first ledger of XRPL is stored with the parser of the state: complete
    expect(body.coverage).toEqual({ from_ledger_index: 32_570, complete: true });
    expect(Object.keys(body.coverage as Obj)).toEqual([...COVERAGE_KEYS]);
    expect(body.kind).toBe('issued');
    expect(body.ledger_index).toBe(THROUGH);
    expect(body.close_time).toBe(iso(THROUGH_CLOSE));
    expect(body.totals).toEqual(WHOLE);
    expect(Object.keys(body.totals as Obj)).toEqual([...ISSUED_TOTALS_KEYS]);
    expect([body.total, body.count]).toEqual([15, 15]);

    // the tokens of the live generation in their newest versions: not USD of the retired generation (777 holders), RET, BLD, DED, or OLD at 900
    expect(keysOf(body)).toEqual(LIST_ORDER);
    expect(ranksOf(body)).toEqual(oneTo(15));
    const rows = body.tokens as Obj[];
    for (const hidden of [DEAD, RETIRED_ONLY, BUILDING_ONLY]) {
      expect(rows.filter((r) => r.issuer === hidden.issuer && r.code === hidden.currency)).toEqual([]);
    }
    // the order is the one of the numbers, as a reader that sorted another way would not give it
    const holders = rows.map((r) => Number(r.holders));
    expect(holders).toEqual([...holders].sort((a, b) => b - a));
    for (const row of rows) expectKeysInOrder(row, ISSUED_TOKEN_ROW_KEYS);

    // a whole row, and a token with neither code, domain nor name (and no market)
    expect(rows[0]).toEqual({
      rank: 1,
      currency: 'USD',
      code: 'USD',
      issuer: ISSUER_A,
      holders: 120,
      trust_lines: 150,
      supply: '7320',
      price: '0.40000000',
      price_change: '-20.00',
      price_time: '2020-07-02T10:42:17Z',
      native_volume: '150',
      trades: 35,
      domain: 'northpeak.example',
      listed: true,
      name: 'Northpeak USD',
    });
    const hex = rows[LIST_ORDER.indexOf('hex')];
    expect(Object.keys(hex)).toEqual([
      'rank',
      'currency',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'native_volume',
      'trades',
      'listed',
    ]);
    expect(hex).toMatchObject({ currency: DEMURRAGE_HEX, issuer: ISSUER_C, supply: '337.5', listed: false });
    // a token whose lines are all empty: supply 0, and the two lines count
    expect(rows[LIST_ORDER.indexOf('chf')]).toMatchObject({ holders: 0, trust_lines: 2, supply: '0' });

    // and every row is what the world says
    LIST_ORDER.forEach((key, i) => expect([key, rows[i]]).toEqual([key, rowOf(key, i + 1)]));
  });

  it('min_holders, q (code, name, domain, hex, issuer prefix, an address), and the counts and totals', async () => {
    const lower = DEMURRAGE_HEX.toLowerCase();
    const cases: { query: string; keys: string[]; total: number; below?: number }[] = [
      // min_holders keeps the tokens with at least that many; total_below counts the others (the board's "hidden")
      { query: 'min_holders=10', keys: LIST_ORDER.slice(0, 9), total: 9, below: 6 },
      { query: 'min_holders=61', keys: ['usd'], total: 1, below: 14 },
      { query: 'min_holders=121', keys: [], total: 0, below: 15 },
      { query: 'min_holders=1', keys: LIST_ORDER.slice(0, 14), total: 14, below: 1 },
      // 0 and empty are none: no total_below
      { query: 'min_holders=0', keys: LIST_ORDER, total: 15 },
      { query: 'min_holders=', keys: LIST_ORDER, total: 15 },
      // the code, in any case: the code of NPUSD holds usd as well
      { query: 'q=usd', keys: ['usd', 'usd2', 'npusd'], total: 3 },
      { query: 'q=USD&min_holders=50', keys: ['usd', 'usd2'], total: 2, below: 1 },
      // the name; the domain (a token whose toml does not list it has one too); a token that matches by two fields is counted once
      { query: 'q=DOLLAR', keys: ['usd2', 'npusd'], total: 2 },
      { query: 'q=zedcoin', keys: ['zzz'], total: 1 },
      { query: `q=${encodeURIComponent('.example')}`, keys: ['usd', 'usd2', 'zzz', 'npusd'], total: 4 },
      { query: 'q=northpeak', keys: ['usd', 'npusd'], total: 2 },
      // the currency in hex, in any case; not a part of it
      { query: `q=${lower}`, keys: ['hex'], total: 1 },
      { query: `q=${DEMURRAGE_HEX}`, keys: ['hex'], total: 1 },
      { query: `q=${NPUSD_HEX.toLowerCase()}`, keys: ['npusd'], total: 1 },
      { query: `q=${lower.slice(0, 12)}`, keys: [], total: 0 },
      // the start of an issuer; a whole address is the tokens of that issuer
      { query: `q=${ISSUER_A.slice(0, 6)}`, keys: LIST_ORDER.filter((k) => seed(k).issuer === ISSUER_A), total: 10 },
      {
        query: `q=${ISSUER_A.slice(0, 6)}&min_holders=10`,
        keys: ['usd', 'eur', 'zzz', 'btc', 'jpy'],
        total: 5,
        below: 5,
      },
      { query: `q=${ISSUER_C}`, keys: ['hex', 'xyz'], total: 2 },
      { query: `q=${ISSUER_D}&min_holders=9`, keys: [], total: 0, below: 1 },
      { query: `q=${ISSUER_B}`, keys: ['usd2', 'npusd'], total: 2 },
      // text is text, not a pattern; a q of only spaces is none
      { query: 'q=%25', keys: [], total: 0 },
      { query: 'q=_', keys: [], total: 0 },
      { query: 'q=nothing-like-it', keys: [], total: 0 },
      { query: 'q=%20%20', keys: LIST_ORDER, total: 15 },
      { query: 'q=%20usd%20', keys: ['usd', 'usd2', 'npusd'], total: 3 },
    ];
    for (const c of cases) {
      const body = await list(`?${c.query}`);
      // the tokens, their places among those the filters select, the counts, and the whole kind's totals
      expect([c.query, keysOf(body)]).toEqual([c.query, c.keys]);
      expect([c.query, ranksOf(body)]).toEqual([c.query, oneTo(c.keys.length)]);
      expect([c.query, body.total, body.total_below, body.count]).toEqual([c.query, c.total, c.below, c.keys.length]);
      expect(Object.keys(body)).toEqual([
        'result',
        'coverage',
        'kind',
        'ledger_index',
        'close_time',
        'totals',
        'total',
        ...(c.below !== undefined ? ['total_below'] : []),
        'count',
        'tokens',
      ]);
      expect([c.query, body.totals]).toEqual([c.query, WHOLE]);
    }
  });

  it('concatenated pages of limit=1, 2 and 7 equal the unpaged list, ranks included', async () => {
    const whole = await list('?limit=1000');
    expect(whole).not.toHaveProperty('marker');
    for (const [query, expected] of [
      ['', LIST_ORDER],
      ['?min_holders=10', LIST_ORDER.slice(0, 9)],
      [`?q=${ISSUER_A.slice(0, 6)}&min_holders=5`, LIST_ORDER.filter((k) => seed(k).issuer === ISSUER_A).slice(0, 7)],
    ] as [string, string[]][]) {
      const want = await list(`${query}${query === '' ? '?' : '&'}limit=1000`);
      expect(keysOf(want)).toEqual(expected);
      for (const limit of [1, 2, 7]) {
        const pages = await api.pages<Obj>(`/v2/tokens${query}`, limit, 'tokens');
        const label = `${query} limit=${limit}`;
        expect([label, pages.length]).toEqual([label, Math.ceil(expected.length / limit)]);
        // the rows (ranks included, the places in the whole list), whatever the page they are on
        expect([label, pages.flatMap((page) => page.tokens)]).toEqual([label, want.tokens]);
        pages.forEach((page, i) => {
          // the envelope of every page is the same, but the marker, which only a page with a next one has
          expect(envelopeOf(page)).toEqual(envelopeOf(want));
          expect(page.count).toBe((page.tokens as Obj[]).length);
          expect([label, i, page.marker !== undefined]).toEqual([label, i, i < pages.length - 1]);
        });
      }
    }
    // the marker is the kind and the (holders, issuer, currency) of the last row of the page
    const first = await get('/v2/tokens?limit=2');
    expect(decodeMarker(first.body.marker as string)).toEqual(['issued', 60, ISSUER_B, 'USD']);
    // and the Link header is the request with the marker
    const origin = new URL(first.request.url).origin;
    expect(first.headers.link).toBe(`<${origin}/v2/tokens?limit=2&marker=${first.body.marker as string}>; rel="next"`);
    expect((await get('/v2/tokens?limit=1000')).headers.link).toBeUndefined();
  });

  it('a marker holds the place of a row: it works for a row that is no longer in the list, and the ranks are those of the whole list', async () => {
    // (60, ISSUER_A, EUR) is in the list: the next is ZZZ, the fourth
    const after = await list(`?marker=${markerOf(['issued', 60, ISSUER_A, 'EUR'])}&limit=2`);
    expect(keysOf(after)).toEqual(['zzz', 'npusd']);
    expect(ranksOf(after)).toEqual([4, 5]);
    // a place no row has: after (60, ISSUER_A, EUS) comes the same, ZZZ
    const between = await list(`?marker=${markerOf(['issued', 60, ISSUER_A, 'EUS'])}&limit=1`);
    expect(keysOf(between)).toEqual(['zzz']);
    // past the last: an empty page, still with the counts
    const past = await list(`?marker=${markerOf(['issued', 0, ISSUER_A, 'CHF'])}`);
    expect([past.count, past.tokens, past.total, past.totals]).toEqual([0, [], 15, WHOLE]);
    expect(past).not.toHaveProperty('marker');
  });

  it('a marker of another kind name is invalid marker', async () => {
    const bad = [
      markerOf(['mpt', 60, ISSUER_B, 'USD']),
      markerOf(['ISSUED', 60, ISSUER_B, 'USD']),
      // not the shape of the key: the old 3-value marker, text for a count, a negative count, a number for the issuer
      markerOf([60, ISSUER_B, 'USD']),
      markerOf(['issued', '60', ISSUER_B, 'USD']),
      markerOf(['issued', -1, ISSUER_B, 'USD']),
      markerOf(['issued', 60, 7, 'USD']),
      'not%20a%20marker',
      '%25%25',
    ];
    for (const marker of bad) {
      const res = await get(`/v2/tokens?marker=${marker}`);
      expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    // the same for the CSV
    expect((await get(`/v2/tokens?format=csv&marker=${bad[0]}`)).body).toEqual({
      result: 'error',
      message: 'invalid marker',
    });
  });

  // -- price, change and volume -----------------------------------------------------------------------------------------

  it('price, change and volume from the day set in both orientations, the 30day fallback, and nothing without sets', async () => {
    const body = await list('?limit=1000');
    const rows = body.tokens as Obj[];
    // the facts of the markets world, token by token (the key order of a row is pinned above)
    for (const key of LIST_ORDER) {
      const row = rows[LIST_ORDER.indexOf(key)];
      const facts = Object.fromEntries(
        ['price', 'price_change', 'price_time', 'native_volume', 'trades']
          .filter((k) => k in row)
          .map((k) => [k, row[k]]),
      );
      expect([key, facts]).toEqual([key, FACTS[key]]);
    }
    // USD is the base of its pair with the native currency, ZZZ the counter of it: the price of a ZZZ is the inverse of the stored rate
    expect(rows[0]).toMatchObject({ price: '0.40000000', price_change: '-20.00' });
    expect(rows[LIST_ORDER.indexOf('zzz')]).toMatchObject({ price: '0.50000000', price_change: '0.00' });
    // JPY has no pair in the day set: its price is the 30day set's, with its time and no change; its volume is 0 (there is a day set)
    const jpy = rows[LIST_ORDER.indexOf('jpy')];
    expect(Object.keys(jpy)).toEqual([
      'rank',
      'currency',
      'code',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'price',
      'price_time',
      'native_volume',
      'trades',
      'listed',
    ]);
    // the native volume of the day set, every pair
    expect((body.totals as Obj).native_volume).toBe('243.5');
  });

  // -- errors -----------------------------------------------------------------------------------------------------------

  it('errors in order: invalid kind - use: issued, invalid min_holders, invalid search, invalid marker', async () => {
    const long = 'a'.repeat(65);
    const cases: [string, string][] = [
      ['kind=mpt', 'invalid kind - use: issued'],
      ['kind=ISSUED', 'invalid kind - use: issued'],
      [`kind=x&min_holders=x&q=${long}&marker=%25%25`, 'invalid kind - use: issued'],
      [`min_holders=x&q=${long}&marker=%25%25`, 'invalid min_holders'],
      ['min_holders=-1', 'invalid min_holders'],
      ['min_holders=1.5', 'invalid min_holders'],
      ['min_holders=1e3', 'invalid min_holders'],
      ['min_holders=%205', 'invalid min_holders'],
      ['min_holders=1000000001', 'invalid min_holders'],
      [`q=${long}&marker=%25%25`, 'invalid search'],
      [`q=${encodeURIComponent('\u{1F600}'.repeat(65))}`, 'invalid search'],
      ['marker=%25%25', 'invalid marker'],
    ];
    const spy = jest.spyOn(h.ch, 'query');
    for (const [query, message] of cases) {
      for (const format of ['', '&format=csv']) {
        const res = await get(`/v2/tokens?${query}${format}`);
        expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
    // all of them before any read
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // the edges that are fine: 1,000,000,000 holders, 64 characters or 64 emoji, plain digits with zeros in front, empty values
    for (const query of [
      'min_holders=1000000000',
      `q=${'a'.repeat(64)}`,
      `q=${encodeURIComponent('\u{1F600}'.repeat(64))}`,
      'min_holders=007',
      'kind=&min_holders=&q=&marker=&limit=',
      'kind=issued&unknown=1&other=x',
    ]) {
      expect([query, (await get(`/v2/tokens?${query}`)).status]).toEqual([query, 200]);
    }
    expect(keysOf(await list('?kind=&min_holders=&q=&marker=&foo=bar'))).toEqual(LIST_ORDER);
    expect(keysOf(await list('?kind=issued'))).toEqual(LIST_ORDER);
  });

  it('a failed read is 500 unable to retrieve tokens', async () => {
    await clearCache();
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    for (const path of ['/v2/tokens', '/v2/tokens?format=csv', '/v2/tokens?q=usd&min_holders=3']) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve tokens' },
      ]);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('answers 401 without a key', async () => {
    const res = await h.http().get('/v2/tokens');
    expect([res.status, res.body]).toEqual([401, { result: 'error', message: 'Missing or invalid API key.' }]);
  });

  // -- CSV --------------------------------------------------------------------------------------------------------------

  it('CSV tokens.csv holds the rows flattened, without coverage', async () => {
    const res = await get('/v2/tokens?format=csv&limit=1000');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(csvDisposition('tokens'));
    const table = lines(res.text).map(cells);
    // the fixed columns of a row, in order, whatever the first rows hold, and a row for each token
    const header = ISSUED_TOKEN_ROW_KEYS.map((k) => `"${k}"`);
    expect(table[0]).toEqual(header);
    expect(table).toHaveLength(1 + 15);
    for (const row of table) expect(row).toHaveLength(header.length);
    for (const word of ['coverage', 'from_ledger_index', 'totals', 'ledger_index', 'marker']) {
      expect(res.text).not.toContain(word);
    }
    // a cell is empty where the token has no value: the token with no code, no domain, no price
    const column = (name: string): number => header.indexOf(`"${name}"`);
    const hex = table[1 + LIST_ORDER.indexOf('hex')];
    expect(hex[column('currency')]).toBe(`"${DEMURRAGE_HEX}"`);
    for (const empty of ['code', 'price', 'price_change', 'price_time', 'domain', 'name']) {
      expect([empty, hex[column(empty)]]).toEqual([empty, '""']);
    }
    expect(hex[column('listed')]).toBe('"false"');
    expect(table[1][column('price')]).toBe('"0.40000000"');
    expect(table[1][column('listed')]).toBe('"true"');
    expect(table[1][column('rank')]).toBe('"1"');

    // pages have the same columns, and are the rows of the JSON pages; the Link is there for the CSV too
    let marker: string | undefined;
    let pages = 0;
    const rows: string[][] = [];
    do {
      const part = await get(`/v2/tokens?format=csv&limit=4${marker ? `&marker=${marker}` : ''}`);
      const json = await get(`/v2/tokens?limit=4${marker ? `&marker=${marker}` : ''}`);
      const text = lines(part.text).map(cells);
      expect([pages, text[0]]).toEqual([pages, header]);
      expect(text.length - 1).toBe((json.body.tokens as Obj[]).length);
      rows.push(...text.slice(1));
      const origin = new URL(part.request.url).origin;
      expect(part.headers.link).toBe(
        json.body.marker === undefined
          ? undefined
          : `<${origin}/v2/tokens?format=csv&limit=4&marker=${json.body.marker as string}>; rel="next"`,
      );
      marker = json.body.marker as string | undefined;
      pages += 1;
    } while (marker && pages < 10);
    expect([pages, rows]).toEqual([4, table.slice(1)]);
    // an error is not a CSV
    const bad = await get('/v2/tokens?format=csv&min_holders=x');
    expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid min_holders' }]);
  });

  // -- reads ------------------------------------------------------------------------------------------------------------

  it('reads one partition of tokens: read_rows at most its rows plus a granule per part', async () => {
    // the live partition holds LIVE_OLD_ROWS + LIVE_NEW_ROWS rows in LIVE_PARTS parts; the retired one 80,000 more in five parts, which a
    // read that did not name its generation would read. The answer needs every row of the live partition (the ranks are over all of them)
    const liveRows = LIVE_OLD_ROWS + LIVE_NEW_ROWS;
    const bound = liveRows + LIVE_PARTS * 2 * GRANULE;
    // so that a read that also took the retired partition would be over the bound
    expect(bound).toBeLessThan(RETIRED_BULK_PARTS * RETIRED_BULK_PER_PART);
    const marker = markerOf(['issued', 25, ISSUER_C, DEMURRAGE_HEX]);
    // what each answer needs of the live partition: all its rows (the ranks and the counts are over them), but for the tokens of one
    // issuer, whose key prefix the primary key narrows to a granule
    const requests: [string, number][] = [
      ['', liveRows],
      ['?limit=1', liveRows],
      ['?min_holders=10', liveRows],
      ['?q=usd', liveRows],
      [`?limit=3&marker=${marker}`, liveRows],
      ['?format=csv', liveRows],
      [`?q=${ISSUER_A}&min_holders=3`, 1],
    ];
    for (const [query, needed] of requests) {
      await clearCache();
      const reads = await readsOf(h, Table.Tokens, async () => {
        await api.ok(`/v2/tokens${query}`);
      });
      // the page and the counts, one read of the partition each, never the other generations'
      expect([query, reads.length]).toEqual([query, 2]);
      for (const read of reads) {
        expect([query, read.read_rows >= needed, read.read_rows <= bound, read.read_rows]).toEqual([
          query,
          true,
          true,
          read.read_rows,
        ]);
      }
    }
    // the lines of the tokens are not read for the list
    const lineReads = await readsOf(h, Table.TokenLines, async () => {
      await api.ok('/v2/tokens');
    });
    expect(lineReads).toEqual([]);
  });

  it('reads the live generation once for the requests of five seconds, whatever they ask', async () => {
    await clearCache();
    // concurrent misses share the read, and the next requests find it kept
    const reads = await readsOf(h, Table.TokenGenerations, async () => {
      await Promise.all([api.ok('/v2/tokens?limit=1'), api.ok('/v2/tokens?q=usd'), api.ok('/v2/tokens?min_holders=5')]);
      await api.ok('/v2/tokens?limit=2');
    });
    expect(reads).toHaveLength(1);
    // the clear route empties it
    await clearCache();
    const again = await readsOf(h, Table.TokenGenerations, async () => {
      await api.ok('/v2/tokens?limit=1');
    });
    expect(again).toHaveLength(1);
  });
});

// =====================================================================================================================
// before a live generation
// =====================================================================================================================

describe('GET /v2/tokens before a live generation', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const clearCache = async (): Promise<void> => {
    await api.ok('/v2/test-cache/clear', 'result');
  };

  it('answers the no-generation shape before any live generation', async () => {
    // an empty database: no ledger either, so the coverage is "not complete" and has no start
    const empty = await api.get('/v2/tokens');
    expect([empty.status, empty.body]).toEqual([
      200,
      { result: 'success', coverage: { complete: false }, kind: 'issued', count: 0, tokens: [] },
    ]);
    expect(Object.keys(empty.body)).toEqual(['result', 'coverage', 'kind', 'count', 'tokens']);
    expect(empty.headers['cache-control']).toBe('private, max-age=60');
    expect(empty.headers.link).toBeUndefined();

    // ledgers, and a generation that builds and one that is retired: none of them is live
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(5_000_000, 1_700_000_000), parser_version: STATE_PARSER_VERSION },
      { ...ledgerRow(THROUGH, THROUGH_CLOSE), parser_version: STATE_PARSER_VERSION },
    ]);
    await h.ch.insert(Table.TokenGenerations, [
      generationRow(3, 'retired', 10),
      generationRow(4, 'building', 20, { pass_done: 0 }),
    ]);
    await clearCache();
    const none = await api.get('/v2/tokens?min_holders=5&q=usd&limit=10');
    expect([none.status, none.body]).toEqual([
      200,
      {
        result: 'success',
        coverage: { from_ledger_index: 5_000_000, complete: false },
        kind: 'issued',
        count: 0,
        tokens: [],
      },
    ]);
    // CSV: an empty file
    const csv = await api.get('/v2/tokens?format=csv');
    expect([csv.status, csv.text]).toEqual([200, '']);
    expect(csv.headers['content-disposition']).toBe(csvDisposition('tokens'));
  });

  it('checks the marker with no generation too: a bad one is 400, and nothing is read for it', async () => {
    const spy = jest.spyOn(h.ch, 'query');
    for (const marker of [markerOf(['mpt', 1, 'r', 'USD']), '%25%25', markerOf([1, 2])]) {
      const res = await api.get(`/v2/tokens?marker=${marker}`);
      expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // a marker that is good is the no-generation answer
    const res = await api.get(`/v2/tokens?marker=${markerOf(['issued', 1, 'r', 'USD'])}`);
    expect([res.status, res.body.count, res.body.tokens]).toEqual([200, 0, []]);
  });

  it('coverage on XRPL from the state parser floor', async () => {
    const coverageOf = async (): Promise<unknown> => {
      await clearCache();
      return (await api.ok('/v2/tokens', 'coverage')).body.coverage;
    };
    // the oldest stored ledger is where the state is whole from, as the first ledger of the network is 32570: not complete
    expect(await coverageOf()).toEqual({ from_ledger_index: 5_000_000, complete: false });
    // the first ledger of XRPL, stored by the parser of the state: complete
    await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(32_570, 1_390_000_000), parser_version: STATE_PARSER_VERSION }]);
    expect(await coverageOf()).toEqual({ from_ledger_index: 32_570, complete: true });
    // a ledger of the parser below the state parser moves the start above it, and past the first ledger
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(90_000_000, 1_750_000_000), parser_version: STATE_PARSER_VERSION - 1 },
    ]);
    expect(await coverageOf()).toEqual({ from_ledger_index: 90_000_001, complete: false });
    // one of the state parser itself, or a later one, does not
    await h.ch.insert(Table.Ledgers, [
      { ...ledgerRow(95_000_000, 1_760_000_000), parser_version: STATE_PARSER_VERSION },
    ]);
    expect(await coverageOf()).toEqual({ from_ledger_index: 90_000_001, complete: false });
  });

  it('a live generation through a ledger that is not stored is the 500 of the route, and the list once the ledger is', async () => {
    const through = 96_000_000;
    // no day set: no native volume among the totals; the generation has not counted its holders yet: no holders either
    await h.ch.insert(Table.TokenGenerations, [generationRow(9, 'live', 30, { through_ledger: through })]);
    await clearCache();
    for (const path of ['/v2/tokens', '/v2/tokens?format=csv']) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve tokens' },
      ]);
    }
    await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(through, 1_770_000_000), parser_version: STATE_PARSER_VERSION }]);
    // (the failure was not kept)
    const res = await api.get('/v2/tokens?min_holders=2');
    expect([res.status, res.body]).toEqual([
      200,
      {
        result: 'success',
        coverage: { from_ledger_index: 90_000_001, complete: false },
        kind: 'issued',
        ledger_index: through,
        close_time: iso(1_770_000_000),
        totals: { tokens: 0, tokens_with_10_holders: 0 },
        total: 0,
        total_below: 0,
        count: 0,
        tokens: [],
      },
    ]);
    // counted holders are served
    await h.ch.insert(Table.TokenGenerations, [
      generationRow(9, 'live', 40, { through_ledger: through, holders: 77, holders_ledger: through - 1 }),
    ]);
    await clearCache();
    expect(((await api.ok('/v2/tokens', 'totals')).body.totals as Obj).holders).toBe(77);
  });
});

// =====================================================================================================================
// tokens and no markets, then sets written by hand
// =====================================================================================================================

describe('GET /v2/tokens without markets sets, then with sets written by hand', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedTokensWorld(h, { markets: false, bulk: false });
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  const clearCache = async (): Promise<void> => {
    await api.ok('/v2/test-cache/clear', 'result');
  };
  const jpyOf = async (): Promise<{ jpy: Obj; totals: Obj }> => {
    const body = (await api.ok('/v2/tokens?limit=1000', 'tokens')).body as Obj;
    return { jpy: (body.tokens as Obj[])[LIST_ORDER.indexOf('jpy')], totals: body.totals as Obj };
  };

  /** A set of the `JPY`/native pair at a time: 7 trades and 7 of native volume, a price from 1 to 2. */
  const jpySet = (period: 'day' | '30day', end: number, over: Partial<HandPair> = {}) =>
    handSet({
      period,
      version: end,
      start: end - 86_400,
      end,
      pairs: [{ base: `JPY+${ISSUER_A}`, counter: 'XRP', count: 7, native: '7', ...over }],
    });

  it('shows nothing of the market without sets: no price, no volume, no trades, and no native volume among the totals', async () => {
    const body = (await api.ok('/v2/tokens?limit=1000', 'tokens')).body as Obj;
    expect(keysOf(body)).toEqual(LIST_ORDER);
    for (const row of body.tokens as Obj[]) {
      expect(Object.keys(row).filter((k) => /price|volume|trades/.test(k))).toEqual([]);
    }
    expect(body.totals).toEqual({ tokens: 15, tokens_with_10_holders: 9, holders: HOLDERS });
  });

  it('a 30day set alone gives the price of its pair and no change, no volume: the day set has the volume', async () => {
    await h.ch.insert(Table.MarketsLive, jpySet('30day', 1_793_000_000));
    // the sets are kept 30 s: the answer is the one before
    expect((await jpyOf()).jpy).not.toHaveProperty('price');
    // and the clear route empties them
    await clearCache();
    const { jpy, totals } = await jpyOf();
    expect(jpy).toMatchObject({ price: '2.0000000', price_time: iso(1_793_000_000) });
    expect(Object.keys(jpy).filter((k) => /price_change|volume|trades/.test(k))).toEqual([]);
    expect(totals).not.toHaveProperty('native_volume');
  });

  it('a day set gives the change, the volume and the trades of its pairs, "0" and 0 for the tokens it has none of, and its total', async () => {
    await h.ch.insert(Table.MarketsLive, jpySet('day', 1_793_100_000));
    await clearCache();
    const { jpy, totals } = await jpyOf();
    // the day set wins for the price: 1 to 2 is a rise of 100 percent
    expect(jpy).toMatchObject({
      price: '2.0000000',
      price_change: '100.00',
      price_time: iso(1_793_100_000),
      native_volume: '7',
      trades: 7,
    });
    expect(totals).toEqual({ tokens: 15, tokens_with_10_holders: 9, holders: HOLDERS, native_volume: '7' });
    const body = (await api.ok('/v2/tokens?limit=1000', 'tokens')).body as Obj;
    const usd = (body.tokens as Obj[])[0];
    expect([usd.native_volume, usd.trades, 'price' in usd]).toEqual(['0', 0, false]);
  });
});

// =====================================================================================================================
// the other networks
// =====================================================================================================================

describe('GET /v2/tokens on Xahau', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedTokensWorld(h, { network: 'xahau', bulk: false });
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('coverage on Xahau from the state parser floor, and the prices against XAH', async () => {
    // the first ledger of Xahau is 1 and is stored with the state parser: complete
    const body = (await api.ok('/v2/tokens?limit=1000', 'tokens')).body as Obj;
    expect(body.coverage).toEqual({ from_ledger_index: 1, complete: true });
    expect(keysOf(body)).toEqual(LIST_ORDER);
    // the world is the same with XAH for XRP
    expect((body.tokens as Obj[])[0]).toMatchObject(FACTS.usd);
    expect((body.totals as Obj).native_volume).toBe('243.5');
    // an older parser's ledger moves the start above it
    await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(500, 1_500_000_000), parser_version: STATE_PARSER_VERSION - 1 }]);
    await api.ok('/v2/test-cache/clear', 'result');
    expect(((await api.ok('/v2/tokens', 'coverage')).body as Obj).coverage).toEqual({
      from_ledger_index: 501,
      complete: false,
    });
  });
});

describe('GET /v2/tokens on a testnet', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xrpl-testnet', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedTokensWorld(h, { network: 'xrpl-testnet', bulk: false, markets: false, lines: false });
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('testnet coverage is never complete', async () => {
    // the oldest stored ledger is as old as can be, and the network has no first ledger to compare it with
    const body = (await api.ok('/v2/tokens', 'tokens')).body as Obj;
    expect(body.coverage).toEqual({ from_ledger_index: 1, complete: false });
    expect(keysOf(body)).toEqual(LIST_ORDER);
  });
});

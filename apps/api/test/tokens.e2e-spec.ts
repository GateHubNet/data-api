import { STATE_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { COVERAGE_KEYS } from '../src/common/feature-coverage.service';
import { TOKEN_LIST_KEYS } from '../src/tokens/token-list';
import {
  HOLDER_ROW_KEYS,
  HOLDERS_ANSWER_KEYS,
  ISSUED_TOKEN_ROW_KEYS,
  ISSUED_TOTALS_KEYS,
  ISSUER_SETTINGS_KEYS,
  TOKEN_ANSWER_KEYS,
  TOKEN_KEYS,
  TOKEN_MARKET_KEYS,
} from '../src/tokens/token-objects';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { cells, compare, decodeMarker, iso, lines, primaryKeys, served } from './support/amm';
import { csvDisposition } from './support/csv';
import { HandPair, handSet } from './support/markets-world';
import { explain } from './support/plans';
import { markerOf, readsOf } from './support/read-rows';
import {
  BUILDING,
  BUILDING_ONLY,
  DEAD,
  DEMURRAGE_HEX,
  generationRow,
  holderAt,
  holderOf,
  HOLDERS,
  ISSUER_A,
  ISSUER_B,
  ISSUER_C,
  ISSUER_D,
  lineRow,
  LIST_ORDER,
  LIVE,
  LIVE_LINES_BULK,
  LIVE_NEW_ROWS,
  LIVE_OLD_ROWS,
  LIVE_PARTS,
  LIVE_TOKENS,
  LIVE_TOKENS_BULK,
  NPUSD_HEX,
  PASS_OVER_PARTS,
  RETIRED,
  RETIRED_BULK_PARTS,
  RETIRED_BULK_PER_PART,
  RETIRED_ONLY,
  SeedToken,
  seedTokensWorld,
  THROUGH,
  THROUGH_CLOSE,
  TIE,
  TIE_BALANCES,
  TIE_HOLDERS,
  TIE_SUPPLY,
  tieHolder,
  tokensRow,
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
/** The path of a token: `{currency}.{issuer}`. */
const pathOf = (t: { currency: string; issuer: string }): string => `/v2/tokens/${t.currency}.${t.issuer}`;
/** `balance` over `supply` to 6 decimals, half up, worked out here with the quotient kept whole (the service rounds it once). */
const shareIs = (balance: string, supply: string): string =>
  new (BigNumber.clone({ DECIMAL_PLACES: 60 }))(balance)
    .dividedBy(supply)
    .decimalPlaces(6, BigNumber.ROUND_HALF_UP)
    .toFixed(6);
/** The 40 hex digits of the standard form of a 3-character code. */
const standardHex = (code: string): string =>
  `${'0'.repeat(24)}${Buffer.from(code, 'latin1').toString('hex').toUpperCase()}${'0'.repeat(10)}`;

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
    // the cache is emptied first: a warm one would answer the generation and the coverage without a read, and the spy below would see none
    // whatever the order of the checks
    await clearCache();
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
    // a token and its holders are not found in it
    for (const path of [pathOf(seed('usd')), `${pathOf(seed('usd'))}/holders`]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'token not found' }]);
    }

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

  it('404 token not found before any generation, for an unknown token, a deleted row and an LP token', async () => {
    // (the ledgers and the generations of the test before are in the database: a generation that builds and one that is retired)
    const usd = pathOf({ currency: 'USD', issuer: ISSUER_A });
    const paths = [usd, `${usd}/holders`, `${usd}/holders?format=csv`];
    const notFound = async (): Promise<void> => {
      for (const path of paths) {
        const res = await api.get(path);
        expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'token not found' }]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    };
    await notFound();

    // the tokens of generations that are not live are not served, a deleted one included: USD is in the retired generation and in
    // the one that builds, with lines, and DED was deleted in the newest version of the retired one
    const usdRef = { issuer: ISSUER_A, currency: 'USD' };
    await h.ch.insert(Table.Tokens, [
      tokensRow({ generation: 3, ...usdRef, holders: 1, trust_lines: 1, supply: '5', supply_f: 5 }),
      tokensRow({ generation: 4, ...usdRef, holders: 2, trust_lines: 2, supply: '9', supply_f: 9 }),
      tokensRow({ generation: 3, issuer: ISSUER_A, currency: 'DED', holders: 3, version: 1_000 }),
      tokensRow({ generation: 3, issuer: ISSUER_A, currency: 'DED', holders: 3, deleted: 1 }),
    ]);
    await h.ch.insert(Table.TokenLines, [
      lineRow(usdRef, holderAt(0, 1), '5', { generation: 3 }),
      lineRow(usdRef, holderAt(0, 2), '9', { generation: 4 }),
    ]);
    await clearCache();
    await notFound();
    for (const path of [
      pathOf({ currency: 'DED', issuer: ISSUER_A }),
      `${pathOf({ currency: 'DED', issuer: ISSUER_A })}/holders`,
    ]) {
      expect([path, (await api.get(path)).status]).toEqual([path, 404]);
    }

    // an LP token is not looked for at all
    await clearCache();
    const spy = jest.spyOn(h.ch, 'query');
    const lp = pathOf({ currency: `03${'AB'.repeat(19)}`, issuer: ISSUER_A });
    for (const path of [lp, `${lp}/holders`]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'token not found' }]);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks the marker with no generation too: a bad one is 400, and nothing is read for it', async () => {
    // a warm cache would hide a read of the coverage or of the generation that came before the check
    await clearCache();
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

  it('checks the path and the marker of a token before looking for it: 400 with no generation too, and nothing is read for it', async () => {
    await clearCache();
    const spy = jest.spyOn(h.ch, 'query');
    const token = pathOf(seed('usd'));
    for (const [path, message] of [
      ['/v2/tokens/USD.xyz', 'invalid issuer address'],
      ['/v2/tokens/USD.xyz/holders', 'invalid issuer address'],
      [`/v2/tokens/%24%24.${ISSUER_A}/holders?marker=%25%25`, 'invalid currency'],
      [`/v2/tokens/XRP.${ISSUER_A}`, 'XRP cannot have an issuer'],
      [`${token}/holders?marker=%25%25`, 'invalid marker'],
      [`${token}/holders?format=csv&marker=${markerOf(['issued', 1, 'r', 'USD'])}`, 'invalid marker'],
    ]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // a good marker is looked at, and there is no token to list
    const res = await api.get(`${token}/holders?marker=${markerOf([1.5, ISSUER_A])}`);
    expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'token not found' }]);
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
    // a token and its holders cannot name the ledger either
    const usd = pathOf(seed('usd'));
    for (const [path, message] of [
      [usd, 'unable to retrieve token'],
      [`${usd}/holders`, 'unable to retrieve holders'],
    ]) {
      const res = await api.get(path);
      expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message }]);
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
    // (and the token is not found: the generation has none)
    expect((await api.get(usd)).status).toBe(404);

    // a token of the generation: 12 holders of 1 to 12 and a line with no balance. The generation has not counted its distinct holders
    // (holders_ledger 0, holders 0): the token has its own count, which is served, not that 0
    const usdRef = { issuer: ISSUER_A, currency: 'USD' };
    await h.ch.insert(Table.Tokens, [
      tokensRow({ generation: 9, ...usdRef, holders: 12, trust_lines: 13, supply: '78', supply_f: 78 }),
    ]);
    await h.ch.insert(Table.TokenLines, [
      ...Array.from({ length: 12 }, (_, i) => lineRow(usdRef, holderAt(0, i + 1), String(i + 1), { generation: 9 })),
      lineRow(usdRef, holderAt(0, 13), '0', { generation: 9 }),
    ]);
    const token = (await api.ok(usd, 'token')).body.token as Obj;
    expect(token).toMatchObject({ holders: 12, trust_lines: 13, supply: '78', markets: [] });
    expect(Object.keys(token).filter((k) => /price|volume|trades/.test(k))).toEqual([]);
    const holders = (await api.ok(`${usd}/holders`, 'holders')).body as Obj;
    expect([holders.supply, holders.count, holders.ledger_index]).toEqual(['78', 12, through]);
    expect((holders.holders as Obj[])[0]).toEqual({
      rank: 1,
      holder: holderAt(0, 12),
      balance: '12',
      share: shareIs('12', '78'),
      limit: '1000000',
      frozen: false,
      authorized: false,
    });

    // counted holders are served by the list; the token's own count is the same, whatever the generation's
    await h.ch.insert(Table.TokenGenerations, [
      generationRow(9, 'live', 40, { through_ledger: through, holders: 77, holders_ledger: through - 1 }),
    ]);
    await clearCache();
    expect(((await api.ok('/v2/tokens', 'totals')).body.totals as Obj).holders).toBe(77);
    expect(((await api.ok(usd, 'token')).body.token as Obj).holders).toBe(12);
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
    // nor does the token: no price, volume or trades, and no market
    const jpy = (await api.ok(pathOf(seed('jpy')), 'token')).body.token as Obj;
    expect(Object.keys(jpy).filter((k) => /price|volume|trades/.test(k))).toEqual([]);
    expect(jpy.markets).toEqual([]);
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
    // the token has the same price, and no market (the markets are those of the day)
    const token = (await api.ok(pathOf(seed('jpy')), 'token')).body.token as Obj;
    expect(token).toMatchObject({ price: '2.0000000', price_time: iso(1_793_000_000), markets: [] });
    expect(Object.keys(token).filter((k) => /price_change|volume|trades/.test(k))).toEqual([]);
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
    // the token has these numbers and the pair as its market (the set has no AMM column: no amm_pool), turned or not
    const token = (await api.ok(pathOf(seed('jpy')), 'token')).body.token as Obj;
    expect(token).toMatchObject({
      price: '2.0000000',
      price_change: '100.00',
      price_time: iso(1_793_100_000),
      native_volume: '7',
      trades: 7,
    });
    expect(token.markets).toEqual([
      {
        counter_currency: 'XRP',
        count: 7,
        volume: '7',
        counter_volume: '14',
        native_volume: '7',
        last: '2.0000000',
        change: '100.00',
        last_time: iso(1_793_100_000),
      },
    ]);
    // another token (0 trades, 0 volume): no market
    const usdToken = (await api.ok(pathOf(seed('usd')), 'token')).body.token as Obj;
    expect([usdToken.native_volume, usdToken.trades, usdToken.markets]).toEqual(['0', 0, []]);
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

  it("Xahau names its flags by xahaud's table", async () => {
    // the issuer A has the XRPL's clawback bit (0x80000000, which is DisallowIncomingRemit on Xahau): no clawback here
    const usd = (await api.ok(pathOf(seed('usd')), 'token')).body.token as Obj;
    expect(usd.issuer_settings).toEqual({
      transfer_fee: '0',
      global_freeze: false,
      no_freeze: false,
      allow_trust_line_clawback: false,
      require_auth: false,
      default_ripple: true,
    });
    // the issuer C has Xahau's (0x1000, which names nothing on the XRP Ledger) and the global freeze
    const xyz = (await api.ok(pathOf(seed('xyz')), 'token')).body.token as Obj;
    expect(xyz.issuer_settings).toEqual({
      transfer_fee: '0',
      global_freeze: true,
      no_freeze: false,
      allow_trust_line_clawback: true,
      require_auth: false,
      default_ripple: false,
    });
    // the toml of Xahau is xahau.toml, the price and the markets are against XAH
    expect(usd).toMatchObject({
      ...FACTS.usd,
      toml_url: 'https://northpeak.example/.well-known/xahau.toml',
    });
    expect((usd.markets as Obj[]).map((m) => m.counter_currency)).toEqual(['XAH', 'ZZZ', 'EUR']);

    // XAH with an issuer is no token; XRP is a currency like any other here, and no token has it
    for (const [segment, status, message] of [
      [`XAH.${ISSUER_A}`, 400, 'XAH cannot have an issuer'],
      [`${standardHex('XAH')}.${ISSUER_A}`, 400, 'XAH cannot have an issuer'],
      [`XRP.${ISSUER_A}`, 404, 'token not found'],
    ] as [string, number, string][]) {
      for (const path of [`/v2/tokens/${segment}`, `/v2/tokens/${segment}/holders`]) {
        const res = await api.get(path);
        expect([path, res.status, res.body]).toEqual([path, status, { result: 'error', message }]);
      }
    }
    // and the holders are those of the world, with the coverage of the test before (a ledger of an older parser at 500)
    const holders = (await api.ok(`${pathOf(seed('usd'))}/holders?limit=2`, 'holders')).body as Obj;
    expect([holders.coverage, holders.supply, holders.count]).toEqual([
      { from_ledger_index: 501, complete: false },
      '7320',
      2,
    ]);
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

  it('a token and its holders say the same of the coverage; with no lines a token has no holders to list', async () => {
    const token = (await api.ok(pathOf(seed('usd')), 'token')).body as Obj;
    expect(token.coverage).toEqual({ from_ledger_index: 1, complete: false });
    expect(token.token).toMatchObject({ holders: 120, supply: '7320', markets: [] });
    const holders = (await api.ok(`${pathOf(seed('usd'))}/holders`, 'holders')).body as Obj;
    expect(holders.coverage).toEqual({ from_ledger_index: 1, complete: false });
    expect([holders.supply, holders.count, holders.holders]).toEqual(['7320', 0, []]);
  });
});

// =====================================================================================================================
// one token (spec 5.2) and its holders (spec 5.3)
// =====================================================================================================================

/** The place `a` has before `b` in the order of the holders: the larger double first, then the address. */
const byBalanceThenHolder = (a: [number, string], b: [number, string]): number => b[0] - a[0] || compare(a[1], b[1]);
/** An object without the keys given. */
const without = (o: Obj, ...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** A read read at least the rows the answer needs and at most the bound; the failure says how many it read. */
function expectRowsBetween(label: unknown, read: number, needed: number, bound: number): void {
  if (read < needed || read > bound) {
    throw new Error(
      `${JSON.stringify(label)}: read ${read} rows, the answer needs ${needed} and the bound is ${bound}`,
    );
  }
}
/** The text of a plan without the lines that draw its tree. */
const plain = (plan: string): string => plan.replace(/[│├└─]/g, ' ');
/** The settings of the issuer A: DefaultRipple and the XRPL's clawback bit. */
const SETTINGS_A = {
  transfer_fee: '0',
  global_freeze: false,
  no_freeze: false,
  allow_trust_line_clawback: true,
  require_auth: false,
  default_ripple: true,
};

/**
 * The detail of USD, worked out from the world (`FACTS` has the price and the volume, `markets-world.ts` the pairs). USD is the base
 * of USD/N and USD/ZZZ and the counter of EUR/USD, which is turned (1.25 USD per EUR is 0.8 EUR per USD, and the volume of the USD
 * side, 50, comes first); the markets are by native volume, 65, 60, 25.
 */
const TOKEN_USD: Obj = {
  currency: 'USD',
  code: 'USD',
  issuer: ISSUER_A,
  holders: 120,
  trust_lines: 150,
  supply: '7320',
  ...FACTS.usd,
  domain: 'northpeak.example',
  toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
  listed: true,
  toml: { name: 'Northpeak USD' },
  issuer_settings: SETTINGS_A,
  markets: [
    {
      counter_currency: 'XRP',
      count: 13,
      volume: '130',
      counter_volume: '65',
      native_volume: '65',
      last: '0.40000000',
      change: '-20.00',
      last_time: '2020-07-02T10:42:17Z',
      amm_pool: false,
    },
    {
      counter_currency: 'ZZZ',
      counter_issuer: ISSUER_A,
      count: 12,
      volume: '120',
      counter_volume: '240',
      native_volume: '60',
      last: '2.0000000',
      change: '0.00',
      last_time: '2020-07-02T04:11:00Z',
      amm_pool: false,
    },
    {
      counter_currency: 'EUR',
      counter_issuer: ISSUER_A,
      count: 10,
      volume: '50',
      counter_volume: '40',
      native_volume: '25',
      last: '0.80000000',
      change: '0.00',
      last_time: '2020-07-02T05:09:00Z',
      amm_pool: false,
    },
  ],
  last_ledger: THROUGH - 10,
};

describe('GET /v2/tokens/{currency}.{issuer} and /holders on the world of what a read of one token passes over', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    get = api.get;
    await seedTokensWorld(h, { passOver: true });
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const clearCache = async (): Promise<void> => {
    await api.ok('/v2/test-cache/clear', 'result');
  };
  const detail = async (key: string): Promise<Obj> => (await api.ok(pathOf(seed(key)), 'token')).body.token as Obj;
  const holdersOf = async (path: string, query = ''): Promise<Obj> =>
    (await api.ok(`${path}/holders${query}`, 'holders')).body as Obj;
  const addressesOf = (body: Obj): string[] => (body.holders as Obj[]).map((r) => String(r.holder));

  it('the data is as the tests assume', async () => {
    const partitions = async (table: Table): Promise<number[][]> =>
      (
        await h.ch.query<{ partition: string; parts: string; rows: string }>(
          `SELECT partition, count() AS parts, sum(rows) AS rows FROM system.parts
            WHERE database = {db:String} AND table = {table:String} AND active GROUP BY partition ORDER BY partition`,
          { db: h.database, table },
        )
      ).map((p) => [Number(p.partition), Number(p.parts), Number(p.rows)]);
    // tokens: the retired generation's bulk in four parts and its two tokens; the live partition in the older versions, the newest
    // (with TIE) and the bulk; the building one's token
    expect(await partitions(Table.Tokens)).toEqual([
      [RETIRED, 1 + RETIRED_BULK_PARTS, 2 + RETIRED_BULK_PARTS * RETIRED_BULK_PER_PART],
      [LIVE, PASS_OVER_PARTS, LIVE_OLD_ROWS + LIVE_NEW_ROWS + 1 + LIVE_TOKENS_BULK],
      [BUILDING, 1, 1],
    ]);
    // token_lines: in the live partition seven other versions, the base lines, two tombstones and the nine lines of TIE, and the
    // bulk; the USD lines of the other two generations, and the retired bulk
    const baseLines = LIVE_TOKENS.reduce((n, t) => n + t.trustLines, 0);
    expect(await partitions(Table.TokenLines)).toEqual([
      [RETIRED, 1 + RETIRED_BULK_PARTS, 1 + RETIRED_BULK_PARTS * RETIRED_BULK_PER_PART],
      [LIVE, PASS_OVER_PARTS, 7 + baseLines + 2 + TIE_BALANCES.length + LIVE_LINES_BULK],
      [BUILDING, 1, 1],
    ]);
    expect(RETIRED_BULK_PER_PART).toBeGreaterThan(2 * GRANULE);
  });

  // -- the detail -------------------------------------------------------------------------------------------------------

  it('the detail: keys, toml, toml_url, issuer settings, markets turned and ordered, last_ledger', async () => {
    const res = await api.ok(pathOf(seed('usd')), 'token');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    const body = res.body as Obj;
    // result, coverage, ledger_index, close_time, token
    expect(Object.keys(body)).toEqual([...TOKEN_ANSWER_KEYS]);
    expect(body.result).toBe('success');
    expect(body.coverage).toEqual({ from_ledger_index: 32_570, complete: true });
    expect(Object.keys(body.coverage as Obj)).toEqual([...COVERAGE_KEYS]);
    // the ledger the generation is through, not the token's last
    expect(body.ledger_index).toBe(THROUGH);
    expect(body.close_time).toBe(iso(THROUGH_CLOSE));

    const usd = body.token as Obj;
    expect(usd).toEqual(TOKEN_USD);
    expectKeysInOrder(usd, TOKEN_KEYS);
    expect(Object.keys(usd.issuer_settings as Obj)).toEqual([...ISSUER_SETTINGS_KEYS]);
    for (const market of usd.markets as Obj[]) expectKeysInOrder(market, TOKEN_MARKET_KEYS);

    // ZZZ is the counter of both its pairs, so both are turned (2 ZZZ per USD is 0.5 USD per ZZZ, and the volume of the ZZZ side
    // comes first); it has a domain and a toml url, and is not listed: no toml
    expect(await detail('zzz')).toEqual({
      currency: 'ZZZ',
      code: 'ZZZ',
      issuer: ISSUER_A,
      holders: 60,
      trust_lines: 64,
      supply: '1860',
      ...FACTS.zzz,
      domain: 'zedcoin.example',
      toml_url: 'https://zedcoin.example/.well-known/xrp-ledger.toml',
      listed: false,
      issuer_settings: SETTINGS_A,
      markets: [
        {
          counter_currency: 'USD',
          counter_issuer: ISSUER_A,
          count: 12,
          volume: '240',
          counter_volume: '120',
          native_volume: '60',
          last: '0.50000000',
          change: '0.00',
          last_time: '2020-07-02T04:11:00Z',
          amm_pool: false,
        },
        {
          counter_currency: 'XRP',
          count: 11,
          volume: '110',
          counter_volume: '55',
          native_volume: '55',
          last: '0.50000000',
          change: '0.00',
          last_time: '2020-07-02T03:10:00Z',
          amm_pool: false,
        },
      ],
      last_ledger: THROUGH - 10,
    });

    // NPUSD (40 hex digits that are a text code): listed, with the served fields of its toml in their order and none of the
    // others, a transfer fee of 0.2 percent, require_auth and no_freeze; no market at all
    const npusd = await detail('npusd');
    expect(npusd).toEqual({
      currency: NPUSD_HEX,
      code: 'NPUSD',
      issuer: ISSUER_B,
      holders: 40,
      trust_lines: 41,
      supply: '840',
      ...FACTS.npusd,
      domain: 'northpeak.example',
      toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      listed: true,
      toml: {
        name: 'Northpeak Dollar',
        desc: 'A US dollar stablecoin',
        display_decimals: 2,
        asset_class: 'Fiat-backed stablecoin',
        attestation: 'https://northpeak.example/attestations/2026-09.pdf',
      },
      issuer_settings: {
        transfer_fee: '0.2',
        global_freeze: false,
        no_freeze: true,
        allow_trust_line_clawback: false,
        require_auth: true,
        default_ripple: false,
      },
      markets: [],
      last_ledger: THROUGH - 10,
    });
    expect(Object.keys(npusd.toml as Obj)).toEqual(['name', 'desc', 'display_decimals', 'asset_class', 'attestation']);

    // a currency with no code, an issuer that froze everything, no domain and no market: neither code, domain, toml_url, toml nor price
    expect(await detail('hex')).toEqual({
      currency: DEMURRAGE_HEX,
      issuer: ISSUER_C,
      holders: 25,
      trust_lines: 30,
      supply: '337.5',
      ...FACTS.hex,
      listed: false,
      issuer_settings: {
        transfer_fee: '0',
        global_freeze: true,
        no_freeze: false,
        allow_trust_line_clawback: false,
        require_auth: false,
        default_ripple: false,
      },
      markets: [],
      last_ledger: THROUGH - 10,
    });

    // BTC has two pairs without a native volume (no native_volume among their keys); they have the same count: by the other currency
    expect((await detail('btc')).markets).toEqual([
      {
        counter_currency: 'EUR',
        counter_issuer: ISSUER_A,
        count: 11,
        volume: '11',
        counter_volume: '220',
        last: '20.000000',
        change: '0.00',
        last_time: '2020-07-01T15:10:00Z',
        amm_pool: false,
      },
      {
        counter_currency: 'GBP',
        counter_issuer: ISSUER_A,
        count: 11,
        volume: '11',
        counter_volume: '330',
        last: '30.000000',
        change: '0.00',
        last_time: '2020-07-01T16:10:00Z',
        amm_pool: false,
      },
    ]);
    // JPY traded only in the month: a price from the 30day set (no change), and no market of the day
    const jpy = await detail('jpy');
    expect(jpy).toMatchObject({ ...FACTS.jpy, markets: [] });
    expect(jpy).not.toHaveProperty('price_change');

    // every token of the world: the facts the list has, and the keys in order
    for (const key of LIST_ORDER) {
      const token = await detail(key);
      expect([key, token]).toEqual([key, expect.objectContaining(without(rowOf(key, 0), 'rank', 'name'))]);
      expect([key, Object.keys(token)]).toEqual([key, TOKEN_KEYS.filter((k) => k in token)]);
      expect(token.last_ledger).toBe(THROUGH - 10);
    }
  });

  it('leaves issuer_settings out when the issuer has no state row', async () => {
    const old = await detail('old');
    expect(Object.keys(old)).toEqual([
      'currency',
      'code',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'native_volume',
      'trades',
      'listed',
      'markets',
      'last_ledger',
    ]);
    // the issuer D alone has no row: every other token has its issuer's settings
    for (const key of LIST_ORDER.filter((k) => k !== 'old'))
      expect(await detail(key)).toHaveProperty('issuer_settings');
  });

  it('404 token not found for an unknown token, a deleted row, the other generations and an LP token', async () => {
    const lp = `03${'AB'.repeat(19)}`;
    const missing = [
      // no such currency of a known issuer, no such issuer of a known currency
      { currency: 'FOO', issuer: ISSUER_A },
      { currency: 'NPUSD', issuer: ISSUER_A },
      { currency: 'ZZZ', issuer: ISSUER_B },
      // the newest version of DED is deleted (its older one is not), RET is of the retired generation, BLD of the building one
      DEAD,
      RETIRED_ONLY,
      BUILDING_ONLY,
      // a valid text code with a separator in it, which no token has; and the native code of the other network, which is a
      // currency like any other here
      { currency: 'A.B%20C', issuer: ISSUER_A },
      { currency: 'XAH', issuer: ISSUER_A },
    ];
    for (const t of missing) {
      for (const path of [pathOf(t), `${pathOf(t)}/holders`, `${pathOf(t)}/holders?format=csv`]) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'token not found' }]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
    // an LP token counts for nothing: not found, and nothing is read for it (the cache is empty, so a read of the generation would show)
    await clearCache();
    const spy = jest.spyOn(h.ch, 'query');
    for (const path of [
      pathOf({ currency: lp, issuer: ISSUER_A }),
      `${pathOf({ currency: lp.toLowerCase(), issuer: ISSUER_A })}/holders`,
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 404, { result: 'error', message: 'token not found' }]);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('the path errors in order: invalid currency, XRP cannot have an issuer, invalid issuer address; then invalid marker; all before any read', async () => {
    const xAddress = 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ';
    const cases: [string, string][] = [
      [`%24%24.${ISSUER_A}`, 'invalid currency'],
      ['%24%24.xyz', 'invalid currency'],
      [`.${ISSUER_A}`, 'invalid currency'],
      [`${'0'.repeat(40)}.${ISSUER_A}`, 'invalid currency'],
      [`${'A'.repeat(21)}.${ISSUER_A}`, 'invalid currency'],
      ['XRP.xyz', 'XRP cannot have an issuer'],
      [`XRP.${ISSUER_A}`, 'XRP cannot have an issuer'],
      [`${standardHex('XRP')}.${ISSUER_A}`, 'XRP cannot have an issuer'],
      ['USD.xyz', 'invalid issuer address'],
      ['USD', 'invalid issuer address'],
      ['USD.', 'invalid issuer address'],
      [`USD.${xAddress}`, 'invalid issuer address'],
      [`USD.${ISSUER_A}x`, 'invalid issuer address'],
    ];
    await clearCache();
    const spy = jest.spyOn(h.ch, 'query');
    for (const [segment, message] of cases) {
      for (const path of [
        `/v2/tokens/${segment}`,
        `/v2/tokens/${segment}/holders`,
        `/v2/tokens/${segment}/holders?format=csv`,
        // the path comes before the marker
        `/v2/tokens/${segment}/holders?marker=%25%25`,
      ]) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
    // a good path and a bad marker: invalid marker, before the token is looked for (an unknown one would be a 404)
    const bad = [
      '%25%25',
      markerOf(['issued', 60, ISSUER_B, 'USD']),
      markerOf([21.5]),
      markerOf(['21.5', ISSUER_B]),
      markerOf([21.5, 7]),
      markerOf([null as unknown as string, ISSUER_B]),
    ];
    for (const marker of bad) {
      for (const token of [pathOf(seed('usd')), pathOf({ currency: 'FOO', issuer: ISSUER_A })]) {
        const path = `${token}/holders?marker=${marker}`;
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message: 'invalid marker' }]);
        expect(res.headers['cache-control']).toBe('no-store');
        // as CSV too
        expect((await get(`${path}&format=csv`)).body).toEqual({ result: 'error', message: 'invalid marker' });
      }
    }
    // all of them before any read (the cache was empty)
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // the detail has no marker, and ignores one
    expect((await get(`${pathOf(seed('usd'))}?marker=%25%25`)).status).toBe(200);

    // they stay 400 while the database is down: the client's mistakes are not the server's
    await clearCache();
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('clickhouse is down'));
    for (const path of [
      '/v2/tokens/USD.xyz',
      '/v2/tokens/USD.xyz/holders',
      `${pathOf(seed('usd'))}/holders?marker=%25%25`,
    ]) {
      expect([path, (await get(path)).status]).toEqual([path, 400]);
    }
  });

  it('every spelling of a token answers the same: 3 characters in any case, its hex, a text code, + and | for the dot', async () => {
    const spellings: [string, string[]][] = [
      ['usd', ['USD', 'usd', 'Usd', standardHex('USD'), standardHex('USD').toLowerCase()]],
      ['npusd', ['NPUSD', NPUSD_HEX, NPUSD_HEX.toLowerCase()]],
      ['hex', [DEMURRAGE_HEX, DEMURRAGE_HEX.toLowerCase()]],
    ];
    for (const [key, codes] of spellings) {
      const t = seed(key);
      const token = (await api.ok(pathOf(t), 'token')).body as Obj;
      const holders = await holdersOf(pathOf(t));
      for (const code of codes) {
        for (const separator of ['.', '+', '%7C']) {
          const segment = `${code}${separator}${t.issuer}`;
          expect([segment, (await api.ok(`/v2/tokens/${segment}`, 'token')).body]).toEqual([segment, token]);
          expect([segment, (await api.ok(`/v2/tokens/${segment}/holders`, 'holders')).body]).toEqual([
            segment,
            holders,
          ]);
        }
      }
    }
    // a text code is read as it is written: in lower case it is another currency (only a code of 3 characters is read in upper case)
    expect((await get(`/v2/tokens/npusd.${ISSUER_B}`)).status).toBe(404);
  });

  it('a failed read is 500 unable to retrieve token, or holders; whichever read fails', async () => {
    const real = h.ch.query.bind(h.ch);
    const failing = (pattern: RegExp): jest.SpyInstance =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pattern.test(sql) ? Promise.reject(new Error('clickhouse is down')) : (real as any)(sql, ...rest)) as never);
    const usd = pathOf(seed('usd'));
    // the answer of each route when only the reads that match fail: the generation is read first, then the token, then (the markets
    // for the detail, the lines for the holders, and) the coverage
    const reads: [string, RegExp, { detail: number; holders: number }][] = [
      ['every read', /./, { detail: 500, holders: 500 }],
      ['the generation', /FROM token_generations/, { detail: 500, holders: 500 }],
      ['the token', /FROM tokens\b/, { detail: 500, holders: 500 }],
      ['the markets', /FROM markets_live/, { detail: 500, holders: 200 }],
      ['the lines', /FROM token_lines/, { detail: 200, holders: 500 }],
    ];
    for (const [what, pattern, status] of reads) {
      for (const [path, message, expected] of [
        [usd, 'unable to retrieve token', status.detail],
        [`${usd}/holders`, 'unable to retrieve holders', status.holders],
        [`${usd}/holders?format=csv`, 'unable to retrieve holders', status.holders],
      ] as [string, string, number][]) {
        await clearCache();
        const spy = failing(pattern);
        const res = await get(path);
        spy.mockRestore();
        expect([what, path, res.status]).toEqual([what, path, expected]);
        if (expected === 500) {
          expect([what, path, res.body]).toEqual([what, path, { result: 'error', message }]);
          expect(res.headers['cache-control']).toBe('no-store');
        }
      }
    }
    // the coverage fails when the generation is known (kept) and the ledgers are not: the 404 of an unknown token reads the
    // generation and the token only
    await clearCache();
    expect((await get(pathOf({ currency: 'FOO', issuer: ISSUER_A }))).status).toBe(404);
    failing(/FROM ledgers\b/);
    for (const [path, message] of [
      [usd, 'unable to retrieve token'],
      [`${usd}/holders`, 'unable to retrieve holders'],
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 500, { result: 'error', message }]);
    }
    jest.restoreAllMocks();
    // and nothing was kept of the failures
    await clearCache();
    expect((await get(usd)).status).toBe(200);
    expect((await get(`${usd}/holders`)).status).toBe(200);
  });

  it('answers 401 without a key', async () => {
    for (const path of [pathOf(seed('usd')), `${pathOf(seed('usd'))}/holders`]) {
      const res = await h.http().get(path);
      expect([path, res.status, res.body]).toEqual([
        path,
        401,
        { result: 'error', message: 'Missing or invalid API key.' },
      ]);
    }
  });

  // -- the holders ------------------------------------------------------------------------------------------------------

  it('holders: by balance then holder, ranks, shares, frozen and authorized', async () => {
    const usd = seed('usd');
    const res = await api.ok(`${pathOf(usd)}/holders`, 'holders');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    const body = res.body as Obj;
    // result, coverage, ledger_index, close_time, supply, count, holders: no marker on the last page
    expect(Object.keys(body)).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'close_time',
      'supply',
      'count',
      'holders',
    ]);
    expectKeysInOrder(body, HOLDERS_ANSWER_KEYS);
    expect(body.coverage).toEqual({ from_ledger_index: 32_570, complete: true });
    expect([body.ledger_index, body.close_time]).toEqual([THROUGH, iso(THROUGH_CLOSE)]);
    // the supply of the token's row, not a sum of the lines read (a holder's older version has 9999.5, a tombstone 700)
    expect(body.supply).toBe('7320');
    // 120 holders: the lines with a balance, newest versions, not the tombstones of 152 and 153 and not the 30 empty lines; the
    // largest balance first, so holder 120 is the first
    expect(body.count).toBe(120);
    const rows = body.holders as Obj[];
    expect(rows).toHaveLength(120);
    rows.forEach((row, i) => {
      const n = 120 - i;
      expect([i, row]).toEqual([
        i,
        {
          rank: i + 1,
          holder: holderOf(usd, n),
          balance: `${n}.5`,
          share: shareIs(`${n}.5`, '7320'),
          limit: '1000000',
          frozen: false,
          authorized: false,
        },
      ]);
      expect(Object.keys(row)).toEqual([...HOLDER_ROW_KEYS]);
    });
    // none of the other generations' holders, the tombstones or the older balances; the shares add up to the whole, give or take the
    // rounding of each (half of the 6th decimal)
    const holders = new Set(addressesOf(body));
    for (const n of [152, 153, 900, 901]) expect(holders.has(holderOf(usd, n))).toBe(false);
    expect(rows.some((r) => r.balance === '9999.5')).toBe(false);
    const total = rows.reduce((sum, r) => sum.plus(r.share as string), new BigNumber(0));
    expect(total.minus(1).abs().lte(new BigNumber(rows.length).times('0.0000005'))).toBe(true);

    // the flags and the limit of a line are those of its newest version: NPUSD's three largest holders
    const npusd = seed('npusd');
    const flagged = await holdersOf(pathOf(npusd));
    expect([flagged.supply, flagged.count]).toEqual(['840', 40]);
    const holderRow = (rank: number, n: number, over: Obj = {}): Obj => ({
      rank,
      holder: holderOf(npusd, n),
      balance: `${n}.5`,
      share: shareIs(`${n}.5`, '840'),
      limit: '1000000',
      frozen: false,
      authorized: false,
      ...over,
    });
    expect((flagged.holders as Obj[]).slice(0, 5)).toEqual([
      holderRow(1, 40, { limit: '1000000000', authorized: true }),
      holderRow(2, 39, { frozen: true, authorized: true }),
      holderRow(3, 38, { limit: '0', frozen: true }),
      holderRow(4, 37),
      holderRow(5, 36),
    ]);
    expect((flagged.holders as Obj[]).filter((r) => r.frozen === true || r.authorized === true)).toHaveLength(3);

    // a token with no holder: its supply, an empty list, no marker
    expect(await holdersOf(pathOf(seed('chf')))).toEqual({
      result: 'success',
      coverage: body.coverage,
      ledger_index: THROUGH,
      close_time: iso(THROUGH_CLOSE),
      supply: '0',
      count: 0,
      holders: [],
    });

    // limit: 0, a text and a negative number are the default; more than 1000 is 1000
    for (const limit of ['0', 'abc', '-5', '', '100000']) {
      expect([limit, (await holdersOf(pathOf(usd), `?limit=${limit}`)).count]).toEqual([limit, 120]);
    }
    expect((await holdersOf(pathOf(usd), '?limit=7')).count).toBe(7);
  });

  it('holders: equal balances are ordered by holder and pages concatenate', async () => {
    const path = pathOf(TIE);
    // the order of the double, then the address, worked out here
    const expected = TIE_BALANCES.filter(([, balance]) => Number(balance) > 0)
      .map(([i, balance]): [number, string, string] => [Number(balance), tieHolder(i), balance])
      .sort((a, b) => byBalanceThenHolder([a[0], a[1]], [b[0], b[1]]));
    expect(expected).toHaveLength(TIE_HOLDERS);
    // the two balances that are one double come first, told apart by the holder alone: the smaller text first, though the larger is
    // the larger number; then the three equal ones, by address (not by the number of the holder), the two equal ones, the small one
    expect(expected.map(([, , balance]) => balance)).toEqual([
      '9007199254740992',
      '9007199254740993',
      '100',
      '100',
      '100',
      '50',
      '50',
      '0.000001',
    ]);
    expect(expected.map(([, holder]) => holder).slice(2, 5)).not.toEqual([1, 2, 3].map(tieHolder));

    const whole = await holdersOf(path, '?limit=1000');
    expect(whole).not.toHaveProperty('marker');
    expect(whole.supply).toBe(TIE_SUPPLY);
    expect(addressesOf(whole)).toEqual(expected.map(([, holder]) => holder));
    expect((whole.holders as Obj[]).map((r) => r.balance)).toEqual(expected.map(([, , balance]) => balance));
    expect((whole.holders as Obj[]).map((r) => r.rank)).toEqual(oneTo(TIE_HOLDERS));
    expect((whole.holders as Obj[]).map((r) => r.share)).toEqual(
      expected.map(([, , balance]) => shareIs(balance, TIE_SUPPLY)),
    );
    // the line with no balance is no holder, and the older balance (5) of a holder is not its balance
    expect(addressesOf(whole)).not.toContain(tieHolder(9));
    expect((whole.holders as Obj[]).map((r) => r.balance)).not.toContain('5');

    for (const limit of [1, 2, 3, 5, 7]) {
      const pages = await api.pages<Obj>(`${path}/holders`, limit, 'holders');
      const label = `limit=${limit}`;
      expect([label, pages.length]).toEqual([label, Math.ceil(TIE_HOLDERS / limit)]);
      expect([label, pages.flatMap((page) => page.holders)]).toEqual([label, whole.holders]);
      pages.forEach((page, i) => {
        // the same envelope on every page but the count and the marker (a page with a next one only)
        expect(without(page, 'count', 'marker', 'holders')).toEqual(without(whole, 'count', 'marker', 'holders'));
        expect(page.count).toBe((page.holders as Obj[]).length);
        expect([label, i, page.marker !== undefined]).toEqual([label, i, i < pages.length - 1]);
      });
    }

    // the marker is the Float64 and the holder of the last row; the next page begins at the other holder of the same double
    const first = await get(`${path}/holders?limit=1`);
    expect(decodeMarker(first.body.marker as string)).toEqual([9007199254740992, expected[0][1]]);
    const second = await get(`${path}/holders?limit=1&marker=${first.body.marker as string}`);
    expect((second.body.holders as Obj[]).map((r) => [r.holder, r.rank, r.balance])).toEqual([
      [expected[1][1], 2, '9007199254740993'],
    ]);
    // and the Link header is the request with the marker
    const origin = new URL(first.request.url).origin;
    expect(first.headers.link).toBe(
      `<${origin}${path}/holders?limit=1&marker=${first.body.marker as string}>; rel="next"`,
    );
    expect((await get(`${path}/holders?limit=1000`)).headers.link).toBeUndefined();

    // a marker is a place, not a row: after (100, an address just after the second holder of 100) comes the third, with its rank
    const hundreds = expected.filter(([balance]) => balance === 100);
    const after = await holdersOf(path, `?marker=${markerOf([100, `${hundreds[1][1]}a`])}&limit=1`);
    expect((after.holders as Obj[]).map((r) => [r.holder, r.rank])).toEqual([[hundreds[2][1], 5]]);
    // past the last: an empty page, with the supply
    const past = await get(`${path}/holders?marker=${markerOf([0.000001, 'rzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'])}`);
    expect([past.status, past.body.count, past.body.holders, past.body.supply]).toEqual([200, 0, [], TIE_SUPPLY]);
    expect(past.body).not.toHaveProperty('marker');
  });

  it('holders CSV is "<code> <issuer> - holders.csv"', async () => {
    const npusd = seed('npusd');
    const res = await get(`${pathOf(npusd)}/holders?format=csv&limit=1000`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    // the code of the token, not the spelling of the path
    expect(res.headers['content-disposition']).toBe(csvDisposition(`NPUSD ${ISSUER_B} - holders`));
    const table = lines(res.text).map(cells);
    const header = HOLDER_ROW_KEYS.map((k) => `"${k}"`);
    expect(table[0]).toEqual(header);
    expect(table).toHaveLength(1 + 40);
    for (const row of table) expect(row).toHaveLength(header.length);
    // no coverage, no envelope
    for (const word of ['coverage', 'from_ledger_index', 'supply', 'ledger_index', 'close_time', 'marker']) {
      expect(res.text).not.toContain(word);
    }
    expect(table[1]).toEqual([
      '"1"',
      `"${holderOf(npusd, 40)}"`,
      '"40.5"',
      `"${shareIs('40.5', '840')}"`,
      '"1000000000"',
      '"false"',
      '"true"',
    ]);
    // the other spellings of the path give the same file under the same name
    for (const segment of [
      `${NPUSD_HEX}.${ISSUER_B}`,
      `${NPUSD_HEX.toLowerCase()}+${ISSUER_B}`,
      `NPUSD%7C${ISSUER_B}`,
    ]) {
      const other = await get(`/v2/tokens/${segment}/holders?format=csv&limit=1000`);
      expect([segment, other.headers['content-disposition'], other.text]).toEqual([
        segment,
        res.headers['content-disposition'],
        res.text,
      ]);
    }
    // a currency with no code is named by its hex; 3 characters in any case by the upper-case code
    const hex = await get(`${pathOf(seed('hex'))}/holders?format=csv`);
    expect(hex.headers['content-disposition']).toBe(csvDisposition(`${DEMURRAGE_HEX} ${ISSUER_C} - holders`));
    const lower = await get(`/v2/tokens/${DEMURRAGE_HEX.toLowerCase()}.${ISSUER_C}/holders?format=csv`);
    expect(lower.headers['content-disposition']).toBe(hex.headers['content-disposition']);
    const usd = await get(`/v2/tokens/usd.${ISSUER_A}/holders?format=csv&limit=1`);
    expect(usd.headers['content-disposition']).toBe(csvDisposition(`USD ${ISSUER_A} - holders`));

    // pages: the same columns, the rows of the JSON pages, and the Link header with format=csv
    let marker: string | undefined;
    let pages = 0;
    const rows: string[][] = [];
    do {
      const query = `limit=15${marker ? `&marker=${marker}` : ''}`;
      const part = await get(`${pathOf(npusd)}/holders?format=csv&${query}`);
      const json = await get(`${pathOf(npusd)}/holders?${query}`);
      const text = lines(part.text).map(cells);
      expect([pages, text[0]]).toEqual([pages, header]);
      expect(text.length - 1).toBe((json.body.holders as Obj[]).length);
      rows.push(...text.slice(1));
      const origin = new URL(part.request.url).origin;
      expect(part.headers.link).toBe(
        json.body.marker === undefined
          ? undefined
          : `<${origin}${pathOf(npusd)}/holders?format=csv&limit=15&marker=${json.body.marker as string}>; rel="next"`,
      );
      marker = json.body.marker as string | undefined;
      pages += 1;
    } while (marker && pages < 10);
    expect([pages, rows]).toEqual([3, table.slice(1)]);
    // a token with no holders is an empty file, and an error is not a CSV
    expect((await get(`${pathOf(seed('chf'))}/holders?format=csv`)).text).toBe('');
    const bad = await get(`${pathOf(npusd)}/holders?format=csv&marker=%25%25`);
    expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid marker' }]);
    const missing = await get(`${pathOf({ currency: 'FOO', issuer: ISSUER_A })}/holders?format=csv`);
    expect([missing.status, missing.body]).toEqual([404, { result: 'error', message: 'token not found' }]);
    // the detail has no CSV: format=csv is ignored
    const asJson = await get(`${pathOf(npusd)}?format=csv`);
    expect([asJson.status, asJson.headers['content-type']]).toEqual([200, expect.stringMatching(/^application\/json/)]);
    expect(asJson.body.result).toBe('success');
  });

  // -- reads ------------------------------------------------------------------------------------------------------------

  it("the detail reads a few granules; holders read the token's prefix and never another token's", async () => {
    const count = async (sql: string, params: Record<string, unknown> = {}): Promise<number> =>
      Number((await h.ch.query<{ n: string }>(`SELECT count() AS n ${sql}`, params))[0].n);
    const parts = async (table: Table): Promise<number> =>
      count(
        `FROM system.parts WHERE database = {db:String} AND table = {table:String} AND active AND partition = {p:String}`,
        {
          db: h.database,
          table,
          p: String(LIVE),
        },
      );
    // the rows of a token in the live partition, every version of them
    const rowsOfToken = (table: Table, t: { issuer: string; currency: string }): Promise<number> =>
      count(
        `FROM ${table} WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}`,
        {
          g: LIVE,
          ...t,
        },
      );
    const livePartsTokens = await parts(Table.Tokens);
    const livePartsLines = await parts(Table.TokenLines);
    expect([livePartsTokens, livePartsLines]).toEqual([PASS_OVER_PARTS, PASS_OVER_PARTS]);

    // what a read that did not name its generation, its issuer, or its currency would read: each is over the bound of every token
    // below, so that dropping a filter fails the test. (The bound is the token's rows plus two granules per part of its partition.)
    const maxNeeded = 2;
    const tokensBound = maxNeeded + livePartsTokens * 2 * GRANULE;
    expect(await count(`FROM ${Table.Tokens} WHERE generation = {g:UInt32}`, { g: RETIRED })).toBeGreaterThan(
      tokensBound,
    );
    expect(await count(`FROM ${Table.Tokens} WHERE generation = {g:UInt32}`, { g: LIVE })).toBeGreaterThan(tokensBound);
    expect(
      await count(`FROM ${Table.Tokens} WHERE generation = {g:UInt32} AND issuer = {i:String} AND currency != 'USD'`, {
        g: LIVE,
        i: ISSUER_A,
      }),
    ).toBeGreaterThan(tokensBound);

    // -- the detail: one point read of `tokens`, none of the lines
    const details: [string, { issuer: string; currency: string }][] = [
      ['usd', seed('usd')],
      ['old', seed('old')],
      ['npusd', seed('npusd')],
      ['hex', seed('hex')],
      ['tie', TIE],
      ['unknown', { issuer: ISSUER_A, currency: 'FOO' }],
    ];
    for (const [name, t] of details) {
      const needed = await rowsOfToken(Table.Tokens, t);
      expect(needed).toBeLessThanOrEqual(maxNeeded);
      const bound = needed + livePartsTokens * 2 * GRANULE;
      await clearCache();
      const reads = await readsOf(h, Table.Tokens, async () => {
        await get(pathOf(t));
      });
      expect([name, reads.length]).toEqual([name, 1]);
      expectRowsBetween(['detail', name], reads[0].read_rows, needed, bound);
      await clearCache();
      expect(await readsOf(h, Table.TokenLines, async () => void (await get(pathOf(t))))).toEqual([]);
    }

    // the plan of the point read: the generation's partition, then the primary key on the issuer and the currency
    await clearCache();
    const point = await served(h, api, Table.Tokens, pathOf(seed('usd')));
    expect(point.statements).toHaveLength(1);
    const pointPlan = await explain(h, 'indexes = 1', ...point.statements[0]);
    expect(plain(pointPlan)).toMatch(/Partition\s+Keys:\s+generation\s+Condition: \(generation in \[7, 7\]\)/);
    const [pointKey] = primaryKeys(pointPlan);
    expect(pointKey.keys).toEqual(['issuer', 'currency']);
    expect(pointKey.condition).toMatch(/currency in \['USD', 'USD'\]/);
    expect(pointKey.condition).toContain(`issuer in ['${ISSUER_A}', '${ISSUER_A}']`);
    // a granule of the part that holds the key, of the 17+ there are in the generation
    expect(pointKey.granules[0]).toBeLessThanOrEqual(2);
    expect(pointKey.granules[1]).toBeGreaterThan(LIVE_TOKENS_BULK / GRANULE);

    // -- the holders: the token's prefix of `token_lines`, and the one point read of its row
    const tokensOfHolders: [string, { issuer: string; currency: string }][] = [
      ['usd', seed('usd')],
      ['npusd', seed('npusd')],
      ['hex', seed('hex')],
      ['tie', TIE],
    ];
    const linesRetired = await count(`FROM ${Table.TokenLines} WHERE generation = {g:UInt32}`, { g: RETIRED });
    const linesLive = await count(`FROM ${Table.TokenLines} WHERE generation = {g:UInt32}`, { g: LIVE });
    const marker = markerOf([30.5, holderOf(seed('npusd'), 30)]);
    for (const [name, t] of tokensOfHolders) {
      const needed = await rowsOfToken(Table.TokenLines, t);
      const bound = needed + livePartsLines * 2 * GRANULE;
      // the other generations' rows, all the live partition's, and (for the issuer A's USD) its other currencies', are each over it
      expect(linesRetired).toBeGreaterThan(bound);
      expect(linesLive).toBeGreaterThan(bound);
      if (t.issuer === ISSUER_A) {
        const otherCurrencies = await count(
          `FROM ${Table.TokenLines} WHERE generation = {g:UInt32} AND issuer = {i:String} AND currency != {c:String}`,
          { g: LIVE, i: t.issuer, c: t.currency },
        );
        expect(otherCurrencies).toBeGreaterThan(bound);
      }
      for (const query of ['', '?limit=3', `?limit=2&marker=${marker}`, '?format=csv']) {
        await clearCache();
        const lineReads = await readsOf(h, Table.TokenLines, async () => {
          await get(`${pathOf(t)}/holders${query}`);
        });
        // one read of the lines, whatever the page
        expect([name, query, lineReads.length]).toEqual([name, query, 1]);
        expectRowsBetween(['holders', name, query], lineReads[0].read_rows, needed, bound);
        // and one of the token's row, to know it and to give its supply
        await clearCache();
        const tokenReads = await readsOf(h, Table.Tokens, async () => {
          await get(`${pathOf(t)}/holders${query}`);
        });
        expect([name, query, tokenReads.length]).toEqual([name, query, 1]);
        expectRowsBetween(['holders, the token', name, query], tokenReads[0].read_rows, 1, tokensBound);
      }
    }

    // the plan of the holders: the generation's partition, the primary key on the issuer and the currency, a few granules of the
    // 20+ of the bulk
    await clearCache();
    const page = await served(h, api, Table.TokenLines, `${pathOf(seed('usd'))}/holders`);
    expect(page.statements).toHaveLength(1);
    const pagePlan = await explain(h, 'indexes = 1', ...page.statements[0]);
    expect(plain(pagePlan)).toMatch(
      /Min-Max\s+Keys:\s+generation\s+Condition: \(generation in \[7, 7\]\)\s+Parts: 3\/\d+/,
    );
    expect(plain(pagePlan)).toMatch(
      /Partition\s+Keys:\s+generation\s+Condition: \(generation in \[7, 7\]\)\s+Parts: 3\/3/,
    );
    const [pageKey] = primaryKeys(pagePlan);
    expect(pageKey.keys).toEqual(['issuer', 'currency']);
    expect(pageKey.condition).toMatch(/currency in \['USD', 'USD'\]/);
    expect(pageKey.condition).toContain(`issuer in ['${ISSUER_A}', '${ISSUER_A}']`);
    expect(pageKey.granules[0]).toBeLessThanOrEqual(2 * PASS_OVER_PARTS);
    expect(pageKey.granules[1]).toBeGreaterThan(LIVE_LINES_BULK / GRANULE);
  });
});

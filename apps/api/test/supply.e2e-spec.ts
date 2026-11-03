import { AMM_PARSER_VERSION, OBJECT_PARSER_VERSION, STATE_PARSER_VERSION, Table } from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import { SUPPLY_KEYS } from '../src/network/supply-object';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { examplesOf, partOf, REFERENCE } from './support/api-reference-check';
import { readsOf } from './support/read-rows';
import {
  AMM_ENABLED,
  ESCROW_ENABLED,
  listAmendments,
  seedAmongOlderSnapshots,
  seedLedgers,
  seedSnapshots,
  XAHAU_FIRST_LEDGER,
  XAHAU_SNAPSHOT,
  xahauAnswer,
  XRPL_FIRST_LEDGER,
  XRPL_SNAPSHOT,
  xrplAnswer,
} from './support/supply-seed';

/**
 * `GET /v2/network/supply` (D7, spec 5.1) on a real ClickHouse: the newest snapshot of `network_supply`, which the syncer's `supply`
 * job writes (the snapshots here are written by hand, with the figures of the spec: `support/supply-seed.ts`), and the coverage of
 * each of its parts that is read from history (`ledgers`, and the amendments of the ledger state).
 *
 * The tests of a suite build on one another: the snapshots and ledgers one adds stay for the next. The coverage depends on the
 * oldest ledger stored and on the ledgers an older parser wrote, and the api keeps it 60 s, so a test that changes them clears the
 * caches first (`/v2/test-cache/clear`, `cache-controllers.ts`). `Escrow` and `AMM` get their enable ledgers only when the ledger
 * state lists them (`Escrow` is retired), so the tests that expect a part to be complete list them.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;
const GRANULE = 8192;
const PATH = '/v2/network/supply';

type Obj = Record<string, unknown>;

/** `JSON.stringify` of an answer: the key order is part of what is compared. */
const text = (value: unknown): string => JSON.stringify(value);

const clearCache = async (api: ApiClient): Promise<void> => {
  await api.ok('/v2/test-cache/clear', 'result');
};

/**
 * The example of `docs/api-reference.md` for a native currency: the JSON block of the section of the route whose `currency` it is.
 * The examples are answers of this suite, so what the reference shows cannot drift from what the route serves.
 */
function referenceExample(currency: string): unknown {
  const section = partOf(readFileSync(REFERENCE, 'utf8'), '### `GET /v2/network/supply`');
  const found = examplesOf(section).filter((example) => (example as Obj).currency === currency);
  if (found.length !== 1) throw new Error(`the reference has ${found.length} supply examples of ${currency}, not one`);
  return found[0];
}

/** `{ from_ledger_index, complete }`. */
const coverage = (from: number, complete: boolean) => ({ from_ledger_index: from, complete });

// =====================================================================================================================
// the XRP Ledger
// =====================================================================================================================

describe('GET /v2/network/supply on the XRP Ledger', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xrpl', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const supply = async (query = ''): Promise<Obj> => (await api.ok(`${PATH}${query}`, 'result')).body as Obj;

  it('answers 404 supply not computed yet without a snapshot, before any other read', async () => {
    // the cache is emptied first: a warm one would answer the coverage without a read, and the spy would see none whatever the order
    await clearCache(api);
    const spy = jest.spyOn(h.ch, 'query');
    const res = await api.get(PATH);
    expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'supply not computed yet' }]);
    expect(res.headers['cache-control']).toBe('no-store');
    // the one read is the newest ledger of network_supply: no second read of it, and no coverage (it is read from `ledgers`)
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain(Table.NetworkSupply);
  });

  it('answers 401 without a key', async () => {
    const refused = await h.http().get(PATH);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    expect(refused.headers['cache-control']).toBe('no-store');
  });

  it("escrowed and circulating say complete false when the history starts after Escrow's enable ledger", async () => {
    await seedSnapshots(h, [XRPL_SNAPSHOT]);
    // the history starts at 99,413,505, past the ledgers Escrow (28,685,313) and AMM (86,795,265) were enabled in, and both are
    // listed by the ledger state, so that the enable ledgers are known and it is the history that is short
    await seedLedgers(h, [[99_413_505], [107_747_456]]);
    await listAmendments(h, ['Escrow', 'AMM'], 107_747_456);
    await clearCache(api);
    const res = await api.ok(PATH, 'result');
    expect(text(res.body)).toBe(
      text(
        xrplAnswer({
          escrows: coverage(99_413_505, false),
          amm: coverage(99_413_505, false),
          reserves: coverage(99_413_505, false),
        }),
      ),
    );
    expect(res.headers['cache-control']).toBe('private, max-age=60');
  });

  it('answers the newest snapshot of XRPL with exact key order', async () => {
    // the history now starts at the ledger Escrow was enabled in: escrows and AMM are complete, the reserves (from the first ledger,
    // 32,570) are not
    await seedLedgers(h, [[ESCROW_ENABLED]]);
    await clearCache(api);
    const body = await supply();
    expect(text(body)).toBe(
      text(
        xrplAnswer({
          escrows: coverage(ESCROW_ENABLED, true),
          amm: coverage(ESCROW_ENABLED, true),
          reserves: coverage(ESCROW_ENABLED, false),
        }),
      ),
    );
    expect(Object.keys(body)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'minted'));
    // the example of the reference is this answer
    expect(text(body)).toBe(text(referenceExample('XRP')));
  });

  it("says complete true when the stored history starts at each part's start", async () => {
    await seedLedgers(h, [[XRPL_FIRST_LEDGER]]);
    await clearCache(api);
    const all = coverage(XRPL_FIRST_LEDGER, true);
    expect(text(await supply())).toBe(text(xrplAnswer({ escrows: all, amm: all, reserves: all })));
    expect(ESCROW_ENABLED).toBeGreaterThan(XRPL_FIRST_LEDGER);
    expect(AMM_ENABLED).toBeGreaterThan(ESCROW_ENABLED);
  });

  it('ignores the parameters it does not know', async () => {
    const plain = text(await supply());
    for (const query of [
      '?foo=bar',
      '?limit=1&marker=abc&start=nonsense&interval=week',
      '?format=csv',
      '?ledger_index=1',
    ]) {
      expect([query, text(await supply(query))]).toEqual([query, plain]);
    }
  });

  it('states the coverage of the feature of each part: an older parser moves the start of its own parts only', async () => {
    // a ledger of parser 2 (the AMM parser, before the state tables of 3) at 90,000,000, and one of parser 5 (before the object
    // parser, 7) at 100,000,000: AMM (version 2) has nothing older than it, the account states (3) start above the first, the escrows
    // (7) above the second
    await seedLedgers(h, [
      [90_000_000, AMM_PARSER_VERSION],
      [100_000_000, 5],
    ]);
    await clearCache(api);
    const res = await api.ok(PATH, 'result');
    expect(text(res.body)).toBe(
      text(
        xrplAnswer({
          escrows: coverage(100_000_001, false),
          amm: coverage(XRPL_FIRST_LEDGER, true),
          reserves: coverage(90_000_001, false),
        }),
      ),
    );
  });

  it('leaves reserves out without reserve values, and reads no coverage for them', async () => {
    // a snapshot with the reserve values: the coverage of the escrows, AMM and the account states is read
    const versionsRead = async (): Promise<number[]> => {
      await clearCache(api);
      const spy = jest.spyOn(h.ch, 'query');
      await supply();
      const versions = spy.mock.calls
        .filter(([sql]) => String(sql).includes('parser_version <'))
        .map(([, params]) => (params as { version: number }).version);
      spy.mockRestore();
      return versions.sort((a, b) => a - b);
    };
    expect(await versionsRead()).toEqual([AMM_PARSER_VERSION, STATE_PARSER_VERSION, OBJECT_PARSER_VERSION]);

    // the next snapshot has none: the part is left out, and its feature is not asked of
    await seedSnapshots(h, [
      { ...XRPL_SNAPSHOT, ledger_index: 107_747_457, reserve_base: null, reserve_inc: null, version: '1761343307000' },
    ]);
    expect(await versionsRead()).toEqual([AMM_PARSER_VERSION, OBJECT_PARSER_VERSION]);
    const body = await supply();
    expect(body.ledger_index).toBe(107_747_457);
    expect(Object.keys(body)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'minted' && key !== 'reserves'));
    expect(text(body)).not.toContain('null');
  });

  it('a failed read is 500 unable to retrieve supply, whichever read fails', async () => {
    const real = h.ch.query.bind(h.ch);
    const failing = (pattern: RegExp): jest.SpyInstance =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pattern.test(sql) ? Promise.reject(new Error('clickhouse is down')) : (real as any)(sql, ...rest)) as never);
    for (const [what, pattern] of [
      ['every read', /./],
      ['the snapshot', /FROM network_supply/],
      ['a coverage', /parser_version </],
    ] as const) {
      await clearCache(api);
      const spy = failing(pattern);
      const res = await api.get(PATH);
      expect([what, res.status, res.body]).toEqual([
        what,
        500,
        { result: 'error', message: 'unable to retrieve supply' },
      ]);
      expect(res.headers['cache-control']).toBe('no-store');
      spy.mockRestore();
    }
    // no coverage was kept from a read that failed: the next request reads it again, and the answer is whole
    expect((await api.get(PATH)).status).toBe(200);
  });
});

// =====================================================================================================================
// what the read of the snapshot costs
// =====================================================================================================================

describe('GET /v2/network/supply over a table of older snapshots', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xrpl', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('reads the end of the key twice, and no more than the rows it needs and two granules of each part', async () => {
    // the snapshot it must find, among 60,000 older ones, all in one part (the newest is in its last granule)
    await seedAmongOlderSnapshots(h, [XRPL_SNAPSHOT], 60_000);
    const [{ parts, rows }] = await h.ch.query<{ parts: string; rows: string }>(
      `SELECT count() AS parts, sum(rows) AS rows FROM system.parts
        WHERE database = {db:String} AND table = {table:String} AND active`,
      { db: h.database, table: Table.NetworkSupply },
    );
    // the one row the first read needs (the newest ledger), and two granules for each part: a scan of the table is over it
    const bound = 1 + 2 * GRANULE * Number(parts);
    expect(Number(parts)).toBe(1);
    expect(Number(rows)).toBe(60_001);
    expect(Number(rows)).toBeGreaterThan(bound);

    let body: Obj | undefined;
    const reads = await readsOf(h, Table.NetworkSupply, async () => {
      body = (await api.ok(PATH, 'result')).body as Obj;
    });
    expect(body?.ledger_index).toBe(XRPL_SNAPSHOT.ledger_index);
    // the newest ledger, then every version of it by its key
    expect(reads).toHaveLength(2);
    for (const { read_rows } of reads) expect(read_rows).toBeLessThanOrEqual(bound);
    expect(reads[0].read_rows).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================================================================
// Xahau
// =====================================================================================================================

describe('GET /v2/network/supply on Xahau', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers the newest snapshot of Xahau with exact key order', async () => {
    await seedSnapshots(h, [XAHAU_SNAPSHOT]);
    // the history starts at Xahau's first ledger, which every feature of Xahau starts at
    await seedLedgers(h, [[XAHAU_FIRST_LEDGER]]);
    await clearCache(api);
    const body = (await api.ok(PATH, 'result')).body as Obj;
    const all = coverage(XAHAU_FIRST_LEDGER, true);
    expect(text(body)).toBe(text(xahauAnswer({ burned: all, minted: all, escrows: all, reserves: all })));
    expect(Object.keys(body)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'amm'));
    expect(text(body)).toBe(text(referenceExample('XAH')));
  });

  it('asks the coverage of the parts at once', async () => {
    await clearCache(api);
    const real = h.ch.query.bind(h.ch);
    const events: string[] = [];
    // each coverage read waits, so that a read begun after another ended is told from one begun with it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(h.ch, 'query').mockImplementation((async (sql: string, ...rest: any[]) => {
      if (!/parser_version </.test(sql)) return (real as any)(sql, ...rest); // eslint-disable-line @typescript-eslint/no-explicit-any
      const version = (rest[0] as { version: number }).version;
      events.push(`start ${version}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      events.push(`end ${version}`);
      return (real as any)(sql, ...rest); // eslint-disable-line @typescript-eslint/no-explicit-any
    }) as never);
    expect((await api.get(PATH)).status).toBe(200);
    // the features of the parts: fees (parser 1, the burned part), the account states (3), the escrows (7) and the mints (9)
    expect(events.slice(0, 4).sort()).toEqual(['start 1', 'start 3', 'start 7', 'start 9']);
    expect(events.slice(4).every((event) => event.startsWith('end'))).toBe(true);
    expect(events).toHaveLength(8);
  });

  it("states the coverage of each part's own feature: an older parser moves the start of the minted part only", async () => {
    // a ledger of parser 8 (before the mint tables, 9) at 500: the mints start at 501, which is past Xahau's first ledger; every
    // other feature was written by 8 or later and starts at ledger 1
    await seedLedgers(h, [[500, 8]]);
    await clearCache(api);
    const all = coverage(XAHAU_FIRST_LEDGER, true);
    const res = await api.ok(PATH, 'result');
    expect(text(res.body)).toBe(
      text(xahauAnswer({ burned: all, minted: coverage(501, false), escrows: all, reserves: all })),
    );
  });
});

// =====================================================================================================================
// the testnets
// =====================================================================================================================

describe('GET /v2/network/supply on a testnet', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('an xrpl-testnet profile answers complete false on every part', async () => {
    h = await startHarness({ network: 'xrpl-testnet', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    const api = await h.api();
    await seedSnapshots(h, [XRPL_SNAPSHOT]);
    // the network has no first ledger, and a testnet ignores the enable ledgers of the metadata (mainnet's): the amendments are
    // listed, and only an indexed EnableAmendment would count
    await seedLedgers(h, [[100], [200]]);
    await listAmendments(h, ['Escrow', 'AMM'], 200);
    const none = coverage(100, false);
    expect(text((await api.ok(PATH, 'result')).body)).toBe(
      text(xrplAnswer({ escrows: none, amm: none, reserves: none })),
    );
  });

  it('an xahau-testnet profile answers complete false on every part, burned and minted included', async () => {
    h = await startHarness({ network: 'xahau-testnet', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    const api = await h.api();
    await seedSnapshots(h, [XAHAU_SNAPSHOT]);
    await seedLedgers(h, [[100], [200]]);
    const none = coverage(100, false);
    expect(text((await api.ok(PATH, 'result')).body)).toBe(
      text(xahauAnswer({ burned: none, minted: none, escrows: none, reserves: none })),
    );
  });
});

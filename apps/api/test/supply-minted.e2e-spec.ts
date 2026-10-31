import { Table } from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import { MINTED_BODY_KEYS, MINTED_ROW_KEYS } from '../src/network/supply-object';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { examplesOf, partOf, REFERENCE } from './support/api-reference-check';
import { csvDisposition } from './support/csv';
import { markerOf, readsOf } from './support/read-rows';
import {
  BEYOND_2_53,
  genesisMint,
  importOf,
  MINTED_CLAIMS,
  MINTED_GENESIS_MINTS,
  MINTED_IMPORTS,
  MINTED_ROWS,
  MintedRowText,
  seedDailyLedgers,
  seedLedgers,
  seedMintedWorld,
  seedMoreLedgers,
  seedSnapshots,
  WorldLedger,
  XAHAU_FIRST_LEDGER,
  XAHAU_SNAPSHOT,
  XRPL_FIRST_LEDGER,
} from './support/supply-seed';

/**
 * `GET /v2/network/supply/minted` (D7, spec 5.2) on a real ClickHouse: the native currency minted per UTC day on Xahau, by source.
 * The ledgers and the mints are written by hand (`support/supply-seed.ts`: five days, mints on three of them, and Xahau's ledger 1,
 * which has no close time).
 *
 * The api keeps the coverage of a feature 60 s, so a test that changes the ledgers clears the caches first
 * (`/v2/test-cache/clear`, `cache-controllers.ts`); a spy that is to see the reads of a request is set after the clear, or a warm
 * cache would answer without a read and the spy would see none whatever the order of the route's checks.
 */

const CACHE_ROUTE = async () => (await import('./cache-controllers')).CACHE_CONTROLLERS;
const GRANULE = 8192;
const DAY = 86_400;
const PATH = '/v2/network/supply/minted';

type Obj = Record<string, unknown>;

/** `JSON.stringify` of an answer: the key order is part of what is compared. */
const text = (value: unknown): string => JSON.stringify(value);

const clearCache = async (api: ApiClient): Promise<void> => {
  await api.ok('/v2/test-cache/clear', 'result');
};

/** `{ from_ledger_index, complete }`. */
const coverage = (from: number, complete: boolean) => ({ from_ledger_index: from, complete });

/** The answer for rows: the keys in the order of spec 5.2, and no `marker` unless one is given. */
const answer = (cover: Obj, rows: MintedRowText[], marker?: string): Obj => ({
  result: 'success',
  coverage: cover,
  ...(marker !== undefined && { marker }),
  count: rows.length,
  rows,
});

/** The start of a UTC day (`YYYY-MM-DD` or the `date` of a row) in unix seconds. */
const dayStart = (date: string): number => Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 1000;

/** The marker of the page that ends with the row of `date`. */
const markerOfDay = (date: string): string => markerOf([dayStart(date)]);

const dates = (rows: MintedRowText[]): string[] => rows.map((row) => row.date.slice(0, 10));

/** The `date` of the day `n` days after 2022-01-01. */
const dayN = (n: number): string =>
  `${new Date(Date.parse('2022-01-01T00:00:00Z') + n * DAY * 1000).toISOString().slice(0, 19)}Z`;

/** The examples of the reference: the JSON blocks of the section of the route. */
function referenceSection(): string {
  return partOf(readFileSync(REFERENCE, 'utf8'), '### `GET /v2/network/supply/minted`');
}

// =====================================================================================================================
// Xahau: the days, the pages, the validation
// =====================================================================================================================

describe('GET /v2/network/supply/minted on Xahau', () => {
  let h: Harness;
  let api: ApiClient;
  const FULL = coverage(XAHAU_FIRST_LEDGER, true);

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedMintedWorld(h);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const minted = async (query = ''): Promise<Obj> => (await api.ok(`${PATH}${query}`, 'result')).body as Obj;

  it('lists the days with their sums by source and zero days', async () => {
    const res = await api.ok(PATH, 'result');
    // every day from the first to the running one is a row, the days without a mint with zeros, in the order of spec 5.2; the sums are
    // exact (the last day holds 2^53 + 1 drops, which no number holds)
    expect(text(res.body)).toBe(text(answer(FULL, MINTED_ROWS)));
    expect(Object.keys(res.body)).toEqual(MINTED_BODY_KEYS.filter((key) => key !== 'marker'));
    for (const row of res.body.rows as Obj[]) expect(Object.keys(row)).toEqual([...MINTED_ROW_KEYS]);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(BigInt(BEYOND_2_53)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('starts at the first day with a ledger when ledger 1 has no close time', async () => {
    // the premise: Xahau's ledger 1 is stored with the close time 0, 1970-01-01, and the coverage starts at it
    const [{ closed }] = await h.ch.query<{ closed: string }>(
      `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} WHERE ledger_index = 1`,
    );
    expect(Number(closed)).toBe(0);
    const body = await minted('?limit=1000');
    expect(body.coverage).toEqual(FULL);
    // not the ~19,700 zero days from 1970: the five days of the ledgers that closed, the first of them the day of ledger 2
    expect(body.count).toBe(5);
    expect(dates(body.rows as MintedRowText[])[0]).toBe('2026-10-20');
    expect(text(await minted('?limit=1000&descending=true'))).toContain('"date":"2026-10-20T00:00:00Z"');
  });

  it('keeps the first day when coverage starts at firstLedger', async () => {
    const body = await minted();
    expect(body.coverage).toEqual(coverage(XAHAU_FIRST_LEDGER, true));
    // the day the coverage starts in is covered whole (the coverage starts at the first ledger of the network): it has its mints
    expect((body.rows as MintedRowText[])[0]).toEqual({
      date: '2026-10-20T00:00:00Z',
      amount: '3.75',
      rewards: '1.75',
      import: '2',
      genesis_mint: '0',
    });
  });

  it('classifies the mints by their parents and adds every entry', async () => {
    const rows = (await minted()).rows as MintedRowText[];
    // 2026-10-20: two rewards of one claim (1.5 and 0.25), an import of 2; 2026-10-22: a GenesisMint without EmitDetails (5) and
    // one whose parent is no claim (1)
    expect(rows[0]).toMatchObject({ rewards: '1.75', import: '2', genesis_mint: '0', amount: '3.75' });
    expect(rows[2]).toMatchObject({ rewards: '0', import: '0', genesis_mint: '6', amount: '6' });
    expect(rows[4]).toMatchObject({ rewards: '3', import: '0.000007', genesis_mint: '9007199254.740993' });
  });

  it('answers a start and an end as the days that start inside them', async () => {
    const all = MINTED_ROWS;
    const cases: Array<[string, MintedRowText[]]> = [
      // a day is a row when it STARTS at or after the start and before the end of what `end` names
      ['?start=2026-10-21', all.slice(1)],
      ['?start=2026-10-21T00:00:00Z', all.slice(1)],
      ['?start=2026-10-21T00:00:01Z', all.slice(2)],
      ['?start=2026-10-21T12', all.slice(2)],
      ['?end=2026-10-22', all.slice(0, 3)],
      ['?end=2026-10-22T00:00:00Z', all.slice(0, 3)],
      ['?end=2026-10-21T23:59:59Z', all.slice(0, 2)],
      ['?start=2026-10-21&end=2026-10-23', all.slice(1, 4)],
      ['?start=2026-10-22&end=2026-10-22', all.slice(2, 3)],
      // before the first day and after the last one: the days there are
      ['?start=2020-01-01&end=2030-01-01', all],
      ['?start=2026-10-25', []],
      ['?end=2026-10-19', []],
      ['?start=2026-10-23&end=2026-10-22', []],
    ];
    for (const [query, rows] of cases) {
      const res = (await api.ok(`${PATH}${query}`, 'result')).body as Obj;
      expect([query, text(res)]).toEqual([query, text(answer(FULL, rows))]);
    }
  });

  it('marker pages, both orders, concatenate to the unpaged list', async () => {
    for (const descending of [false, true]) {
      const unpaged = (await minted(`?descending=${descending}`)).rows as MintedRowText[];
      expect(dates(unpaged)).toEqual(dates(descending ? [...MINTED_ROWS].reverse() : MINTED_ROWS));
      for (const limit of [1, 2]) {
        const pages = await api.pages<{ marker?: string; count: number; rows: MintedRowText[] }>(
          `${PATH}?descending=${descending}`,
          limit,
          'rows',
        );
        // every page is whole but the last, and the pages are the list
        expect(pages.flatMap((page) => page.rows)).toEqual(unpaged);
        expect(pages).toHaveLength(Math.ceil(unpaged.length / limit));
        pages.forEach((page, i) => {
          const last = i === pages.length - 1;
          expect([descending, limit, i, page.count]).toEqual([
            descending,
            limit,
            i,
            last ? unpaged.length - i * limit : limit,
          ]);
          // the marker is the start of the last row's day, unix seconds, and only a page with a next page has one
          expect(page.marker).toBe(last ? undefined : markerOfDay(page.rows[page.rows.length - 1].date));
        });
      }
    }
  });

  it('sends the Link header of the next page, with the marker, and none on the last page', async () => {
    const page = await api.ok(`${PATH}?limit=2&descending=true`, 'result');
    const origin = new URL(page.request.url).origin;
    expect(page.body.marker).toBe(markerOfDay('2026-10-23'));
    expect(page.headers.link).toBe(`<${origin}${PATH}?limit=2&descending=true&marker=${page.body.marker}>; rel="next"`);
    const csv = await api.get(`${PATH}?limit=2&format=csv`);
    expect(csv.headers.link).toBe(
      `<${origin}${PATH}?limit=2&format=csv&marker=${markerOfDay('2026-10-21')}>; rel="next"`,
    );
    expect((await api.ok(`${PATH}?limit=1000`, 'result')).headers.link).toBeUndefined();
  });

  it('pages from a marker that is not the start of a day as a keyset: the days after it, or before it', async () => {
    const mid = dayStart('2026-10-22') + 5 * 3600;
    const after = (await minted(`?marker=${markerOf([mid])}`)).rows as MintedRowText[];
    expect(dates(after)).toEqual(['2026-10-23', '2026-10-24']);
    const before = (await minted(`?descending=true&marker=${markerOf([mid])}`)).rows as MintedRowText[];
    expect(dates(before)).toEqual(['2026-10-22', '2026-10-21', '2026-10-20']);
    // the markers at the ends of the list
    expect((await minted(`?marker=${markerOfDay('2026-10-24')}`)).rows).toEqual([]);
    expect((await minted(`?descending=true&marker=${markerOfDay('2026-10-20')}`)).rows).toEqual([]);
    // a marker with a start and an end: the days inside both
    const both = (await minted(`?start=2026-10-21&end=2026-10-23&marker=${markerOfDay('2026-10-21')}`)).rows;
    expect(dates(both as MintedRowText[])).toEqual(['2026-10-22', '2026-10-23']);
  });

  it('answers CSV as "network minted.csv"', async () => {
    const res = await api.get(`${PATH}?format=csv&limit=3`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(csvDisposition('network minted'));
    const lines = res.text.split('\n');
    // the columns are the keys of a row, in order (a row has every key), and no coverage or marker is in the file
    expect(lines[0]).toBe(MINTED_ROW_KEYS.map((key) => `"${key}"`).join(','));
    expect(lines.slice(1)).toEqual(
      MINTED_ROWS.slice(0, 3).map((row) => MINTED_ROW_KEYS.map((key) => `"${row[key]}"`).join(',')),
    );
    // an empty page is an empty file
    const empty = await api.get(`${PATH}?format=csv&start=2030-01-01`);
    expect([empty.status, empty.text, empty.headers['content-disposition']]).toEqual([
      200,
      '',
      csvDisposition('network minted'),
    ]);
    // the example of the reference is this file
    const example = /^```csv\n([\s\S]*?)^```$/m.exec(referenceSection())?.[1];
    expect(example?.trimEnd()).toBe(res.text.trimEnd());
  });

  it('shows the answer in the reference: the first three days, with the marker of the next page', async () => {
    const served = await minted('?limit=3');
    expect(served.marker).toBe(markerOfDay('2026-10-22'));
    // the example of the reference is this answer, key order included
    expect(examplesOf(referenceSection()).filter((example) => text(example) === text(served))).toHaveLength(1);
  });

  it('reads on a request after the cache is cleared, which is what the spies below rely on', async () => {
    // a control for the spies below: with the cache cleared a valid request reads, so a spy that sees nothing means something
    await clearCache(api);
    const spy = jest.spyOn(h.ch, 'query');
    await minted();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it.each([
    ['invalid start date format', '?start=nonsense'],
    ['invalid end date format', '?end=nonsense'],
    ['invalid interval', '?interval=week'],
    ['invalid interval', '?interval=DAY'],
    ['invalid marker', '?marker=nonsense'],
    ['invalid marker', `?marker=${markerOf([1, 2])}`],
    ['invalid marker', `?marker=${markerOf(['2026-10-22'])}`],
  ])('answers 400 %s before any read: %s', async (message, query) => {
    await clearCache(api);
    const spy = jest.spyOn(h.ch, 'query');
    const res = await api.get(`${PATH}${query}`);
    expect([res.status, res.body]).toEqual([400, { result: 'error', message }]);
    expect(res.headers['cache-control']).toBe('no-store');
    // nothing is read, the coverage included: the marker is checked before it, on an empty cache
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks start, then end, then interval, then marker', async () => {
    const bad = { start: 'x', end: 'x', interval: 'week', marker: 'x' };
    const order: Array<[string[], string]> = [
      [['start', 'end', 'interval', 'marker'], 'invalid start date format'],
      [['end', 'interval', 'marker'], 'invalid end date format'],
      [['interval', 'marker'], 'invalid interval'],
      [['marker'], 'invalid marker'],
    ];
    for (const [keys, message] of order) {
      const query = keys.map((key) => `${key}=${bad[key as keyof typeof bad]}`).join('&');
      const res = await api.get(`${PATH}?${query}`);
      expect([query, res.body.message]).toEqual([query, message]);
    }
    // an empty interval is `day`, and an empty marker is none
    expect((await minted('?interval=&marker=')).count).toBe(5);
    expect((await minted('?interval=day')).count).toBe(5);
  });

  it('defaults a limit it cannot use, and ignores what it does not know', async () => {
    for (const query of ['?limit=abc', '?limit=0', '?limit=-3', '?foo=bar']) {
      expect([query, (await minted(query)).count]).toEqual([query, 5]);
    }
    expect((await minted('?limit=2.9')).count).toBe(2);
  });

  it('is registered beside GET /v2/network/supply, which still answers its own', async () => {
    await seedSnapshots(h, [XAHAU_SNAPSHOT]);
    await clearCache(api);
    const snapshot = (await api.ok('/v2/network/supply', 'result')).body as Obj;
    expect(snapshot.ledger_index).toBe(XAHAU_SNAPSHOT.ledger_index);
    expect(snapshot).not.toHaveProperty('rows');
    const days = await minted();
    expect(days.count).toBe(5);
    expect(days).not.toHaveProperty('ledger_index');
    expect((await api.get(`${PATH}/extra`)).status).toBe(404);
  });

  it('answers 401 without a key', async () => {
    const refused = await h.http().get(PATH);
    expect(refused.status).toBe(401);
    expect(refused.headers['cache-control']).toBe('no-store');
  });

  it('a failed read is 500 unable to retrieve minted supply, whichever read fails', async () => {
    const real = h.ch.query.bind(h.ch);
    const failing = (pattern: RegExp): jest.SpyInstance =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pattern.test(sql) ? Promise.reject(new Error('clickhouse is down')) : (real as any)(sql, ...rest)) as never);
    for (const [what, pattern] of [
      ['every read', /./],
      ['the coverage', /parser_version </],
      ['the first covered day', /close_time > /],
      ['the genesis mints', /FROM genesis_mints/],
      ['the imports', /FROM imports/],
    ] as const) {
      await clearCache(api);
      const spy = failing(pattern);
      const res = await api.get(PATH);
      expect([what, res.status, res.body]).toEqual([
        what,
        500,
        { result: 'error', message: 'unable to retrieve minted supply' },
      ]);
      expect(res.headers['cache-control']).toBe('no-store');
      spy.mockRestore();
    }
    // no coverage was kept from a read that failed: the next request reads it again, and the answer is whole
    expect((await api.get(PATH)).status).toBe(200);
  });
});

// =====================================================================================================================
// the day the coverage starts in
// =====================================================================================================================

describe('GET /v2/network/supply/minted when the coverage starts in the middle of a day', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  it('answers no rows and complete false when no ledger is stored', async () => {
    const res = await api.ok(PATH, 'result');
    expect(text(res.body)).toBe(text({ result: 'success', coverage: { complete: false }, count: 0, rows: [] }));
  });

  it('skips the day the coverage starts in', async () => {
    // ledgers 1 to 4 were written by parser 8, which has no mint tables: the coverage starts at ledger 5, which closed at
    // 23:59:59 on 2026-10-21, and that day has the mints of ledgers 2 to 4 missing. The first day whose every ledger is covered is
    // the next one, and the days before it are no rows, however early `start` is.
    await seedMintedWorld(h, { olderParserThrough: 4 });
    await clearCache(api);
    const from = coverage(5, false);
    for (const query of ['', '?start=2026-10-20', '?start=2000-01-01', '?start=2026-10-21']) {
      const res = (await api.ok(`${PATH}${query}`, 'result')).body as Obj;
      expect([query, text(res)]).toEqual([query, text(answer(from, MINTED_ROWS.slice(2)))]);
    }
    const descending = (await api.ok(`${PATH}?descending=true`, 'result')).body as Obj;
    expect(text(descending)).toBe(text(answer(from, [...MINTED_ROWS.slice(2)].reverse())));
    // the pages stop at the same day
    const pages = await api.pages<{ marker?: string; rows: MintedRowText[] }>(`${PATH}?descending=true`, 2, 'rows');
    expect(dates(pages.flatMap((page) => page.rows))).toEqual(['2026-10-24', '2026-10-23', '2026-10-22']);
  });
});

// =====================================================================================================================
// the running day, and a mint written twice
// =====================================================================================================================

describe('GET /v2/network/supply/minted as ledgers arrive', () => {
  let h: Harness;
  let api: ApiClient;
  const FULL = coverage(XAHAU_FIRST_LEDGER, true);

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    await seedMintedWorld(h);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  const minted = async (query = ''): Promise<Obj> => (await api.ok(`${PATH}${query}`, 'result')).body as Obj;

  it('counts a mint and an import written twice once', async () => {
    // The tables drop an identical second insert inside their dedup window, so the second copy carries a token of its own, and the
    // merges are stopped: the rows are in the tables twice, and the sums count them once.
    const tables = [Table.GenesisMints, Table.Imports, Table.RewardClaims];
    for (const table of tables) await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
    const before: Record<string, number> = {};
    for (const table of tables) {
      const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
      before[table] = Number(n);
    }
    await h.ch.insert(Table.RewardClaims, MINTED_CLAIMS, { dedupToken: 'again-claims' });
    await h.ch.insert(Table.GenesisMints, MINTED_GENESIS_MINTS, { dedupToken: 'again-mints' });
    await h.ch.insert(Table.Imports, MINTED_IMPORTS, { dedupToken: 'again-imports' });
    // the premise: every row is there twice
    for (const [table, rows] of [
      [Table.RewardClaims, MINTED_CLAIMS],
      [Table.GenesisMints, MINTED_GENESIS_MINTS],
      [Table.Imports, MINTED_IMPORTS],
    ] as const) {
      const [{ n }] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
      expect([table, Number(n)]).toEqual([table, 2 * rows.length]);
      expect(before[table]).toBe(rows.length);
    }
    expect(text(await minted())).toBe(text(answer(FULL, MINTED_ROWS)));
  });

  it('sums the running day so far', async () => {
    // a ledger of the running day closes with a mint: the day grows, and no day is added
    const more: WorldLedger[] = [{ index: 11, closed: '2026-10-24T10:30:00Z' }];
    await seedMoreLedgers(h, more);
    await h.ch.insert(Table.GenesisMints, [genesisMint(11, 0, 0, 1_000_000, '', more)]);
    const grown = (await minted()).rows as MintedRowText[];
    expect(grown).toHaveLength(5);
    // 2^53 + 1 + 1,000,000 drops of genesis mints, and 3,000,007 of the others
    expect(grown[4]).toEqual({
      date: '2026-10-24T00:00:00Z',
      amount: '9007199258.741',
      rewards: '3',
      import: '0.000007',
      genesis_mint: '9007199255.740993',
    });
    expect(grown.slice(0, 4)).toEqual(MINTED_ROWS.slice(0, 4));
    expect(dates(grown)).toEqual(dates(MINTED_ROWS));
  });

  it('adds the day of a newer ledger as a row of zeros, and the day before it stays as it was', async () => {
    const next: WorldLedger[] = [{ index: 12, closed: '2026-10-25T00:00:01Z' }];
    await seedMoreLedgers(h, next);
    const rows = (await minted()).rows as MintedRowText[];
    expect(dates(rows)).toEqual([...dates(MINTED_ROWS), '2026-10-25']);
    expect(rows[5]).toEqual({
      date: '2026-10-25T00:00:00Z',
      amount: '0',
      rewards: '0',
      import: '0',
      genesis_mint: '0',
    });
    expect(rows[4].amount).toBe('9007199258.741');
    // a mint of the new day is its sum
    await h.ch.insert(Table.Imports, [importOf(12, 0, 250_000, next)]);
    expect(((await minted()).rows as MintedRowText[])[5]).toMatchObject({ amount: '0.25', import: '0.25' });
  });
});

// =====================================================================================================================
// a history of years
// =====================================================================================================================

describe('GET /v2/network/supply/minted over a history of more than a thousand days', () => {
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();
    // 1,205 days, one ledger a day, from 2022-01-01: no mint, so every row is zeros
    await seedDailyLedgers(h, '2022-01-01', 1_205);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  const minted = async (query = ''): Promise<Obj & { rows: MintedRowText[] }> =>
    (await api.ok(`${PATH}${query}`, 'result')).body as Obj & { rows: MintedRowText[] };

  it('clamps limit to 1000 and defaults it to 200', async () => {
    const first = await minted();
    expect(first.count).toBe(200);
    expect(first.rows).toHaveLength(200);
    expect(first.marker).toBe(markerOfDay(first.rows[199].date));
    expect((await minted('?limit=1000')).count).toBe(1000);
    expect((await minted('?limit=1001')).count).toBe(1000);
    expect((await minted('?limit=100000')).count).toBe(1000);
    expect((await minted('?limit=999')).count).toBe(999);
    expect((await minted('?limit=1')).count).toBe(1);
    // the history is 1,205 days: 1,000, then the rest
    const firstThousand = await minted('?limit=5000');
    expect(firstThousand.marker).toBeDefined();
    const rest = await minted(`?limit=5000&marker=${firstThousand.marker}`);
    expect([rest.count, rest.marker]).toEqual([205, undefined]);
    expect(rest.rows[0].date).toBe(dayN(1000));
    // every day is a row, zeros: the first is the day of the first ledger with a close time, not 1970
    expect(first.rows[0]).toEqual({
      date: '2022-01-01T00:00:00Z',
      amount: '0',
      rewards: '0',
      import: '0',
      genesis_mint: '0',
    });
    expect(first.rows[1].date).toBe('2022-01-02T00:00:00Z');
  });

  it('pages the newest first from the running day', async () => {
    const newest = await minted('?descending=true&limit=3');
    expect(dates(newest.rows)).toEqual(['2025-04-19', '2025-04-18', '2025-04-17']);
    expect(newest.marker).toBe(markerOfDay('2025-04-17'));
    // the history ends where the days were seeded: 1,205 days from 2022-01-01 is up to 2025-04-19
    expect(dayN(1_204)).toBe('2025-04-19T00:00:00Z');
  });
});

// =====================================================================================================================
// the XRP Ledger
// =====================================================================================================================

describe('GET /v2/network/supply/minted on the XRP Ledger', () => {
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

  const MINT_TABLES = [Table.GenesisMints, Table.Imports, Table.RewardClaims];

  it('answers an empty list and complete false with no ledger stored', async () => {
    const res = await api.ok(PATH, 'result');
    expect(text(res.body)).toBe(text({ result: 'success', coverage: { complete: false }, count: 0, rows: [] }));
  });

  it('answers XRPL with an empty list and complete true, reading no mint table', async () => {
    await seedLedgers(h, [[XRPL_FIRST_LEDGER], [107_747_456]]);
    await clearCache(api);
    // minting is something XRPL cannot do: the coverage is complete, and there is nothing to list
    const sqls: string[] = [];
    const real = h.ch.query.bind(h.ch);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) => {
      sqls.push(sql);
      return (real as any)(sql, ...rest); // eslint-disable-line @typescript-eslint/no-explicit-any
    }) as never);
    const reads: Record<string, number> = {};
    for (const table of MINT_TABLES) {
      reads[table] = (
        await readsOf(h, table, async () => {
          await clearCache(api);
          const res = await api.ok(`${PATH}?descending=true&limit=5&start=2020-01-01`, 'result');
          expect(text(res.body)).toBe(
            text({ result: 'success', coverage: coverage(XRPL_FIRST_LEDGER, true), count: 0, rows: [] }),
          );
        })
      ).length;
    }
    // the system.query_log has no read of any of the three tables, and no query the app sent names one
    expect(reads).toEqual({ genesis_mints: 0, imports: 0, reward_claims: 0 });
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter((sql) => MINT_TABLES.some((table) => sql.includes(table)))).toEqual([]);
  });

  it('answers the checks of the route on XRPL as it does on Xahau, and CSV as an empty file', async () => {
    for (const [query, message] of [
      ['?start=x', 'invalid start date format'],
      ['?end=x', 'invalid end date format'],
      ['?interval=hour', 'invalid interval'],
      ['?marker=x', 'invalid marker'],
    ] as const) {
      const res = await api.get(`${PATH}${query}`);
      expect([query, res.status, res.body]).toEqual([query, 400, { result: 'error', message }]);
    }
    const csv = await api.get(`${PATH}?format=csv`);
    expect([csv.status, csv.text, csv.headers['content-disposition']]).toEqual([
      200,
      '',
      csvDisposition('network minted'),
    ]);
    // the example of the reference is this answer
    const empty = (await api.ok(PATH, 'result')).body as Obj;
    expect(examplesOf(referenceSection()).filter((example) => text(example) === text(empty))).toHaveLength(1);
  });
});

// =====================================================================================================================
// what the read costs
// =====================================================================================================================

describe('GET /v2/network/supply/minted over tables of many days', () => {
  let h: Harness;
  let api: ApiClient;

  // The ledgers of five days, 20,000 each from 1,000,000 (one partition of the mint tables), the first 40,001 ledgers written by the
  // parser before the mint tables. Every day has mints; the second and the fifth have a bulk of them (60,000 mints, and 20,000
  // claims and imports), the third and the fourth the few a page needs. The coverage starts at ledger 40,001, which closed on the
  // first day, so the second day is the first row.
  const LEDGERS_PER_DAY = 20_000;
  const FIRST_LEDGER = (day: number): number => 1_000_000 + day * LEDGERS_PER_DAY;
  const OLD_LEDGERS = 40_000;
  const NEEDED_MINTS = 2_000;
  const NEEDED_REWARDS = 100;
  const NEEDED_IMPORTS = 1_000;
  const BULK_MINTS = 60_000;
  const BULK_PER_LEDGER_ROWS = 20_000;
  const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];

  const noon = (day: number): number => Date.parse(`${DAYS[day]}T12:00:00Z`) / 1000;

  /** A run of rows from `base`: `rows` of them, `perLedger` to a ledger, stored with the close time `closed`. */
  interface Run {
    base: number;
    rows: number;
    perLedger: number;
    closed: number;
    /** The first `named` rows have a name of their own: a reward's parent and the claim it points to. */
    named: number;
  }

  /**
   * One INSERT of the runs `table` is given, as one SELECT for each of them: they are one block, so one part, in which the rows a page
   * needs lie between the bulks (merging separate inserts would cut the granules wherever the inserts ended, and the bound is
   * of whole granules). The statement is built from the select of each run, `select(i)` naming its parameters with the number `i`.
   */
  async function insertRuns(table: Table, columns: string, runs: Run[], select: (i: number) => string): Promise<void> {
    const params: Record<string, unknown> = {};
    runs.forEach((run, i) => {
      for (const [name, value] of Object.entries(run)) params[`${name}${i}`] = value;
    });
    const selects = runs.map((_, i) => select(i));
    await h.ch.command(`INSERT INTO ${table} (${columns}) ${selects.join(' UNION ALL ')}`, params);
  }

  /** The genesis mints: the first `named` of a run have the claim `CL<base>-<n>` as parent, the others none. */
  const insertMints = (runs: Run[]): Promise<void> =>
    insertRuns(
      Table.GenesisMints,
      'ledger_index, tx_index, mint_index, tx_hash, close_time, destination, amount, parent_tx_hash, emit_hook_hash',
      runs,
      (i) =>
        `SELECT toUInt32({base${i}:UInt32} + intDiv(n.number, {perLedger${i}:UInt32})), toUInt32(n.number % {perLedger${i}:UInt32}),
                toUInt16(0), concat('bulk-', toString({base${i}:UInt32}), '-', toString(n.number)),
                toDateTime({closed${i}:UInt32}, 'UTC'), 'rSyntheticBulk', toUInt64(10),
                if(n.number < {named${i}:UInt32}, concat('CL', toString({base${i}:UInt32}), '-', toString(n.number)), ''), ''
           FROM numbers({rows${i}:UInt32}) AS n`,
    );

  /** The imports, 10 drops each (one to a ledger: `perLedger` is 1). */
  const insertImports = (runs: Run[]): Promise<void> =>
    insertRuns(
      Table.Imports,
      'ledger_index, tx_index, tx_hash, close_time, account, minted, account_created',
      runs,
      (i) =>
        `SELECT toUInt32({base${i}:UInt32} + n.number), toUInt32(0),
                concat('bulk-', toString({base${i}:UInt32}), '-', toString(n.number)),
                toDateTime({closed${i}:UInt32}, 'UTC'), 'rSyntheticBulk', toUInt64(10), toUInt8(0)
           FROM numbers({rows${i}:UInt32}) AS n`,
    );

  /** The claims, one to a ledger: the first `named` have the hashes `CL<base>-<n>` that the rewards point to, the others `bulk-…`. */
  const insertClaims = (runs: Run[]): Promise<void> =>
    insertRuns(
      Table.RewardClaims,
      'ledger_index, tx_index, tx_hash, close_time, account, issuer, opt_out',
      runs,
      (i) =>
        `SELECT toUInt32({base${i}:UInt32} + n.number), toUInt32(0),
                if(n.number < {named${i}:UInt32}, concat('CL', toString({base${i}:UInt32}), '-', toString(n.number)),
                   concat('bulk-', toString({base${i}:UInt32}), '-', toString(n.number))),
                toDateTime({closed${i}:UInt32}, 'UTC'), 'rSyntheticBulk', '', toUInt8(0)
           FROM numbers({rows${i}:UInt32}) AS n`,
    );

  const countOf = async (sql: string, params: Record<string, unknown> = {}): Promise<number> =>
    Number((await h.ch.queryOne<{ n: string }>(sql, params))?.n);

  const rowsBetween = (table: Table, from: number, to: number): Promise<number> =>
    countOf(`SELECT count() AS n FROM ${table} WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`, { from, to });

  /** The active parts of a table whose ledgers overlap `[from, to]`: the only parts a read of the range opens. */
  const partsOf = (table: Table, from: number, to: number): Promise<number> =>
    countOf(
      `SELECT count() AS n FROM (SELECT _part FROM ${table} GROUP BY _part
                                 HAVING min(ledger_index) <= {to:UInt32} AND max(ledger_index) >= {from:UInt32})`,
      { from, to },
    );

  /** What a read of `[from, to]` of a table may read: its rows there and two granules for each part (the ends of a range are whole granules). */
  const rowsAndGranules = async (table: Table, from: number, to: number): Promise<number> =>
    (await rowsBetween(table, from, to)) + 2 * GRANULE * (await partsOf(table, from, to));

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT, controllers: CACHE_ROUTE });
    api = await h.api();

    // the ledgers: ledger 1 with no close time, 40,000 more of the older parser (through 2026-10-19), ledger 40,001 on the first day,
    // and the first and the last ledger of each day
    const { ledgerRow } = await import('./support/validators-seed');
    const { PARSER_VERSION } = await import('@gatehub/data-api-shared');
    const old = Date.parse('2026-10-19T00:00:00Z') / 1000;
    await h.ch.insert(Table.Ledgers, [{ ...ledgerRow(1, 0), parser_version: 8 }]);
    await h.ch.command(
      `INSERT INTO ${Table.Ledgers}
       SELECT tpl.* REPLACE (toUInt32(n.number + 2) AS ledger_index, toDateTime({old:UInt32} + n.number, 'UTC') AS close_time,
                             toUInt16(8) AS parser_version)
         FROM (SELECT * FROM ${Table.Ledgers} WHERE ledger_index = 1 LIMIT 1) AS tpl
        CROSS JOIN numbers({count:UInt32}) AS n`,
      { old, count: OLD_LEDGERS - 1 },
    );
    const edge = (index: number, iso: string) => ({
      ...ledgerRow(index, Date.parse(iso) / 1000),
      parser_version: PARSER_VERSION,
    });
    await h.ch.insert(Table.Ledgers, [
      edge(OLD_LEDGERS + 1, `${DAYS[0]}T00:00:03Z`),
      ...DAYS.flatMap((day, i) => [
        edge(FIRST_LEDGER(i), `${day}T00:00:05Z`),
        edge(FIRST_LEDGER(i) + LEDGERS_PER_DAY - 1, `${day}T23:59:55Z`),
      ]),
    ]);

    // the mints, one insert for each table: the bulks of the second and the fifth day, and the few a page needs between them
    const run = (day: number, rows: number, perLedger: number, named = 0): Run => ({
      base: FIRST_LEDGER(day),
      rows,
      perLedger,
      closed: noon(day),
      named,
    });
    await insertMints([
      run(1, BULK_MINTS, 3),
      run(2, NEEDED_MINTS, 1, NEEDED_REWARDS),
      run(3, NEEDED_MINTS, 1, NEEDED_REWARDS),
      run(4, BULK_MINTS, 3),
    ]);
    await insertImports([
      run(1, BULK_PER_LEDGER_ROWS, 1),
      run(2, NEEDED_IMPORTS, 1),
      run(3, NEEDED_IMPORTS, 1),
      run(4, BULK_PER_LEDGER_ROWS, 1),
    ]);
    await insertClaims([
      run(1, BULK_PER_LEDGER_ROWS, 1),
      run(2, NEEDED_REWARDS, 1, NEEDED_REWARDS),
      run(3, NEEDED_REWARDS, 1, NEEDED_REWARDS),
      run(4, BULK_PER_LEDGER_ROWS, 1),
    ]);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
  });

  /**
   * The answer of a request, and the rows the SELECTs of the app read on the genesis mints and on the imports while it was served
   * (`system.query_log`; the query on the genesis mints reads the claims too, in a subquery, and counts them). The request is made
   * twice, once for each table, on an empty cache.
   */
  async function readsFor(query: string): Promise<{ body: Obj; genesis: number[]; imports: number[] }> {
    let body: Obj = {};
    const request = async (): Promise<void> => {
      await clearCache(api);
      body = (await api.ok(`${PATH}${query}`, 'result')).body as Obj;
    };
    const genesis = (await readsOf(h, Table.GenesisMints, request)).map((read) => read.read_rows);
    const imports = (await readsOf(h, Table.Imports, request)).map((read) => read.read_rows);
    return { body, genesis, imports };
  }

  it('has the premise: one part for each table, and bulks that are more than any bound below', async () => {
    for (const table of [Table.GenesisMints, Table.Imports, Table.RewardClaims]) {
      expect([table, await partsOf(table, 0, 4_294_967_295)]).toEqual([table, 1]);
    }
    const neededMints = 2 * NEEDED_MINTS;
    expect(await countOf(`SELECT count() AS n FROM ${Table.GenesisMints}`)).toBe(2 * BULK_MINTS + neededMints);
    expect(neededMints + 2 * GRANULE).toBeLessThan(2 * BULK_MINTS);
  });

  it("reads the P6 key ranges of the page's ledgers only", async () => {
    // the page: `limit=1` of the days 2026-10-22 and 2026-10-23, and the extra day that tells there is a next page; the ledgers of the
    // two days are one range, 1,040,000 to 1,079,999, between the bulks of the second and the fifth day, in the same part
    const from = FIRST_LEDGER(2);
    const to = FIRST_LEDGER(3) + LEDGERS_PER_DAY - 1;
    const claimsFrom = from - 256;
    const genesisBound =
      (await rowsAndGranules(Table.GenesisMints, from, to)) +
      (await rowsAndGranules(Table.RewardClaims, claimsFrom, to));
    const importBound = await rowsAndGranules(Table.Imports, from, to);
    // the premise: what the read needs is a part of what the tables hold, and the bulks are more than the bounds
    expect(await rowsBetween(Table.GenesisMints, from, to)).toBe(2 * NEEDED_MINTS);
    expect(await rowsBetween(Table.RewardClaims, claimsFrom, to)).toBe(256 + 2 * NEEDED_REWARDS);
    expect(genesisBound).toBeLessThan(BULK_MINTS);
    expect(importBound).toBeLessThan(BULK_PER_LEDGER_ROWS * 2);

    const { body, genesis, imports } = await readsFor('?start=2026-10-22&end=2026-10-23&limit=1');
    // the answer is the rows': the first day of the page, 100 rewards and 1,900 genesis mints of 10 drops, and 1,000 imports
    expect(body.rows).toEqual([
      { date: '2026-10-22T00:00:00Z', amount: '0.03', rewards: '0.001', import: '0.01', genesis_mint: '0.019' },
    ]);
    expect(body.marker).toBe(markerOfDay('2026-10-22'));
    // one read of the mints and one of the imports for the one slice
    expect(genesis).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(genesis[0]).toBeLessThanOrEqual(genesisBound);
    expect(imports[0]).toBeLessThanOrEqual(importBound);
  });

  it('resolves a descending page from its oldest day to its newest day, and reads those ledgers only', async () => {
    // the days 2026-10-21 to 2026-10-23, newest first, one to a page: the page is 2026-10-23, and 2026-10-22 is the day that tells there
    // is a next page. The ledgers are those two days', from the oldest to the end of the newest; the bulks of 2026-10-21 and of
    // 2026-10-24, on either side in the same part, are skipped.
    const from = FIRST_LEDGER(2);
    const to = FIRST_LEDGER(3) + LEDGERS_PER_DAY - 1;
    const genesisBound =
      (await rowsAndGranules(Table.GenesisMints, from, to)) +
      (await rowsAndGranules(Table.RewardClaims, from - 256, to));
    const importBound = await rowsAndGranules(Table.Imports, from, to);
    const { body, genesis, imports } = await readsFor('?start=2026-10-21&end=2026-10-23&descending=true&limit=1');
    expect(body.rows).toEqual([
      { date: '2026-10-23T00:00:00Z', amount: '0.03', rewards: '0.001', import: '0.01', genesis_mint: '0.019' },
    ]);
    expect(body.marker).toBe(markerOfDay('2026-10-23'));
    expect(genesis).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(genesis[0]).toBeLessThanOrEqual(genesisBound);
    expect(imports[0]).toBeLessThanOrEqual(importBound);
  });

  it('starts the days at the first ledger after the coverage with a keyed read', async () => {
    // the coverage starts at ledger 40,001 (the 40,000 ledgers before it were written by the older parser), on 2026-10-20: the first
    // row is the day after it
    const body = (await api.ok(`${PATH}?limit=1`, 'result')).body as Obj;
    expect(body.coverage).toEqual(coverage(OLD_LEDGERS + 1, false));
    expect((body.rows as MintedRowText[]).map((row) => row.date)).toEqual(['2026-10-21T00:00:00Z']);
    // the read of that ledger is by the key, from the ledger: a scan of the 40,011 ledgers is over two granules
    await clearCache(api);
    const reads = (
      await readsOf(h, Table.Ledgers, async () => {
        await api.ok(`${PATH}?limit=1`, 'result');
      })
    ).filter((read) => read.query.includes('ledger_index >= '));
    expect(reads).toHaveLength(1);
    const total = await countOf(`SELECT count() AS n FROM ${Table.Ledgers}`);
    const bound = 2 + 2 * GRANULE * (await partsOf(Table.Ledgers, OLD_LEDGERS + 1, 4_294_967_295));
    expect(total).toBeGreaterThan(bound);
    expect(reads[0].read_rows).toBeLessThanOrEqual(bound);
  });
});

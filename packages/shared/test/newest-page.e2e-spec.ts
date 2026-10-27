import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AccountNftsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { NewestPage, readNewestPage } from '../src/query/newest-page';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * `readNewestPage` on a real ClickHouse, over `account_nfts` (key `owner, issuer, taxon_key, serial, nft_id`, one row per account
 * an NFT ever had as owner, `held` 1 for the current one): the newest version of each key, the condition applied after it, the page in
 * key order both ways, more room when old versions fill the read, and the rows a page of a long list reads.
 *
 * The versions of a key are separate inserts (separate parts, as the aggregator writes them): rows of one insert with the same key are
 * collapsed on insert, and merges are stopped, so the versions a reader has to choose between stay.
 */

const OWNER = 'rSyntheticHolder';
const ISSUER = 'rSyntheticCollectionIssuer';
const KEY = ['owner', 'issuer', 'taxon_key', 'serial', 'nft_id'];
const COLUMNS = 'owner, issuer, taxon_key, serial, nft_id, held';
const GRANULE = 8192;

/** The NFT with this serial: its id is the serial in 64 upper-case hex digits. */
const idOf = (serial: number): string => serial.toString(16).toUpperCase().padStart(64, '0');

/** A row of the holdings of `OWNER`: the NFT with this serial, `held` or not, as written under `version`. */
const row = (serial: number, held: number, version: number, owner = OWNER): AccountNftsRow => ({
  owner,
  issuer: ISSUER,
  taxon_key: 7,
  serial,
  nft_id: idOf(serial),
  held,
  version,
});

interface Page {
  serial: number;
  nft_id: string;
  held: number | string;
}

describe('readNewestPage (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database of its own, with the merges of `account_nfts` stopped. */
  async function freshDb(): Promise<{ ch: ClickHouseService; database: string }> {
    const database = `newest_page_${++dbCounter}`;
    const config = { ...container.config, database };
    await runMigrations({ config, log: () => undefined });
    const ch = new ClickHouseService(config);
    services.push(ch);
    await ch.command(`SYSTEM STOP MERGES ${database}.${Table.AccountNfts}`);
    return { ch, database };
  }

  /** Inserts each group as a part of its own. */
  async function insertParts(ch: ClickHouseService, ...parts: AccountNftsRow[][]): Promise<void> {
    for (const rows of parts) await ch.insert(Table.AccountNfts, rows);
  }

  /** The page of the holdings of `OWNER`: the keys after `after` (a serial), as the API pages a list. */
  function pageOf(over: Partial<NewestPage> & { after?: number } = {}): NewestPage {
    const { after, ...rest } = over;
    const descending = rest.descending ?? false;
    return {
      columns: COLUMNS,
      table: Table.AccountNfts,
      // the prefix of the key (owner, issuer, taxon_key) is fixed, so the bound on the serial after it narrows the read
      where: [
        'owner = {owner:String}',
        'issuer = {issuer:String}',
        'taxon_key = 7',
        ...(after === undefined ? [] : [`serial ${descending ? '<' : '>'} {after:UInt32}`]),
      ],
      key: KEY,
      keep: 'held = 1',
      descending,
      params: { owner: OWNER, issuer: ISSUER, ...(after === undefined ? {} : { after }) },
      limit: 5,
      ...rest,
    };
  }

  const serialsOf = (rows: Page[]): number[] => rows.map((r) => Number(r.serial));

  it('keeps the newest version of each key and filters after it', async () => {
    const { ch } = await freshDb();
    // 1..6 are held at version 1; 2 and 4 are given up at version 2 (the older rows still say held); 3 is given up and taken again;
    // 7 is held for the first time at version 3
    await insertParts(
      ch,
      [1, 2, 3, 4, 5, 6].map((s) => row(s, 1, 1)),
      [row(2, 0, 2), row(4, 0, 2), row(3, 0, 2)],
      [row(3, 1, 3), row(7, 1, 3)],
    );

    const held = await readNewestPage<Page>(ch, pageOf({ limit: 50 }));
    expect(serialsOf(held)).toEqual([1, 3, 5, 6, 7]);
    // the version of the row is the newest of its key
    expect(held.map((r) => Number(r.held))).toEqual([1, 1, 1, 1, 1]);

    // without a condition every key is served, as its newest version: the keys that are given up say so
    const all = await readNewestPage<Page & { version: string }>(ch, pageOf({ limit: 50, keep: '' }));
    expect(all.map((r) => [Number(r.serial), Number(r.held), Number(r.version)])).toEqual([
      [1, 1, 1],
      [2, 0, 2],
      [3, 1, 3],
      [4, 0, 2],
      [5, 1, 1],
      [6, 1, 1],
      [7, 1, 3],
    ]);

    // the opposite condition serves the keys whose newest version is given up, and not the older versions of those held
    expect(serialsOf(await readNewestPage<Page>(ch, pageOf({ limit: 50, keep: 'held = 0' })))).toEqual([2, 4]);
  });

  it('pages in key order both ways', async () => {
    const { ch } = await freshDb();
    // 40 NFTs, every fifth one given up since: 32 are held, written in four inserts so that they lie in four parts
    const rows = Array.from({ length: 40 }, (_, i) => i + 1);
    await insertParts(
      ch,
      ...[0, 1, 2, 3].map((p) => rows.filter((s) => s % 4 === p).map((s) => row(s, 1, 1))),
      rows.filter((s) => s % 5 === 0).map((s) => row(s, 0, 2)),
    );
    const held = rows.filter((s) => s % 5 !== 0);
    expect(held).toHaveLength(32);

    for (const descending of [false, true]) {
      const walked: number[] = [];
      let after: number | undefined;
      let pages = 0;
      for (;;) {
        const page = await readNewestPage<Page>(ch, pageOf({ descending, after, limit: 7 + 1 }));
        // a page of 7 is read with one more, which tells that there is a next page
        const serials = serialsOf(page).slice(0, 7);
        walked.push(...serials);
        pages += 1;
        if (page.length <= 7) break;
        after = serials[serials.length - 1];
      }
      expect([descending, walked]).toEqual([descending, descending ? [...held].reverse() : held]);
      expect(pages).toBe(5);
    }
  });

  it('reads again with more room when old versions fill the cap', async () => {
    const { ch } = await freshDb();
    // the first two NFTs have 120 versions each (a holding that goes back and forth), the next ten one: a page of 5 is read with
    // room for 21 rows, which the 120 versions of the first NFT fill; it has to be read again with more room, twice
    const versions = (serial: number): AccountNftsRow[][] =>
      Array.from({ length: 120 }, (_, v) => [row(serial, v === 119 ? 1 : v % 2, v + 1)]);
    await insertParts(
      ch,
      ...versions(1),
      ...versions(2),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => row(s, 1, 1)),
    );
    const calls = jest.spyOn(ch, 'query');

    const page = await readNewestPage<Page>(ch, pageOf({ limit: 5 }));

    expect(serialsOf(page)).toEqual([1, 2, 3, 4, 5]);
    // 5 + 21 rows, then 5 + 69, then 5 + 261: the third read is the first that gets past the 240 versions
    const caps = calls.mock.calls.map(([, params]) => (params as { newest_page_cap: number }).newest_page_cap);
    expect(caps).toEqual([5 + 16, 5 + 64, 5 + 256]);
    calls.mockRestore();

    // the same walked backwards, and filtering what is given up by the newest version: NFT 1 is given up at its newest
    await insertParts(ch, [row(1, 0, 500)]);
    const down = await readNewestPage<Page>(ch, pageOf({ limit: 5, descending: true }));
    expect(serialsOf(down)).toEqual([12, 11, 10, 9, 8]);
    const up = await readNewestPage<Page>(ch, pageOf({ limit: 5 }));
    expect(serialsOf(up)).toEqual([2, 3, 4, 5, 6]);
  });

  it('reads again when every row of the read fails the condition: an empty page of a range that goes on is not the end of it', async () => {
    const { ch } = await freshDb();
    // 300 NFTs given up, then three that are held: the first read (21 rows) holds only given-up keys. Their rows are the newest
    // versions, so the page is empty, and the count of the rows read has to come back with it to say that the range goes on
    await insertParts(
      ch,
      Array.from({ length: 300 }, (_, i) => row(i + 1, 1, 1)),
      Array.from({ length: 300 }, (_, i) => row(i + 1, 0, 2)),
      [row(301, 1, 3), row(302, 1, 3), row(303, 1, 3)],
    );
    const calls = jest.spyOn(ch, 'query');

    const page = await readNewestPage<Page>(ch, pageOf({ limit: 5 }));

    expect(serialsOf(page)).toEqual([301, 302, 303]);
    // 21 rows (ten keys), 69, 261, then 1,029, which reaches the end of the 603 rows
    const caps = calls.mock.calls.map(([, params]) => (params as { newest_page_cap: number }).newest_page_cap);
    expect(caps).toEqual([5 + 16, 5 + 64, 5 + 256, 5 + 1024]);
    calls.mockRestore();

    // and a range that ends with nothing held is one read, and an empty page
    const empty = await freshDb();
    await insertParts(empty.ch, [row(1, 1, 1), row(2, 1, 1)], [row(1, 0, 2), row(2, 0, 2)]);
    const once = jest.spyOn(empty.ch, 'query');
    expect(await readNewestPage<Page>(empty.ch, pageOf({ limit: 5 }))).toEqual([]);
    expect(once).toHaveBeenCalledTimes(1);
    once.mockRestore();
    // another owner's rows are not this owner's
    await insertParts(empty.ch, [row(9, 1, 1, 'rSomebodyElse')]);
    expect(await readNewestPage<Page>(empty.ch, pageOf({ limit: 5 }))).toEqual([]);
  });

  it('does not serve a key whose versions the cap cut: its newest version may be among those left out', async () => {
    const { ch } = await freshDb();
    // four keys with one version, a key with 30 versions the newest of which is given up (the 29 others say it is held), and seven
    // more keys with one. The newest version is in the first part written and the others in later ones, which ClickHouse reads
    // first among the rows of one key (a clock that steps back writes a newer version into an older part): the read of a page of 5
    // has room for 21 rows, the four and 17 of the versions of the fifth key, and the newest is not among them. Served as the
    // newest it has in the read, the fifth key would be a holding that is gone
    await insertParts(
      ch,
      [1, 2, 3, 4].map((s) => row(s, 1, 1)),
      [row(5, 0, 30)],
      ...Array.from({ length: 29 }, (_, v) => [row(5, 1, v + 1)]),
      [6, 7, 8, 9, 10, 11, 12].map((s) => row(s, 1, 1)),
    );
    const calls = jest.spyOn(ch, 'query');

    const page = await readNewestPage<Page>(ch, pageOf({ limit: 5 }));

    expect(serialsOf(page)).toEqual([1, 2, 3, 4, 6]);
    const caps = calls.mock.calls.map(([, params]) => (params as { newest_page_cap: number }).newest_page_cap);
    expect(caps).toEqual([5 + 16, 5 + 64]);
    calls.mockRestore();
    // the same backwards: the read from the other end cuts the key 5 as well, at the other end of its versions
    const down = await readNewestPage<Page>(ch, pageOf({ limit: 8, descending: true }));
    expect(serialsOf(down)).toEqual([12, 11, 10, 9, 8, 7, 6, 4]);
  });

  describe('a 200-row page of 120,000 keys of one owner (read_rows over a bulk of five parts)', () => {
    // 120,000 keys of one owner in four parts of 30,000 each, the parts' keys interleaved (as the NFTs of a collection were written
    // over time); every fourth key given up in a fifth part, so the owner's range is 150,000 rows. Two other owners, one that
    // sorts before it and one after it, have 240,000 keys each in the same parts: the table is 780,000 rows, and a read that did
    // not use the key would read them all.
    const PARTS = 4;
    const PER_PART = 30_000;
    const OTHER_PER_PART = 60_000;
    const KEYS = PARTS * PER_PART;
    const BEFORE = 'rBeforeTheHolder';
    const AFTER = 'rZAfterTheHolder';
    const OWNER_ROWS = KEYS + PER_PART;
    const TABLE_ROWS = PARTS * (PER_PART + 2 * OTHER_PER_PART) + PER_PART;
    /**
     * Two granules of each of the five parts of the owner (the one the read starts in and the next), and one more: the measured
     * read is 81,920 rows. It is less than the 150,000 rows of the owner's range, and than what a read that went on to the end
     * of the range would read from a marker 10,000 keys in (about 137,000), so only the pages that leave more than this to
     * read can tell a read that stops after the cap from one that does not.
     */
    const READ_BOUND = (PARTS + 1) * 2 * GRANULE + GRANULE;

    let db: { ch: ClickHouseService; database: string };

    beforeAll(async () => {
      db = await freshDb();
      const { ch } = db;
      /** `per` keys of `owner` as `version`, the serials `number * step + offset + 1`: one part. */
      const bulk = (
        owner: string,
        per: number,
        step: number,
        offset: number,
        held: number,
        version: number,
      ): Promise<void> =>
        ch.command(
          `INSERT INTO ${Table.AccountNfts}
           SELECT {owner:String}, {issuer:String}, 7, toUInt32(number * {step:UInt32} + {offset:UInt32} + 1),
                  lpad(hex(toUInt32(number * {step:UInt32} + {offset:UInt32} + 1)), 64, '0'), {held:UInt8}, {version:UInt64}
             FROM numbers({per:UInt32})`,
          { owner, issuer: ISSUER, step, offset, held, version, per },
          { settings: { insert_deduplicate: 0 } },
        );
      for (let part = 0; part < PARTS; part++) {
        await bulk(BEFORE, OTHER_PER_PART, PARTS, part, 1, 1);
        await bulk(OWNER, PER_PART, PARTS, part, 1, 1);
        await bulk(AFTER, OTHER_PER_PART, PARTS, part, 1, 1);
      }
      // the fourth key of every four given up: the keys 4, 8, ... at a newer version
      await bulk(OWNER, PER_PART, PARTS, PARTS - 1, 0, 2);
    }, 300_000);

    /** The rows the SELECTs of `run` on `account_nfts` read. */
    async function readsOf(run: () => Promise<unknown>): Promise<number[]> {
      const { ch, database } = db;
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const reads = await ch.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log
          WHERE current_database = {database:String} AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})`,
        { database, t, table: `${database}.${Table.AccountNfts}` },
      );
      return reads.map((r) => Number(r.read_rows));
    }

    /** The 201 held serials after `after` in the direction of the read (the 200 of the page and the one that says there is more). */
    function expectedPage(after: number | undefined, descending: boolean): number[] {
      const serials: number[] = [];
      for (
        let serial = descending ? (after ?? KEYS + 1) - 1 : (after ?? 0) + 1;
        serials.length < 201 && serial >= 1 && serial <= KEYS;
        serial += descending ? -1 : 1
      ) {
        // (every fourth key is given up)
        if (serial % 4 !== 0) serials.push(serial);
      }
      return serials;
    }

    /** The rows of the owner's range after the marker, in the direction of the read: what a read to the end of it would read. */
    const restOf = (after: number | undefined, descending: boolean): number =>
      Math.round(((descending ? (after ?? KEYS + 1) - 1 : KEYS - (after ?? 0)) * OWNER_ROWS) / KEYS);

    const pages = [
      ['the first page', undefined, false],
      ['a page deep in the range', 10_000, false],
      ['a page in the middle of the range', 54_321, false],
      ['a page near the end', 119_000, false],
      ['the first page backwards', undefined, true],
      ['a page deep in the range backwards', 110_000, true],
      ['a page in the middle of the range backwards', 54_321, true],
    ] as const;

    it('the seed is as assumed, and the bound is below what a read to the end of the range would read from the deep pages', async () => {
      const [{ n, parts }] = await db.ch.query<{ n: string; parts: string }>(
        `SELECT count() AS n, uniqExact(_part) AS parts FROM ${Table.AccountNfts}`,
      );
      // a part for each owner of each of the four ranges, and the one of the given-up keys
      expect([Number(n), Number(parts)]).toEqual([TABLE_ROWS, PARTS * 3 + 1]);
      expect(READ_BOUND).toBeLessThan(OWNER_ROWS);
      expect(READ_BOUND).toBeLessThan(TABLE_ROWS / 5);
      for (const [name, after, descending] of pages.filter(([name]) => !/middle|end/.test(name))) {
        expect([name, restOf(after, descending) > READ_BOUND]).toEqual([name, true]);
      }
    });

    it.each(pages)('%s reads about a granule of each part, and is whole', async (name, after, descending) => {
      let page: Page[] = [];
      const reads = await readsOf(async () => {
        page = await readNewestPage<Page>(db.ch, pageOf({ limit: 201, after, descending }));
      });
      expect([name, serialsOf(page)]).toEqual([name, expectedPage(after, descending)]);
      expect([name, reads.length]).toEqual([name, 1]);
      expect([name, reads[0] <= READ_BOUND ? 'bounded' : reads[0]]).toEqual([name, 'bounded']);
    });
  });
});

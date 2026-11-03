import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { GenesisMintsRow, ImportsRow, NetworkSupplyRow, RewardClaimsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { mintSums, MintSums, newestSnapshot, SUPPLY_PARENT_LEDGERS } from '../src/query/supply';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The shared reads of the supply on a real ClickHouse: `mintSums` (the minted drops by source, in total and by day) and
 * `newestSnapshot`.
 *
 * Part 1 seeds the three mint tables by hand and pins the sums, the classification of a mint as a reward, a genesis mint or an
 * import, and that a row written twice counts once. Part 2 pins what the mint reads cost, over a bulk of rows they must skip.
 * Part 3 is the newest snapshot, in the order of its columns and in what it reads.
 */

const GRANULE = 8192;
const MILLION = 1_000_000;

const unix = (iso: string): number => Date.parse(iso) / 1000;
const D1 = '2026-10-01';
const D2 = '2026-10-02';
const D3 = '2026-10-03';

const mint = (
  ledger_index: number,
  amount: number | string,
  parent_tx_hash: string,
  closed: string,
  position: { tx_index?: number; mint_index?: number } = {},
): GenesisMintsRow => ({
  ledger_index,
  tx_index: position.tx_index ?? 0,
  mint_index: position.mint_index ?? 0,
  tx_hash: `mint-${ledger_index}-${position.tx_index ?? 0}`,
  close_time: unix(closed),
  destination: 'rSyntheticDestination',
  amount,
  parent_tx_hash,
  emit_hook_hash: parent_tx_hash === '' ? '' : 'AAAA',
});

const claim = (ledger_index: number, tx_hash: string, over: Partial<RewardClaimsRow> = {}): RewardClaimsRow => ({
  ledger_index,
  tx_index: 0,
  tx_hash,
  close_time: unix(`${D1}T00:00:00Z`),
  account: 'rSyntheticClaimer',
  issuer: '',
  opt_out: 0,
  ...over,
});

const imported = (ledger_index: number, minted: number | string, closed: string, tx_index = 0): ImportsRow => ({
  ledger_index,
  tx_index,
  tx_hash: `import-${ledger_index}-${tx_index}`,
  close_time: unix(closed),
  account: 'rSyntheticImporter',
  minted,
  account_created: 0,
});

const sums = (rewards: number, imports: number, genesis_mint: number): MintSums => ({
  rewards: BigInt(rewards),
  import: BigInt(imports),
  genesis_mint: BigInt(genesis_mint),
});

describe('the supply reads (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `supply_reads_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const stopMerges = async (ch: ClickHouseService, ...tables: Table[]): Promise<void> => {
    for (const table of tables) await ch.command(`SYSTEM STOP MERGES ${table}`);
  };

  /**
   * The same rows in the table twice. Merges must be stopped (the caller does), and the two inserts carry tokens of their own: the
   * tables drop an identical insert inside their dedup window, and `insert_deduplicate: 0` does not stop that on `imports` and
   * `genesis_mints` (ClickHouse 26.8: the second copy is dropped; only the token tells the server the inserts are two).
   */
  const insertTwice = async <T>(ch: ClickHouseService, table: Table, rows: T[]): Promise<void> => {
    await ch.insert(table, rows, { dedupToken: 'copy-1' });
    await ch.insert(table, rows, { dedupToken: 'copy-2' });
  };

  const countOf = async (ch: ClickHouseService, sql: string, params: Record<string, unknown> = {}): Promise<number> =>
    Number((await ch.queryOne<{ n: string }>(sql, params))?.n);

  // -------------------------------------------------------------------------------------------------------------------
  describe('the sums', () => {
    it('sums the mints by source over a range and per day', async () => {
      const ch = await fresh();
      await ch.insert(Table.RewardClaims, [
        claim(1_000_100, 'claim-1'),
        claim(1_000_200, 'claim-2', { opt_out: 1 }),
        claim(2_000_000, 'claim-3'),
      ]);
      await ch.insert(Table.GenesisMints, [
        mint(1_000_105, 100, 'claim-1', `${D1}T23:59:59Z`),
        mint(1_000_105, 11, 'claim-1', `${D1}T23:59:59Z`, { mint_index: 1 }), // a second entry of the same transaction
        mint(1_000_205, 200, 'claim-2', `${D2}T00:00:00Z`),
        mint(1_000_300, 7, '', `${D2}T00:00:01Z`),
        mint(1_000_301, 5, 'a-transaction-that-is-not-a-claim', `${D2}T23:59:59Z`),
        mint(999_990, 3, '', `${D1}T12:00:00Z`), // the partition before, the same day as the first
        mint(2_000_001, 40, 'claim-3', `${D3}T00:00:05Z`), // the partition after
        mint(3_000_005, 1_000_000, '', `${D3}T00:00:09Z`), // past the range
      ]);
      await ch.insert(Table.Imports, [
        imported(1_000_400, 1000, `${D1}T10:00:00Z`),
        imported(1_000_401, 20, `${D2}T10:00:00Z`, 1),
        imported(999_995, 9, `${D1}T11:00:00Z`),
        imported(3_000_001, 1_000_000, `${D3}T00:00:08Z`), // past the range
      ]);

      // in total: three partitions, so three slices, whose figures add up
      expect(await mintSums(ch, 999_990, 2_000_001, false)).toEqual(sums(351, 1029, 15));

      // by day (UTC), in ascending order: a day that two slices have mints for adds them up
      const byDay = await mintSums(ch, 999_990, 2_000_001, true);
      expect([...byDay.keys()]).toEqual([D1, D2, D3]);
      expect(byDay.get(D1)).toEqual(sums(111, 1009, 3));
      expect(byDay.get(D2)).toEqual(sums(200, 20, 12));
      expect(byDay.get(D3)).toEqual(sums(40, 0, 0));

      // the range is [from, to], both ends included
      expect(await mintSums(ch, 1_000_105, 1_000_105, false)).toEqual(sums(111, 0, 0));
      expect(await mintSums(ch, 1_000_106, 1_000_300, false)).toEqual(sums(200, 0, 7));
      expect(await mintSums(ch, 1_000_400, 1_000_400, false)).toEqual(sums(0, 1000, 0));
      // a range with nothing in it, and one that is no range
      expect(await mintSums(ch, 5_000_000, 5_000_100, false)).toEqual(sums(0, 0, 0));
      expect((await mintSums(ch, 5_000_000, 5_000_100, true)).size).toBe(0);
      expect(await mintSums(ch, 10, 5, false)).toEqual(sums(0, 0, 0));
      expect((await mintSums(ch, 10, 5, true)).size).toBe(0);
    });

    it('classifies a mint as a reward when its claim is 5 ledgers before the slice', async () => {
      const ch = await fresh();
      // the claim is in the partition before the one the slice reads; the mint is 5 ledgers after it
      await ch.insert(Table.RewardClaims, [claim(999_997, 'claim-before')]);
      await ch.insert(Table.GenesisMints, [mint(1_000_002, 50, 'claim-before', `${D1}T00:00:00Z`)]);
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(50, 0, 0));
      expect((await mintSums(ch, 1_000_000, 1_999_999, true)).get(D1)).toEqual(sums(50, 0, 0));
    });

    it('looks 256 ledgers before the slice for a claim, and no further', async () => {
      const ch = await fresh();
      expect(SUPPLY_PARENT_LEDGERS).toBe(256);
      await ch.insert(Table.RewardClaims, [claim(1_000_000 - 256, 'claim-256'), claim(1_000_000 - 257, 'claim-257')]);
      await ch.insert(Table.GenesisMints, [
        mint(1_000_010, 60, 'claim-256', `${D1}T00:00:00Z`),
        mint(1_000_020, 70, 'claim-257', `${D1}T00:00:00Z`),
      ]);
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(60, 0, 70));
    });

    it("a failed ClaimReward is still a reward's parent", async () => {
      const ch = await fresh();
      // `reward_claims` has no result column: ingest writes a row for every ClaimReward, and the row is all the read asks for
      const columns = await ch.query<{ name: string }>(
        `SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {table:String}`,
        { table: Table.RewardClaims },
      );
      expect(columns.map((c) => c.name)).not.toContain('result');
      await ch.insert(Table.RewardClaims, [
        claim(1_000_100, 'claim-opted-out', { opt_out: 1 }),
        claim(1_000_101, 'c2'),
      ]);
      await ch.insert(Table.GenesisMints, [
        mint(1_000_103, 33, 'claim-opted-out', `${D1}T00:00:00Z`),
        mint(1_000_104, 44, 'c2', `${D1}T00:00:00Z`),
      ]);
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(77, 0, 0));
    });

    it('a mint without EmitDetails is genesis_mint', async () => {
      const ch = await fresh();
      await ch.insert(Table.RewardClaims, [claim(1_000_100, 'claim-1')]);
      await ch.insert(Table.GenesisMints, [mint(1_000_105, 8, '', `${D1}T00:00:00Z`)]);
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(0, 0, 8));
      expect((await mintSums(ch, 1_000_000, 1_999_999, true)).get(D1)).toEqual(sums(0, 0, 8));
    });

    it('reads from the first ledgers, where the 256 ledgers before the slice are below 0', async () => {
      const ch = await fresh();
      // Xahau's history starts at ledger 1 or 2: the claims are read from max(0, from - 256), and a negative bound is no UInt32
      await ch.insert(Table.RewardClaims, [claim(50, 'claim-50')]);
      await ch.insert(Table.GenesisMints, [mint(52, 5, 'claim-50', `${D1}T00:00:00Z`)]);
      expect(await mintSums(ch, 1, 100, false)).toEqual(sums(5, 0, 0));
      expect(await mintSums(ch, 0, 100, false)).toEqual(sums(5, 0, 0));
      expect((await mintSums(ch, 1, 100, true)).get(D1)).toEqual(sums(5, 0, 0));
    });

    it('adds every import and every mint entry of a ledger', async () => {
      const ch = await fresh();
      // the key of an import is (ledger, place in the ledger), the key of a mint entry (ledger, place, entry)
      await ch.insert(Table.Imports, [
        imported(1_000_400, 10, `${D1}T00:00:00Z`),
        imported(1_000_400, 20, `${D1}T00:00:00Z`, 1),
        imported(1_000_400, 40, `${D1}T00:00:00Z`, 2),
      ]);
      await ch.insert(Table.GenesisMints, [
        mint(1_000_500, 1, '', `${D1}T00:00:00Z`),
        mint(1_000_500, 2, '', `${D1}T00:00:00Z`, { mint_index: 1 }),
        mint(1_000_500, 4, '', `${D1}T00:00:00Z`, { tx_index: 1 }),
        mint(1_000_500, 8, '', `${D1}T00:00:00Z`, { tx_index: 1, mint_index: 1 }),
      ]);
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(0, 70, 15));
      expect((await mintSums(ch, 1_000_000, 1_999_999, true)).get(D1)).toEqual(sums(0, 70, 15));
    });

    it('answers the days in ascending order, whatever order the slices and the ledgers come in', async () => {
      const ch = await fresh();
      const D0 = '2026-09-30';
      // the first slice has the latest day of a mint and the earliest day of an import; the second has a later day in an earlier ledger
      await ch.insert(Table.GenesisMints, [
        mint(10, 3, '', `${D3}T00:00:00Z`),
        mint(1_000_105, 2, '', `${D2}T00:00:00Z`),
        mint(1_000_900, 1, '', `${D1}T00:00:00Z`),
      ]);
      await ch.insert(Table.Imports, [imported(11, 4, `${D0}T00:00:00Z`), imported(1_000_400, 8, `${D2}T00:00:00Z`)]);
      const byDay = await mintSums(ch, 0, 1_999_999, true);
      expect([...byDay.keys()]).toEqual([D0, D1, D2, D3]);
      expect(byDay.get(D0)).toEqual(sums(0, 4, 0));
      expect(byDay.get(D1)).toEqual(sums(0, 0, 1));
      expect(byDay.get(D2)).toEqual(sums(0, 8, 2));
      expect(byDay.get(D3)).toEqual(sums(0, 0, 3));
    });

    it('adds amounts past 2^53 exactly', async () => {
      const ch = await fresh();
      // 2^53 + 1 is no JS number: it is inserted as text, summed by ClickHouse inside a slice, and added across slices as a bigint
      const BIG = '9007199254740993';
      const big = (times: number): bigint => BigInt(BIG) * BigInt(times);
      await ch.insert(Table.RewardClaims, [claim(1_000_100, 'claim-big')]);
      await ch.insert(Table.GenesisMints, [
        mint(1_000_105, BIG, 'claim-big', `${D1}T00:00:00Z`),
        mint(1_000_106, BIG, 'claim-big', `${D1}T00:00:00Z`),
        mint(1_000_107, BIG, '', `${D1}T00:00:00Z`),
        mint(1_000_108, BIG, '', `${D1}T00:00:00Z`),
        mint(2_000_001, BIG, '', `${D2}T00:00:00Z`),
      ]);
      await ch.insert(Table.Imports, [
        imported(1_000_400, BIG, `${D1}T00:00:00Z`),
        imported(1_000_401, BIG, `${D1}T00:00:00Z`),
        imported(2_000_002, BIG, `${D2}T00:00:00Z`),
      ]);
      expect(await mintSums(ch, 1_000_000, 2_999_999, false)).toEqual({
        rewards: big(2),
        genesis_mint: big(3),
        import: big(3),
      });
      const byDay = await mintSums(ch, 1_000_000, 2_999_999, true);
      expect(byDay.get(D1)).toEqual({ rewards: big(2), genesis_mint: big(2), import: big(2) });
      expect(byDay.get(D2)).toEqual({ rewards: 0n, genesis_mint: big(1), import: big(1) });
    });

    it('counts a mint and an import written twice once', async () => {
      const ch = await fresh();
      await stopMerges(ch, Table.GenesisMints, Table.Imports, Table.RewardClaims);
      const claims = [claim(1_000_100, 'claim-1')];
      const mints = [
        mint(1_000_105, 100, 'claim-1', `${D1}T00:00:00Z`),
        mint(1_000_105, 11, 'claim-1', `${D1}T00:00:00Z`, { mint_index: 1 }),
        mint(1_000_106, 7, '', `${D1}T00:00:00Z`),
      ];
      // two imports of one ledger: the key of an import is its ledger and its place in the ledger
      const imports = [imported(1_000_400, 1000, `${D1}T00:00:00Z`), imported(1_000_400, 20, `${D1}T00:00:00Z`, 1)];
      const written: Array<[Table, object[]]> = [
        [Table.RewardClaims, claims],
        [Table.GenesisMints, mints],
        [Table.Imports, imports],
      ];
      for (const [table, rows] of written) {
        await insertTwice(ch, table, rows);
        // the rows are in the table twice (no merge ran, and the second copy was not dropped by the dedup window)
        expect(await countOf(ch, `SELECT count() AS n FROM ${table}`)).toBe(2 * rows.length);
      }
      expect(await mintSums(ch, 1_000_000, 1_999_999, false)).toEqual(sums(111, 1020, 7));
      expect((await mintSums(ch, 1_000_000, 1_999_999, true)).get(D1)).toEqual(sums(111, 1020, 7));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what the mint reads cost', () => {
    // The tables hold, besides the rows a read needs, bulks of rows it must skip: parts of other partitions, and parts of
    // the partition it reads above its ledgers (or, for the claims, below the 256 ledgers). The merges are stopped, so every
    // insert stays a part of its own. Bulks are 60,000 rows, more than the bound of any read here.
    const BULK = 60_000;
    const PER_LEDGER = 3;
    const NEEDED = 3_000; // mints in 1,000 ledgers from 1,000,000
    const REWARDS = 100; // the first 100 of them are rewards, whose claims are in the 256 ledgers before the slice
    const SLICE_FROM = MILLION;
    const SLICE_TO = SLICE_FROM + 499_999;

    let ch: ClickHouseService;

    /** `rows` mints from the ledger `base`, three to a ledger; the first `rewards` of them with a claim as parent. */
    const insertMints = (base: number, rows: number, rewards = 0): Promise<void> =>
      ch.command(
        `INSERT INTO ${Table.GenesisMints}
           (ledger_index, tx_index, mint_index, tx_hash, close_time, destination, amount, parent_tx_hash, emit_hook_hash)
         SELECT toUInt32({base:UInt32} + intDiv(n.number, {per:UInt32})), toUInt32(n.number % {per:UInt32}), toUInt16(0),
                concat('bulk-', toString(n.number)), toDateTime(1700000000, 'UTC'), 'rSyntheticBulk', toUInt64(10),
                if(n.number < {rewards:UInt32}, concat('CL', toString(n.number)), ''), ''
           FROM numbers({rows:UInt32}) AS n`,
        { base, per: PER_LEDGER, rows, rewards },
      );

    /** `rows` imports, one to a ledger from `base`, 10 drops each. */
    const insertImports = (base: number, rows: number): Promise<void> =>
      ch.command(
        `INSERT INTO ${Table.Imports} (ledger_index, tx_index, tx_hash, close_time, account, minted, account_created)
         SELECT toUInt32({base:UInt32} + n.number), toUInt32(0), concat('bulk-', toString(n.number)),
                toDateTime(1700000000, 'UTC'), 'rSyntheticBulk', toUInt64(10), toUInt8(0)
           FROM numbers({rows:UInt32}) AS n`,
        { base, rows },
      );

    /** `rows` claims, one to a ledger from `base`, whose hashes are `CL<n>` for the first `named` and `bulk-<n>` for the rest. */
    const insertClaims = (base: number, rows: number, named = 0): Promise<void> =>
      ch.command(
        `INSERT INTO ${Table.RewardClaims} (ledger_index, tx_index, tx_hash, close_time, account, issuer, opt_out)
         SELECT toUInt32({base:UInt32} + n.number), toUInt32(0),
                if(n.number < {named:UInt32}, concat('CL', toString(n.number)), concat('bulk-', toString(n.number))),
                toDateTime(1700000000, 'UTC'), 'rSyntheticBulk', '', toUInt8(0)
           FROM numbers({rows:UInt32}) AS n`,
        { base, rows, named },
      );

    interface Logged {
      tables: string[];
      read_rows: number;
    }

    /** The SELECTs on the mint tables while `run` ran (`system.query_log`), in the order they started, with the rows each read. */
    async function logged(run: () => Promise<unknown>): Promise<Logged[]> {
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ tables: string[]; read_rows: string }>(
        `SELECT tables, read_rows FROM system.query_log
          WHERE current_database = currentDatabase() AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)}
            AND hasAny(tables, arrayMap(x -> concat(currentDatabase(), '.', x), {names:Array(String)}))
          ORDER BY query_start_time_microseconds`,
        { t, names: [Table.GenesisMints, Table.Imports, Table.RewardClaims] },
      );
      return rows.map((r) => ({ tables: r.tables, read_rows: Number(r.read_rows) }));
    }

    const readsOf = (all: Logged[], table: Table): number[] =>
      all.filter((r) => r.tables.some((t) => t.endsWith(`.${table}`))).map((r) => r.read_rows);

    /** The rows of a table with a `ledger_index` in `[from, to]`. */
    const rowsBetween = (table: Table, from: number, to: number): Promise<number> =>
      countOf(ch, `SELECT count() AS n FROM ${table} WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`, {
        from,
        to,
      });

    /** The active parts of a table whose ledgers overlap `[from, to]`: the only parts a read of the range opens. */
    const partsOf = (table: Table, from: number, to: number): Promise<number> =>
      countOf(
        ch,
        `SELECT count() AS n FROM (SELECT _part FROM ${table} GROUP BY _part
                                   HAVING min(ledger_index) <= {to:UInt32} AND max(ledger_index) >= {from:UInt32})`,
        { from, to },
      );

    /** What a read of `[from, to]` of a table may read: its rows there and two granules for each part (the ends of a range are whole granules). */
    const rowsAndGranules = async (table: Table, from: number, to: number): Promise<number> =>
      (await rowsBetween(table, from, to)) + 2 * GRANULE * (await partsOf(table, from, to));

    /**
     * The bound of the genesis query of the slice `[from, to]`: its mints, and the claims of the 256 ledgers before it and of the slice
     * (the two `IN` subqueries of the query are one set: it reads the claims once).
     */
    const genesisBound = async (from: number, to: number): Promise<number> =>
      (await rowsAndGranules(Table.GenesisMints, from, to)) +
      (await rowsAndGranules(Table.RewardClaims, Math.max(0, from - SUPPLY_PARENT_LEDGERS), to));

    beforeAll(async () => {
      ch = await fresh();
      await stopMerges(ch, Table.GenesisMints, Table.Imports, Table.RewardClaims);
      // the rows the slice [1,000,000 .. 1,499,999] needs: 3,000 mints, the first 100 of them rewards whose claims are at
      // 999,800 .. 999,899 (inside the 256 ledgers before the slice), and 1,500 imports
      await insertMints(SLICE_FROM, NEEDED, REWARDS);
      await insertClaims(999_800, REWARDS, REWARDS);
      await insertImports(SLICE_FROM, 1_500);
      // the bulks it must skip: the partition before, the same partition above the slice, and other partitions (the genesis mints
      // and the imports)
      for (const base of [100_000, SLICE_TO + 1, 3 * MILLION, 4 * MILLION]) {
        await insertMints(base, BULK);
        await insertImports(base, BULK);
      }
      // the claims: below the 256 ledgers before the slice (in the partition before), above its end (in the partition of the
      // slice), and in another partition
      for (const base of [100_000, SLICE_TO + 1, 3 * MILLION]) await insertClaims(base, BULK);
    });

    it('reads the rows of its slice, and the claims of 256 ledgers more, not the bulks', async () => {
      const claimsFrom = SLICE_FROM - SUPPLY_PARENT_LEDGERS;
      // the premise: what the read needs is small, and each bulk is more than the bound
      expect(await rowsBetween(Table.GenesisMints, SLICE_FROM, SLICE_TO)).toBe(NEEDED);
      expect(await rowsBetween(Table.RewardClaims, claimsFrom, SLICE_TO)).toBe(REWARDS);
      expect(await rowsBetween(Table.Imports, SLICE_FROM, SLICE_TO)).toBe(1_500);
      const mintBound = await genesisBound(SLICE_FROM, SLICE_TO);
      const importBound = await rowsAndGranules(Table.Imports, SLICE_FROM, SLICE_TO);
      expect(Math.max(mintBound, importBound)).toBeLessThan(BULK);

      let answer: MintSums | undefined;
      const all = await logged(async () => {
        answer = await mintSums(ch, SLICE_FROM, SLICE_TO, false);
      });
      const mintReads = readsOf(all, Table.GenesisMints);
      const importReads = readsOf(all, Table.Imports);
      expect(mintReads).toHaveLength(1);
      expect(importReads).toHaveLength(1);
      expect(mintReads[0]).toBeLessThanOrEqual(mintBound);
      expect(importReads[0]).toBeLessThanOrEqual(importBound);
      // and the answer is the rows': 100 rewards, 2,900 genesis mints and 1,500 imports, 10 drops each
      expect(answer).toEqual({ rewards: 1_000n, genesis_mint: 29_000n, import: 15_000n });
    });

    it('reads one slice per partition', async () => {
      // 999,000 .. 4,000,100 spans five partitions: five slices of two reads each
      const from = 999_000;
      const to = 4 * MILLION + 100;
      const slices = [
        [from, MILLION - 1],
        [MILLION, 2 * MILLION - 1],
        [2 * MILLION, 3 * MILLION - 1],
        [3 * MILLION, 4 * MILLION - 1],
        [4 * MILLION, to],
      ];
      let answer: MintSums | undefined;
      const all = await logged(async () => {
        answer = await mintSums(ch, from, to, false);
      });
      const mintReads = readsOf(all, Table.GenesisMints);
      const importReads = readsOf(all, Table.Imports);
      expect(mintReads).toHaveLength(slices.length);
      expect(importReads).toHaveLength(slices.length);
      // every read is within the bound of its own slice, so none of them reads the range's rows (the bulks of other partitions, and
      // the bulk of partition 4 above its first ledgers)
      for (const [i, [sliceFrom, sliceTo]] of slices.entries()) {
        expect(mintReads[i]).toBeLessThanOrEqual(await genesisBound(sliceFrom, sliceTo));
        expect(importReads[i]).toBeLessThanOrEqual(await rowsAndGranules(Table.Imports, sliceFrom, sliceTo));
      }
      // and the answer: the mints of partition 1 (the range holds the bulk above the first test's slice as well), the bulk of
      // partition 3 (all of it is in the range) and the first 101 ledgers of the bulk of partition 4, 10 drops each
      expect(answer).toEqual({
        rewards: BigInt(10 * REWARDS),
        genesis_mint: BigInt(10 * (NEEDED - REWARDS + BULK + BULK + PER_LEDGER * 101)),
        import: BigInt(10 * (1_500 + BULK + BULK + 101)),
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the newest snapshot', () => {
    const snapshot = (over: Partial<NetworkSupplyRow>): NetworkSupplyRow => ({
      ledger_index: 100,
      close_time: 1_760_000_000,
      started_at: 1_760_000_100,
      computed_at: 1_760_000_200,
      total_coins: '99985312374716318',
      burned: '14687625283682',
      escrowed: '35212847105402318',
      escrow_count: 12879,
      amm: '46218377402915',
      amm_pools: 14594,
      reserve_base: '1000000',
      reserve_inc: '200000',
      accounts: 6410280,
      owner_count: '16998620',
      minted_rewards: null,
      minted_import: null,
      minted_genesis: null,
      version: 1,
      ...over,
    });

    it('answers undefined before the first snapshot', async () => {
      expect(await newestSnapshot(await fresh())).toBeUndefined();
    });

    it('answers the newest snapshot and its newest version', async () => {
      const ch = await fresh();
      await stopMerges(ch, Table.NetworkSupply);
      // one insert each: the rows of a key that arrive in one insert are collapsed to the newest version before they are written, and the
      // rows of one key must be on disk twice to be told apart (the newer version first, so that the last row is not the answer)
      await ch.insert(Table.NetworkSupply, [snapshot({ ledger_index: 99, version: 500 })]); // an older ledger with a higher version
      await ch.insert(Table.NetworkSupply, [
        snapshot({
          ledger_index: 100,
          version: 10, // as text, '10' sorts below '9'
          total_coins: '99985312374716318',
          amm: null, // NULLs stay NULL
          reserve_base: null,
          reserve_inc: null,
        }),
      ]);
      await ch.insert(Table.NetworkSupply, [snapshot({ ledger_index: 100, version: 9, total_coins: '1' })]);
      expect(await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkSupply}`)).toBe(3);
      expect(await newestSnapshot(ch)).toEqual({
        ledger_index: 100,
        close_time: 1_760_000_000,
        started_at: 1_760_000_100,
        computed_at: 1_760_000_200,
        total_coins: '99985312374716318', // past 2^53: text, not a float
        burned: '14687625283682',
        escrowed: '35212847105402318',
        escrow_count: '12879',
        amm: null,
        amm_pools: 14594,
        reserve_base: null,
        reserve_inc: null,
        accounts: '6410280',
        owner_count: '16998620',
        minted_rewards: null,
        minted_import: null,
        minted_genesis: null,
        version: '10',
      });

      // a newer ledger wins whatever the versions below it, and the mint columns are text as well
      await ch.insert(Table.NetworkSupply, [
        snapshot({
          ledger_index: 101,
          version: 2,
          amm: null,
          minted_rewards: '41203318512207',
          minted_import: '8102233104000',
          minted_genesis: '120000000000',
        }),
      ]);
      expect(await newestSnapshot(ch)).toMatchObject({
        ledger_index: 101,
        version: '2',
        amm: null,
        minted_rewards: '41203318512207',
        minted_import: '8102233104000',
        minted_genesis: '120000000000',
      });
    });

    it('reads two granules of the end of the key for the newest snapshot, one for each of its reads', async () => {
      const ch = await fresh();
      await stopMerges(ch, Table.NetworkSupply);
      // 20,000 snapshots in one insert: one part
      await ch.command(
        `INSERT INTO ${Table.NetworkSupply}
         SELECT toUInt32(n.number + 1), toDateTime(1700000000, 'UTC'), toDateTime(1700000000, 'UTC'), toDateTime(1700000000, 'UTC'),
                toUInt64(99985312374716318), toUInt64(14687625283682), toUInt64(0), toUInt64(0), NULL, toUInt32(0), NULL, NULL,
                toUInt64(0), toUInt64(0), NULL, NULL, NULL, toUInt64(1)
           FROM numbers(20000) AS n`,
      );
      const parts = await countOf(
        ch,
        `SELECT count() AS n FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active`,
        { table: Table.NetworkSupply },
      );
      expect(parts).toBe(1);
      expect(await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkSupply}`)).toBe(20_000);

      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      const newest = await newestSnapshot(ch);
      await ch.command('SYSTEM FLUSH LOGS');
      const read = await ch.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log
          WHERE current_database = currentDatabase() AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, concat(currentDatabase(), '.', {table:String}))
          ORDER BY query_start_time_microseconds`,
        { t, table: Table.NetworkSupply },
      );
      expect(newest?.ledger_index).toBe(20_000);
      // the bound is the row and two granules for the one part (the granule here is 11,808 rows: the last of 20,000 in two), and a
      // scan of the table is over it
      const bound = 1 + 2 * GRANULE * parts;
      expect(bound).toBeLessThan(20_000);
      expect(read).toHaveLength(2);
      for (const { read_rows } of read) expect(Number(read_rows)).toBeLessThanOrEqual(bound);
    });
  });
});

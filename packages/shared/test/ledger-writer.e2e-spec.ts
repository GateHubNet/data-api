import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows, CHILD_TABLES, ChildRowsKey, LedgerParseError, LedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import {
  awaitQuiescence,
  committedCheckpoint,
  deleteLedgerRange,
  deleteLedgersAbove,
  firstCommittedLedger,
  LEDGER_KEYED_TABLES,
  missingLedgers,
  storedLedgerHash,
} from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { RawLedger } from '../src/ingest/raw-ledger';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { objectCase } from '../src/test-utils/object-cases';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { mptOfferHash, withMptOffers } from './synthetic-mpt-offers';

const LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const BUILT = LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

/** Whole mainnet ledgers around the recorded AMM cases: swaps, liquidity events, votes and bids, 16 ledgers. */
const AMM_LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/amm')).list();
const AMM_BUILT = AMM_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

/** Whole mainnet ledgers around the recorded NFT cases: mints, offers, sales, burns and a modify, 11 ledgers. */
const NFT_LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/nft')).list();
const NFT_BUILT = NFT_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

/**
 * Whole mainnet ledgers around the recorded escrow, check, payment channel and delegation cases (D5 Task 1), 22 ledgers:
 * escrows created, finished and cancelled, checks created, cashed and cancelled, channels and delegations.
 */
const OBJECT_LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/objects')).list();
const OBJECT_BUILT = OBJECT_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

/** The fixture ledgers are sparse and spread over several partitions: P6 1, 2, 11, 20, 29 and P7 0, 1, 2. */
const index = (i: number): number => LEDGERS[i].header.ledger_index;

const ALL_TABLES: Table[] = LEDGER_KEYED_TABLES.map((t) => t.table);

/**
 * `account_domains` is ordered by account (spec 1.1, decision 7), so the rows of one account collapse: within one insert
 * (`optimize_on_insert`) and across inserts at the merges, whenever they run (the ripple-mock fixtures give the last ledger
 * two rows of one account). Like `tx_by_hash` in the live runner's tests it is left out of the per-table counts, and
 * `expectDomains` compares what it holds instead: the newest row of each account.
 */
const MERGED_TABLES: Table[] = [Table.AccountDomains];

/** The tables whose rows are counted: every ledger-keyed table but the merged ones. */
const COUNTED_TABLES: Table[] = ALL_TABLES.filter((t) => !MERGED_TABLES.includes(t));

/**
 * The tables with a dedup window that are not ledger tables: the validations collector's `validator_validations` and
 * `validator_seen` (window 100). Ingest recovery never touches them, so they are not in `LEDGER_KEYED_TABLES`.
 */
const COLLECTOR_DEDUP_TABLES: Table[] = [Table.ValidatorValidations, Table.ValidatorSeen];

/** The ledger tables of the AMM data: child tables like the others, with rows from the AMM parser. */
const AMM_LEDGER_TABLES: Table[] = [
  Table.AmmPoolStates,
  Table.AmmPoolTouches,
  Table.AmmLiquidity,
  Table.AccountAmmLiquidity,
  Table.AmmGovernance,
];

/** The ledger tables of the NFT data: child tables like the others, with rows from the NFT parser. */
const NFT_LEDGER_TABLES: Table[] = [
  Table.NftEvents,
  Table.AccountNftEvents,
  Table.CollectionNftEvents,
  Table.NftSales,
  Table.NftTouches,
];

/**
 * The ledger tables of the ledger objects (migration 013): child tables like the others, with rows from the object parser.
 * Of the ripple-mock ledgers two have rows (a recorded EscrowCreate and two claims on a channel), in one partition.
 */
const OBJECT_LEDGER_TABLES: Table[] = [Table.ObjectChanges, Table.AccountObjectChanges];

/**
 * The ledger table of the touches of token state (migration 014): a child table like the others, with rows from the touches
 * parser. Of the ripple-mock ledgers two have rows (11119620 and 11618225), in one partition.
 */
const TOUCH_LEDGER_TABLES: Table[] = [Table.StateTouches];

/**
 * The ledger tables of the Xahau mints (migration 015, parser version 9): child tables like the others, with rows from the
 * rewards and import parsers. The ripple-mock ledgers are XRPL's, which has none of the three transaction types, so they give
 * these tables no row.
 */
const MINT_LEDGER_TABLES: Table[] = [Table.GenesisMints, Table.Imports, Table.RewardClaims];

/**
 * The tables the ripple-mock ledgers have (almost) no activity for: the delete tests put hand-made rows into them
 * (`insertSeededRows`), to see what the deletes reach and what they leave. The recorded AMM, NFT and object ledgers give
 * real rows to these tables, but they all sit in one partition of each, and the delete tests need the rows over several.
 * `account_domains` (migration 012) is one of them: the last ripple-mock ledger gives it two rows of one account, but the
 * delete tests need a row in every ledger, and each of an account of its own (`seededDomainRow`). The two object tables
 * (migration 013) are the others: two ripple-mock ledgers give them rows, in one partition. `state_touches` (migration 014)
 * is another: two ripple-mock ledgers give it rows too, in one partition. The three mint tables (migration 015) are the last,
 * and the ripple-mock ledgers give them no row at all.
 */
const SEEDED_LEDGER_TABLES: Table[] = [
  ...AMM_LEDGER_TABLES,
  ...NFT_LEDGER_TABLES,
  Table.AccountDomains,
  ...OBJECT_LEDGER_TABLES,
  ...TOUCH_LEDGER_TABLES,
  ...MINT_LEDGER_TABLES,
];

/** The seeded tables partitioned by a million ledgers (P6); the others by ten million (P7). */
const SEEDED_P6_TABLES: Table[] = [
  Table.AmmPoolTouches,
  Table.NftSales,
  Table.NftTouches,
  Table.StateTouches,
  ...MINT_LEDGER_TABLES,
];

type Counts = Record<string, number>;
type Json = Record<string, unknown>;

/** The columns of an `account_domains` row that the comparisons read. */
interface DomainKey {
  account: string;
  ledger_index: number;
  version: string;
}

/**
 * The hand-made `account_domains` row of a ledger (`insertSeededRows`): its sample row, moved to the ledger. The table has
 * no time and is ordered by account, so rows of one account in a partition would merge into one: every ledger gets an
 * account (and so a version) of its own.
 */
function seededDomainRow(ledgerIndex: number): Json & DomainKey {
  const sample = SAMPLE_ROWS[Table.AccountDomains];
  const version = BigInt(ledgerIndex) * 2n ** 32n + BigInt(sample.tx_index) * 2n ** 16n + BigInt(sample.node_index);
  return { ...sample, ledger_index: ledgerIndex, account: `rSeeded${ledgerIndex}`, version: version.toString() };
}

/** `rows` ordered by the columns `keys`, as ClickHouse orders them by that key (numbers and ASCII text). */
const sortedBy = (rows: Json[], keys: string[]): Json[] =>
  [...rows].sort((a, b) => {
    for (const k of keys) {
      if (a[k] === b[k]) continue;
      return (a[k] as number | string) < (b[k] as number | string) ? -1 : 1;
    }
    return 0;
  });

/**
 * What the counted tables hold when exactly the ledgers of `built` matching `keep` were written, from the rows
 * `buildLedgerRows` made (`account_domains` is not counted: `MERGED_TABLES`). `seeded` are ledgers that also got one
 * hand-made row in each AMM and NFT table, in `account_domains`, in the two object tables, in `state_touches` and in the
 * three mint tables (`insertSeededRows`).
 */
function countsOf(
  built: LedgerRows[],
  keep: (ledgerIndex: number) => boolean = () => true,
  seeded: readonly LedgerRows[] = [],
): Counts {
  const counts: Counts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, 0]));
  for (const rows of built) {
    if (!keep(rows.ledger.ledger_index)) continue;
    counts[Table.Ledgers] += 1;
    counts[Table.LedgerByHash] += 1;
    for (const [table, key] of CHILD_TABLES)
      if (!MERGED_TABLES.includes(table)) counts[table] += (rows[key] as unknown[]).length;
  }
  for (const rows of seeded) {
    if (keep(rows.ledger.ledger_index)) {
      for (const table of SEEDED_LEDGER_TABLES) if (!MERGED_TABLES.includes(table)) counts[table] += 1;
    }
  }
  return counts;
}

/** The ripple-mock ledgers (no AMM or NFT activity), optionally with seeded AMM, NFT and account domain rows. */
const expectedCounts = (keep?: (ledgerIndex: number) => boolean, seeded?: readonly LedgerRows[]): Counts =>
  countsOf(BUILT, keep, seeded);

/** The AMM fixture ledgers. */
const expectedAmmCounts = (keep?: (ledgerIndex: number) => boolean): Counts => countsOf(AMM_BUILT, keep);

/** The NFT fixture ledgers. */
const expectedNftCounts = (keep?: (ledgerIndex: number) => boolean): Counts => countsOf(NFT_BUILT, keep);

const aIndex = (i: number): number => AMM_LEDGERS[i].header.ledger_index;
const nIndex = (i: number): number => NFT_LEDGERS[i].header.ledger_index;
const oIndex = (i: number): number => OBJECT_LEDGERS[i].header.ledger_index;

/** The object fixture ledgers. */
const expectedObjectCounts = (keep?: (ledgerIndex: number) => boolean): Counts => countsOf(OBJECT_BUILT, keep);

describe('LedgerWriter and ingest state (e2e)', () => {
  let ch: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    ch = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.close();
    await ch?.container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A migrated database of its own, so a test never sees another test's rows or dedup log. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...ch.config, database: `lw_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const count = async (svc: ClickHouseService, table: Table | string, where = '1'): Promise<number> =>
    Number((await svc.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  /** Ids of the running queries that belong to `prefix`. */
  async function runningQueryIds(svc: ClickHouseService, prefix: string): Promise<string[]> {
    const rows = await svc.query<{ query_id: string }>(
      'SELECT query_id FROM system.processes WHERE startsWith(query_id, {prefix:String})',
      { prefix },
    );
    return rows.map((r) => r.query_id);
  }

  /** Poll `check` until it is true; false when it never is within `timeoutMs`. */
  async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async function storedCounts(svc: ClickHouseService): Promise<Counts> {
    return Object.fromEntries(await Promise.all(COUNTED_TABLES.map(async (t) => [t, await count(svc, t)] as const)));
  }

  /**
   * The hand-made rows of a seeded table (`insertSeededRows`): in `account_domains` the ones of the `rSeeded…` accounts, in
   * the object tables the ones of the sample's object (two ripple-mock ledgers have real rows in them), in `state_touches` the
   * ones of the sample's line. The mint tables hold nothing else, so every row of them is one.
   */
  const countSeeded = (svc: ClickHouseService, table: Table): Promise<number> =>
    count(
      svc,
      table,
      table === Table.AccountDomains
        ? "startsWith(account, 'rSeeded')"
        : OBJECT_LEDGER_TABLES.includes(table)
          ? `object_id = '${SAMPLE_ROWS[Table.ObjectChanges].object_id}'`
          : TOUCH_LEDGER_TABLES.includes(table)
            ? `account = '${SAMPLE_ROWS[Table.StateTouches].account}' AND counterparty = '${SAMPLE_ROWS[Table.StateTouches].counterparty}'`
            : '1',
    );

  const rowsAbove = async (svc: ClickHouseService, cp: number): Promise<Counts> =>
    Object.fromEntries(
      await Promise.all(ALL_TABLES.map(async (t) => [t, await count(svc, t, `ledger_index > ${cp}`)] as const)),
    );

  /**
   * What `account_domains` holds when exactly the ledgers of `built` matching `keep` were written (and the `seeded`
   * ledgers got their hand-made row), as far as the merges leave it deterministic:
   *  - every stored row is a row of a kept ledger, so nothing of a deleted ledger is left and nothing was invented;
   *  - an account that has no row in a deleted ledger has, as its newest stored row, its newest built row. (One that
   *    has lost its newest rows to a delete may or may not have kept an older one: a merge may have dropped it already.)
   */
  async function expectDomains(
    svc: ClickHouseService,
    built: readonly LedgerRows[],
    keep: (ledgerIndex: number) => boolean = () => true,
    seeded: readonly LedgerRows[] = [],
  ): Promise<void> {
    const all: DomainKey[] = [
      ...built.flatMap((r) => r.accountDomains),
      ...seeded.map((r) => seededDomainRow(r.ledger.ledger_index)),
    ];
    const kept = all.filter((r) => keep(r.ledger_index));
    const hurt = new Set(all.filter((r) => !keep(r.ledger_index)).map((r) => r.account));
    const stored = await svc.query<{ account: string; version: string }>(
      `SELECT account, toString(version) AS version FROM ${Table.AccountDomains}`,
    );

    const keptKeys = new Set(kept.map((r) => `${r.account}/${r.version}`));
    expect(stored.filter((r) => !keptKeys.has(`${r.account}/${r.version}`))).toEqual([]);
    const newest = (rows: Array<{ account: string; version: string }>): Map<string, string> => {
      const latest = new Map<string, bigint>();
      for (const { account, version } of rows) {
        if (BigInt(version) > (latest.get(account) ?? -1n)) latest.set(account, BigInt(version));
      }
      return new Map([...latest].map(([account, version]) => [account, version.toString()]));
    };
    const storedNewest = newest(stored);
    for (const [account, version] of newest(kept.filter((r) => !hurt.has(r.account)))) {
      expect([account, storedNewest.get(account)]).toEqual([account, version]);
    }
  }

  /** The counted tables and `account_domains` hold what writing the ledgers of `built` matching `keep` gives. */
  async function expectStored(
    svc: ClickHouseService,
    built: readonly LedgerRows[],
    keep?: (ledgerIndex: number) => boolean,
    seeded?: readonly LedgerRows[],
  ): Promise<void> {
    expect(await storedCounts(svc)).toEqual(countsOf([...built], keep, seeded));
    await expectDomains(svc, built, keep, seeded);
  }

  /** Insert the child rows and `ledger_by_hash` of ledgers, but not their `ledgers` row: a write that died before it. */
  async function insertUncommitted(svc: ClickHouseService, rows: LedgerRows[]): Promise<void> {
    for (const [table, key] of CHILD_TABLES)
      await svc.insert(
        table,
        rows.flatMap((r) => r[key] as unknown[]),
      );
    await svc.insert(
      Table.LedgerByHash,
      rows.map((r) => r.ledgerByHash),
    );
  }

  /**
   * The hand-made row of `table` for a ledger: the table's sample row, moved to the ledger. The touches of a pool, of an
   * NFT and of token state are the columns of their key, with no time, and `account_domains` and `account_object_changes`
   * have none either. The key of an object row has the ledger in it, so a row of each ledger is a row of its own.
   */
  function seededRow(table: Table, ledger: LedgerRows['ledger']): Json {
    if (table === Table.AccountDomains) return seededDomainRow(ledger.ledger_index);
    const row: Json = { ...SAMPLE_ROWS[table], ledger_index: ledger.ledger_index };
    if (
      table === Table.AmmPoolTouches ||
      table === Table.NftTouches ||
      table === Table.AccountObjectChanges ||
      table === Table.StateTouches
    )
      return row;
    return { ...row, close_time: ledger.close_time };
  }

  /**
   * One row in each AMM and NFT ledger table, in `account_domains`, in the two object tables, in `state_touches` and in
   * the three mint tables, for every one of `rows`' ledgers. The ripple-mock ledgers (2021) have no such activity (but
   * for two rows of `account_domains` in the last one), so the delete tests put these in by hand, over several
   * partitions, to see what the deletes reach and what they leave. `expectedCounts` and `expectStored` take them as
   * `seeded`.
   */
  async function insertSeededRows(svc: ClickHouseService, rows: LedgerRows[]): Promise<void> {
    for (const table of SEEDED_LEDGER_TABLES)
      await svc.insert(
        table,
        rows.map((r) => seededRow(table, r.ledger)),
      );
  }

  describe('write', () => {
    it('writes all fixtures and commit counts match', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      expect(await count(svc, Table.Ledgers)).toBe(54);
      expect(await count(svc, Table.Payments)).toBe(182);
      await expectStored(svc, BUILT);
      expect(await committedCheckpoint(svc)).toBe(index(53));
      expect(await storedLedgerHash(svc, index(7))).toBe(LEDGERS[7].header.ledger_hash);
      expect(await storedLedgerHash(svc, 1)).toBeUndefined();
    });

    it('commits the same rows when the ledgers arrive in several batches of one writer', async () => {
      const svc = await freshService();
      const writer = new LedgerWriter(svc, ctx);
      for (let i = 0; i < LEDGERS.length; i += 10) await writer.write(LEDGERS.slice(i, i + 10));

      await expectStored(svc, BUILT);
    });

    it('re-writing the same ledgers with a new runId duplicates rows until a merge: recovery must delete, not rely on dedup', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      expect(await count(svc, Table.Payments)).toBe(364);
      expect(await count(svc, Table.Ledgers)).toBe(108);

      const expected = expectedCounts();
      for (const table of COUNTED_TABLES) {
        await svc.command(`OPTIMIZE TABLE ${table} FINAL`);
        const key = (
          await svc.queryOne<{ sorting_key: string }>(
            'SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {t:String}',
            { t: table },
          )
        )?.sorting_key;
        const row = await svc.queryOne<{ n: string | number; u: string | number }>(
          `SELECT count() AS n, uniqExact(${key}) AS u FROM ${table}`,
        );
        expect([table, Number(row?.n), Number(row?.u)]).toEqual([table, expected[table], expected[table]]);
      }

      // Ordered by account, account_domains is left with one row per account and partition, the newest.
      await svc.command(`OPTIMIZE TABLE ${Table.AccountDomains} FINAL`);
      const domains = await svc.queryOne<{ n: string | number; u: string | number }>(
        `SELECT count() AS n, uniqExact(account, intDiv(ledger_index, 10000000)) AS u FROM ${Table.AccountDomains}`,
      );
      expect(Number(domains?.n)).toBeGreaterThan(0);
      expect(Number(domains?.n)).toBe(Number(domains?.u));
      await expectDomains(svc, BUILT);
    });

    it('same runId retry is deduplicated', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx, { runId: 'retry-run' }).write(LEDGERS);
      await new LedgerWriter(svc, ctx, { runId: 'retry-run' }).write(LEDGERS);

      expect(await count(svc, Table.Payments)).toBe(182);
      await expectStored(svc, BUILT);
    });

    it('chunks inserts above maxRowsPerInsert, with a token per chunk, children first and the commit marker last', async () => {
      const svc = await freshService();
      const events: string[] = [];
      const calls: Array<{ table: string; rows: number; token: string | undefined }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        events.push(`start:${table}`);
        calls.push({ table, rows: rows.length, token: opts?.dedupToken });
        await real(table, rows, opts);
        events.push(`end:${table}`);
      });

      const writer = new LedgerWriter(svc, ctx, { runId: 'run-x', maxRowsPerInsert: 100 });
      await writer.write(LEDGERS);

      const first = index(0);
      const last = index(53);
      const transactions = calls.filter((c) => c.table === Table.Transactions);
      expect(transactions.length).toBeGreaterThan(1);
      expect(transactions).toHaveLength(Math.ceil(933 / 100));
      expect(transactions.every((c) => c.rows <= 100)).toBe(true);
      expect(transactions.map((c) => c.rows).reduce((a, b) => a + b, 0)).toBe(933);
      expect(transactions.map((c) => c.token)).toEqual(
        transactions.map((_, n) => `run-x:transactions:${first}-${last}:${n}`),
      );
      // Every token of the run is distinct.
      const tokens = calls.map((c) => c.token);
      expect(new Set(tokens).size).toBe(tokens.length);

      // The child tables that have rows (the 12 of the Ripple data, the 2 state tables, the path payments and their index
      // by account, account_domains, which the last ledger has two rows for, the 2 object tables, which the ledgers of
      // a recorded EscrowCreate and of two channel claims have rows for, and state_touches, which the ledgers of 11119620 and
      // 11618225 have rows for: these ledgers have no AMM, NFT or Xahau mint activity, so the 5 AMM tables, the 5 NFT tables
      // and the 3 mint tables get no insert) start together, before any of them has finished.
      const childTables = new Set<string>(
        CHILD_TABLES.filter(([, key]) => BUILT.some((rows) => rows[key].length > 0)).map(([t]) => t),
      );
      expect(childTables.size).toBe(20);
      expect(childTables).toContain(Table.StateTouches);
      expect(childTables).toContain(Table.ObjectChanges);
      expect(childTables).toContain(Table.AccountObjectChanges);
      expect(childTables).toContain(Table.AccountStates);
      expect(childTables).toContain(Table.TrustLineStates);
      expect(childTables).toContain(Table.PathPayments);
      expect(childTables).toContain(Table.AccountPathPayments);
      expect(childTables).toContain(Table.AccountDomains);
      const firstStarts = events.slice(0, childTables.size);
      expect(new Set(firstStarts)).toEqual(new Set([...childTables].map((t) => `start:${t}`)));
      const noInsert = [...AMM_LEDGER_TABLES, ...NFT_LEDGER_TABLES, ...MINT_LEDGER_TABLES];
      expect(events.filter((e) => e.startsWith('start:') && noInsert.includes(e.slice(6) as Table))).toEqual([]);

      const lastChildEnd = Math.max(
        ...events.map((e, i) => (e.startsWith('end:') && childTables.has(e.slice(4)) ? i : -1)),
      );
      const byHashStart = events.indexOf(`start:${Table.LedgerByHash}`);
      const byHashEnd = events.indexOf(`end:${Table.LedgerByHash}`);
      const ledgersStart = events.indexOf(`start:${Table.Ledgers}`);
      expect(byHashStart).toBeGreaterThan(lastChildEnd);
      expect(ledgersStart).toBeGreaterThan(byHashEnd);
      expect(events[events.length - 1]).toBe(`end:${Table.Ledgers}`);
      expect(events.filter((e) => e === `start:${Table.Ledgers}`)).toHaveLength(1);

      await expectStored(svc, BUILT);
    });

    it('skips tables that have no rows, but still commits the ledger', async () => {
      const svc = await freshService();
      const empty: RawLedger = { header: LEDGERS[0].header, transactions: [] };
      const spy = jest.spyOn(svc, 'insert');

      await new LedgerWriter(svc, ctx).write([empty]);

      expect(spy.mock.calls.map((c) => c[0])).toEqual([Table.LedgerByHash, Table.Ledgers]);
      expect(await count(svc, Table.Ledgers)).toBe(1);
    });

    it('fails with a LedgerParseError naming the ledger before it inserts anything (ruling R96)', async () => {
      const svc = await freshService();
      const spy = jest.spyOn(svc, 'insert');
      const bad = index(5);
      const ledgers = LEDGERS.slice(0, 10).map((raw) =>
        raw.header.ledger_index === bad
          ? {
              ...raw,
              transactions: raw.transactions.map((t, i) => (i === 0 ? { ...t, tx: { ...t.tx, Fee: 'x' } } : t)),
            }
          : raw,
      );
      expect(LEDGERS[5].transactions.length).toBeGreaterThan(0);

      await expect(new LedgerWriter(svc, ctx).write(ledgers)).rejects.toMatchObject({
        name: 'LedgerParseError',
        ledgerIndex: bad,
      });
      await expect(new LedgerWriter(svc, ctx).write(ledgers)).rejects.toBeInstanceOf(LedgerParseError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('writing no ledgers does nothing', async () => {
      const svc = await freshService();
      const spy = jest.spyOn(svc, 'insert');
      await new LedgerWriter(svc, ctx).write([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects an invalid maxRowsPerInsert', async () => {
      const svc = await freshService();
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new LedgerWriter(svc, ctx, { maxRowsPerInsert: bad })).toThrow(/maxRowsPerInsert/);
      }
    });

    it('commits the ledgers rows in ascending order, in one insert unless the batch exceeds maxRowsPerInsert', async () => {
      const svc = await freshService();
      const ledgerInserts: Array<{ indexes: number[]; token: string | undefined }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) {
          ledgerInserts.push({
            indexes: (rows as Array<{ ledger_index: number }>).map((r) => r.ledger_index),
            token: opts?.dedupToken,
          });
        }
        await real(table, rows, opts);
      });
      // Handed over out of order.
      const shuffled = [LEDGERS[3], LEDGERS[1], LEDGERS[2], LEDGERS[0]];
      const sorted = [0, 1, 2, 3].map(index);

      await new LedgerWriter(svc, ctx, { runId: 'asc' }).write(shuffled);
      expect(ledgerInserts).toEqual([{ indexes: sorted, token: `asc:ledgers:${sorted[0]}-${sorted[3]}:0` }]);

      ledgerInserts.length = 0;
      await new LedgerWriter(svc, ctx, { runId: 'asc2', maxRowsPerInsert: 3 }).write(shuffled);
      expect(ledgerInserts).toEqual([
        { indexes: sorted.slice(0, 3), token: `asc2:ledgers:${sorted[0]}-${sorted[3]}:0` },
        { indexes: sorted.slice(3), token: `asc2:ledgers:${sorted[0]}-${sorted[3]}:1` },
      ]);
    });

    it('waits for every in-flight child insert before it throws, and then writes no commit marker', async () => {
      const svc = await freshService();
      let inFlight = 0;
      const attempted: string[] = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        attempted.push(table);
        inFlight += 1;
        try {
          if (table === Table.TxByType) throw new Error('boom');
          await real(table, rows, opts);
        } finally {
          inFlight -= 1;
        }
      });

      await expect(new LedgerWriter(svc, ctx).write(LEDGERS)).rejects.toThrow('boom');

      expect(inFlight).toBe(0);
      expect(attempted).not.toContain(Table.LedgerByHash);
      expect(attempted).not.toContain(Table.Ledgers);
      expect(await count(svc, Table.Ledgers)).toBe(0);
    });
  });

  describe('committedCheckpoint, storedLedgerHash and missingLedgers', () => {
    it('are empty on an empty database', async () => {
      const svc = await freshService();
      expect(await committedCheckpoint(svc)).toBeUndefined();
      expect(await storedLedgerHash(svc, 123)).toBeUndefined();
      expect(await missingLedgers(svc, 5, 8)).toEqual([5, 6, 7, 8]);
    });

    it('missingLedgers finds the gaps in a sparse set', async () => {
      const svc = await freshService();
      const lo = 11_119_599;
      const hi = 11_119_615;
      const present = LEDGERS.filter((l) => l.header.ledger_index >= lo && l.header.ledger_index <= hi);
      await new LedgerWriter(svc, ctx).write(present);

      const have = new Set(present.map((l) => l.header.ledger_index));
      const gaps: number[] = [];
      for (let i = lo; i <= hi; i++) if (!have.has(i)) gaps.push(i);
      expect(gaps).toEqual([11_119_605, 11_119_606]);

      expect(await missingLedgers(svc, lo, hi)).toEqual(gaps);
      // Bounds are inclusive and a range can stick out on both sides.
      expect(await missingLedgers(svc, 11_119_605, 11_119_606)).toEqual(gaps);
      expect(await missingLedgers(svc, 11_119_598, 11_119_600)).toEqual([11_119_598]);
      expect(await missingLedgers(svc, 11_119_615, 11_119_617)).toEqual([11_119_616, 11_119_617]);
      expect(await missingLedgers(svc, 11_119_600, 11_119_600)).toEqual([]);
      expect(await missingLedgers(svc, 9, 7)).toEqual([]);
    });

    it('only a ledgers row counts as present: the child rows of an uncommitted ledger do not', async () => {
      const svc = await freshService();
      await insertUncommitted(svc, [BUILT[0]]);
      expect(await committedCheckpoint(svc)).toBeUndefined();
      expect(await missingLedgers(svc, index(0), index(0))).toEqual([index(0)]);
    });

    it('firstCommittedLedger is undefined on an empty database and the lowest committed ledger after writes', async () => {
      const svc = await freshService();
      expect(await firstCommittedLedger(svc)).toBeUndefined();

      // The child rows of an uncommitted ledger do not count: only a `ledgers` row does.
      await insertUncommitted(svc, [BUILT[0]]);
      expect(await firstCommittedLedger(svc)).toBeUndefined();

      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(10, 20));
      expect(await firstCommittedLedger(svc)).toBe(index(10));
      expect(await committedCheckpoint(svc)).toBe(index(19));

      // A lower ledger committed later (a backfill) becomes the first; the checkpoint stays the highest.
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(2, 4));
      expect(await firstCommittedLedger(svc)).toBe(index(2));
      expect(await committedCheckpoint(svc)).toBe(index(19));
    });

    it('rejects arguments that are not UInt32 integers', async () => {
      const svc = await freshService();
      await expect(missingLedgers(svc, -1, 5)).rejects.toThrow(/invalid ledger range start/i);
      await expect(missingLedgers(svc, 1, 2 ** 32)).rejects.toThrow(/invalid ledger range end/i);
      await expect(storedLedgerHash(svc, 1.5)).rejects.toThrow(/invalid ledger index/i);
      await expect(deleteLedgersAbove(svc, Number.NaN)).rejects.toThrow(/invalid checkpoint/i);
      await expect(deleteLedgerRange(svc, 5, 4)).rejects.toThrow(/invalid ledger range 5-4/i);
    });
  });

  describe('deleteLedgersAbove', () => {
    it('removes the child rows of uncommitted ledgers from every ledger-keyed table, and nothing else', async () => {
      const svc = await freshService();
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));
      await insertUncommitted(svc, BUILT.slice(committed));
      // AMM, NFT, account domain and object rows in the uncommitted ledgers (to go) and in the committed ones (to stay).
      await insertSeededRows(svc, BUILT);
      // A table that is not keyed by ledger must survive.
      await svc.insert(Table.FeeStats, [
        {
          ts: 1_700_000_000.123,
          current_ledger_size: 1,
          expected_ledger_size: 2,
          current_queue_size: 3,
          max_queue_size: 4,
          pct_max_queue_size: 0.5,
          median_fee: '10',
          minimum_fee: '10',
          open_ledger_fee: '10',
        },
      ]);

      const cp = await committedCheckpoint(svc);
      expect(cp).toBe(index(committed - 1));
      const before = await rowsAbove(svc, cp!);
      // The uncommitted ledgers put rows into every child table, ledger_by_hash, the AMM, NFT, account domain and object
      // tables, over several partitions.
      for (const table of ALL_TABLES) {
        if (table === Table.Ledgers) expect(before[table]).toBe(0);
        else expect([table, before[table] > 0]).toEqual([table, true]);
      }

      const commands: string[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        commands.push(sql);
        await real(sql, params, opts);
      });
      await deleteLedgersAbove(svc, cp!);

      const after = await rowsAbove(svc, cp!);
      expect(after).toEqual(Object.fromEntries(ALL_TABLES.map((t) => [t, 0])));
      await expectStored(svc, BUILT, (i) => i <= cp!, BUILT);
      // The seeded rows of the committed ledgers are all still there: one per ledger in each table.
      for (const table of SEEDED_LEDGER_TABLES)
        expect([table, await countSeeded(svc, table)]).toEqual([table, committed]);
      expect(await count(svc, Table.FeeStats)).toBe(1);

      // The DELETEs hit exactly the ledger-keyed tables, partition by partition where the table is partitioned.
      const hit = commands.map((c) => /^\s*DELETE FROM (\w+)/.exec(c)?.[1]);
      expect(hit.every((t) => t !== undefined)).toBe(true);
      expect(new Set(hit)).toEqual(new Set(ALL_TABLES));
      for (const sql of commands) {
        const table = /^\s*DELETE FROM (\w+)/.exec(sql)![1];
        const partitioned = LEDGER_KEYED_TABLES.find((t) => t.table === table)!.partitionSize !== undefined;
        expect(sql.includes('IN PARTITION')).toBe(partitioned);
      }
    });

    it('does not touch partitions at or below the checkpoint partition, only the partitions above it', async () => {
      const svc = await freshService();
      // cp is the 40th ledger, in P6 partition 11 / P7 partition 1: partitions 1 and 2 (P6) and 0 (P7) are older.
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));
      await insertUncommitted(svc, BUILT.slice(committed));
      await insertSeededRows(svc, BUILT);

      const params: unknown[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, p, opts) => {
        if (/IN PARTITION/.test(sql)) params.push({ sql, ...p });
        await real(sql, p, opts);
      });
      await deleteLedgersAbove(svc, index(committed - 1));

      const partitionsOf = (table: string): number[] =>
        (params as Array<{ sql: string; partition: string }>)
          .filter((p) => new RegExp(`DELETE FROM ${table} `).test(p.sql))
          .map((p) => Number(p.partition))
          .sort((a, b) => a - b);
      expect(partitionsOf(Table.Transactions)).toEqual([11, 20, 29]);
      // Ledger 20,005,122 has transactions but no payment, so payments has no partition 20.
      expect(partitionsOf(Table.Payments)).toEqual([11, 29]);
      expect(partitionsOf(Table.TxByHash)).toEqual([1, 2]);
      // The AMM, NFT, account domain and object tables are P7 like tx_by_hash, but the touches of a pool, the NFT sales and
      // the NFT touches, which are P6 like transactions.
      for (const table of SEEDED_LEDGER_TABLES) {
        const partitions = SEEDED_P6_TABLES.includes(table) ? [11, 20, 29] : [1, 2];
        expect([table, partitionsOf(table)]).toEqual([table, partitions]);
      }
    });

    it('is a no-op on committed data when nothing is above the checkpoint', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await deleteLedgersAbove(svc, index(53));
      await expectStored(svc, BUILT);
    });

    it('cleans up a failed write so a new LedgerWriter can redo it without duplicates', async () => {
      const svc = await freshService();
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));

      // The commit marker fails: children and ledger_by_hash are in, the ledgers rows are not.
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(new LedgerWriter(svc, ctx).write(LEDGERS.slice(committed))).rejects.toThrow('commit failed');
      failing.mockRestore();

      const cp = await committedCheckpoint(svc);
      expect(cp).toBe(index(committed - 1));
      expect((await storedCounts(svc))[Table.Payments]).toBe(expectedCounts()[Table.Payments]);
      expect(await missingLedgers(svc, index(committed), index(committed))).toEqual([index(committed)]);

      await deleteLedgersAbove(svc, cp!);
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(committed));

      await expectStored(svc, BUILT);
      expect(await committedCheckpoint(svc)).toBe(index(53));
    });

    it('documents the dedup pitfall: a writer that outlives the delete has its child rows dropped, so recovery needs a new LedgerWriter', async () => {
      const svc = await freshService();
      const survivor = new LedgerWriter(svc, ctx, { runId: 'survivor' });
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(survivor.write(LEDGERS)).rejects.toThrow('commit failed');
      failing.mockRestore();

      await deleteLedgersAbove(svc, 0);
      expect(await count(svc, Table.Payments)).toBe(0);

      // The dedup log still remembers the tokens of the first attempt, so the same writer re-inserts nothing but the
      // commit marker: ledgers claim to be committed, their rows are gone.
      await survivor.write(LEDGERS);
      expect(await count(svc, Table.Ledgers)).toBe(54);
      expect(await count(svc, Table.Payments)).toBe(0);
    });
  });

  describe('withNewRunId', () => {
    it('returns a writer with a fresh runId (or the given one) and the same limits', async () => {
      const svc = await freshService();
      const writer = new LedgerWriter(svc, ctx, { runId: 'first', maxRowsPerInsert: 100 });

      const rotated = writer.withNewRunId();
      expect(rotated).not.toBe(writer);
      expect(rotated.runId).not.toBe('first');
      expect(rotated.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(writer.withNewRunId('given').runId).toBe('given');
      expect(writer.runId).toBe('first');

      const spy = jest.spyOn(svc, 'insert');
      await rotated.write(LEDGERS);
      expect(spy.mock.calls.filter((c) => c[0] === Table.Transactions)).toHaveLength(Math.ceil(933 / 100));
    });

    it('lets a writer that failed rewrite after deleteLedgersAbove without losing its child rows', async () => {
      const svc = await freshService();
      const failedWriter = new LedgerWriter(svc, ctx, { runId: 'failed-run' });
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(failedWriter.write(LEDGERS)).rejects.toThrow('commit failed');
      failing.mockRestore();

      await deleteLedgersAbove(svc, 0);
      expect(await count(svc, Table.Payments)).toBe(0);

      await failedWriter.withNewRunId().write(LEDGERS);

      await expectStored(svc, BUILT);
      expect(await count(svc, Table.Payments)).toBe(182);
    });
  });

  describe('deleteLedgerRange', () => {
    it('deletes the ledgers in [from, to] from every ledger-keyed table, across partitions, and keeps the rest', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await insertSeededRows(svc, BUILT);

      // P6 partitions 2, 11 and 20 and P7 partitions 0, 1 and 2 are touched; the first and the last two ledgers stay.
      const from = index(1);
      const to = index(51);
      expect(to).toBe(20_005_122);
      await deleteLedgerRange(svc, from, to);

      const kept = (i: number): boolean => i < from || i > to;
      await expectStored(svc, BUILT, kept, BUILT);
      // The seeded tables lose the rows of the range and keep the three ledgers outside it.
      for (const table of SEEDED_LEDGER_TABLES) expect([table, await countSeeded(svc, table)]).toEqual([table, 3]);
      expect(await committedCheckpoint(svc)).toBe(index(53));
    });

    it('deletes a range that sits inside a partition and leaves the neighbours in it', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      await deleteLedgerRange(svc, 11_119_600, 11_119_604);

      await expectStored(svc, BUILT, (i) => i < 11_119_600 || i > 11_119_604);
    });

    it('lets a ledger range be rewritten by a new writer without duplicates', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      await deleteLedgerRange(svc, index(10), index(20));
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(10, 21));

      await expectStored(svc, BUILT);
    });

    it('removes the commit marker first: a range delete never leaves a ledgers row without its rows', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      const order: string[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        order.push(/^\s*DELETE FROM (\w+)/.exec(sql)?.[1] ?? sql);
        await real(sql, params, opts);
      });
      await deleteLedgerRange(svc, index(0), index(53));

      expect(order[0]).toBe(Table.Ledgers);
    });
  });

  describe('AMM ledgers (whole mainnet ledgers around the recorded AMM cases)', () => {
    /** The rows of an AMM table as ClickHouse returns them, close_time as unix seconds, in the order of `orderBy`. */
    async function readBack(svc: ClickHouseService, table: Table, orderBy: string): Promise<Array<Json>> {
      // the touches of a pool have no time
      if (table === Table.AmmPoolTouches) return svc.query<Json>(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      return svc.query<Json>(
        `SELECT * EXCEPT close_time, toUnixTimestamp(close_time) AS close_time FROM ${table} ORDER BY ${orderBy}`,
      );
    }

    const AMM_KEYS: Array<[Table, ChildRowsKey, string]> = [
      [Table.AmmPoolStates, 'ammPoolStates', 'amm_account, ledger_index, tx_index'],
      [Table.AmmPoolTouches, 'ammPoolTouches', 'ledger_index, tx_index, amm_account'],
      [Table.AmmLiquidity, 'ammLiquidity', 'amm_account, ledger_index, tx_index'],
      [Table.AccountAmmLiquidity, 'accountAmmLiquidity', 'account, ledger_index, tx_index, amm_account'],
      [Table.AmmGovernance, 'ammGovernance', 'amm_account, ledger_index, tx_index'],
    ];

    it('the fixtures put rows into all five AMM tables, and AMM swaps into exchanges', () => {
      const expected = expectedAmmCounts();
      for (const table of AMM_LEDGER_TABLES) expect([table, expected[table] > 0]).toEqual([table, true]);
      const swaps = AMM_BUILT.flatMap((r) => r.exchanges).filter((e) => e.amm_account !== '');
      expect(swaps.length).toBeGreaterThan(10);
    });

    it('an AMM ledger lands in all five tables: counts and every row as built, and the unclassified count is reported', async () => {
      const svc = await freshService();
      const result = await new LedgerWriter(svc, ctx).write(AMM_LEDGERS);

      await expectStored(svc, AMM_BUILT);
      expect(result).toEqual({
        ammUnclassified: AMM_BUILT.reduce((sum, r) => sum + r.diagnostics.ammUnclassified, 0),
        nftSkipped: 0,
        objectsUnclassified: AMM_BUILT.reduce((sum, r) => sum + r.diagnostics.objectsUnclassified, 0),
        importMintedNegative: 0,
      });
      for (const [table, key, orderBy] of AMM_KEYS) {
        const built = AMM_BUILT.flatMap((r) => r[key] as unknown as Json[]);
        const orderKeys = orderBy.split(', ');
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderKeys)]);
      }
      // AMM swaps are exchanges next to the order-book trades; the pool is the provider of an offer without sequence.
      const stored = await svc.queryOne<{ n: string | number; offers: string | number }>(
        `SELECT count() AS n, countIf(provider = amm_account AND offer_sequence = 0) AS offers
           FROM ${Table.Exchanges} WHERE amm_account != ''`,
      );
      const swaps = AMM_BUILT.flatMap((r) => r.exchanges).filter((e) => e.amm_account !== '').length;
      expect([Number(stored?.n), Number(stored?.offers)]).toEqual([swaps, swaps]);
    });

    it('inserts the AMM tables with the other child tables: a token per chunk, all done before ledger_by_hash and the commit marker', async () => {
      const svc = await freshService();
      const events: string[] = [];
      const calls: Array<{ table: string; rows: number; token: string | undefined }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        events.push(`start:${table}`);
        calls.push({ table, rows: rows.length, token: opts?.dedupToken });
        await real(table, rows, opts);
        events.push(`end:${table}`);
      });

      await new LedgerWriter(svc, ctx, { runId: 'amm-order', maxRowsPerInsert: 40 }).write(AMM_LEDGERS);

      const span = `${aIndex(0)}-${aIndex(AMM_LEDGERS.length - 1)}`;
      const expected = expectedAmmCounts();
      for (const table of AMM_LEDGER_TABLES) {
        const mine = calls.filter((c) => c.table === table);
        expect([table, expected[table] > 0, mine.length]).toEqual([table, true, Math.ceil(expected[table] / 40)]);
        expect(mine.map((c) => c.rows).reduce((a, b) => a + b, 0)).toBe(expected[table]);
        expect(mine.every((c) => c.rows <= 40)).toBe(true);
        expect(mine.map((c) => c.token)).toEqual(mine.map((_, n) => `amm-order:${table}:${span}:${n}`));
      }
      // The child tables that have rows, the AMM ones among them, start before the first of them has finished (these ledgers
      // have NFT events, but no sale: `nft_sales` gets no insert) ...
      const withInsert = CHILD_TABLES.filter(([, key]) => AMM_BUILT.some((rows) => rows[key].length > 0));
      const childStarts = withInsert.map(([t]) => events.indexOf(`start:${t}`));
      const firstEnd = events.findIndex((e) => e.startsWith('end:'));
      expect(childStarts.every((at) => at >= 0 && at < firstEnd)).toBe(true);
      // ... and all of them are done before ledger_by_hash and then the commit marker.
      const childTables = new Set<string>(CHILD_TABLES.map(([t]) => t));
      const lastChildEnd = Math.max(
        ...events.map((e, i) => (e.startsWith('end:') && childTables.has(e.slice(4)) ? i : -1)),
      );
      expect(events.indexOf(`start:${Table.LedgerByHash}`)).toBeGreaterThan(lastChildEnd);
      expect(events[events.length - 1]).toBe(`end:${Table.Ledgers}`);
    });

    it('reports nothing unclassified for a batch without AMM activity', async () => {
      const svc = await freshService();
      expect(await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, 5))).toEqual({
        ammUnclassified: 0,
        nftSkipped: 0,
        objectsUnclassified: 0,
        importMintedNegative: 0,
      });
      expect(await new LedgerWriter(svc, ctx).write([])).toEqual({
        ammUnclassified: 0,
        nftSkipped: 0,
        objectsUnclassified: 0,
        importMintedNegative: 0,
      });
    });

    it('a retry of the same batch under the same runId is collapsed by the dedup token, a new runId is not', async () => {
      const svc = await freshService();
      // Merges are stopped, so it is the insert dedup token and not a merge that keeps the count.
      for (const table of AMM_LEDGER_TABLES) await svc.command(`SYSTEM STOP MERGES ${table}`);
      try {
        await new LedgerWriter(svc, ctx, { runId: 'amm-retry' }).write(AMM_LEDGERS);
        await new LedgerWriter(svc, ctx, { runId: 'amm-retry' }).write(AMM_LEDGERS);
        await expectStored(svc, AMM_BUILT);
        for (const table of AMM_LEDGER_TABLES) expect([table, (await count(svc, table)) > 0]).toEqual([table, true]);

        // Without the token the same rows are real duplicates: stored twice, until a merge.
        const expected = expectedAmmCounts();
        for (const table of AMM_LEDGER_TABLES) {
          await svc.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
          expect([table, await count(svc, table)]).toEqual([table, 2 * expected[table]]);
        }
      } finally {
        for (const table of AMM_LEDGER_TABLES) await svc.command(`SYSTEM START MERGES ${table}`);
      }
      for (const table of AMM_LEDGER_TABLES) {
        await svc.command(`OPTIMIZE TABLE ${table} FINAL`);
        const key = (
          await svc.queryOne<{ sorting_key: string }>(
            'SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {t:String}',
            { t: table },
          )
        )?.sorting_key;
        const row = await svc.queryOne<{ n: string | number; u: string | number }>(
          `SELECT count() AS n, uniqExact(${key}) AS u FROM ${table}`,
        );
        expect([table, Number(row?.n), Number(row?.u)]).toEqual([
          table,
          expectedAmmCounts()[table],
          expectedAmmCounts()[table],
        ]);
      }
    });

    it.each([Table.LedgerByHash, Table.Ledgers])(
      'a failure of the %s insert, after the child inserts, leaves no orphan in the AMM tables once recovery is through',
      async (failingTable) => {
        const svc = await freshService();
        // Six committed ledgers (they hold a bid), then a batch whose last inserts fail (it holds a vote).
        const committed = 6;
        await new LedgerWriter(svc, ctx).write(AMM_LEDGERS.slice(0, committed));
        const checkpoint = aIndex(committed - 1);
        const survivors = expectedAmmCounts((i) => i <= checkpoint);
        for (const table of AMM_LEDGER_TABLES) expect([table, survivors[table] > 0]).toEqual([table, true]);

        const failed = new LedgerWriter(svc, ctx, { runId: 'amm-fail' });
        const real = svc.insert.bind(svc);
        const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
          if (table === failingTable) throw new Error('injected failure after the child rows');
          await real(table, rows, opts);
        });
        await expect(failed.write(AMM_LEDGERS.slice(committed))).rejects.toThrow('injected failure');
        failing.mockRestore();

        // The child rows are in, the ledgers are not committed.
        expect(await committedCheckpoint(svc)).toBe(checkpoint);
        for (const table of AMM_LEDGER_TABLES) {
          expect([table, (await rowsAbove(svc, checkpoint))[table] > 0]).toEqual([table, true]);
        }

        // The recovery contract of LedgerWriter.
        await awaitQuiescence(svc, failed.runId);
        const cp = await committedCheckpoint(svc);
        expect(cp).toBe(checkpoint);
        await deleteLedgersAbove(svc, cp!, { queryIdPrefix: 'amm-recover' });
        await awaitQuiescence(svc, 'amm-recover');

        expect(await rowsAbove(svc, checkpoint)).toEqual(Object.fromEntries(ALL_TABLES.map((t) => [t, 0])));
        // The AMM rows of the committed ledgers were not touched.
        await expectStored(svc, AMM_BUILT, (i) => i <= checkpoint);

        await failed.withNewRunId().write(AMM_LEDGERS.slice(committed));
        await expectStored(svc, AMM_BUILT);
        expect(await committedCheckpoint(svc)).toBe(aIndex(AMM_LEDGERS.length - 1));
      },
    );

    it('deleteLedgersAbove keeps the AMM rows of committed ledgers and removes those of uncommitted ones, table by table', async () => {
      const svc = await freshService();
      const committed = 6;
      await new LedgerWriter(svc, ctx).write(AMM_LEDGERS.slice(0, committed));
      const before = await Promise.all(AMM_KEYS.map(([table, , orderBy]) => readBack(svc, table, orderBy)));
      for (const rows of before) expect(rows.length).toBeGreaterThan(0);
      await insertUncommitted(svc, AMM_BUILT.slice(committed));

      await deleteLedgersAbove(svc, aIndex(committed - 1));

      const after = await Promise.all(AMM_KEYS.map(([table, , orderBy]) => readBack(svc, table, orderBy)));
      expect(after).toEqual(before);
      await expectStored(svc, AMM_BUILT, (i) => i <= aIndex(committed - 1));
    });

    it('deleteLedgerRange removes the AMM rows of the range and keeps those outside it, table by table', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(AMM_LEDGERS);

      const from = aIndex(2);
      const to = aIndex(12);
      await deleteLedgerRange(svc, from, to);

      const kept = (i: number): boolean => i < from || i > to;
      await expectStored(svc, AMM_BUILT, kept);
      // Rows are gone from the range and are all there outside it, as built.
      for (const [table, key, orderBy] of AMM_KEYS) {
        const built = AMM_BUILT.filter((r) => kept(r.ledger.ledger_index)).flatMap((r) => r[key] as unknown as Json[]);
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
        expect([table, await count(svc, table, `ledger_index >= ${from} AND ledger_index <= ${to}`)]).toEqual([
          table,
          0,
        ]);
      }

      // And the range can be written again without duplicates.
      await new LedgerWriter(svc, ctx).write(AMM_LEDGERS.slice(2, 13));
      await expectStored(svc, AMM_BUILT);
    });
  });

  describe('NFT ledgers (whole mainnet ledgers around the recorded NFT cases)', () => {
    /** The rows of an NFT table as ClickHouse returns them, times as unix seconds (`expiration` stays NULL), in the order of `orderBy`. */
    async function readBack(svc: ClickHouseService, table: Table, orderBy: string): Promise<Array<Json>> {
      // the touches of an NFT have no time
      if (table === Table.NftTouches) return svc.query<Json>(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      return svc.query<Json>(
        `SELECT * EXCEPT (close_time, expiration), toUnixTimestamp(close_time) AS close_time,
                toUnixTimestamp(expiration) AS expiration FROM ${table} ORDER BY ${orderBy}`,
      );
    }

    const NFT_KEYS: Array<[Table, ChildRowsKey, string]> = [
      [Table.NftEvents, 'nftEvents', 'nft_id, ledger_index, tx_index, event_index'],
      [Table.AccountNftEvents, 'accountNftEvents', 'account, ledger_index, tx_index, event_index'],
      [Table.CollectionNftEvents, 'collectionNftEvents', 'issuer, taxon_key, ledger_index, tx_index, event_index'],
      [Table.NftSales, 'nftSales', 'ledger_index, tx_index, event_index'],
      [Table.NftTouches, 'nftTouches', 'ledger_index, tx_index, nft_id'],
    ];

    /** The recorded sell offer and buy offer of ledger 107886233, the last of the NFT ledgers. */
    const OFFERS_OF_LAST = [
      'BB9BE0C948CB66FB19AD53AA77C6C4FA664D825AA3B7C3CA2397DC2D091B5BD9',
      'AD1F852CF41E0AB3CB234950F2679B96931D3FCC62E17DC264695681DA5B7034',
    ];

    it('the fixtures put rows into all five NFT tables', () => {
      const expected = expectedNftCounts();
      for (const table of NFT_LEDGER_TABLES) expect([table, expected[table] > 0]).toEqual([table, true]);
    });

    it('an NFT ledger lands in all five tables: counts and every row as built, and nothing is reported skipped', async () => {
      const svc = await freshService();
      const result = await new LedgerWriter(svc, ctx).write(NFT_LEDGERS);

      await expectStored(svc, NFT_BUILT);
      expect(result).toEqual({
        ammUnclassified: NFT_BUILT.reduce((sum, r) => sum + r.diagnostics.ammUnclassified, 0),
        nftSkipped: 0,
        objectsUnclassified: NFT_BUILT.reduce((sum, r) => sum + r.diagnostics.objectsUnclassified, 0),
        importMintedNegative: 0,
      });
      for (const [table, key, orderBy] of NFT_KEYS) {
        const built = NFT_BUILT.flatMap((r) => r[key] as unknown as Json[]);
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
      }
    });

    it('reports the events the parser skipped, summed over the batch, and writes no row for them (synthetic-mpt-offer: the two recorded offers of the last ledger priced with an MPT amount)', async () => {
      const svc = await freshService();
      const last = NFT_LEDGERS[NFT_LEDGERS.length - 1];
      // synthetic-mpt-offer: hand-made from the two recorded offers (test/synthetic-mpt-offers.ts), each under a hash of its own
      const batch = [...NFT_LEDGERS.slice(0, -1), withMptOffers(last, OFFERS_OF_LAST)];

      const result = await new LedgerWriter(svc, ctx).write(batch);

      // Two offers of the last ledger have an MPT amount: no event for either, and the transactions are all there, under the
      // hashes of the synthetic ones and not the recorded ones.
      expect(result.nftSkipped).toBe(2);
      const expected = expectedNftCounts();
      expect(await count(svc, Table.NftEvents)).toBe(expected[Table.NftEvents] - 2);
      expect(await count(svc, Table.NftTouches)).toBe(expected[Table.NftTouches] - 2);
      expect(await count(svc, Table.Transactions)).toBe(expected[Table.Transactions]);
      const list = (hashes: string[]) => hashes.map((hash) => `'${hash}'`).join(', ');
      const altered = OFFERS_OF_LAST.map(mptOfferHash);
      expect(await count(svc, Table.Transactions, `hash IN (${list(altered)})`)).toBe(2);
      expect(await count(svc, Table.Transactions, `hash IN (${list(OFFERS_OF_LAST)})`)).toBe(0);
      expect(await count(svc, Table.NftEvents, `tx_hash IN (${list(altered)})`)).toBe(0);
    });

    it('a ripple-mock ledger writes no NFT row', async () => {
      const svc = await freshService();
      const spy = jest.spyOn(svc, 'insert');

      const result = await new LedgerWriter(svc, ctx).write(LEDGERS);

      // The ripple-mock ledgers (2021) have no NFT activity: the five tables get no insert and hold no row.
      expect(result.nftSkipped).toBe(0);
      expect(spy.mock.calls.filter((call) => NFT_LEDGER_TABLES.includes(call[0] as Table))).toEqual([]);
      for (const table of NFT_LEDGER_TABLES) expect([table, await count(svc, table)]).toEqual([table, 0]);
      expect(await count(svc, Table.Ledgers)).toBe(LEDGERS.length);
    });

    it('deleteLedgersAbove keeps the NFT rows of committed ledgers and removes those of uncommitted ones, table by table', async () => {
      const svc = await freshService();
      const committed = 6;
      await new LedgerWriter(svc, ctx).write(NFT_LEDGERS.slice(0, committed));
      const before = await Promise.all(NFT_KEYS.map(([table, , orderBy]) => readBack(svc, table, orderBy)));
      for (const rows of before) expect(rows.length).toBeGreaterThan(0);
      await insertUncommitted(svc, NFT_BUILT.slice(committed));

      await deleteLedgersAbove(svc, nIndex(committed - 1));

      const after = await Promise.all(NFT_KEYS.map(([table, , orderBy]) => readBack(svc, table, orderBy)));
      expect(after).toEqual(before);
      await expectStored(svc, NFT_BUILT, (i) => i <= nIndex(committed - 1));
    });

    it('deleteLedgerRange removes the NFT rows of the range and keeps those outside it, table by table', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(NFT_LEDGERS);

      const from = nIndex(2);
      const to = nIndex(8);
      await deleteLedgerRange(svc, from, to);

      const kept = (i: number): boolean => i < from || i > to;
      await expectStored(svc, NFT_BUILT, kept);
      for (const [table, key, orderBy] of NFT_KEYS) {
        const built = NFT_BUILT.filter((r) => kept(r.ledger.ledger_index)).flatMap((r) => r[key] as unknown as Json[]);
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
        expect([table, await count(svc, table, `ledger_index >= ${from} AND ledger_index <= ${to}`)]).toEqual([
          table,
          0,
        ]);
      }

      // And the range can be written again without duplicates.
      await new LedgerWriter(svc, ctx).write(NFT_LEDGERS.slice(2, 9));
      await expectStored(svc, NFT_BUILT);
    });
  });

  describe('Object ledgers (whole mainnet ledgers around the recorded escrow, check, channel and delegation cases)', () => {
    /** The rows of an object table as ClickHouse returns them, `close_time` as unix seconds, in the order of `orderBy`. */
    async function readBack(svc: ClickHouseService, table: Table, orderBy: string): Promise<Array<Json>> {
      // the index by account has no time
      if (table === Table.AccountObjectChanges) return svc.query<Json>(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      return svc.query<Json>(
        `SELECT * EXCEPT close_time, toUnixTimestamp(close_time) AS close_time FROM ${table} ORDER BY ${orderBy}`,
      );
    }

    const OBJECT_KEYS: Array<[Table, ChildRowsKey, string]> = [
      [Table.ObjectChanges, 'objectChanges', 'object_type, object_id, ledger_index, tx_index'],
      [
        Table.AccountObjectChanges,
        'accountObjectChanges',
        'account, object_type, role, ledger_index, tx_index, object_id',
      ],
    ];

    it('the fixtures put rows into both object tables, and nothing is unclassified', () => {
      const expected = expectedObjectCounts();
      for (const table of OBJECT_LEDGER_TABLES) expect([table, expected[table] > 0]).toEqual([table, true]);
      expect(OBJECT_BUILT.reduce((sum, r) => sum + r.diagnostics.objectsUnclassified, 0)).toBe(0);
    });

    it('an object ledger lands in both tables: counts and every row as built, and nothing is reported unclassified', async () => {
      const svc = await freshService();
      const result = await new LedgerWriter(svc, ctx).write(OBJECT_LEDGERS);

      await expectStored(svc, OBJECT_BUILT);
      expect(result).toEqual({
        ammUnclassified: OBJECT_BUILT.reduce((sum, r) => sum + r.diagnostics.ammUnclassified, 0),
        nftSkipped: 0,
        objectsUnclassified: 0,
        importMintedNegative: 0,
      });
      for (const [table, key, orderBy] of OBJECT_KEYS) {
        const built = OBJECT_BUILT.flatMap((r) => r[key] as unknown as Json[]);
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
      }
    });

    it('reports the changes the parser could give no event, summed over the batch, and still writes their rows (synthetic-object-update: a recorded EscrowCreate and CheckCreate sent as AccountSet)', async () => {
      const svc = await freshService();
      // synthetic-object-update: hand-made from the recorded escrow_create_timed and check_create_xrp, the transaction type
      // of each replaced by one the object history does not expect to create or change an escrow or a check
      const batch = structuredClone(OBJECT_LEDGERS);
      const altered = ['escrow_create_timed', 'check_create_xrp'].map((name) => {
        const { ledger, tx } = objectCase('xrpl', name)!;
        const copy = batch
          .find((l) => l.header.ledger_index === ledger.header.ledger_index)!
          .transactions.find((r) => r.hash === tx.hash)!;
        copy.tx.TransactionType = 'AccountSet';
        return tx.hash;
      });

      const result = await new LedgerWriter(svc, ctx).write(batch);

      expect(result.objectsUnclassified).toBe(2);
      // the rows are there as for the recorded transactions, but for the event
      const expected = expectedObjectCounts();
      expect(await count(svc, Table.ObjectChanges)).toBe(expected[Table.ObjectChanges]);
      expect(await count(svc, Table.AccountObjectChanges)).toBe(expected[Table.AccountObjectChanges]);
      expect(await count(svc, Table.ObjectChanges, "event = 'update'")).toBe(2);
      const list = altered.map((hash) => `'${hash}'`).join(', ');
      expect(await count(svc, Table.ObjectChanges, `event = 'update' AND tx_hash IN (${list})`)).toBe(2);
    });

    it('a retry of the same batch under the same runId is collapsed by the dedup token, a new runId is not', async () => {
      const svc = await freshService();
      // Merges are stopped, so it is the insert dedup token and not a merge that keeps the count.
      for (const table of OBJECT_LEDGER_TABLES) await svc.command(`SYSTEM STOP MERGES ${table}`);
      try {
        await new LedgerWriter(svc, ctx, { runId: 'object-retry' }).write(OBJECT_LEDGERS);
        await new LedgerWriter(svc, ctx, { runId: 'object-retry' }).write(OBJECT_LEDGERS);
        await expectStored(svc, OBJECT_BUILT);

        // Without the token the same rows are real duplicates: stored twice, until a merge.
        const expected = expectedObjectCounts();
        for (const table of OBJECT_LEDGER_TABLES) {
          await svc.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
          expect([table, await count(svc, table)]).toEqual([table, 2 * expected[table]]);
        }
      } finally {
        for (const table of OBJECT_LEDGER_TABLES) await svc.command(`SYSTEM START MERGES ${table}`);
      }
      for (const table of OBJECT_LEDGER_TABLES) {
        await svc.command(`OPTIMIZE TABLE ${table} FINAL`);
        expect([table, await count(svc, table)]).toEqual([table, expectedObjectCounts()[table]]);
      }
    });

    it.each([Table.LedgerByHash, Table.Ledgers])(
      'a failure of the %s insert, after the child inserts, leaves no object row above the checkpoint once recovery is through',
      async (failingTable) => {
        const svc = await freshService();
        // Committed ledgers with object rows, then a batch with object rows whose last inserts fail.
        const committed = 10;
        await new LedgerWriter(svc, ctx).write(OBJECT_LEDGERS.slice(0, committed));
        const checkpoint = oIndex(committed - 1);
        const survivors = expectedObjectCounts((i) => i <= checkpoint);
        const all = expectedObjectCounts();
        for (const table of OBJECT_LEDGER_TABLES) {
          expect([table, survivors[table] > 0, all[table] > survivors[table]]).toEqual([table, true, true]);
        }

        const failed = new LedgerWriter(svc, ctx, { runId: 'object-fail' });
        const real = svc.insert.bind(svc);
        const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
          if (table === failingTable) throw new Error('injected failure after the child rows');
          await real(table, rows, opts);
        });
        await expect(failed.write(OBJECT_LEDGERS.slice(committed))).rejects.toThrow('injected failure');
        failing.mockRestore();

        // The child rows are in, the ledgers are not committed.
        expect(await committedCheckpoint(svc)).toBe(checkpoint);
        for (const table of OBJECT_LEDGER_TABLES) {
          expect([table, (await rowsAbove(svc, checkpoint))[table] > 0]).toEqual([table, true]);
        }

        // The recovery contract of LedgerWriter.
        await awaitQuiescence(svc, failed.runId);
        const cp = await committedCheckpoint(svc);
        expect(cp).toBe(checkpoint);
        await deleteLedgersAbove(svc, cp!, { queryIdPrefix: 'object-recover' });
        await awaitQuiescence(svc, 'object-recover');

        expect(await rowsAbove(svc, checkpoint)).toEqual(Object.fromEntries(ALL_TABLES.map((t) => [t, 0])));
        for (const table of OBJECT_LEDGER_TABLES)
          expect([table, (await rowsAbove(svc, checkpoint))[table]]).toEqual([table, 0]);
        // The object rows of the committed ledgers were not touched.
        await expectStored(svc, OBJECT_BUILT, (i) => i <= checkpoint);

        await failed.withNewRunId().write(OBJECT_LEDGERS.slice(committed));
        await expectStored(svc, OBJECT_BUILT);
        expect(await committedCheckpoint(svc)).toBe(oIndex(OBJECT_LEDGERS.length - 1));
      },
    );

    it('deleteLedgerRange removes the object rows of the range and keeps those outside it, table by table', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(OBJECT_LEDGERS);

      const from = oIndex(4);
      const to = oIndex(15);
      await deleteLedgerRange(svc, from, to);

      const kept = (i: number): boolean => i < from || i > to;
      await expectStored(svc, OBJECT_BUILT, kept);
      for (const [table, key, orderBy] of OBJECT_KEYS) {
        const built = OBJECT_BUILT.filter((r) => kept(r.ledger.ledger_index)).flatMap(
          (r) => r[key] as unknown as Json[],
        );
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
        expect([table, await count(svc, table, `ledger_index >= ${from} AND ledger_index <= ${to}`)]).toEqual([
          table,
          0,
        ]);
      }

      // And the range can be written again without duplicates.
      await new LedgerWriter(svc, ctx).write(OBJECT_LEDGERS.slice(4, 16));
      await expectStored(svc, OBJECT_BUILT);
    });
  });

  describe('Xahau mint ledgers (the recorded Imports with their parents, and the two hand-made ledgers)', () => {
    const XAHAU_CTX = parseContextFor(getNetworkProfile('xahau'));
    const MINT_LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xahau/mint')).list();
    const MINT_BUILT = MINT_LEDGERS.map((raw) => buildLedgerRows(raw, XAHAU_CTX));

    /** The rows of a mint table as ClickHouse returns them, `close_time` as unix seconds, in the order of `orderBy`. */
    const readBack = (svc: ClickHouseService, table: Table, orderBy: string): Promise<Array<Json>> =>
      svc.query<Json>(
        `SELECT * EXCEPT close_time, toUnixTimestamp(close_time) AS close_time FROM ${table} ORDER BY ${orderBy}`,
      );

    /** A built row as it reads back: the drops of these fixtures are far below 2^53, so a UInt64 comes back as a number. */
    const asRead = (row: Json): Json => ({
      ...row,
      ...(typeof row.amount === 'string' ? { amount: Number(row.amount) } : {}),
      ...(typeof row.minted === 'string' ? { minted: Number(row.minted) } : {}),
    });

    const MINT_KEYS: Array<[Table, ChildRowsKey, string]> = [
      [Table.GenesisMints, 'genesisMints', 'ledger_index, tx_index, mint_index'],
      [Table.Imports, 'imports', 'ledger_index, tx_index'],
      [Table.RewardClaims, 'rewardClaims', 'ledger_index, tx_index'],
    ];

    /** `raw` as a ledger of its own: a deep copy at another index whose Imports each lost 1000 drops more than their Fee. */
    function withLostImports(raw: RawLedger, ledgerIndex: number): RawLedger {
      const copy = JSON.parse(JSON.stringify(raw)) as RawLedger;
      copy.header.ledger_index = ledgerIndex;
      copy.header.ledger_hash = ledgerIndex.toString(16).toUpperCase().padStart(64, '0');
      let lost = 0;
      for (const t of copy.transactions.filter((each) => each.tx.TransactionType === 'Import')) {
        for (const node of t.meta.AffectedNodes as Array<Record<string, any>>) {
          const modified = node.ModifiedNode;
          if (modified?.LedgerEntryType !== 'AccountRoot' || modified.FinalFields.Account !== t.tx.Account) continue;
          modified.FinalFields.Balance = String(BigInt(modified.PreviousFields.Balance) - 1000n);
          lost++;
        }
      }
      expect(lost).toBe(1);
      return copy;
    }

    it('lands in the three tables: counts and every row as built, and no clamped import is reported', async () => {
      const expected = countsOf(MINT_BUILT);
      // the two hand-made ledgers hold the mints (8 entries) and the claim (1); the two recorded Imports are the 2
      expect([Table.GenesisMints, Table.Imports, Table.RewardClaims].map((t) => expected[t])).toEqual([8, 2, 1]);

      const svc = await freshService();
      const result = await new LedgerWriter(svc, XAHAU_CTX).write(MINT_LEDGERS);

      await expectStored(svc, MINT_BUILT);
      expect(result).toEqual({ ammUnclassified: 0, nftSkipped: 0, objectsUnclassified: 0, importMintedNegative: 0 });
      for (const [table, key, orderBy] of MINT_KEYS) {
        const built = MINT_BUILT.flatMap((r) => r[key] as unknown as Json[]).map(asRead);
        expect([table, await readBack(svc, table, orderBy)]).toEqual([table, sortedBy(built, orderBy.split(', '))]);
      }
    });

    it('sums the clamped imports of the batch into importMintedNegative, and stores them with minted 0', async () => {
      const existing = MINT_LEDGERS.find((l) => l.header.ledger_index === 2609053)!;
      const lost = [withLostImports(existing, 2609054), withLostImports(existing, 2609055)];
      expect(lost.map((raw) => buildLedgerRows(raw, XAHAU_CTX).diagnostics.importMintedNegative)).toEqual([1, 1]);

      const svc = await freshService();
      const result = await new LedgerWriter(svc, XAHAU_CTX).write([...MINT_LEDGERS, ...lost]);
      expect(result.importMintedNegative).toBe(2);
      expect(
        await svc.query(
          `SELECT ledger_index, toString(minted) AS minted FROM ${Table.Imports} WHERE ledger_index > 2609053 AND ledger_index < 3000000 ORDER BY ledger_index`,
        ),
      ).toEqual([
        { ledger_index: 2609054, minted: '0' },
        { ledger_index: 2609055, minted: '0' },
      ]);
      // (the copies repeat the transactions of 2609053, so tx_by_hash collapses them: the mint tables are counted alone)
      expect(await count(svc, Table.Imports)).toBe(2 + 2);
      expect(await count(svc, Table.Ledgers)).toBe(MINT_LEDGERS.length + 2);
    });

    it('recovery deletes the mint rows above a checkpoint, and keeps the ones below', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, XAHAU_CTX).write(MINT_LEDGERS);
      const checkpoint = 2609053;
      await deleteLedgersAbove(svc, checkpoint);
      const keep = (i: number): boolean => i <= checkpoint;
      await expectStored(svc, MINT_BUILT, keep);
      expect(await count(svc, Table.Imports)).toBe(1);
      expect(await count(svc, Table.GenesisMints)).toBe(0);
      expect(await count(svc, Table.RewardClaims)).toBe(0);
    });
  });

  describe('query ids', () => {
    /** Finished queries with an id under `prefix`, from the query log. */
    async function loggedQueries(svc: ClickHouseService, prefix: string): Promise<string[]> {
      await svc.command('SYSTEM FLUSH LOGS');
      const rows = await svc.query<{ query_id: string }>(
        `SELECT query_id FROM system.query_log
          WHERE type = 'QueryFinish' AND startsWith(query_id, {prefix:String}) ORDER BY query_id`,
        { prefix },
      );
      return rows.map((r) => r.query_id);
    }

    it('LedgerWriter sends every insert with the dedup token as its query_id', async () => {
      const svc = await freshService();
      const seen: Array<{ table: string; queryId?: string; dedupToken?: string }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        seen.push({ table, queryId: opts?.queryId, dedupToken: opts?.dedupToken });
        await real(table, rows, opts);
      });

      await new LedgerWriter(svc, ctx, { runId: 'qid-run', maxRowsPerInsert: 100 }).write(LEDGERS);

      expect(seen.length).toBeGreaterThan(CHILD_TABLES.length);
      for (const call of seen) {
        expect(call.queryId).toBe(call.dedupToken);
        expect(call.queryId).toMatch(new RegExp(`^qid-run:${call.table}:${index(0)}-${index(53)}:\\d+$`));
      }
      // The server saw them: one finished INSERT per call, under the runId.
      jest.restoreAllMocks();
      const logged = (await loggedQueries(svc, 'qid-run:')).sort();
      expect(logged).toEqual(seen.map((c) => c.queryId!).sort());
    });

    it('an insert with a query_id shows up in system.processes while it runs', async () => {
      const svc = await freshService();
      // A column whose default sleeps makes a real INSERT slow enough to catch.
      await svc.command(
        'CREATE TABLE slow_insert (a UInt8, b UInt8 DEFAULT toUInt8(sleepEachRow(0.4))) ENGINE = Memory',
      );

      const running = svc.insert('slow_insert', [{ a: 1 }, { a: 2 }, { a: 3 }], { queryId: 'live:insert:1' });
      const seen = await eventually(async () => (await runningQueryIds(svc, 'live:')).length > 0);
      await running;

      expect(seen).toBe(true);
      expect(await runningQueryIds(svc, 'live:')).toEqual([]);
      expect(await count(svc, 'slow_insert')).toBe(3);
    });

    it('deleteLedgersAbove and deleteLedgerRange tag each statement and make the lightweight delete synchronous', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await insertSeededRows(svc, BUILT);
      const calls: Array<{ sql: string; queryId?: string; sync?: unknown }> = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        calls.push({ sql, queryId: opts?.queryId, sync: opts?.settings?.lightweight_deletes_sync });
        await real(sql, params, opts);
      });

      await deleteLedgersAbove(svc, index(39), { queryIdPrefix: 'tagged-above' });
      await deleteLedgerRange(svc, index(0), index(10), { queryIdPrefix: 'tagged-range' });
      await deleteLedgerRange(svc, index(11), index(12));

      const deletes = calls.filter((c) => /^\s*DELETE FROM/.test(c.sql));
      expect(deletes.every((c) => c.sync === '2')).toBe(true);

      const ids = (prefix: string) => deletes.filter((c) => c.queryId?.startsWith(prefix)).map((c) => c.queryId!);
      for (const id of [...ids('tagged-above'), ...ids('tagged-range')]) {
        expect(id).toMatch(/^tagged-(above|range):delete:[a-z_]+:(\d+|all)$/);
      }
      expect(new Set(ids('tagged-above').map((id) => id.split(':')[2]))).toEqual(new Set(ALL_TABLES));
      expect(ids('tagged-above').find((id) => id.startsWith('tagged-above:delete:accounts_created:'))).toBe(
        'tagged-above:delete:accounts_created:all',
      );
      expect(ids('tagged-above')).toContain('tagged-above:delete:transactions:11');
      expect(new Set(ids('tagged-above')).size).toBe(ids('tagged-above').length);
      // Without a prefix there is no query_id.
      expect(
        deletes.slice(ids('tagged-above').length + ids('tagged-range').length).every((c) => c.queryId === undefined),
      ).toBe(true);

      // And the server ran exactly those statements under those ids.
      expect(await loggedQueries(svc, 'tagged-above:delete:')).toEqual(ids('tagged-above').sort());
    });
  });

  describe('awaitQuiescence', () => {
    /** Start a query that sleeps for about `seconds`, under a query_id, without waiting for it. */
    const sleeper = (svc: ClickHouseService, queryId: string, seconds: number): Promise<void> =>
      svc.raw
        .command({
          query: `SELECT sleepEachRow(0.25) FROM numbers(${Math.round(seconds * 4)}) SETTINGS max_block_size = 1`,
          query_id: queryId,
        })
        .then(() => undefined);

    it('returns immediately when nothing matches', async () => {
      const svc = await freshService();
      const started = Date.now();
      await awaitQuiescence(svc, 'nobody-runs-this', { pollMs: 5000, timeoutMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('waits for a long-running query with the prefix', async () => {
      const svc = await freshService();
      let done = false;
      const slow = sleeper(svc, 'quiet-run:slow:1', 1.5).then(() => {
        done = true;
      });
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-run')).length > 0)).toBe(true);

      await awaitQuiescence(svc, 'quiet-run', { pollMs: 50, timeoutMs: 20_000 });

      expect(done).toBe(true);
      await slow;
    });

    it('matches the prefix as a whole id part: a sibling runId is neither awaited nor killed', async () => {
      const svc = await freshService();
      const sibling = sleeper(svc, 'quiet-run2:slow:1', 1.5);
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-run2')).length > 0)).toBe(true);

      const started = Date.now();
      await awaitQuiescence(svc, 'quiet-run', { pollMs: 50, timeoutMs: 300 });

      expect(Date.now() - started).toBeLessThan(1000);
      await expect(sibling).resolves.toBeUndefined();
    });

    it('kills the queries that are still running after the timeout', async () => {
      const svc = await freshService();
      // The client warns when the socket of the query it is waiting for is closed by the kill (sometimes, depending on
      // timing): expected here, so it is kept out of the output; any other warning still goes through.
      const warn = console.warn.bind(console);
      jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('socket was closed or ended before the response was fully read')) warn(...args);
      });
      const stuck = sleeper(svc, 'quiet-kill:slow:1', 30);
      const outcome = stuck.then(
        () => 'finished',
        () => 'killed',
      );
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-kill')).length > 0)).toBe(true);

      const started = Date.now();
      await awaitQuiescence(svc, 'quiet-kill', { pollMs: 50, timeoutMs: 400 });

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await runningQueryIds(svc, 'quiet-kill')).toEqual([]);
      expect(await outcome).toBe('killed');
    });

    it('waits for pending mutations of the ledger tables, and throws when they cannot finish', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, 2));

      // With merges (and so mutations) stopped, an ALTER DELETE stays pending.
      await svc.command(`SYSTEM STOP MERGES ${Table.LedgerByHash}`);
      try {
        await svc.command(
          `ALTER TABLE ${Table.LedgerByHash} DELETE WHERE ledger_index < 0 SETTINGS mutations_sync = 0`,
        );
        await expect(awaitQuiescence(svc, 'quiet-mut', { pollMs: 50, timeoutMs: 300 })).rejects.toThrow(
          /not quiescent.*mutation/is,
        );
      } finally {
        await svc.command(`SYSTEM START MERGES ${Table.LedgerByHash}`);
      }
      await awaitQuiescence(svc, 'quiet-mut', { pollMs: 50, timeoutMs: 20_000 });
    });

    it('rejects an empty prefix: it would match every query', async () => {
      const svc = await freshService();
      await expect(awaitQuiescence(svc, '')).rejects.toThrow(/prefix/i);
    });
  });

  describe('schema contract', () => {
    it('LEDGER_KEYED_TABLES all have a dedup window, partitioned as declared; the collector tables are the only others', async () => {
      const svc = await freshService();
      const tables = await svc.query<{ name: string; partition_key: string }>(
        "SELECT name, partition_key FROM system.tables WHERE database = currentDatabase() AND engine_full LIKE '%non_replicated_deduplication_window%'",
      );
      const withWindow = new Set(tables.map((t) => t.name));
      for (const table of ALL_TABLES)
        expect({ table, hasWindow: withWindow.has(table) }).toEqual({ table, hasWindow: true });
      expect(withWindow).toEqual(new Set([...ALL_TABLES, ...COLLECTOR_DEDUP_TABLES]));
      // The ledgers table, ledger_by_hash and the child tables are exactly the ones LedgerWriter writes.
      const childTables = new Set(CHILD_TABLES.map(([t]) => t));
      expect(new Set(ALL_TABLES)).toEqual(new Set([Table.Ledgers, Table.LedgerByHash, ...childTables]));
      for (const table of [...AMM_LEDGER_TABLES, ...NFT_LEDGER_TABLES, ...OBJECT_LEDGER_TABLES])
        expect(childTables.has(table)).toBe(true);
      // The escrows aggregate is no ledger table: a ledger's rewrite never touches it.
      expect(ALL_TABLES).not.toContain(Table.Escrows);

      for (const { table, partitionSize } of LEDGER_KEYED_TABLES) {
        const stored = tables.find((t) => t.name === table)!.partition_key;
        expect([table, stored]).toEqual([
          table,
          partitionSize === undefined ? '' : `intDiv(ledger_index, ${partitionSize})`,
        ]);
      }
    });
  });
});

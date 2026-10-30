import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows, CHILD_TABLES, LedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { committedCheckpoint } from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const FIXTURES = join(__dirname, 'fixtures');

/** Every table `buildLedgerRows` fills, with the property of `LedgerRows` that holds its rows. */
const TABLES: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.Ledgers, 'ledger'],
  [Table.LedgerByHash, 'ledgerByHash'],
  ...CHILD_TABLES,
];

type Row = Record<string, unknown>;

/**
 * `account_domains` is ordered by account (spec 1.1, decision 7), so the rows of one account collapse: within one insert
 * (`optimize_on_insert`) and across inserts at the merges, whenever they run. Its row count is neither the number of rows
 * written nor stable, so the comparisons by count and by row leave it out and compare the newest row of each account
 * instead (`newestPerAccount`).
 */
const MERGED_TABLES: ReadonlySet<Table> = new Set([Table.AccountDomains]);
/** The tables whose stored rows are the rows written. */
const EXACT_TABLES: Table[] = TABLES.map(([table]) => table).filter((table) => !MERGED_TABLES.has(table));

/** The row with the largest `version` (decimal text: compared as a BigInt) of each account. */
function newestPerAccount(rows: Row[]): Row[] {
  const newest = new Map<string, Row>();
  for (const row of rows) {
    const known = newest.get(row.account as string);
    if (!known || BigInt(row.version as string) > BigInt(known.version as string))
      newest.set(row.account as string, row);
  }
  return [...newest.values()];
}

/** Reads give back what was written when UInt64 is quoted (exact) and DateTime is a unix timestamp. */
const READ_SETTINGS = {
  output_format_json_quote_64bit_integers: 1,
  date_time_output_format: 'unix_timestamp',
} as const;

/** Key order does not matter to ClickHouse or to a comparison of rows. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Row)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const asText = (rows: Row[]): string[] => rows.map((r) => JSON.stringify(canonical(r))).sort();

/** The first difference between two sets of rows, or `undefined` when they hold the same rows. */
function firstDifference(stored: Row[], written: Row[]): string | undefined {
  const a = asText(stored);
  const b = asText(written);
  if (a.length !== b.length) return `${a.length} rows stored, ${b.length} written`;
  const at = a.findIndex((text, i) => text !== b[i]);
  return at < 0 ? undefined : `row ${at}\n  stored:  ${a[at]}\n  written: ${b[at]}`;
}

interface Scenario {
  /** Test name. */
  name: string;
  database: string;
  network: 'xrpl' | 'xahau';
  dir: string;
  ledgers: number;
  /** The number of payments the Ripple Data API finds in these ledgers, when it is known. */
  payments?: number;
  /** The ledgers are the recorded NFT or URIToken cases: every NFT table gets rows. */
  nft?: boolean;
  /** The ledgers are the recorded escrow, check, channel and delegation cases: both object tables get rows. */
  objects?: boolean;
  /** The ledgers are the recorded AccountSet and Clawback cases of the token aggregate: `state_touches` gets rows of both kinds. */
  touches?: boolean;
  /** The ledgers are the recorded Xahau mint cases (Imports with their parent ledgers, and two hand-made ledgers): the three mint tables get rows. */
  mint?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'ripple-mock', database: 'rows_mock', network: 'xrpl', dir: 'xrpl/ripple-mock', ledgers: 54, payments: 182 },
  { name: 'recorded xrpl', database: 'rows_xrpl', network: 'xrpl', dir: 'xrpl/recorded', ledgers: 9 },
  // Whole ledgers around the recorded AMM cases: swaps, pool states, liquidity events, votes and bids.
  { name: 'recorded AMM', database: 'rows_amm', network: 'xrpl', dir: 'xrpl/amm', ledgers: 16 },
  { name: 'recorded xahau', database: 'rows_xahau', network: 'xahau', dir: 'xahau/recorded', ledgers: 6 },
  // A flag ledger: 22 UNLReport pseudo-transactions with Account "" (ruling R95).
  { name: 'xahau flag ledger', database: 'rows_xahau_flag', network: 'xahau', dir: 'xahau/flag', ledgers: 1 },
  // Whole ledgers around the recorded NFT cases: mints, offers, sales, burns and a modify; and around the URIToken cases.
  { name: 'recorded NFTs', database: 'rows_nft', network: 'xrpl', dir: 'xrpl/nft', ledgers: 11, nft: true },
  {
    name: 'recorded URITokens',
    database: 'rows_uritoken',
    network: 'xahau',
    dir: 'xahau/uritoken',
    ledgers: 9,
    nft: true,
  },
  // Whole ledgers around the recorded escrow, check, payment channel and delegation cases of both networks.
  {
    name: 'recorded objects xrpl',
    database: 'rows_objects_xrpl',
    network: 'xrpl',
    dir: 'xrpl/objects',
    ledgers: 22,
    objects: true,
  },
  {
    name: 'recorded objects xahau',
    database: 'rows_objects_xahau',
    network: 'xahau',
    dir: 'xahau/objects',
    ledgers: 12,
    objects: true,
  },
  // Whole ledgers around the recorded AccountSet (TransferRate, asfAllowTrustLineClawback) and Clawback cases: the touches of both kinds.
  {
    name: 'recorded state touches xrpl',
    database: 'rows_state_touches',
    network: 'xrpl',
    dir: 'xrpl/state-touches',
    ledgers: 3,
    touches: true,
  },
  // The recorded Xahau Imports (an account created, an account that existed) with their parent ledgers, and the two hand-made ledgers: the mint rows.
  {
    name: 'recorded mint cases xahau',
    database: 'rows_mint',
    network: 'xahau',
    dir: 'xahau/mint',
    ledgers: 6,
    mint: true,
  },
];

/** The five NFT tables, with the property of `LedgerRows` that holds their rows. */
const NFT_TABLES: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.NftEvents, 'nftEvents'],
  [Table.AccountNftEvents, 'accountNftEvents'],
  [Table.CollectionNftEvents, 'collectionNftEvents'],
  [Table.NftSales, 'nftSales'],
  [Table.NftTouches, 'nftTouches'],
];

/** The three Xahau mint tables, with the property of `LedgerRows` that holds their rows. */
const MINT_TABLES: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.GenesisMints, 'genesisMints'],
  [Table.Imports, 'imports'],
  [Table.RewardClaims, 'rewardClaims'],
];

/** The two object tables, with the property of `LedgerRows` that holds their rows. */
const OBJECT_TABLES: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.ObjectChanges, 'objectChanges'],
  [Table.AccountObjectChanges, 'accountObjectChanges'],
];

describe('buildLedgerRows into ClickHouse (e2e)', () => {
  let ch: StartedClickHouse;

  beforeAll(async () => {
    ch = await startClickHouse();
  });

  afterAll(async () => {
    await ch?.container.stop();
  });

  describe.each(SCENARIOS)('$name', (scenario) => {
    let svc: ClickHouseService;
    /** What `buildLedgerRows` made of the ledgers. */
    let built: LedgerRows[];
    /** What was inserted, per table. */
    const inserted = new Map<Table, Row[]>();

    beforeAll(async () => {
      const config = { ...ch.config, database: scenario.database };
      await runMigrations({ config, log: () => undefined });
      svc = new ClickHouseService(config);

      const ctx = parseContextFor(getNetworkProfile(scenario.network));
      const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, scenario.dir)).list();
      expect(ledgers).toHaveLength(scenario.ledgers);
      for (const [table] of TABLES) inserted.set(table, []);

      // One insert per table per ledger, the way the ledger writer will: the ledger row is the commit marker, last.
      built = [];
      for (const raw of ledgers) {
        const rows = buildLedgerRows(raw, ctx);
        built.push(rows);
        const dedupToken = (table: Table) => `e2e:${table}:${raw.header.ledger_index}`;
        for (const [table, key] of [...TABLES].reverse()) {
          const value = rows[key] as unknown as Row | Row[];
          const list = Array.isArray(value) ? value : [value];
          inserted.get(table)!.push(...list);
          await svc.insert(table, list, { dedupToken: dedupToken(table) });
        }
      }
    });

    afterAll(async () => {
      await svc?.close();
    });

    const count = async (table: Table): Promise<number> =>
      Number((await svc.queryOne<{ n: string }>(`SELECT count() AS n FROM ${table}`, {}, READ_SETTINGS))?.n);

    it('inserts every row into a migrated schema: count() equals the rows written, in every table', async () => {
      for (const table of EXACT_TABLES) {
        expect([table, await count(table)]).toEqual([table, inserted.get(table)!.length]);
      }
      expect(await count(Table.Ledgers)).toBe(scenario.ledgers);
    });

    /** A DateTime comes back as a quoted unix timestamp, a Nullable one too (NULL stays null); the rows hold a number. */
    const dateTimeColumns = async (table: Table): Promise<string[]> =>
      (
        await svc.query<{ name: string }>(
          "SELECT name FROM system.columns WHERE database = {db:String} AND table = {table:String} AND (type LIKE 'DateTime%' OR type LIKE 'Nullable(DateTime%')",
          { db: scenario.database, table },
        )
      ).map((c) => c.name);

    it.each(EXACT_TABLES)('%s: every row reads back exactly as written', async (table) => {
      // `ingested_at` is the server default, not part of the rows.
      const columns = table === Table.Ledgers ? '* EXCEPT ingested_at' : '*';
      const stored = await svc.query<Row>(`SELECT ${columns} FROM ${table}`, {}, READ_SETTINGS);
      const times = await dateTimeColumns(table);
      for (const row of stored) {
        for (const column of times) if (column in row && row[column] !== null) row[column] = Number(row[column]);
      }

      expect(firstDifference(stored, inserted.get(table)!)).toBeUndefined();
    });

    it('account_domains: the newest row of each account is stored, whatever the merges kept of its older ones', async () => {
      const written = inserted.get(Table.AccountDomains)!;
      // Every fixture set has account roots with a Domain.
      expect(written.length).toBeGreaterThan(0);

      const stored = await svc.query<Row>(`SELECT * FROM ${Table.AccountDomains}`, {}, READ_SETTINGS);
      // Never fewer rows than accounts, never more rows than written; which of the older rows of an account remain is up to
      // the merges.
      const newest = newestPerAccount(written);
      expect(stored.length).toBeGreaterThanOrEqual(newest.length);
      expect(stored.length).toBeLessThanOrEqual(written.length);
      expect(firstDifference(newestPerAccount(stored), newest)).toBeUndefined();
    });

    if (scenario.nft) {
      it('the NFT fixtures land in all five tables', async () => {
        for (const [table, key] of NFT_TABLES) {
          const expected = built.reduce((sum, rows) => sum + (rows[key] as unknown[]).length, 0);
          expect([table, expected > 0, await count(table)]).toEqual([table, true, expected]);
        }
      });
    }

    if (scenario.mint) {
      it('the mint fixtures land in all three tables, and the drops of an Import read back exactly', async () => {
        for (const [table, key] of MINT_TABLES) {
          const expected = built.reduce((sum, rows) => sum + (rows[key] as unknown[]).length, 0);
          expect([table, expected > 0, await count(table)]).toEqual([table, true, expected]);
        }
        const minted = await svc.query<{ minted: string }>(
          `SELECT minted FROM ${Table.Imports} ORDER BY ledger_index`,
          {},
          READ_SETTINGS,
        );
        expect(minted.map((r) => r.minted)).toEqual(['11', '2000000']);
      });
    }

    if (scenario.objects) {
      it('the object fixtures land in both tables, and every change has an owner row in the index', async () => {
        for (const [table, key] of OBJECT_TABLES) {
          const expected = built.reduce((sum, rows) => sum + (rows[key] as unknown[]).length, 0);
          expect([table, expected > 0, await count(table)]).toEqual([table, true, expected]);
        }
        const owners = await svc.queryOne<{ n: string }>(
          `SELECT count() AS n FROM ${Table.AccountObjectChanges} WHERE role = 'owner'`,
          {},
          READ_SETTINGS,
        );
        expect(Number(owners?.n)).toBe(await count(Table.ObjectChanges));
      });
    }

    if (scenario.touches) {
      it('the touch fixtures land in state_touches, with line and account rows (kind reads back as its label)', async () => {
        const written = inserted.get(Table.StateTouches)!;
        const stored = await svc.query<{ kind: string; n: string }>(
          `SELECT kind, count() AS n FROM ${Table.StateTouches} GROUP BY kind`,
          {},
          READ_SETTINGS,
        );
        const byKind = (kind: string) => written.filter((r) => r.kind === kind).length;
        expect(byKind('line')).toBeGreaterThan(0);
        expect(byKind('account')).toBeGreaterThan(0);
        // (GROUP BY gives no order, and an Enum8 sorts by value, not by label: the groups are compared as a map.)
        expect(Object.fromEntries(stored.map((r) => [r.kind, Number(r.n)]))).toEqual({
          line: byKind('line'),
          account: byKind('account'),
        });
      });
    }

    if (scenario.payments !== undefined) {
      it('stores the known number of payments, both in the table and in the ledger summaries', async () => {
        const row = await svc.queryOne<{ n: string; summed: string }>(
          'SELECT (SELECT count() FROM payments) AS n, (SELECT sum(payments_count) FROM ledgers) AS summed',
          {},
          READ_SETTINGS,
        );
        expect(Number(row?.n)).toBe(scenario.payments);
        expect(Number(row?.summed)).toBe(scenario.payments);
      });
    }

    if (scenario.payments !== undefined) {
      it('keeps NULL, 0 and real tags apart in the Nullable columns', async () => {
        const written = inserted.get(Table.Payments)!;
        const tally = (field: string) => ({
          null: written.filter((r) => r[field] === null).length,
          zero: written.filter((r) => r[field] === 0).length,
          set: written.filter((r) => typeof r[field] === 'number' && r[field] !== 0).length,
        });
        const stored = async (field: string) => {
          const row = await svc.queryOne<Record<string, string>>(
            `SELECT countIf(${field} IS NULL) AS \`null\`, countIf(${field} = 0) AS zero, ` +
              `countIf(${field} > 0) AS \`set\` FROM payments`,
            {},
            READ_SETTINGS,
          );
          return { null: Number(row?.null), zero: Number(row?.zero), set: Number(row?.set) };
        };

        // The ledgers hold a source tag of 0 (kept, ruling R10), absent tags and real ones.
        expect(tally('source_tag')).toEqual({ null: 179, zero: 2, set: 1 });
        expect(tally('destination_tag').null).toBeGreaterThan(0);
        expect(tally('destination_tag').set).toBeGreaterThan(0);
        expect(await stored('source_tag')).toEqual(tally('source_tag'));
        expect(await stored('destination_tag')).toEqual(tally('destination_tag'));
      });
    }

    it('stores the ledger summary with exact UInt64 values and maps', async () => {
      const [ledger] = await svc.query<Row>(
        'SELECT ledger_index, total_coins, fee_total, fee_min, fee_max, type_counts, result_counts, tx_count ' +
          'FROM ledgers ORDER BY ledger_index DESC LIMIT 1',
        {},
        READ_SETTINGS,
      );
      const last = inserted
        .get(Table.Ledgers)!
        .reduce((a, b) => ((b.ledger_index as number) > (a.ledger_index as number) ? b : a));
      expect(ledger).toMatchObject({
        ledger_index: last.ledger_index,
        total_coins: last.total_coins,
        fee_total: last.fee_total,
        type_counts: last.type_counts,
        tx_count: last.tx_count,
      });
      // The numbers are what the reference sums.
      expect(String(ledger.total_coins)).toMatch(/^\d{15,17}$/);
    });
  });

  describe('a Xahau flag ledger through the LedgerWriter (ruling R95)', () => {
    let svc: ClickHouseService;

    beforeAll(async () => {
      const config = { ...ch.config, database: 'rows_xahau_flag_writer' };
      await runMigrations({ config, log: () => undefined });
      svc = new ClickHouseService(config);
    });

    afterAll(async () => {
      await svc?.close();
    });

    it('commits the ledger, with the UNLReport sender as the zero account and its tx_json as the node sent it', async () => {
      const ctx = parseContextFor(getNetworkProfile('xahau'));
      const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, 'xahau', 'flag')).list();
      await new LedgerWriter(svc, ctx).write(ledgers);

      expect(await committedCheckpoint(svc)).toBe(26570752);
      const reports = await svc.query<{ account: string; sequence: number; account_in_json: string; n: number }>(
        `SELECT account, sequence, JSONExtractString(tx_json, 'Account') AS account_in_json, count() AS n
           FROM ${Table.Transactions} WHERE tx_type = 'UNLReport' GROUP BY account, sequence, account_in_json`,
      );
      expect(reports).toEqual([{ account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', sequence: 0, account_in_json: '', n: 22 }]);
      const bySequence = await svc.queryOne<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountTxBySequence} WHERE account = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'`,
      );
      expect(Number(bySequence?.n)).toBe(22);
      const ledger = await svc.queryOne<{ tx_count: number; payments_count: number }>(
        `SELECT tx_count, payments_count FROM ${Table.Ledgers} WHERE ledger_index = 26570752`,
      );
      expect(ledger).toEqual({ tx_count: 37, payments_count: 15 });
    });
  });
});

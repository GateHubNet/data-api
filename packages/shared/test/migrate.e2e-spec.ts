import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS, TODAY_NOON } from './sample-rows';

const REAL_SCHEMA_DIR = join(__dirname, '..', 'schema');

const P6 = 'intDiv(ledger_index, 1000000)';
const P7 = 'intDiv(ledger_index, 10000000)';

interface Shape {
  engine: string;
  /** Version column of a ReplacingMergeTree. */
  version?: string;
  partition: string;
  order: string;
}

/** The physical design of every table, as specified for the baseline schema. */
const SHAPES: Record<Table, Shape> = {
  [Table.Ledgers]: { engine: 'ReplacingMergeTree', partition: P6, order: 'ledger_index' },
  [Table.LedgerByHash]: { engine: 'ReplacingMergeTree', partition: P7, order: 'ledger_hash' },
  [Table.Transactions]: { engine: 'ReplacingMergeTree', partition: P6, order: 'ledger_index, tx_index' },
  [Table.TxByHash]: { engine: 'ReplacingMergeTree', partition: P7, order: 'hash' },
  [Table.TxByType]: { engine: 'ReplacingMergeTree', partition: P7, order: 'tx_type, ledger_index, tx_index' },
  [Table.AccountTransactions]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, ledger_index, tx_index',
  },
  [Table.AccountTxBySequence]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, sequence, ledger_index, tx_index',
  },
  [Table.Payments]: { engine: 'ReplacingMergeTree', partition: P6, order: 'ledger_index, tx_index' },
  [Table.PaymentsByCurrency]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'currency, issuer, ledger_index, tx_index',
  },
  [Table.AccountPayments]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, ledger_index, tx_index',
  },
  [Table.Exchanges]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index',
  },
  [Table.AccountExchanges]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, ledger_index, tx_index, node_index',
  },
  [Table.BalanceChanges]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, ledger_index, tx_index, node_index',
  },
  [Table.AccountsCreated]: { engine: 'ReplacingMergeTree', partition: '', order: 'ledger_index, tx_index, account' },
  [Table.FeeStats]: { engine: 'MergeTree', partition: 'toYYYYMM(ts)', order: 'ts' },
  [Table.Validations]: {
    engine: 'AggregatingMergeTree',
    partition: 'toYYYYMMDD(last_datetime)',
    order: 'ledger_hash, validation_public_key',
  },
  [Table.ValidatorManifests]: {
    engine: 'ReplacingMergeTree',
    version: 'seq',
    partition: '',
    order: 'ephemeral_key',
  },
  [Table.StatsHourly]: { engine: 'ReplacingMergeTree', version: 'version', partition: '', order: 'hour' },
  [Table.VolumeDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYYYYMM(day)',
    order: 'metric, day, component',
  },
  [Table.VolumeLive]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'metric, period, component',
  },
  [Table.IngestLog]: {
    engine: 'ReplacingMergeTree',
    version: 'updated_at',
    partition: '',
    order: 'range_start, range_end',
  },
  [Table.AggDirty]: {
    engine: 'ReplacingMergeTree',
    version: 'created_at',
    partition: '',
    order: 'from_hour, to_hour',
  },
  [Table.SyncerLease]: { engine: 'ReplacingMergeTree', version: 'heartbeat', partition: '', order: 'network' },
};

/** The ledger-derived base and secondary tables: written with insert dedup tokens, so they keep a dedup window. */
const DEDUP_TABLES: Table[] = [
  Table.Ledgers,
  Table.LedgerByHash,
  Table.Transactions,
  Table.TxByHash,
  Table.TxByType,
  Table.AccountTransactions,
  Table.AccountTxBySequence,
  Table.Payments,
  Table.PaymentsByCurrency,
  Table.AccountPayments,
  Table.Exchanges,
  Table.AccountExchanges,
  Table.BalanceChanges,
  Table.AccountsCreated,
];

const CONTROLLED_SCHEMA = `-- Controlled schema for the migration runner e2e test.
CREATE TABLE IF NOT EXISTS dedup_t (id UInt32, v String)
ENGINE = MergeTree ORDER BY id
SETTINGS non_replicated_deduplication_window = 100;

-- A second statement after a comment line.
CREATE TABLE IF NOT EXISTS part_t (p UInt8, k UInt32)
ENGINE = MergeTree PARTITION BY p ORDER BY k;
`;

describe('migrations (e2e)', () => {
  let ch: StartedClickHouse;
  let admin: ClickHouseService;
  let tempSchemaDir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const databases = async (): Promise<string[]> =>
    (await admin.query<{ name: string }>('SELECT name FROM system.databases')).map((r) => r.name);

  beforeAll(async () => {
    // No CLICKHOUSE_DB: the runner must create the target database itself.
    ch = await startClickHouse();
    admin = new ClickHouseService(ch.config);
    tempSchemaDir = mkdtempSync(join(tmpdir(), 'gh-schema-'));
  });

  afterAll(async () => {
    delete process.env.GH_SCHEMA_DIR;
    await admin?.onModuleDestroy();
    await ch?.container.stop();
    if (tempSchemaDir) rmSync(tempSchemaDir, { recursive: true, force: true });
  });

  describe('against the real schema', () => {
    const config = () => ({ ...ch.config, database: 'xahau' });
    const realFiles = () =>
      readdirSync(REAL_SCHEMA_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    it('(a) creates the target database and applies every schema file', async () => {
      expect(await databases()).not.toContain('xahau');

      const result = await runMigrations({ config: config(), log });

      expect(await databases()).toContain('xahau');
      expect(result.applied).toEqual(realFiles());
      expect(result.skipped).toEqual([]);
      expect(logs.some((m) => m.includes('xahau'))).toBe(true);

      const svc = new ClickHouseService(config());
      try {
        const tracked = await svc.query<{ filename: string; checksum: string }>(
          'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
        );
        expect(tracked.map((r) => r.filename)).toEqual(realFiles());
        tracked.forEach((r) => expect(r.checksum).toMatch(/^[0-9a-f]{64}$/));
      } finally {
        await svc.onModuleDestroy();
      }
    });

    it('(b) a second run applies nothing', async () => {
      const result = await runMigrations({ config: config(), log });
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(realFiles());
    });

    describe('baseline schema', () => {
      let svc: ClickHouseService;
      const tables = Object.values(Table);

      beforeAll(() => {
        svc = new ClickHouseService(config());
      });

      afterAll(async () => {
        await svc?.onModuleDestroy();
      });

      const systemTables = () =>
        svc.query<{ name: string; engine: string; engine_full: string; partition_key: string; sorting_key: string }>(
          `SELECT name, engine, engine_full, partition_key, sorting_key FROM system.tables
           WHERE database = {db:String} ORDER BY name`,
          { db: 'xahau' },
        );

      it('creates exactly the tables of the Table enum (plus schema_migrations)', async () => {
        const names = (await systemTables()).map((t) => t.name);
        expect(names).toEqual([...tables, 'schema_migrations'].sort());
      });

      it.each(tables)('%s is queryable', async (table) => {
        await expect(svc.query(`SELECT * FROM ${table} LIMIT 0`)).resolves.toEqual([]);
      });

      it('has the specified engine, version column, partition key and sorting key for every table', async () => {
        const actual = new Map((await systemTables()).map((t) => [t.name, t]));
        for (const table of tables) {
          const want = SHAPES[table];
          const got = actual.get(table);
          expect({
            table,
            engine: got?.engine,
            sorting_key: got?.sorting_key,
            partition_key: got?.partition_key,
          }).toEqual({ table, engine: want.engine, sorting_key: want.order, partition_key: want.partition });
          const engineCall = want.version ? `${want.engine}(${want.version})` : want.engine;
          expect({ table, engineFull: got?.engine_full.split(' ')[0] }).toEqual({ table, engineFull: engineCall });
        }
      });

      it('sets a dedup window of 1000 on the ledger-derived tables', async () => {
        for (const t of await systemTables()) {
          const hasWindow = t.engine_full.includes('non_replicated_deduplication_window = 1000');
          expect({ table: t.name, hasWindow }).toEqual({
            table: t.name,
            hasWindow: DEDUP_TABLES.includes(t.name as Table),
          });
        }
      });

      it('keeps transactions on a finer index granularity', async () => {
        const rows = await systemTables();
        const grain = (name: string) =>
          /index_granularity = (\d+)/.exec(rows.find((t) => t.name === name)!.engine_full)?.[1];
        expect(grain(Table.Transactions)).toBe('1024');
        expect(grain(Table.Ledgers)).toBe('8192');
      });

      it('declares the skipping indexes', async () => {
        const idx = await svc.query<{ table: string; name: string; type: string }>(
          `SELECT table, name, type FROM system.data_skipping_indices WHERE database = {db:String} ORDER BY table`,
          { db: 'xahau' },
        );
        expect(idx).toEqual([
          { table: Table.AccountsCreated, name: 'account_bf', type: 'bloom_filter' },
          { table: Table.Ledgers, name: 'close_time_mm', type: 'minmax' },
        ]);
      });

      it('expires validations after 90 days of last_datetime', async () => {
        const row = await svc.queryOne<{ create_table_query: string }>(
          `SELECT create_table_query FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
          { db: 'xahau', t: Table.Validations },
        );
        expect(row?.create_table_query).toMatch(/TTL toDateTime\(last_datetime\) \+ toIntervalDay\(90\)/);
      });

      it('uses DateTime(UTC) for every second-resolution time column', async () => {
        const cols = await svc.query<{ table: string; name: string; type: string }>(
          `SELECT table, name, type FROM system.columns
           WHERE database = {db:String} AND type LIKE '%DateTime%' AND table != 'schema_migrations'`,
          { db: 'xahau' },
        );
        expect(cols.length).toBeGreaterThan(0);
        const bare = cols.filter((c) => /^(Nullable\()?DateTime\)?$/.test(c.type));
        expect(bare).toEqual([]);
      });
    });

    describe('row types', () => {
      let svc: ClickHouseService;
      const tables = Object.values(Table);

      /** Compare values as strings, so a UInt64 read back as a string equals the number that was sent. */
      const norm = (v: unknown): unknown =>
        v === null
          ? null
          : typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
            : String(v);

      beforeAll(() => {
        svc = new ClickHouseService(config());
      });

      afterAll(async () => {
        await svc?.onModuleDestroy();
      });

      it.each(tables)('%s: a typed sample row round-trips through the table', async (table) => {
        const row = SAMPLE_ROWS[table];
        await svc.insert(table, [row]);

        const rows = await svc.query(
          `SELECT * FROM ${table}`,
          {},
          { date_time_output_format: 'unix_timestamp', output_format_json_quote_64bit_integers: 1 },
        );

        expect(rows).toHaveLength(1);
        expect(norm(rows[0])).toEqual(norm(row));
      });

      it('stores NULL for absent nullable columns', async () => {
        await svc.insert(Table.Payments, [
          {
            ...SAMPLE_ROWS[Table.Payments],
            tx_index: 5,
            max_amount: null,
            source_tag: null,
            destination_tag: null,
            invoice_id: null,
            client: null,
          },
        ]);
        const row = await svc.queryOne(
          `SELECT max_amount, source_tag, destination_tag, invoice_id, client FROM payments WHERE tx_index = 5`,
        );
        expect(row).toEqual({
          max_amount: null,
          source_tag: null,
          destination_tag: null,
          invoice_id: null,
          client: null,
        });
      });

      it('stamps ledgers.ingested_at on the server when the row leaves it out', async () => {
        const { ingested_at: _omitted, ...ledger } = SAMPLE_ROWS[Table.Ledgers];
        await svc.insert(Table.Ledgers, [{ ...ledger, ledger_index: ledger.ledger_index + 1 }]);
        const row = await svc.queryOne<{ age: number }>(
          `SELECT abs(toUnixTimestamp(now()) - toUnixTimestamp(ingested_at)) AS age FROM ledgers WHERE ledger_index = {l:UInt32}`,
          { l: ledger.ledger_index + 1 },
        );
        expect(row?.age).toBeLessThan(60);
      });

      it('rejects a label outside an Enum8', async () => {
        const bad = { ...SAMPLE_ROWS[Table.AccountPayments], tx_index: 9, direction: 'sideways' };
        // The client logs the rejected insert; the rejection itself is what is under test.
        const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          await expect(svc.insert(Table.AccountPayments, [bad])).rejects.toThrow();
        } finally {
          logged.mockRestore();
        }
      });

      it('validations: sightings of one validation merge into one row', async () => {
        const base = SAMPLE_ROWS[Table.Validations];
        const key = { ledger_hash: 'F'.repeat(64), validation_public_key: 'n9merge' };
        await svc.insert(Table.Validations, [
          { ...base, ...key, count: 1, first_datetime: TODAY_NOON + 2.5, last_datetime: TODAY_NOON + 2.5, flags: 1 },
          { ...base, ...key, count: 2, first_datetime: TODAY_NOON + 0.25, last_datetime: TODAY_NOON + 8.75, flags: 1 },
        ]);
        await svc.command('OPTIMIZE TABLE validations FINAL');

        const rows = await svc.query(
          `SELECT toString(count) AS count, toString(toUnixTimestamp64Milli(first_datetime)) AS first,
                  toString(toUnixTimestamp64Milli(last_datetime)) AS last, flags
           FROM validations WHERE ledger_hash = {h:String}`,
          { h: key.ledger_hash },
        );
        expect(rows).toEqual([
          { count: '3', first: String(TODAY_NOON * 1000 + 250), last: String(TODAY_NOON * 1000 + 8750), flags: 1 },
        ]);
      });

      it('validations: a row older than 90 days is expired as soon as it is written', async () => {
        const stale = { ...SAMPLE_ROWS[Table.Validations], ledger_hash: 'E'.repeat(64) };
        const old = TODAY_NOON - 91 * 86_400;
        await svc.insert(Table.Validations, [{ ...stale, first_datetime: old, last_datetime: old }]);
        await svc.command('OPTIMIZE TABLE validations FINAL');

        const rows = await svc.query(`SELECT 1 FROM validations WHERE ledger_hash = {h:String}`, {
          h: stale.ledger_hash,
        });
        expect(rows).toEqual([]);
      });

      it('validator_manifests: the highest seq wins regardless of insert order', async () => {
        const row = SAMPLE_ROWS[Table.ValidatorManifests];
        const key = { ephemeral_key: 'n9race' };
        await svc.insert(Table.ValidatorManifests, [{ ...row, ...key, master_key: 'nHnew', seq: 9 }]);
        await svc.insert(Table.ValidatorManifests, [{ ...row, ...key, master_key: 'nHold', seq: 4 }]);
        await svc.command('OPTIMIZE TABLE validator_manifests FINAL');

        const rows = await svc.query(`SELECT master_key, seq FROM validator_manifests WHERE ephemeral_key = 'n9race'`);
        expect(rows).toEqual([{ master_key: 'nHnew', seq: 9 }]);
      });

      it('a ledger-derived table drops a replayed insert token', async () => {
        const row = SAMPLE_ROWS[Table.LedgerByHash];
        await svc.insert(Table.LedgerByHash, [{ ...row, ledger_hash: 'A'.repeat(64) }], { dedupToken: 'replay-1' });
        await svc.insert(Table.LedgerByHash, [{ ...row, ledger_hash: 'B'.repeat(64) }], { dedupToken: 'replay-1' });

        const rows = await svc.query<{ ledger_hash: string }>(
          `SELECT ledger_hash FROM ledger_by_hash WHERE ledger_hash IN ({a:String}, {b:String})`,
          { a: 'A'.repeat(64), b: 'B'.repeat(64) },
        );
        expect(rows.map((r) => r.ledger_hash)).toEqual(['A'.repeat(64)]);
      });
    });
  });

  describe('against a controlled schema dir (GH_SCHEMA_DIR)', () => {
    const DB = 'ctl_migrations';
    const file = () => join(tempSchemaDir, '001_controlled.sql');
    let svc: ClickHouseService;

    beforeAll(async () => {
      writeFileSync(file(), CONTROLLED_SCHEMA);
      process.env.GH_SCHEMA_DIR = tempSchemaDir;
      const result = await runMigrations({ config: { ...ch.config, database: DB }, log });
      expect(result.applied).toEqual(['001_controlled.sql']);
      svc = new ClickHouseService({ ...ch.config, database: DB });
    });

    afterAll(async () => {
      await svc?.onModuleDestroy();
    });

    it('(c) refuses to run once an applied file was modified', async () => {
      appendFileSync(file(), '-- appended after the migration was applied\n');
      try {
        await expect(runMigrations({ config: { ...ch.config, database: DB }, log })).rejects.toThrow(
          'Migration 001_controlled.sql was modified after being applied',
        );
      } finally {
        writeFileSync(file(), CONTROLLED_SCHEMA);
      }
      // Restored content: the same run is a clean no-op again.
      const again = await runMigrations({ config: { ...ch.config, database: DB }, log });
      expect(again).toEqual({ applied: [], skipped: ['001_controlled.sql'] });
    });

    it('(d) insert() de-duplicates per insert token, not by content', async () => {
      const count = async () => Number((await svc.queryOne<{ n: string }>('SELECT count() AS n FROM dedup_t'))?.n);

      await svc.insert('dedup_t', [{ id: 1, v: 'a' }], { dedupToken: 't1' });
      // Same token, different rows: dropped as a replay of t1.
      await svc.insert('dedup_t', [{ id: 2, v: 'b' }], { dedupToken: 't1' });
      expect(await count()).toBe(1);
      expect(await svc.query('SELECT id, v FROM dedup_t')).toEqual([{ id: 1, v: 'a' }]);

      // New token, same rows as before: a new insert.
      await svc.insert('dedup_t', [{ id: 1, v: 'a' }], { dedupToken: 't2' });
      expect(await count()).toBe(2);
    });

    it('(e) a partition-scoped lightweight delete works on the pinned version', async () => {
      const rows = (p: number) => Array.from({ length: 10 }, (_, i) => ({ p, k: i + 1 }));
      await svc.insert('part_t', [...rows(0), ...rows(1)]);

      await svc.command('DELETE FROM part_t IN PARTITION 0 WHERE k > 5');

      const left = (p: number) =>
        svc.query<{ k: number }>('SELECT k FROM part_t WHERE p = {p:UInt8} ORDER BY k', { p });
      expect((await left(0)).map((r) => r.k)).toEqual([1, 2, 3, 4, 5]);
      expect((await left(1)).map((r) => r.k)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('(e2) the delete predicate accepts bound query params', async () => {
      await svc.command('DELETE FROM part_t IN PARTITION 1 WHERE k > {k:UInt32}', { k: 7 });
      const left = await svc.query<{ k: number }>('SELECT k FROM part_t WHERE p = 1 ORDER BY k');
      expect(left.map((r) => r.k)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });
});

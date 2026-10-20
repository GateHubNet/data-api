import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** `validator_validations`: 100 000 ledgers are about four days, so its 7-day expiry drops whole partitions. */
const P5 = 'intDiv(ledger_index, 100000)';

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
    // `direction` tells the `sent` and the `received` row of a payment to oneself apart (R112)
    order: 'account, ledger_index, tx_index, direction',
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
  [Table.ValidatorValidations]: {
    engine: 'AggregatingMergeTree',
    partition: P5,
    order: 'validation_public_key, ledger_index, ledger_hash',
  },
  [Table.ValidatorSeen]: { engine: 'AggregatingMergeTree', partition: '', order: 'validation_public_key' },
  [Table.UnlLists]: {
    engine: 'ReplacingMergeTree',
    version: 'fetched_at',
    partition: '',
    order: 'publisher, sequence',
  },
  [Table.UnlPublishers]: { engine: 'ReplacingMergeTree', version: 'checked_at', partition: '', order: 'publisher' },
  [Table.ValidatorDomains]: {
    engine: 'ReplacingMergeTree',
    version: 'checked_at',
    partition: '',
    order: 'validation_public_key, domain',
  },
  [Table.NetworkState]: { engine: 'ReplacingMergeTree', version: 'polled_at', partition: '', order: 'ledger_index' },
  [Table.AmendmentFeatures]: {
    engine: 'ReplacingMergeTree',
    version: 'polled_at',
    partition: '',
    order: 'amendment_id',
  },
  [Table.ValidatorVotes]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'ledger_index, validation_public_key',
  },
  [Table.AmendmentTallies]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'amendment_id, ledger_index',
  },
  [Table.ValidatorAgreementHourly]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'hour, validation_public_key',
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
  [Table.NativeRatesDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYear(day)',
    order: 'currency, issuer, day',
  },
  [Table.PairHourly]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toDate(hour)',
    order: 'hour, base_currency, base_issuer, counter_currency, counter_issuer, source',
  },
  [Table.MarketsLive]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'period, amm, base_currency, base_issuer, counter_currency, counter_issuer',
  },
  [Table.AccountRollupState]: { engine: 'ReplacingMergeTree', version: 'version', partition: '', order: 'account' },
  [Table.AccountPartitionRows]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: '',
    order: 'partition, account',
  },
  [Table.AccountRollupDays]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYear(day)',
    order: 'account, day',
  },
  [Table.AccountLinesDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYear(day)',
    order: 'account, day, currency, counterparty, change_type, owes, version',
  },
  [Table.AccountTxDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYear(day)',
    order: 'account, day, tx_type, result, version',
  },
  [Table.AccountTradesDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYear(day)',
    order: 'account, day, base_currency, base_issuer, counter_currency, counter_issuer, version',
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

/** The aggregate tables of migration 003 (D2). */
const MIGRATION_003 = '003_account_market_aggregates.sql';
const MIGRATION_003_TABLES: Table[] = [
  Table.NativeRatesDaily,
  Table.PairHourly,
  Table.MarketsLive,
  Table.AccountRollupState,
  Table.AccountPartitionRows,
  Table.AccountRollupDays,
  Table.AccountLinesDaily,
  Table.AccountTxDaily,
  Table.AccountTradesDaily,
];

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

/** The migration runner's split of a file into statements (see `splitStatements` in migrate.ts). */
const statementsOf = (sql: string): string[] =>
  sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);

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

      it('keeps the collector tables on a dedup window of 100', async () => {
        const full = new Map((await systemTables()).map((t) => [t.name, t.engine_full]));
        // `(?!\d)`: a window of 1000, the ledger tables', must not pass for one of 100.
        const window100 = /non_replicated_deduplication_window = 100(?!\d)/;
        expect(full.get(Table.ValidatorValidations)).toMatch(window100);
        expect(full.get(Table.ValidatorSeen)).toMatch(window100);
        expect(full.get(Table.ValidatorValidations)).toContain('ttl_only_drop_parts = 1');
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

      it('expires validator_validations after 7 days, network_state after 100 and the hourly agreement after 400', async () => {
        const ddl = async (table: Table) =>
          (
            await svc.queryOne<{ create_table_query: string }>(
              `SELECT create_table_query FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
              { db: 'xahau', t: table },
            )
          )?.create_table_query;
        expect(await ddl(Table.ValidatorValidations)).toMatch(/TTL toDateTime\(last_datetime\) \+ toIntervalDay\(7\)/);
        expect(await ddl(Table.NetworkState)).toMatch(/TTL toDateTime\(polled_at\) \+ toIntervalDay\(100\)/);
        expect(await ddl(Table.ValidatorAgreementHourly)).toMatch(/TTL hour \+ toIntervalDay\(400\)/);
      });

      it('expires pair_hourly 45 days after its hour, dropping whole parts only', async () => {
        const row = await svc.queryOne<{ create_table_query: string; engine_full: string }>(
          `SELECT create_table_query, engine_full FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
          { db: 'xahau', t: Table.PairHourly },
        );
        expect(row?.create_table_query).toMatch(/TTL hour \+ toIntervalDay\(45\)/);
        expect(row?.engine_full).toContain('ttl_only_drop_parts = 1');
      });

      it('keeps validator_seen, the votes and the tallies for ever', async () => {
        const kept = await svc.query<{ name: string; create_table_query: string }>(
          `SELECT name, create_table_query FROM system.tables WHERE database = {db:String} AND name IN {names:Array(String)}`,
          { db: 'xahau', names: [Table.ValidatorSeen, Table.ValidatorVotes, Table.AmendmentTallies] },
        );
        expect(kept).toHaveLength(3);
        for (const t of kept)
          expect({ table: t.name, ttl: /\bTTL\b/.test(t.create_table_query) }).toEqual({ table: t.name, ttl: false });
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

      it('fills the added columns for a row written without them', async () => {
        const { domain: _d, manifest: _m, source: _s, ...oldManifest } = SAMPLE_ROWS[Table.ValidatorManifests];
        await svc.insert(Table.ValidatorManifests, [{ ...oldManifest, ephemeral_key: 'n9oldshape' }]);
        const manifest = await svc.queryOne(
          `SELECT domain, manifest, source FROM validator_manifests WHERE ephemeral_key = 'n9oldshape'`,
        );
        expect(manifest).toEqual({ domain: '', manifest: '', source: 'stream' });

        const { server_version: _v, ...oldValidation } = SAMPLE_ROWS[Table.Validations];
        const ledger_hash = 'D'.repeat(64);
        await svc.insert(Table.Validations, [{ ...oldValidation, ledger_hash }]);
        const validation = await svc.queryOne(`SELECT server_version FROM validations WHERE ledger_hash = {h:String}`, {
          h: ledger_hash,
        });
        expect(validation).toEqual({ server_version: null });
      });

      it('validator_validations: sightings merge: counts add up, first is the min, last the max, full the max', async () => {
        const base = SAMPLE_ROWS[Table.ValidatorValidations];
        const key = {
          validation_public_key: 'nHmerge',
          ledger_index: base.ledger_index + 1,
          ledger_hash: 'F'.repeat(64),
        };
        await svc.insert(Table.ValidatorValidations, [
          { ...base, ...key, count: 1, first_datetime: TODAY_NOON + 2.5, last_datetime: TODAY_NOON + 2.5, full: 0 },
          { ...base, ...key, count: 2, first_datetime: TODAY_NOON + 0.25, last_datetime: TODAY_NOON + 8.75, full: 1 },
        ]);
        await svc.command('OPTIMIZE TABLE validator_validations FINAL');

        const rows = await svc.query(
          `SELECT toString(count) AS count, toString(toUnixTimestamp64Milli(first_datetime)) AS first,
                  toString(toUnixTimestamp64Milli(last_datetime)) AS last, full
           FROM validator_validations WHERE validation_public_key = {k:String}`,
          { k: key.validation_public_key },
        );
        expect(rows).toEqual([
          { count: '3', first: String(TODAY_NOON * 1000 + 250), last: String(TODAY_NOON * 1000 + 8750), full: 1 },
        ]);
      });

      it('validator_seen: min of first_seen, max of last_seen and of last_ledger_index', async () => {
        const base = SAMPLE_ROWS[Table.ValidatorSeen];
        const key = { validation_public_key: 'nHseenmerge' };
        // The min, the max of last_seen and the max of last_ledger_index come from different rows on purpose.
        await svc.insert(Table.ValidatorSeen, [
          { ...base, ...key, first_seen: 1_699_000_000.5, last_seen: 1_700_000_000.75, last_ledger_index: 200 },
          { ...base, ...key, first_seen: 1_698_000_000.25, last_seen: 1_699_500_000.5, last_ledger_index: 300 },
        ]);
        await svc.command('OPTIMIZE TABLE validator_seen FINAL');

        const rows = await svc.query(
          `SELECT toString(toUnixTimestamp64Milli(first_seen)) AS first, toString(toUnixTimestamp64Milli(last_seen)) AS last,
                  last_ledger_index
           FROM validator_seen WHERE validation_public_key = {k:String}`,
          { k: key.validation_public_key },
        );
        expect(rows).toEqual([{ first: '1698000000250', last: '1700000000750', last_ledger_index: 300 }]);
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

  describe('a migration that failed half way', () => {
    const DB = 'ctl_half';
    let halfDir: string;

    beforeAll(() => {
      halfDir = mkdtempSync(join(tmpdir(), 'gh-schema-half-'));
    });

    afterAll(() => {
      if (halfDir) rmSync(halfDir, { recursive: true, force: true });
    });

    it('(f) completes 002 after it failed half way', async () => {
      const config = { ...ch.config, database: DB };
      const previousDir = process.env.GH_SCHEMA_DIR;
      const svc = new ClickHouseService(config);
      const columns = (database: string) =>
        admin.query(
          `SELECT table, name, type, default_expression FROM system.columns
           WHERE database = {db:String} AND table != 'schema_migrations' ORDER BY table, position`,
          { db: database },
        );
      const tableNames = async (): Promise<string[]> =>
        (
          await admin.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = {db:String}`, {
            db: DB,
          })
        ).map((t) => t.name);

      try {
        // 001 alone, from a copy.
        copyFileSync(join(REAL_SCHEMA_DIR, '001_baseline.sql'), join(halfDir, '001_baseline.sql'));
        process.env.GH_SCHEMA_DIR = halfDir;
        expect((await runMigrations({ config, log })).applied).toEqual(['001_baseline.sql']);

        // The first half of 002 by hand, as if the runner had died after it: file not recorded, six statements applied.
        const statements = statementsOf(readFileSync(join(REAL_SCHEMA_DIR, '002_validators_amendments.sql'), 'utf8'));
        expect(statements).toHaveLength(12);
        for (const statement of statements.slice(0, 6)) await svc.command(statement);
        expect(await tableNames()).toContain(Table.UnlPublishers);
        expect(await tableNames()).not.toContain(Table.ValidatorDomains);

        // The real directory: 002 runs again from its first statement and completes, and 003, which comes after it, is applied too.
        process.env.GH_SCHEMA_DIR = REAL_SCHEMA_DIR;
        const result = await runMigrations({ config, log });
        expect(result).toEqual({
          applied: ['002_validators_amendments.sql', MIGRATION_003],
          skipped: ['001_baseline.sql'],
        });

        // Every statement took effect: the ten tables, and the columns the two ALTERs added.
        const names = await tableNames();
        for (const table of [
          Table.ValidatorValidations,
          Table.ValidatorSeen,
          Table.UnlLists,
          Table.UnlPublishers,
          Table.ValidatorDomains,
          Table.NetworkState,
          Table.AmendmentFeatures,
          Table.ValidatorVotes,
          Table.AmendmentTallies,
          Table.ValidatorAgreementHourly,
        ]) {
          expect(names).toContain(table);
        }
        await expect(svc.query('SELECT server_version FROM validations LIMIT 0')).resolves.toEqual([]);
        await expect(svc.query('SELECT domain, manifest, source FROM validator_manifests LIMIT 0')).resolves.toEqual(
          [],
        );
        // And the result is the schema a straight run makes (database `xahau`, migrated by test (a)).
        expect(await columns(DB)).toEqual(await columns('xahau'));
      } finally {
        if (previousDir === undefined) delete process.env.GH_SCHEMA_DIR;
        else process.env.GH_SCHEMA_DIR = previousDir;
        await svc.onModuleDestroy();
      }
    });
  });

  describe('migration 003', () => {
    const realFiles = () =>
      readdirSync(REAL_SCHEMA_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    let dir: string;
    let previousDir: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gh-schema-003-'));
      previousDir = process.env.GH_SCHEMA_DIR;
      process.env.GH_SCHEMA_DIR = dir;
    });

    afterEach(() => {
      if (previousDir === undefined) delete process.env.GH_SCHEMA_DIR;
      else process.env.GH_SCHEMA_DIR = previousDir;
      rmSync(dir, { recursive: true, force: true });
    });

    const copyReal = (files: string[]) => {
      for (const f of files) copyFileSync(join(REAL_SCHEMA_DIR, f), join(dir, f));
    };
    const tablesOf = async (database: string): Promise<string[]> =>
      (
        await admin.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = {db:String}`, {
          db: database,
        })
      ).map((t) => t.name);

    it('applies 003 to a database migrated before it, and then nothing', async () => {
      const config = { ...ch.config, database: 'ctl_003_after' };
      const before = realFiles().filter((f) => f !== MIGRATION_003);
      expect(before.length).toBeGreaterThan(0);
      expect(realFiles()).toContain(MIGRATION_003);

      copyReal(before);
      expect(await runMigrations({ config, log })).toEqual({ applied: before, skipped: [] });
      for (const table of MIGRATION_003_TABLES) expect(await tablesOf(config.database)).not.toContain(table);

      copyReal([MIGRATION_003]);
      expect(await runMigrations({ config, log })).toEqual({ applied: [MIGRATION_003], skipped: before });
      for (const table of MIGRATION_003_TABLES) expect(await tablesOf(config.database)).toContain(table);

      expect(await runMigrations({ config, log })).toEqual({ applied: [], skipped: realFiles() });
    });

    it('needs no table of 002: 001 and 003 alone apply', async () => {
      const config = { ...ch.config, database: 'ctl_003_alone' };
      copyReal(['001_baseline.sql', MIGRATION_003]);

      expect(await runMigrations({ config, log })).toEqual({
        applied: ['001_baseline.sql', MIGRATION_003],
        skipped: [],
      });

      const names = await tablesOf(config.database);
      for (const table of MIGRATION_003_TABLES) expect(names).toContain(table);
      expect(names).not.toContain(Table.ValidatorVotes);
    });
  });
});

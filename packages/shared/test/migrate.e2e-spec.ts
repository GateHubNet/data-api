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
  [Table.AmmPoolStates]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'amm_account, ledger_index, tx_index',
  },
  // the narrow ledger-ordered index of amm_pool_states (R-A14): the watermark and day scans read it by primary-key range
  [Table.AmmPoolTouches]: {
    engine: 'ReplacingMergeTree',
    partition: P6,
    order: 'ledger_index, tx_index, amm_account',
  },
  [Table.AmmLiquidity]: { engine: 'ReplacingMergeTree', partition: P7, order: 'amm_account, ledger_index, tx_index' },
  [Table.AccountAmmLiquidity]: {
    engine: 'ReplacingMergeTree',
    partition: P7,
    order: 'account, ledger_index, tx_index, amm_account',
  },
  [Table.AmmGovernance]: { engine: 'ReplacingMergeTree', partition: P7, order: 'amm_account, ledger_index, tx_index' },
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
  [Table.AmmPools]: { engine: 'ReplacingMergeTree', version: 'version', partition: '', order: 'amm_account' },
  [Table.AmmDaily]: {
    engine: 'ReplacingMergeTree',
    version: 'version',
    partition: 'toYYYYMM(day)',
    order: 'amm_account, day',
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
  Table.AmmPoolStates,
  Table.AmmPoolTouches,
  Table.AmmLiquidity,
  Table.AccountAmmLiquidity,
  Table.AmmGovernance,
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
          `SELECT table, name, type FROM system.data_skipping_indices WHERE database = {db:String} ORDER BY table, name`,
          { db: 'xahau' },
        );
        expect(idx).toEqual([
          { table: Table.AccountAmmLiquidity, name: 'ledger_mm', type: 'minmax' },
          { table: Table.AccountExchanges, name: 'amm_account_set', type: 'set' },
          { table: Table.AccountsCreated, name: 'account_bf', type: 'bloom_filter' },
          { table: Table.AmmGovernance, name: 'ledger_mm', type: 'minmax' },
          { table: Table.AmmLiquidity, name: 'ledger_mm', type: 'minmax' },
          { table: Table.AmmPoolStates, name: 'ledger_mm', type: 'minmax' },
          { table: Table.Exchanges, name: 'amm_account_set', type: 'set' },
          { table: Table.Ledgers, name: 'close_time_mm', type: 'minmax' },
        ]);
      });

      it('lets `amm=only` reads skip granules without AMM rows: a set(1024) index on amm_account (R-A1)', async () => {
        const idx = await svc.query<{
          table: string;
          name: string;
          type_full: string;
          expr: string;
          granularity: number;
        }>(
          `SELECT table, name, type_full, expr, granularity FROM system.data_skipping_indices
           WHERE database = {db:String} AND name = 'amm_account_set' ORDER BY table`,
          { db: 'xahau' },
        );
        expect(idx.map((i) => ({ ...i, granularity: Number(i.granularity) }))).toEqual([
          {
            table: Table.AccountExchanges,
            name: 'amm_account_set',
            type_full: 'set(1024)',
            expr: 'amm_account',
            granularity: 1,
          },
          {
            table: Table.Exchanges,
            name: 'amm_account_set',
            type_full: 'set(1024)',
            expr: 'amm_account',
            granularity: 1,
          },
        ]);
      });

      it('lets watermark and day scans skip parts of the AMM ledger tables: a minmax index on ledger_index (R-A2)', async () => {
        const idx = await svc.query<{
          table: string;
          name: string;
          type_full: string;
          expr: string;
          granularity: number;
        }>(
          `SELECT table, name, type_full, expr, granularity FROM system.data_skipping_indices
           WHERE database = {db:String} AND name = 'ledger_mm' ORDER BY table`,
          { db: 'xahau' },
        );
        expect(idx.map((i) => ({ ...i, granularity: Number(i.granularity) }))).toEqual(
          [Table.AccountAmmLiquidity, Table.AmmGovernance, Table.AmmLiquidity, Table.AmmPoolStates].map((table) => ({
            table,
            name: 'ledger_mm',
            type_full: 'minmax',
            expr: 'ledger_index',
            granularity: 1,
          })),
        );
      });

      it('the baseline creates the AMM tables with their keys', async () => {
        const rows = await systemTables();
        const keys = Object.fromEntries(
          rows.map((t) => [t.name, { sorting: t.sorting_key, partition: t.partition_key }]),
        );
        const ledgerP7 = 'intDiv(ledger_index, 10000000)';
        const ledgerP6 = 'intDiv(ledger_index, 1000000)';

        expect({
          [Table.AmmPoolStates]: keys[Table.AmmPoolStates],
          [Table.AmmPoolTouches]: keys[Table.AmmPoolTouches],
          [Table.AmmLiquidity]: keys[Table.AmmLiquidity],
          [Table.AccountAmmLiquidity]: keys[Table.AccountAmmLiquidity],
          [Table.AmmGovernance]: keys[Table.AmmGovernance],
          [Table.AmmPools]: keys[Table.AmmPools],
          [Table.AmmDaily]: keys[Table.AmmDaily],
        }).toEqual({
          amm_pool_states: { sorting: 'amm_account, ledger_index, tx_index', partition: ledgerP7 },
          amm_pool_touches: { sorting: 'ledger_index, tx_index, amm_account', partition: ledgerP6 },
          amm_liquidity: { sorting: 'amm_account, ledger_index, tx_index', partition: ledgerP7 },
          account_amm_liquidity: { sorting: 'account, ledger_index, tx_index, amm_account', partition: ledgerP7 },
          amm_governance: { sorting: 'amm_account, ledger_index, tx_index', partition: ledgerP7 },
          amm_pools: { sorting: 'amm_account', partition: '' },
          amm_daily: { sorting: 'amm_account, day', partition: 'toYYYYMM(day)' },
        });

        const engines = Object.fromEntries(rows.map((t) => [t.name, t.engine_full.split(' ')[0]]));
        expect(engines[Table.AmmPools]).toBe('ReplacingMergeTree(version)');
        expect(engines[Table.AmmDaily]).toBe('ReplacingMergeTree(version)');
        for (const table of [
          Table.AmmPoolStates,
          Table.AmmPoolTouches,
          Table.AmmLiquidity,
          Table.AccountAmmLiquidity,
          Table.AmmGovernance,
        ]) {
          expect({ table, engine: engines[table] }).toEqual({ table, engine: 'ReplacingMergeTree' });
        }
      });

      it('gives exchanges and account_exchanges an amm_account String column, empty for order-book trades', async () => {
        const cols = await svc.query<{ table: string; name: string; type: string; default_kind: string }>(
          `SELECT table, name, type, default_kind FROM system.columns
           WHERE database = {db:String} AND name = 'amm_account' AND table IN ({exchanges:String}, {account:String})
           ORDER BY table`,
          { db: 'xahau', exchanges: Table.Exchanges, account: Table.AccountExchanges },
        );
        expect(cols).toEqual([
          { table: Table.AccountExchanges, name: 'amm_account', type: 'String', default_kind: '' },
          { table: Table.Exchanges, name: 'amm_account', type: 'String', default_kind: '' },
        ]);
      });

      it('gives amm_daily the columns of a day, in order: the finality flag of the sentinel is a UInt8 before the versions', async () => {
        const cols = await svc.query<{ name: string; type: string }>(
          `SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
          { db: 'xahau', t: Table.AmmDaily },
        );
        expect(cols.map((c) => [c.name, c.type])).toEqual([
          ['amm_account', 'String'],
          ['day', 'Date'],
          ['base_currency', 'LowCardinality(String)'],
          ['base_issuer', 'String'],
          ['counter_currency', 'LowCardinality(String)'],
          ['counter_issuer', 'String'],
          ['swap_count', 'UInt64'],
          ['volume_base', 'String'],
          ['volume_counter', 'String'],
          ['fees_base_est', 'String'],
          ['fees_counter_est', 'String'],
          ['deposit_count', 'UInt64'],
          ['withdraw_count', 'UInt64'],
          ['liquidity_in_base', 'String'],
          ['liquidity_in_counter', 'String'],
          ['liquidity_out_base', 'String'],
          ['liquidity_out_counter', 'String'],
          ['reserve_base', 'Nullable(String)'],
          ['reserve_counter', 'Nullable(String)'],
          ['lp_supply', 'Nullable(String)'],
          ['trading_fee', 'Nullable(UInt16)'],
          ['value_native', 'Nullable(Float64)'],
          ['final', 'UInt8'],
          ['config_version', 'UInt32'],
          ['version', 'UInt64'],
        ]);
      });

      it('types the values of a pool state as Nullable, so a reader can tell "unchanged" from a value', async () => {
        const cols = await svc.query<{ name: string; type: string }>(
          `SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
          { db: 'xahau', t: Table.AmmPoolStates },
        );
        const types = Object.fromEntries(cols.map((c) => [c.name, c.type]));
        expect(types).toEqual({
          amm_account: 'String',
          ledger_index: 'UInt32',
          tx_index: 'UInt32',
          tx_hash: 'String',
          close_time: "DateTime('UTC')",
          tx_type: 'LowCardinality(String)',
          base_currency: 'LowCardinality(String)',
          base_issuer: 'String',
          counter_currency: 'LowCardinality(String)',
          counter_issuer: 'String',
          reserve_base: 'Nullable(String)',
          reserve_counter: 'Nullable(String)',
          lp_supply: 'Nullable(String)',
          lp_currency: 'Nullable(String)',
          reserve_base_f: 'Nullable(Float64)',
          reserve_counter_f: 'Nullable(Float64)',
          lp_supply_f: 'Nullable(Float64)',
          trading_fee: 'Nullable(UInt16)',
          auction_holder: 'Nullable(String)',
          auction_price: 'Nullable(String)',
          auction_price_f: 'Nullable(Float64)',
          auction_discounted_fee: 'Nullable(UInt16)',
          auction_expiration: 'Nullable(UInt32)',
          deleted: 'UInt8',
        });
      });

      it('keeps amm_pool_touches narrow: the ledger, the transaction and the pool, in the order of its key', async () => {
        const cols = await svc.query<{ name: string; type: string }>(
          `SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
          { db: 'xahau', t: Table.AmmPoolTouches },
        );
        expect(cols).toEqual([
          { name: 'ledger_index', type: 'UInt32' },
          { name: 'tx_index', type: 'UInt32' },
          { name: 'amm_account', type: 'String' },
        ]);
      });

      it('types the liquidity and governance columns', async () => {
        const typesOf = async (table: Table) =>
          Object.fromEntries(
            (
              await svc.query<{ name: string; type: string }>(
                `SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
                { db: 'xahau', t: table },
              )
            ).map((c) => [c.name, c.type]),
          );
        const liquidity = {
          amm_account: 'String',
          ledger_index: 'UInt32',
          tx_index: 'UInt32',
          tx_hash: 'String',
          close_time: "DateTime('UTC')",
          account: 'String',
          initiator: 'String',
          event: 'LowCardinality(String)',
          mode: 'LowCardinality(String)',
          base_amount: 'String',
          counter_amount: 'String',
          lp_tokens: 'String',
          base_amount_f: 'Float64',
          counter_amount_f: 'Float64',
          lp_tokens_f: 'Float64',
        };
        expect(await typesOf(Table.AmmLiquidity)).toEqual(liquidity);
        // The per-account index has the same columns.
        expect(await typesOf(Table.AccountAmmLiquidity)).toEqual(liquidity);
        expect(await typesOf(Table.AmmGovernance)).toEqual({
          amm_account: 'String',
          ledger_index: 'UInt32',
          tx_index: 'UInt32',
          tx_hash: 'String',
          close_time: "DateTime('UTC')",
          kind: 'LowCardinality(String)',
          account: 'String',
          fee_voted: 'Nullable(UInt16)',
          trading_fee_after: 'Nullable(UInt16)',
          bid_min: 'Nullable(String)',
          bid_max: 'Nullable(String)',
          price_paid: 'Nullable(String)',
          slot_holder: 'Nullable(String)',
          slot_discounted_fee: 'Nullable(UInt16)',
          slot_expiration: 'Nullable(UInt32)',
          auth_accounts: 'Array(String)',
        });
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

      it('stores NULL for the pool-state values whose node the transaction did not carry', async () => {
        const state = SAMPLE_ROWS[Table.AmmPoolStates];
        await svc.insert(Table.AmmPoolStates, [
          {
            ...state,
            tx_index: 6,
            reserve_base: null,
            reserve_counter: null,
            lp_supply: null,
            lp_currency: null,
            reserve_base_f: null,
            reserve_counter_f: null,
            lp_supply_f: null,
            trading_fee: null,
            auction_holder: null,
            auction_price: null,
            auction_price_f: null,
            auction_discounted_fee: null,
            auction_expiration: null,
          },
        ]);
        const row = await svc.queryOne(
          `SELECT reserve_base, reserve_counter, lp_supply, lp_currency, reserve_base_f, reserve_counter_f, lp_supply_f,
                  trading_fee, auction_holder, auction_price, auction_price_f, auction_discounted_fee, auction_expiration,
                  deleted
           FROM amm_pool_states WHERE tx_index = 6`,
        );
        expect(row).toEqual({
          reserve_base: null,
          reserve_counter: null,
          lp_supply: null,
          lp_currency: null,
          reserve_base_f: null,
          reserve_counter_f: null,
          lp_supply_f: null,
          trading_fee: null,
          auction_holder: null,
          auction_price: null,
          auction_price_f: null,
          auction_discounted_fee: null,
          auction_expiration: null,
          deleted: 0,
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

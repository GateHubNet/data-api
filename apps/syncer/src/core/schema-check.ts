import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { WorkerName } from '../config/syncer.config';

/** The migration that adds what the validations and the validators workers write. */
export const VALIDATORS_MIGRATION = '002_validators_amendments.sql';

/** The workers that write the columns and the tables of `VALIDATORS_MIGRATION`. */
export const VALIDATORS_SCHEMA_WORKERS: ReadonlySet<WorkerName> = new Set<WorkerName>(['validations', 'validators']);

/** The columns `VALIDATORS_MIGRATION` adds to the tables of 001. */
const ADDED_COLUMNS: readonly (readonly [table: Table, column: string])[] = [
  [Table.Validations, 'server_version'],
  [Table.ValidatorManifests, 'domain'],
  [Table.ValidatorManifests, 'manifest'],
  [Table.ValidatorManifests, 'source'],
];

/** The tables `VALIDATORS_MIGRATION` creates. */
const ADDED_TABLES: readonly Table[] = [
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
];

/**
 * Fails the boot when a worker that writes the tables of `002_validators_amendments.sql` is enabled and the database lacks
 * them: without it the collector's flushes and the worker's writes fail one by one, quietly, for as long as the syncer runs.
 * It runs after the boot-time migrations. A check that cannot be made (ClickHouse unreachable) does not fail the boot: it is
 * said, and the workers report the failures of their writes as they always do.
 */
export async function assertValidatorsSchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  const workers = [...enabled].filter((name) => VALIDATORS_SCHEMA_WORKERS.has(name));
  if (workers.length === 0) return;
  let rows: { column_table: string; column_name: string }[];
  try {
    rows = await ch.query<{ column_table: string; column_name: string }>(
      `SELECT table AS column_table, name AS column_name
         FROM system.columns
        WHERE database = currentDatabase() AND table IN {tables:Array(String)}
        ORDER BY table, name`,
      { tables: [...new Set([...ADDED_COLUMNS.map(([table]) => table), ...ADDED_TABLES])] },
    );
  } catch (err) {
    logger.warn(
      `Could not check that ${VALIDATORS_MIGRATION} is applied (${err instanceof Error ? err.message : String(err)}); ` +
        'the workers start without the check',
    );
    return;
  }
  const columns = new Set(rows.map((row) => `${row.column_table}.${row.column_name}`));
  const tables = new Set(rows.map((row) => row.column_table));
  const missing = [
    ...ADDED_COLUMNS.filter(([table, column]) => !columns.has(`${table}.${column}`)).map(
      ([table, column]) => `column ${table}.${column}`,
    ),
    ...ADDED_TABLES.filter((table) => !tables.has(table)).map((table) => `table ${table}`),
  ];
  if (missing.length === 0) return;
  throw new Error(
    `The ClickHouse database "${database}" lacks the schema of ${VALIDATORS_MIGRATION} (${missing.join(', ')}), which ` +
      `the ${workers.join(' and ')} ${workers.length === 1 ? 'worker writes' : 'workers write'}: apply the migrations ` +
      '(pnpm --filter @gatehub/data-api-shared ch:migrate, or GH_RUN_MIGRATIONS_ON_BOOT=true) and start the syncer again',
  );
}

/** The migration that adds the toml facts to `validator_domains`. */
export const VALIDATOR_TOML_MIGRATION = '016_validator_toml_details.sql';

/** The columns `VALIDATOR_TOML_MIGRATION` adds. */
const VALIDATOR_TOML_COLUMNS = ['owner_country', 'server_country', 'toml_network', 'toml_unl', 'toml_version'] as const;

/**
 * Fails the boot when the validators worker is enabled and `validator_domains` lacks the columns of
 * `016_validator_toml_details.sql`: the domain checker reads them in every pass and writes them with every row, so without them
 * every pass fails. It reads `system.columns`, since 016 adds columns and no table. It runs after the boot-time migrations and
 * after the check of 015. A check that cannot be made (ClickHouse unreachable) does not fail the boot: it is said, and the worker
 * reports the failures of its reads as it always does.
 */
export async function assertValidatorTomlSchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  if (!enabled.has('validators')) return;
  let rows: { column_name: string }[];
  try {
    rows = await ch.query<{ column_name: string }>(
      `SELECT name AS column_name
         FROM system.columns
        WHERE database = currentDatabase() AND table IN {tables:Array(String)}`,
      { tables: [Table.ValidatorDomains] },
    );
  } catch (err) {
    logger.warn(
      `Could not check that ${VALIDATOR_TOML_MIGRATION} is applied (${err instanceof Error ? err.message : String(err)}); ` +
        'the workers start without the check',
    );
    return;
  }
  const columns = new Set(rows.map((row) => row.column_name));
  const missing = VALIDATOR_TOML_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length === 0) return;
  throw new Error(
    `The ClickHouse database "${database}" lacks the schema of ${VALIDATOR_TOML_MIGRATION} ` +
      `(${missing.map((column) => `column ${Table.ValidatorDomains}.${column}`).join(', ')}), which the validators worker ` +
      'reads and writes: apply the migrations (pnpm --filter @gatehub/data-api-shared ch:migrate, or ' +
      'GH_RUN_MIGRATIONS_ON_BOOT=true) and start the syncer again',
  );
}

/** The migration that adds what the tomls worker reads and writes. */
export const TOMLS_MIGRATION = '012_display_names.sql';

/** The workers that read and write the tables of `TOMLS_MIGRATION`. */
export const TOMLS_SCHEMA_WORKERS: ReadonlySet<WorkerName> = new Set<WorkerName>(['tomls']);

/** The tables `TOMLS_MIGRATION` creates. */
const TOMLS_TABLES: readonly Table[] = [Table.AccountDomains, Table.DomainTomls];

/**
 * Fails the boot when the tomls worker is enabled and the database lacks the tables of `012_display_names.sql`: without them
 * its discovery and every pass fail, and a worker that fails at once looks idle, so the failure is said at the start instead.
 * It runs after the boot-time migrations. A check that cannot be made (ClickHouse unreachable) does not fail the boot: it is
 * said, and the worker reports the failures of its reads as it always does.
 */
export async function assertTomlsSchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  if (![...enabled].some((name) => TOMLS_SCHEMA_WORKERS.has(name))) return;
  let rows: { table_name: string }[];
  try {
    rows = await ch.query<{ table_name: string }>(
      `SELECT name AS table_name
         FROM system.tables
        WHERE database = currentDatabase() AND name IN {tables:Array(String)}
        ORDER BY name`,
      { tables: [...TOMLS_TABLES] },
    );
  } catch (err) {
    logger.warn(
      `Could not check that ${TOMLS_MIGRATION} is applied (${err instanceof Error ? err.message : String(err)}); ` +
        'the tomls worker starts without the check',
    );
    return;
  }
  const present = new Set(rows.map((row) => row.table_name));
  const missing = TOMLS_TABLES.filter((table) => !present.has(table)).map((table) => `table ${table}`);
  if (missing.length === 0) return;
  throw new Error(
    `The ClickHouse database "${database}" lacks the schema of ${TOMLS_MIGRATION} (${missing.join(', ')}), which ` +
      'the tomls worker reads and writes: apply the migrations (pnpm --filter @gatehub/data-api-shared ch:migrate, or ' +
      'GH_RUN_MIGRATIONS_ON_BOOT=true) and start the syncer again',
  );
}

/** The tables of one migration each worker needs, and what it does with them. */
type SchemaNeeds = ReadonlyMap<WorkerName, { tables: readonly Table[]; does: string }>;

/**
 * Fails the boot when a worker of `needs` is enabled and the database lacks the tables of `migration` it needs, naming the file,
 * the tables and what the workers do with them. A check that cannot be made (ClickHouse unreachable) does not fail the boot: it
 * is said, and the workers report the failures of their reads and writes as they always do. Shared by the checks of 014, 015 and 017.
 */
async function assertTablesOf(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
  migration: string,
  needs: SchemaNeeds,
): Promise<void> {
  const workers = [...needs.keys()].filter((name) => enabled.has(name));
  if (workers.length === 0) return;
  const wanted = [...new Set(workers.flatMap((name) => needs.get(name)?.tables ?? []))];
  const who = (list: readonly WorkerName[]): string =>
    `${list.join(' and ')} ${list.length === 1 ? 'worker' : 'workers'}`;
  let rows: { table_name: string }[];
  try {
    rows = await ch.query<{ table_name: string }>(
      `SELECT name AS table_name
         FROM system.tables
        WHERE database = currentDatabase() AND name IN {tables:Array(String)}
        ORDER BY name`,
      { tables: wanted },
    );
  } catch (err) {
    logger.warn(
      `Could not check that ${migration} is applied (${err instanceof Error ? err.message : String(err)}); ` +
        `the ${who(workers)} ${workers.length === 1 ? 'starts' : 'start'} without the check`,
    );
    return;
  }
  const present = new Set(rows.map((row) => row.table_name));
  const missing = wanted.filter((table) => !present.has(table)).map((table) => `table ${table}`);
  if (missing.length === 0) return;
  const does = workers.map((name) => `the ${name} worker ${needs.get(name)?.does}`).join(' and ');
  throw new Error(
    `The ClickHouse database "${database}" lacks the schema of ${migration} (${missing.join(', ')}), which ` +
      `${does}: apply the migrations (pnpm --filter @gatehub/data-api-shared ch:migrate, or GH_RUN_MIGRATIONS_ON_BOOT=true) ` +
      'and start the syncer again',
  );
}

/** The migration that adds what the ingest writes with every ledger (`state_touches`) and what the aggregator's `tokens` job keeps. */
export const ISSUED_TOKENS_MIGRATION = '014_issued_tokens.sql';

/**
 * The tables of `ISSUED_TOKENS_MIGRATION` each worker needs, and what it does with them. The ingest writes `state_touches` with every
 * ledger; the `tokens` job of the aggregator reads that table and keeps the three aggregates.
 */
const ISSUED_TOKENS_NEEDS: SchemaNeeds = new Map([
  ['ingest', { tables: [Table.StateTouches], does: 'writes' }],
  [
    'aggregator',
    {
      tables: [Table.StateTouches, Table.TokenGenerations, Table.TokenLines, Table.Tokens],
      does: 'reads and writes',
    },
  ],
]);

/**
 * Fails the boot when the ingest or the aggregator worker is enabled and the database lacks the tables of `014_issued_tokens.sql`
 * the worker needs (the ingest `state_touches`, the aggregator all four): without them the live runner would retry the same ledgers
 * without end, and a `tokens` job that cannot read its generations makes its hook throw on every `agg_dirty` slice, so that the
 * queue stops draining for every job. It runs after the boot-time migrations. A check that cannot be made (ClickHouse unreachable)
 * does not fail the boot: it is said, and the workers report the failures of their reads and writes as they always do.
 */
export async function assertIssuedTokensSchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  await assertTablesOf(ch, enabled, database, logger, ISSUED_TOKENS_MIGRATION, ISSUED_TOKENS_NEEDS);
}

/** The migration that adds the mint tables the ingest writes when a ledger has mint rows, and the snapshot table the aggregator's `supply` job writes. */
export const SUPPLY_MIGRATION = '015_supply.sql';

/**
 * The tables of `SUPPLY_MIGRATION` each worker needs, and what it does with them. The ingest writes the three mint tables
 * (`genesis_mints`, `imports`, `reward_claims`) whenever a ledger has mint rows. The `supply` job of the aggregator writes its
 * snapshots to `network_supply` and reads the mint tables for the minted sums. The schema is one on every network, so each worker
 * needs its tables wherever it runs.
 */
const SUPPLY_NEEDS: SchemaNeeds = new Map([
  ['ingest', { tables: [Table.GenesisMints, Table.Imports, Table.RewardClaims], does: 'writes' }],
  [
    'aggregator',
    {
      tables: [Table.GenesisMints, Table.Imports, Table.RewardClaims, Table.NetworkSupply],
      does: 'reads and writes',
    },
  ],
]);

/**
 * Fails the boot when the ingest or the aggregator worker is enabled and the database lacks the tables of `015_supply.sql` the
 * worker needs (the ingest the three mint tables, the aggregator those and `network_supply`). The schema is one on every network,
 * so the check does not ask which one this is. On Xahau the ingest inserts into the mint tables as soon as a ledger holds a mint,
 * and an insert into a missing table fails the batch, so that the live runner would retry the same ledgers without end. The
 * `supply` job of the aggregator reads the newest snapshot at every run and writes the next one: without its table it fails at
 * every run, and on Xahau its minted steps read the mint tables. It runs after the boot-time migrations and after the check of 014,
 * which it follows in the same way. A check that cannot be made (ClickHouse unreachable) does not fail the boot: it is said, and the
 * workers report the failures of their reads and writes as they always do.
 */
export async function assertSupplySchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  await assertTablesOf(ch, enabled, database, logger, SUPPLY_MIGRATION, SUPPLY_NEEDS);
}

/** MPTokens: the five ledger tables the ingest writes, and the two aggregates of the `mpt_state` job. */
export const MPT_MIGRATION = '017_mpt.sql';

/**
 * The tables of `MPT_MIGRATION` each worker needs, and what it does with them. The ingest writes the five ledger tables whenever a
 * ledger has rows for one. The `mpt_state` job of the aggregator reads the touches and the two state tables at every run, on every
 * network, and writes the two aggregates. The schema is one on every network, so the worker needs its tables wherever it runs.
 */
const MPT_NEEDS: SchemaNeeds = new Map([
  [
    'ingest',
    {
      tables: [
        Table.MptIssuanceStates,
        Table.MptHolderStates,
        Table.MptTouches,
        Table.MptTransfers,
        Table.MptIssuanceTransfers,
      ],
      does: 'writes',
    },
  ],
  [
    'aggregator',
    {
      tables: [Table.MptIssuanceStates, Table.MptHolderStates, Table.MptTouches, Table.MptIssuances, Table.MptHolders],
      does: 'reads and writes',
    },
  ],
]);

/**
 * Fails the boot when the ingest or the aggregator worker is enabled and the database lacks the tables of `017_mpt.sql` it needs. The
 * schema is one on every network, so the check does not ask which one this is. On XRPL and XRPL Testnet the ingest inserts into the five
 * ledger tables as soon as a ledger has MPT rows, and an insert into a missing table fails the batch, so that the live runner would retry
 * the same ledgers without end; the `mpt_state` job of the aggregator would fail at every run, and its hook every slice of `agg_dirty`.
 * It runs after the boot-time migrations and after the check of 016. A check that cannot be made (ClickHouse unreachable) does
 * not fail the boot: it is said, and the workers report the failures of their reads and writes as they always do.
 */
export async function assertMptSchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  await assertTablesOf(ch, enabled, database, logger, MPT_MIGRATION, MPT_NEEDS);
}

/** The token history (issuer analytics): the seven tables the `token_history` worker reads and writes, and the aggregator's dirty ranges. */
export const TOKEN_HISTORY_MIGRATION = '019_token_history.sql';

/**
 * The tables `TOKEN_HISTORY_MIGRATION` each worker needs, and what it does with them. The `token_history` worker reads and writes the
 * seven tables of 019 and reads the state tables, the touches, `tx_by_type` and `pair_hourly` (of 006, 014, 017, 001 and 003) that its
 * live windows, repairs and DEX hours start from. The aggregator's eighth `agg_dirty` hook writes `token_history_dirty`, whether or
 * not the worker runs.
 */
const TOKEN_HISTORY_NEEDS: SchemaNeeds = new Map([
  [
    'token_history',
    {
      tables: [
        Table.TokenHolderChanges,
        Table.TokenCheckpoints,
        Table.TokenCheckpointHeads,
        Table.TokenHourly,
        Table.TokenHourlyDex,
        Table.TokenHistoryState,
        Table.TokenHistoryDirty,
        Table.StateTouches,
        Table.TrustLineStates,
        Table.MptTouches,
        Table.MptHolderStates,
        Table.TxByType,
        Table.PairHourly,
      ],
      does: 'reads and writes',
    },
  ],
  ['aggregator', { tables: [Table.TokenHistoryDirty], does: 'writes' }],
]);

/**
 * Fails the boot when the `token_history` worker or the aggregator is enabled and the database lacks the tables of
 * `019_token_history.sql` it needs (the worker all of them, the aggregator `token_history_dirty`): the worker would fail every pass, and
 * the aggregator's hook would throw on every `agg_dirty` slice. It runs after the boot-time migrations. A check that cannot be made
 * (ClickHouse unreachable) does not fail the boot: it is said, and the workers report the failures of their reads and writes.
 */
export async function assertTokenHistorySchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  await assertTablesOf(ch, enabled, database, logger, TOKEN_HISTORY_MIGRATION, TOKEN_HISTORY_NEEDS);
}

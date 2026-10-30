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
 * is said, and the workers report the failures of their reads and writes as they always do. Shared by the checks of 014 and 015.
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

/** The migration that adds the Xahau mint tables the ingest writes when a ledger has mint rows, and the supply tables the aggregator keeps. */
export const SUPPLY_MIGRATION = '015_supply.sql';

/**
 * The tables of `SUPPLY_MIGRATION` each worker needs, and what it does with them. The ingest writes the three mint tables
 * (`genesis_mints`, `imports`, `reward_claims`) whenever a ledger has mint rows.
 */
const SUPPLY_NEEDS: SchemaNeeds = new Map([
  ['ingest', { tables: [Table.GenesisMints, Table.Imports, Table.RewardClaims], does: 'writes' }],
]);

/**
 * Fails the boot when the ingest worker is enabled and the database lacks the three mint tables of `015_supply.sql`. The schema is
 * one on every network, so the check does not ask which one this is; on Xahau the ingest inserts into the tables as soon as a
 * ledger holds a mint, and an insert into a missing table fails the batch, so that the live runner would retry the same ledgers
 * without end. It runs after the boot-time migrations and after the check of 014, which it follows in the same way. A check that
 * cannot be made (ClickHouse unreachable) does not fail the boot: it is said, and the worker reports the failures of its writes as
 * it always does.
 */
export async function assertSupplySchema(
  ch: Pick<ClickHouseService, 'query'>,
  enabled: ReadonlySet<WorkerName>,
  database: string,
  logger: { warn(message: string): void },
): Promise<void> {
  await assertTablesOf(ch, enabled, database, logger, SUPPLY_MIGRATION, SUPPLY_NEEDS);
}

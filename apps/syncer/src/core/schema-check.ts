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

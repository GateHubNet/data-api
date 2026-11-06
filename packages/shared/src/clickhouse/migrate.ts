/**
 * Schema migration runner.
 *
 * Each `*.sql` file in `packages/shared/schema/` (or in `GH_SCHEMA_DIR`) is one migration unit of a network database. The
 * shared database (ADR-0014) has a set of its own in `packages/shared/schema-shared/` (`runSharedMigrations`). The runner:
 *   1. creates the target database (through a client bound to `default`, which always exists; a Replicated database
 *      on every replica when `GH_CLICKHOUSE_CLUSTER` is set) and a `schema_migrations` bookkeeping table,
 *   2. reads which files have already been applied and verifies their sha256 checksum — an applied file that changed
 *      is a hard error, never silently re-run or skipped,
 *   3. applies only the new files (in lexical order), statement by statement,
 *   4. records each applied file with its checksum.
 *
 * All DDL is also written `CREATE ... IF NOT EXISTS`, so a file that failed half way can simply be re-run.
 *
 * Run as a one-shot, controlled step (CI job / the `migrate` service in the production
 * compose) — not concurrently from every syncer replica.
 *
 *   pnpm --filter @gatehub/data-api-shared ch:migrate           the network database (GH_CLICKHOUSE_DATABASE or GH_NETWORK)
 *   pnpm --filter @gatehub/data-api-shared ch:migrate shared    the shared database (GH_CLICKHOUSE_SHARED_DATABASE, `shared`)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertValidDatabaseName,
  ClickHouseConfig,
  clickHouseConfigFromEnv,
  sharedDatabaseFromEnv,
} from './clickhouse.config';
import { ClickHouseService, type CommandOptions } from './clickhouse.service';

/** `src/clickhouse` and `dist/clickhouse` are both two levels below the package root, which ships `schema/`. */
const DEFAULT_SCHEMA_DIR = join(__dirname, '..', '..', 'schema');
/** The migration set of the shared database (ADR-0014), which the package ships next to `schema/`. */
export const SHARED_SCHEMA_DIR = join(__dirname, '..', '..', 'schema-shared');
const MIGRATIONS_TABLE = 'schema_migrations';

export interface MigrateOptions {
  /** Connection to migrate. Defaults to `clickHouseConfigFromEnv()`. */
  config?: ClickHouseConfig;
  /** Progress sink. Defaults to `console.log`. */
  log?: (message: string) => void;
  /** The directory of the migration set. Defaults to `GH_SCHEMA_DIR`, else the network set `schema/`. */
  schemaDir?: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/**
 * On a single server, a plain database. On a cluster (`GH_CLICKHOUSE_CLUSTER`), a Replicated database created on every
 * replica: Keeper replays each later CREATE/ALTER on all of them, so the migrations run once. It replicates only the
 * metadata: the data of a table is replicated by its engine (`replicatedEngines`). Both names are validated before
 * they get here.
 */
export function createDatabaseStatement(database: string, cluster?: string): string {
  if (!cluster) return 'CREATE DATABASE IF NOT EXISTS {database:Identifier}';
  return (
    `CREATE DATABASE IF NOT EXISTS ${database} ON CLUSTER '${cluster}' ` +
    `ENGINE = Replicated('/clickhouse/databases/${database}', '{shard}', '{replica}')`
  );
}

/**
 * On a cluster, a `*MergeTree` engine becomes its `Replicated*MergeTree` twin, so the data reaches every replica, not
 * only the one that was written to. No Keeper path or replica name: the Replicated database gives each table its
 * default ones. The files keep the single-server engines, and their checksums, for both paths.
 */
export function replicatedEngines(statement: string): string {
  return statement.replace(/\bENGINE(\s*)=(\s*)(?!Replicated)(\w*MergeTree)\b/g, 'ENGINE$1=$2Replicated$3');
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function runMigrations(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const config = opts.config ?? clickHouseConfigFromEnv();
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((message: string) => console.log(message));
  const database = assertValidDatabaseName(config.database);
  const schemaDir = opts.schemaDir ?? (process.env.GH_SCHEMA_DIR || DEFAULT_SCHEMA_DIR);

  // The target database may not exist yet, so create it through a connection bound to `default`.
  const bootstrap = new ClickHouseService({ ...config, database: 'default' });
  try {
    await bootstrap.command(createDatabaseStatement(database, config.cluster), { database });
  } finally {
    await bootstrap.close();
  }

  const service = new ClickHouseService({ ...config, database });
  // On a cluster a table left unreplicated would keep its rows on one replica (for `schema_migrations`, the history the
  // next run reads), so the server refuses one that slips past `replicatedEngines`.
  const replicatedOnly: CommandOptions = { settings: { database_replicated_allow_only_replicated_engine: 1 } };
  const ddl = config.cluster
    ? (statement: string) => service.command(replicatedEngines(statement), {}, replicatedOnly)
    : (statement: string) => service.command(statement);
  try {
    await ddl(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} ` +
        `(filename String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY filename`,
    );

    const recorded = new Map(
      (
        await service.query<{ filename: string; checksum: string }>(
          `SELECT filename, checksum FROM ${MIGRATIONS_TABLE}`,
        )
      ).map((r) => [r.filename, r.checksum]),
    );

    const files = readdirSync(schemaDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((filename) => {
        const content = readFileSync(join(schemaDir, filename), 'utf8');
        return { filename, content, checksum: checksum(content) };
      });

    // Verify every applied file before applying anything new, so a modified history never half-migrates.
    for (const file of files) {
      const previous = recorded.get(file.filename);
      if (previous !== undefined && previous !== file.checksum) {
        throw new Error(`Migration ${file.filename} was modified after being applied`);
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      if (recorded.has(file.filename)) {
        skipped.push(file.filename);
        continue;
      }
      for (const statement of splitStatements(file.content)) {
        log(`[migrate] ${file.filename}: ${statement.slice(0, 80).replace(/\s+/g, ' ')}…`);
        await ddl(statement);
      }
      await service.insert(MIGRATIONS_TABLE, [{ filename: file.filename, checksum: file.checksum }]);
      applied.push(file.filename);
    }

    log(`[migrate] db="${database}" applied=${applied.length} skipped=${skipped.length}`);
    return { applied, skipped };
  } finally {
    await service.close();
  }
}

/**
 * Migrates the shared database (ADR-0014) with its own set, `schema-shared/`, and its own `schema_migrations`. The
 * database is the one of `config` when given, else `GH_CLICKHOUSE_SHARED_DATABASE` (default `shared`) on the server of
 * `clickHouseConfigFromEnv()`. One job runs it, before the apis of every network start: two runners on one
 * `schema_migrations` would race.
 */
export async function runSharedMigrations(opts: Omit<MigrateOptions, 'schemaDir'> = {}): Promise<MigrateResult> {
  const config = opts.config ?? { ...clickHouseConfigFromEnv(), database: sharedDatabaseFromEnv() };
  return runMigrations({ ...opts, config, schemaDir: SHARED_SCHEMA_DIR });
}

if (require.main === module) {
  const set = process.argv[2];
  if (set !== undefined && set !== 'shared') {
    // eslint-disable-next-line no-console
    console.error(`[migrate] unknown migration set "${set}": none (the network database) or "shared"`);
    process.exit(1);
  }
  (set === 'shared' ? runSharedMigrations() : runMigrations()).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}

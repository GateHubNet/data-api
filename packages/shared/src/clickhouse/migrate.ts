/**
 * Schema migration runner.
 *
 * Each `*.sql` file in `packages/shared/schema/` (or in `GH_SCHEMA_DIR`) is one migration unit. The runner:
 *   1. creates the target database (through a client bound to `default`, which always exists) and a
 *      `schema_migrations` bookkeeping table,
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
 *   pnpm --filter @gatehub/data-api-shared ch:migrate
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidDatabaseName, ClickHouseConfig, clickHouseConfigFromEnv } from './clickhouse.config';
import { ClickHouseService } from './clickhouse.service';

/** `src/clickhouse` and `dist/clickhouse` are both two levels below the package root, which ships `schema/`. */
const DEFAULT_SCHEMA_DIR = join(__dirname, '..', '..', 'schema');
const MIGRATIONS_TABLE = 'schema_migrations';

export interface MigrateOptions {
  /** Connection to migrate. Defaults to `clickHouseConfigFromEnv()`. */
  config?: ClickHouseConfig;
  /** Progress sink. Defaults to `console.log`. */
  log?: (message: string) => void;
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

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function runMigrations(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const config = opts.config ?? clickHouseConfigFromEnv();
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((message: string) => console.log(message));
  const database = assertValidDatabaseName(config.database);
  const schemaDir = process.env.GH_SCHEMA_DIR || DEFAULT_SCHEMA_DIR;

  // The target database may not exist yet, so create it through a connection bound to `default`.
  const bootstrap = new ClickHouseService({ ...config, database: 'default' });
  try {
    await bootstrap.command('CREATE DATABASE IF NOT EXISTS {database:Identifier}', { database });
  } finally {
    await bootstrap.onModuleDestroy();
  }

  const service = new ClickHouseService({ ...config, database });
  try {
    await service.command(
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
        await service.command(statement);
      }
      await service.insert(MIGRATIONS_TABLE, [{ filename: file.filename, checksum: file.checksum }]);
      applied.push(file.filename);
    }

    log(`[migrate] db="${database}" applied=${applied.length} skipped=${skipped.length}`);
    return { applied, skipped };
  } finally {
    await service.onModuleDestroy();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}

/**
 * Schema migration runner.
 *
 * Each `*.sql` file in `packages/shared/schema/` is one migration unit. The runner:
 *   1. ensures the target database and a `schema_migrations` bookkeeping table exist,
 *   2. reads which files have already been applied,
 *   3. applies only the new files (in lexical order), statement by statement,
 *   4. records each applied file.
 *
 * All DDL is also written `CREATE ... IF NOT EXISTS`, so even a re-applied file is a
 * no-op — the tracking table just avoids needless work and gives an audit trail.
 *
 * Run as a one-shot, controlled step (CI job / the `migrate` service in the production
 * compose) — not concurrently from every syncer replica.
 *
 *   pnpm --filter @gatehub/data-api-shared ch:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clickHouseConfigFromEnv } from './clickhouse.config';
import { ClickHouseService } from './clickhouse.service';

const SCHEMA_DIR = join(__dirname, '..', '..', 'schema');
const MIGRATIONS_TABLE = 'schema_migrations';

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

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const config = clickHouseConfigFromEnv();
  const service = new ClickHouseService(config);

  await service.command(`CREATE DATABASE IF NOT EXISTS ${config.database}`);
  await service.command(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (filename String, applied_at DateTime DEFAULT now()) ` +
      `ENGINE = MergeTree ORDER BY filename`,
  );

  const alreadyApplied = new Set(
    (await service.query<{ filename: string }>(`SELECT filename FROM ${MIGRATIONS_TABLE}`)).map((r) => r.filename),
  );

  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const statements = splitStatements(readFileSync(join(SCHEMA_DIR, file), 'utf8'));
    for (const statement of statements) {
      // eslint-disable-next-line no-console
      console.log(`[migrate] ${file}: ${statement.slice(0, 80).replace(/\s+/g, ' ')}…`);
      await service.command(statement);
    }
    await service.insert(MIGRATIONS_TABLE, [{ filename: file }]);
    applied.push(file);
  }

  await service.onModuleDestroy();
  // eslint-disable-next-line no-console
  console.log(`[migrate] db="${config.database}" applied=${applied.length} skipped=${skipped.length}`);
  return { applied, skipped };
}

if (require.main === module) {
  runMigrations().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}

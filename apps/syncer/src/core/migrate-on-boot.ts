import { ClickHouseConfig, MigrateOptions, MigrateResult, runMigrations } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';

/**
 * Applies the ClickHouse schema when `GH_RUN_MIGRATIONS_ON_BOOT` is on. It runs as an async provider, which Nest
 * resolves before any module's lifecycle hook, so every worker starts on a migrated database. Resolves to whether the
 * migrations ran.
 */
export async function migrateOnBoot(
  cfg: Pick<SyncerConfig, 'runMigrationsOnBoot'>,
  clickHouse: ClickHouseConfig,
  logger: { log(message: string): void },
  run: (opts: MigrateOptions) => Promise<MigrateResult> = runMigrations,
): Promise<boolean> {
  if (!cfg.runMigrationsOnBoot) return false;
  logger.log(`Applying ClickHouse schema migrations to database "${clickHouse.database}"`);
  await run({ config: clickHouse, log: (message) => logger.log(message) });
  return true;
}

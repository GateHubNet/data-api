import { ClickHouseConfig } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';
import { migrateOnBoot } from './migrate-on-boot';

const chConfig = { url: 'http://ch:8123', database: 'xrpl' } as ClickHouseConfig;
const cfg = (runMigrationsOnBoot: boolean) => ({ runMigrationsOnBoot }) as SyncerConfig;

describe('migrateOnBoot', () => {
  it('does nothing unless GH_RUN_MIGRATIONS_ON_BOOT is on', async () => {
    const run = jest.fn();
    await expect(migrateOnBoot(cfg(false), chConfig, { log: jest.fn() }, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('applies the migrations to the configured database and reports progress through the logger', async () => {
    const log = jest.fn();
    const run = jest.fn(async (opts: { config?: ClickHouseConfig; log?: (m: string) => void }) => {
      opts.log?.('applied 001_baseline.sql');
      return { applied: ['001_baseline.sql'], skipped: [] };
    });
    await expect(migrateOnBoot(cfg(true), chConfig, { log }, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ config: chConfig }));
    expect(log).toHaveBeenCalledWith('applied 001_baseline.sql');
  });

  it('fails the boot when a migration fails', async () => {
    const run = jest.fn().mockRejectedValue(new Error('checksum mismatch'));
    await expect(migrateOnBoot(cfg(true), chConfig, { log: jest.fn() }, run)).rejects.toThrow('checksum mismatch');
  });
});

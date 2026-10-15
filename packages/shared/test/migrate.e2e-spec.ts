import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const REAL_SCHEMA_DIR = join(__dirname, '..', 'schema');

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

import { ClickHouseService } from './clickhouse.service';
import { createDatabaseStatement, runMigrations, runSharedMigrations } from './migrate';

// No test here can reach a server, whatever the code does: an address left out must never reach whatever listens on this machine.
jest.mock('./clickhouse.service');

describe('the migrations without GH_CLICKHOUSE_URL', () => {
  const saved = process.env.GH_CLICKHOUSE_URL;
  beforeEach(() => {
    delete process.env.GH_CLICKHOUSE_URL;
    jest.mocked(ClickHouseService).mockClear();
  });
  afterAll(() => {
    if (saved !== undefined) process.env.GH_CLICKHOUSE_URL = saved;
  });

  it.each([
    ['the network database', runMigrations],
    ['the shared database', runSharedMigrations],
  ])('refuses %s before it makes a client', async (_, run) => {
    await expect(run({ log: () => undefined })).rejects.toThrow(/GH_CLICKHOUSE_URL/);
    expect(ClickHouseService).not.toHaveBeenCalled();
  });
});

describe('createDatabaseStatement', () => {
  it('creates a plain database on a single server', () => {
    expect(createDatabaseStatement('xrpl')).toBe('CREATE DATABASE IF NOT EXISTS {database:Identifier}');
  });

  it('creates a Replicated database on every replica of a cluster', () => {
    expect(createDatabaseStatement('xahau', 'clickhouse')).toBe(
      "CREATE DATABASE IF NOT EXISTS xahau ON CLUSTER 'clickhouse' " +
        "ENGINE = Replicated('/clickhouse/databases/xahau', '{shard}', '{replica}')",
    );
  });
});

import { ClickHouseService } from './clickhouse.service';
import { runMigrations, runSharedMigrations } from './migrate';

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

import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  ClickHouseService,
  getNetworkProfile,
  LedgerWriter,
  parseContextFor,
  readTokenHistoryStates,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { seedTokenHistoryWorld } from '../../../packages/shared/test/tokens-world';

const APP_ROOT = join(__dirname, '..');
const CLI_TIMEOUT_MS = 120_000;

let clickhouse: StartedClickHouse;
const services: ClickHouseService[] = [];

beforeAll(async () => {
  clickhouse = await startClickHouse();
});

afterAll(async () => {
  for (const s of services) await s.close();
  await clickhouse?.container.stop();
});

/** A migrated database with the token history's world and a fresh lease of the worker. */
async function seeded(database: string): Promise<ClickHouseService> {
  const config = { ...clickhouse.config, database };
  await runMigrations({ config, log: () => undefined });
  const ch = new ClickHouseService(config);
  services.push(ch);
  // the world is written by the shared sources, the CLI by the shared package: the two classes are the same code
  await seedTokenHistoryWorld(ch as never, new LedgerWriter(ch, parseContextFor(getNetworkProfile('xrpl'))) as never);
  await ch.command(
    `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl:token_history', 'worker-1', now64(3)`,
  );
  return ch;
}

describe('token-history-build CLI (e2e)', () => {
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = undefined;
  });

  /** Runs `src/cli/token-history-build.ts` as `node dist/cli/token-history-build.js` would, against the test's ClickHouse. */
  async function runCli(database: string, args: string[] = []): Promise<{ code: number | null; output: string }> {
    // the process reaches the test's container and nothing else: never the stack on localhost:8123
    expect(clickhouse.url).toMatch(/^http:\/\/[^:]+:\d+$/);
    expect(clickhouse.url).not.toMatch(/:8123$/);
    const env = {
      PATH: process.env.PATH ?? '',
      GH_ENV: 'e2e',
      GH_NETWORK: 'xrpl',
      GH_CLICKHOUSE_URL: clickhouse.url,
      GH_CLICKHOUSE_DATABASE: database,
    };
    expect(env.GH_CLICKHOUSE_URL).toBe(clickhouse.url);
    let output = '';
    child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/cli/token-history-build.ts', ...args], {
      cwd: APP_ROOT,
      env,
    });
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const killer = setTimeout(() => child?.kill('SIGKILL'), CLI_TIMEOUT_MS);
    try {
      const [code] = (await once(child, 'exit')) as [number | null];
      return { code, output };
    } finally {
      clearTimeout(killer);
    }
  }

  it('exits 2 with "a range-ingest is running" while one runs', async () => {
    const ch = await seeded('th_cli_refused');
    await ch.insert(Table.IngestLog, [
      { range_start: 100, range_end: 199, run_id: 'run-1', status: 'started', updated_at: Date.now() / 1000 },
    ]);
    const { code, output } = await runCli('th_cli_refused');
    expect({ code, refused: output.includes('a range-ingest is running') }).toEqual({ code: 2, refused: true });
    expect(await readTokenHistoryStates(ch)).toEqual([]);
  });

  it('exits 0 and leaves a done generation', async () => {
    const ch = await seeded('th_cli_done');
    const { code, output } = await runCli('th_cli_done', ['--threads', '2']);
    expect({ code, output: code === 0 ? '' : output }).toEqual({ code: 0, output: '' });
    expect(output).toContain('token-history-build: generation 1 phase changes');
    const [state] = await readTokenHistoryStates(ch);
    expect(state).toMatchObject({ generation: 1, state: 'building', phase: 'done' });
  });
});

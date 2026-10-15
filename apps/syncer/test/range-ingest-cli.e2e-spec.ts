import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { syntheticChain, SyntheticLedger } from './synthetic-chain';

const APP_ROOT = join(__dirname, '..');
const DB = 'range_cli_e2e';
const CLI_TIMEOUT_MS = 60_000;

/** Ledgers 81000001 .. 81000030: one chunk of the default size (the 81000th bucket). */
const CHAIN = syntheticChain(81_000_001, 30);

let clickhouse: StartedClickHouse;

beforeAll(async () => {
  clickhouse = await startClickHouse();
});

afterAll(async () => {
  await clickhouse?.container.stop();
});

/** A websocket server that answers `server_info` and serves the ledgers of `chain` (`lgrNotFound` for any other). */
async function startFakeNode(chain: SyntheticLedger[]): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; command: string; ledger_index?: unknown };
      const respond = (result: object) =>
        socket.send(JSON.stringify({ id: request.id, type: 'response', status: 'success', result }));
      if (request.command === 'server_info') {
        respond({ info: { complete_ledgers: '1-100', validated_ledger: { seq: 100 } } });
      } else if (request.command === 'ledger') {
        const ledger = chain.find((l) => l.index === request.ledger_index);
        if (ledger) {
          respond({ ledger: ledger.json, ledger_index: ledger.index, validated: true });
        } else {
          socket.send(
            JSON.stringify({ id: request.id, type: 'response', status: 'error', error: 'lgrNotFound', request }),
          );
        }
      } else {
        respond({});
      }
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

/** Runs a query over the ClickHouse HTTP interface (independent of the CLI under test); returns the TSV rows. */
async function chRows(query: string): Promise<string[]> {
  const res = await fetch(`${clickhouse.url}/?${new URLSearchParams({ query }).toString()}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text.split('\n').filter((line) => line !== '');
}

/** Runs a statement over the ClickHouse HTTP interface. */
async function chCommand(statement: string): Promise<void> {
  const res = await fetch(clickhouse.url, { method: 'POST', body: statement });
  if (!res.ok) throw new Error(await res.text());
}

describe('ingest:range CLI (e2e)', () => {
  /** Every fake node of the test (a test may run the CLI more than once). */
  const nodes: Array<{ url: string; stop: () => Promise<void> }> = [];
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = undefined;
    for (const node of nodes.splice(0)) await node.stop();
  });

  /** Runs `src/cli/range-ingest.ts` as `node dist/cli/range-ingest.js` would, against a fake node serving `chain`. */
  async function runCli(
    args: string[],
    chain: SyntheticLedger[] = CHAIN,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; output: string }> {
    const node = await startFakeNode(chain);
    nodes.push(node);
    let output = '';
    child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/cli/range-ingest.ts', ...args], {
      cwd: APP_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        GH_ENV: 'e2e',
        GH_NETWORK: 'xrpl',
        GH_NODE_ENDPOINTS: node.url,
        GH_CLICKHOUSE_URL: clickhouse.url,
        GH_CLICKHOUSE_DATABASE: DB,
        GH_RUN_MIGRATIONS_ON_BOOT: 'true',
        ...env,
      },
    });
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    // A CLI that does not end is a failure with its output attached, not a test that times out without a word.
    const killer = setTimeout(() => child?.kill('SIGKILL'), CLI_TIMEOUT_MS);
    try {
      const [code] = (await once(child, 'exit')) as [number | null];
      return { code, output };
    } finally {
      clearTimeout(killer);
    }
  }

  const first = CHAIN[0].index;
  const last = CHAIN[CHAIN.length - 1].index;

  it('ingests a range from the node and exits 0', async () => {
    const { code, output } = await runCli(['--from', String(first), '--to', String(last)]);

    expect({ code, output: code === 0 ? '' : output }).toEqual({ code: 0, output: '' });
    expect(await chRows(`SELECT count(), min(ledger_index), max(ledger_index) FROM ${DB}.ledgers`)).toEqual([
      `30\t${first}\t${last}`,
    ]);
    expect(
      await chRows(
        `SELECT range_start, range_end, argMax(status, updated_at) FROM ${DB}.ingest_log GROUP BY range_start, range_end`,
      ),
    ).toEqual([`${first}\t${last}\tdone`]);
    expect(await chRows(`SELECT count() FROM ${DB}.agg_dirty`)).toEqual(['1']);
    expect(output).toContain('30 ledgers written');
  });

  it('a second run finds everything committed and writes nothing', async () => {
    const { code, output } = await runCli(['--from', String(first), '--to', String(last)]);

    expect(code).toBe(0);
    expect(output).toContain('0 ledgers written');
    expect(await chRows(`SELECT count() FROM ${DB}.ledgers`)).toEqual(['30']);
    expect(await chRows(`SELECT count() FROM ${DB}.agg_dirty`)).toEqual(['1']);
  });

  it('passes --chunk, --concurrency, --reprocess and --run-id on', async () => {
    const { code, output } = await runCli([
      ...['--from', String(first), '--to', String(last)],
      ...['--chunk', '10', '--concurrency', '2', '--reprocess', '--run-id', 'cli-run'],
    ]);

    expect(code).toBe(0);
    expect(output).toContain('30 ledgers written');
    // Rewritten with no duplicates, in chunks of 10 aligned to multiples of 10 (81000001..81000009, 81000010..81000019, ...).
    expect(await chRows(`SELECT count() FROM ${DB}.ledgers`)).toEqual(['30']);
    expect(
      await chRows(
        `SELECT range_start, range_end, argMax(status, updated_at), startsWith(argMax(run_id, updated_at), 'cli-run:')
           FROM ${DB}.ingest_log WHERE range_end - range_start < 10 GROUP BY range_start, range_end ORDER BY range_start`,
      ),
    ).toEqual([
      `81000001\t81000009\tdone\t1`,
      `81000010\t81000019\tdone\t1`,
      `81000020\t81000029\tdone\t1`,
      `81000030\t81000030\tdone\t1`,
    ]);
    expect(await chRows(`SELECT count(), uniqExact(ledger_index, tx_index) FROM ${DB}.transactions`)).toEqual([
      expect.stringMatching(/^(\d+)\t\1$/) as unknown as string,
    ]);
  });

  it('exits 1 and names the ledger when the node does not have it, leaving the chunk to be redone', async () => {
    const database = `${DB}_gap`;
    const gap = syntheticChain(82_000_001, 30).filter((l) => l.index !== 82_000_020);

    const { code, output } = await runCli(['--from', '82000001', '--to', '82000030'], gap, {
      GH_CLICKHOUSE_DATABASE: database,
    });

    expect(code).toBe(1);
    expect(output).toContain('Ledger 82000020 is not available');
    expect(await chRows(`SELECT count() FROM ${database}.ledgers`)).toEqual(['0']);
    expect(
      await chRows(`SELECT argMax(status, updated_at) FROM ${database}.ingest_log GROUP BY range_start, range_end`),
    ).toEqual(['started']);
  });

  it('exits 2 with the usage for a wrong command line, without connecting to anything', async () => {
    const { code, output } = await runCli(['--from', '5']);

    expect(code).toBe(2);
    expect(output).toContain('--to is required');
    expect(output).toContain('Usage: pnpm ingest:range');
  });

  it('exits 1 when the range is invalid', async () => {
    const { code, output } = await runCli(['--from', '30', '--to', '10']);

    expect(code).toBe(1);
    expect(output).toContain('Invalid ledger range [30,10]');
  });

  it('refuses a range above the checkpoint while a live syncer holds the lease', async () => {
    const database = `${DB}_live`;
    // The first run creates the database and commits 81000001..81000030; then a live syncer takes the lease.
    expect(
      (await runCli(['--from', String(first), '--to', String(last)], CHAIN, { GH_CLICKHOUSE_DATABASE: database })).code,
    ).toBe(0);
    await chCommand(
      `INSERT INTO ${database}.syncer_lease (network, holder, heartbeat) SELECT 'xrpl', 'live-host:1:abc', now64(3)`,
    );

    const more = syntheticChain(81_000_001, 40);
    const { code, output } = await runCli(['--from', String(first), '--to', '81000040'], more, {
      GH_CLICKHOUSE_DATABASE: database,
    });

    expect(code).toBe(1);
    expect(output).toContain(
      `Range [${first},81000040] reaches above the live checkpoint ${last} while a live syncer holds the lease (live-host:1:abc)`,
    );
    expect(await chRows(`SELECT count() FROM ${database}.ledgers`)).toEqual(['30']);
  });
});

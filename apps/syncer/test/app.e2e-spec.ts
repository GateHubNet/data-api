import type { INestApplication } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { AddressInfo, createServer } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { syntheticChain, SyntheticLedger } from './synthetic-chain';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };
const APP_ROOT = join(__dirname, '..');

let clickhouse: StartedClickHouse;

beforeAll(async () => {
  clickhouse = await startClickHouse();
});

afterAll(async () => {
  await clickhouse?.container.stop();
});

/**
 * A websocket server that answers `server_info` like a rippled / xahaud with the given `network_id`. With a chain it also
 * serves `ledger` requests: `validated` is the last ledger of the chain, and every ledger of the chain is validated.
 */
async function startFakeNode(
  networkId: number | undefined,
  chain: SyntheticLedger[] = [],
  opts: { rateLimitedServerInfo?: number } = {},
): Promise<{ url: string; stop: () => Promise<void>; serverInfos: () => number }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const head = chain[chain.length - 1];
  let serverInfos = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; command: string; ledger_index?: unknown };
      const respond = (result: object) =>
        socket.send(JSON.stringify({ id: request.id, type: 'response', status: 'success', result }));
      if (request.command === 'server_info' && ++serverInfos <= (opts.rateLimitedServerInfo ?? 0)) {
        // What the public nodes answer to a client that sends too much.
        socket.send(
          JSON.stringify({
            id: request.id,
            type: 'response',
            status: 'error',
            error: 'slowDown',
            error_message: 'rate limit: units quota (50000 per 10s) exhausted, retry in ~700ms',
            request,
          }),
        );
      } else if (request.command === 'server_info') {
        respond({ info: { complete_ledgers: '1-100', validated_ledger: { seq: 100 }, network_id: networkId } });
      } else if (request.command === 'ledger' && request.ledger_index === 'validated' && head) {
        respond({ ledger_index: head.index, ledger_hash: head.raw.header.ledger_hash, validated: true });
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
    serverInfos: () => serverInfos,
    stop: () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

/** Runs a query over the ClickHouse HTTP interface (independent of the app under test); returns the TSV rows. */
async function chRows(query: string, params: Record<string, string>): Promise<string[]> {
  const search = new URLSearchParams({ query });
  for (const [name, value] of Object.entries(params)) search.set(`param_${name}`, value);
  const res = await fetch(`${clickhouse.url}/?${search.toString()}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text.split('\n').filter((line) => line !== '');
}

const tablesOf = (database: string) =>
  chRows('SELECT name FROM system.tables WHERE database = {db:String}', { db: database });

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('AppModule on a real ClickHouse', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Builds the AppModule (fresh module registry: it reads GH_* on import), with only the node client faked. */
  async function bootApp(env: Record<string, string>): Promise<string> {
    const saved = { ...process.env };
    Object.assign(process.env, {
      GH_NETWORK: 'xrpl',
      GH_NODE_ENDPOINTS: 'ws://127.0.0.1:1',
      GH_WORKERS: '',
      ...env,
    });
    try {
      let baseUrl: string | undefined;
      await jest.isolateModulesAsync(async () => {
        const { Test } = await import('@nestjs/testing');
        const { NODE_CLIENT } = await import('../src/config/syncer.config');
        const { AppModule } = await import('../src/app.module');
        const node = { stop: async () => undefined };
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .setLogger(QUIET)
          .overrideProvider(NODE_CLIENT)
          .useValue(node)
          .compile();
        app = moduleRef.createNestApplication();
        await app.listen(0, '127.0.0.1');
        baseUrl = await app.getUrl();
      });
      return baseUrl as string;
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  it('applies the schema before the app starts when GH_RUN_MIGRATIONS_ON_BOOT=true, and the probe is healthy', async () => {
    const baseUrl = await bootApp({
      GH_CLICKHOUSE_DATABASE: 'syncer_app_e2e_migrated',
      GH_RUN_MIGRATIONS_ON_BOOT: 'true',
    });
    expect(await tablesOf('syncer_app_e2e_migrated')).toEqual(
      expect.arrayContaining(['ledgers', 'transactions', 'schema_migrations']),
    );
    const res = await fetch(`${baseUrl}/liveliness/healthz`);
    expect(res.status).toBe(200);
  });

  it('leaves the database alone when migrations are off', async () => {
    const baseUrl = await bootApp({ GH_CLICKHOUSE_DATABASE: 'syncer_app_e2e_untouched' });
    expect(
      await chRows('SELECT name FROM system.databases WHERE name = {db:String}', { db: 'syncer_app_e2e_untouched' }),
    ).toEqual([]);
    // The database does not exist, but the ping only needs the server.
    expect((await fetch(`${baseUrl}/liveliness/healthz`)).status).toBe(200);
  });
});

describe('main.ts under the toolbox bootstrap()', () => {
  let child: ChildProcess | undefined;
  let node: Awaited<ReturnType<typeof startFakeNode>> | undefined;
  let output = '';

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = undefined;
    await node?.stop();
    node = undefined;
  });

  async function start(
    networkId: number | undefined,
    env: Record<string, string> = {},
    chain?: SyntheticLedger[],
    nodeOpts: Parameters<typeof startFakeNode>[2] = {},
  ) {
    node = await startFakeNode(networkId, chain, nodeOpts);
    const httpPort = await freePort();
    const metriczPort = await freePort();
    output = '';
    child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/main.ts'], {
      cwd: APP_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        GH_ENV: 'e2e',
        GH_NETWORK: 'xrpl',
        GH_NODE_ENDPOINTS: node.url,
        GH_WORKERS: '',
        GH_HTTP_API_PORT: String(httpPort),
        GH_METRICZ_PORT: String(metriczPort),
        GH_CLICKHOUSE_URL: clickhouse.url,
        GH_CLICKHOUSE_DATABASE: 'default',
        ...env,
      },
    });
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return { httpPort, metriczPort };
  }

  it('serves the probe on the main port and the metrics on the metricz port', async () => {
    const { httpPort, metriczPort } = await start(undefined);

    const health = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${httpPort}/liveliness/healthz`);
      return res.status === 200 ? res : undefined;
    }, `the probe on ${httpPort}\n${output}`);
    expect(health.status).toBe(200);

    const metrics = await (await fetch(`http://127.0.0.1:${metriczPort}/metricz`)).text();
    for (const name of [
      'syncer_checkpoint_ledger',
      'syncer_head_ledger',
      'syncer_lag_ledgers',
      'syncer_last_commit_timestamp_seconds',
      'syncer_validations_flushed_total',
      'syncer_fee_stats_samples_total',
      'syncer_aggregator_runs_total',
    ]) {
      expect(metrics).toContain(`# TYPE ${name} `);
    }
    expect((await fetch(`http://127.0.0.1:${httpPort}/metricz`)).status).toBe(404);
  });

  it('reports 503 when ClickHouse is unreachable', async () => {
    const { httpPort } = await start(undefined, { GH_CLICKHOUSE_URL: `http://127.0.0.1:${await freePort()}` });
    const res = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${httpPort}/liveliness/healthz`);
      return response.status === 503 ? response : undefined;
    }, `a 503 from the probe on ${httpPort}\n${output}`);
    expect(res.status).toBe(503);
  });

  it('exits with an error when the node belongs to another network', async () => {
    await start(21337, { GH_WORKERS: 'fee_stats' }); // an xahau node, GH_NETWORK=xrpl
    const [code] = (await once(child as ChildProcess, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output).toContain('Node network_id 21337 does not match GH_NETWORK=xrpl');
  });

  it('runs the ingest worker to the node head, and on SIGTERM stops, releases the lease and exits 0', async () => {
    const chain = syntheticChain(81_000_001, 30);
    const head = chain[chain.length - 1];
    const db = 'syncer_app_e2e_ingest';
    const { httpPort, metriczPort } = await start(
      undefined,
      {
        GH_WORKERS: 'ingest',
        GH_CLICKHOUSE_DATABASE: db,
        GH_RUN_MIGRATIONS_ON_BOOT: 'true',
        GH_SYNC_START_LEDGER: String(chain[0].index),
      },
      chain,
    );

    await waitFor(async () => {
      const [committed] = await chRows(`SELECT count() FROM ${db}.ledgers`, {});
      return committed === '30' ? true : undefined;
    }, `30 committed ledgers\n${output}`);
    expect(await chRows(`SELECT min(ledger_index), max(ledger_index) FROM ${db}.ledgers`, {})).toEqual([
      `${chain[0].index}\t${head.index}`,
    ]);

    const health = await waitFor(async () => {
      const body = (await (await fetch(`http://127.0.0.1:${httpPort}/liveliness/healthz`)).json()) as {
        info?: { ingest?: { state?: string } };
      };
      return body.info?.ingest?.state === 'live' ? body : undefined;
    }, `a live ingest status\n${output}`);
    expect(health.info?.ingest).toMatchObject({ status: 'up', state: 'live', lag: 0 });
    const metrics = await (await fetch(`http://127.0.0.1:${metriczPort}/metricz`)).text();
    expect(metrics).toMatch(new RegExp(`^syncer_checkpoint_ledger ${head.index}$`, 'm'));
    expect(metrics).toMatch(new RegExp(`^syncer_head_ledger ${head.index}$`, 'm'));
    expect(metrics).toMatch(/^syncer_lag_ledgers 0$/m);
    expect(metrics).toMatch(/^syncer_last_commit_age_seconds \d/m);
    const lease = `SELECT argMax(holder, heartbeat) FROM ${db}.syncer_lease WHERE network = 'xrpl'`;
    expect((await chRows(lease, {}))[0]).toMatch(/:\d+:[0-9a-f-]{36}$/);

    const exited = once(child as ChildProcess, 'exit');
    const signalledAt = Date.now();
    child?.kill('SIGTERM');
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    expect(Date.now() - signalledAt).toBeLessThan(10_000);
    expect(output).toContain('SIGTERM');
    // The lease is released: the latest row has no holder, so a new syncer may start at once.
    expect(
      await chRows(`SELECT argMax(holder, heartbeat) = '' FROM ${db}.syncer_lease WHERE network = 'xrpl'`, {}),
    ).toEqual(['1']);
  });

  it('boots without a node when no worker reads from it (GH_WORKERS=aggregator; ruling R99)', async () => {
    const { httpPort } = await start(undefined, {
      GH_WORKERS: 'aggregator',
      GH_NODE_ENDPOINTS: `ws://127.0.0.1:${await freePort()}`, // nothing listens there
      GH_CLICKHOUSE_DATABASE: 'syncer_app_e2e_aggregator_only',
      GH_RUN_MIGRATIONS_ON_BOOT: 'true',
    });
    const res = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${httpPort}/liveliness/healthz`);
      return response.status === 200 ? response : undefined;
    }, `the probe of an aggregator-only syncer\n${output}`);
    expect(res.status).toBe(200);
    expect(output).toContain('no worker reads from the node');
    expect(output).not.toContain('Cannot connect');
  });

  it('retries the boot network check while the node rate-limits it, instead of exiting (ruling R99)', async () => {
    const { httpPort } = await start(
      undefined,
      {
        GH_WORKERS: 'fee_stats',
        GH_CLICKHOUSE_DATABASE: 'syncer_app_e2e_boot_retry',
        GH_RUN_MIGRATIONS_ON_BOOT: 'true',
      },
      [],
      { rateLimitedServerInfo: 2 },
    );
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${httpPort}/liveliness/healthz`);
      return response.status === 200 ? true : undefined;
    }, `the probe after the rate-limited boot check\n${output}`);
    expect(child?.exitCode).toBeNull();
    expect(node?.serverInfos()).toBe(3);
    expect(output).toMatch(/boot network check \(server_info\) failed: .*rate limit/);
    // One pause per rate-limit answer, logged once each by the node client.
    expect(output.match(/It rate limits this client/g)).toHaveLength(2);
  });

  it('exits with an error on invalid configuration', async () => {
    await start(undefined, { GH_LEDGER_FETCH_TIMEOUT_MS: '0' });
    const [code] = (await once(child as ChildProcess, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output).toContain('GH_LEDGER_FETCH_TIMEOUT_MS must be a positive integer');
  });
});

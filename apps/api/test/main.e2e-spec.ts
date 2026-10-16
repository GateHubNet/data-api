import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { AddressInfo, createServer } from 'node:net';
import { join } from 'node:path';
import { clickHouseUrl } from './e2e-env';

const APP_ROOT = join(__dirname, '..');

let child: ChildProcess | undefined;
let output = '';

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  child = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: () => string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what()}\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Runs the real `src/main.ts` (toolbox `bootstrap()`) in a child process. */
async function start(env: Record<string, string> = {}) {
  const httpPort = await freePort();
  const metriczPort = await freePort();
  output = '';
  child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/main.ts'], {
    cwd: APP_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      GH_ENV: 'e2e',
      GH_NETWORK: 'xrpl',
      GH_NODE_ENDPOINTS: 'ws://127.0.0.1:1',
      GH_API_KEYS: 'main-key',
      GH_HTTP_API_PORT: String(httpPort),
      GH_METRICZ_PORT: String(metriczPort),
      GH_CLICKHOUSE_URL: clickHouseUrl(),
      GH_CLICKHOUSE_DATABASE: 'default',
      ...env,
    },
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { httpPort, metriczPort, base: `http://127.0.0.1:${httpPort}`, metricz: `http://127.0.0.1:${metriczPort}` };
}

describe('main.ts under the toolbox bootstrap()', () => {
  it('serves the Ripple error contract, the probe, the swagger docs and the metrics', async () => {
    const { base, metricz } = await start();
    await waitFor(
      async () => ((await fetch(`${base}/liveliness/healthz`)).status === 200 ? true : undefined),
      () => `the probe on ${base}`,
    );

    // The toolbox global filter is installed by bootstrap(); the controller filters win on /v2.
    const noKey = await fetch(`${base}/v2/nope`);
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    const unknown = await fetch(`${base}/v2/nope`, { headers: { 'X-API-Key': 'main-key' } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ result: 'error', message: 'Cannot GET /v2/nope' });
    expect(unknown.headers.get('x-powered-by')).toBeNull();
    // a malformed percent-escape in a /v2 path is a Ripple 400 on the real bootstrap too (R55)
    const undecodable = await fetch(`${base}/v2/accounts/%zz/payments`, { headers: { 'X-API-Key': 'main-key' } });
    expect([undecodable.status, await undecodable.json()]).toEqual([
      400,
      { result: 'error', message: "Failed to decode param '%zz'" },
    ]);
    const outside = await fetch(`${base}/nope`);
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ error: { message: expect.stringContaining('/nope') } });

    // Swagger comes from bootstrap() at /internal/docs.
    expect((await fetch(`${base}/internal/docs`)).status).toBe(200);
    const docs = (await (await fetch(`${base}/internal/docs-json`)).json()) as { info: { title: string } };
    expect(docs.info.title).toBe('data-api');

    // Metrics live on the second app only, and count the traffic of the main one.
    expect((await fetch(`${base}/metricz`)).status).toBe(404);
    const metrics = await (await fetch(`${metricz}/metricz`)).text();
    expect(metrics).toContain('# TYPE api_http_requests_total counter');
    // The interceptor sees what the guards let through: the 404 of the catch-all, labelled with the route pattern.
    expect(metrics).toMatch(/^api_http_requests_total\{method="GET",route="\/v2\/\*",status="404"\} 1$/m);
    expect(metrics).toContain('# TYPE api_process_cpu_user_seconds_total counter');
  });

  it('the probe answers 503 with the detail body of a 200 when ClickHouse is unreachable (ruling R101)', async () => {
    const { base } = await start({ GH_CLICKHOUSE_URL: `http://127.0.0.1:${await freePort()}` });
    const res = await waitFor(
      async () => {
        const response = await fetch(`${base}/liveliness/healthz`);
        return response.status === 503 ? response : undefined;
      },
      () => `a 503 from the probe on ${base}`,
    );
    expect(await res.json()).toEqual({
      status: 'error',
      info: {},
      error: { clickhouse: { status: 'down' } },
      details: { clickhouse: { status: 'down' } },
    });
  });

  it('on SIGTERM drains the server, closes ClickHouse and exits 0', async () => {
    const { base } = await start();
    await waitFor(
      async () => ((await fetch(`${base}/liveliness/healthz`)).status === 200 ? true : undefined),
      () => `the probe on ${base}`,
    );

    const exited = once(child as ChildProcess, 'exit');
    const signalledAt = Date.now();
    child?.kill('SIGTERM');
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    expect(Date.now() - signalledAt).toBeLessThan(10_000);
    expect(output).toContain('SIGTERM');
    expect(output).toContain('Shutdown complete');
    expect(output).not.toContain('failed');
    expect(output).not.toContain('did not finish');
  });

  it('refuses to boot in production without GH_API_KEYS', async () => {
    await start({ NODE_ENV: 'production', GH_API_KEYS: '' });
    const [code] = (await once(child as ChildProcess, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output).toContain('GH_API_KEYS must be set in production');
  });

  it.each(['dev-api-key', 'change-me-key-1'])(
    'refuses to boot in production with the placeholder key %s',
    async (key) => {
      await start({ NODE_ENV: 'production', GH_API_KEYS: `real-key,${key}` });
      const [code] = (await once(child as ChildProcess, 'exit')) as [number | null];
      expect(code).toBe(1);
      expect(output).toContain('GH_API_KEYS contains a placeholder key');
      expect(output).not.toContain('real-key');
    },
  );

  it('boots in production with a key', async () => {
    const { base } = await start({ NODE_ENV: 'production' });
    await waitFor(
      async () => ((await fetch(`${base}/liveliness/healthz`)).status === 200 ? true : undefined),
      () => `the probe on ${base}`,
    );
    expect((await fetch(`${base}/v2/nope`, { headers: { Authorization: 'Bearer main-key' } })).status).toBe(404);
  });

  it.each([
    ['GH_RATE_LIMIT', '0', 'GH_RATE_LIMIT must be a positive integer'],
    ['GH_HTTP_API_PORT', 'abc', 'GH_HTTP_API_PORT must be an integer between 1 and 65535'],
    ['GH_NETWORK', 'bitcoin', 'GH_NETWORK must be xrpl or xahau'],
    [
      'GH_NODE_ENDPOINTS',
      'https://example.com',
      'GH_NODE_ENDPOINTS must be a comma separated list of ws:// or wss:// URLs',
    ],
    [
      'GH_CORS_ORIGINS',
      'example.com',
      'GH_CORS_ORIGINS must be * or a comma separated list of http:// or https:// origins',
    ],
  ])('exits with an error naming %s=%s', async (name, value, message) => {
    await start({ [name]: value });
    const [code] = (await once(child as ChildProcess, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output).toContain(message);
  });
});

import type { INestApplication } from '@nestjs/common';

const FAKE_ENV = {
  GH_NETWORK: 'xrpl',
  GH_NODE_ENDPOINTS: 'ws://127.0.0.1:1',
  GH_WORKERS: '',
};

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

interface Booted {
  app: INestApplication;
  tokens: typeof import('./config/syncer.config');
  INGEST_STATUS: symbol;
  LiveRunner: typeof import('./ingest/live-runner').LiveRunner;
  ShutdownSignals: typeof import('@gatehub/data-api-shared').ShutdownSignals;
  clickhouse: { ping: jest.Mock };
  node: { start: jest.Mock; stop: jest.Mock; serverInfo: jest.Mock };
  baseUrl: string;
}

/**
 * Builds the AppModule from a fresh module registry (it reads GH_* when it is imported) with the two providers that
 * talk to the outside world replaced, and starts it on an ephemeral port.
 */
async function boot(
  env: Record<string, string>,
  options: {
    pingOk?: boolean;
    ingestStatus?: { state?: string; lag?: number };
    /** Replaces the LiveRunner of the real ingest module (which would otherwise start ingesting). */
    liveRunner?: { status: () => object };
  } = {},
): Promise<Booted> {
  const { pingOk = true, ingestStatus, liveRunner } = options;
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GH_') && key !== 'GH_ENV') delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let booted: Booted | undefined;
    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { ClickHouseService } = await import('@gatehub/data-api-shared');
      const tokens = await import('./config/syncer.config');
      if (ingestStatus) {
        // What the ingest worker's module will do: register itself and provide INGEST_STATUS from a global module.
        // The registry is read when app.module is imported, so this comes first.
        const { Global, Module } = await import('@nestjs/common');
        const { INGEST_STATUS } = await import('./modules/liveliness/ingest-status');
        const { WORKER_MODULES } = await import('./worker-registry');
        @Global()
        @Module({
          providers: [{ provide: INGEST_STATUS, useValue: { status: () => ingestStatus } }],
          exports: [INGEST_STATUS],
        })
        class FakeIngestModule {}
        WORKER_MODULES.ingest = FakeIngestModule;
      }
      // Imported before app.module: once it is imported, its config load races `setLogger(QUIET)` below.
      const { INGEST_STATUS } = await import('./modules/liveliness/ingest-status');
      const { LiveRunner } = await import('./ingest/live-runner');
      const { ShutdownSignals } = await import('@gatehub/data-api-shared');
      const { AppModule } = await import('./app.module');
      const clickhouse = { ping: jest.fn(async () => pingOk), onModuleDestroy: jest.fn() };
      const node = {
        start: jest.fn(),
        stop: jest.fn(async () => undefined),
        serverInfo: jest.fn(async () => ({ complete_ledgers: '1-2' })),
      };
      let builder = Test.createTestingModule({ imports: [AppModule] })
        .setLogger(QUIET) // terminus logs every failed health check
        .overrideProvider(ClickHouseService)
        .useValue(clickhouse)
        .overrideProvider(tokens.NODE_CLIENT)
        .useValue(node);
      if (liveRunner) builder = builder.overrideProvider(LiveRunner).useValue(liveRunner);
      const moduleRef = await builder.compile();
      const app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      booted = {
        app,
        tokens,
        INGEST_STATUS,
        LiveRunner,
        ShutdownSignals,
        clickhouse,
        node,
        baseUrl: await app.getUrl(),
      };
    });
    return booted as Booted;
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('AppModule', () => {
  let booted: Booted | undefined;
  afterEach(async () => {
    await booted?.app.close();
    booted = undefined;
  });

  it('compiles with workers="" (infrastructure only) and exposes the shared tokens', async () => {
    booted = await boot(FAKE_ENV);
    const { app, tokens } = booted;

    expect(app.get(tokens.SyncerConfig).workers).toBe('');
    expect(app.get(tokens.NETWORK_PROFILE)).toMatchObject({ name: 'xrpl', nativeCurrency: 'XRP', networkId: 0 });
    expect(app.get(tokens.PARSE_CONTEXT)).toEqual({
      nativeCurrency: 'XRP',
      networkId: 0,
      partialPaymentFixLedger: 4594094,
    });
    expect(app.get(tokens.NODE_CLIENT)).toBe(booted.node);
    expect(app.get(booted.ShutdownSignals)).toBeInstanceOf(booted.ShutdownSignals);
  });

  it('has no ingest status (and no LiveRunner) when the ingest worker is not enabled', async () => {
    booted = await boot(FAKE_ENV);
    const { app, INGEST_STATUS, LiveRunner } = booted;
    expect(() => app.get(INGEST_STATUS)).toThrow();
    expect(() => app.get(LiveRunner)).toThrow();
    const res = await fetch(`${booted.baseUrl}/liveliness/healthz`);
    expect((await res.json()).info).not.toHaveProperty('ingest');
  });

  it('resolves INGEST_STATUS to the LiveRunner of the ingest module when the ingest worker is enabled', async () => {
    const runner = {
      status: () => ({ state: 'catching_up', checkpoint: 100, head: 107, lag: 7, lastCommitAt: Date.now() / 1000 - 3 }),
    };
    booted = await boot({ ...FAKE_ENV, GH_WORKERS: 'ingest' }, { liveRunner: runner });
    const { app, INGEST_STATUS, LiveRunner } = booted;

    expect(app.get(LiveRunner)).toBe(runner);
    expect(app.get(INGEST_STATUS)).toBe(runner);
    const res = await fetch(`${booted.baseUrl}/liveliness/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      info: { ingest: { status: 'up', state: 'catching_up', lag: 7, last_commit_age: 3 } },
    });
  });

  it('builds the xahau profile and parse context for GH_NETWORK=xahau', async () => {
    booted = await boot({ ...FAKE_ENV, GH_NETWORK: 'xahau' });
    const { app, tokens } = booted;
    expect(app.get(tokens.NETWORK_PROFILE)).toMatchObject({ name: 'xahau', nativeCurrency: 'XAH', networkId: 21337 });
    expect(app.get(tokens.PARSE_CONTEXT)).toMatchObject({ nativeCurrency: 'XAH', networkId: 21337 });
  });

  it('serves the liveliness probe: 200 while ClickHouse answers', async () => {
    booted = await boot(FAKE_ENV);
    const res = await fetch(`${booted.baseUrl}/liveliness/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
    expect(booted.clickhouse.ping).toHaveBeenCalled();
  });

  it('serves the liveliness probe: 503 when the ClickHouse ping fails', async () => {
    booted = await boot(FAKE_ENV, { pingOk: false });
    const res = await fetch(`${booted.baseUrl}/liveliness/healthz`);
    expect(res.status).toBe(503);
  });

  it('wires the ingest status of an enabled ingest worker into the probe', async () => {
    booted = await boot({ ...FAKE_ENV, GH_WORKERS: 'ingest' }, { ingestStatus: { state: 'live', lag: 2 } });
    const res = await fetch(`${booted.baseUrl}/liveliness/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ info: { ingest: { status: 'up', state: 'live', lag: 2 } } });
  });

  it('answers 503 when the ingest worker reports that it halted', async () => {
    await boot({ ...FAKE_ENV, GH_WORKERS: 'ingest' }, { ingestStatus: { state: 'halted', lag: 0 } }).then(async (b) => {
      booted = b;
      expect((await fetch(`${b.baseUrl}/liveliness/healthz`)).status).toBe(503);
    });
  });

  it('stops the node client when the app closes', async () => {
    booted = await boot(FAKE_ENV);
    const { app, node } = booted;
    expect(node.stop).not.toHaveBeenCalled();
    await app.close();
    expect(node.stop).toHaveBeenCalledTimes(1);
    booted = undefined;
  });

  it('does not serve /metricz on the main port (that is the metricz app)', async () => {
    booted = await boot(FAKE_ENV);
    const res = await fetch(`${booted.baseUrl}/metricz`);
    expect(res.status).toBe(404);
  });

  it('refuses to build with an unknown worker name', async () => {
    const saved = { ...process.env };
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('GH_') && key !== 'GH_ENV') delete process.env[key];
      }
      Object.assign(process.env, { ...FAKE_ENV, GH_WORKERS: 'ingest,bogus' });
      await jest.isolateModulesAsync(async () => {
        const { AppModule } = await import('./app.module');
        const { Test } = await import('@nestjs/testing');
        await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
          'Unknown worker "bogus"',
        );
      });
    } finally {
      exit.mockRestore();
      consoleError.mockRestore();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

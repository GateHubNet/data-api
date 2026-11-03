import { ClickHouseService, getNetworkProfile, ShutdownSignals } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NETWORK_PROFILE, NODE_CLIENT, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { SafeFetcher, tomlsUserAgent } from '../validators/safe-fetch';
import { DomainDiscovery } from './domain-discovery';
import { TomlChecker } from './toml-checker';
import { TomlsWorker } from './tomls-worker';
import { TomlsModule } from './tomls.module';
import { TOMLS_SAFE_FETCHER, TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from './tomls.options';

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

const made: TestingModule[] = [];

/** The module as the application builds it, over a core stub: no connection, no loop (the app is not initialised). */
async function build(options?: TomlsWorkerOptions): Promise<{ moduleRef: TestingModule }> {
  // what the global core module provides to every worker: there is no NODE_CLIENT here on purpose, the module must not ask for it
  @Global()
  @Module({
    providers: [
      { provide: SyncerConfig, useValue: Object.assign(new SyncerConfig(), { workers: 'tomls' }) },
      { provide: NETWORK_PROFILE, useValue: getNetworkProfile('xrpl') },
      { provide: ClickHouseService, useValue: { query: jest.fn(), insert: jest.fn() } },
      { provide: PrometheusService, useClass: PrometheusService },
      { provide: ShutdownSignals, useValue: { register: jest.fn() } },
      ...(options === undefined ? [] : [{ provide: TOMLS_WORKER_OPTIONS, useValue: options }]),
    ],
    exports: [
      SyncerConfig,
      NETWORK_PROFILE,
      ClickHouseService,
      PrometheusService,
      ShutdownSignals,
      ...(options === undefined ? [] : [TOMLS_WORKER_OPTIONS]),
    ],
  })
  class CoreStub {}
  const moduleRef = await Test.createTestingModule({ imports: [CoreStub, TomlsModule] })
    .setLogger(QUIET)
    .compile();
  made.push(moduleRef);
  return { moduleRef };
}

/** The user agent a `SafeFetcher` sends. */
const userAgentOf = (fetcher: SafeFetcher): string => (fetcher as unknown as { userAgent: string }).userAgent;

describe('TomlsModule', () => {
  afterEach(async () => {
    await Promise.all(made.splice(0).map((moduleRef) => moduleRef.close()));
  });

  it('builds over the core stub, with no node client, and provides the worker, the discovery and the checker', async () => {
    const { moduleRef } = await build();
    expect(() => moduleRef.get(NODE_CLIENT, { strict: false })).toThrow();
    expect(moduleRef.get(TomlsWorker)).toBeInstanceOf(TomlsWorker);
    expect(moduleRef.get(DomainDiscovery)).toBeInstanceOf(DomainDiscovery);
    expect(moduleRef.get(TomlChecker)).toBeInstanceOf(TomlChecker);
  });

  it('gives the checker a safe fetcher of its own, whose user agent ends " (tomls)"', async () => {
    const { moduleRef } = await build();
    const fetcher = moduleRef.get<SafeFetcher>(TOMLS_SAFE_FETCHER);
    expect(fetcher).toBeInstanceOf(SafeFetcher);
    expect(userAgentOf(fetcher)).toBe(tomlsUserAgent());
    expect(userAgentOf(fetcher)).toMatch(/^gatehub-data-api\/\S+ \(tomls\)$/);
    expect((moduleRef.get(TomlChecker) as unknown as { fetcher: unknown }).fetcher).toBe(fetcher);
  });

  it('hands the test options to the discovery, the checker and the worker, and the fetch options to the fetcher', async () => {
    const options: TomlsWorkerOptions = {
      logger: QUIET,
      fetch: { allowAddress: () => true },
      start: { discovery: false },
    };
    const { moduleRef } = await build(options);
    expect((moduleRef.get(TomlsWorker) as unknown as { start: unknown }).start).toBe(options.start);
    expect((moduleRef.get(TomlChecker) as unknown as { logger: unknown }).logger).toBe(QUIET);
    expect((moduleRef.get(DomainDiscovery) as unknown as { logger: unknown }).logger).toBe(QUIET);
    const fetcher = moduleRef.get<SafeFetcher>(TOMLS_SAFE_FETCHER);
    expect((fetcher as unknown as { test: unknown }).test).toBe(options.fetch);
  });
});

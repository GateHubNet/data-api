import { ClickHouseService, clickHouseConfigFromEnv, runMigrations } from '@gatehub/data-api-shared';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { clickHouseUrl } from './e2e-env';

/** The API key every harness app accepts. */
export const TEST_API_KEY = 'test-key';

const QUIET = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

export interface HarnessOptions {
  /** Extra `GH_*` variables for this app (`GH_RATE_LIMIT`, `GH_CORS_ORIGINS`, ...); they win over the defaults. */
  env?: Record<string, string>;
  /**
   * Test-only controllers. The callback runs while the app is being built, so the classes it returns come from the same
   * module registry as the AppModule (`import('./test-controllers')` inside it, never a top-level import: a filter
   * from another registry would not recognise the `HttpException` the app throws).
   *
   * They are controllers of the testing module itself, which Nest registers ahead of the AppModule's: like the
   * endpoint modules of the real app, they come before the catch-all `/v2/*` 404.
   */
  controllers?: () => Type<unknown>[] | Promise<Type<unknown>[]>;
}

export interface Harness {
  app: INestApplication;
  /** A supertest agent on the app (no listening socket needed). */
  http(): ReturnType<typeof request>;
  /** The app's own ClickHouse service, bound to this harness's database. */
  ch: ClickHouseService;
  /** The database this harness created (random, dropped by `close()`). */
  database: string;
  key: string;
  close(): Promise<void>;
}

/**
 * Boots the AppModule the way `main.ts` does, against the shared ClickHouse container of `global-setup.ts`:
 * a fresh random database, the real schema (`runMigrations`), `GH_API_KEYS=test-key`.
 *
 * The toolbox `bootstrap()` returns no app handle, so its app-level settings are repeated here: the global
 * `HttpExceptionFilter` (the Ripple filter of the controllers has to win over it) and `x-powered-by` off.
 *
 * The AppModule reads `GH_*` when it is imported, so each call imports it into a fresh module registry
 * (`jest.isolateModulesAsync`); anything the test needs from the app's own modules has to be imported in there too.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = `api_e2e_${randomBytes(6).toString('hex')}`;
  const env: Record<string, string> = {
    GH_NETWORK: 'xrpl',
    GH_NODE_ENDPOINTS: 'ws://127.0.0.1:1',
    GH_API_KEYS: TEST_API_KEY,
    GH_CLICKHOUSE_URL: clickHouseUrl(),
    GH_CLICKHOUSE_USER: 'default',
    GH_CLICKHOUSE_PASSWORD: '',
    GH_CLICKHOUSE_DATABASE: database,
    ...options.env,
  };
  const config = clickHouseConfigFromEnv({ ...env });
  await runMigrations({ config, log: () => undefined });

  const saved = { ...process.env };
  Object.assign(process.env, env);
  let app: NestExpressApplication | undefined;
  let ch: ClickHouseService | undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { HttpExceptionFilter } = await import('@gatehub/toolbox/lib/http/exceptions/http-exception.filter');
      const { ClickHouseService: AppClickHouseService } = await import('@gatehub/data-api-shared');
      const { AppModule } = await import('../src/app.module');
      const controllers = (await options.controllers?.()) ?? [];
      const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers })
        .setLogger(QUIET)
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>();
      app.useGlobalFilters(new HttpExceptionFilter());
      app.disable('x-powered-by');
      await app.init();
      ch = app.get(AppClickHouseService);
    });
  } catch (err) {
    await app?.close();
    await dropDatabase(database, env);
    // ts-jest diagnostics arrive as plain objects that jest cannot print (an empty failure), so make it an Error.
    throw err instanceof Error ? err : new Error(String((err as { message?: unknown })?.message ?? err));
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  const running = app as unknown as NestExpressApplication;
  return {
    app: running,
    http: () => request(running.getHttpServer()),
    ch: ch as unknown as ClickHouseService,
    database,
    key: TEST_API_KEY,
    close: async () => {
      await running.close();
      await dropDatabase(database, env);
    },
  };
}

/** Drops a harness database through a connection bound to `default`, so the shared server stays tidy. */
async function dropDatabase(database: string, env: Record<string, string>): Promise<void> {
  const service = new ClickHouseService({ ...clickHouseConfigFromEnv({ ...env }), database: 'default' });
  try {
    await service.command('DROP DATABASE IF EXISTS {database:Identifier} SYNC', { database });
  } finally {
    await service.onModuleDestroy();
  }
}

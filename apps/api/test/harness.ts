import {
  clickHouseConfigFromEnv,
  ClickHouseService,
  getNetworkProfile,
  LedgerWriter,
  NetworkName,
  parseContextFor,
  recomputeStatsHourly,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { clickHouseUrl } from './e2e-env';
import { fixtureSource, SEED_NETWORK, SeedName } from './support/fixtures';

/** The API key every harness app accepts. */
export const TEST_API_KEY = 'test-key';

const QUIET = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

/** What a harness is seeded with: the ledgers of a fixture set, or nothing. */
export type Seed = SeedName | 'none';

/**
 * Stands in for the live node: gets the rippled request object and returns its `result`. The app's `XrplService.request`
 * returns what it returns and rethrows what it throws, as the `NodeClient` does. An error that is a `RippledError`
 * (build one with `rippledError()`) reaches the app as the app's own `RippledError`; anything else passes unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XrplStub = (req: any) => any;

export interface HarnessOptions {
  /** The network to run for (`GH_NETWORK`, and with it the profile). Default: the network of `seed`, else `xrpl`. */
  network?: NetworkName;
  /**
   * Ledgers to write to the database before the tests run, through the `LedgerWriter` exactly as the syncer would:
   *  - `ripple-mock`: the 54 mock ledgers of the original Ripple API (`xrpl`);
   *  - `xahau-recorded`: the Xahau mainnet ledgers recorded from a public node (`xahau`);
   *  - `none` (default): an empty database.
   */
  seed?: Seed;
  /**
   * The live node. Without a stub every node request fails at once, so a test never reaches the network (and the
   * `BinaryCodecService` falls back to the definitions of the network profile, or the codec's built-in ones). A stub
   * that does not answer `server_definitions` (returns nothing, or throws) gets the same fallback.
   */
  xrplStub?: XrplStub;
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

/**
 * `GH_RATE_LIMIT` for a suite that walks lists a page at a time: far more requests to one route than the default limit
 * of 600 a minute. Pass it as `env` of `startHarness`.
 */
export const NO_RATE_LIMIT: Record<string, string> = { GH_RATE_LIMIT: '1000000' };

/** A GET client on a harness app, with the API key. See `Harness.api()`. */
export interface ApiClient {
  /** GET with the key; any status. Await it (or `.expect`/`.set`) like a supertest request. */
  get(path: string): request.Test;
  /**
   * GET that must answer 200 and, when `key` is given, a body with that key; otherwise it throws an Error that carries
   * the path, the status and the body, so a page walk that goes wrong says what it was given.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ok<T = any>(path: string, key?: string): Promise<request.Response & { body: T }>;
  /**
   * Every page of a list, following the `marker` of each (`limit` and the marker are added to `path`), in order. Each
   * page goes through `ok(…, key)`, and a list that does not end in 1000 pages throws.
   */
  pages<T extends { marker?: string }>(path: string, limit: number, key: string): Promise<T[]>;
}

export interface Harness {
  app: INestApplication;
  /**
   * A supertest agent on the app. It starts and closes a server for every request, which is fine for a few requests; a
   * test that makes hundreds of them (a walk over a list) should use `api()`.
   */
  http(): ReturnType<typeof request>;
  /**
   * A client on a socket of the app's own, opened by the first call and used by every call after it (closed by
   * `close()`). The requests of `http()` each listen on a new port, and now and then one of hundreds lands on a port
   * whose connection the client still holds and fails with ECONNRESET.
   */
  api(): Promise<ApiClient>;
  /** The app's own ClickHouse service, bound to this harness's database. */
  ch: ClickHouseService;
  /** The database this harness created (random, dropped by `close()`). */
  database: string;
  key: string;
  close(): Promise<void>;
}

/**
 * A rippled error for an `xrplStub` to throw: what the node's error response becomes in xrpl.js (a `RippledError`
 * whose `data` is the response). Built here without importing xrpl, because the harness and the app live in different
 * module registries and `instanceof` does not cross them: the harness turns it into the app's `RippledError`.
 */
export function rippledError(error: string, message = error): Error {
  return Object.assign(new Error(message), {
    name: 'RippledError',
    data: { status: 'error', type: 'response', error, error_message: message },
  });
}

/**
 * Boots the AppModule the way `main.ts` does, against the shared ClickHouse container of `global-setup.ts`:
 * a fresh random database, the real schema (`runMigrations`), `GH_API_KEYS=test-key`, optionally seeded with ledgers
 * (`seed`) and with the live node replaced by a stub (`xrplStub`).
 *
 * The toolbox `bootstrap()` returns no app handle, so its app-level settings are repeated here: the global
 * `HttpExceptionFilter` (the Ripple filter of the controllers has to win over it) and `x-powered-by` off.
 *
 * The AppModule reads `GH_*` when it is imported, so each call imports it into a fresh module registry
 * (`jest.isolateModulesAsync`); anything the test needs from the app's own modules has to be imported in there too.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const seed = options.seed ?? 'none';
  const database = `api_e2e_${randomBytes(6).toString('hex')}`;
  const env: Record<string, string> = {
    GH_NETWORK: options.network ?? (seed === 'none' ? 'xrpl' : SEED_NETWORK[seed]),
    GH_NODE_ENDPOINTS: 'ws://127.0.0.1:1',
    GH_API_KEYS: TEST_API_KEY,
    GH_CLICKHOUSE_URL: clickHouseUrl(),
    GH_CLICKHOUSE_USER: 'default',
    GH_CLICKHOUSE_PASSWORD: '',
    GH_CLICKHOUSE_DATABASE: database,
    ...options.env,
  };
  const network = getNetworkProfile(env.GH_NETWORK).name;
  if (seed !== 'none' && SEED_NETWORK[seed] !== network) {
    throw new Error(
      `The ${seed} ledgers are ${SEED_NETWORK[seed]} ledgers: start the harness with network '${SEED_NETWORK[seed]}', not '${network}'`,
    );
  }
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
      const { XrplService } = await import('../src/xrpl/xrpl.service');
      const { RippledError } = await import('xrpl');
      const { AppModule } = await import('../src/app.module');
      const controllers = (await options.controllers?.()) ?? [];
      const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers })
        .overrideProvider(XrplService)
        .useValue(nodeStub(options.xrplStub, RippledError))
        .setLogger(QUIET)
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>();
      app.useGlobalFilters(new HttpExceptionFilter());
      app.disable('x-powered-by');
      await app.init();
      const appClickHouse = app.get(AppClickHouseService);
      ch = appClickHouse;
      if (seed !== 'none') await seedLedgers(appClickHouse, seed, network);
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
  let client: Promise<ApiClient> | undefined;
  return {
    app: running,
    http: () => request(running.getHttpServer()),
    api: () => (client ??= listeningClient(running, TEST_API_KEY)),
    ch: ch as unknown as ClickHouseService,
    database,
    key: TEST_API_KEY,
    close: async () => {
      await running.close();
      await dropDatabase(database, env);
    },
  };
}

/** Opens the app on a port of its own and returns a client on it (`app.close()` closes the socket again). */
async function listeningClient(app: NestExpressApplication, key: string): Promise<ApiClient> {
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const get = (path: string): request.Test => request(url).get(path).set('X-API-Key', key);

  const ok: ApiClient['ok'] = async (path, expectedKey) => {
    const res = await get(path);
    const body = res.body as Record<string, unknown> | null;
    if (
      res.status !== 200 ||
      (expectedKey !== undefined && (body === null || typeof body !== 'object' || !(expectedKey in body)))
    ) {
      const why = res.status !== 200 ? `answered ${res.status}` : `has no "${expectedKey}"`;
      throw new Error(`GET ${path} ${why}: ${JSON.stringify(res.body ?? res.text)}`);
    }
    return res;
  };

  const pages: ApiClient['pages'] = async <T extends { marker?: string }>(path: string, limit: number, key: string) => {
    const out: T[] = [];
    let marker: string | undefined;
    do {
      const res = await ok<T>(
        `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${marker ? `&marker=${marker}` : ''}`,
        key,
      );
      out.push(res.body);
      marker = res.body.marker;
      if (out.length >= 1000) throw new Error(`GET ${path}: still a marker after ${out.length} pages of ${limit}`);
    } while (marker);
    return out;
  };

  return { get, ok, pages };
}

/**
 * Writes the ledgers of a fixture set the way the syncer does, so every table the API reads is filled, and rolls them up
 * into `stats_hourly` the way the syncer's aggregator does (`recomputeStatsHourly` over the hours they closed in).
 */
async function seedLedgers(ch: ClickHouseService, seed: SeedName, network: NetworkName): Promise<void> {
  const writer = new LedgerWriter(ch, parseContextFor(getNetworkProfile(network)));
  await writer.write(fixtureSource(seed).list());
  const closed = await ch.queryOne<{ first: number | string; last: number | string }>(
    `SELECT toUnixTimestamp(min(close_time)) AS first, toUnixTimestamp(max(close_time)) AS last FROM ${Table.Ledgers}`,
  );
  if (closed)
    await recomputeStatsHourly(ch, new Date(Number(closed.first) * 1000), new Date((Number(closed.last) + 1) * 1000));
}

/** What the harness puts in place of the `XrplService`. */
function nodeStub(stub: XrplStub | undefined, RippledError: new (message?: string, data?: unknown) => Error) {
  return {
    async request(req: Record<string, unknown>): Promise<unknown> {
      if (!stub) throw new Error('No node: this harness has no xrplStub');
      try {
        return await stub(req);
      } catch (err) {
        const named = err as { name?: unknown; message?: string; data?: unknown } | null;
        if (named?.name === 'RippledError' && !(err instanceof RippledError)) {
          throw new RippledError(named.message, named.data);
        }
        throw err;
      }
    },
    async stop(): Promise<void> {
      /* nothing is connected */
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

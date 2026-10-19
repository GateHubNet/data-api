import { ClickHouseConfig, ClickHouseService, getNetworkProfile, runMigrations } from '@gatehub/data-api-shared';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { once } from 'node:events';
import { IncomingHttpHeaders } from 'node:http';
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { startClickHouse } from '../../../../packages/shared/test/clickhouse-container';
import { SyncerConfig } from '../../src/config/syncer.config';
import { SyncerCoreModule } from '../../src/core/syncer-core.module';
import { PrometheusService } from '../../src/modules/prometheus/prometheus.service';
import { SafeFetchTestOptions } from '../../src/validators/safe-fetch';
import { UnlFetcher } from '../../src/validators/unl-fetcher';
import { ValidatorsModule } from '../../src/validators/validators.module';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from '../../src/validators/validators.options';
import { needsNodeClient } from '../../src/worker-registry';
import { TEST_TLS } from './tls';

/*
 * The environment of the e2e specs of the validators worker. Every part is a small function of its own, so that a spec
 * takes what it needs and a later spec adds a part without touching the others:
 *
 *   startMigratedClickHouse(database)  a throwaway ClickHouse with the whole schema applied (`.ch` reads and writes it)
 *   startTestWeb()                     an HTTPS server on 127.0.0.1 that answers by host and path. The publishers of UNL
 *                                      lists and (for the domain checks) the `.well-known` TOML files of validators are
 *                                      routes of it: `web.serveJson('unl.example', '/', body)`,
 *                                      `web.serve('a.example', '/.well-known/xrp-ledger.toml', { body })`. Serving the
 *                                      same host and path again swaps the answer; a route no one serves is a 404.
 *                                      `web.requests` logs what was asked, `web.fetchOptions()` is the
 *                                      `SafeFetchTestOptions` that send every `*.example` host to it (the certificate is
 *                                      still verified, against `TEST_TLS.cert`, for the host asked: only the hosts in the
 *                                      SAN of the certificate work, see `tls.ts`)
 *   startFakeNode(answers?)            a websocket server that talks like rippled and answers by `command`:
 *                                      `node.answers.ledger_entry = (request) => ({ node: { ... } })` swaps or adds an
 *                                      answer (a value, or a function of the request); `node.requests` logs the requests; a
 *                                      command with no answer is an `unknownCmd` error. `server_info` is answered from the start
 *   startValidatorsApp(options)        the real `SyncerCoreModule` (config, ClickHouse, metrics, shutdown signals and the
 *                                      node client made from the fake node) with the `ValidatorsModule` as the only worker,
 *                                      booted as the application does: the result holds the app, the `UnlFetcher`, the
 *                                      metrics, and `stop()`. `options.config` overrides `SyncerConfig` (for instance
 *                                      `unlPublishers`), `options.worker` the `ValidatorsWorkerOptions` (`now`, `start`,
 *                                      ...; the `fetch` options of the web server are already in it)
 *   quietLogger / resetValidatorsMetrics / waitFor   helpers
 *
 * A spec ends what it starts: `app.stop()`, `web.stop()`, `node.stop()`, `clickhouse.stop()`.
 */

export const quietLogger = () => ({ log: () => undefined, warn: () => undefined, error: () => undefined });

/** Polls `probe` until it gives a value other than `undefined`/`false`; a test waits for what it waits for, not for a time. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// -- ClickHouse -------------------------------------------------------------------------------------------------------

export interface MigratedClickHouse {
  config: ClickHouseConfig;
  /** A service on the database, for the spec's own reads and writes. */
  ch: ClickHouseService;
  stop(): Promise<void>;
}

/** A ClickHouse container with the whole schema applied to `database`. */
export async function startMigratedClickHouse(database: string): Promise<MigratedClickHouse> {
  const started = await startClickHouse();
  const config = { ...started.config, database };
  await runMigrations({ config, log: () => undefined });
  const ch = new ClickHouseService(config);
  return {
    config,
    ch,
    stop: async () => {
      await ch.onModuleDestroy();
      await started.container.stop();
    },
  };
}

// -- HTTPS ------------------------------------------------------------------------------------------------------------

export interface WebReply {
  /** Default 200. */
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

export interface WebRequest {
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface TestWeb {
  /** The port of the server on 127.0.0.1. */
  readonly port: number;
  /** Every request received, in order. */
  readonly requests: WebRequest[];
  /** `GET https://<host><path>` answers `reply` (a function is called for each request). Replaces an earlier answer of the same host and path. */
  serve(host: string, path: string, reply: WebReply | ((request: WebRequest) => WebReply)): void;
  /** `serve` with a JSON body. */
  serveJson(host: string, path: string, body: unknown): void;
  /** Forgets every route and request. */
  clear(): void;
  /** Send every fetch of `SafeFetcher` to this server: the name resolves to 127.0.0.1 (the only address allowed), the certificate of the test is trusted. */
  fetchOptions(): SafeFetchTestOptions;
  stop(): Promise<void>;
}

export async function startTestWeb(): Promise<TestWeb> {
  const routes = new Map<string, WebReply | ((request: WebRequest) => WebReply)>();
  const requests: WebRequest[] = [];
  const server: Server = createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (req, res) => {
    const request: WebRequest = {
      host: (req.headers.host ?? '').toLowerCase(),
      path: new URL(req.url ?? '/', 'https://x.example').pathname,
      headers: req.headers,
    };
    requests.push(request);
    const route = routes.get(`${request.host}${request.path}`);
    const reply: WebReply =
      route === undefined ? { status: 404, body: 'not found' } : typeof route === 'function' ? route(request) : route;
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    serve: (host, path, reply) => void routes.set(`${host.toLowerCase()}${path}`, reply),
    serveJson: (host, path, body) => void routes.set(`${host.toLowerCase()}${path}`, { body: JSON.stringify(body) }),
    clear: () => {
      routes.clear();
      requests.length = 0;
    },
    fetchOptions: () => ({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      allowAddress: (address) => address === '127.0.0.1',
      ca: TEST_TLS.cert,
      connectPort: port,
    }),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// -- The node ---------------------------------------------------------------------------------------------------------

/** What a node answers to a command: the `result`, or a function of the request that gives it. */
export type NodeAnswer = object | ((request: Record<string, unknown>) => object);

export interface FakeNode {
  /** `ws://127.0.0.1:<port>` */
  readonly url: string;
  /** The answers by command; change them as a test needs. */
  readonly answers: Record<string, NodeAnswer>;
  /** Every request received, in order. */
  readonly requests: Record<string, unknown>[];
  stop(): Promise<void>;
}

/** A node of the XRP Ledger network (`network_id` 0) that answers `server_info` and whatever `answers` adds. */
export async function startFakeNode(answers: Record<string, NodeAnswer> = {}): Promise<FakeNode> {
  const all: Record<string, NodeAnswer> = {
    server_info: { info: { complete_ledgers: '1-100', validated_ledger: { seq: 100 }, network_id: 0 } },
    ...answers,
  };
  const requests: Record<string, unknown>[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; command: string } & Record<string, unknown>;
      requests.push(request);
      const answer = all[request.command];
      if (answer === undefined) {
        socket.send(
          JSON.stringify({ id: request.id, type: 'response', status: 'error', error: 'unknownCmd', request }),
        );
        return;
      }
      const result = typeof answer === 'function' ? answer(request) : answer;
      socket.send(JSON.stringify({ id: request.id, type: 'response', status: 'success', result }));
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    answers: all,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

// -- The worker -------------------------------------------------------------------------------------------------------

export interface ValidatorsApp {
  app: INestApplication;
  fetcher: UnlFetcher;
  metrics: PrometheusService;
  stop(): Promise<void>;
}

export interface ValidatorsAppOptions {
  clickhouse: ClickHouseConfig;
  node: FakeNode;
  web: TestWeb;
  /** Over the defaults of `SyncerConfig`: an empty `unlPublishers` and the fake node as every endpoint. */
  config?: Partial<SyncerConfig>;
  /** Over the defaults: a quiet logger and the fetch options of `web`. */
  worker?: ValidatorsWorkerOptions;
}

/**
 * Boots the validators worker the way the application does: the core module of the syncer with the `ValidatorsModule` as
 * its only worker, a node client made from the fake node, and a ClickHouse that is already migrated. Resolves when the
 * application is initialised, i.e. after the worker registered its publishers (the loops run in the background).
 */
export async function startValidatorsApp(o: ValidatorsAppOptions): Promise<ValidatorsApp> {
  const config = Object.assign(new SyncerConfig(), {
    nodeEndpoints: o.node.url,
    validationEndpoints: o.node.url,
    workers: 'validators',
    unlPublishers: '',
    ...o.config,
  });
  const options: ValidatorsWorkerOptions = { logger: quietLogger(), fetch: o.web.fetchOptions(), ...o.worker };

  // the options reach the module the way the core stub of a unit spec provides them: from a global module
  @Global()
  @Module({
    providers: [{ provide: VALIDATORS_WORKER_OPTIONS, useValue: options }],
    exports: [VALIDATORS_WORKER_OPTIONS],
  })
  class OptionsModule {}

  const profile = getNetworkProfile('xrpl');
  const moduleRef = await Test.createTestingModule({
    imports: [
      SyncerCoreModule.register({
        config,
        profile,
        clickHouse: o.clickhouse,
        workerModules: [ValidatorsModule],
        nodeClient: needsNodeClient(new Set(['validators'])),
      }),
      OptionsModule,
    ],
  })
    .setLogger(quietLogger())
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    fetcher: app.get(UnlFetcher),
    metrics: app.get(PrometheusService),
    stop: () => app.close(),
  };
}

/** The metrics are one set per process, so a spec clears the ones the worker sets before each test. */
export function resetValidatorsMetrics(): void {
  const metrics = new PrometheusService();
  metrics.validatorsUnlFetchesTotal.reset();
  metrics.validatorsUnlExpirySeconds.reset();
  metrics.validatorsUnlSize.reset();
}

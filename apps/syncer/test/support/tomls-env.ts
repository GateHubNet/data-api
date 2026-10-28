import {
  ClickHouseConfig,
  ClickHouseService,
  getNetworkProfile,
  NetworkProfile,
  Table,
} from '@gatehub/data-api-shared';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SyncerConfig, WorkerName } from '../../src/config/syncer.config';
import { SyncerCoreModule } from '../../src/core/syncer-core.module';
import { PrometheusService } from '../../src/modules/prometheus/prometheus.service';
import { DomainDiscovery } from '../../src/tomls/domain-discovery';
import { TomlChecker } from '../../src/tomls/toml-checker';
import { TomlsWorker } from '../../src/tomls/tomls-worker';
import { TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from '../../src/tomls/tomls.options';
import { needsNodeClient, selectWorkerModules } from '../../src/worker-registry';
import { quietLogger, TestWeb } from './validators-env';

/*
 * The environment of the e2e specs of the tomls worker, on the parts of `validators-env.ts` (`startMigratedClickHouse`,
 * `startTestWeb`, `quietLogger`, `waitFor`, which a spec takes from there):
 *
 *   startTomlsApp(options)    the real `SyncerCoreModule` (config, ClickHouse, metrics, shutdown signals) with the module of
 *                             the `tomls` worker, chosen by the application's own `selectWorkerModules`, booted as the
 *                             application does. There is no node: `needsNodeClient` says a syncer of only `tomls` makes none.
 *                             The result holds the app, the `DomainDiscovery`, the `TomlChecker`, the `TomlsWorker`, the metrics
 *                             and `stop()`. `options.config` overrides `SyncerConfig` (the defaults here: checks on, a fetch
 *                             timeout of 500 ms, a recheck of 1 h), `options.worker` the `TomlsWorkerOptions` (`now`, `start`,
 *                             ...; the `fetch` options of the web server are already in it, and so is a quiet logger). Both
 *                             loops are OFF unless `worker.start` switches them on: a test makes the passes itself
 *                             (`discovery.discover()`, `checker.pass()`). A boot that fails closes the Nest application before
 *                             it rethrows
 *   resetTomlsMetrics()       clears the metrics of the worker, one set per process
 *   readsOf(ch, db, table, run)   the SELECTs on `table` that ran while `run` did, with the rows each read (`system.query_log`)
 *
 * A spec ends what it starts: `app.stop()`, `web.stop()`, `clickhouse.stop()`.
 */

export interface TomlsApp {
  app: INestApplication;
  discovery: DomainDiscovery;
  checker: TomlChecker;
  worker: TomlsWorker;
  metrics: PrometheusService;
  stop(): Promise<void>;
}

export interface TomlsAppOptions {
  clickhouse: ClickHouseConfig;
  web: TestWeb;
  /** Over the defaults of `SyncerConfig`: `tomls` the only worker, a fetch timeout of 500 ms and a recheck of 1 h. */
  config?: Partial<SyncerConfig>;
  /** Over the defaults: a quiet logger, the fetch options of `web`, and both loops off. */
  worker?: TomlsWorkerOptions;
  /** The network the syncer is of. Default XRPL. */
  profile?: NetworkProfile;
}

/**
 * Boots the tomls worker the way the application does: the core module of the syncer with `TomlsModule` (through
 * `selectWorkerModules`), over a ClickHouse that is already migrated. Resolves when the application is initialised.
 */
export async function startTomlsApp(o: TomlsAppOptions): Promise<TomlsApp> {
  const profile = o.profile ?? getNetworkProfile('xrpl');
  const workers = new Set<WorkerName>(['tomls']);
  const config = Object.assign(new SyncerConfig(), {
    network: profile.name,
    workers: [...workers].join(','),
    domainVerification: true,
    domainFetchTimeoutMs: 500,
    tomlRecheckMs: 3_600_000,
    ...o.config,
  });
  const options: TomlsWorkerOptions = { logger: quietLogger(), fetch: o.web.fetchOptions(), ...o.worker };
  options.start = { discovery: false, checks: false, ...options.start };

  // the options reach the module the way the core stub of a unit spec provides them: from a global module
  @Global()
  @Module({
    providers: [{ provide: TOMLS_WORKER_OPTIONS, useValue: options }],
    exports: [TOMLS_WORKER_OPTIONS],
  })
  class OptionsModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      SyncerCoreModule.register({
        config,
        profile,
        clickHouse: o.clickhouse,
        workerModules: selectWorkerModules(workers),
        nodeClient: needsNodeClient(workers),
      }),
      OptionsModule,
    ],
  })
    .setLogger(quietLogger())
    .compile();
  const app = moduleRef.createNestApplication();
  try {
    await app.init();
  } catch (err) {
    // a boot that failed half way has started things (the ClickHouse client): end them
    await app.close().catch(() => undefined);
    throw err;
  }
  let closing: Promise<void> | undefined;
  return {
    app,
    discovery: app.get(DomainDiscovery),
    checker: app.get(TomlChecker),
    worker: app.get(TomlsWorker),
    metrics: app.get(PrometheusService),
    // a spec that closes the application itself and the one that ends what it started can both call it
    stop: () => (closing ??= app.close()),
  };
}

/** The metrics the tomls worker sets: add the name of a new one here and `resetTomlsMetrics` clears it too. */
export const TOMLS_METRICS = ['tomlsChecksTotal', 'tomlsDomains', 'tomlsDue', 'tomlsDiscoverySeconds'] as const;

/** The metrics are one set per process, so a spec clears the ones the worker sets before each test. */
export function resetTomlsMetrics(): void {
  const metrics = new PrometheusService();
  for (const name of TOMLS_METRICS) metrics[name].reset();
}

/** What `system.query_log` says one SELECT on a table read. */
export interface LoggedRead {
  query: string;
  read_rows: number;
}

/**
 * The SELECTs on `table` of `database` that ran while `run` did, in the order they started, with the rows each read
 * (`system.query_log`; the database is the one the app is connected to).
 */
export async function readsOf(
  ch: ClickHouseService,
  database: string,
  table: Table,
  run: () => Promise<unknown>,
): Promise<LoggedRead[]> {
  const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
  await run();
  await ch.command('SYSTEM FLUSH LOGS');
  const rows = await ch.query<{ query: string; read_rows: string }>(
    `SELECT query, read_rows FROM system.query_log
      WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
        AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
      ORDER BY query_start_time_microseconds`,
    { db: database, t, table: `${database}.${table}` },
  );
  return rows.map((r) => ({ query: r.query, read_rows: Number(r.read_rows) }));
}

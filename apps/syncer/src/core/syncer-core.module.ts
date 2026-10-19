import {
  ClickHouseConfig,
  ClickHouseModule,
  ClickHouseService,
  NetworkProfile,
  NodeClient,
  parseContextFor,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { DynamicModule, Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { enabledWorkers, NETWORK_PROFILE, NODE_CLIENT, PARSE_CONTEXT, SyncerConfig } from '../config/syncer.config';
import { LivelinessModule } from '../modules/liveliness/liveliness.module';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WorkerModule } from '../worker-registry';
import { migrateOnBoot } from './migrate-on-boot';
import { createNodeClient } from './node-client.provider';
import { assertValidatorsSchema } from './schema-check';

/**
 * Token of the async provider that applies the boot-time migrations and then checks that the schema of
 * `002_validators_amendments.sql` is there when a worker that writes it is enabled (`assertValidatorsSchema`). Nest awaits
 * async providers before it calls any lifecycle hook, so workers (which start in their hooks) always find the migrated
 * schema, and a database without 002 fails the boot instead of every write of the validations and validators workers;
 * nothing injects this.
 */
const SCHEMA_READY = Symbol('SCHEMA_READY');

/** Stops the node client (sockets, watchdog) after every worker has shut down. */
@Injectable()
class NodeClientShutdown implements OnApplicationShutdown {
  constructor(@Inject(NODE_CLIENT) private readonly client: NodeClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.stop();
  }
}

export interface SyncerCoreOptions {
  config: SyncerConfig;
  profile: NetworkProfile;
  clickHouse: ClickHouseConfig;
  workerModules: WorkerModule[];
  /**
   * Whether a worker that reads from the shared node client is enabled (`needsNodeClient`). Without one the app makes no
   * client: no connection, no boot network check, and `NODE_CLIENT` is not provided (ruling R99).
   */
  nodeClient: boolean;
}

/**
 * Everything the workers share, global so that a worker module needs no imports to use it:
 * `SyncerConfig`, `NETWORK_PROFILE`, `PARSE_CONTEXT`, `NODE_CLIENT`, `ClickHouseService`, `PrometheusService` and
 * `ShutdownSignals` (SIGTERM / SIGINT cleanups; the node client's stop is registered here, first, so it runs last).
 * It also imports the liveliness probe and the modules of the enabled workers.
 *
 * `NODE_CLIENT` is only there when `options.nodeClient` says a worker reads from it (ingest, fee_stats): an aggregator
 * or validations-only syncer boots without a node (the validations collector makes its own clients, one per node).
 */
@Global()
@Module({})
export class SyncerCoreModule {
  static register(options: SyncerCoreOptions): DynamicModule {
    const { config, profile, clickHouse, workerModules, nodeClient } = options;
    const logger = new Logger('Syncer');
    const node = nodeClient
      ? [
          {
            provide: NODE_CLIENT,
            useFactory: async (signals: ShutdownSignals) => {
              const client = await createNodeClient(config, profile);
              signals.register('node-client', () => client.stop());
              return client;
            },
            inject: [ShutdownSignals],
          },
          NodeClientShutdown,
        ]
      : [];
    return {
      module: SyncerCoreModule,
      imports: [ClickHouseModule.forRoot(clickHouse), LivelinessModule, ...workerModules],
      providers: [
        { provide: SyncerConfig, useValue: config },
        { provide: NETWORK_PROFILE, useValue: profile },
        { provide: PARSE_CONTEXT, useValue: parseContextFor(profile) },
        {
          provide: SCHEMA_READY,
          useFactory: async (ch: ClickHouseService) => {
            const migrated = await migrateOnBoot(config, clickHouse, logger);
            await assertValidatorsSchema(ch, enabledWorkers(config), clickHouse.database, logger);
            return migrated;
          },
          inject: [ClickHouseService],
        },
        ShutdownSignals,
        ...node,
        PrometheusService,
      ],
      exports: [
        SyncerConfig,
        NETWORK_PROFILE,
        PARSE_CONTEXT,
        ...(nodeClient ? [NODE_CLIENT] : []),
        PrometheusService,
        ShutdownSignals,
      ],
    };
  }
}

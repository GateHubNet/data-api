import {
  ClickHouseConfig,
  ClickHouseModule,
  NetworkProfile,
  NodeClient,
  parseContextFor,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { DynamicModule, Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { NETWORK_PROFILE, NODE_CLIENT, PARSE_CONTEXT, SyncerConfig } from '../config/syncer.config';
import { LivelinessModule } from '../modules/liveliness/liveliness.module';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { WorkerModule } from '../worker-registry';
import { migrateOnBoot } from './migrate-on-boot';
import { createNodeClient } from './node-client.provider';

/**
 * Token of the async provider that applies the boot-time migrations. Nest awaits async providers before it calls any
 * lifecycle hook, so workers (which start in their hooks) always find the migrated schema; nothing injects this.
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
}

/**
 * Everything the workers share, global so that a worker module needs no imports to use it:
 * `SyncerConfig`, `NETWORK_PROFILE`, `PARSE_CONTEXT`, `NODE_CLIENT`, `ClickHouseService`, `PrometheusService` and
 * `ShutdownSignals` (SIGTERM / SIGINT cleanups; the node client's stop is registered here, first, so it runs last).
 * It also imports the liveliness probe and the modules of the enabled workers.
 */
@Global()
@Module({})
export class SyncerCoreModule {
  static register(options: SyncerCoreOptions): DynamicModule {
    const { config, profile, clickHouse, workerModules } = options;
    const logger = new Logger('Syncer');
    return {
      module: SyncerCoreModule,
      imports: [ClickHouseModule.forRoot(clickHouse), LivelinessModule, ...workerModules],
      providers: [
        { provide: SyncerConfig, useValue: config },
        { provide: NETWORK_PROFILE, useValue: profile },
        { provide: PARSE_CONTEXT, useValue: parseContextFor(profile) },
        { provide: SCHEMA_READY, useFactory: () => migrateOnBoot(config, clickHouse, logger) },
        ShutdownSignals,
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
        PrometheusService,
      ],
      exports: [SyncerConfig, NETWORK_PROFILE, PARSE_CONTEXT, NODE_CLIENT, PrometheusService, ShutdownSignals],
    };
  }
}

import {
  ClickHouseConfig,
  ClickHouseModule,
  ClickHouseService,
  NetworkProfile,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { DynamicModule, Global, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { CacheService } from './cache.service';

/**
 * Wires the process's graceful shutdown. The toolbox `bootstrap()` never enables Nest's shutdown hooks (ruling R19),
 * so a SIGTERM would kill the process mid-request; `ShutdownSignals` runs these on SIGTERM / SIGINT instead, in reverse
 * order of registration:
 *  1. the HTTP server stops accepting connections and lets the requests in flight finish (registered last, so first);
 *  2. the ClickHouse client closes (registered when it is built, so after every request is done).
 * The NodeClient stop of the live-node service (Task 18) registers next to the ClickHouse one.
 */
@Injectable()
class ShutdownRegistrations implements OnApplicationBootstrap {
  constructor(
    private readonly signals: ShutdownSignals,
    clickhouse: ClickHouseService,
    private readonly adapterHost: HttpAdapterHost,
  ) {
    signals.register('clickhouse', () => clickhouse.raw.close());
  }

  onApplicationBootstrap(): void {
    // Every provider's constructor and onModuleInit have run: whatever they registered is torn down after this.
    this.signals.register('http-server', async () => {
      await this.adapterHost.httpAdapter?.close();
    });
  }
}

export interface CommonOptions {
  config: ApiConfig;
  profile: NetworkProfile;
  clickHouse: ClickHouseConfig;
}

/**
 * Everything the endpoint modules share, global so that they need no imports to use it: `ApiConfig`,
 * `NETWORK_PROFILE`, `ClickHouseService`, `CacheService`, `PrometheusService` and `ShutdownSignals`.
 */
@Global()
@Module({})
export class CommonModule {
  static register(options: CommonOptions): DynamicModule {
    const { config, profile, clickHouse } = options;
    return {
      module: CommonModule,
      // GateHubConfigModule provides the ConfigService the toolbox swagger setup resolves.
      imports: [GateHubConfigModule, ClickHouseModule.forRoot(clickHouse)],
      providers: [
        { provide: ApiConfig, useValue: config },
        { provide: NETWORK_PROFILE, useValue: profile },
        CacheService,
        PrometheusService,
        ShutdownSignals,
        ShutdownRegistrations,
      ],
      exports: [ApiConfig, NETWORK_PROFILE, CacheService, PrometheusService, ShutdownSignals],
    };
  }
}

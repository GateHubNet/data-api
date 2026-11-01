import { DynamicModule, Global, Module } from '@nestjs/common';
import { CLICKHOUSE_CONFIG, ClickHouseConfig, clickHouseConfigFromEnv } from './clickhouse.config';
import { ClickHouseService } from './clickhouse.service';

/**
 * Shared ClickHouse module. Register once per app with `ClickHouseModule.forRoot()`.
 * Replaces the per-module, copy-pasted Elasticsearch client config from the old API.
 */
@Global()
@Module({})
export class ClickHouseModule {
  static forRoot(config?: Partial<ClickHouseConfig>): DynamicModule {
    // A caller that names the server needs no GH_CLICKHOUSE_URL.
    const env = config?.url ? { ...process.env, GH_CLICKHOUSE_URL: config.url } : process.env;
    const resolved: ClickHouseConfig = { ...clickHouseConfigFromEnv(env), ...config };
    return {
      module: ClickHouseModule,
      providers: [{ provide: CLICKHOUSE_CONFIG, useValue: resolved }, ClickHouseService],
      exports: [ClickHouseService],
    };
  }
}

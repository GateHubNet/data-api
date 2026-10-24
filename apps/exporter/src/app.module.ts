import {
  clickHouseConfigFromEnv,
  ClickHouseModule,
  ClickHouseService,
  getNetworkProfile,
  ShutdownSignals,
} from '@gatehub/data-api-shared';
import { DynamicModule, Global, Injectable, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ExporterConfig, loadExporterConfig, NETWORK_PROFILE } from './config/exporter.config';
import { ExportWorkerService } from './export-worker.service';
import { LivelinessModule } from './modules/liveliness/liveliness.module';
import { PrometheusService } from './modules/prometheus/prometheus.service';

/** Closes the ClickHouse client on SIGTERM / SIGINT: registered before the worker stop, so it runs after it. */
@Injectable()
class ShutdownRegistrations {
  constructor(signals: ShutdownSignals, clickhouse: ClickHouseService) {
    signals.register('clickhouse', () => clickhouse.raw.close());
  }
}

/** Everything the exporter's modules share: `ExporterConfig`, `NETWORK_PROFILE`, ClickHouse, metrics, shutdown. */
@Global()
@Module({})
class ExporterCoreModule {
  static async register(): Promise<DynamicModule> {
    const config = await loadExporterConfig();
    const profile = getNetworkProfile(config.network);
    const clickHouse = clickHouseConfigFromEnv(process.env, profile);
    new Logger('Exporter').log(
      `network=${profile.name} database=${clickHouse.database} api=${config.apiUrl} bucket=${config.exportBucket}`,
    );
    return {
      module: ExporterCoreModule,
      imports: [ClickHouseModule.forRoot(clickHouse)],
      providers: [
        { provide: ExporterConfig, useValue: config },
        { provide: NETWORK_PROFILE, useValue: profile },
        PrometheusService,
        ShutdownSignals,
        ShutdownRegistrations,
      ],
      exports: [ExporterConfig, NETWORK_PROFILE, PrometheusService, ShutdownSignals],
    };
  }
}

const assembled = ExporterCoreModule.register();
// A failure (invalid configuration, ...) is reported when Nest awaits the module in `NestFactory.create`; this handler
// only keeps it from also being reported as an unhandled rejection while the import is still running.
assembled.catch(() => undefined);

/**
 * The exporter (spec #4, ticket #15): one per network. Importing `app.module` loads and validates the configuration
 * (GH_* variables, see `ExporterConfig`).
 */
@Module({ imports: [assembled, LivelinessModule], providers: [ExportWorkerService] })
export class AppModule implements NestModule {
  // The toolbox bootstrap() types its root module as a NestModule; the exporter has no middleware.
  configure(_consumer: MiddlewareConsumer): void {}
}

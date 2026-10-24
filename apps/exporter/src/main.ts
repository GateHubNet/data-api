import { bootstrap } from '@gatehub/toolbox/lib/bootstrap';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadExporterConfig } from './config/exporter.config';
import { PrometheusModule } from './modules/prometheus/prometheus.module';

async function main(): Promise<void> {
  const cfg = await loadExporterConfig();
  // The exporter is a worker, but it still serves HTTP: the liveliness probe on the main port and Prometheus metrics on
  // a second app (metricz).
  await bootstrap(AppModule, {
    port: cfg.httpApiPort,
    swaggerDocs: { disabled: true },
    versioning: { disabled: true, defaultVersion: '1' },
    metricz: { module: PrometheusModule, port: cfg.metriczPort },
  });
}

main().catch((err) => {
  new Logger('ExporterBootstrap').error('Fatal bootstrap error', err instanceof Error ? err.stack : err);
  process.exit(1);
});

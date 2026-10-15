import { bootstrap } from '@gatehub/toolbox/lib/bootstrap';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadApiConfig } from './config/api.config';
import { registerServiceInfo } from './config/service-info';
import { PrometheusModule } from './modules/prometheus/prometheus.module';

async function main(): Promise<void> {
  const cfg = await loadApiConfig();
  await registerServiceInfo();
  await bootstrap(AppModule, {
    port: cfg.httpApiPort,
    // The toolbox pipe rejects unknown query parameters; the Ripple API ignores them and parses its own.
    disableValidationPipe: true,
    // The paths carry their own /v2 (see RippleController), and the liveliness probe is unversioned.
    versioning: { disabled: true, defaultVersion: '1' },
    swaggerDocs: { docsPath: 'internal/docs' },
    metricz: { module: PrometheusModule, port: cfg.metriczPort },
  });
}

main().catch((err) => {
  new Logger('ApiBootstrap').error('Fatal bootstrap error', err instanceof Error ? err.stack : err);
  process.exit(1);
});

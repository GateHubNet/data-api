import { METRICS_SOURCE, PrometheusController } from '@gatehub/data-api-shared';
import { Global, Module } from '@nestjs/common';
import { PrometheusService } from './prometheus.service';

/**
 * Serves `/metricz`. It is the `metricz.module` of the toolbox `bootstrap()`, which starts it as a second Nest app on
 * `GH_METRICZ_PORT` (default 3000). The main app records through the `PrometheusService` the CommonModule provides;
 * both services share one registry (see the service), so the scrape shows the traffic of the main port.
 */
@Global()
@Module({
  controllers: [PrometheusController],
  providers: [PrometheusService, { provide: METRICS_SOURCE, useExisting: PrometheusService }],
  exports: [PrometheusService],
})
export class PrometheusModule {}

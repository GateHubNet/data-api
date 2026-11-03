import { Global, Module } from '@nestjs/common';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';

/**
 * Serves `/metricz`. It is the `metricz.module` of the toolbox `bootstrap()`, which starts it as a second Nest app on
 * `GH_METRICZ_PORT` (default 3000). The worker publishes through the `PrometheusService` of the main app; both services
 * share one registry (see the service).
 */
@Global()
@Module({
  controllers: [PrometheusController],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}

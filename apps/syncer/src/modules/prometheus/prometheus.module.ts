import { Global, Module } from '@nestjs/common';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';

/**
 * Metrics served on the main HTTP port at `/metricz`.
 *
 * Note: gh-bridge boots a second Nest app for Prometheus on port 3000. For a worker
 * that must publish domain gauges from its sync loop we keep a single registry in the
 * main app instead, so those gauges and the scrape endpoint share one DI container.
 */
@Global()
@Module({
  controllers: [PrometheusController],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}

import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * One registry and one set of metrics per process. The toolbox `bootstrap()` runs the Prometheus module as a second
 * Nest app (own DI container, own port) next to the main app, so the worker of the main app and the scrape endpoint of
 * the metricz app each get their own `PrometheusService`. They must see the same metrics, so those live here, once.
 */
const registry = new Registry();
collectDefaultMetrics({ register: registry });

const metrics = {
  jobsTotal: new Counter({
    name: 'exporter_jobs_total',
    help: 'Export jobs the exporter finished, by status (done, failed).',
    labelNames: ['status'],
    registers: [registry],
  }),
  rowsTotal: new Counter({
    name: 'exporter_rows_total',
    help: 'Rows written to export files.',
    registers: [registry],
  }),
  jobSeconds: new Histogram({
    name: 'exporter_job_duration_seconds',
    help: 'How long an export job took, from running to done or failed.',
    labelNames: ['status'],
    buckets: [1, 5, 15, 60, 300, 900, 3600],
    registers: [registry],
  }),
};

@Injectable()
export class PrometheusService {
  /** Counts a finished job. */
  jobFinished(status: 'done' | 'failed', rows: number, seconds: number): void {
    metrics.jobsTotal.inc({ status });
    metrics.rowsTotal.inc(rows);
    metrics.jobSeconds.observe({ status }, seconds);
  }

  getMetrics(): Promise<string> {
    return registry.metrics();
  }
}

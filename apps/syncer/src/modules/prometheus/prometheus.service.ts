import { Injectable, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

/**
 * One registry and one set of metrics per process. The toolbox `bootstrap()` runs the Prometheus module as a second
 * Nest app (own DI container, own port) next to the main app, so the workers of the main app and the scrape endpoint of
 * the metricz app each get their own `PrometheusService`. They must see the same metrics, so those live here, once.
 */
const registry = new Registry();

const metrics = {
  checkpointLedger: new Gauge({
    name: 'syncer_checkpoint_ledger',
    help: 'Highest ledger index committed to ClickHouse.',
    registers: [registry],
  }),
  headLedger: new Gauge({
    name: 'syncer_head_ledger',
    help: 'Latest validated ledger index known from the node.',
    registers: [registry],
  }),
  lagLedgers: new Gauge({
    name: 'syncer_lag_ledgers',
    help: 'Validated head minus the committed checkpoint, in ledgers.',
    registers: [registry],
  }),
  lastCommitTimestampSeconds: new Gauge({
    name: 'syncer_last_commit_timestamp_seconds',
    help: 'Unix time of the last ledger commit.',
    registers: [registry],
  }),
  lastCommitAgeSeconds: new Gauge({
    name: 'syncer_last_commit_age_seconds',
    help: 'Seconds since the last ledger commit, computed at scrape time; NaN before the first commit.',
    registers: [registry],
    async collect() {
      const last = (await metrics.lastCommitTimestampSeconds.get()).values[0]?.value;
      this.set(last ? Math.max(0, Date.now() / 1000 - last) : Number.NaN);
    },
  }),
  validationsFlushedTotal: new Counter({
    name: 'syncer_validations_flushed_total',
    help: 'Validation rows flushed to ClickHouse.',
    registers: [registry],
  }),
  validationsErrorsTotal: new Counter({
    name: 'syncer_validations_errors_total',
    help: 'Failures of the validations collector, by stage (flush, reporter, manifest_rpc, ...).',
    labelNames: ['stage'],
    registers: [registry],
  }),
  validationsDroppedTotal: new Counter({
    name: 'syncer_validations_dropped_total',
    help: 'Validations (or buffered rows) the collector did not keep, by reason (buffer_full, no_reporter, invalid).',
    labelNames: ['reason'],
    registers: [registry],
  }),
  feeStatsSamplesTotal: new Counter({
    name: 'syncer_fee_stats_samples_total',
    help: 'Fee stats samples written to ClickHouse.',
    registers: [registry],
  }),
  feeStatsErrorsTotal: new Counter({
    name: 'syncer_fee_stats_errors_total',
    help: 'Fee stats samples that failed (the node did not answer, or ClickHouse refused the row).',
    registers: [registry],
  }),
  aggregatorRunsTotal: new Counter({
    name: 'syncer_aggregator_runs_total',
    help: 'Aggregator job runs, by job.',
    labelNames: ['job'],
    registers: [registry],
  }),
};

let defaultMetricsCollected = false;

/**
 * The syncer's Prometheus metrics: default process metrics (prefixed `syncer_`) plus the domain metrics the workers
 * update. The names are the contract with the dashboards; workers set the gauges and increment the counters.
 */
@Injectable()
export class PrometheusService implements OnModuleInit {
  readonly registry = registry;

  readonly checkpointLedger = metrics.checkpointLedger;
  readonly headLedger = metrics.headLedger;
  readonly lagLedgers = metrics.lagLedgers;
  readonly lastCommitTimestampSeconds = metrics.lastCommitTimestampSeconds;
  /** Derived from `lastCommitTimestampSeconds` when scraped; nothing sets it. */
  readonly lastCommitAgeSeconds = metrics.lastCommitAgeSeconds;
  readonly validationsFlushedTotal = metrics.validationsFlushedTotal;
  readonly validationsErrorsTotal = metrics.validationsErrorsTotal;
  readonly validationsDroppedTotal = metrics.validationsDroppedTotal;
  readonly feeStatsSamplesTotal = metrics.feeStatsSamplesTotal;
  readonly feeStatsErrorsTotal = metrics.feeStatsErrorsTotal;
  readonly aggregatorRunsTotal = metrics.aggregatorRunsTotal;

  onModuleInit(): void {
    // Registering the same default metrics twice throws, and both apps initialise a service.
    if (defaultMetricsCollected) return;
    defaultMetricsCollected = true;
    collectDefaultMetrics({ register: registry, prefix: 'syncer_' });
  }

  async getMetrics(): Promise<string> {
    return registry.metrics();
  }
}

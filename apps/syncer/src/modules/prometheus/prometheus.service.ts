import { nodeThrottle, ThrottlePause } from '@gatehub/data-api-shared';
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
  nodeRateLimitedTotal: new Counter({
    name: 'syncer_node_rate_limited_total',
    help: 'Pauses a node asked for with a rate-limit answer (nothing is sent to it while one lasts), by endpoint host.',
    labelNames: ['endpoint'],
    registers: [registry],
  }),
  ingestHaltsTotal: new Counter({
    name: 'syncer_ingest_halts_total',
    help: 'Times the live ingest halted until an operator intervenes, by reason (chain_break, parse_error, lease_lost).',
    labelNames: ['reason'],
    registers: [registry],
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
    help: 'Validations (or buffered rows) the collector did not keep, by reason (buffer_full, no_reporter, manifest_no_reporter, invalid, shutdown).',
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
  aggregatorStatsLagSeconds: new Gauge({
    name: 'syncer_aggregator_stats_lag_seconds',
    help: 'Seconds of ledger history the stats catch-up still has to cover (0 when the stats are up to the last two hours). Positive for as long as a sweep of an old database or after an outage is under way.',
    registers: [registry],
  }),
  aggregatorErrorsTotal: new Counter({
    name: 'syncer_aggregator_errors_total',
    help: 'Aggregator jobs (or slices of one) that failed, by job; each is retried on the next tick.',
    labelNames: ['job'],
    registers: [registry],
  }),
  pairHourlyMissingHours: new Gauge({
    name: 'syncer_pair_hourly_missing_hours',
    help: 'Hours of the last 31 days without a set of the current config version.',
    registers: [registry],
  }),
  marketsLiveAgeSeconds: new Gauge({
    name: 'syncer_markets_live_age_seconds',
    help: 'Now minus the end_time of the newest include set.',
    labelNames: ['period'],
    registers: [registry],
  }),
  validatorsUnlFetchesTotal: new Counter({
    name: 'syncer_validators_unl_fetches_total',
    help: 'Validator list fetches, by publisher and outcome (ok, unchanged, or the reason code of the failure).',
    labelNames: ['publisher', 'outcome'],
    registers: [registry],
  }),
  validatorsUnlExpirySeconds: new Gauge({
    name: 'syncer_validators_unl_expiry_seconds',
    help: 'Seconds until the current validator list of a publisher expires (negative when expired).',
    labelNames: ['publisher'],
    registers: [registry],
  }),
  validatorsUnlSize: new Gauge({
    name: 'syncer_validators_unl_size',
    help: 'Validators on the current list of a publisher.',
    labelNames: ['publisher'],
    registers: [registry],
  }),
  validatorsDomainChecksTotal: new Counter({
    name: 'syncer_validators_domain_checks_total',
    help: 'Domain checks of validators, by outcome (verified, or the reason code of the failure).',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  validatorsNodePollsTotal: new Counter({
    name: 'syncer_validators_node_polls_total',
    help: 'Polls of the node by the validators worker, by request (amendments, negative_unl, fee_settings, server_info, feature) and outcome (ok, error).',
    labelNames: ['request', 'outcome'],
    registers: [registry],
  }),
  validatorsJobsTotal: new Counter({
    name: 'syncer_validators_jobs_total',
    help: 'Runs of the validators worker jobs, by job (rounds, agreement) and outcome (ok, error).',
    labelNames: ['job', 'outcome'],
    registers: [registry],
  }),
  validatorsAgreementLagSeconds: new Gauge({
    name: 'syncer_validators_agreement_lag_seconds',
    help: 'Now minus the end of the newest final hour of validator agreement, in seconds.',
    registers: [registry],
  }),
  validatorsRoundsLagLedgers: new Gauge({
    name: 'syncer_validators_rounds_lag_ledgers',
    help: 'Newest committed voting ledger minus the newest stored amendment voting round, in ledgers.',
    registers: [registry],
  }),
  amendmentsWithoutMetadata: new Gauge({
    name: 'syncer_amendments_without_metadata',
    help: 'Amendments seen (node, ledger, votes) without an entry in the amendment metadata.',
    registers: [registry],
  }),
  validatorValidationsFlushedTotal: new Counter({
    name: 'syncer_validator_validations_flushed_total',
    help: 'Rows written to validator_validations and validator_seen, by table.',
    labelNames: ['table'],
    registers: [registry],
  }),
};

// Every node client of the process shares `nodeThrottle`: each pause it starts is counted here, once.
nodeThrottle.on('pause', (pause: ThrottlePause) => metrics.nodeRateLimitedTotal.inc({ endpoint: pause.host }));

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
  readonly ingestHaltsTotal = metrics.ingestHaltsTotal;
  readonly nodeRateLimitedTotal = metrics.nodeRateLimitedTotal;
  readonly validationsFlushedTotal = metrics.validationsFlushedTotal;
  readonly validationsErrorsTotal = metrics.validationsErrorsTotal;
  readonly validationsDroppedTotal = metrics.validationsDroppedTotal;
  readonly feeStatsSamplesTotal = metrics.feeStatsSamplesTotal;
  readonly feeStatsErrorsTotal = metrics.feeStatsErrorsTotal;
  readonly aggregatorRunsTotal = metrics.aggregatorRunsTotal;
  readonly aggregatorErrorsTotal = metrics.aggregatorErrorsTotal;
  readonly aggregatorStatsLagSeconds = metrics.aggregatorStatsLagSeconds;
  readonly pairHourlyMissingHours = metrics.pairHourlyMissingHours;
  readonly marketsLiveAgeSeconds = metrics.marketsLiveAgeSeconds;
  readonly validatorsUnlFetchesTotal = metrics.validatorsUnlFetchesTotal;
  readonly validatorsUnlExpirySeconds = metrics.validatorsUnlExpirySeconds;
  readonly validatorsUnlSize = metrics.validatorsUnlSize;
  readonly validatorsDomainChecksTotal = metrics.validatorsDomainChecksTotal;
  readonly validatorsNodePollsTotal = metrics.validatorsNodePollsTotal;
  readonly validatorsJobsTotal = metrics.validatorsJobsTotal;
  readonly validatorsAgreementLagSeconds = metrics.validatorsAgreementLagSeconds;
  readonly validatorsRoundsLagLedgers = metrics.validatorsRoundsLagLedgers;
  readonly amendmentsWithoutMetadata = metrics.amendmentsWithoutMetadata;
  readonly validatorValidationsFlushedTotal = metrics.validatorValidationsFlushedTotal;

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

import { nodeThrottle, ThrottlePause } from '@gatehub/data-api-shared';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

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
  ammUnclassifiedTotal: new Counter({
    name: 'syncer_amm_unclassified_total',
    help: 'Pools of AMM transactions the parser could make no swap, liquidity or governance row for, or whose assets it could not tell (spec §2.3), over the ledgers written by the live ingest and by range-ingest runs of this process.',
    registers: [registry],
  }),
  nftSkippedTotal: new Counter({
    name: 'syncer_nft_skipped_total',
    help: 'NFT and URIToken events the parser dropped because their amount is an MPT amount or not an amount at all (spec §2.5), over the ledgers written by the live ingest and by range-ingest runs of this process.',
    registers: [registry],
  }),
  objectsUnclassifiedTotal: new Counter({
    name: 'syncer_objects_unclassified_total',
    help: 'Changes of an escrow, check, payment channel or delegation that no event of the object history expects (the event update, spec section 2.2), over the ledgers written by the live ingest and by range-ingest runs of this process.',
    registers: [registry],
  }),
  parserAnomaliesTotal: new Counter({
    name: 'syncer_parser_anomalies_total',
    help: 'Things a parser found in a ledger that the network cannot produce and stored in a safe form, by kind (import_minted_negative: a Xahau Import whose minted drops came out below 0 and were stored as 0; mpt_unreadable: an MPT amount that is not a UInt64, stored as 0, or a node skipped because its ID cannot be made), over the ledgers written by the live ingest and by range-ingest runs of this process.',
    labelNames: ['kind'],
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
  marketsLiveAmmShareKnown: new Gauge({
    name: 'syncer_markets_live_amm_share_known',
    help: '1 when the newest include markets set of the period has total_amm_share (every ledger of its window parsed with AMM), else 0.',
    labelNames: ['period'],
    registers: [registry],
  }),
  ratesDailyMissingDays: new Gauge({
    name: 'syncer_rates_daily_missing_days',
    help: 'Closed final days without a valid rates set, from the first native trade to the newest final day.',
    registers: [registry],
  }),
  accountRollupsHeavyAccounts: new Gauge({
    name: 'syncer_account_rollups_heavy_accounts',
    help: 'Heavy accounts.',
    registers: [registry],
  }),
  accountRollupsPendingAccounts: new Gauge({
    name: 'syncer_account_rollups_pending_accounts',
    help: 'Heavy accounts whose coverage does not yet reach from first_day to the newest final day.',
    registers: [registry],
  }),
  nftStateLagLedgers: new Gauge({
    name: 'syncer_nft_state_lag_ledgers',
    help: 'Ledgers between the newest committed ledger and the live cursor of the nft_state job.',
    registers: [registry],
  }),
  nftDirtyLedgers: new Gauge({
    name: 'syncer_nft_dirty_ledgers',
    help: 'Ledgers in the ranges of nft_dirty that the nft_state job has still to rebuild the NFTs of.',
    registers: [registry],
  }),
  nftCollectionsPending: new Gauge({
    name: 'syncer_nft_collections_pending',
    help: 'NFT collections queued for the nft_collections job to compute again.',
    registers: [registry],
  }),
  escrowsLagLedgers: new Gauge({
    name: 'syncer_escrows_lag_ledgers',
    help: 'Ledgers between the newest committed ledger and the watermark of the escrows job (the through_ledger of its sentinel).',
    registers: [registry],
  }),
  escrowsOpen: new Gauge({
    name: 'syncer_escrows_open',
    help: 'Open native escrows, as the sentinel of the escrows job counts them.',
    registers: [registry],
  }),
  tokensLive: new Gauge({
    name: 'syncer_tokens_live',
    help: "1 when a live generation of the issued tokens exists, else 0. Gates the explorer's TOKENS switch.",
    registers: [registry],
  }),
  tokensLagLedgers: new Gauge({
    name: 'syncer_tokens_lag_ledgers',
    help: 'Ledgers between the newest committed ledger and the through_ledger of the live generation of the issued tokens (0 without one).',
    registers: [registry],
  }),
  tokensBuilding: new Gauge({
    name: 'syncer_tokens_building',
    help: '1 while a generation of the issued tokens builds, else 0. The account cursor of its pass is logged at each batch.',
    registers: [registry],
  }),
  tokensRepairLedgers: new Gauge({
    name: 'syncer_tokens_repair_ledgers',
    help: 'through_ledger less repair_from of the live generation of the issued tokens: the ledgers its repair applies again, 0 without a repair.',
    registers: [registry],
  }),
  tokenHistoryLagLedgers: new Gauge({
    name: 'syncer_token_history_lag_ledgers',
    help: 'Ledgers between the committed head and the levels_through of the live generation of the token history; no sample without one. Alert above 30 for 10 minutes.',
    registers: [registry],
  }),
  tokenHistoryRebuildNeeded: new Gauge({
    name: 'syncer_token_history_rebuild_needed',
    help: 'A build of the token history is due, by reason (none: no generation yet; coverage; config; repair): 1 for the reason, no series when none is due. A build is run by the operator (token-history-build).',
    labelNames: ['reason'],
    registers: [registry],
  }),
  tokenHistoryBuilding: new Gauge({
    name: 'syncer_token_history_building',
    help: '1 while a building generation of the token history is in this phase (changes, mpt_changes, levels, dex, done), from its state rows.',
    labelNames: ['phase'],
    registers: [registry],
  }),
  tokenHistoryWindowSeconds: new Histogram({
    name: 'syncer_token_history_window_seconds',
    help: 'Seconds a live window of the token history took, from its read to its state row.',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  }),
  tokenHistoryErrorsTotal: new Counter({
    name: 'syncer_token_history_errors_total',
    help: 'Failed steps of the token_history worker, by step (live, repair, catch_up, dex, drop). Alert when it rises for 15 minutes.',
    labelNames: ['step'],
    registers: [registry],
  }),
  tokenHistoryUnfitSumsTotal: new Counter({
    name: 'syncer_token_history_unfit_sums_total',
    help: 'Sums of the token history that held an amount Decimal256(30) cannot hold, and were summed again in BigNumber.',
    registers: [registry],
  }),
  mptStateLagLedgers: new Gauge({
    name: 'syncer_mpt_state_lag_ledgers',
    help: 'Ledgers between the committed head and the mpt_state cursor',
    registers: [registry],
  }),
  supplySnapshotAgeSeconds: new Gauge({
    name: 'syncer_supply_snapshot_age_seconds',
    help: 'Seconds since the close time of the newest supply snapshot the supply job knows (read or written by it); no sample until it has seen one. Alert above 3 hours.',
    registers: [registry],
  }),
  supplyCycleSeconds: new Gauge({
    name: 'syncer_supply_cycle_seconds',
    help: 'Wall-clock seconds the last finished supply cycle took, from its start to the write of its snapshot row; no sample until the first one.',
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
  validatorsTomlFieldsTotal: new Counter({
    name: 'syncer_validators_toml_fields_total',
    help: "Per verified domain check, what the validator's toml entry gave, by field (owner_country, server_country, network, unl) and outcome (read, absent, invalid).",
    labelNames: ['field', 'outcome'],
    registers: [registry],
  }),
  validatorsTomlStoreWritesTotal: new Counter({
    name: 'syncer_validators_toml_store_writes_total',
    help: 'Writes of the domain checker to the per-domain toml store, by outcome (ok, error). A failed write does not fail the pass.',
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
  tomlsChecksTotal: new Counter({
    name: 'syncer_tomls_checks_total',
    help: 'Checks of the toml of a domain, by outcome (ok, or the reason code of the failure).',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  tomlsDomains: new Gauge({
    name: 'syncer_tomls_domains',
    help: 'Domains accounts name, by the status of their toml after the last pass (ok, failed, unchecked).',
    labelNames: ['status'],
    registers: [registry],
  }),
  tomlsDue: new Gauge({
    name: 'syncer_tomls_due',
    help: 'Domains due and not checked yet at the end of the last pass.',
    registers: [registry],
  }),
  tomlsDiscoverySeconds: new Gauge({
    name: 'syncer_tomls_discovery_seconds',
    help: 'Duration of the last discovery read, in seconds.',
    registers: [registry],
  }),
};

// A labelled counter has no series until its first `inc`, and `increase()` of a series that first shows at its value is 0: the first
// Import the parser clamps would raise no alert. The series of each kind starts at 0, as the unlabelled counters above do.
metrics.parserAnomaliesTotal.inc({ kind: 'import_minted_negative' }, 0);
metrics.parserAnomaliesTotal.inc({ kind: 'mpt_unreadable' }, 0);
// the alert is an increase(), and a series that first shows at its value has none: its first failure would raise nothing
metrics.validatorsTomlStoreWritesTotal.inc({ outcome: 'ok' }, 0);
metrics.validatorsTomlStoreWritesTotal.inc({ outcome: 'error' }, 0);
// the same: an issuance set aside moves no lag, and its errors are all that say so, up to an hour apart
metrics.aggregatorErrorsTotal.inc({ job: 'mpt_state' }, 0);
metrics.aggregatorErrorsTotal.inc({ job: 'mpt_state_dirty' }, 0);
metrics.aggregatorErrorsTotal.inc({ job: 'token_history_dirty' }, 0);
for (const step of ['live', 'repair', 'catch_up', 'dex', 'drop']) metrics.tokenHistoryErrorsTotal.inc({ step }, 0);

// prom-client gives a gauge without labels a sample of 0 when it is registered. These two are not known until the supply job has seen
// a snapshot, or written a row: a 0 would read as a snapshot that has just been written, and no alert could fire on a job that
// never writes one. So they start without a sample (the HELP and TYPE lines stay, `absent()` is true), and a `set` brings it.
metrics.supplySnapshotAgeSeconds.remove();
// the same for the token history's lag: not known until the worker has read a live generation
metrics.tokenHistoryLagLedgers.remove();
metrics.supplyCycleSeconds.remove();

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
  readonly ammUnclassifiedTotal = metrics.ammUnclassifiedTotal;
  readonly nftSkippedTotal = metrics.nftSkippedTotal;
  readonly objectsUnclassifiedTotal = metrics.objectsUnclassifiedTotal;
  readonly parserAnomaliesTotal = metrics.parserAnomaliesTotal;
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
  readonly marketsLiveAmmShareKnown = metrics.marketsLiveAmmShareKnown;
  readonly ratesDailyMissingDays = metrics.ratesDailyMissingDays;
  readonly accountRollupsHeavyAccounts = metrics.accountRollupsHeavyAccounts;
  readonly accountRollupsPendingAccounts = metrics.accountRollupsPendingAccounts;
  readonly nftStateLagLedgers = metrics.nftStateLagLedgers;
  readonly nftDirtyLedgers = metrics.nftDirtyLedgers;
  readonly nftCollectionsPending = metrics.nftCollectionsPending;
  readonly escrowsLagLedgers = metrics.escrowsLagLedgers;
  readonly escrowsOpen = metrics.escrowsOpen;
  readonly tokensLive = metrics.tokensLive;
  readonly tokensLagLedgers = metrics.tokensLagLedgers;
  readonly mptStateLagLedgers = metrics.mptStateLagLedgers;
  readonly tokensBuilding = metrics.tokensBuilding;
  readonly tokensRepairLedgers = metrics.tokensRepairLedgers;
  readonly supplySnapshotAgeSeconds = metrics.supplySnapshotAgeSeconds;
  readonly supplyCycleSeconds = metrics.supplyCycleSeconds;
  readonly validatorsUnlFetchesTotal = metrics.validatorsUnlFetchesTotal;
  readonly validatorsUnlExpirySeconds = metrics.validatorsUnlExpirySeconds;
  readonly validatorsUnlSize = metrics.validatorsUnlSize;
  readonly validatorsDomainChecksTotal = metrics.validatorsDomainChecksTotal;
  readonly validatorsTomlFieldsTotal = metrics.validatorsTomlFieldsTotal;
  readonly validatorsTomlStoreWritesTotal = metrics.validatorsTomlStoreWritesTotal;
  readonly validatorsNodePollsTotal = metrics.validatorsNodePollsTotal;
  readonly validatorsJobsTotal = metrics.validatorsJobsTotal;
  readonly validatorsAgreementLagSeconds = metrics.validatorsAgreementLagSeconds;
  readonly validatorsRoundsLagLedgers = metrics.validatorsRoundsLagLedgers;
  readonly amendmentsWithoutMetadata = metrics.amendmentsWithoutMetadata;
  readonly validatorValidationsFlushedTotal = metrics.validatorValidationsFlushedTotal;
  readonly tomlsChecksTotal = metrics.tomlsChecksTotal;
  readonly tomlsDomains = metrics.tomlsDomains;
  readonly tomlsDue = metrics.tomlsDue;
  readonly tomlsDiscoverySeconds = metrics.tomlsDiscoverySeconds;
  readonly tokenHistoryLagLedgers = metrics.tokenHistoryLagLedgers;
  readonly tokenHistoryRebuildNeeded = metrics.tokenHistoryRebuildNeeded;
  readonly tokenHistoryBuilding = metrics.tokenHistoryBuilding;
  readonly tokenHistoryWindowSeconds = metrics.tokenHistoryWindowSeconds;
  readonly tokenHistoryErrorsTotal = metrics.tokenHistoryErrorsTotal;
  readonly tokenHistoryUnfitSumsTotal = metrics.tokenHistoryUnfitSumsTotal;

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

import { nodeThrottle } from '@gatehub/data-api-shared';
import { PrometheusService } from './prometheus.service';

describe('PrometheusService', () => {
  it('exposes the syncer gauges and counters', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    service.checkpointLedger.set(100);
    service.headLedger.set(105);
    service.lagLedgers.set(5);
    service.lastCommitTimestampSeconds.set(1_760_000_000);
    service.validationsFlushedTotal.inc(20);
    service.validationsErrorsTotal.inc({ stage: 'flush' });
    service.validationsErrorsTotal.inc({ stage: 'reporter' }, 2);
    service.validationsDroppedTotal.inc({ reason: 'buffer_full' }, 3);
    service.feeStatsSamplesTotal.inc();
    service.feeStatsErrorsTotal.inc(3);
    service.aggregatorRunsTotal.inc({ job: 'stats' });
    service.aggregatorRunsTotal.inc({ job: 'volume' }, 2);
    service.aggregatorErrorsTotal.inc({ job: 'stats_dirty' }, 4);
    service.aggregatorStatsLagSeconds.set(86_400);

    const text = await service.getMetrics();
    expect(text).toMatch(/^# TYPE syncer_checkpoint_ledger gauge$/m);
    expect(text).toMatch(/^syncer_checkpoint_ledger 100$/m);
    expect(text).toMatch(/^syncer_head_ledger 105$/m);
    expect(text).toMatch(/^syncer_lag_ledgers 5$/m);
    expect(text).toMatch(/^syncer_last_commit_timestamp_seconds 1760000000$/m);
    expect(text).toMatch(/^syncer_validations_flushed_total 20$/m);
    expect(text).toMatch(/^syncer_validations_errors_total\{stage="flush"\} 1$/m);
    expect(text).toMatch(/^syncer_validations_errors_total\{stage="reporter"\} 2$/m);
    expect(text).toMatch(/^syncer_validations_dropped_total\{reason="buffer_full"\} 3$/m);
    expect(text).toMatch(/^syncer_fee_stats_samples_total 1$/m);
    expect(text).toMatch(/^syncer_fee_stats_errors_total 3$/m);
    expect(text).toMatch(/^syncer_aggregator_runs_total\{job="stats"\} 1$/m);
    expect(text).toMatch(/^syncer_aggregator_runs_total\{job="volume"\} 2$/m);
    expect(text).toMatch(/^syncer_aggregator_errors_total\{job="stats_dirty"\} 4$/m);
    expect(text).toMatch(/^# TYPE syncer_aggregator_stats_lag_seconds gauge$/m);
    expect(text).toMatch(/^syncer_aggregator_stats_lag_seconds 86400$/m);
  });

  it('exposes the metrics of the validators worker, by name, type and label set', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    // A labelled metric shows no series until a label set was observed, so each is observed once.
    service.validatorsUnlFetchesTotal.inc({ publisher: 'vl.ripple.com', outcome: 'ok' });
    service.validatorsUnlExpirySeconds.set({ publisher: 'vl.ripple.com' }, 1_209_600);
    service.validatorsUnlSize.set({ publisher: 'vl.ripple.com' }, 35);
    service.validatorsDomainChecksTotal.inc({ outcome: 'verified' });
    service.validatorsNodePollsTotal.inc({ request: 'server_info', outcome: 'ok' });
    service.validatorsJobsTotal.inc({ job: 'rounds', outcome: 'error' });
    service.validatorsAgreementLagSeconds.set(3600);
    service.validatorsRoundsLagLedgers.set(256);
    service.amendmentsWithoutMetadata.set(2);
    service.validatorValidationsFlushedTotal.inc({ table: 'validator_validations' }, 12);

    const text = await service.getMetrics();
    expect(text).toMatch(/^# TYPE syncer_validators_unl_fetches_total counter$/m);
    expect(text).toMatch(/^syncer_validators_unl_fetches_total\{publisher="vl.ripple.com",outcome="ok"\} 1$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_unl_expiry_seconds gauge$/m);
    expect(text).toMatch(/^syncer_validators_unl_expiry_seconds\{publisher="vl.ripple.com"\} 1209600$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_unl_size gauge$/m);
    expect(text).toMatch(/^syncer_validators_unl_size\{publisher="vl.ripple.com"\} 35$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_domain_checks_total counter$/m);
    expect(text).toMatch(/^syncer_validators_domain_checks_total\{outcome="verified"\} 1$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_node_polls_total counter$/m);
    expect(text).toMatch(/^syncer_validators_node_polls_total\{request="server_info",outcome="ok"\} 1$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_jobs_total counter$/m);
    expect(text).toMatch(/^syncer_validators_jobs_total\{job="rounds",outcome="error"\} 1$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_agreement_lag_seconds gauge$/m);
    expect(text).toMatch(/^syncer_validators_agreement_lag_seconds 3600$/m);
    expect(text).toMatch(/^# TYPE syncer_validators_rounds_lag_ledgers gauge$/m);
    expect(text).toMatch(/^syncer_validators_rounds_lag_ledgers 256$/m);
    expect(text).toMatch(/^# TYPE syncer_amendments_without_metadata gauge$/m);
    expect(text).toMatch(/^syncer_amendments_without_metadata 2$/m);
    expect(text).toMatch(/^# TYPE syncer_validator_validations_flushed_total counter$/m);
    expect(text).toMatch(/^syncer_validator_validations_flushed_total\{table="validator_validations"\} 12$/m);
  });

  it('exposes the gauges of the pair_hourly and markets_live jobs, by name, type, label set and help text (spec section 11)', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    service.pairHourlyMissingHours.set(3);
    service.marketsLiveAgeSeconds.set({ period: 'day' }, 75);
    service.marketsLiveAgeSeconds.set({ period: '30day' }, 610);

    const text = await service.getMetrics();
    const pair = 'Hours of the last 31 days without a set of the current config version.';
    const age = 'Now minus the end_time of the newest include set.';
    expect(text).toContain(
      `# HELP syncer_pair_hourly_missing_hours ${pair}\n# TYPE syncer_pair_hourly_missing_hours gauge\n`,
    );
    expect(text).toMatch(/^syncer_pair_hourly_missing_hours 3$/m);
    expect(text).toContain(
      `# HELP syncer_markets_live_age_seconds ${age}\n# TYPE syncer_markets_live_age_seconds gauge\n`,
    );
    expect(text).toMatch(/^syncer_markets_live_age_seconds\{period="day"\} 75$/m);
    expect(text).toMatch(/^syncer_markets_live_age_seconds\{period="30day"\} 610$/m);
    const labels = (name: string): string[] | undefined =>
      (service.registry.getSingleMetric(name) as unknown as { labelNames: string[] } | undefined)?.labelNames;
    expect(labels('syncer_pair_hourly_missing_hours')).toEqual([]);
    expect(labels('syncer_markets_live_age_seconds')).toEqual(['period']);
  });

  it('exposes the gauges of the rates_daily and account_rollups jobs, by name, type, label set and help text (spec section 11)', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    service.ratesDailyMissingDays.set(4);
    service.accountRollupsHeavyAccounts.set(120);
    service.accountRollupsPendingAccounts.set(7);

    const text = await service.getMetrics();
    const declared: [string, string, number][] = [
      [
        'syncer_rates_daily_missing_days',
        'Closed final days without a valid rates set, from the first native trade to the newest final day.',
        4,
      ],
      ['syncer_account_rollups_heavy_accounts', 'Heavy accounts.', 120],
      [
        'syncer_account_rollups_pending_accounts',
        'Heavy accounts whose coverage does not yet reach from first_day to the newest final day.',
        7,
      ],
    ];
    for (const [name, help, value] of declared) {
      expect(text).toContain(`# HELP ${name} ${help}\n# TYPE ${name} gauge\n`);
      expect(text).toMatch(new RegExp(`^${name} ${value}$`, 'm'));
      expect((service.registry.getSingleMetric(name) as unknown as { labelNames: string[] }).labelNames).toEqual([]);
    }
  });

  describe('the declaration of the validators metrics', () => {
    // [name, type, declared label names (exactly), HELP text (spec section 6)]
    const declared: [string, string, string[], string][] = [
      [
        'syncer_validators_unl_fetches_total',
        'counter',
        ['publisher', 'outcome'],
        'Validator list fetches, by publisher and outcome (ok, unchanged, or the reason code of the failure).',
      ],
      [
        'syncer_validators_unl_expiry_seconds',
        'gauge',
        ['publisher'],
        'Seconds until the current validator list of a publisher expires (negative when expired).',
      ],
      ['syncer_validators_unl_size', 'gauge', ['publisher'], 'Validators on the current list of a publisher.'],
      [
        'syncer_validators_domain_checks_total',
        'counter',
        ['outcome'],
        'Domain checks of validators, by outcome (verified, or the reason code of the failure).',
      ],
      [
        'syncer_validators_node_polls_total',
        'counter',
        ['request', 'outcome'],
        'Polls of the node by the validators worker, by request (amendments, negative_unl, fee_settings, server_info, feature) and outcome (ok, error).',
      ],
      [
        'syncer_validators_jobs_total',
        'counter',
        ['job', 'outcome'],
        'Runs of the validators worker jobs, by job (rounds, agreement) and outcome (ok, error).',
      ],
      [
        'syncer_validators_agreement_lag_seconds',
        'gauge',
        [],
        'Now minus the end of the newest final hour of validator agreement, in seconds.',
      ],
      [
        'syncer_validators_rounds_lag_ledgers',
        'gauge',
        [],
        'Newest committed voting ledger minus the newest stored amendment voting round, in ledgers.',
      ],
      [
        'syncer_amendments_without_metadata',
        'gauge',
        [],
        'Amendments seen (node, ledger, votes) without an entry in the amendment metadata.',
      ],
      [
        'syncer_validator_validations_flushed_total',
        'counter',
        ['table'],
        'Rows written to validator_validations and validator_seen, by table.',
      ],
    ];

    it.each(declared)('%s is a %s with the labels %j and its help text', async (name, type, labelNames, help) => {
      const service = new PrometheusService();
      // prom-client types `labelNames` only on the constructor options; the metric object keeps it.
      const metric = service.registry.getSingleMetric(name) as unknown as { labelNames: string[] } | undefined;
      expect(metric?.labelNames).toEqual(labelNames);
      const exposed = (await service.registry.getMetricsAsJSON()).find((m) => m.name === name);
      expect(exposed).toMatchObject({ type, help });
      expect(await service.getMetrics()).toContain(`# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`);
    });
  });

  it('shares one registry between instances, as the main app and the metricz app each create one', async () => {
    const worker = new PrometheusService();
    const scraper = new PrometheusService();
    worker.onModuleInit();
    scraper.onModuleInit(); // must not register the default process metrics twice

    worker.headLedger.set(777);
    expect(await scraper.getMetrics()).toMatch(/^syncer_head_ledger 777$/m);
    expect(scraper.registry).toBe(worker.registry);
  });

  describe('syncer_last_commit_age_seconds', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('is the time since the last commit, computed when scraped', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
      const service = new PrometheusService();
      service.lastCommitTimestampSeconds.set(Date.now() / 1000 - 30);
      expect(await service.getMetrics()).toMatch(/^# TYPE syncer_last_commit_age_seconds gauge$/m);
      expect(await service.getMetrics()).toMatch(/^syncer_last_commit_age_seconds 30$/m);
      jest.advanceTimersByTime(15_000);
      expect(await service.getMetrics()).toMatch(/^syncer_last_commit_age_seconds 45$/m);
    });

    it('is NaN (unknown) before the first commit', async () => {
      const service = new PrometheusService();
      service.lastCommitTimestampSeconds.reset();
      // prom-client writes NaN as `Nan`; Prometheus parses it case-insensitively.
      expect(await service.getMetrics()).toMatch(/^syncer_last_commit_age_seconds nan$/im);
    });
  });

  it('prefixes the default process metrics with syncer_', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    expect(await service.getMetrics()).toMatch(/^syncer_process_cpu_user_seconds_total /m);
  });

  it('counts every pause a rate-limited node asked for, by endpoint host (no credentials, no default port; ruling R98)', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    const endpoint = 'wss://user:secret@syncer-node.example:443/ws';
    try {
      nodeThrottle.pause(endpoint, new Error('rate limit: units quota (50000 per 10s) exhausted, retry in ~5000ms'));
      nodeThrottle.pause(endpoint, new Error('rate limit: retry in ~6000ms')); // the same pause, extended: not counted
      const text = await service.getMetrics();
      expect(text).toMatch(/^# TYPE syncer_node_rate_limited_total counter$/m);
      expect(text).toMatch(/^syncer_node_rate_limited_total\{endpoint="syncer-node.example"\} 1$/m);
      expect(text).not.toContain('secret');
    } finally {
      nodeThrottle.clear();
    }
  });
});

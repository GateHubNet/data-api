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
    service.ammUnclassifiedTotal.inc(3);

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
    expect(text).toMatch(/^# TYPE syncer_amm_unclassified_total counter$/m);
    expect(text).toMatch(/^syncer_amm_unclassified_total 3$/m);
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

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
    service.feeStatsSamplesTotal.inc();
    service.aggregatorRunsTotal.inc({ job: 'stats' });
    service.aggregatorRunsTotal.inc({ job: 'volume' }, 2);

    const text = await service.getMetrics();
    expect(text).toMatch(/^# TYPE syncer_checkpoint_ledger gauge$/m);
    expect(text).toMatch(/^syncer_checkpoint_ledger 100$/m);
    expect(text).toMatch(/^syncer_head_ledger 105$/m);
    expect(text).toMatch(/^syncer_lag_ledgers 5$/m);
    expect(text).toMatch(/^syncer_last_commit_timestamp_seconds 1760000000$/m);
    expect(text).toMatch(/^syncer_validations_flushed_total 20$/m);
    expect(text).toMatch(/^syncer_fee_stats_samples_total 1$/m);
    expect(text).toMatch(/^syncer_aggregator_runs_total\{job="stats"\} 1$/m);
    expect(text).toMatch(/^syncer_aggregator_runs_total\{job="volume"\} 2$/m);
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

  it('prefixes the default process metrics with syncer_', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    expect(await service.getMetrics()).toMatch(/^syncer_process_cpu_user_seconds_total /m);
  });
});

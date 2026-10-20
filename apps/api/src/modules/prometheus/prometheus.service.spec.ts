import { nodeThrottle } from '@gatehub/data-api-shared';
import { PrometheusService } from './prometheus.service';

describe('PrometheusService', () => {
  it('shares one registry between instances, as the main app and the metricz app each build their own', async () => {
    const main = new PrometheusService();
    const scrape = new PrometheusService();
    main.onModuleInit();
    scrape.onModuleInit(); // the default metrics are registered once; a second registration would throw

    main.httpRequests.inc({ method: 'GET', route: '/v2/x', status: '200' });
    expect(scrape.registry).toBe(main.registry);
    expect(await scrape.getMetrics()).toContain('api_http_requests_total{method="GET",route="/v2/x",status="200"} 1');
    expect(await scrape.getMetrics()).toContain('# TYPE api_process_cpu_user_seconds_total counter');
  });

  it('counts the transactions served as stored JSON because they could not be serialized, per mode', async () => {
    const service = new PrometheusService();
    service.txEncodeFallback.inc({ mode: 'json' });
    service.txEncodeFallback.inc({ mode: 'binary' }, 2);
    const metrics = await service.getMetrics();
    expect(metrics).toContain('# TYPE api_tx_encode_fallback_total counter');
    expect(metrics).toContain('api_tx_encode_fallback_total{mode="json"} 1');
    expect(metrics).toContain('api_tx_encode_fallback_total{mode="binary"} 2');
  });

  it('counts the asset-days valued on read because native_rates_daily had no valid set for them', async () => {
    const service = new PrometheusService();
    service.ratesOnReadTotal.inc(3);
    const metrics = await service.getMetrics();
    expect(metrics).toContain(
      '# HELP api_rates_on_read_total Asset-days valued with dailyNativeRates because native_rates_daily had no valid set for the day.',
    );
    expect(metrics).toContain('# TYPE api_rates_on_read_total counter');
    expect(metrics).toContain('api_rates_on_read_total 3');
  });

  it('counts the day-group reads by source, raw and rollup', async () => {
    const service = new PrometheusService();
    service.accountDayGroupsTotal.inc({ source: 'raw' });
    service.accountDayGroupsTotal.inc({ source: 'rollup' }, 2);
    const metrics = await service.getMetrics();
    expect(metrics).toContain('# HELP api_account_day_groups_total Day-group reads by source (raw, rollup).');
    expect(metrics).toContain('# TYPE api_account_day_groups_total counter');
    expect(metrics).toContain('api_account_day_groups_total{source="raw"} 1');
    expect(metrics).toContain('api_account_day_groups_total{source="rollup"} 2');
  });

  it('counts every pause a rate-limited node asked for, by endpoint host (no credentials, no default port; ruling R98)', async () => {
    const service = new PrometheusService();
    service.onModuleInit();
    const endpoint = 'wss://user:secret@api-node.example:443/ws';
    try {
      nodeThrottle.pause(endpoint, new Error('rate limit: units quota (50000 per 10s) exhausted, retry in ~5000ms'));
      nodeThrottle.pause(endpoint, new Error('rate limit: retry in ~6000ms')); // the same pause, extended: not counted
      const text = await service.getMetrics();
      expect(text).toMatch(/^# TYPE api_node_rate_limited_total counter$/m);
      expect(text).toMatch(/^api_node_rate_limited_total\{endpoint="api-node.example"\} 1$/m);
      expect(text).not.toContain('secret');
    } finally {
      nodeThrottle.clear();
    }
  });
});

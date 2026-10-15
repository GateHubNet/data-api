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
});

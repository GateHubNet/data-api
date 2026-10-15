import { CallHandler, ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { lastValueFrom, of } from 'rxjs';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { MetricsInterceptor } from './metrics.interceptor';

function contextFor(req: object, res: object, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('MetricsInterceptor', () => {
  const metrics = new PrometheusService();
  const interceptor = new MetricsInterceptor(metrics);

  async function requests(): Promise<string> {
    return (await metrics.getMetrics())
      .split('\n')
      .filter((line) => line.startsWith('api_http_requests_total{'))
      .join('\n');
  }

  it('records the status the response ends with, labelled by route pattern and not by URL', async () => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const req = { method: 'GET', path: '/v2/ledgers/32570', route: { path: '/v2/ledgers/:id' } };
    const next: CallHandler = { handle: () => of('body') };

    await lastValueFrom(interceptor.intercept(contextFor(req, res), next));
    // Nothing is counted until the response has been written: a filter sets the status of an error after the handler.
    expect(await requests()).not.toContain('/v2/ledgers/:id');

    res.statusCode = 404;
    res.emit('finish');
    expect(await requests()).toContain('api_http_requests_total{method="GET",route="/v2/ledgers/:id",status="404"} 1');
    const duration = await metrics.getMetrics();
    expect(duration).toContain(
      'api_http_request_duration_seconds_count{method="GET",route="/v2/ledgers/:id",status="404"} 1',
    );
  });

  it('leaves non-HTTP contexts alone', async () => {
    const next: CallHandler = { handle: () => of('body') };
    await expect(lastValueFrom(interceptor.intercept(contextFor({}, {}, 'rpc'), next))).resolves.toBe('body');
  });
});

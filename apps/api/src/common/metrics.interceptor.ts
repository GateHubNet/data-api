import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/**
 * Records per-request Prometheus metrics (count + duration histogram), labelled by
 * method, route *pattern* (not raw URL, to avoid label cardinality blow-up) and status.
 * Wired globally so `/metricz` actually reflects HTTP traffic.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: PrometheusService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { route?: { path?: string } }>();
    const res = http.getResponse<Response>();
    const start = process.hrtime.bigint();

    const route = (): string => req.route?.path ?? req.path ?? 'unknown';

    return next.handle().pipe(
      finalize(() => {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        const labels = { method: req.method, route: route(), status: String(res.statusCode) };
        this.metrics.httpRequests.inc(labels);
        this.metrics.httpDuration.observe(labels, seconds);
      }),
    );
  }
}

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/**
 * Records per-request Prometheus metrics (count + duration histogram), labelled by
 * method, route *pattern* (not raw URL, to avoid label cardinality blow-up) and status.
 * Wired globally so `/metricz` actually reflects HTTP traffic.
 *
 * The measurement is taken when the response has been written (`finish`), not when the handler's stream ends: an
 * error is turned into its status by an exception filter only after the stream has failed, so the status read at
 * that point would still be 200.
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

    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = {
        method: req.method,
        route: req.route?.path ?? req.path ?? 'unknown',
        status: String(res.statusCode),
      };
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, seconds);
    });

    return next.handle();
  }
}

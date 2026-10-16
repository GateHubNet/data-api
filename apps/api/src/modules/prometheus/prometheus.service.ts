import { nodeThrottle, ThrottlePause } from '@gatehub/data-api-shared';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * One registry and one set of metrics per process. The toolbox `bootstrap()` runs the Prometheus module as a second
 * Nest app (own DI container, own port) next to the main app, so the interceptor of the main app and the scrape
 * endpoint of the metricz app each get their own `PrometheusService`. They must see the same metrics, so those live
 * here, once.
 */
const registry = new Registry();

const httpRequests = new Counter({
  name: 'api_http_requests_total',
  help: 'Total HTTP requests handled.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: 'api_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const txEncodeFallback = new Counter({
  name: 'api_tx_encode_fallback_total',
  help: 'Transactions served as their stored JSON because the binary codec could not serialize them.',
  labelNames: ['mode'] as const,
  registers: [registry],
});

const nodeRateLimited = new Counter({
  name: 'api_node_rate_limited_total',
  help: 'Pauses a node asked for with a rate-limit answer (nothing is sent to it while one lasts), by endpoint host.',
  labelNames: ['endpoint'] as const,
  registers: [registry],
});

// Every node client of the process shares `nodeThrottle`: each pause it starts is counted here, once.
nodeThrottle.on('pause', (pause: ThrottlePause) => nodeRateLimited.inc({ endpoint: pause.host }));

let defaultMetricsCollected = false;

@Injectable()
export class PrometheusService implements OnModuleInit {
  readonly registry = registry;
  readonly httpRequests = httpRequests;
  readonly httpDuration = httpDuration;
  /** `mode` is `json` or `binary`: the kind of response that fell back. */
  readonly txEncodeFallback = txEncodeFallback;
  /** Pauses that rate-limited nodes asked for, by endpoint host. */
  readonly nodeRateLimited = nodeRateLimited;

  onModuleInit(): void {
    // Registering the same default metrics twice throws, and both apps initialise a service.
    if (defaultMetricsCollected) return;
    defaultMetricsCollected = true;
    collectDefaultMetrics({ register: registry, prefix: 'api_' });
  }

  async getMetrics(): Promise<string> {
    return registry.metrics();
  }
}

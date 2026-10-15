import { Injectable, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

/**
 * Prometheus registry for the syncer. Exposes default process metrics plus a couple
 * of domain metrics the sync loop updates (latest synced ledger, ledgers processed).
 */
@Injectable()
export class PrometheusService implements OnModuleInit {
  readonly registry = new Registry();

  readonly latestSyncedLedger = new Gauge({
    name: 'syncer_latest_synced_ledger',
    help: 'Highest ledger index written to ClickHouse.',
    registers: [this.registry],
  });

  // Monotonic counter (the `_total` suffix is the Prometheus convention for counters).
  readonly ledgersProcessed = new Counter({
    name: 'syncer_ledgers_processed_total',
    help: 'Total ledgers processed since process start.',
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry, prefix: 'syncer_' });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}

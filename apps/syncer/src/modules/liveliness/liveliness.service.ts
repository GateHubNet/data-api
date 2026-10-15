import { ClickHouseService } from '@gatehub/data-api-shared';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthCheckError, HealthCheckService, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { SyncerConfig } from '../../config/syncer.config';
import { INGEST_STATUS, IngestStatusProvider } from './ingest-status';

/** How long the ingest lag may stay above `maxLagHealthy` before the probe fails. */
export const LAG_GRACE_MS = 60_000;

/**
 * Liveliness probe (terminus). Fails (503) when
 * - the ClickHouse ping fails, or
 * - the ingest worker is running (a module provides `INGEST_STATUS`) and its state is `halted`, or its lag has been
 *   above `maxLagHealthy` ledgers on every probe for more than 60 s.
 *
 * The lag is judged across probes: a spike that is gone by the next probe resets the window, and a lag the runner has
 * not measured yet (undefined) counts as healthy.
 */
@Injectable()
export class LivelinessService extends HealthIndicator {
  /** When the lag was first seen above the threshold in the current run of unhealthy probes. */
  private lagSince?: number;

  constructor(
    private readonly health: HealthCheckService,
    private readonly ch: ClickHouseService,
    private readonly config: SyncerConfig,
    @Optional() @Inject(INGEST_STATUS) private readonly ingest?: IngestStatusProvider,
  ) {
    super();
  }

  private async clickhouse(): Promise<HealthIndicatorResult> {
    let ok = false;
    try {
      ok = await this.ch.ping();
    } catch {
      ok = false;
    }
    const result = this.getStatus('clickhouse', ok);
    if (ok) return result;
    throw new HealthCheckError('ClickHouse check failed', result);
  }

  private async ingestStatus(): Promise<HealthIndicatorResult> {
    const { lag, state } = this.ingest!.status();
    const details = { state, lag };

    if (state === 'halted') {
      throw new HealthCheckError('Ingest halted', this.getStatus('ingest', false, { ...details, message: 'halted' }));
    }

    const now = Date.now();
    if (lag !== undefined && lag > this.config.maxLagHealthy) {
      this.lagSince ??= now;
      if (now - this.lagSince > LAG_GRACE_MS) {
        const message = `lag above ${this.config.maxLagHealthy} ledgers for ${Math.round((now - this.lagSince) / 1000)} s`;
        throw new HealthCheckError('Ingest lag too high', this.getStatus('ingest', false, { ...details, message }));
      }
    } else {
      this.lagSince = undefined;
    }
    return this.getStatus('ingest', true, details);
  }

  livelinessCheck() {
    const indicators = [() => this.clickhouse()];
    if (this.ingest) indicators.push(() => this.ingestStatus());
    return this.health.check(indicators);
  }
}

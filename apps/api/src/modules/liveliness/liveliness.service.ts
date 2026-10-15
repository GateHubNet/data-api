import { ClickHouseService } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthCheckService, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';

/** ClickHouse ping health indicator (terminus v10 style). */
@Injectable()
export class LivelinessService extends HealthIndicator {
  constructor(
    private readonly health: HealthCheckService,
    private readonly ch: ClickHouseService,
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

  livelinessCheck() {
    return this.health.check([() => this.clickhouse()]);
  }
}

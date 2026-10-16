import { Module } from '@nestjs/common';
import { AggregatorService } from './aggregator.service';

/**
 * The `aggregator` worker: the `AggregatorService`, which keeps `stats_hourly` (and, with a later task, the volume
 * tables) up to date once a minute. It needs nothing but what the global core module provides (`ClickHouseService`,
 * `PrometheusService`, `ShutdownSignals`), so it imports nothing.
 */
@Module({ providers: [AggregatorService] })
export class AggregatorModule {}

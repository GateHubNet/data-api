import { Module } from '@nestjs/common';
import { FeeStatsPoller } from './fee-stats-poller';

/**
 * The `fee_stats` worker: the `FeeStatsPoller`, which samples the node's fees every 5 s into `fee_stats`. It needs
 * nothing but what the global core module provides (`NODE_CLIENT`, `ClickHouseService`, `PrometheusService`,
 * `ShutdownSignals`), so it imports nothing.
 */
@Module({ providers: [FeeStatsPoller] })
export class FeesModule {}

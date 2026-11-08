import { Module } from '@nestjs/common';
import { TokenHistoryWorker } from './token-history-worker';

/**
 * The `token_history` worker (issuer analytics, spec 4): the `TokenHistoryWorker`, which keeps the live generation of the token history
 * at the head, repairs it after a re-ingest and promotes a finished build. It needs nothing but what the global core module provides
 * (`SyncerConfig`, `NETWORK_PROFILE`, `ClickHouseService`, `PrometheusService`, `ShutdownSignals`), and no node (`NODE_CLIENT_WORKERS`
 * does not list it).
 */
@Module({ providers: [TokenHistoryWorker] })
export class TokenHistoryModule {}

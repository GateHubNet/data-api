import { Module } from '@nestjs/common';
import { ValidationsCollector } from './validations-collector';

/**
 * The `validations` worker: the `ValidationsCollector`, which listens to the validations and manifests streams of
 * `GH_VALIDATION_ENDPOINTS` and writes them to `validations` / `validator_manifests`. It needs nothing but what the
 * global core module provides (`SyncerConfig`, `NETWORK_PROFILE`, `ClickHouseService`, `PrometheusService`,
 * `ShutdownSignals`), so it imports nothing. It makes its own node clients (one per endpoint), not the shared one.
 */
@Module({ providers: [ValidationsCollector] })
export class ValidationsModule {}

import { Module } from '@nestjs/common';
import { SafeFetcher, tomlsUserAgent } from '../validators/safe-fetch';
import { DomainDiscovery } from './domain-discovery';
import { TomlChecker } from './toml-checker';
import { TomlsWorker } from './tomls-worker';
import { TOMLS_SAFE_FETCHER, TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from './tomls.options';

/**
 * The `tomls` worker: the `TomlsWorker` and the `DomainDiscovery` and `TomlChecker` it runs, which read the tomls of the domains
 * accounts name into `domain_tomls`. It needs nothing but what the global core module provides (`SyncerConfig`,
 * `NETWORK_PROFILE`, `ClickHouseService`, `PrometheusService`, `ShutdownSignals`), so it imports nothing, and it does not need the
 * node (`NODE_CLIENT_WORKERS` does not list it). All its outbound HTTP goes through the `SafeFetcher` it provides, one of its own
 * with the user agent of this worker (`tomlsUserAgent()`), apart from the validators worker's.
 */
@Module({
  providers: [
    {
      provide: TOMLS_SAFE_FETCHER,
      useFactory: (options?: TomlsWorkerOptions) => new SafeFetcher(tomlsUserAgent(), options?.fetch),
      inject: [{ token: TOMLS_WORKER_OPTIONS, optional: true }],
    },
    DomainDiscovery,
    TomlChecker,
    TomlsWorker,
  ],
})
export class TomlsModule {}

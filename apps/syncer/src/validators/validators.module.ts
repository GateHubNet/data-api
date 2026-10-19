import { Module } from '@nestjs/common';
import { SAFE_FETCHER, SafeFetcher, validatorsUserAgent } from './safe-fetch';
import { UnlFetcher } from './unl-fetcher';
import { ValidatorsWorker } from './validators-worker';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/**
 * The `validators` worker: the `ValidatorsWorker` and the loops it starts (for now the `UnlFetcher`), which keep the
 * validator lists, and what is derived from them, in ClickHouse. It needs nothing but what the global core module provides
 * (`SyncerConfig`, `NETWORK_PROFILE`, `NODE_CLIENT`, `ClickHouseService`, `PrometheusService`, `ShutdownSignals`), so it
 * imports nothing. All its outbound HTTP goes through the one `SafeFetcher` it provides.
 */
@Module({
  providers: [
    {
      provide: SAFE_FETCHER,
      useFactory: (options?: ValidatorsWorkerOptions) => new SafeFetcher(validatorsUserAgent(), options?.fetch),
      inject: [{ token: VALIDATORS_WORKER_OPTIONS, optional: true }],
    },
    UnlFetcher,
    ValidatorsWorker,
  ],
})
export class ValidatorsModule {}

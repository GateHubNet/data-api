import { loadAmendmentsConfig, NetworkProfile } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { DomainChecker } from './domain-checker';
import { NetworkStatePoller } from './network-state-poller';
import { SAFE_FETCHER, SafeFetcher, validatorsUserAgent } from './safe-fetch';
import { UnlFetcher } from './unl-fetcher';
import { ValidatorsWorker } from './validators-worker';
import { AMENDMENTS_CONFIG, VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

export { AMENDMENTS_CONFIG };

/**
 * The `validators` worker: the `ValidatorsWorker` and the loops it starts (for now the `UnlFetcher`, the `DomainChecker`
 * and the `NetworkStatePoller`), which keep the validator lists, the domains of the validators, the ledger state and the
 * names of the amendments, and what is derived from them, in ClickHouse. It needs nothing but what the global core module
 * provides (`SyncerConfig`, `NETWORK_PROFILE`, `NODE_CLIENT`, `ClickHouseService`, `PrometheusService`,
 * `ShutdownSignals`), so it imports nothing. All its outbound HTTP goes through the one `SafeFetcher` it provides.
 *
 * `AMENDMENTS_CONFIG` is the amendment metadata of the network (`GH_AMENDMENTS_CONFIG`, or the file shipped with the shared
 * package), loaded when the module is built: a file that does not load fails the boot.
 */
@Module({
  providers: [
    {
      provide: SAFE_FETCHER,
      useFactory: (options?: ValidatorsWorkerOptions) => new SafeFetcher(validatorsUserAgent(), options?.fetch),
      inject: [{ token: VALIDATORS_WORKER_OPTIONS, optional: true }],
    },
    {
      provide: AMENDMENTS_CONFIG,
      useFactory: (profile: NetworkProfile, cfg: Pick<SyncerConfig, 'amendmentsConfig'>) =>
        loadAmendmentsConfig(profile, cfg.amendmentsConfig),
      inject: [NETWORK_PROFILE, SyncerConfig],
    },
    UnlFetcher,
    DomainChecker,
    NetworkStatePoller,
    ValidatorsWorker,
  ],
})
export class ValidatorsModule {}

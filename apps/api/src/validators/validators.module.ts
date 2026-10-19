import { loadAmendmentsConfig, NetworkProfile } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { AmendmentsController } from './amendments.controller';
import { AMENDMENTS_CONFIG, AmendmentsService } from './amendments.service';
import { ValidatorDirectoryService } from './validator-directory.service';
import { ValidatorsController } from './validators.controller';

/**
 * `GET /v2/network/validators/summary`, `GET /v2/network/validators`, `GET /v2/network/validators/{key}`,
 * `GET /v2/network/amendments` and `GET /v2/network/amendments/{name}`. The `ValidatorDirectoryService` is the table of every
 * validator that the routes of the validators and of the amendments read, and the `AmendmentsService` the amendments on top of
 * it; both are exported for the routes of a validator.
 *
 * The metadata of the amendments (`AMENDMENTS_CONFIG`) is loaded and checked when the module is built, from
 * `GH_AMENDMENTS_CONFIG` or the file that ships for the network: an invalid file fails the boot, naming the entry.
 */
@Module({
  controllers: [ValidatorsController, AmendmentsController],
  providers: [
    ValidatorDirectoryService,
    AmendmentsService,
    {
      provide: AMENDMENTS_CONFIG,
      inject: [NETWORK_PROFILE, ApiConfig],
      useFactory: (profile: NetworkProfile, config: ApiConfig) =>
        loadAmendmentsConfig(profile, config.amendmentsConfig),
    },
  ],
  exports: [ValidatorDirectoryService, AmendmentsService, AMENDMENTS_CONFIG],
})
export class ValidatorsModule {}

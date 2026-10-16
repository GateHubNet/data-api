import { ClickHouseService, NetworkProfile, RatesService } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { NETWORK_PROFILE } from '../config/api.config';
import { ExchangeRatesController } from './exchange-rates.controller';
import { NormalizeController } from './normalize.controller';

/**
 * `GET /v2/exchange_rates/:base/:counter` and `GET /v2/normalize`. `RatesService` lives in the shared package (the
 * syncer's aggregator uses it too) and is a plain class, so it is built here, for the native currency of the network,
 * and exported for the other endpoints that convert to it (reports, account stats).
 */
@Module({
  controllers: [ExchangeRatesController, NormalizeController],
  providers: [
    {
      provide: RatesService,
      inject: [ClickHouseService, NETWORK_PROFILE],
      useFactory: (ch: ClickHouseService, profile: NetworkProfile) => new RatesService(ch, profile.nativeCurrency),
    },
  ],
  exports: [RatesService],
})
export class RatesModule {}

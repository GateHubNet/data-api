import { ClickHouseService, DailyRates, NetworkProfile, RatesService } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { ExchangeRatesController } from './exchange-rates.controller';
import { NormalizeController } from './normalize.controller';

/**
 * `GET /v2/exchange_rates/:base/:counter` and `GET /v2/normalize`. `RatesService` lives in the shared package (the
 * syncer's aggregator uses it too) and is a plain class, so it is built here, for the native currency of the network,
 * and exported for the other endpoints that convert to it (reports, account stats). `DailyRates` is the same for whole
 * days: it reads the `native_rates_daily` sets and computes the days that have none on read, keeping those for a minute in
 * the `CacheService` and counting them in `api_rates_on_read_total`.
 */
@Module({
  controllers: [ExchangeRatesController, NormalizeController],
  providers: [
    {
      provide: RatesService,
      inject: [ClickHouseService, NETWORK_PROFILE],
      useFactory: (ch: ClickHouseService, profile: NetworkProfile) => new RatesService(ch, profile.nativeCurrency),
    },
    {
      provide: DailyRates,
      inject: [ClickHouseService, RatesService, CacheService, PrometheusService],
      useFactory: (ch: ClickHouseService, rates: RatesService, cache: CacheService, metrics: PrometheusService) =>
        new DailyRates(ch, rates, { cache, onRead: (assetDays) => metrics.ratesOnReadTotal.inc(assetDays) }),
    },
  ],
  exports: [RatesService, DailyRates],
})
export class RatesModule {}

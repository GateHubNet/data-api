import { ClickHouseService, DailyRates, NetworkProfile, RatesService } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { ExchangeRatesController } from './exchange-rates.controller';
import { NormalizeController } from './normalize.controller';

/** The `CacheService` of the rates computed on read, apart from the shared one of the `CommonModule`. */
export const RATES_CACHE = Symbol('RATES_CACHE');

/**
 * `GET /v2/exchange_rates/:base/:counter` and `GET /v2/normalize`. `RatesService` lives in the shared package (the
 * syncer's aggregator uses it too) and is a plain class, so it is built here, for the native currency of the network,
 * and exported for the other endpoints that convert to it (reports, account stats). `DailyRates` is the same for whole
 * days: it reads the `native_rates_daily` sets and computes the days that have none on read, keeping those for a minute in
 * a `CacheService` of its own (`RATES_CACHE`) and counting them in `api_rates_on_read_total`. The cache is its own so that
 * the asset-days of a long report (one entry each) cannot push the answers that shield the node out of the shared one.
 */
@Module({
  controllers: [ExchangeRatesController, NormalizeController],
  providers: [
    {
      provide: RatesService,
      inject: [ClickHouseService, NETWORK_PROFILE],
      useFactory: (ch: ClickHouseService, profile: NetworkProfile) => new RatesService(ch, profile.nativeCurrency),
    },
    { provide: RATES_CACHE, useFactory: (): CacheService => new CacheService() },
    {
      provide: DailyRates,
      inject: [ClickHouseService, RatesService, RATES_CACHE, PrometheusService],
      useFactory: (ch: ClickHouseService, rates: RatesService, cache: CacheService, metrics: PrometheusService) =>
        new DailyRates(ch, rates, { cache, onRead: (assetDays) => metrics.ratesOnReadTotal.inc(assetDays) }),
    },
  ],
  exports: [RatesService, DailyRates],
})
export class RatesModule {}

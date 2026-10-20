import {
  assertValidMarketsConfig,
  ClickHouseService,
  loadMarketsConfig,
  NetworkProfile,
  RatesService,
} from '@gatehub/data-api-shared';
import { Logger, Module } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { AGGREGATOR_OPTIONS, AggregatorOptions, AggregatorService } from './aggregator.service';

/**
 * The options of the aggregator that come from the deployment: the markets config of the network (`GH_MARKETS_CONFIG`, else the
 * bundled `config/markets/<network>.json`), the rates of the network, which the volume jobs and the account and market jobs
 * share (one `RatesService`), and the size from which an account is rolled up (`GH_ACCOUNT_ROLLUP_MIN_ROWS`). A config that is
 * not valid stops the boot with a message that says what is wrong with it, instead of failing every tick.
 */
export function aggregatorOptions(
  ch: ClickHouseService,
  profile: NetworkProfile,
  config: SyncerConfig,
  logger = new Logger('Aggregator'),
): AggregatorOptions {
  const markets = loadMarketsConfig(profile);
  assertValidMarketsConfig(markets, profile.nativeCurrency);
  logger.log(
    `Volume jobs on: ${markets.tradeMarkets.length} trade market(s), ${markets.paymentCurrencies.length} payment currenc(ies) ` +
      `and the native one, markets config version ${markets.version}`,
  );
  const rates = new RatesService(ch, profile.nativeCurrency);
  return { volumes: { rates, markets }, aggregates: { rates, accountRollupMinRows: config.accountRollupMinRows } };
}

/**
 * The `aggregator` worker: the `AggregatorService`, which keeps `stats_hourly`, the volume tables (`volume_live`, `volume_daily`)
 * and the account and market tables (`pair_hourly`, `markets_live`, `native_rates_daily`, the account rollups) up to date
 * once a minute. It needs what the global core module provides (`ClickHouseService`, `PrometheusService`, `ShutdownSignals`,
 * `NETWORK_PROFILE`, `SyncerConfig`), so it imports nothing.
 */
@Module({
  providers: [
    {
      provide: AGGREGATOR_OPTIONS,
      useFactory: (ch: ClickHouseService, profile: NetworkProfile, config: SyncerConfig): AggregatorOptions =>
        aggregatorOptions(ch, profile, config),
      inject: [ClickHouseService, NETWORK_PROFILE, SyncerConfig],
    },
    AggregatorService,
  ],
})
export class AggregatorModule {}

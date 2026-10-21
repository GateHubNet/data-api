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
 * bundled `config/markets/<network>.json`), the rates of the network, which the volume jobs, the value of a pool and the
 * account and market jobs share (one `RatesService`), and the size from which an account is rolled up
 * (`GH_ACCOUNT_ROLLUP_MIN_ROWS`). A config that is not valid stops the boot with a message that says what is wrong with it,
 * instead of failing every tick.
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
  // one service for all: the volume jobs, the value of a pool and the account and market jobs read the same trades
  const rates = new RatesService(ch, profile.nativeCurrency);
  logger.log('AMM pools job on: the current state of every pool, from amm_pool_states');
  logger.log(
    'AMM daily job on: the per-day stats of every pool, from the exchanges, the liquidity and the pool states',
  );
  return {
    volumes: { rates, markets },
    ammPools: { rates },
    ammDaily: { rates },
    aggregates: { rates, accountRollupMinRows: config.accountRollupMinRows },
  };
}

/**
 * The `aggregator` worker: the `AggregatorService`, which keeps `stats_hourly`, the volume tables (`volume_live`,
 * `volume_daily`), `amm_pools` and `amm_daily` (the last one every fifth tick of a minute) and the account and market tables
 * (`pair_hourly`, `markets_live`, `native_rates_daily`, the account rollups) up to date once a minute. It needs what the
 * global core module provides (`ClickHouseService`, `PrometheusService`, `ShutdownSignals`, `NETWORK_PROFILE`,
 * `SyncerConfig`), so it imports nothing.
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

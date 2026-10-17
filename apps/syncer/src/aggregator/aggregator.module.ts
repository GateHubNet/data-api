import {
  assertValidMarketsConfig,
  ClickHouseService,
  loadMarketsConfig,
  NetworkProfile,
  RatesService,
} from '@gatehub/data-api-shared';
import { Logger, Module } from '@nestjs/common';
import { NETWORK_PROFILE } from '../config/syncer.config';
import { AGGREGATOR_OPTIONS, AggregatorOptions, AggregatorService } from './aggregator.service';

/**
 * The options of the aggregator that come from the deployment: the markets config of the network (`GH_MARKETS_CONFIG`, else the
 * bundled `config/markets/<network>.json`) and the rates of the network, which the volume jobs and the value of a pool need. A config that is not
 * valid stops the boot with a message that says what is wrong with it, instead of failing every tick.
 */
export function aggregatorOptions(
  ch: ClickHouseService,
  profile: NetworkProfile,
  logger = new Logger('Aggregator'),
): AggregatorOptions {
  const markets = loadMarketsConfig(profile);
  assertValidMarketsConfig(markets, profile.nativeCurrency);
  logger.log(
    `Volume jobs on: ${markets.tradeMarkets.length} trade market(s), ${markets.paymentCurrencies.length} payment currenc(ies) ` +
      `and the native one, markets config version ${markets.version}`,
  );
  // one service for both: the volume jobs and the value of a pool read the same trades
  const rates = new RatesService(ch, profile.nativeCurrency);
  logger.log('AMM pools job on: the current state of every pool, from amm_pool_states');
  return { volumes: { rates, markets }, ammPools: { rates } };
}

/**
 * The `aggregator` worker: the `AggregatorService`, which keeps `stats_hourly`, the volume tables (`volume_live`,
 * `volume_daily`) and `amm_pools` up to date once a minute. It needs what the global core module provides (`ClickHouseService`,
 * `PrometheusService`, `ShutdownSignals`, `NETWORK_PROFILE`), so it imports nothing.
 */
@Module({
  providers: [
    {
      provide: AGGREGATOR_OPTIONS,
      useFactory: (ch: ClickHouseService, profile: NetworkProfile): AggregatorOptions => aggregatorOptions(ch, profile),
      inject: [ClickHouseService, NETWORK_PROFILE],
    },
    AggregatorService,
  ],
})
export class AggregatorModule {}

import {
  assertValidMarketsConfig,
  ClickHouseService,
  DailyRates,
  loadMarketsConfig,
  NetworkProfile,
  RatesService,
} from '@gatehub/data-api-shared';
import { Logger, Module } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { AGGREGATOR_OPTIONS, AggregatorOptions, AggregatorService } from './aggregator.service';

/**
 * The options of the aggregator that come from the deployment: the markets config of the network (`GH_MARKETS_CONFIG`, else the
 * bundled `config/markets/<network>.json`), the rates of the network, which the volume jobs, the value of a pool, the NFT
 * jobs, the escrows job and the account and market jobs share (one `RatesService`, with the daily rates of the NFT prices over
 * it), and the size from which an account is rolled up (`GH_ACCOUNT_ROLLUP_MIN_ROWS`). A config that is not valid stops the
 * boot with a message that says what is wrong with it, instead of failing every tick.
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
  logger.log('NFT state job on: the state of every NFT and the holdings of the accounts, from nft_events');
  logger.log(
    'NFT collections job on: the supply, holders and volume of every collection, from nfts and the collection events',
  );
  logger.log('Escrows job on: the current state of every escrow and the escrowed total, from object_changes');
  return {
    volumes: { rates, markets },
    ammPools: { rates },
    nfts: { rates, dailyRates: new DailyRates(ch, rates) },
    escrows: { rates, nativeCurrency: profile.nativeCurrency },
    ammDaily: { rates },
    aggregates: { rates, accountRollupMinRows: config.accountRollupMinRows },
  };
}

/**
 * The `aggregator` worker: the `AggregatorService`, which keeps `stats_hourly`, the volume tables (`volume_live`,
 * `volume_daily`), `amm_pools`, `nfts`, `escrows` (and the sentinel of its total), `amm_daily` and `nft_collections` (the last
 * two every fifth tick of a minute) and the account and market tables (`pair_hourly`, `markets_live`, `native_rates_daily`, the
 * account rollups) up to date once a minute. It needs what the global core module provides (`ClickHouseService`,
 * `PrometheusService`, `ShutdownSignals`, `NETWORK_PROFILE`, `SyncerConfig`), so it imports nothing.
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

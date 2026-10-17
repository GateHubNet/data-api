import { Module } from '@nestjs/common';
import { AmmPairController, AmmPoolsController } from './amm-pools.controller';
import { AmmPoolsService } from './amm-pools.service';

/**
 * The AMM data routes under `/v2/amm`: the pools (list, detail, pair, history). The pair form `/pools/:base/:counter`
 * matches any path of two segments after `pools`, so `AmmPairController` has to stay the LAST of `controllers`: Nest
 * registers the routes in this order, and a route such as `/pools/:pool/history` (or the `swaps`, `liquidity` and
 * `governance` of the pool) registered after it would be read as a pair.
 */
@Module({
  controllers: [AmmPoolsController, AmmPairController],
  providers: [AmmPoolsService],
})
export class AmmModule {}

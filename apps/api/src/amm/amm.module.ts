import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AmmEventsController } from './amm-events.controller';
import { AmmEventsService } from './amm-events.service';
import { AmmPairController, AmmPoolsController } from './amm-pools.controller';
import { AmmPoolsService } from './amm-pools.service';

/**
 * The AMM data routes under `/v2/amm`: the pools (list, detail, pair, history) and the events of a pool (swaps, liquidity,
 * governance). The pair form `/pools/:base/:counter` matches any path of two segments after `pools`, so `AmmPairController`
 * has to stay the LAST of `controllers`: Nest registers the routes in this order, and a route such as `/pools/:pool/history`
 * or `/pools/:pool/swaps` registered after it would be read as a pair. The swaps are the pair read of the exchanges, so the
 * module imports `ExchangesModule` for its service.
 */
@Module({
  imports: [ExchangesModule],
  controllers: [AmmPoolsController, AmmEventsController, AmmPairController],
  providers: [AmmPoolsService, AmmEventsService],
})
export class AmmModule {}

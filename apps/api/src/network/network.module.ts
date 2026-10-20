import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { FeeStatsService } from './fee-stats.service';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';
import { VolumeController } from './volume.controller';
import { VolumeService } from './volume.service';

/**
 * `GET /v2/network/fees` and `GET /v2/network/fee_stats`, and `GET /v2/network/exchange_volume` and
 * `GET /v2/network/payment_volume`. The volumes convert to a display currency with the `RatesService` of `RatesModule`.
 * `GET /v2/network/markets` reads the `markets_live` sets and converts the same way.
 */
@Module({
  imports: [RatesModule],
  controllers: [FeesController, VolumeController, MarketsController],
  providers: [FeesService, FeeStatsService, VolumeService, MarketsService],
})
export class NetworkModule {}

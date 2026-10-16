import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { FeeStatsService } from './fee-stats.service';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { VolumeController } from './volume.controller';
import { VolumeService } from './volume.service';

/**
 * `GET /v2/network/fees` and `GET /v2/network/fee_stats`, and `GET /v2/network/exchange_volume` and
 * `GET /v2/network/payment_volume`. The volumes convert to a display currency with the `RatesService` of `RatesModule`.
 */
@Module({
  imports: [RatesModule],
  controllers: [FeesController, VolumeController],
  providers: [FeesService, FeeStatsService, VolumeService],
})
export class NetworkModule {}

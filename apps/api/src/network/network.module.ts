import { Module } from '@nestjs/common';
import { FeeStatsService } from './fee-stats.service';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';

/**
 * `GET /v2/network/fees` and `GET /v2/network/fee_stats`. The volume routes of `/v2/network` join the controllers here.
 */
@Module({
  controllers: [FeesController],
  providers: [FeesService, FeeStatsService],
})
export class NetworkModule {}

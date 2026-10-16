import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/** `GET /v2/stats[/:family[/:metric]]`. */
@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}

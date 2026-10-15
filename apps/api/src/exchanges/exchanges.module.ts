import { Module } from '@nestjs/common';
import { ExchangesController } from './exchanges.controller';
import { ExchangesService } from './exchanges.service';

/** `GET /v2/exchanges/:base/:counter` and, as a GateHub extra, `GET /v2/exchanges` (every pair). */
@Module({
  controllers: [ExchangesController],
  providers: [ExchangesService],
})
export class ExchangesModule {}

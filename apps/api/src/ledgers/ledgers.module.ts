import { Module } from '@nestjs/common';
import { LastValidatedController, LedgersController } from './ledgers.controller';
import { LedgersService } from './ledgers.service';

/** `GET /v2/ledgers[/:ledger_param]` and `GET /v2/last_validated`. */
@Module({
  controllers: [LedgersController, LastValidatedController],
  providers: [LedgersService],
})
export class LedgersModule {}

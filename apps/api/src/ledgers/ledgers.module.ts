import { Module } from '@nestjs/common';
import { LedgersController } from './ledgers.controller';
import { LedgersService } from './ledgers.service';

@Module({
  controllers: [LedgersController],
  providers: [LedgersService],
  exports: [LedgersService],
})
export class LedgersModule {}

import { Module } from '@nestjs/common';
import { ValidationsController } from './validations.controller';
import { ValidationsService } from './validations.service';

/** `GET /v2/ledgers/:ledger_hash/validations[/:pubkey]` and the singular `/v2/ledger/...` alias. */
@Module({
  controllers: [ValidationsController],
  providers: [ValidationsService],
})
export class ValidationsModule {}

import { Module } from '@nestjs/common';
import { ChecksController } from './checks.controller';
import { EscrowsController } from './escrows.controller';
import { LedgerObjectsService } from './ledger-objects.service';
import { ObjectAnswers } from './object-answers';
import { PaymentChannelsController } from './payment-channels.controller';

/**
 * The escrow, check and payment channel routes (spec 5): `/v2/escrows/{id}`, `/v2/checks/{id}` and `/v2/payment_channels/{id}`
 * with their histories here, and the owner and sequence route of an escrow under `/v2/accounts`, served by
 * `AccountEscrowController` of `AccountsModule` through the `ObjectAnswers` this module exports (the answers of the three kinds,
 * built from the `LedgerObjectsService` reads). `FeatureCoverageService`, `LedgerRangeResolver` and the `ClickHouseService` are global.
 */
@Module({
  controllers: [EscrowsController, ChecksController, PaymentChannelsController],
  providers: [LedgerObjectsService, ObjectAnswers],
  exports: [LedgerObjectsService, ObjectAnswers],
})
export class LedgerObjectsModule {}

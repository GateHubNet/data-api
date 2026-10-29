import { Module } from '@nestjs/common';
import { EscrowsController } from './escrows.controller';
import { LedgerObjectsService } from './ledger-objects.service';

/**
 * The escrow, check and payment channel routes (spec 5): `/v2/escrows/{id}` with its history here, and the owner and sequence
 * route of an escrow under `/v2/accounts`, served by `AccountEscrowController` of `AccountsModule` through the
 * `LedgerObjectsService` this module exports. `FeatureCoverageService`, `LedgerRangeResolver` and the `ClickHouseService` are global.
 */
@Module({
  controllers: [EscrowsController],
  providers: [LedgerObjectsService],
  exports: [LedgerObjectsService],
})
export class LedgerObjectsModule {}

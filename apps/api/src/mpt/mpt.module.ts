import { Module } from '@nestjs/common';
import { MptHoldersService } from './mpt-holders.service';
import { MptTokensService } from './mpt-tokens.service';
import { MptTransfersService } from './mpt-transfers.service';
import { MptController } from './mpt.controller';
import { MptService } from './mpt.service';

/**
 * The MPT routes (D9, spec 7): `/v2/mpt`, `/v2/mpt/{issuanceId}`, its holders and its transfers. `kind=mpt` of `/v2/tokens` is served by
 * the `MptTokensService` exported to `TokensModule`, and the holdings of an account by the `MptService` exported to `AccountsModule`.
 * `FeatureCoverageService`, `LedgerRangeResolver` and the `ClickHouseService` are global.
 */
@Module({
  controllers: [MptController],
  providers: [MptService, MptHoldersService, MptTransfersService, MptTokensService],
  exports: [MptService, MptTokensService],
})
export class MptModule {}

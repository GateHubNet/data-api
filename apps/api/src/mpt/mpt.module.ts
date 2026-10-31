import { Module } from '@nestjs/common';
import { MptHoldersService } from './mpt-holders.service';
import { MptTransfersService } from './mpt-transfers.service';
import { MptController } from './mpt.controller';
import { MptService } from './mpt.service';

/**
 * The MPT routes (D9, spec 7): `/v2/mpt`, `/v2/mpt/{issuanceId}`, its holders and its transfers. `FeatureCoverageService`,
 * `LedgerRangeResolver` and the `ClickHouseService` are global.
 */
@Module({
  controllers: [MptController],
  providers: [MptService, MptHoldersService, MptTransfersService],
  exports: [MptService],
})
export class MptModule {}

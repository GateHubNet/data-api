import { Module } from '@nestjs/common';
import { MptController } from './mpt.controller';
import { MptService } from './mpt.service';

/**
 * The MPT routes (D9, spec 7): `/v2/mpt`, `/v2/mpt/{issuanceId}`. `FeatureCoverageService` and the `ClickHouseService` are global.
 */
@Module({
  controllers: [MptController],
  providers: [MptService],
  exports: [MptService],
})
export class MptModule {}

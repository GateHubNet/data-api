import { Module } from '@nestjs/common';
import { ValidatorsModule } from '../validators/validators.module';
import { IssuersController } from './issuers.controller';
import { TokenFlowsController } from './token-flows.controller';
import { TokenHistoryReadsService } from './token-history-reads.service';
import { TokenHistoryService } from './token-history.service';
import { TokenSummaryController } from './token-summary.controller';
import { TokenSupplyController } from './token-supply.controller';

/**
 * The read routes of the token history (issuer analytics, spec 5): the issuer's tokens and a token's summary, supply, flows,
 * distribution and snapshot. `AmendmentsService` (the MPT coverage) comes from `ValidatorsModule`; `ClickHouseService`, `CacheService`, `LedgerRangeResolver` and `FeatureCoverageService` are global.
 */
@Module({
  imports: [ValidatorsModule],
  controllers: [IssuersController, TokenSummaryController, TokenSupplyController, TokenFlowsController],
  providers: [TokenHistoryService, TokenHistoryReadsService],
  exports: [TokenHistoryService],
})
export class TokenHistoryModule {}

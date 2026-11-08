import { Module } from '@nestjs/common';
import { TokenHistoryService } from './token-history.service';

/**
 * The read routes of the token history (issuer analytics, spec 5): the issuer's tokens and a token's summary, supply, flows,
 * distribution and snapshot. `ClickHouseService`, `CacheService`, `LedgerRangeResolver` and `FeatureCoverageService` are global.
 */
@Module({
  providers: [TokenHistoryService],
  exports: [TokenHistoryService],
})
export class TokenHistoryModule {}

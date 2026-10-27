import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { NftsController } from './nfts.controller';
import { NftsService } from './nfts.service';

/**
 * The NFT and URIToken routes under `/v2/nfts` (the detail of an NFT, its history and its open offers). The later routes of
 * the family (the collections, the sales, an account's NFTs) join this module; the controllers are listed in the order their
 * routes need (a literal sub-route before the form that would read it as a parameter, pinned by `nft.module.spec.ts` when
 * the first such route comes). The module imports `RatesModule` for `DailyRates`, which converts the price of a sale to the
 * native currency (`convertedSalePrices`); `FeatureCoverageService` is global.
 */
@Module({
  imports: [RatesModule],
  controllers: [NftsController],
  providers: [NftsService],
})
export class NftModule {}

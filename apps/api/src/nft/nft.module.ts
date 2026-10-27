import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { NftCollectionListsController, NftCollectionsController } from './nft-collections.controller';
import { NftCollectionsService } from './nft-collections.service';
import { NftsController } from './nfts.controller';
import { NftsService } from './nfts.service';

/**
 * The NFT and URIToken routes: `/v2/nfts` (the detail of an NFT, its history and its open offers) and `/v2/nft_collections` (the
 * list, one collection, and a collection's NFTs, holders, sales and daily stats). The later routes of the family (the sales of the
 * network, an account's NFTs) join this module; the controllers are listed in the order their routes need: a literal sub-route
 * before the form that would read it as a parameter. `NftCollectionListsController` (every `…/nfts`, `…/holders`, `…/sales` and
 * `…/stats`, on both key forms) is registered before `NftCollectionsController` (`/{issuer}` and `/{issuer}/{taxon}`), which
 * would take `/{issuer}/nfts` for the collection of the taxon `nfts`; `nft.module.spec.ts` pins it. The module imports `RatesModule`
 * for `DailyRates`, which converts the price of a sale to the native currency (`convertedSalePrices`, `nftSalesNativeSql`);
 * `FeatureCoverageService` and `CacheService` are global.
 */
@Module({
  imports: [RatesModule],
  controllers: [NftsController, NftCollectionListsController, NftCollectionsController],
  providers: [NftsService, NftCollectionsService],
})
export class NftModule {}

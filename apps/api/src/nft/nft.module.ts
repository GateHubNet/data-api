import { Module } from '@nestjs/common';
import { RatesModule } from '../exchanges/rates.module';
import { NftAccountsService } from './nft-accounts.service';
import { NftCollectionListsController, NftCollectionsController } from './nft-collections.controller';
import { NftCollectionsService } from './nft-collections.service';
import { NftSalesController } from './nft-sales.controller';
import { NftSalesService } from './nft-sales.service';
import { NftsController } from './nfts.controller';
import { NftsService } from './nfts.service';

/**
 * The NFT and URIToken routes: `/v2/nfts` (the detail of an NFT, its history and its open offers), `/v2/nft_collections` (the
 * list, one collection, and a collection's NFTs, holders, sales and daily stats) and `/v2/nft_sales` (the sales of the network).
 * An account's NFTs and NFT history are routes under `/v2/accounts`, served by `AccountNftsController` of `AccountsModule`
 * through `NftAccountsService`, which this module exports. The controllers are listed in the order their routes need: a literal
 * sub-route before the form that would read it as a parameter. `NftCollectionListsController` (every `…/nfts`, `…/holders`,
 * `…/sales` and `…/stats`, on both key forms) is registered before `NftCollectionsController` (`/{issuer}` and
 * `/{issuer}/{taxon}`), which would take `/{issuer}/nfts` for the collection of the taxon `nfts`; `nft.module.spec.ts` pins it.
 * The module imports `RatesModule` for `DailyRates`, which converts the price of a sale to the native currency
 * (`convertedSalePrices`, `nftSalesNativeSql`); `FeatureCoverageService` and `CacheService` are global.
 */
@Module({
  imports: [RatesModule],
  controllers: [NftsController, NftCollectionListsController, NftCollectionsController, NftSalesController],
  providers: [NftsService, NftCollectionsService, NftSalesService, NftAccountsService],
  exports: [NftAccountsService],
})
export class NftModule {}

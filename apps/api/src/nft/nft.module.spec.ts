import { NftAccountsService } from './nft-accounts.service';
import { NftCollectionListsController, NftCollectionsController } from './nft-collections.controller';
import { NftSalesController } from './nft-sales.controller';
import { NftModule } from './nft.module';
import { NftsController } from './nfts.controller';

describe('NftModule', () => {
  // Express matches routes in the order they are registered, and Nest registers the controllers of a module in the order of
  // `controllers`. `/v2/nft_collections/:issuer/:taxon` (the XRPL form of a collection) matches every path of two segments
  // after `nft_collections`, so `/v2/nft_collections/rIssuer/nfts` (the lists of a collection on Xahau) registered after it would
  // be read as the collection of the taxon `nfts`.
  it('registers the lists of a collection before the taxon form', () => {
    const controllers = Reflect.getMetadata('controllers', NftModule) as unknown[];
    expect(controllers).toContain(NftCollectionListsController);
    expect(controllers).toContain(NftCollectionsController);
    expect(controllers.indexOf(NftCollectionListsController)).toBeLessThan(
      controllers.indexOf(NftCollectionsController),
    );
    expect(controllers.filter((c) => c === NftCollectionsController)).toHaveLength(1);
  });

  it('registers the NFT routes too, and the sales of the network', () => {
    expect(Reflect.getMetadata('controllers', NftModule)).toContain(NftsController);
    expect(Reflect.getMetadata('controllers', NftModule)).toContain(NftSalesController);
  });

  // the routes of an account are a controller of `AccountsModule`, which reads through this module's service
  it('provides and exports the NFT service of the accounts', () => {
    expect(Reflect.getMetadata('providers', NftModule)).toContain(NftAccountsService);
    expect(Reflect.getMetadata('exports', NftModule)).toEqual([NftAccountsService]);
  });
});

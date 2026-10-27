import { NetworkProfile } from '@gatehub/data-api-shared';
import { applyDecorators, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, first, ledgerDates, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { NftCollectionsService } from './nft-collections.service';
import {
  COLLECTION_CSV_COLUMNS,
  COLLECTION_DAY_KEYS,
  CollectionBody,
  CollectionsBody,
  HoldersBody,
  NFT_CSV_COLUMNS,
  NFT_SALE_KEYS,
  NftsBody,
  SalesBody,
  StatsBody,
  toCsvRow,
} from './nft-objects';
import {
  COLLECTION_SORTS,
  collectionDescendingParam,
  collectionKeyParam,
  collectionSortParam,
  issuerParam,
  statsWindowParam,
} from './nft-params';

/**
 * The name of the CSV file of a list of a collection: `<issuer>[ <taxon>] - <list>`. `@Csv` adds the `.csv`. The names are those
 * of the path, as the request wrote them.
 */
const filenameOf =
  (list: string) =>
  (req: Request): string =>
    `${String(req.params.issuer)}${req.params.taxon === undefined ? '' : ` ${String(req.params.taxon)}`} - ${list}`;

/** The two forms of the path of a collection (spec 5.8): XRPL's has a taxon, Xahau's has none. */
const forms = (tail: string): string[] => [`:issuer${tail}`, `:issuer/:taxon${tail}`];

/** The documentation of the two parameters of the path of a collection. */
const CollectionPath = (): MethodDecorator =>
  applyDecorators(
    ApiParam({ name: 'issuer', description: 'The address of the issuer of the collection.' }),
    ApiParam({
      name: 'taxon',
      required: false,
      description: 'The taxon of the collection, on XRPL (`/{issuer}/{taxon}`); Xahau has none (`/{issuer}`).',
    }),
  ) as MethodDecorator;

/**
 * The lists of one collection (GateHub extras, no Ripple original): its NFTs, holders, sales and daily stats, each on both key
 * forms (`/{issuer}/{taxon}/…` on XRPL, `/{issuer}/…` on Xahau; the other network's form is a 404 `collection not found`). This
 * controller is registered BEFORE `NftCollectionsController` (`nft.module.spec.ts` pins it): `/v2/nft_collections/{issuer}/nfts`
 * would otherwise be read by `/{issuer}/{taxon}` as a collection of the taxon `nfts` (a 400 `invalid taxon` on XRPL).
 *
 * The checks come in the order of the parameters: the issuer and the taxon, the others of the route, the marker, then the
 * collection (404 `collection not found`: none, the other network's form, or younger than the last run of the collections job).
 * Every answer states `coverage`, the key after `result`, which is the feature's own (spec section 4).
 */
@RippleController('v2/nft_collections')
export class NftCollectionListsController {
  constructor(
    private readonly collections: NftCollectionsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(forms('/nfts'))
  @RippleRoute('unable to retrieve nfts')
  @CollectionPath()
  @Csv(filenameOf('nfts'), 'nfts')
  @ApiOperation({
    summary: 'Get the NFTs of a collection',
    description:
      'The NFTs of the collection by serial (on Xahau, by id), as the aggregate keeps them: each with its owner and since when, ' +
      'its mint, its sales (`sale_count`, the newest as `last_sale`: a list has no `converted_amount` for it, the NFT has) and ' +
      'its URI. Burned NFTs are left out unless `include_burned=true`. With `owner` the NFTs that account holds. ' +
      '`format=csv` gives the NFTs as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'owner', required: false, description: 'Only the NFTs of the collection this account holds.' })
  @ApiQuery({ name: 'include_burned', required: false, type: Boolean, description: 'Also the NFTs that were burned.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async nfts(
    @Param('issuer') issuerRaw: string,
    @Param('taxon') taxonRaw: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NftsBody> {
    const key = collectionKeyParam(this.profile.family, issuerRaw, taxonRaw);
    const owner = first(query, 'owner');
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.collections.nfts(key, {
      ...(owner !== undefined && owner !== '' && { owner }),
      includeBurned: bool(query, 'include_burned'),
      limit,
      marker: first(query, 'marker'),
    });
    if (found === undefined) throw notFound('collection not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.nfts.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      nfts: wantsCsv(query) ? found.nfts.map((nft) => toCsvRow(nft, NFT_CSV_COLUMNS)) : found.nfts,
    };
  }

  @Get(forms('/holders'))
  @RippleRoute('unable to retrieve holders')
  @CollectionPath()
  @Csv(filenameOf('holders'), 'holders')
  @ApiOperation({
    summary: 'Get the holders of a collection',
    description:
      'The accounts that hold NFTs of the collection and how many (`held`), the most first, then by address, as of the last run ' +
      'of the collections job. `format=csv` gives the holders as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async holdersOf(
    @Param('issuer') issuerRaw: string,
    @Param('taxon') taxonRaw: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HoldersBody> {
    const key = collectionKeyParam(this.profile.family, issuerRaw, taxonRaw);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.collections.holders(key, { limit, marker: first(query, 'marker') });
    if (found === undefined) throw notFound('collection not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.holders.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      holders: found.holders,
    };
  }

  @Get(forms('/sales'))
  @RippleRoute('unable to retrieve sales')
  @CollectionPath()
  @Csv(filenameOf('sales'), 'sales')
  @ApiOperation({
    summary: 'Get the sales of a collection',
    description:
      "The sales of the collection's NFTs in the ledgers that closed between `start` and `end`, oldest first, or newest first " +
      'with `descending=true`: the seller and buyer, whether it was `direct` or `brokered`, the price and `converted_amount`, ' +
      'the price in the native currency where the asset has a rate. `format=csv` gives the sales as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async sales(
    @Param('issuer') issuerRaw: string,
    @Param('taxon') taxonRaw: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesBody> {
    const key = collectionKeyParam(this.profile.family, issuerRaw, taxonRaw);
    const window = ledgerDates(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.collections.sales(key, {
      ...window,
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    if (found === undefined) throw notFound('collection not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.sales.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      sales: wantsCsv(query) ? found.sales.map((sale) => toCsvRow(sale, NFT_SALE_KEYS)) : found.sales,
    };
  }

  @Get(forms('/stats'))
  @RippleRoute('unable to retrieve stats')
  @CollectionPath()
  @Csv(filenameOf('stats'), 'days')
  @ApiOperation({
    summary: 'Get the daily stats of a collection',
    description:
      'One row for each UTC day of the window on which the collection had a sale, a mint or a burn (a day without a row had no ' +
      'activity): `sales_count`, `volume_native`, `avg_price_native` and `min_price_native` (in the native currency, over the ' +
      'sales with a price in it: a sale of an asset with no rate that day counts in `sales_count` only, and a day of none has ' +
      'neither price), `mints` and `burns`. `start` is required and the window is at most 366 days. `format=csv` gives the days ' +
      'as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'start', required: true, description: 'Start time.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: now.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async stats(
    @Param('issuer') issuerRaw: string,
    @Param('taxon') taxonRaw: string | undefined,
    @Query() query: QueryParams,
  ): Promise<StatsBody> {
    const key = collectionKeyParam(this.profile.family, issuerRaw, taxonRaw);
    const window = statsWindowParam(query);
    const found = await this.collections.stats(key, { ...window, descending: bool(query, 'descending') });
    if (found === undefined) throw notFound('collection not found');
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.days.length,
      days: wantsCsv(query) ? found.days.map((day) => toCsvRow(day, COLLECTION_DAY_KEYS)) : found.days,
    };
  }
}

/**
 * The list of collections, and one collection by its key: `/{issuer}/{taxon}` on XRPL, `/{issuer}` on Xahau (spec 5.7 and 5.8).
 * Registered after `NftCollectionListsController`: its `/{issuer}/{taxon}` reads every path of two segments.
 */
@RippleController('v2/nft_collections')
export class NftCollectionsController {
  constructor(
    private readonly collections: NftCollectionsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve collections')
  @Csv('nft collections', 'collections')
  @ApiOperation({
    summary: 'Get the NFT collections',
    description:
      'The collections in their current state, the biggest first by `sort` (`volume` of their sales in the native currency by ' +
      'default, `supply` or `holders`; the ties by issuer, then taxon). A collection is ' +
      '`{issuer, taxon?, kind, supply, holders, minted, burned, sales_count, volume_native, first_mint?, last_mint?, last_ledger}`, ' +
      'updated by the collections job some minutes after its NFTs change; `volume_native` is the sum of the prices of the sales ' +
      'that have one in the native currency, as of that run. `total` is how many collections the filter matches. The answer is ' +
      'kept 60 seconds. `format=csv` gives the collections as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'issuer', required: false, description: 'Only the collections of this issuer.' })
  @ApiQuery({ name: 'sort', required: false, enum: [...COLLECTION_SORTS], description: 'Default: volume.' })
  @ApiQuery({
    name: 'descending',
    required: false,
    type: Boolean,
    description: 'Default true; `false` for the smallest first.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CollectionsBody> {
    // the checks come in the order of the params: the issuer, the sort, then the limit (it has no error) and the marker (the service)
    const issuer = first(query, 'issuer');
    const filter = issuer === undefined || issuer === '' ? undefined : issuerParam(issuer);
    const sort = collectionSortParam(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.collections.list({
      ...(filter !== undefined && { issuer: filter }),
      sort,
      descending: collectionDescendingParam(query),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      total: found.total,
      count: found.collections.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      collections: wantsCsv(query)
        ? found.collections.map((collection) => toCsvRow(collection, COLLECTION_CSV_COLUMNS))
        : found.collections,
    };
  }

  @Get(forms(''))
  @RippleRoute('unable to retrieve collection')
  @CollectionPath()
  @ApiOperation({
    summary: 'Get an NFT collection',
    description:
      'The collection of an issuer and a taxon on XRPL (`/{issuer}/{taxon}`), of an issuer on Xahau (`/{issuer}`), as the list ' +
      "has it. 404 `collection not found` for none, for the other network's form, and for a collection whose NFTs the " +
      'collections job has not counted yet (some minutes).',
  })
  async detail(
    @Param('issuer') issuerRaw: string,
    @Param('taxon') taxonRaw: string | undefined,
  ): Promise<CollectionBody> {
    const key = collectionKeyParam(this.profile.family, issuerRaw, taxonRaw);
    const found = await this.collections.detail(key);
    if (found === undefined) throw notFound('collection not found');
    return { result: 'success', coverage: found.coverage, collection: found.collection };
  }
}

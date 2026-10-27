import { NFT_EVENTS } from '@gatehub/data-api-shared';
import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { ledgerDates } from '../amm/amm-params';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NftBody, NftEventsBody, NftOffersBody, toNftEventCsvRow } from './nft-objects';
import { eventsParam, nftIdParam, OFFER_TYPES, offerTypeParam } from './nft-params';
import { NftsService } from './nfts.service';

/** The name of the CSV file of the history of an NFT: `<nft_id> - nft history`. `@Csv` adds the `.csv`. */
const historyFilename = (req: Request): string => `${String(req.params.nft_id).toUpperCase()} - nft history`;

/**
 * The routes of one NFT or URIToken (GateHub extras, no Ripple original): its detail, its history and its open offers. The
 * id is 64 hex digits in any case; 400 `invalid nft id` otherwise, and 404 `nft not found` for an id with no event in a
 * committed ledger (an XRPL id on Xahau and a URIToken id on XRPL are such ids). `coverage`, the key after `result`, is the
 * NFT's own: complete when its mint is indexed (spec section 4).
 */
@RippleController('v2/nfts')
export class NftsController {
  constructor(private readonly nfts: NftsService) {}

  @Get(':nft_id')
  @RippleRoute('unable to retrieve nft')
  @ApiOperation({
    summary: 'Get an NFT or URIToken',
    description:
      'The NFT folded from its indexed events: its owner and since when, its mint and burn, its URI, its sales (`sale_count`, ' +
      'the newest as `last_sale` with `converted_amount`, its price in the native currency where the asset has a rate) and ' +
      'the fields of its id (`taxon`, `serial` and `transfer_fee` on XRPL only). `owner` is absent for a burned NFT and when ' +
      'no indexed event names one; `minted` is absent when its mint is not indexed (`coverage.complete` says whether the ' +
      'history of this NFT is whole).',
  })
  @ApiParam({ name: 'nft_id', description: 'The 64 hex digits of the NFT or URIToken id, in any case.' })
  async detail(@Param('nft_id') nftIdRaw: string): Promise<NftBody> {
    const id = nftIdParam(nftIdRaw);
    const found = await this.nfts.detail(id);
    if (found === undefined) throw notFound('nft not found');
    return { result: 'success', coverage: found.coverage, nft: found.nft };
  }

  @Get(':nft_id/history')
  @RippleRoute('unable to retrieve nft history')
  @Csv(historyFilename, 'events')
  @ApiOperation({
    summary: 'Get the history of an NFT or URIToken',
    description:
      'The events of the NFT in the ledgers that closed between `start` and `end` (mint, burn, modify, offers created, ' +
      'cancelled and removed, sales, transfers), oldest first, or newest first with `descending=true`. A sale carries ' +
      '`converted_amount`, its price in the native currency where the asset has a rate. `event` is a comma list that keeps ' +
      'the events of those kinds. `format=csv` gives the events as a CSV file (without `coverage`).',
  })
  @ApiParam({ name: 'nft_id', description: 'The 64 hex digits of the NFT or URIToken id, in any case.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'event',
    required: false,
    description: `A comma list of ${NFT_EVENTS.join(', ')}. Default: all.`,
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async history(
    @Param('nft_id') nftIdRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NftEventsBody> {
    // the checks come in the order of the params: the id, start, end, event, then the limit (it has no error) and the
    // marker (the service)
    const id = nftIdParam(nftIdRaw);
    const window = ledgerDates(query);
    const events = eventsParam(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.nfts.history(id, {
      ...window,
      ...(events !== undefined && { events }),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    if (found === undefined) throw notFound('nft not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.events.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      events: wantsCsv(query) ? found.events.map(toNftEventCsvRow) : found.events,
    };
  }

  @Get(':nft_id/offers')
  @RippleRoute('unable to retrieve offers')
  @ApiOperation({
    summary: 'Get the open offers of an NFT or URIToken',
    description:
      'The offers made for the NFT that no later event has cancelled, removed or accepted, newest first, worked out from its ' +
      "offer events. An expired offer is listed until it is removed. A URIToken has at most one, the entry's. `type` keeps " +
      'the offers that sell the NFT (`sell`) or those that bid for it (`buy`).',
  })
  @ApiParam({ name: 'nft_id', description: 'The 64 hex digits of the NFT or URIToken id, in any case.' })
  @ApiQuery({ name: 'type', required: false, enum: [...OFFER_TYPES], description: 'Only the sell or the buy offers.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  async offers(
    @Param('nft_id') nftIdRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NftOffersBody> {
    // the checks come in the order of the params: the id, type, then the limit (it has no error) and the marker (the service)
    const id = nftIdParam(nftIdRaw);
    const type = offerTypeParam(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.nfts.offers(id, {
      ...(type !== undefined && { type }),
      limit,
      marker: first(query, 'marker'),
    });
    if (found === undefined) throw notFound('nft not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.offers.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      offers: found.offers,
    };
  }
}

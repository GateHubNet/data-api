import { NFT_EVENTS, NFT_ROLES } from '@gatehub/data-api-shared';
import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, ledgerDates, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NftAccountsService } from '../nft/nft-accounts.service';
import { NFT_CSV_COLUMNS, NftEventsBody, NftsBody, toCsvRow, toNftEventCsvRow } from '../nft/nft-objects';
import { eventsParam, holdingsCollectionParam, rolesParam } from '../nft/nft-params';

/** The name of the CSV file of the NFTs of an account: `<address> - nfts`. `@Csv` adds the `.csv`. */
const nftsFilename = (req: Request): string => `${String(req.params.address)} - nfts`;

/** The name of the CSV file of the NFT history of an account: `<address> - nft history`. */
const historyFilename = (req: Request): string => `${String(req.params.address)} - nft history`;

/**
 * The NFT routes under an account (GateHub extras, no Ripple original): the NFTs and URITokens it holds, and its history of them.
 * As on the other routes under an account, the address is not checked: one that is none simply holds nothing and has no
 * events. `coverage`, the key after `result`, is the feature's own (spec section 4).
 */
@RippleController('v2/accounts')
export class AccountNftsController {
  constructor(private readonly nfts: NftAccountsService) {}

  @Get(':address/nfts')
  @RippleRoute('unable to retrieve nfts')
  @Csv(nftsFilename, 'nfts')
  @ApiOperation({
    summary: 'Get the NFTs an account holds',
    description:
      'The NFTs and URITokens the account holds now, grouped by collection (issuer, then taxon) and then by serial (on Xahau ' +
      'by id): each as `GET /v2/nfts/{nft_id}` gives it, except that `last_sale` has no `converted_amount` in a list. An NFT ' +
      'the account sold or gave away, and a burned one, are not listed. `issuer` keeps the NFTs of that issuer, and with ' +
      '`taxon` those of one collection (a `taxon` without an `issuer` is a 400). `format=csv` gives the NFTs as a CSV file ' +
      '(without `coverage`).',
  })
  @ApiParam({ name: 'address', description: 'The address of the holder.' })
  @ApiQuery({ name: 'issuer', required: false, description: 'Only the NFTs of this issuer.' })
  @ApiQuery({
    name: 'taxon',
    required: false,
    description: 'Only the NFTs of this taxon of the issuer. Needs `issuer`.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async holdings(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NftsBody> {
    // the checks come in the order of the params: the issuer, the taxon, then the limit (it has no error) and the marker (the service)
    const collection = holdingsCollectionParam(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.nfts.holdings(address, { ...collection, limit, marker: first(query, 'marker') });
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.nfts.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      nfts: wantsCsv(query) ? found.nfts.map((nft) => toCsvRow(nft, NFT_CSV_COLUMNS)) : found.nfts,
    };
  }

  @Get(':address/nft_history')
  @RippleRoute('unable to retrieve nft history')
  @Csv(historyFilename, 'events')
  @ApiOperation({
    summary: 'Get the NFT history of an account',
    description:
      'The events of NFTs and URITokens in which the account has a role, in the ledgers that closed between `start` and ' +
      '`end`, oldest first, or newest first with `descending=true`: each as `GET /v2/nfts/{nft_id}/history` gives it, with ' +
      '`account` the account that did it. An event is listed once, whatever number of roles the account has in it. A ' +
      '`modify` names no account, so it is in no account history. `event` keeps the events of those kinds, `role` those in ' +
      'which the account is any of the roles named (the issuer of a mint, burn or sale, the minter when it is not the ' +
      'issuer, the owner before or after, the broker, the owner of an offer, the destination of an offer). `format=csv` ' +
      'gives the events as a CSV file (without `coverage`).',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'event',
    required: false,
    description:
      `A comma list of ${NFT_EVENTS.join(', ')}. Default: all. ` +
      '`modify` is accepted and always gives nothing here: a modify names no account.',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    description: `A comma list of ${NFT_ROLES.join(', ')}. Default: any role.`,
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async history(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NftEventsBody> {
    // the checks come in the order of the params: start, end, event, role, then the limit (it has no error) and the marker
    const window = ledgerDates(query);
    const events = eventsParam(query);
    const roles = rolesParam(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.nfts.history(address, {
      ...window,
      ...(events !== undefined && { events }),
      ...(roles !== undefined && { roles }),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.events.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      events: wantsCsv(query) ? found.events.map(toNftEventCsvRow) : found.events,
    };
  }
}

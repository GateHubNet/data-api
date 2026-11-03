import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, ledgerDates, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { NFT_SALE_KEYS, SalesBody, toCsvRow } from './nft-objects';
import { checkSaleCurrencyIssuer, saleAssetParam, saleCurrencyParam } from './nft-params';
import { NftSalesService } from './nft-sales.service';

/**
 * `GET /v2/nft_sales` (GateHub extra, no Ripple original): the sales of NFTs and URITokens on the network, in the ledgers that
 * closed between `start` and `end`. `currency` keeps the sales priced in one currency, in the form of `/v2/payments/{currency}`.
 * The checks come in the order of that route and of the spec's common checks: the issuer of `currency` (400 `invalid issuer
 * address`), `start`, `end`, the rest of `currency` (`parseAsset`: `XRP cannot have an issuer`, `issuer is required`, ...), then
 * the marker. `coverage`, the key after `result`, is the feature's own (spec section 4).
 */
@RippleController('v2/nft_sales')
export class NftSalesController {
  constructor(
    private readonly sales: NftSalesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve sales')
  @Csv('nft sales', 'sales')
  @ApiOperation({
    summary: 'Get the NFT sales of the network',
    description:
      'The sales of NFTs (XRPL) and URITokens (Xahau) in the ledgers that closed between `start` and `end`, oldest first, or ' +
      'newest first with `descending=true`: each with the seller and buyer, whether it was `direct` or `brokered` (with the ' +
      '`broker`, its `broker_fee` and the estimated `royalty_est`), the price, and `converted_amount`, the price in the native ' +
      'currency where the asset has a rate that day (a sale in an asset with no rate has none). `currency` keeps the sales ' +
      'priced in one currency: the native currency alone, or `CUR+issuer` (a space for the `+` is read as one). ' +
      '`format=csv` gives the sales as a CSV file (without `coverage`).',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'Only the sales priced in this currency: the native currency, or `CUR+issuer`. Default: all.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesBody> {
    // the checks come in the order of `/v2/payments/{currency}`: the issuer, start, end, the rest of the currency, then the
    // limit (it has no error) and the marker (the service)
    const currency = saleCurrencyParam(query);
    checkSaleCurrencyIssuer(currency);
    const window = ledgerDates(query);
    const asset = saleAssetParam(currency, this.profile.nativeCurrency);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found = await this.sales.list({
      ...window,
      ...(asset !== undefined && { asset }),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      count: found.sales.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      sales: wantsCsv(query) ? found.sales.map((sale) => toCsvRow(sale, NFT_SALE_KEYS)) : found.sales,
    };
  }
}

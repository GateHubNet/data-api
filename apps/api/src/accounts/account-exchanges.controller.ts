import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { parseAssetFilter, splitAsset } from '../common/asset-param';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { ammFilter, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { AccountCsvRow, AccountExchangeObject, toAccountCsvRows } from './account-exchange-object';
import { AccountExchangesService } from './account-exchanges.service';
import { accountWindow } from './account-window';

interface AccountExchangesBody {
  result: 'success';
  count: number;
  marker?: string;
  exchanges: AccountExchangeObject[] | AccountCsvRow[];
}

/**
 * The name of the CSV file, as `accountExchanges.js` has it: `<address> - exchanges`, then ` - <base>-<counter>` of the
 * path, or ` - <base>` alone. `@Csv` adds the `.csv`.
 */
function csvFilename(req: Request): string {
  const base = splitAsset(req.params.base ?? '').currency;
  const counter = splitAsset(req.params.counter ?? '').currency;
  const pair = base && counter ? ` - ${base}-${counter}` : base ? ` - ${base}` : counter ? ` - ${counter}` : '';
  return `${req.params.address} - exchanges${pair}`;
}

/**
 * `GET /v2/accounts/:address/exchanges[/:base[/:counter]]` (`api/routes/accountExchanges.js`).
 *
 * The address is not checked, as in the original: one that is none simply has no exchanges. `base` and `counter` are
 * filters, not a pair to be complete: `USD` is the dollars of any issuer, `USD+rvYAf…/XRP` one pair. They work in either
 * orientation (see `AccountExchangesService`).
 */
@RippleController('v2/accounts')
export class AccountExchangesController {
  constructor(private readonly exchanges: AccountExchangesService) {}

  @Get([':address/exchanges', ':address/exchanges/:base', ':address/exchanges/:base/:counter'])
  @RippleRoute('unable to retrieve exchanges')
  @Csv(csvFilename, 'exchanges')
  @ApiOperation({
    summary: 'Get the exchanges of an account',
    description:
      'The trades the account took part in, as buyer or as seller, in the ledgers that closed between `start` and ' +
      '`end`, oldest first. Each is the exchange `GET /v2/exchanges` serves, plus the `client` when there is one. With ' +
      '`base`, only the trades of that asset, and with `counter` only against that asset, in whichever order the pair ' +
      'is stored: a trade stored the other way round is inverted (base and counter, buyer and seller swap, the rate ' +
      'is 1/rate). A swap against an AMM pool is an exchange too: it has `amm_account` as its last key, and `amm` ' +
      'lists it (`include`, the default), leaves it out (`exclude`) or lists only the swaps (`only`). ' +
      '`format=csv` gives the trades as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiParam({
    name: 'base',
    required: false,
    description:
      'A currency, with its issuer or without: `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, `USD`, or the native currency.',
  })
  @ApiParam({ name: 'counter', required: false, description: 'The other side of the pair, written like `base`.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'amm',
    required: false,
    enum: ['include', 'exclude', 'only'],
    description:
      'Swaps against AMM pools are exchanges too (they carry `amm_account`, the pool). `include` (default) lists ' +
      'them with the order-book exchanges, `exclude` lists the order-book exchanges only, `only` the swaps only.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Param('base') baseRaw: string | undefined,
    @Param('counter') counterRaw: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountExchangesBody> {
    // the checks come in the order of the pair routes: the assets (the original checked none: ruling R33 validates the
    // issuers), then start, end, limit (the window), then amm
    const base = parseAssetFilter(baseRaw, 'base');
    const counter = parseAssetFilter(counterRaw, 'counter');
    const window = accountWindow(query);
    const amm = ammFilter(query);

    const page = await this.exchanges.list({
      ...window,
      amm,
      account: address,
      ...(base && { base }),
      ...(counter && { counter }),
    });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.exchanges.length,
      marker: page.marker,
      exchanges: wantsCsv(query) ? toAccountCsvRows(page.exchanges) : page.exchanges,
    };
  }
}

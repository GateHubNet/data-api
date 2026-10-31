import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv, toCsvRow, wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ACCOUNT_MPT_KEYS } from '../mpt/mpt-objects';
import { AccountMptService, parseHoldingsMarker } from './account-mpt.service';

/** The name of the CSV file of the holdings of an account: `<address> - mpt`. `@Csv` adds the `.csv`. */
const holdingsFilename = (req: Request): string => `${String(req.params.address)} - mpt`;

/**
 * `GET /v2/accounts/:address/mpt` (a GateHub extra, no Ripple original, spec 7.6): the MPT holdings of an account at the newest committed
 * ledger, by issuance ID. Unlike most routes under an account the address is checked: an X-address is no address here (400 `invalid
 * ripple address`). The checks come in the order of the parameters: the address, then the marker (400 `invalid marker`), both before any
 * read. `coverage`, the key after `result`, is the feature `mpt`.
 */
@RippleController('v2/accounts')
export class AccountMptController {
  constructor(private readonly holdings: AccountMptService) {}

  @Get(':address/mpt')
  @RippleRoute('unable to retrieve mpt holdings')
  @Csv(holdingsFilename, 'mpt')
  @ApiOperation({
    summary: 'Get the MPT holdings of an account',
    description:
      "The account's balances of MPTs at the newest committed ledger (`ledger_index`, `close_time`), by issuance ID: the integer units it " +
      'can move (`amount`) and has in escrow (`escrowed_amount`), `locked` when the balance cannot move (its own flag or the ' +
      "issuance's), and its `authorized` flag. `issuer` comes from the ID; `ticker`, `name` and `asset_scale` from the issuance, when " +
      'its state is known. `include_zero` adds a balance of nothing; a deleted token is never listed. The marker is the ID of the last ' +
      'row. `format=csv` gives the holdings as a CSV file `<address> - mpt.csv` (without `coverage`). A network without MPT has an empty ' +
      'list, complete.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account (a classic address).' })
  @ApiQuery({ name: 'include_zero', required: false, type: Boolean, description: 'Also a balance of nothing.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page: the ID of its last row.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    const after = parseHoldingsMarker(first(query, 'marker'));
    const page = await this.holdings.page(address, {
      includeZero: bool(query, 'include_zero'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      ...(after !== undefined && { after }),
    });
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      coverage: page.coverage,
      ...(page.head && { ledger_index: page.head.ledger_index, close_time: fmtTime(page.head.close_time) }),
      count: page.rows.length,
      ...(page.marker !== undefined && { marker: page.marker }),
      mpt: wantsCsv(query) ? page.rows.map((row) => toCsvRow(row, ACCOUNT_MPT_KEYS)) : page.rows,
    };
  }
}

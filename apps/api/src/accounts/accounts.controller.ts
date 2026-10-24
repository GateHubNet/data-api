import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { AccountObject } from './account-object';
import { AccountsService } from './accounts.service';
import { NamesAndLabels, NamesAndLabelsService } from './names-and-labels.service';

/** The message of both routes when something other than a Ripple 4xx goes wrong (`accounts.js`, `getAccount.js`). */
const FAILURE = 'unable to get accounts';

/** `GET /v2/accounts` (`api/routes/accounts.js`) and `GET /v2/accounts/:address` (`api/routes/getAccount.js`). */
@RippleController('v2/accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly namesAndLabels: NamesAndLabelsService,
  ) {}

  @Get()
  @RippleRoute(FAILURE)
  @Csv('accounts', 'accounts')
  @ApiOperation({
    summary: 'Get the accounts created',
    description:
      'The accounts created in the ledgers that closed between `start` and `end`, oldest first, each with the ' +
      'account that created it (`parent`), the balance it was created with and when. With `parent`, only the ' +
      'accounts that address created. `format=csv` gives the accounts as a CSV file.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'parent', required: false, description: 'Only the accounts this address created.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; count: number; marker?: string; accounts: AccountObject[] }> {
    // the checks come in the order of the original: start (2013-01-01 when missing or empty), then end
    const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
    const end = dateParam(query, 'end', 'invalid end date format');

    const page = await this.accounts.list({
      start: start.date,
      ...(end && { endExclusive: endExclusive(end) }),
      // the original did not check it either; an empty one is no filter (`if (options.parent)`)
      parent: first(query, 'parent') || undefined,
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return { result: 'success', count: page.accounts.length, marker: page.marker, accounts: page.accounts };
  }

  @Get(':address')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get an account',
    description:
      'When and by whom an account was created. An address that was created more than once (deleted and funded ' +
      'again) answers with its latest creation. `account_name` is the name the operator gave the address, the ' +
      'same on every network, left out when it has none.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  async lookup(
    @Param('address') address: string,
  ): Promise<{ result: 'success'; account_data: AccountObject & NamesAndLabels }> {
    // not validated, as in the original: an address that is none has simply never been created
    const account = await this.accounts.latest(address);
    // an address with a name but no activation on this network stays not found (spec #4, an open point)
    if (!account) throw notFound('Account not found');
    return { result: 'success', account_data: { ...account, ...this.namesAndLabels.of(account.account) } };
  }
}

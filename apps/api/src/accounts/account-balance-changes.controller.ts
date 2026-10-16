import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { AccountBalanceChangesService } from './account-balance-changes.service';
import { accountWindow } from './account-window';
import { BalanceChangeObject } from './balance-change-object';

/**
 * The `change_type`s the original accepts (`types` of `accountBalanceChanges.js`). Its list leaves out the types of
 * escrows and payment channels, which the rows do carry, so those cannot be asked for (and are rejected, as there).
 */
const CHANGE_TYPES = ['transaction_cost', 'exchange', 'intermediary', 'payment_source', 'payment_destination'];

/**
 * The name of the CSV file, as `accountBalanceChanges.js` has it: `<address> - balance changes`, then ` <currency>`
 * (upper case) when given. `@Csv` adds the `.csv`.
 */
function csvFilename(req: Request): string {
  const currency = first(req.query, 'currency');
  return `${req.params.address} - balance changes${currency ? ` ${currency.toUpperCase()}` : ''}`;
}

interface BalanceChangesBody {
  result: 'success';
  count: number;
  marker?: string;
  balance_changes: BalanceChangeObject[];
}

/**
 * `GET /v2/accounts/:address/balance_changes` (`api/routes/accountBalanceChanges.js`).
 *
 * The address is not checked, as in the original: one that is none simply has no changes.
 */
@RippleController('v2/accounts')
export class AccountBalanceChangesController {
  constructor(
    private readonly changes: AccountBalanceChangesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':address/balance_changes')
  @RippleRoute('unable to retrieve balance changes')
  @Csv(csvFilename, 'balance_changes')
  @ApiOperation({
    summary: 'Get the balance changes of an account',
    description:
      'Every change of a balance of the account (the native currency and its trust lines) made by the transactions of ' +
      'the ledgers that closed between `start` and `end`, oldest first; the fee of a transaction comes first, as a ' +
      '`transaction_cost` without a `node_index`. `currency`, `counterparty` (alias `issuer`) and `change_type` (alias ' +
      '`type`) keep the changes of that currency, against that counterparty, of that kind. `format=csv` gives the ' +
      'changes as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'currency', required: false, description: 'Only changes of this currency.' })
  @ApiQuery({
    name: 'counterparty',
    required: false,
    description: 'Only changes against this counterparty; not with the native currency. Alias: issuer.',
  })
  @ApiQuery({
    name: 'change_type',
    required: false,
    enum: CHANGE_TYPES,
    description: 'Only changes of this kind. Alias: type.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BalanceChangesBody> {
    // the checks come in the order of the original: start, end, a counterparty with the native currency, the change type
    const window = accountWindow(query);
    // `req.query.counterparty || req.query.issuer`: an empty one is none
    const counterparty = first(query, 'counterparty') || first(query, 'issuer') || undefined;
    const currency = first(query, 'currency') || undefined;
    const native = this.profile.nativeCurrency;
    if (counterparty && currency && currency.toUpperCase() === native) {
      throw badRequest(`counterparty cannot be specified for ${native}`);
    }
    // `req.query.change_type || req.query.type`
    const changeType = first(query, 'change_type') || first(query, 'type') || undefined;
    if (changeType !== undefined && !CHANGE_TYPES.includes(changeType)) {
      throw badRequest(`invalid change_type - use: ${CHANGE_TYPES.join(', ')}`);
    }

    const page = await this.changes.list({
      ...window,
      account: address,
      ...(currency && { currency: currency.toUpperCase() }),
      ...(counterparty && { counterparty }),
      ...(changeType && { changeType }),
    });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.balance_changes.length,
      marker: page.marker,
      balance_changes: page.balance_changes,
    };
  }
}

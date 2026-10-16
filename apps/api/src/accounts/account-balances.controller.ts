import { Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { AccountBalancesService, Balance } from './account-balances.service';
import { ledgerSelector, liveLimit } from './account-ledger';

interface AccountBalancesBody {
  result: 'success';
  ledger_index?: number;
  close_time?: string;
  limit?: number;
  balances: Balance[];
}

/**
 * `GET /v2/accounts/:address/balances` (`api/routes/accountBalances.js`): the balances of an account on the live node.
 *
 * The checks come in the order of the original: the address (400 `invalid ripple address`), the date (400 `invalid date
 * format`), the limit (400 `invalid limit`). `ledger_index` (alias `ledger`), `ledger_hash` and `date` (alias
 * `close_time`) choose the ledger, `validated` when none does; see `AccountBalancesService` for the rest.
 */
@RippleController('v2/accounts')
export class AccountBalancesController {
  constructor(private readonly balances: AccountBalancesService) {}

  @Get(':address/balances')
  @RippleRoute('unable to retrieve balances')
  @Csv((req) => `${req.params.address} - balances`, 'balances')
  @ApiOperation({
    summary: 'Get the balances of an account',
    description:
      'The balances of the account on a ledger of the live node, the native one first (it has no `counterparty`), then ' +
      'the trust lines in the order of the node. The ledger is chosen by `ledger_index`, `ledger_hash` or `date` (the ' +
      'last ledger closed at or before it, answered with its `close_time`); without any of them it is the newest ' +
      'validated one. `currency` keeps the balances of one currency, `counterparty` the trust lines with one account. ' +
      '`limit=all` reads every trust line. `format=csv` gives the balances as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'ledger_index', required: false, description: 'A ledger number. Alias: `ledger`.' })
  @ApiQuery({ name: 'ledger_hash', required: false, description: 'The hash of the ledger.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The last ledger closed at or before this time. Alias: `close_time`.',
  })
  @ApiQuery({ name: 'currency', required: false, description: 'Only balances in this currency.' })
  @ApiQuery({
    name: 'counterparty',
    required: false,
    description: 'Only trust lines with this account. Alias: `issuer`.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 200, at most 400, or `all`.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(@Param('address') address: string, @Query() query: QueryParams): Promise<AccountBalancesBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    const selector = ledgerSelector(query);
    const limit = liveLimit(query);

    const found = await this.balances.balances({
      address,
      selector,
      currency: first(query, 'currency') || undefined,
      counterparty: first(query, 'counterparty') || first(query, 'issuer') || undefined,
      limit,
    });

    return {
      result: 'success',
      ledger_index: found.ledgerIndex,
      close_time: found.closeTime === undefined ? undefined : fmtTime(found.closeTime),
      limit,
      balances: found.balances,
    };
  }
}

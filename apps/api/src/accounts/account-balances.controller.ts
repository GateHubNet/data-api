import { Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameter below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ApiConfig } from '../config/api.config';
import { AccountBalancesService, Balance } from './account-balances.service';
import { ledgerSelector, liveCacheControl, liveLimit } from './account-ledger';

interface AccountBalancesBody {
  result: 'success';
  ledger_index?: number;
  close_time?: string;
  limit?: number;
  balances: Balance[];
}

/**
 * `GET /v2/accounts/:address/balances` (`api/routes/accountBalances.js`): the balances of an account at a historical
 * ledger from the account state history in ClickHouse, or at the current ledger from the live node (ADR-0015).
 *
 * The checks come in the order of the original: the address (400 `invalid ripple address`), the date (400 `invalid date
 * format`), the limit (400 `invalid limit`). `ledger_hash`, `date` (alias `close_time`) and a numeric `ledger_index`
 * (alias `ledger`) name a historical ledger; none, or `validated`, `closed`, `current`, is the node's; see
 * `AccountBalancesService` for the rest. Only a live answer carries the `Cache-Control` of the live cache: a historical
 * one keeps the global header of `/v2`, as the other routes that read ClickHouse.
 */
@RippleController('v2/accounts')
export class AccountBalancesController {
  constructor(
    private readonly balances: AccountBalancesService,
    private readonly config: ApiConfig,
  ) {}

  @Get(':address/balances')
  @RippleRoute('unable to retrieve balances')
  @Csv((req) => `${req.params.address} - balances`, 'balances')
  @ApiOperation({
    summary: 'Get the balances of an account',
    description:
      'The balances of the account at a ledger, the native one first (it has no `counterparty`), then the trust lines. ' +
      'A ledger named by `ledger_hash`, `date` (the last ledger closed at or before it) or a numeric `ledger_index` is ' +
      'read from the indexed state history, with the trust lines ordered by (counterparty, currency), and answered with ' +
      'its `close_time`; without any of them (or with `validated`, `closed`, `current`) the balances come from the live ' +
      "node, the newest validated ledger by default, with the trust lines in the node's order. `currency` keeps the " +
      'balances of one currency, `counterparty` the trust lines with one account. `limit=all` reads every trust line. ' +
      '`format=csv` gives the balances as a CSV file.',
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
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountBalancesBody> {
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

    // a live answer: private and no older than the live cache, in place of the global header of /v2 (R108)
    if (found.live) res.setHeader('Cache-Control', liveCacheControl(this.config.liveCacheTtlMs));
    return {
      result: 'success',
      ledger_index: found.ledgerIndex,
      close_time: found.closeTime === undefined ? undefined : fmtTime(found.closeTime),
      limit,
      balances: found.balances,
    };
  }
}

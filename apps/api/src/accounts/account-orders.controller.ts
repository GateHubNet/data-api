import { Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameter below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ApiConfig } from '../config/api.config';
import { ledgerSelector, liveCacheControl, liveLimit } from './account-ledger';
import { AccountOrdersService } from './account-orders.service';
import { OrderObject } from './order-object';

interface AccountOrdersBody {
  result: 'success';
  ledger_index?: number;
  close_time?: string;
  limit?: number;
  orders: OrderObject[];
}

/**
 * `GET /v2/accounts/:address/orders` (`api/routes/accountOrders.js`): the open orders of an account on the live node.
 *
 * Parsed exactly like the balances: the same ledger choice (`ledger_index` / `ledger`, `ledger_hash`, `date` /
 * `close_time`; `validated` when none), the same `limit` (200 by default, at most 400, `all`) and the same checks in
 * the same order. The original checked no address here and let the node fail (a 500); a malformed one is the same 400
 * `invalid ripple address` as on the balances. `currency` is read by the original and never used, so it is ignored.
 */
@RippleController('v2/accounts')
export class AccountOrdersController {
  constructor(
    private readonly orders: AccountOrdersService,
    private readonly config: ApiConfig,
  ) {}

  @Get(':address/orders')
  @RippleRoute('unable to retrieve orders')
  @Csv((req) => `${req.params.address} - orders`, 'orders')
  @ApiOperation({
    summary: 'Get the open orders of an account',
    description:
      'The offers the account has on the book, on a ledger of the live node, in the order of the node. A buy has the ' +
      'quantity it pays for and the total price it gets; a sell (the offer has the sell flag) the other way round. ' +
      '`makerExchangeRate` is the quality of the offer in whole units. The ledger is chosen by `ledger_index`, ' +
      '`ledger_hash` or `date` (the last ledger closed at or before it, answered with its `close_time`); without any of ' +
      'them it is the newest validated one. `limit=all` reads every offer. `format=csv` gives the orders as a flat CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'ledger_index', required: false, description: 'A ledger number. Alias: `ledger`.' })
  @ApiQuery({ name: 'ledger_hash', required: false, description: 'The hash of the ledger.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The last ledger closed at or before this time. Alias: `close_time`.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 200, at most 400, or `all`.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountOrdersBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    const selector = ledgerSelector(query);
    const limit = liveLimit(query);

    const found = await this.orders.orders({ address, selector, limit });

    // private and no older than the live cache, in place of the global header of /v2 (R108)
    res.setHeader('Cache-Control', liveCacheControl(this.config.liveCacheTtlMs));
    return {
      result: 'success',
      ledger_index: found.ledgerIndex,
      close_time: found.closeTime === undefined ? undefined : fmtTime(found.closeTime),
      limit,
      orders: found.orders,
    };
  }
}

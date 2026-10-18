import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { dateOf } from '../active-accounts/active-window';
import { LiquidityCsvRow, LiquidityObject, PositionObject, toLiquidityCsvRow } from '../amm/amm-objects';
import { eventParam, ledgerDates } from '../amm/amm-params';
import { poolParam } from '../amm/amm-pools.controller';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { AccountAmmService } from './account-amm.service';

interface AccountLiquidityBody {
  result: 'success';
  count: number;
  marker?: string;
  liquidity: LiquidityObject[] | LiquidityCsvRow[];
}

interface PositionsBody {
  result: 'success';
  positions: PositionObject[];
}

/** The name of the CSV file: `<address> - amm liquidity`. `@Csv` adds the `.csv`. */
function liquidityFilename(req: Request): string {
  return `${req.params.address} - amm liquidity`;
}

/**
 * The AMM routes under an account (GateHub extra, no Ripple original): the liquidity events of the account across pools, and
 * its LP-token positions. As on the other routes under an account, the address is not checked: one that is none simply has no
 * events and no positions.
 */
@RippleController('v2/accounts')
export class AccountAmmController {
  constructor(private readonly amm: AccountAmmService) {}

  @Get(':address/amm_liquidity')
  @RippleRoute('unable to retrieve liquidity')
  @Csv(liquidityFilename, 'liquidity')
  @ApiOperation({
    summary: 'Get the AMM liquidity events of an account',
    description:
      'The creations, deposits, withdrawals, clawbacks and deletions of AMM pools in which the account was the liquidity ' +
      'provider, in the ledgers that closed between `start` and `end`, oldest first. Each is the event ' +
      '`GET /v2/amm/pools/:pool/liquidity` serves: `{amm_account, ledger_index, tx_index, tx_hash, executed_time, account, ' +
      'initiator, event, mode?, base_amount, counter_amount, lp_tokens}`, with the amounts signed from the pool side. ' +
      '`pool` and `event` keep the events of that pool, of that kind. `format=csv` gives the events as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the liquidity provider.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'pool', required: false, description: 'Only the events of the pool with this account.' })
  @ApiQuery({
    name: 'event',
    required: false,
    enum: ['create', 'deposit', 'withdraw', 'clawback', 'delete'],
    description: 'Only the events of this kind.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async liquidity(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountLiquidityBody> {
    // the checks come in the order of the params: start, end, limit, pool, event, then the marker (the service)
    const window = ledgerDates(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const rawPool = first(query, 'pool');
    const pool = rawPool === undefined || rawPool === '' ? undefined : poolParam(rawPool);
    const event = eventParam(query);

    const page = await this.amm.liquidity({
      account: address,
      ...window,
      ...(pool !== undefined && { pool }),
      ...(event !== undefined && { event }),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.events.length,
      marker: page.marker,
      liquidity: wantsCsv(query) ? page.events.map(toLiquidityCsvRow) : page.events,
    };
  }

  @Get(':address/amm_positions')
  @RippleRoute('unable to retrieve positions')
  @ApiOperation({
    summary: 'Get the AMM positions of an account',
    description:
      'The LP tokens the account holds, one position for each AMM pool: `{pool, lp_currency, lp_balance, share, ' +
      "base_amount?, counter_amount?}`, sorted by pool. `lp_balance` is the account's last balance of the pool's LP token " +
      'at `date` (now without one: the last ledger that closed at or before it), `share` is that balance over the LP ' +
      'supply of the pool at the same ledger, and each amount is the same share of the reserve of the pool on that side ' +
      "(the pool's base and counter, as `GET /v2/amm/pools/:pool` gives them). They are exact decimal strings (30 " +
      'significant digits where they do not end sooner). A zero balance, a deleted pool and a pool without a supply have ' +
      'no position; neither has a line that is not the LP token the pool names.',
  })
  @ApiParam({ name: 'address', description: 'The address of the liquidity provider.' })
  @ApiQuery({ name: 'date', required: false, description: 'The time the positions are of. Default: now.' })
  async positions(@Param('address') address: string, @Query() query: QueryParams): Promise<PositionsBody> {
    // an empty `date` is none, as on the other routes that take one (`dateOf`); text that is no date is 400
    const date = dateOf(query);
    return { result: 'success', positions: await this.amm.positions(address, date?.date) };
  }
}

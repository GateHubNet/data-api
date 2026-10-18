import { AMM_LIQUIDITY_EVENTS } from '@gatehub/data-api-shared';
import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { toCsvRow } from '../exchanges/exchange-object';
import { exchangesWindow } from '../exchanges/exchanges-window';
import { AmmEventsService } from './amm-events.service';
import {
  GovernanceCsvRow,
  GovernanceObject,
  LiquidityCsvRow,
  LiquidityObject,
  toGovernanceCsvRow,
  toLiquidityCsvRow,
} from './amm-objects';
import { eventParam, GOVERNANCE_TYPES, ledgerDates, PagingQuery, typeParam } from './amm-params';
import { poolParam } from './amm-pools.controller';

interface SwapsBody {
  result: 'success';
  count: number;
  marker?: string;
  exchanges: unknown[];
}

interface LiquidityBody {
  result: 'success';
  count: number;
  marker?: string;
  liquidity: LiquidityObject[] | LiquidityCsvRow[];
}

interface GovernanceBody {
  result: 'success';
  count: number;
  marker?: string;
  governance: GovernanceObject[] | GovernanceCsvRow[];
}

/** The name of the CSV file of a list of a pool: `<pool> - amm <what>`. `@Csv` adds the `.csv`. */
const filenameOf =
  (what: string) =>
  (req: Request): string =>
    `${req.params.pool} - amm ${what}`;

/**
 * The event lists of a pool (GateHub extra, no Ripple original): its swaps, its liquidity events and its votes and bids. A
 * pool is addressed by its account; 400 `invalid pool` for a text that is no address, and 404 `pool not found` for an address
 * with no state in a committed ledger (`AmmPoolsService.requirePool`). Registered BEFORE `AmmPairController`, whose
 * `/pools/:base/:counter` would take `/pools/<pool>/swaps` for a pair.
 */
@RippleController('v2/amm/pools')
export class AmmEventsController {
  constructor(private readonly events: AmmEventsService) {}

  @Get(':pool/swaps')
  @RippleRoute('unable to retrieve swaps')
  @Csv(filenameOf('swaps'), 'exchanges')
  @ApiOperation({
    summary: 'Get the swaps of a pool',
    description:
      'The exchanges that were swaps against the pool, in the ledgers that closed between `start` and `end`, oldest first: ' +
      'what `GET /v2/exchanges/:base/:counter?amm=only` serves for the pair of the pool, restricted to the pool, with the ' +
      'same rows, the same markers and the same params (`autobridged`, the limit of at most 400), in the pair as the pool ' +
      'stores it (`amm_account` is the last key of each). `amm` is ignored: these are always the swaps. `format=csv` ' +
      'gives the swaps as a CSV file.',
  })
  @ApiParam({ name: 'pool', description: 'The address of the pool account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'autobridged', required: false, type: Boolean, description: 'Only the autobridged exchanges.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 400.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async swaps(
    @Param('pool') poolRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SwapsBody> {
    // the checks come in the order of the params: the pool, start, end, limit (as the exchange routes read them), then the
    // marker (the service); `amm` is not read: the swaps of a pool are always the swaps
    const pool = poolParam(poolRaw);
    const window = exchangesWindow(query, () => 'only');
    const page = await this.events.swaps({ ...window, pool });
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.exchanges.length,
      marker: page.marker,
      exchanges: wantsCsv(query) ? page.exchanges.map(toCsvRow) : page.exchanges,
    };
  }

  @Get(':pool/liquidity')
  @RippleRoute('unable to retrieve liquidity')
  @Csv(filenameOf('liquidity'), 'liquidity')
  @ApiOperation({
    summary: 'Get the liquidity events of a pool',
    description:
      'The creation, the deposits, the withdrawals, the clawbacks and the deletion of the pool in the ledgers that closed ' +
      'between `start` and `end`, oldest first: `{amm_account, ledger_index, tx_index, tx_hash, executed_time, account, ' +
      'initiator, event, mode?, base_amount, counter_amount, lp_tokens}`. The amounts are exact strings, signed from the ' +
      'pool side (positive into the pool, negative out of it); `lp_tokens` is positive when LP tokens were minted and ' +
      'negative when burned; `account` is the liquidity provider and `initiator` who sent the transaction (not the same ' +
      'for a clawback); `mode` is the mode of a deposit or withdrawal. `event` and `account` keep the events of that ' +
      'kind, of that provider. `format=csv` gives the events as a CSV file.',
  })
  @ApiParam({ name: 'pool', description: 'The address of the pool account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'event',
    required: false,
    enum: [...AMM_LIQUIDITY_EVENTS],
    description: 'Only the events of this kind.',
  })
  @ApiQuery({ name: 'account', required: false, description: 'Only the events of this liquidity provider.' })
  @PagingQuery()
  async liquidity(
    @Param('pool') poolRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LiquidityBody> {
    // the checks come in the order of the params: the pool, start, end, limit, event, then the marker (the service)
    const pool = poolParam(poolRaw);
    const window = ledgerDates(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const event = eventParam(query);
    const account = first(query, 'account');
    const page = await this.events.liquidity({
      pool,
      ...window,
      ...(event !== undefined && { event }),
      ...(account !== undefined && account !== '' && { account }),
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

  @Get(':pool/governance')
  @RippleRoute('unable to retrieve governance')
  @Csv(filenameOf('governance'), 'governance')
  @ApiOperation({
    summary: 'Get the votes and bids of a pool',
    description:
      'The votes (`type` `vote`: `fee_voted`, the fee the voter asked for, and `trading_fee_after`, the fee of the pool ' +
      'after it) and the bids (`type` `bid`: `bid_min`, `bid_max`, `price_paid`, the LP tokens the bid burned, and ' +
      '`auction_slot`, the slot after the bid with its authorized accounts) of the pool in the ledgers that closed between ' +
      '`start` and `end`, oldest first. `type` keeps one kind. `format=csv` gives the rows as a CSV file, with the ' +
      'columns of both kinds.',
  })
  @ApiParam({ name: 'pool', description: 'The address of the pool account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [...GOVERNANCE_TYPES],
    description: 'Only the votes, or only the bids.',
  })
  @PagingQuery()
  async governance(
    @Param('pool') poolRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GovernanceBody> {
    // the checks come in the order of the params: the pool, start, end, limit, type, then the marker (the service)
    const pool = poolParam(poolRaw);
    const window = ledgerDates(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const type = typeParam(query);
    const page = await this.events.governance({
      pool,
      ...window,
      ...(type !== undefined && { type }),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.items.length,
      marker: page.marker,
      governance: wantsCsv(query) ? page.items.map(toGovernanceCsvRow) : page.items,
    };
  }
}

import { Asset, NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { parseAsset, parseAssetPair } from '../common/asset-param';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest, notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import {
  PoolCsvRow,
  PoolDayCsvRow,
  PoolDayObject,
  PoolObject,
  PoolStateCsvRow,
  PoolStateObject,
  toPoolCsvRow,
  toPoolDayCsvRow,
  toPoolStateCsvRow,
} from './amm-objects';
import { ledgerDates, PagingQuery } from './amm-params';
import { AmmPoolsService, HistoryQuery } from './amm-pools.service';

interface PoolsBody {
  result: 'success';
  count: number;
  marker?: string;
  pools: PoolObject[] | PoolCsvRow[];
}

interface PoolBody {
  result: 'success';
  pool: PoolObject;
}

interface HistoryBody {
  result: 'success';
  count: number;
  marker?: string;
  history?: PoolStateObject[] | PoolStateCsvRow[] | PoolDayCsvRow[];
  days?: PoolDayObject[];
}

/** The pool of a path: an address that is none is 400 `invalid pool`. */
export function poolParam(raw: string): string {
  if (!isValidClassicAddress(raw)) throw badRequest('invalid pool');
  return raw;
}

/** The name of the CSV file of a history: `<pool> - amm history`. `@Csv` adds the `.csv`. */
function historyFilename(req: Request): string {
  return `${req.params.pool} - amm history`;
}

/**
 * The pool routes of the AMM data (GateHub extra, no Ripple original): the list of pools, a pool by its account, and the
 * history of a pool. The pair form (`/pools/:base/:counter`) is the `AmmPairController` below, registered last.
 */
@RippleController('v2/amm/pools')
export class AmmPoolsController {
  constructor(
    private readonly pools: AmmPoolsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve pools')
  @Csv('amm pools', 'pools')
  @ApiOperation({
    summary: 'Get the AMM pools',
    description:
      'The pools in their current state, the most valuable first (`value_native` descending, the pools without a value ' +
      'last, then the account). A pool is ' +
      '`{amm_account, base_currency, base_issuer?, counter_currency, counter_issuer?, reserve_base?, reserve_counter?, ' +
      'lp_supply?, lp_currency?, trading_fee?, auction_slot?, value_native?, created_ledger?, created_by?, last_ledger, ' +
      'deleted}`: the pair in the order it is stored in, the amounts as exact strings, `trading_fee` in units of 1/100000, ' +
      '`value_native` (eight significant digits) the pool worth in the native currency, left out when no asset has a rate ' +
      'and for a deleted pool. `format=csv` gives the pools as a CSV file.',
  })
  @ApiQuery({
    name: 'asset',
    required: false,
    description:
      'Only the pools that have this asset on either side: `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone. ' +
      'A raw `+` (which a query string decodes as a space) works; `%2B` is the strict form.',
  })
  @ApiQuery({
    name: 'asset2',
    required: false,
    description: 'Written like `asset`; with both, the pools that have both.',
  })
  @ApiQuery({
    name: 'include_deleted',
    required: false,
    type: Boolean,
    description: 'Also the pools that were deleted.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PoolsBody> {
    // the checks come in the order of the params: asset, asset2, limit, then the marker, which the service checks
    const assets = this.assets(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const page = await this.pools.list({
      assets,
      includeDeleted: bool(query, 'include_deleted'),
      limit,
      marker: first(query, 'marker'),
    });
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.pools.length,
      marker: page.marker,
      pools: wantsCsv(query) ? page.pools.map(toPoolCsvRow) : page.pools,
    };
  }

  @Get(':pool/history')
  @RippleRoute('unable to retrieve pool history')
  @Csv(historyFilename, 'history')
  @ApiOperation({
    summary: 'Get the history of a pool',
    description:
      'Every state of the pool in the ledgers that closed between `start` and `end`, oldest first: the pool after each ' +
      'transaction that touched it. A transaction only tells the values of the pool nodes it changed, so each state has ' +
      'its missing values carried forward from the newest earlier state, also from before `start`. With `interval=day` ' +
      'instead the days of the pool with activity (`swap_count`, `volume_base` and `volume_counter` by side, `fees_*_est`, ' +
      'estimates, left out when a swap into the side had no known fee, liquidity in and out, and the closing state), a day ' +
      'when its start is within `start` and `end`. ' +
      '`format=csv` gives the rows as a CSV file.',
  })
  @ApiParam({ name: 'pool', description: 'The address of the pool account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ['day'],
    description: 'Without it every state; `day`: one row a day.',
  })
  @PagingQuery()
  async history(
    @Param('pool') poolRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HistoryBody> {
    // the checks come in the order of the params: the pool, start, end, limit, interval, then the marker (the service)
    const pool = poolParam(poolRaw);
    const dates = ledgerDates(query);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const interval = first(query, 'interval');
    if (interval !== undefined && interval !== '' && interval !== 'day') throw badRequest('invalid interval');

    const window: HistoryQuery = {
      pool,
      ...dates,
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    };
    const csv = wantsCsv(query);
    if (interval === 'day') {
      const page = await this.pools.days(window);
      setLinkHeader(req, res, page.marker);
      // a CSV has its rows under one key (`@Csv`): the body is replaced by the CSV, so the key is only that
      return csv
        ? { result: 'success', count: page.days.length, marker: page.marker, history: page.days.map(toPoolDayCsvRow) }
        : { result: 'success', count: page.days.length, marker: page.marker, days: page.days };
    }
    const page = await this.pools.states(window);
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.states.length,
      marker: page.marker,
      history: csv ? page.states.map(toPoolStateCsvRow) : page.states,
    };
  }

  @Get(':pool')
  @RippleRoute('unable to retrieve pool')
  @ApiOperation({
    summary: 'Get a pool',
    description:
      'The pool of an account in its current state, deleted or not; 404 `pool not found` when there is none.',
  })
  @ApiParam({ name: 'pool', description: 'The address of the pool account.' })
  async detail(@Param('pool') poolRaw: string): Promise<PoolBody> {
    const pool = await this.pools.detail(poolParam(poolRaw));
    if (pool === undefined) throw notFound('pool not found');
    return { result: 'success', pool };
  }

  /**
   * `asset` and `asset2`: the assets to filter by, each as the exchange routes write one. A missing or empty one is none. A
   * query string decodes a raw `+` as a space, and a space can be in neither a currency code nor an address, so a space is the
   * `+` separator (`asset2=USD+rIssuer` works as written; `%2B` is the strict form).
   */
  private assets(query: QueryParams): Asset[] {
    return (['asset', 'asset2'] as const).flatMap((name) => {
      const raw = first(query, name);
      return raw === undefined || raw === ''
        ? []
        : [parseAsset(raw.trim().replace(/ /g, '+'), this.profile.nativeCurrency)];
    });
  }
}

/**
 * `GET /v2/amm/pools/:base/:counter`: the pool of a pair, in either order. In a controller of its own, which the module
 * registers LAST: it matches every path of two segments after `pools`, so a route such as `/pools/:pool/history` registered
 * after it would be taken for a pair (`rPool` and `history`).
 */
@RippleController('v2/amm/pools')
export class AmmPairController {
  constructor(
    private readonly pools: AmmPoolsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':base/:counter')
  @RippleRoute('unable to retrieve pool')
  @ApiOperation({
    summary: 'Get the pool of a pair',
    description:
      'The live pool of the pair, in whichever order the assets are given; when the pair has none, the pool that was ' +
      'deleted last. 404 `pool not found` when the pair never had one.',
  })
  @ApiParam({
    name: 'base',
    description: 'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone.',
  })
  @ApiParam({ name: 'counter', description: 'The other side of the pair, written like `base`.' })
  async pair(@Param('base') baseRaw: string, @Param('counter') counterRaw: string): Promise<PoolBody> {
    const { base, counter } = parseAssetPair(baseRaw, counterRaw, this.profile.nativeCurrency);
    const pool = await this.pools.byPair(base, counter);
    if (pool === undefined) throw notFound('pool not found');
    return { result: 'success', pool };
  }
}

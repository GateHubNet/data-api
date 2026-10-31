import { Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, first, ledgerDates, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { MintedAnswer, SupplyAnswer } from './supply-object';
import { SupplyService } from './supply.service';

/** The `interval`s of `/v2/network/supply/minted`: a row per UTC day, and nothing else. */
export const MINTED_INTERVALS = ['day'] as const;

/**
 * `GET /v2/network/supply` (spec 5.1): the native supply of the network at the newest snapshot of the syncer's `supply` job, one an
 * hour. A new route: its object and key order are ours (`supply-object.ts`), and it uses the contract layer of the others (the API
 * key, the rate limit, `GH_CACHE_CONTROL`, errors `{result: "error", message}`). It takes no parameter; the ones sent are ignored.
 *
 * `GET /v2/network/supply/minted` (spec 5.2): the native currency minted per UTC day, by source, on a network that mints (Xahau). A list
 * in the style of `network/fees`: `{result, coverage, marker?, count, rows}`, `start`, `end`, `descending`, `limit`, `marker` and a CSV
 * form. It is a path below `v2/network/supply`, and the two routes do not meet: each is its own exact path.
 */
@RippleController('v2/network/supply')
export class SupplyController {
  constructor(private readonly supply: SupplyService) {}

  @Get()
  @RippleRoute('unable to retrieve supply')
  @ApiOperation({
    summary: 'Get the supply of the native currency',
    description:
      'The newest hourly snapshot of the native supply: every figure is as of one ledger (`ledger_index`, `close_time`), ' +
      'computed at `computed_at`, and an exact decimal text in whole units. `total` is the currency in existence. `burned` is ' +
      'what was destroyed: on the XRP Ledger 100 billion XRP less the total, exact from the ledger header, and on Xahau the ' +
      'fees of the indexed ledgers (no cap). `minted` (Xahau) is what was created by the indexed ledgers, `amount` being the sum ' +
      'of `rewards` (the rewards claimed), `import` (what an Import credited) and `genesis_mint` (every other GenesisMint). ' +
      '`escrowed` is the native currency in open escrows, `circulating` the total less the escrowed, which counts what is in ' +
      'payment channels, in AMM pools and held as reserves. `amm` (the XRP Ledger) is the native currency in the pools of ' +
      'automated market makers, and `reserves` the least the accounts must keep: the accounts times the base reserve plus ' +
      'their owned objects times the owner reserve (`base`, `increment`), at the snapshot ledger. `minted`, `amm` and ' +
      '`reserves` are left out where the network or the snapshot has none. A part read from the indexed history ends with ' +
      'its `coverage`: the first ledger the history is whole from, and whether it is whole back to where the feature ' +
      'starts. Before the first snapshot the answer is 404 `supply not computed yet`.',
  })
  snapshot(): Promise<SupplyAnswer> {
    return this.supply.snapshot();
  }

  @Get('minted')
  @RippleRoute('unable to retrieve minted supply')
  @Csv('network minted', 'rows')
  @ApiOperation({
    summary: 'Get the native currency minted per day',
    description:
      'The native currency created on each UTC day, by source, on a network that mints (Xahau): `amount` is the sum of `rewards` ' +
      '(the rewards claimed), `import` (what an Import credited) and `genesis_mint` (every other GenesisMint), in whole units. ' +
      'Every day from the first one the indexed history covers whole to the day of the newest ledger is a row, the days with no ' +
      'mint with zeros, and the newest day is the running one, summed so far. The answer states the `coverage` of the mints: the ' +
      "first ledger the history is whole from, and whether it is whole back to the network's first ledger. On a network that " +
      'cannot mint (the XRP Ledger) the list is empty. `format=csv` gives the rows as a CSV file.',
  })
  @ApiQuery({ name: 'interval', required: false, enum: MINTED_INTERVALS, description: 'Default: day (the only one).' })
  @ApiQuery({
    name: 'start',
    required: false,
    description: 'Start time. Default: the first day the mints are covered for.',
  })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async minted(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MintedAnswer> {
    // the checks come in this order: start, end, interval; the marker is checked by the service, before it reads anything
    const window = ledgerDates(query);
    const interval = first(query, 'interval') || 'day';
    if (!(MINTED_INTERVALS as readonly string[]).includes(interval)) throw badRequest('invalid interval');

    const page = await this.supply.minted({
      ...window,
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      coverage: page.coverage,
      ...(page.marker !== undefined && { marker: page.marker }),
      count: page.rows.length,
      rows: page.rows,
    };
  }
}

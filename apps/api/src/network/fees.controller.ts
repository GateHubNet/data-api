import { Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { FeeStat, FeeSummary } from './fee-object';
import { FEE_STAT_INTERVALS, FeeStatInterval, FeeStatsService } from './fee-stats.service';
import { FEE_INTERVALS, FeeInterval, FeesService } from './fees.service';

/** The message of both routes when something other than a Ripple 4xx goes wrong (`getFees.js`, `getFeeStats.js`). */
const FAILURE = 'unable to retrieve fee summary(s)';

/**
 * `GET /v2/network/fees` (`api/routes/network/getFees.js`) and `GET /v2/network/fee_stats`
 * (`api/routes/network/getFeeStats.js`). Both answer `{result, count, marker?, rows}`.
 */
@RippleController('v2/network')
export class FeesController {
  constructor(
    private readonly fees: FeesService,
    private readonly feeStats: FeeStatsService,
  ) {}

  @Get('fees')
  @RippleRoute(FAILURE)
  @Csv('network fees', 'rows')
  @ApiOperation({
    summary: 'Get the fees paid on the network',
    description:
      'The fees of the transactions in each ledger, hour or day, in the native currency: the mean, the smallest and ' +
      'the largest fee, the total and the number of transactions. An hour or a day is listed when it starts within ' +
      '`start` and `end`, and counts all its ledgers. `format=csv` gives the rows as a CSV file.',
  })
  @ApiQuery({ name: 'interval', required: false, enum: FEE_INTERVALS, description: 'Default: ledger.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async networkFees(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; marker?: string; count: number; rows: FeeSummary[] }> {
    // the checks come in the order of the original: start (2013-01-01 when missing or empty), end, interval
    const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
    const end = dateParam(query, 'end', 'invalid end date format');
    const interval = first(query, 'interval') || 'ledger';
    if (!(FEE_INTERVALS as readonly string[]).includes(interval)) throw badRequest('invalid interval');

    const page = await this.fees.list({
      interval: interval as FeeInterval,
      start: start.date,
      ...(end && { endExclusive: endExclusive(end) }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return { result: 'success', marker: page.marker, count: page.rows.length, rows: page.rows };
  }

  @Get('fee_stats')
  @RippleRoute(FAILURE)
  @Csv('network fee stats', 'rows')
  @ApiOperation({
    summary: 'Get the fee state of the network over time',
    description:
      "Snapshots of the node's fee state, taken every few seconds: the size of the open ledger and of the queue, " +
      'the percentage of the queue in use, and the median, the minimum and the open ledger fee in the native ' +
      'currency. With `interval`, the first snapshot at or after each minute, hour or day. `format=csv` gives the ' +
      'rows as a CSV file.',
  })
  @ApiQuery({ name: 'interval', required: false, enum: ['raw', ...FEE_STAT_INTERVALS], description: 'Default: raw.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2016-07-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: now.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async networkFeeStats(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; marker?: string; count: number; rows: FeeStat[] }> {
    const start = dateParam(query, 'start', 'invalid start date format', '2016-07-01');
    const end = dateParam(query, 'end', 'invalid end date format');
    // an empty interval is none; `raw` is listed as valid by the original and means the same
    const interval = first(query, 'interval') || undefined;
    if (interval !== undefined && interval !== 'raw' && !(FEE_STAT_INTERVALS as readonly string[]).includes(interval)) {
      throw badRequest('invalid interval');
    }

    const page = await this.feeStats.list({
      ...(interval !== undefined && interval !== 'raw' && { interval: interval as FeeStatInterval }),
      start: start.date,
      ...(end && { endExclusive: endExclusive(end), endAt: end.date }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return { result: 'success', marker: page.marker, count: page.rows.length, rows: page.rows };
  }
}

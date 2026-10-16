import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import {
  checkFamily,
  FlatStats,
  NestedStats,
  STATS_INTERVALS,
  statsFilename,
  StatsInterval,
  statsSelection,
} from './stats-object';
import { StatsService } from './stats.service';

/**
 * `GET /v2/stats[/:family[/:metric]]` (`api/routes/stats.js`): counts of what happened on the network per hour, day or
 * week. Answers `{result, count, marker?, stats}`.
 */
@RippleController('v2/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get(['', ':family', ':family/:metric'])
  @RippleRoute('unable to retrieve stats')
  @Csv((req) => statsFilename(statsSelection(req.params, req.query)), 'stats')
  @ApiOperation({
    summary: 'Get statistics of the network',
    description:
      'Transactions (by type and by result), payments, exchanges, created accounts and ledgers per hour, day or week (Monday ' +
      'to Sunday, UTC), with the average number of transactions per ledger and the average time between ledgers. ' +
      'Without a family a row is `{date, type, result, metric}`; with `type`, `result` or `metric` (in the path or in ' +
      '`family`) it holds the values of that family and `date`, and `metrics` (a list) or the last part of the path picks ' +
      'some of them. What is zero is left out. A bucket is listed when it starts within `start` and `end`. ' +
      '`format=csv` gives the rows as a CSV file.',
  })
  @ApiParam({ name: 'family', required: false, enum: ['type', 'result', 'metric'] })
  @ApiParam({
    name: 'metric',
    required: false,
    description: 'A transaction type, a result code or a metric of the family.',
  })
  @ApiQuery({ name: 'interval', required: false, enum: STATS_INTERVALS, description: 'Default: day.' })
  @ApiQuery({ name: 'family', required: false, enum: ['type', 'result', 'metric'], description: 'As in the path.' })
  @ApiQuery({ name: 'metrics', required: false, description: 'Comma separated names in the family; needs a family.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: now.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('family') family: string | undefined,
    @Param('metric') metric: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; count: number; marker?: string; stats: Array<NestedStats | FlatStats> }> {
    // the checks come in the order of the original: the metrics need a family, the start, the end, the family; then the interval
    const selection = statsSelection({ family, metric }, query);
    const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
    const end = dateParam(query, 'end', 'invalid end date format');
    const checked = checkFamily(selection.family);
    const interval = first(query, 'interval') || 'day';
    if (!(STATS_INTERVALS as readonly string[]).includes(interval)) throw badRequest('invalid interval');

    const page = await this.stats.list({
      interval: interval as StatsInterval,
      start: start.date,
      // without an end: now, to the second (`smoment()` of the original), so that the current bucket is the last
      endExclusive: end ? endExclusive(end) : new Date(Date.now() + 1000),
      ...(checked !== undefined && { family: checked }),
      ...(selection.names !== undefined && { names: selection.names }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return { result: 'success', count: page.rows.length, marker: page.marker, stats: page.rows };
  }
}

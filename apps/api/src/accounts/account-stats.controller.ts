import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { TransactionStats, ValueStats } from './account-stats-object';
import { statsWindow } from './account-stats-window';
import { AccountStatsService } from './account-stats.service';
import { ANALYTICS_INTERVALS, intervalParam } from './analytics-window';

/** The families of `accountStats.js`: `transactions` and `value`. */
const FAMILIES = ['transactions', 'value'];

interface AccountStatsBody {
  result: 'success';
  count: number;
  marker?: string;
  rows: (TransactionStats | ValueStats)[];
}

/** The name of the CSV file, as `accountStats.js` has it: `<address> - stats.<family>`. `@Csv` adds the `.csv`. */
const csvFilename = (req: Request): string => `${req.params.address} - stats.${req.params.family}`;

/**
 * `GET /v2/accounts/:address/stats/:family` (`api/routes/accountStats.js`): a row for each UTC day the account was
 * active, `transactions` with the number of transactions it sent and their results and types, `value` with the value of
 * the account at the end of the day and the number of balance changes.
 *
 * The address is not checked, as in the original: one that is none has no rows. The original answered a failure with
 * `unable to retrieve exchanges` (the message of the route it was copied from), and so does this.
 */
@RippleController('v2/accounts')
export class AccountStatsController {
  constructor(private readonly stats: AccountStatsService) {}

  @Get(':address/stats/:family')
  @RippleRoute('unable to retrieve exchanges')
  @Csv(csvFilename, 'rows')
  @ApiOperation({
    summary: 'Get the daily stats of an account',
    description:
      'A row for each UTC day from `start` up to, but not including, `end`, in which the account was active; a day ' +
      'without activity has no row. `family=transactions`: `{date, transaction_count, result, type}`, the transactions ' +
      'the account sent that day, with how many had each result code and each transaction type. `family=value`: ' +
      '`{date, account_value, balance_change_count}`, what the account held at the end of the day in the native ' +
      'currency (the native balance, plus each issued currency it holds at the rate of the day, as a string; what the ' +
      'account owes is not counted) and how many times its balances changed that day, not counting the fee. ' +
      '`format=csv` gives the rows as a CSV file. With `interval` (`day`, `week` from Monday or `month`) the rows are ' +
      'buckets instead of days, `date` being the start of the bucket: a bucket is a row when its start is at or after ' +
      '`start` and before `end`. `transactions` has a row for each bucket in which the account sent a transaction, with ' +
      'the counts of the whole bucket. `value` has a row for every bucket from the first one in which the account had a ' +
      'balance to the last before `end`, active or not: its value at the end of the last day of the bucket (today, for ' +
      'the current one) and the number of balance changes in it (0 for a quiet bucket).',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiParam({ name: 'family', enum: FAMILIES, description: 'What to count: `transactions` or `value`.' })
  @ApiQuery({
    name: 'start',
    required: false,
    description: 'The first day, from its midnight on. Default: 2013-01-01.',
  })
  @ApiQuery({
    name: 'end',
    required: false,
    description: 'Where the days stop, exclusive: `end=2015-01-16` is the days before it. Default: now.',
  })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ANALYTICS_INTERVALS,
    description: 'Rows per day, week (from Monday) or month, UTC. Without it: a row per active day.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest day or bucket first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Param('family') family: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountStatsBody> {
    // the checks come in the order of the original: start, end, then the family; `interval` is ours and comes next (the
    // marker is checked where it is used)
    const now = Date.now();
    const window = statsWindow(query, now);
    if (!FAMILIES.includes(family)) throw badRequest('invalid family');
    const interval = intervalParam(query);

    const q = {
      account: address,
      window,
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
      ...(interval !== undefined && { interval }),
      now,
    };
    const page = family === 'transactions' ? await this.stats.transactions(q) : await this.stats.value(q);

    setLinkHeader(req, res, page.marker);
    return { result: 'success', count: page.rows.length, marker: page.marker, rows: page.rows };
  }
}

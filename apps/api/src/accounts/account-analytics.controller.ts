import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import {
  BalanceChangesAnswer,
  balanceChangesAnswer,
  BalancesAnswer,
  balancesAnswer,
  CHANGE_TYPE_ORDER,
} from './account-analytics-object';
import { AccountAnalyticsService } from './account-analytics.service';
import { ANALYTICS_INTERVALS, analyticsWindow, checkBucketLimit, MAX_ANALYTICS_BUCKETS } from './analytics-window';

/** The name of a CSV file: `<address> - <what>`. `@Csv` adds the `.csv`. */
const csvName =
  (what: string) =>
  (req: Request): string =>
    `${req.params.address} - ${what}`;

const WINDOW_DESCRIPTION =
  'The window is whole UTC days, from the day of `start` to the day of `end` (both included, whatever the time of day), ' +
  "widened to whole buckets when there is an `interval`; the answer's `start` is the start of the first day or bucket and " +
  '`end` the start of the one after the last, so it is exclusive. An `end` before `start` is an empty answer.';

/**
 * The routes of an account under `analytics/`: what the explorer shows about an account over a period, from its balance
 * changes (`AccountAnalyticsService`). New routes (ADR-0010 lists them as additions): their object shapes and key orders are
 * ours, and they use the contract layer of the others (the API key, the rate limit, `GH_CACHE_CONTROL`, `format=csv`, errors
 * `{result: "error", message}`).
 *
 * The address is not checked, as on the other account routes: one that is none has empty answers.
 */
@RippleController('v2/accounts')
export class AccountAnalyticsController {
  constructor(
    private readonly analytics: AccountAnalyticsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':address/analytics/balances')
  @RippleRoute('unable to retrieve balance history')
  @Csv(csvName('balance history'), 'rows')
  @ApiOperation({
    summary: 'Get the balance history of an account, per line',
    description:
      'A line is a currency and its counterparty (none for the native currency). `lines` are the lines of the account that ' +
      'changed up to the end of the window, after the filters, ranked: the native line first, then the lines that have a ' +
      'rate by their balance over that rate (the rate of the asset `(currency, counterparty)` on the newest valid day at or ' +
      'before the end of the window), largest first, then the others by the size of the balance; the first `limit` are ' +
      'served, and `lines_total` counts them all. `balance` of a line is its balance at the end of the window. `rows` are the ' +
      'balance of each of those lines at the end of each bucket: the last balance up to then, so a bucket without a change ' +
      'carries the balance before it. A line has rows from the bucket of its first change, or from the first bucket of the ' +
      'window when it changed before it, and a line that went back to 0 keeps its rows of "0". A balance below 0 is what ' +
      'the account owes on that line. A bucket that has not begun has no row, so the rows stop at the bucket that holds now ' +
      'whatever the end. ' +
      `${WINDOW_DESCRIPTION} At most ${MAX_ANALYTICS_BUCKETS} buckets. \`format=csv\` gives the rows as a CSV file.`,
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'The first day. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'The last day, whole. Default: now.' })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ANALYTICS_INTERVALS,
    description: 'The bucket of a row: day, week (from Monday) or month, UTC. Default: day.',
  })
  @ApiQuery({ name: 'currency', required: false, description: 'Only the lines of this currency (upper-cased).' })
  @ApiQuery({
    name: 'counterparty',
    required: false,
    description: 'Only the lines with this account; not with the native currency. Alias: issuer.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'How many lines. Default 10, at most 50.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async balances(@Param('address') address: string, @Query() query: QueryParams): Promise<BalancesAnswer> {
    // the checks come in the order of the table of parameters: start, end, interval, the counterparty, then the limit of buckets
    const now = Date.now();
    const window = analyticsWindow(query, now, 'default-day');
    // `req.query.counterparty || req.query.issuer`: an empty one is none
    const counterparty = first(query, 'counterparty') || first(query, 'issuer') || undefined;
    const currency = first(query, 'currency')?.toUpperCase() || undefined;
    const native = this.profile.nativeCurrency;
    if (counterparty && currency === native) throw badRequest(`counterparty cannot be specified for ${native}`);
    const limit = limitParam(query, { def: 10, max: 50 });
    checkBucketLimit(window);

    const found = await this.analytics.balances({
      account: address,
      window,
      ...(currency && { currency }),
      ...(counterparty && { counterparty }),
      limit,
      now,
    });
    return balancesAnswer(window, found);
  }

  @Get(':address/analytics/balance_changes')
  @RippleRoute('unable to retrieve balance changes')
  @Csv(csvName('balance change totals'), 'rows')
  @ApiOperation({
    summary: 'Get the sums of the balance changes of an account by change type and currency',
    description:
      'Every balance change of the window counts once, the fees (`transaction_cost`) too. A change type is one of ' +
      `${CHANGE_TYPE_ORDER.join(', ')}; the changes of transaction types that have none are grouped without a ` +
      '`change_type`. `in` is the sum of the positive changes and `out` the sum of the negative ones as a positive amount; ' +
      '`in_value` and `out_value` are their values in the native currency (the native currency is worth itself, an issued ' +
      'amount its amount over the rate of its day, cut to 17 significant digits per change type, asset and day, and 0 ' +
      'without a rate; a change on a line the account owes on is a change of its own currency), and `net_value` is `in_value` ' +
      'minus `out_value`. `totals` has an entry for each change type that has a change, in that order. Without `interval` ' +
      '`rows` are per change type and asset (`issuer` is left out for the native currency), the largest `in_value + ' +
      'out_value` first; with one they are per bucket and change type, with `date` the start of the bucket. ' +
      `${WINDOW_DESCRIPTION} With an interval, at most ${MAX_ANALYTICS_BUCKETS} buckets. ` +
      '`format=csv` gives the rows as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'The first day. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'The last day, whole. Default: now.' })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ANALYTICS_INTERVALS,
    description:
      'Rows per bucket (day, week from Monday, month; UTC) and change type instead of per change type and asset.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async balanceChanges(@Param('address') address: string, @Query() query: QueryParams): Promise<BalanceChangesAnswer> {
    const window = analyticsWindow(query, Date.now(), 'optional');
    checkBucketLimit(window);
    return balanceChangesAnswer(window, await this.analytics.balanceChanges({ account: address, window }));
  }
}

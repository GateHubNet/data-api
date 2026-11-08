import { NetworkProfile, PeriodInterval } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { badRequest } from '../common/errors';
import { dateParam, endExclusive, first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { FLOWS_SCHEMA } from './schemas';
import { ANY_TOKEN_PARAM } from './token-history-docs';
import { parseAnyToken } from './token-history-param';
import { checkFlowsWindow, TokenHistoryReadsService } from './token-history-reads.service';

const FLOWS_INTERVALS: readonly PeriodInterval[] = ['day', 'hour', 'month'];
const COUNTERPARTIES_DEFAULT = 10;
const COUNTERPARTIES_MAX = 100;

/** `interval` of the flows: `day` (default), `hour` or `month`, else 400. */
export function parseFlowsInterval(q: QueryParams): PeriodInterval {
  const raw = first(q, 'interval');
  if (raw === undefined || raw === '') return 'day';
  if (!(FLOWS_INTERVALS as readonly string[]).includes(raw))
    throw badRequest('invalid interval - use: day, hour, month');
  return raw as PeriodInterval;
}

/** `counterparties`: 10 by default, at most 100; a text that is no whole number above 0 is the default, as `limit`'s is (R33). */
export function parseCounterparties(q: QueryParams): number {
  const n = Math.floor(Number(first(q, 'counterparties') ?? ''));
  if (!Number.isFinite(n) || n < 1) return COUNTERPARTIES_DEFAULT;
  return Math.min(n, COUNTERPARTIES_MAX);
}

/**
 * `GET /v2/tokens/{token}/flows` (issuer analytics, spec 5.6): what was issued, redeemed, clawed back and transferred in a window, by
 * period, and the holders that received and sent the most in it. Checks before any read: the token, `start` and `end` (both
 * required), `interval` and the window's size.
 */
@RippleController('v2/tokens')
export class TokenFlowsController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':token/flows')
  @RippleRoute('unable to retrieve token flows')
  @ApiOperation({
    summary: 'Get the flows of a token over a window',
    description:
      'The flows of the window `[start, end]` (`end` inclusive at its granularity; at most 366 days, 31 by the hour, else 400 ' +
      '`window too large`): `totals` and every `period` of the `interval` (UTC), the empty ones included: `issued`, `redeemed`, ' +
      '`clawed_back`, `transferred`, `transfers` and `unknown_before`. `exchanged` and `trades` are there only when the DEX history ' +
      'has every hour of the window. `counterparties` (default 10, at most 100) are the holders with the largest `received + sent` ' +
      'in the window, then by account. No CSV, no pagination.',
  })
  @ApiParam(ANY_TOKEN_PARAM)
  @ApiQuery({ name: 'start', required: true, description: 'The start of the window.' })
  @ApiQuery({ name: 'end', required: true, description: 'The end of the window, inclusive at its granularity.' })
  @ApiQuery({ name: 'interval', required: false, enum: [...FLOWS_INTERVALS], description: 'Default: day.' })
  @ApiQuery({ name: 'counterparties', required: false, type: Number, description: 'Default 10, at most 100.' })
  @ApiOkResponse({ schema: FLOWS_SCHEMA as never })
  async flows(@Param('token') raw: string, @Query() query: QueryParams): Promise<Record<string, unknown>> {
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const start = dateParam(query, 'start', 'invalid start date format');
    const end = dateParam(query, 'end', 'invalid end date format');
    if (start === undefined) throw badRequest('invalid start date format');
    if (end === undefined) throw badRequest('invalid end date format');
    const interval = parseFlowsInterval(query);
    const window = {
      start: Math.floor(start.date.getTime() / 1000),
      end: Math.ceil(endExclusive(end).getTime() / 1000),
    };
    checkFlowsWindow(window.start, window.end, interval);
    const counterparties = parseCounterparties(query);
    this.reads.assertPossible(token);
    const live = await this.reads.live();
    await this.reads.assertToken(live, token);
    return { ...(await this.reads.flows(live, token, { ...window, interval, counterparties })) };
  }
}

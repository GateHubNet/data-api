import { NetworkProfile, SeriesInterval } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters would otherwise make Nest's metadata `require('express')`
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { decodeMarker, setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { parseExclude } from './exclude-param';
import { SUPPLY_SCHEMA } from './schemas';
import { ANY_TOKEN_PARAM, EXCLUDE_QUERY } from './token-history-docs';
import { toSupplyCsvRow } from './token-history-objects';
import { anyTokenFileStem, parseAnyToken } from './token-history-param';
import { TokenHistoryReadsService } from './token-history-reads.service';

const SERIES_INTERVALS: readonly SeriesInterval[] = ['day', 'hour', 'ledger'];
const supplyFilename = (req: Request): string => `${anyTokenFileStem(String(req.params.token))} - supply`;

/** `interval` of the supply series: `day` (default), `hour` or `ledger`, else 400. */
export function parseSeriesInterval(q: QueryParams): SeriesInterval {
  const raw = first(q, 'interval');
  if (raw === undefined || raw === '') return 'day';
  if (!(SERIES_INTERVALS as readonly string[]).includes(raw))
    throw badRequest('invalid interval - use: day, hour, ledger');
  return raw as SeriesInterval;
}

/**
 * `GET /v2/tokens/{token}/supply` (issuer analytics, spec 5.3): the supply, holders and trust lines of a token over time, by hour, by
 * day or at every ledger with a change, with the flows of each row. Checks before any read: the token, `interval`, `start`, `end`,
 * the marker and `exclude`.
 */
@RippleController('v2/tokens')
export class TokenSupplyController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':token/supply')
  @RippleRoute('unable to retrieve token supply')
  @Csv(supplyFilename, 'rows')
  @ApiOperation({
    summary: 'Get the supply series of a token',
    description:
      'The token over time: by `hour` or `day` (UTC), every bucket of the window with the levels at its end (`supply`, `holders`, ' +
      '`trust_lines`, carried forward through buckets without a change, and `ledger_index`, the newest change they are as of) and ' +
      'the flows in it (`issued`, `redeemed`, `clawed_back`, `net` = issued − redeemed − clawed back, `unknown_before`); by ' +
      '`ledger`, every ledger with a change of the token, at most 100,000 ledgers. `start` defaults to the first change of the ' +
      'token, `end` (inclusive at its granularity) to the newest ledger of the token history. With `exclude` every row adds ' +
      '`without_excluded`. `format=csv` gives `<code or currency> <issuer> - supply.csv`.',
  })
  @ApiParam(ANY_TOKEN_PARAM)
  @ApiQuery({ name: 'interval', required: false, enum: [...SERIES_INTERVALS], description: 'Default: day.' })
  @ApiQuery({
    name: 'start',
    required: false,
    description: 'The start of the window. Default: the first change of the token.',
  })
  @ApiQuery({
    name: 'end',
    required: false,
    description: 'The end of the window, inclusive at its granularity. Default: now.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first. Default false.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery(EXCLUDE_QUERY)
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  @ApiOkResponse({ schema: SUPPLY_SCHEMA as never })
  async supply(
    @Param('token') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const interval = parseSeriesInterval(query);
    const start = first(query, 'start') === '' ? undefined : dateParam(query, 'start', 'invalid start date format');
    const end = first(query, 'end') === '' ? undefined : dateParam(query, 'end', 'invalid end date format');
    const after = decodeMarker(first(query, 'marker'), [
      { column: interval === 'ledger' ? 'ledger_index' : 'time', type: 'UInt32' },
    ]);
    const exclude = parseExclude(query);
    const descending = bool(query, 'descending');
    const limit = limitParam(query, { def: 200, max: 1000 });
    this.reads.assertPossible(token);
    const live = await this.reads.live();
    await this.reads.assertToken(live, token);
    const { answer, marker } = await this.reads.supply(live, token, {
      interval,
      start: start === undefined ? undefined : Math.floor(start.date.getTime() / 1000),
      end: end === undefined ? undefined : Math.ceil(endExclusive(end).getTime() / 1000),
      descending,
      after: after?.[0] as number | undefined,
      limit,
      exclude,
    });
    setLinkHeader(req, res, marker);
    return wantsCsv(query) ? { ...answer, rows: answer.rows.map(toSupplyCsvRow) } : { ...answer };
  }
}

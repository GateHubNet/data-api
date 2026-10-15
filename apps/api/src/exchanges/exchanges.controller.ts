import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { parseAssetPair, splitAsset } from '../common/asset-param';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { AggregateCsvRow, CandleObject, ReducedObject, toAggregateCsvRow } from './exchange-aggregate';
import { EXCHANGE_INTERVALS, ExchangeInterval, isExchangeInterval, readInterval } from './exchange-intervals';
import { ExchangeObject, toCsvRow } from './exchange-object';
import { ExchangesService, ExchangesWindow } from './exchanges.service';

type ExchangesRows =
  | ExchangeObject[]
  | ReturnType<typeof toCsvRow>[]
  | (CandleObject | ReducedObject)[]
  | AggregateCsvRow[];

interface ExchangesBody {
  result: 'success';
  count: number;
  marker?: string;
  exchanges: ExchangesRows;
}

/**
 * The name of the CSV file, as `getExchanges.js` has it: `exchanges - <base>-<counter>` of the path, the currencies in
 * the order they were asked for. `@Csv` adds the `.csv`. The path has been validated by the time the answer is built.
 */
function pairCsvFilename(req: Request): string {
  return `exchanges - ${splitAsset(req.params.base).currency}-${splitAsset(req.params.counter).currency}`;
}

/**
 * `GET /v2/exchanges/:base/:counter` (`api/routes/getExchanges.js`) and, as a GateHub extra, `GET /v2/exchanges`, the
 * exchanges of every pair.
 *
 * The pair route answers the raw exchanges, or with `interval` the candles of the pair and with `reduce=true` one row
 * of all its exchanges (the aggregated path of the original, read right after `window()`).
 */
@RippleController('v2/exchanges')
export class ExchangesController {
  constructor(
    private readonly exchanges: ExchangesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':base/:counter')
  @RippleRoute('unable to retrieve exchanges')
  @Csv(pairCsvFilename, 'exchanges')
  @ApiOperation({
    summary: 'Get the exchanges of a pair',
    description:
      'The trades between `base` and `counter` of the ledgers that closed between `start` and `end`, oldest first. A ' +
      'pair asked for in the reverse order of the stored one is inverted: base and counter, buyer and seller swap ' +
      'and the rate is 1/rate. With `interval`, the candles of the buckets that start between `start` and `end` ' +
      '(open, high, low, close, vwap, volumes, count); with `reduce=true`, one such row of the whole window. An ' +
      'exchange whose native leg is 0.0005 or less is left out of both. `format=csv` gives the rows as a CSV file.',
  })
  @ApiParam({
    name: 'base',
    description: 'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone.',
  })
  @ApiParam({ name: 'counter', description: 'The other side of the pair, written like `base`.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: [...EXCHANGE_INTERVALS, 'week'],
    description: 'Candles of this interval (`week` is `7day`, the ISO week) instead of the exchanges.',
  })
  @ApiQuery({
    name: 'reduce',
    required: false,
    type: Boolean,
    description: 'One row of all the exchanges of the window. Not with `interval`.',
  })
  @ApiQuery({ name: 'autobridged', required: false, type: Boolean, description: 'Only the autobridged exchanges.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 400.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async pair(
    @Param('base') baseRaw: string,
    @Param('counter') counterRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExchangesBody> {
    // the checks come in the order of the original: the pair, start, end, limit, reduce with interval, interval
    const { base, counter } = parseAssetPair(baseRaw, counterRaw, this.profile.nativeCurrency);
    const window = this.window(query);
    const { interval, reduce } = this.aggregation(query);
    const csv = wantsCsv(query);

    if (reduce) {
      // the whole window, so no page and no marker
      const reduced = await this.exchanges.reduce({ base, counter, ...window });
      return { result: 'success', count: 1, exchanges: csv ? [toAggregateCsvRow(reduced)] : [reduced] };
    }
    if (interval !== undefined) {
      const page = await this.exchanges.candles({ base, counter, ...window, interval });
      return this.answer(req, res, csv ? page.candles.map(toAggregateCsvRow) : page.candles, page.marker);
    }
    const page = await this.exchanges.pair({ base, counter, ...window });
    return this.answer(req, res, csv ? page.exchanges.map(toCsvRow) : page.exchanges, page.marker);
  }

  /** GateHub extra: the exchanges of every pair, as stored (the pair in canonical order), oldest first. */
  @Get()
  @RippleRoute('unable to retrieve exchanges')
  @Csv('exchanges', 'exchanges')
  @ApiOperation({
    summary: 'Get the exchanges of every pair',
    description:
      'The trades of all pairs of the ledgers that closed between `start` and `end`, oldest first, each with the pair ' +
      'it is stored under. Reads every exchange of the range: ask for a window.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'autobridged', required: false, type: Boolean, description: 'Only the autobridged exchanges.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 400.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async all(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExchangesBody> {
    const page = await this.exchanges.all(this.window(query));
    return this.answer(req, res, wantsCsv(query) ? page.exchanges.map(toCsvRow) : page.exchanges, page.marker);
  }

  /**
   * What both routes read after the pair: `start` (2013-01-01 when missing or empty), `end`, `limit` (200, at most 400;
   * a text that is not a number answers `invalid limit: NaN`, as the original did), `autobridged`, `descending` and
   * the `marker`, which the service checks.
   */
  private window(query: QueryParams): ExchangesWindow & { start: Date } {
    const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
    const end = dateParam(query, 'end', 'invalid end date format');
    const limit = limitParam(query, { def: 200, max: 400, nanError: 'invalid limit: NaN' });
    return {
      start: start.date,
      ...(end && { endExclusive: endExclusive(end) }),
      autobridged: bool(query, 'autobridged'),
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    };
  }

  /**
   * `interval` and `reduce`, after the window, in the order of the original: both together are an error (whatever the
   * interval), then an interval must be one of the list. The interval is lowercased first, and `week` is `7day`; the
   * message has the lowercased text. The original skipped the interval check when the limit was over 400 (its checks
   * were one `else if` chain with the clamp in it) and then failed with a 500; it is checked whatever the limit here.
   */
  private aggregation(query: QueryParams): { interval?: ExchangeInterval; reduce: boolean } {
    const interval = readInterval(first(query, 'interval'));
    const reduce = bool(query, 'reduce');
    if (reduce && interval !== undefined) throw badRequest('cannot use reduce with interval');
    if (interval === undefined) return { reduce };
    if (!isExchangeInterval(interval)) throw badRequest(`invalid interval: ${interval}`);
    return { interval, reduce };
  }

  /** The body of a page, and the Link header for the next one (CSV too). */
  private answer(req: Request, res: Response, rows: ExchangesRows, marker: string | undefined): ExchangesBody {
    setLinkHeader(req, res, marker);
    return { result: 'success', count: rows.length, marker, exchanges: rows };
  }
}

import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { parseAssetPair, splitAsset } from '../common/asset-param';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { ExchangeObject, toCsvRow } from './exchange-object';
import { ExchangesPage, ExchangesService, ExchangesWindow } from './exchanges.service';

interface ExchangesBody {
  result: 'success';
  count: number;
  marker?: string;
  exchanges: ExchangeObject[] | ReturnType<typeof toCsvRow>[];
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
 * The pair route is the raw path of the original. Its `interval` and `reduce` parameters (the aggregated path) belong
 * to the same route: they are read where `window()` has been read, and answer from the aggregated rows instead of
 * `ExchangesService.pair`.
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
      'and the rate is 1/rate. `format=csv` gives the exchanges as a CSV file.',
  })
  @ApiParam({
    name: 'base',
    description: 'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone.',
  })
  @ApiParam({ name: 'counter', description: 'The other side of the pair, written like `base`.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
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
    // the checks come in the order of the original: the pair, start, end, limit
    const { base, counter } = parseAssetPair(baseRaw, counterRaw, this.profile.nativeCurrency);
    const window = this.window(query);

    const page = await this.exchanges.pair({ base, counter, ...window });
    return this.answer(query, req, res, page);
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
    return this.answer(query, req, res, page);
  }

  /**
   * What both routes read after the pair: `start` (2013-01-01 when missing or empty), `end`, `limit` (200, at most 400;
   * a text that is not a number answers `invalid limit: NaN`, as the original did), `autobridged`, `descending` and
   * the `marker`, which the service checks.
   */
  private window(query: QueryParams): ExchangesWindow {
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

  /** The body of a page: the Link header for the next one (CSV too), and the rows in the columns of the CSV if asked. */
  private answer(query: QueryParams, req: Request, res: Response, page: ExchangesPage): ExchangesBody {
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.exchanges.length,
      marker: page.marker,
      exchanges: wantsCsv(query) ? page.exchanges.map(toCsvRow) : page.exchanges,
    };
  }
}

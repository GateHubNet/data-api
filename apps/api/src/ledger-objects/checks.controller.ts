import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { CheckBody, ObjectAnswers, ObjectHistoryBody } from './object-answers';
import { objectIdParam } from './object-params';

/** The name of the CSV file of the history of a check: `<id> - check history`. `@Csv` adds the `.csv`. */
const historyFilename = (req: Request): string => `${String(req.params.check_id).toUpperCase()} - check history`;

/**
 * The check routes under `/v2/checks` (GateHub extras, no Ripple original): the check by its ID and its history. The id is
 * 64 hex digits in any case, answered in upper case; 400 `invalid check id` otherwise, and 404 `check not found` for an id
 * that has no row in a committed ledger (a check created before the index starts is such an id until it is touched). The
 * `coverage`, the key after `result`, is the check's own: complete when its creation is indexed (spec 1.4).
 */
@RippleController('v2/checks')
export class ChecksController {
  constructor(private readonly answers: ObjectAnswers) {}

  @Get(':check_id')
  @RippleRoute('unable to retrieve check')
  @ApiOperation({
    summary: 'Get a check',
    description:
      'The check with the ID, as of the newest committed ledger: its owner (`account`), destination, `send_max`, `expiration` ' +
      'and `status` (`open`, `expired`, or once deleted `cashed`, `cancelled` or `removed`, with `removed` naming the ' +
      'transaction that deleted it and `delivered` what a cash delivered), and the newest 50 transactions that changed it. ' +
      '`history_marker` continues them at `/v2/checks/{id}/history?descending=true`.',
  })
  @ApiParam({ name: 'check_id', description: 'The 64 hex digits of the check ID, in any case.' })
  detail(@Param('check_id') idRaw: string): Promise<CheckBody> {
    return this.answers.check(objectIdParam(idRaw, 'invalid check id'));
  }

  @Get(':check_id/history')
  @RippleRoute('unable to retrieve check history')
  @Csv(historyFilename, 'history')
  @ApiOperation({
    summary: 'Get the history of a check',
    description:
      'The transactions that changed the check (created, cashed, cancelled, or removed), oldest first, or newest first with ' +
      '`descending=true`. `format=csv` gives the events as a CSV file (without `coverage`).',
  })
  @ApiParam({ name: 'check_id', description: 'The 64 hex digits of the check ID, in any case.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async history(
    @Param('check_id') idRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ObjectHistoryBody> {
    // the parameters are checked in their order: the id, then the limit (it has no error) and the marker (the service)
    const id = objectIdParam(idRaw, 'invalid check id');
    const body = await this.answers.history('check', id, {
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
      csv: wantsCsv(query),
    });
    setLinkHeader(req, res, body.marker);
    return body;
  }
}

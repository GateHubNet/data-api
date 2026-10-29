import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { EscrowBody, ObjectAnswers, ObjectHistoryBody } from './object-answers';
import { objectIdParam } from './object-params';

/** The name of the CSV file of the history of an escrow: `<id> - escrow history`. `@Csv` adds the `.csv`. */
const historyFilename = (req: Request): string => `${String(req.params.escrow_id).toUpperCase()} - escrow history`;

/**
 * The escrow routes under `/v2/escrows` (GateHub extras, no Ripple original): the escrow by its ID and its history. The id is
 * 64 hex digits in any case, answered in upper case; 400 `invalid escrow id` otherwise, and 404 `escrow not found` for an id
 * that has no row in a committed ledger (an escrow created before the index starts is such an id until it is touched). The
 * `coverage`, the key after `result`, is the escrow's own: complete when its creation is indexed (spec 1.4).
 */
@RippleController('v2/escrows')
export class EscrowsController {
  constructor(private readonly answers: ObjectAnswers) {}

  @Get(':escrow_id')
  @RippleRoute('unable to retrieve escrow')
  @ApiOperation({
    summary: 'Get an escrow',
    description:
      'The escrow with the ID, as of the newest committed ledger: its owner (`account`), destination, amount, times, condition ' +
      'and `status` (`pending`, `can_be_finished`, `can_be_cancelled`, or once deleted `finished`, `cancelled` or `removed`, ' +
      'with `removed` naming the transaction that deleted it), and the newest 50 transactions that changed it. ' +
      '`history_marker` continues them at `/v2/escrows/{id}/history?descending=true`.',
  })
  @ApiParam({ name: 'escrow_id', description: 'The 64 hex digits of the escrow ID, in any case.' })
  detail(@Param('escrow_id') idRaw: string): Promise<EscrowBody> {
    return this.answers.escrow(objectIdParam(idRaw, 'invalid escrow id'));
  }

  @Get(':escrow_id/history')
  @RippleRoute('unable to retrieve escrow history')
  @Csv(historyFilename, 'history')
  @ApiOperation({
    summary: 'Get the history of an escrow',
    description:
      'The transactions that changed the escrow (created, finished, cancelled, or removed), oldest first, or newest first with ' +
      '`descending=true`. `format=csv` gives the events as a CSV file (without `coverage`).',
  })
  @ApiParam({ name: 'escrow_id', description: 'The 64 hex digits of the escrow ID, in any case.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async history(
    @Param('escrow_id') idRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ObjectHistoryBody> {
    // the parameters are checked in their order: the id, then the limit (it has no error) and the marker (the service)
    const id = objectIdParam(idRaw, 'invalid escrow id');
    const body = await this.answers.history('escrow', id, {
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
      csv: wantsCsv(query),
    });
    setLinkHeader(req, res, body.marker);
    return body;
  }
}

import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { paginate, setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { CsvRow } from '../nft/nft-objects';
import { DETAIL_EVENTS, FEATURE_OF, LedgerObjectsService, ObjectDetail, ObjectHistory } from './ledger-objects.service';
import { objectIdParam } from './object-params';
import { EscrowObject, escrowObject, ObjectEvent, objectEvent, objectEventCsvRow } from './object-views';

/** The name of the CSV file of the history of an escrow: `<id> - escrow history`. `@Csv` adds the `.csv`. */
const historyFilename = (req: Request): string => `${String(req.params.escrow_id).toUpperCase()} - escrow history`;

/** `GET /v2/escrows/{id}`: the keys are `DETAIL_BODY_KEYS.escrow`, in this order. */
export interface EscrowBody {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  escrow: EscrowObject;
  history: ObjectEvent[];
  history_marker?: string;
}

/** `GET /v2/escrows/{id}/history`: the keys are `HISTORY_BODY_KEYS`, in this order; `history` is the CSV rows for `format=csv`. */
export interface EscrowHistoryBody {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  count: number;
  marker?: string;
  history: ObjectEvent[] | CsvRow[];
}

/**
 * The answer of the detail of an escrow, from what the service read: the escrow as of the newest committed ledger (its status
 * is evaluated at that ledger's close time), its newest `DETAIL_EVENTS` events, and `history_marker` when there are more (it
 * continues `/{id}/history?descending=true`). Shared by `GET /v2/escrows/{id}` and the owner and sequence route.
 */
export function escrowBody(detail: ObjectDetail, coverage: Coverage, native: string): EscrowBody {
  const { asOf, rows, created } = detail;
  const page = paginate(rows, DETAIL_EVENTS, (row) => [row.ledger_index, row.tx_index]);
  return {
    result: 'success',
    coverage,
    ledger_index: asOf.ledger_index,
    close_time: fmtTime(asOf.close_time),
    escrow: escrowObject(rows[0], created, asOf.close_time, native),
    history: page.rows.map((row) => objectEvent(row, native)),
    ...(page.marker !== undefined && { history_marker: page.marker }),
  };
}

/**
 * The escrow routes under `/v2/escrows` (GateHub extras, no Ripple original): the escrow by its ID and its history. The id is
 * 64 hex digits in any case, answered in upper case; 400 `invalid escrow id` otherwise, and 404 `escrow not found` for an id
 * that has no row in a committed ledger (an escrow created before the index starts is such an id until it is touched). The
 * `coverage`, the key after `result`, is the escrow's own: complete when its creation is indexed (spec 1.4).
 */
@RippleController('v2/escrows')
export class EscrowsController {
  constructor(
    private readonly objects: LedgerObjectsService,
    private readonly coverage: FeatureCoverageService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

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
  async detail(@Param('escrow_id') idRaw: string): Promise<EscrowBody> {
    const id = objectIdParam(idRaw, 'invalid escrow id');
    const detail = await this.objects.detail('escrow', id);
    const coverage = await this.coverage.itemCoverage(FEATURE_OF.escrow, detail.created?.ledger_index);
    return escrowBody(detail, coverage, this.profile.nativeCurrency);
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
  ): Promise<EscrowHistoryBody> {
    // the checks come in the order of the params: the id, then the limit (it has no error) and the marker (the service)
    const id = objectIdParam(idRaw, 'invalid escrow id');
    const limit = limitParam(query, { def: 200, max: 1000 });
    const found: ObjectHistory = await this.objects.history('escrow', id, {
      descending: bool(query, 'descending'),
      limit,
      marker: first(query, 'marker'),
    });
    const coverage = await this.coverage.itemCoverage(FEATURE_OF.escrow, found.created?.ledger_index);
    setLinkHeader(req, res, found.marker);
    const native = this.profile.nativeCurrency;
    const events = found.rows.map((row) => objectEvent(row, native));
    return {
      result: 'success',
      coverage,
      ledger_index: found.asOf.ledger_index,
      close_time: fmtTime(found.asOf.close_time),
      count: events.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      history: wantsCsv(query) ? events.map((event) => objectEventCsvRow(event, 'escrow')) : events,
    };
  }
}

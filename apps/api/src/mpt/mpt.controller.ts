import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, toCsvRow, wantsCsv } from '../common/csv.interceptor';
import { notFound } from '../common/errors';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { MptHoldersService } from './mpt-holders.service';
import {
  MPT_HOLDER_KEYS,
  MPT_TRANSFER_KEYS,
  MPT_TRANSFER_KINDS,
  toMptHolder,
  toMptIssuance,
  toMptSummary,
  toMptTransfer,
} from './mpt-objects';
import { decodeMptHoldersMarker, parseIdsParam, parseIssuanceIdParam, parseKindsParam } from './mpt-param';
import { decodeMptTransfersMarker, MptTransfersService } from './mpt-transfers.service';
import { MptService } from './mpt.service';

/** The documentation of the segment of the path that names an issuance. */
const ISSUANCE_PARAM = {
  name: 'issuanceId',
  description: 'The ID of the issuance: 48 hex digits in either case, answered in upper case.',
} as const;

/** The name of a CSV file of an issuance, `<issuanceId> - <list>` in upper case whatever the path's case (`@Csv` adds the `.csv`). */
const csvFilename =
  (list: string) =>
  (req: Request): string =>
    `${String(req.params.issuanceId).toUpperCase()} - ${list}`;

/**
 * The MPT issuances (spec 7): one, a lookup of several, and the holders and the transfers of one. A route that names an issuance
 * checks the ID first, and its answer states `coverage`, the key after `result`, which is the feature `mpt`. On a network without MPT
 * no route reads an MPT table: an issuance is a 404 and a lookup bare IDs (`MptService`).
 */
@RippleController('v2/mpt')
export class MptController {
  constructor(
    private readonly mpt: MptService,
    private readonly holderPages: MptHoldersService,
    private readonly transferPages: MptTransfersService,
    private readonly coverage: FeatureCoverageService,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve issuances')
  @ApiOperation({
    summary: 'Look up several MPT issuances',
    description:
      'A summary of each of 1 to 100 issuances, in the order asked, duplicates too. An ID with no row, or whose state is not known, ' +
      'is the ID alone, as is every ID on a network without MPT. No coverage, no paging, no CSV.',
  })
  @ApiQuery({ name: 'ids', required: true, description: 'A comma list of 1 to 100 issuance IDs.' })
  async lookup(@Query() query: QueryParams): Promise<Record<string, unknown>> {
    const ids = parseIdsParam(query);
    const found = await this.mpt.issuances(ids);
    return {
      result: 'success',
      count: ids.length,
      issuances: ids.map((id) => {
        const row = found.get(id);
        return row === undefined || row.state_known === 0 ? { mpt_issuance_id: id } : toMptSummary(row);
      }),
    };
  }

  @Get(':issuanceId')
  @RippleRoute('unable to retrieve issuance')
  @ApiOperation({
    summary: 'Get an MPT issuance',
    description:
      "One issuance as of the last run of the `mpt_state` job: its issuer and sequence, the ticker and name of its metadata, the ledger's " +
      'integer units of its maximum, outstanding, escrowed and locked amounts (`asset_scale` says how to show them), its holders, ' +
      'transfer fee and flags, its metadata (`metadata` only when it was decoded; `metadata_hex` and `metadata_conforms` when it has ' +
      'any), its creation when that is in the coverage, and `destroyed`. No row, a state outside the coverage or newer than the last ' +
      'tick, and every ID on a network without MPT are a 404 `issuance not found`. No CSV.',
  })
  @ApiParam(ISSUANCE_PARAM)
  async issuance(@Param('issuanceId') raw: string): Promise<Record<string, unknown>> {
    const id = parseIssuanceIdParam(raw);
    const row = await this.mpt.issuance(id);
    if (row === undefined || row.state_known === 0) throw notFound('issuance not found');
    return { result: 'success', coverage: await this.coverage.coverage('mpt'), issuance: toMptIssuance(row) };
  }

  @Get(':issuanceId/holders')
  @RippleRoute('unable to retrieve holders')
  @Csv(csvFilename('holders'), 'holders')
  @ApiOperation({
    summary: 'Get the holders of an MPT issuance',
    description:
      'The balances of an issuance as of the last run of the `mpt_state` job, the largest first (`amount`, the integer units the holder ' +
      'can move, and `escrowed_amount`, those it has in escrow, count together), then by address. `locked` says the balance cannot ' +
      "move, by the holder's own flag or the issuance's; `authorized` is the holder's flag, which means something when the issuance " +
      'requires it. `include_zero` adds the holders with nothing. An issuance whose state is not known is served; no row is a 404 ' +
      '`issuance not found`, as is every ID on a network without MPT. `format=csv` gives the holders as a CSV file ' +
      '`<issuanceId> - holders.csv` (without `coverage`).',
  })
  @ApiParam(ISSUANCE_PARAM)
  @ApiQuery({ name: 'include_zero', required: false, type: Boolean, description: 'Also the holders with nothing.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async holders(
    @Param('issuanceId') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    // everything the request can get wrong is checked before the first read
    const id = parseIssuanceIdParam(raw);
    const after = decodeMptHoldersMarker(first(query, 'marker'));
    const issuance = await this.mpt.issuance(id);
    if (issuance === undefined) throw notFound('issuance not found');
    const page = await this.holderPages.page(id, {
      includeZero: bool(query, 'include_zero'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      ...(after && { after }),
    });
    const coverage = await this.coverage.coverage('mpt');
    setLinkHeader(req, res, page.marker);
    const holders = page.rows.map((row) => toMptHolder(row, issuance.flags));
    return {
      result: 'success',
      coverage,
      count: holders.length,
      ...(page.marker !== undefined && { marker: page.marker }),
      holders: wantsCsv(query) ? holders.map((holder) => toCsvRow(holder, MPT_HOLDER_KEYS)) : holders,
    };
  }

  @Get(':issuanceId/transfers')
  @RippleRoute('unable to retrieve transfers')
  @Csv(csvFilename('transfers'), 'transfers')
  @ApiOperation({
    summary: 'Get the transfers of an MPT issuance',
    description:
      'What the successful transactions of the ledgers that closed between `start` and `end` moved, clawed back, locked or unlocked ' +
      'of an issuance, oldest first. `amount` is integer units; `source` and `destination` are left out where there is none (a lock ' +
      'of every balance has no destination) and `fee`, the transfer fee burned, unless it is above 0. `kind` and `account` (on either ' +
      'side, not validated) keep those rows. An issuance whose state is not known is served; no row is a 404 `issuance not found`, as ' +
      'is every ID on a network without MPT. `format=csv` gives the transfers as a CSV file `<issuanceId> - transfers.csv` (without ' +
      '`coverage`).',
  })
  @ApiParam(ISSUANCE_PARAM)
  @ApiQuery({
    name: 'kind',
    required: false,
    description: `A comma list of ${MPT_TRANSFER_KINDS.join(', ')}. Default: all.`,
  })
  @ApiQuery({
    name: 'account',
    required: false,
    description: 'Only the rows with this account as source or destination.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the beginning.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async transfers(
    @Param('issuanceId') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    // the checks, in order, before the first read: the ID, start (an empty one is none), end, kind, the marker
    const id = parseIssuanceIdParam(raw);
    const start = first(query, 'start') === '' ? undefined : dateParam(query, 'start', 'invalid start date format');
    const end = dateParam(query, 'end', 'invalid end date format');
    const kinds = parseKindsParam(query);
    const after = decodeMptTransfersMarker(first(query, 'marker'));
    if ((await this.mpt.issuance(id)) === undefined) throw notFound('issuance not found');
    const account = first(query, 'account') || undefined;
    const page = await this.transferPages.page(id, {
      ...(start && { start: start.date }),
      ...(end && { endExclusive: endExclusive(end) }),
      ...(kinds && { kinds }),
      ...(account !== undefined && { account }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      ...(after && { after }),
    });
    const coverage = await this.coverage.coverage('mpt');
    setLinkHeader(req, res, page.marker);
    const transfers = page.rows.map(toMptTransfer);
    return {
      result: 'success',
      coverage,
      count: transfers.length,
      ...(page.marker !== undefined && { marker: page.marker }),
      transfers: wantsCsv(query) ? transfers.map((transfer) => toCsvRow(transfer, MPT_TRANSFER_KEYS)) : transfers,
    };
  }
}

import { Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { notFound } from '../common/errors';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { toMptIssuance, toMptSummary } from './mpt-objects';
import { parseIdsParam, parseIssuanceIdParam } from './mpt-param';
import { MptService } from './mpt.service';

/** The documentation of the segment of the path that names an issuance. */
const ISSUANCE_PARAM = {
  name: 'issuanceId',
  description: 'The ID of the issuance: 48 hex digits in either case, answered in upper case.',
} as const;

/**
 * The MPT issuances (spec 7): one, a lookup of several, and the holders and the transfers of one. A route that names an issuance
 * checks the ID first, and its answer states `coverage`, the key after `result`, which is the feature `mpt`. On a network without MPT
 * no route reads an MPT table: an issuance is a 404 and a lookup bare IDs (`MptService`).
 */
@RippleController('v2/mpt')
export class MptController {
  constructor(
    private readonly mpt: MptService,
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
}

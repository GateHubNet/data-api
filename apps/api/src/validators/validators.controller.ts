import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ApiConfig } from '../config/api.config';
import { AmendmentsService } from './amendments.service';
import { routeCacheControl, VALIDATORS_CACHE_CONTROL } from './cache-control';
import { buildSummary, ValidatorsSummary } from './summary-object';
import { ValidatorDirectoryService } from './validator-directory.service';
import { parseValidatorKey, resolveValidator } from './validator-key';
import { buildValidatorsBody, validatorDetail, ValidatorDetail, ValidatorsBody } from './validator-object';
import { listValidators, parseListQuery } from './validators-query';

/** The message of the routes of the validators when something other than a Ripple 4xx goes wrong. */
const FAILURE = 'unable to retrieve validator(s)';

/**
 * `GET /v2/network/validators/summary`, `GET /v2/network/validators` and `GET /v2/network/validators/{key}` (spec 3.1 to 3.3).
 * The routes with a validator key come after `summary` in this controller, so that `summary` is never read as a key.
 *
 * The list and the validator are built on the assembly of the amendments (which holds the directory it was built on): their
 * votes name the amendments they vote for, and the detail lists the ones still being decided. One request, one directory.
 */
@RippleController('v2/network/validators')
export class ValidatorsController {
  constructor(
    private readonly directory: ValidatorDirectoryService,
    private readonly amendments: AmendmentsService,
    private readonly config: ApiConfig,
  ) {}

  @Get('summary')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get the summary of the validators of the network',
    description:
      'The figures of the Validators board: the validators seen in the last 24 hours, the trusted UNL with its publishers and ' +
      'the quorum, the negative UNL, the fees, the next flag ledger, the software versions and how far the agreement and the ' +
      'votes are computed. There are no parameters.',
  })
  async summary(@Res({ passthrough: true }) res: Response): Promise<ValidatorsSummary> {
    const summary = buildSummary(await this.directory.get());
    this.setCacheControl(res);
    return summary;
  }

  @Get()
  @RippleRoute(FAILURE)
  @Csv('validators', 'validators')
  @ApiOperation({
    summary: 'Get the validators of the network',
    description:
      'The validators of the trusted UNL, or of the UNL and every validator seen in the last 24 hours, with their agreement, ' +
      'their domain and its verification, the lists they are on, their software version, and what they vote for: fees and ' +
      'amendments. Validators with a domain come first, by domain, then the others by key. `format=csv` gives the rows as a ' +
      'CSV file.',
  })
  @ApiQuery({ name: 'scope', required: false, enum: ['unl', 'all'], description: 'Default: unl.' })
  @ApiQuery({
    name: 'publisher',
    required: false,
    description: 'The id of a publisher of the summary: its list in use.',
  })
  @ApiQuery({
    name: 'amendment',
    required: false,
    description: 'The name or the ID (64 hex digits) of an amendment: the validators that vote for it.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A part of the domain, the master key or the signing key (at most 100 characters).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ValidatorsBody> {
    const assembly = await this.amendments.get();
    // the checks come in the order of the specification: scope, publisher, amendment, q, marker, limit
    const request = parseListQuery(query, assembly.directory, (name) => this.amendments.find(assembly, name)?.id);
    const page = listValidators(assembly.directory, request);
    const body = buildValidatorsBody(page.rows, page.marker, assembly);
    setLinkHeader(req, res, page.marker);
    this.setCacheControl(res);
    return body;
  }

  /** The flat validator object plus `result`: JSON only, as the original's was. */
  @Get(':key')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get a validator of the network',
    description:
      'One validator by its master key, its signing key or 66 hex digits: the row of the list, its vote on every amendment ' +
      'being decided, its manifest and its agreement of each of the last 30 days. JSON only.',
  })
  @ApiParam({
    name: 'key',
    description: 'A master key (nH...), a signing key (n9...) or 66 hex digits (02, 03 or ED first).',
  })
  async detail(@Param('key') raw: string, @Res({ passthrough: true }) res: Response): Promise<ValidatorDetail> {
    const key = parseValidatorKey(raw);
    const assembly = await this.amendments.get();
    const body = validatorDetail(resolveValidator(assembly.directory, key), assembly);
    this.setCacheControl(res);
    return body;
  }

  private setCacheControl(res: Response): void {
    const cacheControl = routeCacheControl(this.config, VALIDATORS_CACHE_CONTROL);
    if (cacheControl !== undefined) res.setHeader('Cache-Control', cacheControl);
  }
}

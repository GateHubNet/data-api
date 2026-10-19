import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameter below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest, notFound } from '../common/errors';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { AmendmentDetail, AmendmentsBody, buildAmendmentDetail, buildAmendmentsBody } from './amendment-object';
import { parseStatuses } from './amendment-status';
import { AmendmentsService } from './amendments.service';
import { AMENDMENTS_CACHE_CONTROL, routeCacheControl } from './cache-control';

/** The message of both routes when something other than a Ripple 4xx goes wrong. */
const FAILURE = 'unable to retrieve amendments';

/**
 * `GET /v2/network/amendments` and `GET /v2/network/amendments/{name}` (spec 3.5, 3.6): the amendments the network knows, with
 * their status, votes and history. The answers are built from the assembly `AmendmentsService` keeps for 10 s.
 */
@RippleController('v2/network/amendments')
export class AmendmentsController {
  constructor(
    private readonly amendments: AmendmentsService,
    private readonly config: ApiConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get()
  @RippleRoute(FAILURE)
  @Csv('amendments', 'amendments')
  @ApiOperation({
    summary: 'Get the amendments of the network',
    description:
      'Every amendment the network knows: enabled, with a majority, voting, obsolete or unknown, with the votes of the newest ' +
      'voting round and, for the enabled ones, when they were enabled. The answer states the rules, the newest round and ' +
      'the next flag ledger. `format=csv` gives the amendments as a CSV file.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'A comma list of enabled, majority, voting, obsolete and unknown. Default: all.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(@Query() query: QueryParams, @Res({ passthrough: true }) res: Response): Promise<AmendmentsBody> {
    const statuses = parseStatuses(first(query, 'status'));
    if (statuses === undefined) throw badRequest('invalid status');
    const body = buildAmendmentsBody(await this.amendments.get(), this.profile, statuses);
    this.setCacheControl(res);
    return body;
  }

  @Get(':name')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get an amendment of the network',
    description:
      'One amendment by its name or its ID, with the envelope of the list, how each validator votes on it, its rounds of the ' +
      'last 30 days and its history. JSON only.',
  })
  @ApiParam({
    name: 'name',
    description:
      'The name of the amendment (as written, else in any case when only one has it) or its ID (64 hex digits).',
  })
  async detail(@Param('name') name: string, @Res({ passthrough: true }) res: Response): Promise<AmendmentDetail> {
    const assembly = await this.amendments.get();
    const view = this.amendments.find(assembly, name);
    if (view === undefined) throw notFound('amendment not found');
    const rounds = await this.amendments.rounds(view, assembly.directory);
    const body = buildAmendmentDetail(assembly, this.profile, view, rounds);
    this.setCacheControl(res);
    return body;
  }

  private setCacheControl(res: Response): void {
    const cacheControl = routeCacheControl(this.config, AMENDMENTS_CACHE_CONTROL);
    if (cacheControl !== undefined) res.setHeader('Cache-Control', cacheControl);
  }
}

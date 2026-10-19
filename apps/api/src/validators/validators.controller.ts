import { Get, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
// `import type`: the decorated parameter below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Response } from 'express';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ApiConfig } from '../config/api.config';
import { routeCacheControl, VALIDATORS_CACHE_CONTROL } from './cache-control';
import { buildSummary, ValidatorsSummary } from './summary-object';
import { ValidatorDirectoryService } from './validator-directory.service';

/** The message of the routes of the validators when something other than a Ripple 4xx goes wrong. */
const FAILURE = 'unable to retrieve validator(s)';

/**
 * `GET /v2/network/validators/summary` (spec 3.1): the figures of the header of the Validators board. The routes with a
 * validator key come after `summary` in this controller, so that `summary` is never read as a key.
 */
@RippleController('v2/network/validators')
export class ValidatorsController {
  constructor(
    private readonly directory: ValidatorDirectoryService,
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
    const cacheControl = routeCacheControl(this.config, VALIDATORS_CACHE_CONTROL);
    if (cacheControl !== undefined) res.setHeader('Cache-Control', cacheControl);
    return summary;
  }
}

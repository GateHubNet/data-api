import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { parseExclude } from './exclude-param';
import { DISTRIBUTION_SCHEMA } from './schemas';
import { ANY_TOKEN_PARAM, EXCLUDE_QUERY, LEDGER_QUERIES } from './token-history-docs';
import { parseAnyToken } from './token-history-param';
import { TokenHistoryReadsService } from './token-history-reads.service';
import { TokenHistoryService } from './token-history.service';

/**
 * `GET /v2/tokens/{token}/distribution` (issuer analytics, spec 5.4): how a token's supply is spread over its holders at a ledger, by
 * powers of ten, and the share of its 10 and 100 largest holders. Checks before any read: the token, `exclude`, the ledger's own.
 */
@RippleController('v2/tokens')
export class TokenDistributionController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    private readonly history: TokenHistoryService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':token/distribution')
  @RippleRoute('unable to retrieve token distribution')
  @ApiOperation({
    summary: 'Get the distribution of a token at a ledger',
    description:
      'The holders of the token at the ledger by the power of ten of their balance: one bucket from the smallest holding to the ' +
      'largest, the empty ones between included, `min` inclusive and `max` exclusive as text (an MPT in raw units), with its ' +
      '`holders` and their `balance`; and `top`, the sum of the largest 10 and 100 holdings with their `share` of the supply (exact, ' +
      'rounded half up to 6 decimals). With `exclude`, `without_excluded` has the same figures without those holders. No CSV.',
  })
  @ApiParam(ANY_TOKEN_PARAM)
  @ApiQuery(LEDGER_QUERIES[0])
  @ApiQuery(LEDGER_QUERIES[1])
  @ApiQuery(LEDGER_QUERIES[2])
  @ApiQuery(EXCLUDE_QUERY)
  @ApiOkResponse({ schema: DISTRIBUTION_SCHEMA as never })
  async distribution(@Param('token') raw: string, @Query() query: QueryParams): Promise<Record<string, unknown>> {
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const exclude = parseExclude(query);
    this.reads.assertPossible(token);
    const live = await this.reads.live();
    const n = await this.history.resolveLedger(query, live);
    await this.reads.assertToken(live, token);
    return { ...(await this.reads.distribution(live, token, n, exclude)) };
  }
}

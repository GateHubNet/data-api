import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { parseExclude } from './exclude-param';
import { SUMMARY_SCHEMA } from './schemas';
import { ANY_TOKEN_PARAM, EXCLUDE_QUERY, LEDGER_QUERIES } from './token-history-docs';
import { parseAnyToken } from './token-history-param';
import { TokenHistoryReadsService } from './token-history-reads.service';
import { TokenHistoryService } from './token-history.service';

/**
 * `GET /v2/tokens/{token}/summary` (issuer analytics, spec 5.2): a token's figures at a ledger and the flows of the 24 hours, 7 days and
 * 30 days before it. Checks before any read: the token, `exclude`, the ledger's own parameters; then 404s for a token no generation
 * can have, before the first generation, and for a token with no change.
 */
@RippleController('v2/tokens')
export class TokenSummaryController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    private readonly history: TokenHistoryService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':token/summary')
  @RippleRoute('unable to retrieve token summary')
  @ApiOperation({
    summary: 'Get the summary of a token at a ledger',
    description:
      'The token at the ledger: its exact `supply`, `holders`, `trust_lines`, its first and newest change (`first_ledger`, ' +
      '`last_ledger`, with their times), and the flows of the 24 hours, 7 days and 30 days before the close of the ledger: ' +
      '`issued`, `redeemed`, `clawed_back`, `transferred`, `transfers`, `changes`, exact over the changes whose earlier state is ' +
      'known, and `unknown_before`, the changes whose earlier state is not (0 once the coverage is complete). `exchanged` and ' +
      '`trades` are the DEX figures of the whole hours of the window up to `exchanged_through`; they are left out before the DEX ' +
      'history is computed. No CSV. 404 `token history is not built yet` before the first build, `token not found` for a token ' +
      'with no change in it.',
  })
  @ApiParam(ANY_TOKEN_PARAM)
  @ApiQuery(LEDGER_QUERIES[0])
  @ApiQuery(LEDGER_QUERIES[1])
  @ApiQuery(LEDGER_QUERIES[2])
  @ApiQuery(EXCLUDE_QUERY)
  @ApiOkResponse({ schema: SUMMARY_SCHEMA as never })
  async summary(@Param('token') raw: string, @Query() query: QueryParams): Promise<Record<string, unknown>> {
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const exclude = parseExclude(query);
    this.reads.assertPossible(token);
    const live = await this.reads.live();
    const n = await this.history.resolveLedger(query, live);
    await this.reads.assertToken(live, token);
    return { ...(await this.reads.summary(live, token, n, exclude)) };
  }
}

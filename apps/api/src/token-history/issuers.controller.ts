import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters would otherwise make Nest's metadata `require('express')`
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { decodeMarker, paginate, setLinkHeader } from '../common/pagination';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { ISSUER_TOKENS_SCHEMA } from './schemas';
import { LEDGER_QUERIES } from './token-history-docs';
import { issuerTokensAnswer, toIssuerTokenCsvRow } from './token-history-objects';
import { TokenHistoryReadsService } from './token-history-reads.service';
import { TokenHistoryService } from './token-history.service';

const tokensFilename = (req: Request): string => `${String(req.params.issuer)} - tokens`;

/**
 * `GET /v2/issuers/{issuer}/tokens` (issuer analytics, spec 5.1): every token of an issuer in the live token history, issued tokens and
 * MPTs together, by `currency`, at a ledger. Checks before any read: the issuer, the limit, the marker, the ledger's own parameters.
 */
@RippleController('v2/issuers')
export class IssuersController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    private readonly history: TokenHistoryService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':issuer/tokens')
  @RippleRoute('unable to retrieve tokens')
  @Csv(tokensFilename, 'tokens')
  @ApiOperation({
    summary: "Get an issuer's tokens at a ledger",
    description:
      'Every token of the issuer with a change in the token history at or before the ledger, issued tokens and MPTs together, by ' +
      '`currency` (an MPT by its issuance ID): its `supply` (exact), `holders`, `trust_lines`, and the ledgers of its first and ' +
      'newest change. The ledger is `ledger_index` (alias `ledger`), `ledger_hash` or `date` (alias `close_time`); none is the newest ' +
      'ledger of the token history. An issuer with no token is an empty list. `coverage` is the token history of issued tokens. ' +
      '404 `token history is not built yet` before the first build. `format=csv` gives `<issuer> - tokens.csv`.',
  })
  @ApiParam({ name: 'issuer', description: 'A classic address.' })
  @ApiQuery(LEDGER_QUERIES[0])
  @ApiQuery(LEDGER_QUERIES[1])
  @ApiQuery(LEDGER_QUERIES[2])
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  @ApiOkResponse({ schema: ISSUER_TOKENS_SCHEMA as never })
  async tokens(
    @Param('issuer') issuer: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    if (!isValidClassicAddress(issuer)) throw badRequest('invalid issuer address');
    const limit = limitParam(query, { def: 200, max: 1000 });
    const after = decodeMarker(first(query, 'marker'), [{ column: 'currency', type: 'String' }])?.[0] as
      | string
      | undefined;
    const live = await this.reads.live();
    const n = await this.history.resolveLedger(query, live);
    const [rows, coverage, close] = await Promise.all([
      this.reads.issuerTokens(live, issuer, n, { after, limit }),
      this.reads.coverage(live, 'issued'),
      this.reads.closeTimeOf(live, n),
    ]);
    const page = paginate(rows, limit, (r) => [r.currency]);
    setLinkHeader(req, res, page.marker);
    const body = issuerTokensAnswer({
      result: 'success',
      coverage,
      ledger_index: n,
      close_time: fmtTime(close),
      count: page.rows.length,
      marker: page.marker,
      tokens: page.rows,
    });
    return wantsCsv(query) ? { ...body, tokens: page.rows.map(toIssuerTokenCsvRow) } : { ...body };
  }
}

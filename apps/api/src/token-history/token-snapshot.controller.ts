import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters would otherwise make Nest's metadata `require('express')`
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { decodeMarker, setLinkHeader } from '../common/pagination';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { parseExclude } from './exclude-param';
import { SNAPSHOT_SCHEMA } from './schemas';
import { ANY_TOKEN_PARAM, EXCLUDE_QUERY, LEDGER_QUERIES } from './token-history-docs';
import { toSnapshotCsvRow } from './token-history-objects';
import { anyTokenFileStem, parseAnyToken } from './token-history-param';
import { TokenHistoryReadsService } from './token-history-reads.service';
import { TokenHistoryService } from './token-history.service';

const snapshotFilename = (req: Request, body: unknown): string =>
  `${anyTokenFileStem(String(req.params.token))} - snapshot ${String((body as { ledger_index?: number }).ledger_index ?? '')}`;

/**
 * `GET /v2/tokens/{token}/snapshot` (issuer analytics, spec 5.7): every holder of a token at a ledger, by address, with a digest of the
 * whole set that an auditor can check any page and any recount against. A ledger is required. Checks before any read: the token,
 * the ledger's presence and its own parameters, the limit, the marker and `exclude`.
 */
@RippleController('v2/tokens')
export class TokenSnapshotController {
  constructor(
    private readonly reads: TokenHistoryReadsService,
    private readonly history: TokenHistoryService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':token/snapshot')
  @RippleRoute('unable to retrieve token snapshot')
  @Csv(snapshotFilename, 'balances')
  @ApiOperation({
    summary: 'Get the snapshot of a token at a ledger',
    description:
      'Every holder of the token at the ledger (a balance above 0), by address in byte order, with its `balance` (an MPT: amount ' +
      'and `escrowed` together), `limit`, `frozen` and `authorized`, paged (default 1000, at most 10,000). `digest` is the ' +
      'lower-case hex SHA-256 of one line `<holder>,<balance>\\n` per holder of the whole set, in that order: the same on every page ' +
      'and whatever `exclude` says. A ledger is required (400 `a ledger is required`). `format=csv` gives `<code or currency> ' +
      '<issuer> - snapshot <ledger_index>.csv`.',
  })
  @ApiParam(ANY_TOKEN_PARAM)
  @ApiQuery({
    ...LEDGER_QUERIES[0],
    description: `${String(LEDGER_QUERIES[0].description)} One of the three is required.`,
  })
  @ApiQuery(LEDGER_QUERIES[1])
  @ApiQuery(LEDGER_QUERIES[2])
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 1000, at most 10,000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery(EXCLUDE_QUERY)
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  @ApiOkResponse({ schema: SNAPSHOT_SCHEMA as never })
  async snapshot(
    @Param('token') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const limit = limitParam(query, { def: 1000, max: 10_000 });
    const after = decodeMarker(first(query, 'marker'), [{ column: 'holder', type: 'String' }])?.[0] as
      | string
      | undefined;
    const exclude = parseExclude(query);
    this.reads.assertPossible(token);
    const live = await this.reads.live();
    const n = await this.history.resolveLedger(query, live, { required: true });
    await this.reads.assertToken(live, token);
    const { answer, marker } = await this.reads.snapshot(live, token, n, { after, limit, exclude });
    setLinkHeader(req, res, marker);
    return wantsCsv(query) ? { ...answer, balances: answer.balances.map(toSnapshotCsvRow) } : { ...answer };
  }
}

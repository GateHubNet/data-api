import { Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import {
  parseTokenListQuery,
  TOKEN_KINDS,
  TOKEN_LIST_SERVICES,
  TokenKind,
  tokenListBody,
  TokenListService,
} from './token-list';

/**
 * The tokens (spec 5). The list is `GET /v2/tokens`, served by the `TokenListService` of the kind asked for
 * (`TOKEN_LIST_SERVICES`): this controller knows no kind but through that map, so that D9 adds `mpt` without a change here.
 *
 * The checks come in the order of the parameters: `kind`, `min_holders`, `q`, then the marker (the service, before it reads). The
 * answer states `coverage`, the key after `result`, which is the kind's own (spec 6).
 */
@RippleController('v2/tokens')
export class TokensController {
  constructor(@Inject(TOKEN_LIST_SERVICES) private readonly services: ReadonlyMap<TokenKind, TokenListService>) {}

  @Get()
  @RippleRoute('unable to retrieve tokens')
  @Csv('tokens', 'tokens')
  @ApiOperation({
    summary: 'Get the tokens, ranked by holders',
    description:
      'The tokens of a kind (`issued`: the currencies issued on trust lines) with the most holders first, then by issuer, then by ' +
      'currency; `rank` is the place of a token in that order among the tokens the filters select. A token is a currency and its ' +
      'issuer, as of the last run of the tokens job (`ledger_index` and `close_time` are the ledger it is through): its holders ' +
      '(the accounts that hold a positive balance), `trust_lines` (the lines that count), `supply` (the exact sum of the balances), ' +
      'the `price` of the last day against the native currency with its `price_change` (percent) and `price_time` (the month ' +
      "when the day has none, without a change), the `native_volume` and `trades` of the day, and the issuer's `domain`, whether " +
      'its toml `listed` the token, and the `name` it gives it. `min_holders` keeps the tokens with at least that many holders; ' +
      '`q` (1 to 64 characters) keeps the tokens of an issuer (a classic address), or those whose code, name or domain contains ' +
      'it (any case), whose currency it is (40 hex digits) or whose issuer starts with it. `total` is the number of tokens the ' +
      'filters select, on all pages; `total_below`, with `min_holders`, the number that match `q` but have fewer holders. ' +
      '`totals` describe the whole kind, whatever the filters: `tokens`, `tokens_with_10_holders`, `holders` (distinct holders ' +
      'of all tokens; left out while the job has not counted them) and the `native_volume` of the day on the markets (left out ' +
      'without a day set). Before the job has built a generation the answer has no tokens. The ranking is rebuilt each minute, ' +
      'so a token can move between pages from one minute to the next. `format=csv` gives the tokens as a CSV file (without ' +
      '`coverage`).',
  })
  @ApiQuery({ name: 'kind', required: false, enum: [...TOKEN_KINDS], description: 'Default: issued.' })
  @ApiQuery({
    name: 'min_holders',
    required: false,
    type: Number,
    description: 'Only the tokens with at least this many holders: 0 to 1,000,000,000. Default 0.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A search, 1 to 64 characters: an issuer address, or text in the code, name or domain, a currency in hex, an issuer prefix.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const q = parseTokenListQuery(query);
    const service = this.services.get(q.kind);
    if (service === undefined) throw new Error(`No list of tokens is registered for the kind ${q.kind}`);
    // the list first: it checks the marker, and a bad one is a 400 before the coverage is read
    const listing = service.list(q);
    const [coverage, page] = await Promise.all([service.coverage(), listing]);
    setLinkHeader(req, res, page?.marker);
    const body = tokenListBody(q.kind, coverage, page);
    return q.csv && page !== undefined ? { ...body, tokens: page.rows.map((row) => service.csvRow(row)) } : body;
  }
}

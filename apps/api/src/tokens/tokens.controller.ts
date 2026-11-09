import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest, notFound } from '../common/errors';
import { fmtTime } from '../common/format';
import { decodeMarker, setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { HOLDERS_SCHEMA } from '../token-history/schemas';
import { LEDGER_QUERIES } from '../token-history/token-history-docs';
import { parseAnyToken } from '../token-history/token-history-param';
import { TokenHistoryReadsService } from '../token-history/token-history-reads.service';
import { TokenHistoryService } from '../token-history/token-history.service';
import { decodeHoldersMarker } from './token-holders.service';
import {
  parseTokenListQuery,
  TOKEN_KINDS,
  TOKEN_LIST_SERVICES,
  TokenKind,
  tokenListBody,
  TokenListService,
} from './token-list';
import { toTransferCsvRow } from './token-objects';
import { parseTokenParam, tokenFileStemOfPath } from './token-param';
import { TokenTransfersService } from './token-transfers.service';
import { TokensService } from './tokens.service';

/**
 * The name of the CSV file of the holders, `<code or currency> <issuer> - holders` (`@Csv` adds the `.csv`): that of the token the
 * path names, whatever its spelling.
 */
const holdersFilename = (req: Request): string => `${tokenFileStemOfPath(String(req.params.token))} - holders`;

/** The parameters that name a ledger (spec 5.0): the token history's, which D6's route did not have. */
const LEDGER_PARAMS = ['ledger_index', 'ledger', 'ledger_hash', 'date', 'close_time'] as const;
const namesLedger = (q: QueryParams): boolean => LEDGER_PARAMS.some((name) => (first(q, name) ?? '') !== '');

/** A marker's balance: the exact decimal text of the served balance. */
const MARKER_BALANCE = /^\d+(\.\d+)?$/;

/**
 * The marker of the holders, read for both sources before the route knows which one answers: 400 `invalid marker` at once when it is
 * a marker of neither, else each source takes its own (and a marker of the other is `invalid marker` then).
 */
function holdersMarkers(marker: string | undefined): {
  d6: () => ReturnType<typeof decodeHoldersMarker>;
  tokenHistory: () => ReturnType<typeof decodeTokenHistoryHoldersMarker>;
} {
  const read = <T>(decode: () => T): { value?: T; error?: unknown } => {
    try {
      return { value: decode() };
    } catch (error) {
      return { error };
    }
  };
  const d6 = read(() => decodeHoldersMarker(marker));
  const th = read(() => decodeTokenHistoryHoldersMarker(marker));
  if (d6.error !== undefined && th.error !== undefined) throw th.error;
  const take =
    <T>(r: { value?: T; error?: unknown }) =>
    (): T => {
      if (r.error !== undefined) throw r.error;
      return r.value as T;
    };
  return { d6: take(d6), tokenHistory: take(th) };
}

/**
 * The marker of the holders once the route reads the token history (spec 5.5): base64url JSON `[holder, balance text]`. A marker of
 * D6's route (a number first), a holder that is no classic address, or a balance that is not a decimal text, is 400 `invalid marker`:
 * a marker that neither source could have written is refused before the route reads which source answers.
 */
export function decodeTokenHistoryHoldersMarker(
  marker: string | undefined,
): { balance: string; holder: string } | undefined {
  const values = decodeMarker(marker, [
    { column: 'holder', type: 'String' },
    { column: 'balance', type: 'String' },
  ]);
  if (values === undefined) return undefined;
  const [holder, balance] = values as [string, string];
  if (!isValidClassicAddress(holder) || !MARKER_BALANCE.test(balance)) throw badRequest('invalid marker');
  return { balance, holder };
}

/** The name of the CSV file of the transfers, `<code or currency> <issuer> - transfers` (`@Csv` adds the `.csv`), as that of the holders. */
const transfersFilename = (req: Request): string => `${tokenFileStemOfPath(String(req.params.token))} - transfers`;

/** The documentation of the segment of the path that names a token. */
const TOKEN_PARAM = {
  name: 'token',
  description:
    'A currency and its issuer, `{currency}.{issuer}` (or with `+` or `|` for the dot): a 3-character code, 40 hex digits or ' +
    'a text of 4 to 20 characters, then the issuer address. The segment is split at its last separator.',
} as const;

/**
 * The tokens (spec 5). The list is `GET /v2/tokens`, served by the `TokenListService` of the kind asked for
 * (`TOKEN_LIST_SERVICES`): this controller knows no kind but through that map. One
 * token, its holders and its transfers are `GET /v2/tokens/{currency}.{issuer}`, `.../holders` and `.../transfers`, issued tokens only.
 *
 * The checks of the list come in the order of the parameters: `kind`, `min_holders`, `q`, then the marker (the service, before it
 * reads). Those of a token's routes: the path (`invalid currency`, `XRP cannot have an issuer`, `invalid issuer address`), the
 * marker of the holders, all of them before any read, then the token (404 `token not found`). Those of the transfers are the path's,
 * then `/v2/payments`': `start`, `end` and the marker (`PaymentsService` decodes it before its first read), and the transfers of a
 * token the job does not know are listed all the same (no 404). The answer states `coverage`, the key after `result`, which is the
 * feature's own (spec 6).
 */
@RippleController('v2/tokens')
export class TokensController {
  constructor(
    @Inject(TOKEN_LIST_SERVICES) private readonly services: ReadonlyMap<TokenKind, TokenListService>,
    private readonly tokens: TokensService,
    private readonly transferPages: TokenTransfersService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    private readonly history: TokenHistoryService,
    private readonly reads: TokenHistoryReadsService,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve tokens')
  @Csv('tokens', 'tokens')
  @ApiOperation({
    summary: 'Get the tokens, ranked by holders',
    description:
      'The tokens of a kind with the most holders first, then by issuer, then by the token; `rank` is the place of a token in that ' +
      'order among the tokens the filters select. `kind=mpt` lists the MPT issuances instead of the currencies issued on trust ' +
      'lines (`issued`, the default): its row, its `totals` and its search are in the MPT section of the reference, and the rest of ' +
      'this text is of `issued`. A token is a currency and its ' +
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
      'A search, 1 to 64 characters: an issuer address, or text in the code, name or domain, a currency in hex, an issuer prefix. ' +
      'With `kind=mpt`: an issuer address, an issuance ID, or text in the ticker or name, an issuer prefix, an ID prefix of 8 hex ' +
      'digits or more.',
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

  @Get(':token/holders')
  @RippleRoute('unable to retrieve holders')
  @Csv(holdersFilename, 'holders')
  @ApiOperation({
    summary: 'Get the holders of a token',
    description:
      'The accounts that hold a positive balance of the token, the largest balance first, then by address, as of the last run of ' +
      "the tokens job (`ledger_index` and `close_time` are the ledger it is through). `rank` is the holder's place in that order " +
      'among all the holders, whatever the page; `share` is its balance over the token `supply` (exact, rounded half up to 6 ' +
      "decimals); `limit` is the holder's limit; `frozen` and `authorized` are the issuer's freeze and authorization of the line. " +
      'The path names the token like the detail does; a token the job does not know (no live row, an LP token, no generation ' +
      'yet) is a 404. `format=csv` gives the holders as a CSV file `<code or currency> <issuer> - holders.csv` (without `coverage`). ' +
      'Once the token history is built, the route reads it instead, seconds behind the head: the holders at a ledger (`ledger_index`, ' +
      '`ledger_hash` or `date`; none is the newest of the token history), in the exact order of the balances (`descending=false` ' +
      'gives the smallest first), each row with `first_ledger` and `last_ledger` (the start of its current run of holding and its ' +
      'newest change) and, for an MPT (its issuance ID in the path), `escrowed`. The marker then holds the balance text and the ' +
      'holder, so a marker of the earlier answer is `invalid marker` once. Before the build, a ledger is 404 `token history is not ' +
      'built yet`.',
  })
  @ApiParam(TOKEN_PARAM)
  @ApiQuery(LEDGER_QUERIES[0])
  @ApiQuery(LEDGER_QUERIES[1])
  @ApiQuery(LEDGER_QUERIES[2])
  @ApiQuery({
    name: 'descending',
    required: false,
    type: Boolean,
    description: 'The largest balances first. Default true.',
  })
  @ApiOkResponse({ schema: HOLDERS_SCHEMA as never })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async holders(
    @Param('token') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    // everything the request can get wrong is checked before the first read: the path, a token no source can have (an LP token,
    // an MPT on a network without), the limit, and a marker that neither source's could be
    const token = parseAnyToken(raw, this.profile.nativeCurrency);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const markers = holdersMarkers(first(query, 'marker'));
    this.reads.assertPossible(token);
    // then the source: the token history once a generation is live, else D6's lines
    const live = await this.history.live();
    if (live !== undefined) {
      const after = markers.tokenHistory();
      const descending = (first(query, 'descending') ?? '') === '' || bool(query, 'descending');
      const n = await this.history.resolveLedger(query, live);
      await this.reads.assertToken(live, token);
      const body = await this.reads.holders(live, token, n, { descending, ...(after && { after }), limit });
      setLinkHeader(req, res, body.marker as string | undefined);
      return body;
    }
    // before the first generation: D6's route, unchanged; a ledger, or an MPT, names the token history
    if (token.kind === 'mpt' || namesLedger(query)) throw notFound('token history is not built yet');
    const ref = { currency: token.currency, issuer: token.issuer };
    const after = markers.d6();
    const found = await this.tokens.holders(ref, { limit, ...(after && { after }) });
    if (found === undefined) throw notFound('token not found');
    setLinkHeader(req, res, found.marker);
    return {
      result: 'success',
      coverage: found.coverage,
      ledger_index: found.ledgerIndex,
      close_time: fmtTime(found.closeTime),
      supply: found.supply,
      count: found.rows.length,
      ...(found.marker !== undefined && { marker: found.marker }),
      holders: found.rows,
    };
  }

  @Get(':token/transfers')
  @RippleRoute('unable to retrieve transfers')
  @Csv(transfersFilename, 'transfers')
  @ApiOperation({
    summary: 'Get the transfers of a token',
    description:
      'The payments that delivered the token, oldest first: the `Payment` transactions between two different accounts that ' +
      'delivered the currency of the issuer (a payment to oneself is not a payment, as in `/v2/payments`), with the `amount` ' +
      'delivered and the tags the payment has. The window, `descending`, `limit` and `marker` are those of `/v2/payments` ' +
      '(`start` inclusive, `end` the end of the period it names; the marker is `(ledger_index, tx_index)`). The path names the ' +
      'token like the detail does, but the list does not look the token up: a token nobody was paid in, one the tokens job does ' +
      'not know and an LP token list the transfers they have, and no transfers is an empty list. `coverage` is that of the ' +
      'payments of the ledgers, not of the state tables. `format=csv` gives the transfers as a CSV file ' +
      '`<code or currency> <issuer> - transfers.csv` with a column for each key of a transfer (without `coverage`).',
  })
  @ApiParam(TOKEN_PARAM)
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the beginning.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async transfers(
    @Param('token') raw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    // the checks come in the order of `/v2/payments`, after the path's: start (an empty one is none), end, the rest, the marker
    const ref = parseTokenParam(raw, this.profile.nativeCurrency);
    const start = first(query, 'start') === '' ? undefined : dateParam(query, 'start', 'invalid start date format');
    const end = dateParam(query, 'end', 'invalid end date format');
    // the marker is checked by `PaymentsService.list`, the first thing it does, so that its 400 comes before any read; the
    // coverage is read after the page for that reason
    const page = await this.transferPages.page(ref, {
      ...(start && { start: start.date }),
      ...(end && { endExclusive: endExclusive(end) }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });
    const coverage = await this.transferPages.coverage();
    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      coverage,
      count: page.rows.length,
      ...(page.marker !== undefined && { marker: page.marker }),
      transfers: wantsCsv(query) ? page.rows.map(toTransferCsvRow) : page.rows,
    };
  }

  @Get(':token')
  @RippleRoute('unable to retrieve token')
  @ApiOperation({
    summary: 'Get a token',
    description:
      'One issued token as of the last run of the tokens job (`ledger_index` and `close_time` are the ledger it is through): its ' +
      'holders, `trust_lines` and exact `supply`, the `price` of the last day with its change and the volume and trades of the ' +
      "day, the issuer's `domain` and the `toml_url` of its toml, whether the toml `listed` the token and what it says of it " +
      "(`toml`), the issuer's `issuer_settings` (left out while the issuer has no row in the state tables), its `markets` of the " +
      'day (the token is always the base), and `last_ledger`, the newest ledger of one of its lines. A token with no live row (no ' +
      'line counts, an LP token, or no generation yet) is a 404 `token not found`. No CSV.',
  })
  @ApiParam(TOKEN_PARAM)
  async token(@Param('token') raw: string): Promise<Record<string, unknown>> {
    const ref = parseTokenParam(raw, this.profile.nativeCurrency);
    const found = await this.tokens.token(ref);
    if (found === undefined) throw notFound('token not found');
    return {
      result: 'success',
      coverage: found.coverage,
      ledger_index: found.ledgerIndex,
      close_time: fmtTime(found.closeTime),
      token: found.token,
    };
  }
}

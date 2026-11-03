import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is not
// a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { decodeMarker, paginate, setLinkHeader } from '../common/pagination';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { StateLedgerService } from '../common/state-ledger.service';
import { ledgerSelector } from './account-ledger';
import { TRUST_LINE_KEYS, TrustLine, TrustLinesService } from './trust-lines.service';

/** The `limit` of the route: 200 by default, at most 1000. */
export const TRUSTLINES_LIMIT_DEFAULT = 200;
export const TRUSTLINES_LIMIT_MAX = 1000;

interface AccountTrustlinesBody {
  result: 'success';
  ledger_index: number;
  close_time: string;
  count: number;
  marker?: string;
  trustlines: TrustLine[];
}

/**
 * `GET /v2/accounts/:address/trustlines`: the trust lines of an account at a ledger, with all their settings, from the
 * trust line state history in ClickHouse (ADR-0015), ordered and paged by (counterparty, currency). A GateHub extra:
 * the original had no such route.
 *
 * It never reads the node. The ledger is chosen as on `/balances` (`ledger_hash`, then `date` / `close_time`, then a
 * numeric `ledger_index` / `ledger`); with none, or with `validated`, `closed` or `current`, it is the newest indexed
 * ledger, so that a marker always belongs to this API's own data.
 *
 * The checks come in the order of `/balances`: the address (400 `invalid ripple address`), the date (400 `invalid date
 * format`), the hash (400 `invalid ledger hash`), the limit (400 `invalid limit`), then the marker (400 `invalid
 * marker`); a ledger the state tables do not cover is 400 `the date provided is too old`.
 */
@RippleController('v2/accounts')
export class AccountTrustlinesController {
  constructor(
    private readonly lines: TrustLinesService,
    private readonly ledgers: StateLedgerService,
  ) {}

  @Get(':address/trustlines')
  @RippleRoute('unable to retrieve trustlines')
  @Csv((req) => `${req.params.address} - trustlines`, 'trustlines')
  @ApiOperation({
    summary: 'Get the trust lines of an account',
    description:
      'The trust lines of the account at a ledger, from the indexed state history, with each line from the ' +
      "account's side: its balance, its limit and the peer's, no-ripple, authorization and freeze on both sides, and " +
      'its quality in and out. Lines with a zero balance are listed; lines deleted at or before the ledger are not. ' +
      'Ordered and paged by (counterparty, currency). The ledger is chosen by `ledger_hash`, `date` (the last ledger ' +
      "closed at or before it) or `ledger_index`; without any of them it is the newest indexed one. An issuer's lines " +
      'are its holders. `format=csv` gives the lines as a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'ledger_index', required: false, description: 'A ledger number. Alias: `ledger`.' })
  @ApiQuery({ name: 'ledger_hash', required: false, description: 'The hash of the ledger.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The last ledger closed at or before this time. Alias: `close_time`.',
  })
  @ApiQuery({ name: 'currency', required: false, description: 'Only the lines in this currency.' })
  @ApiQuery({ name: 'counterparty', required: false, description: 'Only the lines with this account.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'The `marker` of the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountTrustlinesBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    const selector = ledgerSelector(query);
    const limit = limitParam(query, {
      def: TRUSTLINES_LIMIT_DEFAULT,
      max: TRUSTLINES_LIMIT_MAX,
      nanError: 'invalid limit',
    });
    const after = decodeMarker(first(query, 'marker'), TRUST_LINE_KEYS) as [string, string] | undefined;

    const ledger = (await this.ledgers.resolve(selector)) ?? (await this.ledgers.latest());
    const rows = await this.lines.linesAt({
      address,
      ledgerIndex: ledger.ledger_index,
      currency: first(query, 'currency') || undefined,
      counterparty: first(query, 'counterparty') || undefined,
      after,
      limit: limit + 1,
    });
    const page = paginate(rows, limit, (line) => [line.counterparty, line.currency]);

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      ledger_index: ledger.ledger_index,
      close_time: fmtTime(ledger.close_time),
      count: page.rows.length,
      ...(page.marker !== undefined && { marker: page.marker }),
      trustlines: page.rows,
    };
  }
}

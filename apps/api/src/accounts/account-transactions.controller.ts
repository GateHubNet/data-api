import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { BinaryCodecService } from '../common/binary-codec.service';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest, notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { transactionFilters } from '../common/tx-filters';
import { TxObject } from '../common/tx-object';
import { AccountTransactionsService, TransactionsPage } from './account-transactions.service';
import { TransactionSummary } from './transaction-summary';

/** The message of the list when something other than a Ripple 4xx goes wrong (`accountTransactions.js`). */
const LIST_FAILURE = 'unable to retrieve transactions';
/** The message of the lookup by sequence (`accountTxSeq.js`). */
const LOOKUP_FAILURE = 'unable to retrieve transaction';

/** The name of the CSV file: `<address> - transactions`. `@Csv` adds the `.csv`. */
function transactionsFilename(req: Request): string {
  return `${req.params.address} - transactions`;
}

/** `^\d+$` of the original, which tests every sequence with it. */
const DIGITS = /^\d+$/;

/**
 * `min_sequence` or `max_sequence`: the digits of the original's `intMatch`, as large as they come (a number above
 * what a sequence can be is a legal ask with nothing to find); missing or empty is no bound.
 */
function sequenceParam(q: QueryParams, name: string): number | undefined {
  const raw = first(q, name);
  if (raw === undefined || raw === '') return undefined;
  if (!DIGITS.test(raw)) throw badRequest(`invalid ${name}`);
  return Number(raw);
}

/**
 * `GET /v2/accounts/:address/transactions[/:sequence]` (`api/routes/accountTransactions.js`, `accountTxSeq.js`).
 *
 * The address is not checked, as in the original: one that is none simply has no transactions.
 */
@RippleController('v2/accounts')
export class AccountTransactionsController {
  constructor(
    private readonly transactions: AccountTransactionsService,
    private readonly codec: BinaryCodecService,
  ) {}

  @Get(':address/transactions/:sequence')
  @RippleRoute(LOOKUP_FAILURE)
  @ApiOperation({
    summary: 'Get an account transaction by sequence',
    description:
      'The transaction the account sent with this `Sequence`. Transactions that use a ticket have Sequence 0; ' +
      'there the latest of them is returned. `binary=true` gives `tx` and `meta` as hex.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiParam({ name: 'sequence', description: 'The sequence number of the transaction (digits).' })
  @ApiQuery({ name: 'binary', required: false, type: Boolean, description: 'Serve `tx` and `meta` as hex.' })
  async getBySequence(
    @Param('address') address: string,
    @Param('sequence') sequence: string,
    @Query() query: QueryParams,
  ): Promise<{ result: 'success'; transaction: TxObject }> {
    if (!DIGITS.test(sequence)) throw badRequest('invalid sequence number');

    const transaction = await this.transactions.bySequence(address, Number(sequence), bool(query, 'binary'));
    if (!transaction) throw notFound('transaction not found');
    return { result: 'success', transaction };
  }

  @Get(':address/transactions')
  @RippleRoute(LIST_FAILURE)
  @Csv(transactionsFilename, 'transactions')
  @ApiOperation({
    summary: 'Get the transactions of an account',
    description:
      'Every transaction that affects the account (sent, received, or touching one of its offers or trust lines) in ' +
      'the ledgers that closed between `start` and `end`, oldest first. With `min_sequence` or `max_sequence` the ' +
      'list is instead the transactions the account sent, by their sequence number, and `start` and `end` are ' +
      'ignored. `type` and `result` are the names of the network (`Payment`, `tesSUCCESS`). `format=csv` serves ' +
      "the same list as a CSV of summary rows from the account's side.",
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the first ledger.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'min_sequence', required: false, type: Number, description: 'Lowest sequence number, included.' })
  @ApiQuery({ name: 'max_sequence', required: false, type: Number, description: 'Highest sequence number, included.' })
  @ApiQuery({ name: 'type', required: false, description: 'Only this transaction type.' })
  @ApiQuery({ name: 'result', required: false, description: 'Only this transaction result code.' })
  @ApiQuery({ name: 'binary', required: false, type: Boolean, description: 'Serve `tx` and `meta` as hex.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 20, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({
    name: 'format',
    required: false,
    description: '`csv`: one summary row per transaction, file `<address> - transactions.csv`.',
  })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; count: number; marker?: string; transactions: TxObject[] | TransactionSummary[] }> {
    const common = {
      account: address,
      // a CSV has no `tx` or `meta` to serve as hex: `binary` does not change it
      form: wantsCsv(query) ? ('summary' as const) : bool(query, 'binary') ? ('binary' as const) : ('json' as const),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 20, max: 1000 }),
      marker: first(query, 'marker'),
    };

    // the checks come in the order of the original: a sequence query (min, then max) or else the dates (start, then
    // end), then type, then result. A sequence query never reads the dates.
    const minSequence = sequenceParam(query, 'min_sequence');
    const maxSequence = sequenceParam(query, 'max_sequence');
    // `options.minSequence || options.maxSequence` of the original: an empty value is none
    const bySequence = Boolean(first(query, 'min_sequence') || first(query, 'max_sequence'));
    const start = bySequence ? undefined : dateParam(query, 'start', 'invalid start date format', '1970-01-01');
    const end = bySequence ? undefined : dateParam(query, 'end', 'invalid end date format');
    const filters = transactionFilters(query, this.codec);

    const page: TransactionsPage = bySequence
      ? await this.transactions.listBySequence({ ...common, ...filters, minSequence, maxSequence })
      : await this.transactions.listByTime({
          ...common,
          ...filters,
          start: start?.date,
          ...(end && { endExclusive: endExclusive(end) }),
        });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.transactions.length,
      marker: page.marker,
      transactions: page.transactions,
    };
  }
}

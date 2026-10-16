import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { BinaryCodecService } from '../common/binary-codec.service';
import { badRequest, notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { transactionFilters } from '../common/tx-filters';
import { TxObject } from '../common/tx-object';
import { TransactionsService } from './transactions.service';

/** The message of both routes when something other than a Ripple 4xx goes wrong (`getTransactions.js`). */
const FAILURE = 'unable to retrieve transaction(s)';

/** `^(0x)?[0-9A-Fa-f]+$` of the original, on the upper-cased hash: the `0x` can never match there, so it is the digits. */
const HEX = /^[0-9A-F]+$/;

/** `GET /v2/transactions[/:tx_hash]` (`api/routes/getTransactions.js`). */
@RippleController('v2/transactions')
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly codec: BinaryCodecService,
  ) {}

  @Get(':tx_hash')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get a transaction',
    description: 'A transaction by its hash (any case). `binary=true` gives `tx` and `meta` as hex.',
  })
  @ApiParam({ name: 'tx_hash', description: 'The transaction hash: an even number of hex digits.' })
  @ApiQuery({ name: 'binary', required: false, type: Boolean, description: 'Serve `tx` and `meta` as hex.' })
  async getTransaction(
    @Param('tx_hash') param: string,
    @Query() query: QueryParams,
  ): Promise<{ result: 'success'; transaction: TxObject }> {
    const hash = param.toUpperCase();
    if (!HEX.test(hash) || hash.length % 2 !== 0) throw badRequest('invalid hash');

    const transaction = await this.transactions.getByHash(hash, bool(query, 'binary'));
    if (!transaction) throw notFound('transaction not found');
    return { result: 'success', transaction };
  }

  @Get()
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get transactions',
    description:
      'The transactions of the ledgers that closed between `start` and `end`, oldest first, each with the hash of ' +
      'its ledger. `type` and `result` are the names of the network (`Payment`, `tesSUCCESS`).',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'type', required: false, description: 'Only this transaction type.' })
  @ApiQuery({ name: 'result', required: false, description: 'Only this transaction result code.' })
  @ApiQuery({ name: 'binary', required: false, type: Boolean, description: 'Serve `tx` and `meta` as hex.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 20, at most 100.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    result: 'success';
    count: number;
    marker?: string;
    transactions: TxObject[];
  }> {
    // the checks come in the order of the original
    const start = dateParam(query, 'start', 'invalid start date format', '2013-01-01');
    const end = dateParam(query, 'end', 'invalid end date format');
    const { type, result } = transactionFilters(query, this.codec);

    const page = await this.transactions.list({
      start: start.date,
      ...(end && { endExclusive: endExclusive(end) }),
      type,
      result,
      binary: bool(query, 'binary'),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 20, max: 100 }),
      marker: first(query, 'marker'),
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

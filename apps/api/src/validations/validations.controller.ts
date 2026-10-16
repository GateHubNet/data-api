import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { notFound } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { parseLedgerHash, Validation } from './validation-object';
import { ValidationsService } from './validations.service';

/** The message of both routes when something other than a Ripple 4xx goes wrong (`getLedgerValidations.js`). */
const FAILURE = 'unable to retrieve ledger';

/**
 * `GET /v2/ledgers/:ledger_hash/validations[/:pubkey]` (`api/routes/network/getLedgerValidations.js`), and the singular
 * `/v2/ledger/...` that is an alias of it.
 */
@RippleController('v2/ledgers/:ledger_hash/validations', 'v2/ledger/:ledger_hash/validations')
export class ValidationsController {
  constructor(private readonly validations: ValidationsService) {}

  @Get()
  @RippleRoute(FAILURE)
  @Csv((_req, body) => `${String(body.ledger_hash)} - validations`, 'validations')
  @ApiOperation({
    summary: 'Get the validations of a ledger',
    description:
      'The validations the network made of the ledger with this hash, one per validator, sorted by validator key. ' +
      '`format=csv` gives them as a CSV file.',
  })
  @ApiParam({ name: 'ledger_hash', description: 'The hash of the ledger: hex, of even length.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('ledger_hash') ledgerHash: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ result: 'success'; ledger_hash: string; count: number; marker?: string; validations: Validation[] }> {
    // the checks come in the order of the original: the hash, then the limit
    const hash = parseLedgerHash(ledgerHash);
    const limit = limitParam(query, { def: 200, max: 1000 });
    const page = await this.validations.list(hash, limit, first(query, 'marker'));

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      ledger_hash: hash,
      count: page.rows.length,
      marker: page.marker,
      validations: page.rows,
    };
  }

  /** The flat validation plus `result`: JSON only, as the original ignored `format` here. */
  @Get(':pubkey')
  @RippleRoute(FAILURE)
  @ApiOperation({
    summary: 'Get the validation of a ledger by one validator',
    description: 'The validation object itself, with `result: "success"`.',
  })
  @ApiParam({ name: 'ledger_hash', description: 'The hash of the ledger: hex, of even length.' })
  @ApiParam({ name: 'pubkey', description: 'The public key of the validator.' })
  async get(
    @Param('ledger_hash') ledgerHash: string,
    @Param('pubkey') pubkey: string,
  ): Promise<Validation & { result: 'success' }> {
    const validation = await this.validations.get(parseLedgerHash(ledgerHash), pubkey);
    if (!validation) throw notFound('validation not found');
    // `result` after the columns, where the original added it to the row it had read
    return { ...validation, result: 'success' };
  }
}

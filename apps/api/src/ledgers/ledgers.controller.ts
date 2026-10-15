import { Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { notFound, RippleHttpError } from '../common/errors';
import { bool, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { parseLedgerIdentifier } from './ledger-identifier';
import { LedgerObject, LedgersService } from './ledgers.service';

/** `GET /v2/ledgers[/:ledger_param]` (`api/routes/getLedger.js`). */
@RippleController('v2/ledgers')
export class LedgersController {
  constructor(private readonly ledgers: LedgersService) {}

  @Get(['', ':ledger_param'])
  @RippleRoute('unable to retrieve ledger')
  @ApiOperation({
    summary: 'Get a ledger',
    description:
      'A ledger by index, hash or date (the ledger that closed at or before it), or the latest validated ledger. ' +
      '`binary` wins over `expand`, and both win over `transactions`.',
  })
  @ApiParam({
    name: 'ledger_param',
    required: false,
    description:
      'Ledger index (digits), date (`YYYY-MM-DD[THH:mm:ss]`) or ledger hash (even-length hex). Omitted: the latest ledger.',
  })
  @ApiQuery({ name: 'ledger_index', required: false, description: 'Used when there is no identifier in the path.' })
  @ApiQuery({ name: 'ledger_hash', required: false, description: 'Used when there is no identifier in the path.' })
  @ApiQuery({ name: 'date', required: false, description: 'Used when there is no identifier in the path.' })
  @ApiQuery({ name: 'transactions', required: false, type: Boolean, description: 'Include the transaction hashes.' })
  @ApiQuery({ name: 'expand', required: false, type: Boolean, description: 'Include the transactions as JSON.' })
  @ApiQuery({ name: 'binary', required: false, type: Boolean, description: 'Include the transactions as hex.' })
  async getLedger(
    @Param('ledger_param') param: string | undefined,
    @Query() query: QueryParams,
  ): Promise<{ result: 'success'; ledger: LedgerObject }> {
    const ledger = await this.ledgers.getLedger(parseLedgerIdentifier(param, query), {
      transactions: bool(query, 'transactions'),
      expand: bool(query, 'expand'),
      binary: bool(query, 'binary'),
    });
    if (!ledger) throw notFound('ledger not found');
    return { result: 'success', ledger };
  }
}

/** `GET /v2/last_validated` (`api/routes/getLastValidated.js`), which the original documents nowhere. */
@RippleController('v2/last_validated')
export class LastValidatedController {
  constructor(private readonly ledgers: LedgersService) {}

  @Get()
  @RippleRoute('unavailable')
  @ApiOperation({ summary: 'Get the last validated ledger' })
  async getLastValidated(): Promise<{
    result: 'success';
    ledger_index: string;
    ledger_hash: string;
    parent_hash: string;
    close_time: string;
  }> {
    const last = await this.ledgers.getLastValidated();
    // The original never answered when its control row was missing; there is no validated ledger to report yet.
    if (!last) throw new RippleHttpError(500, 'unavailable');
    return { result: 'success', ...last };
  }
}

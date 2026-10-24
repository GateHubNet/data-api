import { Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { PathPaymentObject, toPathPaymentCsvRow } from './path-payment-object';
import { PathPaymentsService } from './path-payments.service';

interface PathPaymentsBody {
  result: 'success';
  count: number;
  marker?: string;
  path_payments: PathPaymentObject[] | Record<string, string | number>[];
}

/** `GET /v2/path_payments`: the path payments of the network in a window (spec #4 §4), a GateHub extra. */
@RippleController('v2/path_payments')
export class PathPaymentsController {
  constructor(private readonly pathPayments: PathPaymentsService) {}

  @Get()
  @RippleRoute('unable to retrieve path payments')
  @Csv('path payments', 'path_payments')
  @ApiOperation({
    summary: 'Get path payments',
    description:
      'The path payments of the ledgers that closed between `start` and `end`, oldest first: the successful ' +
      'payments whose delivery used someone else’s liquidity (an order-book offer, an AMM pool, or an account other ' +
      'than the delivered currency’s issuer rippling between its trust lines), payments to oneself included. Each ' +
      'says what left the source, what reached the destination and what it crossed. `format=csv` gives them as a CSV file.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the beginning.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PathPaymentsBody> {
    // an empty start is no start, as on /v2/payments
    const start = first(query, 'start') === '' ? undefined : dateParam(query, 'start', 'invalid start date format');
    const end = dateParam(query, 'end', 'invalid end date format');

    const page = await this.pathPayments.list({
      ...(start && { start: start.date }),
      ...(end && { endExclusive: endExclusive(end) }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.pathPayments.length,
      marker: page.marker,
      path_payments: wantsCsv(query) ? page.pathPayments.map(toPathPaymentCsvRow) : page.pathPayments,
    };
  }
}

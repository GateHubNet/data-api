import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { PathPaymentsBody, pathPaymentsBody, pathPaymentsQuery } from '../path-payments/path-payments.controller';
import { PathPaymentsService } from '../path-payments/path-payments.service';

/** The name of the CSV file: `<address> - path payments`. `@Csv` adds the `.csv`. */
function csvFilename(req: Request): string {
  return `${req.params.address} - path payments`;
}

/**
 * `GET /v2/accounts/:address/path_payments`: the path payments an account sent or received (spec #4 §4), a GateHub
 * extra. The parameters and the rows are those of `GET /v2/path_payments`. As on the other routes under an account, the
 * address is not checked: one that is none simply has no path payments.
 */
@RippleController('v2/accounts')
export class AccountPathPaymentsController {
  constructor(private readonly pathPayments: PathPaymentsService) {}

  @Get(':address/path_payments')
  @RippleRoute('unable to retrieve path payments')
  @Csv(csvFilename, 'path_payments')
  @ApiOperation({
    summary: 'Get the path payments of an account',
    description:
      'The path payments the account sent or received in the ledgers that closed between `start` and `end`, oldest ' +
      'first, as `GET /v2/path_payments` serves them; a payment to oneself is listed once. `format=csv` gives them as ' +
      'a CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the beginning.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PathPaymentsBody> {
    const page = await this.pathPayments.listOfAccount(address, pathPaymentsQuery(query));
    setLinkHeader(req, res, page.marker);
    return pathPaymentsBody(query, page);
  }
}

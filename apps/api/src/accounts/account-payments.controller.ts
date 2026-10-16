import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { first, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { PaymentObject } from '../payments/payment-object';
import { AccountPaymentsService, PaymentDirection } from './account-payments.service';
import { accountWindow } from './account-window';

/** The `type`s of the original, `types` of `accountPayments.js`. */
const DIRECTIONS: PaymentDirection[] = ['sent', 'received'];

const MAX_TAG = 4_294_967_295;

/**
 * A tag filter. HBase compared the text with the stored one, so a text that is not the digits of a tag matches
 * nothing (`null`); an empty one is no filter (`value &&` in `buildSingleColumnValueFilters`). A tag of 0 is a tag
 * (ruling R10; the original never stored it, so `destination_tag=0` found nothing).
 */
function tagParam(q: QueryParams, name: string): number | null | undefined {
  const raw = first(q, name);
  if (raw === undefined || raw === '') return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const tag = Number(raw);
  return tag > MAX_TAG ? null : tag;
}

/**
 * The name of the CSV file, as `accountPayments.js` has it: `<address> - payments`, then ` <type>` and ` <currency>`
 * when given (`type` lower case, `currency` upper case). `@Csv` adds the `.csv`.
 */
function csvFilename(req: Request): string {
  const type = first(req.query, 'type');
  const currency = first(req.query, 'currency');
  return `${req.params.address} - payments${type ? ` ${type.toLowerCase()}` : ''}${currency ? ` ${currency.toUpperCase()}` : ''}`;
}

interface AccountPaymentsBody {
  result: 'success';
  count: number;
  marker?: string;
  payments: PaymentObject[];
}

/**
 * `GET /v2/accounts/:address/payments` (`api/routes/accountPayments.js`).
 *
 * The address is not checked, as in the original: one that is none simply has no payments. The payments are those of
 * `GET /v2/payments`, only the ones the account sent or received.
 */
@RippleController('v2/accounts')
export class AccountPaymentsController {
  constructor(private readonly payments: AccountPaymentsService) {}

  @Get(':address/payments')
  @RippleRoute('unable to retrieve payments')
  @Csv(csvFilename, 'payments')
  @ApiOperation({
    summary: 'Get the payments of an account',
    description:
      'The `Payment` transactions the account sent or received in the ledgers that closed between `start` and `end`, ' +
      'oldest first, as `GET /v2/payments` serves them. `type` keeps the ones it `sent` or `received`, `currency`, ' +
      '`issuer`, `source_tag` and `destination_tag` the ones with that currency, issuer or tag. `format=csv` gives ' +
      'the payments as a flat CSV file.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account.' })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: 2013-01-01.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'type', required: false, enum: DIRECTIONS, description: 'Only payments sent or received.' })
  @ApiQuery({ name: 'currency', required: false, description: 'Only payments of this currency.' })
  @ApiQuery({ name: 'issuer', required: false, description: 'Only payments of this issuer.' })
  @ApiQuery({ name: 'source_tag', required: false, type: Number, description: 'Only payments with this source tag.' })
  @ApiQuery({
    name: 'destination_tag',
    required: false,
    type: Number,
    description: 'Only payments with this destination tag.',
  })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountPaymentsBody> {
    // the checks come in the order of the original: start, end, then the type
    const window = accountWindow(query);
    const type = first(query, 'type')?.toLowerCase();
    if (type && !DIRECTIONS.includes(type as PaymentDirection)) {
      throw badRequest(`invalid type - use: ${DIRECTIONS.join(', ')}`);
    }
    const currency = first(query, 'currency');
    const issuer = first(query, 'issuer');

    const page = await this.payments.list({
      ...window,
      account: address,
      ...(type && { direction: type as PaymentDirection }),
      ...(currency && { currency: currency.toUpperCase() }),
      ...(issuer && { issuer }),
      sourceTag: tagParam(query, 'source_tag'),
      destinationTag: tagParam(query, 'destination_tag'),
    });

    setLinkHeader(req, res, page.marker);
    return { result: 'success', count: page.payments.length, marker: page.marker, payments: page.payments };
  }
}

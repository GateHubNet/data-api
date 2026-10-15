import { NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { parseAsset, splitAsset } from '../common/asset-param';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { bool, dateParam, endExclusive, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { PaymentObject } from './payment-object';
import { PaymentsService } from './payments.service';

interface PaymentsBody {
  result: 'success';
  count: number;
  marker?: string;
  payments: PaymentObject[];
}

/**
 * The name of the CSV file, as `getPayments.js` meant it: `payments`, then ` - <currency>` and ` <issuer>` of the path
 * (the original repeated the currency where the issuer was meant, and, as it never had them at hand, always named it
 * `payments  `). `@Csv` adds the `.csv`. The path has been validated by the time the answer is built.
 */
function csvFilename(req: Request): string {
  const { currency, issuer } = splitAsset(req.params.currency ?? '');
  return `payments${currency ? ` - ${currency}` : ''}${issuer ? ` ${issuer}` : ''}`;
}

/** `GET /v2/payments[/:currency]` (`api/routes/getPayments.js`). */
@RippleController('v2/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(['', ':currency'])
  @RippleRoute('unable to retrieve payments')
  @Csv(csvFilename, 'payments')
  @ApiOperation({
    summary: 'Get payments',
    description:
      'The `Payment` transactions between two different accounts of the ledgers that closed between `start` and ' +
      '`end`, oldest first; with a currency in the path, only the payments of that currency. `format=csv` gives the ' +
      'payments as a flat CSV file.',
  })
  @ApiParam({
    name: 'currency',
    required: false,
    description:
      'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone. Omitted: all currencies.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time. Default: the beginning.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time. Default: the newest ledger.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('currency') currency: string | undefined,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentsBody> {
    // the checks come in the order of the original: the address of the issuer, start, end, the rest of the currency
    if (currency) {
      const { issuer } = splitAsset(currency);
      if (issuer !== undefined && !isValidClassicAddress(issuer)) throw badRequest('invalid issuer address');
    }
    // `start` is `req.query.start || 0` in the original: an empty one is no start
    const start = first(query, 'start') === '' ? undefined : dateParam(query, 'start', 'invalid start date format');
    const end = dateParam(query, 'end', 'invalid end date format');
    const asset = currency ? parseAsset(currency, this.profile.nativeCurrency) : undefined;

    const page = await this.payments.list({
      ...(start && { start: start.date }),
      ...(end && { endExclusive: endExclusive(end) }),
      ...(asset && { asset }),
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
    });

    setLinkHeader(req, res, page.marker);
    return {
      result: 'success',
      count: page.payments.length,
      marker: page.marker,
      payments: page.payments,
    };
  }
}

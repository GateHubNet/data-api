import { NetworkProfile, RatesService } from '@gatehub/data-api-shared';
import { Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
import BigNumber from 'bignumber.js';
import { assetFromParts } from '../common/asset-param';
import { badRequest } from '../common/errors';
import { precision8 } from '../common/format';
import { first, Query as QueryParams, strictFlag } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { rateDate } from './rate-date';

interface NormalizeBody {
  result: 'success';
  amount: string;
  converted: string;
  rate: string;
}

/**
 * `GET /v2/normalize` (`api/routes/normalize.js`): an amount of one currency in another, through the native currency.
 * Both `currency` and `exchange_currency` are the native currency when they are missing.
 */
@RippleController('v2/normalize')
export class NormalizeController {
  constructor(
    private readonly rates: RatesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get()
  @RippleRoute('unable to retrieve exchanges')
  @ApiOperation({
    summary: 'Convert an amount between currencies',
    description:
      'Converts `amount` of `currency` into `exchange_currency` at the rate of `date`: ' +
      '`rate(currency -> native) / rate(exchange_currency -> native)`, each the rate of `/v2/exchange_rates`. The same ' +
      'currency and issuer on both sides is rate 1; a currency without a rate gives 0.',
  })
  @ApiQuery({ name: 'amount', required: true, description: 'The amount to convert, a number.' })
  @ApiQuery({ name: 'currency', required: false, description: 'Default: the native currency.' })
  @ApiQuery({ name: 'issuer', required: false, description: 'Required for every currency but the native one.' })
  @ApiQuery({
    name: 'exchange_currency',
    required: false,
    description: 'The currency to convert to. Default: the native currency.',
  })
  @ApiQuery({
    name: 'exchange_issuer',
    required: false,
    description: 'Required for every currency but the native one.',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The moment the rates are as of, not in the future. Default: now.',
  })
  @ApiQuery({
    name: 'strict',
    required: false,
    type: Boolean,
    description: 'As for `/v2/exchange_rates`. Default true.',
  })
  async normalize(@Query() query: QueryParams): Promise<NormalizeBody> {
    const native = this.profile.nativeCurrency;
    // `Number(req.query.amount)`: a missing amount is NaN, and text JavaScript reads as a number is one. Infinity is not
    // an amount (the original answered it as `Infinity` and `NaN` strings).
    const amount = Number(first(query, 'amount'));
    if (!Number.isFinite(amount)) throw badRequest('invalid amount');

    // the checks of the original in its order; the issuers are then also checked for being addresses
    const currency = (first(query, 'currency') || native).toUpperCase();
    const issuer = first(query, 'issuer') || '';
    const exchangeCurrency = (first(query, 'exchange_currency') || native).toUpperCase();
    const exchangeIssuer = first(query, 'exchange_issuer') || '';
    if (currency === native && issuer) throw badRequest(`${native} cannot have an issuer`);
    if (currency !== native && !issuer) throw badRequest('issuer is required');
    if (exchangeCurrency === native && exchangeIssuer) throw badRequest(`${native} cannot have an issuer`);
    if (exchangeCurrency !== native && !exchangeIssuer) throw badRequest('issuer is required');
    const from = assetFromParts(currency, issuer, native);
    const to = assetFromParts(exchangeCurrency, exchangeIssuer, native);

    const { date, endExclusive } = rateDate(query);
    const { rate, converted } = await this.rates.normalize(new BigNumber(amount), from, to, {
      date,
      endExclusive,
      strict: strictFlag(query),
    });
    return {
      result: 'success',
      amount: String(amount),
      // what a JavaScript number prints: the original multiplied floats
      converted: String(converted.toNumber()),
      rate: precision8(rate),
    };
  }
}

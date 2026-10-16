import { NetworkProfile, RATE_PERIODS, RatePeriod, RatesService } from '@gatehub/data-api-shared';
import { Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { parseAssetPair } from '../common/asset-param';
import { badRequest } from '../common/errors';
import { precision8 } from '../common/format';
import { bool, first, Query as QueryParams, strictFlag } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { rateDate } from './rate-date';

interface ExchangeRateBody {
  result: 'success';
  rate: string;
}

/**
 * `period` of the query, lowercased (`(req.query.period || '').toLowerCase()`): none when missing or empty, else one of
 * the rolling windows or 400 `invalid period: <lowercased text>`.
 */
function periodOf(query: QueryParams): RatePeriod | undefined {
  const period = (first(query, 'period') ?? '').toLowerCase();
  if (period === '') return undefined;
  if (!(RATE_PERIODS as readonly string[]).includes(period)) throw badRequest(`invalid period: ${period}`);
  return period as RatePeriod;
}

/**
 * `GET /v2/exchange_rates/:base/:counter` (`api/routes/getExchangeRate.js`): how many `counter` one `base` buys, as eight
 * significant digits. The checks come in the order of the original: the pair, `period`, the date.
 */
@RippleController('v2/exchange_rates')
export class ExchangeRatesController {
  constructor(
    private readonly rates: RatesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get(':base/:counter')
  @RippleRoute('unable to retrieve exchanges')
  @ApiOperation({
    summary: 'Get the exchange rate of a pair',
    description:
      'How many `counter` one `base` buys at `date`: the average of the volume weighted price of the day of `date` up ' +
      'to it and of the last 50 trades in the 14 days before it, or the latter alone when the day has none. The last ' +
      'trades count only when there are at least 10 of them, unless `strict=false`. With `period`, the volume ' +
      'weighted price of the window of that length that ends a second before `date`. The same asset on both sides is ' +
      '1; a rate that cannot be told is 0. Trades whose native leg is 0.0005 or less are left out.',
  })
  @ApiParam({
    name: 'base',
    description: 'A currency and its issuer, `USD+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`, or the native currency alone.',
  })
  @ApiParam({ name: 'counter', description: 'The other side of the pair, written like `base`.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'The moment the rate is as of, not in the future. Default: now.',
  })
  @ApiQuery({
    name: 'strict',
    required: false,
    type: Boolean,
    description:
      'Default true: the last trades count only when there are at least 10. `false` counts however many there are.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: RATE_PERIODS,
    description:
      'The rate over a rolling window that ends a second before `date`, instead of the daily and the latest rate.',
  })
  @ApiQuery({
    name: 'live',
    required: false,
    type: Boolean,
    description: 'Leave out the daily rate: only the latest trades.',
  })
  async rate(
    @Param('base') baseRaw: string,
    @Param('counter') counterRaw: string,
    @Query() query: QueryParams,
  ): Promise<ExchangeRateBody> {
    const { base, counter } = parseAssetPair(baseRaw, counterRaw, this.profile.nativeCurrency);
    const period = periodOf(query);
    const { date, endExclusive } = rateDate(query);
    const rate = await this.rates.exchangeRate(base, counter, {
      date,
      endExclusive,
      strict: strictFlag(query),
      live: bool(query, 'live'),
      period,
    });
    return { result: 'success', rate: precision8(rate) };
  }
}

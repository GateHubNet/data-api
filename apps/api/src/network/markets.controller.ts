import { MARKETS_PERIODS, MarketsPeriod, NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { MarketsAnswer, NoMarketsAnswer } from './markets-object';
import { MarketsService } from './markets.service';

/** `min_trades` when the request has none. */
const DEFAULT_MIN_TRADES = 10;
const MAX_MIN_TRADES = 1_000_000;

/** The `period`: `day` when missing or empty, else 400 `invalid period - use: day, 7day, 30day`. */
function periodParam(query: QueryParams): MarketsPeriod {
  const period = first(query, 'period');
  if (period === undefined || period === '') return 'day';
  if (!(MARKETS_PERIODS as readonly string[]).includes(period)) {
    throw badRequest(`invalid period - use: ${MARKETS_PERIODS.join(', ')}`);
  }
  return period as MarketsPeriod;
}

/** `min_trades`: 10 when missing or empty, else a whole number from 1 to 1,000,000 (plain digits), else 400 `invalid min_trades`. */
function minTradesParam(query: QueryParams): number {
  const raw = first(query, 'min_trades');
  if (raw === undefined || raw === '') return DEFAULT_MIN_TRADES;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_MIN_TRADES)) throw badRequest('invalid min_trades');
  return n;
}

/**
 * `GET /v2/network/markets` (spec 7): the trade statistics of every pair in a live period, from the newest set of the
 * `markets_live` job (`MarketsService`). A new route: its object and key order are ours (`markets-object.ts`), and it uses the
 * contract layer of the others (the API key, the rate limit, `GH_CACHE_CONTROL`, `format=csv`, errors
 * `{result: "error", message}`). It serves no AMM field, and `amm` is no parameter: it is ignored like any unknown one (spec 8).
 *
 * The checks come in order: `period`, `min_trades`, then the display currency, with the checks and messages of the volume routes.
 */
@RippleController('v2/network')
export class MarketsController {
  constructor(
    private readonly markets: MarketsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get('markets')
  @RippleRoute('unable to retrieve markets')
  @Csv('markets', 'markets')
  @ApiOperation({
    summary: 'Get the trade statistics of every market in a live period',
    description:
      'Every pair that traded in the period (not the markets config), in the canonical stored order of its currencies; a price ' +
      'is counter per base. The pairs with at least `min_trades` trades are listed, by `native_volume`, the largest first, the ' +
      'pairs without one last by `count`, then by the pair; at most `limit`. A trade counts when its native leg is above 0.0005 ' +
      '(as candles). `open`, `high`, `low` and `last` have 8 significant digits; `change` is `(last / open - 1) * 100` in ' +
      'percent, rounded half up to 2 decimals; the volumes are exact. `native_volume` is the volume of the native side of a ' +
      'pair that has one; for another pair the base volume over the rate of the base, or, without one, the counter volume ' +
      'over the rate of the counter (an asset has a rate when it traded against the native currency in the period), cut to 17 ' +
      'significant digits; a pair without a rate has none. `sparkline` is the close of each of the last 7 UTC days, ending ' +
      'with today (a day without a trade carries the close before it; `close` is left out where there is none). `start_time` ' +
      'and `end_time` are the window of the set. `totals.pairs` counts the listed pairs, whatever the limit; ' +
      '`pairs_traded`, `count` and `native_volume` are over every pair that traded. With `exchange_currency` the answer has ' +
      '`exchange` and `exchange_rate` (units of it per native coin, at the rate of the latest trades) and a `converted_volume` ' +
      '(the native volume times the rate) on the totals and on every market that has a native volume. The sets are written ' +
      'every minute (day) or five minutes (7day, 30day); before the first one the answer has no markets.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: MARKETS_PERIODS,
    description: 'The rolling period: the last 24 hours, 7 days or 30 days. Default: day.',
  })
  @ApiQuery({
    name: 'min_trades',
    required: false,
    type: Number,
    description: 'List the pairs with at least this many trades: a whole number from 1 to 1000000. Default: 10.',
  })
  @ApiQuery({
    name: 'exchange_currency',
    required: false,
    description: 'Also show the volumes in this currency. Default: the native currency (nothing is added).',
  })
  @ApiQuery({
    name: 'exchange_issuer',
    required: false,
    description: 'Required for every currency but the native one.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 1000, at most 5000.' })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['json', 'csv'],
    description: 'Default: json (csv: markets.csv).',
  })
  async list(@Query() query: QueryParams): Promise<MarketsAnswer | NoMarketsAnswer> {
    const period = periodParam(query);
    const minTrades = minTradesParam(query);

    // the checks and the messages of the volume routes (`VolumeController`): the exchange currency, upper-cased
    const native = this.profile.nativeCurrency;
    const currency = (first(query, 'exchange_currency') || native).toUpperCase();
    const issuer = first(query, 'exchange_issuer');
    if (currency !== native && !issuer) throw badRequest('exchange currency must have an issuer');
    if (currency === native && issuer) throw badRequest(`${native} cannot have an issuer`);
    if (issuer && !isValidClassicAddress(issuer)) throw badRequest('invalid exchange issuer address');
    const display = currency === native ? undefined : { currency, issuer: issuer as string };

    return this.markets.markets({
      period,
      minTrades,
      limit: limitParam(query, { def: 1000, max: 5000 }),
      ...(display && { display }),
    });
  }
}

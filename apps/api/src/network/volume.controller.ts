import {
  LivePeriod,
  NetworkProfile,
  PAYMENT_LIVE_PERIODS,
  TRADE_LIVE_PERIODS,
  VolumeMetric,
} from '@gatehub/data-api-shared';
import { Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { endExclusive, first, limitParam, parseDate, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { VolumeInterval } from './volume-buckets';
import { VolumeRow } from './volume-object';
import { VOLUME_INTERVALS, VolumeService } from './volume.service';

/** The message of both routes when something other than a Ripple 4xx goes wrong (`getMetric.js`). */
const FAILURE = 'error getting data';

interface VolumeBody {
  result: 'success';
  count: number;
  marker?: string;
  rows: VolumeRow[];
}

/**
 * `GET /v2/network/exchange_volume` and `GET /v2/network/payment_volume` (`api/routes/network/getMetric.js` of the develop
 * branch of the original, which has the historical mode): the trade volume and the payment volume of the network, converted
 * to the native currency or to a display currency. With neither `start` nor `end` it is the live row of a rolling period
 * (`live`, default `day`); with either, a row per day, week or month.
 *
 * The checks come in the order of the original: the exchange currency, `start`, `end`, `interval`, and only without
 * `start` and `end` the live period. The `minute` period of the develop branch is not supported.
 */
@RippleController('v2/network')
export class VolumeController {
  constructor(
    private readonly volumes: VolumeService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  @Get('exchange_volume')
  @RippleRoute(FAILURE)
  @Csv('trade_volume', 'rows')
  @ApiOperation({
    summary: 'Get the volume of the trades on the network',
    description:
      'The trades of the markets of the markets config, in the native currency: per market the base volume, the number of ' +
      'trades and the rate, and the volume converted to the native currency (through the native market of the base or the ' +
      'counter currency; a market without a rate is left out). Without `start` and `end`, the live row of the rolling period ' +
      '`live` (hour, day, 3day, 7day, 30day; default day). With them, a row per `interval` (day, week from Monday, month, UTC) ' +
      'for the days that were computed: a bucket is a row when it starts within `start` and `end`, whole. ' +
      '`exchange_currency` / `exchange_issuer` show the amounts in another currency, at the rate of the live trades (live) ' +
      'or the volume weighted price of the bucket (historical).',
  })
  @ApiQuery({
    name: 'live',
    required: false,
    enum: TRADE_LIVE_PERIODS,
    description: 'Default: day. Ignored with start or end.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time of the historical rows. Default: the epoch.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time of the historical rows. Default: now.' })
  @ApiQuery({ name: 'interval', required: false, enum: VOLUME_INTERVALS, description: 'Default: day.' })
  @ApiQuery({ name: 'exchange_currency', required: false, description: 'Default: the native currency.' })
  @ApiQuery({
    name: 'exchange_issuer',
    required: false,
    description: 'Required for every currency but the native one.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  exchangeVolume(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VolumeBody> {
    return this.rows('trade_volume', TRADE_LIVE_PERIODS, query, req, res);
  }

  @Get('payment_volume')
  @RippleRoute(FAILURE)
  @Csv('payment_volume', 'rows')
  @ApiOperation({
    summary: 'Get the volume of the payments on the network',
    description:
      'The payments in the native currency and in the currencies of the markets config, with the amount, the number of ' +
      'payments and the rate each currency was converted to the native currency with (at the start of the period). A ' +
      'currency without a rate is counted but not listed. Without `start` and `end`, the live row of the rolling period `live` ' +
      '(hour, day; default day). With them, a row per `interval`. `exchange_currency` / `exchange_issuer` as for the ' +
      'exchange volume.',
  })
  @ApiQuery({
    name: 'live',
    required: false,
    enum: PAYMENT_LIVE_PERIODS,
    description: 'Default: day. Ignored with start or end.',
  })
  @ApiQuery({ name: 'start', required: false, description: 'Start time of the historical rows. Default: the epoch.' })
  @ApiQuery({ name: 'end', required: false, description: 'End time of the historical rows. Default: now.' })
  @ApiQuery({ name: 'interval', required: false, enum: VOLUME_INTERVALS, description: 'Default: day.' })
  @ApiQuery({ name: 'exchange_currency', required: false, description: 'Default: the native currency.' })
  @ApiQuery({
    name: 'exchange_issuer',
    required: false,
    description: 'Required for every currency but the native one.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  paymentVolume(
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VolumeBody> {
    return this.rows('payment_volume', PAYMENT_LIVE_PERIODS, query, req, res);
  }

  private async rows(
    metric: VolumeMetric,
    periods: readonly LivePeriod[],
    query: QueryParams,
    req: Request,
    res: Response,
  ): Promise<VolumeBody> {
    const native = this.profile.nativeCurrency;

    // the exchange currency: `(req.query.exchange_currency || 'XRP').toUpperCase()`
    const currency = (first(query, 'exchange_currency') || native).toUpperCase();
    const issuer = first(query, 'exchange_issuer');
    if (currency !== native && !issuer) throw badRequest('exchange currency must have an issuer');
    if (currency === native && issuer) throw badRequest(`${native} cannot have an issuer`);
    if (issuer && !isValidClassicAddress(issuer)) throw badRequest('invalid exchange issuer address');
    const display = currency === native ? undefined : { currency, issuer: issuer as string };

    // `req.query.start ? smoment(...) : null`: an empty one is none
    const startText = first(query, 'start');
    const endText = first(query, 'end');
    const start = startText ? parseDate(startText) : undefined;
    if (startText && !start) throw badRequest('invalid start date format');
    const end = endText ? parseDate(endText) : undefined;
    if (endText && !end) throw badRequest('invalid end date format');

    const interval = first(query, 'interval');
    if (interval && !(VOLUME_INTERVALS as readonly string[]).includes(interval)) {
      throw badRequest(`invalid interval - use: ${VOLUME_INTERVALS.join(', ')}`);
    }

    if (start || end) {
      const now = Math.floor(Date.now() / 1000) * 1000;
      const page = await this.volumes.history({
        metric,
        interval: (interval || 'day') as VolumeInterval,
        start: start ? start.date : new Date(0),
        // a missing end is now, to the second: the bucket that starts now is still in
        endExclusive: end ? endExclusive(end) : new Date(now + 1000),
        limit: limitParam(query, { def: 200, max: 1000 }),
        marker: first(query, 'marker'),
        display,
      });
      setLinkHeader(req, res, page.marker);
      return { result: 'success', count: page.rows.length, marker: page.marker, rows: page.rows };
    }

    const live = first(query, 'live') || 'day';
    if (!(periods as readonly string[]).includes(live)) {
      throw badRequest(`invalid period - use: ${periods.join(', ')}`);
    }
    const rows = await this.volumes.live({ metric, period: live as LivePeriod, display });
    return { result: 'success', count: rows.length, rows };
  }
}

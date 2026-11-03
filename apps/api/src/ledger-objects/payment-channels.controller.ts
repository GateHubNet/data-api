import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { setLinkHeader } from '../common/pagination';
import { bool, first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ObjectAnswers, ObjectHistoryBody, PaymentChannelBody } from './object-answers';
import { objectIdParam } from './object-params';

/** The name of the CSV file of the history of a payment channel: `<id> - payment channel history`. `@Csv` adds the `.csv`. */
const historyFilename = (req: Request): string =>
  `${String(req.params.channel_id).toUpperCase()} - payment channel history`;

/**
 * The payment channel routes under `/v2/payment_channels` (GateHub extras, no Ripple original): the channel by its ID and its
 * history. The id is 64 hex digits in any case, answered in upper case; 400 `invalid channel id` otherwise, and 404 `payment
 * channel not found` for an id that has no row in a committed ledger (a channel created before the index starts is such an id
 * until it is touched). The `coverage`, the key after `result`, is the channel's own: complete when its creation is indexed
 * (spec 1.4).
 */
@RippleController('v2/payment_channels')
export class PaymentChannelsController {
  constructor(private readonly answers: ObjectAnswers) {}

  @Get(':channel_id')
  @RippleRoute('unable to retrieve payment channel')
  @ApiOperation({
    summary: 'Get a payment channel',
    description:
      'The payment channel with the ID, as of the newest committed ledger: its owner (`account`), destination, what was ' +
      'deposited (`amount`), paid out (`balance`) and is left (`remaining`), `settle_delay`, `status` (`open`, `closing`, or ' +
      'once deleted `closed` or `removed`), how many times it was funded and claimed from (`funds`, `claims`), and the ' +
      'newest 50 transactions that changed it. `history_marker` continues them at ' +
      '`/v2/payment_channels/{id}/history?descending=true`.',
  })
  @ApiParam({ name: 'channel_id', description: 'The 64 hex digits of the payment channel ID, in any case.' })
  detail(@Param('channel_id') idRaw: string): Promise<PaymentChannelBody> {
    return this.answers.paymentChannel(objectIdParam(idRaw, 'invalid channel id'));
  }

  @Get(':channel_id/history')
  @RippleRoute('unable to retrieve payment channel history')
  @Csv(historyFilename, 'history')
  @ApiOperation({
    summary: 'Get the history of a payment channel',
    description:
      'The transactions that changed the payment channel (created, funded, claimed from, closed), oldest first, or newest ' +
      'first with `descending=true`. `format=csv` gives the events as a CSV file (without `coverage`).',
  })
  @ApiParam({ name: 'channel_id', description: 'The 64 hex digits of the payment channel ID, in any case.' })
  @ApiQuery({ name: 'descending', required: false, type: Boolean, description: 'Newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async history(
    @Param('channel_id') idRaw: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ObjectHistoryBody> {
    // the parameters are checked in their order: the id, then the limit (it has no error) and the marker (the service)
    const id = objectIdParam(idRaw, 'invalid channel id');
    const body = await this.answers.history('payment_channel', id, {
      descending: bool(query, 'descending'),
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
      csv: wantsCsv(query),
    });
    setLinkHeader(req, res, body.marker);
    return body;
  }
}

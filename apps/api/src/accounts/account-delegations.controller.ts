import { Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request, Response } from 'express';
import { isValidClassicAddress } from 'ripple-address-codec';
import { Csv, wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import { setLinkHeader } from '../common/pagination';
import { first, limitParam, Query as QueryParams } from '../common/params';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { DelegationDirection, DelegationsBody, DelegationsService } from './delegations.service';

/** The `direction` of a request: `given` when it is missing or empty, `held`, or 400 `invalid direction`. */
function directionParam(query: QueryParams): DelegationDirection {
  const raw = first(query, 'direction');
  if (raw === undefined || raw === '' || raw === 'given') return 'given';
  if (raw === 'held') return 'held';
  throw badRequest('invalid direction');
}

/** The name of the CSV file of the delegations of an account: `<address> - delegations given` or `… held`. `@Csv` adds the `.csv`. */
const delegationsFilename = (req: Request): string =>
  `${String(req.params.address)} - delegations ${directionParam(req.query as QueryParams)}`;

/**
 * `GET /v2/accounts/:address/delegations` (a GateHub extra, no Ripple original): the delegations an account gave (it is the
 * `Account` of the entry) or holds (it is the `Authorize`), the ones in the ledger as of the newest committed ledger, the entry
 * changed last first. Unlike most routes under an account the address is checked: an X-address is no address here (400
 * `invalid ripple address`). The checks come in the order of the parameters: the address, the `direction` (400 `invalid
 * direction`), then the `limit` (it has no error) and the `marker` (400 `invalid marker`). `coverage`, the key after `result`, is
 * the feature's own (spec section 4).
 */
@RippleController('v2/accounts')
export class AccountDelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get(':address/delegations')
  @RippleRoute('unable to retrieve delegations')
  @Csv(delegationsFilename, 'delegations')
  @ApiOperation({
    summary: 'Get the delegations of an account',
    description:
      'The delegations the account gave (`direction=given`, the default: it is the `account` of the entry) or holds ' +
      '(`direction=held`: it is the `authorize`) that are in the ledger as of the newest committed ledger, the entry changed ' +
      'last first, then by `delegation_id`. Each lists the `permissions` the delegate was given, with the last transaction that ' +
      'changed the entry (`updated`) and the one that made it (`created`, when it is indexed). An entry whose list was emptied ' +
      'is deleted and is not listed. `format=csv` gives the delegations as a CSV file, with the permission names in one ' +
      'cell separated by a space (without `coverage`). Xahau has no delegation: its list is empty.',
  })
  @ApiParam({ name: 'address', description: 'The address of the account (a classic address).' })
  @ApiQuery({
    name: 'direction',
    required: false,
    enum: ['given', 'held'],
    description: '`given` (default): the delegations the account made. `held`: those it was given.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 200, at most 1000.' })
  @ApiQuery({ name: 'marker', required: false, description: 'From the previous page.' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Default: json.' })
  async list(
    @Param('address') address: string,
    @Query() query: QueryParams,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DelegationsBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    const direction = directionParam(query);
    // the limit has no error, and the marker is the service's
    const body = await this.delegations.answer(address, {
      direction,
      limit: limitParam(query, { def: 200, max: 1000 }),
      marker: first(query, 'marker'),
      csv: wantsCsv(query),
    });
    setLinkHeader(req, res, body.marker);
    return body;
  }
}

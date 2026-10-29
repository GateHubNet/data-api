import { Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam } from '@nestjs/swagger';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { LedgerObjectLookup, LedgerObjectsService } from './ledger-objects.service';
import { objectIdParam } from './object-params';

/** `GET /v2/ledger_objects/{id}`: the keys are `result`, then `ledger_object` (`LEDGER_OBJECT_KEYS`). */
export interface LedgerObjectBody {
  result: 'success';
  ledger_object: LedgerObjectLookup;
}

/**
 * `GET /v2/ledger_objects/:object_id` (a GateHub extra, no Ripple original): which kind of object an ID is. Of the objects the
 * index follows (escrows, checks, payment channels and delegations) it says the type, the owner, whether the newest row of the
 * object deleted it, and the ledger of that row. The answer is a lookup: it has no `coverage`, `ledger_index` or `close_time`
 * of its own beside the object's. The id is 64 hex digits in any case, answered in upper case; 400 `invalid ledger object id`
 * otherwise, and 404 `ledger object not found` for an id that has no row in a committed ledger.
 */
@RippleController('v2/ledger_objects')
export class LedgerObjectsController {
  constructor(private readonly objects: LedgerObjectsService) {}

  @Get(':object_id')
  @RippleRoute('unable to retrieve ledger object')
  @ApiOperation({
    summary: 'Look up a ledger object by its ID',
    description:
      'Which kind of object the ID is, among the escrows, checks, payment channels and delegations: its `object_type` ' +
      '(`Escrow`, `Check`, `PayChannel` or `Delegate`), its owner (`account`), whether it was `deleted`, and the ledger of its newest ' +
      'row, as of the newest committed ledger. An object that was created before the index starts and has not been touched since ' +
      'is not known.',
  })
  @ApiParam({ name: 'object_id', description: 'The 64 hex digits of the object ID, in any case.' })
  async lookup(@Param('object_id') idRaw: string): Promise<LedgerObjectBody> {
    const id = objectIdParam(idRaw, 'invalid ledger object id');
    return { result: 'success', ledger_object: await this.objects.lookup(id) };
  }
}

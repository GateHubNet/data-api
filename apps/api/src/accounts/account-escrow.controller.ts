import { escrowId } from '@gatehub/data-api-shared';
import { Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam } from '@nestjs/swagger';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { EscrowBody, ObjectAnswers } from '../ledger-objects/object-answers';

const DIGITS = /^\d+$/;
const MAX_UINT32 = 4_294_967_295;

/**
 * `GET /v2/accounts/:address/escrows/:sequence` (a GateHub extra, no Ripple original): the escrow an account created with
 * this `Sequence` (or `TicketSequence`), answered exactly as `GET /v2/escrows/{id}` answers the escrow's ID, which is worked
 * out from the owner and the sequence before any read. Unlike most routes under an account the address is checked, as it is
 * part of the ID: an X-address is no address here (400 `invalid ripple address`), as is a sequence that is no UInt32
 * (400 `invalid sequence number`, the message of `/transactions/{sequence}`).
 */
@RippleController('v2/accounts')
export class AccountEscrowController {
  constructor(private readonly answers: ObjectAnswers) {}

  @Get(':address/escrows/:sequence')
  @RippleRoute('unable to retrieve escrow')
  @ApiOperation({
    summary: 'Get the escrow an account created with a sequence',
    description:
      'The escrow the account created with this `Sequence` (a ticketed `EscrowCreate`: its `TicketSequence`), as ' +
      '`GET /v2/escrows/{escrow_id}` gives it.',
  })
  @ApiParam({ name: 'address', description: 'The address of the escrow owner (a classic address).' })
  @ApiParam({
    name: 'sequence',
    description: 'The `Sequence` (or `TicketSequence`) of the `EscrowCreate`: digits, at most 4294967295.',
  })
  escrow(@Param('address') address: string, @Param('sequence') sequence: string): Promise<EscrowBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    if (!DIGITS.test(sequence) || Number(sequence) > MAX_UINT32) throw badRequest('invalid sequence number');

    return this.answers.escrow(escrowId(address, Number(sequence)));
  }
}

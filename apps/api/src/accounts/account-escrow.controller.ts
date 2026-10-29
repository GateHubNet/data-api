import { escrowId, NetworkProfile } from '@gatehub/data-api-shared';
import { Get, Inject, Param } from '@nestjs/common';
import { ApiOperation, ApiParam } from '@nestjs/swagger';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { NETWORK_PROFILE } from '../config/api.config';
import { EscrowBody, escrowBody } from '../ledger-objects/escrows.controller';
import { FEATURE_OF, LedgerObjectsService } from '../ledger-objects/ledger-objects.service';

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
  constructor(
    private readonly objects: LedgerObjectsService,
    private readonly coverage: FeatureCoverageService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

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
  async escrow(@Param('address') address: string, @Param('sequence') sequence: string): Promise<EscrowBody> {
    if (!isValidClassicAddress(address)) throw badRequest('invalid ripple address');
    if (!DIGITS.test(sequence) || Number(sequence) > MAX_UINT32) throw badRequest('invalid sequence number');

    const detail = await this.objects.detail('escrow', escrowId(address, Number(sequence)));
    const coverage = await this.coverage.itemCoverage(FEATURE_OF.escrow, detail.created?.ledger_index);
    return escrowBody(detail, coverage, this.profile.nativeCurrency);
  }
}

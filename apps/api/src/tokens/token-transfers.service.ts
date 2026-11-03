import { Injectable } from '@nestjs/common';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { PaymentsQuery, PaymentsService } from '../payments/payments.service';
import { TransferRow, transferRow } from './token-objects';
import { TokenRef } from './token-param';

/**
 * The transfers of an issued token (spec 5.4): the payments that delivered it, which `PaymentsService` lists for the asset
 * (`payments_by_currency`, the keys read by `readDistinctPage`, then the rows of the page from `payments`), each as a `transferRow`.
 * Payments to oneself are not payments (ADR-0010 item 66), so the parser has not written them and the list has none.
 *
 * The list does not look the token up in the aggregate: a token it does not know, and an LP currency, list the transfers they have.
 */
@Injectable()
export class TokenTransfersService {
  constructor(
    private readonly payments: PaymentsService,
    private readonly features: FeatureCoverageService,
  ) {}

  /** The coverage of the feature `token_transfers`: every stored ledger has its payments (parser version 1). */
  coverage(): Promise<Coverage> {
    return this.features.coverage('token_transfers');
  }

  /**
   * One page of the transfers of the token, in the order asked for, with the marker of the next page when there is one. The marker
   * is that of `/v2/payments` (`(ledger_index, tx_index)`): `PaymentsService.list` decodes it before it reads anything, and answers
   * 400 `invalid marker` for one that is none of its own.
   */
  async page(ref: TokenRef, q: Omit<PaymentsQuery, 'asset'>): Promise<{ rows: TransferRow[]; marker?: string }> {
    const page = await this.payments.list({ ...q, asset: { currency: ref.currency, issuer: ref.issuer } });
    return { rows: page.payments.map(transferRow), ...(page.marker !== undefined && { marker: page.marker }) };
  }
}

import { Injectable } from '@nestjs/common';
import { AccountsCreatedParser, ParsedAccountCreated } from './accounts-created.parser';
import { AffectedAccountsParser, ParsedAffectedAccount } from './affected-accounts.parser';
import { BalanceChangesParser, ParsedBalanceChange } from './balance-changes.parser';
import { EscrowParser, ParsedEscrow } from './escrow.parser';
import { ExchangeParser, ParsedExchange } from './exchanges.parser';
import { FromClientParser } from './from-client.parser';
import { IssuersParser, ParsedIssuerTrustline } from './issuers.parser';
import { OffersParser, ParsedOffer } from './offers.parser';
import { LedgerTransaction, XrplTx } from './parser.interface';
import { ParsedPayChannel, PaychanParser } from './paychan.parser';
import { ParsedPayment, PaymentParser } from './payment.parser';

export interface ParsedTransaction {
  rawTransaction: XrplTx;
  payment?: ParsedPayment;
  exchanges: ParsedExchange[];
  balanceChanges: ParsedBalanceChange[];
  accountsCreated: ParsedAccountCreated[];
  affectedAccounts: ParsedAffectedAccount[];
  offers: ParsedOffer[];
  issuers: ParsedIssuerTrustline[];
  escrow?: ParsedEscrow;
  paychannel?: ParsedPayChannel;
}

/**
 * Runs the full parser suite over a single transaction. Pure and synchronous —
 * no network calls (issuer trustlines are derived from metadata, see IssuersParser).
 */
@Injectable()
export class ParsingService {
  private readonly offersParser = new OffersParser();
  private readonly paymentParser = new PaymentParser();
  private readonly paychanParser = new PaychanParser();
  private readonly escrowParser = new EscrowParser();
  private readonly clientParser = new FromClientParser();
  private readonly exchangesParser = new ExchangeParser();
  private readonly balanceChangesParser = new BalanceChangesParser();
  private readonly accountsCreatedParser = new AccountsCreatedParser();
  private readonly affectedAccountsParser = new AffectedAccountsParser();
  private readonly issuersParser = new IssuersParser();

  parseClient(transaction: LedgerTransaction): string | null {
    return this.clientParser.parse(transaction as unknown as XrplTx);
  }

  parseTransaction(transaction: XrplTx): ParsedTransaction {
    return {
      rawTransaction: transaction,
      payment: this.paymentParser.parse(transaction),
      exchanges: this.exchangesParser.parse(transaction),
      balanceChanges: this.balanceChangesParser.parse(transaction),
      accountsCreated: this.accountsCreatedParser.parse(transaction),
      affectedAccounts: this.affectedAccountsParser.parse(transaction),
      offers: this.offersParser.parse(transaction),
      issuers: this.issuersParser.parse(transaction),
      escrow: this.escrowParser.parse(transaction),
      paychannel: this.paychanParser.parse(transaction),
    };
  }
}

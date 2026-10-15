import { BigNumber } from 'bignumber.js';
import { parseBalanceChanges } from 'ripple-lib-transactionparser';
import * as xrpl from 'xrpl';
import { IssuedCurrencyAmount } from 'xrpl/dist/npm/models/common';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedPayment {
  source: string;
  destination: string;
  source_balance_changes: unknown[];
  destination_balance_changes: unknown[];
  currency: string;
  amount: string;
  delivered_amount: string;
  source_currency?: string;
  max_amount?: string;
  issuer?: string;
  destination_tag?: number;
  source_tag?: number;
  invoice_id?: string;
  fee: string;
  ledger_index: number;
  tx_index: number;
  date: number;
  tx_hash: string;
  client?: string | null;
}

export class PaymentParser implements IParser<ParsedPayment | undefined> {
  private setIssuer(data: XrplTx, payment: ParsedPayment): ParsedPayment {
    const metadata = data.meta;
    const transaction = data as xrpl.Payment;

    // XRP is native, so no issuer.
    if (payment.currency === 'XRP') {
      return payment;
    }

    const amount = transaction.Amount as IssuedCurrencyAmount;
    if (payment.source !== amount.issuer && payment.destination !== amount.issuer) {
      payment.issuer = amount.issuer;
      return payment;
    }

    for (const affNode of metadata!.AffectedNodes) {
      const node =
        (affNode as any).CreatedNode || (affNode as any).ModifiedNode || (affNode as any).DeletedNode;

      if (!node || node.LedgerEntryType !== 'RippleState' || !node.FinalFields) {
        continue;
      }
      if (node.FinalFields.HighLimit.currency !== payment.currency) {
        continue;
      }

      const high = node.FinalFields.HighLimit.issuer;
      const low = node.FinalFields.LowLimit.issuer;

      if (high === payment.destination || low === payment.destination) {
        const balance = parseFloat(node.FinalFields.Balance.value);
        const previous = node.PreviousFields ? parseFloat(node.PreviousFields.Balance.value) : 0;
        // A negative (or previously-negative) balance means the low-limit account is the issuer.
        payment.issuer = balance < 0 || previous < 0 ? low : high;
        return payment;
      }
    }

    return payment;
  }

  public parse(transaction: XrplTx): ParsedPayment | undefined {
    const metadata = transaction.meta;
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS' || transaction.TransactionType !== 'Payment') {
      return undefined;
    }
    // A payment to self is not a real payment (it is an exchange / no-op).
    if (transaction.Account === transaction.Destination) {
      return undefined;
    }

    const balanceChanges = parseBalanceChanges(metadata);

    const payment: ParsedPayment = {
      source: transaction.Account,
      destination: transaction.Destination,
      source_balance_changes: [],
      // FIX (review C4/H4): guard against a missing destination entry instead of assuming it exists.
      destination_balance_changes: balanceChanges[transaction.Destination] ?? [],
      currency: 'XRP',
      amount: '0',
      delivered_amount: '0',
      fee: xrpl.dropsToXrp(new BigNumber(transaction.Fee ?? '0')).toString(),
      ledger_index: transaction.ledger_index,
      tx_index: metadata.TransactionIndex,
      date: transaction.date,
      tx_hash: transaction.hash,
      client: transaction.client,
    };

    // FIX (review H4): the source may have no balance change in some flows — guard it.
    const sourceChanges = balanceChanges[transaction.Account] ?? [];
    for (const change of sourceChanges) {
      if (change.currency === 'XRP') {
        // The source's net XRP change already includes the transaction fee, e.g.
        // -(amount + fee). Add the fee back to isolate the payment amount itself.
        // (The fee is recorded separately as a 'fee' balance change.)
        const fee = xrpl.dropsToXrp(new BigNumber(transaction.Fee ?? '0'));
        change.value = new BigNumber(change.value).plus(fee).toString();
      }
      if (change.value !== '0') {
        (payment.source_balance_changes as unknown[]).push(change);
      }
    }

    if (transaction.DestinationTag !== undefined) payment.destination_tag = transaction.DestinationTag;
    if (transaction.SourceTag !== undefined) payment.source_tag = transaction.SourceTag;
    if (transaction.InvoiceID) payment.invoice_id = transaction.InvoiceID;

    if (typeof transaction.Amount === 'object') {
      payment.currency = transaction.Amount.currency;
      payment.amount = transaction.Amount.value;
    } else {
      payment.currency = 'XRP';
      payment.amount = xrpl.dropsToXrp(transaction.Amount).toString();
    }

    const amount = (metadata as any).DeliveredAmount || (metadata as any).delivered_amount || transaction.Amount;
    payment.delivered_amount =
      typeof amount === 'object' ? amount.value : xrpl.dropsToXrp(new BigNumber(amount)).toString();

    if (typeof transaction.SendMax === 'object') {
      payment.max_amount = transaction.SendMax.value;
      payment.source_currency = transaction.SendMax.currency;
    } else if (transaction.SendMax) {
      payment.max_amount = xrpl.dropsToXrp(new BigNumber(transaction.SendMax)).toString();
      payment.source_currency = 'XRP';
    }

    if (!payment.source_currency && payment.source_balance_changes.length) {
      payment.source_currency = (payment.source_balance_changes[0] as { currency: string }).currency;
    }

    return this.setIssuer(transaction, payment);
  }
}

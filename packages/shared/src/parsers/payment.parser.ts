import { BigNumber } from 'bignumber.js';
import { parseBalanceChanges } from 'ripple-lib-transactionparser';
import { dropsToNative } from '../util/amount';
import { ParseContext, ParserTx } from './parser.interface';

/** A balance change as `ripple-lib-transactionparser` reports it, but with the native currency remapped. */
export interface BalanceChangeAmount {
  /** The other side of the trustline; `''` for the native currency. */
  counterparty: string;
  currency: string;
  value: string;
}

export interface ParsedPayment {
  source: string;
  destination: string;
  /** Currency of `Amount`. */
  currency: string;
  /** Issuer of `Amount`, resolved from the trustlines when `Amount.issuer` is a party to the payment. Native: unset. */
  issuer?: string;
  /** `Amount` in whole units. */
  amount: string;
  /** What actually arrived, in whole units. Differs from `amount` for partial payments. */
  delivered_amount: string;
  max_amount?: string;
  source_currency: string;
  source_tag?: number;
  destination_tag?: number;
  invoice_id?: string;
  /** The transaction's `Fee`, in drops. */
  fee_drops: string;
  /** The source's balance changes. The native one excludes the fee. */
  source_balance_changes: BalanceChangeAmount[];
  destination_balance_changes: BalanceChangeAmount[];
}

const TF_PARTIAL_PAYMENT = 0x00020000;

type Json = Readonly<Record<string, any>>;

function isMptAmount(amount: unknown): boolean {
  return typeof amount === 'object' && amount !== null && (amount as Json).mpt_issuance_id !== undefined;
}

/**
 * The amount a Payment actually delivered, as it appears on the wire (drops string or IOU object), or
 * `'unavailable'` when it cannot be known.
 *
 * Mirrors rippled's `delivered_amount` rules and the Ripple Data API: `DeliveredAmount`, else the `delivered_amount`
 * that rippled adds to API v1 metadata, else `Amount` when the payment is not partial or the ledger is after
 * `ctx.partialPaymentFixLedger`. A partial payment from earlier ledgers carries no delivered amount.
 */
export function deliveredAmount(tx: Json, meta: Json, ledgerIndex: number, ctx: ParseContext): unknown | 'unavailable' {
  if (meta.DeliveredAmount !== undefined && meta.DeliveredAmount !== null) return meta.DeliveredAmount;
  if (meta.delivered_amount !== undefined && meta.delivered_amount !== null) return meta.delivered_amount;

  const partial = (Number(tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0;
  return !partial || ledgerIndex > ctx.partialPaymentFixLedger ? tx.Amount : 'unavailable';
}

/** The whole-unit value of an amount: an issued currency's `value`, or native drops converted. */
function amountValue(amount: unknown): string {
  return typeof amount === 'object' && amount !== null ? (amount as Json).value : dropsToNative(amount as string);
}

export class PaymentParser {
  /**
   * Turn a successful Payment into the row the API serves. Matches `ledgerParser/payment.js` of the Ripple Data API:
   * - only `tesSUCCESS` Payments between two different accounts are payments (a payment to self is a conversion);
   * - source and destination tags are kept when present, including 0 (the reference dropped 0, ruling R10); an empty
   *   invoice id is left out;
   * - `delivered_amount` falls back to `Amount` for a partial payment whose delivered amount is `'unavailable'`.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedPayment | undefined {
    const { tx, meta } = t;
    if (tx.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS') return undefined;
    if (tx.Account === tx.Destination) return undefined;
    if ([tx.Amount, tx.SendMax, meta.DeliveredAmount, meta.delivered_amount].some(isMptAmount)) return undefined;

    const changes = parseBalanceChanges(meta);
    const fee = dropsToNative(tx.Fee ?? '0');

    const isNative = (change: { counterparty: string; currency: string }) =>
      change.counterparty === '' && change.currency === 'XRP';
    const remap = (value: string, change: { counterparty: string; currency: string }): BalanceChangeAmount => ({
      counterparty: change.counterparty,
      currency: isNative(change) ? ctx.nativeCurrency : change.currency,
      value,
    });

    // The library reports the source's native change as -(amount + fee); the payment amount itself excludes the fee.
    const sourceChanges: BalanceChangeAmount[] = [];
    for (const change of changes[tx.Account] ?? []) {
      const value = isNative(change) ? new BigNumber(change.value).plus(fee).toString() : change.value;
      if (value !== '0') sourceChanges.push(remap(value, change));
    }
    const destinationChanges = (changes[tx.Destination] ?? []).map((change) => remap(change.value, change));

    const issued = typeof tx.Amount === 'object';
    const delivered = deliveredAmount(tx, meta, t.ledger_index, ctx);

    const payment: ParsedPayment = {
      source: tx.Account,
      destination: tx.Destination,
      currency: issued ? tx.Amount.currency : ctx.nativeCurrency,
      amount: amountValue(tx.Amount),
      delivered_amount: amountValue(delivered === 'unavailable' ? tx.Amount : delivered),
      // Without SendMax rippled spends the currency it delivers.
      source_currency: sourceChanges[0]?.currency ?? (issued ? tx.Amount.currency : ctx.nativeCurrency),
      fee_drops: String(tx.Fee ?? '0'),
      source_balance_changes: sourceChanges,
      destination_balance_changes: destinationChanges,
    };

    if (tx.SendMax !== undefined && tx.SendMax !== null) {
      payment.max_amount = amountValue(tx.SendMax);
      payment.source_currency = typeof tx.SendMax === 'object' ? tx.SendMax.currency : ctx.nativeCurrency;
    }
    if (tx.SourceTag !== undefined && tx.SourceTag !== null) payment.source_tag = tx.SourceTag;
    if (tx.DestinationTag !== undefined && tx.DestinationTag !== null) payment.destination_tag = tx.DestinationTag;
    if (tx.InvoiceID) payment.invoice_id = tx.InvoiceID;

    if (issued) {
      const issuer = this.issuer(t, payment);
      if (issuer !== undefined) payment.issuer = issuer;
    }
    return payment;
  }

  /**
   * Who issued the delivered currency. `Amount.issuer` is the answer unless it names a party to the payment, in which
   * case it means "any issuer that party trusts", and the RippleState nodes the payment touched say which one it was.
   */
  private issuer(t: ParserTx, payment: ParsedPayment): string | undefined {
    const amountIssuer: string = t.tx.Amount.issuer;
    if (payment.source !== amountIssuer && payment.destination !== amountIssuer) return amountIssuer;

    for (const affected of t.meta.AffectedNodes ?? []) {
      const node: Json | undefined = affected.CreatedNode ?? affected.ModifiedNode ?? affected.DeletedNode;
      if (!node || node.LedgerEntryType !== 'RippleState') continue;

      // A trustline created by this payment has NewFields instead of FinalFields.
      const fields: Json | undefined = node.FinalFields ?? node.NewFields;
      if (!fields || fields.HighLimit?.currency !== payment.currency) continue;

      const high: string = fields.HighLimit.issuer;
      const low: string = fields.LowLimit.issuer;
      if (high !== payment.destination && low !== payment.destination) continue;

      const balance = parseFloat(fields.Balance?.value);
      const previous = parseFloat(node.PreviousFields?.Balance?.value ?? '0');
      // The balance is from the low account's perspective: when it is, or was, negative the low account owes, so it
      // is the issuer.
      return balance < 0 || previous < 0 ? low : high;
    }
    return undefined;
  }
}

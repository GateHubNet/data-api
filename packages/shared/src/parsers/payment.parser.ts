import { BigNumber } from 'bignumber.js';
import { parseBalanceChanges } from 'ripple-lib-transactionparser';
import { dropsToNative } from '../util/amount';
import { mptIssuerOf } from '../util/mpt';
import { mptAmountIssuance, MptDeltas, mptDeltas, mptPaymentIssuance, mptUnits } from './mpt-deltas';
import { feePayer, ParseContext, ParserTx } from './parser.interface';

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
  /** Currency of `Amount`: an MPT's is its issuance ID, 48 upper-case hex digits. */
  currency: string;
  /**
   * Issuer of `Amount`, resolved from the trustlines when `Amount.issuer` is a party to the payment; an MPT's is the one its ID
   * holds. Native: unset.
   */
  issuer?: string;
  /** `Amount` in whole units; an MPT's in the ledger's integer units, never scaled. */
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

/** The integer units of an MPT amount, `'0'` when they are not a `UInt64`: a ledger cannot hold that, and nothing throws here. */
const mptValue = (amount: unknown): string => String(mptUnits((amount as Json | undefined)?.value) ?? 0n);

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

/**
 * What a partial MPT payment moved when the ledger stored no `DeliveredAmount`: before fixMPTDeliveredAmount it stored none, and the
 * node's `delivered_amount` is then only `Amount` (FINDINGS (5)). It is the destination's rise, or the fall of `OutstandingAmount` for
 * a payment to the issuer, which holds no `MPToken`. `undefined` for every other payment, which `deliveredAmount` reads.
 */
export function mptPartialDelivered(tx: Json, meta: Json, id: string, deltas: MptDeltas): bigint | undefined {
  if ((Number(tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) === 0) return undefined;
  if (meta.DeliveredAmount !== undefined && meta.DeliveredAmount !== null) return undefined;
  let moved = 0n;
  if (tx.Destination === mptIssuerOf(id)) {
    const issuance = deltas.issuances.find((i) => i.mpt_issuance_id === id);
    if (issuance !== undefined) moved = issuance.outstanding_before - issuance.outstanding_after;
  } else {
    const holder = deltas.holders.find((h) => h.holder === tx.Destination && h.mpt_issuance_id === id);
    if (holder !== undefined) moved = holder.amount_after - holder.amount_before;
  }
  return moved > 0n ? moved : undefined;
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
   * - `delivered_amount` falls back to `Amount` for a partial payment whose delivered amount is `'unavailable'`;
   * - an MPT payment (a GateHub extra) is read by `mptPayment`. A mixed one, which only MPTokensV2 can make, and one whose ID is
   *   not 48 hex digits are left out, as the reference leaves out every MPT.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedPayment | undefined {
    const { tx, meta } = t;
    if (tx.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS') return undefined;
    if (tx.Account === tx.Destination) return undefined;
    const hasMpt = [tx.Amount, tx.DeliverMax, tx.SendMax, meta.DeliveredAmount, meta.delivered_amount].some(
      isMptAmount,
    );
    const mptId = hasMpt ? mptPaymentIssuance(tx, meta) : undefined;
    if (hasMpt && mptId === undefined) return undefined;

    const changes = parseBalanceChanges(meta);
    const fee = dropsToNative(tx.Fee ?? '0');

    const isNative = (change: { counterparty: string; currency: string }) =>
      change.counterparty === '' && change.currency === 'XRP';
    const remap = (value: string, change: { counterparty: string; currency: string }): BalanceChangeAmount => ({
      counterparty: change.counterparty,
      currency: isNative(change) ? ctx.nativeCurrency : change.currency,
      value,
    });

    // The library reports the source's native change as -(amount + fee); the payment amount itself excludes the fee. A
    // delegate pays the fee of a delegated Payment, so the source's change is the amount alone and there is no fee to add.
    const sourcePaysFee = feePayer(tx) === tx.Account;
    const sourceChanges: BalanceChangeAmount[] = [];
    for (const change of changes[tx.Account] ?? []) {
      const value = isNative(change) && sourcePaysFee ? new BigNumber(change.value).plus(fee).toString() : change.value;
      if (value !== '0') sourceChanges.push(remap(value, change));
    }
    // A delegate that is the Payment's Destination (it sweeps the delegator's funds to itself) pays the fee out of what
    // arrives: the library reports its native change as what arrived less the fee (-fee for a token payment, nothing when
    // the two cancel). The fee goes back on, and a native change that is then 0 is none. Any other destination is as the
    // library reports it.
    const destinationPaysFee = feePayer(tx) === tx.Destination;
    const destinationChanges: BalanceChangeAmount[] = [];
    let feeAddedBack = false;
    for (const change of changes[tx.Destination] ?? []) {
      if (!(isNative(change) && destinationPaysFee)) {
        destinationChanges.push(remap(change.value, change));
        continue;
      }
      feeAddedBack = true;
      const value = new BigNumber(change.value).plus(fee).toFixed();
      if (value !== '0') destinationChanges.push(remap(value, change));
    }
    if (destinationPaysFee && !feeAddedBack && !new BigNumber(fee).isZero()) {
      destinationChanges.push({ counterparty: '', currency: ctx.nativeCurrency, value: fee });
    }

    if (mptId !== undefined) return this.mptPayment(t, ctx, mptId, sourceChanges, destinationChanges);

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
    this.setTags(payment, tx);

    if (issued) {
      const issuer = this.issuer(t, payment);
      if (issuer !== undefined) payment.issuer = issuer;
    }
    return payment;
  }

  /**
   * An MPT payment: `currency` the issuance ID, `issuer` the one the ID holds, amounts in the ledger's integer units. The library
   * knows no `MPToken`, so the MPT entries, after its own, come from `mptDeltas`: a holder's is the change of its `MPTAmount` with
   * the issuer as `counterparty`, and the issuer's, when it sends or receives, the change of `OutstandingAmount` negated with the
   * other party as `counterparty`. An entry of value 0 is left out. A transfer fee is on top of `Amount`, so the source's entry holds
   * it.
   */
  private mptPayment(
    t: ParserTx,
    ctx: ParseContext,
    id: string,
    sourceChanges: BalanceChangeAmount[],
    destinationChanges: BalanceChangeAmount[],
  ): ParsedPayment {
    const { tx, meta } = t;
    const issuer = mptIssuerOf(id);
    const asked = tx.Amount ?? tx.DeliverMax;
    const delivered = deliveredAmount(tx, meta, t.ledger_index, ctx);

    const deltas = mptDeltas(tx, meta);
    const issuance = deltas.issuances.find((i) => i.mpt_issuance_id === id);
    const changeOf = (account: string): bigint => {
      if (account === issuer)
        return issuance === undefined ? 0n : issuance.outstanding_before - issuance.outstanding_after;
      const holder = deltas.holders.find((h) => h.holder === account && h.mpt_issuance_id === id);
      return holder === undefined ? 0n : holder.amount_after - holder.amount_before;
    };
    const addEntry = (changes: BalanceChangeAmount[], account: string, other: string): void => {
      const value = changeOf(account);
      if (value !== 0n) {
        changes.push({ counterparty: account === issuer ? other : issuer, currency: id, value: String(value) });
      }
    };
    addEntry(sourceChanges, tx.Account, tx.Destination);
    addEntry(destinationChanges, tx.Destination, tx.Account);

    const payment: ParsedPayment = {
      source: tx.Account,
      destination: tx.Destination,
      currency: id,
      issuer,
      amount: mptValue(asked),
      delivered_amount: String(
        mptPartialDelivered(tx, meta, id, deltas) ?? mptValue(mptAmountIssuance(delivered) === id ? delivered : asked),
      ),
      source_currency: id,
      fee_drops: String(tx.Fee ?? '0'),
      source_balance_changes: sourceChanges,
      destination_balance_changes: destinationChanges,
    };
    if (tx.SendMax !== undefined && tx.SendMax !== null) payment.max_amount = mptValue(tx.SendMax);
    this.setTags(payment, tx);
    return payment;
  }

  private setTags(payment: ParsedPayment, tx: Json): void {
    if (tx.SourceTag !== undefined && tx.SourceTag !== null) payment.source_tag = tx.SourceTag;
    if (tx.DestinationTag !== undefined && tx.DestinationTag !== null) payment.destination_tag = tx.DestinationTag;
    if (tx.InvoiceID) payment.invoice_id = tx.InvoiceID;
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

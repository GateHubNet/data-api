import { BigNumber } from 'bignumber.js';
import { dropsToNative } from '../util/amount';
import { ParseContext, ParserTx } from './parser.interface';

export interface ParsedBalanceChange {
  account: string;
  /** The other side of the trustline; `''` for the native currency. */
  counterparty: string;
  currency: string;
  /** Whole units, exact. */
  amount_change: string;
  /** The balance after the change, whole units, exact. */
  final_balance: string;
  /** Index of the node in `meta.AffectedNodes`; `-1` for the transaction cost. */
  node_index: number;
  /**
   * `'transaction_cost'`, `'payment_source'`, `'payment_destination'`, `'exchange'`, `'intermediary'`,
   * `'escrow_create'`, `'escrow_cancel'`, `'escrow_finish'`, `'paychannel_fund'` or `'paychannel_payout'`; `''` when the
   * change has none of them.
   */
  change_type: string;
  escrow_counterparty?: string;
  escrow_balance_change?: string;
  paychannel_counterparty?: string;
  paychannel_fund_change?: string;
  paychannel_fund_final_balance?: string;
  paychannel_final_balance?: string;
  paychannel_balance_change?: string;
}

type Json = Readonly<Record<string, any>>;

const ZERO = new BigNumber(0);

/** The value of an escrowed amount in whole units: drops converted, an issued currency or token as it is. */
function escrowValue(amount: unknown): BigNumber {
  if (typeof amount === 'object' && amount !== null) return new BigNumber((amount as Json).value);
  return new BigNumber(dropsToNative(amount as string));
}

export class BalanceChangesParser {
  /**
   * Every balance change a transaction made, in the order of `meta.AffectedNodes`. Matches
   * `ledgerParser/balanceChanges.js` of the Ripple Data API, so a `tesSUCCESS` or `tec` transaction gives:
   * - for each changed `AccountRoot`, in the native currency: if it is the sender's, a `transaction_cost` row at node
   *   -1 whose `final_balance` is the balance after the fee and before the transaction's other effect on it; then a
   *   row for that other effect if there is one;
   * - for each trustline whose balance changed, one row for the low and one for the high side, from each side's point
   *   of view.
   * `change_type` is the reference's `findType` for a Payment or OfferCreate, `''` for every other transaction type;
   * rows of an account that is a party to an `Escrow` or `PayChannel` the transaction touched, and have no type yet, become
   * `escrow_*` or `paychannel_*` rows. Differences from the reference:
   * - the native currency is `ctx.nativeCurrency`, and a row is native because it comes from an `AccountRoot`, not
   *   because its currency is called `XRP`;
   * - trustline rows come from every transaction type, not only Payment and OfferCreate (AMM, check, Remit, ... also
   *   move tokens);
   * - amounts are exact decimal strings with no Number in between, and escrow amounts may be tokens;
   * - a fee of 0 (an inner transaction of a Batch) leaves no `transaction_cost` row, and a created account without a
   *   `Balance` (an AMM pseudo-account that holds no XRP) leaves no row at all, instead of a `NaN` change. A created
   *   AMM account that does hold XRP gets its row, so native changes still add up.
   *
   * Pure: nothing in `t` is modified (the reference wrote `nodeIndex` into the metadata), and the result shares no
   * objects with it.
   */
  parse(t: ParserTx, ctx: ParseContext): ParsedBalanceChange[] {
    const { meta } = t;
    const result: unknown = meta.TransactionResult;
    if (typeof result !== 'string' || (result !== 'tesSUCCESS' && !result.startsWith('tec'))) return [];

    const rows: ParsedBalanceChange[] = [];
    const escrows = new Map<string, Json>();
    const channels = new Map<string, Json>();

    const nodes: readonly Json[] = meta.AffectedNodes ?? [];
    for (let index = 0; index < nodes.length; index++) {
      const node: Json | undefined =
        nodes[index]?.ModifiedNode || nodes[index]?.CreatedNode || nodes[index]?.DeletedNode;
      if (!node) continue;

      switch (node.LedgerEntryType) {
        case 'AccountRoot':
          rows.push(...this.accountRoot(t, ctx, node, index));
          break;
        case 'RippleState':
          rows.push(...this.rippleState(t, node, index));
          break;
        case 'Escrow': {
          const fields: Json | undefined = node.NewFields || node.FinalFields;
          if (fields) {
            escrows.set(fields.Account, fields);
            escrows.set(fields.Destination, fields);
          }
          break;
        }
        case 'PayChannel': {
          const fields: Json | undefined = node.NewFields || node.FinalFields;
          if (fields) {
            channels.set(fields.Account, fields);
            channels.set(fields.Destination, fields);
          }
          break;
        }
      }
    }

    for (const row of rows) {
      if (row.change_type !== '') continue;
      const escrow = escrows.get(row.account);
      if (escrow) this.escrow(t, row, escrow);
      const channel = channels.get(row.account);
      if (channel && row.change_type === '') this.channel(row, channel);
    }
    return rows;
  }

  /** The native balance changes of an `AccountRoot` node: the transaction cost, and the rest. */
  private accountRoot(t: ParserTx, ctx: ParseContext, node: Json, nodeIndex: number): ParsedBalanceChange[] {
    let account: string;
    let balance: BigNumber;
    let previous: BigNumber;

    if (node.FinalFields && node.PreviousFields && node.FinalFields.Balance && node.PreviousFields.Balance) {
      balance = new BigNumber(node.FinalFields.Balance);
      previous = new BigNumber(node.PreviousFields.Balance);
      account = node.FinalFields.Account;
    } else if (node.NewFields) {
      balance = new BigNumber(node.NewFields.Balance ?? 0);
      previous = ZERO;
      account = node.NewFields.Account;
    } else {
      return [];
    }

    const rows: ParsedBalanceChange[] = [];
    const change = balance.minus(previous);
    let amount: BigNumber;

    if (t.tx.Account === account) {
      const fee = new BigNumber(t.tx.Fee ?? 0).negated();
      amount = change.minus(fee);
      if (!fee.isZero()) {
        rows.push({
          account,
          counterparty: '',
          currency: ctx.nativeCurrency,
          amount_change: dropsToNative(fee),
          // The balance once the fee is paid and before whatever else the transaction did to the account.
          final_balance: dropsToNative(balance.minus(amount)),
          node_index: -1,
          change_type: 'transaction_cost',
        });
      }
    } else {
      amount = change;
    }

    if (!amount.isZero()) {
      const row: ParsedBalanceChange = {
        account,
        counterparty: '',
        currency: ctx.nativeCurrency,
        amount_change: dropsToNative(amount),
        final_balance: dropsToNative(balance),
        node_index: nodeIndex,
        change_type: '',
      };
      row.change_type = this.changeType(t.tx, row, true);
      rows.push(row);
    }
    return rows;
  }

  /** The two rows, one per side, of a trustline whose balance changed. */
  private rippleState(t: ParserTx, node: Json, nodeIndex: number): ParsedBalanceChange[] {
    let balance: BigNumber;
    let change: BigNumber;
    let currency: string;
    let highParty: string;
    let lowParty: string;

    if (node.NewFields) {
      // A trustline created with nothing on it is not a balance change.
      if (node.NewFields.Balance.value === '0') return [];
      currency = node.NewFields.Balance.currency;
      highParty = node.NewFields.HighLimit.issuer;
      lowParty = node.NewFields.LowLimit.issuer;
      balance = new BigNumber(node.NewFields.Balance.value);
      change = balance;
    } else if (node.PreviousFields?.Balance && node.FinalFields?.Balance) {
      currency = node.FinalFields.Balance.currency;
      highParty = node.FinalFields.HighLimit.issuer;
      lowParty = node.FinalFields.LowLimit.issuer;
      balance = new BigNumber(node.FinalFields.Balance.value);
      change = balance.minus(node.PreviousFields.Balance.value);
    } else {
      return [];
    }

    // The balance is the low account's: a positive balance is owed to it by the high account.
    const low: ParsedBalanceChange = {
      account: lowParty,
      counterparty: highParty,
      currency,
      amount_change: change.toString(),
      final_balance: balance.toString(),
      node_index: nodeIndex,
      change_type: '',
    };
    const high: ParsedBalanceChange = {
      account: highParty,
      counterparty: lowParty,
      currency,
      amount_change: change.negated().toString(),
      final_balance: balance.negated().toString(),
      node_index: nodeIndex,
      change_type: '',
    };
    low.change_type = this.changeType(t.tx, low, false);
    high.change_type = this.changeType(t.tx, high, false);
    return [low, high];
  }

  /**
   * What a Payment or OfferCreate balance change was, as the reference's `findType` decides it; `''` for any other
   * transaction. The order of the tests matters. `native` says the row is of the native currency, which the reference
   * knew by the currency being called `XRP`.
   */
  private changeType(tx: Json, row: ParsedBalanceChange, native: boolean): string {
    const owes = new BigNumber(row.final_balance).lt(0);

    if (tx.TransactionType === 'OfferCreate') return owes ? 'intermediary' : 'exchange';
    if (tx.TransactionType !== 'Payment') return '';

    const amountCurrency: string | undefined = tx.Amount?.currency;
    const sendMax: Json | string | undefined = tx.SendMax;
    const sendMaxCurrency: string | undefined = typeof sendMax === 'object' ? sendMax?.currency : undefined;
    // An issued amount in this row's currency; a native row is never one, whatever the currency is called.
    const issuedMatch = (currency: string | undefined) => !native && !!currency && currency === row.currency;

    if (tx.Account === tx.Destination) return owes ? 'intermediary' : 'exchange';
    if (row.account === tx.Destination && issuedMatch(amountCurrency)) return 'payment_destination';
    if (row.account === tx.Destination && !amountCurrency && native) return 'payment_destination';
    if (row.account === tx.Account && sendMax && issuedMatch(sendMaxCurrency)) return 'payment_source';
    if (row.account === tx.Account && sendMax && native) return 'payment_source';
    if (row.account === tx.Account && issuedMatch(amountCurrency)) return 'payment_source';
    if (row.account === tx.Account && !amountCurrency && native) return 'payment_source';
    return owes ? 'intermediary' : 'exchange';
  }

  /** An untyped change of a party to an escrow is the escrow moving: created, cancelled or finished. */
  private escrow(t: ParserTx, row: ParsedBalanceChange, escrow: Json): void {
    const amount = escrowValue(escrow.Amount);
    row.escrow_counterparty = escrow.Destination;

    switch (t.tx.TransactionType) {
      case 'EscrowCreate':
        row.change_type = 'escrow_create';
        row.escrow_balance_change = amount.toString();
        break;
      case 'EscrowCancel':
        row.change_type = 'escrow_cancel';
        row.escrow_balance_change = ZERO.minus(amount).toString();
        break;
      case 'EscrowFinish':
        row.change_type = 'escrow_finish';
        row.escrow_balance_change = ZERO.minus(amount).toString();
        break;
    }
  }

  /** An untyped change of a party to a payment channel is the channel being funded or paid out. Native units. */
  private channel(row: ParsedBalanceChange, channel: Json): void {
    const fund = dropsToNative(channel.Amount ?? 0);
    const paid = dropsToNative(channel.Balance ?? 0);

    if (row.account === channel.Account) {
      row.change_type = 'paychannel_fund';
      row.paychannel_counterparty = channel.Destination;
      row.paychannel_fund_change = ZERO.minus(row.amount_change).toString();
    } else {
      row.change_type = 'paychannel_payout';
      row.paychannel_counterparty = channel.Account;
      row.paychannel_balance_change = ZERO.minus(row.amount_change).toString();
    }
    row.paychannel_fund_final_balance = fund;
    row.paychannel_final_balance = paid;
  }
}

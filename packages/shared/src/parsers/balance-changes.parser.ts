import { BigNumber } from 'bignumber.js';
import * as xrpl from 'xrpl';
import { IssuedCurrencyAmount } from 'xrpl/dist/npm/models/common';
import { Node as LedgerNode } from 'xrpl/dist/npm/models/transactions/metadata';
import { amountToValueString } from '../util/amount';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedBalanceChange {
  account: string;
  counterparty?: string;
  currency: string;
  change: string;
  final_balance: string;
  date: number;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  tx_hash: string;
  client?: string | null;
  type?: string;
  escrow_counterparty?: string;
  escrow_balance_change?: string;
  paychannel_counterparty?: string;
  paychannel_fund_change?: string;
  paychannel_balance_change?: string;
  paychannel_fund_final_balance?: string;
  paychannel_final_balance?: string;
}

export class BalanceChangesParser implements IParser<ParsedBalanceChange[]> {
  private findType(transaction: XrplTx, data: ParsedBalanceChange): string {
    const amount = (transaction as any).Amount as IssuedCurrencyAmount | undefined;
    const sendMax = (transaction as any).SendMax as IssuedCurrencyAmount | undefined;

    if (transaction.TransactionType === 'OfferCreate' && Number(data.final_balance) < 0) {
      return 'intermediary';
    } else if (transaction.TransactionType === 'OfferCreate') {
      return 'exchange';
    } else if (transaction.TransactionType === 'Payment') {
      if (transaction.Account === transaction.Destination && Number(data.final_balance) < 0) {
        return 'intermediary';
      } else if (transaction.Account === transaction.Destination) {
        return 'exchange';
      } else if (data.account === transaction.Destination && amount?.currency && amount.currency === data.currency) {
        return 'payment_destination';
      } else if (data.account === transaction.Destination && !amount?.currency && data.currency === 'XRP') {
        return 'payment_destination';
      } else if (data.account === transaction.Account && sendMax?.currency && sendMax.currency === data.currency) {
        return 'payment_source';
      } else if (data.account === transaction.Account && sendMax && data.currency === 'XRP') {
        return 'payment_source';
        // FIX (review C3): this was `data.account = transaction.Account` (assignment). Now a comparison.
      } else if (data.account === transaction.Account && amount?.currency && amount.currency === data.currency) {
        return 'payment_source';
      } else if (data.account === transaction.Account && !amount?.currency && data.currency === 'XRP') {
        return 'payment_source';
      } else if (Number(data.final_balance) < 0) {
        return 'intermediary';
      }
      return 'exchange';
    }
    return '';
  }

  private parseAccountRoot(node: any, tx: XrplTx): ParsedBalanceChange[] {
    const xs: ParsedBalanceChange[] = [];
    let account: string;
    let balance: BigNumber;
    let previous: BigNumber;

    if (node.FinalFields?.Balance && node.PreviousFields?.Balance) {
      balance = new BigNumber(node.FinalFields.Balance);
      previous = new BigNumber(node.PreviousFields.Balance);
      account = node.FinalFields.Account;
    } else if (node.NewFields) {
      if (Object.keys(node.NewFields).includes('AMMID')) return xs;
      balance = new BigNumber(node.NewFields.Balance);
      previous = new BigNumber(0);
      account = node.NewFields.Account;
    } else {
      return xs;
    }

    const change = balance.minus(previous);
    let amount: BigNumber;

    if (tx.Account === account) {
      const fee = new BigNumber(tx.Fee ?? '0').negated();
      amount = change.minus(fee);
      xs.push({
        account,
        currency: 'XRP',
        change: xrpl.dropsToXrp(fee).toString(),
        // balance/amount are in drops; final_balance is reported in XRP like the
        // non-fee row below (was xrpToDrops, which scaled the wrong direction).
        final_balance: xrpl.dropsToXrp(balance.minus(amount)).toString(),
        date: tx.date,
        ledger_index: tx.ledger_index,
        tx_index: tx.meta!.TransactionIndex,
        node_index: -1,
        tx_hash: tx.hash,
        client: tx.client,
        type: 'fee',
      });
    } else {
      amount = change;
    }

    if (!amount.isZero()) {
      const data: ParsedBalanceChange = {
        account,
        currency: 'XRP',
        change: xrpl.dropsToXrp(amount).toString(),
        final_balance: xrpl.dropsToXrp(balance).toString(),
        date: tx.date,
        ledger_index: tx.ledger_index,
        tx_index: tx.meta!.TransactionIndex,
        node_index: node.nodeIndex,
        tx_hash: tx.hash,
        client: tx.client,
      };
      data.type = this.findType(tx, data);
      xs.push(data);
    }

    return xs;
  }

  private parseRippleState(node: any, tx: XrplTx): ParsedBalanceChange[] {
    const xs: ParsedBalanceChange[] = [];
    let balance: BigNumber;
    let change: BigNumber;
    let currency: string;
    let highParty: string;
    let lowParty: string;

    if (tx.TransactionType !== 'Payment' && tx.TransactionType !== 'OfferCreate') {
      return [];
    } else if (node.NewFields && node.NewFields.Balance.value === '0') {
      return [];
    } else if (node.NewFields) {
      currency = node.NewFields.Balance.currency;
      highParty = node.NewFields.HighLimit.issuer;
      lowParty = node.NewFields.LowLimit.issuer;
      balance = new BigNumber(node.NewFields.Balance.value);
      change = new BigNumber(node.NewFields.Balance.value);
    } else if (node.PreviousFields?.Balance) {
      currency = node.FinalFields.Balance.currency;
      highParty = node.FinalFields.HighLimit.issuer;
      lowParty = node.FinalFields.LowLimit.issuer;
      balance = new BigNumber(node.FinalFields.Balance.value);
      change = balance.minus(new BigNumber(node.PreviousFields.Balance.value));
    } else {
      return [];
    }

    const low: ParsedBalanceChange = {
      account: lowParty,
      counterparty: highParty,
      currency,
      change: change.toString(),
      final_balance: balance.toString(),
      date: tx.date,
      ledger_index: tx.ledger_index,
      tx_index: tx.meta!.TransactionIndex,
      node_index: node.nodeIndex,
      tx_hash: tx.hash,
      client: tx.client,
    };
    low.type = this.findType(tx, low);
    xs.push(low);

    const high: ParsedBalanceChange = {
      account: highParty,
      counterparty: lowParty,
      currency,
      change: change.negated().toString(),
      final_balance: balance.negated().toString(),
      date: tx.date,
      ledger_index: tx.ledger_index,
      tx_index: tx.meta!.TransactionIndex,
      node_index: node.nodeIndex,
      tx_hash: tx.hash,
      client: tx.client,
    };
    high.type = this.findType(tx, high);
    xs.push(high);

    return xs;
  }

  public parse(tx: XrplTx): ParsedBalanceChange[] {
    let list: ParsedBalanceChange[] = [];
    const escrows: Record<string, any> = {};
    const paychan: Record<string, any> = {};

    if (!tx.meta || (tx.meta.TransactionResult.indexOf('tec') !== 0 && tx.meta.TransactionResult !== 'tesSUCCESS')) {
      return list;
    }

    tx.meta.AffectedNodes.forEach((affNode: LedgerNode, i: number) => {
      const node: any = (affNode as any)?.ModifiedNode || (affNode as any)?.CreatedNode || (affNode as any)?.DeletedNode;
      if (!node) return;

      node.nodeIndex = i;
      if (node.LedgerEntryType === 'AccountRoot') {
        list = list.concat(this.parseAccountRoot(node, tx));
      } else if (node.LedgerEntryType === 'RippleState') {
        list = list.concat(this.parseRippleState(node, tx));
      } else if (node.LedgerEntryType === 'Escrow') {
        const fields = node.NewFields || node.FinalFields;
        escrows[fields.Account] = fields;
        escrows[fields.Destination] = fields;
      } else if (node.LedgerEntryType === 'PayChannel') {
        const fields = node.NewFields || node.FinalFields;
        paychan[fields.Account] = fields;
        paychan[fields.Destination] = fields;
      }
    });

    list = list.filter((x) => x);
    for (const d of list) {
      if (escrows[d.account] && !d.type) {
        const e = escrows[d.account];
        // e.Amount may be XRP drops OR a token (IOU/MPT) object on token-enabled escrows.
        const amount = new BigNumber(amountToValueString(e.Amount) ?? '0');
        d.escrow_counterparty = e.Destination;
        if (tx.TransactionType === 'EscrowCreate') {
          d.type = 'escrow_create';
          d.escrow_balance_change = amount.toString();
        } else if (tx.TransactionType === 'EscrowCancel') {
          d.type = 'escrow_cancel';
          d.escrow_balance_change = new BigNumber(0).minus(amount).toString();
        } else if (tx.TransactionType === 'EscrowFinish') {
          d.type = 'escrow_finish';
          d.escrow_balance_change = new BigNumber(0).minus(amount).toString();
        }
      }

      if (paychan[d.account] && !d.type) {
        const e = paychan[d.account];
        if (d.account === e.Account) {
          d.type = 'paychannel_fund';
          d.paychannel_counterparty = e.Destination;
          d.paychannel_fund_change = new BigNumber(0).minus(d.change).toString();
          d.paychannel_fund_final_balance = xrpl.dropsToXrp(new BigNumber(e.Amount || 0)).toString();
          d.paychannel_final_balance = xrpl.dropsToXrp(new BigNumber(e.Balance || 0)).toString();
        } else {
          d.type = 'paychannel_payout';
          d.paychannel_counterparty = e.Account;
          d.paychannel_balance_change = new BigNumber(0).minus(d.change).toString();
          d.paychannel_fund_final_balance = xrpl.dropsToXrp(new BigNumber(e.Amount || 0)).toString();
          d.paychannel_final_balance = xrpl.dropsToXrp(new BigNumber(e.Balance || 0)).toString();
        }
      }
    }

    return list;
  }
}

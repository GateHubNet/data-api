import { BigNumber } from 'bignumber.js';
import * as xrpl from 'xrpl';
import { IssuedCurrencyAmount } from 'xrpl/dist/npm/models/common';
import { parseQuality } from '../util/quality';
import { IParser, XrplTx } from './parser.interface';

interface Side {
  currency: string;
  amount: number;
  issuer?: string;
}

export interface ParsedExchange {
  base: Side;
  counter: Side;
  rate: number;
  buyer: string;
  seller: string;
  taker: string;
  provider: string;
  sequence: number;
  /** unix seconds */
  date: number;
  tx_type: string;
  tx_index: number;
  ledger_index: number;
  node_index: number;
  tx_hash: string;
  client?: string | null;
  autobridged?: { currency: string; issuer?: string };
}

export class ExchangeParser implements IParser<ParsedExchange[]> {
  private parseOfferExercised(node: any, transaction: XrplTx): ParsedExchange {
    const counterparty = node.FinalFields.Account;
    let change: BigNumber;
    let base: Side;
    let counter: Side;

    if (typeof node.PreviousFields.TakerPays === 'object') {
      change = new BigNumber(node.PreviousFields.TakerPays.value).minus(node.FinalFields.TakerPays.value);
      base = { currency: node.PreviousFields.TakerPays.currency, issuer: node.PreviousFields.TakerPays.issuer, amount: change.toNumber() };
    } else {
      change = new BigNumber(node.PreviousFields.TakerPays).minus(node.FinalFields.TakerPays);
      base = { currency: 'XRP', amount: new BigNumber(xrpl.dropsToXrp(change)).toNumber() };
    }

    if (typeof node.PreviousFields.TakerGets === 'object') {
      change = new BigNumber(node.PreviousFields.TakerGets.value).minus(node.FinalFields.TakerGets.value);
      counter = { currency: node.PreviousFields.TakerGets.currency, issuer: node.PreviousFields.TakerGets.issuer, amount: change.toNumber() };
    } else {
      change = new BigNumber(node.PreviousFields.TakerGets).minus(node.FinalFields.TakerGets);
      counter = { currency: 'XRP', amount: new BigNumber(xrpl.dropsToXrp(change)).toNumber() };
    }

    let exchangeRate: BigNumber | undefined;
    try {
      exchangeRate = parseQuality(node.FinalFields.BookDirectory, base.currency, counter.currency);
    } catch {
      /* fall back to amount ratio below */
    }
    if (!exchangeRate) {
      exchangeRate = new BigNumber(base.amount).dividedBy(counter.amount);
    }

    const offer: ParsedExchange & { rate: any } = {
      base,
      counter,
      rate: exchangeRate as any,
      buyer: counterparty,
      seller: transaction.Account,
      taker: transaction.Account,
      provider: node.FinalFields.Account,
      sequence: node.FinalFields.Sequence,
      // `transaction.date` is supplied by the syncer as unix seconds (see SyncWorker).
      date: transaction.date,
      tx_type: transaction.TransactionType,
      tx_index: transaction.meta!.TransactionIndex,
      ledger_index: transaction.ledger_index,
      node_index: node.nodeIndex,
      tx_hash: transaction.hash,
      client: transaction.client,
    };

    // Autobridging detection for OfferCreate with two IOU legs bridged through XRP.
    const takerPays = (transaction as any).TakerPays as IssuedCurrencyAmount | undefined;
    const takerGets = (transaction as any).TakerGets as IssuedCurrencyAmount | undefined;
    if (transaction.TransactionType === 'OfferCreate' && takerPays?.currency && takerGets?.currency) {
      if (counter.currency === 'XRP' && base.currency === takerPays.currency) {
        offer.autobridged = { currency: takerGets.currency, issuer: takerGets.issuer };
      } else if (counter.currency === 'XRP' && base.currency === takerGets.currency) {
        offer.autobridged = { currency: takerPays.currency, issuer: takerPays.issuer };
      } else if (base.currency === 'XRP' && counter.currency === takerPays.currency) {
        offer.autobridged = { currency: takerGets.currency, issuer: takerGets.issuer };
      } else if (base.currency === 'XRP' && counter.currency === takerGets.currency) {
        offer.autobridged = { currency: takerPays.currency, issuer: takerPays.issuer };
      }
    }

    return this.orderPair(offer);
  }

  private orderPair(offer: ParsedExchange & { rate: any }): ParsedExchange {
    const c1 = (offer.base.currency + (offer.base.issuer ?? '')).toLowerCase();
    const c2 = (offer.counter.currency + (offer.counter.issuer ?? '')).toLowerCase();

    if (c2 < c1) {
      const swapSide = offer.base;
      offer.base = offer.counter;
      offer.counter = swapSide;
      offer.rate = (offer.rate as BigNumber).toNumber();
      const swapParty = offer.buyer;
      offer.buyer = offer.seller;
      offer.seller = swapParty;
    } else {
      offer.rate = (offer.rate as BigNumber).pow(-1).toNumber();
    }
    return offer;
  }

  public parse(transaction: XrplTx): ParsedExchange[] {
    const metadata = transaction.meta;
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') return [];
    if (transaction.TransactionType !== 'Payment' && transaction.TransactionType !== 'OfferCreate') return [];

    const list: ParsedExchange[] = [];
    for (let i = 0; i < metadata.AffectedNodes.length; i++) {
      const affNode: any = metadata.AffectedNodes[i];
      const node = affNode.ModifiedNode || affNode.DeletedNode;
      if (!node || node.LedgerEntryType !== 'Offer') continue;
      if (!node.PreviousFields || !node.PreviousFields.TakerPays || !node.PreviousFields.TakerGets) continue;
      node.nodeIndex = i;
      list.push(this.parseOfferExercised(node, transaction));
    }
    return list;
  }
}

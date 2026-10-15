import { BigNumber } from 'bignumber.js';
import { Balance, dropsToXrp, OfferCancel, OfferCreate } from 'xrpl';
import { parseQuality } from '../util/quality';
import { CreatedNodeData, DeletedNodeData, IParser, LedgerNode, LedgerNodeData, ModifiedNodeData, XrplTx } from './parser.interface';

export interface ParsedOffer {
  tx_type: string;
  node_type: string;
  account: string;
  offer_sequence: number;
  expiration?: number;
  book_directory: string;
  tx_hash: string;
  date: number;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  prev_offer_sequence?: number;
  next_offer_sequence?: number;
  taker_pays?: Balance;
  taker_gets?: Balance;
  rate?: string;
  pays_change: string;
  gets_change: string;
  change_type?: string;
}

export class OffersParser implements IParser<ParsedOffer[]> {
  public parse(transaction: XrplTx): ParsedOffer[] {
    const metadata = transaction.meta;
    const list: ParsedOffer[] = [];
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') return [];
    if (!['Payment', 'OfferCancel', 'OfferCreate'].includes(transaction.TransactionType)) return [];

    for (let i = 0; i < metadata.AffectedNodes.length; i++) {
      const affNode = metadata.AffectedNodes[i] as LedgerNode;
      let node: LedgerNodeData | undefined;
      let type: string;

      if (affNode.CreatedNode) {
        node = affNode.CreatedNode;
        type = 'CreatedNode';
      } else if (affNode.ModifiedNode) {
        node = affNode.ModifiedNode;
        type = 'ModifiedNode';
      } else if (affNode.DeletedNode) {
        node = affNode.DeletedNode;
        type = 'DeletedNode';
      } else {
        continue;
      }

      if (node.LedgerEntryType !== 'Offer') continue;
      const fields = (node as CreatedNodeData).NewFields || (node as ModifiedNodeData | DeletedNodeData).FinalFields;
      if (!fields) continue;

      const offer: ParsedOffer = {
        tx_type: transaction.TransactionType,
        node_type: type,
        account: fields.Account as string,
        offer_sequence: fields.Sequence as number,
        expiration: fields.Expiration as number | undefined,
        book_directory: fields.BookDirectory as string,
        tx_hash: transaction.hash,
        date: transaction.date,
        ledger_index: transaction.ledger_index,
        tx_index: metadata.TransactionIndex,
        node_index: i,
        pays_change: '0',
        gets_change: '0',
      };

      if ((transaction as OfferCancel).OfferSequence && fields.Account === transaction.Account) {
        if (type === 'CreatedNode') offer.prev_offer_sequence = (transaction as OfferCreate).OfferSequence;
        else if (type === 'DeletedNode') offer.next_offer_sequence = transaction.Sequence;
      }

      offer.taker_pays =
        typeof fields.TakerPays === 'object'
          ? (fields.TakerPays as Balance)
          : { currency: 'XRP', value: dropsToXrp(new BigNumber(fields.TakerPays as string)).toString() };
      offer.taker_gets =
        typeof fields.TakerGets === 'object'
          ? (fields.TakerGets as Balance)
          : { currency: 'XRP', value: dropsToXrp(new BigNumber(fields.TakerGets as string)).toString() };

      try {
        offer.rate = parseQuality(fields.BookDirectory as string, offer.taker_pays.currency, offer.taker_gets.currency).toString();
      } catch {
        /* rate stays undefined */
      }

      const prevFields = (node as ModifiedNodeData).PreviousFields;
      if (prevFields) {
        if (prevFields.TakerPays) {
          offer.pays_change =
            offer.taker_pays.currency === 'XRP'
              ? new BigNumber(dropsToXrp(new BigNumber(prevFields.TakerPays as string))).minus(offer.taker_pays.value).toString()
              : new BigNumber((prevFields.TakerPays as Balance).value).minus(offer.taker_pays.value).toString();
        }
        if (prevFields.TakerGets) {
          offer.gets_change =
            offer.taker_gets.currency === 'XRP'
              ? new BigNumber(dropsToXrp(new BigNumber(prevFields.TakerGets as string))).minus(offer.taker_gets.value).toString()
              : new BigNumber((prevFields.TakerGets as Balance).value).minus(offer.taker_gets.value).toString();
        }
      }

      if (type === 'CreatedNode') offer.change_type = 'create';
      else if (type === 'ModifiedNode') offer.change_type = 'partial_fill';
      else if (transaction.TransactionType === 'OfferCancel') offer.change_type = 'cancel';
      else if (
        transaction.TransactionType === 'OfferCreate' &&
        type === 'DeletedNode' &&
        fields.Account === transaction.Account &&
        fields.Sequence === (transaction as OfferCreate).OfferSequence
      ) {
        offer.change_type = 'replace';
      } else if (offer.taker_pays.value === '0') offer.change_type = 'fill';
      else if (!prevFields) offer.change_type = 'unfunded_cancel';
      else if (offer.pays_change !== '0' || offer.gets_change !== '0') offer.change_type = 'unfunded_partial_fill';

      list.push(offer);
    }

    return list;
  }
}

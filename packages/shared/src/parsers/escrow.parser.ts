import { BigNumber } from 'bignumber.js';
import { dropsToXrp, rippleTimeToUnixTime, TransactionMetadata } from 'xrpl';
import { amountToValueString } from '../util/amount';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedEscrow {
  fee: string;
  flags?: string;
  ledger_index: number;
  tx_index: number;
  date: number;
  tx_hash: string;
  tx_type: string;
  client?: string | null;
  amount?: string;
  account: string;
  owner?: string;
  destination?: string;
  destination_tag?: number;
  source_tag?: number;
  create_tx_seq?: number;
  create_tx?: string;
  condition?: string;
  fulfillment?: string;
  cancel_after?: number;
  finish_after?: number;
}

export class EscrowParser implements IParser<ParsedEscrow | undefined> {
  private getEscrowNode(metadata: TransactionMetadata): any {
    for (const node of metadata.AffectedNodes) {
      if ((node as any).DeletedNode && (node as any).DeletedNode.LedgerEntryType === 'Escrow') {
        return (node as any).DeletedNode;
      }
      if ((node as any).CreatedNode && (node as any).CreatedNode.LedgerEntryType === 'Escrow') {
        return (node as any).CreatedNode;
      }
    }
    return { FinalFields: {}, NewFields: {} };
  }

  parse(transaction: XrplTx): ParsedEscrow | undefined {
    const metadata = transaction.meta;
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') return undefined;
    if (!['EscrowCreate', 'EscrowCancel', 'EscrowFinish'].includes(transaction.TransactionType)) return undefined;

    const node = this.getEscrowNode(metadata);
    const fields = node.FinalFields || node.NewFields || {};
    // FIX (review H4): EscrowCancel/Finish carry no top-level Amount — fall back to the node, then guard.
    const rawAmount = (transaction as any).Amount ?? fields.Amount;

    return {
      fee: dropsToXrp(new BigNumber(transaction.Fee ?? '0')).toString(),
      flags: transaction.Flags?.toString(),
      ledger_index: transaction.ledger_index,
      tx_index: metadata.TransactionIndex,
      date: transaction.date,
      tx_hash: transaction.hash,
      tx_type: transaction.TransactionType,
      client: transaction.client,
      // Handles XRP drops AND token-enabled escrows (IOU/MPT Amount objects).
      amount: amountToValueString(rawAmount),
      account: transaction.Account,
      // For EscrowFinish/Cancel the escrow owner is `tx.Owner` (the creator), which may
      // differ from the submitter `tx.Account`; EscrowCreate has no Owner field so it
      // falls back to Account (the creator).
      owner: (transaction as any).Owner ?? transaction.Account,
      destination: (transaction as any).Destination || fields.Destination,
      destination_tag: (transaction as any).DestinationTag || fields.DestinationTag,
      source_tag: transaction.SourceTag || fields.SourceTag,
      create_tx_seq: transaction.Sequence || (transaction as any).OfferSequence,
      create_tx: fields.PreviousTxnID || transaction.hash,
      condition: (transaction as any).Condition,
      fulfillment: (transaction as any).Fulfillment,
      cancel_after: (transaction as any).CancelAfter ? rippleTimeToUnixTime((transaction as any).CancelAfter) / 1000 : undefined,
      finish_after: (transaction as any).FinishAfter ? rippleTimeToUnixTime((transaction as any).FinishAfter) / 1000 : undefined,
    };
  }
}

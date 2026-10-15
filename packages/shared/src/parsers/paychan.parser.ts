import { BigNumber } from 'bignumber.js';
import * as xrpl from 'xrpl';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedPayChannel {
  fee: string;
  flags?: number;
  ledger_index: number;
  tx_index: number;
  date: number;
  tx_hash: string;
  tx_type: string;
  client?: string | null;
  channel?: string;
  signature?: string;
  pubkey?: string;
  settle?: number;
  account: string;
  source?: string;
  destination?: string;
  destination_tag?: number;
  source_tag?: number;
  amount?: string;
  balance?: string;
  cancel_after?: number;
  expiration?: number;
}

export class PaychanParser implements IParser<ParsedPayChannel | undefined> {
  private getPaychannelNode(metadata: xrpl.TransactionMetadata): any {
    for (const affNode of metadata.AffectedNodes) {
      const node = (affNode as any).CreatedNode || (affNode as any).ModifiedNode || (affNode as any).DeletedNode;
      if (node && node.LedgerEntryType === 'PayChannel') {
        node.fields = node.NewFields || node.FinalFields;
        return node;
      }
    }
    return { fields: {} };
  }

  public parse(transaction: XrplTx): ParsedPayChannel | undefined {
    const metadata = transaction.meta;
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') return undefined;
    if (!['PaymentChannelCreate', 'PaymentChannelFund', 'PaymentChannelClaim'].includes(transaction.TransactionType)) {
      return undefined;
    }

    const node = this.getPaychannelNode(metadata);
    const f = node.fields ?? {};
    return {
      fee: xrpl.dropsToXrp(new BigNumber(transaction.Fee ?? '0')).toString(),
      flags: typeof transaction.Flags === 'number' ? transaction.Flags : undefined,
      ledger_index: transaction.ledger_index,
      tx_index: metadata.TransactionIndex,
      date: transaction.date,
      tx_hash: transaction.hash,
      tx_type: transaction.TransactionType,
      client: transaction.client,
      channel: (transaction as any).Channel,
      signature: (transaction as any).Signature,
      // The channel's public key is `PublicKey` (XRPL PaymentChannelClaim), not the
      // transaction signer's `SigningPubKey`.
      pubkey: (transaction as any).PublicKey,
      settle: (transaction as any).SettleDelay,
      account: transaction.Account,
      source: f.Account,
      destination: f.Destination,
      destination_tag: f.DestinationTag,
      source_tag: f.SourceTag,
      amount: f.Amount ? xrpl.dropsToXrp(new BigNumber(f.Amount)).toString() : undefined,
      balance: f.Balance ? xrpl.dropsToXrp(new BigNumber(f.Balance)).toString() : undefined,
      // ripple time -> unix seconds, consistent with the escrow parser and all other times.
      cancel_after: (transaction as any).CancelAfter ? xrpl.rippleTimeToUnixTime((transaction as any).CancelAfter) / 1000 : undefined,
      expiration: (transaction as any).Expiration ? xrpl.rippleTimeToUnixTime((transaction as any).Expiration) / 1000 : undefined,
    };
  }
}

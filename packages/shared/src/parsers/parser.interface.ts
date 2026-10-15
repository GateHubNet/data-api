import { Client, CreatedNode, DeletedNode, ModifiedNode, Transaction, TransactionMetadata } from 'xrpl';

/** A transaction enriched with the ledger-level context the parsers need. */
export type XrplTx = {
  hash: string;
  ledger_index: number;
  /**
   * Ledger close time as **unix seconds (UTC)**. The syncer converts the ledger's
   * ripple-epoch close time to unix seconds before parsing, so every parser writes a
   * consistent unix-seconds `date`.
   */
  date: number;
  meta?: TransactionMetadata;
  validated?: boolean;
  client?: string | null;
} & Transaction;

export type LedgerTransaction = Transaction & {
  metaData?: TransactionMetadata;
  hash: string;
};

export interface IParser<T = unknown> {
  parse(transaction: XrplTx, xrplClient?: Client): T;
}

export type LedgerNode = Partial<CreatedNode & ModifiedNode & DeletedNode>;
export type CreatedNodeData = CreatedNode['CreatedNode'];
export type ModifiedNodeData = ModifiedNode['ModifiedNode'];
export type DeletedNodeData = DeletedNode['DeletedNode'];
export type LedgerNodeData = CreatedNodeData | ModifiedNodeData | DeletedNodeData;

/** Returns true for a transaction whose metadata indicates it had ledger effects. */
export function txSucceededOrClaimed(meta?: TransactionMetadata): boolean {
  if (!meta) return false;
  const result = meta.TransactionResult;
  return result === 'tesSUCCESS' || result.startsWith('tec');
}

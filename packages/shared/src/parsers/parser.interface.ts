import { Client, CreatedNode, DeletedNode, ModifiedNode, Transaction, TransactionMetadata } from 'xrpl';
import { LedgerHeader, RawTransaction } from '../ingest/raw-ledger';
import { NetworkProfile } from '../network/network-profile';

/**
 * The per-network facts a pure parser needs. Parsers take it as an argument instead of reading the environment or
 * hardcoding `'XRP'`.
 */
export interface ParseContext {
  /** `'XRP'` or `'XAH'`: the currency code that stands for the network's native asset in parsed output. */
  nativeCurrency: string;
  /** CTID network id. */
  networkId: number;
  /** A partial payment's delivered amount is only recoverable from the metadata in ledgers after this one. */
  partialPaymentFixLedger: number;
}

export function parseContextFor(profile: NetworkProfile): ParseContext {
  return {
    nativeCurrency: profile.nativeCurrency,
    networkId: profile.networkId,
    partialPaymentFixLedger: profile.partialPaymentFixLedger,
  };
}

/**
 * A transaction with the ledger-level context the parsers need. `tx` and `meta` are the node's JSON, untouched and
 * typically deep-frozen: parsers must never write to them.
 */
export interface ParserTx {
  hash: string;
  ledger_index: number;
  /** Ledger close time, unix seconds (UTC). */
  close_time: number;
  /** `meta.TransactionIndex`. */
  tx_index: number;
  tx: Readonly<Record<string, any>>;
  meta: Readonly<Record<string, any>>;
  client: string | null;
}

export function toParserTx(raw: RawTransaction, header: LedgerHeader, client: string | null): ParserTx {
  return {
    hash: raw.hash,
    ledger_index: header.ledger_index,
    close_time: header.close_time,
    tx_index: raw.meta.TransactionIndex as number,
    tx: raw.tx,
    meta: raw.meta,
    client,
  };
}

/**
 * A transaction enriched with the ledger-level context the parsers need.
 *
 * Legacy shape, still consumed by the parsers that have not moved to {@link ParserTx} yet.
 */
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

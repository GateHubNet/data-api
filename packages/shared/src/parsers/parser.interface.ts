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

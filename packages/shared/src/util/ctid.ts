/**
 * XRPL "Concise Transaction Identifier" (CTID) — a deterministic, globally-unique
 * id derived from (ledger_index, tx_index, network_id). See XLS-37d.
 *
 * We use the CTID as the ClickHouse sort/dedup key for every per-transaction row so
 * that re-processing a ledger is fully idempotent (ReplacingMergeTree collapses
 * duplicate keys). This replaces Elasticsearch's auto-generated `_id`, which made the
 * old pipeline produce duplicate documents on any replay.
 */

const CTID_PREFIX = 'C';

export function getTxCtid(ledgerIndex: number, txIndex: number, networkId: number): string {
  if (txIndex === undefined || txIndex === null) {
    throw new Error('Cannot compute CTID: txIndex is undefined or null.');
  }
  if (ledgerIndex < 0 || ledgerIndex > 0xfffffff) {
    throw new Error(`Cannot compute CTID: ledgerIndex ${ledgerIndex} out of range.`);
  }
  // XLS-37d: txIndex and networkId are each 16 bits. Out-of-range values would widen
  // the fixed-width hex fields and silently corrupt the CTID.
  if (txIndex < 0 || txIndex > 0xffff) {
    throw new Error(`Cannot compute CTID: txIndex ${txIndex} out of range.`);
  }
  if (networkId < 0 || networkId > 0xffff) {
    throw new Error(`Cannot compute CTID: networkId ${networkId} out of range.`);
  }

  const ledgerIndexHex = ledgerIndex.toString(16).padStart(7, '0').toUpperCase();
  const txIndexHex = txIndex.toString(16).padStart(4, '0').toUpperCase();
  const networkIdHex = networkId.toString(16).padStart(4, '0').toUpperCase();

  return `${CTID_PREFIX}${ledgerIndexHex}${txIndexHex}${networkIdHex}`;
}

export function parseCtid(ctid: string): { ledgerIndex: number; txIndex: number; networkId: number } {
  return {
    ledgerIndex: parseInt(ctid.slice(1, 8), 16),
    txIndex: parseInt(ctid.slice(8, 12), 16),
    networkId: parseInt(ctid.slice(12), 16),
  };
}

/** Stable key for a per-node row inside a transaction (e.g. balance changes, exchanges). */
export function getNodeCtid(ledgerIndex: number, txIndex: number, nodeIndex: number, networkId: number): string {
  return `${getTxCtid(ledgerIndex, txIndex, networkId)}.${String(nodeIndex).padStart(4, '0')}`;
}

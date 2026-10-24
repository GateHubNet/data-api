/** The key of a row of a ledger-keyed table: the ledger and the position of its transaction in that ledger. */
export interface TxKey {
  ledger_index: number;
  tx_index: number;
}

/** `ledger_index:tx_index`: the key of a map of rows by `TxKey`. */
export const txKeyString = (key: TxKey): string => `${key.ledger_index}:${key.tx_index}`;

/**
 * The condition that a row's `(ledger_index, tx_index)` is one of `keys` (at least one), with its bound parameters
 * (`tx_keys_*`): the range of their ledgers prunes the partitions and granules, and the keys go in as two arrays that
 * the server zips back into tuples.
 */
export function txKeysIn(keys: readonly TxKey[]): { clause: string; params: Record<string, number | number[]> } {
  const ledgers = keys.map((k) => k.ledger_index);
  return {
    clause: `ledger_index BETWEEN {tx_keys_lo:UInt32} AND {tx_keys_hi:UInt32}
          AND (ledger_index, tx_index) IN (
              SELECT tupleElement(key, 1), tupleElement(key, 2)
                FROM (SELECT arrayJoin(arrayZip({tx_keys_ledgers:Array(UInt32)}, {tx_keys_indexes:Array(UInt32)})) AS key))`,
    params: {
      tx_keys_lo: Math.min(...ledgers),
      tx_keys_hi: Math.max(...ledgers),
      tx_keys_ledgers: ledgers,
      tx_keys_indexes: keys.map((k) => k.tx_index),
    },
  };
}

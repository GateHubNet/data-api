import { Table } from '../clickhouse/tables';

/**
 * The manifest map (Global Constraints, "Key mapping"): per `ephemeral_key` of `validator_manifests`, the `master_key` of the
 * manifest with the highest `seq`. Every job and every API read that aggregates rows by validator maps each key through it
 * first, so that a validation recorded under a signing key before its manifest was known is counted for the right validator.
 * Read it with no parameters, give the rows to `keyMapParams`, and map a key in SQL with
 * `transform(k, {ephemerals:Array(String)}, {masters:Array(String)}, k)`: a key the map does not know stays as it is.
 */
export const MANIFEST_MAP_SQL = `SELECT ephemeral_key, argMax(master_key, seq) AS master_key
  FROM ${Table.ValidatorManifests}
 GROUP BY ephemeral_key
 ORDER BY ephemeral_key`;

/**
 * The query parameters `{ephemerals:Array(String)}` and `{masters:Array(String)}` of the manifest map: the keys and their
 * masters, in the order of the rows (position `i` of one is position `i` of the other).
 */
export function keyMapParams(rows: readonly { ephemeral_key: string; master_key: string }[]): {
  ephemerals: string[];
  masters: string[];
} {
  return { ephemerals: rows.map((row) => row.ephemeral_key), masters: rows.map((row) => row.master_key) };
}

import { Table } from '../clickhouse/tables';

/**
 * The order of the newest manifest of a master (`argMax(column, NEWEST_MANIFEST_ORDER)`): the highest `seq`, and among rows of
 * one `seq` the one that has the raw manifest. A database upgraded from 001 holds rows with neither a domain nor a manifest
 * (`domain = ''`, `manifest = ''`), and the row of the same manifest that brings them (from a list, or the node) has the same
 * `seq`: until a merge keeps one of them, `argMax(…, seq)` could take either.
 */
export const NEWEST_MANIFEST_ORDER = '(seq, notEmpty(manifest))';

/**
 * The manifest map (Global Constraints, "Key mapping"): per `ephemeral_key` of `validator_manifests`, the master key of the
 * manifest with the highest `seq` (`map_master`; a row without a master key counts for nothing). Every job and every API read
 * that aggregates rows by validator maps each key through it first, so that a validation recorded under a signing key before
 * its manifest was known is counted for the right validator.
 *
 * A statement maps its keys with the map computed inside it (`KEY_MAP_WITH` and `mappedKey`), never with the map sent as
 * parameters: the client puts parameters in the URL, and a map of some 9,000 manifests (which anyone who broadcasts
 * manifests can make) is more than the 1 MiB of a URL ClickHouse takes. This statement on its own is for a map that an
 * answer carries (the API's `signingToMaster`). It has no parameters.
 */
export const MANIFEST_MAP_SQL = `SELECT ephemeral_key, argMax(master_key, seq) AS map_master
  FROM ${Table.ValidatorManifests}
 WHERE master_key != ''
 GROUP BY ephemeral_key
 ORDER BY ephemeral_key`;

/**
 * The manifest map as an element of the WITH clause of a statement: `key_map`, a scalar of two arrays (the ephemeral keys,
 * then their masters) that one `groupArray` pass over `MANIFEST_MAP_SQL` keeps aligned. ClickHouse computes it once for the
 * statement, and its subqueries and common table expressions see it. A statement starts `WITH ${KEY_MAP_WITH}` (or adds it to
 * its WITH list) and maps a key column with `mappedKey`.
 */
export const KEY_MAP_WITH = `(SELECT tuple(groupArray(ephemeral_key), groupArray(map_master)) FROM (${MANIFEST_MAP_SQL})) AS key_map`;

/** The master key of `column` through the manifest map of `KEY_MAP_WITH`: a key the map does not know stays as it is. */
export function mappedKey(column: string): string {
  return `transform(${column}, key_map.1, key_map.2, ${column})`;
}

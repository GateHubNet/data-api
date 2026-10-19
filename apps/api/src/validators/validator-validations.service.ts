import { ClickHouseService, readGrowingCap, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { StoredValidation, ValidationRow, validationRow } from './validation-row-object';
import { ValidatorDirectoryService } from './validator-directory.service';

/** The key of a validation of a validator, which is what a marker holds: the end of the ORDER BY of `validator_validations`. */
export const VALIDATION_PAGE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'ledger_hash', type: 'String' },
];

/** How far back the validations of a validator are served: the table keeps 7 days (a part is dropped once all of it is older). */
export const VALIDATIONS_WINDOW_SECONDS = 7 * 86_400;

/** The columns of `validator_validations` that the page needs. */
const COLUMNS =
  'ledger_index, ledger_hash, count, first_datetime, last_datetime, ephemeral_public_key, signing_time, full';

/** A row of the page as the read gives it: the validation, and whether it is one the read may not have all the sightings of. */
type PageRow = StoredValidation & { cut: number | string };

/**
 * The SQL of a page of validations of a validator that is `keyCount` keys: its master key and the signing keys its manifests
 * name. `keyset` is the condition of the marker (`keysetClause`), or empty.
 *
 * The page is read in the shape of Ruling R106, once for each key:
 *  - the inner SELECT of a key is the read: that key's rows of the last 7 days, `ORDER BY` the whole sorting key of the table
 *    and a plain `LIMIT {distinct_page_cap}`, which ClickHouse stops after, about a granule per part it touches. The keys are
 *    combined with `UNION ALL`: one read in the order of its key for each, never one read of all the keys ordered by ledger,
 *    which is no prefix of the key and would read all their rows;
 *  - the sightings of one (ledger index, ledger hash), whatever key they were recorded under and in however many partial rows
 *    (the table is an AggregatingMergeTree, and until a merge a validation is several rows), are added up outside the reads:
 *    counts summed, the first sighting's time the earliest and the last the latest, `full` the greatest, and the signing key
 *    and signing time those of the earliest sighting;
 *  - the page is cut after the merge: `LIMIT {distinct_page_limit}`, the page and one more, in the order of the page.
 *
 * A read that stopped at its cap may have more sightings of the last ledger it reached than it took, and everything it did not
 * reach is missing: `cut` says that a group is the last one that a read which stopped at its cap reached, so the groups from the
 * first such one on are not sure. The aliases are not the names of the columns they aggregate (`sightings`, not `count`): an
 * alias with the name of a column would be read as that column.
 */
export function validationsPageSql(keyCount: number, descending: boolean, keyset: string): string {
  const direction = descending ? 'DESC' : 'ASC';
  const reads = Array.from(
    { length: keyCount },
    (_, i) => `SELECT ${i} AS source, ${COLUMNS}
          FROM (SELECT ${COLUMNS}
                  FROM ${Table.ValidatorValidations}
                 WHERE validation_public_key = {key${i}:String}
                   AND last_datetime >= toDateTime64({since:UInt32}, 3, 'UTC')${keyset === '' ? '' : `\n                   AND ${keyset}`}
                 ORDER BY validation_public_key ${direction}, ledger_index ${direction}, ledger_hash ${direction}
                 LIMIT {distinct_page_cap:UInt32})`,
  ).join('\n         UNION ALL\n         ');
  // the last (ledger index, ledger hash) of a read, in the order of the page, is the one it reached last
  const last = descending ? 'min' : 'max';
  return `SELECT ledger_index, ledger_hash,
       sum(count) AS sightings,
       toUnixTimestamp64Milli(min(first_datetime)) AS first_ms,
       toUnixTimestamp64Milli(max(last_datetime)) AS last_ms,
       argMin(ephemeral_public_key, first_datetime) AS signing_key,
       argMin(signing_time, first_datetime) AS signed_at,
       max(full) AS is_full,
       max(edge) AS cut
  FROM (SELECT *,
               (count() OVER (PARTITION BY source) >= {distinct_page_cap:UInt32}
                 AND (ledger_index, ledger_hash) = ${last}((ledger_index, ledger_hash)) OVER (PARTITION BY source)) AS edge
          FROM (${reads}))
 GROUP BY ledger_index, ledger_hash
 ORDER BY ledger_index ${direction}, ledger_hash ${direction}
 LIMIT {distinct_page_limit:UInt32}`;
}

/**
 * The validations of a validator (spec 3.4): the last 7 days of `validator_validations`, newest first or oldest first, a page
 * at a time.
 *
 * **Which rows.** Every API read maps a key through the manifest map first (spec 2): the validations a collector recorded under
 * a signing key before its manifest was known are the master's. So the rows are those of the master key AND of every signing key
 * whose newest manifest names that master (the directory's `signingToMaster`, which is `argMax(master_key, seq)` for each
 * ephemeral key). The sightings of one ledger and hash under two of the keys are one validation.
 *
 * **One page.** `validationsPageSql` reads each key in the order of its key with a limit and adds up the sightings outside the
 * reads. When the reads were capped and the groups that are sure do not fill the page (duplicates took the room, or one key
 * holds many sightings of the same few ledgers), the page is read again with four times the room (`readGrowingCap`), so it
 * is always the first `limit` validations of the range, each whole. Then one lookup of `ledgers` by the indices of the page.
 */
@Injectable()
export class ValidatorValidationsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly directory: ValidatorDirectoryService,
  ) {}

  /**
   * A page of the validations of the master key `master`, `limit` at most, with the marker of the next page when there is one.
   * A marker that is none of ours answers 400 `invalid marker`.
   */
  async page(
    master: string,
    o: { limit: number; marker?: string; descending: boolean },
  ): Promise<{ rows: ValidationRow[]; marker?: string }> {
    // before any read: a marker that is none of ours is the client's mistake, whatever the table holds
    const after = decodeMarker(o.marker, VALIDATION_PAGE_KEYS);
    const keys = await this.keysOf(master);
    const cursor = keysetClause(VALIDATION_PAGE_KEYS, o.descending, after);
    const sql = validationsPageSql(keys.length, o.descending, cursor.clause);
    const params: Record<string, unknown> = {
      ...cursor.params,
      ...Object.fromEntries(keys.map((key, i) => [`key${i}`, key])),
      since: Math.floor(Date.now() / 1000) - VALIDATIONS_WINDOW_SECONDS,
      distinct_page_limit: o.limit + 1,
    };

    const rows = await readGrowingCap(o.limit, async (cap) => {
      const read = await this.ch.query<PageRow>(sql, { ...params, distinct_page_cap: cap });
      // the groups before the first one a capped read ended in are sure; the page needs `limit` of them
      const unsure = read.findIndex((row) => Number(row.cut) === 1);
      return { result: read, found: unsure === -1 ? read.length : unsure, read: unsure === -1 ? 0 : cap };
    });

    const page = paginate(rows, o.limit, (row) => [Number(row.ledger_index), row.ledger_hash]);
    const hashes = await this.ledgerHashes(page.rows.map((row) => Number(row.ledger_index)));
    return {
      rows: page.rows.map((row) => validationRow(row, hashes.get(Number(row.ledger_index)))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** The master key and the signing keys whose newest manifest names it: the keys its rows are recorded under. */
  private async keysOf(master: string): Promise<string[]> {
    const { signingToMaster } = await this.directory.get();
    const signing = [...signingToMaster].filter(([key, of]) => of === master && key !== master).map(([key]) => key);
    return [master, ...signing.sort()];
  }

  /** The hash of the ledger at each index; an index that is not a committed ledger is not in the map. */
  private async ledgerHashes(indexes: number[]): Promise<Map<number, string>> {
    if (indexes.length === 0) return new Map();
    const rows = await this.ch.query<{ ledger_index: number; ledger_hash: string }>(
      `SELECT ledger_index, ledger_hash FROM ${Table.Ledgers} WHERE ledger_index IN {indexes:Array(UInt32)}`,
      { indexes: [...new Set(indexes)] },
    );
    return new Map(rows.map((row) => [row.ledger_index, row.ledger_hash]));
  }
}

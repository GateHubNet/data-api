import { ClickHouseSettings } from '@clickhouse/client';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { readGrowingCap } from './distinct-page';

/**
 * A page of a list of a version-set table (`ReplacingMergeTree(version)`, read without FINAL), in the order of the table's key: the
 * newest version of each key, and only the keys whose newest version passes a condition.
 *
 * The aggregates (`nfts`, `account_nfts`, `nft_collection_holders`, ...) keep every version they have written until a merge, and a
 * key can lose what makes it a row of a list between versions: an NFT is burned, a holding is given up (`held` goes to 0). A condition
 * on the rows of the table (`WHERE held = 1`) would serve the older version that still has it, so the condition (`keep`) has to be
 * applied to the newest version of the key, after the step that picks it. That step cannot be put in one SELECT with the read (see
 * `distinct-page.ts`: the `LIMIT BY` keeps ClickHouse from stopping the read after the page), so a page is, as there:
 *  - the inner SELECT is the read: the prefix conditions and the keyset clause (`where`), `ORDER BY` the WHOLE sorting key of the table
 *    and a plain `LIMIT {newest_page_cap}`, which ClickHouse stops after (about a granule per part it touches). The key alone is
 *    what it orders by: with the version after it (`ORDER BY <key>, version DESC`) ClickHouse sorts the rest of the key in a
 *    transform that does not let the read stop, and reads the whole range (measured: 120,000 rows for a page of 200 where the key
 *    alone reads 65,536, two granules of each of four parts), so the versions of a key come in no order;
 *  - the middle one says which rows are the last key of the read, whose versions the cap may have cut (the newest could be among
 *    those left out) unless the read ended before the cap, and so is not served;
 *  - the next one keeps the newest version of each key (`ORDER BY <key>, version DESC LIMIT 1 BY <key>`, over the few rows the read
 *    took) and says whether the key is served: its group is whole and its newest version passes `keep`;
 *  - the outer one puts the keys that are served first, in key order, and cuts the page.
 * `cap` is the page plus room for old versions (as many as the page, at least 16). When the read hit its cap and the page came out
 * short, because old versions, keys that do not pass `keep` or a cut key took the room, it is read again with four times the room
 * (`readGrowingCap`), until the read is no longer capped: the page is always the first `limit` keys of the range whose newest version
 * passes `keep`.
 *
 * The rows of keys that are not served are still returned (after the ones that are, to fill the page) and dropped here, for one reason:
 * the number of rows the inner read took (`count() OVER ()`) is a column of the rows, and a page whose every row failed `keep`, or is
 * of the cut key, would otherwise come back empty, with nothing to tell a range that is over from a read that was cut by its cap.
 */

/** The column that says how many rows the inner read took (`count() OVER ()`). */
export const NEWEST_PAGE_READ = 'newest_page_read';
/** The column that says whether a key is served: its group of versions is whole, and its newest version passes `keep`. */
const NEWEST_PAGE_SERVED = 'newest_page_served';
/** The key of a row as a tuple, and the last key of the read (the largest, or the smallest when descending). */
const NEWEST_PAGE_TUPLE = 'newest_page_tuple';
const NEWEST_PAGE_EDGE = 'newest_page_edge';

export interface NewestPage {
  /** The columns of a row: SQL of the code, never user input. They include every column of `key` and every column `keep` names, and not `version`. */
  columns: string;
  /** The table to read. */
  table: Table;
  /** The prefix conditions and the keyset clause, joined by AND; none reads the whole table. */
  where: string[];
  /** The table's WHOLE sorting key, in order (with only a suffix of it ClickHouse sorts the range instead of reading it in order). */
  key: string[];
  /** The condition the newest version of a key must pass to be served (`held = 1`, `burned = 0`); `''` for none. SQL of the code. */
  keep: string;
  descending: boolean;
  /** The bound values of `columns`, `where` and `keep`. `newest_page_cap` and `newest_page_limit` are the read's own. */
  params: Record<string, unknown>;
  /** How many rows to return at most: the page and one more, which only tells whether there is a next page. */
  limit: number;
  /** Merged over the client's guards, as `ClickHouseService.query` does. */
  settings?: ClickHouseSettings;
}

/** The SQL of a page read (see the top of this file); `{newest_page_cap}` and `{newest_page_limit}` are bound. */
export function newestPageSql(
  p: Pick<NewestPage, 'columns' | 'table' | 'where' | 'key' | 'keep' | 'descending'>,
): string {
  const direction = p.descending ? 'DESC' : 'ASC';
  const key = p.key.join(', ');
  const ordered = p.key.map((c) => `${c} ${direction}`).join(', ');
  const edge = p.descending ? 'min' : 'max';
  return `SELECT * EXCEPT (${NEWEST_PAGE_TUPLE}, ${NEWEST_PAGE_EDGE}, ${NEWEST_PAGE_READ}), ${NEWEST_PAGE_READ} FROM (
  SELECT *, (${NEWEST_PAGE_READ} < {newest_page_cap:UInt32} OR ${NEWEST_PAGE_TUPLE} != ${NEWEST_PAGE_EDGE})${p.keep === '' ? '' : ` AND (${p.keep})`} AS ${NEWEST_PAGE_SERVED}
    FROM (
      SELECT *, count() OVER () AS ${NEWEST_PAGE_READ}, tuple(${key}) AS ${NEWEST_PAGE_TUPLE}, ${edge}(${NEWEST_PAGE_TUPLE}) OVER () AS ${NEWEST_PAGE_EDGE}
        FROM (SELECT ${p.columns}, version
                FROM ${p.table}${p.where.length > 0 ? `\n               WHERE ${p.where.join(' AND ')}` : ''}
               ORDER BY ${ordered}
               LIMIT {newest_page_cap:UInt32}))
   ORDER BY ${ordered}, version DESC
   LIMIT 1 BY ${key})
 ORDER BY ${NEWEST_PAGE_SERVED} DESC, ${ordered}
 LIMIT {newest_page_limit:UInt32}`;
}

/**
 * The first `limit` keys of the conditions, in the order of the key, whose newest version passes `keep` (see the top of this
 * file), each as its newest version. Reads once, unless old versions, keys that fail `keep` or a cut key fill the room of the inner
 * read; then again, with more room.
 */
export function readNewestPage<T>(ch: ClickHouseService, p: NewestPage): Promise<T[]> {
  const sql = newestPageSql(p);
  return readGrowingCap(p.limit, async (cap) => {
    const rows = await ch.query<Record<string, unknown>>(
      sql,
      { ...p.params, newest_page_limit: p.limit, newest_page_cap: cap },
      p.settings,
    );
    const served = rows.filter((row) => Number(row[NEWEST_PAGE_SERVED]) === 1);
    return {
      result: served.map((row) => {
        const { [NEWEST_PAGE_READ]: _read, [NEWEST_PAGE_SERVED]: _served, ...rest } = row;
        return rest as unknown as T;
      }),
      found: served.length,
      read: rows.length === 0 ? 0 : Number(rows[0][NEWEST_PAGE_READ]),
    };
  });
}

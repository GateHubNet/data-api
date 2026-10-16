import { ClickHouseSettings } from '@clickhouse/client';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';

/**
 * A page of a list read in the order of a table's primary key, each row once, without reading the rest of the range.
 *
 * The tables are ReplacingMergeTree and no list uses FINAL, so until a merge a row that was written twice is there twice,
 * and a list keeps one of them (`LIMIT 1 BY` its key). In ONE select, `ORDER BY <key> LIMIT 1 BY <key> LIMIT n` reads
 * the table in key order, but the `LIMIT BY` between the read and the `LIMIT` keeps ClickHouse (26.8) from pushing the
 * limit down into the read: over a range that spans more than one part it reads, and buffers, most of the range before
 * the page is cut (final review, Ruling R106: one 201-row page of a 256M-row table read 143M rows / 1.16 GiB, and failed
 * under a 100 MB memory cap; with a plain inner `LIMIT` it read 590k rows / 20 MiB).
 *
 * So a page is two selects:
 *  - the inner one is the read: the conditions, `ORDER BY` the WHOLE sorting key of the table and a plain
 *    `LIMIT {cap}`, which ClickHouse stops after `cap` rows of the key order (about a granule per part it touches);
 *  - the outer one dedupes what the inner one read (`LIMIT 1 BY` the key of a row) and cuts the page.
 * `cap` is the page plus room for duplicates (as many as the page, at least 16). When the duplicates took all of that
 * room (the inner read hit its cap and the page came out short), the page is read again with four times the room, until
 * the inner read is no longer capped: the page is always the first `limit` distinct rows of the range.
 */

/** The column of the outer select that says how many rows the inner one read (`count() OVER ()`). */
export const DISTINCT_PAGE_READ = 'distinct_page_read';
const MAX_UINT32 = 4_294_967_295;
/** The least room for duplicates; the room is the page itself when the page is larger. */
const MIN_SLACK = 16;
/** How much the room grows on every read again. */
const GROWTH = 4;

/** What one read under a cap gave: its result, how many of what it looks for it found, and how many rows it took. */
export interface CappedRead<R> {
  result: R;
  /** The rows (or buckets, ...) of the result; `limit` of them is enough. */
  found: number;
  /** The rows the capped inner read took: `cap` of them means it stopped at its cap, not at the end of the range. */
  read: number;
}

/**
 * Runs a read whose inner select takes at most `cap` rows: first with `cap` = `limit` plus room (as much as `limit`, at
 * least `minRoom`), then, while a read stopped at its cap and still found fewer than `limit`, with four times the room.
 * It ends at the first read that found `limit`, or was not capped (the range ended), or whose cap is the largest
 * UInt32: a handful of reads at most, however many duplicates there are.
 */
export async function readGrowingCap<R>(
  limit: number,
  read: (cap: number) => Promise<CappedRead<R>>,
  minRoom = MIN_SLACK,
): Promise<R> {
  let room = Math.max(limit, minRoom);
  for (;;) {
    const cap = Math.min(limit + room, MAX_UINT32);
    const done = await read(cap);
    if (done.found >= limit || done.read < cap || cap === MAX_UINT32) return done.result;
    room *= GROWTH;
  }
}

export interface DistinctPage {
  /** The columns of a row: SQL of the code, never user input. They include the `unique` columns, as named there. */
  columns: string;
  /** The table to read. */
  table: Table;
  /** The conditions, joined by AND (the keyset clause of a marker among them); none reads the whole table. */
  where: string[];
  /**
   * The ORDER BY of the read: the whole sorting key of the table, including the columns the conditions fix
   * (`account, ledger_index, tx_index`). With only a suffix of the key ClickHouse sorts the range instead of reading
   * it in order (Task 21).
   */
  orderBy: string[];
  /**
   * The output columns that identify a row (`ledger_index, tx_index`): a row written twice has the same values, and is
   * kept once. The page is ordered by them, so they have to give the order of `orderBy` once the fixed columns are left
   * out (or a monotonic function of it, like the milliseconds of a `DateTime64`).
   */
  unique: string[];
  descending: boolean;
  /** The bound values of `columns` and `where`. `distinct_page_cap` and `distinct_page_limit` are the read's own. */
  params: Record<string, unknown>;
  /** How many rows to return at most: the page and one more, which only tells whether there is a next page. */
  limit: number;
  /** Merged over the client's guards, as `ClickHouseService.query` does. */
  settings?: ClickHouseSettings;
}

/** The SQL of a page read (see the top of this file); `{distinct_page_cap}` and `{distinct_page_limit}` are bound. */
export function distinctPageSql(
  p: Pick<DistinctPage, 'columns' | 'table' | 'where' | 'orderBy' | 'unique' | 'descending'>,
): string {
  const direction = p.descending ? 'DESC' : 'ASC';
  const ordered = (columns: string[]): string => columns.map((c) => `${c} ${direction}`).join(', ');
  return `SELECT *, count() OVER () AS ${DISTINCT_PAGE_READ}
  FROM (SELECT ${p.columns}
          FROM ${p.table}${p.where.length > 0 ? `\n         WHERE ${p.where.join(' AND ')}` : ''}
         ORDER BY ${ordered(p.orderBy)}
         LIMIT {distinct_page_cap:UInt32})
 ORDER BY ${ordered(p.unique)}
 LIMIT 1 BY ${p.unique.join(', ')}
 LIMIT {distinct_page_limit:UInt32}`;
}

/**
 * The first `limit` distinct rows of the conditions in the order of the key (see the top of this file). Reads once,
 * unless duplicates fill the room of the inner read; then again, with more room.
 */
export function readDistinctPage<T>(ch: ClickHouseService, p: DistinctPage): Promise<T[]> {
  const sql = distinctPageSql(p);
  return readGrowingCap(p.limit, async (cap) => {
    const rows = await ch.query<T & Record<typeof DISTINCT_PAGE_READ, number | string>>(
      sql,
      { ...p.params, distinct_page_limit: p.limit, distinct_page_cap: cap },
      p.settings,
    );
    return {
      result: rows.map((row) => {
        const { [DISTINCT_PAGE_READ]: _read, ...rest } = row;
        return rest as unknown as T;
      }),
      found: rows.length,
      read: rows.length === 0 ? 0 : Number(rows[0][DISTINCT_PAGE_READ]),
    };
  });
}

import { Table } from '@gatehub/data-api-shared';
import type { Harness } from '../harness';

/**
 * Bulk rows for the read_rows regression tests (Ruling R106): a page of a list must read about the granules it needs, not
 * the range. A range only shows the difference once it spans more than one part, so the bulk is four parts of
 * `BULK_PER_PART` rows each, inserted separately into a table whose merges are stopped, each in a ledger range of its
 * own: `[base, base + BULK_LEDGERS)` for the bases below, four rows a ledger (`tx_index` 0..3). The ranges lie between
 * the ripple-mock ledgers 20005122 and 29136413, in four partitions of the tables partitioned by a million ledgers (one
 * partition, four parts, of those partitioned by ten million).
 *
 * The rows are copies of a real row of the table (`tpl.* REPLACE (...)`), so a page that serves them is a valid answer.
 */
export const BULK_BASES = [21_000_000, 22_000_000, 23_000_000, 24_000_000];
export const BULK_PER_PART = 200_000;
export const BULK_LEDGERS = BULK_PER_PART / 4;
/** The rows of a table's bulk. */
export const BULK_ROWS = BULK_BASES.length * BULK_PER_PART;

/** The ledger of the `n`-th row of a part (`n` is `n.number` in the insert). */
export const bulkLedger = (base: number): string => `toUInt32(${base} + intDiv(n.number, 4))`;
/** The position of the `n`-th row in its ledger. */
export const BULK_TX_INDEX = 'toUInt32(n.number % 4)';

/**
 * Inserts the bulk of a table: for each base, `perPart` copies of the row `template` selects (a `SELECT * ... LIMIT 1`),
 * with the columns `replace(base)` gives (`<expr> AS <column>, ...`; `n.number` counts the copies), as one insert, so
 * one part. Merges of the table are stopped first and stay stopped (the harness drops the database).
 */
export async function insertBulk(
  h: Harness,
  table: Table,
  template: string,
  params: Record<string, unknown>,
  replace: (base: number) => string,
  perPart = BULK_PER_PART,
): Promise<void> {
  await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
  const [found] = await h.ch.query<{ n: string }>(`SELECT count() AS n FROM (${template})`, params);
  if (Number(found.n) !== 1) throw new Error(`the template of the ${table} bulk selects ${found.n} rows, not one`);
  for (const base of BULK_BASES) {
    await h.ch.command(
      `INSERT INTO ${table}
       SELECT tpl.* REPLACE (${replace(base)})
         FROM (${template}) AS tpl
        CROSS JOIN numbers({bulk_rows:UInt32}) AS n`,
      { ...params, bulk_rows: perPart },
      { settings: { insert_deduplicate: 0 } },
    );
  }
}

/** What `system.query_log` says one SELECT of the app read. */
export interface LoggedRead {
  query: string;
  read_rows: number;
  memory_usage: number;
}

/**
 * The SELECTs of the app on `table` while `run` ran, in the order they started, with the rows each read
 * (`system.query_log`, matched on the harness's database and the table).
 */
export async function readsOf(h: Harness, table: Table, run: () => Promise<unknown>): Promise<LoggedRead[]> {
  const [{ t }] = await h.ch.query<{ t: string }>('SELECT now64(6) AS t');
  await run();
  await h.ch.command('SYSTEM FLUSH LOGS');
  const rows = await h.ch.query<{ query: string; read_rows: string; memory_usage: string }>(
    `SELECT query, read_rows, memory_usage FROM system.query_log
      WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
        AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
      ORDER BY query_start_time_microseconds`,
    { db: h.database, t, table: `${h.database}.${table}` },
  );
  return rows.map((r) => ({ query: r.query, read_rows: Number(r.read_rows), memory_usage: Number(r.memory_usage) }));
}

/** The base64url marker of a key. */
export const markerOf = (key: (string | number)[]): string =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

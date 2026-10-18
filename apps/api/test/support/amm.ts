import type { Table } from '@gatehub/data-api-shared';
import { encodeAccountID } from 'ripple-address-codec';
import type { ApiClient, Harness } from '../harness';
import { LoggedRead, readsOf } from './read-rows';

/**
 * Helpers the AMM e2e suites share (`amm-pools`, `amm-events`, `account-amm`): rows made by hand, the text of a time,
 * and what an `EXPLAIN indexes = 1` says about a primary key.
 */

/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds: what `fmtTime` writes, worked out here apart from the code under test. */
export const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;

/** The same object without the keys that are undefined or null: what the API leaves out. */
export const defined = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** A valid classic address made of a number: the same number is always the same account. */
export const accountAt = (n: number): string => encodeAccountID(Buffer.from(n.toString(16).padStart(40, '0'), 'hex'));

/** A 64-digit transaction hash made of a number. */
export const hashOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `?a=1&b=2`, encoded. */
export const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * Inserts each group of rows as its own insert, so as its own part. Rows of one insert with the same key are collapsed on
 * insert (`optimize_on_insert` runs the merge of a ReplacingMergeTree over the block), so the versions of one row that a
 * reader has to choose between (they exist until a merge) have to come in different inserts.
 */
export async function insertParts(h: Harness, table: Table, ...parts: unknown[][]): Promise<void> {
  for (const rows of parts) await h.ch.insert(table, rows);
}

/** What an `EXPLAIN indexes = 1` says about the primary key of each read of a MergeTree table, in plan order. */
export interface PrimaryKeyIndex {
  keys: string[];
  condition: string;
  parts: [number, number];
  granules: [number, number];
}

export function primaryKeys(plan: string): PrimaryKeyIndex[] {
  const text = plan.replace(/[│├└─]/g, ' ');
  return [
    ...text.matchAll(
      /PrimaryKey\s+Keys:\s+((?:\w+\s+)+?)Condition: ([^\n]*)\n\s+Parts: (\d+)\/(\d+)\n\s+Granules: (\d+)\/(\d+)/g,
    ),
  ].map((m) => ({
    keys: m[1].trim().split(/\s+/),
    condition: m[2],
    parts: [Number(m[3]), Number(m[4])],
    granules: [Number(m[5]), Number(m[6])],
  }));
}

/** What `served` hands back: the SELECTs of one request on a table, the SQL (with its params) of each, and the body. */
export interface Served {
  reads: LoggedRead[];
  statements: [string, Record<string, unknown>][];
  body: Record<string, unknown>;
}

/**
 * Serves `path` through the app and reports the SELECTs it made on `table`: what each read (`system.query_log`) and the SQL
 * with its params (to EXPLAIN them). `key` is the key the body must have (`api.ok`).
 */
export async function served(h: Harness, api: ApiClient, table: Table, path: string, key?: string): Promise<Served> {
  const spy = jest.spyOn(h.ch, 'query');
  let body: Record<string, unknown> = {};
  const reads = await readsOf(h, table, async () => {
    body = (await api.ok(path, key)).body as Record<string, unknown>;
  });
  const statements = spy.mock.calls
    .filter(([sql]) => new RegExp(`FROM ${table}\\b`).test(String(sql)))
    .map(
      ([sql, params]) => [String(sql), (params ?? {}) as Record<string, unknown>] as [string, Record<string, unknown>],
    );
  spy.mockRestore();
  return { reads, statements, body };
}

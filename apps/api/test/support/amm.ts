import { AmmLiquidityRow, AmmPoolStatesRow, Table } from '@gatehub/data-api-shared';
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

// -- text of a response ----------------------------------------------------------------------------------------------

export const lines = (text: string): string[] => text.split('\n');
export const cells = (line: string): string[] => line.split(',');
/** The key a base64url marker holds. */
export const decodeMarker = (marker: string): unknown => JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));

// -- the liquidity events ---------------------------------------------------------------------------------------------

/** The pinned key order of a liquidity event (written out here, apart from the code under test). */
export const LIQUIDITY_KEYS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'executed_time',
  'account',
  'initiator',
  'event',
  'mode',
  'base_amount',
  'counter_amount',
  'lp_tokens',
];

/** The object the API serves for a liquidity row (the oracle). */
export const liquidityOf = (r: AmmLiquidityRow): Record<string, unknown> =>
  defined({
    amm_account: r.amm_account,
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    tx_hash: r.tx_hash,
    executed_time: iso(r.close_time),
    account: r.account,
    initiator: r.initiator,
    event: r.event,
    mode: r.mode === '' ? undefined : r.mode,
    base_amount: r.base_amount,
    counter_amount: r.counter_amount,
    lp_tokens: r.lp_tokens,
  });

// -- rows made by hand --------------------------------------------------------------------------------------------------

/** The issuer of the `AAA` side of the pools made by hand. */
export const AAA_ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/**
 * When a ledger made by hand closes: one second a ledger from the recorded ledger 93663334 back (it closed at 1737679022) and
 * from 100132150 on (1762843711, before the next recorded one, 102186243). The order of the ledgers is the order of their
 * times, which the lookups of a date by a ledger rely on.
 */
export const ledgerCloseTime = (ledger: number): number =>
  ledger <= 93_663_334 ? 1_737_679_022 + (ledger - 93_663_334) : 1_762_843_711 + (ledger - 100_132_150);

/**
 * A state row of a pool made by hand: the pool AAA+AAA_ISSUER / XRP after a deposit, every value unknown (null) unless `over`
 * names it. The one list of the columns of the row, for every suite.
 */
export function poolStateRow(
  account: string,
  ledger: number,
  tx: number,
  over: Partial<AmmPoolStatesRow> = {},
): AmmPoolStatesRow {
  return {
    amm_account: account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hashOf(ledger * 1000 + tx),
    close_time: ledgerCloseTime(ledger),
    tx_type: 'AMMDeposit',
    base_currency: 'AAA',
    base_issuer: AAA_ISSUER,
    counter_currency: 'XRP',
    counter_issuer: '',
    reserve_base: null,
    reserve_counter: null,
    lp_supply: null,
    lp_currency: null,
    reserve_base_f: null,
    reserve_counter_f: null,
    lp_supply_f: null,
    trading_fee: null,
    auction_holder: null,
    auction_price: null,
    auction_price_f: null,
    auction_discounted_fee: null,
    auction_expiration: null,
    deleted: 0,
    ...over,
  };
}

/**
 * A `ledgers` row for a ledger made by hand, so that a date can name it: a copy of the first ledger of the table with this
 * index, hash and close time (unix seconds; `ledgerCloseTime` by default).
 */
export async function insertLedgerRow(h: Harness, ledger: number, closeTime = ledgerCloseTime(ledger)): Promise<void> {
  await h.ch.command(
    `INSERT INTO ${Table.Ledgers}
     SELECT tpl.* REPLACE (toUInt32({ledger:UInt32}) AS ledger_index, toDateTime({time:UInt32}, 'UTC') AS close_time,
                           {hash:String} AS ledger_hash)
       FROM (SELECT * FROM ${Table.Ledgers} ORDER BY ledger_index LIMIT 1) AS tpl`,
    { ledger, time: closeTime, hash: hashOf(ledger) },
  );
}

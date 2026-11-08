import { ClickHouseService } from '../../clickhouse/clickhouse.service';
import { Table } from '../../clickhouse/tables';
import { mptIssuerOf } from '../../util/mpt';
import {
  ISSUED_SIDE_KEEP,
  issuedAmountSql,
  issuedCountedSql,
  MPT_AUTHORIZED_SQL,
  MPT_FROZEN_SQL,
  mptAmountSql,
  mptCountedSql,
  mptEscrowedSql,
  orderKeySql,
} from '../token-side.sql';

/**
 * The build's `changes` pass (spec 4.6 phase 1): the change log of the issued tokens, from `trust_line_states`, one batch of
 * accounts at a time, as one `INSERT … SELECT` each, in ClickHouse.
 */

/** The transaction types whose changes are clawed back (spec 1). */
export const CLAWBACK_TX_TYPES = ['Clawback', 'AMMClawback'] as const;

/** The columns of `token_holder_changes`, in the order the passes write them. */
export const CHANGE_COLUMNS =
  'generation, issuer, currency, ledger_index, tx_index, node_index, holder, close_time, clawback, amount_before, amount_after, ' +
  'counted_before, counted_after, before_known, `limit`, frozen, authorized, escrowed, order_exp, order_mant';

/** The options of a batch of a changes pass. */
export interface ChangesBatchOptions {
  /**
   * Whether the generation's coverage is complete (it starts at or before the network's first ledger, spec 6). A line's first row in
   * the coverage is then its creation, unless the line has a row below the coverage, and its before-state is known. In an incomplete
   * coverage a line's first row may follow a state the index never saw, so it is `before_known = 0`: the state history keeps no node
   * type, so the pass cannot tell a creation from a change there.
   */
  coverageComplete: boolean;
  /** `max_threads` of the statement (default: the server's). */
  threads?: number;
}

const lagged = { balance: 'p_balance', limit_peer: 'p_limit_peer', deleted: 'p_deleted' };
const amountKey = orderKeySql('amount_after', 'issued');

/**
 * The statement of a batch. The inner read is the batch's rows of `[from, h0]` in key order, each with the row before it on its line
 * (`lagInFrame` over `(account, counterparty, currency)` ordered by `(ledger_index, tx_index, node_index)`): the token side before and
 * after. A row of a line below `from` never serves as a before-state. A row stored twice (a re-ingest before the merge) is read once:
 * the second has the key of the row before it. Only the changes where the line counted before or after are written, in the table's
 * order.
 */
function changesBatchSql(coverageComplete: boolean): string {
  const firstKnown = coverageComplete
    ? `toUInt8((account, counterparty, currency) NOT IN (
         SELECT account, counterparty, currency FROM ${Table.TrustLineStates}
          WHERE account IN {accounts:Array(String)} AND ledger_index < {from:UInt32}))`
    : 'toUInt8(0)';
  return `INSERT INTO ${Table.TokenHolderChanges} (${CHANGE_COLUMNS})
SELECT {g:UInt32}, account, currency, ledger_index, tx_index, node_index, counterparty, close_time,
       toUInt8((ledger_index, tx_index) IN (
         SELECT ledger_index, tx_index FROM ${Table.TxByType}
          WHERE tx_type IN {clawbackTypes:Array(String)} AND ledger_index >= {from:UInt32} AND ledger_index <= {h0:UInt32})),
       amount_before, amount_after, counted_before, counted_after,
       if(rn = 1, ${firstKnown}, toUInt8(1)),
       limit_peer, freeze, authorized, '0', ${amountKey.exp}, ${amountKey.mant}
  FROM (
    SELECT account, counterparty, currency, ledger_index, tx_index, node_index, close_time, limit_peer, freeze, authorized, rn,
           if(rn = 1, '0', ${issuedAmountSql(lagged)}) AS amount_before,
           ${issuedAmountSql()} AS amount_after,
           if(rn = 1, toUInt8(0), toUInt8(${issuedCountedSql(lagged)})) AS counted_before,
           toUInt8(${issuedCountedSql()}) AS counted_after
      FROM (
        SELECT account, counterparty, currency, ledger_index, tx_index, node_index, close_time, balance, limit_peer, freeze,
               authorized, deleted,
               row_number() OVER w AS rn,
               lagInFrame(balance) OVER w AS p_balance,
               lagInFrame(limit_peer) OVER w AS p_limit_peer,
               lagInFrame(deleted) OVER w AS p_deleted,
               lagInFrame(ledger_index) OVER w AS p_ledger,
               lagInFrame(tx_index) OVER w AS p_tx,
               lagInFrame(node_index) OVER w AS p_node
          FROM ${Table.TrustLineStates}
         WHERE account IN {accounts:Array(String)} AND ledger_index >= {from:UInt32} AND ledger_index <= {h0:UInt32}
           AND ${ISSUED_SIDE_KEEP}
        WINDOW w AS (PARTITION BY account, counterparty, currency ORDER BY ledger_index, tx_index, node_index
                     ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))
     WHERE NOT (rn > 1 AND p_ledger = ledger_index AND p_tx = tx_index AND p_node = node_index))
 WHERE counted_before = 1 OR counted_after = 1
 ORDER BY account, currency, ledger_index, tx_index, node_index, counterparty`;
}

/** The dedup token of a batch: a batch run again (a retry, a resumed build) is dropped by the server. */
export const changesBatchToken = (g: number, kind: 'changes' | 'mpt_changes', first: string, last: string): string =>
  `token_history:${g}:${kind}:${first}-${last}`;

/** The settings of a batch's insert: deterministic blocks (one insert thread, a sorted stream) under its dedup token. */
export function batchInsertSettings(token: string, threads?: number): Record<string, string | number> {
  return {
    insert_deduplicate: 1,
    insert_deduplication_token: token,
    max_insert_threads: 1,
    ...(threads === undefined ? {} : { max_threads: threads }),
  };
}

/**
 * Writes the change rows of generation `g` for the issued tokens of `accounts` (a batch of the pass, in key order) over the rows of
 * `[coverageFrom, h0]`: one `INSERT … SELECT`. Deterministic, under the dedup token `token_history:<g>:changes:<first>-<last>`, so
 * running it again writes nothing. Returns the rows the server wrote.
 */
export async function writeChangesBatch(
  ch: ClickHouseService,
  g: number,
  accounts: string[],
  coverageFrom: number,
  h0: number,
  o: ChangesBatchOptions,
): Promise<{ rows: number }> {
  if (accounts.length === 0) return { rows: 0 };
  const token = changesBatchToken(g, 'changes', accounts[0], accounts[accounts.length - 1]);
  const summary = await ch.command(
    changesBatchSql(o.coverageComplete),
    { g, accounts, from: coverageFrom, h0, clawbackTypes: [...CLAWBACK_TX_TYPES] },
    { settings: batchInsertSettings(token, o.threads) },
  );
  return { rows: summary.written_rows };
}

// ---------------------------------------------------------------------------------------------------------------------
// The MPT pass (spec 4.6 phase 2)
// ---------------------------------------------------------------------------------------------------------------------

/** The next holders of `mpt_holder_states` in key order, as `nextPassAccounts` reads accounts: stopped by its `LIMIT` groups. */
const NEXT_MPT_HOLDERS_SQL = `SELECT holder
  FROM ${Table.MptHolderStates}
 WHERE holder > {after:String}
 GROUP BY holder
 ORDER BY holder
 LIMIT {n:UInt32}`;

/** The holders of an `MPToken` after `after`, in key order, at most `n`: a batch of the MPT pass. Empty past the last. */
export async function nextMptPassHolders(ch: ClickHouseService, after: string, n: number): Promise<string[]> {
  const rows = await ch.query<{ holder: string }>(NEXT_MPT_HOLDERS_SQL, { after, n }, {
    optimize_aggregation_in_order: 1,
    max_block_size: '8192',
  });
  return rows.map((r) => r.holder);
}

const mptLagged = { amount: 'p_amount', escrowed_amount: 'p_escrowed', deleted: 'p_deleted' };

/**
 * The statement of an MPT batch: the rule of `changesBatchSql` over `mpt_holder_states`, by `(holder, mpt_issuance_id)`. The issuer
 * of each issuance ID is bound (`{ids}`, `{issuers}`), worked out by `mptIssuerOf`; `clawback` is the row's own `tx_type`.
 */
function mptChangesBatchSql(coverageComplete: boolean): string {
  const firstKnown = coverageComplete
    ? `toUInt8((holder, mpt_issuance_id) NOT IN (
         SELECT holder, mpt_issuance_id FROM ${Table.MptHolderStates}
          WHERE holder IN {holders:Array(String)} AND ledger_index < {from:UInt32}))`
    : 'toUInt8(0)';
  return `INSERT INTO ${Table.TokenHolderChanges} (${CHANGE_COLUMNS})
SELECT {g:UInt32}, transform(mpt_issuance_id, {ids:Array(String)}, {issuers:Array(String)}, '') AS issuer, mpt_issuance_id,
       ledger_index, tx_index, node_index, holder, close_time,
       toUInt8(tx_type IN {clawbackTypes:Array(String)}),
       amount_before, amount_after, counted_before, counted_after,
       if(rn = 1, ${firstKnown}, toUInt8(1)),
       '', ${MPT_FROZEN_SQL}, ${MPT_AUTHORIZED_SQL}, escrowed, ${orderKeySql('amount_after', 'mpt').exp},
       ${orderKeySql('amount_after', 'mpt').mant}
  FROM (
    SELECT holder, mpt_issuance_id, ledger_index, tx_index, node_index, close_time, tx_type, flags, rn,
           if(rn = 1, '0', ${mptAmountSql(mptLagged)}) AS amount_before,
           ${mptAmountSql()} AS amount_after,
           if(rn = 1, toUInt8(0), toUInt8(${mptCountedSql(mptLagged)})) AS counted_before,
           toUInt8(${mptCountedSql()}) AS counted_after,
           ${mptEscrowedSql()} AS escrowed
      FROM (
        SELECT holder, mpt_issuance_id, ledger_index, tx_index, node_index, close_time, tx_type, amount, escrowed_amount, flags,
               deleted,
               row_number() OVER w AS rn,
               lagInFrame(amount) OVER w AS p_amount,
               lagInFrame(escrowed_amount) OVER w AS p_escrowed,
               lagInFrame(deleted) OVER w AS p_deleted,
               lagInFrame(ledger_index) OVER w AS p_ledger,
               lagInFrame(tx_index) OVER w AS p_tx,
               lagInFrame(node_index) OVER w AS p_node
          FROM ${Table.MptHolderStates}
         WHERE holder IN {holders:Array(String)} AND ledger_index >= {from:UInt32} AND ledger_index <= {h0:UInt32}
        WINDOW w AS (PARTITION BY holder, mpt_issuance_id ORDER BY ledger_index, tx_index, node_index
                     ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))
     WHERE NOT (rn > 1 AND p_ledger = ledger_index AND p_tx = tx_index AND p_node = node_index))
 WHERE counted_before = 1 OR counted_after = 1
 ORDER BY issuer, mpt_issuance_id, ledger_index, tx_index, node_index, holder`;
}

/**
 * Writes the change rows of generation `g` for the MPTokens of `holders` (a batch of the MPT pass, in key order) over the rows of
 * `[coverageFrom, h0]`, as `writeChangesBatch` does for lines: the holder's amount is `amount + escrowed_amount`, the issuer is the
 * one the issuance ID names. Under the dedup token `token_history:<g>:mpt_changes:<first>-<last>`.
 */
export async function writeMptChangesBatch(
  ch: ClickHouseService,
  g: number,
  holders: string[],
  coverageFrom: number,
  h0: number,
  o: ChangesBatchOptions,
): Promise<{ rows: number }> {
  if (holders.length === 0) return { rows: 0 };
  const ids = (
    await ch.query<{ id: string }>(
      `SELECT DISTINCT mpt_issuance_id AS id FROM ${Table.MptHolderStates} WHERE holder IN {holders:Array(String)}`,
      { holders },
    )
  ).map((r) => r.id);
  const token = changesBatchToken(g, 'mpt_changes', holders[0], holders[holders.length - 1]);
  const summary = await ch.command(
    mptChangesBatchSql(o.coverageComplete),
    {
      g,
      holders,
      from: coverageFrom,
      h0,
      ids,
      issuers: ids.map(mptIssuerOf),
      clawbackTypes: [...CLAWBACK_TX_TYPES],
    },
    { settings: batchInsertSettings(token, o.threads) },
  );
  return { rows: summary.written_rows };
}

import { ClickHouseService } from '../../clickhouse/clickhouse.service';
import { Table } from '../../clickhouse/tables';
import { orderKeySql } from '../token-side.sql';
import { ISSUED_SIDE_KEEP, issuedAmountSql, issuedCountedSql } from '../token-side.sql';

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

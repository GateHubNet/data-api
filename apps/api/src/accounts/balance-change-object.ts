import { BalanceChangesRow } from '@gatehub/data-api-shared';
import { fmtTime } from '../common/format';

/**
 * A balance change as the Ripple API serves it (`accountBalanceChanges.js` on the row `lib/hbase/hbase-thrift/data.js`
 * builds). The keys come in the order of the original: the columns of HBase's `d` family, then those of the `f` family,
 * each sorted by name. A field the change does not have is left out: the fee has no node, the native currency no
 * counterparty, a change of most transaction types no change type, and only the change of a party to an escrow or a
 * payment channel has the `escrow_*` and `paychannel_*` fields. The account and the client are stripped.
 *
 * `paychannel_balance_change` is not served (R61): the parser computes it and the table keeps it, but the original's
 * `prepareParsedData` never wrote it to HBase, so data.ripple.com never returned it. The other three
 * `paychannel_*` amounts and `paychannel_counterparty` it did write.
 */
export interface BalanceChangeObject {
  /** Whole units of the currency, exact. */
  amount_change: string;
  escrow_balance_change?: string;
  /** The balance after the change, whole units, exact. */
  final_balance: string;
  /** The node of the transaction's metadata the change comes from; the fee (a `transaction_cost`) has none. */
  node_index?: number;
  paychannel_final_balance?: string;
  paychannel_fund_change?: string;
  paychannel_fund_final_balance?: string;
  tx_index: number;
  /** `transaction_cost`, `payment_source`, `payment_destination`, `exchange`, `intermediary`, `escrow_*`, `paychannel_*`. */
  change_type?: string;
  /** The other side of the trust line; the native currency has none. */
  counterparty?: string;
  currency: string;
  escrow_counterparty?: string;
  /** `YYYY-MM-DDTHH:mm:ssZ`, the close time of the ledger. */
  executed_time: string;
  ledger_index: number;
  paychannel_counterparty?: string;
  tx_hash: string;
}

/**
 * The columns of `balance_changes` the API reads: what `StoredBalanceChange` holds, with the close time as unix seconds.
 * Not `paychannel_balance_change`, which is not served.
 */
export const BALANCE_CHANGE_COLUMNS = [
  'ledger_index',
  'tx_index',
  'node_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'currency',
  'counterparty',
  'amount_change',
  'final_balance',
  'change_type',
  'escrow_counterparty',
  'escrow_balance_change',
  'paychannel_counterparty',
  'paychannel_fund_change',
  'paychannel_fund_final_balance',
  'paychannel_final_balance',
].join(', ');

/** A row of `balance_changes` as `BALANCE_CHANGE_COLUMNS` reads it. The account, the Float64 shadow and the client are not read. */
export type StoredBalanceChange = Pick<
  BalanceChangesRow,
  | 'ledger_index'
  | 'tx_index'
  | 'node_index'
  | 'tx_hash'
  | 'close_time'
  | 'currency'
  | 'counterparty'
  | 'amount_change'
  | 'final_balance'
  | 'change_type'
  | 'escrow_counterparty'
  | 'escrow_balance_change'
  | 'paychannel_counterparty'
  | 'paychannel_fund_change'
  | 'paychannel_fund_final_balance'
  | 'paychannel_final_balance'
>;

/** The API object of a stored balance change. */
export function toBalanceChangeObject(row: StoredBalanceChange): BalanceChangeObject {
  return {
    amount_change: row.amount_change,
    ...(row.escrow_balance_change !== null && { escrow_balance_change: row.escrow_balance_change }),
    final_balance: row.final_balance,
    // the fee of a transaction is stored at node -1 and served with none (`delete row.node_index` of the original)
    ...(row.node_index !== -1 && { node_index: row.node_index }),
    ...(row.paychannel_final_balance !== null && { paychannel_final_balance: row.paychannel_final_balance }),
    ...(row.paychannel_fund_change !== null && { paychannel_fund_change: row.paychannel_fund_change }),
    ...(row.paychannel_fund_final_balance !== null && {
      paychannel_fund_final_balance: row.paychannel_fund_final_balance,
    }),
    tx_index: row.tx_index,
    // a change of a transaction that is none of the typed ones (GenesisMint, Cron, ...) is stored with '', the original had none
    ...(row.change_type !== '' && { change_type: row.change_type }),
    // the native currency has no counterparty, stored as ''
    ...(row.counterparty !== '' && { counterparty: row.counterparty }),
    currency: row.currency,
    ...(row.escrow_counterparty !== null && { escrow_counterparty: row.escrow_counterparty }),
    executed_time: fmtTime(row.close_time),
    ledger_index: row.ledger_index,
    ...(row.paychannel_counterparty !== null && { paychannel_counterparty: row.paychannel_counterparty }),
    tx_hash: row.tx_hash,
  };
}

import { AccountsCreatedRow } from '@gatehub/data-api-shared';
import { fmtTime } from '../common/format';

/** The columns of `accounts_created` the API reads: what `StoredAccount` holds, with the inception as unix seconds. */
export const ACCOUNT_COLUMNS = [
  'account',
  'parent',
  'initial_balance',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(inception) AS inception',
  'genesis_balance',
  'genesis_index',
].join(', ');

/** A row of `accounts_created` as `ACCOUNT_COLUMNS` reads it. */
export type StoredAccount = AccountsCreatedRow;

/**
 * An account as `accounts.js` and `getAccount.js` serve it. `genesis_balance` and `genesis_index` are there only when
 * the row has them: the accounts of the first ledger (32570) come from a history import that has not been made, so
 * today none do.
 */
export interface AccountObject {
  account: string;
  /** The sender of the transaction that created the account. */
  parent: string;
  /** The balance the account was created with, in whole units of the native currency, as exact decimal text. */
  initial_balance: string;
  /** The close time of the ledger that created it, `YYYY-MM-DDTHH:mm:ssZ`. */
  inception: string;
  ledger_index: number;
  tx_hash: string;
  genesis_balance?: string;
  genesis_index?: number;
}

/**
 * The API object of a stored account, with the fields in the order of the original (`account`, `parent`,
 * `initial_balance`, `inception`, `ledger_index`, `tx_hash`, then the genesis ones). `tx_index` only completes the key
 * of the table and is not served.
 */
export function toAccountObject(row: StoredAccount): AccountObject {
  return {
    account: row.account,
    parent: row.parent,
    initial_balance: row.initial_balance,
    inception: fmtTime(row.inception),
    ledger_index: row.ledger_index,
    tx_hash: row.tx_hash,
    ...(row.genesis_balance !== null && { genesis_balance: row.genesis_balance }),
    ...(row.genesis_index !== null && { genesis_index: row.genesis_index }),
  };
}

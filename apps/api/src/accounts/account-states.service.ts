import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';

/** What the historical reads take from the state of an account root at a ledger. */
export interface AccountState {
  /** The native balance in whole units, exact decimal text. */
  balance: string;
  /** The AccountRoot `Flags`. */
  flags: number;
}

/**
 * The state of an account at a ledger, from the account state history (`account_states`; ADR-0015): its newest row at
 * or before the ledger. It is read by the historical answers of `/v2/accounts/:address?flags=true` (the flags) and of
 * `/v2/accounts/:address/balances` (the native balance).
 *
 * The ledger must be one the state tables cover (`StateLedgerService.resolve`); this service does not check.
 */
@Injectable()
export class AccountStatesService {
  constructor(private readonly ch: ClickHouseService) {}

  /**
   * The state of the account at the ledger; `undefined` when it has no row at or before it, or when its newest row
   * deleted the account (AccountDelete): the account did not exist at that ledger.
   */
  async stateAt(address: string, ledgerIndex: number): Promise<AccountState | undefined> {
    const [row] = await this.ch.query<{ balance: string; flags: number; deleted: number }>(
      `SELECT balance, flags, deleted FROM ${Table.AccountStates}
        WHERE account = {address:String} AND ledger_index <= {ledgerIndex:UInt32}
        ORDER BY ledger_index DESC, tx_index DESC, node_index DESC
        LIMIT 1`,
      { address, ledgerIndex },
    );
    if (!row || row.deleted) return undefined;
    return { balance: row.balance, flags: row.flags };
  }
}

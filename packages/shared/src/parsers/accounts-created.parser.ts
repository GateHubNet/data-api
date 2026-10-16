import { dropsToNative } from '../util/amount';
import { ParseContext, ParserTx, senderAccount } from './parser.interface';

export interface ParsedAccountCreated {
  account: string;
  /** The sender of the transaction that created it. */
  parent: string;
  /** The balance it was created with, in whole units of the native currency. */
  initial_balance: string;
}

type Json = Readonly<Record<string, any>>;

export class AccountsCreatedParser {
  /**
   * The accounts a successful transaction created, in the order of `meta.AffectedNodes`. Matches
   * `ledgerParser/accountsCreated.js` of the Ripple Data API: every `CreatedNode` of an `AccountRoot` in a `tesSUCCESS`
   * transaction, with the transaction's sender as the parent. Differences from the reference:
   * - the balance is an exact decimal string (the reference divided a Number), and an account created without a
   *   `Balance` starts at `0`;
   * - AMM pseudo-accounts (`AMMID`) are not accounts anybody opened, so they are not creations. The reference predates
   *   AMMs.
   *
   * Native amounts are drops on every network, so `ctx` only keeps the signature the same as the other parsers.
   *
   * Pure: nothing in `t` is modified.
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedAccountCreated[] {
    if (t.meta.TransactionResult !== 'tesSUCCESS') return [];

    const accounts: ParsedAccountCreated[] = [];
    for (const affected of (t.meta.AffectedNodes ?? []) as readonly Json[]) {
      const node: Json | undefined = affected.CreatedNode;
      if (!node || node.LedgerEntryType !== 'AccountRoot') continue;

      const fields: Json = node.NewFields ?? {};
      if ('AMMID' in fields) continue;
      accounts.push({
        account: fields.Account,
        parent: senderAccount(t.tx) ?? t.tx.Account,
        initial_balance: dropsToNative(fields.Balance ?? '0'),
      });
    }
    return accounts;
  }
}

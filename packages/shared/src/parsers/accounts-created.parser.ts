import { BigNumber } from 'bignumber.js';
import * as xrpl from 'xrpl';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedAccountCreated {
  account: string;
  parent: string;
  balance: string;
  date: number;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  client?: string | null;
}

export class AccountsCreatedParser implements IParser<ParsedAccountCreated[]> {
  parse(transaction: XrplTx): ParsedAccountCreated[] {
    const metadata = transaction.meta;
    const list: ParsedAccountCreated[] = [];
    if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') return [];

    for (const affNode of metadata.AffectedNodes as any[]) {
      if (!affNode.CreatedNode || affNode.CreatedNode.LedgerEntryType !== 'AccountRoot') continue;
      const fields = affNode.CreatedNode.NewFields ?? {};
      // Skip AMM pseudo-accounts (created by AMMCreate): they are not user account
      // creations and may carry no XRP Balance field. The `?? 0` further guards any
      // created AccountRoot without an explicit Balance so it can never produce NaN.
      if ('AMMID' in fields) continue;
      list.push({
        account: fields.Account,
        parent: transaction.Account,
        balance: xrpl.dropsToXrp(new BigNumber(fields.Balance ?? 0)).toString(),
        date: transaction.date,
        ledger_index: transaction.ledger_index,
        tx_index: metadata.TransactionIndex,
        tx_hash: transaction.hash,
        client: transaction.client,
      });
    }
    return list;
  }
}

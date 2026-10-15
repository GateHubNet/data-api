import { getAffectedAccounts } from 'ripple-lib-transactionparser';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedAffectedAccount {
  account: string;
  tx_result: string;
  tx_type: string;
  date: number;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  client?: string | null;
}

export class AffectedAccountsParser implements IParser<ParsedAffectedAccount[]> {
  public parse(transaction: XrplTx): ParsedAffectedAccount[] {
    const metadata = transaction.meta;
    const list: ParsedAffectedAccount[] = [];
    if (!metadata) return [];

    for (const account of getAffectedAccounts(metadata)) {
      if (account[0] !== 'r') continue;
      list.push({
        account,
        tx_result: metadata.TransactionResult,
        tx_type: transaction.TransactionType,
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

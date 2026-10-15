declare module 'ripple-lib-transactionparser' {
  import { TransactionMetadata } from 'xrpl';

  export interface BalanceChange {
    counterparty: string;
    currency: string;
    value: string;
  }

  export function parseBalanceChanges(metadata: TransactionMetadata): Record<string, BalanceChange[]>;
  export function getAffectedAccounts(metadata: TransactionMetadata): string[];
}

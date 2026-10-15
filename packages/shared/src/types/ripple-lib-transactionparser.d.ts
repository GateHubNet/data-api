declare module 'ripple-lib-transactionparser' {
  export interface BalanceChange {
    counterparty: string;
    currency: string;
    value: string;
  }

  export function parseBalanceChanges(metadata: Readonly<Record<string, any>>): Record<string, BalanceChange[]>;
  export function getAffectedAccounts(metadata: Readonly<Record<string, any>>): string[];
}

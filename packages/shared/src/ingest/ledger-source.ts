import { RawLedger } from './raw-ledger';

/** Where the ledger writer gets ledgers from: a live node, or recorded fixtures in tests. */
export interface LedgerSource {
  /** Index of the newest validated ledger the source can serve. */
  validatedHead(): Promise<number>;
  /** The ledger with the given index; rejects with `LedgerNotAvailableError` when the source does not have it. */
  fetch(index: number): Promise<RawLedger>;
}

/** Thrown by a `LedgerSource` when asked for a ledger it does not have. */
export class LedgerNotAvailableError extends Error {
  constructor(readonly ledgerIndex: number) {
    super(`Ledger ${ledgerIndex} is not available`);
    this.name = 'LedgerNotAvailableError';
  }
}

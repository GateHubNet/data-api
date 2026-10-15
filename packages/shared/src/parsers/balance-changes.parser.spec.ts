import { BalanceChangesParser } from './balance-changes.parser';
import { XrplTx } from './parser.interface';

describe('BalanceChangesParser', () => {
  const parser = new BalanceChangesParser();

  it('returns the sender fee change for a simple XRP payment without throwing', () => {
    const tx = {
      TransactionType: 'Payment',
      Account: 'rSender',
      Destination: 'rDest',
      Amount: '1000000',
      Fee: '12',
      hash: 'HASH',
      ledger_index: 100,
      date: 1_700_000_000,
      meta: {
        TransactionResult: 'tesSUCCESS',
        TransactionIndex: 0,
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: 'rSender', Balance: '98999988' },
              PreviousFields: { Balance: '100000000' },
            },
          },
        ],
      },
    } as unknown as XrplTx;

    const changes = parser.parse(tx);
    expect(Array.isArray(changes)).toBe(true);
    const fee = changes.find((c) => c.type === 'fee');
    expect(fee).toBeDefined();
    expect(fee?.account).toBe('rSender');
  });

  it('classifies a RippleState source leg as payment_source via comparison (regression: the old code used assignment)', () => {
    const tx = {
      TransactionType: 'Payment',
      Account: 'rSender',
      Destination: 'rDest',
      Amount: { currency: 'USD', issuer: 'rGate', value: '10' },
      Fee: '12',
      hash: 'HASH',
      ledger_index: 100,
      date: 1_700_000_000,
      meta: {
        TransactionResult: 'tesSUCCESS',
        TransactionIndex: 0,
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'RippleState',
              FinalFields: {
                Balance: { currency: 'USD', value: '5' },
                HighLimit: { issuer: 'rSender', currency: 'USD' },
                LowLimit: { issuer: 'rGate', currency: 'USD' },
              },
              PreviousFields: { Balance: { currency: 'USD', value: '15' } },
            },
          },
        ],
      },
    } as unknown as XrplTx;

    const changes = parser.parse(tx);
    // The high party is the sender; that leg must be tagged payment_source and its
    // account must remain 'rSender' (the old `data.account = tx.Account` assignment
    // would silently corrupt the low-party leg).
    const senderLeg = changes.find((c) => c.account === 'rSender');
    expect(senderLeg).toBeDefined();
    expect(senderLeg?.type).toBe('payment_source');
    const gateLeg = changes.find((c) => c.account === 'rGate');
    expect(gateLeg?.account).toBe('rGate');
  });
});

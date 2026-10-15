import { EscrowParser } from './escrow.parser';
import { XrplTx } from './parser.interface';

describe('EscrowParser', () => {
  const parser = new EscrowParser();

  const base = {
    Account: 'rCreator',
    Destination: 'rDest',
    Fee: '12',
    hash: 'H',
    ledger_index: 15013709,
    date: 1_700_000_000,
    meta: {
      TransactionResult: 'tesSUCCESS',
      TransactionIndex: 0,
      AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Escrow', NewFields: { Account: 'rCreator', Destination: 'rDest' } } }],
    },
  };

  it('parses a token-enabled escrow (IOU Amount) without throwing (regression: NaN/dropsToXrp)', () => {
    const tx = {
      ...base,
      TransactionType: 'EscrowCreate',
      Amount: { currency: 'USD', issuer: 'rBT1mDMmZhmuzXvvNmZ7njDh6uf7GtxJnG', value: '100' },
    } as unknown as XrplTx;

    const escrow = parser.parse(tx);
    expect(escrow).toBeDefined();
    expect(escrow!.amount).toBe('100'); // token value in whole units, not drops-converted
    expect(escrow!.tx_type).toBe('EscrowCreate');
  });

  it('parses a classic XRP escrow (drops Amount) -> XRP', () => {
    const tx = {
      ...base,
      TransactionType: 'EscrowCreate',
      Amount: '100000000', // 100 XRP in drops
    } as unknown as XrplTx;

    const escrow = parser.parse(tx);
    expect(escrow!.amount).toBe('100');
  });
});

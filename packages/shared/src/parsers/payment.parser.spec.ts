import { PaymentParser } from './payment.parser';
import { XrplTx } from './parser.interface';

describe('PaymentParser', () => {
  const parser = new PaymentParser();

  it('strips the fee from the XRP source balance change (regression: fee must be added back, not subtracted)', () => {
    // rSender pays 100 XRP to rDest, fee 12 drops. The source AccountRoot drops by
    // 100.000012 XRP (amount + fee). The reported source balance change should be the
    // payment amount alone, -100, with the fee accounted for separately.
    const tx = {
      TransactionType: 'Payment',
      Account: 'rSender',
      Destination: 'rDest',
      Amount: '100000000', // 100 XRP in drops
      Fee: '12',
      hash: 'HASH',
      ledger_index: 200,
      date: 1_700_000_000,
      meta: {
        TransactionResult: 'tesSUCCESS',
        TransactionIndex: 0,
        delivered_amount: '100000000',
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: 'rSender', Balance: '899999988' }, // 1000 - 100.000012 XRP
              PreviousFields: { Balance: '1000000000' }, // 1000 XRP
            },
          },
          {
            ModifiedNode: {
              LedgerEntryType: 'AccountRoot',
              FinalFields: { Account: 'rDest', Balance: '100000000' },
              PreviousFields: { Balance: '0' },
            },
          },
        ],
      },
    } as unknown as XrplTx;

    const payment = parser.parse(tx);
    expect(payment).toBeDefined();
    expect(payment!.currency).toBe('XRP');
    expect(payment!.amount).toBe('100');
    expect(payment!.delivered_amount).toBe('100');

    // The XRP source change must be exactly the payment amount, not -100.000024 (the
    // old bug, which subtracted the fee again).
    const xrpChange = (payment!.source_balance_changes as { currency: string; value: string }[]).find((c) => c.currency === 'XRP');
    expect(xrpChange).toBeDefined();
    expect(Number(xrpChange!.value)).toBeCloseTo(-100, 9);
  });

  it('ignores a payment to self (handled as an exchange)', () => {
    const tx = {
      TransactionType: 'Payment',
      Account: 'rSelf',
      Destination: 'rSelf',
      Amount: '1000000',
      Fee: '10',
      hash: 'H',
      ledger_index: 1,
      date: 1,
      meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] },
    } as unknown as XrplTx;
    expect(parser.parse(tx)).toBeUndefined();
  });
});

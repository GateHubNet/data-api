import { PAYMENT_COLUMNS, StoredPayment, toPaymentObject } from './payment-object';

const STORED: StoredPayment = {
  ledger_index: 11616399,
  tx_index: 4,
  tx_hash: 'A'.repeat(64),
  close_time: 1_421_256_550,
  source: 'rSource',
  destination: 'rDestination',
  currency: 'USD',
  issuer: 'rIssuer',
  amount: '100.5',
  delivered_amount: '100',
  max_amount: '101',
  source_currency: 'EUR',
  source_tag: 0,
  destination_tag: 7,
  invoice_id: 'ABCDEF',
  fee: '12',
  source_balance_changes: '[{"counterparty":"rIssuer","currency":"EUR","value":"-90"}]',
  destination_balance_changes: '[{"counterparty":"rIssuer","currency":"USD","value":"100"}]',
};

describe('toPaymentObject', () => {
  it('has the fields of the original in its order, the cost last', () => {
    expect(Object.keys(toPaymentObject(STORED))).toEqual([
      'amount',
      'delivered_amount',
      'destination_balance_changes',
      'max_amount',
      'source_balance_changes',
      'tx_index',
      'currency',
      'destination',
      'destination_tag',
      'executed_time',
      'invoice_id',
      'issuer',
      'ledger_index',
      'source',
      'source_currency',
      'source_tag',
      'tx_hash',
      'transaction_cost',
    ]);
  });

  it('converts: the cost to whole units, the time to YYYY-MM-DDTHH:mm:ssZ, the balance changes back to arrays', () => {
    expect(toPaymentObject(STORED)).toMatchObject({
      transaction_cost: '0.000012',
      executed_time: '2015-01-14T17:29:10Z',
      source_balance_changes: [{ counterparty: 'rIssuer', currency: 'EUR', value: '-90' }],
      destination_balance_changes: [{ counterparty: 'rIssuer', currency: 'USD', value: '100' }],
      amount: '100.5',
      delivered_amount: '100',
    });
  });

  it('keeps a tag of 0 (R10) and leaves out the fields that are null or, for the issuer, empty', () => {
    expect(toPaymentObject(STORED)).toHaveProperty('source_tag', 0);
    const bare = toPaymentObject({
      ...STORED,
      issuer: '',
      max_amount: null,
      source_tag: null,
      destination_tag: null,
      invoice_id: null,
    });
    for (const absent of ['issuer', 'max_amount', 'source_tag', 'destination_tag', 'invoice_id']) {
      expect(bare).not.toHaveProperty(absent);
    }
    expect(Object.keys(bare)).toHaveLength(13);
  });

  it('writes a fee without exponent notation and a zero fee as 0', () => {
    expect(toPaymentObject({ ...STORED, fee: '10' }).transaction_cost).toBe('0.00001');
    expect(toPaymentObject({ ...STORED, fee: '1' }).transaction_cost).toBe('0.000001');
    expect(toPaymentObject({ ...STORED, fee: '0' }).transaction_cost).toBe('0');
    expect(toPaymentObject({ ...STORED, fee: '18446744073709551615' }).transaction_cost).toBe('18446744073709.551615');
  });

  it('reads only the columns it serves', () => {
    expect(PAYMENT_COLUMNS).not.toMatch(/\bclient\b|delivered_amount_f/);
    expect(PAYMENT_COLUMNS).toContain('toString(fee) AS fee');
    expect(PAYMENT_COLUMNS).toContain('toUnixTimestamp(close_time) AS close_time');
  });
});

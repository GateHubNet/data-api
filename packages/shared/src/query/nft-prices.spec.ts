import { saleKey } from './nft-prices';

describe('saleKey', () => {
  it('is the ledger, transaction and event index of a sale, joined by colons', () => {
    expect(saleKey({ ledger_index: 107701201, tx_index: 14, event_index: 2 })).toBe('107701201:14:2');
    expect(saleKey({ ledger_index: 1, tx_index: 0, event_index: 0 })).toBe('1:0:0');
  });

  it('reads the text of a number as the number: ClickHouse writes a UInt32 either way', () => {
    expect(saleKey({ ledger_index: '107701201', tx_index: '14', event_index: '2' })).toBe('107701201:14:2');
    expect(saleKey({ ledger_index: '000042', tx_index: 7, event_index: '03' })).toBe('42:7:3');
  });

  it('is the same for a sale and for the key asked for', () => {
    const row = { ledger_index: '5', tx_index: 1, event_index: '0' };
    expect(saleKey(row)).toBe(saleKey({ ledger_index: 5, tx_index: 1, event_index: 0 }));
  });
});

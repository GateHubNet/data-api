import { getTxCtid, parseCtid } from './ctid';

describe('ctid', () => {
  it('encodes ledger/tx/network into a 16-char CTID and round-trips', () => {
    const ctid = getTxCtid(1, 2, 0);
    expect(ctid).toBe('C000000100020000');
    expect(parseCtid(ctid)).toEqual({ ledgerIndex: 1, txIndex: 2, networkId: 0 });
  });

  it('matches the XLS-37d reference vector', () => {
    // ledger 0xFFFFFFF, tx 0xFFFF, network 0xFFFF
    expect(getTxCtid(0xfffffff, 0xffff, 0xffff)).toBe('CFFFFFFFFFFFFFFF');
  });

  it('throws on a missing tx index', () => {
    expect(() => getTxCtid(1, undefined as unknown as number, 0)).toThrow();
  });
});

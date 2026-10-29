import { isMptIssuanceId, mptAmountObject, mptIssuerOf } from './mpt';

/** The first 4 bytes are the sequence (298), then the issuer's AccountID: the vector of the plan's preflight (P5). */
const ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

describe('isMptIssuanceId', () => {
  it('is 48 hex digits in either case', () => {
    expect(isMptIssuanceId(ID)).toBe(true);
    expect(isMptIssuanceId(ID.toLowerCase())).toBe(true);
  });

  it('is nothing else', () => {
    for (const text of ['', '0000012A', ID + '0', ID.slice(1), ID.slice(0, -1) + 'G', ` ${ID}`, '0'.repeat(64)]) {
      expect(isMptIssuanceId(text)).toBe(false);
    }
  });
});

describe('mptIssuerOf', () => {
  it('reads the issuer from bytes 4 to 24 of the ID', () => {
    expect(mptIssuerOf(ID)).toBe(ISSUER);
    expect(mptIssuerOf(ID.toLowerCase())).toBe(ISSUER);
  });

  it('throws on a bad ID', () => {
    expect(() => mptIssuerOf('0000012A')).toThrow();
    expect(() => mptIssuerOf(ID + '00')).toThrow();
    expect(() => mptIssuerOf('Z'.repeat(48))).toThrow();
  });
});

describe('mptAmountObject', () => {
  it('is the currency and the issuance ID, the issuer read from the ID and the raw units', () => {
    expect(mptAmountObject(ID.toLowerCase(), '2500000')).toEqual({
      currency: ID,
      issuer: ISSUER,
      value: '2500000',
      mpt_issuance_id: ID,
    });
  });

  it('has its keys in this order', () => {
    expect(Object.keys(mptAmountObject(ID, '1'))).toEqual(['currency', 'issuer', 'value', 'mpt_issuance_id']);
  });

  it('throws on a bad ID', () => {
    expect(() => mptAmountObject('0000012A', '1')).toThrow();
  });
});

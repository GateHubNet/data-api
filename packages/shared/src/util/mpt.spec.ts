import { join } from 'path';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { decodeMptIssuanceId, isMptIssuanceId, mptAmountObject, mptIssuanceId, mptIssuerOf } from './mpt';

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

describe('mptIssuanceId', () => {
  it('is the big-endian sequence and then the AccountID, in upper case', () => {
    expect(mptIssuanceId(1, 'rrrrrrrrrrrrrrrrrrrrrhoLvTp')).toBe('00000001' + '0'.repeat(40));
    expect(mptIssuanceId(298, 'rrrrrrrrrrrrrrrrrrrrBZbvji')).toBe('0000012A' + '0'.repeat(38) + '01');
    expect(mptIssuanceId(298, ISSUER)).toBe(ID);
  });

  it('holds the largest sequence', () => {
    expect(mptIssuanceId(0xffffffff, 'rrrrrrrrrrrrrrrrrrrrrhoLvTp')).toBe('FFFFFFFF' + '0'.repeat(40));
  });

  it('throws on a sequence that is not a UInt32 and on an address that does not decode', () => {
    for (const sequence of [undefined, null, -1, 1.5, 2 ** 32, '1', Number.NaN]) {
      expect(() => mptIssuanceId(sequence as number, ISSUER)).toThrow();
    }
    for (const issuer of [undefined, '', 'not an address', ISSUER + 'x']) {
      expect(() => mptIssuanceId(1, issuer as string)).toThrow();
    }
  });

  it('builds the ID of every recorded issuance from the sequence of its node', () => {
    // A create sent with a ticket has `tx.Sequence` 0 and the ticket in the node (FINDINGS (2)), so the node is what counts.
    const fixtures = join(__dirname, '..', '..', 'test', 'fixtures');
    const seen: string[] = [];
    for (const dir of [join(fixtures, 'xrpl', 'mpt'), join(fixtures, 'xrpl-testnet', 'mpt')]) {
      for (const ledger of FixtureLedgerSource.fromDir(dir).list()) {
        for (const { tx, meta } of ledger.transactions) {
          if (tx.TransactionType !== 'MPTokenIssuanceCreate' || meta.TransactionResult !== 'tesSUCCESS') continue;
          const created = (meta.AffectedNodes as { CreatedNode?: Record<string, any> }[])
            .map((entry) => entry.CreatedNode)
            .find((node) => node?.LedgerEntryType === 'MPTokenIssuance');
          const id = mptIssuanceId(created?.NewFields.Sequence as number, tx.Account as string);
          expect(id).toBe(meta.mpt_issuance_id);
          seen.push(id);
        }
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });
});

describe('decodeMptIssuanceId', () => {
  it('reads the sequence and the issuer, in either case', () => {
    expect(decodeMptIssuanceId('0000012a' + '0'.repeat(38) + '01')).toEqual({
      sequence: 298,
      issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji',
    });
    expect(decodeMptIssuanceId('FFFFFFFF' + '0'.repeat(40)).sequence).toBe(0xffffffff);
  });

  it('agrees with mptIssuerOf and undoes mptIssuanceId', () => {
    expect(decodeMptIssuanceId(ID)).toEqual({ sequence: 298, issuer: mptIssuerOf(ID) });
    const { sequence, issuer } = decodeMptIssuanceId(ID);
    expect(mptIssuanceId(sequence, issuer)).toBe(ID);
  });

  it('throws on anything but 48 hex digits', () => {
    for (const bad of ['0'.repeat(47), '0'.repeat(49), '0x' + '0'.repeat(46), 'G'.repeat(48), '']) {
      expect(() => decodeMptIssuanceId(bad)).toThrow('invalid mpt issuance id');
    }
  });
});

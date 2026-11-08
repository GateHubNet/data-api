import { LowSideLine, orientations } from '../aggregate/token-rules';
import { generatedLowSideLine, LP_CURRENCY, seededRandom, stateRowsOf } from '../test-utils/token-history-cases';
import { issuedSideOf, mptSideOf, TokenSide } from './token-side';

const LOW = 'rLowAccountOfTheLine';
const HIGH = 'rHighAccountOfTheLine';

function line(o: Partial<LowSideLine> = {}): LowSideLine {
  return {
    account: LOW,
    counterparty: HIGH,
    currency: 'USD',
    balance: '0',
    limit: '0',
    limit_peer: '0',
    authorized: false,
    peer_authorized: true,
    freeze: true,
    peer_freeze: false,
    ledger_index: 123,
    deleted: false,
    ...o,
  };
}

/** The two sides of a line, the low account's token first (`issuedSideOf` of the low account's row). */
const sidesOf = (l: LowSideLine): [TokenSide | null, TokenSide | null] => {
  const [lowRow, highRow] = stateRowsOf(l);
  return [issuedSideOf(lowRow), issuedSideOf(highRow)];
};

describe('issuedSideOf', () => {
  it('agrees with orientations() on 5,000 generated lines', () => {
    const rnd = seededRandom(20261108);
    for (let i = 0; i < 5_000; i++) {
      const l = generatedLowSideLine(rnd);
      const [lowSide, highSide] = sidesOf(l);
      const entries = orientations(l);
      if (entries.length === 0) {
        expect({ i, lowSide, highSide }).toEqual({ i, lowSide: null, highSide: null });
        continue;
      }
      // orientations() gives the high account's token first, then the low account's
      const [ofHigh, ofLow] = entries;
      for (const [side, entry] of [
        [lowSide, ofLow],
        [highSide, ofHigh],
      ] as const) {
        expect(side).not.toBeNull();
        const got = side!;
        expect({ i, issuer: got.issuer, currency: got.currency, holder: got.holder }).toEqual({
          i,
          issuer: entry.token.issuer,
          currency: entry.token.currency,
          holder: entry.holder,
        });
        if (entry.wanted === null) {
          expect({ i, counted: got.counted, amount: got.amount }).toEqual({ i, counted: false, amount: '0' });
        } else {
          expect({
            i,
            counted: got.counted,
            amount: got.amount,
            limit: got.limit,
            frozen: got.frozen,
            authorized: got.authorized,
          }).toEqual({
            i,
            counted: true,
            amount: entry.wanted.balance,
            limit: entry.wanted.limit,
            frozen: entry.wanted.frozen === 1,
            authorized: entry.wanted.authorized === 1,
          });
        }
        expect(got.escrowed).toBe('0');
      }
    }
  });

  it('counts for both tokens when the balance is 0 and both limits are above 0', () => {
    const [lowSide, highSide] = sidesOf(line({ balance: '0', limit: '10', limit_peer: '20' }));
    expect(lowSide).toMatchObject({ issuer: LOW, holder: HIGH, counted: true, amount: '0', limit: '20' });
    expect(highSide).toMatchObject({ issuer: HIGH, holder: LOW, counted: true, amount: '0', limit: '10' });
  });

  it('a line that turns round leaves one token and joins the other', () => {
    const before = sidesOf(line({ balance: '-5', limit: '10', limit_peer: '20' }));
    const after = sidesOf(line({ balance: '5', limit: '10', limit_peer: '20' }));
    // -5: the low account owes the high one, so the low account issued and the high one holds 5
    expect(before[0]).toMatchObject({ issuer: LOW, holder: HIGH, counted: true, amount: '5' });
    expect(before[1]).toMatchObject({ issuer: HIGH, holder: LOW, counted: false, amount: '0' });
    // +5: the other way round
    expect(after[0]).toMatchObject({ issuer: LOW, holder: HIGH, counted: false, amount: '0' });
    expect(after[1]).toMatchObject({ issuer: HIGH, holder: LOW, counted: true, amount: '5' });
  });

  it('an LP currency has no side', () => {
    const [lowSide, highSide] = sidesOf(line({ currency: LP_CURRENCY, balance: '-5', limit_peer: '20' }));
    expect([lowSide, highSide]).toEqual([null, null]);
  });

  it('a deleted row does not count', () => {
    const [lowSide, highSide] = sidesOf(line({ balance: '0', limit: '10', limit_peer: '20', deleted: true }));
    expect(lowSide).toMatchObject({ counted: false, amount: '0' });
    expect(highSide).toMatchObject({ counted: false, amount: '0' });
  });

  it('takes the flags of the issuer side', () => {
    const [lowSide] = sidesOf(line({ balance: '-5', limit_peer: '20', freeze: true, authorized: false }));
    expect(lowSide).toMatchObject({ frozen: true, authorized: false });
  });
});

describe('mptSideOf', () => {
  const ID = '0000012AB5F762798A53D543A014CAF8B297CFF8F2F937E8';
  const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
  const row = (o: Partial<Parameters<typeof mptSideOf>[0]> = {}) => ({
    holder: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn',
    mpt_issuance_id: ID,
    amount: '9007199254740743',
    escrowed_amount: '250',
    flags: 0,
    deleted: 0,
    ...o,
  });

  it('the amount is amount plus escrowed', () => {
    expect(mptSideOf(row(), ISSUER)).toEqual({
      issuer: ISSUER,
      currency: ID,
      holder: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn',
      amount: '9007199254740993',
      counted: true,
      limit: '',
      frozen: false,
      authorized: false,
      escrowed: '250',
    });
    // past 2^63: the sum is exact in integers
    expect(mptSideOf(row({ amount: '9223372036854775807', escrowed_amount: '9223372036854775807' }), ISSUER).amount).toBe(
      '18446744073709551614',
    );
  });

  it('locked and authorized come from the flags', () => {
    expect(mptSideOf(row({ flags: 0x0001 }), ISSUER)).toMatchObject({ frozen: true, authorized: false });
    expect(mptSideOf(row({ flags: 0x0002 }), ISSUER)).toMatchObject({ frozen: false, authorized: true });
    expect(mptSideOf(row({ flags: 0x0003 }), ISSUER)).toMatchObject({ frozen: true, authorized: true });
  });

  it('a deleted MPToken does not count', () => {
    expect(mptSideOf(row({ deleted: 1 }), ISSUER)).toMatchObject({ counted: false, amount: '0', escrowed: '0' });
  });
});

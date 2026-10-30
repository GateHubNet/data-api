import { RippleHttpError } from '../common/errors';
import { parseTokenParam, tokenFileStem, tokenFileStemOfPath } from './token-param';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
/** The X-address of a classic address: not accepted as an issuer. */
const X_ADDRESS = 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ';

const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase().padEnd(40, '0');
const RLUSD = hexOf('RLUSD');
const USD_STANDARD = '0000000000000000000000005553440000000000';
const XRP_STANDARD = '0000000000000000000000005852500000000000';
const XAH_STANDARD = '0000000000000000000000005841480000000000';

/** Runs `fn` and returns the message of the 400 it must throw. */
function badRequestMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RippleHttpError);
    expect((e as RippleHttpError).getStatus()).toBe(400);
    return ((e as RippleHttpError).getResponse() as { message: string }).message;
  }
  throw new Error('expected the call to throw');
}

describe('parseTokenParam', () => {
  it.each<[string, string]>([
    [`USD.${ISSUER}`, 'USD'],
    [`usd+${ISSUER}`, 'USD'],
    [`USD|${ISSUER}`, 'USD'],
    // a ledger currency stored in lower case ('usd') is unreachable by path: a 3-character code is upper-cased
    [`usd.${ISSUER}`, 'USD'],
    [`RLUSD.${ISSUER}`, RLUSD],
    [`${RLUSD}.${ISSUER}`, RLUSD],
    [`${RLUSD.toLowerCase()}.${ISSUER}`, RLUSD],
    // the standard form of a 3-character code is that code
    [`${USD_STANDARD}.${ISSUER}`, 'USD'],
    // a text code of 4 to 20 characters is its 40 hex digits, a space included
    [`MY TOKEN.${ISSUER}`, hexOf('MY TOKEN')],
    // the last separator splits, so a text code may hold one; only a 3-character code is upper-cased (`a.b.c` is no `A.B.C`)
    [`a.b.c.${ISSUER}`, hexOf('a.b.c')],
    [`A.B.C.${ISSUER}`, hexOf('A.B.C')],
    [`a+b|c.${ISSUER}`, hexOf('a+b|c')],
    // an LP token's currency is a currency of the path; the route finds no such token
    [`03${'AB'.repeat(19)}.${ISSUER}`, `03${'AB'.repeat(19)}`],
  ])('%s is the currency %s', (raw, currency) => {
    expect(parseTokenParam(raw, 'XRP')).toEqual({ currency, issuer: ISSUER });
  });

  it('keeps `a.b.c` and `A.B.C` apart', () => {
    const lower = parseTokenParam(`a.b.c.${ISSUER}`, 'XRP').currency;
    const upper = parseTokenParam(`A.B.C.${ISSUER}`, 'XRP').currency;
    expect(lower).toBe('612E622E63' + '0'.repeat(30));
    expect(upper).toBe('412E422E43' + '0'.repeat(30));
  });

  it('the issuer is what follows the last separator, as written', () => {
    expect(parseTokenParam(`USD.${ISSUER}`, 'XRP').issuer).toBe(ISSUER);
  });

  describe('the native currency', () => {
    it('XRP with an issuer is 400 on the XRP Ledger, in any case and in the standard form of its hex', () => {
      for (const raw of [`XRP.${ISSUER}`, `xrp+${ISSUER}`, `${XRP_STANDARD}.${ISSUER}`]) {
        expect(badRequestMessage(() => parseTokenParam(raw, 'XRP'))).toBe('XRP cannot have an issuer');
      }
    });

    it('XAH with an issuer is 400 on Xahau, XRP is a token like any other there', () => {
      for (const raw of [`XAH.${ISSUER}`, `xah|${ISSUER}`, `${XAH_STANDARD}.${ISSUER}`]) {
        expect(badRequestMessage(() => parseTokenParam(raw, 'XAH'))).toBe('XAH cannot have an issuer');
      }
      expect(parseTokenParam(`XRP.${ISSUER}`, 'XAH')).toEqual({ currency: 'XRP', issuer: ISSUER });
      expect(parseTokenParam(`${XRP_STANDARD}.${ISSUER}`, 'XAH')).toEqual({ currency: 'XRP', issuer: ISSUER });
    });

    it('XAH is a token on the XRP Ledger', () => {
      expect(parseTokenParam(`XAH.${ISSUER}`, 'XRP')).toEqual({ currency: 'XAH', issuer: ISSUER });
    });

    it('the native code with no issuer at all is no token: the issuer is what is missing', () => {
      expect(badRequestMessage(() => parseTokenParam('XRP', 'XRP'))).toBe('invalid issuer address');
    });
  });

  describe('errors, in order', () => {
    it.each([
      // 2 characters, 1 character, nothing
      [`$$.${ISSUER}`],
      [`U.${ISSUER}`],
      [`.${ISSUER}`],
      [''],
      // 3 characters outside rippled's set are no currency (the ledger prints them as hex)
      [`A-B.${ISSUER}`],
      [`"'+.${ISSUER}`],
      // the all-zero hex, a hex of 39 digits, 21 characters of text
      [`${'0'.repeat(40)}.${ISSUER}`],
      [`${'A'.repeat(39)}.${ISSUER}`],
      [`${'A'.repeat(21)}.${ISSUER}`],
      // a control character in a text code
      [`AB\tCD.${ISSUER}`],
    ])('%j is 400 `invalid currency`', (raw) => {
      expect(badRequestMessage(() => parseTokenParam(raw, 'XRP'))).toBe('invalid currency');
    });

    it.each([['USD.xyz'], ['USD'], ['USD.'], [`USD.${ISSUER}x`], [`USD.${X_ADDRESS}`], [`RLUSD.${X_ADDRESS}`]])(
      '%j is 400 `invalid issuer address`',
      (raw) => {
        expect(badRequestMessage(() => parseTokenParam(raw, 'XRP'))).toBe('invalid issuer address');
      },
    );

    it('checks the currency before the native code, and the native code before the issuer', () => {
      expect(badRequestMessage(() => parseTokenParam('$$.xyz', 'XRP'))).toBe('invalid currency');
      expect(badRequestMessage(() => parseTokenParam('XRP.xyz', 'XRP'))).toBe('XRP cannot have an issuer');
      expect(badRequestMessage(() => parseTokenParam('XAH.xyz', 'XAH'))).toBe('XAH cannot have an issuer');
      expect(badRequestMessage(() => parseTokenParam('USD.xyz', 'XAH'))).toBe('invalid issuer address');
    });
  });
});

describe('tokenFileStem', () => {
  it('is the code and the issuer, the stem of the CSV names', () => {
    expect(tokenFileStem({ currency: RLUSD, issuer: ISSUER })).toBe(`RLUSD ${ISSUER}`);
    expect(tokenFileStem({ currency: 'USD', issuer: ISSUER })).toBe(`USD ${ISSUER}`);
    expect(tokenFileStem({ currency: hexOf('MY TOKEN'), issuer: ISSUER })).toBe(`MY TOKEN ${ISSUER}`);
  });

  it('is the 40 hex digits for a currency with no code', () => {
    const noText = `FF${'00'.repeat(18)}01`;
    expect(tokenFileStem({ currency: noText, issuer: ISSUER })).toBe(`${noText} ${ISSUER}`);
    const lp = `03${'AB'.repeat(19)}`;
    expect(tokenFileStem({ currency: lp, issuer: ISSUER })).toBe(`${lp} ${ISSUER}`);
  });
});

describe('tokenFileStemOfPath', () => {
  it('is the stem of the token the path names, whatever the spelling of it', () => {
    const hex = hexOf('RLUSD');
    for (const raw of [
      `RLUSD.${ISSUER}`,
      `RLUSD+${ISSUER}`,
      `RLUSD|${ISSUER}`,
      `${hex}.${ISSUER}`,
      `${hex.toLowerCase()}+${ISSUER}`,
    ]) {
      expect([raw, tokenFileStemOfPath(raw)]).toEqual([raw, `RLUSD ${ISSUER}`]);
    }
    expect(tokenFileStemOfPath(`usd.${ISSUER}`)).toBe(`USD ${ISSUER}`);
    expect(tokenFileStemOfPath(`${USD_STANDARD}.${ISSUER}`)).toBe(`USD ${ISSUER}`);
    // a text code that holds a separator: the last one splits
    expect(tokenFileStemOfPath(`A.B C.${ISSUER}`)).toBe(`A.B C ${ISSUER}`);
  });

  it('is the 40 hex digits of a currency with no code', () => {
    const noText = `FF${'00'.repeat(18)}01`;
    expect(tokenFileStemOfPath(`${noText.toLowerCase()}.${ISSUER}`)).toBe(`${noText} ${ISSUER}`);
  });
});

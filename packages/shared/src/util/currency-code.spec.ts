import { currencyCode, isLpCurrency, ledgerCurrencyOf } from './currency-code';

const ZEROS = (n: number): string => '0'.repeat(n);
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase().padEnd(40, '0');

describe('currencyCode', () => {
  it('gives a 3-character currency as it is', () => {
    expect(currencyCode('USD')).toBe('USD');
    expect(currencyCode('usd')).toBe('usd');
  });

  it('gives the text of a hex currency: bytes 0 to 19, trailing zeros dropped, printable ASCII', () => {
    expect(currencyCode('524C555344000000000000000000000000000000')).toBe('RLUSD');
    expect(currencyCode('524c555344000000000000000000000000000000')).toBe('RLUSD');
    expect(currencyCode('4D5920544F4B454E000000000000000000000000')).toBe('MY TOKEN');
    expect(currencyCode(hexOf('a.b.c'))).toBe('a.b.c');
    expect(currencyCode(hexOf('x'.repeat(20)))).toBe('x'.repeat(20));
  });

  it('gives the standard code a hex currency holds (bytes 12 to 14, the rest zero)', () => {
    expect(currencyCode('0000000000000000000000005553440000000000')).toBe('USD');
    expect(currencyCode('0000000000000000000000005553440000000000'.toLowerCase())).toBe('USD');
  });

  it('gives nothing for a hex currency that is no text', () => {
    // the XAU-demurrage form: first byte 0x01
    expect(currencyCode('0158415500000000C1F76FF6ECB0BAC600000000')).toBeUndefined();
    // an LP token's: first byte 0x03
    expect(currencyCode('03A1F7' + ZEROS(34))).toBeUndefined();
    // all zero
    expect(currencyCode(ZEROS(40))).toBeUndefined();
    // a zero byte inside the text
    expect(currencyCode('4100420000000000000000000000000000000000')).toBeUndefined();
    // a byte above 0x7E
    expect(currencyCode('41FF000000000000000000000000000000000000')).toBeUndefined();
    // the standard form with a character outside 0x21-0x7E: not a code, and not text either (it starts with zero bytes)
    expect(currencyCode('0000000000000000000000005520440000000000')).toBeUndefined();
  });

  it('gives nothing for a currency that is neither 3 characters nor 40 hex digits', () => {
    expect([currencyCode(''), currencyCode('RLUSD'), currencyCode(ZEROS(39)), currencyCode(ZEROS(41))]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(currencyCode('G'.repeat(40))).toBeUndefined();
  });
});

describe('ledgerCurrencyOf', () => {
  it('turns the codes of a client or a toml into the ledger form (C5: only 3 characters are upper-cased)', () => {
    expect([
      ledgerCurrencyOf('usd'),
      ledgerCurrencyOf('RLUSD'),
      ledgerCurrencyOf('524c555344000000000000000000000000000000'),
      ledgerCurrencyOf('0000000000000000000000005553440000000000'),
      ledgerCurrencyOf('a.b.c'),
      ledgerCurrencyOf('ab'),
      ledgerCurrencyOf('x'.repeat(21)),
      ledgerCurrencyOf('0'.repeat(40)),
    ]).toEqual([
      'USD',
      '524C555344000000000000000000000000000000',
      '524C555344000000000000000000000000000000',
      'USD',
      '612E622E63' + ZEROS(30),
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps a text of 5 or more characters as it is, so a.b.c and A.B.C are two currencies', () => {
    expect(ledgerCurrencyOf('A.B.C')).toBe('412E422E43' + ZEROS(30));
    expect(ledgerCurrencyOf('A.B.C')).not.toBe(ledgerCurrencyOf('a.b.c'));
    expect(currencyCode(ledgerCurrencyOf('a.b.c') as string)).toBe('a.b.c');
    expect(currencyCode(ledgerCurrencyOf('A.B.C') as string)).toBe('A.B.C');
  });

  it('takes a 3-character code of 0x21 to 0x7E and a text of 4 to 20 characters of 0x20 to 0x7E, nothing else', () => {
    expect(ledgerCurrencyOf('$&!')).toBe('$&!');
    expect(ledgerCurrencyOf('U D')).toBeUndefined();
    expect(ledgerCurrencyOf('MY T')).toBe('4D592054' + ZEROS(32));
    expect(ledgerCurrencyOf('x'.repeat(20))).toBe('78'.repeat(20));
    expect(ledgerCurrencyOf('é12')).toBeUndefined();
    expect(ledgerCurrencyOf('tést')).toBeUndefined();
    expect(ledgerCurrencyOf('')).toBeUndefined();
    expect(ledgerCurrencyOf('ab\u0000c')).toBeUndefined();
  });

  it('takes 40 hex digits in either case, and gives a standard form hex as its 3 characters, upper-cased', () => {
    expect(ledgerCurrencyOf('4e50555344000000000000000000000000000000')).toBe(
      '4E50555344000000000000000000000000000000',
    );
    // the standard form of "usd" is the 3 characters upper-cased, as a client's 3-character code is
    expect(ledgerCurrencyOf('0000000000000000000000007573640000000000')).toBe('USD');
    // the form of an LP token or of a demurrage currency is a hex like any other
    expect(ledgerCurrencyOf('03A1F7' + ZEROS(34))).toBe('03A1F7' + ZEROS(34));
    expect(ledgerCurrencyOf('0158415500000000C1F76FF6ECB0BAC600000000')).toBe(
      '0158415500000000C1F76FF6ECB0BAC600000000',
    );
  });

  it('gives nothing for a 40-character text that is no hex, nor for 39 or 41 hex digits', () => {
    expect([
      ledgerCurrencyOf('G'.repeat(40)),
      ledgerCurrencyOf('A'.repeat(39)),
      ledgerCurrencyOf('A'.repeat(41)),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('is the reverse of currencyCode for a code that reads as text', () => {
    for (const code of ['USD', 'RLUSD', 'MY TOKEN', 'a.b.c', 'A.B.C', 'x'.repeat(20)]) {
      expect(currencyCode(ledgerCurrencyOf(code) as string)).toBe(code);
    }
  });
});

describe('isLpCurrency', () => {
  it('is true for 40 upper-case hex digits that start with 03', () => {
    expect([isLpCurrency('03A1F7' + ZEROS(34)), isLpCurrency('USD')]).toEqual([true, false]);
    expect(isLpCurrency('03a1f7' + ZEROS(34))).toBe(false);
    expect(isLpCurrency('04A1F7' + ZEROS(34))).toBe(false);
    expect(isLpCurrency('03A1F7' + ZEROS(33))).toBe(false);
    expect(isLpCurrency('03A1F7' + ZEROS(35))).toBe(false);
  });
});

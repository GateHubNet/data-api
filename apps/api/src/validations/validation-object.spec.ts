import { parseLedgerHash, StoredValidation, toValidation } from './validation-object';

const HASH = '9373383605D0994AF33ACECA206693B331BA61C3CDA511AF3E7DD569593E126C';

/** A full validation as the aggregate read of `validations` returns it. */
const stored = (overrides: Partial<StoredValidation> = {}): StoredValidation => ({
  count: 13,
  first_ms: Date.parse('2019-03-26T16:45:20.466Z'),
  last_ms: Date.parse('2019-03-26T16:45:20.549Z'),
  amendments: '["42426C4D4F1009EE67080A9B7965B44656D7714D104A72F9B4369F97ABF044EE"]',
  base_fee: '10',
  ephemeral_public_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
  flags: 2147483649,
  full: 1,
  ledger_hash: HASH,
  ledger_index: 46087342,
  load_fee: '256000',
  reporter_public_key: 'n9KJb7NMxGySRcjCqh69xEPMUhwJx22qntYYXsnUqYgjsJhNoW7g',
  reserve_base: '10000000',
  reserve_inc: '2000000',
  signature: '3045022100E4634BA5',
  signing_time: 606933920,
  validation_public_key: 'nHUkhmyFPr3vEN3C8yfhKp4pu4t3wkTCi2KEDBWhyMNpsMj2HbnD',
  ...overrides,
});

describe('toValidation()', () => {
  it('R73: the keys are the columns of the HBase row, sorted by name (family d), in that order', () => {
    expect(Object.keys(toValidation(stored()))).toEqual([
      'amendments',
      'base_fee',
      'count',
      'ephemeral_public_key',
      'first_datetime',
      'flags',
      'full',
      'last_datetime',
      'ledger_hash',
      'ledger_index',
      'load_fee',
      'reporter_public_key',
      'reserve_base',
      'reserve_inc',
      'signature',
      'signing_time',
      'validation_public_key',
    ]);
  });

  it('serves the values as the HBase row did: text, except count, which is a number', () => {
    expect(toValidation(stored())).toEqual({
      amendments: '["42426C4D4F1009EE67080A9B7965B44656D7714D104A72F9B4369F97ABF044EE"]',
      base_fee: '10',
      count: 13,
      ephemeral_public_key: 'n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy',
      first_datetime: '2019-03-26T16:45:20.466Z',
      flags: '2147483649',
      full: 'true',
      last_datetime: '2019-03-26T16:45:20.549Z',
      ledger_hash: HASH,
      ledger_index: '46087342',
      load_fee: '256000',
      reporter_public_key: 'n9KJb7NMxGySRcjCqh69xEPMUhwJx22qntYYXsnUqYgjsJhNoW7g',
      reserve_base: '10000000',
      reserve_inc: '2000000',
      signature: '3045022100E4634BA5',
      signing_time: '606933920',
      validation_public_key: 'nHUkhmyFPr3vEN3C8yfhKp4pu4t3wkTCi2KEDBWhyMNpsMj2HbnD',
    });
  });

  it('writes the datetimes with milliseconds and a Z, whatever the milliseconds are', () => {
    const v = toValidation(
      stored({ first_ms: Date.parse('2019-03-26T16:45:20.000Z'), last_ms: Date.parse('2019-03-26T16:45:20.009Z') }),
    );
    expect(v.first_datetime).toBe('2019-03-26T16:45:20.000Z');
    expect(v.last_datetime).toBe('2019-03-26T16:45:20.009Z');
  });

  it('reads numbers that ClickHouse sends as text (UInt64 counts, Int64 times) as numbers', () => {
    const v = toValidation(
      stored({
        count: '57',
        first_ms: '1553618720466',
        last_ms: '1553618720549',
        flags: '2147483649',
        ledger_index: '46087342',
      }),
    );
    expect(v.count).toBe(57);
    expect(v.first_datetime).toBe('2019-03-26T16:45:20.466Z');
    expect(v.flags).toBe('2147483649');
  });

  it('leaves out what HBase did not store: empty text, NULL fees, a partial validation (full 0)', () => {
    const v = toValidation(
      stored({
        amendments: '',
        base_fee: null,
        load_fee: null,
        reserve_base: null,
        reserve_inc: null,
        full: 0,
        ephemeral_public_key: '',
        reporter_public_key: '',
      }),
    );
    expect(Object.keys(v)).toEqual([
      'count',
      'first_datetime',
      'flags',
      'last_datetime',
      'ledger_hash',
      'ledger_index',
      'signature',
      'signing_time',
      'validation_public_key',
    ]);
  });

  it('keeps a fee of 0 (the original dropped empty values but kept 0)', () => {
    const v = toValidation(stored({ base_fee: '0', reserve_inc: '0' }));
    expect(v.base_fee).toBe('0');
    expect(v.reserve_inc).toBe('0');
  });

  it('keeps flags 0, ledger_index 0 and signing_time 0 as "0"', () => {
    const v = toValidation(stored({ flags: 0, ledger_index: 0, signing_time: 0 }));
    expect([v.flags, v.ledger_index, v.signing_time]).toEqual(['0', '0', '0']);
  });

  it('keeps a fee above 2^53 exactly', () => {
    expect(toValidation(stored({ base_fee: '18446744073709551615' })).base_fee).toBe('18446744073709551615');
  });
});

describe('parseLedgerHash()', () => {
  it('upper-cases a hash', () => {
    expect(parseLedgerHash(HASH.toLowerCase())).toBe(HASH);
    expect(parseLedgerHash(HASH)).toBe(HASH);
  });

  it('strips a leading 0x (the original upper-cased it to 0X..., which never matched anything)', () => {
    expect(parseLedgerHash(`0x${HASH.toLowerCase()}`)).toBe(HASH);
    expect(parseLedgerHash(`0x${HASH}`)).toBe(HASH);
  });

  it('accepts any even-length hex text (the original did; the length is not 64 only)', () => {
    expect(parseLedgerHash('abcd')).toBe('ABCD');
    expect(parseLedgerHash('0xab')).toBe('AB');
  });

  it('answers 400 invalid ledger hash for odd length, non-hex text, a bare 0x, 0X, and nothing', () => {
    for (const bad of ['abc', '0xabc', 'zzz', '0x', '0X1234', 'ab cd', 'ab-cd', '', '0xzz', `${HASH}g`, 'ab\n']) {
      expect(() => parseLedgerHash(bad)).toThrow(expect.objectContaining({ status: 400 }));
      try {
        parseLedgerHash(bad);
      } catch (err) {
        expect((err as { getResponse(): unknown }).getResponse()).toEqual({
          result: 'error',
          message: 'invalid ledger hash',
        });
      }
    }
  });
});

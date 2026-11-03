import type { TokenLinesRow } from '../clickhouse/rows';
import { getNetworkProfile } from '../network/network-profile';
import type { TomlCurrency } from '../tomls/toml-read';
import {
  countsFor,
  LowSideLine,
  orientations,
  sameTokenLine,
  servedTomlFields,
  TOKEN_TOML_KEYS,
  tokenListing,
  WantedTokenLine,
} from './token-rules';

const LOW = 'rLowAccountOfTheLine';
const HIGH = 'rHighAccountOfTheLine';

/** A line read from the low account's side. The four flags differ, so that a mix-up of two of them shows. */
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

describe('orientations', () => {
  /** The wanted row of a token: `holder` holds `balance` and has the limit `limit`; the flags are the issuer side's. */
  const wanted = (
    holder: string,
    balance: string,
    limit: string,
    frozen: 0 | 1,
    authorized: 0 | 1,
  ): WantedTokenLine => ({ holder, balance, limit, frozen, authorized, ledger_index: 123 });

  // The high account's token: holder LOW, balance as stored, limit `limit`, flags peer_freeze (0) and peer_authorized (1).
  // The low account's token: holder HIGH, balance negated, limit `limit_peer`, flags freeze (1) and authorized (0).
  const TABLE: [string, Partial<LowSideLine>, WantedTokenLine | null, WantedTokenLine | null][] = [
    [
      'the low account owes the high one (-5): the low account issued, the high one holds 5',
      { balance: '-5', limit: '10', limit_peer: '20' },
      null,
      wanted(HIGH, '5', '20', 1, 0),
    ],
    [
      'the high account owes the low one (+5): the high account issued, the low one holds 5',
      { balance: '5', limit: '10', limit_peer: '20' },
      wanted(LOW, '5', '10', 0, 1),
      null,
    ],
    [
      'a balance of 0 with both limits above 0: both tokens count, at 0',
      { balance: '0', limit: '10', limit_peer: '20' },
      wanted(LOW, '0', '10', 0, 1),
      wanted(HIGH, '0', '20', 1, 0),
    ],
    [
      'a balance of 0 and only the high limit above 0: only the low account issued',
      { balance: '0', limit: '0', limit_peer: '20' },
      null,
      wanted(HIGH, '0', '20', 1, 0),
    ],
    [
      'a balance of 0 and only the low limit above 0: only the high account issued',
      { balance: '0', limit: '10', limit_peer: '0' },
      wanted(LOW, '0', '10', 0, 1),
      null,
    ],
    ['a balance of 0 with no limit: neither token counts', { balance: '0', limit: '0', limit_peer: '0' }, null, null],
    [
      'a balance owed with no limit still counts (the limit only decides at 0)',
      { balance: '-5', limit: '0', limit_peer: '0' },
      null,
      wanted(HIGH, '5', '0', 1, 0),
    ],
    [
      'a deleted line counts for neither token, whatever it held',
      { balance: '5', limit: '10', limit_peer: '20', deleted: true },
      null,
      null,
    ],
    [
      'a deleted line with a balance owed counts for neither token',
      { balance: '-5', limit: '10', limit_peer: '20', deleted: true },
      null,
      null,
    ],
    [
      'a small balance is plain text, never an exponent',
      { balance: '-0.0000001', limit: '1000000000', limit_peer: '0.0000001' },
      null,
      wanted(HIGH, '0.0000001', '0.0000001', 1, 0),
    ],
    [
      'a large balance keeps every digit',
      { balance: '123456789012345.6789', limit: '1000000000000000000000000000000', limit_peer: '0' },
      wanted(LOW, '123456789012345.6789', '1000000000000000000000000000000', 0, 1),
      null,
    ],
  ];

  it.each(TABLE)('every sign and limit combination: %s', (_name, overrides, high, low) => {
    expect(orientations(line(overrides))).toEqual([
      { token: { issuer: HIGH, currency: 'USD' }, holder: LOW, wanted: high },
      { token: { issuer: LOW, currency: 'USD' }, holder: HIGH, wanted: low },
    ]);
  });

  it('the flags of the issuer side: the high account issues with peer_freeze and peer_authorized, the low with freeze and authorized', () => {
    const both = { balance: '0', limit: '1', limit_peer: '1' };
    const flags = (freeze: boolean, authorized: boolean, peerFreeze: boolean, peerAuthorized: boolean) =>
      orientations(line({ ...both, freeze, authorized, peer_freeze: peerFreeze, peer_authorized: peerAuthorized })).map(
        (o) => [o.wanted?.frozen, o.wanted?.authorized],
      );
    // [the high account's token, the low account's token]
    expect(flags(false, false, false, false)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(flags(true, true, true, true)).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(flags(true, false, false, false)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(flags(false, true, false, false)).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(flags(false, false, true, false)).toEqual([
      [1, 0],
      [0, 0],
    ]);
    expect(flags(false, false, false, true)).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });

  it('gives the holder of each token also when the line does not count for it', () => {
    expect(orientations(line({ balance: '5', limit: '10' })).map((o) => [o.token.issuer, o.holder])).toEqual([
      [HIGH, LOW],
      [LOW, HIGH],
    ]);
  });

  it('gives a hex currency as it is and the ledger index of the line', () => {
    const currency = '524C555344000000000000000000000000000000';
    const [high] = orientations(line({ currency, balance: '1', ledger_index: 99 }));
    expect(high.token).toEqual({ issuer: HIGH, currency });
    expect(high.wanted?.ledger_index).toBe(99);
  });

  it('gives no orientation for an LP currency', () => {
    expect(orientations(line({ currency: '03A1F7' + '0'.repeat(34), balance: '-5', limit: '10' }))).toEqual([]);
    // a deleted line of an LP currency as well
    expect(orientations(line({ currency: '03A1F7' + '0'.repeat(34), deleted: true }))).toEqual([]);
  });

  it('never gives -0: a balance of 0 stays 0', () => {
    const [, low] = orientations(line({ balance: '0', limit: '1', limit_peer: '1' }));
    expect(low.wanted?.balance).toBe('0');
    expect(Object.is(Number(low.wanted?.balance), 0)).toBe(true);
  });
});

describe('countsFor', () => {
  it('holds, or zero with a limit above 0', () => {
    expect(countsFor('-1', '0')).toBe(true);
    expect(countsFor('0', '1')).toBe(true);
    expect(countsFor('0', '0')).toBe(false);
    expect(countsFor('1', '1000')).toBe(false);
  });

  it('compares numbers, not text', () => {
    expect(countsFor('-0.0000001', '0')).toBe(true);
    expect(countsFor('0.0', '0.0000001')).toBe(true);
    expect(countsFor('-0', '0')).toBe(false);
    expect(countsFor('-0', '5')).toBe(true);
  });
});

describe('sameTokenLine', () => {
  const stored: Pick<TokenLinesRow, 'balance' | 'limit' | 'frozen' | 'authorized' | 'ledger_index'> = {
    balance: '5',
    limit: '10',
    frozen: 1,
    authorized: 0,
    ledger_index: 123,
  };
  const wanted: WantedTokenLine = {
    holder: LOW,
    balance: '5',
    limit: '10',
    frozen: 1,
    authorized: 0,
    ledger_index: 123,
  };

  it('compares the five fields', () => {
    expect(sameTokenLine(stored, wanted)).toBe(true);
    expect(sameTokenLine({ ...stored, balance: '6' }, wanted)).toBe(false);
    expect(sameTokenLine({ ...stored, limit: '11' }, wanted)).toBe(false);
    expect(sameTokenLine({ ...stored, frozen: 0 }, wanted)).toBe(false);
    expect(sameTokenLine({ ...stored, authorized: 1 }, wanted)).toBe(false);
    expect(sameTokenLine({ ...stored, ledger_index: 124 }, wanted)).toBe(false);
  });

  it('is as exact as the text: the holder is not a field of a stored row', () => {
    expect(sameTokenLine(stored, { ...wanted, holder: HIGH })).toBe(true);
    expect(sameTokenLine({ ...stored, balance: '5.5' }, { ...wanted, balance: '5.50' })).toBe(false);
  });
});

describe('servedTomlFields', () => {
  it("keeps the served keys in order and D4's types (C22: an empty text is kept)", () => {
    const served = servedTomlFields(
      '{"desc":"d","name":"N","display_decimals":2,"extra":"x","icon":7,"asset_class":""}',
    );
    expect(served).toEqual({ name: 'N', desc: 'd', display_decimals: 2, asset_class: '' });
    expect(Object.keys(served)).toEqual(['name', 'desc', 'display_decimals', 'asset_class']);
  });

  it('serves every key of TOKEN_TOML_KEYS, in that order', () => {
    expect(TOKEN_TOML_KEYS).toEqual([
      'name',
      'desc',
      'icon',
      'symbol',
      'display_decimals',
      'asset_class',
      'asset_subclass',
      'attestation',
    ]);
    const all = Object.fromEntries([...TOKEN_TOML_KEYS].reverse().map((k) => [k, k === 'display_decimals' ? 8 : k]));
    expect(Object.keys(servedTomlFields(JSON.stringify(all)))).toEqual([...TOKEN_TOML_KEYS]);
  });

  it('keeps display_decimals only as a whole number from 0 to 30', () => {
    const decimals = (v: unknown) => servedTomlFields(JSON.stringify({ display_decimals: v }));
    expect([decimals(0), decimals(30), decimals(2.0)]).toEqual([
      { display_decimals: 0 },
      { display_decimals: 30 },
      { display_decimals: 2 },
    ]);
    expect([decimals(31), decimals(-1), decimals(2.5), decimals('2'), decimals(true), decimals(null)]).toEqual([
      {},
      {},
      {},
      {},
      {},
      {},
    ]);
  });

  it('drops a text key that holds a number, a boolean, a list or an object', () => {
    expect(servedTomlFields('{"name":1,"desc":true,"icon":["a"],"symbol":{"a":"b"},"attestation":null}')).toEqual({});
  });

  it('gives nothing for JSON that is not an object, or is not JSON', () => {
    expect(['not json', '', '[1]', 'null', '"name"', '7', '{"name":'].map(servedTomlFields)).toEqual(
      Array.from({ length: 7 }, () => ({})),
    );
  });

  it('reads a key of the object itself, never of a prototype', () => {
    expect(servedTomlFields('{"__proto__":{"name":"x"},"constructor":"y"}')).toEqual({});
  });
});

describe('tokenListing', () => {
  const xrpl = getNetworkProfile('xrpl');
  const xahau = getNetworkProfile('xahau');
  const ISSUER = 'rIssuerOfTheToken';
  const RLUSD = '524C555344000000000000000000000000000000';
  const entry = (o: Partial<TomlCurrency> = {}): TomlCurrency => ({
    code: 'RLUSD',
    issuer: ISSUER,
    network: '',
    fields: '{"name":"Ripple USD","display_decimals":2}',
    ...o,
  });
  const listed = (name: string, toml: Record<string, unknown>) => ({
    domain: 'example.com',
    listed: 1,
    name,
    toml: JSON.stringify(toml),
  });
  const NOT_LISTED = { domain: 'example.com', listed: 0, name: '', toml: '' };

  it.each([
    ['RLUSD', RLUSD, 'RLUSD'],
    ['its hex in upper case', RLUSD, RLUSD],
    ['its hex in lower case', RLUSD, RLUSD.toLowerCase()],
    ['usd', 'USD', 'usd'],
    ['USD', 'USD', 'USD'],
    ['the hex of USD', 'USD', '0000000000000000000000005553440000000000'],
    ['the lower-case hex of USD', 'USD', '0000000000000000000000005553440000000000'.toLowerCase()],
    ['a text with dots', '612E622E63' + '0'.repeat(30), 'a.b.c'],
  ])('tokenListing matches every code form (%s)', (_name, currency, code) => {
    const result = tokenListing({ issuer: ISSUER, currency }, 'example.com', [entry({ code })], xrpl);
    expect(result.listed).toBe(1);
  });

  it('upper-cases a 3-character code only: rlusd and a.b.c are other currencies than RLUSD and A.B.C', () => {
    expect(tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry({ code: 'rlusd' })], xrpl)).toEqual(
      NOT_LISTED,
    );
    expect(
      tokenListing(
        { issuer: ISSUER, currency: '412E422E43' + '0'.repeat(30) },
        'example.com',
        [entry({ code: 'a.b.c' })],
        xrpl,
      ),
    ).toEqual(NOT_LISTED);
  });

  it('serves the name and the served fields of the matched entry', () => {
    expect(tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry()], xrpl)).toEqual(
      listed('Ripple USD', { name: 'Ripple USD', display_decimals: 2 }),
    );
  });

  it('is listed with the name "" and an empty object when the entry has no name or no served field', () => {
    expect(tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry({ fields: '{}' })], xrpl)).toEqual(
      listed('', {}),
    );
    expect(
      tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry({ fields: '{"name":5,"x":"y"}' })], xrpl),
    ).toEqual(listed('', {}));
    expect(
      tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry({ fields: 'not json' })], xrpl),
    ).toEqual(listed('', {}));
    expect(
      tokenListing({ issuer: ISSUER, currency: RLUSD }, 'example.com', [entry({ fields: '{"name":""}' })], xrpl),
    ).toEqual(listed('', { name: '' }));
  });

  it("is two-way: the entry names the token's issuer, and its code the token's currency", () => {
    const token = { issuer: ISSUER, currency: RLUSD };
    expect(tokenListing(token, 'example.com', [entry({ issuer: 'rAnotherIssuer' })], xrpl)).toEqual(NOT_LISTED);
    expect(tokenListing(token, 'example.com', [entry({ code: 'EURO' })], xrpl)).toEqual(NOT_LISTED);
    // an issuer stored as '' (the toml named none, or no valid address) never matches, not even a token with no issuer
    expect(tokenListing(token, 'example.com', [entry({ issuer: '' })], xrpl)).toEqual(NOT_LISTED);
    expect(tokenListing({ issuer: '', currency: RLUSD }, 'example.com', [entry({ issuer: '' })], xrpl)).toEqual(
      NOT_LISTED,
    );
  });

  it('matches a code that is no code of the ledger to nothing', () => {
    const token = { issuer: ISSUER, currency: RLUSD };
    expect(tokenListing(token, 'example.com', [entry({ code: 'ab' }), entry({ code: '' })], xrpl)).toEqual(NOT_LISTED);
    expect(
      tokenListing(
        { issuer: ISSUER, currency: '0'.repeat(40) },
        'example.com',
        [entry({ code: '0'.repeat(40) })],
        xrpl,
      ),
    ).toEqual(NOT_LISTED);
  });

  it('counts the entries of this network only (countsOn)', () => {
    const token = { issuer: ISSUER, currency: RLUSD };
    const on = (network: string, profile = xrpl) =>
      tokenListing(token, 'example.com', [entry({ network })], profile).listed;
    expect([on('testnet'), on(''), on('mainnet'), on('main'), on('21337')]).toEqual([0, 1, 1, 1, 0]);
    expect([on('testnet', xahau), on('', xahau), on('mainnet', xahau), on('21337', xahau)]).toEqual([0, 1, 1, 1]);
  });

  it('takes the first matching entry in file order', () => {
    const token = { issuer: ISSUER, currency: RLUSD };
    const entries = [
      entry({ issuer: 'rAnotherIssuer', fields: '{"name":"other issuer"}' }),
      entry({ network: 'testnet', fields: '{"name":"test network"}' }),
      entry({ code: RLUSD.toLowerCase(), fields: '{"name":"first"}' }),
      entry({ fields: '{"name":"second"}' }),
    ];
    expect(tokenListing(token, 'example.com', entries, xrpl)).toEqual(listed('first', { name: 'first' }));
    expect(tokenListing(token, 'example.com', entries.slice(3), xrpl)).toEqual(listed('second', { name: 'second' }));
  });

  it('does not list a toml without entries or one that was not read (a failed toml), and keeps the domain', () => {
    const token = { issuer: ISSUER, currency: RLUSD };
    expect(tokenListing(token, 'example.com', undefined, xrpl)).toEqual(NOT_LISTED);
    expect(tokenListing(token, 'example.com', [], xrpl)).toEqual(NOT_LISTED);
    expect(tokenListing(token, '', undefined, xrpl)).toEqual({ domain: '', listed: 0, name: '', toml: '' });
  });

  it('brings both sides to the ledger form: a ledger token written in lower case matches the toml code in upper case', () => {
    expect(
      tokenListing({ issuer: ISSUER, currency: 'usd' }, 'example.com', [entry({ code: 'USD' })], xrpl).listed,
    ).toBe(1);
  });
});

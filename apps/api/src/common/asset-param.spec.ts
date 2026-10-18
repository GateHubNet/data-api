import { Asset } from '@gatehub/data-api-shared';
import { assetFromParts, parseAsset, parseAssetFilter, parseAssetPair, splitAsset } from './asset-param';
import { RippleHttpError } from './errors';

const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const GATEHUB = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
/** The X-address of a classic address: not accepted as an issuer. */
const X_ADDRESS = 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ';

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

describe('splitAsset', () => {
  it.each<[string, { currency?: string; issuer?: string }]>([
    ['usd+rX', { currency: 'USD', issuer: 'rX' }],
    ['usd|rX', { currency: 'USD', issuer: 'rX' }],
    ['usd.rX', { currency: 'USD', issuer: 'rX' }],
    ['xrp', { currency: 'XRP', issuer: undefined }],
    ['xrp+', { currency: 'XRP', issuer: undefined }],
    ['+rX', { currency: undefined, issuer: 'rX' }],
    ['', { currency: undefined, issuer: undefined }],
    // only the first two parts count, as in the Ripple routes
    ['usd+rX+junk', { currency: 'USD', issuer: 'rX' }],
  ])('splits %j', (raw, expected) => {
    expect(splitAsset(raw)).toEqual(expected);
  });
});

describe('parseAsset', () => {
  it.each<[string, string, Asset]>([
    [`usd+${BITSTAMP}`, 'XRP', { currency: 'USD', issuer: BITSTAMP }],
    [`USD+${BITSTAMP}`, 'XRP', { currency: 'USD', issuer: BITSTAMP }],
    [`usd|${BITSTAMP}`, 'XRP', { currency: 'USD', issuer: BITSTAMP }],
    [`usd.${BITSTAMP}`, 'XRP', { currency: 'USD', issuer: BITSTAMP }],
    [`eur+${GATEHUB}`, 'XRP', { currency: 'EUR', issuer: GATEHUB }],
    ['XRP', 'XRP', { currency: 'XRP' }],
    ['xrp', 'XRP', { currency: 'XRP' }],
    ['xrp+', 'XRP', { currency: 'XRP' }],
    ['XAH', 'XAH', { currency: 'XAH' }],
    // only the first two parts count
    [`usd+${BITSTAMP}+junk`, 'XRP', { currency: 'USD', issuer: BITSTAMP }],
    // on Xahau, XRP is an ordinary currency code with an issuer, and on the XRPL so is XAH
    [`xrp+${BITSTAMP}`, 'XAH', { currency: 'XRP', issuer: BITSTAMP }],
    [`xah+${BITSTAMP}`, 'XRP', { currency: 'XAH', issuer: BITSTAMP }],
  ])('parses %s on a network whose native currency is %s', (raw, native, expected) => {
    expect(parseAsset(raw, native)).toStrictEqual(expected);
  });

  it('upper-cases a 40-hex currency code and keeps the issuer as written', () => {
    const hex = '0158415500000000c1f76ff6ecb0bac600000000';
    const a = parseAsset(`${hex}+${BITSTAMP}`, 'XRP');
    expect(a.currency).toBe(hex.toUpperCase());
    expect(a.issuer).toBe(BITSTAMP);
  });

  it('leaves out the issuer of the native currency', () => {
    expect(Object.keys(parseAsset('XRP', 'XRP'))).toEqual(['currency']);
  });

  it.each<[string, string, 'base' | 'counter' | undefined, string]>([
    ['XRP+rX', 'XRP', undefined, 'XRP cannot have an issuer'],
    ['xrp+rX', 'XRP', 'base', 'XRP cannot have an issuer'],
    [`XRP+${BITSTAMP}`, 'XRP', 'counter', 'XRP cannot have an issuer'],
    [`XAH+${BITSTAMP}`, 'XAH', 'base', 'XAH cannot have an issuer'],
    ['USD', 'XRP', 'base', 'base issuer is required'],
    ['USD', 'XRP', 'counter', 'counter issuer is required'],
    ['USD', 'XRP', undefined, 'issuer is required'],
    ['USD+', 'XRP', 'base', 'base issuer is required'],
    ['XRP', 'XAH', undefined, 'issuer is required'],
    ['XRP', 'XAH', 'counter', 'counter issuer is required'],
    ['', 'XRP', undefined, 'currency is required'],
    ['', 'XRP', 'base', 'base currency is required'],
    [`+${BITSTAMP}`, 'XRP', 'counter', 'counter currency is required'],
    ['USD+notanaddress', 'XRP', undefined, 'invalid issuer address'],
    ['USD+notanaddress', 'XRP', 'base', 'invalid base issuer address'],
    ['USD+notanaddress', 'XRP', 'counter', 'invalid counter issuer address'],
    [`USD+${BITSTAMP.toLowerCase()}`, 'XRP', undefined, 'invalid issuer address'],
    [`USD+${BITSTAMP.slice(0, -1)}`, 'XRP', undefined, 'invalid issuer address'],
    [`USD+${X_ADDRESS}`, 'XRP', undefined, 'invalid issuer address'],
  ])('rejects %j (native %s, role %s) with "%s"', (raw, native, role, message) => {
    expect(badRequestMessage(() => parseAsset(raw, native, role))).toBe(message);
  });

  it('says the native currency cannot have an issuer before it looks at the issuer address', () => {
    expect(badRequestMessage(() => parseAsset('XRP+rX', 'XRP'))).toBe('XRP cannot have an issuer');
  });

  it('answers a 400 whose body is the Ripple error', () => {
    try {
      parseAsset('USD', 'XRP', 'base');
      throw new Error('expected the call to throw');
    } catch (e) {
      expect((e as RippleHttpError).getResponse()).toEqual({ result: 'error', message: 'base issuer is required' });
    }
  });
});

describe('parseAssetPair', () => {
  it('parses both sides', () => {
    expect(parseAssetPair(`usd+${BITSTAMP}`, 'xrp', 'XRP')).toStrictEqual({
      base: { currency: 'USD', issuer: BITSTAMP },
      counter: { currency: 'XRP' },
    });
  });

  // Ripple checks the whole pair for one kind of mistake at a time: both currencies, then the native currency with an
  // issuer on either side, then a missing issuer on either side.
  it.each<[string, string, string]>([
    ['', '', 'base currency is required'],
    ['USD', '', 'counter currency is required'],
    ['', 'XRP+rX', 'base currency is required'],
    ['USD', 'XRP+rX', 'XRP cannot have an issuer'],
    ['XRP+rX', 'USD', 'XRP cannot have an issuer'],
    ['XRP', 'EUR', 'counter issuer is required'],
    ['USD', 'EUR', 'base issuer is required'],
    [`USD+${BITSTAMP}`, 'EUR', 'counter issuer is required'],
    ['USD+notanaddress', 'EUR', 'counter issuer is required'],
    ['USD+notanaddress', `EUR+${BITSTAMP}`, 'invalid base issuer address'],
    [`USD+${BITSTAMP}`, 'EUR+notanaddress', 'invalid counter issuer address'],
  ])('reports base %j, counter %j as "%s"', (base, counter, message) => {
    expect(badRequestMessage(() => parseAssetPair(base, counter, 'XRP'))).toBe(message);
  });

  it('uses the native currency of the network', () => {
    expect(badRequestMessage(() => parseAssetPair('XRP', `XAH+${BITSTAMP}`, 'XAH'))).toBe('XAH cannot have an issuer');
    expect(badRequestMessage(() => parseAssetPair('XRP', 'XAH', 'XAH'))).toBe('base issuer is required');
  });
});

describe('parseAssetFilter', () => {
  it.each<[string, { currency?: string; issuer?: string }]>([
    ['usd', { currency: 'USD', issuer: undefined }],
    [`usd+${BITSTAMP}`, { currency: 'USD', issuer: BITSTAMP }],
    [`Usd.${BITSTAMP}`, { currency: 'USD', issuer: BITSTAMP }],
    [`usd|${BITSTAMP}`, { currency: 'USD', issuer: BITSTAMP }],
    ['xrp', { currency: 'XRP', issuer: undefined }],
    // nothing is required of a filter: no issuer for an issued currency, and an issuer alone
    [`+${BITSTAMP}`, { currency: undefined, issuer: BITSTAMP }],
    // and nothing is checked of the currency
    ['usdollar', { currency: 'USDOLLAR', issuer: undefined }],
  ])('accepts %j', (raw, expected) => {
    expect(parseAssetFilter(raw, 'base')).toEqual(expected);
  });

  it('is no filter for nothing, or for a segment that names neither a currency nor an issuer', () => {
    expect(parseAssetFilter(undefined, 'base')).toBeUndefined();
    expect(parseAssetFilter('', 'base')).toBeUndefined();
    expect(parseAssetFilter('+', 'counter')).toBeUndefined();
  });

  it('rejects an issuer that is not a classic address, naming the side (R33)', () => {
    expect(badRequestMessage(() => parseAssetFilter('usd+nonsense', 'base'))).toBe('invalid base issuer address');
    expect(badRequestMessage(() => parseAssetFilter('usd+nonsense', 'counter'))).toBe('invalid counter issuer address');
    expect(badRequestMessage(() => parseAssetFilter(`usd+${X_ADDRESS}`, 'base'))).toBe('invalid base issuer address');
    expect(badRequestMessage(() => parseAssetFilter('+nonsense', 'base'))).toBe('invalid base issuer address');
  });

  it('does not reject the native currency with an issuer: such a filter matches nothing, as in the original', () => {
    expect(parseAssetFilter(`xrp+${GATEHUB}`, 'base')).toEqual({ currency: 'XRP', issuer: GATEHUB });
  });
});

describe('assetFromParts', () => {
  it.each<[string | undefined, string | undefined, string, boolean | undefined, Asset]>([
    [undefined, undefined, 'XRP', undefined, { currency: 'XRP' }],
    ['', '', 'XRP', undefined, { currency: 'XRP' }],
    ['xrp', undefined, 'XRP', undefined, { currency: 'XRP' }],
    ['usd', BITSTAMP, 'XRP', undefined, { currency: 'USD', issuer: BITSTAMP }],
    [undefined, undefined, 'XAH', undefined, { currency: 'XAH' }],
    ['XRP', BITSTAMP, 'XAH', undefined, { currency: 'XRP', issuer: BITSTAMP }],
    ['usd', BITSTAMP, 'XRP', false, { currency: 'USD', issuer: BITSTAMP }],
    ['xrp', undefined, 'XRP', false, { currency: 'XRP' }],
  ])('builds (%j, %j) on native %s (defaultNative %s)', (currency, issuer, native, defaultNative, expected) => {
    expect(assetFromParts(currency, issuer, native, defaultNative)).toStrictEqual(expected);
  });

  it.each<[string | undefined, string | undefined, string, boolean | undefined, string]>([
    ['XRP', 'rX', 'XRP', undefined, 'XRP cannot have an issuer'],
    ['xrp', BITSTAMP, 'XRP', undefined, 'XRP cannot have an issuer'],
    [undefined, BITSTAMP, 'XRP', undefined, 'XRP cannot have an issuer'],
    ['XAH', BITSTAMP, 'XAH', undefined, 'XAH cannot have an issuer'],
    ['USD', undefined, 'XRP', undefined, 'issuer is required'],
    ['USD', '', 'XRP', undefined, 'issuer is required'],
    ['XRP', undefined, 'XAH', undefined, 'issuer is required'],
    ['USD', 'notanaddress', 'XRP', undefined, 'invalid issuer address'],
    [undefined, undefined, 'XRP', false, 'currency is required'],
    ['', BITSTAMP, 'XRP', false, 'currency is required'],
  ])(
    'rejects (%j, %j) on native %s (defaultNative %s) with "%s"',
    (currency, issuer, native, defaultNative, message) => {
      expect(badRequestMessage(() => assetFromParts(currency, issuer, native, defaultNative))).toBe(message);
    },
  );
});

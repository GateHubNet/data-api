import { Asset, assetKey, canonicalPair } from './asset';

const BITSTAMP = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const GATEHUB = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';

describe('assetKey', () => {
  it.each<[Asset, string]>([
    [{ currency: 'XRP' }, 'XRP'],
    [{ currency: 'XRP', issuer: undefined }, 'XRP'],
    [{ currency: 'XRP', issuer: '' }, 'XRP'],
    [{ currency: 'USD', issuer: BITSTAMP }, `USD.${BITSTAMP}`],
  ])('%j -> %s', (asset, key) => {
    expect(assetKey(asset)).toBe(key);
  });
});

describe('canonicalPair', () => {
  const XRP: Asset = { currency: 'XRP' };
  const USD: Asset = { currency: 'USD', issuer: BITSTAMP };
  const EUR: Asset = { currency: 'EUR', issuer: BITSTAMP };

  it('puts the native currency second against a USD IOU, so XRP/USD is inverted', () => {
    const r = canonicalPair(XRP, USD);
    expect(r).toEqual({ base: USD, counter: XRP, inverted: true });
  });

  it('keeps USD/XRP as requested', () => {
    expect(canonicalPair(USD, XRP)).toEqual({ base: USD, counter: XRP, inverted: false });
  });

  it('orders two IOUs by lower-cased currency, then issuer', () => {
    expect(canonicalPair(USD, EUR)).toEqual({ base: EUR, counter: USD, inverted: true });
    expect(canonicalPair(EUR, USD)).toEqual({ base: EUR, counter: USD, inverted: false });

    const a: Asset = { currency: 'USD', issuer: BITSTAMP };
    const b: Asset = { currency: 'USD', issuer: GATEHUB };
    // 'rvyaf...' sorts after 'rhub8...'
    expect(canonicalPair(a, b)).toEqual({ base: b, counter: a, inverted: true });
    expect(canonicalPair(b, a)).toEqual({ base: b, counter: a, inverted: false });
  });

  it('is case-insensitive in the currency, like the Ripple key', () => {
    const lower: Asset = { currency: 'eur', issuer: BITSTAMP };
    expect(canonicalPair(USD, lower).inverted).toBe(true);
    expect(canonicalPair(lower, USD).inverted).toBe(false);
  });

  it('uses the Ripple key where the native currency reads "undefined" (xrpundefined)', () => {
    // Sorted by a bare "xrp" the native currency would come first; Ripple's key is "xrpundefined", which sorts after
    // "xrpb…".
    const xrpB: Asset = { currency: 'XRPB', issuer: BITSTAMP };
    expect(canonicalPair(XRP, xrpB)).toEqual({ base: xrpB, counter: XRP, inverted: true });
  });

  it('works the same on a network whose native code is XAH', () => {
    const XAH: Asset = { currency: 'XAH' };
    expect(canonicalPair(XAH, USD)).toEqual({ base: USD, counter: XAH, inverted: true });
    expect(canonicalPair(USD, XAH)).toEqual({ base: USD, counter: XAH, inverted: false });
  });

  it('treats an empty issuer as the native currency, as stored rows do', () => {
    const storedXrp: Asset = { currency: 'XRP', issuer: '' };
    const xrpB: Asset = { currency: 'XRPB', issuer: BITSTAMP };
    expect(canonicalPair(storedXrp, xrpB).inverted).toBe(true);
    expect(canonicalPair(storedXrp, xrpB).inverted).toBe(canonicalPair(XRP, xrpB).inverted);
  });

  it('does not invert two equal assets', () => {
    expect(canonicalPair(USD, { ...USD })).toEqual({ base: USD, counter: USD, inverted: false });
  });

  it('returns the given assets and leaves its input untouched', () => {
    const base = Object.freeze({ ...XRP });
    const counter = Object.freeze({ ...USD });
    const r = canonicalPair(base, counter);
    expect(r.base).toBe(counter);
    expect(r.counter).toBe(base);
    expect(base).toEqual(XRP);
    expect(counter).toEqual(USD);
  });
});

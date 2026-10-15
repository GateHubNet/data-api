import { canonicalPairKey } from '../parsers/exchanges.parser';

/** One side of a market. `issuer` is absent for the native currency. */
export interface Asset {
  currency: string;
  issuer?: string;
}

/** `XRP`, or `USD.rvYAf…` for an issued currency. An empty issuer counts as none, as in stored rows. */
export function assetKey(a: Asset): string {
  return a.issuer ? `${a.currency}.${a.issuer}` : a.currency;
}

/**
 * Orders a pair the way the Ripple Data API stores every exchange: the side with the lower `canonicalPairKey` is the
 * base. `inverted` says the caller asked for the opposite order, so rates and volumes of the stored rows have to be
 * flipped. The returned assets are the given objects, in the stored order.
 */
export function canonicalPair(base: Asset, counter: Asset): { base: Asset; counter: Asset; inverted: boolean } {
  const key = (a: Asset): string => canonicalPairKey(a.currency, a.issuer || undefined);
  return key(counter) < key(base)
    ? { base: counter, counter: base, inverted: true }
    : { base, counter, inverted: false };
}

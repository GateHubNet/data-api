import { ratio } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime, precision8 } from '../common/format';
import { changePercent, StoredMarket } from '../network/markets-object';
import type { TokenMarket } from './token-objects';
import type { TokenRef } from './token-param';

/**
 * The pure part of `TokenMarkets` (spec 5.5): the price, the volume and the markets of a token from the newest `include` sets of
 * `markets_live` (`day` and `30day`), indexed by asset. The service that reads and keeps the sets is Task 10's.
 */

/** The price and volume of a token, as the list and the detail show them. A fact that is not known is not there. */
export interface TokenMarketFacts {
  price?: string;
  price_change?: string;
  price_time?: string;
  native_volume?: string;
  trades?: number;
}

/**
 * The sets the facts are made from, each as a map from an asset (`assetKeyOf`) to the pairs it is a side of. `day` is
 * `undefined` while there is no set of the day (its `total_native_volume` is that of the set, every pair), `month` the same for the
 * `30day` set.
 */
export interface MarketsSnapshot {
  day?: { total_native_volume: string; byAsset: ReadonlyMap<string, readonly StoredMarket[]> };
  month?: { byAsset: ReadonlyMap<string, readonly StoredMarket[]> };
}

/** The most markets a token shows. */
const MAX_MARKETS = 20;

/** The key of an asset in the index: `currency|issuer`, with `''` for the issuer of the native currency. */
export function assetKeyOf(asset: { currency: string; issuer: string }): string {
  return `${asset.currency}|${asset.issuer}`;
}

/** The pairs of a set under each of their two sides, in the order given. */
export function indexMarkets(markets: readonly StoredMarket[]): ReadonlyMap<string, readonly StoredMarket[]> {
  const index = new Map<string, StoredMarket[]>();
  const add = (key: string, market: StoredMarket): void => {
    const pairs = index.get(key);
    if (pairs) pairs.push(market);
    else index.set(key, [market]);
  };
  for (const market of markets) {
    const base = assetKeyOf({ currency: market.base_currency, issuer: market.base_issuer });
    const counter = assetKeyOf({ currency: market.counter_currency, issuer: market.counter_issuer });
    add(base, market);
    if (counter !== base) add(counter, market);
  }
  return index;
}

const isBaseOf = (market: StoredMarket, token: TokenRef): boolean =>
  market.base_currency === token.currency && market.base_issuer === token.issuer;

/** The side of a pair that is not the token. */
function otherSide(market: StoredMarket, token: TokenRef): { currency: string; issuer: string } {
  return isBaseOf(market, token)
    ? { currency: market.counter_currency, issuer: market.counter_issuer }
    : { currency: market.base_currency, issuer: market.base_issuer };
}

/**
 * The rates of a pair with the token as the base (spec 5.5): as stored when the token is the base, else the inverse
 * (`ratio`, 200 decimal places: a rate and its inverse keep their significant digits). Plain decimal texts.
 */
function turnedRates(market: StoredMarket, token: TokenRef): { open: string; last: string } {
  if (isBaseOf(market, token)) return { open: market.open, last: market.last };
  return { open: ratio(1, market.open).toFixed(), last: ratio(1, market.last).toFixed() };
}

/** The pair of the token against the native currency, if the set has one. */
function nativePair(
  pairs: readonly StoredMarket[] | undefined,
  token: TokenRef,
  native: string,
): StoredMarket | undefined {
  return pairs?.find((market) => {
    const other = otherSide(market, token);
    return other.currency === native && other.issuer === '';
  });
}

/**
 * The price of a token, its volume and its trades (spec 5.5). `price` is the last rate of the token's pair against the native
 * currency (`native`, `XRP` or `XAH`) in the `day` set, turned to native per token and in 8 significant digits, with
 * `price_change` (percent, 2 decimals) and `price_time`; else that pair's `last` in the `month` set with `price_time` and no
 * change; else absent. `native_volume` and `trades` are the sums over the `day` pairs with the token (the native volume of those
 * that have one): `"0"` and 0 when it has none, and absent when there is no `day` set.
 */
export function tokenMarketFacts(s: MarketsSnapshot, t: TokenRef, native: string): TokenMarketFacts {
  const key = assetKeyOf(t);
  const dayPairs = s.day?.byAsset.get(key);
  const dayNative = nativePair(dayPairs, t, native);
  const priced = dayNative ?? nativePair(s.month?.byAsset.get(key), t, native);

  let price: { price: string; price_change?: string; price_time: string } | undefined;
  if (priced !== undefined) {
    const rates = turnedRates(priced, t);
    const change = priced === dayNative ? changePercent(rates.open, rates.last) : undefined;
    price = {
      price: precision8(rates.last),
      ...(change !== undefined && { price_change: change }),
      price_time: fmtTime(Number(priced.last_time)),
    };
  }

  let volume: { native_volume: string; trades: number } | undefined;
  if (s.day !== undefined) {
    let nativeVolume = new BigNumber(0);
    let trades = 0;
    for (const market of dayPairs ?? []) {
      if (typeof market.native_volume === 'string') nativeVolume = nativeVolume.plus(market.native_volume);
      trades += Number(market.count);
    }
    volume = { native_volume: nativeVolume.toFixed(), trades };
  }

  return { ...price, ...volume };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Listed {
  stored: StoredMarket;
  count: number;
  /** `undefined`: the pair has no native volume. */
  native: BigNumber | undefined;
  other: { currency: string; issuer: string };
}

/**
 * The markets of a token (spec 5.5): every pair of the `day` set with the token on a side, turned so that the token is the
 * base (`volume` the token's side, `counter_volume` the other, `last` the other asset per token in 8 significant digits,
 * `change` from the open and last rates in that orientation), ordered by `native_volume`, the largest first (compared as numbers,
 * the pairs without one last), then by `count`, the largest first, then by the other asset; at most 20.
 */
export function tokenMarkets(s: MarketsSnapshot, t: TokenRef): TokenMarket[] {
  const pairs = s.day?.byAsset.get(assetKeyOf(t)) ?? [];
  const listed: Listed[] = pairs.map((stored) => ({
    stored,
    count: Number(stored.count),
    native: typeof stored.native_volume === 'string' ? new BigNumber(stored.native_volume) : undefined,
    other: otherSide(stored, t),
  }));
  listed.sort((a, b) => {
    if (a.native && b.native) {
      const byVolume = b.native.comparedTo(a.native);
      if (byVolume) return byVolume;
    } else if (a.native || b.native) {
      return a.native ? -1 : 1;
    }
    return b.count - a.count || compare(a.other.currency, b.other.currency) || compare(a.other.issuer, b.other.issuer);
  });
  return listed.slice(0, MAX_MARKETS).map((m) => toTokenMarket(m, t));
}

function toTokenMarket({ stored, count, other }: Listed, token: TokenRef): TokenMarket {
  const isBase = isBaseOf(stored, token);
  const rates = turnedRates(stored, token);
  const change = changePercent(rates.open, rates.last);
  return {
    counter_currency: other.currency,
    ...(other.issuer !== '' && { counter_issuer: other.issuer }),
    count,
    volume: isBase ? stored.base_volume : stored.counter_volume,
    counter_volume: isBase ? stored.counter_volume : stored.base_volume,
    ...(typeof stored.native_volume === 'string' && { native_volume: stored.native_volume }),
    last: precision8(rates.last),
    ...(change !== undefined && { change }),
    last_time: fmtTime(Number(stored.last_time)),
    ...(typeof stored.amm_pool === 'number' && { amm_pool: stored.amm_pool === 1 }),
  };
}

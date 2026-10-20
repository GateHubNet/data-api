import { Asset, MarketsPeriod, QUOTIENT_DIGITS } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime, precision8 } from '../common/format';

/**
 * The answer of `GET /v2/network/markets` (spec 7), with the keys in the order the spec pins. A key without a value is left out
 * and `null` is never served. The answer has no AMM field in D2 (spec 8): no `amm`, no `totals.amm_share`, no `amm_share` or
 * `amm_pool` on a market. The objects are built key by key, so a column of the stored rows that is none of the keys below
 * (`amm_share`, `amm_pool`, `total_amm_share`) can never get into an answer.
 */

const DAY = 86_400;

/** A row of a `markets_live` set as the service reads it. A 64-bit column or a time may come back as text. */
export interface StoredMarket {
  base_currency: string;
  /** `''` for the native currency. */
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  count: number | string;
  base_volume: string;
  counter_volume: string;
  native_volume: string | null;
  open: string;
  high: string;
  low: string;
  last: string;
  /** Unix seconds. */
  open_time: number | string;
  last_time: number | string;
  /** The close of each of the 7 days that end with the day of the set's `end_time`, oldest first; `null`: none. */
  closes: readonly (string | null)[];
}

/** The newest set of a period: the pairs, and what its sentinel row carries (the window and the totals). */
export interface StoredMarketsSet {
  /** Unix seconds. */
  start_time: number | string;
  end_time: number | string;
  pairs_traded: number | string;
  total_count: number | string;
  total_native_volume: string;
  /** Every pair with a kept trade in the window, in no order the answer relies on. */
  markets: readonly StoredMarket[];
}

/** The currency the volumes are shown in as well, and how many of it one native coin buys (0 when that cannot be told). */
export interface MarketsDisplay {
  asset: Asset;
  rate: BigNumber;
}

export interface MarketsInput {
  period: MarketsPeriod;
  set: StoredMarketsSet;
  /** The pairs with at least this many trades are listed. */
  minTrades: number;
  limit: number;
  display?: MarketsDisplay;
}

export interface SparklineEntry {
  /** The start of the UTC day. */
  date: string;
  close?: string;
}

export interface Market {
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
  count: number;
  base_volume: string;
  counter_volume: string;
  native_volume?: string;
  converted_volume?: string;
  open: string;
  high: string;
  low: string;
  last: string;
  /** Percent, two decimals; left out for an open that is not above 0. */
  change?: string;
  open_time: string;
  last_time: string;
  sparkline: SparklineEntry[];
}

export interface MarketsTotals {
  pairs: number;
  pairs_traded: number;
  count: number;
  native_volume: string;
  converted_volume?: string;
}

export interface MarketsAnswer {
  result: 'success';
  period: MarketsPeriod;
  start_time: string;
  end_time: string;
  exchange?: { currency: string; issuer?: string };
  exchange_rate?: string;
  totals: MarketsTotals;
  count: number;
  markets: Market[];
}

/** The answer while no set has been written: `result, period, count, markets`. */
export interface NoMarketsAnswer {
  result: 'success';
  period: MarketsPeriod;
  count: 0;
  markets: [];
}

// A quotient rounded once, half up (a tie goes away from zero), at the place the answer shows
const Percent = BigNumber.clone({ DECIMAL_PLACES: 2, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

/**
 * `(last / open - 1) * 100`, exact, rounded half up to 2 decimals: the quotient `(last - open) * 100 / open` is made of
 * exact sums and products and is rounded once (a `last / open` cut to 20 places first could round twice). `undefined` for
 * an `open` that is not above 0 (no change can be told), which a rate of a trade never is.
 */
export function changePercent(open: string, last: string): string | undefined {
  const from = new Percent(open);
  if (!from.gt(0)) return undefined;
  const change = new Percent(last).minus(from).times(100).dividedBy(from);
  return change.isFinite() ? change.toFixed(2) : undefined;
}

/** `native * rate`, to 17 significant digits (`QUOTIENT_DIGITS`, as every value derived by a rate), the rate as it is. */
export function convertedVolume(native: BigNumber.Value, rate: BigNumber): string {
  return new BigNumber(native).times(rate).precision(QUOTIENT_DIGITS).toString();
}

/**
 * The sparkline of a market: a date and a close for each of its `closes`, which end with the UTC day of `endTime` (unix
 * seconds). The close has the eight significant digits of a price, and is left out for a day without one.
 */
export function sparklineOf(closes: readonly (string | null)[], endTime: number | string): SparklineEntry[] {
  const lastDay = Math.floor(Number(endTime) / DAY) * DAY;
  return closes.map((close, i) => ({
    date: fmtTime(lastDay - (closes.length - 1 - i) * DAY),
    ...(typeof close === 'string' && { close: precision8(close) }),
  }));
}

function toMarket(m: StoredMarket, endTime: number, display?: MarketsDisplay): Market {
  const native = m.native_volume;
  const change = changePercent(m.open, m.last);
  return {
    base_currency: m.base_currency,
    ...(m.base_issuer !== '' && { base_issuer: m.base_issuer }),
    counter_currency: m.counter_currency,
    ...(m.counter_issuer !== '' && { counter_issuer: m.counter_issuer }),
    count: Number(m.count),
    base_volume: m.base_volume,
    counter_volume: m.counter_volume,
    ...(typeof native === 'string' && {
      native_volume: native,
      ...(display && { converted_volume: convertedVolume(native, display.rate) }),
    }),
    open: precision8(m.open),
    high: precision8(m.high),
    low: precision8(m.low),
    last: precision8(m.last),
    ...(change !== undefined && { change }),
    open_time: fmtTime(Number(m.open_time)),
    last_time: fmtTime(Number(m.last_time)),
    sparkline: sparklineOf(m.closes, endTime),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The order of the pair key of the table: base currency, base issuer, counter currency, counter issuer. */
const byPair = (a: StoredMarket, b: StoredMarket): number =>
  compare(a.base_currency, b.base_currency) ||
  compare(a.base_issuer, b.base_issuer) ||
  compare(a.counter_currency, b.counter_currency) ||
  compare(a.counter_issuer, b.counter_issuer);

interface Listed {
  stored: StoredMarket;
  count: number;
  /** `undefined`: the pair has no native volume. */
  native: BigNumber | undefined;
}

/**
 * The markets of a period from its set. The pairs with `count >= min_trades` are listed (`totals.pairs` counts them, listed or
 * not: the `limit` comes after), sorted by `native_volume`, the largest first (compared as numbers), the pairs without one
 * last by `count`, the largest first, and then by the pair; the first `limit` are served. The other totals are those of the
 * set (over every pair that traded). With a display currency the answer has `exchange` and `exchange_rate` after `end_time`,
 * and a `converted_volume` after the `native_volume` of every market that has one and in the totals.
 */
export function marketsAnswer(input: MarketsInput): MarketsAnswer {
  const { set, display } = input;
  const end = Number(set.end_time);
  const listed: Listed[] = set.markets
    .map((stored) => ({
      stored,
      count: Number(stored.count),
      native: typeof stored.native_volume === 'string' ? new BigNumber(stored.native_volume) : undefined,
    }))
    .filter((m) => m.count >= input.minTrades)
    .sort((a, b) => {
      if (a.native && b.native) return b.native.comparedTo(a.native) || byPair(a.stored, b.stored);
      if (a.native || b.native) return a.native ? -1 : 1;
      return b.count - a.count || byPair(a.stored, b.stored);
    });

  const markets = listed.slice(0, input.limit).map((m) => toMarket(m.stored, end, display));
  return {
    result: 'success',
    period: input.period,
    start_time: fmtTime(Number(set.start_time)),
    end_time: fmtTime(end),
    ...(display && {
      exchange: {
        currency: display.asset.currency,
        ...(display.asset.issuer && { issuer: display.asset.issuer }),
      },
      exchange_rate: precision8(display.rate),
    }),
    totals: {
      pairs: listed.length,
      pairs_traded: Number(set.pairs_traded),
      count: Number(set.total_count),
      native_volume: set.total_native_volume,
      ...(display && { converted_volume: convertedVolume(set.total_native_volume, display.rate) }),
    },
    count: markets.length,
    markets,
  };
}

export function noMarketsAnswer(period: MarketsPeriod): NoMarketsAnswer {
  return { result: 'success', period, count: 0, markets: [] };
}

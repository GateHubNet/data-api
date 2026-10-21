import {
  Asset,
  canonicalPair,
  computeMarketsSet,
  computePairHourSets,
  ExchangesRow,
  MARKETS_PERIOD_HOURS,
  MARKETS_PERIODS,
  MarketsLiveRow,
  MarketsPeriod,
  MarketsSetOutcome,
  RatesService,
  SPARKLINE_DAYS,
  Table,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { SAMPLE_ROWS } from '../../../../packages/shared/test/sample-rows';
import type { Harness } from '../harness';

/**
 * The world of the suites of `GET /v2/network/markets`: a few hundred trades, worked out by hand, over the 30 days before
 * `now`, written straight into `ledgers` and `exchanges`, then the hour sets of `pair_hourly` (`computePairHourSets`) and the
 * markets sets (`computeMarketsSet`) of the periods, exactly as the syncer's aggregator writes them. The trades are of the
 * 12 pairs below; a trade is `base amount for counter amount`, so the rate (the price) is counter over base, and the times are
 * those of `now`'s UTC day (`today`) and the days before it. `now` has to be a time between 09:00:00 and 11:59:59 UTC, so
 * that the trades of "yesterday at 12:00" are inside the day window and the ones of "today at 08:30" are before `now`; the
 * newest trade is at `now` itself (the newest ledger, so `t` and `end_time` of every set).
 *
 * `N` is the native currency (XRP, XAH on Xahau), and the issuer of every issued currency is the same, `MARKETS_ISSUER`.
 *
 * | pair      | trades                                                                                                           |
 * | --------- | ---------------------------------------------------------------------------------------------------------------- |
 * | USD/N     | M: 10 x (10, 2.5) then 10 x (10, 7.5) on day -22; W: 5 x (10, 4.5) then 10 x (10, 5.25) on day -4;              |
 * |           | D: 10 x (10, 5) yesterday 12:00 to 12:09, (10, 8) at 06:30, (10, 3) at 08:15, (10, 4) at `now`                  |
 * | N/ZZZ     | M: 3 x (5, 10) on day -17; D: 11 x (5, 10) today 03:00 to 03:10                                                  |
 * | USD/ZZZ   | M: 5 x (10, 25) on day -20; W: 3 x (10, 20) on day -5; D: 12 x (10, 20) today 04:00 to 04:11                     |
 * | EUR/USD   | W: 5 x (4, 5) on day -3; D: 10 x (4, 5) today 05:00 to 05:09                                                     |
 * | BTC/EUR   | D: 11 x (1, 20) yesterday 15:00 to 15:10                                                                         |
 * | BTC/GBP   | D: 11 x (1, 30) yesterday 16:00 to 16:10                                                                         |
 * | EUR/GBP   | D: 14 x (2, 3) yesterday 17:00 to 17:13                                                                          |
 * | AUD/N     | W: 2 x (4, 1.2) on day -3 at 14:00; D: 10 x (4, 1) today 07:00 to 07:09                                          |
 * | CAD/N     | D: 10 x (8, 1) today 07:30 to 07:39                                                                              |
 * | CHF/N     | D: 9 x (10, 2) today 08:00 to 08:08                                                                              |
 * | NZD/N     | D: 1 x (1, 0.5) today at 08:30                                                                                   |
 * | JPY/N     | M: 12 x (100, 1) on day -20 at 14:00                                                                             |
 *
 * `day -22` is the day 22 days before today, `yesterday` the day before it. D is the day window (the 24 hours before the hour
 * of `now`, and that hour), W the part of the 7 days that is not in it, M the part of the 30 days that is not in the 7.
 * The trades of a run are a minute apart. USD has a rate of 2 (USD per native coin) in each
 * period, ZZZ too, and EUR, GBP and BTC have none: EUR/USD has a native volume through the counter, USD/ZZZ through the base,
 * and BTC/EUR, BTC/GBP and EUR/GBP have none.
 *
 * Every trade above is an order-book trade (`amm_account` ''), so the numbers are those of the order book: with no swap in
 * the world, the `exclude` set is the `include` one and the `only` set is empty, and every pair has an `amm_share` of
 * "0.0000" and no pool. (`SAMPLE_ROWS[Table.Exchanges]` is a swap against a pool, which a spread of it would make every
 * trade of the world: the account is set on purpose.)
 *
 * With `{ amm: true }` the world also has two pairs that traded in the day window, new currencies against the native one, so
 * that no number above changes (a rate of USD or ZZZ comes from their own pairs), and the pool of one of them:
 *
 * | pair      | trades                                                                                                           |
 * | --------- | ---------------------------------------------------------------------------------------------------------------- |
 * | MIX/N     | D: 6 x (10, 2) today 01:00 to 01:05 in the order book, then 4 x (10, 3) 01:10 to 01:13, swaps of `MARKETS_POOL`  |
 * | SWP/N     | D: 10 x (5, 1) today 01:20 to 01:29, all swaps of `MARKETS_POOL2`                                                |
 *
 * `MARKETS_POOL` has an `amm_pools` row (MIX/N, not deleted); `MARKETS_POOL2` has none. So MIX/N has 10 trades, 100 MIX and
 * 24 of native volume, 40 of the MIX are swaps: `amm_share` "0.4000", `amm_pool` true; SWP/N has 10 trades, 50 SWP and 10 of
 * native volume, all swaps: "1.0000", no pool. The native volume of the day is 243.5 + 24 + 10 = 277.5 and its share
 * (24 x 0.4 + 10 x 1) / 277.5 = 0.0706.
 */

/** Two addresses that are valid (the issuers of the world and of the display currency). */
export const MARKETS_ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
export const MARKETS_ISSUER2 = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/** The accounts of two pools, only names: nothing reads them as addresses. The first has an `amm_pools` row, the second none. */
export const MARKETS_POOL = 'rPoolMixXrp11111111111111111111111';
export const MARKETS_POOL2 = 'rPoolSwpXrp11111111111111111111111';

/** The `now` the suites make their sets at. */
export const MARKETS_NOW = new Date('2020-07-02T10:42:17Z');

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

export interface MarketsWorldOptions {
  /** The native currency of the network. Default: `XRP`. */
  native?: string;
  /** The periods to write a set for. Default: all three. A short list is quicker: the hours that are read are fewer. */
  periods?: readonly MarketsPeriod[];
  /** Add the pairs and the pool with swaps of the table at the top (MIX/N and SWP/N). Default: no, the order book only. */
  amm?: boolean;
}

export interface MarketsWorld {
  now: Date;
  native: string;
  /** What each period's run came to; every one is a written set. */
  sets: Partial<Record<MarketsPeriod, MarketsSetOutcome>>;
}

type StoredPair = ReturnType<typeof canonicalPair>;

interface Trade {
  pair: StoredPair;
  close: number;
  base: string;
  counter: string;
  /** The pool a swap is against; none for an order-book trade (`amm_account` ''). */
  pool?: string;
}

const issued = (currency: string): Asset => ({ currency, issuer: MARKETS_ISSUER });

/** The pair of two assets in the canonical stored order: the world is written in it, and it is a mistake if it is not. */
function stored(base: Asset, counter: Asset): StoredPair {
  const pair = canonicalPair(base, counter);
  if (pair.inverted) throw new Error(`${base.currency}/${counter.currency} is not in the canonical order`);
  return pair;
}

/** The trades of the world (see the table at the top), with `now` in unix seconds; `amm` adds the swaps and their pairs. */
function worldTrades(now: number, native: string, amm: boolean): Trade[] {
  const today = Math.floor(now / DAY) * DAY;
  /** `days` before today, at the given time of day. */
  const at = (days: number, hour: number, minute = 0, second = 0): number =>
    today - days * DAY + hour * HOUR + minute * 60 + second;
  /** `n` trades a minute apart from `from`. */
  const run = (pair: StoredPair, from: number, n: number, base: string, counter: string): Trade[] =>
    Array.from({ length: n }, (_, i) => ({ pair, close: from + i * 60, base, counter }));
  const one = (pair: StoredPair, close: number, base: string, counter: string): Trade[] =>
    run(pair, close, 1, base, counter);

  const N: Asset = { currency: native };
  const usdN = stored(issued('USD'), N);
  const nZzz = stored(N, issued('ZZZ'));
  const usdZzz = stored(issued('USD'), issued('ZZZ'));
  const eurUsd = stored(issued('EUR'), issued('USD'));
  const btcEur = stored(issued('BTC'), issued('EUR'));
  const btcGbp = stored(issued('BTC'), issued('GBP'));
  const eurGbp = stored(issued('EUR'), issued('GBP'));
  const audN = stored(issued('AUD'), N);
  const cadN = stored(issued('CAD'), N);
  const chfN = stored(issued('CHF'), N);
  const nzdN = stored(issued('NZD'), N);
  const jpyN = stored(issued('JPY'), N);
  const mixN = stored(issued('MIX'), N);
  const swpN = stored(issued('SWP'), N);
  /** `n` swaps against `pool` a minute apart from `from`. */
  const swaps = (pair: StoredPair, from: number, n: number, base: string, counter: string, pool: string): Trade[] =>
    run(pair, from, n, base, counter).map((trade) => ({ ...trade, pool }));

  const swapTrades = [
    // MIX/N: the order book, then the pool
    ...run(mixN, at(0, 1), 6, '10', '2'),
    ...swaps(mixN, at(0, 1, 10), 4, '10', '3', MARKETS_POOL),
    // SWP/N: swaps only
    ...swaps(swpN, at(0, 1, 20), 10, '5', '1', MARKETS_POOL2),
  ];

  return [
    // USD/N
    ...run(usdN, at(22, 12), 10, '10', '2.5'),
    ...run(usdN, at(22, 13), 10, '10', '7.5'),
    ...run(usdN, at(4, 12), 5, '10', '4.5'),
    ...run(usdN, at(4, 13), 10, '10', '5.25'),
    ...run(usdN, at(1, 12), 10, '10', '5'),
    ...one(usdN, at(0, 6, 30), '10', '8'),
    ...one(usdN, at(0, 8, 15), '10', '3'),
    ...one(usdN, now, '10', '4'),
    // N/ZZZ
    ...run(nZzz, at(17, 12), 3, '5', '10'),
    ...run(nZzz, at(0, 3), 11, '5', '10'),
    // USD/ZZZ
    ...run(usdZzz, at(20, 12), 5, '10', '25'),
    ...run(usdZzz, at(5, 12), 3, '10', '20'),
    ...run(usdZzz, at(0, 4), 12, '10', '20'),
    // EUR/USD
    ...run(eurUsd, at(3, 12), 5, '4', '5'),
    ...run(eurUsd, at(0, 5), 10, '4', '5'),
    // the pairs without a native volume
    ...run(btcEur, at(1, 15), 11, '1', '20'),
    ...run(btcGbp, at(1, 16), 11, '1', '30'),
    ...run(eurGbp, at(1, 17), 14, '2', '3'),
    // the pairs against the native currency
    ...run(audN, at(3, 14), 2, '4', '1.2'),
    ...run(audN, at(0, 7), 10, '4', '1'),
    ...run(cadN, at(0, 7, 30), 10, '8', '1'),
    ...run(chfN, at(0, 8), 9, '10', '2'),
    ...one(nzdN, at(0, 8, 30), '1', '0.5'),
    ...run(jpyN, at(20, 14), 12, '100', '1'),
    ...(amm ? swapTrades : []),
  ];
}

/**
 * Writes a `ledgers` row for the close time of every trade (the index goes up with the time, a trade of its own each, or the
 * next transaction index of a ledger that two trades share) and the trades into `exchanges`.
 */
async function writeTrades(h: Harness, trades: Trade[]): Promise<void> {
  const closes = [...new Set(trades.map((t) => t.close))].sort((a, b) => a - b);
  const ledgerOf = new Map(closes.map((close, i) => [close, 2_000_000 + i]));
  await h.ch.insert(
    Table.Ledgers,
    closes.map((close) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: ledgerOf.get(close) as number,
      ledger_hash: String(ledgerOf.get(close)).padStart(64, 'C'),
      close_time: close,
    })),
  );
  const txIn = new Map<number, number>();
  const rows = trades.map((t, i): ExchangesRow => {
    const tx = txIn.get(t.close) ?? 0;
    txIn.set(t.close, tx + 1);
    const rate = new BigNumber(t.counter).dividedBy(t.base);
    return {
      ...SAMPLE_ROWS[Table.Exchanges],
      base_currency: t.pair.base.currency,
      base_issuer: t.pair.base.issuer ?? '',
      counter_currency: t.pair.counter.currency,
      counter_issuer: t.pair.counter.issuer ?? '',
      ledger_index: ledgerOf.get(t.close) as number,
      tx_index: tx,
      node_index: 0,
      tx_hash: String(i).padStart(64, 'E'),
      close_time: t.close,
      // the sample row is a swap against a pool: an order-book trade has no pool
      amm_account: t.pool ?? '',
      base_amount: t.base,
      counter_amount: t.counter,
      base_amount_f: Number(t.base),
      counter_amount_f: Number(t.counter),
      rate: rate.toString(),
      rate_f: rate.toNumber(),
    };
  });
  await h.ch.insert(Table.Exchanges, rows);
}

/** The `amm_pools` row of a pool of a pair: not deleted, the first and only version. */
async function writePool(h: Harness, pair: StoredPair, account: string): Promise<void> {
  await h.ch.insert(Table.AmmPools, [
    {
      ...SAMPLE_ROWS[Table.AmmPools],
      amm_account: account,
      base_currency: pair.base.currency,
      base_issuer: pair.base.issuer ?? '',
      counter_currency: pair.counter.currency,
      counter_issuer: pair.counter.issuer ?? '',
      deleted: 0,
      version: 1,
    },
  ]);
}

/** The hour sets of `firstHour` to `lastHour` (unix seconds of whole hours, both included), a UTC day at a time. */
async function writeHourSets(h: Harness, rates: RatesService, firstHour: number, lastHour: number): Promise<void> {
  for (let from = firstHour; from <= lastHour; ) {
    const to = Math.min((Math.floor(from / DAY) + 1) * DAY, lastHour + HOUR);
    await computePairHourSets(h.ch, rates, from, to);
    from = to;
  }
}

/**
 * Seeds the harness's database with the world of the top of this file and the markets sets of its periods at `now`.
 *
 * The hours of the world are long before the real clock of the ClickHouse server, and `pair_hourly` expires its rows 45 days
 * after their hour: a background TTL merge would drop them within milliseconds of their insert, so the TTL merges of the table
 * are stopped first (Ruling P5; `markets_live` has no TTL).
 */
export async function seedMarketsWorld(
  h: Harness,
  now: Date,
  options: MarketsWorldOptions = {},
): Promise<MarketsWorld> {
  const native = options.native ?? 'XRP';
  const periods = options.periods ?? MARKETS_PERIODS;
  const seconds = Math.floor(now.getTime() / SEC);
  const secondOfDay = seconds % DAY;
  if (secondOfDay < 9 * HOUR || secondOfDay >= 12 * HOUR) {
    throw new RangeError(`The world needs a time between 09:00:00 and 11:59:59 UTC: ${now.toISOString()}`);
  }

  // Ruling P5: the hours are far past the 45 days of the TTL, so a TTL merge would drop the rows of pair_hourly mid-test
  await h.ch.command(`SYSTEM STOP TTL MERGES ${h.database}.${Table.PairHourly}`);
  await writeTrades(h, worldTrades(seconds, native, options.amm === true));
  if (options.amm) await writePool(h, stored(issued('MIX'), { currency: native }), MARKETS_POOL);

  // the hours the sets read: the longest window, and the days of the sparkline
  const currentHour = Math.floor(seconds / HOUR) * HOUR;
  const sparkStart = Math.floor(currentHour / DAY) * DAY - (SPARKLINE_DAYS - 1) * DAY;
  const firstHour = Math.min(sparkStart, ...periods.map((p) => currentHour - MARKETS_PERIOD_HOURS[p] * HOUR));
  await writeHourSets(h, new RatesService(h.ch, native), firstHour, currentHour);

  const sets: MarketsWorld['sets'] = {};
  for (const period of periods) {
    const outcome = await computeMarketsSet(h.ch, native, period, now);
    if (!outcome.written) throw new Error(`The ${period} set was not written: no set for ${outcome.missingHours}`);
    sets[period] = outcome;
  }
  return { now, native, sets };
}

/**
 * Writes the trades the live rate of a display currency is made of: `trades` of them (at least 10, or the rate is 0) in the hour
 * before the real clock, each `native` coins for `display` units of the currency, so one native coin is worth
 * `display / native` of it. The rate of `exchangeRate(native, currency, { live: true })` is that of the newest 50 trades within
 * 14 days of the real clock, which the trades of the world, in 2020, are far from.
 */
export async function seedLiveRate(
  h: Harness,
  nativeCurrency: string,
  currency: Asset,
  amounts: { native: string; display: string },
  trades = 12,
): Promise<void> {
  const pair = canonicalPair({ currency: nativeCurrency }, currency);
  const first = Math.floor(Date.now() / SEC) - HOUR;
  const closes = Array.from({ length: trades }, (_, i) => first + i);
  const index = (i: number): number => 90_000_000 + i;
  await h.ch.insert(
    Table.Ledgers,
    closes.map((close, i) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: index(i),
      ledger_hash: String(index(i)).padStart(64, 'F'),
      close_time: close,
    })),
  );
  const baseAmount = pair.inverted ? amounts.display : amounts.native;
  const counterAmount = pair.inverted ? amounts.native : amounts.display;
  await h.ch.insert(
    Table.Exchanges,
    closes.map(
      (close, i): ExchangesRow => ({
        ...SAMPLE_ROWS[Table.Exchanges],
        base_currency: pair.base.currency,
        base_issuer: pair.base.issuer ?? '',
        counter_currency: pair.counter.currency,
        counter_issuer: pair.counter.issuer ?? '',
        ledger_index: index(i),
        tx_index: 0,
        node_index: 0,
        tx_hash: String(i).padStart(64, 'D'),
        close_time: close,
        // a trade of the rate, not a swap: the sample row is one
        amm_account: '',
        base_amount: baseAmount,
        counter_amount: counterAmount,
        base_amount_f: Number(baseAmount),
        counter_amount_f: Number(counterAmount),
        rate: new BigNumber(counterAmount).dividedBy(baseAmount).toString(),
        rate_f: new BigNumber(counterAmount).dividedBy(baseAmount).toNumber(),
      }),
    ),
  );
}

/** A pair of a set written by hand: `base` and `counter` as `CUR` or `CUR+issuer`; the rest is made up from the count. */
export interface HandPair {
  base: string;
  counter: string;
  count: number;
  /** The native volume; none when it is left out. */
  native?: string;
  /** The AMM share (text, 4 decimals) and the pool flag; NULL (not known) when left out. */
  ammShare?: string;
  ammPool?: 0 | 1;
}

/**
 * The rows of a `markets_live` set written by hand: the sentinel (window and totals, which are those of the pairs) and a row
 * for each pair, all under one `version`. A pair's volumes are its count and twice its count, its rates 1 to 2, and its closes
 * `2` on the last day. The AMM columns are NULL (not known) unless a pair or `totalAmmShare` names them.
 */
export function handSet(o: {
  period: string;
  amm?: MarketsLiveRow['amm'];
  version: number;
  start: number;
  end: number;
  pairs: HandPair[];
  /** The `total_amm_share` of the sentinel; NULL when left out. */
  totalAmmShare?: string;
}): MarketsLiveRow[] {
  const amm = o.amm ?? 'include';
  const frame = {
    period: o.period,
    amm,
    start_time: o.start,
    end_time: o.end,
    amm_share: null,
    amm_pool: null,
    total_amm_share: o.totalAmmShare ?? null,
    version: o.version,
  };
  const sentinel: MarketsLiveRow = {
    ...frame,
    base_currency: '',
    base_issuer: '',
    counter_currency: '',
    counter_issuer: '',
    count: 0,
    base_volume: '0',
    counter_volume: '0',
    native_volume: null,
    open: '',
    high: '',
    low: '',
    last: '',
    open_time: o.start,
    last_time: o.start,
    closes: [],
    pairs_traded: o.pairs.length,
    total_count: o.pairs.reduce((n, p) => n + p.count, 0),
    total_native_volume: o.pairs.reduce((sum, p) => sum.plus(p.native ?? 0), new BigNumber(0)).toString(),
  };
  const side = (text: string): [string, string] => {
    const [currency, issuer = ''] = text.split('+');
    return [currency, issuer];
  };
  return [
    sentinel,
    ...o.pairs.map((p): MarketsLiveRow => {
      const [baseCurrency, baseIssuer] = side(p.base);
      const [counterCurrency, counterIssuer] = side(p.counter);
      return {
        ...sentinel,
        base_currency: baseCurrency,
        base_issuer: baseIssuer,
        counter_currency: counterCurrency,
        counter_issuer: counterIssuer,
        count: p.count,
        base_volume: String(p.count),
        counter_volume: String(2 * p.count),
        native_volume: p.native ?? null,
        amm_share: p.ammShare ?? null,
        amm_pool: p.ammPool ?? null,
        total_amm_share: null,
        open: '1',
        high: '2',
        low: '1',
        last: '2',
        open_time: o.start,
        last_time: o.end,
        closes: [null, null, null, null, null, null, '2'],
        pairs_traded: 0,
        total_count: 0,
        total_native_volume: '0',
      };
    }),
  ];
}

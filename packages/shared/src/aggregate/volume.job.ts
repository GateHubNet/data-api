import BigNumber from 'bignumber.js';
import { isValidClassicAddress } from 'xrpl';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { VolumeDailyRow, VolumeLiveRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { MarketAsset, MarketsConfig } from '../network/network-profile';
import { Asset, assetKey } from '../query/asset';
import { exactAmount, exactSum, floatSum, ratio, sumOf } from '../query/decimal';
import { LedgerRange, RatesService } from '../query/rates.service';
// amm-daily.job imports this module too: neither may use the other's exports at load time, only inside functions
import { ammWindowSwapTotals, SwapTotals } from './amm-daily.job';
import { AmmPoolVolume, ammPoolVolumes } from './amm-reads';

/**
 * The volume jobs: the trade volume and the payment volume of the Ripple Data API (`scripts/tradeVolume.js`,
 * `scripts/paymentVolume.js`, served by `/v2/network/exchange_volume` and `/v2/network/payment_volume`), computed from the
 * ledgers instead of from HBase's top markets and top currencies: the markets and the currencies are the ones of the
 * versioned markets config. A third metric, the AMM volume (`/v2/network/amm_volume`), is the swaps against the AMM pools, a
 * component per pool, converted like the trade components; it is not limited to the configured markets (every pool with swaps
 * counts) and needs no table or job of its own.
 *
 * Two kinds of sets are written. A **live set** is a rolling window ending now (`volume_live`: trade volume and AMM volume for
 * the periods hour, day, 3day, 7day and 30day, payment volume for hour and day); a **daily set** is a UTC day
 * (`volume_daily`). The API sums daily sets into weeks and months.
 *
 * Both tables are ReplacingMergeTree(version) keyed by the component, which would let a component that disappears (a market
 * removed from the config, a currency whose rate is gone) linger for ever. So **a recompute writes the complete set of a
 * (metric, day) or (metric, period) with one version, in one insert, and a reader keeps the rows whose version is the
 * newest of the set** (no FINAL, and nothing depends on a merge). Every set holds a **sentinel** row (component '', count 0):
 * a day without any volume still has a set, which is how a day is known to be computed.
 *
 * The version is the time of the write in milliseconds on the ClickHouse clock, and never lower than one more than the
 * newest version the set has now, so that it only goes up.
 */

export const VOLUME_METRICS = ['trade_volume', 'payment_volume', 'amm_volume'] as const;
export type VolumeMetric = (typeof VOLUME_METRICS)[number];

/** The rolling windows of the live sets. */
export type LivePeriod = 'hour' | 'day' | '3day' | '7day' | '30day';
/** The periods of the trade volume, in the order the original lists them. */
export const TRADE_LIVE_PERIODS: readonly LivePeriod[] = ['hour', 'day', '3day', '7day', '30day'];
/** The periods of the payment volume. The original's develop branch also had `minute`; it is not supported here. */
export const PAYMENT_LIVE_PERIODS: readonly LivePeriod[] = ['hour', 'day'];

/** The periods a metric has live sets for: the AMM volume has the periods of the trade volume. */
export function livePeriodsOf(metric: VolumeMetric): readonly LivePeriod[] {
  return metric === 'payment_volume' ? PAYMENT_LIVE_PERIODS : TRADE_LIVE_PERIODS;
}

/** The length of each period, in seconds. */
export const LIVE_PERIOD_SECONDS: Readonly<Record<LivePeriod, number>> = {
  hour: 3600,
  day: 86_400,
  '3day': 3 * 86_400,
  '7day': 7 * 86_400,
  '30day': 30 * 86_400,
};

export const DAY_SECONDS = 86_400;
const MAX_UINT32 = 4_294_967_295;
/** At most this many rate lookups of a payment set are in flight at once. */
const RATE_CONCURRENCY = 4;

/** Thrown by a recompute whose `signal` was aborted: nothing was written after the abort. */
export class VolumeRecomputeAborted extends Error {
  constructor() {
    super('The volume recompute was aborted before it wrote');
    this.name = 'VolumeRecomputeAborted';
  }
}

export interface VolumeOptions {
  /**
   * Checked before the work and again just before the insert: an aborted recompute throws `VolumeRecomputeAborted` and
   * writes nothing. The syncer aborts it when it shuts down, so that no row is written once the shutdown has begun.
   */
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new VolumeRecomputeAborted();
}

// ---------------------------------------------------------------------------------------------------------------------
// The markets config
// ---------------------------------------------------------------------------------------------------------------------

/** `Invalid markets config: <where>: <why>`: what a bad config of the operator is reported as, at boot. */
function invalid(where: string, why: string): never {
  throw new Error(`Invalid markets config: ${where}: ${why}`);
}

/** A currency code as the ledger takes it: three characters of the standard set, or 40 hex digits. */
const STANDARD_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CODE = /^[0-9A-Fa-f]{40}$/;

function checkAsset(where: string, a: unknown, nativeCurrency: string): void {
  if (typeof a !== 'object' || a === null) return invalid(where, 'must be an object with a currency (and an issuer)');
  const { currency, issuer } = a as MarketAsset;
  if (typeof currency !== 'string' || currency === '') return invalid(where, 'needs a currency');
  if (currency !== nativeCurrency && !STANDARD_CODE.test(currency) && !HEX_CODE.test(currency)) {
    return invalid(where, `"${currency}" is not a currency code (three characters, or 40 hexadecimal digits)`);
  }
  if (issuer !== undefined && issuer !== null && typeof issuer !== 'string')
    return invalid(where, 'the issuer must be text');
  if (currency === nativeCurrency && !issuer) return;
  if (currency === nativeCurrency) return invalid(where, `the native currency ${nativeCurrency} has no issuer`);
  if (!issuer)
    return invalid(where, `${currency} needs an issuer (only the native currency ${nativeCurrency} has none)`);
  if (!isValidClassicAddress(issuer)) return invalid(where, `the issuer "${issuer}" is not a classic address`);
}

/**
 * Throws an `Error` that says what is wrong with a markets config (`version` a whole number that fits a `UInt32`; every
 * market two different assets; every asset a currency code with the classic address of its issuer, or the native currency
 * without one), so that a typo of the operator stops the boot instead of failing every tick. The loader only checks the
 * shape of the file.
 */
export function assertValidMarketsConfig(config: MarketsConfig, nativeCurrency: string): void {
  if (!Number.isInteger(config.version) || config.version < 0 || config.version > MAX_UINT32) {
    invalid('version', 'must be a whole number between 0 and 4294967295');
  }
  config.tradeMarkets.forEach((market, i) => {
    const where = `tradeMarkets[${i}]`;
    if (typeof market !== 'object' || market === null)
      return invalid(where, 'must be an object with a base and a counter');
    checkAsset(`${where}.base`, market.base, nativeCurrency);
    checkAsset(`${where}.counter`, market.counter, nativeCurrency);
    if (key(market.base) === key(market.counter)) invalid(where, 'a market needs two different assets');
  });
  config.paymentCurrencies.forEach((currency, i) => checkAsset(`paymentCurrencies[${i}]`, currency, nativeCurrency));
}

/** The asset of a config entry: no `issuer` key for the native currency (an empty issuer counts as none). */
function assetOf(a: MarketAsset): Asset {
  return a.issuer ? { currency: a.currency, issuer: a.issuer } : { currency: a.currency };
}

const key = (a: MarketAsset): string => assetKey(assetOf(a));

const isNative = (a: Asset, nativeCurrency: string): boolean => a.currency === nativeCurrency && !a.issuer;

interface Market {
  base: Asset;
  counter: Asset;
  /** `USD.rhub8…/XRP`: the id of the market in the set (and the key of its row). */
  component: string;
}

/**
 * The markets of the config as the original's job ran them: the native currency is always the counter (a market listed
 * with it as the base is turned round), and a market listed twice, or the other way round, is kept once (the first listing
 * wins, in the orientation it was written).
 */
function marketsOf(config: MarketsConfig, nativeCurrency: string): Market[] {
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const m of config.tradeMarkets) {
    let base = assetOf(m.base);
    let counter = assetOf(m.counter);
    if (isNative(base, nativeCurrency)) [base, counter] = [counter, base];
    const id = [assetKey(base), assetKey(counter)].sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ base, counter, component: `${assetKey(base)}/${assetKey(counter)}` });
  }
  return out;
}

/** The currencies a payment set lists: the configured ones and the native currency, each once. */
function paymentAssetsOf(config: MarketsConfig, nativeCurrency: string): Asset[] {
  const out = new Map<string, Asset>();
  for (const c of [...config.paymentCurrencies, { currency: nativeCurrency }]) out.set(key(c), assetOf(c));
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// The components of a set
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One row of a set, before it is stored. `converted` is in the native currency and `rate` is how many units of the
 * component's `base` one native coin buys, so that `converted = amount / rate` for every component, whatever way it was
 * converted (the one exception is a native-leg component with no base volume, a rate of 0: `amount` 0, `rate` 0, `converted` its
 * native volume). A trade component has a `counter` (the other side of the market); a pool component too (the other asset of the
 * pool, its `component` the pool account); a payment component is a currency alone.
 */
interface VolumeComponent {
  component: string;
  base: Asset;
  counter?: Asset;
  amount: BigNumber;
  count: number;
  rate: BigNumber;
  converted: BigNumber;
  /** A pool component of the live day set only: its estimated fees in the native currency, null when not known (D2b.3). */
  feesEst?: BigNumber | null;
}

const ZERO = new BigNumber(0);

/** Largest converted amount first; the same converted amount in the order of the ids, so that a set is deterministic. */
function byConverted(a: VolumeComponent, b: VolumeComponent): number {
  return b.converted.comparedTo(a.converted) || (a.component < b.component ? -1 : a.component > b.component ? 1 : 0);
}

/**
 * A market (or a pool) with what traded in a window, before it is converted to the native currency: the volume of its base
 * and of its counter, and how many trades. The trade components and the AMM components are made of these and converted by the
 * same code (`convertLegs`).
 */
interface Leg {
  component: string;
  base: Asset;
  counter: Asset;
  baseVolume: BigNumber;
  counterVolume: BigNumber;
  count: number;
}

/**
 * How many units of an asset one native coin buys, from the legs against the native currency (the base of the leg, which the
 * native counter is the price of): the base volume over the native volume of a leg that traded.
 */
function nativeRatesOf(legs: readonly Leg[], native: string): Map<string, BigNumber> {
  const rates = new Map<string, BigNumber>();
  for (const m of legs) {
    if (isNative(m.counter, native) && m.count > 0 && m.counterVolume.gt(0)) {
      rates.set(assetKey(m.base), ratio(m.baseVolume, m.counterVolume));
    }
  }
  return rates;
}

/**
 * The legs converted to the native currency (`normalize` of `scripts/tradeVolume.js`):
 *  - a leg against the native currency: `amount` is the volume of the base, `converted` the volume of the native side and
 *    `rate` its own base volume over native volume (units of the base for one native coin);
 *  - any other leg is converted through the rate of its base in `nativeRate`; if that has none, through the rate of its
 *    counter: base and counter are swapped then and `amount` is the counter volume;
 *  - a leg without trades, or without a rate for either side, is dropped.
 * The order of the result is that of the legs; the caller drops what converted to nothing and sorts.
 */
function convertLegs(
  legs: readonly Leg[],
  nativeRate: ReadonlyMap<string, BigNumber>,
  native: string,
): VolumeComponent[] {
  const out: VolumeComponent[] = [];
  for (const m of legs) {
    if (m.count === 0) continue;
    const baseRate = nativeRate.get(assetKey(m.base));
    const counterRate = nativeRate.get(assetKey(m.counter));
    if (isNative(m.counter, native)) {
      if (m.counterVolume.gt(0))
        out.push({
          component: m.component,
          base: m.base,
          counter: m.counter,
          amount: m.baseVolume,
          count: m.count,
          rate: ratio(m.baseVolume, m.counterVolume),
          converted: m.counterVolume,
        });
    } else if (baseRate?.gt(0)) {
      out.push({
        component: m.component,
        base: m.base,
        counter: m.counter,
        amount: m.baseVolume,
        count: m.count,
        rate: baseRate,
        converted: ratio(m.baseVolume, baseRate),
      });
    } else if (counterRate?.gt(0)) {
      out.push({
        component: m.component,
        base: m.counter,
        counter: m.base,
        amount: m.counterVolume,
        count: m.count,
        rate: counterRate,
        converted: ratio(m.counterVolume, counterRate),
      });
    }
  }
  return out;
}

/**
 * The configured markets with what traded in them in a window (`getVolumes` of `scripts/tradeVolume.js`). With `bases`, only
 * the markets against the native currency whose base is one of those assets (the markets a rate of those assets comes from),
 * and nothing is read when there are none.
 */
async function tradeLegs(
  rates: RatesService,
  config: MarketsConfig,
  from: Date,
  toExclusive: Date,
  bases?: ReadonlySet<string>,
): Promise<Leg[]> {
  const native = rates.nativeCurrency;
  const markets = marketsOf(config, native).filter(
    (m) => bases === undefined || (isNative(m.counter, native) && bases.has(assetKey(m.base))),
  );
  if (markets.length === 0) return [];
  const vwaps = await rates.vwaps(markets, from, toExclusive);
  return markets.map((market, i) => ({ ...market, ...vwaps[i] }));
}

/**
 * The trade components of a window (`getVolumes`, `getRates`, `normalize` of `scripts/tradeVolume.js`):
 *  - a market against the native currency: `amount` is the volume of the base, `converted` the volume of the native side
 *    and `rate` 1/vwap (units of the base for one native coin); its rate also converts the other markets that have this
 *    base or counter;
 *  - any other market is converted through the rate of its base; if that has none, through the rate of its counter: base
 *    and counter are swapped then and `amount` is the counter volume;
 *  - a market without trades, or without a rate for either side, is dropped.
 *
 * Deviation from the original, which kept `vwap / rate` as the `rate` of the markets converted through a leg (a number in
 * counter · native / base², while `converted_amount` was `amount / rate` of the leg): the rate is that of the leg, so that
 * `converted = amount / rate` holds for every component, and so does it for the sums of days and after the conversion to a
 * display currency.
 */
async function tradeComponents(
  rates: RatesService,
  config: MarketsConfig,
  from: Date,
  toExclusive: Date,
): Promise<VolumeComponent[]> {
  const native = rates.nativeCurrency;
  const legs = await tradeLegs(rates, config, from, toExclusive);
  return convertLegs(legs, nativeRatesOf(legs, native), native)
    .filter((c) => c.converted.gt(0))
    .sort(byConverted);
}

/**
 * A pool as a leg, with the native currency as its counter when it has one: the legs against the native currency have it so
 * (a market the config lists with it as the base is turned round the same way), and a pool whose canonical pair puts the native
 * currency first (XRP against a currency that sorts after it) is turned round, base and counter volumes with it.
 */
function poolLeg(p: AmmPoolVolume, native: string): Leg {
  const leg: Leg = {
    component: p.account,
    base: p.base,
    counter: p.counter,
    baseVolume: p.baseVolume,
    counterVolume: p.counterVolume,
    count: p.count,
  };
  return isNative(p.base, native)
    ? { ...leg, base: p.counter, counter: p.base, baseVolume: p.counterVolume, counterVolume: p.baseVolume }
    : leg;
}

/** The estimate of one side of a pool in the native currency: `fees x converted / volume`, see `componentFeesEst`. */
function sideFeesEst(fees: string | null, volume: BigNumber, converted: BigNumber): BigNumber | null {
  if (fees === null) return null;
  const sum = new BigNumber(fees);
  // no fees add 0 whatever the volume: nothing is divided, so a side without volume gives no NaN
  if (sum.isZero()) return ZERO;
  return volume.gt(0) ? ratio(sum.times(converted), volume) : null;
}

/**
 * The estimated fees of an AMM component in the native currency (D2b.3, D8): with S the asset of its `amount` (its `base`) and
 * O the other asset of the pool, `fees_S x converted / amount + fees_O x converted / volume_O`. The fees of O are priced in S by
 * the pool itself (times `amount / volume_O`, its own average price in the window) and both are converted like the component's
 * volume (times `converted / amount`). `totals` are the fees of the pool's swaps by side (`swapTotals`: every swap of the
 * window), `pool` is the pool as stored, before `poolLeg` turns it, with the volumes of its kept swaps (`ammPoolVolumes`: the
 * native dust left out); the component's `base` says which of its sides is S (a pool turned round, or converted through its
 * counter, has the sides swapped). Null when the fees of a side are not known (Ruling R-A26: part of the fees is never shown as
 * all of them), or are above 0 while the volume of that side is not (nothing prices them); a side without fees adds 0.
 */
export function componentFeesEst(
  component: { base: Asset; amount: BigNumber; converted: BigNumber },
  pool: { base: Asset; counter: Asset; baseVolume: BigNumber; counterVolume: BigNumber },
  totals: SwapTotals,
): BigNumber | null {
  const amountIsBase = assetKey(component.base) === assetKey(pool.base);
  const own = sideFeesEst(
    amountIsBase ? totals.fees_base_est : totals.fees_counter_est,
    component.amount,
    component.converted,
  );
  const other = sideFeesEst(
    amountIsBase ? totals.fees_counter_est : totals.fees_base_est,
    amountIsBase ? pool.counterVolume : pool.baseVolume,
    component.converted,
  );
  return own === null || other === null ? null : own.plus(other);
}

/**
 * The AMM components of a window (Rulings R-A18 and R-A19): the swaps against the pools that closed in `[from, toExclusive)`,
 * a component per pool, whose `component` is the pool account and `amount` the volume of its base. The pools, their pairs and
 * their swaps are read through the keys of the tables (`ammPoolVolumes`), never a scan of the exchanges across the pairs, and
 * only committed ledgers are read: the window becomes a range of the ledgers that are in `ledgers`.
 *
 * Every pool with swaps counts, not only the configured markets, and it is converted like a trade component (`convertLegs`)
 * with the units of its assets per native coin taken from, in this order:
 *  1. the configured markets against the native currency in the window (as the trade components take them);
 *  2. for an asset they have none for, the pools against the native currency in the window: the base volume over the native
 *     volume of all of them together.
 * A pool against the native currency is converted to its own native volume; the others through the rate of their base, else
 * of their counter; a pool with no rate for either asset is dropped. Only the pools that are not against the native currency
 * use a rate, so only the markets of their two assets are read, and none when there is no such pool.
 *
 * With `withFees` (the live day set, D2b.3) each component also gets `feesEst`, its fees in the window converted like its
 * volume (`componentFeesEst`): the swaps of the listed pools are read one by one for it, with the fee state they came into the
 * window with (`ammWindowSwapTotals`).
 */
async function ammComponents(
  ch: ClickHouseService,
  rates: RatesService,
  config: MarketsConfig,
  from: Date,
  toExclusive: Date,
  withFees: boolean,
): Promise<VolumeComponent[]> {
  const native = rates.nativeCurrency;
  const range = await rates.ledgersClosedIn(from, toExclusive);
  if (!range) return [];
  const stored = await ammPoolVolumes(ch, range);
  const pools = stored.map((p) => poolLeg(p, native));
  if (pools.length === 0) return [];

  const needed = new Set<string>();
  for (const p of pools) {
    if (!isNative(p.counter, native)) {
      needed.add(assetKey(p.base));
      needed.add(assetKey(p.counter));
    }
  }
  const nativeRate = nativeRatesOf(await tradeLegs(rates, config, from, toExclusive, needed), native);
  const fromPools = new Map<string, { base: BigNumber; native: BigNumber }>();
  for (const p of pools) {
    if (!isNative(p.counter, native) || !p.counterVolume.gt(0)) continue;
    const sums = fromPools.get(assetKey(p.base)) ?? { base: ZERO, native: ZERO };
    fromPools.set(assetKey(p.base), { base: sums.base.plus(p.baseVolume), native: sums.native.plus(p.counterVolume) });
  }
  for (const [key, sums] of fromPools)
    if (!nativeRate.get(key)?.gt(0)) nativeRate.set(key, ratio(sums.base, sums.native));

  const components = convertLegs(pools, nativeRate, native)
    .filter((c) => c.converted.gt(0))
    .sort(byConverted);
  if (!withFees || components.length === 0) return components;

  // the pools as stored (the leg may be turned round), for the listed components only
  const byAccount = new Map(stored.map((p) => [p.account, p]));
  const listed = components.map((c) => byAccount.get(c.component) as AmmPoolVolume);
  const totals = await ammWindowSwapTotals(
    ch,
    listed.map((p) => ({
      account: p.account,
      pair: [p.base.currency, p.base.issuer ?? '', p.counter.currency, p.counter.issuer ?? ''] as const,
    })),
    { first: range.min, last: range.max },
  );
  return components.map((c, i) => ({
    ...c,
    feesEst: componentFeesEst(c, listed[i], totals.get(c.component) as SwapTotals),
  }));
}

/**
 * The components of a metric in a window `[from, toExclusive)`; a payment is converted at the rate of `from`. `withFees` gives
 * the AMM components their fee estimates (the live day set); the other metrics have none.
 */
function componentsOf(
  ch: ClickHouseService,
  rates: RatesService,
  config: MarketsConfig,
  metric: VolumeMetric,
  from: Date,
  toExclusive: Date,
  withFees = false,
): Promise<VolumeComponent[]> {
  switch (metric) {
    case 'trade_volume':
      return tradeComponents(rates, config, from, toExclusive);
    case 'payment_volume':
      return paymentComponents(ch, rates, config, from, toExclusive, from);
    case 'amm_volume':
      return ammComponents(ch, rates, config, from, toExclusive, withFees);
  }
}

/** The sums of the payments of one currency in a window. */
interface PaymentSums {
  count: number;
  amount: BigNumber;
}

interface PaymentSumsRow {
  currency: string;
  issuer: string;
  n: number | string;
  sum_exact: string | null;
  unfit: number | string;
  sum_f: number | null;
}

/**
 * The payments of some currencies in a range of ledgers, a group per currency: the narrow index `payments_by_currency`
 * (ordered by currency, issuer, ledger) gives the payments of the currencies, the wide `payments` the delivered amounts. Each
 * payment counts once (`LIMIT 1 BY` its key: a table that was written twice is not collapsed before a merge, and no FINAL
 * is used). The sums are exact decimals (a Float64 sum when an amount does not fit one, see `query/decimal`).
 */
async function paymentSums(
  ch: ClickHouseService,
  assets: Asset[],
  range: LedgerRange,
): Promise<Map<string, PaymentSums>> {
  const rows = await ch.query<PaymentSumsRow>(
    `SELECT currency, issuer,
            toUInt32(count()) AS n,
            ${exactSum('delivered_exact')} AS sum_exact,
            toUInt32(countIf(delivered_exact IS NULL)) AS unfit,
            ${floatSum('delivered_amount_f')} AS sum_f
       FROM (SELECT currency, issuer, ${exactAmount('delivered_amount')} AS delivered_exact, delivered_amount_f
               FROM ${Table.Payments}
              WHERE (ledger_index, tx_index) IN (
                    SELECT ledger_index, tx_index
                      FROM ${Table.PaymentsByCurrency}
                     WHERE (currency, issuer) IN (SELECT arrayJoin(arrayZip({currencies:Array(String)}, {issuers:Array(String)})))
                       AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                     ORDER BY currency, issuer, ledger_index, tx_index
                    )
                AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
              ORDER BY ledger_index, tx_index
              LIMIT 1 BY ledger_index, tx_index)
      GROUP BY currency, issuer`,
    {
      currencies: assets.map((a) => a.currency),
      issuers: assets.map((a) => a.issuer ?? ''),
      min: range.min,
      max: range.max,
    },
  );
  return new Map(
    rows.map((r) => [
      assetKey({ currency: r.currency, ...(r.issuer && { issuer: r.issuer }) }),
      { count: Number(r.n), amount: sumOf(Number(r.unfit), r.sum_exact, r.sum_f) },
    ]),
  );
}

/** `fn` over `items`, at most `limit` at a time; the results come in the order of the items. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The payment components of a window (`scripts/paymentVolume.js`): the configured currencies and the native currency that
 * have payments in it. `amount` is the sum of the delivered amounts, `rate` the units of the currency one native coin
 * bought at `rateDate` (the start of the window: the exchange rate of `RatesService`, 0 when it cannot be told), and
 * `converted = amount / rate`, 0 without a rate. Like the original, a currency with payments but without a rate is still
 * a row: its payments are in the count of the set, and readers leave it out of the components.
 */
async function paymentComponents(
  ch: ClickHouseService,
  rates: RatesService,
  config: MarketsConfig,
  from: Date,
  toExclusive: Date,
  rateDate: Date,
): Promise<VolumeComponent[]> {
  const native = rates.nativeCurrency;
  const range = await rates.ledgersClosedIn(from, toExclusive);
  if (!range) return [];
  const assets = paymentAssetsOf(config, native);
  const sums = await paymentSums(ch, assets, range);
  const present = assets.filter((a) => (sums.get(assetKey(a))?.count ?? 0) > 0);
  const components = await mapLimit(present, RATE_CONCURRENCY, async (a): Promise<VolumeComponent> => {
    const { count, amount } = sums.get(assetKey(a)) as PaymentSums;
    const rate = isNative(a, native)
      ? new BigNumber(1)
      : await rates.exchangeRate({ currency: native }, a, { date: rateDate });
    return { component: assetKey(a), base: a, amount, count, rate, converted: rate.gt(0) ? ratio(amount, rate) : ZERO };
  });
  return components.sort(byConverted);
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing a set
// ---------------------------------------------------------------------------------------------------------------------

type SetRow = Omit<VolumeDailyRow, 'day'>;

/** A row of a live set: those of `setRows`, with the fee estimate of its own component. */
type LiveSetRow = SetRow & Pick<VolumeLiveRow, 'fees_est_f'>;

/**
 * The rows of a set: the sentinel first, then the components. The `rate_f` of a daily sentinel is 1 when the set is the final
 * one of its day (`final`, see `computeDailyVolumeSet`), else 0; a live set's is 0. With `withFees` (a live set) each row also
 * has `fees_est_f`, taken from its own component (`feesEst`; NULL on the sentinel and where it is not known); a daily row has no
 * such column.
 */
function setRows(
  metric: VolumeMetric,
  components: VolumeComponent[],
  configVersion: number,
  version: number,
  final?: boolean,
): SetRow[];
function setRows(
  metric: VolumeMetric,
  components: VolumeComponent[],
  configVersion: number,
  version: number,
  final: boolean,
  withFees: true,
): LiveSetRow[];
function setRows(
  metric: VolumeMetric,
  components: VolumeComponent[],
  configVersion: number,
  version: number,
  final = false,
  withFees = false,
): SetRow[] {
  const row = (c: VolumeComponent | undefined): SetRow => ({
    metric,
    component: c?.component ?? '',
    base_currency: c?.base.currency ?? '',
    base_issuer: c?.base.issuer ?? '',
    counter_currency: c?.counter?.currency ?? '',
    counter_issuer: c?.counter?.issuer ?? '',
    amount: c ? c.amount.toString() : '0',
    amount_f: c ? c.amount.toNumber() : 0,
    count: c?.count ?? 0,
    rate_f: c ? c.rate.toNumber() : final ? 1 : 0,
    converted_f: c ? c.converted.toNumber() : 0,
    config_version: configVersion,
    version,
    ...(withFees && { fees_est_f: c?.feesEst?.toNumber() ?? null }),
  });
  return [row(undefined), ...components.map(row)];
}

/**
 * The version of the next set of a (metric, day|period): the ClickHouse clock in milliseconds, but one past the newest
 * version the set has now. (`amm_daily` takes its versions the same way, from the sentinel row of the day.)
 */
export async function nextVersion(
  ch: ClickHouseService,
  table: Table.VolumeDaily | Table.VolumeLive | Table.AmmDaily,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  const [row] = await ch.query<{ newest: number | string; now_ms: number | string }>(
    `SELECT toUInt64(max(version)) AS newest, toUnixTimestamp64Milli(now64(3)) AS now_ms FROM ${table} WHERE ${where}`,
    params,
  );
  return Math.max(Number(row?.now_ms ?? Date.now()), Number(row?.newest ?? 0) + 1);
}

/** The start of the UTC day of a date, unix seconds; an invalid date is a `RangeError`. */
export function dayStartSeconds(date: Date): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Invalid date');
  return Math.floor(ms / 1000 / DAY_SECONDS) * DAY_SECONDS;
}

/** `YYYY-MM-DD` of the UTC day that starts at, or contains, a time in unix seconds. */
export const dayKey = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
/** The date of a time in unix seconds. */
export const at = (seconds: number): Date => new Date(seconds * 1000);

/**
 * A daily set is the FINAL one of its day when the ledgers had been ingested past the day when it was written: the newest
 * ledger closed at least this long after the day's end (ledger time, not wall clock: after an outage, or with an ingest that
 * started at an old ledger, the wall clock says nothing about which ledgers are in). The ledgers are ingested in order, so
 * then every ledger of the day is in `ledgers`.
 */
export const VOLUME_DAY_SETTLE_MS = 3_600_000;

/** The close time of the newest ingested ledger (the highest index: a read of the end of the primary key), unix seconds. */
async function newestLedgerClose(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ closed: number | string }>(
    `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
  );
  return row === undefined ? undefined : Number(row.closed);
}

/**
 * Recomputes the daily set of a metric for the UTC day of `day`, and writes it: the sentinel and the components, one version,
 * one insert. Returns how many components it wrote. Trades and payments that closed in `[00:00, 24:00)` count, and a
 * payment is converted at the rate of the start of the day.
 *
 * The `rate_f` of the sentinel says whether the set is the final one of its day: 1 when the newest ledger had closed
 * `VOLUME_DAY_SETTLE_MS` after the end of the day when the set was read (read BEFORE the trades and payments, so that all
 * ledgers up to it are in what the set counted), else 0. `volumeDaysDone` counts a day as done only for a final set.
 */
export async function computeDailyVolumeSet(
  ch: ClickHouseService,
  rates: RatesService,
  markets: MarketsConfig,
  metric: VolumeMetric,
  day: Date,
  options: VolumeOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfAborted(signal);
  const start = dayStartSeconds(day);
  const [from, to] = [at(start), at(start + DAY_SECONDS)];
  const newest = await newestLedgerClose(ch);
  const final = newest !== undefined && newest >= start + DAY_SECONDS + VOLUME_DAY_SETTLE_MS / 1000;
  const components = await componentsOf(ch, rates, markets, metric, from, to);
  const version = await nextVersion(ch, Table.VolumeDaily, 'metric = {metric:String} AND day = {day:Date}', {
    metric,
    day: dayKey(start),
  });
  throwIfAborted(signal);
  const rows = setRows(metric, components, markets.version, version, final).map(
    (r): VolumeDailyRow => ({ ...r, day: dayKey(start) }),
  );
  await ch.insert(Table.VolumeDaily, rows);
  return components.length;
}

/**
 * Recomputes the live set of a metric for a period and writes it: the window is `[now - period, now)`, whole seconds, and
 * every row carries its start and end. A payment is converted at the rate of the start of the window. The components of the
 * AMM volume's day set carry their fee estimates (`fees_est_f`, D2b.3; NULL when not known); its sentinel and the rows of every
 * other set have NULL there (the longer periods would read up to 30 days of swaps at every tick).
 */
export async function computeLiveVolumeSet(
  ch: ClickHouseService,
  rates: RatesService,
  markets: MarketsConfig,
  metric: VolumeMetric,
  period: LivePeriod,
  now: Date,
  options: VolumeOptions = {},
): Promise<number> {
  const { signal } = options;
  if (!livePeriodsOf(metric).includes(period)) {
    throw new RangeError(`${metric} has no live period ${period}`);
  }
  throwIfAborted(signal);
  if (Number.isNaN(now.getTime())) throw new RangeError('Invalid date');
  const end = Math.floor(now.getTime() / 1000);
  const start = end - LIVE_PERIOD_SECONDS[period];
  const [from, to] = [at(start), at(end)];
  const components = await componentsOf(ch, rates, markets, metric, from, to, period === 'day');
  const version = await nextVersion(ch, Table.VolumeLive, 'metric = {metric:String} AND period = {period:String}', {
    metric,
    period,
  });
  throwIfAborted(signal);
  const rows = setRows(metric, components, markets.version, version, false, true).map(
    (r): VolumeLiveRow => ({ ...r, period, start_time: start, end_time: end }),
  );
  await ch.insert(Table.VolumeLive, rows);
  return components.length;
}

/**
 * The live sets of every metric, every period (trade and AMM: hour, day, 3day, 7day, 30day; payment: hour, day), one after the
 * other.
 */
export async function computeLiveVolumes(
  ch: ClickHouseService,
  rates: RatesService,
  markets: MarketsConfig,
  now: Date,
  options: VolumeOptions = {},
): Promise<void> {
  for (const metric of VOLUME_METRICS) {
    for (const period of livePeriodsOf(metric)) {
      await computeLiveVolumeSet(ch, rates, markets, metric, period, now, options);
    }
  }
}

/** The daily sets of every metric for the UTC day of `day`. */
export async function computeDailyVolumes(
  ch: ClickHouseService,
  rates: RatesService,
  markets: MarketsConfig,
  day: Date,
  options: VolumeOptions = {},
): Promise<void> {
  for (const metric of VOLUME_METRICS) {
    await computeDailyVolumeSet(ch, rates, markets, metric, day, options);
  }
}

/**
 * The days of `[from, toExclusive)` (UTC days: both are cut to their midnight) that are done for `metric`: the newest daily
 * set of the day was made with `configVersion` AND is a final set (its sentinel says the ingest had passed the day, see
 * `computeDailyVolumeSet`). A day whose set has another version is not in it, so it is computed again after a config change;
 * neither is a day whose newest set was made while its ledgers were not all in (the aggregator ran during the day, the
 * ingest was behind after an outage, the ingest started at an old ledger). A day with only a sentinel (no volume) is. Each day
 * counts by its newest sentinel, and a set that was stored twice counts once. Returns the days as `YYYY-MM-DD`.
 */
export async function volumeDaysDone(
  ch: ClickHouseService,
  metric: VolumeMetric,
  from: Date,
  toExclusive: Date,
  configVersion: number,
): Promise<Set<string>> {
  const first = dayStartSeconds(from);
  const until = dayStartSeconds(toExclusive);
  if (first >= until) return new Set();
  const rows = await ch.query<{ day: string }>(
    `SELECT toString(day) AS day
       FROM (SELECT day, config_version, rate_f
               FROM ${Table.VolumeDaily}
              WHERE metric = {metric:String} AND component = '' AND day >= {from:Date} AND day < {until:Date}
              ORDER BY day ASC, version DESC
              LIMIT 1 BY day)
      WHERE config_version = {configVersion:UInt32} AND rate_f = 1`,
    { metric, from: dayKey(first), until: dayKey(until), configVersion },
  );
  return new Set(rows.map((r) => r.day));
}

/**
 * The newest version of every live set there is, keyed `<metric>/<period>` (`trade_volume/hour`): when each was last written.
 * A set that has never been written is not in it. The aggregator starts with the stalest set, so that none starves.
 */
export async function liveSetVersions(ch: ClickHouseService): Promise<Map<string, number>> {
  const rows = await ch.query<{ metric: string; period: string; version: number | string }>(
    `SELECT metric, period, toUInt64(max(version)) AS version FROM ${Table.VolumeLive} GROUP BY metric, period`,
  );
  return new Map(rows.map((r) => [`${r.metric}/${r.period}`, Number(r.version)]));
}

/**
 * The newest version of the daily sets of the days of `[from, to]` (UTC days), keyed `<metric>/<YYYY-MM-DD>`; a set that
 * does not exist is not in it.
 */
export async function dailySetVersions(ch: ClickHouseService, from: Date, to: Date): Promise<Map<string, number>> {
  const first = dayStartSeconds(from);
  const last = dayStartSeconds(to);
  if (first > last) return new Map();
  const rows = await ch.query<{ metric: string; day_text: string; version: number | string }>(
    `SELECT metric, toString(day) AS day_text, toUInt64(max(version)) AS version
       FROM ${Table.VolumeDaily}
      WHERE day >= {from:Date} AND day <= {to:Date}
      GROUP BY metric, day`,
    { from: dayKey(first), to: dayKey(last) },
  );
  return new Map(rows.map((r) => [`${r.metric}/${r.day_text}`, Number(r.version)]));
}

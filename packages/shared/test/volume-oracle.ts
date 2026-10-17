import BigNumber from 'bignumber.js';
import { ExchangesRow, PaymentsRow } from '../src/clickhouse/rows';
import { MarketAsset, MarketsConfig } from '../src/network';
import { Asset, assetKey } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';

/**
 * The oracle of the volume tests: what the trade volume and the payment volume of a window have to be, worked out in plain
 * JavaScript and BigNumber from the rows the ledger writer stores (`exchanges`, `payments`), by the algorithm of the original's
 * `scripts/tradeVolume.js` and `scripts/paymentVolume.js` (with the deviation the job documents: the rate of a component is the
 * rate of the leg it is converted through). It never uses the code under test, except `RatesService.exchangeRate` for the rate
 * a payment currency is converted with, which has its oracle in `rates.e2e-spec.ts`.
 *
 * Used by the volume job tests (`volume-job.e2e-spec.ts`) and by the API's (`apps/api/test/volume.e2e-spec.ts`).
 */

const XRP: Asset = { currency: 'XRP' };
const at = (seconds: number): Date => new Date(seconds * 1000);

export const key = (a: MarketAsset): string =>
  assetKey({ currency: a.currency, ...(a.issuer && { issuer: a.issuer }) });
export const isNative = (a: MarketAsset): boolean => a.currency === 'XRP' && !a.issuer;
export const asset = (a: MarketAsset): Asset => ({ currency: a.currency, ...(a.issuer && { issuer: a.issuer }) });

// ---------------------------------------------------------------------------------------------------------------------
// The oracle for trades: the algorithm of `scripts/tradeVolume.js` over the stored exchanges, in BigNumber.
// ---------------------------------------------------------------------------------------------------------------------

export interface ExpectedComponent {
  component: string;
  base: Asset;
  counter: Asset;
  amount: BigNumber;
  count: number;
  converted: BigNumber;
  rate: BigNumber;
}

export const DUST = new BigNumber('0.0005');
export const Wide = BigNumber.clone({ DECIMAL_PLACES: 200 });

/** The trades of a market that closed in `[from, to)`: count and volumes of the market as asked (native dust out). */
export function tradesOf(rows: ExchangesRow[], base: Asset, counter: Asset, from: number, to: number) {
  let count = 0;
  let baseVolume = new BigNumber(0);
  let counterVolume = new BigNumber(0);
  for (const r of rows) {
    if (r.close_time < from || r.close_time >= to) continue;
    const storedBase = assetKey({ currency: r.base_currency, ...(r.base_issuer && { issuer: r.base_issuer }) });
    const storedCounter = assetKey({
      currency: r.counter_currency,
      ...(r.counter_issuer && { issuer: r.counter_issuer }),
    });
    const direct = storedBase === assetKey(base) && storedCounter === assetKey(counter);
    const reverse = storedBase === assetKey(counter) && storedCounter === assetKey(base);
    if (!direct && !reverse) continue;
    if (
      (r.base_issuer === '' && new BigNumber(r.base_amount).lte(DUST)) ||
      (r.counter_issuer === '' && new BigNumber(r.counter_amount).lte(DUST))
    ) {
      continue;
    }
    count++;
    baseVolume = baseVolume.plus(direct ? r.base_amount : r.counter_amount);
    counterVolume = counterVolume.plus(direct ? r.counter_amount : r.base_amount);
  }
  return { count, baseVolume, counterVolume };
}

export function tradeOracle(
  markets: MarketsConfig,
  rows: ExchangesRow[],
  from: number,
  to: number,
): ExpectedComponent[] {
  const seen = new Set<string>();
  const configured = markets.tradeMarkets
    .map((m) =>
      isNative(m.base)
        ? { base: asset(m.counter), counter: asset(m.base) }
        : { base: asset(m.base), counter: asset(m.counter) },
    )
    .filter((m) => {
      const k = [assetKey(m.base), assetKey(m.counter)].sort().join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const items = configured.map((m) => ({ ...m, ...tradesOf(rows, m.base, m.counter, from, to) }));
  const nativeRates = new Map<string, BigNumber>();
  for (const m of items) {
    if (m.counter.currency === 'XRP' && !m.counter.issuer && m.count > 0 && m.counterVolume.gt(0)) {
      nativeRates.set(assetKey(m.base), new Wide(m.baseVolume).dividedBy(m.counterVolume));
    }
  }
  const out: ExpectedComponent[] = [];
  for (const m of items) {
    if (m.count === 0) continue;
    const component = `${assetKey(m.base)}/${assetKey(m.counter)}`;
    if (m.counter.currency === 'XRP' && !m.counter.issuer) {
      if (m.counterVolume.gt(0)) {
        out.push({
          component,
          base: m.base,
          counter: m.counter,
          amount: m.baseVolume,
          count: m.count,
          converted: m.counterVolume,
          rate: nativeRates.get(assetKey(m.base)) as BigNumber,
        });
      }
    } else if (nativeRates.get(assetKey(m.base))?.gt(0)) {
      const r = nativeRates.get(assetKey(m.base)) as BigNumber;
      out.push({
        component,
        base: m.base,
        counter: m.counter,
        amount: m.baseVolume,
        count: m.count,
        converted: new Wide(m.baseVolume).dividedBy(r),
        rate: r,
      });
    } else if (nativeRates.get(assetKey(m.counter))?.gt(0)) {
      const r = nativeRates.get(assetKey(m.counter)) as BigNumber;
      out.push({
        component,
        base: m.counter,
        counter: m.base,
        amount: m.counterVolume,
        count: m.count,
        converted: new Wide(m.counterVolume).dividedBy(r),
        rate: r,
      });
    }
  }
  return out
    .filter((c) => c.converted.gt(0))
    .sort((a, b) => b.converted.comparedTo(a.converted) || (a.component < b.component ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle for payments: the sums of the stored payments per currency; the rate is `RatesService.exchangeRate`.
// ---------------------------------------------------------------------------------------------------------------------

export async function paymentOracle(
  markets: MarketsConfig,
  rates: Pick<RatesService, 'exchangeRate'>,
  rows: PaymentsRow[],
  from: number,
  to: number,
  rateDate: number,
): Promise<
  { component: string; asset: Asset; amount: BigNumber; count: number; rate: BigNumber; converted: BigNumber }[]
> {
  const wanted = new Map<string, Asset>();
  for (const a of [...markets.paymentCurrencies, XRP]) wanted.set(key(a), asset(a));
  const out = [];
  for (const [component, a] of wanted) {
    const mine = rows.filter(
      (r) => r.close_time >= from && r.close_time < to && r.currency === a.currency && r.issuer === (a.issuer ?? ''),
    );
    if (mine.length === 0) continue;
    const amount = mine.reduce((sum, r) => sum.plus(r.delivered_amount), new BigNumber(0));
    const rate = isNative(a) ? new BigNumber(1) : await rates.exchangeRate(XRP, a, { date: at(rateDate) });
    out.push({
      component,
      asset: a,
      amount,
      count: mine.length,
      rate,
      converted: rate.gt(0) ? new Wide(amount).dividedBy(rate) : new BigNumber(0),
    });
  }
  return out.sort((a, b) => b.converted.comparedTo(a.converted) || (a.component < b.component ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle for the AMM volume: the swaps of each pool in a window, converted like trade components (Ruling R-A19).
// ---------------------------------------------------------------------------------------------------------------------

export interface ExpectedAmm {
  /** The pool account. */
  component: string;
  base: Asset;
  counter: Asset;
  amount: BigNumber;
  count: number;
  converted: BigNumber;
  rate: BigNumber;
}

interface PoolSums {
  account: string;
  base: Asset;
  counter: Asset;
  count: number;
  baseVolume: BigNumber;
  counterVolume: BigNumber;
}

/**
 * How many units of an asset one native coin buys, from the configured trade markets against the native currency in a
 * window (the first source of Ruling R-A19: exactly how the trade components build it).
 */
export function marketNativeRates(
  markets: MarketsConfig,
  rows: ExchangesRow[],
  from: number,
  to: number,
): Map<string, BigNumber> {
  const seen = new Set<string>();
  const rates = new Map<string, BigNumber>();
  for (const m of markets.tradeMarkets) {
    const [base, counter] = isNative(m.base) ? [asset(m.counter), asset(m.base)] : [asset(m.base), asset(m.counter)];
    const id = [assetKey(base), assetKey(counter)].sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    if (counter.currency !== 'XRP' || counter.issuer) continue;
    const t = tradesOf(rows, base, counter, from, to);
    if (t.count > 0 && t.counterVolume.gt(0))
      rates.set(assetKey(base), new Wide(t.baseVolume).dividedBy(t.counterVolume));
  }
  return rates;
}

/**
 * The AMM components of `[from, to)` over the stored exchanges (order-book rows and swaps alike; only the rows with an
 * `amm_account` are the pools'). Plain JavaScript over the rows, never the job:
 *  - a swap whose native leg is 0.0005 or less is left out; the others add up per pool (`amm_account`);
 *  - a pool with the native currency as its base is turned round, so that the native currency is the counter;
 *  - the units of an asset per native coin come from the markets against the native currency first, and for an asset they
 *    have none for from the pools against the native currency in the window (all the base volume over all the native
 *    volume of such pools);
 *  - a pool against the native currency: `converted` is its native volume and `rate` its own base volume over native volume;
 *    any other pool through the rate of its base, else through the rate of its counter (swapped, `amount` the counter
 *    volume); a pool without a rate on either side is dropped; largest converted amount first, then the account.
 */
export function ammVolumeOracle(markets: MarketsConfig, rows: ExchangesRow[], from: number, to: number): ExpectedAmm[] {
  const pools = new Map<string, PoolSums>();
  for (const r of rows) {
    if (r.amm_account === '' || r.close_time < from || r.close_time >= to) continue;
    if (
      (r.base_issuer === '' && new BigNumber(r.base_amount).lte(DUST)) ||
      (r.counter_issuer === '' && new BigNumber(r.counter_amount).lte(DUST))
    ) {
      continue;
    }
    let pool = pools.get(r.amm_account);
    if (!pool) {
      pool = {
        account: r.amm_account,
        base: asset({ currency: r.base_currency, issuer: r.base_issuer }),
        counter: asset({ currency: r.counter_currency, issuer: r.counter_issuer }),
        count: 0,
        baseVolume: new BigNumber(0),
        counterVolume: new BigNumber(0),
      };
      pools.set(r.amm_account, pool);
    }
    pool.count++;
    pool.baseVolume = pool.baseVolume.plus(r.base_amount);
    pool.counterVolume = pool.counterVolume.plus(r.counter_amount);
  }
  const legs = [...pools.values()].map((p) =>
    isNative(p.base)
      ? { ...p, base: p.counter, counter: p.base, baseVolume: p.counterVolume, counterVolume: p.baseVolume }
      : p,
  );

  const rates = marketNativeRates(markets, rows, from, to);
  const fromPools = new Map<string, { base: BigNumber; native: BigNumber }>();
  for (const p of legs) {
    if (!isNative(p.counter) || p.count === 0 || !p.counterVolume.gt(0)) continue;
    const sums = fromPools.get(assetKey(p.base)) ?? { base: new BigNumber(0), native: new BigNumber(0) };
    sums.base = sums.base.plus(p.baseVolume);
    sums.native = sums.native.plus(p.counterVolume);
    fromPools.set(assetKey(p.base), sums);
  }
  for (const [k, sums] of fromPools) if (!rates.has(k)) rates.set(k, new Wide(sums.base).dividedBy(sums.native));

  const out: ExpectedAmm[] = [];
  for (const p of legs) {
    const baseRate = rates.get(assetKey(p.base));
    const counterRate = rates.get(assetKey(p.counter));
    if (isNative(p.counter)) {
      if (p.counterVolume.gt(0)) {
        out.push({
          component: p.account,
          base: p.base,
          counter: p.counter,
          amount: p.baseVolume,
          count: p.count,
          converted: p.counterVolume,
          rate: new Wide(p.baseVolume).dividedBy(p.counterVolume),
        });
      }
    } else if (baseRate?.gt(0)) {
      out.push({
        component: p.account,
        base: p.base,
        counter: p.counter,
        amount: p.baseVolume,
        count: p.count,
        converted: new Wide(p.baseVolume).dividedBy(baseRate),
        rate: baseRate,
      });
    } else if (counterRate?.gt(0)) {
      out.push({
        component: p.account,
        base: p.counter,
        counter: p.base,
        amount: p.counterVolume,
        count: p.count,
        converted: new Wide(p.counterVolume).dividedBy(counterRate),
        rate: counterRate,
      });
    }
  }
  return out
    .filter((c) => c.converted.gt(0))
    .sort((a, b) => b.converted.comparedTo(a.converted) || (a.component < b.component ? -1 : 1));
}

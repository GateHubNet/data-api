import BigNumber from 'bignumber.js';
import { Asset, assetKey } from './asset';
import type { DayRates } from './daily-rates';
import { ratio } from './decimal';

/**
 * The rule that turns an amount of an asset into native coins, which every value the API serves follows: the native
 * currency is worth itself, an issued amount is worth the amount over the rate of its asset on its UTC day.
 */

/** The significant digits of a quotient: what the double the original printed could tell apart. */
export const QUOTIENT_DIGITS = 17;

/**
 * What an amount of `asset` is worth in the native currency on `day` (`YYYY-MM-DD`).
 *
 * The native currency is worth itself, to the drop. An issued asset is worth 0 where it has no rate (none for the day, a
 * rate of 0 or below, or no issuer to have one); where it has one the quotient is cut to 17 significant digits, the
 * precision of the rate itself being what it is (BigNumber's own 20 decimal places would give a small value fewer digits
 * than a large one). The caller sums the values it gets, and a sum of values is exact.
 */
export function nativeValue(
  amount: BigNumber,
  asset: Asset,
  day: string,
  rates: DayRates,
  nativeCurrency: string,
): BigNumber {
  if (asset.currency === nativeCurrency && !asset.issuer) return amount;
  // an issued currency without an issuer has no rate to look up
  if (!asset.issuer) return new BigNumber(0);
  const rate = rates.get(assetKey(asset))?.get(day);
  if (!rate || !rate.gt(0)) return new BigNumber(0);
  return ratio(amount, rate).precision(QUOTIENT_DIGITS);
}

/**
 * The asset a balance change of `account` is in: the line is the asset of `(currency, counterparty)`, the counterparty
 * being its issuer, unless the account owes on it (its final balance is negative), when the account is the issuer. The
 * native line, which has no counterparty, is the currency alone.
 */
export function balanceChangeAsset(
  line: { currency: string; counterparty: string; owes: boolean },
  account: string,
): Asset {
  if (!line.counterparty) return { currency: line.currency };
  return { currency: line.currency, issuer: line.owes ? account : line.counterparty };
}

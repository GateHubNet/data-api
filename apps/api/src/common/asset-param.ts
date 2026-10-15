import type { Asset } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from './errors';

/** Which side of a pair a path segment is, so the message can say so (`base issuer is required`). */
export type AssetRole = 'base' | 'counter';

/** The two parts of `CUR+issuer`, as far as the text has them. The currency is upper-cased, the issuer as written. */
export interface AssetParts {
  currency?: string;
  issuer?: string;
}

const rolePrefix = (role?: AssetRole): string => (role ? `${role} ` : '');

/**
 * Splits `CUR+issuer` the way the Ripple routes do: at any of `+`, `|` or `.`, keeping only the first two parts. An
 * empty part counts as missing. This does not validate anything.
 */
export function splitAsset(raw: string): AssetParts {
  const [currency, issuer] = raw.split(/[+|.]/);
  return { currency: currency ? currency.toUpperCase() : undefined, issuer: issuer ? issuer : undefined };
}

// The checks, in the order Ripple makes them. `native` is the code of the network's own currency (no issuer).

function requireCurrency(a: AssetParts, role?: AssetRole): void {
  if (!a.currency) throw badRequest(`${rolePrefix(role)}currency is required`);
}

function rejectNativeIssuer(a: AssetParts, native: string): void {
  if (a.currency === native && a.issuer) throw badRequest(`${native} cannot have an issuer`);
}

function requireIssuer(a: AssetParts, native: string, role?: AssetRole): void {
  if (a.currency !== native && !a.issuer) throw badRequest(`${rolePrefix(role)}issuer is required`);
}

function requireValidIssuer(a: AssetParts, role?: AssetRole): void {
  if (a.issuer && !isValidClassicAddress(a.issuer)) throw badRequest(`invalid ${rolePrefix(role)}issuer address`);
}

/** The asset of checked parts: the native currency has no `issuer` key. */
function toAsset(a: AssetParts, native: string): Asset {
  return a.currency === native ? { currency: native } : { currency: a.currency as string, issuer: a.issuer as string };
}

/**
 * One asset from a path segment such as `USD+rvYAf…`. `native` is the network's native currency (`XRP` or `XAH`):
 * it must have no issuer, and every other currency, including `XRP` on Xahau, needs one. The issuer must be a classic
 * address. With a `role` the messages name the side (`base issuer is required`). Answers 400 with the Ripple message.
 */
export function parseAsset(raw: string, native: string, role?: AssetRole): Asset {
  const parts = splitAsset(raw);
  requireCurrency(parts, role);
  rejectNativeIssuer(parts, native);
  requireIssuer(parts, native, role);
  requireValidIssuer(parts, role);
  return toAsset(parts, native);
}

/**
 * The `{base}/{counter}` of an exchanges route. Ripple checks the pair for one mistake at a time rather than one side
 * at a time, so a pair with two mistakes gets the same message as there: both currencies, then the native currency
 * with an issuer on either side, then a missing issuer on either side.
 */
export function parseAssetPair(baseRaw: string, counterRaw: string, native: string): { base: Asset; counter: Asset } {
  const base = splitAsset(baseRaw);
  const counter = splitAsset(counterRaw);
  requireCurrency(base, 'base');
  requireCurrency(counter, 'counter');
  rejectNativeIssuer(base, native);
  rejectNativeIssuer(counter, native);
  requireIssuer(base, native, 'base');
  requireIssuer(counter, native, 'counter');
  requireValidIssuer(base, 'base');
  requireValidIssuer(counter, 'counter');
  return { base: toAsset(base, native), counter: toAsset(counter, native) };
}

/**
 * One asset from separate `currency` and `issuer` parameters. A missing currency is the native one, as in
 * `/v2/normalize` (`currency || 'XRP'`); with `defaultNative` off, a missing currency answers 400
 * `currency is required`.
 */
export function assetFromParts(
  currency: string | undefined,
  issuer: string | undefined,
  native: string,
  defaultNative = true,
): Asset {
  const parts: AssetParts = {
    currency: currency ? currency.toUpperCase() : defaultNative ? native : undefined,
    issuer: issuer ? issuer : undefined,
  };
  requireCurrency(parts);
  rejectNativeIssuer(parts, native);
  requireIssuer(parts, native);
  requireValidIssuer(parts);
  return toAsset(parts, native);
}

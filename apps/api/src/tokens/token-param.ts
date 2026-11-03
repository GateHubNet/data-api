import { currencyCode, ledgerCurrencyOf } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';

/** A token as the path names it: the currency in the ledger's form and the issuer. */
export interface TokenRef {
  /** The ledger's currency: 3 upper-case characters of rippled's set, or 40 upper-case hex digits. */
  currency: string;
  issuer: string;
}

/**
 * The token of a path segment `{currency}.{issuer}` (spec 5.2). The segment is split at its **last** `.`, `+` or `|` (an
 * address has none, so a text code may hold one): the code before it, the issuer after it. With no separator the issuer is
 * `''`, which is no address.
 *
 * The code is read by `ledgerCurrencyOf`: a 3-character code of the ledger's set is upper-cased (so a currency the ledger holds
 * in lower case, `usd`, is unreachable by path: `usd` names `USD`), 40 hex digits are the hex in upper case (or the 3
 * characters of the standard form they hold), a text of 4 to 20 characters is its hex, and only a 3-character code is
 * upper-cased (`a.b.c` and `A.B.C` are two currencies). Anything else, a 3-character code outside the ledger's set included
 * (`A-B`), is no currency.
 *
 * Answers 400 with the first of these that fails: `invalid currency`; `${native} cannot have an issuer` (the network's own
 * code with an issuer, tested on the ledger's form so that the standard hex of `XRP` is caught too; on Xahau `XRP` is a currency
 * like any other); `invalid issuer address` (a classic address is required, an X-address is not one).
 */
export function parseTokenParam(raw: string, native: 'XRP' | 'XAH'): TokenRef {
  const { code, issuer } = splitTokenParam(raw);

  const currency = ledgerCurrencyOf(code);
  if (currency === undefined) throw badRequest('invalid currency');
  if (currency === native && issuer !== '') throw badRequest(`${native} cannot have an issuer`);
  if (!isValidClassicAddress(issuer)) throw badRequest('invalid issuer address');
  return { currency, issuer };
}

/** The segment split at its last `.`, `+` or `|`: the code before it and the issuer after it (`''` when there is no separator). */
function splitTokenParam(raw: string): { code: string; issuer: string } {
  const at = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf('+'), raw.lastIndexOf('|'));
  return { code: at < 0 ? raw : raw.slice(0, at), issuer: at < 0 ? '' : raw.slice(at + 1) };
}

/** `<code or currency> <issuer>`, the stem of the names of the CSV files: the code when the currency has one, else its hex. */
export function tokenFileStem(t: TokenRef): string {
  return `${currencyCode(t.currency) ?? t.currency} ${t.issuer}`;
}

/**
 * The stem of the CSV file of a path segment that `parseTokenParam` has accepted (a CSV is named once the route has answered, and
 * the network's native code, which is all `parseTokenParam` needs the profile for, cannot be in an accepted path): the same stem
 * for every spelling of a token, `NPUSD`, its 40 hex digits in either case, `+` or `|` for `.`.
 */
export function tokenFileStemOfPath(raw: string): string {
  const { code, issuer } = splitTokenParam(raw);
  return tokenFileStem({ currency: ledgerCurrencyOf(code) ?? code, issuer });
}

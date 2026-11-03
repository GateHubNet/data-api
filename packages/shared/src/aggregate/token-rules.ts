import BigNumber from 'bignumber.js';
import type { TokenLinesRow } from '../clickhouse/rows';
import type { NetworkProfile } from '../network/network-profile';
import { countsOn } from '../tomls/counts-on';
import type { TomlCurrency } from '../tomls/toml-read';
import { isLpCurrency, ledgerCurrencyOf } from '../util/currency-code';

/**
 * The rules of an issued token that the tokens job and the api share (spec 1, 3.1, 3.2, 3.7 and 5.2): which side of a trust
 * line issues, which lines count, and which entry of a toml lists a token. Pure: no read, no write.
 */

/** A token: the account that issued it and the currency, in the ledger's form. */
export interface TokenKey {
  issuer: string;
  currency: string;
}

/**
 * A `trust_line_states` row, read from the low account's side (`account` is the line's low account, `counterparty` its high
 * one): `balance` is the low account's (positive: the high account owes it), `limit` its own limit and `limit_peer` the high
 * account's; `authorized` and `freeze` are the low account's flags, `peer_authorized` and `peer_freeze` the high account's.
 */
export interface LowSideLine {
  account: string;
  counterparty: string;
  currency: string;
  balance: string;
  limit: string;
  limit_peer: string;
  authorized: boolean;
  peer_authorized: boolean;
  freeze: boolean;
  peer_freeze: boolean;
  ledger_index: number;
  deleted: boolean;
}

/** What a `token_lines` row should say: the holder's balance (0 or above) and limit, and the issuer side's flags. */
export interface WantedTokenLine {
  holder: string;
  balance: string;
  limit: string;
  frozen: 0 | 1;
  authorized: 0 | 1;
  ledger_index: number;
}

const flag = (on: boolean): 0 | 1 => (on ? 1 : 0);

/** The negation of a plain decimal text, as plain text: a zero stays `'0'`, never `'-0'`. */
function negated(value: string): string {
  const n = new BigNumber(value);
  return n.isZero() ? '0' : n.negated().toFixed();
}

/** spec 1: H holds (issuer-side balance below 0), or the balance is 0 and H's limit is above 0. */
export function countsFor(issuerSideBalance: string, holderLimit: string): boolean {
  const balance = new BigNumber(issuerSideBalance);
  return balance.isLessThan(0) || (balance.isZero() && new BigNumber(holderLimit).isGreaterThan(0));
}

/**
 * Both orientations of a line, the token of the high account first: the token of the high account (holder: low, balance as
 * stored, limit `limit`, issuer flags `peer_freeze`/`peer_authorized`) and the token of the low account (holder: high, balance
 * negated, limit `limit_peer`, flags `freeze`/`authorized`). `wanted` is null when the line does not count for that token (see
 * `countsFor`, from the issuer's side) or is deleted. `[]` for an LP currency, which counts for nothing.
 */
export function orientations(
  line: LowSideLine,
): Array<{ token: TokenKey; wanted: WantedTokenLine | null; holder: string }> {
  if (isLpCurrency(line.currency)) return [];
  const { currency, ledger_index } = line;
  const high = line.counterparty;
  const low = line.account;
  const highCounts = !line.deleted && countsFor(negated(line.balance), line.limit);
  const lowCounts = !line.deleted && countsFor(line.balance, line.limit_peer);
  return [
    {
      token: { issuer: high, currency },
      holder: low,
      wanted: highCounts
        ? {
            holder: low,
            balance: line.balance,
            limit: line.limit,
            frozen: flag(line.peer_freeze),
            authorized: flag(line.peer_authorized),
            ledger_index,
          }
        : null,
    },
    {
      token: { issuer: low, currency },
      holder: high,
      wanted: lowCounts
        ? {
            holder: high,
            balance: negated(line.balance),
            limit: line.limit_peer,
            frozen: flag(line.freeze),
            authorized: flag(line.authorized),
            ledger_index,
          }
        : null,
    },
  ];
}

/**
 * Whether a stored `token_lines` row already says what `wanted` says (balance, limit, frozen, authorized, ledger_index). The
 * balance and the limit are compared as text: both are written by the same plain-decimal rule, and a row that differs only in
 * its spelling is rewritten, which is harmless.
 */
export function sameTokenLine(
  stored: Pick<TokenLinesRow, 'balance' | 'limit' | 'frozen' | 'authorized' | 'ledger_index'>,
  wanted: WantedTokenLine,
): boolean {
  return (
    stored.balance === wanted.balance &&
    stored.limit === wanted.limit &&
    stored.frozen === wanted.frozen &&
    stored.authorized === wanted.authorized &&
    stored.ledger_index === wanted.ledger_index
  );
}

/** What a token row says of the toml of its issuer's account domain (spec 3.7). `toml` is JSON text, `''` when not listed. */
export interface TokenListing {
  domain: string;
  listed: 0 | 1;
  name: string;
  toml: string;
}

/** The keys of a `[[CURRENCIES]]` entry that a token serves (spec 5.2), in the order they are served. */
export const TOKEN_TOML_KEYS = [
  'name',
  'desc',
  'icon',
  'symbol',
  'display_decimals',
  'asset_class',
  'asset_subclass',
  'attestation',
] as const;

/** The most decimals a currency shows: `display_decimals` is a whole number from 0 to this (D4's rule of `/v2/toml/{domain}`). */
const MAX_DISPLAY_DECIMALS = 30;

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/**
 * The served fields of an entry's `fields` JSON, in `TOKEN_TOML_KEYS` order, with D4's type rule (toml-object.ts):
 * `display_decimals` a whole number 0 to 30, the others text, any text, an empty one included; anything else (or JSON that is
 * not an object) is left out.
 */
export function servedTomlFields(fields: string): Record<string, string | number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fields);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const served: Record<string, string | number> = {};
  for (const key of TOKEN_TOML_KEYS) {
    if (!hasOwn(record, key)) continue;
    const value = record[key];
    if (key === 'display_decimals') {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DISPLAY_DECIMALS) {
        served[key] = value;
      }
    } else if (typeof value === 'string') {
      served[key] = value;
    }
  }
  return served;
}

/**
 * spec 3.7: the first entry, in file order, that counts on this network (`countsOn`), names the token's issuer, and whose code is
 * the token's currency once both are in the ledger's form (`ledgerCurrencyOf`). `currencies` are the entries of the toml of the
 * issuer's own account domain (`domain`), `undefined` when that toml was not read. An entry whose issuer is `''` (the toml named
 * none, or no valid address) never matches. Without a match the token is not listed: `{ domain, listed: 0, name: '', toml: '' }`;
 * with one, `name` is the entry's `name` text (else `''`) and `toml` the JSON of `servedTomlFields`.
 */
export function tokenListing(
  token: TokenKey,
  domain: string,
  currencies: readonly TomlCurrency[] | undefined,
  profile: Pick<NetworkProfile, 'tomlNetworkNames'>,
): TokenListing {
  const currency = ledgerCurrencyOf(token.currency);
  const match =
    currency === undefined
      ? undefined
      : currencies?.find(
          (entry) =>
            entry.issuer !== '' &&
            entry.issuer === token.issuer &&
            countsOn(entry.network, profile) &&
            ledgerCurrencyOf(entry.code) === currency,
        );
  if (match === undefined) return { domain, listed: 0, name: '', toml: '' };
  const served = servedTomlFields(match.fields);
  const name = served.name;
  return { domain, listed: 1, name: typeof name === 'string' ? name : '', toml: JSON.stringify(served) };
}

import {
  countsOn,
  DomainTomlsRow,
  NetworkProfile,
  TomlAccount,
  TomlCurrency,
  TomlValidator,
  validatorTomlEntryOf,
} from '@gatehub/data-api-shared';
import { fmtMillis, fmtTime } from '../common/format';

/** The keys of `toml` in the answer of `GET /v2/toml/{domain}`, in order. A key without a value is left out, never `null`. */
export const TOML_KEYS = [
  'domain',
  'toml_url',
  'status',
  'reason',
  'status_code',
  'checked',
  'fetched',
  'modified',
  'expires',
  'accounts',
  'currencies',
  'principals',
  'validators',
] as const;

/** The keys of an entry of `accounts`, in order. */
export const TOML_ACCOUNT_KEYS = ['address', 'desc'] as const;

/** The keys of an entry of `currencies`, in order; the last four come from the entry's `fields`. */
export const TOML_CURRENCY_KEYS = ['code', 'issuer', 'display_decimals', 'symbol', 'name', 'desc'] as const;

/** The keys of an entry of `validators`, in order: the facts come through D8's rules, as the validator routes have them. */
export const TOML_VALIDATOR_KEYS = ['public_key', 'owner_country', 'server_country', 'network', 'unl'] as const;

/** The `fields` of a currency that are served, besides `display_decimals`: text. */
const CURRENCY_TEXT_FIELDS = ['symbol', 'name', 'desc'] as const;

/** The most decimals a currency shows (spec 6): `display_decimals` is an integer from 0 to this. */
const MAX_DISPLAY_DECIMALS = 30;

/**
 * An instant of receipt, to the millisecond. The store gives seconds with the milliseconds as a fraction, and a division can
 * leave a float a hair below the millisecond, which a `Date` would cut: it is rounded.
 */
const instant = (seconds: number): string => fmtMillis(new Date(Math.round(seconds * 1000)));

/**
 * The `fields` of an entry, the JSON object text the toml reader stores (spec 3.3). Text that is not a JSON object has no fields:
 * the answer serves what it can of a row and never fails on one.
 */
function fieldsOf(text: string): Record<string, unknown> {
  try {
    const fields: unknown = JSON.parse(text);
    return typeof fields === 'object' && fields !== null && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The value of `key` when `fields` has it of its own and it is text. */
function textOf(fields: Record<string, unknown>, key: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** An entry of `accounts`: the `desc` only when the toml gave one. */
function accountObject(account: TomlAccount): Record<string, string> {
  const object: Record<string, string> = { address: account.address };
  if (account.desc !== '') object.desc = account.desc;
  return object;
}

/** An entry of `currencies`: the issuer when it names one, and of `fields` only the decimals (an integer 0 to 30) and the texts. */
function currencyObject(currency: TomlCurrency): Record<string, unknown> {
  const fields = fieldsOf(currency.fields);
  const object: Record<string, unknown> = { code: currency.code };
  if (currency.issuer !== '') object.issuer = currency.issuer;
  const decimals = Object.prototype.hasOwnProperty.call(fields, 'display_decimals')
    ? fields.display_decimals
    : undefined;
  if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DISPLAY_DECIMALS) {
    object.display_decimals = decimals;
  }
  for (const key of CURRENCY_TEXT_FIELDS) {
    const text = textOf(fields, key);
    if (text !== undefined) object[key] = text;
  }
  return object;
}

/** An entry of `validators`, read by `validatorTomlEntryOf` so that this route and the validator routes never disagree on a country. */
function validatorObject(validator: TomlValidator): Record<string, string> {
  const { ownerCountry, serverCountry, network, unl } = validatorTomlEntryOf(validator);
  const object: Record<string, string> = { public_key: validator.public_key };
  if (ownerCountry !== '') object.owner_country = ownerCountry;
  if (serverCountry !== '') object.server_country = serverCountry;
  if (network !== '') object.network = network;
  if (unl !== '') object.unl = unl;
  return object;
}

/**
 * What the store says of a domain (spec 6): the keys of `TOML_KEYS` in order, the ones without a value left out. Only the entries
 * that count on the network of `profile` (`countsOn`) are served, and of an entry only the keys above; the rest of `fields`
 * stays in the store. `reason` is for a `failed` toml, `status_code` for its `http_status`, `fetched` for a toml that has content
 * in effect (a `failed` one within its grace carries it, one after a definite failure has none), and a list without entries is
 * left out. It builds new objects and changes nothing it is given: the row is the one the service keeps and serves again.
 */
export function tomlObject(
  row: DomainTomlsRow,
  profile: Pick<NetworkProfile, 'tomlNetworkNames'>,
): Record<string, unknown> {
  const toml: Record<string, unknown> = { domain: row.domain, toml_url: row.toml_url, status: row.status };
  if (row.status === 'failed') toml.reason = row.reason;
  if (row.reason === 'http_status') toml.status_code = row.status_code;
  toml.checked = instant(row.checked_at);
  if (row.fetched_at !== null) toml.fetched = instant(row.fetched_at);
  if (row.modified !== null) toml.modified = fmtTime(row.modified);
  if (row.expires !== null) toml.expires = fmtTime(row.expires);

  const accounts = row.accounts.filter((a) => countsOn(a.network, profile)).map(accountObject);
  if (accounts.length > 0) toml.accounts = accounts;
  const currencies = row.currencies.filter((c) => countsOn(c.network, profile)).map(currencyObject);
  if (currencies.length > 0) toml.currencies = currencies;
  if (row.principals.length > 0) toml.principals = [...row.principals];
  const validators = row.validators.filter((v) => countsOn(v.network, profile)).map(validatorObject);
  if (validators.length > 0) toml.validators = validators;
  return toml;
}

import { isValidClassicAddress } from 'ripple-address-codec';
import { parse, TomlDate } from 'smol-toml';
import type { UnixSeconds } from '../clickhouse/rows';
import type { NetworkProfile } from '../network/network-profile';
import { cleanTomlText } from './toml-text';

/** A `[[ACCOUNTS]]` entry: a classic address a domain names, with the `desc` it gives (`''` when none). */
export interface TomlAccount {
  address: string;
  /** As the writer stores it: lower case, `''` when absent (see `countsOn`). */
  network: string;
  desc: string;
}

/** A `[[CURRENCIES]]` entry. `fields` is the JSON object text of the entry's other scalar keys (`{}` when none). */
export interface TomlCurrency {
  code: string;
  /** A classic address, `''` when the entry names none (or not a valid one). */
  issuer: string;
  network: string;
  fields: string;
}

/** A `[[VALIDATORS]]` entry. `fields` is the JSON object text of the entry's other scalar keys (`{}` when none). */
export interface TomlValidator {
  public_key: string;
  network: string;
  fields: string;
}

/** What a domain's toml says (spec 3.3): the content of a row of `domain_tomls`. */
export interface TomlContent {
  modified: UnixSeconds | null;
  expires: UnixSeconds | null;
  accounts: TomlAccount[];
  currencies: TomlCurrency[];
  validators: TomlValidator[];
  /** The names of the principals, no repeat; never an email or a handle. */
  principals: string[];
}

const frozenList = <T>(): T[] => Object.freeze([] as T[]) as T[];

/** The content of a domain whose toml says nothing, or was never read: nulls and empty lists, frozen. */
export const EMPTY_TOML_CONTENT: Readonly<TomlContent> = Object.freeze({
  modified: null,
  expires: null,
  accounts: frozenList<TomlAccount>(),
  currencies: frozenList<TomlCurrency>(),
  validators: frozenList<TomlValidator>(),
  principals: frozenList<string>(),
});

/** The most entries kept of each list of a file, and the most keys kept in the `fields` of an entry (spec 3.3). */
export const TOML_LIMITS = {
  accounts: 1_000,
  currencies: 200,
  validators: 100,
  principals: 10,
  fieldKeys: 16,
} as const;

/** 2012-01-01T00:00:00Z: a `modified` before it is no date of a toml. */
export const MODIFIED_FLOOR_S = 1_325_376_000;

/** A `modified` more than this many seconds after the fetch is no date of a toml (a clock a day ahead is forgiven). */
const MODIFIED_AHEAD_S = 86_400;

/** The most code points of each text a file gives. */
const MAX_TEXT = { desc: 256, code: 40, publicKey: 128, principal: 100, network: 64, field: 256 } as const;

const FIELD_KEY = /^[A-Za-z0-9_]{1,32}$/;
const BYTE_ORDER_MARK = 0xfeff;

/** The text is not TOML. The message says nothing of the file: a parser's own message quotes the line that failed. */
export class TomlInvalidError extends Error {
  constructor() {
    super('the file is not valid TOML');
    this.name = 'TomlInvalidError';
  }
}

/**
 * The document a toml text holds. The text is parsed, never evaluated. A byte order mark at its start (U+FEFF once decoded,
 * which the parser would refuse) is dropped. Throws `TomlInvalidError` when the text is not TOML.
 */
export function parseTomlText(text: string): Record<string, unknown> {
  try {
    return parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  } catch {
    // whatever the parser met (a syntax error, a structure nested too deep): no word of the file goes into the error
    throw new TomlInvalidError();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/** The entries of a table array (`[[NAME]]`, or an array of inline tables) of the file; anything else has none. */
function entriesOf(document: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = own(document, name);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A classic address with a valid checksum, trimmed, else `undefined` (an X-address, a bad checksum, not text). */
function classicAddressOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = value.trim();
  return isValidClassicAddress(address) ? address : undefined;
}

/** The `network` of an entry: text cleaned and lower-cased, an integer as its decimal text, else `''` (spec 3.3). */
function networkOf(entry: Record<string, unknown>): string {
  const value = own(entry, 'network');
  if (typeof value === 'string') return cleanTomlText(value, MAX_TEXT.network)?.toLowerCase() ?? '';
  // the parser refuses an integer it cannot hold exactly, so a number that is an integer is a safe one
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

/**
 * The keys of an entry other than `kept`, as JSON object text: the first `TOML_LIMITS.fieldKeys` whose name matches
 * `FIELD_KEY` and whose value is a string (cleaned), a finite number or a boolean. A date, a list or a table is no field.
 */
function fieldsOf(entry: Record<string, unknown>, kept: readonly string[]): string {
  const fields: [string, string | number | boolean][] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (fields.length === TOML_LIMITS.fieldKeys) break;
    if (kept.includes(key) || !FIELD_KEY.test(key)) continue;
    const scalar =
      typeof value === 'string'
        ? cleanTomlText(value, MAX_TEXT.field)
        : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
          ? value
          : undefined;
    if (scalar !== undefined) fields.push([key, scalar]);
  }
  // fromEntries defines each key as an own property, even one named __proto__
  return JSON.stringify(Object.fromEntries(fields));
}

/**
 * The unix second a `[METADATA]` date names, or `null`: a TOML date, or text one reads as. An offset date-time is its
 * instant, a local date-time is read as UTC, a local date is 00:00 UTC; a local time alone is no date.
 */
function unixSecondsOf(value: unknown): UnixSeconds | null {
  const date = value instanceof TomlDate ? value : typeof value === 'string' ? new TomlDate(value.trim()) : undefined;
  if (date === undefined || !date.isValid() || date.isTime()) return null;
  return Math.floor(date.getTime() / 1_000);
}

/**
 * What a domain's toml says (spec 3.3). Only the keys the spec lists are read, every text is cleaned and capped, and the
 * entries of every network are kept: a reader filters them with `countsOn`. The text is parsed, never evaluated, never kept.
 * `profile` is read by no rule (the writer keeps every network's entries); it is the signature D6 and D8 call.
 *
 * - `[[ACCOUNTS]]`: `address` (a classic address with a valid checksum, once: the first entry of a repeat is kept), `desc`.
 * - `[[CURRENCIES]]`: `code`, `issuer`, and the other scalar keys as `fields`; `[[VALIDATORS]]`: `public_key` and `fields`.
 * - `[[PRINCIPALS]]`: the `name` alone, without an `@`, once. An email or a social handle is never read.
 * - `[METADATA]`: `modified` (dropped before 2012 or more than a day after `fetchedAt`) and `expires`.
 *
 * An unknown section, a key of another type and a nested table inside an entry are ignored; none fails a file.
 * Throws `TomlInvalidError` when the text is not TOML.
 */
export function readToml(text: string, profile: Pick<NetworkProfile, 'name'>, fetchedAt: UnixSeconds): TomlContent {
  const document = parseTomlText(text);

  const accounts: TomlAccount[] = [];
  const seen = new Set<string>();
  for (const entry of entriesOf(document, 'ACCOUNTS')) {
    if (accounts.length === TOML_LIMITS.accounts) break;
    const address = classicAddressOf(own(entry, 'address'));
    if (address === undefined || seen.has(address)) continue;
    seen.add(address);
    accounts.push({
      address,
      network: networkOf(entry),
      desc: cleanTomlText(own(entry, 'desc'), MAX_TEXT.desc) ?? '',
    });
  }

  const currencies: TomlCurrency[] = [];
  for (const entry of entriesOf(document, 'CURRENCIES')) {
    if (currencies.length === TOML_LIMITS.currencies) break;
    const code = cleanTomlText(own(entry, 'code'), MAX_TEXT.code);
    if (code === undefined) continue;
    currencies.push({
      code,
      issuer: classicAddressOf(own(entry, 'issuer')) ?? '',
      network: networkOf(entry),
      fields: fieldsOf(entry, ['code', 'issuer', 'network']),
    });
  }

  const validators: TomlValidator[] = [];
  for (const entry of entriesOf(document, 'VALIDATORS')) {
    if (validators.length === TOML_LIMITS.validators) break;
    const publicKey = cleanTomlText(own(entry, 'public_key'), MAX_TEXT.publicKey);
    if (publicKey === undefined) continue;
    validators.push({
      public_key: publicKey,
      network: networkOf(entry),
      fields: fieldsOf(entry, ['public_key', 'network']),
    });
  }

  const principals: string[] = [];
  for (const entry of entriesOf(document, 'PRINCIPALS')) {
    if (principals.length === TOML_LIMITS.principals) break;
    const name = cleanTomlText(own(entry, 'name'), MAX_TEXT.principal);
    if (name === undefined || name.includes('@') || principals.includes(name)) continue;
    principals.push(name);
  }

  const metadata = own(document, 'METADATA');
  const section = isRecord(metadata) ? metadata : {};
  const modified = unixSecondsOf(own(section, 'modified'));

  return {
    modified:
      modified !== null && modified >= MODIFIED_FLOOR_S && modified <= fetchedAt + MODIFIED_AHEAD_S ? modified : null,
    expires: unixSecondsOf(own(section, 'expires')),
    accounts,
    currencies,
    validators,
    principals,
  };
}

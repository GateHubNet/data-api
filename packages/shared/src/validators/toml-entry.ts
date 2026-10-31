import { countryCodeOf } from './country';

/** What the domain checker reads of a file. A later change of what is read bumps it, and the verified pairs below it are read again. */
export const TOML_DETAILS_VERSION = 1;

/** The fields of a `[[VALIDATORS]]` entry that are read; nothing else of it is. */
export const TOML_FIELDS = ['owner_country', 'server_country', 'network', 'unl'] as const;
export type TomlField = (typeof TOML_FIELDS)[number];

/** The facts of one `[[VALIDATORS]]` entry. */
export interface ValidatorTomlEntry {
  /** `''` when not given or not a code. */
  ownerCountry: string;
  serverCountry: string;
  /** As the store keeps it (`main`, `testnet`, `21337`); `''` when absent. */
  network: string;
  unl: string;
  /** The fields the file gives a value for that the rules refuse, each with the value as a log line shows it. */
  invalid: { field: TomlField; shown: string }[];
}

const MAX_UNL = 256;
const MAX_NETWORK = 32;
/** The most code points of a value from a file that a log line shows. */
const MAX_SHOWN = 16;
/** `URL` alone also parses `https:vl.example`, which a client would resolve as a relative link. */
const HTTPS_SLASHES = /^https:\/\//i;

const codePoints = (text: string): string[] => Array.from(text);

/** Text that parses with `URL`, over https, with no user or password, of at most 256 characters: the text as written. Nothing fetches it. */
export function tomlUnlOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HTTPS_SLASHES.test(value) || codePoints(value).length > MAX_UNL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Text of 1 to 32 characters, holding no `@` (as the store's other texts of a file hold none). */
export function tomlNetworkOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('@')) return undefined;
  const length = codePoints(value).length;
  return length >= 1 && length <= MAX_NETWORK ? value : undefined;
}

/** A value from a file as a log line shows it: its text, the first 16 code points and `...` when longer, in JSON quotes. */
export function shownValue(value: unknown): string {
  const points = codePoints(String(value));
  return JSON.stringify(points.length > MAX_SHOWN ? `${points.slice(0, MAX_SHOWN).join('')}...` : points.join(''));
}

function parsedFields(fields: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fields);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The facts of one `[[VALIDATORS]]` entry as `readToml` gives it. A field that is present and refused goes into `invalid`;
 * an absent one is `''`. A `network` holding `@` reads as absent, so that it is never shown. Never throws: a `fields` that is
 * not a JSON object reads as none.
 */
export function validatorTomlEntryOf(entry: { network: string; fields: string }): ValidatorTomlEntry {
  const fields = parsedFields(entry.fields);
  const invalid: ValidatorTomlEntry['invalid'] = [];
  const read = (field: TomlField, value: unknown, rule: (value: unknown) => string | undefined): string => {
    if (value === undefined) return '';
    const kept = rule(value);
    if (kept === undefined) invalid.push({ field, shown: shownValue(value) });
    return kept ?? '';
  };
  const ownerCountry = read('owner_country', fields.owner_country, countryCodeOf);
  const serverCountry = read('server_country', fields.server_country, countryCodeOf);
  const givenNetwork = entry.network === '' || entry.network.includes('@') ? undefined : entry.network;
  const network = read('network', givenNetwork, tomlNetworkOf);
  const unl = read('unl', fields.unl, tomlUnlOf);
  return { ownerCountry, serverCountry, network, unl, invalid };
}

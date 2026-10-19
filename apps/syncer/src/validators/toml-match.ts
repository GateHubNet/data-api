import { isValidClassicAddress } from 'ripple-address-codec';
import { parse } from 'smol-toml';

/** The most account addresses kept from a file (spec 2.2, G1). */
export const MAX_ACCOUNTS = 10;

/** The text is not TOML. The message says nothing of the file: a parser's own message quotes the line that failed. */
export class TomlInvalidError extends Error {
  constructor() {
    super('the file is not valid TOML');
    this.name = 'TomlInvalidError';
  }
}

export interface TomlMatch {
  /** Whether a `[[VALIDATORS]]` entry names the master key. */
  listed: boolean;
  /** The classic addresses of the `[[ACCOUNTS]]` entries, sorted, at most `MAX_ACCOUNTS`; none unless `listed`. */
  accounts: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entries of a table array (`[[NAME]]`, or an array of inline tables) of the file; anything else has none. */
function entriesOf(document: Record<string, unknown>, name: string): Record<string, unknown>[] {
  if (!Object.prototype.hasOwnProperty.call(document, name)) return [];
  const value = document[name];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The trimmed text of a field of an entry, `undefined` when it is missing or not text. */
function textOf(entry: Record<string, unknown>, field: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(entry, field) ? entry[field] : undefined;
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * What a validator's TOML file says about one master key (spec 2.2, 8.2). The file is parsed, never evaluated, and only two
 * fields are read: the `public_key` of the `[[VALIDATORS]]` entries (the key is listed when one equals `masterKey` once
 * trimmed) and, only when it is listed, the `address` of the `[[ACCOUNTS]]` entries, which are kept when they are classic
 * addresses with a valid checksum (an X-address, a bad checksum, a missing or non-text address is skipped), once each,
 * sorted, the first `MAX_ACCOUNTS`. Every other field is ignored.
 *
 * Throws `TomlInvalidError` when the text is not TOML.
 */
export function matchToml(text: string, masterKey: string): TomlMatch {
  let document: Record<string, unknown>;
  try {
    document = parse(text);
  } catch {
    // whatever the parser met (a syntax error, a structure nested too deep): no word of the file goes into the error
    throw new TomlInvalidError();
  }

  const listed = entriesOf(document, 'VALIDATORS').some((entry) => textOf(entry, 'public_key') === masterKey);
  if (!listed) return { listed, accounts: [] };

  const addresses = new Set<string>();
  for (const entry of entriesOf(document, 'ACCOUNTS')) {
    const address = textOf(entry, 'address');
    if (address !== undefined && isValidClassicAddress(address)) addresses.add(address);
  }
  return { listed, accounts: [...addresses].sort().slice(0, MAX_ACCOUNTS) };
}

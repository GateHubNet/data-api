import {
  NetworkProfile,
  readToml,
  UnixSeconds,
  ValidatorTomlEntry,
  validatorTomlEntryOf,
} from '@gatehub/data-api-shared';

// the parse moved to the shared package with `readToml`; `domain-checker.ts` and the spec keep importing the error from here
export { TomlInvalidError } from '@gatehub/data-api-shared';

/** The most account addresses kept from a file (spec 2.2, G1). */
export const MAX_ACCOUNTS = 10;

export interface TomlMatch {
  /** Whether a `[[VALIDATORS]]` entry names the master key. */
  listed: boolean;
  /** The classic addresses of the `[[ACCOUNTS]]` entries, sorted, at most `MAX_ACCOUNTS`; none unless `listed`. */
  accounts: string[];
  /** The facts of the first entry that names the key; only when `listed`. */
  entry?: ValidatorTomlEntry;
}

/**
 * What a validator's TOML file says about one master key (spec 2.2, 8.2; D8 1.1), read with `readToml`: the file is parsed,
 * never evaluated, and every text is cleaned. The key is listed when a `[[VALIDATORS]]` entry's `public_key` equals `masterKey`.
 * Only then are the `[[ACCOUNTS]]` addresses taken (classic addresses with a valid checksum, once each, sorted, the first
 * `MAX_ACCOUNTS`, whatever their network) and the facts of the first entry that names the key (a second one is ignored, and no
 * other entry is read). `readToml` keeps at most 100 entries, so a key listed past the 100th is not listed.
 * A byte order mark at the start of the text is ignored.
 *
 * Throws `TomlInvalidError` when the text is not TOML.
 */
export function matchToml(
  text: string,
  masterKey: string,
  profile: Pick<NetworkProfile, 'name'>,
  fetchedAt: UnixSeconds,
): TomlMatch {
  const { validators, accounts } = readToml(text, profile, fetchedAt);
  const validator = validators.find((entry) => entry.public_key === masterKey);
  if (validator === undefined) return { listed: false, accounts: [] };
  const addresses = [...new Set(accounts.map((account) => account.address))];
  return { listed: true, accounts: addresses.sort().slice(0, MAX_ACCOUNTS), entry: validatorTomlEntryOf(validator) };
}

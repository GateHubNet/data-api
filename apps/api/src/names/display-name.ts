/** What stands behind a display name: a toml that lists the address (`verified`), an operator's name (`account`) or an unverified domain (`domain`). */
export type DisplayNameKind = 'verified' | 'account' | 'domain';

/** The name to show for an address, and what stands behind it. */
export interface DisplayName {
  text: string;
  kind: DisplayNameKind;
}

/** The longest `desc` that is a verified name, in code points: a longer one is not a name and the domain is used (nothing is cut). */
export const VERIFIED_DESC_MAX = 64;

/** What the rule needs to know of one address. */
export interface DisplayNameInput {
  address: string;
  /** The account domain (lower case), when the account has one. */
  domain?: string;
  /** What the toml of `domain` says of its accounts on this network, address to `desc`; absent when the directory holds none. */
  listed?: ReadonlyMap<string, string>;
  /** Whether the api has read the toml directory at least once: before that a domain is unknown, not "not verified". */
  directoryLoaded: boolean;
  accountName?: string;
  accountNetworkName?: string;
}

/**
 * The display name of an address (spec 5.1), the first that applies:
 *
 * 1. `verified`: the account has a domain and the toml of that domain lists the address. The text is the listed `desc` when it is 1 to
 *    64 code points, else the domain.
 * 2. `account`: the account name, else the account network name.
 * 3. `domain`: the account has a domain and the directory has loaded (nothing vouches for it: not listed, a failed toml or a toml not
 *    read yet are all the same).
 *
 * `undefined` otherwise.
 */
export function displayNameOf(i: DisplayNameInput): DisplayName | undefined {
  if (i.domain !== undefined && i.listed?.has(i.address)) {
    const desc = i.listed.get(i.address) ?? '';
    const length = [...desc].length;
    return { text: length >= 1 && length <= VERIFIED_DESC_MAX ? desc : i.domain, kind: 'verified' };
  }
  const name = i.accountName ?? i.accountNetworkName;
  if (name !== undefined) return { text: name, kind: 'account' };
  if (i.domain !== undefined && i.directoryLoaded) return { text: i.domain, kind: 'domain' };
  return undefined;
}

import { countsOn, DomainTomlsRow, NetworkProfile } from '@gatehub/data-api-shared';

/** What the validator detail serves of the toml store's row of a domain (D8 1.2). The one place that reads the row for it. */
export interface DomainTomlFacts {
  /** As stored (names, at most 10), less any holding `@`: the writer drops them, and the reader drops them again. */
  readonly principals: readonly string[];
  /** Unix seconds. */
  readonly modified: number | null;
  /** The distinct addresses of `[[ACCOUNTS]]`, whatever their network: the writer keeps an address once per network. */
  readonly accountsListed: number;
  /** The entries that count on this network, less any whose code holds `@`, in file order: all of them. */
  readonly currencies: readonly { readonly code: string; readonly issuer: string }[];
  /** Unix seconds with a millisecond fraction. */
  readonly fetchedAt: number;
}

/** `undefined` without a row and when its content is not in effect (`fetched_at` NULL: a definite failure, or past the grace). */
export function domainTomlFactsOf(
  row: DomainTomlsRow | undefined,
  profile: Pick<NetworkProfile, 'tomlNetworkNames'>,
): DomainTomlFacts | undefined {
  if (row === undefined || row.fetched_at === null) return undefined;
  return {
    principals: row.principals.filter((name) => !name.includes('@')),
    modified: row.modified,
    accountsListed: new Set(row.accounts.map((account) => account.address)).size,
    currencies: row.currencies
      .filter((currency) => countsOn(currency.network, profile) && !currency.code.includes('@'))
      .map(({ code, issuer }) => ({ code, issuer })),
    fetchedAt: row.fetched_at,
  };
}

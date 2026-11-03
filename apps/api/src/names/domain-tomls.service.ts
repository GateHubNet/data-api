import {
  ClickHouseService,
  countsOn,
  DomainTomlsRow,
  NetworkProfile,
  readStoredTomls,
  Table,
  TomlAccount,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { TomlListing } from './display-name';
import { NAMES_CACHE } from './names-cache';

/**
 * What the newest row of each of `domains` says of `addresses`, by key (`domain` is the sort key; the largest `checked_at` of a
 * domain is its current word, `LIMIT 1 BY` over the sort key, never `FINAL`): the `[[ACCOUNTS]]` entries of those addresses
 * and nothing else of the row, in file order. A domain without a row is not in the answer; one whose row lists none of them
 * has an empty `listed`. The alias is not a column name.
 */
export const TOML_LISTINGS_SQL = `SELECT domain, arrayFilter(a -> has({addresses:Array(String)}, tupleElement(a, 'address')), accounts) AS listed
  FROM (SELECT domain, accounts FROM ${Table.DomainTomls}
         WHERE domain IN {domains:Array(String)}
         ORDER BY domain, checked_at DESC
         LIMIT 1 BY domain)`;

/** How long the row of a domain is kept (`DomainTomlsService.get`), in milliseconds. */
export const DOMAIN_TOML_TTL_MS = 60_000;

/** How long what a domain's toml says of an address is kept (`DomainTomlsService.listings`), in milliseconds. */
export const TOML_LISTING_TTL_MS = 60_000;

/** A row of `TOML_LISTINGS_SQL`. */
interface ListingsRow {
  domain: string;
  listed: TomlAccount[];
}

/** The key what the toml of `domain` says of `address` is kept under; an address it does not list is kept as `null`. */
const keyOf = (domain: string, address: string): string => `toml-listing:${domain}:${address}`;

/**
 * The toml store as the api reads it (spec 5.3, 8), by key and on request, never whole: what the toml of an account's
 * domain says of the account, for the display names, and the newest row of one domain, for `GET /v2/toml/{domain}` (and D6,
 * D8). Each answer is kept 60 s in the cache of the names (`NAMES_CACHE`), so a call reads only what it has not got: what
 * the api holds is bounded by the requests and the size of that cache, never by the store.
 */
@Injectable()
export class DomainTomlsService {
  constructor(
    private readonly ch: ClickHouseService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    @Inject(NAMES_CACHE) private readonly cache: CacheService,
  ) {}

  /**
   * What the toml of each account's domain says of the account (`accounts`: address to its account domain, lower case), for
   * each address of `accounts`: the `desc` of the address's first entry that counts on this network (`countsOn`) in the
   * domain's newest row, or `null` when there is none (no such entry, no row, a row with no content). Only the account's own
   * domain vouches for it: what the toml of another domain says of the address is not read. One read by key, for the distinct
   * domains of the addresses that are not kept, and none when every one is (or there is none); each answer is kept 60 s.
   * Rejects when the read fails, and keeps nothing of it.
   */
  async listings(accounts: ReadonlyMap<string, string>): Promise<Map<string, TomlListing | null>> {
    const answers = new Map<string, TomlListing | null>();
    const misses = new Map<string, string>();
    for (const [address, domain] of accounts) {
      // `get` gives `undefined` for a key it does not keep, so an address the toml does not list is kept as `null`
      const kept = this.cache.get<TomlListing | null>(keyOf(domain, address));
      if (kept === undefined) misses.set(address, domain);
      else answers.set(address, kept);
    }

    if (misses.size > 0) {
      const rows = await this.ch.query<ListingsRow>(TOML_LISTINGS_SQL, {
        domains: [...new Set(misses.values())],
        addresses: [...misses.keys()],
      });
      const listedBy = new Map(rows.map((row) => [row.domain, row.listed]));
      for (const [address, domain] of misses) {
        const entry = listedBy
          .get(domain)
          ?.find((account) => account.address === address && countsOn(account.network, this.profile));
        const listing = entry === undefined ? null : { desc: entry.desc };
        this.cache.set(keyOf(domain, address), listing, TOML_LISTING_TTL_MS);
        answers.set(address, listing);
      }
    }
    return new Map([...accounts.keys()].map((address) => [address, answers.get(address) ?? null]));
  }

  /**
   * The newest row of `domain` (lower case), read by key and kept for 60 s, a domain with no row too. Rejects when the read
   * fails, and keeps nothing of it.
   */
  get(domain: string): Promise<DomainTomlsRow | undefined> {
    return this.cache.wrap(`domain-toml:${domain}`, DOMAIN_TOML_TTL_MS, async () =>
      (await readStoredTomls(this.ch, [domain])).get(domain),
    );
  }
}

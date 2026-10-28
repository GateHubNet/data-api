import { accountDomainOf, ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NAMES_CACHE } from './names-cache';

/**
 * The newest row of each account asked, by key (`account` is the sort key of the table, which keeps one row per account and
 * partition after merges): the domain it holds and whether the node was deleted, by `argMax` of `version`, never `FINAL`. The
 * aliases are not column names (`gone`, not `deleted`).
 */
export const ACCOUNT_DOMAINS_SQL = `SELECT account, argMax(domain_hex, version) AS top_hex, argMax(deleted, version) AS gone
  FROM ${Table.AccountDomains}
 WHERE account IN {addresses:Array(String)}
 GROUP BY account`;

/** How long the account domain of an address is kept, in milliseconds. */
export const ACCOUNT_DOMAIN_TTL_MS = 60_000;

/** A row of `ACCOUNT_DOMAINS_SQL`: `gone` is a `UInt8`. */
interface AccountDomainRow {
  account: string;
  top_hex: string;
  gone: number | string;
}

/** The key an address is kept under; an address with no domain is kept as the empty text. */
const keyOf = (address: string): string => `account-domain:${address}`;

/**
 * The account domain of addresses (spec 5.3): the domain the Domain field of the account names (`accountDomainOf` of the newest
 * row), read from `account_domains` by key. Each answer is kept 60 s per address in the cache of the names, so a call reads only the
 * addresses it has not got, in one statement.
 */
@Injectable()
export class AccountDomainsService {
  constructor(
    private readonly ch: ClickHouseService,
    @Inject(NAMES_CACHE) private readonly cache: CacheService,
  ) {}

  /**
   * The account domain of each distinct address, in the order they first come: `undefined` for an address with none (no row, a
   * deleted account, an empty Domain, or one that is not a domain). Rejects when the read fails, and keeps nothing of it.
   */
  async current(addresses: readonly string[]): Promise<Map<string, string | undefined>> {
    const distinct = [...new Set(addresses)];
    const answers = new Map<string, string | undefined>();
    const misses: string[] = [];
    for (const address of distinct) {
      // `get` cannot tell a kept `undefined` from none: an address with no domain is kept as ''
      const kept = this.cache.get<string>(keyOf(address));
      if (kept === undefined) misses.push(address);
      else answers.set(address, kept === '' ? undefined : kept);
    }

    if (misses.length > 0) {
      const rows = await this.ch.query<AccountDomainRow>(ACCOUNT_DOMAINS_SQL, { addresses: misses });
      const read = new Map(
        rows.map((row) => [row.account, Number(row.gone) !== 0 ? undefined : accountDomainOf(row.top_hex)]),
      );
      for (const address of misses) {
        const domain = read.get(address);
        this.cache.set(keyOf(address), domain ?? '', ACCOUNT_DOMAIN_TTL_MS);
        answers.set(address, domain);
      }
    }
    return new Map(distinct.map((address) => [address, answers.get(address)]));
  }
}

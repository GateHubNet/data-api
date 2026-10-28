import { accountDomainOf, ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from './tomls.options';

/** The domains accounts name are read again every 5 minutes (spec 4.1). */
export const TOML_DISCOVERY_INTERVAL_MS = 300_000;

/**
 * The current domain of every account, and how many accounts name each (spec 4.1). The newest row of an account is the one
 * with the largest `version`: `argMax`, never `FINAL`, because the rows of an account collapse only when parts merge. A
 * deleted account and an account without a Domain name none. `count()` is a UInt64, which ClickHouse's JSON may send as
 * quoted text.
 */
export const DISCOVERY_SQL = `SELECT top_hex AS domain_hex, count() AS accounts
  FROM (SELECT account, argMax(domain_hex, version) AS top_hex, argMax(deleted, version) AS gone
          FROM ${Table.AccountDomains} GROUP BY account)
 WHERE top_hex != '' AND gone = 0
 GROUP BY top_hex`;

/**
 * The domains the hex Domains of the rows name, and the accounts that name each. Each `domain_hex` goes through
 * `accountDomainOf`: the ones that are no domain are dropped (`dropped` counts them, not their values), and the spellings of
 * one domain (`Example.com`, `example.com`) add up. `accounts` is a number or the text ClickHouse sends for a UInt64.
 */
export function domainsOf(rows: readonly { domain_hex: string; accounts: number | string }[]): {
  domains: Map<string, number>;
  dropped: number;
} {
  const domains = new Map<string, number>();
  let dropped = 0;
  for (const row of rows) {
    const domain = accountDomainOf(row.domain_hex);
    if (domain === undefined) {
      dropped++;
      continue;
    }
    domains.set(domain, (domains.get(domain) ?? 0) + Number(row.accounts));
  }
  return { domains, dropped };
}

/**
 * The domains of `next` named by more accounts than in `previous` (a domain `previous` lacks counts as named by none),
 * sorted. None when there is no previous map: the first discovery after a start has nothing to compare with, so no domain is
 * named anew then.
 */
export function grownDomains(
  previous: ReadonlyMap<string, number> | undefined,
  next: ReadonlyMap<string, number>,
): string[] {
  if (previous === undefined) return [];
  return [...next]
    .filter(([domain, accounts]) => accounts > (previous.get(domain) ?? 0))
    .map(([domain]) => domain)
    .sort();
}

/**
 * Which domains accounts name (spec 4.1): `discover()` reads the current domain of every account from `account_domains` and
 * keeps the result in `current`, the domains the worker checks and no others. A domain more accounts name than at the
 * previous discovery is **named anew** until it is `checked()`: the pass checks it again soon (spec 4.2).
 *
 * The state is in memory and belongs to the process; the first discovery after a start has no previous map to compare with.
 */
@Injectable()
export class DomainDiscovery {
  /** The domains of the last read that worked; none before the first one. */
  private domains: ReadonlyMap<string, number> | undefined;
  private readonly anew = new Set<string>();
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private markReady!: () => void;

  /**
   * Settles after the first `discover()` call, whatever it came to: it never rejects, so that a worker can wait for it
   * before its first pass without a failed read ending the wait with an error (the loop that calls `discover()` logs it).
   */
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });

  constructor(
    @Inject(ClickHouseService) private readonly ch: Pick<ClickHouseService, 'query'>,
    @Inject(PrometheusService) private readonly prometheus: Pick<PrometheusService, 'tomlsDiscoverySeconds'>,
    @Optional() @Inject(TOMLS_WORKER_OPTIONS) options: TomlsWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? new Logger(DomainDiscovery.name);
  }

  /** The domains accounts name now, with the number of accounts that name each; empty before the first discovery. */
  get current(): ReadonlyMap<string, number> {
    return this.domains ?? new Map();
  }

  /**
   * One read of `account_domains`. It replaces `current` and adds the domains whose count grew to the named-anew set, which
   * it prunes of the domains no account names any more. The number of values that name no domain is logged when above 0.
   *
   * `syncer_tomls_discovery_seconds` is set to the seconds the read took whatever it came to: a read that outgrows its
   * limits does not get slow, it fails (the time limit, the memory cap, the request timeout), and the alert on the gauge
   * must see that. Rejects when the read fails, and then `current` and the named-anew set stay as they were.
   */
  async discover(): Promise<void> {
    try {
      const rows = await this.read();

      const { domains, dropped } = domainsOf(rows);
      for (const domain of grownDomains(this.domains, domains)) this.anew.add(domain);
      for (const domain of this.anew) if (!domains.has(domain)) this.anew.delete(domain);
      this.domains = domains;
      if (dropped > 0) this.logger.log(`Discovery dropped ${dropped} Domain value(s) that name no domain`);
    } finally {
      this.markReady();
    }
  }

  /** The read of `DISCOVERY_SQL`, its duration in the gauge even when it fails. */
  private async read(): Promise<{ domain_hex: string; accounts: number | string }[]> {
    const started = this.now();
    try {
      return await this.ch.query<{ domain_hex: string; accounts: number | string }>(DISCOVERY_SQL);
    } finally {
      this.prometheus.tomlsDiscoverySeconds.set((this.now() - started) / 1000);
    }
  }

  /**
   * True while more accounts name the domain than at an earlier discovery, it was not `checked()` since and some account
   * still names it.
   */
  namedAnew(domain: string): boolean {
    return this.anew.has(domain);
  }

  /** A checked domain is no longer named anew. */
  checked(domain: string): void {
    this.anew.delete(domain);
  }
}

import {
  ClickHouseService,
  countsOn,
  DomainTomlsRow,
  NetworkProfile,
  readStoredTomls,
  Table,
  TomlAccount,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { NAMES_CACHE } from './names-cache';

/**
 * The newest row of each domain (the largest `checked_at`, `LIMIT 1 BY` over the sort key, never `FINAL`) that has accounts, with
 * the accounts and nothing else of it: the whole table is read, three columns of it, once per reload.
 */
export const TOML_DIRECTORY_SQL = `SELECT domain, accounts FROM (
  SELECT domain, accounts FROM ${Table.DomainTomls}
   ORDER BY domain, checked_at DESC
   LIMIT 1 BY domain)
 WHERE notEmpty(accounts)`;

/** How long the row of a domain is kept (`DomainTomlsService.get`), in milliseconds. */
export const DOMAIN_TOML_TTL_MS = 60_000;

/** A row of `TOML_DIRECTORY_SQL`. */
interface DirectoryRow {
  domain: string;
  accounts: TomlAccount[];
}

/** What a domain's toml says of its accounts on this network: address to `desc`. */
type Listed = ReadonlyMap<string, string>;

/**
 * The toml store as the api reads it (spec 5.3, 8): the **directory** of what each toml says of its accounts, held whole in memory,
 * and the newest row of one domain, by key.
 *
 * The directory is loaded when the app starts and again every `GH_NAMES_AND_LABELS_RELOAD_MS` (60 s), like the names. A load that
 * fails is a `warn`: the last directory stays (none before the first load, `loaded` false) and the next reload tries again. It
 * never fails a request or the boot.
 */
@Injectable()
export class DomainTomlsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DomainTomlsService.name);
  private directory = new Map<string, Listed>();
  private hasLoaded = false;
  private timer?: NodeJS.Timeout;
  private reloading?: Promise<void>;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly config: ApiConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    @Inject(NAMES_CACHE) private readonly cache: CacheService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), this.config.namesAndLabelsReloadMs);
    // a timer alone never keeps the process alive
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.reloading;
  }

  /** False until the first load of the directory succeeded: no domain is listed before it. */
  get loaded(): boolean {
    return this.hasLoaded;
  }

  /**
   * What the toml of `domain` (lower case) says of its accounts: address to `desc`, of the entries that count on this network
   * (`countsOn`), the first entry of an address. `undefined` for a domain the directory does not hold (no row, no account that
   * counts here), and for every domain before the first load.
   */
  listed(domain: string): Listed | undefined {
    return this.directory.get(domain);
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

  /** Loads the directory again; a reload still running when the timer fires again is not doubled. */
  private reload(): Promise<void> {
    this.reloading ??= this.load().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.ch.query<DirectoryRow>(TOML_DIRECTORY_SQL);
      this.directory = this.directoryOf(rows);
      this.hasLoaded = true;
    } catch (err) {
      this.logger.warn(`Could not load the toml directory, keeping the last one: ${(err as Error).message}`);
    }
  }

  /** The directory of the rows: the entries that count here, the first per address; a domain without one is left out. */
  private directoryOf(rows: readonly DirectoryRow[]): Map<string, Listed> {
    const directory = new Map<string, Listed>();
    for (const row of rows) {
      const listed = new Map<string, string>();
      for (const account of row.accounts) {
        if (!countsOn(account.network, this.profile) || listed.has(account.address)) continue;
        listed.set(account.address, account.desc);
      }
      if (listed.size > 0) directory.set(row.domain, listed);
    }
    return directory;
  }
}

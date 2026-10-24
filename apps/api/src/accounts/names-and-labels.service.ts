import { ClickHouseService } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ApiConfig, SHARED_DATABASE } from '../config/api.config';
import { ACCOUNT_LABELS, AccountLabels } from './account-labels';
import { ACCOUNT_NAMES } from './account-names';
import { ACCOUNT_NETWORK_NAMES } from './account-network-names';

/**
 * What the operator's names and labels add to `account_data` of `GET /v2/accounts/{address}` (ADR-0014), each key left
 * out when there is none.
 */
export interface NamesAndLabels {
  /** The account name of the address, the same on every network. */
  account_name?: string;
  /** The account network name of the address: its name on this network only. */
  account_network_name?: string;
  /** The labels of the address keyed by label (`scam`, `spam`, `advisory`), the same on every network. */
  account_labels?: AccountLabels;
}

/** Where a set is read from: the app's own (network) database through `ch`, the shared one by its name. */
export interface NamesAndLabelsSource {
  /** Bound to the network database of the app. */
  ch: ClickHouseService;
  /** The shared database: qualify its tables with it (`${shared}.${SharedTable.X}`). */
  shared: string;
}

/**
 * One set of names or labels, loaded whole: for each address that has something, what it adds to `account_data`. A
 * set reads an append-only table, takes the newest row of each key and drops the keys whose newest row is a removal,
 * without `FINAL`.
 */
export interface NamesAndLabelsSet {
  /** What the set is, for the logs: `account names`. */
  name: string;
  load(source: NamesAndLabelsSource): Promise<Map<string, NamesAndLabels>>;
}

/**
 * The sets, in the order their keys come in `account_data`: account names (`account_name`), account network names
 * (`account_network_name`), then the labels (`account_labels`).
 */
export const NAMES_AND_LABELS_SETS: readonly NamesAndLabelsSet[] = [
  ACCOUNT_NAMES,
  ACCOUNT_NETWORK_NAMES,
  ACCOUNT_LABELS,
];

/**
 * The names and labels the operator writes by hand (ADR-0014), held in memory: every set is loaded whole when the app
 * starts and again every `GH_NAMES_AND_LABELS_RELOAD_MS` (60 s), so a request never reads them from ClickHouse and an
 * inserted row shows within that time.
 *
 * A set that fails to load keeps what it had (empty before its first load) and is tried again at the next reload: the
 * failure is logged and the accounts are served without it, never failing a request or the boot.
 */
@Injectable()
export class NamesAndLabelsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NamesAndLabelsService.name);
  private readonly sets = NAMES_AND_LABELS_SETS;
  /** What each set loaded, in the order of `sets`. */
  private readonly loaded: Map<string, NamesAndLabels>[] = this.sets.map(() => new Map());
  private timer?: NodeJS.Timeout;
  private reloading?: Promise<void>;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly config: ApiConfig,
    @Inject(SHARED_DATABASE) private readonly shared: string,
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

  /** What the names and labels add to `account_data` of `address`, in the order of the sets; `{}` when nothing. */
  of(address: string): NamesAndLabels {
    return Object.assign({}, ...this.loaded.map((set) => set.get(address)));
  }

  /** Loads every set again; a reload still running when the timer fires again is not doubled. */
  private reload(): Promise<void> {
    this.reloading ??= this.loadAll().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  private async loadAll(): Promise<void> {
    const source: NamesAndLabelsSource = { ch: this.ch, shared: this.shared };
    await Promise.all(
      this.sets.map(async (set, i) => {
        try {
          this.loaded[i] = await set.load(source);
        } catch (err) {
          this.logger.warn(`Could not load the ${set.name}, serving the ones loaded before: ${(err as Error).message}`);
        }
      }),
    );
  }
}

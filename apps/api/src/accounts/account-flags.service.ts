import { AccountFlag, accountFlagsOf, namedAccountFlags, NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { notFound } from '../common/errors';
import { StateLedgerService } from '../common/state-ledger.service';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { XrplService } from '../xrpl/xrpl.service';
import { LedgerSelector, liveCacheKey, liveNodeError } from './account-ledger';
import { AccountStatesService } from './account-states.service';

/** The account flags of an account at a ledger, and the ledger they were read at. */
export interface AccountFlags {
  ledgerIndex: number;
  /** Unix seconds; only a ledger read from ClickHouse has one. */
  closeTime?: number;
  /** Every account flag the network names, set or not. */
  flags: Record<string, boolean>;
  /** Read from the live node (no historical ledger named). */
  live: boolean;
}

interface AccountInfoResult {
  account_data: { Flags?: number };
  ledger_index?: number;
  ledger_current_index?: number;
}

/**
 * The account flags of an account (`?flags=true` of `GET /v2/accounts/:address`), named for the network
 * (`accountFlagsOf`).
 *
 * With a historical ledger named (a hash, a date or a ledger number; `StateLedgerService`) they come from the account
 * state history: the newest `account_states` row of the account at or before that ledger. No row, or a row that deleted
 * the account, answers 404 `account not found`, as the node does for an account that does not exist at a ledger.
 *
 * Without one (or with `validated`, `closed` or `current`) they come from `account_info` on the live node, the validated
 * ledger by default, cached like the other live answers (`ApiConfig.liveCacheTtlMs`).
 */
@Injectable()
export class AccountFlagsService {
  private readonly names: readonly AccountFlag[];

  constructor(
    private readonly states: AccountStatesService,
    private readonly ledgers: StateLedgerService,
    private readonly xrpl: XrplService,
    private readonly cache: CacheService,
    private readonly config: ApiConfig,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
  ) {
    this.names = accountFlagsOf(profile);
  }

  async flags(address: string, selector: LedgerSelector): Promise<AccountFlags> {
    const ledger = await this.ledgers.resolve(selector);
    if (ledger === undefined) return this.live(address, selector.index ?? 'validated');

    const state = await this.states.stateAt(address, ledger.ledger_index);
    if (state === undefined) throw notFound('account not found');
    return {
      ledgerIndex: ledger.ledger_index,
      closeTime: ledger.close_time,
      flags: namedAccountFlags(state.flags, this.names),
      live: false,
    };
  }

  private async live(address: string, ledgerIndex: number | string): Promise<AccountFlags> {
    const key = liveCacheKey('flags', address, ledgerIndex);
    return this.cache.wrap(key, this.config.liveCacheTtlMs, async () => {
      try {
        const info = await this.xrpl.request<AccountInfoResult>({
          command: 'account_info',
          account: address,
          ledger_index: ledgerIndex,
        });
        return {
          ledgerIndex: (info.ledger_index ?? info.ledger_current_index) as number,
          flags: namedAccountFlags(info.account_data.Flags ?? 0, this.names),
          live: true,
        };
      } catch (err) {
        return liveNodeError(err);
      }
    });
  }
}

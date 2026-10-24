import { dropsToNative, NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { notFound } from '../common/errors';
import { StateLedger, StateLedgerService } from '../common/state-ledger.service';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { XrplService } from '../xrpl/xrpl.service';
import { LedgerSelector, LedgerSpec, liveCacheKey, LiveDeadline, liveNodeError, pagedLedger } from './account-ledger';
import { AccountStatesService } from './account-states.service';
import { LiveLedgerService } from './live-ledger.service';
import { TrustLinesService } from './trust-lines.service';

/** A balance of the account: the native one has no `counterparty`. Keys in the order of the original. */
export interface Balance {
  currency: string;
  counterparty?: string;
  value: string;
}

/** What `GET /v2/accounts/:address/balances` is asked for; the values are already validated. */
export interface BalancesQuery {
  address: string;
  selector: LedgerSelector;
  /** Only the balances in this currency, compared as written. The native currency alone is just the native balance. */
  currency?: string;
  /** The `peer` of the trust lines. The native balance is not filtered by it. */
  counterparty?: string;
  /** At most this many balances, the native one included; `undefined` is all of them. */
  limit?: number;
}

export interface BalancesResult {
  /** The ledger the balances were read at: the one the node answered for, or the stored one. */
  ledgerIndex?: number;
  /** Unix seconds: the close time of a historical ledger, or of the ledger a date chose. */
  closeTime?: number;
  balances: Balance[];
  /** Read from the live node (no historical ledger named), not from the state history. */
  live: boolean;
}

/** Trust lines asked of the node per request (`rippled.js`). */
export const LINES_PAGE_SIZE = 400;

/** The part of an `account_info` result this service reads. */
interface AccountInfoResult {
  account_data: { Balance: string };
  ledger_index?: number;
  ledger_current_index?: number;
}

/** The part of an `account_lines` result this service reads. */
interface AccountLinesResult {
  lines: { account: string; balance: string; currency: string }[];
  marker?: unknown;
}

/**
 * The balances of an account at a ledger: from the account state history in ClickHouse for a historical ledger, from the
 * live node for the current one (ADR-0015).
 *
 * A ledger named by a hash, a date or a number (`StateLedgerService.resolve`) is historical. Its native balance is the
 * account's state at that ledger (`AccountStatesService`), its trust lines those of `/trustlines` at that ledger
 * (`TrustLinesService`), ordered by (counterparty, currency), with the same `currency`, `counterparty` and `limit` as
 * below. No state of the account at that ledger, or a state that deleted it, is 404 `account not found`, as the node
 * answers; a ledger the state tables do not cover is 400 `the date provided is too old`. The answer always carries the
 * ledger's close time, and is not put in the live cache (the history of a ledger does not move with the node).
 *
 * Without one, or with `validated`, `closed` or `current`, the balances come from the live node (`rippled.getBalances` of
 * the original): `account_info` for the native balance and the ledger, then `account_lines` for the trust lines, in the
 * node's order, paged, on the very ledger `account_info` answered for, so that a validated ledger that moves on between
 * the requests cannot mix two states.
 *
 * Differences from the original, each a bug fix:
 *  - the default ledger is `validated` (it asked for the open ledger);
 *  - the lines are paged until the limit is filled with lines that pass the filters. The original cut the first page
 *    to the limit and filtered afterwards, so a `currency` could miss its lines on later pages (and, by subtracting
 *    the page size twice, never read a second page at all);
 *  - `limit=all` reads every page (R32), within an overall deadline of 30 s (R108: past it the route answers its 500);
 *  - the trust lines are read from the index `account_info` answered with (a marker belongs to one ledger).
 *
 * A live response is cached (`ApiConfig.liveCacheTtlMs`) under the whole resolved request: address, the ledger spec,
 * filters and limit. A `validated` entry shows the ledger it was read at in `ledger_index`, and is at most the TTL old.
 */
@Injectable()
export class AccountBalancesService {
  private readonly native: string;

  constructor(
    private readonly xrpl: XrplService,
    private readonly ledgers: LiveLedgerService,
    private readonly stateLedgers: StateLedgerService,
    private readonly states: AccountStatesService,
    private readonly trustLines: TrustLinesService,
    private readonly cache: CacheService,
    private readonly config: ApiConfig,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
  ) {
    this.native = profile.nativeCurrency;
  }

  async balances(q: BalancesQuery): Promise<BalancesResult> {
    const historical = await this.stateLedgers.resolve(q.selector);
    if (historical !== undefined) return this.historical(q, historical);

    const { spec, closeTime } = await this.ledgers.resolve(q.selector);
    const key = liveCacheKey('balances', q.address, spec, q.currency, q.counterparty, q.limit);
    const found = await this.cache.wrap(key, this.config.liveCacheTtlMs, () => this.read(q, spec));
    // not part of the entry: the same ledger can be asked for with a date or without
    return { ...found, ...(closeTime !== undefined && { closeTime }), live: true };
  }

  /** The balances at a historical ledger, from the account and trust line state history. */
  private async historical(q: BalancesQuery, ledger: StateLedger): Promise<BalancesResult> {
    const state = await this.states.stateAt(q.address, ledger.ledger_index);
    if (state === undefined) throw notFound('account not found');
    const at = { ledgerIndex: ledger.ledger_index, closeTime: ledger.close_time, live: false };
    const native: Balance = { currency: this.native, value: state.balance };
    if (q.currency === this.native) return { ...at, balances: [native] };

    const balances = q.currency === undefined ? [native] : [];
    const wanted = q.limit === undefined ? undefined : q.limit - balances.length;
    if (wanted === 0) return { ...at, balances };
    const which = {
      address: q.address,
      ledgerIndex: ledger.ledger_index,
      currency: q.currency,
      counterparty: q.counterparty,
    };
    // `limit=all`: every line, page by page, never in one read of the account's whole line history
    const lines =
      wanted === undefined
        ? await this.trustLines.linesAll(which)
        : await this.trustLines.linesAt({ ...which, limit: wanted });
    for (const line of lines)
      balances.push({ currency: line.currency, counterparty: line.counterparty, value: line.balance });
    return { ...at, balances };
  }

  private async read(q: BalancesQuery, spec: LedgerSpec): Promise<Omit<BalancesResult, 'live'>> {
    const deadline = LiveDeadline.for(q.limit);
    try {
      const info = await deadline.race(
        this.xrpl.request<AccountInfoResult>({ command: 'account_info', account: q.address, ...spec }),
      );
      const ledgerIndex = info.ledger_index ?? info.ledger_current_index;
      const native: Balance = { currency: this.native, value: dropsToNative(info.account_data.Balance) };
      // `currency=<native>` is the native balance and nothing else, whatever the other filters say
      if (q.currency === this.native) return { ledgerIndex, balances: [native] };

      const balances = q.currency === undefined ? [native] : [];
      const lines = await this.lines(q, pagedLedger(spec, ledgerIndex), balances.length, deadline);
      return { ledgerIndex, balances: [...balances, ...lines] };
    } catch (err) {
      return liveNodeError(err);
    }
  }

  /** The trust lines that pass the filters, as balances, as many as the limit leaves room for after `taken` balances. */
  private async lines(q: BalancesQuery, ledger: LedgerSpec, taken: number, deadline: LiveDeadline): Promise<Balance[]> {
    const wanted = q.limit === undefined ? Infinity : q.limit - taken;
    const out: Balance[] = [];
    let marker: unknown;
    while (out.length < wanted) {
      deadline.check();
      const page: AccountLinesResult = await deadline.race(
        this.xrpl.request<AccountLinesResult>({
          command: 'account_lines',
          account: q.address,
          ...ledger,
          limit: LINES_PAGE_SIZE,
          ...(q.counterparty !== undefined && { peer: q.counterparty }),
          ...(marker !== undefined && { marker }),
        }),
      );
      for (const line of page.lines) {
        if (q.currency !== undefined && line.currency !== q.currency) continue;
        out.push({ currency: line.currency, counterparty: line.account, value: line.balance });
        if (out.length >= wanted) break;
      }
      if (out.length >= wanted || page.marker === undefined || page.marker === null) break;
      // a node that answers with the marker it was given would be asked forever
      if (JSON.stringify(page.marker) === JSON.stringify(marker)) {
        throw new Error('account_lines answered with the marker it was given');
      }
      marker = page.marker;
    }
    return out;
  }
}

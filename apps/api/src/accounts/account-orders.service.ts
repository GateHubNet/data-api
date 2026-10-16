import { NetworkProfile } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { ApiConfig, NETWORK_PROFILE } from '../config/api.config';
import { XrplService } from '../xrpl/xrpl.service';
import { LedgerSelector, LedgerSpec, liveCacheKey, liveNodeError } from './account-ledger';
import { LiveLedgerService } from './live-ledger.service';
import { NodeOffer, OrderObject, toOrderObject } from './order-object';

/** What `GET /v2/accounts/:address/orders` is asked for; the values are already validated. */
export interface OrdersQuery {
  address: string;
  selector: LedgerSelector;
  /** At most this many orders; `undefined` is all of them. */
  limit?: number;
}

export interface OrdersResult {
  /** The ledger the node answered for. */
  ledgerIndex?: number;
  /** Unix seconds, when a date chose the ledger. */
  closeTime?: number;
  orders: OrderObject[];
}

/** Offers asked of the node per request at most (rippled's own maximum for `account_offers`). */
export const OFFERS_PAGE_SIZE = 400;

/** The part of an `account_offers` result this service reads. */
interface AccountOffersResult {
  offers: NodeOffer[];
  ledger_index?: number;
  ledger_current_index?: number;
  marker?: unknown;
}

/**
 * The open orders of an account on the live node (`rippled.getOrders` of the original): `account_offers`, paged until
 * the limit is filled (`limit=all`: until the node has no more).
 *
 * The first request names the ledger the caller chose (or `validated`); once the node has said which ledger that was,
 * the following pages are asked of that ledger by its index, because a marker is only good for the ledger it came from
 * and a validated ledger moves on every few seconds. A page asks for no more offers than the limit still lacks
 * (at most 400); the original asked for 100 each time.
 *
 * Cached like the balances: `ApiConfig.liveCacheTtlMs`, under the whole resolved request.
 */
@Injectable()
export class AccountOrdersService {
  private readonly native: string;

  constructor(
    private readonly xrpl: XrplService,
    private readonly ledgers: LiveLedgerService,
    private readonly cache: CacheService,
    private readonly config: ApiConfig,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
  ) {
    this.native = profile.nativeCurrency;
  }

  async orders(q: OrdersQuery): Promise<OrdersResult> {
    const { spec, closeTime } = await this.ledgers.resolve(q.selector);
    const key = liveCacheKey('orders', q.address, spec, q.limit);
    const found = await this.cache.wrap(key, this.config.liveCacheTtlMs, () => this.read(q, spec));
    // not part of the entry: the same ledger can be asked for with a date or without
    return closeTime === undefined ? found : { ...found, closeTime };
  }

  private async read(q: OrdersQuery, chosen: LedgerSpec): Promise<OrdersResult> {
    const wanted = q.limit ?? Infinity;
    const orders: OrderObject[] = [];
    let ledger = chosen;
    let ledgerIndex: number | undefined;
    let marker: unknown;
    try {
      for (;;) {
        const page: AccountOffersResult = await this.xrpl.request<AccountOffersResult>({
          command: 'account_offers',
          account: q.address,
          ...ledger,
          limit: Math.min(OFFERS_PAGE_SIZE, wanted - orders.length),
          ...(marker !== undefined && { marker }),
        });
        ledgerIndex ??= page.ledger_index ?? page.ledger_current_index;
        for (const offer of page.offers) {
          if (orders.length >= wanted) break;
          orders.push(toOrderObject(offer, q.address, this.native));
        }

        if (orders.length >= wanted || page.marker === undefined || page.marker === null) break;
        // a node that answers with the marker it was given would be asked forever
        if (JSON.stringify(page.marker) === JSON.stringify(marker)) {
          throw new Error('account_offers answered with the marker it was given');
        }
        marker = page.marker;
        // the marker belongs to the ledger of this page: the next page asks for that ledger by its index
        if (ledgerIndex !== undefined) ledger = { ledger_index: ledgerIndex };
      }
    } catch (err) {
      return liveNodeError(err);
    }
    return { ledgerIndex, orders };
  }
}

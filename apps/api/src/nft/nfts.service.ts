import {
  ClickHouseService,
  convertedSalePrices,
  DailyRates,
  foldNftEvents,
  NftEventName,
  NftEventRead,
  NftEventsRow,
  readDistinctPage,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import {
  NftEventObject,
  NftObject,
  NftOfferObject,
  toNftEventObject,
  toNftObject,
  toNftOfferObject,
} from './nft-objects';
import { NftOfferType } from './nft-params';

/** The key of the history of an NFT, the end of the ORDER BY of `nft_events`: what a marker holds. */
export const NFT_EVENT_POSITION: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'event_index', type: 'UInt16' },
];

/** The whole ORDER BY of `nft_events`: the NFT is fixed by the read, but the read has to ask for the whole key. */
const EVENT_ORDER = ['nft_id', ...columnsOf(NFT_EVENT_POSITION)];

/**
 * The columns of `nft_events` that an event object is made of (a row of `NftEventsRow`): the times as unix seconds, an
 * expiration that is `NULL` for an offer that has none.
 */
export const EVENT_COLUMNS = [
  'nft_id',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'tx_type',
  'toUnixTimestamp(close_time) AS close_time',
  'kind',
  'event',
  'issuer',
  'taxon',
  'taxon_key',
  'serial',
  'nft_flags',
  'transfer_fee',
  'uri',
  'digest',
  'account',
  'from_account',
  'to_account',
  'offer_id',
  'is_sell_offer',
  'amount',
  'amount_f',
  'currency',
  'amount_issuer',
  'destination',
  'toUnixTimestamp(expiration) AS expiration',
  'broker',
  'broker_fee',
  'royalty_est',
  'removed_by',
].join(', ');

/** The columns the fold reads (`NftEventRead`). */
const FOLD_COLUMNS = [
  'nft_id',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'kind',
  'event',
  'issuer',
  'taxon',
  'taxon_key',
  'serial',
  'nft_flags',
  'transfer_fee',
  'uri',
  'digest',
  'account',
  'from_account',
  'to_account',
  'amount',
  'currency',
  'amount_issuer',
].join(', ');

/** The events of an NFT, each once (a row written twice is not collapsed before a merge), up to the head, oldest first. */
const FOLD_EVENTS_SQL = `SELECT ${FOLD_COLUMNS}
  FROM ${Table.NftEvents}
 WHERE nft_id = {id:String} AND ledger_index <= {head:UInt32}
 ORDER BY ${EVENT_ORDER.map((c) => `${c} ASC`).join(', ')}
 LIMIT 1 BY ${EVENT_ORDER.join(', ')}`;

/** The first event of an NFT up to the head: whether the index knows the NFT at all, and whether its first event is its mint. */
const FIRST_EVENT_SQL = `SELECT ledger_index, event
  FROM ${Table.NftEvents}
 WHERE nft_id = {id:String} AND ledger_index <= {head:UInt32}
 ORDER BY ${EVENT_ORDER.map((c) => `${c} ASC`).join(', ')}
 LIMIT 1`;

/** The key of an open offer, the key of the `offer_create` that made it: what the marker of the offers holds. */
const OFFER_POSITION = NFT_EVENT_POSITION;

interface Counted {
  ledger_index: number | string;
  tx_index: number | string;
  event_index: number | string;
}

/** The `${ledger_index}:${tx_index}:${event_index}` key that `convertedSalePrices` answers by. */
const saleKeyOf = (r: Counted): string => `${Number(r.ledger_index)}:${Number(r.tx_index)}:${Number(r.event_index)}`;

/** The window and the page of the history of an NFT. The values are already validated. */
export interface HistoryQuery {
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  events?: NftEventName[];
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface OffersQuery {
  type?: NftOfferType;
  limit: number;
  marker?: string;
}

export interface NftAnswer {
  coverage: Coverage;
  nft: NftObject;
}

export interface HistoryAnswer {
  coverage: Coverage;
  events: NftEventObject[];
  marker?: string;
}

export interface OffersAnswer {
  coverage: Coverage;
  offers: NftOfferObject[];
  marker?: string;
}

/**
 * The routes of one NFT (spec sections 5.2 to 5.4): its detail, its history and its open offers. Every route answers
 * `undefined` (a 404 `nft not found`) when the index has no event of the NFT, and reads ledgers up to the newest `ledgers`
 * row only (a ledger is committed once its row is written, after every child table of it).
 *
 *  - **The detail** folds the NFT's events (`foldNftEvents`, the function of the `nft_state` job: the same facts, fresh at the
 *    commit of a ledger and not when the aggregator gets to it), a range of the primary key of `nft_events`, and joins the
 *    converted price of its last sale (`convertedSalePrices`, on `${ledger_index}:${tx_index}:${event_index}`).
 *  - **The history** is a range of the same key, read in the order of the key a page at a time by `readDistinctPage`. The
 *    filters (the dates as a range of ledgers, the events) are conditions of the inner read that is capped: a filter after the
 *    page would leave a page short or empty while there is a next one.
 *  - **The open offers** are worked out at read time from the NFT's offer events: the newest event of each `offer_id` is kept,
 *    and it is open when that is its `offer_create`. They are read in newest-first order and paged by the key of that event.
 *
 * The `coverage` of the three is the NFT's own (`FeatureCoverageService.itemCoverage`): complete when the NFT's first indexed
 * event is its mint, whether or not the history of the feature is whole.
 */
@Injectable()
export class NftsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly coverage: FeatureCoverageService,
    private readonly rates: DailyRates,
  ) {}

  /** The NFT folded from its events, or `undefined` when none is indexed. */
  async detail(id: string): Promise<NftAnswer | undefined> {
    const head = await this.ranges.latest();
    if (head === undefined) return undefined;
    const events = await this.ch.query<NftEventRead>(FOLD_EVENTS_SQL, { id, head });
    if (events.length === 0) return undefined;
    const fold = foldNftEvents(events);

    const sale = fold.last_sale;
    const [coverage, converted] = await Promise.all([
      this.coverage.itemCoverage('nfts', fold.created_ledger),
      sale === undefined
        ? undefined
        : convertedSalePrices(this.ch, this.rates, [
            { ledger_index: sale.ledger_index, tx_index: sale.tx_index, event_index: sale.event_index },
          ]),
    ]);
    const price = sale === undefined ? undefined : converted?.get(saleKeyOf(sale));
    return { coverage, nft: toNftObject(fold, price) };
  }

  /** One page of the events of an NFT, in the order asked for; `undefined` when none is indexed. */
  async history(id: string, q: HistoryQuery): Promise<HistoryAnswer | undefined> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the NFT is
    const after = decodeMarker(q.marker, NFT_EVENT_POSITION);
    const known = await this.known(id);
    if (known === undefined) return undefined;
    const coverage = await this.coverage.itemCoverage('nfts', known.createdLedger);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { coverage, events: [] };

    // the columns after the NFT, which the query fixes: `keysetClause` bounds the first of them on its own, which ClickHouse
    // narrows the read with
    const cursor = keysetClause(NFT_EVENT_POSITION, q.descending, after);
    const rows = await readDistinctPage<NftEventsRow>(this.ch, {
      columns: EVENT_COLUMNS,
      table: Table.NftEvents,
      where: [
        'nft_id = {id:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(q.events !== undefined ? ['event IN {events:Array(String)}'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: EVENT_ORDER,
      unique: columnsOf(NFT_EVENT_POSITION),
      descending: q.descending,
      params: {
        id,
        min: range.min,
        max: range.max,
        ...(q.events !== undefined && { events: q.events }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index, row.event_index]);

    const converted = await convertedSalePrices(
      this.ch,
      this.rates,
      page.rows.filter((r) => r.event === 'sale'),
    );
    return {
      coverage,
      events: page.rows.map((r) => toNftEventObject(r, converted.get(saleKeyOf(r)))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** One page of the open offers of an NFT, newest first; `undefined` when no event of the NFT is indexed. */
  async offers(id: string, q: OffersQuery): Promise<OffersAnswer | undefined> {
    const after = decodeMarker(q.marker, OFFER_POSITION);
    const known = await this.known(id);
    if (known === undefined) return undefined;
    const coverage = await this.coverage.itemCoverage('nfts', known.createdLedger);

    // the newest event of each offer (inside), kept when it is the offer's creation (outside); the marker and the side are
    // conditions of the outside only: an offer made before the marker may have been ended after it
    const cursor = keysetClause(OFFER_POSITION, true, after);
    const rows = await this.ch.query<NftEventsRow>(
      `SELECT *
         FROM (SELECT ${EVENT_COLUMNS}
                 FROM ${Table.NftEvents}
                WHERE nft_id = {id:String} AND ledger_index <= {head:UInt32}
                  AND event IN ('offer_create', 'offer_cancel', 'offer_removed')
                ORDER BY ledger_index DESC, tx_index DESC, event_index DESC
                LIMIT 1 BY offer_id)
        WHERE event = 'offer_create'
          ${q.type !== undefined ? 'AND is_sell_offer = {sell:UInt8}' : ''}
          ${cursor.clause !== '' ? `AND ${cursor.clause}` : ''}
        ORDER BY ledger_index DESC, tx_index DESC, event_index DESC
        LIMIT {n:UInt32}`,
      {
        id,
        head: known.head,
        ...(q.type !== undefined && { sell: q.type === 'sell' ? 1 : 0 }),
        ...cursor.params,
        n: q.limit + 1,
      },
    );
    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index, row.event_index]);
    return {
      coverage,
      offers: page.rows.map(toNftOfferObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /**
   * Whether the index has an event of the NFT in a committed ledger: the committed head (the cap of every read of the
   * request) and, for the coverage, the ledger of the NFT's creation, which is its first event's when that is a mint.
   */
  private async known(id: string): Promise<{ head: number; createdLedger?: number } | undefined> {
    const head = await this.ranges.latest();
    if (head === undefined) return undefined;
    const first = await this.ch.queryOne<{ ledger_index: number | string; event: NftEventName }>(FIRST_EVENT_SQL, {
      id,
      head,
    });
    if (first === undefined) return undefined;
    return { head, ...(first.event === 'mint' && { createdLedger: Number(first.ledger_index) }) };
  }
}

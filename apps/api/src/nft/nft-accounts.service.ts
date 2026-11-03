import {
  ClickHouseService,
  convertedSalePrices,
  DailyRates,
  NftEventName,
  NftEventsRow,
  NftRole,
  NftsRow,
  readDistinctPage,
  readNewestPage,
  saleKey,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetBranches, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { COLLECTION_NFT_POSITION, NFT_COLUMNS } from './nft-collections.service';
import { NftEventObject, nftFoldOfRow, NftObject, toNftEventObject, toNftObject } from './nft-objects';
import { EVENT_COLUMN_LIST, NFT_EVENT_POSITION } from './nfts.service';

/** The key of an NFT among an account's holdings, the end of the key of `account_nfts`: what the marker of `/nfts` holds. */
export const ACCOUNT_NFT_POSITION: KeysetKey[] = [
  { column: 'issuer', type: 'String' },
  { column: 'taxon_key', type: 'UInt32' },
  ...COLLECTION_NFT_POSITION,
];

/** The whole sorting key of `account_nfts`: the owner is fixed by the read, but the read has to ask for the whole key. */
const HOLDING_ORDER = ['owner', ...columnsOf(ACCOUNT_NFT_POSITION)];

/** The whole sorting key of `account_nft_events`. */
const ACCOUNT_EVENT_ORDER = ['account', ...columnsOf(NFT_EVENT_POSITION)];

/**
 * The columns of an event object from `account_nft_events`: its `actor` is the `account` of the event (who did it), and
 * `account` is the account the row is for, which is not the event's. They are read as `actor` and not as `actor AS account`: an
 * alias shadows the column of the same name in the `WHERE` and `ORDER BY` of the same SELECT, and `account` there is the first
 * column of the key.
 */
const ACCOUNT_EVENT_COLUMNS = EVENT_COLUMN_LIST.map((column) => (column === 'account' ? 'actor' : column)).join(', ');

/**
 * The newest `nfts` row of the NFTs of a page of holdings, by the whole key of each. The holdings of an account lie in
 * collections of their own, so the key is the whole of `(issuer, taxon_key, serial, nft_id)` and not a collection's prefix.
 *
 * The bound of the read is the granules the NFTs of the page lie in: ClickHouse tests each granule of a part against the keys of
 * the set (the set is ordered by the whole key, so the test is exact) and reads those that can hold one. A page of holdings that
 * lie together (an owner's NFTs of one collection, in serial order: the first 200 of 120,000) reads about a granule of each part.
 * Holdings that lie far from one another read a granule each: 200 scattered over one collection read about every granule of that
 * collection's `nfts` rows, and a page across collections the granules of the collections it names. So the bound is the `nfts` rows
 * of the collections the page names (at most `limit` of them) and a granule of each part at the edges, never the rows of any
 * other collection and never the table; `paged-reads.e2e-spec.ts` pins the three cases (one owner of 120,000, an account whose
 * holdings are spread over a collection, and one whose holdings are in two collections).
 */
const NFTS_OF_HOLDINGS_SQL = `SELECT ${NFT_COLUMNS}
  FROM ${Table.Nfts}
 WHERE (issuer, taxon_key, serial, nft_id) IN (
       SELECT arrayJoin(arrayZip({issuers:Array(String)}, {taxon_keys:Array(UInt32)}, {serials:Array(UInt32)}, {ids:Array(String)})))
 ORDER BY issuer ASC, taxon_key ASC, serial ASC, nft_id ASC, version DESC
 LIMIT 1 BY issuer, taxon_key, serial, nft_id`;

/** The key of an NFT among the rows of a read: its collection, serial and id (a number may come back as the text of one). */
const holdingKey = (row: {
  issuer: string;
  taxon_key: number | string;
  serial: number | string;
  nft_id: string;
}): string => [row.issuer, Number(row.taxon_key), Number(row.serial), row.nft_id].join('\u0000');

/** The NFTs an account holds, as the request names them. The values are already validated. */
export interface HoldingsQuery {
  /** Only the NFTs of this issuer (a prefix of the key). */
  issuer?: string;
  /** Only the NFTs of this taxon of the issuer (with `issuer`). */
  taxon_key?: number;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface HoldingsAnswer {
  coverage: Coverage;
  nfts: NftObject[];
  marker?: string;
}

/** The window and the page of the NFT history of an account. The values are already validated. */
export interface AccountHistoryQuery {
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  events?: NftEventName[];
  /** Keeps the events in which the account has any of these roles. */
  roles?: NftRole[];
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface AccountHistoryAnswer {
  coverage: Coverage;
  events: NftEventObject[];
  marker?: string;
}

/** A row of `account_nft_events` as the history reads it: the event of `nft_events`, with the actor in the place of `account`. */
type AccountEventRead = Omit<NftEventsRow, 'account'> & { actor: string };

/**
 * The NFT routes of an account (spec sections 5.5 and 5.6). The address is not checked: one that is none (or an X-address)
 * has an empty list, as on the other routes under an account. Every answer states `coverage('nfts')`, the feature's own.
 *
 *  - **The holdings** page the newest `account_nfts` row of each of the account's NFTs by `readNewestPage`, the rows whose
 *    newest version says `held = 1` (an NFT sold away has a newer row of `held = 0`, which hides the older one), in the order of
 *    the key: the collection (issuer, then taxon), then the serial. The NFTs themselves are the newest `nfts` rows of the page.
 *    `issuer` and `taxon` narrow the prefix of the read.
 *  - **The history** is a range of the primary key of `account_nft_events` (the account, then its ledgers), read in the order of
 *    the key a page at a time by `readDistinctPage`. The filters (the dates as a range of ledgers, the events, the roles) are
 *    conditions of the inner read that is capped: a filter after the page would leave a page short or empty while there is a
 *    next one. A role matches when the account has any of those named in that event.
 * Reads end at the newest `ledgers` row (`LedgerRangeResolver`), and the aggregates are written by jobs that read committed
 * ledgers only.
 */
@Injectable()
export class NftAccountsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly coverage: FeatureCoverageService,
    private readonly rates: DailyRates,
  ) {}

  /** One page of the NFTs the account holds, by collection and then serial. */
  async holdings(address: string, q: HoldingsQuery): Promise<HoldingsAnswer> {
    // before any query: a marker that is none of ours is the client's mistake
    const after = decodeMarker(q.marker, ACCOUNT_NFT_POSITION);
    const coverage = await this.coverage.coverage('nfts');

    // the owner, and the collection when it is asked for, are the prefix of the key. The marker holds the issuer, the taxon, the
    // serial and the id, none of them fixed by the query when no collection is named, so its condition is written as branches
    // (`keysetBranches`): a tuple comparison would start the read at the issuer of the marker, however far into it the marker is
    const cursor = keysetBranches(ACCOUNT_NFT_POSITION, false, after);
    const held = await readNewestPage<{
      issuer: string;
      taxon_key: number | string;
      serial: number | string;
      nft_id: string;
    }>(this.ch, {
      columns: 'owner, issuer, taxon_key, serial, nft_id, held',
      table: Table.AccountNfts,
      where: [
        'owner = {owner:String}',
        ...(q.issuer !== undefined ? ['issuer = {issuer:String}'] : []),
        ...(q.taxon_key !== undefined ? ['taxon_key = {taxon_key:UInt32}'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      key: HOLDING_ORDER,
      keep: 'held = 1',
      descending: false,
      params: {
        owner: address,
        ...(q.issuer !== undefined && { issuer: q.issuer }),
        ...(q.taxon_key !== undefined && { taxon_key: q.taxon_key }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    const page = paginate(held, q.limit, (r) => [r.issuer, Number(r.taxon_key), Number(r.serial), r.nft_id]);
    const rows = await this.nftsOf(page.rows);
    return {
      coverage,
      // `last_sale` has no `converted_amount` here: the row has no transaction index to join the price of the sale on
      nfts: rows.map((row) => toNftObject(nftFoldOfRow(row))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** One page of the events the account is named in, in the order asked for. */
  async history(address: string, q: AccountHistoryQuery): Promise<AccountHistoryAnswer> {
    const after = decodeMarker(q.marker, NFT_EVENT_POSITION);
    const coverage = await this.coverage.coverage('nfts');

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { coverage, events: [] };

    // the columns after the account, which the query fixes: `keysetClause` bounds the first of them on its own, which
    // ClickHouse narrows the read with
    const cursor = keysetClause(NFT_EVENT_POSITION, q.descending, after);
    const rows = await readDistinctPage<AccountEventRead>(this.ch, {
      columns: ACCOUNT_EVENT_COLUMNS,
      table: Table.AccountNftEvents,
      where: [
        'account = {account:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(q.events !== undefined ? ['event IN {events:Array(String)}'] : []),
        ...(q.roles !== undefined ? ['hasAny(roles, {roles:Array(String)})'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: ACCOUNT_EVENT_ORDER,
      unique: columnsOf(NFT_EVENT_POSITION),
      descending: q.descending,
      params: {
        account: address,
        min: range.min,
        max: range.max,
        ...(q.events !== undefined && { events: q.events }),
        ...(q.roles !== undefined && { roles: q.roles }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (r) => [r.ledger_index, r.tx_index, r.event_index]);

    const events = page.rows.map(({ actor, ...row }): NftEventsRow => ({ ...row, account: actor }));
    const converted = await convertedSalePrices(
      this.ch,
      this.rates,
      events.filter((e) => e.event === 'sale'),
    );
    return {
      coverage,
      events: events.map((e) => toNftEventObject(e, converted.get(saleKey(e)))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /**
   * The newest `nfts` rows of the NFTs of a page of holdings, in the order of the page. An NFT whose `nfts` row is not written
   * yet (the aggregator writes the holdings first and the `nfts` rows after them) is left out of the page.
   */
  private async nftsOf(
    holdings: Array<{ issuer: string; taxon_key: number | string; serial: number | string; nft_id: string }>,
  ): Promise<NftsRow[]> {
    if (holdings.length === 0) return [];
    const found = await this.ch.query<NftsRow>(NFTS_OF_HOLDINGS_SQL, {
      issuers: holdings.map((h) => h.issuer),
      taxon_keys: holdings.map((h) => Number(h.taxon_key)),
      serials: holdings.map((h) => Number(h.serial)),
      ids: holdings.map((h) => h.nft_id),
    });
    const byKey = new Map(found.map((row) => [holdingKey(row), row]));
    return holdings.flatMap((h) => byKey.get(holdingKey(h)) ?? []);
  }
}

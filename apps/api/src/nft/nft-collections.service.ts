import {
  ClickHouseService,
  CollectionKey,
  convertedSalePrices,
  DailyRates,
  NftCollectionsRow,
  NftEventsRow,
  nftSalesNativeSql,
  NftsRow,
  readDistinctPage,
  readNewestPage,
  saleKey,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { Coverage, FeatureCoverageService } from '../common/feature-coverage.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import {
  CollectionDayObject,
  CollectionDayRow,
  CollectionObject,
  HolderObject,
  nftFoldOfRow,
  NftObject,
  NftSaleObject,
  toCollectionDayObject,
  toCollectionObject,
  toHolderObject,
  toNftObject,
  toNftSaleObject,
} from './nft-objects';
import { CollectionSort } from './nft-params';
import { EVENT_COLUMNS, NFT_EVENT_POSITION } from './nfts.service';

/** How long the newest rows of every collection are kept (the list sorts and pages them per request). */
export const COLLECTIONS_CACHE_MS = 60_000;
/**
 * The key of that list in `CacheService`, `nft-collections:*`. Only the list of every collection is kept: the list of one issuer
 * is a read of a prefix of a few rows, and a key for each issuer a request names would let requests evict the other entries of
 * the cache (it is a 10,000-entry FIFO shared with the coverage of every feature and the rollup coverage of accounts).
 */
export const COLLECTIONS_CACHE_KEY = 'nft-collections:*';

/** The key of an NFT inside a collection, the end of the key of `nfts`: what the marker of `/nfts` holds. */
export const COLLECTION_NFT_POSITION: KeysetKey[] = [
  { column: 'serial', type: 'UInt32' },
  { column: 'nft_id', type: 'String' },
];

/** The whole sorting keys of the tables a collection's lists page through: the collection is fixed by the read, not by the key. */
const NFT_ORDER = ['issuer', 'taxon_key', ...columnsOf(COLLECTION_NFT_POSITION)];
const HOLDING_ORDER = ['owner', ...NFT_ORDER];
const SALE_ORDER = ['issuer', 'taxon_key', ...columnsOf(NFT_EVENT_POSITION)];

/** The marker of the holders: how many NFTs the owner holds, then the owner. */
export const HOLDER_POSITION: KeysetKey[] = [
  { column: 'held', type: 'UInt32' },
  { column: 'owner', type: 'String' },
];

/** The columns of a row of `nfts` as `nftFoldOfRow` takes it: the times as unix seconds. */
export const NFT_COLUMNS = [
  'issuer',
  'taxon_key',
  'serial',
  'nft_id',
  'kind',
  'taxon',
  'nft_flags',
  'transfer_fee',
  'owner',
  'owner_ledger',
  'owner_tx',
  'toUnixTimestamp(owner_time) AS owner_time',
  'uri',
  'digest',
  'minted_ledger',
  'minted_tx',
  'toUnixTimestamp(minted_time) AS minted_time',
  'minted_by',
  'minted_to',
  'burned',
  'burned_ledger',
  'burned_tx',
  'toUnixTimestamp(burned_time) AS burned_time',
  'burned_by',
  'sale_count',
  'last_sale_ledger',
  'last_sale_tx',
  'toUnixTimestamp(last_sale_time) AS last_sale_time',
  'last_sale_amount',
  'last_sale_currency',
  'last_sale_amount_issuer',
  'first_ledger',
  'last_ledger',
].join(', ');

/** The columns of a row of `nft_collections` as `toCollectionObject` takes it. */
const COLLECTION_COLUMNS = [
  'issuer',
  'taxon_key',
  'kind',
  'taxon',
  'supply',
  'holders',
  'minted',
  'burned',
  'sales_count',
  'volume_native',
  'volume_native_f',
  'first_mint_ledger',
  'first_mint_tx',
  'toUnixTimestamp(first_mint_time) AS first_mint_time',
  'last_mint_ledger',
  'last_mint_tx',
  'toUnixTimestamp(last_mint_time) AS last_mint_time',
  'last_ledger',
].join(', ');

type StoredCollection = Omit<NftCollectionsRow, 'version'>;

/** The newest row of every collection (of an issuer), by the key of the table: a read of the rows of `nft_collections`, once. */
const COLLECTIONS_SQL = (filtered: boolean): string => `SELECT ${COLLECTION_COLUMNS}
  FROM ${Table.NftCollections}${filtered ? '\n WHERE issuer = {issuer:String}' : ''}
 ORDER BY issuer ASC, taxon_key ASC, version DESC
 LIMIT 1 BY issuer, taxon_key`;

/** The newest row of one collection: a read of its key. */
const COLLECTION_SQL = `SELECT ${COLLECTION_COLUMNS}
  FROM ${Table.NftCollections}
 WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}
 ORDER BY version DESC
 LIMIT 1`;

/**
 * The newest `nfts` row of some NFTs of a collection, by the whole key of each: what a page of holdings is made into NFTs with.
 * The read costs about a granule of `nfts` for each NFT of the page that lies in a granule of its own, so up to the granules of
 * the collection's whole `nfts` prefix for an account that holds NFTs spread over the collection (200 of 120,000: about all of
 * them), and about one granule per part for holdings that lie together. The bound is the collection's NFTs and not the table;
 * `paged-reads.e2e-spec.ts` pins both cases.
 */
const NFTS_OF_SQL = `SELECT ${NFT_COLUMNS}
  FROM ${Table.Nfts}
 WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}
   AND (serial, nft_id) IN (SELECT arrayJoin(arrayZip({serials:Array(UInt32)}, {ids:Array(String)})))
 ORDER BY issuer ASC, taxon_key ASC, serial ASC, nft_id ASC, version DESC
 LIMIT 1 BY issuer, taxon_key, serial, nft_id`;

/**
 * The newest row of each owner of the collection's set with something held, by `held` descending and then the owner. The order
 * is not the key of the table (`issuer, taxon_key, owner`), so a page cannot stop after its rows: it reads the collection's WHOLE
 * holders prefix, the bound of this read being the holders of one collection and not the table.
 */
const HOLDERS_SQL = (after: boolean): string => `SELECT owner, held
  FROM (SELECT owner, held
          FROM ${Table.NftCollectionHolders}
         WHERE issuer = {issuer:String} AND taxon_key = {taxon_key:UInt32}
         ORDER BY issuer ASC, taxon_key ASC, owner ASC, version DESC
         LIMIT 1 BY issuer, taxon_key, owner)
 WHERE held > 0${after ? ' AND (held < {after_held:UInt32} OR (held = {after_held:UInt32} AND owner > {after_owner:String}))' : ''}
 ORDER BY held DESC, owner ASC
 LIMIT {n:UInt32}`;

/**
 * The sales, mints and burns of a collection in a range of ledgers, each once: what the daily stats group, through
 * `nftSalesNativeSql` (the one conversion of a price). The parameters are prefixed `st_`.
 */
const STATS_EVENTS_SQL = `SELECT event, ledger_index, tx_index, event_index, currency, amount_issuer, close_time, amount, amount_f
  FROM ${Table.CollectionNftEvents}
 WHERE issuer = {st_issuer:String} AND taxon_key = {st_taxon_key:UInt32}
   AND ledger_index BETWEEN {st_min:UInt32} AND {st_max:UInt32} AND event IN ('sale', 'mint', 'burn')
 ORDER BY issuer, taxon_key, ledger_index, tx_index, event_index
 LIMIT 1 BY issuer, taxon_key, ledger_index, tx_index, event_index`;

/** The list of collections as the request names it; the values are already validated. */
export interface CollectionsQuery {
  /** Only the collections of this issuer (a prefix of the key). */
  issuer?: string;
  sort: CollectionSort;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface CollectionsAnswer {
  coverage: Coverage;
  /** How many collections the filter matches. */
  total: number;
  collections: CollectionObject[];
  marker?: string;
}

export interface CollectionAnswer {
  coverage: Coverage;
  collection: CollectionObject;
}

export interface NftsQuery {
  /** Only the NFTs this account holds (`account_nfts`). */
  owner?: string;
  includeBurned: boolean;
  limit: number;
  marker?: string;
}

export interface NftsAnswer {
  coverage: Coverage;
  nfts: NftObject[];
  marker?: string;
}

export interface HoldersQuery {
  limit: number;
  marker?: string;
}

export interface HoldersAnswer {
  coverage: Coverage;
  holders: HolderObject[];
  marker?: string;
}

export interface CollectionSalesQuery {
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  marker?: string;
}

export interface SalesAnswer {
  coverage: Coverage;
  sales: NftSaleObject[];
  marker?: string;
}

export interface StatsQuery {
  start: Date;
  endExclusive?: Date;
  descending: boolean;
}

export interface StatsAnswer {
  coverage: Coverage;
  days: CollectionDayObject[];
}

/** A collection of the list with what it is ordered by: the value of the sort, then the key of the collection. */
interface Listed {
  stored: StoredCollection;
  value: number;
  issuer: string;
  taxon: number;
}

/** What each sort orders by: the volume by its Float64 shadow, the others by their counts. */
const SORT_VALUE: Record<CollectionSort, (c: StoredCollection) => number> = {
  volume: (c) => Number(c.volume_native_f),
  supply: (c) => Number(c.supply),
  holders: (c) => Number(c.holders),
};

/** The marker of a list is the sort value, then the key of the collection; the value is a double for the volume, else a count. */
const collectionPosition = (sort: CollectionSort): KeysetKey[] => [
  { column: 'value', type: sort === 'volume' ? 'Float64' : 'UInt64' },
  { column: 'issuer', type: 'String' },
  { column: 'taxon_key', type: 'UInt32' },
];

/**
 * The collection routes (spec sections 5.7 to 5.10): the list, one collection, and its NFTs, holders, sales and daily stats. Every
 * answer states `coverage('nfts')`, the feature's own (the collection is an aggregate of the feature, not of one NFT).
 *
 *  - **The list** reads the newest row of every collection (some 40,000 on XRPL) and sorts them per request, by the volume, supply
 *    or holders, the ties by issuer and then taxon ascending, with a keyset marker on the value and the key. The rows of every
 *    collection are kept 60 s; those of one issuer are not (see `COLLECTIONS_CACHE_KEY`). `total` counts what the filter matches.
 *  - **A collection** is a read of its key in `nft_collections`. Its sub-routes check it first: a collection younger than the last
 *    run of the collections job has no row yet, and is a 404 on them too (the route answers `undefined`). So is a path that names
 *    no collection, the other family's form (`undefined` for the key): after the marker is checked, nothing is read for it.
 *  - **The NFTs** page the newest `nfts` row of each NFT of the collection by `readNewestPage`, the burned ones left out unless
 *    asked for. With an owner the holdings are paged instead (`account_nfts`, `held = 1`) and made into NFTs with the newest `nfts`
 *    rows of the page. A list does not join prices: the `last_sale` of its NFTs has no `converted_amount` (the detail has it).
 *  - **The holders** are the newest row of each owner of the collection's set with something held, by `held` descending and the
 *    owner. That is not the order of the key, so a page reads the collection's whole holders prefix: the bound is the holders of
 *    one collection, which is what `paged-reads.e2e-spec.ts` pins.
 *  - **The sales** are the `sale` events of `collection_nft_events` by `readDistinctPage`, as `NftSale` objects with their
 *    converted price.
 *  - **The stats** group the sales, mints and burns of the collection in the window's ledgers by UTC day, the sales converted by
 *    `nftSalesNativeSql`, as the collections job and the volume metric convert them.
 * Every read is of committed ledgers: the aggregates are written by jobs that read nothing else, and the event reads end at the
 * newest `ledgers` row (`LedgerRangeResolver`).
 */
@Injectable()
export class NftCollectionsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly coverage: FeatureCoverageService,
    private readonly rates: DailyRates,
    private readonly cache: CacheService,
  ) {}

  // -- the list and one collection ------------------------------------------------------------------------------------

  /** One page of the collections. */
  async list(q: CollectionsQuery): Promise<CollectionsAnswer> {
    // before any query: a marker that is none of ours is the client's mistake
    const after = decodeMarker(q.marker, collectionPosition(q.sort));
    const [coverage, stored] = await Promise.all([this.coverage.coverage('nfts'), this.collections(q.issuer)]);

    const valueOf = SORT_VALUE[q.sort];
    const listed: Listed[] = stored.map((c) => ({
      stored: c,
      value: valueOf(c),
      issuer: c.issuer,
      taxon: Number(c.taxon_key),
    }));
    const direction = q.descending ? -1 : 1;
    /** The order of the list: the value (descending or not), then the issuer and the taxon, ascending whichever way it runs. */
    const compare = (a: Omit<Listed, 'stored'>, b: Omit<Listed, 'stored'>): number =>
      (a.value < b.value ? -direction : a.value > b.value ? direction : 0) ||
      (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0) ||
      a.taxon - b.taxon;
    // (`stored` may be the rows of the cache, which the requests share: it is not changed, `listed` is this request's own array)
    listed.sort(compare);
    const marker =
      after === undefined
        ? undefined
        : { value: after[0] as number, issuer: after[1] as string, taxon: after[2] as number };
    const rest = marker === undefined ? listed : listed.filter((l) => compare(l, marker) > 0);

    // one more than the page: it only tells whether there is a next page
    const page = paginate(rest.slice(0, q.limit + 1), q.limit, (l) => [l.value, l.issuer, l.taxon]);
    return {
      coverage,
      total: listed.length,
      collections: page.rows.map((l) => toCollectionObject(l.stored)),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** The collection with this key, `undefined` when it has no row (yet). */
  async detail(path: CollectionKey | undefined): Promise<CollectionAnswer | undefined> {
    const row = path === undefined ? undefined : await this.collectionRow(path);
    if (row === undefined) return undefined;
    return { coverage: await this.coverage.coverage('nfts'), collection: toCollectionObject(row) };
  }

  // -- the lists of a collection --------------------------------------------------------------------------------------

  /** One page of the NFTs of a collection, by serial and id; `undefined` when the collection has no row. */
  async nfts(path: CollectionKey | undefined, q: NftsQuery): Promise<NftsAnswer | undefined> {
    const after = decodeMarker(q.marker, COLLECTION_NFT_POSITION);
    const key = await this.existing(path);
    if (key === undefined) return undefined;
    const coverage = await this.coverage.coverage('nfts');

    // the prefix of the key (the collection) is fixed, so the bound on the serial after it narrows the read
    const cursor = keysetClause(COLLECTION_NFT_POSITION, false, after);
    const prefix = [
      'issuer = {issuer:String}',
      'taxon_key = {taxon_key:UInt32}',
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const params = { issuer: key.issuer, taxon_key: key.taxon_key, ...cursor.params };

    let page: { rows: NftsRow[]; marker?: string };
    if (q.owner === undefined) {
      const rows = await readNewestPage<NftsRow>(this.ch, {
        columns: NFT_COLUMNS,
        table: Table.Nfts,
        where: prefix,
        key: NFT_ORDER,
        keep: q.includeBurned ? '' : 'burned = 0',
        descending: false,
        params,
        limit: q.limit + 1,
      });
      page = paginate(rows, q.limit, (r) => [Number(r.serial), r.nft_id]);
    } else {
      // what the account holds of the collection: the newest row of each NFT it ever had, kept when it is still held (a burned
      // NFT has no holder). The NFTs themselves are the newest `nfts` rows of the page
      const held = await readNewestPage<{ serial: number | string; nft_id: string }>(this.ch, {
        columns: 'owner, issuer, taxon_key, serial, nft_id, held',
        table: Table.AccountNfts,
        where: ['owner = {owner:String}', ...prefix],
        key: HOLDING_ORDER,
        keep: 'held = 1',
        descending: false,
        params: { ...params, owner: q.owner },
        limit: q.limit + 1,
      });
      const holdings = paginate(held, q.limit, (r) => [Number(r.serial), r.nft_id]);
      page = {
        rows: await this.nftsOf(key, holdings.rows),
        ...(holdings.marker !== undefined && { marker: holdings.marker }),
      };
    }
    return {
      coverage,
      // `last_sale` has no `converted_amount` here: the row has no transaction index to join the price of the sale on (C6)
      nfts: page.rows.map((row) => toNftObject(nftFoldOfRow(row))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** One page of the holders of a collection, by NFTs held (the most first) and owner; `undefined` when it has no row. */
  async holders(path: CollectionKey | undefined, q: HoldersQuery): Promise<HoldersAnswer | undefined> {
    const after = decodeMarker(q.marker, HOLDER_POSITION);
    const key = await this.existing(path);
    if (key === undefined) return undefined;
    const coverage = await this.coverage.coverage('nfts');

    const rows = await this.ch.query<{ owner: string; held: number | string }>(HOLDERS_SQL(after !== undefined), {
      issuer: key.issuer,
      taxon_key: key.taxon_key,
      ...(after !== undefined && { after_held: after[0], after_owner: after[1] }),
      n: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (r) => [Number(r.held), r.owner]);
    return {
      coverage,
      holders: page.rows.map(toHolderObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** One page of the sales of a collection, in the order asked for; `undefined` when it has no row. */
  async sales(path: CollectionKey | undefined, q: CollectionSalesQuery): Promise<SalesAnswer | undefined> {
    const after = decodeMarker(q.marker, NFT_EVENT_POSITION);
    const key = await this.existing(path);
    if (key === undefined) return undefined;
    const coverage = await this.coverage.coverage('nfts');

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { coverage, sales: [] };

    // the columns after the collection, which the query fixes: `keysetClause` bounds the first of them on its own, which
    // ClickHouse narrows the read with. The kind of event is a condition of the read that is capped, as in a history
    const cursor = keysetClause(NFT_EVENT_POSITION, q.descending, after);
    const rows = await readDistinctPage<NftEventsRow>(this.ch, {
      columns: EVENT_COLUMNS,
      table: Table.CollectionNftEvents,
      where: [
        'issuer = {issuer:String}',
        'taxon_key = {taxon_key:UInt32}',
        "event = 'sale'",
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: SALE_ORDER,
      unique: columnsOf(NFT_EVENT_POSITION),
      descending: q.descending,
      params: { issuer: key.issuer, taxon_key: key.taxon_key, min: range.min, max: range.max, ...cursor.params },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (r) => [r.ledger_index, r.tx_index, r.event_index]);
    const converted = await convertedSalePrices(this.ch, this.rates, page.rows);
    return {
      coverage,
      sales: page.rows.map((r) => toNftSaleObject(r, converted.get(saleKey(r)))),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** The days of the window on which the collection had a sale, a mint or a burn; `undefined` when it has no row. */
  async stats(path: CollectionKey | undefined, q: StatsQuery): Promise<StatsAnswer | undefined> {
    const key = await this.existing(path);
    if (key === undefined) return undefined;
    const coverage = await this.coverage.coverage('nfts');

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { coverage, days: [] };

    const native = await nftSalesNativeSql(this.ch, this.rates, {
      sql: STATS_EVENTS_SQL,
      params: { st_issuer: key.issuer, st_taxon_key: key.taxon_key, st_min: range.min, st_max: range.max },
    });
    // a sale without a price in the native currency (no rate that day) counts in `sales_count` and not in the rest
    const rows = await this.ch.query<CollectionDayRow>(
      `SELECT toString(toDate(close_time, 'UTC')) AS day,
              toUInt64(countIf(event = 'sale')) AS sales_count,
              toUInt64(countIf(event = 'mint')) AS mints,
              toUInt64(countIf(event = 'burn')) AS burns,
              toUInt64(countIf(event = 'sale' AND converted_native IS NOT NULL)) AS priced,
              toString(sumIf(toDecimal256(converted_native, 6), event = 'sale')) AS volume,
              toString(minIf(converted_native, event = 'sale')) AS min_price
         FROM (${native.sql})
        GROUP BY day
        ORDER BY day ${q.descending ? 'DESC' : 'ASC'}`,
      native.params,
    );
    return { coverage, days: rows.map(toCollectionDayObject) };
  }

  // -- reads ------------------------------------------------------------------------------------------------------------

  /**
   * The key of a path when the collection has a row, else `undefined`: a path that names none (the other family's form, which the
   * controller passes as `undefined`) reads nothing.
   */
  private async existing(path: CollectionKey | undefined): Promise<CollectionKey | undefined> {
    return path !== undefined && (await this.collectionRow(path)) !== undefined ? path : undefined;
  }

  /** The newest row of the collection with this key, `undefined` when there is none. */
  private async collectionRow(key: CollectionKey): Promise<StoredCollection | undefined> {
    const [row] = await this.ch.query<StoredCollection>(COLLECTION_SQL, {
      issuer: key.issuer,
      taxon_key: key.taxon_key,
    });
    return row;
  }

  /** The newest row of every collection, of an issuer's when `issuer` is given; those of every collection are kept 60 s. */
  private collections(issuer?: string): Promise<StoredCollection[]> {
    if (issuer !== undefined) return this.ch.query<StoredCollection>(COLLECTIONS_SQL(true), { issuer });
    return this.cache.wrap(COLLECTIONS_CACHE_KEY, COLLECTIONS_CACHE_MS, () =>
      this.ch.query<StoredCollection>(COLLECTIONS_SQL(false)),
    );
  }

  /** The newest `nfts` rows of the NFTs of a page of holdings, in the order of the page. */
  private async nftsOf(
    key: CollectionKey,
    holdings: Array<{ serial: number | string; nft_id: string }>,
  ): Promise<NftsRow[]> {
    if (holdings.length === 0) return [];
    return this.ch.query<NftsRow>(NFTS_OF_SQL, {
      issuer: key.issuer,
      taxon_key: key.taxon_key,
      serials: holdings.map((h) => Number(h.serial)),
      ids: holdings.map((h) => h.nft_id),
    });
  }
}

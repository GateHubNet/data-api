import { TupleParam } from '@clickhouse/client';
import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { NftCollectionHoldersRow, NftCollectionsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import type { NftKind } from '../parsers/nft.parser';
import { DailyRates } from '../query/daily-rates';
import { nftSalesNativeSql } from '../query/nft-prices';
import { committedHead } from './amm-pools.job';
import { CollectionKey } from './nft-state.job';

/**
 * The `nft_collections` job's functions (spec sections 1.2 and 3.2): the row of every collection (its supply, holders, mints,
 * burns, sales and volume) and the set of its holders, computed from the `nfts` rows that the `nft_state` job keeps and from the
 * collection's `collection_nft_events`. The runner that calls them is `NftCollectionsJobRunner` of the syncer.
 *
 *  - **Only committed ledgers.** The events are read up to the head (`committedHead`: the newest `ledgers` row, written after every
 *    child table of its ledger), so the sale of a half-written ledger is never counted. Each event is read once
 *    (`LIMIT 1 BY` its key): a table written twice is not collapsed before a merge. The `nfts` rows are the newest version of
 *    each NFT (`ORDER BY <key>, version DESC LIMIT 1 BY <key>`, no `FINAL`).
 *  - **One version for a batch**, the ClickHouse clock in milliseconds read before the first read, but above the newest version of
 *    every key the batch rewrites: the `nft_collections` rows **and the `nft_collection_holders` rows** of its collections (every
 *    version of them is read, the owners that are gone included), so the newest row of a key is the newest write even when the clock
 *    steps back. It is also above the newest `nfts` version it has read, so that the collection is not behind
 *    (`collectionsBehind`) for rows it has already counted.
 *  - **The holders go first**, then the `nft_collections` row, which says what the holders set is. Each recompute writes every
 *    current holder (with how many NFTs it holds) and a `held = 0` row for each owner of the newest set who is gone; a reader
 *    keeps the newest row of an owner with `held` above 0.
 *  - **A collection with no NFT left is deleted** from both tables (a lightweight DELETE, the `nft_collections` row first, so that a
 *    crash in between leaves holders no collection names rather than a collection with no holders): a re-ingest dropped its
 *    events and `nft_state` removed its NFTs.
 *  - **Prices** come from `nftSalesNativeSql`, the one conversion of the volume metric and `/stats`: a sale has a price in the
 *    native currency when it is in it or has a rate on its day, and `volume_native` is the exact sum of those (a `Decimal256`, as
 *    the `nft_volume` components are summed), written as plain decimal text, with `volume_native_f` its `Float64`. `sales_count`
 *    counts every sale.
 *  - **Nothing is written once the shutdown has begun**: `signal` is checked before each read and each write.
 */

/** How many collections one recompute batch covers, and so one version: the size of a batch of the job. */
export const NFT_COLLECTIONS_BATCH = 50;

/** Thrown by a recompute whose `signal` was aborted: nothing was written after the abort. */
export class NftCollectionsRecomputeAborted extends Error {
  constructor() {
    super('The NFT collections recompute was aborted before it wrote');
    this.name = 'NftCollectionsRecomputeAborted';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new NftCollectionsRecomputeAborted();
}

/** Passed on every lightweight DELETE so that no server profile makes it asynchronous (2 = wait for all replicas). */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

type Counted = number | string;

/** A collection key as the tuple parameter of `(issuer, taxon_key) IN {nc_keys:KEYS_PARAM}`. */
const KEYS_PARAM = 'Array(Tuple(String, UInt32))';
const keysParam = (keys: readonly CollectionKey[]): TupleParam[] =>
  keys.map((k) => new TupleParam([k.issuer, k.taxon_key]));

const idOf = (key: { issuer: string; taxon_key: Counted }): string => `${key.issuer}/${Number(key.taxon_key)}`;

const compareKeys = (a: CollectionKey, b: CollectionKey): number =>
  a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : a.taxon_key - b.taxon_key;

/** The rows of `rows` grouped by the collection they are of. */
function groupByCollection<T extends { issuer: string; taxon_key: Counted }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = idOf(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------------
// What to compute
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The collections whose newest NFT version is above their `nft_collections` version, or which have none: one grouped read of
 * each table. Every row of a version older than the collection's is counted in it already, since a collection is computed under
 * a version above the newest `nfts` version it read. In key order.
 */
const BEHIND_SQL = `SELECT n.issuer AS issuer, n.taxon_key AS taxon_key
  FROM (SELECT issuer, taxon_key, max(version) AS version FROM ${Table.Nfts} GROUP BY issuer, taxon_key) AS n
  LEFT JOIN (SELECT issuer, taxon_key, max(version) AS version FROM ${Table.NftCollections} GROUP BY issuer, taxon_key) AS c
    ON n.issuer = c.issuer AND n.taxon_key = c.taxon_key
 WHERE n.version > ifNull(c.version, 0)
 ORDER BY issuer, taxon_key`;

/**
 * The collections whose newest NFT version is above their `nft_collections` version (or which have none), in key order: what
 * the job computes at its start, since the queue of the collections that `nft_state` rebuilt is in memory and a restart loses it.
 */
export async function collectionsBehind(ch: ClickHouseService): Promise<CollectionKey[]> {
  const rows = await ch.query<{ issuer: string; taxon_key: Counted }>(BEHIND_SQL);
  return rows.map((r) => ({ issuer: r.issuer, taxon_key: Number(r.taxon_key) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The recompute
// ---------------------------------------------------------------------------------------------------------------------

/** The newest `nfts` row of each NFT of some collections: a read by the prefix of the key of the table. */
const NEWEST_NFTS = `SELECT issuer, taxon_key, serial, nft_id, kind, taxon, owner, burned, last_ledger, version
  FROM ${Table.Nfts}
 WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}}
 ORDER BY issuer, taxon_key, serial, nft_id, version DESC
 LIMIT 1 BY issuer, taxon_key, serial, nft_id`;

/** The NFTs of each collection: what it is (kind, taxon), its supply (the NFTs not burned) and the newest NFT version. */
const SUPPLY_SQL = `SELECT issuer, taxon_key, any(kind) AS kind, any(taxon) AS taxon,
       toUInt64(countIf(burned = 0)) AS supply, toUInt32(max(last_ledger)) AS last_ledger, toUInt64(max(version)) AS version
  FROM (${NEWEST_NFTS})
 GROUP BY issuer, taxon_key`;

/** The holders of each collection, with how many of its NFTs each holds: the non-empty owners of the NFTs not burned. */
const HOLDERS_SQL = `SELECT issuer, taxon_key, owner, toUInt32(count()) AS held
  FROM (${NEWEST_NFTS})
 WHERE burned = 0 AND owner != ''
 GROUP BY issuer, taxon_key, owner
 ORDER BY issuer, taxon_key, owner`;

/** The newest row of each owner of the holders sets stored, and its version (every owner ever written, those with 0 included). */
const PREVIOUS_HOLDERS_SQL = `SELECT issuer, taxon_key, owner, held, toUInt64(version) AS version
  FROM ${Table.NftCollectionHolders}
 WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}}
 ORDER BY issuer, taxon_key, owner, version DESC
 LIMIT 1 BY issuer, taxon_key, owner`;

/** The newest version of the `nft_collections` row of each collection that has one. */
const PREVIOUS_COLLECTIONS_SQL = `SELECT issuer, taxon_key, toUInt64(max(version)) AS version
  FROM ${Table.NftCollections}
 WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}}
 GROUP BY issuer, taxon_key`;

/**
 * The mints and the burns of each collection, each event once, up to the head: how many, and the oldest and the newest mint
 * (by ledger, transaction and event). A collection with no mint has the defaults of the aggregate for its mint columns, and a
 * `minted` of 0 says so.
 */
const MINTS_AND_BURNS_SQL = `SELECT issuer, taxon_key,
       toUInt64(countIf(event = 'mint')) AS minted, toUInt64(countIf(event = 'burn')) AS burned,
       argMinIf(ledger_index, (ledger_index, tx_index, event_index), event = 'mint') AS first_mint_ledger,
       argMinIf(tx_hash, (ledger_index, tx_index, event_index), event = 'mint') AS first_mint_tx,
       argMinIf(toUnixTimestamp(close_time), (ledger_index, tx_index, event_index), event = 'mint') AS first_mint_time,
       argMaxIf(ledger_index, (ledger_index, tx_index, event_index), event = 'mint') AS last_mint_ledger,
       argMaxIf(tx_hash, (ledger_index, tx_index, event_index), event = 'mint') AS last_mint_tx,
       argMaxIf(toUnixTimestamp(close_time), (ledger_index, tx_index, event_index), event = 'mint') AS last_mint_time
  FROM (
       SELECT issuer, taxon_key, ledger_index, tx_index, event_index, tx_hash, event, close_time
         FROM ${Table.CollectionNftEvents}
        WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}} AND ledger_index <= {nc_head:UInt32} AND event IN ('mint', 'burn')
        ORDER BY issuer, taxon_key, ledger_index, tx_index, event_index
        LIMIT 1 BY issuer, taxon_key, ledger_index, tx_index, event_index
       )
 GROUP BY issuer, taxon_key`;

/** The newest event of each collection (of any kind, up to the head). */
const LAST_LEDGER_SQL = `SELECT issuer, taxon_key, toUInt32(max(ledger_index)) AS last_ledger
  FROM ${Table.CollectionNftEvents}
 WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}} AND ledger_index <= {nc_head:UInt32}
 GROUP BY issuer, taxon_key`;

/** The sales of some collections, each once, up to the head: what `nftSalesNativeSql` converts (its parameters are prefixed `nc_`). */
const SALES_SQL = `SELECT issuer, taxon_key, ledger_index, tx_index, event_index, currency, amount_issuer, close_time, amount, amount_f
  FROM ${Table.CollectionNftEvents}
 WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}} AND event = 'sale' AND ledger_index <= {nc_head:UInt32}
 ORDER BY issuer, taxon_key, ledger_index, tx_index, event_index
 LIMIT 1 BY issuer, taxon_key, ledger_index, tx_index, event_index`;

/** The deletes of a collection with no NFT left; the `nft_collections` row goes first. */
const DELETE_COLLECTIONS_SQL = `DELETE FROM ${Table.NftCollections} WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}}`;
const DELETE_HOLDERS_SQL = `DELETE FROM ${Table.NftCollectionHolders} WHERE (issuer, taxon_key) IN {nc_keys:${KEYS_PARAM}}`;

interface SupplyRow extends CollectionKey {
  kind: NftKind;
  taxon: Counted | null;
  supply: Counted;
  last_ledger: Counted;
  version: Counted;
}

interface HolderRow {
  issuer: string;
  taxon_key: Counted;
  owner: string;
  held: Counted;
}

interface PreviousHolderRow extends HolderRow {
  version: Counted;
}

interface MintsRow {
  issuer: string;
  taxon_key: Counted;
  minted: Counted;
  burned: Counted;
  first_mint_ledger: Counted;
  first_mint_tx: string;
  first_mint_time: Counted;
  last_mint_ledger: Counted;
  last_mint_tx: string;
  last_mint_time: Counted;
}

interface SalesRow {
  issuer: string;
  taxon_key: Counted;
  sales_count: Counted;
  volume: string | null;
}

/** A sum of converted prices as the text the readers show: plain decimal, no trailing zeros and no exponent (`0` for none). */
const volumeText = (sum: string | null): string => (sum === null ? '0' : new BigNumber(sum).toFixed());

/** The converted prices of the sales of some collections, summed by collection (`nftSalesNativeSql`). */
async function salesOf(
  ch: ClickHouseService,
  rates: DailyRates,
  keys: readonly CollectionKey[],
  head: number,
): Promise<SalesRow[]> {
  const native = await nftSalesNativeSql(ch, rates, {
    sql: SALES_SQL,
    params: { nc_keys: keysParam(keys), nc_head: head },
  });
  return ch.query<SalesRow>(
    `SELECT issuer, taxon_key, toUInt64(count()) AS sales_count, toString(sum(toDecimal256(converted_native, 6))) AS volume
       FROM (${native.sql})
      GROUP BY issuer, taxon_key`,
    native.params,
  );
}

/**
 * Computes the rows of `keys` (a batch: at most `NFT_COLLECTIONS_BATCH` is what the job passes, but any number works) and writes
 * them under one version (see the header): the holders of each collection, then its `nft_collections` row. A collection with no
 * NFT in `nfts` is deleted from both tables, if either has a row of it.
 *
 * What a row says (spec 1.2): `supply` counts the NFTs of the collection that are not burned, `holders` the distinct non-empty
 * owners of those; `minted` and `burned` count the indexed mint and burn events, `first_mint_*` and `last_mint_*` are the oldest
 * and newest mint, `sales_count` counts every sale and `volume_native` sums the converted prices of those that have one, and
 * `last_ledger` is the newest event of the collection (the newest ledger its NFTs have seen when it has no event). `kind` and
 * `taxon` come from the NFTs.
 *
 * Returns how many `nft_collections` rows it wrote and how many collections it deleted. It is idempotent: running it again leaves
 * the same newest values under newer versions. `signal` is checked before each read and each write: an aborted recompute throws
 * `NftCollectionsRecomputeAborted` and writes nothing more. Nothing is written while no ledger is committed.
 */
export async function recomputeCollections(
  ch: ClickHouseService,
  rates: DailyRates,
  keys: readonly CollectionKey[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ written: number; removed: number }> {
  const { signal } = opts;
  throwIfAborted(signal);
  const distinct = [...new Map(keys.map((k) => [idOf(k), { issuer: k.issuer, taxon_key: k.taxon_key }])).values()].sort(
    compareKeys,
  );
  if (distinct.length === 0) return { written: 0, removed: 0 };
  // read once, before any event: a ledger at or below it is committed, so all its rows are there to read
  const head = await committedHead(ch);
  if (head === 0) return { written: 0, removed: 0 };

  // the clock before the NFTs are read: an NFT written after that is under a version above the one this batch gets
  const clock = await ch.queryOne<{ now_ms: Counted }>(`SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms`);
  throwIfAborted(signal);
  const params = { nc_keys: keysParam(distinct), nc_head: head };
  const [supplies, holders, previousHolders, previousCollections, mints, lastLedgers, sales] = await Promise.all([
    ch.query<SupplyRow>(SUPPLY_SQL, params),
    ch.query<HolderRow>(HOLDERS_SQL, params),
    ch.query<PreviousHolderRow>(PREVIOUS_HOLDERS_SQL, params),
    ch.query<CollectionKey & { version: Counted }>(PREVIOUS_COLLECTIONS_SQL, params),
    ch.query<MintsRow>(MINTS_AND_BURNS_SQL, params),
    ch.query<CollectionKey & { last_ledger: Counted }>(LAST_LEDGER_SQL, params),
    salesOf(ch, rates, distinct, head),
  ]);

  const supplyOf = new Map(supplies.map((s) => [idOf(s), s]));
  const holdersOf = groupByCollection(holders);
  const previousHoldersOf = groupByCollection(previousHolders);
  const mintsOf = new Map(mints.map((m) => [idOf(m), m]));
  const lastLedgerOf = new Map(lastLedgers.map((l) => [idOf(l), Number(l.last_ledger)]));
  const salesOfCollection = new Map(sales.map((s) => [idOf(s), s]));

  // above the clock, and above the newest version of every key rewritten (the holders and the collection rows), and of the NFTs counted
  let version = Number(clock?.now_ms ?? Date.now());
  for (const { version: newest } of [...previousHolders, ...previousCollections, ...supplies]) {
    version = Math.max(version, Number(newest) + 1);
  }

  const holderRows: NftCollectionHoldersRow[] = [];
  const collectionRows: NftCollectionsRow[] = [];
  const gone: CollectionKey[] = [];
  for (const key of distinct) {
    const id = idOf(key);
    const supply = supplyOf.get(id);
    if (supply === undefined) {
      gone.push(key);
      continue;
    }
    const current = holdersOf.get(id) ?? [];
    const owners = new Set(current.map((h) => h.owner));
    for (const h of current) {
      holderRows.push({ issuer: key.issuer, taxon_key: key.taxon_key, owner: h.owner, held: Number(h.held), version });
    }
    // the owners of the newest set who hold nothing of the collection any more
    for (const p of previousHoldersOf.get(id) ?? []) {
      if (Number(p.held) > 0 && !owners.has(p.owner)) {
        holderRows.push({ issuer: key.issuer, taxon_key: key.taxon_key, owner: p.owner, held: 0, version });
      }
    }

    const mint = mintsOf.get(id);
    const minted = Number(mint?.minted ?? 0);
    const sold = salesOfCollection.get(id);
    const volume = volumeText(sold?.volume ?? null);
    collectionRows.push({
      issuer: key.issuer,
      taxon_key: key.taxon_key,
      kind: supply.kind,
      taxon: supply.taxon === null ? null : Number(supply.taxon),
      supply: Number(supply.supply),
      holders: current.length,
      minted,
      burned: Number(mint?.burned ?? 0),
      sales_count: Number(sold?.sales_count ?? 0),
      volume_native: volume,
      volume_native_f: Number(volume),
      first_mint_ledger: minted > 0 ? Number(mint?.first_mint_ledger) : null,
      first_mint_tx: minted > 0 ? (mint?.first_mint_tx ?? '') : '',
      first_mint_time: minted > 0 ? Number(mint?.first_mint_time) : null,
      last_mint_ledger: minted > 0 ? Number(mint?.last_mint_ledger) : null,
      last_mint_tx: minted > 0 ? (mint?.last_mint_tx ?? '') : '',
      last_mint_time: minted > 0 ? Number(mint?.last_mint_time) : null,
      last_ledger: lastLedgerOf.get(id) ?? Number(supply.last_ledger),
      version,
    });
  }

  // the holders first, the `nft_collections` rows (which say what the holders are) last
  throwIfAborted(signal);
  await ch.insert(Table.NftCollectionHolders, holderRows);
  throwIfAborted(signal);
  await ch.insert(Table.NftCollections, collectionRows);

  // a collection with no NFT left is removed when something of it was stored; one that never had a row is nothing to do
  const stored = new Set([...previousCollections, ...previousHolders].map(idOf));
  const removed = gone.filter((key) => stored.has(idOf(key)));
  if (removed.length > 0) {
    throwIfAborted(signal);
    await ch.command(DELETE_COLLECTIONS_SQL, { nc_keys: keysParam(removed) }, { settings: SYNC_DELETE });
    throwIfAborted(signal);
    await ch.command(DELETE_HOLDERS_SQL, { nc_keys: keysParam(removed) }, { settings: SYNC_DELETE });
  }
  return { written: collectionRows.length, removed: removed.length };
}

import { TupleParam } from '@clickhouse/client';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AccountNftsRow, NftsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { committedHead } from './amm-pools.job';
import { foldNftEvents, NftEventRead, NftFold } from './nft-state';

/**
 * The `nft_state` job's functions (spec section 3.1): the state of every NFT with an indexed event, rebuilt from its
 * `nft_events` for the NFT list, the holdings of an account and the detail of the API. The runner that calls them is Task 9's.
 *
 *  - **Only committed ledgers.** As for `amm_pools`, everything reads up to the head (`committedHead`: the newest `ledgers`
 *    row, written after every child table of its ledger). A rebuild ignores events above it, so an NFT's `last_ledger` is never
 *    past the head, and the scans for what changed stop at it, so that a cursor never passes a ledger whose rows are not all
 *    readable.
 *  - **Stale NFTs.** The narrow `nft_touches` (one row per NFT a transaction had an event of) say which NFTs changed: a touch
 *    is stale while its ledger is above what the NFT's newest `nfts` row has seen (`last_ledger`). An NFT that was rebuilt up
 *    to the head has no stale touch. The live read (`nftsChangedSince`) looks up what the rows have seen for the NFTs the
 *    touches of its range name only, a lookup of the key of `nfts` (`issuer, taxon_key, serial, nft_id`, which the touches
 *    carry for this); only the watermark, once at the start, reads the whole table.
 *  - **Idempotent, versioned.** An NFT's rows are a function of its events. A batch is written under one version: the
 *    ClickHouse clock in milliseconds, but above the newest version of every key the batch rewrites, so the newest row of a key
 *    is the newest write even when the clock steps back. Readers keep the newest version of a key (`LIMIT 1 BY`, no `FINAL`).
 *    The `account_nfts` rows go first and the `nfts` rows last, as the `ledgers` row is the commit marker of a ledger: an NFT
 *    whose `nfts` row says it has seen a ledger has its holdings written for it.
 *  - **An NFT with no event left is removed**: a re-ingest dropped its events. Its `nfts` rows are deleted (a lightweight
 *    DELETE) after its holdings have been set to `held = 0`, so that a crash in between leaves the NFT to be removed again.
 *  - **Nothing is written once the shutdown has begun**: `signal` is checked before each read and each write.
 */

/** How many NFTs one rebuild batch covers, and so one version: the size of a live batch of the job. */
export const NFT_STATE_BATCH = 500;

/** How many ledgers of an `nft_dirty` range one step of the job rebuilds. */
export const NFT_DIRTY_STEP_LEDGERS = 10_000;

/**
 * How many ledgers one live read of the job looks at (`nftsChangedSince` with `to`): a cursor far behind the head would otherwise
 * group every touch after it in one query. The cursor crosses a stretch of ledgers with nothing stale one window per read.
 */
export const NFT_LIVE_STEP_LEDGERS = 10_000;

type Counted = number | string;

/** The key of an NFT in `nfts` (`ORDER BY (issuer, taxon_key, serial, nft_id)`). */
export interface NftKey {
  issuer: string;
  taxon_key: number;
  serial: number;
  nft_id: string;
}

/** The key of a collection in `nft_collections`: an issuer and, on XRPL, a taxon (`taxon_key` is 0 on Xahau). */
export interface CollectionKey {
  issuer: string;
  taxon_key: number;
}

/** Thrown by a rebuild whose `signal` was aborted: nothing was written after the abort. */
export class NftRebuildAborted extends Error {
  constructor() {
    super('The NFT rebuild was aborted before it wrote');
    this.name = 'NftRebuildAborted';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new NftRebuildAborted();
}

/** Passed on every lightweight DELETE so that no server profile makes it asynchronous (2 = wait for all replicas). */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

const KEY_COLUMNS = 'issuer, taxon_key, serial, nft_id';

const keyOf = (row: { issuer: string; taxon_key: Counted; serial: Counted; nft_id: string }): NftKey => ({
  issuer: row.issuer,
  taxon_key: Number(row.taxon_key),
  serial: Number(row.serial),
  nft_id: row.nft_id,
});

/** An NFT key as the tuple parameter of `(issuer, taxon_key, serial, nft_id) IN {keys:KEYS_PARAM}`. */
const KEYS_PARAM = 'Array(Tuple(String, UInt32, UInt32, String))';
const keysParam = (keys: readonly NftKey[]): TupleParam[] =>
  keys.map((k) => new TupleParam([k.issuer, k.taxon_key, k.serial, k.nft_id]));

const compareKeys = (a: NftKey, b: NftKey): number =>
  a.issuer < b.issuer
    ? -1
    : a.issuer > b.issuer
      ? 1
      : a.taxon_key - b.taxon_key || a.serial - b.serial || (a.nft_id < b.nft_id ? -1 : a.nft_id > b.nft_id ? 1 : 0);

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------------------------------------------------
// What to rebuild
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The touches with, for each, what the NFT's newest `nfts` row has seen (`reflected`: its `last_ledger`, and nothing for an
 * NFT that has no row). A touch above it is stale (`IS_STALE`; the one definition of stale of the watermark and of
 * `nftsChangedSince`). `only` limits the NFTs whose rows are read to some of them (a `WHERE` over the key of `nfts`).
 */
const touchesWithReflected = (only = ''): string => `FROM ${Table.NftTouches} AS t
  LEFT JOIN (
       SELECT nft_id, argMax(last_ledger, version) AS reflected
         FROM ${Table.Nfts}
         ${only}
        GROUP BY nft_id
       ) AS p ON t.nft_id = p.nft_id`;
const IS_STALE = 't.ledger_index > ifNull(p.reflected, 0)';

/** The NFTs touched in the ledgers that `condition` (over `ledger_index`) selects, as a restriction of the rows of `nfts` read. */
const onlyTouched = (condition: string): string =>
  `WHERE (${KEY_COLUMNS}) IN (SELECT ${KEY_COLUMNS} FROM ${Table.NftTouches} WHERE ${condition})`;

/** The ledgers `(ledger, head]`: `head` is the end of the window of the read (the committed head, or the cap below it). */
const RANGE_AFTER = 'ledger_index > {ledger:UInt32} AND ledger_index <= {head:UInt32}';

/**
 * The stale NFTs after `ledger` (up to the end of the window), with the first stale ledger of each: a range of the primary key
 * of the touches, which are ordered by ledger, and the rows of `nfts` of the NFTs they name only.
 */
const NFTS_CHANGED_SINCE_SQL = `SELECT t.issuer AS issuer, t.taxon_key AS taxon_key, t.serial AS serial, t.nft_id AS nft_id,
       min(t.ledger_index) AS first_ledger
  ${touchesWithReflected(onlyTouched(RANGE_AFTER))}
 WHERE t.ledger_index > {ledger:UInt32} AND t.ledger_index <= {head:UInt32} AND ${IS_STALE}
 GROUP BY t.issuer, t.taxon_key, t.serial, t.nft_id
 ORDER BY first_ledger ASC, nft_id ASC
 LIMIT {n:UInt32}`;

/** The stale NFTs with a touch at one ledger. */
const NFTS_AT_LEDGER_SQL = `SELECT DISTINCT t.issuer AS issuer, t.taxon_key AS taxon_key, t.serial AS serial, t.nft_id AS nft_id
  ${touchesWithReflected(onlyTouched('ledger_index = {at:UInt32}'))}
 WHERE t.ledger_index = {at:UInt32} AND ${IS_STALE}
 ORDER BY issuer, taxon_key, serial, nft_id`;

interface ChangedNft extends NftKey {
  first_ledger: Counted;
}

export interface NftsChanged {
  /** The stale NFTs after the ledger, at most `limit` of them (see `nftsChangedSince`). */
  nfts: NftKey[];
  /**
   * The ledger up to which `nfts` is everything there is: every NFT with a stale touch in `(ledger, upTo]` is in it. Equal to
   * the ledger when the end of the window (the committed head, or the cap `to`) is not past it; higher than it otherwise, also
   * with no NFT to rebuild.
   */
  upTo: number;
}

/**
 * The NFTs to rebuild after `ledger`: those with a touch above what their newest `nfts` row has seen, in a committed ledger
 * (`committedHead`), oldest such touch first, at most `limit` of them, and the ledger the answer is complete up to. A caller that
 * has rebuilt `nfts` goes on from `upTo`, and nothing is missed or waits for ever.
 *
 * The read looks at the window `(ledger, end]`, where `end` is the committed head, or `to` when that is lower (a cap on how far
 * one read goes, so that a cursor far behind the head does not group every touch after it: see `NFT_LIVE_STEP_LEDGERS`).
 *
 *  - When there are no more than `limit` such NFTs in the window they are all returned and `upTo` is its end (the ledgers between
 *    their touches and the end have no stale touch, so the cursor may skip them: also when no NFT is returned).
 *  - Otherwise the NFTs whose first stale touch is before that of the first one left out are returned, and `upTo` is the ledger
 *    before it.
 *  - When more than `limit` NFTs have their first stale touch in the very first ledger there is, the cut would never move on,
 *    so all the NFTs of that ledger are returned (more than `limit` of them) and `upTo` is that ledger.
 *  - Nothing is returned, and `upTo` is `ledger`, while the end of the window is not past it.
 */
export async function nftsChangedSince(
  ch: ClickHouseService,
  ledger: number,
  limit: number,
  to?: number,
): Promise<NftsChanged> {
  const n = Math.max(1, Math.floor(limit));
  const head = await committedHead(ch);
  const end = to === undefined ? head : Math.min(head, to);
  if (end <= ledger) return { nfts: [], upTo: ledger };
  const rows = await ch.query<ChangedNft>(NFTS_CHANGED_SINCE_SQL, { ledger, head: end, n: n + 1 });
  if (rows.length <= n) return { nfts: rows.map(keyOf), upTo: end };
  const edge = Number(rows[n].first_ledger);
  const before = rows.slice(0, n).filter((r) => Number(r.first_ledger) < edge);
  if (before.length > 0) return { nfts: before.map(keyOf), upTo: edge - 1 };
  // the ledgers of the edge are committed (the edge is at most the head), so the NFTs there are all readable
  const atEdge = await ch.query<NftKey>(NFTS_AT_LEDGER_SQL, { at: edge });
  return { nfts: atEdge.map(keyOf), upTo: edge };
}

/**
 * Where the live job goes on from: the highest ledger such that every NFT with a touch up to it is reflected in `nfts` (its newest
 * row has seen the ledger: `last_ledger` is at least the touch's). The persistent cursor of the job, worked out from the tables
 * themselves, so that a restart resumes where the last run stopped instead of rebuilding every NFT: one scan of `nft_touches`
 * (narrow, and not the events), at the start of the process. The scan reads the whole table, not a range of its key: an NFT
 * that was never rebuilt, or not since long ago, may have a stale touch anywhere.
 *
 * It is the ledger before the oldest touch that its NFT has not seen, or the committed head when there is none: 0 for a
 * database without a ledger. Touches above the head are not counted, as they are not for `nftsChangedSince`.
 */
export async function nftStateWatermark(ch: ClickHouseService): Promise<number> {
  const head = await committedHead(ch);
  if (head === 0) return 0;
  const row = await ch.queryOne<{ first_stale: Counted; stale: Counted }>(
    `SELECT minIf(t.ledger_index, ${IS_STALE}) AS first_stale, countIf(${IS_STALE}) AS stale
       ${touchesWithReflected()}
      WHERE t.ledger_index <= {head:UInt32}`,
    { head },
  );
  return row !== undefined && Number(row.stale) > 0 ? Number(row.first_stale) - 1 : head;
}

/** The NFTs with a touch in a range of ledgers (a range of the primary key of the touches). */
const TOUCHED_IN_SQL = `SELECT DISTINCT ${KEY_COLUMNS}
  FROM ${Table.NftTouches}
 WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}`;

/**
 * The NFTs whose newest `nfts` row first or last saw a ledger of a range: a re-ingest of the range may have dropped their events
 * there, and then nothing in `nft_touches` names them. The keys with a row that says so, whatever its version, are looked
 * for first (two narrow columns), and only then is the newest row of each of them tested.
 */
const SEEN_IN_SQL = `SELECT ${KEY_COLUMNS}
  FROM (
       SELECT ${KEY_COLUMNS}, first_ledger, last_ledger
         FROM ${Table.Nfts}
        WHERE (${KEY_COLUMNS}) IN (
              SELECT ${KEY_COLUMNS} FROM ${Table.Nfts}
               WHERE first_ledger BETWEEN {from:UInt32} AND {to:UInt32} OR last_ledger BETWEEN {from:UInt32} AND {to:UInt32}
              )
        ORDER BY ${KEY_COLUMNS}, version DESC
        LIMIT 1 BY ${KEY_COLUMNS}
       )
 WHERE first_ledger BETWEEN {from:UInt32} AND {to:UInt32} OR last_ledger BETWEEN {from:UInt32} AND {to:UInt32}`;

/**
 * The NFTs of the ledgers `[from, to]` (both inclusive, the part of them up to the head): those with a touch there, and those
 * whose newest `nfts` row has its `first_ledger` or its `last_ledger` there (a re-ingest that dropped the events of an NFT
 * there leaves no touch to find it by; its rebuild goes back to its older events, or removes it when none is left). The `nft_dirty`
 * steps use it. In the order of the key of `nfts`, each once.
 */
export async function nftsInLedgers(ch: ClickHouseService, from: number, to: number): Promise<NftKey[]> {
  const head = await committedHead(ch);
  const upTo = Math.min(to, head);
  if (upTo < from) return [];
  const params = { from, to: upTo };
  const [touched, seen] = await Promise.all([
    ch.query<NftKey>(TOUCHED_IN_SQL, params),
    ch.query<NftKey>(SEEN_IN_SQL, params),
  ]);
  const found = new Map<string, NftKey>();
  for (const row of [...touched, ...seen]) found.set(row.nft_id, keyOf(row));
  return [...found.values()].sort(compareKeys);
}

// ---------------------------------------------------------------------------------------------------------------------
// The rebuild
// ---------------------------------------------------------------------------------------------------------------------

/** The events of some NFTs, each once (a table written twice is not collapsed before a merge), up to the head, oldest first. */
const EVENTS_SQL = `SELECT nft_id, ledger_index, tx_index, event_index, tx_hash, toUnixTimestamp(close_time) AS closed,
       kind, event, issuer, taxon, taxon_key, serial, nft_flags, transfer_fee, uri, digest,
       account, from_account, to_account, amount, currency, amount_issuer
  FROM ${Table.NftEvents}
 WHERE nft_id IN {ids:Array(String)} AND ledger_index <= {head:UInt32}
 ORDER BY nft_id ASC, ledger_index ASC, tx_index ASC, event_index ASC
 LIMIT 1 BY nft_id, ledger_index, tx_index, event_index`;

/** The newest `nfts` row of each of some NFTs (its owner and version: what the rebuild replaces). */
const PREVIOUS_SQL = `SELECT ${KEY_COLUMNS}, owner, toUInt64(version) AS version
  FROM ${Table.Nfts}
 WHERE (${KEY_COLUMNS}) IN {keys:${KEYS_PARAM}}
 ORDER BY ${KEY_COLUMNS}, version DESC
 LIMIT 1 BY ${KEY_COLUMNS}`;

/** The newest `account_nfts` row of every owner of some NFTs. The key of the table starts with the owner: a read of the whole column of ids. */
const HOLDINGS_SQL = `SELECT owner, ${KEY_COLUMNS}, held, toUInt64(version) AS version
  FROM ${Table.AccountNfts}
 WHERE nft_id IN {ids:Array(String)}
 ORDER BY owner, ${KEY_COLUMNS}, version DESC
 LIMIT 1 BY owner, ${KEY_COLUMNS}`;

const DELETE_NFTS_SQL = `DELETE FROM ${Table.Nfts} WHERE (${KEY_COLUMNS}) IN {keys:${KEYS_PARAM}}`;

interface EventRow extends Omit<NftEventRead, 'close_time'> {
  closed: Counted;
}

interface PreviousNft extends NftKey {
  owner: string;
  version: Counted;
}

interface Holding extends NftKey {
  owner: string;
  held: Counted;
  version: Counted;
}

const eventOf = ({ closed, ...event }: EventRow): NftEventRead => ({ ...event, close_time: Number(closed) });

/** The `nfts` row of a fold: the columns of the table (the fold keeps more, such as the `tx_index` of the last sale). */
function nftsRowOf(fold: NftFold, version: number): NftsRow {
  const { owner_since: since, minted, burned_at: burned, last_sale: sale } = fold;
  return {
    issuer: fold.issuer,
    taxon_key: fold.taxon_key,
    serial: fold.serial,
    nft_id: fold.nft_id,
    kind: fold.kind,
    taxon: fold.taxon,
    nft_flags: fold.nft_flags,
    transfer_fee: fold.transfer_fee,
    owner: fold.owner,
    owner_ledger: since?.ledger_index ?? null,
    owner_tx: since?.tx_hash ?? '',
    owner_time: since?.close_time ?? null,
    uri: fold.uri,
    digest: fold.digest,
    minted_ledger: minted?.ledger_index ?? null,
    minted_tx: minted?.tx_hash ?? '',
    minted_time: minted?.close_time ?? null,
    minted_by: minted?.by ?? '',
    minted_to: minted?.to ?? '',
    burned: fold.burned ? 1 : 0,
    burned_ledger: burned?.ledger_index ?? null,
    burned_tx: burned?.tx_hash ?? '',
    burned_time: burned?.close_time ?? null,
    burned_by: burned?.by ?? '',
    sale_count: fold.sale_count,
    last_sale_ledger: sale?.ledger_index ?? null,
    last_sale_tx: sale?.tx_hash ?? '',
    last_sale_time: sale?.close_time ?? null,
    last_sale_amount: sale?.amount ?? '',
    last_sale_currency: sale?.currency ?? '',
    last_sale_amount_issuer: sale?.amount_issuer ?? '',
    first_ledger: fold.first_ledger,
    last_ledger: fold.last_ledger,
    version,
  };
}

/** The `account_nfts` rows of a fold: one per account it ever had as owner, `held` 1 for the current one. */
function accountRowsOf(fold: NftFold, previousOwner: string | undefined, version: number): AccountNftsRow[] {
  const row = (owner: string, held: number): AccountNftsRow => ({
    owner,
    issuer: fold.issuer,
    taxon_key: fold.taxon_key,
    serial: fold.serial,
    nft_id: fold.nft_id,
    held,
    version,
  });
  const rows = fold.owners.map((owner) => row(owner, owner === fold.owner ? 1 : 0));
  // the owner of the row being replaced, when the events no longer name it: it holds the NFT no more
  if (previousOwner && !fold.owners.includes(previousOwner)) rows.push(row(previousOwner, 0));
  return rows;
}

/** Rebuilds one batch of NFTs (at most `NFT_STATE_BATCH`, distinct) under one version. */
async function rebuildBatch(
  ch: ClickHouseService,
  batch: NftKey[],
  head: number,
  signal: AbortSignal | undefined,
): Promise<{ written: number; removed: number; collections: CollectionKey[] }> {
  throwIfAborted(signal);
  const [events, previous, clock] = await Promise.all([
    ch.query<EventRow>(EVENTS_SQL, { ids: batch.map((k) => k.nft_id), head }),
    ch.query<PreviousNft>(PREVIOUS_SQL, { keys: keysParam(batch) }),
    ch.queryOne<{ now_ms: Counted }>(`SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms`),
  ]);

  const eventsOf = new Map<string, NftEventRead[]>();
  for (const row of events) {
    const list = eventsOf.get(row.nft_id);
    if (list) list.push(eventOf(row));
    else eventsOf.set(row.nft_id, [eventOf(row)]);
  }
  const folds: NftFold[] = [];
  const gone: NftKey[] = [];
  for (const key of batch) {
    const list = eventsOf.get(key.nft_id);
    if (list) folds.push(foldNftEvents(list));
    else gone.push(key);
  }

  // the holdings of the NFTs with no event left: each owner whose newest row says it holds one holds it no more
  throwIfAborted(signal);
  const holdings = gone.length > 0 ? await ch.query<Holding>(HOLDINGS_SQL, { ids: gone.map((k) => k.nft_id) }) : [];
  const held = holdings.filter((h) => Number(h.held) > 0);

  const previousOf = new Map(previous.map((p) => [p.nft_id, p]));
  // above the clock, and above the newest version of every key rewritten (the rows being replaced and the holdings set to 0)
  let version = Number(clock?.now_ms ?? Date.now());
  for (const { version: newest } of [...previous, ...holdings]) version = Math.max(version, Number(newest) + 1);
  const accountRows = [
    ...folds.flatMap((fold) => accountRowsOf(fold, previousOf.get(fold.nft_id)?.owner, version)),
    ...held.map((h): AccountNftsRow => ({ ...keyOf(h), owner: h.owner, held: 0, version })),
  ];
  const nftsRows = folds.map((fold) => nftsRowOf(fold, version));

  // the holdings first, the `nfts` rows (which say what a row has seen) last
  throwIfAborted(signal);
  await ch.insert(Table.AccountNfts, accountRows);
  throwIfAborted(signal);
  await ch.insert(Table.Nfts, nftsRows);

  // an NFT with no event left is removed when something of it was stored; one that never had a row is nothing to do
  const stored = new Set([...previous.map((p) => p.nft_id), ...held.map((h) => h.nft_id)]);
  const removed = gone.filter((k) => stored.has(k.nft_id));
  const withRow = gone.filter((k) => previousOf.has(k.nft_id));
  if (withRow.length > 0) {
    throwIfAborted(signal);
    await ch.command(DELETE_NFTS_SQL, { keys: keysParam(withRow) }, { settings: SYNC_DELETE });
  }

  return {
    written: nftsRows.length,
    removed: removed.length,
    collections: [...nftsRows, ...removed].map(({ issuer, taxon_key }) => ({ issuer, taxon_key })),
  };
}

/**
 * Rebuilds the `nfts` row of each of `nfts` from its `nft_events` (up to the head, each event once, in key order) and writes
 * it under one version per batch of `NFT_STATE_BATCH` (see the header), with one `account_nfts` row per account the NFT ever
 * had as owner (`held` 1 for its owner). The owner of the row it replaces, if the events no longer name it, gets a `held = 0` row.
 *
 * An NFT with no event left is removed (see the header): a lightweight `DELETE` of its `nfts` rows, and a `held = 0` row
 * for each owner of its newest `account_nfts` rows that still says `held` (the others say it already). It writes and removes
 * only what is stored: an NFT with no event, no row and no holding is nothing to do, and removing one twice is the same as
 * once. Nothing is written while no ledger is committed.
 *
 * Returns how many `nfts` rows it wrote, how many NFTs it removed, and the collections (issuer and taxon) of those, each once,
 * in key order: the ones whose `nft_collections` row has to be computed again. It is idempotent: running it again leaves the same
 * newest values under newer versions (the older versions go away when ClickHouse merges). `signal` is checked before each read
 * and each write: an aborted rebuild throws `NftRebuildAborted` and writes nothing more.
 */
export async function rebuildNfts(
  ch: ClickHouseService,
  nfts: readonly NftKey[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ written: number; removed: number; collections: CollectionKey[] }> {
  const { signal } = opts;
  throwIfAborted(signal);
  const distinct = [...new Map(nfts.map((k) => [k.nft_id, k])).values()].sort(compareKeys);
  const result = { written: 0, removed: 0, collections: [] as CollectionKey[] };
  if (distinct.length === 0) return result;
  // read once, before any event: a ledger at or below it is committed, so all its rows are there to read
  const head = await committedHead(ch);
  if (head === 0) return result;

  const collections = new Map<string, CollectionKey>();
  for (const batch of chunksOf(distinct, NFT_STATE_BATCH)) {
    const done = await rebuildBatch(ch, batch, head, signal);
    result.written += done.written;
    result.removed += done.removed;
    for (const c of done.collections) collections.set(`${c.issuer}/${c.taxon_key}`, c);
  }
  result.collections = [...collections.values()].sort(
    (a, b) => (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0) || a.taxon_key - b.taxon_key,
  );
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The ledger ranges to rebuild (`nft_dirty`)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A ledger range whose NFTs must be rebuilt, as `agg_dirty` is for hours: a re-ingest wrote its ledgers behind the aggregator.
 * `nft_dirty` is a ReplacingMergeTree keyed by `(from_ledger, to_ledger)` with `created_at` as the version: marking a range again
 * leaves two rows of one key until a merge, so reads take the newest of a key (no FINAL).
 */
export interface NftDirtyRange {
  /** The first ledger, inclusive. */
  from: number;
  /** The last ledger, inclusive. */
  to: number;
  /** When the newest mark of this range was made, unix milliseconds. */
  created: number;
}

/**
 * Marks the ledgers `[from, to]` (both inclusive) dirty, at the ClickHouse clock: their NFTs are rebuilt by the job. An empty range
 * (`to` below `from`) marks nothing.
 */
export async function markNftDirty(ch: ClickHouseService, from: number, to: number): Promise<void> {
  if (to < from) return;
  await ch.command(
    `INSERT INTO ${Table.NftDirty} (from_ledger, to_ledger, created_at)
     SELECT {from:UInt32}, {to:UInt32}, now64(3)`,
    { from, to },
  );
}

/** The newest mark of each range, so that a range marked twice is one. */
const NEWEST_MARKS = `SELECT from_ledger, to_ledger, created_at
              FROM ${Table.NftDirty}
             ORDER BY from_ledger ASC, to_ledger ASC, created_at DESC
             LIMIT 1 BY from_ledger, to_ledger`;

/** The range to work on first: the one marked longest ago (ties by range), `undefined` when there is none. */
export async function oldestNftDirty(ch: ClickHouseService): Promise<NftDirtyRange | undefined> {
  const row = await ch.queryOne<{ from_ledger: Counted; to_ledger: Counted; created_ms: Counted }>(
    `SELECT from_ledger, to_ledger, toUnixTimestamp64Milli(created_at) AS created_ms
       FROM (
            ${NEWEST_MARKS}
            )
      ORDER BY created_at ASC, from_ledger ASC, to_ledger ASC
      LIMIT 1`,
  );
  return row === undefined
    ? undefined
    : { from: Number(row.from_ledger), to: Number(row.to_ledger), created: Number(row.created_ms) };
}

/**
 * Removes a range that was worked on: every row of its key marked at or before `created`, the mark that was read. A row of the
 * same key that was marked after the read (the ingest rewrote more ledgers of the range while it was being rebuilt) is not
 * touched, so it is worked on again; a mark is never lost.
 */
export async function deleteNftDirty(ch: ClickHouseService, range: NftDirtyRange): Promise<void> {
  await ch.command(
    `DELETE FROM ${Table.NftDirty}
      WHERE from_ledger = {from:UInt32} AND to_ledger = {to:UInt32}
        AND toUnixTimestamp64Milli(created_at) <= {created:Int64}`,
    { from: range.from, to: range.to, created: range.created },
    { settings: SYNC_DELETE },
  );
}

/**
 * Replaces a range by the part of it that is left, `[from, range.to]` (the ledgers before `from` are done): the narrowed row is
 * inserted first, then the old one is deleted (`deleteNftDirty`), so that a crash between the two leaves both, and the work in
 * between is done twice, which is harmless. The narrowed row keeps the `created_at` of the original: it stays where it was in
 * the queue and is finished before younger ranges are started. A `from` beyond the range finishes it; one at or before its start
 * changes nothing.
 */
export async function narrowNftDirty(ch: ClickHouseService, range: NftDirtyRange, from: number): Promise<void> {
  if (from <= range.from) return;
  if (from > range.to) {
    await deleteNftDirty(ch, range);
    return;
  }
  // `fromUnixTimestamp64Milli`: the milliseconds exactly, where a JSON number would be a fraction of seconds
  await ch.command(
    `INSERT INTO ${Table.NftDirty} (from_ledger, to_ledger, created_at)
     SELECT {from:UInt32}, {to:UInt32}, fromUnixTimestamp64Milli({created:Int64})`,
    { from, to: range.to, created: range.created },
  );
  await deleteNftDirty(ch, range);
}

/** How many ledgers the dirty ranges hold: Σ (to − from + 1) over the newest row of each key. 0 when there is none. */
export async function nftDirtyLedgers(ch: ClickHouseService): Promise<number> {
  const row = await ch.queryOne<{ ledgers: Counted }>(
    `SELECT sum(toUInt64(to_ledger) - from_ledger + 1) AS ledgers
       FROM (
            ${NEWEST_MARKS}
            )`,
  );
  return Number(row?.ledgers ?? 0);
}

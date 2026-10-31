import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { MptHoldersRow, MptIssuancesRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { LSF_MPT_LOCKED } from '../parsers/mpt.parser';
import { RatesService } from '../query/rates.service';
import { decodeMptIssuanceId } from '../util/mpt';
import { cutText, decodeMptMetadata, MPT_NAME_MAX, MPT_TICKER_MAX, mptMetadataConforms } from '../util/mpt-metadata';
import { committedHead } from './amm-pools.job';

/**
 * The `mpt_state` job's functions (spec 2026-10-17-mpt-data-design.md, section 6): the current state of every issuance and of every
 * holder of one, rebuilt from the append-only `mpt_issuance_states` and `mpt_holder_states` for the MPT routes of the API. The runner
 * that calls them is `apps/syncer/src/aggregator/mpt-state.job-runner.ts`.
 *
 *  - **Only committed ledgers.** As for `amm_pools`, everything reads up to a head the caller read (`committedHead`: the newest
 *    `ledgers` row, written after every child table of its ledger): a rebuild ignores state rows above it, and the scans for what
 *    changed stop at it, so that a cursor never passes a ledger whose rows are not all readable.
 *  - **Stale issuances.** The narrow `mpt_touches` (one row per issuance and holder a transaction touched, holder `''` for the
 *    issuance's own node) say what changed: a touch is stale while its ledger is above what the issuance's newest `mpt_issuances` row
 *    has seen (`reflected`: its `last_ledger`, 0 without a row).
 *  - **What `last_ledger` claims.** A rebuild moves `reflected` up to the newest touch at or below its head, so every pair touched
 *    below that must have been rebuilt, or its touch stops being stale and `/holders` stays wrong until the pair's next touch. So
 *    `rebuildMptIssuances` first reads, for its IDs, every pair touched above each `reflected` up to the head, and unions it with the
 *    holders handed in, and no caller has to know them: a retry holds only an ID, a hook at a newer head names only its slice, and
 *    the read of a tie names only its ledger. What is handed in stays needed for what no touch above `reflected` names: the pairs of a
 *    slice that a re-ingest rewrote behind the row.
 *  - **Newest state, whole.** The newest row of a key is read by `LIMIT 1 BY`, never by `argMax`: `argMax` over a `Nullable` skips
 *    NULL, so a `maximum_amount` or a `created_*` would be filled from an older row.
 *  - **Idempotent, versioned.** A row is a function of the state rows. A version is the ClickHouse clock in milliseconds, never below
 *    one more than the newest version of the key, so the newest row of a key is the newest write even when the clock steps back.
 *    Readers keep the newest version of a key (`LIMIT 1 BY`, no `FINAL`).
 *  - **Duplicates change nothing.** The state tables are ReplacingMergeTrees that may not have merged, so a row may be there twice; a
 *    read of the newest row of a key takes one copy.
 *  - **Holders first.** The issuance's count is read from `mpt_holders`, so a reader never sees a count ahead of the rows it counts,
 *    and an issuance's `last_ledger`, the commit marker of a rebuild, is written last.
 *  - **Removal.** A pair with no state row left (a re-ingest dropped it) is deleted from `mpt_holders`, and an issuance with neither a
 *    state row nor a holder row left from both tables (Ruling R-A28's rule), by synchronous lightweight deletes.
 *  - **Query parameters travel in the URL**, and ClickHouse refuses one over 128 KiB (ADR-0012): pairs are read and deleted
 *    `MPT_HOLDERS_READ_CHUNK` at a time, as two arrays zipped back by the server, sorted, so that each read is a narrow range of the
 *    key however many holders there are.
 *  - **Nothing is written once the shutdown has begun**: `signal` is checked before each read and each write.
 */

/** How many issuances one batch of the job covers, and one read of a recompute (their IDs travel as an array parameter). */
export const MPT_STATE_BATCH = 200;

/** How many rows of `mpt_holders` one insert holds. */
export const MPT_HOLDERS_CHUNK = 5000;

/** How many pairs one read and one delete name: two arrays of about 72 KiB and 100 KiB, under the 128 KiB of a parameter. */
export const MPT_HOLDERS_READ_CHUNK = 2000;

/** An issuance to rebuild, and the holders known to want it. */
export interface MptStale {
  id: string;
  /** Holders touched above the issuance's `last_ledger`, or that a slice names. */
  holders: string[];
}

/** What `mptIssuancesChangedSince` answers. */
export interface MptChanged {
  /** The stale issuances after the ledger, at most `limit` of them but for rule 3 (see `mptIssuancesChangedSince`). */
  issuances: MptStale[];
  /** The ledger up to which `issuances` is everything there is: every issuance with a stale touch in `(ledger, upTo]` is in it. */
  upTo: number;
}

export interface RebuildMptOptions {
  /** Checked before each read and each write: an aborted rebuild throws `MptStateAborted` and writes nothing more. */
  signal?: AbortSignal;
}

/** Thrown by a rebuild whose `signal` was aborted: nothing was written after the abort. */
export class MptStateAborted extends Error {
  constructor() {
    super('The MPT state rebuild was aborted before it wrote');
    this.name = 'MptStateAborted';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MptStateAborted();
}

/** Passed on every lightweight DELETE so that no server profile makes it asynchronous (2 = wait for all replicas). */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

type Counted = number | string;

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** The ClickHouse clock in milliseconds, as a version. */
async function clockVersion(ch: ClickHouseService): Promise<bigint> {
  const row = await ch.queryOne<{ now_ms: string }>('SELECT toString(toUnixTimestamp64Milli(now64(3))) AS now_ms');
  return BigInt(row?.now_ms ?? Date.now());
}

// ---------------------------------------------------------------------------------------------------------------------
// What to rebuild
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The touches with, for each, what the issuance's newest `mpt_issuances` row has seen (`reflected`: its `last_ledger`, and nothing for
 * an issuance that has no row). A touch above it is stale (`IS_STALE`; the one definition of stale of the watermark and of
 * `mptIssuancesChangedSince`).
 */
const TOUCHES_WITH_REFLECTED = `FROM ${Table.MptTouches} AS t
  LEFT JOIN (
       SELECT mpt_issuance_id, argMax(last_ledger, version) AS reflected
         FROM ${Table.MptIssuances}
        GROUP BY mpt_issuance_id
       ) AS i ON t.mpt_issuance_id = i.mpt_issuance_id`;
const IS_STALE = 't.ledger_index > ifNull(i.reflected, 0)';

/**
 * The stale issuances after a ledger (up to the head), with the first stale ledger of each and the holders touched since: a range of
 * the key of the touches.
 */
const MPT_CHANGED_SINCE_SQL = `SELECT t.mpt_issuance_id AS id, min(t.ledger_index) AS first_ledger, groupUniqArrayIf(t.holder, t.holder != '') AS holders
  ${TOUCHES_WITH_REFLECTED}
 WHERE t.ledger_index > {ledger:UInt32} AND t.ledger_index <= {head:UInt32} AND ${IS_STALE}
 GROUP BY id
 ORDER BY first_ledger ASC, id ASC
 LIMIT {n:UInt32}`;

/** The stale issuances with a touch at one ledger, with the holders touched there. */
const MPT_AT_LEDGER_SQL = `SELECT t.mpt_issuance_id AS id, groupUniqArrayIf(t.holder, t.holder != '') AS holders
  ${TOUCHES_WITH_REFLECTED}
 WHERE t.ledger_index = {at:UInt32} AND ${IS_STALE}
 GROUP BY id
 ORDER BY id ASC`;

interface StaleRead {
  id: string;
  holders: string[];
}

interface ChangedRead extends StaleRead {
  first_ledger: Counted;
}

const staleOf = (row: StaleRead): MptStale => ({ id: row.id, holders: [...row.holders].sort() });

/**
 * The issuances to rebuild after `ledger`: those with a touch above what their `mpt_issuances` row has seen, at or below `head`, oldest
 * such touch first, each with the holders of those touches, at most `limit` of them, and the ledger the answer is complete up to. A
 * caller that has rebuilt `issuances` goes on from `upTo`, and nothing is missed or waits for ever.
 *
 *  - When there are no more than `limit` such issuances they are all returned and `upTo` is the head (the ledgers between their
 *    touches and the head have no stale touch, so the cursor may skip them: also when no issuance is returned).
 *  - Otherwise the issuances whose first stale touch is before that of the first one left out are returned, and `upTo` is the ledger
 *    before it.
 *  - When more than `limit` issuances have their first stale touch in the very first ledger there is, the cut would never move on, so
 *    all the issuances of that ledger are returned (more than `limit` of them) and `upTo` is that ledger.
 *  - Nothing is returned, and `upTo` is `ledger`, while the head is not past it.
 */
export async function mptIssuancesChangedSince(
  ch: ClickHouseService,
  ledger: number,
  head: number,
  limit: number,
): Promise<MptChanged> {
  const n = Math.max(1, Math.floor(limit));
  if (head <= ledger) return { issuances: [], upTo: ledger };
  const rows = await ch.query<ChangedRead>(MPT_CHANGED_SINCE_SQL, { ledger, head, n: n + 1 });
  if (rows.length <= n) return { issuances: rows.map(staleOf), upTo: head };
  const edge = Number(rows[n].first_ledger);
  const before = rows.slice(0, n).filter((r) => Number(r.first_ledger) < edge);
  if (before.length > 0) return { issuances: before.map(staleOf), upTo: edge - 1 };
  // the ledger of the edge is committed (it is at most the head), so its issuances are all readable
  const atEdge = await ch.query<StaleRead>(MPT_AT_LEDGER_SQL, { at: edge });
  return { issuances: atEdge.map(staleOf), upTo: edge };
}

/**
 * Where the live job of `mpt_state` goes on from: the ledger before the oldest touch at or below the head that its issuance has not
 * seen, or the head when there is none (0 for a database without a ledger). It is the persistent cursor of the job, worked out from the
 * tables, so that a restart resumes where the last run stopped: one scan of `mpt_touches`, at the start of the process. The scan reads
 * the whole table, not a range of its key: an issuance that was never rebuilt may have a stale touch anywhere.
 */
export async function mptStateWatermark(ch: ClickHouseService): Promise<number> {
  const head = await committedHead(ch);
  if (head === 0) return 0;
  const row = await ch.queryOne<{ first_stale: Counted; stale: Counted }>(
    `SELECT minIf(t.ledger_index, ${IS_STALE}) AS first_stale, countIf(${IS_STALE}) AS stale
       ${TOUCHES_WITH_REFLECTED}
      WHERE t.ledger_index <= {head:UInt32}`,
    { head },
  );
  return row !== undefined && Number(row.stale) > 0 ? Number(row.first_stale) - 1 : head;
}

/** The issuances and holders touched in a range of ledgers: a range of the key of the touches. */
const MPT_TOUCHED_IN_SQL = `SELECT mpt_issuance_id AS id, groupUniqArrayIf(holder, holder != '') AS holders
  FROM ${Table.MptTouches}
 WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
 GROUP BY id`;

/**
 * The issuances whose newest `mpt_issuances` row last saw a ledger of a range. A read of the newest version of every issuance: the table
 * is small.
 */
const MPT_ISSUANCES_LAST_SEEN_IN_SQL = `SELECT id
  FROM (
       SELECT mpt_issuance_id AS id, argMax(last_ledger, version) AS reflected
         FROM ${Table.MptIssuances}
        GROUP BY id
       )
 WHERE reflected BETWEEN {min:UInt32} AND {max:UInt32}`;

/**
 * The pairs, of any issuance, whose newest `mpt_holders` row last saw a ledger of a range. A read of the newest version of every pair: a
 * row per MPToken ever made.
 */
const MPT_HOLDERS_LAST_SEEN_IN_SQL = `SELECT id, who
  FROM (
       SELECT mpt_issuance_id AS id, holder AS who, argMax(last_ledger, version) AS seen
         FROM ${Table.MptHolders}
        GROUP BY id, who
       )
 WHERE seen BETWEEN {min:UInt32} AND {max:UInt32}`;

/**
 * The issuances of an `agg_dirty` slice `[from, toExclusive)`, whose ledgers were rewritten behind the aggregator: those with a touch in
 * a ledger that closed in the window, with the holders touched there, those whose newest `mpt_issuances` row last saw one of its
 * ledgers, and every pair, of any issuance, whose newest `mpt_holders` row last saw one (a re-ingest that dropped rows there leaves no
 * touch to find them by, and the pair's issuance may be last seen elsewhere). The time window becomes a range of ledgers first
 * (`RatesService.ledgersClosedIn`). Sorted, each once.
 */
export async function mptIssuancesClosedIn(
  ch: ClickHouseService,
  rates: RatesService,
  from: Date,
  toExclusive: Date,
): Promise<MptStale[]> {
  const range = await rates.ledgersClosedIn(from, toExclusive);
  if (!range) return [];
  const params = { min: range.min, max: range.max };
  const [touched, seen, pairs] = await Promise.all([
    ch.query<StaleRead>(MPT_TOUCHED_IN_SQL, params),
    ch.query<{ id: string }>(MPT_ISSUANCES_LAST_SEEN_IN_SQL, params),
    ch.query<{ id: string; who: string }>(MPT_HOLDERS_LAST_SEEN_IN_SQL, params),
  ]);
  const holdersOf = new Map<string, Set<string>>();
  const of = (id: string): Set<string> => {
    let holders = holdersOf.get(id);
    if (holders === undefined) holdersOf.set(id, (holders = new Set()));
    return holders;
  };
  for (const row of touched) {
    const holders = of(row.id);
    for (const holder of row.holders) holders.add(holder);
  }
  for (const row of seen) of(row.id);
  for (const row of pairs) of(row.id).add(row.who);
  return [...holdersOf.keys()].sort().map((id) => ({ id, holders: [...of(id)].sort() }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The holders
// ---------------------------------------------------------------------------------------------------------------------

/** A holder of an issuance: the key of `mpt_holders`. */
export interface MptPair {
  id: string;
  holder: string;
}

/**
 * A chunk of pairs as the two arrays the server zips back into tuples (`arrayZip`): one parameter of tuples would pass 128 KiB far
 * sooner.
 */
const pairParams = (pairs: ReadonlyArray<MptPair>): { holders: string[]; ids: string[] } => ({
  holders: pairs.map((p) => p.holder),
  ids: pairs.map((p) => p.id),
});

/** A pair as text that sorts by holder, then by issuance (a space sorts below every character of an address). */
const pairKey = (id: string, holder: string): string => `${holder} ${id}`;

/** The newest state row at or below the head of each pair: a prefix of the key each, one row per pair however many copies there are. */
const HOLDER_STATES_SQL = `SELECT holder, mpt_issuance_id, ledger_index, toString(amount) AS amount_text, toString(escrowed_amount) AS escrowed_text, flags, deleted
  FROM ${Table.MptHolderStates}
 WHERE (holder, mpt_issuance_id) IN (SELECT arrayJoin(arrayZip({holders:Array(String)}, {ids:Array(String)})))
   AND ledger_index <= {head:UInt32}
 ORDER BY holder, mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index DESC
 LIMIT 1 BY holder, mpt_issuance_id`;

/** The newest version each pair has in `mpt_holders`; a pair with none has no row there. */
const HOLDER_VERSIONS_SQL = `SELECT mpt_issuance_id, holder, toString(max(version)) AS newest
  FROM ${Table.MptHolders}
 WHERE (mpt_issuance_id, holder) IN (SELECT arrayJoin(arrayZip({ids:Array(String)}, {holders:Array(String)})))
 GROUP BY mpt_issuance_id, holder`;

const DELETE_HOLDERS_SQL = `DELETE FROM ${Table.MptHolders}
 WHERE (mpt_issuance_id, holder) IN (SELECT arrayJoin(arrayZip({ids:Array(String)}, {holders:Array(String)})))`;

interface HolderStateRead {
  holder: string;
  mpt_issuance_id: string;
  ledger_index: Counted;
  amount_text: string;
  escrowed_text: string;
  flags: Counted;
  deleted: Counted;
}

/**
 * Rebuilds the `mpt_holders` row of each pair, from the newest `mpt_holder_states` row at or below the head, and writes them under one
 * new version: pairs are read `MPT_HOLDERS_READ_CHUNK` at a time, sorted, and written `MPT_HOLDERS_CHUNK` at a time. A pair with a row
 * of its own and no state row left is deleted. Returns how many rows it wrote.
 */
export async function recomputeMptHolders(
  ch: ClickHouseService,
  pairs: ReadonlyArray<MptPair>,
  head: number,
  o: RebuildMptOptions = {},
): Promise<number> {
  const { signal } = o;
  throwIfAborted(signal);
  const distinct = new Map(pairs.map((p) => [pairKey(p.id, p.holder), p]));
  // by holder, as the key of the state rows is: each chunk is a narrow range of it
  const sorted = [...distinct.keys()].sort().map((key) => distinct.get(key) as MptPair);
  if (sorted.length === 0) return 0;

  let version = await clockVersion(ch);
  const rows: HolderStateRead[] = [];
  const gone: MptPair[] = [];
  for (const chunk of chunksOf(sorted, MPT_HOLDERS_READ_CHUNK)) {
    throwIfAborted(signal);
    const params = pairParams(chunk);
    const [states, versions] = await Promise.all([
      ch.query<HolderStateRead>(HOLDER_STATES_SQL, { ...params, head }),
      ch.query<{ mpt_issuance_id: string; holder: string; newest: string }>(HOLDER_VERSIONS_SQL, params),
    ]);
    rows.push(...states);
    const withState = new Set(states.map((s) => pairKey(s.mpt_issuance_id, s.holder)));
    for (const row of versions) {
      if (BigInt(row.newest) >= version) version = BigInt(row.newest) + 1n;
      if (!withState.has(pairKey(row.mpt_issuance_id, row.holder))) {
        gone.push({ id: row.mpt_issuance_id, holder: row.holder });
      }
    }
  }

  const written = version.toString();
  for (const chunk of chunksOf(rows, MPT_HOLDERS_CHUNK)) {
    throwIfAborted(signal);
    await ch.insert<MptHoldersRow>(
      Table.MptHolders,
      chunk.map((s) => ({
        mpt_issuance_id: s.mpt_issuance_id,
        holder: s.holder,
        amount: s.amount_text,
        escrowed_amount: s.escrowed_text,
        flags: Number(s.flags),
        last_ledger: Number(s.ledger_index),
        deleted: Number(s.deleted),
        version: written,
      })),
    );
  }
  gone.sort((a, b) => (pairKey(a.id, a.holder) < pairKey(b.id, b.holder) ? -1 : 1));
  for (const chunk of chunksOf(gone, MPT_HOLDERS_READ_CHUNK)) {
    throwIfAborted(signal);
    await ch.command(DELETE_HOLDERS_SQL, pairParams(chunk), { settings: SYNC_DELETE });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// The issuances
// ---------------------------------------------------------------------------------------------------------------------

/** The newest state of each issuance at or below the head: whole, and one row however many copies there are. */
const ISSUANCE_STATES_SQL = `SELECT mpt_issuance_id, ledger_index, flags, asset_scale, toString(maximum_amount) AS maximum_text,
       toString(outstanding_amount) AS outstanding_text, toString(escrowed_amount) AS escrowed_text, transfer_fee, metadata_hex, deleted
  FROM ${Table.MptIssuanceStates}
 WHERE mpt_issuance_id IN {ids:Array(String)} AND ledger_index <= {head:UInt32}
 ORDER BY mpt_issuance_id, ledger_index DESC, tx_index DESC, node_index DESC
 LIMIT 1 BY mpt_issuance_id`;

/** The creation of each issuance whose `MPTokenIssuanceCreate` is in the coverage: its oldest such row. */
const ISSUANCE_CREATED_SQL = `SELECT mpt_issuance_id, ledger_index, toUnixTimestamp(close_time) AS created_close, tx_hash
  FROM ${Table.MptIssuanceStates}
 WHERE mpt_issuance_id IN {ids:Array(String)} AND ledger_index <= {head:UInt32} AND tx_type = 'MPTokenIssuanceCreate'
 ORDER BY mpt_issuance_id, ledger_index ASC, tx_index ASC, node_index ASC
 LIMIT 1 BY mpt_issuance_id`;

const HAS_BALANCE = '(amount > 0 OR escrowed_amount > 0)';
const LOCKED_WITH_BALANCE = `deleted = 0 AND bitAnd(flags, ${LSF_MPT_LOCKED}) != 0 AND ${HAS_BALANCE}`;

/** What the newest `mpt_holders` row of each holder says of each issuance. */
const ISSUANCE_HOLDERS_SQL = `SELECT id,
       countIf(deleted = 0 AND ${HAS_BALANCE}) AS with_balance,
       toString(sumIf(amount, ${LOCKED_WITH_BALANCE})) AS locked_sum,
       countIf(${LOCKED_WITH_BALANCE}) AS locked_count,
       max(last_ledger) AS newest_seen
  FROM (
       SELECT mpt_issuance_id AS id, holder, amount, escrowed_amount, flags, last_ledger, deleted
         FROM ${Table.MptHolders}
        WHERE mpt_issuance_id IN {ids:Array(String)}
        ORDER BY mpt_issuance_id, holder, version DESC
        LIMIT 1 BY mpt_issuance_id, holder
       )
 GROUP BY id`;

/** The newest version each of the issuances has now. */
const ISSUANCE_VERSIONS_SQL = `SELECT mpt_issuance_id, toString(max(version)) AS newest
  FROM ${Table.MptIssuances}
 WHERE mpt_issuance_id IN {ids:Array(String)}
 GROUP BY mpt_issuance_id`;

/** What is deleted of an issuance with neither a state row nor a holder row left. */
const DELETE_ISSUANCE_SQLS = [
  `DELETE FROM ${Table.MptHolders} WHERE mpt_issuance_id IN {ids:Array(String)}`,
  `DELETE FROM ${Table.MptIssuances} WHERE mpt_issuance_id IN {ids:Array(String)}`,
];

interface IssuanceStateRead {
  mpt_issuance_id: string;
  ledger_index: Counted;
  flags: Counted;
  asset_scale: Counted;
  maximum_text: string | null;
  outstanding_text: string;
  escrowed_text: string;
  transfer_fee: Counted;
  metadata_hex: string;
  deleted: Counted;
}

interface IssuanceCreatedRead {
  mpt_issuance_id: string;
  ledger_index: Counted;
  created_close: Counted;
  tx_hash: string;
}

interface IssuanceHoldersRead {
  id: string;
  with_balance: Counted;
  locked_sum: string;
  locked_count: Counted;
  newest_seen: Counted;
}

/** The row of an issuance, but its version. */
function issuanceRowOf(
  id: string,
  state: IssuanceStateRead | undefined,
  made: IssuanceCreatedRead | undefined,
  holders: IssuanceHoldersRead | undefined,
): Omit<MptIssuancesRow, 'version'> {
  const { issuer, sequence } = decodeMptIssuanceId(id);
  const flags = state === undefined ? 0 : Number(state.flags);
  const outstanding = state?.outstanding_text ?? '0';
  const withBalance = holders === undefined ? 0 : Number(holders.with_balance);
  const allLocked = (flags & LSF_MPT_LOCKED) !== 0;
  const hex = state?.metadata_hex ?? '';
  const decoded = decodeMptMetadata(hex);
  return {
    mpt_issuance_id: id,
    issuer,
    sequence,
    state_known: state === undefined ? 0 : 1,
    flags,
    asset_scale: state === undefined ? 0 : Number(state.asset_scale),
    maximum_amount: state?.maximum_text ?? null,
    outstanding_amount: outstanding,
    escrowed_amount: state?.escrowed_text ?? '0',
    locked_amount: allLocked ? outstanding : (holders?.locked_sum ?? '0'),
    locked_holders: allLocked ? withBalance : Number(holders?.locked_count ?? 0),
    holders: withBalance,
    transfer_fee: state === undefined ? 0 : Number(state.transfer_fee),
    metadata_hex: hex,
    metadata: decoded === undefined ? '' : JSON.stringify(decoded),
    metadata_conforms: decoded !== undefined && mptMetadataConforms(decoded) ? 1 : 0,
    ticker: cutText(decoded?.ticker, MPT_TICKER_MAX),
    name: cutText(decoded?.name, MPT_NAME_MAX),
    created_ledger: made === undefined ? null : Number(made.ledger_index),
    created_time: made === undefined ? null : Number(made.created_close),
    created_tx_hash: made === undefined ? null : made.tx_hash,
    last_ledger: Math.max(Number(state?.ledger_index ?? 0), Number(holders?.newest_seen ?? 0)),
    destroyed: state === undefined ? 0 : Number(state.deleted),
  };
}

async function recomputeIssuancesChunk(
  ch: ClickHouseService,
  ids: string[],
  head: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  const [states, created, holders, versions, clock] = await Promise.all([
    ch.query<IssuanceStateRead>(ISSUANCE_STATES_SQL, { ids, head }),
    ch.query<IssuanceCreatedRead>(ISSUANCE_CREATED_SQL, { ids, head }),
    ch.query<IssuanceHoldersRead>(ISSUANCE_HOLDERS_SQL, { ids }),
    ch.query<{ mpt_issuance_id: string; newest: string }>(ISSUANCE_VERSIONS_SQL, { ids }),
    clockVersion(ch),
  ]);
  const stateOf = new Map(states.map((s) => [s.mpt_issuance_id, s]));
  const madeOf = new Map(created.map((c) => [c.mpt_issuance_id, c]));
  const holdersOf = new Map(holders.map((h) => [h.id, h]));
  const newestOf = new Map(versions.map((v) => [v.mpt_issuance_id, BigInt(v.newest)]));

  // an ID with a row of its own and neither a state row nor a holder row left is no issuance any more: its rows go
  const gone = ids.filter((id) => newestOf.has(id) && !stateOf.has(id) && !holdersOf.has(id));
  if (gone.length > 0) {
    for (const sql of DELETE_ISSUANCE_SQLS) {
      throwIfAborted(signal);
      await ch.command(sql, { ids: gone }, { settings: SYNC_DELETE });
    }
  }
  const known = ids.filter((id) => stateOf.has(id) || holdersOf.has(id));
  if (known.length === 0) return 0;

  const rows: MptIssuancesRow[] = known.map((id) => {
    const above = (newestOf.get(id) ?? -1n) + 1n;
    return {
      ...issuanceRowOf(id, stateOf.get(id), madeOf.get(id), holdersOf.get(id)),
      // the clock, but one past the version the issuance has now
      version: (above > clock ? above : clock).toString(),
    };
  });
  throwIfAborted(signal);
  await ch.insert(Table.MptIssuances, rows);
  return rows.length;
}

/**
 * Rebuilds the `mpt_issuances` row of each ID and writes it under a new version of its own: the newest state at or below the head
 * (`state_known` 1), or `state_known` 0 with the state columns at their defaults; the creation; `holders`, `locked_amount` and
 * `locked_holders` from the newest `mpt_holders` rows; the decoded metadata; and `last_ledger`, the greater of the newest state row's
 * ledger and the highest `last_ledger` of its `mpt_holders` rows. An ID with neither a state row nor a holder row left is deleted from
 * both tables. Returns how many rows it wrote.
 */
export async function recomputeMptIssuances(
  ch: ClickHouseService,
  ids: readonly string[],
  head: number,
  o: RebuildMptOptions = {},
): Promise<number> {
  const { signal } = o;
  throwIfAborted(signal);
  let written = 0;
  for (const chunk of chunksOf([...new Set(ids)].sort(), MPT_STATE_BATCH)) {
    written += await recomputeIssuancesChunk(ch, chunk, head, signal);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------------------------------
// The rebuild
// ---------------------------------------------------------------------------------------------------------------------

/** What each of some issuances' newest `mpt_issuances` row has seen; an issuance with no row is not in it. */
const REFLECTED_OF_SQL = `SELECT mpt_issuance_id AS id, argMax(last_ledger, version) AS reflected
  FROM ${Table.MptIssuances}
 WHERE mpt_issuance_id IN {ids:Array(String)}
 GROUP BY id`;

/** The pairs of some issuances touched in `(above, head]`, with the newest touch of each: a range of the key of the touches. */
const TOUCHED_PAIRS_SQL = `SELECT mpt_issuance_id AS id, holder AS who, max(ledger_index) AS newest
  FROM ${Table.MptTouches}
 WHERE ledger_index > {above:UInt32} AND ledger_index <= {head:UInt32}
   AND mpt_issuance_id IN {ids:Array(String)} AND holder != ''
 GROUP BY id, who`;

/** Every pair of some issuances touched above what the issuance's row has seen, up to the head (see the header). */
async function pairsAboveReflected(
  ch: ClickHouseService,
  ids: string[],
  head: number,
  signal: AbortSignal | undefined,
): Promise<MptPair[]> {
  throwIfAborted(signal);
  const rows = await ch.query<{ id: string; reflected: Counted }>(REFLECTED_OF_SQL, { ids });
  const reflected = new Map(rows.map((r) => [r.id, Number(r.reflected)]));
  const seenOf = (id: string): number => reflected.get(id) ?? 0;
  const above = Math.min(...ids.map(seenOf));
  if (above >= head) return [];
  throwIfAborted(signal);
  const touched = await ch.query<{ id: string; who: string; newest: Counted }>(TOUCHED_PAIRS_SQL, { above, head, ids });
  return touched.filter((t) => Number(t.newest) > seenOf(t.id)).map((t) => ({ id: t.id, holder: t.who }));
}

/**
 * Rebuilds some issuances at a head: first their holders, those handed in and every pair touched above what the issuance's row has seen
 * (see the header), then their rows. It is idempotent, and a batch that fails is simply done again.
 */
export async function rebuildMptIssuances(
  ch: ClickHouseService,
  stale: readonly MptStale[],
  head: number,
  o: RebuildMptOptions = {},
): Promise<void> {
  const { signal } = o;
  throwIfAborted(signal);
  const ids = [...new Set(stale.map((s) => s.id))].sort();
  if (ids.length === 0) return;
  const pairs: MptPair[] = stale.flatMap((s) => s.holders.map((holder) => ({ id: s.id, holder })));
  for (const chunk of chunksOf(ids, MPT_STATE_BATCH)) {
    pairs.push(...(await pairsAboveReflected(ch, chunk, head, signal)));
  }
  await recomputeMptHolders(ch, pairs, head, o);
  await recomputeMptIssuances(ch, ids, head, o);
}

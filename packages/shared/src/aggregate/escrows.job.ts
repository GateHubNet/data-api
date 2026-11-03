import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { EscrowsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { firstCommittedLedger } from '../ingest/ingest-state';
import { dropsToNative } from '../util/amount';
import { mptIssuerOf } from '../util/mpt';
import { RIPPLE_EPOCH_MS } from '../util/time';
import { committedHead } from './amm-pools.job';

/**
 * The `escrows` job's functions (spec sections 1.3, 4.1 and 4.3): the current state of every escrow the index has seen, rebuilt
 * from its `object_changes` rows, and the **sentinel** row that holds the escrowed total. The runner that calls them is Task 8's.
 *
 *  - **A step is a window.** `runEscrowsStep` works on `(W, U]`: `W` is the sentinel's `through_ledger`, or the ledger before the
 *    first committed one while that is 0 (no sentinel, or one a step on an empty database wrote: no escrow row can be older, so
 *    the job never walks the empty ledgers below the first one, nor writes a `through_ledger` the `ledgers` table does not have),
 *    `U = max(W, min(head, W + step))` and the head is the newest committed ledger (`committedHead`), so a ledger whose rows are
 *    not all readable is never passed. A first run over all history proceeds in steps of `ESCROWS_STEP_LEDGERS`.
 *  - **What is read, and how each read is bounded.**
 *      - the sentinel: its key, one row (`readEscrowed`); the first committed ledger: a `min` of the one column the table is
 *        partitioned and ordered by, only while the watermark is 0, so once the first ledger is committed;
 *      - the touched escrows (`escrowsTouchedIn`): `object_changes` by the partitions that hold the window (`PARTITION BY
 *        intDiv(ledger_index, 10000000)`) and the `object_type = 'Escrow'` prefix of its key, so no more than the escrow rows of
 *        those partitions (a bound the tests pin over a bulk of other rows); the answer is the escrows touched in the window;
 *      - the recompute (`recomputeEscrows`): in chunks of `ESCROWS_CHUNK`, two reads of the `Escrow` rows of the escrows named up
 *        to `upTo` (the prefix `(object_type, object_id)` of the key of `object_changes`, then the ledger range inside it: the
 *        rows of other types under the same IDs, and the rows above `upTo`, are not read; a test pins it), and the `escrows` rows
 *        of the same IDs by the key of `escrows`;
 *      - the total: one narrow row per escrow ever seen, only after a step that wrote or removed an escrow, or that finds no
 *        sentinel (spec 4.2).
 *  - **Idempotent, versioned.** An escrow's row is a function of its `object_changes` rows up to `U`. A chunk is written under
 *    one version: the ClickHouse clock in milliseconds, but above the newest version of each row it replaces, so that the
 *    newest write stays the newest row even when the clock steps back. Readers keep the newest version of a key (`LIMIT 1 BY`,
 *    no `FINAL`).
 *  - **The sentinel is the commit marker of a step** (as `ledgers` is of an ingest): it is written last, on every step, whether
 *    or not an escrow changed. A step that fails before it leaves the old sentinel, whose total and watermark agree with each
 *    other, and the next step does `(W, U]` again, which rewrites the same rows.
 *  - **An escrow that cannot be mapped is set aside**, not allowed to stall the job: its row is not written (a row it had stays as
 *    it was, and the total counts that row) and its ID is returned with the reason (`setAside`), and the step commits. Mapping
 *    fails only on rows the ledger cannot produce (a text that is not JSON, an `Amount` of no shape the ledger has, drops that are
 *    not a whole number, an MPT ID that is not one), so it is unreachable from ledger data. Mapping is a pure function of the
 *    rows, so there is nothing to retry.
 *  - **An escrow with no row left is removed**: a re-ingest dropped its `object_changes` rows. Its `escrows` rows are deleted
 *    (a lightweight DELETE, as for `amm_pools`).
 *  - **Nothing is written once the shutdown has begun**: `signal` is checked before each read and each write.
 */

/** How many ledgers one step of the job covers: a first run over all history proceeds in steps within the runner's budget. */
export const ESCROWS_STEP_LEDGERS = 1_000_000;

/** How many escrows one recompute batch covers, and so one version. */
export const ESCROWS_CHUNK = 500;

/** What D7's `supply` job reads of the sentinel: the native drops in open escrows, how many there are, and the ledger they are as of. */
export interface Escrowed {
  /** The sum of `amount_drops` over the open native escrows: an integer, as text. */
  drops: string;
  /** How many native escrows are open. */
  open: number;
  /** The ledger the job has processed up to (its watermark): the total is the state of the escrows at it. */
  through_ledger: number;
}

/** What one `runEscrowsStep` did. */
export interface EscrowsStep {
  /** The watermark the step started from, and the one it wrote (`through_ledger` of the new sentinel). */
  from: number;
  to: number;
  /** The newest committed ledger the step saw: `to` is below it while there is more to do. */
  head: number;
  /** How many escrows `(from, to]` touched, how many rows were written and how many escrows were removed. */
  touched: number;
  written: number;
  removed: number;
  /** The escrows of the window that could not be mapped (see `recomputeEscrows`), in the order of their IDs. */
  setAside: SetAsideEscrow[];
  /** The sentinel the step wrote. */
  escrowed: Escrowed;
}

/** An escrow whose rows cannot be mapped to an `escrows` row, and why (what `escrowRowOf` refuses them for). */
export interface SetAsideEscrow {
  id: string;
  reason: string;
}

/** The columns of an `object_changes` row that make an `escrows` row. */
export interface EscrowSource {
  object_id: string;
  ledger_index: number;
  action: 'created' | 'modified' | 'deleted';
  /** The node's fields after the transaction: JSON text, raw ledger values. */
  fields: string;
  /** The facts the event took from the transaction: JSON text (`sequence` for a `create`). */
  event_fields: string;
}

/** Thrown by a step whose `signal` was aborted: nothing was written after the abort. */
export class EscrowsAborted extends Error {
  constructor() {
    super('The escrows job was aborted before it wrote');
    this.name = 'EscrowsAborted';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EscrowsAborted();
}

/** Passed on every lightweight DELETE so that no server profile makes it asynchronous (2 = wait for all replicas). */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

type Counted = number | string;

const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;

// ---------------------------------------------------------------------------------------------------------------------
// The row of an escrow (pure)
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseObject(text: string): Json {
  const value: unknown = JSON.parse(text);
  return isRecord(value) ? value : {};
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A ledger time (Ripple-epoch seconds) as unix seconds, `null` when the escrow has none. */
const unixTime = (value: unknown): number | null => (typeof value === 'number' ? value + RIPPLE_EPOCH_S : null);

type EscrowAmount = Pick<EscrowsRow, 'currency' | 'issuer' | 'amount' | 'amount_drops'>;

/**
 * The amount columns of an escrow from the node's `Amount`: drops as text (the native currency), an issued-token object, or an
 * MPT object. Any other shape is not one the ledger has, and is refused, so that no row is written that counts for nothing.
 */
function amountOf(amount: unknown, native: string): EscrowAmount {
  if (typeof amount === 'string' || typeof amount === 'number') {
    const drops = String(amount);
    if (!/^[0-9]+$/.test(drops)) throw new Error(`an Amount of ${drops} drops is not a whole number`);
    return { currency: native, issuer: '', amount: dropsToNative(drops), amount_drops: drops };
  }
  if (isRecord(amount) && typeof amount.value === 'string') {
    if (typeof amount.mpt_issuance_id === 'string') {
      const issuance = amount.mpt_issuance_id.toUpperCase();
      return { currency: issuance, issuer: mptIssuerOf(issuance), amount: amount.value, amount_drops: 0 };
    }
    if (typeof amount.currency === 'string' && typeof amount.issuer === 'string') {
      return { currency: amount.currency, issuer: amount.issuer, amount: amount.value, amount_drops: 0 };
    }
  }
  throw new Error('the Amount is of a shape the ledger does not have');
}

/**
 * The `escrows` row of an escrow, from its newest `object_changes` row (the state at `last_ledger`; a `deleted` row is the end
 * of it) and its created row, when the index has it (`created`: the history may start after the escrow was made). Pure.
 *
 * `sequence` is the object's own `Sequence`, else the one the created row's event took from the transaction (a ticketed
 * escrow, an XRPL escrow older than the field, a Xahau one), else `null` (a Hook-emitted Xahau escrow has neither; a 0 is no
 * sequence, as in the parser). `open_count` and `through_ledger` are the sentinel's, 0 here.
 *
 * Throws an `Error` that names the escrow when its rows cannot be mapped (a text that is not JSON, an `Amount` of a shape the
 * ledger does not have, an MPT ID that is not one): the job sets such an escrow aside.
 */
export function escrowRowOf(
  newest: EscrowSource,
  created: EscrowSource | undefined,
  native: string,
  version: number,
): EscrowsRow {
  const mapped = mappedEscrow(newest, created, native, version);
  if ('reason' in mapped) throw new Error(`The escrow ${newest.object_id} cannot be mapped: ${mapped.reason}`);
  return mapped.row;
}

/** The `escrows` row of an escrow (`escrowRowOf`), or why its rows cannot be mapped. */
function mappedEscrow(
  newest: EscrowSource,
  created: EscrowSource | undefined,
  native: string,
  version: number,
): { row: EscrowsRow } | { reason: string } {
  try {
    return { row: mapEscrow(newest, created, native, version) };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

function mapEscrow(
  newest: EscrowSource,
  created: EscrowSource | undefined,
  native: string,
  version: number,
): EscrowsRow {
  const fields = parseObject(newest.fields);
  const createdFacts = created === undefined ? {} : parseObject(created.event_fields);
  const sequence = positiveInteger(fields.Sequence)
    ? fields.Sequence
    : positiveInteger(createdFacts.sequence)
      ? createdFacts.sequence
      : null;
  return {
    escrow_id: newest.object_id,
    owner: typeof fields.Account === 'string' ? fields.Account : '',
    destination: typeof fields.Destination === 'string' ? fields.Destination : '',
    sequence,
    ...amountOf(fields.Amount, native),
    finish_after: unixTime(fields.FinishAfter),
    cancel_after: unixTime(fields.CancelAfter),
    has_condition: typeof fields.Condition === 'string' && fields.Condition !== '' ? 1 : 0,
    created_ledger: created === undefined ? null : created.ledger_index,
    last_ledger: newest.ledger_index,
    deleted: newest.action === 'deleted' ? 1 : 0,
    open_count: 0,
    through_ledger: 0,
    version,
  };
}

/** The sentinel row: the total and the watermark, every other column empty, 0 or `null`. */
function sentinelRow(escrowed: Escrowed, version: number): EscrowsRow {
  return {
    escrow_id: '',
    owner: '',
    destination: '',
    sequence: null,
    currency: '',
    issuer: '',
    amount: '',
    amount_drops: escrowed.drops,
    finish_after: null,
    cancel_after: null,
    has_condition: 0,
    created_ledger: null,
    last_ledger: 0,
    deleted: 0,
    open_count: escrowed.open,
    through_ledger: escrowed.through_ledger,
    version,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What was touched
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The escrows with a row in the ledgers `[from, to]` (both inclusive). The partitions that hold the range are read (`PARTITION
 * BY intDiv(ledger_index, 10000000)`) and, in them, the `object_type = 'Escrow'` prefix of the key: no more than the escrow rows
 * of those partitions, whatever other objects the table holds.
 */
const TOUCHED_BETWEEN_SQL = `SELECT DISTINCT object_id
  FROM ${Table.ObjectChanges}
 WHERE object_type = 'Escrow' AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}
 ORDER BY object_id`;

const touchedBetween = async (ch: ClickHouseService, from: number, to: number): Promise<string[]> =>
  to < from ? [] : (await ch.query<{ object_id: string }>(TOUCHED_BETWEEN_SQL, { from, to })).map((r) => r.object_id);

/**
 * The escrows with an `object_changes` row in the ledgers after `fromLedger` up to `toLedger` (`(from, to]`: the window of a step
 * whose watermark is `fromLedger`), in the order of their IDs, each once.
 */
export function escrowsTouchedIn(ch: ClickHouseService, fromLedger: number, toLedger: number): Promise<string[]> {
  return touchedBetween(ch, fromLedger + 1, toLedger);
}

/**
 * The escrows whose newest `escrows` row has its `last_ledger` in a range, found in two reads of two narrow columns: the keys
 * with any row that says so first, and only then the newest row of each of those. An escrow whose rows a re-ingest removed from
 * the range leaves no touch to find it by, and its `last_ledger` is the one place that still names the range.
 */
const LAST_SEEN_IN_SQL = `SELECT escrow_id
  FROM (
       SELECT escrow_id, last_ledger
         FROM ${Table.Escrows}
        WHERE escrow_id IN (
              SELECT escrow_id FROM ${Table.Escrows}
               WHERE escrow_id != '' AND last_ledger >= {min:UInt32} AND last_ledger <= {max:UInt32}
              )
        ORDER BY escrow_id, version DESC
        LIMIT 1 BY escrow_id
       )
 WHERE last_ledger >= {min:UInt32} AND last_ledger <= {max:UInt32}`;

/**
 * The escrows of the ledgers `[min, max]` (both inclusive): those with an `object_changes` row there, and those whose newest
 * `escrows` row has its `last_ledger` there (a re-ingest that dropped the rows of an escrow there leaves no row to find it by;
 * its recompute goes back to its older rows, or removes it when none is left). The step of an `agg_dirty` slice uses it. In the
 * order of the IDs, each once. The second read looks at two columns of every row of `escrows` (spec 4.2: one narrow row per
 * escrow ever seen), once per slice.
 */
export async function escrowsOfLedgers(ch: ClickHouseService, min: number, max: number): Promise<string[]> {
  if (max < min) return [];
  const [touched, seen] = await Promise.all([
    touchedBetween(ch, min, max),
    ch.query<{ escrow_id: string }>(LAST_SEEN_IN_SQL, { min, max }),
  ]);
  return [...new Set([...touched, ...seen.map((r) => r.escrow_id)])].sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// The recompute
// ---------------------------------------------------------------------------------------------------------------------

/** The newest row of each of some escrows at or before a ledger, by the prefix `(object_type, object_id)` of the key. */
const newestRowSql = (only = ''): string => `SELECT object_id, ledger_index, action, fields, event_fields
  FROM ${Table.ObjectChanges}
 WHERE object_type = 'Escrow' AND object_id IN {ids:Array(String)} AND ledger_index <= {upTo:UInt32}${only}
 ORDER BY object_type, object_id, ledger_index DESC, tx_index DESC
 LIMIT 1 BY object_id`;
const NEWEST_SQL = newestRowSql();
const NEWEST_CREATED_SQL = newestRowSql(` AND action = 'created'`);

/** The newest version of the `escrows` rows of some escrows (what the batch replaces), by the key of the table. */
const VERSIONS_SQL = `SELECT escrow_id, toUInt64(max(version)) AS newest
  FROM ${Table.Escrows}
 WHERE escrow_id IN {ids:Array(String)}
 GROUP BY escrow_id`;

const CLOCK_SQL = `SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms`;

const DELETE_ESCROWS_SQL = `DELETE FROM ${Table.Escrows} WHERE escrow_id IN {gone:Array(String)}`;

interface SourceRow extends Omit<EscrowSource, 'ledger_index'> {
  ledger_index: Counted;
}

const sourceOf = (row: SourceRow): EscrowSource => ({ ...row, ledger_index: Number(row.ledger_index) });

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Recomputes one chunk of escrows (at most `ESCROWS_CHUNK`, distinct) under one version. */
async function recomputeChunk(
  ch: ClickHouseService,
  ids: string[],
  opts: { upTo: number; native: string; signal?: AbortSignal },
): Promise<{ written: number; removed: number; setAside: SetAsideEscrow[] }> {
  const { upTo, native, signal } = opts;
  throwIfAborted(signal);
  const params = { ids, upTo };
  const [newest, created, versions, clock] = await Promise.all([
    ch.query<SourceRow>(NEWEST_SQL, params),
    ch.query<SourceRow>(NEWEST_CREATED_SQL, params),
    ch.query<{ escrow_id: string; newest: Counted }>(VERSIONS_SQL, { ids }),
    ch.queryOne<{ now_ms: Counted }>(CLOCK_SQL),
  ]);

  const newestOf = new Map(newest.map((r) => [r.object_id, sourceOf(r)]));
  const createdOf = new Map(created.map((r) => [r.object_id, sourceOf(r)]));
  // above the clock, and above the newest version of every row being replaced
  let version = Number(clock?.now_ms ?? Date.now());
  for (const { newest: latest } of versions) version = Math.max(version, Number(latest) + 1);

  const rows: EscrowsRow[] = [];
  const setAside: SetAsideEscrow[] = [];
  for (const id of ids) {
    const row = newestOf.get(id);
    if (row === undefined) continue;
    const mapped = mappedEscrow(row, createdOf.get(id), native, version);
    // rows that cannot be mapped: the others are written and the job goes on
    if ('reason' in mapped) setAside.push({ id, reason: mapped.reason });
    else rows.push(mapped.row);
  }
  throwIfAborted(signal);
  await ch.insert(Table.Escrows, rows);

  // an escrow with no row left is removed when something of it was stored; one that never had a row is nothing to do
  const stored = new Set(versions.map((v) => v.escrow_id));
  const gone = ids.filter((id) => !newestOf.has(id) && stored.has(id));
  if (gone.length > 0) {
    throwIfAborted(signal);
    await ch.command(DELETE_ESCROWS_SQL, { gone }, { settings: SYNC_DELETE });
  }
  return { written: rows.length, removed: gone.length, setAside };
}

/**
 * Rebuilds the `escrows` row of each of `ids` from its `object_changes` rows at or before `upTo` (its newest row, and the newest
 * `created` row for the ledger and the sequence it was made with) and writes it under one version per chunk of `ESCROWS_CHUNK`
 * (see the header). An ID with no row left at or before `upTo` is removed: a lightweight `DELETE` of its `escrows` rows, when
 * any is stored. It does not touch the sentinel. Idempotent: running it again leaves the same newest values under newer
 * versions. `signal` is checked before each read and each write: an aborted recompute throws `EscrowsAborted` and writes nothing
 * more.
 *
 * An escrow whose rows cannot be mapped (`escrowRowOf` refuses them: an `Amount` of a shape the ledger does not have, a text that
 * is not JSON) is set aside: the others of its chunk are written, and its ID is returned with the reason. A row it had stays as it
 * was.
 *
 * Returns how many rows it wrote, how many escrows it removed, and the escrows set aside, in the order of their IDs.
 */
export async function recomputeEscrows(
  ch: ClickHouseService,
  ids: readonly string[],
  opts: { upTo: number; native: string; signal?: AbortSignal },
): Promise<{ written: number; removed: number; setAside: SetAsideEscrow[] }> {
  throwIfAborted(opts.signal);
  const result = { written: 0, removed: 0, setAside: [] as SetAsideEscrow[] };
  for (const chunk of chunksOf([...new Set(ids)].sort(), ESCROWS_CHUNK)) {
    const done = await recomputeChunk(ch, chunk, opts);
    result.written += done.written;
    result.removed += done.removed;
    result.setAside.push(...done.setAside);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The total and the sentinel
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The open native escrows and their drops: the newest row of every escrow ever seen (two narrow columns besides the key and the
 * version), then those not deleted whose currency is the native one.
 */
const TOTAL_SQL = `SELECT count() AS open, toString(sum(amount_drops)) AS drops
  FROM (SELECT deleted, amount_drops, currency, issuer FROM ${Table.Escrows} WHERE escrow_id != ''
         ORDER BY escrow_id, version DESC LIMIT 1 BY escrow_id)
 WHERE deleted = 0 AND issuer = '' AND currency = {native:String}`;

/** The newest sentinel, by the key of the table. */
const SENTINEL_SQL = `SELECT toString(amount_drops) AS drops, open_count, through_ledger
  FROM ${Table.Escrows}
 WHERE escrow_id = ''
 ORDER BY version DESC
 LIMIT 1`;

const SENTINEL_VERSION_SQL = `SELECT toUInt64(max(version)) AS newest FROM ${Table.Escrows} WHERE escrow_id = ''`;

/**
 * The escrowed total, as the sentinel holds it: one read of the sentinel (`WHERE escrow_id = '' ORDER BY version DESC LIMIT 1`).
 * `undefined` before the first run of the job. Its coverage is not in it: D7's API asks for the coverage of the `escrows`
 * feature.
 */
export async function readEscrowed(ch: ClickHouseService): Promise<Escrowed | undefined> {
  const row = await ch.queryOne<{ drops: string; open_count: Counted; through_ledger: Counted }>(SENTINEL_SQL);
  return row === undefined
    ? undefined
    : { drops: row.drops, open: Number(row.open_count), through_ledger: Number(row.through_ledger) };
}

/** The total of the open native escrows, as of the rows now in `escrows`. */
async function totalOf(ch: ClickHouseService, native: string): Promise<Pick<Escrowed, 'drops' | 'open'>> {
  const row = await ch.queryOne<{ open: Counted; drops: string }>(TOTAL_SQL, { native });
  return { drops: row?.drops ?? '0', open: Number(row?.open ?? 0) };
}

/** Writes the sentinel under a version above the clock and above the newest sentinel's. */
async function writeSentinel(
  ch: ClickHouseService,
  escrowed: Escrowed,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const [clock, newest] = await Promise.all([
    ch.queryOne<{ now_ms: Counted }>(CLOCK_SQL),
    ch.queryOne<{ newest: Counted }>(SENTINEL_VERSION_SQL),
  ]);
  const version = Math.max(Number(clock?.now_ms ?? Date.now()), Number(newest?.newest ?? 0) + 1);
  throwIfAborted(signal);
  await ch.insert(Table.Escrows, [sentinelRow(escrowed, version)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------------------------------

/** Where a job with a watermark of 0 starts: the ledger before the first committed one (0 without a ledger). */
async function startOfHistory(ch: ClickHouseService): Promise<number> {
  const first = await firstCommittedLedger(ch);
  return first === undefined ? 0 : Math.max(0, first - 1);
}

/**
 * One step of the job (spec 4.1): the window `(W, U]`, `U = max(W, min(head, W + step))`, `W` being the sentinel's
 * `through_ledger` and, while that is 0, the ledger before the first committed one (so a step on an empty database writes 0, and
 * the first step once there is a ledger starts at it); the escrows touched in it are recomputed as of `U`, those that cannot be
 * mapped set aside (`setAside`); the total is read again when the step wrote or removed something (or there was no sentinel),
 * else it is the previous sentinel's; and the sentinel (`through_ledger = U`) is written last, on every step, set-asides or not.
 * A step does not loop: the runner calls it again while `to` is below `head`.
 */
export async function runEscrowsStep(
  ch: ClickHouseService,
  opts: { native: string; step?: number; signal?: AbortSignal },
): Promise<EscrowsStep> {
  const { native, signal } = opts;
  const step = Math.max(1, Math.floor(opts.step ?? ESCROWS_STEP_LEDGERS));
  throwIfAborted(signal);
  const head = await committedHead(ch);
  const previous = await readEscrowed(ch);
  const watermark = previous?.through_ledger ?? 0;
  const from = watermark > 0 ? watermark : await startOfHistory(ch);
  const to = Math.max(from, Math.min(head, from + step));

  throwIfAborted(signal);
  const ids = await escrowsTouchedIn(ch, from, to);
  const { written, removed, setAside } = await recomputeEscrows(ch, ids, { upTo: to, native, signal });

  throwIfAborted(signal);
  const total =
    written + removed > 0 || previous === undefined
      ? await totalOf(ch, native)
      : { drops: previous.drops, open: previous.open };
  const escrowed: Escrowed = { ...total, through_ledger: to };
  await writeSentinel(ch, escrowed, signal);
  return { from, to, head, touched: ids.length, written, removed, setAside, escrowed };
}

/**
 * The total again, and the sentinel rewritten under a newer version with the same `through_ledger`: what the step of an
 * `agg_dirty` slice does after `recomputeEscrows`. `undefined` (and nothing written) without a sentinel: the job has not run, and
 * its first step reads the total.
 */
export async function refreshEscrowsTotal(
  ch: ClickHouseService,
  opts: { native: string; signal?: AbortSignal },
): Promise<Escrowed | undefined> {
  const { native, signal } = opts;
  throwIfAborted(signal);
  const previous = await readEscrowed(ch);
  if (previous === undefined) return undefined;
  throwIfAborted(signal);
  const escrowed: Escrowed = { ...(await totalOf(ch, native)), through_ledger: previous.through_ledger };
  await writeSentinel(ch, escrowed, signal);
  return escrowed;
}

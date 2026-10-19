import {
  assertNetwork,
  ClickHouseService,
  NetworkProfile,
  NodeClient,
  ShutdownSignals,
  Table,
  UInt64Value,
  ValidationsRow,
  ValidatorManifestsRow,
  ValidatorSeenRow,
  ValidatorValidationsRow,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { endpointHost, endpointList, NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** The buffer is written to `validations` every 20 s (the original kept a validation in memory for the same kind of while). */
export const VALIDATIONS_FLUSH_INTERVAL_MS = 20_000;

/**
 * How long a shutdown waits for its last flush (for a manifest lookup that is on its way, and for the insert). The
 * cleanups of `ShutdownSignals` share one budget of 10 s, and the ingest runner, which gives up the syncer lease, stops
 * after this one; a ClickHouse that does not answer must not use it up. What is not written by then is lost and the
 * warning says how many rows it were.
 */
export const VALIDATIONS_SHUTDOWN_WAIT_MS = 3_000;

/**
 * Of the shutdown's budget, how long the validations that wait for a `manifest` answer get. A node that hangs must not
 * starve the final flush of every other row in the buffer; what still waits after this is dropped and counted
 * (`reason="shutdown"`), not recorded under its signing key: that would list the validator a second time for the ledger.
 */
export const VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS = 1_000;

/**
 * The most rows a table's buffer holds, for each of `validations`, `validator_validations` and `validator_seen` (the
 * rows of a table that waits to be written again count together, however many batches they are). A mainnet node reports
 * about 10 validations a second, so a flush (every 20 s) writes a few hundred rows; 50 000 is a hundred times that, an
 * outage of ClickHouse of more than an hour at about 25 MB. Past it the oldest rows are dropped, counted
 * (`syncer_validations_dropped_total{reason="buffer_full"}`) and logged.
 */
export const MAX_BUFFERED_ROWS = 50_000;

/** How long a validator without a manifest is remembered as one, so that it does not cost an RPC per validation. */
export const MANIFEST_MISS_TTL_MS = 10 * 60_000;
/** How long the node is left alone after a `manifest` request failed (it timed out or the connection dropped). */
export const MANIFEST_FAILURE_TTL_MS = 30_000;
/** The timeout of a `manifest` request (no retries: the next validation of the key tries again after the failure TTL). */
export const MANIFEST_RPC_TIMEOUT_MS = 2_000;
/** How soon `server_info` is asked again after it failed. */
export const REPORTER_RETRY_MS = 5_000;

/** The most `manifest` requests in flight at once; past it a validation takes its signing key as it is (and asks again later). */
const MAX_CONCURRENT_LOOKUPS = 16;
/** The most keys the caches hold. There are a few hundred validators; this is for the keys that rotate and rotate. */
const MAX_CACHED_KEYS = 10_000;
/** The drops of a full buffer are logged at most this often. */
const DROP_LOG_INTERVAL_MS = 60_000;

const STREAMS = ['validations', 'manifests'];
const MAX_UINT32 = 4_294_967_295;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const LEDGER_HASH = /^[0-9A-Fa-f]{64}$/;

/** Optional `ValidationsCollectorOptions`; tests shorten the intervals, replace the clients and capture the log. */
export const VALIDATIONS_COLLECTOR_OPTIONS = Symbol('VALIDATIONS_COLLECTOR_OPTIONS');

export interface ValidationsCollectorOptions {
  /** Default: `VALIDATIONS_FLUSH_INTERVAL_MS`. */
  flushIntervalMs?: number;
  /** Default: `MAX_BUFFERED_ROWS`. */
  maxBufferedRows?: number;
  /** Default: `MANIFEST_MISS_TTL_MS`. */
  missTtlMs?: number;
  /** Default: `MANIFEST_FAILURE_TTL_MS`. */
  failureTtlMs?: number;
  /** One client for one endpoint. Default: a `NodeClient` of that single endpoint (so each reporter is a distinct node). */
  makeClient?: (endpoint: string) => NodeClient;
  /** Default: a Nest `Logger` with the context `ValidationsCollector`. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** The clock, in unix milliseconds. Default: `Date.now`. */
  now?: () => number;
}

/** A text that is there: a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A whole number from a number or a string of digits, if it fits `0..max`. */
function uint(value: unknown, max: number): number | undefined {
  const n = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Number.NaN) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max ? n : undefined;
}

/** A `UInt64` as exact digits, from a number or a string of digits: `null` for anything else (the column is Nullable). */
function uint64(value: unknown): UInt64Value | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= MAX_UINT64) return value;
  return null;
}

/** The domain a manifest names, `''` when it names none (or something that is no text). */
function domainOf(value: unknown): string {
  return text(value) ?? '';
}

const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The raw manifest of a `manifestReceived` message (hex in either case) as upper-case hex; `''` for anything else. */
function manifestFromHex(value: unknown): string {
  return typeof value === 'string' && HEX_BYTES.test(value) ? value.toUpperCase() : '';
}

/** The raw manifest of a `manifest` answer (base64) as upper-case hex; `''` for anything else. */
function manifestFromBase64(value: unknown): string {
  return typeof value === 'string' && BASE64.test(value)
    ? Buffer.from(value, 'base64').toString('hex').toUpperCase()
    : '';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A node's own answer (`RippledError`, matched by name: the class is not the same across package copies). */
function isRippledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RippledError';
}

/**
 * The `validations` row of one `validationReceived` message, seen at `at` (unix SECONDS, the milliseconds as a fraction:
 * a `DateTime64(3)` column reads a number as seconds). `master` is the key the validator is known by
 * (`validation_public_key`), `signing` the key the validation was signed with (`ephemeral_public_key`).
 *
 * Every number is made to fit its column (a field that is missing or odd is 0, or NULL for the fee fields), so that a
 * strange message can never make the batch it lands in fail for ever. The ledger hash is upper-cased: the API looks it up
 * in that form. `undefined` for a message whose ledger hash is not 64 hex digits. The message is not mutated.
 */
export function validationRowFrom(
  msg: Record<string, unknown>,
  reporter: string,
  at: number,
  master: string,
  signing: string,
): ValidationsRow | undefined {
  const hash = msg.ledger_hash;
  if (typeof hash !== 'string' || !LEDGER_HASH.test(hash)) return undefined;
  const amendments =
    Array.isArray(msg.amendments) && msg.amendments.length > 0 && msg.amendments.every((a) => typeof a === 'string')
      ? JSON.stringify(msg.amendments)
      : '';
  return {
    ledger_hash: hash.toUpperCase(),
    validation_public_key: master,
    count: 1,
    first_datetime: at,
    last_datetime: at,
    ledger_index: uint(msg.ledger_index, MAX_UINT32) ?? 0,
    reporter_public_key: reporter,
    ephemeral_public_key: signing,
    signature: text(msg.signature) ?? '',
    signing_time: uint(msg.signing_time, MAX_UINT32) ?? 0,
    flags: uint(msg.flags, MAX_UINT32) ?? 0,
    full: msg.full === true || msg.full === 'true' || msg.full === 1 ? 1 : 0,
    amendments,
    base_fee: uint64(msg.base_fee),
    load_fee: uint64(msg.load_fee),
    reserve_base: uint64(msg.reserve_base),
    reserve_inc: uint64(msg.reserve_inc),
    server_version: uint64(msg.server_version),
  };
}

/** `older` plus `newer` sightings of one validation: the counts add up, the first time is the min and the last the max. */
function mergeRows(older: ValidationsRow, newer: ValidationsRow): ValidationsRow {
  older.count = Number(older.count) + Number(newer.count);
  older.first_datetime = Math.min(older.first_datetime, newer.first_datetime);
  older.last_datetime = Math.max(older.last_datetime, newer.last_datetime);
  return older;
}

const keyOf = (row: ValidationsRow): string => `${row.ledger_hash}|${row.validation_public_key}`;

/**
 * The `validator_validations` row of one sighting: the same validation, narrow and keyed by the validator (no reporter,
 * signature, flags, amendments or fee fields). It shares nothing with `row`.
 */
export function byValidatorRowFrom(row: ValidationsRow): ValidatorValidationsRow {
  return {
    validation_public_key: row.validation_public_key,
    ledger_index: row.ledger_index,
    ledger_hash: row.ledger_hash,
    count: row.count,
    first_datetime: row.first_datetime,
    last_datetime: row.last_datetime,
    ephemeral_public_key: row.ephemeral_public_key,
    signing_time: row.signing_time,
    full: row.full,
    server_version: row.server_version,
  };
}

/** The `validator_seen` row of one sighting: when the validator was seen, and in which ledger. */
export function seenRowFrom(row: ValidationsRow): ValidatorSeenRow {
  return {
    validation_public_key: row.validation_public_key,
    first_seen: row.first_datetime,
    last_seen: row.last_datetime,
    last_ledger_index: row.ledger_index,
  };
}

/**
 * `older` plus `newer` sightings of one validation of one validator, as the table merges them: the counts add up, the
 * first time is the min, the last the max, `full` the max (a full validation wins over a partial one); every other
 * field is the first sighting's.
 */
export function mergeByValidatorRows(
  older: ValidatorValidationsRow,
  newer: ValidatorValidationsRow,
): ValidatorValidationsRow {
  older.count = Number(older.count) + Number(newer.count);
  older.first_datetime = Math.min(older.first_datetime, newer.first_datetime);
  older.last_datetime = Math.max(older.last_datetime, newer.last_datetime);
  older.full = Math.max(older.full, newer.full);
  return older;
}

/** `older` plus `newer` sightings of one validator: `first_seen` the min, `last_seen` and `last_ledger_index` the max. */
export function mergeSeenRows(older: ValidatorSeenRow, newer: ValidatorSeenRow): ValidatorSeenRow {
  older.first_seen = Math.min(older.first_seen, newer.first_seen);
  older.last_seen = Math.max(older.last_seen, newer.last_seen);
  older.last_ledger_index = Math.max(older.last_ledger_index, newer.last_ledger_index);
  return older;
}

const byValidatorKeyOf = (row: ValidatorValidationsRow): string =>
  `${row.validation_public_key}|${row.ledger_index}|${row.ledger_hash}`;

/** The rows cut at one flush: sent as they are, with their own insert token, until a send is acknowledged. */
interface Batch<R> {
  /** The `insert_deduplication_token`: the same on every attempt, so a replay of an attempt that landed is dropped. */
  readonly token: string;
  readonly rows: Map<string, R>;
}

/**
 * What one of the per-validator tables (`validator_validations`, `validator_seen`) holds between flushes. New rows
 * collect in `collecting`, merged by key. A flush cuts them into a batch, and a batch stays in `batches` until its insert
 * has been acknowledged: it is never changed after the cut (what is seen meanwhile collects for the next batch), so
 * its retry is the insert that failed, and the dedup window of the table can drop it if the first attempt landed after
 * all. The rows of `collecting` and of all batches together are bounded.
 */
class Spool<R> {
  /** The batches already cut and not yet written, oldest first. */
  readonly batches: Batch<R>[] = [];
  /** The rows not cut yet, oldest first. */
  collecting = new Map<string, R>();
  /** The rows dropped for the bound since a flush said so. */
  dropped = 0;

  constructor(
    readonly table: Table.ValidatorValidations | Table.ValidatorSeen,
    /** The `syncer_validations_errors_total` stage of a failed insert. */
    readonly stage: 'flush_by_validator' | 'flush_seen',
    private readonly merge: (older: R, newer: R) => R,
  ) {}

  /** All rows that wait to be written: those of every batch, and the ones still collecting. */
  get size(): number {
    let n = this.collecting.size;
    for (const batch of this.batches) n += batch.rows.size;
    return n;
  }

  /** Merges `row` into the collecting row of its key, else adds it; returns how many old rows the bound pushed out. */
  add(key: string, row: R, max: number): number {
    const existing = this.collecting.get(key);
    if (existing !== undefined) {
      this.merge(existing, row);
      return 0;
    }
    this.collecting.set(key, row);
    return this.trim(max);
  }

  /** Cuts the rows collected so far into a batch with `token`. */
  cut(token: string): void {
    if (this.collecting.size === 0) return;
    this.batches.push({ token, rows: this.collecting });
    this.collecting = new Map();
  }

  remove(batch: Batch<R>): void {
    const at = this.batches.indexOf(batch);
    if (at >= 0) this.batches.splice(at, 1);
  }

  /** Drops the oldest rows (the oldest batch's first) until `max` are left; returns how many. */
  private trim(max: number): number {
    const excess = this.size - max;
    if (excess <= 0) return 0;
    let left = excess;
    while (left > 0) {
      const oldest = this.batches[0];
      const rows = oldest?.rows ?? this.collecting;
      for (const key of rows.keys()) {
        rows.delete(key);
        left -= 1;
        if (left === 0) break;
      }
      if (oldest !== undefined && oldest.rows.size === 0) this.batches.shift();
      else if (oldest === undefined && rows.size === 0) break; // nothing left to drop
    }
    return excess;
  }
}

/** One node the collector listens to. */
interface Feed {
  endpoint: string;
  /** `scheme://host:port` only: endpoints may carry credentials, so logs show only this. */
  host: string;
  client: NodeClient;
  /** The `pubkey_node` of the node behind the current connection; undefined until `server_info` has answered. */
  reporter?: string;
  /** Bumped by every (re)connect: the answer of an older `server_info` is not valid for the connection that replaced it. */
  attempt: number;
  retry?: NodeJS.Timeout;
  /** Another network than GH_NETWORK: stopped, and none of its messages is kept. */
  rejected: boolean;
  onValidation: (msg: unknown) => void;
  onManifest: (msg: unknown) => void;
  onConnected: () => void;
}

/** A `manifest` answer: `details` of the manifest the node knows, and the manifest itself in base64. */
interface ManifestAnswer {
  details?: { master_key?: unknown; ephemeral_key?: unknown; seq?: unknown; domain?: unknown };
  manifest?: unknown;
}

/**
 * The `validations` worker: listens to the `validations` and `manifests` streams of every node of
 * `GH_VALIDATION_ENDPOINTS`, merges what it sees in memory and writes it to `validations`, `validator_validations` and
 * `validator_seen` every 20 s (what `rippled-historical-database` did with `lib/validations`, with ClickHouse in place
 * of HBase).
 *
 * - **One client per endpoint**, each a client of that single node, so every reporter is a distinct node. A node that is
 *   down does not hold up the boot or the other nodes: each client connects (and reconnects, with the backoff of
 *   `NodeClient`) on its own. `subscribe` is recorded before the client starts, so the node client sends it with every
 *   connection. A node of another network than `GH_NETWORK` is refused. The streams are not unsubscribed on shutdown;
 *   stopping the client closes the socket, which ends them.
 * - **`reporter_public_key`** is the `pubkey_node` of the node the message came from, asked of `server_info` on every
 *   (re)connect (an endpoint can be a cluster that answers from another server each time). A message that arrives while
 *   it is not known is NOT buffered: it is dropped and counted (`reason="no_reporter"`), which is a few messages around
 *   a reconnect. A node that reports no `pubkey_node` at all gets an empty reporter, with a warning.
 * - **The master key** (`validation_public_key`) is the `master_key` of the message, else the manifest map (loaded from
 *   `validator_manifests` at start and kept up to date by `manifestReceived`), else the answer of the `manifest` RPC
 *   (asked once per key at a time; the validation waits for it, which is 4 s at most: the node client applies the
 *   2 s timeout to the connection and again to the answer), else the signing key. A key
 *   that has no manifest is remembered for 10 minutes, one whose request failed for 30 s, so a validator without a
 *   manifest does not cost an RPC per validation. `ephemeral_public_key` is always the signing key. Manifests are taken
 *   from the node as they come (rippled has checked their signatures before it publishes them); they are written to
 *   `validator_manifests` with the next flush (ReplacingMergeTree: the highest `seq` wins), with the domain they name,
 *   the raw manifest (upper-case hex; the stream gives hex, the `manifest` RPC base64) and where they came from
 *   (`stream`, `rpc`).
 * - **Merging**: one row per (`ledger_hash`, `validation_public_key`): `count` goes up, the first and the last time of
 *   RECEIPT are kept as unix seconds with a fraction, the other fields are those of the first sighting. The rows are
 *   partial sightings; the table adds them up on merge and the API on read. The same sightings are merged into two more
 *   buffers: `validator_validations` (one row per master key, ledger index and ledger hash: narrow, `full` the max) and
 *   `validator_seen` (one row per master key: first and last time, newest ledger). `server_version` is the validator's
 *   software version, in the validation of a voting ledger.
 * - **At-least-once.** A failed `validations` flush puts its rows back into the buffer, merged with whatever came in
 *   meanwhile, and the next flush writes them. An insert that times out after ClickHouse has taken the rows is written a
 *   second time (the count of that validation is then too high by the rows of that flush): rare, and accepted. The
 *   buffer is bounded (`MAX_BUFFERED_ROWS`); past it the oldest rows are dropped, counted and logged.
 * - **No duplicates on a retried batch, for the per-validator tables.** A flush writes `validator_manifests`, `validations`,
 *   `validator_validations`, `validator_seen`, in that order; a table that fails neither stops the ones after it nor makes
 *   the ones before it be written again (`flush()` rejects only for `validations`). The rows of `validator_validations`
 *   and `validator_seen` leave in batches, one per flush, each with the `insert_deduplication_token`
 *   `vc:<bootId>:<table>:<flushSeq>`. A batch that failed stays as it was and is sent again, oldest first, before the
 *   new one, with its own token: both tables keep a window of 100 tokens (`non_replicated_deduplication_window`), so a
 *   retry of an insert that landed after all (a timeout) is dropped by the server and counts nothing twice. A table whose
 *   oldest batch fails again is left alone for that flush (a ClickHouse that is down is asked once, not once per batch).
 *   What is seen meanwhile collects in a new batch, and the rows of all of a table's batches together are bounded by
 *   `MAX_BUFFERED_ROWS`: past it the oldest rows are dropped, counted (`reason="buffer_full"`), and one line per flush
 *   says how many of which table.
 * - **Messages in the replay window of a reconnect** (between the connection dropping and the subscription being sent
 *   again) are lost; so are the ones a node never sent. That is the node client's contract.
 * - **Stops** on module destroy and on SIGTERM / SIGINT (`ShutdownSignals`): the timers stop, the messages are no longer
 *   listened to, the validations that wait for a manifest answer get `VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS` (what still
 *   waits after that is dropped and counted, `reason="shutdown"`), the buffer is flushed once more, and the clients are
 *   stopped, all within `VALIDATIONS_SHUTDOWN_WAIT_MS`. A flush not done by then is abandoned, and from that moment no
 *   insert is started by anything (a flush chained behind one that hangs, a lookup that settles late).
 * - **Never crashes.** Every failure (flush, `server_info`, manifest RPC or load, a message that breaks the handler) is
 *   logged and counted in `syncer_validations_errors_total{stage}`; none escapes into the stream.
 */
@Injectable()
export class ValidationsCollector implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly flushIntervalMs: number;
  private readonly maxBufferedRows: number;
  private readonly missTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly makeClient: (endpoint: string) => NodeClient;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly nowMs: () => number;

  private readonly feeds: Feed[] = [];
  private timer?: NodeJS.Timeout;
  private closing = false;
  private stopped?: Promise<void>;

  /** Insertion order is age: the first entry is the oldest. */
  private buffer = new Map<string, ValidationsRow>();
  private readonly pendingManifests = new Map<string, ValidatorManifestsRow>();
  /** `validator_validations`: keyed by `master|ledger_index|ledger_hash`. */
  private readonly byValidator = new Spool<ValidatorValidationsRow>(
    Table.ValidatorValidations,
    'flush_by_validator',
    mergeByValidatorRows,
  );
  /** `validator_seen`: keyed by master key. */
  private readonly seen = new Spool<ValidatorSeenRow>(Table.ValidatorSeen, 'flush_seen', mergeSeenRows);
  /** Part of every insert token: tells this process from the one before it, whose batches may be in the dedup window. */
  private readonly bootId = randomUUID();
  /** Counts the flushes of this process, for the insert tokens. */
  private flushSeq = 0;

  /** ephemeral (signing) key -> master key. */
  private readonly masters = new Map<string, string>();
  /** ephemeral key -> the highest `seq` seen for it. */
  private readonly manifestSeqs = new Map<string, number>();
  /** signing key -> when (ms) the answer "no manifest" stops being valid. */
  private readonly misses = new Map<string, number>();
  private readonly lookups = new Map<string, Promise<string | undefined>>();
  /** Validations waiting for a master key, as the promises that record them. */
  private readonly waiting = new Set<Promise<void>>();

  /** Set when the final flush is given up on: from then on no insert is started, whoever asks for it. */
  private abandoned = false;
  /** Set when the shutdown stops waiting for the manifest lookups: what they answer later is not recorded. */
  private lookupsCutOff = false;

  private lastFlush?: Promise<void>;
  private flushesInFlight = 0;
  /** The rows of the flush under way, which a shutdown that gives up on it reports as at stake. */
  private rowsInFlight = 0;

  private droppedSinceLog = 0;
  private droppedTotal = 0;
  private lastDropLog = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(SyncerConfig) private readonly cfg: SyncerConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
    private readonly ch: ClickHouseService,
    @Optional() private readonly metrics?: PrometheusService,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(VALIDATIONS_COLLECTOR_OPTIONS) options: ValidationsCollectorOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? VALIDATIONS_FLUSH_INTERVAL_MS;
    this.maxBufferedRows = options.maxBufferedRows ?? MAX_BUFFERED_ROWS;
    this.missTtlMs = options.missTtlMs ?? MANIFEST_MISS_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? MANIFEST_FAILURE_TTL_MS;
    this.makeClient = options.makeClient ?? ((endpoint) => new NodeClient({ endpoints: [endpoint] }));
    this.logger = options.logger ?? new Logger(ValidationsCollector.name);
    this.nowMs = options.now ?? Date.now;
  }

  /** The rows waiting for the next flush. */
  get bufferedRows(): number {
    return this.buffer.size;
  }

  /** The reporter of each feed, in the order of the endpoints: `undefined` while it is not known, and for a refused node. */
  get reporters(): (string | undefined)[] {
    return this.feeds.map((feed) => feed.reporter);
  }

  /** Starts the flush timer and the feeds. The feeds are not awaited: a node that is down does not hold up the boot. */
  onApplicationBootstrap(): void {
    if (this.closing || this.timer) return;
    this.shutdownSignals?.register('validations-collector', () => this.stop());
    this.timer = setInterval(() => this.tick(), this.flushIntervalMs);
    void this.startFeeds();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Stops listening, waits for the manifest lookups that are on their way, flushes once more and stops the clients, in
   * `VALIDATIONS_SHUTDOWN_WAIT_MS` altogether: a flush that has not finished by then is abandoned (and said so, with the
   * number of rows at stake), and a client that does not stop is left. Idempotent; a stopped collector does not start again.
   */
  stop(): Promise<void> {
    this.closing = true;
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  /**
   * Counts one validation message seen at `now` by the node `reporter`. Exported for tests; the feeds call it for every
   * `validationReceived`. A message without a `validation_public_key` or with a ledger hash that is not 64 hex digits is
   * dropped and counted. When the master key is not known the validation waits for the answer of the node.
   */
  handleValidation(msg: Record<string, unknown>, reporter: string, now: Date = new Date(this.nowMs())): void {
    if (typeof msg !== 'object' || msg === null) return this.drop('invalid');
    const signing = text(msg.validation_public_key);
    if (signing === undefined || typeof msg.ledger_hash !== 'string' || !LEDGER_HASH.test(msg.ledger_hash)) {
      return this.drop('invalid');
    }
    const at = now.getTime() / 1000;

    const announced = text(msg.master_key);
    if (announced !== undefined) {
      this.learn(signing, announced);
      return this.record(msg, reporter, at, announced, signing);
    }
    const known = this.masters.get(signing);
    if (known !== undefined) return this.record(msg, reporter, at, known, signing);
    const missUntil = this.misses.get(signing);
    if (missUntil !== undefined) {
      if (missUntil > now.getTime()) return this.record(msg, reporter, at, signing, signing);
      this.misses.delete(signing);
    }

    // not known: ask the node, and record the validation under what it answers
    const recorded: Promise<void> = this.lookupMaster(signing, reporter)
      .then((master) => {
        if (this.lookupsCutOff) return; // the shutdown gave up on this one (and counted it)
        // a manifest of the stream may have come in while the node was being asked
        this.record(msg, reporter, at, master ?? this.masters.get(signing) ?? signing, signing);
      })
      .catch((err: unknown) => this.failed('handle', 'Recording a validation failed', err))
      .then(() => {
        this.waiting.delete(recorded);
      });
    this.waiting.add(recorded);
  }

  /**
   * Takes a `manifestReceived` message: the signing key now belongs to the master key, and the row (with the domain and
   * the raw manifest the message carries) goes to `validator_manifests` with the next flush. A manifest whose `seq` is
   * not higher than the one known for its signing key is ignored; so is one without a signing key (a revocation), a
   * master key or a `seq`.
   */
  handleManifest(msg: Record<string, unknown>): void {
    if (typeof msg !== 'object' || msg === null) return;
    const master = text(msg.master_key);
    const ephemeral = text(msg.signing_key);
    const seq = uint(msg.seq, MAX_UINT32);
    if (master === undefined || ephemeral === undefined || seq === undefined) return;
    const known = this.manifestSeqs.get(ephemeral);
    if (known !== undefined && seq <= known) return;
    this.rememberSeq(ephemeral, seq);
    this.learn(ephemeral, master);
    this.misses.delete(ephemeral);
    this.queueManifest({
      ephemeral_key: ephemeral,
      master_key: master,
      seq,
      domain: domainOf(msg.domain),
      manifest: manifestFromHex(msg.manifest),
      source: 'stream',
    });
  }

  /**
   * Writes the manifests that are waiting, then the buffer, then the batches of `validator_validations` and of
   * `validator_seen`, and returns the number of validation rows written. A failed manifest insert is counted and retried
   * with the next flush, and does not fail the flush; neither does a failed insert of a per-validator table (counted
   * as `flush_by_validator` / `flush_seen`, its batches stay and are sent again). A failed validations insert puts the
   * rows back (see the class comment), is counted and logged, and rejects, after the other tables were tried. Flushes
   * run one after the other.
   */
  flush(): Promise<number> {
    const previous = this.lastFlush;
    const result = previous === undefined ? this.doFlush() : previous.then(() => this.doFlush());
    this.flushesInFlight += 1;
    const done: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.flushesInFlight -= 1;
        if (this.lastFlush === done) this.lastFlush = undefined;
      });
    this.lastFlush = done;
    return result;
  }

  /** Resolves when every validation that waits for a master key has been recorded. */
  async whenIdle(): Promise<void> {
    while (this.waiting.size > 0) await Promise.allSettled([...this.waiting]);
  }

  // -- feeds -------------------------------------------------------------------------------------------------------

  private async startFeeds(): Promise<void> {
    await this.loadManifests();
    if (this.closing) return;
    for (const endpoint of new Set(endpointList(this.cfg.validationEndpoints))) {
      if (this.closing) return;
      try {
        this.startFeed(endpoint);
      } catch (err) {
        // one endpoint that cannot even be set up does not keep the others from being collected
        this.failed('connect', `Cannot listen to ${endpointHost(endpoint)}`, err);
      }
    }
  }

  private startFeed(endpoint: string): void {
    const client = this.makeClient(endpoint);
    const feed: Feed = {
      endpoint,
      host: endpointHost(endpoint),
      client,
      attempt: 0,
      rejected: false,
      onValidation: (msg) => this.onStreamValidation(feed, msg),
      onManifest: (msg) => this.onStreamManifest(feed, msg),
      onConnected: () => this.onConnected(feed),
    };
    this.feeds.push(feed);
    client.on('validationReceived', feed.onValidation);
    client.on('manifestReceived', feed.onManifest);
    client.on('connected', feed.onConnected);
    // `subscribe` before `start` only records the streams: the client sends them with every connection it makes
    client
      .subscribe(STREAMS)
      .then(() => client.start())
      .catch((err: unknown) => {
        // `start` only gives up when the client was stopped
        if (!this.closing && !feed.rejected) this.failed('connect', `Cannot listen to ${feed.host}`, err);
      });
  }

  private onStreamValidation(feed: Feed, msg: unknown): void {
    if (this.closing || feed.rejected) return;
    if (feed.reporter === undefined) return this.drop('no_reporter');
    try {
      this.handleValidation(msg as Record<string, unknown>, feed.reporter);
    } catch (err) {
      this.failed('handle', `Handling a validation from ${feed.host} failed`, err);
    }
  }

  /** Gated like the validations: a node of another network, or one whose reporter is not known yet, is not believed. */
  private onStreamManifest(feed: Feed, msg: unknown): void {
    if (this.closing || feed.rejected) return;
    if (feed.reporter === undefined) return this.drop('manifest_no_reporter');
    try {
      this.handleManifest(msg as Record<string, unknown>);
    } catch (err) {
      this.failed('handle', 'Handling a manifest failed', err);
    }
  }

  /** A new connection: the node behind it may be another server, so who the reporter is has to be asked again. */
  private onConnected(feed: Feed): void {
    if (this.closing || feed.rejected) return;
    feed.attempt += 1;
    feed.reporter = undefined;
    void this.fetchReporter(feed, feed.attempt);
  }

  private async fetchReporter(feed: Feed, attempt: number): Promise<void> {
    clearTimeout(feed.retry);
    feed.retry = undefined;
    try {
      const info = await feed.client.serverInfo();
      if (this.closing || attempt !== feed.attempt) return;
      try {
        assertNetwork(info, this.profile);
      } catch (err) {
        this.reject(feed, err);
        return;
      }
      const pubkey = text(info.pubkey_node);
      if (pubkey === undefined) {
        this.logger.warn(`${feed.host} reports no pubkey_node: its validations get an empty reporter_public_key`);
      } else {
        this.logger.log(`Collecting validations from ${feed.host} (reporter ${pubkey})`);
      }
      feed.reporter = pubkey ?? '';
    } catch (err) {
      if (this.closing || attempt !== feed.attempt) return;
      this.failed('reporter', `server_info of ${feed.host} failed; trying again in ${REPORTER_RETRY_MS} ms`, err);
      feed.retry = setTimeout(() => void this.fetchReporter(feed, attempt), REPORTER_RETRY_MS);
    }
  }

  /** A node of another network than `GH_NETWORK` would fill the table with the wrong validations: leave it. */
  private reject(feed: Feed, err: unknown): void {
    feed.rejected = true;
    feed.reporter = undefined;
    this.failed('network', `Refusing ${feed.host}`, err);
    void feed.client.stop().catch(() => undefined);
  }

  private clientFor(reporter: string): NodeClient | undefined {
    const live = this.feeds.filter((feed) => !feed.rejected);
    return (live.find((feed) => feed.reporter === reporter) ?? live[0])?.client;
  }

  // -- master keys -------------------------------------------------------------------------------------------------

  private async loadManifests(): Promise<void> {
    try {
      // the aliases are not the names of columns: the analyzer would read `seq` inside argMax as the alias
      const rows = await this.ch.query<{ ephemeral_key: string; master: string; highest: number | string }>(
        `SELECT ephemeral_key, argMax(master_key, seq) AS master, max(seq) AS highest
           FROM ${Table.ValidatorManifests}
          GROUP BY ephemeral_key`,
      );
      for (const row of rows) {
        this.learn(row.ephemeral_key, row.master);
        this.rememberSeq(row.ephemeral_key, Number(row.highest));
      }
      this.logger.log(`Loaded ${rows.length} validator manifests`);
    } catch (err) {
      this.failed(
        'manifests_load',
        'Could not read validator_manifests; master keys come from the stream and from the nodes',
        err,
      );
    }
  }

  /** Remembers `ephemeral -> master`, keeping the map bounded (the oldest entry goes first). */
  private learn(ephemeral: string, master: string): void {
    this.masters.delete(ephemeral);
    this.masters.set(ephemeral, master);
    if (this.masters.size > MAX_CACHED_KEYS) this.masters.delete(this.masters.keys().next().value as string);
    this.misses.delete(ephemeral);
  }

  private rememberSeq(ephemeral: string, seq: number): void {
    this.manifestSeqs.delete(ephemeral);
    this.manifestSeqs.set(ephemeral, seq);
    if (this.manifestSeqs.size > MAX_CACHED_KEYS) {
      this.manifestSeqs.delete(this.manifestSeqs.keys().next().value as string);
    }
  }

  private remember(key: string, ttlMs: number): void {
    this.misses.delete(key);
    this.misses.set(key, this.nowMs() + ttlMs);
    if (this.misses.size > MAX_CACHED_KEYS) this.misses.delete(this.misses.keys().next().value as string);
  }

  /** Keeps the manifest for the next flush, if its `seq` is higher than that of the one waiting for the same signing key. */
  private queueManifest(row: ValidatorManifestsRow): void {
    const pending = this.pendingManifests.get(row.ephemeral_key);
    if (pending !== undefined && pending.seq >= row.seq) return;
    this.pendingManifests.set(row.ephemeral_key, row);
  }

  /**
   * The master key of a signing key from the `manifest` RPC of the node that reported the validation, or `undefined`
   * (which the caller reads as: the signing key is the identity). One request per key at a time; every caller of that
   * key gets the same answer. It never rejects.
   */
  private lookupMaster(signing: string, reporter: string): Promise<string | undefined> {
    const running = this.lookups.get(signing);
    if (running !== undefined) return running;
    if (this.lookups.size >= MAX_CONCURRENT_LOOKUPS) return Promise.resolve(undefined);

    const run = (async (): Promise<string | undefined> => {
      const client = this.clientFor(reporter);
      if (client === undefined) return undefined;
      try {
        const answer = await client.request<ManifestAnswer>(
          { command: 'manifest', public_key: signing },
          { timeoutMs: MANIFEST_RPC_TIMEOUT_MS, retries: 0 },
        );
        const master = text(answer?.details?.master_key);
        if (master === undefined || master === signing) {
          this.remember(signing, this.missTtlMs);
          return undefined;
        }
        this.learn(signing, master);
        const seq = uint(answer?.details?.seq, MAX_UINT32);
        if (answer?.details?.ephemeral_key === signing && seq !== undefined) {
          this.rememberSeq(signing, Math.max(seq, this.manifestSeqs.get(signing) ?? 0));
          this.queueManifest({
            ephemeral_key: signing,
            master_key: master,
            seq,
            domain: domainOf(answer.details.domain),
            manifest: manifestFromBase64(answer.manifest),
            source: 'rpc',
          });
        }
        return master;
      } catch (err) {
        // the app is going down and the clients with it: neither a fault of the node nor of the key
        if (this.closing) return undefined;
        if (isRippledError(err)) {
          // the node's own answer (it does not know the key): the same as no manifest
          this.remember(signing, this.missTtlMs);
        } else {
          this.remember(signing, this.failureTtlMs);
          this.failed('manifest_rpc', `manifest request for ${signing} failed`, err);
        }
        return undefined;
      }
    })();
    this.lookups.set(signing, run);
    const forget = () => {
      if (this.lookups.get(signing) === run) this.lookups.delete(signing);
    };
    run.then(forget, forget);
    return run;
  }

  // -- the buffer --------------------------------------------------------------------------------------------------

  private record(msg: Record<string, unknown>, reporter: string, at: number, master: string, signing: string): void {
    const row = validationRowFrom(msg, reporter, at, master, signing);
    if (row === undefined) return this.drop('invalid');
    // the per-validator rows are copies: the buffer goes on merging later sightings into `row`
    const byValidator = byValidatorRowFrom(row);
    const seen = seenRowFrom(row);
    const key = keyOf(row);
    const existing = this.buffer.get(key);
    if (existing !== undefined) {
      mergeRows(existing, row);
    } else {
      this.buffer.set(key, row);
      this.enforceCap();
    }
    this.spool(this.byValidator, byValidatorKeyOf(byValidator), byValidator);
    this.spool(this.seen, seen.validation_public_key, seen);
  }

  /** Adds a sighting to a per-validator table; rows the bound pushes out are counted now and logged at the next flush. */
  private spool<R>(spool: Spool<R>, key: string, row: R): void {
    const dropped = spool.add(key, row, this.maxBufferedRows);
    if (dropped === 0) return;
    spool.dropped += dropped;
    this.metrics?.validationsDroppedTotal.inc({ reason: 'buffer_full' }, dropped);
  }

  /** Puts the rows of a failed flush back in front of what has come in since, merged by key, oldest first. */
  private putBack(rows: ValidationsRow[]): void {
    const merged = new Map<string, ValidationsRow>();
    for (const row of rows) merged.set(keyOf(row), row);
    for (const [key, row] of this.buffer) {
      const older = merged.get(key);
      if (older !== undefined) mergeRows(older, row);
      else merged.set(key, row);
    }
    this.buffer = merged;
    this.enforceCap();
  }

  /** Drops the oldest rows past the cap: counted at once, logged on the first drop and then once a minute. */
  private enforceCap(): void {
    let dropped = 0;
    while (this.buffer.size > this.maxBufferedRows) {
      this.buffer.delete(this.buffer.keys().next().value as string);
      this.metrics?.validationsDroppedTotal.inc({ reason: 'buffer_full' });
      dropped += 1;
    }
    if (dropped === 0) return;
    this.droppedSinceLog += dropped;
    this.droppedTotal += dropped;
    const now = this.nowMs();
    if (now - this.lastDropLog >= DROP_LOG_INTERVAL_MS) {
      this.logger.warn(
        `The validations buffer is full (cap ${this.maxBufferedRows} rows): dropped ${this.droppedSinceLog} of the ` +
          `oldest rows (${this.droppedTotal} since the start); is ClickHouse down?`,
      );
      this.lastDropLog = now;
      this.droppedSinceLog = 0;
    }
  }

  private tick(): void {
    if (this.closing) return;
    if (this.flushesInFlight > 0) {
      this.logger.warn('Skipping a validations flush: the previous flush is still running');
      return;
    }
    // doFlush has logged and counted a failure; the rows are back in the buffer
    this.flush().catch(() => undefined);
  }

  private async doFlush(): Promise<number> {
    // a flush that was chained behind one that hangs, or that was waiting for the manifests, starts after the shutdown
    // has given up on the final flush: it must not write anything then
    if (this.abandoned) return 0;
    this.flushSeq += 1;
    const seq = this.flushSeq;
    await this.flushManifests();
    if (this.abandoned) return 0;

    let written = 0;
    let failure: { error: unknown } | undefined;
    const rows = [...this.buffer.values()];
    if (rows.length > 0) {
      this.buffer = new Map();
      this.rowsInFlight = rows.length;
      try {
        await this.ch.insert(Table.Validations, rows);
        written = rows.length;
      } catch (err) {
        this.putBack(rows);
        this.failed('flush', `Writing ${rows.length} validation rows failed; they stay in the buffer`, err);
        failure = { error: err };
      } finally {
        this.rowsInFlight = 0;
      }
      if (written > 0) this.metrics?.validationsFlushedTotal.inc(written);
    }

    // each table has its own batches: one that fails neither stops the next nor makes the written ones be written again
    if (!this.abandoned) await this.flushSpool(this.byValidator, seq);
    if (!this.abandoned) await this.flushSpool(this.seen, seq);
    if (failure !== undefined) throw failure.error;
    return written;
  }

  /**
   * Cuts the rows collected for a per-validator table into the batch `vc:<bootId>:<table>:<seq>`, then writes the
   * batches that wait, oldest first, each with its own token. A batch that fails stays as it is (and so do the ones
   * behind it, for the next flush); it is counted and logged, and does not throw.
   */
  private async flushSpool<R>(spool: Spool<R>, seq: number): Promise<void> {
    if (spool.dropped > 0) {
      this.logger.warn(
        `The ${spool.table} buffer is full (cap ${this.maxBufferedRows} rows): dropped ${spool.dropped} of the ` +
          `oldest rows since the last flush; is ClickHouse down?`,
      );
      spool.dropped = 0;
    }
    spool.cut(`vc:${this.bootId}:${spool.table}:${seq}`);
    for (const batch of [...spool.batches]) {
      if (this.abandoned) return;
      if (batch.rows.size === 0) {
        spool.remove(batch); // all of it was pushed out by the bound
        continue;
      }
      const rows = [...batch.rows.values()];
      try {
        await this.ch.insert(spool.table, rows, { dedupToken: batch.token });
      } catch (err) {
        this.failed(
          spool.stage,
          `Writing ${rows.length} ${spool.table} rows failed; they stay pending (token ${batch.token})`,
          err,
        );
        return;
      }
      spool.remove(batch);
      this.metrics?.validatorValidationsFlushedTotal.inc({ table: spool.table }, rows.length);
    }
  }

  private async flushManifests(): Promise<void> {
    if (this.pendingManifests.size === 0) return;
    const rows = [...this.pendingManifests.values()];
    this.pendingManifests.clear();
    try {
      await this.ch.insert(Table.ValidatorManifests, rows);
    } catch (err) {
      for (const row of rows) this.queueManifest(row);
      this.failed(
        'manifests_flush',
        `Writing ${rows.length} validator manifests failed; they will be tried again`,
        err,
      );
    }
  }

  // -- shutdown ----------------------------------------------------------------------------------------------------

  private async shutDown(): Promise<void> {
    const started = Date.now();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const feed of this.feeds) {
      clearTimeout(feed.retry);
      feed.retry = undefined;
      feed.client.off('validationReceived', feed.onValidation);
      feed.client.off('manifestReceived', feed.onManifest);
      feed.client.off('connected', feed.onConnected);
    }

    // The validations that wait for a manifest answer get a part of the budget, so that a node that hangs cannot keep
    // the rows that are already in the buffer from being written.
    if (await this.within(this.whenIdle(), VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS)) {
      this.lookupsCutOff = true;
      const left = this.waiting.size;
      this.metrics?.validationsDroppedTotal.inc({ reason: 'shutdown' }, left);
      this.logger.warn(
        `Giving up on ${left} validations still waiting for a manifest answer ` +
          `after ${VALIDATIONS_LOOKUP_SHUTDOWN_WAIT_MS} ms of the shutdown: they are dropped`,
      );
    }

    const final = this.flush().catch(() => undefined); // counted and logged by doFlush
    const remaining = Math.max(0, VALIDATIONS_SHUTDOWN_WAIT_MS - (Date.now() - started));
    // `abandoned` is set by the timer itself: nothing can start an insert between the cap and the warning
    if (
      await this.within(final, remaining, () => {
        this.abandoned = true;
      })
    ) {
      this.logger.warn(
        `Abandoning the final flush: no answer within ${VALIDATIONS_SHUTDOWN_WAIT_MS} ms of the shutdown; ` +
          `${this.rowsInFlight + this.buffer.size} rows may not have been written`,
      );
    }

    // the sockets close as soon as `stop` is called; what is left of the budget is for them to say so
    const stops = Promise.all(this.feeds.map((feed) => feed.client.stop().catch(() => undefined)));
    await this.within(stops, Math.max(0, VALIDATIONS_SHUTDOWN_WAIT_MS - (Date.now() - started)));
  }

  /** Whether `work` did NOT finish within `ms` (it is left running; `onTimeout` runs the moment it is given up on). Leaves no timer behind. */
  private async within(work: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        onTimeout?.();
        resolve(true);
      }, ms);
    });
    try {
      return await Promise.race([work.then(() => false), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // -- bookkeeping -------------------------------------------------------------------------------------------------

  private drop(reason: 'invalid' | 'no_reporter' | 'manifest_no_reporter'): void {
    this.metrics?.validationsDroppedTotal.inc({ reason });
  }

  /** Logs and counts a fault of the collector: nothing is swallowed, nothing escapes. */
  private failed(stage: string, what: string, err: unknown): void {
    this.metrics?.validationsErrorsTotal.inc({ stage });
    this.logger.error(`${what}: ${describe(err)}`);
  }
}

import { ClickHouseService, KEY_MAP_WITH, mappedKey, quorumOf, Table, unlAt } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { agreementRows, gapsOf } from './agreement';
import { ComputeJob, ComputeTick } from './compute-loop';
import { VALIDATIONS_RETENTION_SECONDS } from './rounds.job';
import { ListContext, loadListContext } from './stored-lists';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** An hour is computed once it ended this long ago: the validations of its last ledgers are in (spec 2.5). */
export const HOUR_DELAY_SECONDS = 600;

/** The most of a compute tick the `agreement` job may use. */
export const AGREEMENT_BUDGET_MS = 10_000;

const HOUR = 3600;
const DAY = 86_400;

/** An hour with a gap is recomputed this often at most (milliseconds: versions are wall-clock milliseconds). */
const RECOMPUTE_INTERVAL_MS = 3_600_000;

/** The validations of a ledger are read from this long before the start of the window ... */
const READ_LEAD_MS = 600_000;
/** ... to this long after its end (a validation that is recorded again later is still counted). */
const READ_TAIL_MS = 7_200_000;

/** What a run reads once and the hours of it share: the lists. */
type RunContext = ListContext;

/** The key of a validation or a row of an hour, mapped to its master through the manifest map of the statement (`KEY_MAP_WITH`). */
const MAPPED_KEY = mappedKey('validation_public_key');

/** An hour to compute, with its UNL and its quorum. */
interface HourPlan {
  /** The start of the hour, unix seconds. */
  hour: number;
  unl: ReadonlySet<string>;
  quorum: number;
}

/** The ledgers of a window of hours, from `ledgers`. */
interface WindowLedgers {
  /** The ledger indices of each hour (by the start of the hour), ascending. */
  byHour: Map<number, number[]>;
  /** The lowest and the highest ledger index of the window; none when it has no ledger. */
  first?: number;
  last?: number;
  /** The nearest committed ledger before the window, and the nearest at or after its end. */
  before?: number;
  after?: number;
}

/** What the read of the validations gives for a window of hours. */
interface WindowReads {
  /** Per hour: the observed ledgers. */
  observed: Map<number, number>;
  /** Per hour and validator: the observed ledgers it signed fully and only partially. */
  perKey: Map<number, Map<string, { agreed: number; partialOnly: number }>>;
  /** Per hour and validator: the newest receipt in the hour, in seconds. */
  seen: Map<number, Map<string, number>>;
  /** Per hour and validator: the newest receipt of a validation of an observed ledger of the hour, in seconds, whenever it came. */
  late: Map<number, Map<string, number>>;
}

/**
 * The read of the agreement of a window of hours (one hour, or a whole UTC day).
 *
 * `key_map` is the manifest map (`KEY_MAP_WITH`), computed in the statement; `l` is the chain of the window (the ledgers of
 * `ledgers` with a close time in it, one hash per hash, each with its hour); `v` is, per ledger of it and validator (keys mapped
 * to master keys through `key_map`), the newest validation as the
 * collector recorded it (`f` = 1 for a full one) and the time of its last receipt, among the rows received from 10 minutes
 * before the window to 2 hours after it; `obs` is the ledgers with full validations from at least `quorum` members of the UNL.
 * The ledgers outside `obs` count for nobody.
 */
const AGREEMENT_WITH = `WITH ${KEY_MAP_WITH},
       l AS (
         SELECT ledger_hash, any(intDiv(toUnixTimestamp(close_time), 3600) * 3600) AS chain_hour
           FROM ${Table.Ledgers}
          WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
            AND close_time >= toDateTime({windowStart:UInt32}, 'UTC') AND close_time < toDateTime({windowEnd:UInt32}, 'UTC')
          GROUP BY ledger_hash
       ),
       v AS (
         SELECT ledger_hash,
                ${MAPPED_KEY} AS k,
                max(full) AS f,
                max(last_datetime) AS seen
           FROM ${Table.Validations}
          WHERE last_datetime >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
            AND last_datetime < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
            AND ledger_hash IN (SELECT ledger_hash FROM l)
            AND validation_public_key != ''
          GROUP BY ledger_hash, k
       ),
       obs AS (
         SELECT ledger_hash
           FROM v
          WHERE f = 1 AND has({unl:Array(String)}, k)
          GROUP BY ledger_hash
         HAVING count() >= {quorum:UInt16}
       )`;

/**
 * The `agreement` job of the compute loop (spec 2.5): per UTC hour, how many of the ledgers of the indexed validated chain
 * (`ledgers`) each tracked validator agreed with, missed or only partially validated, in `validator_agreement_hourly`.
 *
 * **Hours.** An hour is ready when it ended at least 10 minutes ago and the newest committed ledger closed at or after its end (the
 * ingest has passed it). They are computed oldest first, until the deadline of the tick, because the tracked validators of an hour
 * carry over from the hour before. The first hour is the first whole hour at or after both the oldest validation of the oldest
 * active `validations` partition (`system.parts`) and the first ledger of `ledgers`; then always the hour after the newest stored one
 * (its newest sentinel), so a restart goes on where the last run ended and a final hour is never done twice, though never from an
 * hour whose validations `validations` no longer holds whole (the 90 days of its TTL). While no UNL is known
 * (no list stored yet) nothing is computed: an hour with an empty UNL would be written final with nothing observed.
 *
 * **A window.** One hour per read, or, from midnight UTC while the whole day ended more than 24 hours ago and is ready, a whole day
 * per read (a day of 21,600 hashes is read through a subquery on `ledgers`, not as a parameter), when every hour of the day has the
 * same UNL and quorum: the rows are the same as hour by hour, which is what a day that does not qualify gets. Each hour of a window is
 * written on its own.
 *
 * **An hour** is L(h), the ledgers with a close time in it (one per index); UNL(h) is `unlAt` of every stored list of the configured
 * publishers at the end of the hour (each key a publisher served under was trusted in its time) and nUNL(h) the negative UNL of the
 * newest `network_state` row polled at or before that time (none: empty); quorum(h) = `quorumOf(|UNL|, |nUNL ∩ UNL|)`. A ledger is
 * observed when full validations from at least quorum(h) members of the UNL are recorded (keys mapped to master keys through the
 * manifest map); the others are `unobserved` and count for nobody. `agreementRows` does the counting. `gaps` is `gapsOf` over the
 * ledger indices, with the nearest committed ledger on each side; an hour with no gap is written `final`.
 *
 * **Not final.** An hour with gaps (ledgers missing in it or at its edges: the range ingest may still fill them) is written with
 * `final = 0` and recomputed, as a new version, at most once an hour while `validations` still holds its validations (90 days).
 * Recomputing it does not change the hours after it: what carries over is who was tracked, not what was counted.
 *
 * **Version sets.** An hour is one insert under one `version` (wall-clock milliseconds, above any version stored for the hour), the
 * sentinel (`validation_public_key ''`) its last row: the insert is one part, so a reader never sees half of it, and it keeps only
 * the rows of the newest sentinel's version. The previous hour's tracked set is read the same way.
 *
 * **Observability.** `syncer_validators_agreement_lag_seconds` is now minus the end of the newest final hour, set at the end of every
 * run, also one that failed or ran out of time.
 */
@Injectable()
export class AgreementJob implements ComputeJob {
  readonly name = 'agreement' as const;
  readonly budgetMs = AGREEMENT_BUDGET_MS;
  private readonly clock: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Whether the wait for a UNL was said: once, not at every tick. */
  private warnedEmptyUnl = false;

  constructor(
    @Inject(ClickHouseService) private readonly ch: Pick<ClickHouseService, 'query' | 'queryOne' | 'insert'>,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlThreshold'>,
    @Inject(PrometheusService) private readonly metrics: Pick<PrometheusService, 'validatorsAgreementLagSeconds'>,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.clock = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(AgreementJob.name);
  }

  async run(tick: ComputeTick): Promise<void> {
    let context: RunContext | undefined;
    const contextOf = async () => (context ??= await this.loadContext());
    try {
      const newestClosed = await this.newestClosed();
      if (newestClosed === undefined) return;
      const stored = await this.newestStoredHour();
      let next = stored === undefined ? await this.firstHour() : stored + HOUR;
      // an hour whose validations are past their TTL cannot be counted: it is not sealed
      if (next !== undefined) next = Math.max(next, retentionFloor(tick.now / 1000));
      let first = stored === undefined;
      while (next !== undefined && this.mayStart(tick)) {
        const plans = await this.planWindow(next, contextOf, tick.now / 1000, newestClosed);
        if (plans === undefined) break;
        if (!(await this.computeWindow(plans, tick))) break;
        if (first) this.logger.log(`Agreement: none was stored, the first hour is ${isoOf(plans[0].hour)}`);
        first = false;
        next = plans[plans.length - 1].hour + HOUR;
      }
      await this.recomputeStale(tick, contextOf, newestClosed);
    } finally {
      // the lag is what an operator watches when a run fails or is too short, so it is set then too (best effort)
      if (!tick.signal.aborted) await this.reportLag(tick.now).catch(() => undefined);
    }
  }

  private mayStart(tick: ComputeTick): boolean {
    return !tick.signal.aborted && this.clock() < tick.deadline;
  }

  // -- which hours ------------------------------------------------------------------------------------------------------

  /** When the newest committed ledger closed, in unix seconds; none while `ledgers` is empty. */
  private async newestClosed(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ newest_closed: number }>(
      `SELECT toUnixTimestamp(close_time) AS newest_closed FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.newest_closed);
  }

  /** The newest hour with a sentinel, the mark of a complete set. */
  private async newestStoredHour(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ stored_hour: number }>(
      `SELECT toUnixTimestamp(hour) AS stored_hour
         FROM ${Table.ValidatorAgreementHourly}
        WHERE validation_public_key = ''
        ORDER BY hour DESC
        LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.stored_hour);
  }

  /**
   * The first hour of a database with none: the first whole hour at or after both the first ledger of `ledgers` and the first
   * validation received in the oldest active partition of `validations`. None while either has nothing.
   */
  private async firstHour(): Promise<number | undefined> {
    // the ingest first: without a ledger there is nothing to look for in the partitions of `validations`
    const ingested = await this.ch.queryOne<{ first_closed: number }>(
      `SELECT toUnixTimestamp(close_time) AS first_closed FROM ${Table.Ledgers} ORDER BY ledger_index ASC LIMIT 1`,
    );
    if (ingested === undefined) return undefined;
    const oldest = await this.ch.queryOne<{ oldest_partition: string }>(
      `SELECT min(partition_id) AS oldest_partition
         FROM system.parts
        WHERE database = currentDatabase() AND table = {table:String} AND active`,
      { table: Table.Validations },
    );
    if (!oldest?.oldest_partition) return undefined;
    const received = await this.ch.queryOne<{ first_ms: number | string; received: number | string }>(
      `SELECT toUnixTimestamp64Milli(min(last_datetime)) AS first_ms, count() AS received
         FROM ${Table.Validations}
        WHERE _partition_id = {partition:String} AND validation_public_key != ''`,
      { partition: oldest.oldest_partition },
    );
    if (received === undefined || Number(received.received) === 0) return undefined;
    const startMs = Math.max(Number(ingested.first_closed) * 1000, Number(received.first_ms));
    return Math.ceil(startMs / (HOUR * 1000)) * HOUR;
  }

  /** Whether an hour is over for the validations (10 minutes) and the ingest has passed its end. */
  private isReady(hour: number, nowSeconds: number, newestClosed: number): boolean {
    return nowSeconds >= hour + HOUR + HOUR_DELAY_SECONDS && newestClosed >= hour + HOUR;
  }

  /**
   * The hours to read next, starting at `next`: a whole UTC day when `next` is its midnight, the day ended more than 24 hours ago
   * and is ready, and its hours have one UNL and one quorum; else the one hour. None when the hour is not ready, or no UNL is known.
   */
  private async planWindow(
    next: number,
    contextOf: () => Promise<RunContext>,
    nowSeconds: number,
    newestClosed: number,
  ): Promise<HourPlan[] | undefined> {
    if (!this.isReady(next, nowSeconds, newestClosed)) return undefined;
    const context = await contextOf();
    if (
      next % DAY === 0 &&
      nowSeconds - (next + DAY) > DAY &&
      this.isReady(next + DAY - HOUR, nowSeconds, newestClosed)
    ) {
      const day: HourPlan[] = [];
      for (let hour = next; hour < next + DAY; hour += HOUR) day.push(await this.planHour(hour, context));
      if (day.every((plan) => plan.unl.size > 0 && sameMembership(plan, day[0]))) return day;
    }
    const plan = await this.planHour(next, context);
    if (plan.unl.size === 0) {
      if (!this.warnedEmptyUnl) {
        this.logger.warn(
          `Agreement: no UNL is known at the end of ${isoOf(next)}, the hour waits for a validator list`,
        );
        this.warnedEmptyUnl = true;
      }
      return undefined;
    }
    this.warnedEmptyUnl = false;
    return [plan];
  }

  /** The UNL and the quorum of an hour, both as of its end. */
  private async planHour(hour: number, context: RunContext): Promise<HourPlan> {
    const end = hour + HOUR;
    const unl = unlAt(context.lists, context.publishers, context.threshold, end);
    const negative = await this.negativeUnlAt(end);
    const onUnl = negative.filter((key) => unl.has(key)).length;
    return { hour, unl, quorum: quorumOf(unl.size, onUnl) };
  }

  /** The negative UNL of the newest ledger state polled at or before `end` (unix seconds); none when there is none. */
  private async negativeUnlAt(end: number): Promise<string[]> {
    const row = await this.ch.queryOne<{ disabled: string[] }>(
      `SELECT arrayMap(v -> tupleElement(v, 'validation_public_key'), negative_unl) AS disabled
         FROM ${Table.NetworkState}
        WHERE polled_at <= fromUnixTimestamp64Milli({endMs:Int64}, 'UTC')
        ORDER BY polled_at DESC, ledger_index DESC
        LIMIT 1`,
      { endMs: end * 1000 },
    );
    return row?.disabled ?? [];
  }

  // -- what a run reads once --------------------------------------------------------------------------------------------

  private loadContext(): Promise<RunContext> {
    return loadListContext(this.ch, this.cfg);
  }

  // -- one window -------------------------------------------------------------------------------------------------------

  /**
   * Reads and writes the hours of a window, oldest first. Resolves `false` when the shutdown stopped it before all of them were
   * written; each hour written is whole.
   */
  private async computeWindow(plans: HourPlan[], tick: ComputeTick): Promise<boolean> {
    const start = plans[0].hour;
    const end = plans[plans.length - 1].hour + HOUR;
    const chain = await this.readChain(start, end);
    const reads = await this.readWindow(plans[0], chain, start, end);
    const versions = await this.storedVersions(start, end);
    let previous = await this.previousRows(start - HOUR);
    const edges = edgesOf(plans, chain);

    for (const plan of plans) {
      if (tick.signal.aborted) return false;
      const indices = chain.byHour.get(plan.hour) ?? [];
      const gaps = gapsOf(indices, edges.before.get(plan.hour), edges.after.get(plan.hour));
      const rows = agreementRows({
        hour: plan.hour,
        ledgers: indices.length,
        observed: reads.observed.get(plan.hour) ?? 0,
        gaps,
        unl: plan.unl,
        quorum: plan.quorum,
        perKey: reads.perKey.get(plan.hour) ?? new Map(),
        seenInHour: reads.seen.get(plan.hour) ?? new Map(),
        seenOutside: reads.late.get(plan.hour),
        previous,
        final: gaps === 0,
        version: Math.max(Math.floor(tick.now), (versions.get(plan.hour) ?? 0) + 1),
      });
      await this.ch.insert(Table.ValidatorAgreementHourly, rows);
      previous = rows;
    }
    return true;
  }

  /** The ledgers of the window [start, end) by hour, and the nearest committed ledger on each side of it. */
  private async readChain(start: number, end: number): Promise<WindowLedgers> {
    const rows = await this.ch.query<{ ledger_index: number; ledger_hour: number }>(
      `SELECT ledger_index, intDiv(toUnixTimestamp(any(close_time)), 3600) * 3600 AS ledger_hour
         FROM ${Table.Ledgers}
        WHERE close_time >= toDateTime({windowStart:UInt32}, 'UTC') AND close_time < toDateTime({windowEnd:UInt32}, 'UTC')
        GROUP BY ledger_index
        ORDER BY ledger_index`,
      { windowStart: start, windowEnd: end },
    );
    const byHour = new Map<number, number[]>();
    for (const row of rows) {
      const hour = Number(row.ledger_hour);
      const indices = byHour.get(hour);
      if (indices === undefined) byHour.set(hour, [Number(row.ledger_index)]);
      else indices.push(Number(row.ledger_index));
    }
    if (rows.length === 0) {
      // nothing in the window: its neighbours are found by time
      const before = await this.ch.queryOne<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.Ledgers}
          WHERE close_time < toDateTime({windowStart:UInt32}, 'UTC')
          ORDER BY ledger_index DESC LIMIT 1`,
        { windowStart: start },
      );
      const after = await this.ch.queryOne<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.Ledgers}
          WHERE close_time >= toDateTime({windowEnd:UInt32}, 'UTC')
          ORDER BY ledger_index ASC LIMIT 1`,
        { windowEnd: end },
      );
      return { byHour, before: indexOf(before), after: indexOf(after) };
    }
    const first = Number(rows[0].ledger_index);
    const last = Number(rows[rows.length - 1].ledger_index);
    const below = await this.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} WHERE ledger_index < {first:UInt32} ORDER BY ledger_index DESC LIMIT 1`,
      { first },
    );
    const above = await this.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} WHERE ledger_index > {last:UInt32} ORDER BY ledger_index ASC LIMIT 1`,
      { last },
    );
    return { byHour, first, last, before: indexOf(below), after: indexOf(above) };
  }

  /**
   * The observed ledgers, what each validator signed of them and when each validator was last heard, per hour of the window.
   * `first` carries the UNL and the quorum, which every hour of a window shares.
   */
  private async readWindow(first: HourPlan, chain: WindowLedgers, start: number, end: number): Promise<WindowReads> {
    const reads: WindowReads = { observed: new Map(), perKey: new Map(), seen: new Map(), late: new Map() };
    const fromMs = start * 1000 - READ_LEAD_MS;
    const toMs = end * 1000 + READ_TAIL_MS;
    // heard in the hour: the newest receipt of every validator in it, of any ledger
    const heard = await this.ch.query<{ seen_hour: number; seen_key: string; seen_ms: number | string }>(
      `WITH ${KEY_MAP_WITH}
       SELECT intDiv(toUnixTimestamp64Milli(last_datetime), 3600000) * 3600 AS seen_hour,
              ${MAPPED_KEY} AS seen_key,
              toUnixTimestamp64Milli(max(last_datetime)) AS seen_ms
         FROM ${Table.Validations}
        WHERE last_datetime >= fromUnixTimestamp64Milli({startMs:Int64}, 'UTC')
          AND last_datetime < fromUnixTimestamp64Milli({endMs:Int64}, 'UTC')
          AND validation_public_key != ''
        GROUP BY seen_hour, seen_key
        ORDER BY seen_hour, seen_key`,
      { startMs: start * 1000, endMs: end * 1000 },
    );
    for (const row of heard) mapOf(reads.seen, Number(row.seen_hour)).set(row.seen_key, Number(row.seen_ms) / 1000);
    if (chain.first !== undefined && chain.last !== undefined) {
      const params = {
        first: chain.first,
        last: chain.last,
        windowStart: start,
        windowEnd: end,
        fromMs,
        toMs,
        unl: [...first.unl],
        quorum: first.quorum,
      };
      // one read, one snapshot: the rows of the validators, and (WITH ROLLUP) the rows of the hours with the distinct observed
      // ledgers of each, the key `''` that no validator has (the reads of `validations` leave it out)
      const counts = await this.ch.query<{
        counted_hour: number;
        counted_key: string;
        agreed: number | string;
        partial_only: number | string;
        last_ms: number | string;
        observed_ledgers: number | string;
      }>(
        `${AGREEMENT_WITH}
         SELECT l.chain_hour AS counted_hour, v.k AS counted_key, countIf(v.f = 1) AS agreed, countIf(v.f = 0) AS partial_only,
                toUnixTimestamp64Milli(max(v.seen)) AS last_ms, uniqExact(v.ledger_hash) AS observed_ledgers
           FROM v INNER JOIN l USING ledger_hash
          WHERE v.ledger_hash IN (SELECT ledger_hash FROM obs)
          GROUP BY counted_hour, counted_key WITH ROLLUP
          ORDER BY counted_hour, counted_key`,
        params,
      );
      for (const row of counts) {
        const hour = Number(row.counted_hour);
        if (hour === 0) continue; // the total of all the hours
        if (row.counted_key === '') {
          reads.observed.set(hour, Number(row.observed_ledgers));
          continue;
        }
        mapOf(reads.perKey, hour).set(row.counted_key, {
          agreed: Number(row.agreed),
          partialOnly: Number(row.partial_only),
        });
        mapOf(reads.late, hour).set(row.counted_key, Number(row.last_ms) / 1000);
      }
    }
    return reads;
  }

  /** The newest version stored for each hour of the window [start, end), complete or not. */
  private async storedVersions(start: number, end: number): Promise<Map<number, number>> {
    const rows = await this.ch.query<{ stored_hour: number; stored_version: string }>(
      `SELECT toUnixTimestamp(hour) AS stored_hour, toString(max(version)) AS stored_version
         FROM ${Table.ValidatorAgreementHourly}
        WHERE hour >= toDateTime({windowStart:UInt32}, 'UTC') AND hour < toDateTime({windowEnd:UInt32}, 'UTC')
        GROUP BY hour`,
      { windowStart: start, windowEnd: end },
    );
    return new Map(rows.map((row) => [Number(row.stored_hour), Number(row.stored_version)]));
  }

  /**
   * The validators of the hour that starts at `hour`, with the newest receipt known of each, as its newest sentinel's version
   * has them and no other (a set that is being rewritten, or was cut short, never mixes with the one a reader takes). The keys are
   * mapped to master keys through the manifest map, as one stored under a signing key counts for its master.
   */
  private async previousRows(hour: number): Promise<Array<{ validation_public_key: string; last_seen: number }>> {
    const rows = await this.ch.query<{ tracked_key: string; seen_ms: number | string }>(
      `WITH ${KEY_MAP_WITH}
       SELECT ${MAPPED_KEY} AS tracked_key,
              toUnixTimestamp64Milli(max(last_seen)) AS seen_ms
         FROM ${Table.ValidatorAgreementHourly}
        WHERE hour = toDateTime({hour:UInt32}, 'UTC')
          AND validation_public_key != ''
          AND version = (SELECT max(version) FROM ${Table.ValidatorAgreementHourly}
                          WHERE hour = toDateTime({hour:UInt32}, 'UTC') AND validation_public_key = '')
        GROUP BY tracked_key
        ORDER BY tracked_key`,
      { hour },
    );
    return rows.map((row) => ({ validation_public_key: row.tracked_key, last_seen: Number(row.seen_ms) / 1000 }));
  }

  // -- hours that were not final ----------------------------------------------------------------------------------------

  /**
   * Recomputes, oldest first until the deadline, the stored hours whose newest sentinel is not final, once their version is an hour
   * old and while `validations` still holds their validations (the hour and the 10 minutes before it are inside its 90 days).
   */
  private async recomputeStale(
    tick: ComputeTick,
    contextOf: () => Promise<RunContext>,
    newestClosed: number,
  ): Promise<void> {
    const nowSeconds = tick.now / 1000;
    const since = retentionFloor(nowSeconds);
    const stale = await this.ch.query<{ stale_hour: number; stale_version: string }>(
      `SELECT toUnixTimestamp(hour) AS stale_hour, toString(max(version)) AS stale_version, argMax(final, version) AS stale_final
         FROM ${Table.ValidatorAgreementHourly}
        WHERE validation_public_key = '' AND hour >= toDateTime({since:UInt32}, 'UTC')
        GROUP BY hour
       HAVING stale_final = 0
        ORDER BY hour`,
      { since },
    );
    for (const row of stale) {
      if (!this.mayStart(tick)) return;
      const hour = Number(row.stale_hour);
      if (tick.now - Number(row.stale_version) < RECOMPUTE_INTERVAL_MS) continue;
      if (!this.isReady(hour, nowSeconds, newestClosed)) continue;
      const context = await contextOf();
      const plan = await this.planHour(hour, context);
      if (plan.unl.size === 0) continue;
      if (!(await this.computeWindow([plan], tick))) return;
    }
  }

  // -- the gauge --------------------------------------------------------------------------------------------------------

  /** Sets the gauge: now minus the end of the newest final hour. Without a final hour it says nothing. */
  private async reportLag(nowMs: number): Promise<void> {
    const row = await this.ch.queryOne<{ newest_final: number }>(
      `SELECT toUnixTimestamp(hour) AS newest_final, argMax(final, version) AS newest_is_final
         FROM ${Table.ValidatorAgreementHourly}
        WHERE validation_public_key = ''
        GROUP BY hour
       HAVING newest_is_final = 1
        ORDER BY hour DESC
        LIMIT 1`,
    );
    if (row === undefined) return;
    this.metrics.validatorsAgreementLagSeconds.set(
      Math.max(0, Math.floor(nowMs / 1000) - (Number(row.newest_final) + HOUR)),
    );
  }
}

/**
 * The first hour whose validations `validations` still holds whole: the hour and the 10 minutes read before it are inside the 90
 * days of its TTL. Earlier hours are neither started from nor recomputed.
 */
function retentionFloor(nowSeconds: number): number {
  const since = Math.floor(nowSeconds) - VALIDATIONS_RETENTION_SECONDS + HOUR_DELAY_SECONDS;
  return Math.max(0, Math.ceil(since / HOUR) * HOUR);
}

/** The `ledger_index` of a row, if there is one. */
function indexOf(row: { ledger_index: number } | undefined): number | undefined {
  return row === undefined ? undefined : Number(row.ledger_index);
}

/** The map of `key` in `maps`, made when it is not there. */
function mapOf<V>(maps: Map<number, Map<string, V>>, key: number): Map<string, V> {
  let map = maps.get(key);
  if (map === undefined) {
    map = new Map();
    maps.set(key, map);
  }
  return map;
}

/** Whether two hours have the same UNL members and the same quorum. */
function sameMembership(a: HourPlan, b: HourPlan): boolean {
  if (a.quorum !== b.quorum || a.unl.size !== b.unl.size) return false;
  for (const key of a.unl) if (!b.unl.has(key)) return false;
  return true;
}

/** `2026-10-19T14:00:00Z`: an hour, for a log line. */
function isoOf(hour: number): string {
  return new Date(hour * 1000).toISOString();
}

/**
 * For each hour of a window, the nearest committed ledger before its first ledger and after its last: in the neighbouring hours of
 * the window, else the nearest committed ledger outside it. An hour with no ledger has those of the ledgers around it.
 */
function edgesOf(
  plans: readonly HourPlan[],
  chain: WindowLedgers,
): { before: Map<number, number | undefined>; after: Map<number, number | undefined> } {
  const before = new Map<number, number | undefined>();
  const after = new Map<number, number | undefined>();
  let newest = chain.before;
  for (const plan of plans) {
    before.set(plan.hour, newest);
    const indices = chain.byHour.get(plan.hour);
    if (indices !== undefined && indices.length > 0) newest = indices[indices.length - 1];
  }
  let oldest = chain.after;
  for (let i = plans.length - 1; i >= 0; i--) {
    after.set(plans[i].hour, oldest);
    const indices = chain.byHour.get(plans[i].hour);
    if (indices !== undefined && indices.length > 0) oldest = indices[0];
  }
  return { before, after };
}

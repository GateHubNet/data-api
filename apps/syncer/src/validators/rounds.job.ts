import {
  ClickHouseService,
  keyMapParams,
  MANIFEST_MAP_SQL,
  RECORD_LIFETIME_SECONDS,
  RoundMembership,
  StoredUnlList,
  Table,
  unlAt,
  ValidatorVotesRow,
  VoteRow,
  votingLedgerAtOrAfter,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SyncerConfig, unlPublishersOf, unlThresholdOf } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { ComputeJob, ComputeTick } from './compute-loop';
import { readStoredLists } from './stored-lists';
import { Fees, feesOfSetFee, missingRound, roundQuorum, tallyRound, voteAmendmentsOf } from './tally';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** A round is processed once its voting ledger closed this long ago: the validations of it are in (spec 2.4). */
export const ROUND_DELAY_SECONDS = 120;

/** The most of a compute tick the `rounds` job may use. */
export const ROUNDS_BUDGET_MS = 5_000;

/** Ledgers between voting ledgers (the flag interval of both networks). */
const ROUND_STRIDE = 256;

/** The fees recorded when neither a `SetFee` nor a ledger state is there to say (the columns are not nullable). */
const NO_FEES: Fees = { base_fee: '0', reserve_base: '0', reserve_inc: '0' };

/** What a run reads once and the rounds of it share. */
interface RunContext {
  /** Every list the configured publishers served, whatever key it was served under: a round reads the past. */
  lists: StoredUnlList[];
  publishers: string[];
  threshold: number;
  /** The manifest map as the query parameters of `transform(k, {ephemerals}, {masters}, k)`. */
  keyMap: { ephemerals: string[]; masters: string[] };
  /** The newest `network_state` row, if any. */
  state?: { ledgerIndex: number; majorities: string[]; negativeUnl: string[]; fees: Fees };
}

/** A round that can be processed: where its close time and, if the ingest has it, its hash come from. */
interface ReadyRound {
  /** `undefined` when `ledgers` lacks the voting ledger (a gap of the ingest). */
  hash?: string;
  /** The close time of the voting ledger, or of the first ledger above it when it is missing; unix seconds. */
  closeTime: number;
}

/**
 * The `rounds` job of the compute loop (spec 2.4): for each voting ledger V (index % 256 = 255) that is ready, each validator's
 * vote (`validator_votes`) and the tally of each amendment (`amendment_tallies`).
 *
 * **Rounds.** A round is ready when `ledgers` holds a committed ledger at or above V and it is 120 s past the close of V (of the
 * first committed ledger above V when V itself is missing). They are processed oldest first, until the deadline of the tick.
 * The first round is the first voting ledger at or after the lowest ledger of the oldest active `validations` partition that
 * `ledgers` also covers; the next is always the newest stored round (its newest sentinel) + 256, so a restart goes on where the
 * last run ended and a round is never done twice. A voting ledger `ledgers` lacks gets a sentinel with `observed 0` and no vote.
 *
 * **A round** reads the hash of V; the votes (the earliest sighting's values of each validator, keys mapped to master keys through
 * the manifest map, validations of another hash ignored); the UNL at the close of V from every stored list (each key of a
 * publisher was trusted in its time) and the negative UNL of the newest ledger state at or before V; the votes and sentinels of the
 * rounds of the last 24 hours (the rows of the newest version of each); and the fees in force. `tallyRound` does the counting.
 * The votes are inserted first, then the tallies with the sentinel last, all under one `version` (wall-clock milliseconds, above any
 * version stored for the round): a reader keeps the rows of the newest sentinel's version, so a round that crashed half way is
 * redone as a newer set and is invisible until its sentinel is in.
 *
 * **Observability.** A round recorded with fewer full validations than the quorum is warned about; the gauge
 * `syncer_validators_rounds_lag_ledgers` is the newest committed voting ledger minus the newest stored round, set at the end of
 * every run, also one that failed or ran out of time.
 */
@Injectable()
export class RoundsJob implements ComputeJob {
  readonly name = 'rounds' as const;
  readonly budgetMs = ROUNDS_BUDGET_MS;
  private readonly clock: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;

  constructor(
    @Inject(ClickHouseService) private readonly ch: Pick<ClickHouseService, 'query' | 'queryOne' | 'insert'>,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlThreshold'>,
    @Inject(PrometheusService) private readonly metrics: Pick<PrometheusService, 'validatorsRoundsLagLedgers'>,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.clock = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(RoundsJob.name);
  }

  async run(tick: ComputeTick): Promise<void> {
    let newest: number | undefined;
    let context: RunContext | undefined;
    try {
      newest = await this.newestStoredRound();
      const fresh = newest === undefined;
      let next = newest === undefined ? await this.firstRound() : newest + ROUND_STRIDE;
      while (next !== undefined && this.mayStart(tick)) {
        const ready = await this.readyRound(next, tick.now / 1000);
        if (ready === undefined) break;
        context ??= await this.loadContext();
        if (!(await this.processRound(next, ready, context, tick))) break;
        if (fresh && newest === undefined) this.logger.log(`Rounds: none was stored, the first is ${next}`);
        newest = next;
        next += ROUND_STRIDE;
      }
    } finally {
      // the lag is what an operator watches when a run fails or is too short, so it is set then too (best effort)
      if (!tick.signal.aborted) await this.reportLag(newest).catch(() => undefined);
    }
  }

  private mayStart(tick: ComputeTick): boolean {
    return !tick.signal.aborted && this.clock() < tick.deadline;
  }

  // -- which round ------------------------------------------------------------------------------------------------------

  /** The newest round with a sentinel, the mark of a complete set. */
  private async newestStoredRound(): Promise<number | undefined> {
    const row = await this.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.AmendmentTallies}
        WHERE amendment_id = ''
        ORDER BY ledger_index DESC
        LIMIT 1`,
    );
    return row === undefined ? undefined : Number(row.ledger_index);
  }

  /**
   * The first round of a database with none: the first voting ledger at or after the higher of the lowest ledger the oldest
   * active partition of `validations` holds a validation of, and the lowest ledger of `ledgers`. None while either has nothing.
   */
  private async firstRound(): Promise<number | undefined> {
    const oldest = await this.ch.queryOne<{ oldest_partition: string }>(
      `SELECT min(partition_id) AS oldest_partition
         FROM system.parts
        WHERE database = currentDatabase() AND table = {table:String} AND active`,
      { table: Table.Validations },
    );
    if (!oldest?.oldest_partition) return undefined;
    const voted = await this.ch.queryOne<{ lowest: number; validations: number | string }>(
      `SELECT min(ledger_index) AS lowest, count() AS validations
         FROM ${Table.Validations}
        WHERE _partition_id = {partition:String} AND ledger_index > 0`,
      { partition: oldest.oldest_partition },
    );
    if (voted === undefined || Number(voted.validations) === 0) return undefined;
    const ingested = await this.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} ORDER BY ledger_index ASC LIMIT 1`,
    );
    if (ingested === undefined) return undefined;
    return votingLedgerAtOrAfter(Math.max(Number(voted.lowest), Number(ingested.ledger_index)));
  }

  /**
   * The ledger that makes `round` ready: the first committed ledger at or above it, once its close was 120 s ago. `hash` is
   * there when that ledger is the voting ledger itself.
   */
  private async readyRound(round: number, nowSeconds: number): Promise<ReadyRound | undefined> {
    const row = await this.ch.queryOne<{ ledger_index: number; ledger_hash: string; closed: number }>(
      `SELECT ledger_index, ledger_hash, toUnixTimestamp(close_time) AS closed
         FROM ${Table.Ledgers}
        WHERE ledger_index >= {round:UInt32}
        ORDER BY ledger_index ASC
        LIMIT 1`,
      { round },
    );
    if (row === undefined) return undefined;
    const closeTime = Number(row.closed);
    if (nowSeconds < closeTime + ROUND_DELAY_SECONDS) return undefined;
    return Number(row.ledger_index) === round ? { hash: row.ledger_hash, closeTime } : { closeTime };
  }

  // -- what a run reads once --------------------------------------------------------------------------------------------

  private async loadContext(): Promise<RunContext> {
    const publishers = unlPublishersOf(this.cfg).map((publisher) => publisher.id);
    const [lists, manifests, state] = await Promise.all([
      readStoredLists(this.ch, publishers),
      this.ch.query<{ ephemeral_key: string; master_key: string }>(MANIFEST_MAP_SQL),
      this.ch.queryOne<{
        ledger_index: number;
        majority_ids: string[];
        disabled: string[];
        state_base_fee: string;
        state_reserve_base: string;
        state_reserve_inc: string;
      }>(
        `SELECT ledger_index,
                arrayMap(m -> tupleElement(m, 'amendment'), majorities) AS majority_ids,
                arrayMap(v -> tupleElement(v, 'validation_public_key'), negative_unl) AS disabled,
                toString(base_fee) AS state_base_fee, toString(reserve_base) AS state_reserve_base,
                toString(reserve_inc) AS state_reserve_inc
           FROM ${Table.NetworkState}
          ORDER BY ledger_index DESC, polled_at DESC
          LIMIT 1`,
      ),
    ]);
    return {
      lists,
      publishers,
      threshold: unlThresholdOf(this.cfg),
      keyMap: keyMapParams(manifests),
      state:
        state === undefined
          ? undefined
          : {
              ledgerIndex: Number(state.ledger_index),
              majorities: state.majority_ids,
              negativeUnl: state.disabled,
              fees: {
                base_fee: state.state_base_fee,
                reserve_base: state.state_reserve_base,
                reserve_inc: state.state_reserve_inc,
              },
            },
    };
  }

  // -- one round --------------------------------------------------------------------------------------------------------

  /** Reads, counts and writes a round. Resolves `false` when the shutdown stopped it before the set was complete. */
  private async processRound(
    round: number,
    ready: ReadyRound,
    context: RunContext,
    tick: ComputeTick,
  ): Promise<boolean> {
    const { closeTime } = ready;
    const unl = unlAt(context.lists, context.publishers, context.threshold, closeTime);
    const negativeUnl = await this.negativeUnlAt(round, context);
    const fees = await this.feesAt(round, context);
    const version = await this.nextVersion(round, tick.now);

    if (ready.hash === undefined) {
      if (tick.signal.aborted) return false;
      await this.ch.insert(Table.AmendmentTallies, [
        missingRound({ round, closeTime, unl, negativeUnl, fees, version }),
      ]);
      this.checkQuorum(round, 0, unl.size, roundQuorum(unl, negativeUnl));
      return true;
    }

    const votes = await this.votesOf(round, ready.hash, closeTime, context);
    const { history, membership } = await this.historyOf(round, closeTime, unl);
    const { tallies, quorum, observed } = tallyRound({
      round,
      closeTime,
      votes,
      history,
      membership,
      unl,
      negativeUnl,
      majorities: context.state?.majorities ?? [],
      fees,
      version,
    });

    // the votes first, then the tallies with the sentinel last: the sentinel is what makes the set visible
    if (tick.signal.aborted) return false;
    await this.ch.insert(Table.ValidatorVotes, voteRows(round, ready.hash, closeTime, votes, version));
    if (tick.signal.aborted) return false;
    await this.ch.insert(Table.AmendmentTallies, tallies);
    this.checkQuorum(round, observed, unl.size, quorum);
    return true;
  }

  private checkQuorum(round: number, observed: number, unlSize: number, quorum: number): void {
    if (observed < quorum) {
      this.logger.warn(`round ${round}: recorded ${observed} of ${unlSize} UNL validations, below quorum ${quorum}`);
    }
  }

  /** The negative UNL of the newest ledger state at or before the round; none when there is none. */
  private async negativeUnlAt(round: number, context: RunContext): Promise<Set<string>> {
    if (context.state !== undefined && context.state.ledgerIndex <= round) return new Set(context.state.negativeUnl);
    const row = await this.ch.queryOne<{ disabled: string[] }>(
      `SELECT arrayMap(v -> tupleElement(v, 'validation_public_key'), negative_unl) AS disabled
         FROM ${Table.NetworkState}
        WHERE ledger_index <= {round:UInt32}
        ORDER BY ledger_index DESC, polled_at DESC
        LIMIT 1`,
      { round },
    );
    return new Set(row?.disabled ?? []);
  }

  /**
   * The fees in force at the round: those of the newest `SetFee` at or before it (found through `tx_by_type`), else, and also
   * when that transaction does not hold three fees, those of the newest ledger state, else zeros.
   */
  private async feesAt(round: number, context: RunContext): Promise<Fees> {
    const row = await this.ch.queryOne<{ tx_json: string }>(
      `SELECT tx_json
         FROM ${Table.Transactions}
        WHERE (ledger_index, tx_index) IN (
                SELECT ledger_index, tx_index
                  FROM ${Table.TxByType}
                 WHERE tx_type = {type:String} AND ledger_index <= {round:UInt32}
                 ORDER BY ledger_index DESC, tx_index DESC
                 LIMIT 1)
        LIMIT 1`,
      { type: 'SetFee', round },
    );
    return (row === undefined ? undefined : feesOfSetFee(row.tx_json)) ?? context.state?.fees ?? NO_FEES;
  }

  /** A version above any the round has now (its votes, its sentinel), and the time of the tick when that is higher. */
  private async nextVersion(round: number, nowMs: number): Promise<number> {
    const row = await this.ch.queryOne<{ newest: string }>(
      `SELECT toString(max(version)) AS newest
         FROM (SELECT version FROM ${Table.ValidatorVotes} WHERE ledger_index = {round:UInt32}
               UNION ALL
               SELECT version FROM ${Table.AmendmentTallies} WHERE amendment_id = '' AND ledger_index = {round:UInt32})`,
      { round },
    );
    return Math.max(Math.floor(nowMs), Number(row?.newest ?? 0) + 1);
  }

  /**
   * The vote of each validator that signed the ledger with `hash`, as the earliest sighting recorded it (the values of the
   * validation `ValidationsService` shows), under the master key. A validator seen under its signing key and under its master is one.
   */
  private async votesOf(round: number, hash: string, closeTime: number, context: RunContext): Promise<VoteRow[]> {
    const rows = await this.ch.query<{
      vote_key: string;
      vote_full: number;
      vote_amendments: string;
      vote_base_fee: string | null;
      vote_reserve_base: string | null;
      vote_reserve_inc: string | null;
      vote_server_version: string | null;
    }>(
      `SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS vote_key,
              argMin(full, first_datetime) AS vote_full,
              argMin(amendments, first_datetime) AS vote_amendments,
              toString(argMin(base_fee, first_datetime)) AS vote_base_fee,
              toString(argMin(reserve_base, first_datetime)) AS vote_reserve_base,
              toString(argMin(reserve_inc, first_datetime)) AS vote_reserve_inc,
              toString(argMin(server_version, first_datetime)) AS vote_server_version
         FROM ${Table.Validations}
        WHERE ledger_hash = {hash:String}
        GROUP BY vote_key
        ORDER BY vote_key`,
      { hash, ...context.keyMap },
    );
    return rows.map((row) => ({
      ledger_index: round,
      validation_public_key: row.vote_key,
      close_time: closeTime,
      full: Number(row.vote_full),
      amendments: voteAmendmentsOf(row.vote_amendments),
      base_fee: row.vote_base_fee,
      reserve_base: row.vote_reserve_base,
      reserve_inc: row.vote_reserve_inc,
      server_version: row.vote_server_version,
    }));
  }

  /**
   * The full votes of UNL members in the stored rounds that closed no more than 24 hours before this one, and who was on the UNL
   * and the negative UNL in each of them. A round is the rows of its newest sentinel's version, and no other: a set that
   * was rewritten (or is being) never mixes with an older one.
   */
  private async historyOf(
    round: number,
    closeTime: number,
    unl: ReadonlySet<string>,
  ): Promise<{ history: VoteRow[]; membership: Map<number, RoundMembership> }> {
    const membership = new Map<number, RoundMembership>();
    if (unl.size === 0) return { history: [], membership };
    const sentinels = await this.ch.query<{
      ledger_index: number;
      newest_version: string;
      unl_keys: string[];
      nunl_keys: string[];
    }>(
      `SELECT ledger_index, toString(max(version)) AS newest_version,
              argMax(unl, version) AS unl_keys, argMax(negative_unl, version) AS nunl_keys
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id = '' AND ledger_index < {round:UInt32} AND close_time >= toDateTime({since:UInt32}, 'UTC')
        GROUP BY ledger_index
        ORDER BY ledger_index`,
      { round, since: Math.max(0, closeTime - RECORD_LIFETIME_SECONDS) },
    );
    if (sentinels.length === 0) return { history: [], membership };
    for (const sentinel of sentinels) {
      membership.set(Number(sentinel.ledger_index), {
        unl: new Set(sentinel.unl_keys),
        negativeUnl: new Set(sentinel.nunl_keys),
      });
    }

    // only full votes of the UNL can make a record (`recordOf`), so only those are read
    const rows = await this.ch.query<{
      ledger_index: number;
      validation_public_key: string;
      closed: number;
      amendments: string[];
    }>(
      `SELECT ledger_index, validation_public_key, toUnixTimestamp(close_time) AS closed, amendments
         FROM ${Table.ValidatorVotes}
        WHERE ledger_index IN {rounds:Array(UInt32)}
          AND version = transform(ledger_index, {rounds:Array(UInt32)}, {versions:Array(UInt64)}, toUInt64(0))
          AND full = 1
          AND validation_public_key IN {unl:Array(String)}`,
      {
        rounds: sentinels.map((sentinel) => Number(sentinel.ledger_index)),
        versions: sentinels.map((sentinel) => Number(sentinel.newest_version)),
        unl: [...unl],
      },
    );
    const history: VoteRow[] = rows.map((row) => ({
      ledger_index: Number(row.ledger_index),
      validation_public_key: row.validation_public_key,
      close_time: Number(row.closed),
      full: 1,
      amendments: row.amendments,
      base_fee: null,
      reserve_base: null,
      reserve_inc: null,
      server_version: null,
    }));
    return { history, membership };
  }

  // -- the gauge --------------------------------------------------------------------------------------------------------

  /** Sets the gauge: the newest committed voting ledger minus the newest stored round. Without a stored round it says nothing. */
  private async reportLag(newest: number | undefined): Promise<void> {
    if (newest === undefined) return;
    const row = await this.ch.queryOne<{ ledger_index: number }>(
      `SELECT ledger_index FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
    );
    if (row === undefined || Number(row.ledger_index) < ROUND_STRIDE - 1) return;
    // the one voting ledger among the 256 up to the newest committed ledger
    const newestVoting = votingLedgerAtOrAfter(Number(row.ledger_index) - (ROUND_STRIDE - 1));
    this.metrics.validatorsRoundsLagLedgers.set(Math.max(0, newestVoting - newest));
  }
}

/** The `validator_votes` rows of a round, all of one version. */
function voteRows(
  round: number,
  hash: string,
  closeTime: number,
  votes: readonly VoteRow[],
  version: number,
): ValidatorVotesRow[] {
  return votes.map((vote) => ({
    ledger_index: round,
    validation_public_key: vote.validation_public_key,
    ledger_hash: hash,
    close_time: closeTime,
    full: vote.full,
    amendments: vote.amendments,
    base_fee: vote.base_fee,
    reserve_base: vote.reserve_base,
    reserve_inc: vote.reserve_inc,
    server_version: vote.server_version,
    version,
  }));
}

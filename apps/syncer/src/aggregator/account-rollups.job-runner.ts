import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  LedgerRange,
  LedgerRangeOf,
  partitionOf,
  promotionSlice,
  RollupState,
  UTC_DAY_MS,
  utcDayStart,
} from '@gatehub/data-api-shared';
import {
  AggregateFunctions,
  AggregateJobDeps,
  AggregatorAggregates,
  DAY_SECONDS,
  defaultAggregateFunctions,
  isoDay,
  MAX_FAILED_AGGREGATE_SETS_PER_TICK,
  newestFinalDay,
  SetBackoff,
  SetGate,
} from './aggregate-job-deps';
import type { AggregatorJob, AggregatorTick } from './aggregator.service';

/**
 * Every call of `writeAccountRollups` of the runner (the daily increment, a promotion, the correction of a slice) is for this
 * many accounts at most; more are split into several calls, each its own set version. The accounts of a call go to ClickHouse
 * in a URL parameter (about 100 bytes each), and the URI has a limit of 1 MiB.
 */
export const ACCOUNT_ROLLUPS_BATCH_ACCOUNTS = 500;

/** The set of a partition is recounted when it is older than this: the partition of the newest ledger, which grows. */
const NEWEST_PARTITION_RECOUNT_MS = 24 * 3_600_000;
/** ... and every other partition, which only changes by a re-ingest (and that marks it, see `ofSlice`). */
const OTHER_PARTITION_RECOUNT_MS = 7 * 86_400_000;

/** The days whose hook roll the runner remembers (the oldest are forgotten first); a forgotten day is only rolled once more. */
const ROLLED_DAYS_KEPT = 1000;

const chunksOf = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** A state whose rollups cover days, both ends of them. */
type Covered = RollupState & { rolledFrom: string; rolledThrough: string };
const hasCoverage = (state: RollupState): state is Covered =>
  state.rolledFrom !== undefined && state.rolledThrough !== undefined;

/** The days of a promotion slice, `YYYY-MM-DD`, both included. */
interface Slice {
  fromDay: string;
  throughDay: string;
}

/** What one run of the job works with. */
interface Run {
  readonly tick: AggregatorTick;
  /** The newest final day, `YYYY-MM-DD`. */
  readonly through: string;
  /** The state of every heavy account that has one, as the run goes on (what a run writes replaces what it read). */
  readonly states: Map<string, RollupState>;
  /** The sets that failed in this run. */
  failed: number;
  /** What the promotions of the run have read, once for each partition, account and day. */
  readonly daysOfPartition: Map<number, number>;
  readonly rowsOfAccount: Map<string, Map<number, number>>;
  readonly partitionOfDay: Map<string, number | undefined>;
  readonly firstDayOfPartition: Map<number, string | undefined>;
  /** The newest set of each partition that has one, as the run goes on (a recount of the run adds its partition). */
  readonly partitionVersions: Map<number, number>;
  /** The accounts whose promotion waits for the count of a partition, this run. */
  readonly deferred: Set<string>;
}

/**
 * The `account_rollups` job of the aggregator (job 10 of a tick, see spec 3 and 3.4): the day groups of the heavy accounts
 * (those with `GH_ACCOUNT_ROLLUP_MIN_ROWS` balance changes or more), kept per UTC day so that a read of years does not read the
 * millions of rows behind them, and the hook of the slices of `agg_dirty` (`ofSlice`). The job is off when the minimum is 0:
 * the run reads and writes nothing (the hook still keeps existing coverage right, see `ofSlice`). The state of the job (the
 * waits of what failed, the partitions that a slice marked) is its own; the database, the clock, the budget and the rule of
 * failure are the deps'.
 *
 * Per run, in order, each set only while the deadline of the tick has not passed, the shutdown has not begun and fewer than 3
 * sets have failed:
 *
 *  1. **Discovery.** The partitions of `balance_changes` that are due, newest first, are recounted (`recountPartition`): one that
 *     has no set, the newest one when its set is over 24 hours old, any other when it is over 7 days old, and one that a slice
 *     marked. Then the heavy accounts are read, and the states are brought in line in one insert: a new heavy account gets a
 *     state with its first day and no coverage; an account that is no longer heavy loses its coverage; the state of another
 *     config version is an account without coverage (the API does not use it either); the count of rows is kept up to date.
 *  2. **The daily increment.** For each final day d after the `rolled_through` of an account, oldest first, the accounts whose
 *     `rolled_through` is d - 1 are rolled together (in calls of 500 accounts at most), and then their state has
 *     `rolled_through = d`. An account that failed inside a call of several is rolled alone from then on, so that one bad account
 *     does not keep the others.
 *  3. **The promotion**, in rounds: every account whose coverage does not reach back to its first day gets one slice, the ones
 *     without coverage first, then the newest `rolled_from` first, so that a year is covered before all of it. An account with
 *     no coverage starts at the newest final day; the others go on backwards from their `rolled_from`. A slice is as many whole
 *     days as hold about 2,000,000 rows of the account (`promotionSlice`), from its rows in the partition of the slice's end
 *     over the days of the partition, and it stays inside that partition (`sliceOf`): its count says nothing of the older ones.
 *     An account whose slice ends in a partition that has no set yet waits for the discovery to count it.
 *  4. The gauges `syncer_account_rollups_heavy_accounts` and `syncer_account_rollups_pending_accounts`.
 *
 * It says once (a log line, as `rates_daily` and `pair_hourly` do for theirs) that the promotion back-fill is under way, when a run
 * finds a heavy account whose coverage has to grow back, and once that it is done, when no heavy account is pending any more
 * (the pending of the gauge: its coverage reaches from its first day to the newest final day); it says so again if accounts
 * become pending again. A new day that only has to be rolled on (the daily increment) is no back-fill and says nothing.
 *
 * What fails (a partition, a call of accounts, a slice) is logged and counted (`deps.failed`), waits 5 minutes and twice as long
 * after each further failure, up to an hour, while the rest goes on. A day is final as for `rates_daily`.
 */
export class AccountRollupsJobRunner {
  private readonly fns: AggregateFunctions;
  private readonly backoff = new SetBackoff();
  private readonly gate: SetGate;
  /** The ledger ranges of days, from the rates of the network (what `writeAccountRollups` and the promotions work with). */
  private readonly ranges: LedgerRangeOf;
  /** The partitions that the slices of `agg_dirty` touched: the next discovery recounts them. */
  private readonly marked = new Set<number>();
  /** The accounts that failed inside a call of several: they are rolled alone until they work. */
  private readonly solo = new Set<string>();
  /**
   * The days the hook (`ofSlice`) has rolled, across ticks, each with the clock reading (ms) at which that roll began, oldest
   * first, at most `ROLLED_DAYS_KEPT`. A range of `agg_dirty` that was marked at or before it needs no roll of the day again.
   */
  private readonly rolledDays = new Map<string, number>();
  /** Whether the promotion back-fill has announced that it is under way (so that it says so once, and once more when it is done). */
  private backfilling = false;

  constructor(
    private readonly deps: AggregateJobDeps,
    private readonly aggregates: AggregatorAggregates,
    fns: Partial<AggregateFunctions> = {},
  ) {
    this.fns = { ...defaultAggregateFunctions(), ...fns };
    this.gate = new SetGate(deps, 'account_rollups');
    this.ranges = (from, toExclusive) => aggregates.rates.ledgersClosedIn(from, toExclusive);
  }

  job(): AggregatorJob {
    return { name: 'account_rollups', budgetMs: this.deps.budgetMs, run: (tick) => this.run(tick) };
  }

  private async run(tick: AggregatorTick): Promise<void> {
    try {
      await this.refresh(tick);
    } finally {
      this.gate.endRun();
    }
  }

  /**
   * The hook of `agg_dirty`: a slice `[start, end)` (unix seconds, at most a day) recomputes, for every account whose rollups
   * cover a day of it (its newest state row is of the current config version and its coverage holds the day: the state rows say
   * so, not the heavy accounts), that day (a call for each day, of 500 accounts at most), and marks the partitions of its
   * ledgers for the next discovery to recount. A failure rejects: the caller fails the slice, which keeps its range for the next
   * tick. Nothing is started once the shutdown has begun.
   *
   * `marked` is when the range of the slice was marked (`DirtyRange.created`, unix ms). A re-ingested day comes as many ranges
   * (one for each chunk of ledgers, about an hour), each its own slice, and one roll of the day answers them all: a day that was
   * rolled, from a roll that began at or after `marked`, is not rolled again, as the volume sets of the day are not (see
   * `volumesOfSlice`). A range that was marked after the roll began rolls the day again: the ingest wrote ledgers into it
   * meanwhile, which that roll may not have seen. Without `marked` every slice rolls its days. A roll that failed is not
   * remembered.
   *
   * With `GH_ACCOUNT_ROLLUP_MIN_ROWS` 0 the job is off, but the API still uses the coverage that exists, so a re-ingest must
   * not leave its days stale: the slice still recomputes them, and marks no partition (there is no discovery to recount it). With
   * no account that has coverage it does nothing.
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick, marked?: number): Promise<void> {
    const { deps, fns } = this;
    if (deps.closing() || end <= start) return;
    if (this.aggregates.accountRollupMinRows > 0) {
      const range = await this.ranges(new Date(start * 1000), new Date(end * 1000));
      if (range !== null) {
        for (let partition = partitionOf(range.min); partition <= partitionOf(range.max); partition++) {
          this.marked.add(partition);
        }
      }
    }
    const days: string[] = [];
    for (let day = Math.floor(start / DAY_SECONDS) * DAY_SECONDS; day < end; day += DAY_SECONDS) {
      const key = isoDay(day);
      const began = this.rolledDays.get(key);
      if (marked !== undefined && began !== undefined && began >= marked) {
        deps.logger.debug(`account_rollups: ${key}: rolled since the range was marked (agg_dirty)`);
      } else {
        days.push(key);
      }
    }
    if (days.length === 0) return;
    const states = await fns.rollupStates(deps.ch);
    for (const key of days) {
      const began = deps.clock();
      const accounts = [...states.values()]
        .filter(
          (s) =>
            s.configVersion === ACCOUNT_ROLLUP_CONFIG_VERSION &&
            hasCoverage(s) &&
            s.rolledFrom <= key &&
            key <= s.rolledThrough,
        )
        .map((s) => s.account)
        .sort();
      for (const batch of chunksOf(accounts, ACCOUNT_ROLLUPS_BATCH_ACCOUNTS)) {
        if (deps.closing()) return;
        await fns.writeAccountRollups(deps.ch, this.ranges, batch, key, key, { signal: tick.signal });
      }
      this.rememberRolled(key, began);
      deps.logger.debug(`account_rollups: ${key}: ${accounts.length} account(s) (agg_dirty)`);
    }
  }

  /** Remembers that a day's roll began at `began`; the oldest day goes when more than `ROLLED_DAYS_KEPT` are kept. */
  private rememberRolled(day: string, began: number): void {
    this.rolledDays.delete(day);
    this.rolledDays.set(day, began);
    if (this.rolledDays.size > ROLLED_DAYS_KEPT) {
      const [oldest] = this.rolledDays.keys();
      this.rolledDays.delete(oldest);
    }
  }

  private async refresh(tick: AggregatorTick): Promise<void> {
    const { deps, fns } = this;
    const minRows = this.aggregates.accountRollupMinRows;
    if (minRows <= 0) return;
    // the jobs before this one may have used the tick up: do not even read what cannot be worked on
    if (!this.gate.mayStart(tick.deadline)) return;
    const newest = await fns.newestLedgerClose(deps.ch);
    // the first and the last ledger give the partitions of `balance_changes` there are
    const ledgers = newest === undefined ? null : await this.ranges(new Date(0), new Date((newest + 1) * 1000));
    if (newest === undefined || ledgers === null) {
      deps.metrics?.accountRollupsHeavyAccounts.set(0);
      deps.metrics?.accountRollupsPendingAccounts.set(0);
      return;
    }
    const run: Run = {
      tick,
      through: isoDay(newestFinalDay(newest, tick.now)),
      states: new Map(),
      failed: 0,
      daysOfPartition: new Map(),
      rowsOfAccount: new Map(),
      partitionOfDay: new Map(),
      firstDayOfPartition: new Map(),
      partitionVersions: new Map(),
      deferred: new Set(),
    };

    const due = await this.recount(run, ledgers);
    if (deps.closing()) return;
    const heavy = await this.classify(run, minRows);
    if (heavy === undefined) return;
    // a set that is done (or an account that is no longer heavy) has no failure to remember
    this.backoff.keepOnly(
      new Set([...due.map((p) => `partition/${p}`), ...[...heavy.keys()].flatMap((a) => [`inc/${a}`, `promo/${a}`])]),
    );
    for (const account of this.solo) if (!heavy.has(account)) this.solo.delete(account);

    // the promotion is under way when an account has to be covered further back (not for a new day, which only rolls on)
    const toPromote = [...run.states.values()].filter((s) => this.needsPromotion(s, run.through)).length;
    if (toPromote > 0) this.announceBackfill(true, toPromote);
    await this.increment(run);
    await this.promote(run);
    this.report(run, heavy);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // 1. discovery
  // -------------------------------------------------------------------------------------------------------------------

  /** Recounts the partitions that are due, newest first, as far as the run may go; returns the ones that were due. */
  private async recount(run: Run, ledgers: LedgerRange): Promise<number[]> {
    const { deps } = this;
    const newestPartition = partitionOf(ledgers.max);
    const oldestPartition = partitionOf(ledgers.min);
    const versions = await this.fns.partitionSetVersions(deps.ch);
    for (const [partition, version] of versions) run.partitionVersions.set(partition, version);
    const now = run.tick.now.getTime();
    const due: number[] = [];
    for (let partition = newestPartition; partition >= oldestPartition; partition--) {
      const version = versions.get(partition);
      const maxAge = partition === newestPartition ? NEWEST_PARTITION_RECOUNT_MS : OTHER_PARTITION_RECOUNT_MS;
      if (version === undefined || this.marked.has(partition) || now - version > maxAge) due.push(partition);
    }
    for (const partition of this.marked) {
      if (partition < oldestPartition || partition > newestPartition) this.marked.delete(partition);
    }

    for (const partition of due) {
      const key = `partition/${partition}`;
      if (this.backoff.waiting(key, deps.clock())) continue;
      if (!this.mayStart(run)) break;
      try {
        const accounts = await this.fns.recountPartition(deps.ch, partition, { signal: run.tick.signal });
        this.backoff.done(key);
        this.marked.delete(partition);
        run.partitionVersions.set(partition, deps.clock());
        deps.logger.debug(`account_rollups: partition ${partition}: ${accounts} account(s) counted`);
      } catch (err) {
        this.fail(run, err, ` recounting partition ${partition}`, [key]);
      }
    }
    return due;
  }

  /**
   * Reads the heavy accounts and their states and writes the changes, in one insert. `run.states` becomes the state of every
   * heavy account that has one. Returns the heavy accounts (the account and its balance changes); undefined when the shutdown
   * began.
   */
  private async classify(run: Run, minRows: number): Promise<Map<string, number> | undefined> {
    const { deps, fns } = this;
    const [heavy, stored] = await Promise.all([fns.heavyAccounts(deps.ch, minRows), fns.rollupStates(deps.ch)]);
    if (deps.closing()) return undefined;
    const changes: RollupState[] = [];
    const fresh: Array<[account: string, rows: number]> = [];
    for (const [account, rows] of heavy) {
      const state = stored.get(account);
      if (state === undefined) {
        fresh.push([account, rows]);
      } else if (state.configVersion !== ACCOUNT_ROLLUP_CONFIG_VERSION) {
        // its coverage is not the API's to use: it has none, and is promoted from the newest final day
        const uncovered: RollupState = {
          account,
          rows,
          firstDay: state.firstDay,
          configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
        };
        changes.push(uncovered);
        run.states.set(account, uncovered);
      } else if (state.rows !== rows) {
        const counted = { ...state, rows };
        changes.push(counted);
        run.states.set(account, counted);
      } else {
        run.states.set(account, state);
      }
    }
    // an account that is no longer heavy loses its coverage (its rollup rows stay, unused)
    for (const [account, state] of stored) {
      if (!heavy.has(account) && hasCoverage(state)) {
        changes.push({ account, rows: state.rows, firstDay: state.firstDay, configVersion: state.configVersion });
      }
    }
    // a new heavy account: the day of its first balance change, one read each, as far as the budget lasts
    for (const [account, rows] of fresh) {
      if (!this.gate.mayStart(run.tick.deadline)) break;
      const firstDay = await fns.firstChangeDay(deps.ch, account);
      if (firstDay === undefined) continue;
      const created: RollupState = { account, rows, firstDay, configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION };
      changes.push(created);
      run.states.set(account, created);
    }
    if (changes.length > 0) await fns.writeRollupStates(deps.ch, changes, { signal: run.tick.signal });
    return heavy;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // 2. the daily increment
  // -------------------------------------------------------------------------------------------------------------------

  private async increment(run: Run): Promise<void> {
    const { deps } = this;
    let lowest: number | undefined;
    for (const state of run.states.values()) {
      if (hasCoverage(state)) {
        const day = utcDayStart(state.rolledThrough);
        if (lowest === undefined || day < lowest) lowest = day;
      }
    }
    if (lowest === undefined) return;
    const through = utcDayStart(run.through);
    for (let day = lowest + UTC_DAY_MS; day <= through; day += UTC_DAY_MS) {
      const key = isoDay(day / 1000);
      const before = isoDay((day - UTC_DAY_MS) / 1000);
      // the accounts that are at the day before, not those that wait for a failure; the ones that failed in a call of several
      // are a call of their own
      const ready = [...run.states.values()]
        .filter((s) => hasCoverage(s) && s.rolledThrough === before)
        .map((s) => s.account)
        .filter((account) => !this.backoff.waiting(`inc/${account}`, deps.clock()))
        .sort();
      const calls = [
        ...chunksOf(
          ready.filter((account) => !this.solo.has(account)),
          ACCOUNT_ROLLUPS_BATCH_ACCOUNTS,
        ),
        ...ready.filter((account) => this.solo.has(account)).map((account) => [account]),
      ];
      for (const accounts of calls) {
        if (!this.mayStart(run)) return;
        await this.roll(run, accounts, key);
      }
    }
  }

  /** Rolls a day of the accounts and writes their state; a failure is logged and counted, and the accounts are made to wait. */
  private async roll(run: Run, accounts: string[], day: string): Promise<void> {
    const { deps, fns } = this;
    const who = accounts.length === 1 ? accounts[0] : `${accounts.length} accounts`;
    try {
      const rows = await fns.writeAccountRollups(deps.ch, this.ranges, accounts, day, day, { signal: run.tick.signal });
      const next = accounts.flatMap((account) => {
        const state = run.states.get(account);
        return state === undefined ? [] : [{ ...state, rolledThrough: day }];
      });
      await fns.writeRollupStates(deps.ch, next, { signal: run.tick.signal });
      for (const state of next) run.states.set(state.account, state);
      for (const account of accounts) {
        this.backoff.done(`inc/${account}`);
        this.solo.delete(account);
      }
      deps.logger.debug(`account_rollups: ${day}: ${who}: ${rows} row(s)`);
    } catch (err) {
      this.fail(
        run,
        err,
        ` rolling ${who} on ${day}`,
        accounts.map((account) => `inc/${account}`),
      );
      if (!deps.closing() && accounts.length > 1) for (const account of accounts) this.solo.add(account);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // 3. the promotion
  // -------------------------------------------------------------------------------------------------------------------

  /** Whether the coverage of an account has to grow: it has none and has a day to cover, or it does not reach its first day. */
  private needsPromotion(state: RollupState, through: string): boolean {
    return hasCoverage(state) ? state.rolledFrom > state.firstDay : state.firstDay <= through;
  }

  private async promote(run: Run): Promise<void> {
    const { deps } = this;
    // the accounts without coverage first, then the one that is covered back the least
    const order = (a: RollupState, b: RollupState): number => {
      const [x, y] = [a.rolledFrom ?? '9999-12-31', b.rolledFrom ?? '9999-12-31'];
      return x !== y ? (x < y ? 1 : -1) : a.account < b.account ? -1 : 1;
    };
    for (;;) {
      const pending = [...run.states.values()]
        .filter(
          (s) =>
            this.needsPromotion(s, run.through) &&
            !run.deferred.has(s.account) &&
            !this.backoff.waiting(`promo/${s.account}`, deps.clock()),
        )
        .sort(order);
      if (pending.length === 0) return;
      for (const state of pending) {
        if (!this.mayStart(run)) return;
        await this.promoteOne(run, state);
      }
    }
  }

  /**
   * One slice of an account, and its state after it. The rollup is written first and the state only when it worked, so that a
   * state never claims days that are not there. A failure is logged and counted, and the account is made to wait; a slice that
   * has to wait for the count of a partition (`sliceOf`) is neither, and is the next run's.
   */
  private async promoteOne(run: Run, state: RollupState): Promise<void> {
    const { deps, fns } = this;
    const { account } = state;
    // an account with coverage goes on from the day before it; one without starts at the newest final day
    const throughDay = hasCoverage(state) ? isoDay((utcDayStart(state.rolledFrom) - UTC_DAY_MS) / 1000) : run.through;
    let slice: Slice | undefined;
    try {
      slice = await this.sliceOf(run, state, throughDay);
      if (slice === undefined) {
        run.deferred.add(account);
        deps.logger.debug(`account_rollups: ${account}: waits for the count of the partition of ${throughDay}`);
        return;
      }
      const rows = await fns.writeAccountRollups(deps.ch, this.ranges, [account], slice.fromDay, slice.throughDay, {
        signal: run.tick.signal,
      });
      const next: RollupState = {
        ...state,
        rolledFrom: slice.fromDay,
        rolledThrough: hasCoverage(state) ? state.rolledThrough : slice.throughDay,
      };
      await fns.writeRollupStates(deps.ch, [next], { signal: run.tick.signal });
      run.states.set(account, next);
      this.backoff.done(`promo/${account}`);
      deps.logger.debug(`account_rollups: ${account}: ${slice.fromDay} - ${slice.throughDay}: ${rows} row(s)`);
    } catch (err) {
      const days = slice === undefined ? '' : ` (${slice.fromDay} - ${slice.throughDay})`;
      this.fail(run, err, ` promoting ${account}${days}`, [`promo/${account}`]);
    }
  }

  /**
   * The next slice of an account backwards from `throughDay`, which is about the rows of ONE partition, the one of the newest
   * ledger that closed before the end of `throughDay`, and stays inside it:
   *  - with the count of the account in that partition, as many whole days as hold about 2,000,000 rows at the rows per day of
   *    the partition (`promotionSlice`), but never before the first day of the partition (the count says nothing of the older
   *    ones, which may hold far more);
   *  - without a count (the account is under `ACCOUNT_PARTITION_ROWS_FLOOR` in the partition), the rest of the partition, which
   *    holds less than that by definition;
   *  - both are bounded below by the first day of the account;
   *  - no ledger closed before the end of the day: nothing is older, so the days down to the first day of the account are
   *    the slice (they have no rows in the rollups or in the raw rows, and the write of them reads none);
   *  - the partition has no set yet: undefined. Its count of the account is not known; the discovery counts it (it is due),
   *    and the promotion waits, with no error and no wait of its own.
   */
  private async sliceOf(run: Run, state: RollupState, throughDay: string): Promise<Slice | undefined> {
    const partition = await this.partitionOfDay(run, throughDay);
    if (partition === undefined) return { fromDay: state.firstDay, throughDay };
    if (!run.partitionVersions.has(partition)) return undefined;
    const partitionStart = (await this.firstDayOf(run, partition)) ?? state.firstDay;
    const floorDay = partitionStart > state.firstDay ? partitionStart : state.firstDay;
    const rows = (await this.rowsOf(run, state.account)).get(partition);
    if (rows === undefined) return { fromDay: floorDay, throughDay };
    const { fromDay } = promotionSlice({
      firstDay: state.firstDay,
      throughDay,
      rowsPerDay: rows / (await this.daysOf(run, partition)),
    });
    return { fromDay: fromDay > floorDay ? fromDay : floorDay, throughDay };
  }

  /** The partition of `balance_changes` of the newest ledger that closed before the end of a day; none when there is none. */
  private async partitionOfDay(run: Run, day: string): Promise<number | undefined> {
    if (!run.partitionOfDay.has(day)) {
      const range = await this.ranges(new Date(0), new Date(utcDayStart(day) + UTC_DAY_MS));
      run.partitionOfDay.set(day, range === null ? undefined : partitionOf(range.max));
    }
    return run.partitionOfDay.get(day);
  }

  private async firstDayOf(run: Run, partition: number): Promise<string | undefined> {
    if (!run.firstDayOfPartition.has(partition)) {
      run.firstDayOfPartition.set(partition, await this.fns.partitionFirstDay(this.deps.ch, partition));
    }
    return run.firstDayOfPartition.get(partition);
  }

  private async rowsOf(run: Run, account: string): Promise<Map<number, number>> {
    let rows = run.rowsOfAccount.get(account);
    if (rows === undefined) {
      rows = await this.fns.accountPartitionRows(this.deps.ch, account);
      run.rowsOfAccount.set(account, rows);
    }
    return rows;
  }

  private async daysOf(run: Run, partition: number): Promise<number> {
    let days = run.daysOfPartition.get(partition);
    if (days === undefined) {
      days = await this.fns.partitionDays(this.deps.ch, partition);
      run.daysOfPartition.set(partition, days);
    }
    return days;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // 4. the gauges, and what the steps share
  // -------------------------------------------------------------------------------------------------------------------

  /** The heavy accounts, and those whose coverage does not reach from the first day to the newest final day. */
  private report(run: Run, heavy: Map<string, number>): void {
    const pending = [...heavy.keys()].filter((account) => {
      const state = run.states.get(account);
      if (state === undefined) return true;
      // an account whose first day is not over yet has nothing to cover
      if (state.firstDay > run.through) return false;
      return !hasCoverage(state) || state.rolledFrom > state.firstDay || state.rolledThrough < run.through;
    });
    this.deps.metrics?.accountRollupsHeavyAccounts.set(heavy.size);
    this.deps.metrics?.accountRollupsPendingAccounts.set(pending.length);
    // an account that failed or waits is still pending, so the back-fill is not done while one does
    if (pending.length === 0) this.announceBackfill(false, 0);
  }

  /** Says once that the promotion back-fill is under way (and how many accounts wait for it), and once that it is done. */
  private announceBackfill(under: boolean, accounts: number): void {
    if (under && !this.backfilling) {
      this.backfilling = true;
      this.deps.logger.log(`Account-rollups back-fill: ${accounts} heavy account(s) to cover, newest days first`);
    } else if (!under && this.backfilling) {
      this.backfilling = false;
      this.deps.logger.log(
        'Account-rollups back-fill is done: every heavy account is covered from its first day to the newest final day',
      );
    }
  }

  /** Whether the run may start another set: fewer than 3 failed, and the gate (the shutdown, the deadline) says so. */
  private mayStart(run: Run): boolean {
    return run.failed < MAX_FAILED_AGGREGATE_SETS_PER_TICK && this.gate.mayStart(run.tick.deadline);
  }

  /** A set failed: logged and counted, and the keys of what was in it made to wait (not after the shutdown, which aborted it). */
  private fail(run: Run, err: unknown, where: string, keys: string[]): void {
    const { deps } = this;
    run.failed++;
    deps.failed('account_rollups', err, where);
    if (!deps.closing()) for (const key of keys) this.backoff.failed(key, deps.clock());
  }
}

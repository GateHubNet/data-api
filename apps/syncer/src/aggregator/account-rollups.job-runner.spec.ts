import { ACCOUNT_ROLLUP_CONFIG_VERSION, LedgerRangeOf, RatesService, RollupState } from '@gatehub/data-api-shared';
import { DAY, fakeDeps, FakeDeps, HOUR, NOW, unix } from '../../test/aggregate-job-fakes';
import { ACCOUNT_ROLLUPS_BATCH_ACCOUNTS, AccountRollupsJobRunner } from './account-rollups.job-runner';
import { AGGREGATE_MAX_RETRY_MS, AGGREGATE_RETRY_MS, AggregateFunctions } from './aggregate-job-deps';

const NOW_SECONDS = NOW.getTime() / 1000;
const MIN_ROWS = 1_000_000;
/** The newest final day of NOW: yesterday (its set is final once a ledger of 01:00 or later is there). */
const THROUGH = '2026-10-15';

/**
 * A chain with one ledger every 4 seconds from 2026-01-01T00:00:00Z, the first with index 5,000,000: ledger 10,000,000, the
 * start of partition 1 of `balance_changes`, closes on 2026-08-20 at 11:33:20. The newest ledger is `world.newest`.
 */
const T0 = unix('2026-01-01T00:00:00Z');
const FIRST_LEDGER = 5_000_000;
const ledgerAt = (seconds: number): number => FIRST_LEDGER + Math.ceil((seconds - T0) / 4);

interface RollupCall {
  accounts: string[];
  from: string;
  through: string;
  signal?: AbortSignal;
  ranges: LedgerRangeOf;
  ch: unknown;
}

/**
 * The shared functions of `account_rollups` as the runner calls them, over a small world: the partition sets, the heavy accounts,
 * the state rows (a write replaces them, so that the next run reads what this one wrote), the partition counts of the accounts
 * and the days of the partitions. Every write records its call; the writes that take a ledger range or do real work take
 * `callMs` of the fake clock, and throw for the accounts and partitions in `failing`.
 */
class FakeRollups {
  newest: number | undefined = NOW_SECONDS - 3;
  /** The version (ms) of the newest set of each partition: fresh by default, so that no partition is due. */
  partitionVersions = new Map<number, number>([
    [0, NOW.getTime() - HOUR * 1000],
    [1, NOW.getTime() - HOUR * 1000],
  ]);
  heavy = new Map<string, number>();
  states = new Map<string, RollupState>();
  firstDays = new Map<string, string>();
  /** `accountPartitionRows`: account -> partition -> rows. */
  partitionRows = new Map<string, Map<number, number>>();
  daysOfPartition = new Map<number, number>();
  failingAccounts = new Set<string>();
  failingPartitions = new Set<number>();
  callMs = 0;
  onRollup?: (accounts: string[]) => void;

  recounts: number[] = [];
  recountSignals: Array<AbortSignal | undefined> = [];
  rollups: RollupCall[] = [];
  stateWrites: RollupState[][] = [];
  heavyReads: number[] = [];
  partitionRowReads: string[] = [];
  partitionDaysReads: number[] = [];
  firstDayReads: string[] = [];
  newestReads = 0;
  versionReads = 0;

  /** A heavy account; `state` fills its state row (the current config version, from 2025-01-01). */
  heavyAccount(account: string, state?: Partial<RollupState> | null, rows = 2_000_000): void {
    this.heavy.set(account, rows);
    if (state !== null) {
      this.states.set(account, {
        account,
        rows,
        firstDay: '2025-01-01',
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
        ...state,
      });
    }
  }

  setPartitionRows(account: string, rows: Record<number, number>): void {
    this.partitionRows.set(account, new Map(Object.entries(rows).map(([p, n]) => [Number(p), n])));
  }

  fns(): Partial<AggregateFunctions> {
    return {
      newestLedgerClose: async () => {
        this.newestReads++;
        return this.newest;
      },
      partitionSetVersions: async () => {
        this.versionReads++;
        return new Map(this.partitionVersions);
      },
      recountPartition: async (_ch, partition, options) => {
        this.recounts.push(partition);
        this.recountSignals.push(options?.signal);
        if (this.callMs > 0) jest.setSystemTime(Date.now() + this.callMs);
        if (this.failingPartitions.has(partition)) throw new Error('memory limit');
        this.partitionVersions.set(partition, Date.now());
        return 7;
      },
      heavyAccounts: async (_ch, minRows) => {
        this.heavyReads.push(minRows);
        return new Map(this.heavy);
      },
      rollupStates: async () => new Map([...this.states].map(([a, s]) => [a, { ...s }])),
      writeRollupStates: async (_ch, states) => {
        this.stateWrites.push(states.map((s) => ({ ...s })));
        for (const s of states) this.states.set(s.account, { ...s });
      },
      firstChangeDay: async (_ch, account) => {
        this.firstDayReads.push(account);
        return this.firstDays.get(account);
      },
      accountPartitionRows: async (_ch, account) => {
        this.partitionRowReads.push(account);
        return new Map(this.partitionRows.get(account) ?? []);
      },
      partitionDays: async (_ch, partition) => {
        this.partitionDaysReads.push(partition);
        return this.daysOfPartition.get(partition) ?? 100;
      },
      writeAccountRollups: async (ch, ranges, accounts, from, through, options) => {
        this.rollups.push({ accounts, from, through, signal: options?.signal, ranges, ch });
        this.onRollup?.(accounts);
        if (this.callMs > 0) jest.setSystemTime(Date.now() + this.callMs);
        if (accounts.some((a) => this.failingAccounts.has(a))) throw new Error('memory limit');
        return 11;
      },
    };
  }

  /** The calls to `writeAccountRollups` as `[accounts, from, through]`. */
  calls(): Array<[string[], string, string]> {
    return this.rollups.map((c) => [c.accounts, c.from, c.through]);
  }

  /** How many calls to `writeAccountRollups` included the account. */
  attempts(account: string): number {
    return this.rollups.filter((c) => c.accounts.includes(account)).length;
  }

  clear(): void {
    this.recounts = [];
    this.rollups = [];
    this.stateWrites = [];
  }
}

/** The ledgers of a window of time on the chain above, up to the newest one, as `RatesService.ledgersClosedIn` gives them. */
function fakeRates(world: FakeRollups): RatesService & { ledgersClosedIn: jest.Mock } {
  const ledgersClosedIn = jest.fn(async (from: Date, toExclusive: Date) => {
    const first = Math.max(from.getTime() / 1000, T0);
    const before = Math.min(toExclusive.getTime() / 1000, (world.newest ?? 0) + 1);
    if (first >= before) return null;
    return { min: ledgerAt(first), max: ledgerAt(before) - 1 };
  });
  return { nativeCurrency: 'XRP', ledgersClosedIn } as unknown as RatesService & { ledgersClosedIn: jest.Mock };
}

const accountName = (i: number): string => `rAccount${String(i).padStart(4, '0')}`;

/** The ledger ranges a call was given are those of `rates.ledgersClosedIn`: it asks it, with the same window, and answers what it did. */
async function expectRangesOfRates(ranges: LedgerRangeOf, rates: { ledgersClosedIn: jest.Mock }): Promise<void> {
  const from = new Date('2026-10-14T00:00:00Z');
  const to = new Date('2026-10-15T00:00:00Z');
  rates.ledgersClosedIn.mockClear();
  rates.ledgersClosedIn.mockResolvedValueOnce({ min: 7, max: 9 });
  expect(await ranges(from, to)).toEqual({ min: 7, max: 9 });
  expect(rates.ledgersClosedIn).toHaveBeenCalledTimes(1);
  expect(rates.ledgersClosedIn).toHaveBeenCalledWith(from, to);
}

describe('AccountRollupsJobRunner', () => {
  let fake: FakeDeps;
  let world: FakeRollups;
  let rates: ReturnType<typeof fakeRates>;
  let minRows: number;

  const runner = (deps = fake.deps): AccountRollupsJobRunner =>
    new AccountRollupsJobRunner(deps, { rates, accountRollupMinRows: minRows }, world.fns());
  /** One run of the job, as the aggregator does it. */
  const run = (r: AccountRollupsJobRunner): Promise<void> => r.job().run(fake.tick());
  const minutes = (n: number): number => n * 60_000;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fake = fakeDeps({ budgetMs: 8000 });
    world = new FakeRollups();
    rates = fakeRates(world);
    minRows = MIN_ROWS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the job account_rollups, with the budget of its deps; and a call of the job writes 500 accounts at most', () => {
    const job = new AccountRollupsJobRunner(
      fakeDeps({ budgetMs: 1234 }).deps,
      { rates, accountRollupMinRows: MIN_ROWS },
      world.fns(),
    ).job();
    expect(job.name).toBe('account_rollups');
    expect(job.budgetMs).toBe(1234);
    expect(ACCOUNT_ROLLUPS_BATCH_ACCOUNTS).toBe(500);
  });

  it('does nothing at all when GH_ACCOUNT_ROLLUP_MIN_ROWS is 0', async () => {
    minRows = 0;
    world.heavyAccount('rA', { rolledFrom: '2026-10-01', rolledThrough: '2026-10-14' });
    world.partitionVersions.clear(); // partitions that would be due
    const r = runner();
    await run(r);
    await r.ofSlice(unix('2026-10-12T05:00:00Z'), unix('2026-10-12T09:00:00Z'), fake.tick());
    expect(world.newestReads).toBe(0);
    expect(world.versionReads).toBe(0);
    expect(world.heavyReads).toEqual([]);
    expect(world.recounts).toEqual([]);
    expect(world.stateWrites).toEqual([]);
    expect(world.rollups).toEqual([]);
    expect(rates.ledgersClosedIn).not.toHaveBeenCalled();
    expect(fake.metrics.accountRollupsHeavyAccounts.set).not.toHaveBeenCalled();
    expect(fake.metrics.accountRollupsPendingAccounts.set).not.toHaveBeenCalled();
    expect(fake.logger.warn).not.toHaveBeenCalled();
  });

  describe('discovery', () => {
    it('recounts the partition of the newest ledger when its set is over 24 h old, every other partition over 7 days old, and one marked by ofSlice', async () => {
      const r = runner();
      // exactly 24 h and exactly 7 days are not over
      world.partitionVersions.set(1, NOW.getTime() - 24 * HOUR * 1000);
      world.partitionVersions.set(0, NOW.getTime() - 7 * DAY * 1000);
      await run(r);
      expect(world.recounts).toEqual([]);
      // the heavy accounts are those of the minimum the runner was given
      expect(world.heavyReads).toEqual([MIN_ROWS]);

      // a millisecond over: the newest partition, then the other one (newest first); each with the signal of the tick
      world.partitionVersions.set(1, NOW.getTime() - 24 * HOUR * 1000 - 1);
      world.partitionVersions.set(0, NOW.getTime() - 7 * DAY * 1000 - 1);
      await run(r);
      expect(world.recounts).toEqual([1, 0]);
      expect(world.recountSignals).toEqual([fake.abort.signal, fake.abort.signal]);

      // their sets are new now: nothing is due
      world.clear();
      await run(r);
      expect(world.recounts).toEqual([]);

      // an older partition is not due at a day old, the newest is
      world.partitionVersions.set(0, NOW.getTime() - 3 * DAY * 1000);
      world.partitionVersions.set(1, NOW.getTime() - 25 * HOUR * 1000);
      await run(r);
      expect(world.recounts).toEqual([1]);
    });

    it('recounts a partition that has no set, newest first, and one that ofSlice marked, once', async () => {
      const r = runner();
      world.partitionVersions.clear();
      await run(r);
      expect(world.recounts).toEqual([1, 0]);

      // a slice of day X marks the partition of its ledgers: 2026-07-01 is in partition 0
      world.clear();
      await r.ofSlice(unix('2026-07-01T05:00:00Z'), unix('2026-07-01T06:00:00Z'), fake.tick());
      await run(r);
      expect(world.recounts).toEqual([0]);
      world.clear();
      await run(r);
      expect(world.recounts).toEqual([]);

      // a slice across the boundary between the partitions marks both
      await r.ofSlice(unix('2026-08-20T11:00:00Z'), unix('2026-08-20T12:00:00Z'), fake.tick());
      await run(r);
      expect(world.recounts).toEqual([1, 0]);
    });

    it('a partition that fails is logged and counted as account_rollups, waits 5 min doubling to 1 h, and the others go on', async () => {
      world.partitionVersions.clear();
      world.failingPartitions.add(1);
      world.heavyAccount('rA', { rolledFrom: '2025-01-01', rolledThrough: '2026-10-14' });
      const r = runner();
      await run(r);
      expect(world.recounts).toEqual([1, 0]);
      expect(fake.failures).toHaveLength(1);
      expect(fake.failures[0].job).toBe('account_rollups');
      expect(fake.failures[0].where).toContain('partition 1');
      expect((fake.failures[0].err as Error).message).toBe('memory limit');
      // the rest of the run went on: the account was rolled to the newest final day
      expect(world.calls()).toEqual([[['rA'], THROUGH, THROUGH]]);

      expect(AGGREGATE_RETRY_MS).toBe(minutes(5));
      expect(AGGREGATE_MAX_RETRY_MS).toBe(minutes(60));
      let failedAt = Date.now();
      let attempts = 1;
      for (const wait of [5, 10, 20, 40, 60, 60]) {
        jest.setSystemTime(failedAt + minutes(wait) - 1);
        await run(r);
        expect(world.recounts.filter((p) => p === 1)).toHaveLength(attempts); // still waiting
        jest.setSystemTime(failedAt + minutes(wait));
        await run(r);
        expect(world.recounts.filter((p) => p === 1)).toHaveLength(++attempts);
        failedAt += minutes(wait);
      }
      // partition 0 was recounted once: its new set is not due
      expect(world.recounts.filter((p) => p === 0)).toHaveLength(1);

      world.failingPartitions.clear();
      jest.setSystemTime(failedAt + minutes(60));
      await run(r);
      expect(world.recounts.filter((p) => p === 1)).toHaveLength(attempts + 1);
      await run(r);
      expect(world.recounts.filter((p) => p === 1)).toHaveLength(attempts + 1);
    });

    it('a new heavy account gets a state row with its first_day and no coverage; one that is no longer heavy loses its coverage; a state of another config version counts as uncovered', async () => {
      // new: no state yet
      world.heavyAccount('rNew', null, 3_000_000);
      world.firstDays.set('rNew', '2026-09-10');
      world.setPartitionRows('rNew', { 1: 10_000 });
      // heavy and covered to the end, its count grew
      world.heavyAccount('rCovered', { rows: 1_500_000, rolledFrom: '2025-01-01', rolledThrough: THROUGH }, 2_000_000);
      // heavy, covered, unchanged: not written
      world.heavyAccount('rSame', { rolledFrom: '2025-01-01', rolledThrough: THROUGH });
      // of another config version: its coverage does not count
      world.heavyAccount(
        'rOld',
        { configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION - 1, rolledFrom: '2025-01-01', rolledThrough: THROUGH },
        1_200_000,
      );
      world.setPartitionRows('rOld', { 1: 10_000 });
      // no longer heavy (the setting was raised): it has coverage still, and loses it
      world.states.set('rDemoted', {
        account: 'rDemoted',
        rows: 900_000,
        firstDay: '2025-03-03',
        rolledFrom: '2025-04-01',
        rolledThrough: '2026-10-01',
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      });
      // not heavy and without coverage: left alone
      world.states.set('rQuiet', {
        account: 'rQuiet',
        rows: 10,
        firstDay: '2025-03-03',
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      });

      await run(runner());

      // the discovery wrote its changes in one insert (the writes of the promotions come after it)
      const byAccount = (a: RollupState, b: RollupState): number => (a.account < b.account ? -1 : 1);
      expect([...world.stateWrites[0]].sort(byAccount)).toEqual([
        {
          account: 'rCovered',
          rows: 2_000_000,
          firstDay: '2025-01-01',
          rolledFrom: '2025-01-01',
          rolledThrough: THROUGH,
          configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
        },
        { account: 'rDemoted', rows: 900_000, firstDay: '2025-03-03', configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION },
        { account: 'rNew', rows: 3_000_000, firstDay: '2026-09-10', configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION },
        { account: 'rOld', rows: 1_200_000, firstDay: '2025-01-01', configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION },
      ]);
      // the first day of an account is read once, when it is new
      expect(world.firstDayReads).toEqual(['rNew']);
      // the uncovered accounts (the new one, and the one of the old config) are promoted from the newest final day; the covered ones not
      expect(world.calls()).toEqual([
        [['rNew'], '2026-09-10', THROUGH],
        [['rOld'], '2025-01-01', THROUGH],
      ]);
      expect(world.states.get('rOld')).toMatchObject({ rolledFrom: '2025-01-01', rolledThrough: THROUGH });
      expect(world.states.get('rDemoted')?.rolledFrom).toBeUndefined();

      // the next run has nothing to write: every state is as discovery wants it
      world.clear();
      await run(runner());
      expect(world.stateWrites).toEqual([]);
      expect(world.rollups).toEqual([]);
      expect(world.firstDayReads).toEqual(['rNew']);
    });

    it('leaves a heavy account whose first day is not known yet to the next run, and counts it pending', async () => {
      world.heavyAccount('rNoDay', null);
      world.heavyAccount('rHasDay', { rolledFrom: '2025-01-01', rolledThrough: THROUGH });
      await run(runner());
      expect(world.stateWrites).toEqual([]);
      expect(world.rollups).toEqual([]);
      expect(fake.metrics.accountRollupsHeavyAccounts.set).toHaveBeenLastCalledWith(2);
      expect(fake.metrics.accountRollupsPendingAccounts.set).toHaveBeenLastCalledWith(1);
    });

    it('does nothing, and says there are no heavy accounts, while the database has no ledger', async () => {
      world.newest = undefined;
      await run(runner());
      expect(world.heavyReads).toEqual([]);
      expect(world.recounts).toEqual([]);
      expect(fake.metrics.accountRollupsHeavyAccounts.set).toHaveBeenLastCalledWith(0);
      expect(fake.metrics.accountRollupsPendingAccounts.set).toHaveBeenLastCalledWith(0);
    });
  });

  describe('the daily increment', () => {
    it('for each final day d after rolled_through, oldest first, rolls together the heavy accounts whose rolled_through is d − 1, then writes rolled_through = d', async () => {
      // rLag is three days behind; rA, rB and rC were rolled through the day before the newest final day; each is covered
      // back to its first day
      const firstDay: Record<string, string> = {
        rLag: '2025-06-01',
        rC: '2025-01-01',
        rA: '2025-02-02',
        rB: '2025-03-03',
      };
      const rolledThrough: Record<string, string> = {
        rLag: '2026-10-12',
        rC: '2026-10-14',
        rA: '2026-10-14',
        rB: '2026-10-14',
      };
      for (const account of Object.keys(firstDay)) {
        world.heavyAccount(account, {
          firstDay: firstDay[account],
          rolledFrom: firstDay[account],
          rolledThrough: rolledThrough[account],
        });
      }
      // an account that is rolled to the end already, and one that has no coverage and nothing to promote (its first day is today)
      world.heavyAccount('rDone', { rolledFrom: '2025-01-01', rolledThrough: THROUGH });
      world.heavyAccount('rToday', { firstDay: '2026-10-16' });

      await run(runner());

      expect(world.calls()).toEqual([
        [['rLag'], '2026-10-13', '2026-10-13'],
        [['rLag'], '2026-10-14', '2026-10-14'],
        // rLag has caught up: it is rolled together with the others (the accounts are sorted)
        [['rA', 'rB', 'rC', 'rLag'], THROUGH, THROUGH],
      ]);
      // each call has the signal of the tick, the database, and the ledger ranges of the network's rates
      expect(world.rollups.every((c) => c.signal === fake.abort.signal && c.ch === fake.deps.ch)).toBe(true);
      await expectRangesOfRates(world.rollups[0].ranges, rates);

      // the state rows are written after each call, with rolled_through = d and the rest of the state as it was
      const stateOf = (account: string, through: string): RollupState => ({
        account,
        rows: 2_000_000,
        firstDay: firstDay[account],
        rolledFrom: firstDay[account],
        rolledThrough: through,
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      });
      expect(world.stateWrites).toEqual([
        [stateOf('rLag', '2026-10-13')],
        [stateOf('rLag', '2026-10-14')],
        ['rA', 'rB', 'rC', 'rLag'].map((account) => stateOf(account, THROUGH)),
      ]);

      // the next run has nothing to roll
      world.clear();
      await run(runner());
      expect(world.rollups).toEqual([]);
    });

    it('rolls nothing on a day that is not final: the newest final day is yesterday only once the ingest has passed it', async () => {
      world.heavyAccount('rA', { rolledFrom: '2025-01-01', rolledThrough: '2026-10-14' });
      world.newest = unix('2026-10-16T00:59:59Z');
      await run(runner());
      expect(world.rollups).toEqual([]);

      world.newest = unix('2026-10-16T01:00:00Z');
      await run(runner());
      expect(world.calls()).toEqual([[['rA'], THROUGH, THROUGH]]);
    });

    it('writes at most 500 accounts a call: more are split into several calls, each with its own states', async () => {
      const accounts = Array.from({ length: 1200 }, (_, i) => accountName(i));
      for (const account of accounts)
        world.heavyAccount(account, { rolledFrom: '2025-01-01', rolledThrough: '2026-10-14' });
      await run(runner());
      expect(world.rollups.map((c) => c.accounts.length)).toEqual([500, 500, 200]);
      expect(world.rollups.flatMap((c) => c.accounts)).toEqual(accounts);
      expect(world.rollups.every((c) => c.from === THROUGH && c.through === THROUGH)).toBe(true);
      expect(world.stateWrites.map((s) => s.length)).toEqual([500, 500, 200]);
      expect(world.stateWrites.flat().every((s) => s.rolledThrough === THROUGH)).toBe(true);
    });

    it('a call that fails backs its accounts off and they are tried alone after, so that one bad account does not keep the rest', async () => {
      const accounts = ['rA1', 'rA2', 'rA3', 'rA4'];
      for (const account of accounts)
        world.heavyAccount(account, { rolledFrom: '2025-01-01', rolledThrough: '2026-10-14' });
      world.failingAccounts.add('rA3');
      const r = runner();

      await run(r);
      expect(world.calls()).toEqual([[accounts, THROUGH, THROUGH]]);
      expect(fake.failures).toHaveLength(1);
      expect(fake.failures[0].job).toBe('account_rollups');
      expect(fake.failures[0].where).toContain('2026-10-15');
      expect(world.stateWrites).toEqual([]);

      // they wait 5 minutes
      jest.setSystemTime(Date.now() + minutes(5) - 1);
      await run(r);
      expect(world.rollups).toHaveLength(1);

      // then each is a call of its own; the good ones are rolled, the bad one fails alone
      world.clear();
      jest.setSystemTime(Date.now() + 1);
      await run(r);
      expect(world.calls()).toEqual(accounts.map((a) => [[a], THROUGH, THROUGH]));
      expect(world.stateWrites.map((s) => s.map((x) => x.account))).toEqual([['rA1'], ['rA2'], ['rA4']]);
      expect(fake.failures).toHaveLength(2);

      // the bad one doubles its wait (10 min); the others are done
      world.clear();
      jest.setSystemTime(Date.now() + minutes(10) - 1);
      await run(r);
      expect(world.rollups).toEqual([]);
      jest.setSystemTime(Date.now() + 1);
      await run(r);
      expect(world.calls()).toEqual([[['rA3'], THROUGH, THROUGH]]);

      // it works at last, and the next run has nothing to do
      world.failingAccounts.clear();
      world.clear();
      jest.setSystemTime(Date.now() + minutes(20));
      await run(r);
      expect(world.calls()).toEqual([[['rA3'], THROUGH, THROUGH]]);
      expect(world.states.get('rA3')?.rolledThrough).toBe(THROUGH);
      world.clear();
      await run(r);
      expect(world.rollups).toEqual([]);
    });
  });

  describe('the promotion', () => {
    it("an uncovered account starts at the newest final day; a covered one gets its next slice backwards (promotionSlice from its partition's rows per day) until rolled_from is first_day", async () => {
      // partition 1 holds the days from 2026-08-20, partition 0 the ones before; each count is of the account in the partition
      world.daysOfPartition.set(1, 40);
      world.daysOfPartition.set(0, 300);
      // uncovered, 8M rows over 40 days of partition 1: 200,000 a day, 10 days a slice
      world.heavyAccount('rU', { firstDay: '2026-09-10' });
      world.setPartitionRows('rU', { 1: 8_000_000 });
      // covered from 2026-09-01: its next slice ends on 08-31 (partition 1, 10 days), then 08-21 (partition 1), then 08-11 (partition 0: 3M rows over 300 days, 200 days a slice)
      world.heavyAccount('rV1', { firstDay: '2026-07-01', rolledFrom: '2026-09-01', rolledThrough: THROUGH });
      world.setPartitionRows('rV1', { 1: 8_000_000, 0: 3_000_000 });
      // covered from 2026-08-05: it gets all it lacks in one slice (partition 0)
      world.heavyAccount('rV2', { firstDay: '2026-07-01', rolledFrom: '2026-08-05', rolledThrough: THROUGH });
      world.setPartitionRows('rV2', { 0: 3_000_000 });
      // covered back to its first day: nothing to do
      world.heavyAccount('rV3', { firstDay: '2026-09-20', rolledFrom: '2026-09-20', rolledThrough: THROUGH });

      await run(runner());

      // a round gives each account one slice: the uncovered first, then the newest rolled_from first
      expect(world.calls()).toEqual([
        [['rU'], '2026-10-06', '2026-10-15'],
        [['rV1'], '2026-08-22', '2026-08-31'],
        [['rV2'], '2026-07-01', '2026-08-04'],
        // round 2: rU (rolled_from 10-06) before rV1 (08-22)
        [['rU'], '2026-09-26', '2026-10-05'],
        [['rV1'], '2026-08-12', '2026-08-21'],
        // round 3
        [['rU'], '2026-09-16', '2026-09-25'],
        [['rV1'], '2026-07-01', '2026-08-11'],
        // round 4: its first day is the end of it
        [['rU'], '2026-09-10', '2026-09-15'],
      ]);
      expect(world.rollups.every((c) => c.signal === fake.abort.signal)).toBe(true);
      // after each slice rolled_from is the slice's first day, and rolled_through that of the first slice (the newest final day)
      const writes = world.stateWrites.map(([s]) => [s.account, s.rolledFrom, s.rolledThrough]);
      expect(writes).toEqual([
        ['rU', '2026-10-06', THROUGH],
        ['rV1', '2026-08-22', THROUGH],
        ['rV2', '2026-07-01', THROUGH],
        ['rU', '2026-09-26', THROUGH],
        ['rV1', '2026-08-12', THROUGH],
        ['rU', '2026-09-16', THROUGH],
        ['rV1', '2026-07-01', THROUGH],
        ['rU', '2026-09-10', THROUGH],
      ]);
      // the rows per day come from the partition of the slice's end, counted once for an account and a partition a run
      expect(world.partitionRowReads.sort()).toEqual(['rU', 'rV1', 'rV2']);
      expect(world.partitionDaysReads.sort()).toEqual([0, 1]);

      world.clear();
      await run(runner());
      expect(world.rollups).toEqual([]);
    });

    it("takes everything back to the first day when the account has no count in the partition of the slice's end", async () => {
      world.heavyAccount('rU', { firstDay: '2025-01-01' }); // no count in any partition
      await run(runner());
      expect(world.calls()).toEqual([[['rU'], '2025-01-01', THROUGH]]);
    });

    it('promotes an account of another config version again from the newest final day', async () => {
      world.setPartitionRows('rOld', { 1: 20_000_000 });
      world.daysOfPartition.set(1, 40); // 500,000 a day: 4 days a slice
      world.heavyAccount('rOld', {
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION - 1,
        firstDay: '2026-10-01',
        rolledFrom: '2026-09-01',
        rolledThrough: '2026-10-14',
      });
      await run(runner());
      // the coverage of the old config is gone: the slice starts at the newest final day, and the first one is the end of the state
      expect(world.calls()).toEqual([
        [['rOld'], '2026-10-12', THROUGH],
        [['rOld'], '2026-10-08', '2026-10-11'],
        [['rOld'], '2026-10-04', '2026-10-07'],
        [['rOld'], '2026-10-01', '2026-10-03'],
      ]);
      expect(world.states.get('rOld')).toMatchObject({
        rolledFrom: '2026-10-01',
        rolledThrough: THROUGH,
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      });
    });

    it('a promotion is a call of one account, whatever the count of the accounts that wait', async () => {
      for (let i = 0; i < 600; i++) world.heavyAccount(accountName(i), { firstDay: '2026-10-14' });
      await run(runner());
      expect(world.rollups).toHaveLength(600);
      expect(world.rollups.every((c) => c.accounts.length === 1)).toBe(true);
    });
  });

  describe('gauges', () => {
    it('sets the heavy and pending gauges', async () => {
      const heavy = fake.metrics.accountRollupsHeavyAccounts.set;
      const pending = fake.metrics.accountRollupsPendingAccounts.set;
      world.heavyAccount('rDone', { rolledFrom: '2025-01-01', rolledThrough: THROUGH }); // reaches from first_day to the end
      world.heavyAccount('rBack', { rolledFrom: '2025-05-01', rolledThrough: THROUGH }); // does not reach first_day
      world.heavyAccount('rNew', { rolledFrom: '2025-01-01', rolledThrough: '2026-10-13' }); // does not reach the newest final day
      world.heavyAccount('rUncovered', {}); // has no coverage
      world.heavyAccount('rToday', { firstDay: '2026-10-16' }); // has no day to cover yet: not pending
      world.states.set('rDemoted', { account: 'rDemoted', rows: 5, firstDay: '2025-01-01', configVersion: 1 }); // not heavy
      // none of them can be worked on: everything fails
      for (const account of ['rBack', 'rNew', 'rUncovered']) world.failingAccounts.add(account);

      const r = runner();
      await run(r);
      expect(heavy).toHaveBeenLastCalledWith(5);
      expect(pending).toHaveBeenLastCalledWith(3);

      // they work after their waits: nothing is pending
      world.failingAccounts.clear();
      jest.setSystemTime(Date.now() + minutes(5));
      await run(r);
      expect(heavy).toHaveBeenLastCalledWith(5);
      expect(pending).toHaveBeenLastCalledWith(0);
    });

    it('counts the accounts the run did not get to as pending, and the heavy ones however the run ended', async () => {
      const pending = fake.metrics.accountRollupsPendingAccounts.set;
      for (let i = 0; i < 10; i++) world.heavyAccount(accountName(i), { firstDay: '2026-10-14' });
      world.callMs = 3000; // the budget is 8 s: three promotions start
      await run(runner());
      expect(world.rollups).toHaveLength(3);
      expect(fake.metrics.accountRollupsHeavyAccounts.set).toHaveBeenLastCalledWith(10);
      expect(pending).toHaveBeenLastCalledWith(7);
    });

    it('runs without metrics', async () => {
      world.heavyAccount('rA', { rolledFrom: '2025-01-01', rolledThrough: '2026-10-14' });
      await run(
        new AccountRollupsJobRunner(
          { ...fake.deps, metrics: undefined },
          { rates, accountRollupMinRows: MIN_ROWS },
          world.fns(),
        ),
      );
      expect(world.rollups).toHaveLength(1);
    });
  });

  describe('ofSlice', () => {
    const ofSlice = (r: AccountRollupsJobRunner, from: string, to: string): Promise<void> =>
      r.ofSlice(unix(from), unix(to), fake.tick());

    it('recomputes (account, day) for the heavy accounts whose coverage holds the day, and marks the partition for the next discovery', async () => {
      world.heavyAccount('rWide', { rolledFrom: '2026-09-01', rolledThrough: THROUGH });
      world.heavyAccount('rNarrow', { rolledFrom: '2026-10-10', rolledThrough: THROUGH });
      world.heavyAccount('rEarly', { rolledFrom: '2026-07-01', rolledThrough: '2026-09-30' }); // does not hold October
      world.heavyAccount('rNone', {}); // no coverage
      world.heavyAccount('rOld', {
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION - 1, // its coverage does not count
        rolledFrom: '2026-01-01',
        rolledThrough: THROUGH,
      });
      const r = runner(); // it has not run: the slice does not depend on a run

      await ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z');
      expect(world.calls()).toEqual([[['rNarrow', 'rWide'], '2026-10-12', '2026-10-12']]);
      expect(world.rollups[0].signal).toBe(fake.abort.signal);
      expect(world.rollups[0].ch).toBe(fake.deps.ch);
      await expectRangesOfRates(world.rollups[0].ranges, rates);
      // the state rows are as they were: the coverage did not change
      expect(world.stateWrites).toEqual([]);

      // a slice across midnight: a call for each day, of the accounts that hold it
      world.clear();
      await ofSlice(r, '2026-10-09T20:00:00Z', '2026-10-10T03:00:00Z');
      expect(world.calls()).toEqual([
        [['rWide'], '2026-10-09', '2026-10-09'],
        [['rNarrow', 'rWide'], '2026-10-10', '2026-10-10'],
      ]);

      // a day that no coverage holds is not recomputed
      world.clear();
      await ofSlice(r, '2026-06-01T00:00:00Z', '2026-06-01T06:00:00Z');
      expect(world.rollups).toEqual([]);

      // the slices marked their partitions, 1 (October) and 0 (June): the next discovery recounts both, newest first, once
      world.heavy.clear();
      world.states.clear();
      await run(r);
      expect(world.recounts).toEqual([1, 0]);
      world.clear();
      await run(r);
      expect(world.recounts).toEqual([]);
    });

    it('writes at most 500 accounts a call', async () => {
      for (let i = 0; i < 1100; i++)
        world.heavyAccount(accountName(i), { rolledFrom: '2026-10-01', rolledThrough: THROUGH });
      await ofSlice(runner(), '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z');
      expect(world.rollups.map((c) => c.accounts.length)).toEqual([500, 500, 100]);
      expect(new Set(world.rollups.flatMap((c) => c.accounts)).size).toBe(1100);
    });

    it('a failure rejects, and neither it nor the accounts are logged, counted or backed off here', async () => {
      world.heavyAccount('rA', { rolledFrom: '2026-10-01', rolledThrough: THROUGH });
      world.failingAccounts.add('rA');
      const r = runner();
      await expect(ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z')).rejects.toThrow('memory limit');
      expect(fake.failures).toEqual([]);
      // the slice is tried again by its caller, at once
      await expect(ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z')).rejects.toThrow('memory limit');
      expect(world.rollups).toHaveLength(2);
      // a failure of the ledger lookup rejects too
      rates.ledgersClosedIn.mockRejectedValueOnce(new Error('timeout'));
      await expect(ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z')).rejects.toThrow('timeout');
    });

    it('starts nothing once closing() is true, and an empty slice recomputes nothing', async () => {
      world.heavyAccount('rA', { rolledFrom: '2026-10-01', rolledThrough: THROUGH });
      const r = runner();
      fake.closing = true;
      await ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T09:00:00Z');
      expect(world.rollups).toEqual([]);
      fake.closing = false;
      await ofSlice(r, '2026-10-12T05:00:00Z', '2026-10-12T05:00:00Z');
      expect(world.rollups).toEqual([]);
    });
  });

  describe('the budget and failures', () => {
    it('stops at its deadline and backs off a failing account', async () => {
      for (let i = 0; i < 9; i++) world.heavyAccount(accountName(i), { firstDay: '2026-10-14' });
      world.failingAccounts.add(accountName(1));
      world.callMs = 3000; // the budget is 8 s: calls start at 0, 3 and 6 s; the fourth would start at 9 s
      const r = runner();
      const budgetWarnings = (): number => fake.logger.warn.mock.calls.filter((c) => /budget/.test(c[0])).length;

      await run(r);
      expect(world.calls().map(([accounts]) => accounts[0])).toEqual([accountName(0), accountName(1), accountName(2)]);
      expect(fake.failures).toHaveLength(1);
      expect(fake.failures[0].job).toBe('account_rollups');
      expect(fake.failures[0].where).toContain(accountName(1));
      expect(budgetWarnings()).toBe(1);
      expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('account_rollups'));

      // the next run: the account that failed waits, and the ones that are left go on
      world.clear();
      jest.setSystemTime(Date.now() + minutes(1));
      await run(r);
      expect(world.calls().map(([accounts]) => accounts[0])).toEqual([accountName(3), accountName(4), accountName(5)]);
      expect(budgetWarnings()).toBe(1); // said once for as long as the runs hit it
      expect(fake.logger.debug).toHaveBeenCalledWith(expect.stringContaining('budget'));

      // then it is tried again after 5 minutes, and doubles its wait
      world.callMs = 0;
      world.clear();
      jest.setSystemTime(Date.now() + minutes(5));
      await run(r);
      expect(world.attempts(accountName(1))).toBe(1);
      expect(fake.failures).toHaveLength(2);
      world.clear();
      jest.setSystemTime(Date.now() + minutes(10) - 1);
      await run(r);
      expect(world.attempts(accountName(1))).toBe(0);
      jest.setSystemTime(Date.now() + 1);
      await run(r);
      expect(world.attempts(accountName(1))).toBe(1);

      expect(AGGREGATE_RETRY_MS).toBe(minutes(5));
      expect(AGGREGATE_MAX_RETRY_MS).toBe(minutes(60));
    });

    it('gives up after 3 failed sets in a run, across its steps', async () => {
      world.partitionVersions.clear();
      world.failingPartitions.add(1);
      world.failingPartitions.add(0);
      for (let i = 0; i < 4; i++) world.heavyAccount(accountName(i), { firstDay: '2026-10-14' });
      world.failingAccounts.add(accountName(0));
      world.failingAccounts.add(accountName(1));
      await run(runner());
      // two partitions, then one account; the run gave up there
      expect(world.recounts).toEqual([1, 0]);
      expect(world.calls().map(([accounts]) => accounts[0])).toEqual([accountName(0)]);
      expect(fake.failures).toHaveLength(3);
    });

    it('starts nothing when the deadline has passed before it reads anything', async () => {
      world.heavyAccount('rA', { firstDay: '2026-10-14' });
      const tick = fake.tick();
      jest.setSystemTime(tick.deadline);
      await runner().job().run(tick);
      expect(world.newestReads).toBe(0);
      expect(world.rollups).toEqual([]);
      expect(fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
    });

    it('starts nothing once closing() is true, and ends a run that was going', async () => {
      for (let i = 0; i < 3; i++) world.heavyAccount(accountName(i), { firstDay: '2026-10-14' });
      fake.closing = true;
      const r = runner();
      await run(r);
      expect(world.newestReads).toBe(0);
      expect(world.rollups).toEqual([]);
      expect(fake.logger.warn).not.toHaveBeenCalled();

      fake.closing = false;
      world.onRollup = () => {
        fake.closing = true;
      };
      await run(r);
      expect(world.rollups).toHaveLength(1);
    });

    it('does not back off a call that the shutdown aborted', async () => {
      world.heavyAccount('rA', { firstDay: '2026-10-14' });
      world.failingAccounts.add('rA');
      world.onRollup = () => {
        fake.closing = true;
      };
      const r = runner();
      await run(r);
      // `failed` is told (it drops what the shutdown aborted), and the account is not made to wait
      expect(fake.failures).toHaveLength(1);

      fake.closing = false;
      world.onRollup = undefined;
      world.failingAccounts.clear();
      await run(r);
      expect(world.attempts('rA')).toBe(2);
    });
  });
});

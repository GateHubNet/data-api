import {
  AccountStatesRow,
  AmmPoolsRow,
  AmmPoolStatesRow,
  ClickHouseService,
  EscrowsRow,
  GenesisMintsRow,
  getNetworkProfile,
  ImportsRow,
  MINT_PARSER_VERSION,
  NetworkStateRow,
  newestSnapshot,
  RatesService,
  RewardClaimsRow,
  runMigrations,
  runSupplyStep,
  startSupplyCycle,
  SUPPLY_INTERVAL_MS,
  SupplyCycle,
  Table,
} from '@gatehub/data-api-shared';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { AGGREGATOR_SUPPLY_BUDGET_MS, AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The `supply` job of the `AggregatorService` against a real ClickHouse, with the real shared functions: the start, the steps and
 * the write of `packages/shared/src/aggregate/supply.job.ts`, the runner that spreads them over ticks, and the sight of the
 * `amm_pools` runner. The tables are seeded by hand (the world of each test is small enough to add up in the test), the clock is a
 * fake one, and a step takes a second of it, so that a cycle of a hundred steps goes over a score of ticks as it would in
 * production. What the shared functions compute is checked against an oracle in `packages/shared/test/supply-job.e2e-spec.ts`; here
 * it is the job that is on trial: the ticks from the start to the row, the cadence of an hour, and the lent sight.
 */

const T0 = 1_760_000_000;
const NOOP = (): void => undefined;

const xahau = getNetworkProfile('xahau');
const xrpl = getNetworkProfile('xrpl');

/** The sentinel of the escrows job, as D5 writes it (every other column empty, 0 or null). */
const sentinel = (
  over: Pick<EscrowsRow, 'amount_drops' | 'open_count' | 'through_ledger' | 'version'>,
): EscrowsRow => ({
  escrow_id: '',
  owner: '',
  destination: '',
  sequence: null,
  currency: '',
  issuer: '',
  amount: '',
  finish_after: null,
  cancel_after: null,
  has_condition: 0,
  created_ledger: null,
  last_ledger: 0,
  deleted: 0,
  ...over,
});

const ledgerRow = (ledger_index: number, over: Record<string, unknown> = {}) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time: T0 + ledger_index,
  total_coins: '99985312374716318',
  parser_version: MINT_PARSER_VERSION,
  ...over,
});

const accountState = (
  account: string,
  ledger_index: number,
  owner_count: number,
  over: Partial<AccountStatesRow> = {},
): AccountStatesRow => ({
  account,
  ledger_index,
  tx_index: 0,
  node_index: 0,
  tx_hash: `${account}-${ledger_index}`,
  close_time: T0 + ledger_index,
  balance: '100',
  flags: 0,
  sequence: 1,
  owner_count,
  fields: '{}',
  deleted: 0,
  ...over,
});

const deletedState = (account: string, ledger_index: number): AccountStatesRow =>
  accountState(account, ledger_index, 0, { deleted: 1 });

const mintRow = (ledger_index: number, amount: number, parent_tx_hash: string): GenesisMintsRow => ({
  ledger_index,
  tx_index: 0,
  mint_index: 0,
  tx_hash: `mint-${ledger_index}`,
  close_time: T0 + ledger_index,
  destination: 'rSyntheticDestination',
  amount,
  parent_tx_hash,
  emit_hook_hash: parent_tx_hash === '' ? '' : 'AAAA',
});

const claimRow = (ledger_index: number, tx_hash: string, over: Partial<RewardClaimsRow> = {}): RewardClaimsRow => ({
  ledger_index,
  tx_index: 0,
  tx_hash,
  close_time: T0 + ledger_index,
  account: 'rSyntheticClaimer',
  issuer: '',
  opt_out: 0,
  ...over,
});

const importRow = (ledger_index: number, minted: number): ImportsRow => ({
  ledger_index,
  tx_index: 0,
  tx_hash: `import-${ledger_index}`,
  close_time: T0 + ledger_index,
  account: 'rSyntheticImporter',
  minted,
  account_created: 0,
});

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

const pool = (account: string, over: Partial<AmmPoolsRow> = {}): AmmPoolsRow => ({
  amm_account: account,
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  lp_currency: null,
  created_ledger: null,
  created_by: null,
  last_ledger: 100,
  reserve_base: '10',
  reserve_counter: '5',
  lp_supply: null,
  trading_fee: null,
  auction_holder: null,
  auction_price: null,
  auction_discounted_fee: null,
  auction_expiration: null,
  deleted: 0,
  value_native: null,
  version: 1,
  ...over,
});

const ammState = (amm_account: string, ledger_index: number, over: Partial<AmmPoolStatesRow>): AmmPoolStatesRow => ({
  amm_account,
  ledger_index,
  tx_index: 0,
  tx_hash: `${amm_account}-${ledger_index}`,
  close_time: T0 + ledger_index,
  tx_type: 'AMMDeposit',
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  reserve_base: '10',
  reserve_counter: '5',
  lp_supply: null,
  lp_currency: null,
  reserve_base_f: null,
  reserve_counter_f: null,
  lp_supply_f: null,
  trading_fee: null,
  auction_holder: null,
  auction_price: null,
  auction_price_f: null,
  auction_discounted_fee: null,
  auction_expiration: null,
  deleted: 0,
  ...over,
});

/** The fake metrics of the aggregator and of the supply job: what is set and counted is read from the mocks. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  supplySnapshotAgeSeconds: { set: jest.fn() },
  supplyCycleSeconds: { set: jest.fn() },
});
type FakeMetrics = ReturnType<typeof fakeMetrics>;

/** The values a gauge was set to, in order. */
const valuesOf = (gauge: { set: jest.Mock }): number[] => gauge.set.mock.calls.map(([value]) => value);

describe('AggregatorService supply job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_supply_${++dbCounter}` };
    await runMigrations({ config, log: NOOP });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /**
   * The aggregator with the supply job and, of the stats, only the walk from ledger to ledger (they have their own tests). The
   * clock is a fake one, in milliseconds, which a test moves and which a step of the cycle moves on by a second; the cycles the
   * start made, and the steps run, are noted.
   */
  function aggregator(
    ch: ClickHouseService,
    start: number,
    options: Partial<ConstructorParameters<typeof AggregatorService>[3]> = {},
  ) {
    const metrics = fakeMetrics();
    const logs = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const clock = { ms: start * 1000 };
    const cycles: SupplyCycle[] = [];
    const steps: string[] = [];
    const svc = new AggregatorService(ch, metrics as never, undefined, {
      logger: logs,
      recompute: async () => 0,
      now: () => clock.ms,
      supplyFunctions: {
        startSupplyCycle: async (...args) => {
          const answer = await startSupplyCycle(...args);
          if ('cycle' in answer) cycles.push(answer.cycle);
          return answer;
        },
        runSupplyStep: async (...args) => {
          steps.push(args[2].pending[0].kind);
          const next = await runSupplyStep(...args);
          clock.ms += 1000;
          return next;
        },
      },
      ...options,
    });
    aggregators.push(svc);
    return { svc, metrics, logs, clock, cycles, steps };
  }
  type Rig = ReturnType<typeof aggregator>;

  /** One tick, a minute after the last, at the clock of the rig. */
  async function tick({ svc, clock }: Rig): Promise<void> {
    await svc.tick(new Date(clock.ms));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The Xahau world. The ledgers are in three partitions of a million, L is 2,300,000 and the head 40 ledgers on. A second
  // snapshot is possible an hour later, at the ledger L2 = 2,300,600, once the escrows job has moved its sentinel there.
  const L = 2_300_000;
  const HEAD = L + 40;
  const L2 = 2_300_600;
  const HEAD2 = L2 + 10;
  const X = { one: 'rBmXahauOne', deleted: 'rKqXahauDeleted', three: 'rzzXahauThree', later: 'rEzXahauAfterL' };

  async function seedXahau(ch: ClickHouseService): Promise<void> {
    await ch.insert(Table.Escrows, [
      sentinel({ amount_drops: '18406227318004', open_count: 2140, through_ledger: L, version: 1 }),
    ]);
    await ch.insert(Table.Ledgers, [
      ledgerRow(2, { fee_total: 100 }),
      ledgerRow(1_500_000, { fee_total: 2_000 }),
      ledgerRow(1_999_999, { fee_total: 30 }),
      ledgerRow(2_000_000, { fee_total: 400 }),
      ledgerRow(L, { fee_total: 5, total_coins: '613401782117306' }),
      ledgerRow(HEAD, { fee_total: 7_000_000 }), // after L
    ]);
    await ch.insert(Table.AccountStates, [
      accountState(X.one, 100, 1),
      accountState(X.one, 2_200_000, 2),
      accountState(X.deleted, 50, 3),
      deletedState(X.deleted, 2_250_000),
      accountState(X.three, 70, 4),
      accountState(X.later, L + 20, 9), // after L, before L2
    ]);
    await ch.insert(Table.RewardClaims, [claimRow(1_999_990, 'CLAIM1'), claimRow(1_500_100, 'CLAIM2', { opt_out: 1 })]);
    await ch.insert(Table.GenesisMints, [
      mintRow(2_000_003, 1_000_000, 'CLAIM1'), // a reward
      mintRow(1_500_104, 250_000, 'CLAIM2'), // a reward
      mintRow(5, 120_000_000, ''), // no parent: a genesis mint
      mintRow(1_200_000, 7, 'NOT-A-CLAIM'), // a parent that is no claim: a genesis mint
      mintRow(L, 30, ''), // in L itself
      mintRow(L + 30, 999, ''), // after L, before L2
    ]);
    await ch.insert(Table.Imports, [
      importRow(3, 5_000_000),
      importRow(1_700_000, 800_000),
      importRow(2_100_000, 12_345),
      importRow(L + 1, 77), // after L, before L2
    ]);
  }

  /** What the escrows job leaves an hour later: its sentinel at L2, and the ledgers L2 and the new head. */
  async function advanceXahau(ch: ClickHouseService): Promise<void> {
    await ch.insert(Table.Ledgers, [
      ledgerRow(L2, { fee_total: 60, total_coins: '613401782117999' }),
      ledgerRow(HEAD2, { fee_total: 1 }),
    ]);
    await ch.insert(Table.Escrows, [
      sentinel({ amount_drops: '18406227318900', open_count: 2141, through_ledger: L2, version: 2 }),
    ]);
  }

  describe('Xahau', () => {
    it('computes a snapshot over ticks and writes one row an hour', async () => {
      const ch = await fresh();
      await seedXahau(ch);
      const rig = aggregator(ch, T0 + L + 120, { supply: { profile: xahau } });
      const { metrics, logs, clock, cycles, steps } = rig;
      expect(await newestSnapshot(ch)).toBeUndefined();

      // ---- the first cycle: the first tick starts it, and the ticks that follow go through its steps, five to a tick
      const startedAt = Math.floor(clock.ms / 1000);
      await tick(rig);
      expect(cycles).toHaveLength(1);
      const plan = cycles[0].steps;
      // 106 account ranges, a burned slice for each of the three million-ledger partitions of the ledgers, and the minted slices
      expect(plan).toBeGreaterThan(106);
      expect(cycles[0].pending.map((step) => step.kind)).toContain('burned');
      expect(cycles[0].pending.map((step) => step.kind)).toContain('minted');
      // the start took the one unit that is owed to it; the steps took the clock, a second each, until the budget of the job was spent
      const stepsPerTick = AGGREGATOR_SUPPLY_BUDGET_MS / 1000;
      expect(steps).toHaveLength(stepsPerTick);
      expect(await newestSnapshot(ch)).toBeUndefined();

      let ticks = 1;
      while ((await newestSnapshot(ch)) === undefined && ticks < 60) {
        clock.ms += 60_000;
        await tick(rig);
        ticks++;
      }
      // every tick took five steps of the cycle, and the one that took the last also wrote the row
      expect(ticks).toBe(Math.ceil(plan / stepsPerTick));
      expect(steps).toHaveLength(plan);
      expect(cycles).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logs.error).not.toHaveBeenCalled();
      expect(logs.warn).not.toHaveBeenCalled();

      // L = 2,300,000, closed at T0 + L. burned = the fees of the ledgers up to L: 100 + 2,000 + 30 + 400 + 5 = 2,535 (the 7,000,000 of
      // the ledger after L is not in it). minted: rewards 1,000,000 + 250,000; imports 5,000,000 + 800,000 + 12,345; genesis mints
      // 120,000,000 + 7 + 30 (the 999 and the 77 after L are not in it). accounts: one and three, of 2 + 4 owners. No AMM, and neither
      // a network_state row nor a SetFee: no reserve values.
      const first = await newestSnapshot(ch);
      expect(first).toMatchObject({
        ledger_index: L,
        close_time: T0 + L,
        started_at: startedAt,
        total_coins: '613401782117306',
        burned: '2535',
        escrowed: '18406227318004',
        escrow_count: '2140',
        amm: null,
        amm_pools: 0,
        reserve_base: null,
        reserve_inc: null,
        accounts: '2',
        owner_count: '6',
        minted_rewards: '1250000',
        minted_import: '5812345',
        minted_genesis: '120000037',
      });
      // written in the second the clock said then, whole
      expect(first?.computed_at).toBe(Math.floor(clock.ms / 1000));
      // the gauges: the wall time of the cycle, and the age of the snapshot (its ledger closed 120 s before the cycle began)
      expect(valuesOf(metrics.supplyCycleSeconds)).toEqual([(clock.ms - startedAt * 1000) / 1000]);
      expect(valuesOf(metrics.supplySnapshotAgeSeconds).at(-1)).toBe(Math.floor(clock.ms / 1000) - (T0 + L));
      // and one line in the log, for the whole cycle
      expect(logs.log).toHaveBeenCalledTimes(1);
      expect(logs.log).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `^supply: ledger ${L}, ${plan} steps, \\d+ s, in drops: total 613401782117306, burned 2535, escrowed 18406227318004, ` +
              'amm none, reserves unknown, minted 127062382$',
          ),
        ),
      );

      // ---- an hour later: the cadence is that of the newest snapshot's start, the hour is not over until the second
      const rowsBefore = await ch.query<{ ledger_index: number }>(`SELECT ledger_index FROM ${Table.NetworkSupply}`);
      expect(rowsBefore).toHaveLength(1);
      await advanceXahau(ch);
      clock.ms = (startedAt + SUPPLY_INTERVAL_MS / 1000 - 1) * 1000;
      await tick(rig);
      await tick(rig);
      expect(cycles).toHaveLength(1);
      expect(steps).toHaveLength(plan);
      expect(await newestSnapshot(ch)).toEqual(first);

      clock.ms = (startedAt + SUPPLY_INTERVAL_MS / 1000) * 1000;
      const secondStartedAt = Math.floor(clock.ms / 1000);
      let more = 0;
      do {
        await tick(rig);
        clock.ms += 60_000;
        more++;
      } while ((await newestSnapshot(ch))?.ledger_index === L && more < 60);
      expect(cycles).toHaveLength(2);
      expect(cycles[1].ledger).toBe(L2);
      expect(steps).toHaveLength(plan + cycles[1].steps);
      expect(more).toBe(Math.ceil(cycles[1].steps / stepsPerTick));

      // L2 = 2,300,600: burned = 2,535 + the 7,000,000 of the ledger after L + the 60 of L2 = 7,002,595; the account created after L is
      // counted now (3 accounts of 2 + 4 + 9 owners) and the mints and the import after L too: genesis 120,000,037 + 999, imports
      // 5,812,345 + 77
      const second = await newestSnapshot(ch);
      expect(second).toMatchObject({
        ledger_index: L2,
        close_time: T0 + L2,
        started_at: secondStartedAt,
        total_coins: '613401782117999',
        burned: '7002595',
        escrowed: '18406227318900',
        escrow_count: '2141',
        accounts: '3',
        owner_count: '15',
        minted_rewards: '1250000',
        minted_import: '5812422',
        minted_genesis: '120001036',
      });
      // two rows in all, one for each snapshot ledger
      const rows = await ch.query<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.NetworkSupply} ORDER BY ledger_index`,
      );
      expect(rows.map((row) => row.ledger_index)).toEqual([L, L2]);
      expect(valuesOf(metrics.supplyCycleSeconds)).toHaveLength(2);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logs.log).toHaveBeenCalledTimes(2);
    }, 240_000);

    it('waits for the escrows job without an error while there is no sentinel, and starts a cycle once there is one', async () => {
      const ch = await fresh();
      const rig = aggregator(ch, T0 + L + 120, { supply: { profile: xahau } });
      for (let i = 0; i < 3; i++) await tick(rig);
      expect(rig.cycles).toHaveLength(0);
      expect(rig.steps).toHaveLength(0);
      expect(await newestSnapshot(ch)).toBeUndefined();
      expect(rig.metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      // a process that has seen no snapshot sets no age
      expect(rig.metrics.supplySnapshotAgeSeconds.set).not.toHaveBeenCalled();

      await seedXahau(ch);
      await tick(rig);
      expect(rig.cycles).toHaveLength(1);
      expect(rig.cycles[0].ledger).toBe(L);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  // The XRPL world. L is in the second partition of account_states, the head 400 ledgers on, and the amm_pools job of the service is
  // at a cursor 100 ledgers before L.
  const XRPL_L = 10_000_500;
  const XRPL_HEAD = 10_000_900;
  const CURSOR = 10_000_400;
  const acct = (n: number): string => `rAmm${String(n).padStart(6, '0')}`;
  const R = { first: 'r4BAccountOne', second: 'rQaAccountTwo', deleted: 'rKqDeletedBeforeL' };

  describe('XRPL, with the sight of the amm_pools runner', () => {
    it('fills forward the pool that is stale at L, counts the pool the amm_pools job has set aside at its stored row, and warns', async () => {
      const ch = await fresh();
      await ch.insert(Table.Escrows, [
        sentinel({ amount_drops: '35212847105402318', open_count: 12879, through_ledger: XRPL_L, version: 1 }),
      ]);
      await ch.insert(Table.Ledgers, [ledgerRow(XRPL_L), ledgerRow(XRPL_HEAD)]);
      await ch.insert(
        Table.NetworkState,
        [
          { ledger_index: XRPL_L - 3, reserves: [1_000_000, 200_000] },
          { ledger_index: XRPL_L + 100, reserves: [9_000_000, 900_000] },
        ].map(
          ({ ledger_index, reserves }): NetworkStateRow => ({
            ledger_index,
            ledger_hash: '',
            polled_at: Math.floor(Date.now() / 1000) + 0.125,
            amendments: [],
            majorities: [],
            negative_unl: [],
            to_disable: '',
            to_reenable: '',
            base_fee: 10,
            reserve_base: reserves[0],
            reserve_inc: reserves[1],
            node_quorum: 0,
          }),
        ),
      );
      // two accounts of 3 and 5 owners, one deleted before L, and the accounts of the three pools (one owner each), which are left out
      await ch.insert(Table.AccountStates, [
        accountState(R.first, 4_000_000, 3),
        accountState(R.second, 5_000_000, 5),
        accountState(R.deleted, 4_000_000, 11),
        deletedState(R.deleted, 10_000_200),
        ...[1, 2, 3].map((n) => accountState(acct(n), 10_000_100, 1)),
      ]);
      // P1 is whole: its row has seen its last state. P2 is stale at L: a state at 10,000,450, above the cursor, that its row has not
      // seen. P3 is the pool the amm_pools job sets aside: it has the same unseen state, which is not filled forward.
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { last_ledger: 10_000_100, reserve_base: '100.5' }),
        pool(acct(2), { last_ledger: 10_000_100, reserve_base: '10' }),
        pool(acct(3), { last_ledger: 10_000_100, reserve_base: '7' }),
      ]);
      const states = [
        ammState(acct(1), 10_000_100, { reserve_base: '100.5' }),
        ammState(acct(2), 10_000_100, { reserve_base: '10' }),
        ammState(acct(2), 10_000_450, { reserve_base: '2.5' }),
        ammState(acct(3), 10_000_100, { reserve_base: '7' }),
        ammState(acct(3), 10_000_450, { reserve_base: '1' }),
      ];
      await ch.insert(Table.AmmPoolStates, states);
      await ch.insert(
        Table.AmmPoolTouches,
        states.map(({ ledger_index, amm_account }) => ({ ledger_index, tx_index: 0, amm_account })),
      );

      // the amm_pools job of the service: the cursor it reads is CURSOR; its first batch holds the pool P3, which fails on its own, and
      // another that works, so that P3 is set aside; the batch moves the cursor one ledger on
      const rates = new RatesService(ch, 'XRP');
      const rig = aggregator(ch, T0 + XRPL_L + 120, {
        supply: { profile: xrpl },
        ammPools: { rates },
        ammPoolsFunctions: {
          watermark: async () => CURSOR,
          changedSince: async (_ch, ledger) =>
            ledger === CURSOR ? { accounts: [acct(3), acct(1)], upTo: CURSOR + 1 } : { accounts: [], upTo: ledger },
          poolsClosedIn: async () => [],
          recompute: async (_ch, _rates, accounts) => {
            if (accounts.includes(acct(3))) throw new Error('DB::Exception: memory limit');
            return accounts.length;
          },
        },
      });
      let ticks = 0;
      do {
        await tick(rig);
        rig.clock.ms += 60_000;
        ticks++;
      } while ((await newestSnapshot(ch)) === undefined && ticks < 60);

      expect(rig.cycles).toHaveLength(1);
      const cycle = rig.cycles[0];
      expect(cycle.poolsAtStoredRow).toEqual([acct(3)]);
      // L: closed at T0 + L; burned = 10^17 - total_coins; accounts: first and second, of 3 + 5 owners (the deleted one and the three pools'
      // accounts are left out); reserves from the poll of L - 3. amm: P1 at its row (100.5 XRP), P2 filled forward to L (2.5 XRP, not the 10
      // of its row), P3 at its stored row (7 XRP, not the 1 it holds at L): 110,000,000 drops in 3 pools.
      expect(await newestSnapshot(ch)).toMatchObject({
        ledger_index: XRPL_L,
        close_time: T0 + XRPL_L,
        total_coins: '99985312374716318',
        burned: '14687625283682',
        escrowed: '35212847105402318',
        escrow_count: '12879',
        amm: '110000000',
        amm_pools: 3,
        reserve_base: '1000000',
        reserve_inc: '200000',
        accounts: '2',
        owner_count: '8',
        minted_rewards: null,
        minted_import: null,
        minted_genesis: null,
      });
      // the plan has one AMM step, for the pool that is stale: none for P1, which is whole, or for the set-aside P3
      expect(rig.steps.filter((kind) => kind === 'amm')).toHaveLength(1);
      expect(cycle.steps).toBe(106 + 1);
      expect(cycle.pending.filter((step) => step.kind === 'amm')).toEqual([{ kind: 'amm', pools: [acct(2)] }]);

      // the warning names the pool that is counted at its stored row, once; the failure of the pool was the amm_pools job's
      const said = rig.logs.warn.mock.calls.map(([text]) => text as string);
      expect(said.filter((text) => text.includes('counted at their stored row'))).toEqual([
        `supply: 1 AMM pool(s) set aside by the amm_pools job are counted at their stored row, and not as of ledger ${XRPL_L}: ${acct(3)}`,
      ]);
      // (its retries fail too, as the clock goes on: still the amm_pools job's errors, and no other job's)
      expect(new Set(rig.metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job))).toEqual(
        new Set(['amm_pools']),
      );
      expect(rig.logs.error).toHaveBeenCalledWith(expect.stringContaining(`pool ${acct(3)}`));
    }, 240_000);

    it('waits, without an error, for the amm_pools job to read its cursor', async () => {
      const ch = await fresh();
      await ch.insert(Table.Escrows, [
        sentinel({ amount_drops: '1', open_count: 1, through_ledger: XRPL_L, version: 1 }),
      ]);
      await ch.insert(Table.Ledgers, [ledgerRow(XRPL_L), ledgerRow(XRPL_HEAD)]);
      let reads = 0;
      const rig = aggregator(ch, T0 + XRPL_L + 120, {
        supply: { profile: xrpl },
        ammPools: { rates: new RatesService(ch, 'XRP') },
        ammPoolsFunctions: {
          // the first read of the cursor fails, the next works
          watermark: async () => {
            if (reads++ === 0) throw new Error('connect ECONNREFUSED');
            return XRPL_L;
          },
          changedSince: async (_ch, ledger) => ({ accounts: [], upTo: ledger }),
          poolsClosedIn: async () => [],
          recompute: async () => 0,
        },
      });
      await tick(rig);
      // the start was refused for the want of a cursor: nothing began, and the only error is the read of the amm_pools job
      expect(rig.cycles).toHaveLength(0);
      expect(rig.metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job)).toEqual(['amm_pools']);
      await tick(rig);
      expect(rig.cycles).toHaveLength(1);
      expect(rig.cycles[0].ledger).toBe(XRPL_L);
    }, 120_000);
  });
});

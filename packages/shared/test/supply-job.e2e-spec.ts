import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import {
  AMM_FILL_WINDOW_LEDGERS,
  AMM_POOLS_CHUNK,
  POOLS_CHANGED_SINCE_SQL,
  poolsChangedSince,
} from '../src/aggregate/amm-pools.job';
import { SUPPLY_ACCOUNT_PREFIXES, supplyAccountRanges } from '../src/aggregate/supply';
import {
  computeSupplyCycle,
  runSupplyStep,
  stalePoolsUpTo,
  startSupplyCycle,
  SUPPLY_ACCOUNTS_SQL,
  SUPPLY_AMM_TOUCHED_LIMIT,
  SUPPLY_INTERVAL_MS,
  SUPPLY_MAX_LAG_LEDGERS,
  SUPPLY_START_WAIT_TICKS,
  SupplyAmmSight,
  SupplyCycle,
  supplySnapshotRow,
  SupplyStep,
  writeSupplySnapshot,
} from '../src/aggregate/supply.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import {
  AccountStatesRow,
  AmmPoolsRow,
  AmmPoolStatesRow,
  EscrowsRow,
  GenesisMintsRow,
  ImportsRow,
  MINT_PARSER_VERSION,
  NetworkStateRow,
  NetworkSupplyRow,
  RewardClaimsRow,
} from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { getNetworkProfile } from '../src/network';
import { mintSlices, newestSnapshot } from '../src/query/supply';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The start of a supply cycle (`startSupplyCycle`) on a real ClickHouse: when a cycle starts and at which ledger, what the first
 * tick reads (the ledger L, the escrowed total, the reserve values, the first part of the AMM) and the plan of steps it leaves.
 *
 * Part 1 is the choice of L and the waits. Part 2 is the reads of the first tick on both networks. Part 3 is the AMM: the pools
 * that count at their stored row, the pools to fill forward, the set-aside pools and the rows that cannot be read. Part 4 is the
 * plan of steps and the start of the minted steps. Part 5 pins what the reserve lookups read, over bulks they must skip.
 *
 * Then the steps and the row (`describe('a supply cycle')`): two whole cycles with every figure computed by hand in the test, the
 * account ranges, the AMM steps (the fill-forward at L), a step on its own (the cycle it returns and the one it leaves alone), the
 * snapshot row and its write, and what an account range, a burned slice and an AMM step read, over bulks they must skip.
 */

const GRANULE = 8192;
const TX_GRANULE = 1024; // `transactions` is created with `index_granularity = 1024`
const T0 = 1_760_000_000;
const L = 5_000;
const STARTED_AT = T0 + 99_999;

const xrpl = getNetworkProfile('xrpl');
const xahau = getNetworkProfile('xahau');

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const acct = (n: number): string => `rAmm${String(n).padStart(6, '0')}`;

/** A `ledgers` row: the columns a start reads, and the parser that wrote it (the current one unless told). */
const ledgerRow = (ledger_index: number, over: Record<string, unknown> = {}) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time: T0 + ledger_index,
  total_coins: '99985312374716318',
  parser_version: MINT_PARSER_VERSION,
  ...over,
});

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

const NOW = Math.floor(Date.now() / 1000);

/** A `network_state` row: the reserves are the point, the rest is what the poller leaves empty. */
const stateRow = (
  ledger_index: number,
  reserves: [number | string, number | string],
  polledAfter = 0,
): NetworkStateRow => ({
  ledger_index,
  ledger_hash: '',
  polled_at: NOW + polledAfter + 0.125,
  amendments: [],
  majorities: [],
  negative_unl: [],
  to_disable: '',
  to_reenable: '',
  base_fee: 10,
  reserve_base: reserves[0],
  reserve_inc: reserves[1],
  node_quorum: 0,
});

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

const touch = (ledger_index: number, amm_account: string, tx_index = 0) => ({ ledger_index, tx_index, amm_account });

const kinds = (cycle: SupplyCycle): string[] => cycle.pending.map((step) => step.kind);
const stepsOf = <K extends SupplyStep['kind']>(cycle: SupplyCycle, kind: K): Array<Extract<SupplyStep, { kind: K }>> =>
  cycle.pending.filter((step): step is Extract<SupplyStep, { kind: K }> => step.kind === kind);

// -- The steps and the snapshot (Task 7) ---------------------------------------------------------------------------------

const COMPUTED_AT = STARTED_AT + 123;

/** An `account_states` row: the state of an account after a transaction; the columns the supply reads, the rest filled in. */
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
  tx_hash: `${account}-${ledger_index}-${over.tx_index ?? 0}`,
  close_time: T0 + ledger_index,
  balance: '100',
  flags: 0,
  sequence: 1,
  owner_count,
  fields: '{}',
  deleted: 0,
  ...over,
});

/** The row an AccountDelete writes: the account does not exist after it. */
const deletedState = (account: string, ledger_index: number): AccountStatesRow =>
  accountState(account, ledger_index, 0, { deleted: 1 });

/** An `amm_pool_states` row of a pool whose pair is XRP/USD unless told; the reserves are the point. */
const ammState = (
  amm_account: string,
  ledger_index: number,
  over: Partial<AmmPoolStatesRow> = {},
): AmmPoolStatesRow => ({
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

/** A pool of the pair USD/XRP: the counter side is the native one. */
const COUNTER_NATIVE = { base_currency: 'USD', base_issuer: ISSUER, counter_currency: 'XRP', counter_issuer: '' };

const mintRow = (
  ledger_index: number,
  amount: number,
  parent_tx_hash: string,
  position: { tx_index?: number; mint_index?: number } = {},
): GenesisMintsRow => ({
  ledger_index,
  tx_index: position.tx_index ?? 0,
  mint_index: position.mint_index ?? 0,
  tx_hash: `mint-${ledger_index}-${position.tx_index ?? 0}`,
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

/** A cycle made by hand, for the steps that need no start: nothing counted, nothing pending, L = the L of the tests. */
const cycleOf = (over: Partial<SupplyCycle> = {}): SupplyCycle => ({
  ledger: L,
  closeTime: T0 + L,
  startedAt: STARTED_AT,
  totalCoins: 1n,
  escrowed: 0n,
  escrowCount: 0,
  reserveBase: null,
  reserveInc: null,
  poolAccounts: [],
  amm: null,
  ammPools: 0,
  poolsAtStoredRow: [],
  poolsAtZero: [],
  accounts: 0n,
  ownerCount: 0n,
  burned: 0n,
  minted: null,
  pending: [],
  steps: 0,
  ...over,
});

/** Freezes a value and everything in it: a step that changes its cycle in place throws. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

/** The index of the account range an account falls in. */
const rangeOf = (account: string): number =>
  supplyAccountRanges().findIndex((range) => account >= range.lo && account < range.hi);

describe('startSupplyCycle (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `supply_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const stopMerges = async (ch: ClickHouseService, ...tables: Table[]): Promise<void> => {
    for (const table of tables) await ch.command(`SYSTEM STOP MERGES ${table}`);
  };

  const countOf = async (ch: ClickHouseService, sql: string, params: Record<string, unknown> = {}): Promise<number> =>
    Number((await ch.queryOne<{ n: string }>(sql, params))?.n);

  /** The sentinel of the escrows job at `through`, and the ledgers `through .. head` committed (every one: the head is the newest). */
  async function ready(
    ch: ClickHouseService,
    over: { through?: number; head?: number; ledgers?: number[] } = {},
  ): Promise<void> {
    const through = over.through ?? L;
    await ch.insert(Table.Escrows, [
      sentinel({ amount_drops: '35212847105402318', open_count: 12879, through_ledger: through, version: 1 }),
    ]);
    const head = over.head ?? through;
    await ch.insert(
      Table.Ledgers,
      [...new Set([through, head, ...(over.ledgers ?? [])])].map((ledger) => ledgerRow(ledger)),
    );
  }

  const start = async (ch: ClickHouseService, profile = xahau, amm?: SupplyAmmSight): Promise<SupplyCycle> => {
    const answer = await startSupplyCycle(ch, profile, STARTED_AT, amm);
    if (!('cycle' in answer)) throw new Error(`the cycle did not start: ${answer.waiting}`);
    return answer.cycle;
  };

  /** The sight the amm_pools runner lends, with a cursor at `cursor` (the L of the tests unless told). */
  const sight = (cursor: number | undefined, setAside: string[] = []): SupplyAmmSight => ({ cursor, setAside });

  interface Logged {
    tables: string[];
    read_rows: number;
  }

  /** The SELECTs on `tables` while `run` ran (`system.query_log`), in the order they started, with the rows each read. */
  async function logged(ch: ClickHouseService, run: () => Promise<unknown>, ...names: Table[]): Promise<Logged[]> {
    const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
    await run();
    await ch.command('SYSTEM FLUSH LOGS');
    const rows = await ch.query<{ tables: string[]; read_rows: string }>(
      `SELECT tables, read_rows FROM system.query_log
        WHERE current_database = currentDatabase() AND type = 'QueryFinish' AND query_kind = 'Select'
          AND query_start_time_microseconds >= {t:DateTime64(6)}
          AND hasAny(tables, arrayMap(x -> concat(currentDatabase(), '.', x), {names:Array(String)}))
        ORDER BY query_start_time_microseconds`,
      { t, names },
    );
    return rows.map((r) => ({ tables: r.tables, read_rows: Number(r.read_rows) }));
  }

  /** The rows each SELECT read that read this table alone. */
  const readsOf = (all: Logged[], table: Table): number[] =>
    all.filter((r) => r.tables.length === 1 && r.tables[0].endsWith(`.${table}`)).map((r) => r.read_rows);

  /** The active parts of a table that hold a row where `where` is true: the only parts a read of those rows opens. */
  const partsWith = (
    ch: ClickHouseService,
    table: Table,
    where: string,
    params: Record<string, unknown>,
  ): Promise<number> =>
    countOf(ch, `SELECT count() AS n FROM (SELECT _part FROM ${table} WHERE ${where} GROUP BY _part)`, params);

  const granuleOf = async (ch: ClickHouseService, table: Table): Promise<number> => {
    const ddl =
      (
        await ch.queryOne<{ engine_full: string }>(
          `SELECT engine_full FROM system.tables WHERE database = currentDatabase() AND name = {table:String}`,
          { table },
        )
      )?.engine_full ?? '';
    const declared = /index_granularity = (\d+)/.exec(ddl);
    return declared ? Number(declared[1]) : GRANULE;
  };

  /** What a read of the rows where `where` is true may read: the rows it needs and two granules (of the table's own size) for each part. */
  const bound = async (
    ch: ClickHouseService,
    table: Table,
    needed: number,
    where: string,
    params: Record<string, unknown>,
  ): Promise<number> => needed + 2 * (await granuleOf(ch, table)) * (await partsWith(ch, table, where, params));

  // -------------------------------------------------------------------------------------------------------------------
  describe('the choice of L', () => {
    it('exports the constants of the plan', () => {
      expect(SUPPLY_INTERVAL_MS).toBe(3_600_000);
      expect(SUPPLY_START_WAIT_TICKS).toBe(10);
      expect(SUPPLY_MAX_LAG_LEDGERS).toBe(1_000);
      expect(SUPPLY_AMM_TOUCHED_LIMIT).toBeGreaterThanOrEqual(100_000);
    });

    it('waits without a sentinel, after a single read', async () => {
      const ch = await fresh();
      const query = jest.spyOn(ch, 'query');
      expect(await startSupplyCycle(ch, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('waits while the sentinel says ledger 0 (the escrows job saw an empty database)', async () => {
      const ch = await fresh();
      await ch.insert(Table.Escrows, [sentinel({ amount_drops: '0', open_count: 0, through_ledger: 0, version: 1 })]);
      await ch.insert(Table.Ledgers, [ledgerRow(L)]);
      // answered by the sentinel alone: the head, 5,000 ahead of ledger 0, would answer the same, but after a second read
      const query = jest.spyOn(ch, 'query');
      expect(await startSupplyCycle(ch, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('starts at the sentinel while the head is at most 1,000 ledgers ahead, and waits when it is further', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + SUPPLY_MAX_LAG_LEDGERS });
      expect((await start(ch)).ledger).toBe(L);

      const behind = await fresh();
      await ready(behind, { head: L + SUPPLY_MAX_LAG_LEDGERS + 1 });
      // the ledgers row of L is stored, and still the escrows job is a first fill behind
      expect(await startSupplyCycle(behind, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
    });

    it('waits while the ledgers row of L is not stored (a step of the escrows job can land in a gap of the index)', async () => {
      const ch = await fresh();
      await ready(ch, { through: L, head: L + 20 });
      await ch.command(`DELETE FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`, { l: L });
      expect(await startSupplyCycle(ch, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
    });

    it('waits while the sentinel is past the head (its ledger is not stored yet)', async () => {
      const ch = await fresh();
      await ready(ch, { through: L + 10, head: L });
      await ch.command(`DELETE FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`, { l: L + 10 });
      expect(await startSupplyCycle(ch, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
    });

    it('asks in the order that costs least: the sentinel, then the head, then the row of L', async () => {
      const lagging = await fresh();
      await ready(lagging, { head: L + SUPPLY_MAX_LAG_LEDGERS + 1 });
      const lagQuery = jest.spyOn(lagging, 'query');
      expect(await startSupplyCycle(lagging, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
      expect(lagQuery).toHaveBeenCalledTimes(2);

      const gap = await fresh();
      await ready(gap, { head: L + 20 });
      await gap.command(`DELETE FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`, { l: L });
      const gapQuery = jest.spyOn(gap, 'query');
      expect(await startSupplyCycle(gap, xahau, STARTED_AT)).toEqual({ waiting: 'escrows' });
      expect(gapQuery).toHaveBeenCalledTimes(3);
    });

    it('throws on a read that fails: the answer is not a wait', async () => {
      const ch = await fresh();
      await ready(ch);
      jest.spyOn(ch, 'query').mockRejectedValue(new Error('the server went away'));
      await expect(startSupplyCycle(ch, xahau, STARTED_AT)).rejects.toThrow('the server went away');
    });

    it('takes L, its close time and total_coins (past 2^53) from the sentinel ledger, and the escrowed total from the sentinel', async () => {
      const ch = await fresh();
      await ready(ch, { through: L, head: L + 3, ledgers: [L - 1] });
      const cycle = await start(ch);
      expect(cycle.ledger).toBe(L);
      expect(cycle.closeTime).toBe(T0 + L);
      expect(cycle.startedAt).toBe(STARTED_AT);
      expect(cycle.totalCoins).toBe(99_985_312_374_716_318n);
      expect(cycle.escrowed).toBe(35_212_847_105_402_318n);
      expect(cycle.escrowCount).toBe(12_879);
    });

    it("takes the ledger's own row, not a neighbour's", async () => {
      const ch = await fresh();
      await ch.insert(Table.Escrows, [sentinel({ amount_drops: '5', open_count: 1, through_ledger: L, version: 1 })]);
      await ch.insert(Table.Ledgers, [
        ledgerRow(L - 1, { total_coins: '1', close_time: T0 + 1 }),
        ledgerRow(L, { total_coins: '2', close_time: T0 + 2 }),
        ledgerRow(L + 1, { total_coins: '3', close_time: T0 + 3 }),
      ]);
      const cycle = await start(ch);
      expect([cycle.closeTime, cycle.totalCoins]).toEqual([T0 + 2, 2n]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the reserve values', () => {
    const setFee = (ledger: number, tx: Record<string, unknown>, tx_index = 0) => ({
      tx: {
        ledger_index: ledger,
        tx_index,
        hash: `${ledger}-${tx_index}`.padStart(64, 'A'),
        tx_type: 'SetFee',
        result: 'tesSUCCESS',
        account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        sequence: 0,
        fee: 0,
        close_time: T0 + ledger,
        tx_json: JSON.stringify({ TransactionType: 'SetFee', ...tx }),
        meta_json: '{}',
      },
      byType: { tx_type: 'SetFee', ledger_index: ledger, tx_index, result: 'tesSUCCESS' },
    });
    const DROPS = (base: string, inc: string) => ({
      BaseFeeDrops: '10',
      ReserveBaseDrops: base,
      ReserveIncrementDrops: inc,
    });
    const LEGACY = (base: number, inc: number) => ({
      BaseFee: '000000000000000A',
      ReferenceFeeUnits: 10,
      ReserveBase: base,
      ReserveIncrement: inc,
    });

    async function insertSetFees(ch: ClickHouseService, ...rows: Array<ReturnType<typeof setFee>>): Promise<void> {
      await ch.insert(
        Table.Transactions,
        rows.map((r) => r.tx),
      );
      await ch.insert(
        Table.TxByType,
        rows.map((r) => r.byType),
      );
    }

    const reservesOf = async (ch: ClickHouseService) => {
      const cycle = await start(ch);
      return [cycle.reserveBase, cycle.reserveInc];
    };

    it('takes the reserve values in force at L from network_state: the newest poll of the newest ledger at or before L', async () => {
      const ch = await fresh();
      await ready(ch);
      await stopMerges(ch, Table.NetworkState);
      // two polls of ledger L - 10: the one polled later wins, whatever order they were written in; one ledger after L is ignored
      await ch.insert(Table.NetworkState, [stateRow(L - 10, [2_000_000, 400_000], 5)]);
      await ch.insert(Table.NetworkState, [stateRow(L - 10, [1_000_000, 200_000], 1)]);
      await ch.insert(Table.NetworkState, [stateRow(L + 5, [9_000_000, 900_000], 9)]);
      await ch.insert(Table.NetworkState, [stateRow(L - 4000, [7_000_000, 700_000], 0)]);
      // the premise: the two polls are two rows of the table (no merge ran), not one
      expect(await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkState} WHERE ledger_index = ${L - 10}`)).toBe(
        2,
      );
      expect(await reservesOf(ch)).toEqual([2_000_000n, 400_000n]);
    });

    it('takes the row of L itself', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.NetworkState, [stateRow(L - 1, [1, 1]), stateRow(L, [3_000_000, 600_000])]);
      expect(await reservesOf(ch)).toEqual([3_000_000n, 600_000n]);
    });

    it('keeps a reserve above 2^53 exact', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.NetworkState, [stateRow(L - 1, ['9007199254740993', '18446744073709551615'])]);
      expect(await reservesOf(ch)).toEqual([9_007_199_254_740_993n, 18_446_744_073_709_551_615n]);
    });

    it('falls back to the newest SetFee at or before L, in the drops spelling', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(
        ch,
        setFee(4_000, LEGACY(10_000_000, 2_000_000)),
        setFee(4_900, DROPS('1000000', '200000')),
        setFee(L + 1, DROPS('5000000', '500000')), // after L
      );
      // a transaction of another type between them is not a SetFee
      await ch.insert(Table.TxByType, [{ tx_type: 'Payment', ledger_index: 4_950, tx_index: 0, result: 'tesSUCCESS' }]);
      expect(await reservesOf(ch)).toEqual([1_000_000n, 200_000n]);
    });

    it('falls back to the legacy spelling (ReserveBase, ReserveIncrement) of a ledger before the XRPFees amendment', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(ch, setFee(4_000, LEGACY(10_000_000, 2_000_000)), setFee(L + 1, DROPS('1', '1')));
      expect(await reservesOf(ch)).toEqual([10_000_000n, 2_000_000n]);
    });

    it('takes the SetFee of the ledger L itself, and the later one of a ledger', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(
        ch,
        setFee(L - 1, DROPS('1', '1')),
        setFee(L, DROPS('2', '2'), 0),
        setFee(L, DROPS('3', '3'), 4),
        setFee(L, DROPS('4', '4'), 2),
      );
      expect(await reservesOf(ch)).toEqual([3n, 3n]);
    });

    it('prefers network_state to a SetFee', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(ch, setFee(4_900, DROPS('1000000', '200000')));
      await ch.insert(Table.NetworkState, [stateRow(L - 1, [12_000_000, 2_400_000])]);
      expect(await reservesOf(ch)).toEqual([12_000_000n, 2_400_000n]);
    });

    it('leaves the reserve values NULL with neither network_state nor SetFee', async () => {
      const ch = await fresh();
      await ready(ch);
      // a network_state row after L and a SetFee after L do not count
      await ch.insert(Table.NetworkState, [stateRow(L + 1, [1, 1])]);
      await insertSetFees(ch, setFee(L + 1, DROPS('1', '1')));
      expect(await reservesOf(ch)).toEqual([null, null]);
    });

    it('leaves them NULL when the newest SetFee holds no fees (the one reading of D1: feesOfSetFee)', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(
        ch,
        setFee(4_900, { ReserveBaseDrops: 'many', ReserveIncrementDrops: '2', BaseFeeDrops: '10' }),
      );
      expect(await reservesOf(ch)).toEqual([null, null]);
    });

    it('leaves them NULL when the newest SetFee of the index has no transaction row (a re-ingest dropped it)', async () => {
      const ch = await fresh();
      await ready(ch);
      // the older SetFee is whole, the newest has its index row and no transaction: the newest is the one asked for, and it says nothing
      await insertSetFees(ch, setFee(4_000, DROPS('1000000', '200000')));
      await ch.insert(Table.TxByType, [{ tx_type: 'SetFee', ledger_index: 4_900, tx_index: 0, result: 'tesSUCCESS' }]);
      expect(await reservesOf(ch)).toEqual([null, null]);
    });

    it('reads the SetFee fallback with the shared feesOfSetFee, field by field (a drops field first, a UInt64 check)', async () => {
      const ch = await fresh();
      await ready(ch);
      await insertSetFees(
        ch,
        setFee(4_900, {
          BaseFee: '000000000000000A',
          ReserveBase: 5,
          ReserveBaseDrops: '9007199254740993',
          ReserveIncrementDrops: '7',
        }),
      );
      expect(await reservesOf(ch)).toEqual([9_007_199_254_740_993n, 7n]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('burned and minted on both networks', () => {
    it('starts XRPL with burned = 10^17 − total_coins and no minted sums', async () => {
      const ch = await fresh();
      await ready(ch);
      const cycle = await start(ch, xrpl, sight(L));
      expect(cycle.burned).toBe(10n ** 17n - 99_985_312_374_716_318n);
      expect(cycle.minted).toBeNull();
      expect(kinds(cycle).filter((k) => k === 'burned' || k === 'minted')).toEqual([]);
    });

    it('starts Xahau with burned at 0 and zero minted sums, to be filled by the steps', async () => {
      const ch = await fresh();
      await ready(ch);
      const cycle = await start(ch, xahau);
      expect(cycle.burned).toBe(0n);
      expect(cycle.minted).toEqual({ rewards: 0n, import: 0n, genesis_mint: 0n });
    });

    it('starts the sums at zero', async () => {
      const ch = await fresh();
      await ready(ch);
      const cycle = await start(ch, xahau);
      expect([cycle.accounts, cycle.ownerCount]).toEqual([0n, 0n]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the AMM, part 1', () => {
    const native = (cycle: SupplyCycle) => [cycle.amm, cycle.ammPools];

    it('waits with no cursor of the amm_pools runner (before its first run), and starts with one', async () => {
      const ch = await fresh();
      await ready(ch);
      expect(await startSupplyCycle(ch, xrpl, STARTED_AT)).toEqual({ waiting: 'amm_pools' });
      expect(await startSupplyCycle(ch, xrpl, STARTED_AT, sight(undefined))).toEqual({ waiting: 'amm_pools' });
      expect((await start(ch, xrpl, sight(0))).amm).toBe(0n); // a cursor of 0 is a cursor
    });

    it('never asks on Xahau: no cursor needed, no AMM table read, amm null', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: L + 1 })]);
      const query = jest.spyOn(ch, 'query');
      const cycle = await start(ch, xahau, sight(undefined));
      expect(native(cycle)).toEqual([null, 0]);
      expect(cycle.poolAccounts).toEqual([]);
      expect(kinds(cycle)).not.toContain('amm');
      expect([cycle.poolsAtStoredRow, cycle.poolsAtZero]).toEqual([[], []]);
      const text = query.mock.calls.map(([sql]) => String(sql)).join('\n');
      expect(text).not.toContain(Table.AmmPools);
      expect(text).not.toContain(Table.AmmPoolTouches);
    });

    it('does not ask for the watermark of the pools, a scan of all their touches', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 10 });
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: 300 })]);
      await ch.insert(Table.AmmPoolTouches, [touch(300, acct(1))]);
      const query = jest.spyOn(ch, 'query');
      await start(ch, xrpl, sight(L));
      const text = query.mock.calls.map(([sql]) => String(sql));
      // the watermark query is `minIf(t.ledger_index, ...) AS first_stale ... countIf(...) AS stale`
      expect(text.filter((sql) => sql.includes('first_stale') || sql.includes('countIf'))).toEqual([]);
    });

    it('sums the native side of the pools whose row is at or before L, from the newest version of each', async () => {
      const ch = await fresh();
      await ready(ch);
      await stopMerges(ch, Table.AmmPools);
      // the older version of a pool is bigger: the newest version (the higher number, '10' above '9') is the one
      await ch.insert(Table.AmmPools, [pool(acct(1), { reserve_base: '999', version: 9 })]);
      await ch.insert(Table.AmmPools, [pool(acct(1), { reserve_base: '10', version: 10 })]);
      // the premise: both versions are rows of the table (no merge ran)
      expect(await countOf(ch, `SELECT count() AS n FROM ${Table.AmmPools} WHERE amm_account = '${acct(1)}'`)).toBe(2);
      await ch.insert(Table.AmmPools, [
        pool(acct(2), {
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_counter: '2.5',
        }), // counter is native
        pool(acct(3), { base_currency: 'EUR', base_issuer: ISSUER, reserve_base: '77' }), // no native side
        pool(acct(4), { reserve_base: '99', deleted: 1 }), // deleted: holds nothing
        pool(acct(5), { base_issuer: ISSUER, reserve_base: '55' }), // an issued 'XRP' is not the native one
        pool(acct(6), { reserve_base: '0' }), // native, empty: not counted in ammPools
        pool(acct(7), { reserve_base: '0.000001' }), // one drop
        pool(acct(8), { last_ledger: L }), // the row is at L exactly
      ]);
      const cycle = await start(ch, xrpl, sight(L));
      expect(native(cycle)).toEqual([10_000_000n + 2_500_000n + 1n + 10_000_000n, 4]);
      expect(cycle.poolAccounts).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(acct));
      expect(stepsOf(cycle, 'amm')).toEqual([]);
      expect([cycle.poolsAtStoredRow, cycle.poolsAtZero]).toEqual([[], []]);
    });

    it("counts the native currency of the network's profile, with no issuer", async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { base_currency: 'XAH', reserve_base: '3' }),
        pool(acct(2), { base_currency: 'XRP', reserve_base: '40' }),
      ]);
      expect(native(await start(ch, { ...xrpl, nativeCurrency: 'XAH' }, sight(L)))).toEqual([3_000_000n, 1]);
      expect(native(await start(ch, xrpl, sight(L)))).toEqual([40_000_000n, 1]);
    });

    it('reads the deleted UInt8 as a number, 0 or 1', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { deleted: 0 }),
        pool(acct(2), { deleted: 1 }),
        pool(acct(3), { deleted: 2 }),
      ]);
      expect(native(await start(ch, xrpl, sight(L)))).toEqual([10_000_000n, 1]);
    });

    it('reads the UInt8 and the UInt32 of a row as numbers, whatever way the client writes them', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { deleted: 0, last_ledger: 100 }),
        pool(acct(2), { deleted: 1, last_ledger: 100 }),
        pool(acct(3), { deleted: 0, last_ledger: L + 1 }),
      ]);
      // a client that quotes its integers answers '0' (a text, and true) for a pool that is not deleted
      const read = ch.query.bind(ch);
      jest
        .spyOn(ch, 'query')
        .mockImplementation((async (sql: string, params?: Record<string, unknown>) =>
          (await read(sql, params)).map((row: Record<string, unknown>) =>
            sql.includes(`FROM ${Table.AmmPools}`) && 'deleted' in row
              ? { ...row, deleted: String(row.deleted), last_ledger: String(row.last_ledger) }
              : row,
          )) as typeof ch.query);
      const cycle = await start(ch, xrpl, sight(L));
      expect(native(cycle)).toEqual([10_000_000n, 1]);
      expect(stepsOf(cycle, 'amm')).toEqual([{ kind: 'amm', pools: [acct(3)] }]);
    });

    it('counts a row it cannot read at zero and lists it, so that no pool row stalls the cycle', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { reserve_base: '10' }),
        pool(acct(2), { reserve_base: '0.0000001' }), // not a whole number of drops
        pool(acct(3), { reserve_base: 'abc' }),
        pool(acct(4), { reserve_base: null }), // the native side has never been given a reserve
        pool(acct(5), {
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XRP',
          counter_issuer: '',
          reserve_counter: null,
        }),
        pool(acct(6), { reserve_base: null, deleted: 1 }), // deleted: nothing to know
        pool(acct(7), { base_currency: 'EUR', base_issuer: ISSUER, reserve_base: null }), // no native side: nothing to know
        pool(acct(8), { reserve_base: '20' }),
      ]);
      const cycle = await start(ch, xrpl, sight(L));
      expect(native(cycle)).toEqual([30_000_000n, 2]);
      expect(cycle.poolsAtZero).toEqual([2, 3, 4, 5].map(acct));
      expect(cycle.poolAccounts).toHaveLength(8);
      expect(stepsOf(cycle, 'amm')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the AMM, the pools to fill forward', () => {
    const native = (cycle: SupplyCycle) => [cycle.amm, cycle.ammPools];
    const ammPools = (cycle: SupplyCycle): string[] => stepsOf(cycle, 'amm').flatMap((s) => [...s.pools]);

    it('plans a fill-forward of a pool stale at L (a touch at or before L that its row has not seen)', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 1000 });
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { last_ledger: 100 }), // stale: a touch at 4,000 it has not seen
        pool(acct(2), { last_ledger: 4_500 }), // seen
        pool(acct(3), { last_ledger: 5_800 }), // its row is past L
        pool(acct(4), { last_ledger: 100 }), // stale only past L (a touch at 5,500)
        pool(acct(6), { last_ledger: 100, reserve_base: '7' }), // stale at L, and set aside
        pool(acct(7), { last_ledger: 6_000, reserve_base: '3' }), // past L, and set aside
        pool(acct(8), { last_ledger: 4_400, reserve_base: '40' }),
      ]);
      await ch.insert(Table.AmmPoolTouches, [
        touch(100, acct(1)),
        touch(4_000, acct(1)),
        touch(100, acct(2)),
        touch(4_500, acct(2)),
        touch(5_800, acct(3)),
        touch(100, acct(4)),
        touch(5_500, acct(4)),
        touch(4_800, acct(5)), // a brand-new pool: touched, and no amm_pools row yet
        touch(100, acct(6)),
        touch(4_000, acct(6)),
        touch(6_000, acct(7)),
        touch(4_400, acct(8)),
      ]);
      // the runner's cursor is at 3,000: every touch above it that its pool has not seen is in what the start asks for
      const cycle = await start(ch, xrpl, sight(3_000, [acct(6), acct(7)]));

      // the pools to fill forward at L: stale at L (1), past L (3), stale past L (4, harmless), a new pool (5); not the set-aside ones
      expect(stepsOf(cycle, 'amm')).toEqual([{ kind: 'amm', pools: [1, 3, 4, 5].map(acct) }]);
      // the others count at their stored row: 2 (10 XRP), the set-aside 6 (7 XRP) and 7 (3 XRP, though its row is past L), 8 (40 XRP)
      expect(native(cycle)).toEqual([(10n + 7n + 3n + 40n) * 1_000_000n, 4]);
      expect(cycle.poolsAtStoredRow).toEqual([acct(6), acct(7)]);
      // every pool is left out of the reserves, a pool with no row yet as well
      expect(cycle.poolAccounts).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(acct));
    });

    it('asks poolsChangedSince from the cursor, with the named limit', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 10 });
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: 100 })]);
      await ch.insert(Table.AmmPoolTouches, [touch(100, acct(1)), touch(4_000, acct(1))]);
      const changedParams = (query: jest.SpyInstance) =>
        query.mock.calls
          .filter(([sql]) => sql === POOLS_CHANGED_SINCE_SQL)
          .map(([, params]) => params as { ledger: number; head: number; n: number });

      const query = jest.spyOn(ch, 'query');
      const cycle = await start(ch, xrpl, sight(3_000));
      expect(changedParams(query)).toEqual([{ ledger: 3_000, head: L + 10, n: SUPPLY_AMM_TOUCHED_LIMIT + 1 }]);
      expect(ammPools(cycle)).toEqual([acct(1)]);
    });

    it('does not read the touches when the cursor is at or past L: nothing can be stale at L but a pool whose row is past it', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 100 });
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { last_ledger: 4_000 }),
        pool(acct(2), { last_ledger: L + 50 }), // its row is past L
        pool(acct(3), { last_ledger: 100 }), // stale only past L: the cursor has not got there, and this start does not need it
      ]);
      await ch.insert(Table.AmmPoolTouches, [touch(4_000, acct(1)), touch(L + 50, acct(2)), touch(L + 60, acct(3))]);
      for (const cursor of [L, L + 20]) {
        const query = jest.spyOn(ch, 'query');
        const cycle = await start(ch, xrpl, sight(cursor));
        expect([cursor, ammPools(cycle)]).toEqual([cursor, [acct(2)]]);
        expect([cursor, native(cycle)]).toEqual([cursor, [20_000_000n, 2]]);
        expect(query.mock.calls.filter(([sql]) => String(sql).includes(Table.AmmPoolTouches))).toEqual([]);
        query.mockRestore();
      }
    });

    it('finds a pool stale at L only from a cursor below its touch: a cursor at the touch, or above L, asks for none', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 100 });
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: 100 })]);
      await ch.insert(Table.AmmPoolTouches, [touch(3_500, acct(1))]);
      // a cursor below the touch finds the pool stale; a cursor at the touch (the runner has been through it) does not ask
      expect(ammPools(await start(ch, xrpl, sight(3_499)))).toEqual([acct(1)]);
      expect(ammPools(await start(ch, xrpl, sight(3_500)))).toEqual([]);
      // a cursor above L is read as L: the pool whose touch the runner has passed counts at its stored row (a re-ingest of ledgers
      // below the cursor can leave one so until agg_dirty rebuilds it, which spec 4.5 tolerates), and no touch is read
      const query = jest.spyOn(ch, 'query');
      const above = await start(ch, xrpl, sight(L + 50));
      expect(ammPools(above)).toEqual([]);
      expect(native(above)).toEqual([10_000_000n, 1]);
      expect(query.mock.calls.filter(([sql]) => String(sql).includes(Table.AmmPoolTouches))).toEqual([]);
    });

    it('chunks the pools to fill forward into amm steps of 200, sorted, in order', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 10 });
      expect(AMM_POOLS_CHUNK).toBe(200);
      const accounts = Array.from({ length: 401 }, (_, i) => acct(i));
      await ch.insert(
        Table.AmmPools,
        accounts.map((account) => pool(account, { last_ledger: L + 5 })),
      );
      const cycle = await start(ch, xrpl, sight(L));
      const steps = stepsOf(cycle, 'amm');
      expect(steps.map((s) => s.pools.length)).toEqual([200, 200, 1]);
      expect(steps.flatMap((s) => [...s.pools])).toEqual(accounts);
      expect(native(cycle)).toEqual([0n, 0]);
      expect(cycle.poolAccounts).toEqual(accounts);
    });

    it('lists a set-aside pool once, whether it is stale at L, past L or neither, and one it has no row or touch of', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { last_ledger: 100, reserve_base: '1' }),
        pool(acct(2), { last_ledger: 4_000, reserve_base: '2' }),
      ]);
      await ch.insert(Table.AmmPoolTouches, [touch(4_000, acct(1)), touch(4_000, acct(2))]);
      const cycle = await start(ch, xrpl, sight(3_000, [acct(2), acct(1), acct(404)]));
      // the runner names a pool it set aside: it is a pool of the cycle whether or not the tables hold a row or a touch of it
      expect(cycle.poolsAtStoredRow).toEqual([acct(1), acct(2), acct(404)]);
      expect(cycle.poolAccounts).toEqual([acct(1), acct(2), acct(404)]);
      expect(stepsOf(cycle, 'amm')).toEqual([]);
      expect(native(cycle)).toEqual([3_000_000n, 2]);
    });

    it('a pool that is set aside and has a touch above the cursor and no row is a pool of the cycle, and counts nothing', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPoolTouches, [touch(4_000, acct(9))]);
      const cycle = await start(ch, xrpl, sight(3_000, [acct(9)]));
      expect(cycle.poolAccounts).toEqual([acct(9)]);
      expect(cycle.poolsAtStoredRow).toEqual([acct(9)]);
      expect(stepsOf(cycle, 'amm')).toEqual([]);
    });

    it('a pool the runner set aside before it ever had a row is named and left out of the reserves, though its cursor is past its touches', async () => {
      const ch = await fresh();
      await ready(ch, { head: L + 100 });
      // the runner moves its cursor past a pool it sets aside: the touch is at or below the cursor, the pool has no row (it failed from
      // its first rebuild), and nothing in the tables finds it; only the runner's list does
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: 4_400, reserve_base: '40' })]);
      await ch.insert(Table.AmmPoolTouches, [touch(4_400, acct(1)), touch(4_000, acct(9))]);
      for (const cursor of [4_500, L, L + 50]) {
        const cycle = await start(ch, xrpl, sight(cursor, [acct(9)]));
        expect([cursor, cycle.poolAccounts]).toEqual([cursor, [acct(1), acct(9)]]);
        expect([cursor, cycle.poolsAtStoredRow]).toEqual([cursor, [acct(9)]]);
        expect([cursor, stepsOf(cycle, 'amm')]).toEqual([cursor, []]);
        expect([cursor, native(cycle)]).toEqual([cursor, [40_000_000n, 1]]);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the pools touched since a cursor, in pages (stalePoolsUpTo)', () => {
    const PAGE = 3;

    async function seeded(): Promise<ClickHouseService> {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, [ledgerRow(1_000)]);
      // seven pools whose first stale touch is at ledgers 110, 120, ..., 170, with no amm_pools row: all stale
      await ch.insert(
        Table.AmmPoolTouches,
        [0, 1, 2, 3, 4, 5, 6].map((i) => touch(110 + 10 * i, acct(i))),
      );
      return ch;
    }

    it('returns every stale pool of (after, upTo] by going on from the upTo of a page that is not complete', async () => {
      const ch = await seeded();
      const changed = jest.fn(poolsChangedSince);
      const accounts = await stalePoolsUpTo(ch, 100, 1_000, PAGE, changed);
      expect([...accounts].sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map(acct));
      expect(changed.mock.calls.length).toBeGreaterThan(1);
      // each call goes on from the upTo of the one before, and asks for the limit it was given
      const from = changed.mock.calls.map(([, ledger]) => ledger);
      expect(from[0]).toBe(100);
      expect([...from]).toEqual([...from].sort((a, b) => a - b));
      expect(new Set(from).size).toBe(from.length);
      expect(changed.mock.calls.every(([, , limit]) => limit === PAGE)).toBe(true);
    });

    it('awaits each page before it asks for the next', async () => {
      const ch = await seeded();
      let running = 0;
      let overlapped = false;
      const changed: typeof poolsChangedSince = async (service, ledger, limit) => {
        if (++running > 1) overlapped = true;
        try {
          return await poolsChangedSince(service, ledger, limit);
        } finally {
          running--;
        }
      };
      await stalePoolsUpTo(ch, 100, 1_000, PAGE, changed);
      expect(overlapped).toBe(false);
    });

    it('stops at the first page that is complete up to the ledger, also when it holds no pool', async () => {
      const ch = await seeded();
      const changed = jest.fn(poolsChangedSince);
      expect(await stalePoolsUpTo(ch, 100, 1_000, 100, changed)).toHaveLength(7);
      expect(changed).toHaveBeenCalledTimes(1);
      changed.mockClear();
      expect(await stalePoolsUpTo(ch, 900, 1_000, 100, changed)).toEqual([]);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing when there is no ledger between', async () => {
      const ch = await seeded();
      const changed = jest.fn(poolsChangedSince);
      expect(await stalePoolsUpTo(ch, 1_000, 1_000, 100, changed)).toEqual([]);
      expect(await stalePoolsUpTo(ch, 1_001, 1_000, 100, changed)).toEqual([]);
      expect(changed).not.toHaveBeenCalled();
    });

    it('throws rather than ask for ever when a page does not move on', async () => {
      const ch = await seeded();
      const stuck: typeof poolsChangedSince = async (_service, ledger) => ({ accounts: [], upTo: ledger });
      await expect(stalePoolsUpTo(ch, 100, 1_000, PAGE, stuck)).rejects.toThrow(/does not move on/);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the plan of steps', () => {
    it('plans XRPL as 106 account ranges and then the fill-forwards', async () => {
      const ch = await fresh();
      await ready(ch);
      await ch.insert(Table.AmmPools, [pool(acct(1), { last_ledger: L + 1 })]);
      const cycle = await start(ch, xrpl, sight(L));
      const ranges = supplyAccountRanges();
      expect(ranges).toHaveLength(106);
      expect(cycle.pending).toEqual([
        ...ranges.map((range) => ({ kind: 'accounts', range })),
        { kind: 'amm', pools: [acct(1)] },
      ]);
      expect(cycle.steps).toBe(107);
    });

    it('plans XRPL with no fill-forward as the 106 account ranges', async () => {
      const ch = await fresh();
      await ready(ch);
      const cycle = await start(ch, xrpl, sight(L));
      expect(kinds(cycle)).toEqual(Array(106).fill('accounts'));
      expect(cycle.steps).toBe(106);
    });

    describe('Xahau', () => {
      /** Ledgers in three partitions: the first stored is 2, the sentinel is at 2,300,000. */
      const XL = 2_300_000;

      it('plans 106 account ranges, one burned step per slice, then one minted step per slice', async () => {
        const ch = await fresh();
        await ready(ch, { through: XL, ledgers: [2, 1_200_000] });
        const cycle = await start(ch, xahau);
        const slices = mintSlices(2, XL);
        expect(slices).toHaveLength(3);
        expect(cycle.pending).toEqual([
          ...supplyAccountRanges().map((range) => ({ kind: 'accounts', range })),
          ...slices.map(([from, to]) => ({ kind: 'burned', from, to })),
          ...slices.map(([from, to]) => ({ kind: 'minted', from, to })),
        ]);
        expect(cycle.steps).toBe(106 + 3 + 3);
      });

      it('starts the minted steps above the newest ledger an older parser wrote, and the burned steps at the oldest stored ledger', async () => {
        const ch = await fresh();
        await ready(ch, { through: XL, ledgers: [2] });
        await ch.insert(Table.Ledgers, [ledgerRow(1_200_000, { parser_version: MINT_PARSER_VERSION - 1 })]);
        const cycle = await start(ch, xahau);
        expect(stepsOf(cycle, 'burned').map((s) => [s.from, s.to])).toEqual(mintSlices(2, XL));
        expect(stepsOf(cycle, 'minted').map((s) => [s.from, s.to])).toEqual(mintSlices(1_200_001, XL));
        expect(stepsOf(cycle, 'minted')[0]).toEqual({ kind: 'minted', from: 1_200_001, to: 1_999_999 });
      });

      it('starts the minted steps at the oldest stored ledger when no older parser wrote one', async () => {
        const ch = await fresh();
        await ready(ch, { through: XL, ledgers: [1_500_000] });
        const cycle = await start(ch, xahau);
        expect(stepsOf(cycle, 'minted').map((s) => [s.from, s.to])).toEqual(mintSlices(1_500_000, XL));
        expect(stepsOf(cycle, 'burned').map((s) => [s.from, s.to])).toEqual(mintSlices(1_500_000, XL));
      });

      it('plans no minted step when the newest older ledger is at L', async () => {
        const ch = await fresh();
        await ready(ch, { through: XL, ledgers: [2] });
        await ch.command(`DELETE FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`, { l: XL });
        await ch.insert(Table.Ledgers, [ledgerRow(XL, { parser_version: MINT_PARSER_VERSION - 1 })]);
        const cycle = await start(ch, xahau);
        expect(stepsOf(cycle, 'minted')).toEqual([]);
        expect(stepsOf(cycle, 'burned')).toHaveLength(3);
      });

      it('plans one slice a step when L is in the first partition', async () => {
        const ch = await fresh();
        await ready(ch, { through: 900, ledgers: [1] });
        const cycle = await start(ch, xahau);
        expect(stepsOf(cycle, 'burned')).toEqual([{ kind: 'burned', from: 1, to: 900 }]);
        expect(stepsOf(cycle, 'minted')).toEqual([{ kind: 'minted', from: 1, to: 900 }]);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what the reserve lookups read', () => {
    // network_state (ordered by ledger_index; granules of 8,192 rows), tx_by_type (ordered by tx_type, ledger_index, tx_index; granules
    // of 8,192) and transactions (ordered by ledger_index, tx_index; granules of 1,024) hold, besides the rows a lookup needs, bulks
    // it must skip: more than two granules of rows in the very part the lookup reads, at both sides of its rows. The merges are
    // stopped, so every insert stays a part of its own. The bound of a read is the rows it needs and two granules for each part its
    // range touches (the ends of a range are whole granules).
    const BL = 60_000; // the ledger of the cycle
    const BULK = 30_000;
    const NEWEST_STATE = BL - 10; // the newest network_state ledger at or before it
    const NEWEST_SETFEE = BL - 1_000;
    /** The rows of `tx_by_type` that the SetFee lookup reads through: its type, up to the ledger. */
    const SET_FEES_UP_TO_L = 'tx_type = {type:String} AND ledger_index <= {l:UInt32}';

    describe('network_state', () => {
      let ch: ClickHouseService;

      beforeAll(async () => {
        ch = await fresh();
        await stopMerges(ch, Table.NetworkState);
        await ch.insert(Table.Ledgers, [ledgerRow(BL)]);
        await ch.insert(Table.Escrows, [
          sentinel({ amount_drops: '5', open_count: 1, through_ledger: BL, version: 1 }),
        ]);
        // a part of polls below the ledger of the cycle (one row a ledger) with the row the lookup needs among them, the newest at or
        // before it (a single poll: the rows of one key in one insert are collapsed to one), and a part of polls above it
        await ch.command(
          `INSERT INTO ${Table.NetworkState}
             (ledger_index, ledger_hash, polled_at, amendments, majorities, negative_unl, to_disable, to_reenable,
              base_fee, reserve_base, reserve_inc, node_quorum)
           SELECT toUInt32(if(n.number < {below:UInt32}, n.number + 1, {newest:UInt32})), '', toDateTime64(now(), 3, 'UTC'),
                  [], [], [], '', '', 10, toUInt64(if(n.number < {below:UInt32}, 1, 2000000)),
                  toUInt64(if(n.number < {below:UInt32}, 1, 400000)), 0
             FROM numbers({rows:UInt32}) AS n`,
          { below: BL - 5_000, newest: NEWEST_STATE, rows: BL - 5_000 + 1 },
        );
        await ch.command(
          `INSERT INTO ${Table.NetworkState}
             (ledger_index, ledger_hash, polled_at, amendments, majorities, negative_unl, to_disable, to_reenable,
              base_fee, reserve_base, reserve_inc, node_quorum)
           SELECT toUInt32({base:UInt32} + n.number), '', toDateTime64(now(), 3, 'UTC'), [], [], [], '', '', 10,
                  toUInt64(9), toUInt64(9), 0
             FROM numbers({rows:UInt32}) AS n`,
          { base: BL + 50, rows: BULK },
        );
      });

      it('has a bulk each side of the rows it needs, more than the bound of the lookup', async () => {
        const lookup = await bound(ch, Table.NetworkState, 2, 'ledger_index <= {l:UInt32}', { l: BL });
        expect(
          await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkState} WHERE ledger_index < {l:UInt32}`, {
            l: NEWEST_STATE,
          }),
        ).toBeGreaterThan(lookup);
        expect(
          await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkState} WHERE ledger_index > {l:UInt32}`, {
            l: BL,
          }),
        ).toBeGreaterThan(GRANULE);
        expect(await granuleOf(ch, Table.NetworkState)).toBe(GRANULE);
        // the rows it reads are in one part, with the bulk below them
        expect(await partsWith(ch, Table.NetworkState, 'ledger_index <= {l:UInt32}', { l: BL })).toBe(1);
      });

      it('reads one granule to find the reserve values: the newest ledger by key, then its polls', async () => {
        let cycle: SupplyCycle | undefined;
        const all = await logged(
          ch,
          async () => {
            cycle = await start(ch, xahau);
          },
          Table.NetworkState,
        );
        // the poll of the newest ledger at or before L
        expect([cycle?.reserveBase, cycle?.reserveInc]).toEqual([2_000_000n, 400_000n]);
        const reads = readsOf(all, Table.NetworkState);
        expect(reads.length).toBeGreaterThanOrEqual(1);
        // the rows needed: the newest ledger (1 row), then its poll (1 row), counted as 2
        const lookup = await bound(ch, Table.NetworkState, 2, 'ledger_index <= {l:UInt32}', { l: BL });
        for (const read of reads) expect(read).toBeLessThanOrEqual(lookup);
      });
    });

    describe('the SetFee fallback', () => {
      let ch: ClickHouseService;

      beforeAll(async () => {
        ch = await fresh();
        await stopMerges(ch, Table.TxByType, Table.Transactions);
        await ch.insert(Table.Ledgers, [ledgerRow(BL)]);
        await ch.insert(Table.Escrows, [
          sentinel({ amount_drops: '5', open_count: 1, through_ledger: BL, version: 1 }),
        ]);
        // tx_by_type: other types each side of 'SetFee' in the key order, and a part of SetFee rows with the ones the lookup needs
        // in the middle of its ledgers: 40,000 rows below the cycle's ledger (one a ledger), the newest SetFee at or before it, and
        // 30,000 rows after it
        const byType = (type: string, base: number, rows: number) =>
          ch.command(
            `INSERT INTO ${Table.TxByType} (tx_type, ledger_index, tx_index, result)
             SELECT {type:String}, toUInt32({base:UInt32} + n.number), toUInt32(0), 'tesSUCCESS'
               FROM numbers({rows:UInt32}) AS n`,
            { type, base, rows },
          );
        await byType('Payment', 1, BULK);
        await byType('TrustSet', 1, BULK);
        await ch.command(
          `INSERT INTO ${Table.TxByType} (tx_type, ledger_index, tx_index, result)
           SELECT 'SetFee',
                  toUInt32(multiIf(n.number < 40000, n.number + 1, n.number = 40000, {newest:UInt32}, {after:UInt32} + n.number)),
                  toUInt32(if(n.number = 40000, 2, 0)), 'tesSUCCESS'
             FROM numbers(70001) AS n`,
          { newest: NEWEST_SETFEE, after: BL + 100 },
        );
        // transactions: a bulk of Payments (four to a ledger, in the places 0, 1, 3 and 4, so that the place of the SetFee, 2, is inside
        // the range of the places and no read by the place alone can leave a granule out), and the SetFee itself
        await ch.command(
          `INSERT INTO ${Table.Transactions}
             (ledger_index, tx_index, hash, tx_type, result, account, sequence, fee, close_time, tx_json, meta_json)
           SELECT toUInt32(n.number % {ledgers:UInt32}), toUInt32(arrayElement([0, 1, 3, 4], intDiv(n.number, {ledgers:UInt32}) + 1)),
                  concat('bulk-', toString(n.number)), 'Payment', 'tesSUCCESS', 'rBulk', 0, 10,
                  toDateTime(1700000000, 'UTC'), '{}', '{}'
             FROM numbers({rows:UInt32}) AS n`,
          { ledgers: BL, rows: 4 * BL },
        );
        await ch.insert(Table.Transactions, [
          {
            ledger_index: NEWEST_SETFEE,
            tx_index: 2,
            hash: 'S'.repeat(64),
            tx_type: 'SetFee',
            result: 'tesSUCCESS',
            account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
            sequence: 0,
            fee: 0,
            close_time: T0,
            tx_json: JSON.stringify({
              TransactionType: 'SetFee',
              BaseFeeDrops: '10',
              ReserveBaseDrops: '1000000',
              ReserveIncrementDrops: '200000',
            }),
            meta_json: '{}',
          },
        ]);
      });

      it('has a bulk each side of the rows it needs, more than the bound of each lookup', async () => {
        expect(await granuleOf(ch, Table.Transactions)).toBe(TX_GRANULE);
        expect(await granuleOf(ch, Table.TxByType)).toBe(GRANULE);
        const typeBound = await bound(ch, Table.TxByType, 1, SET_FEES_UP_TO_L, { type: 'SetFee', l: BL });
        const txBound = await bound(ch, Table.Transactions, 1, 'ledger_index = {l:UInt32}', { l: NEWEST_SETFEE });
        const setFeesBelow = `SELECT count() AS n FROM ${Table.TxByType} WHERE tx_type = 'SetFee' AND ledger_index < {l:UInt32}`;
        const setFeesAfter = `SELECT count() AS n FROM ${Table.TxByType} WHERE tx_type = 'SetFee' AND ledger_index > {l:UInt32}`;
        expect(await countOf(ch, setFeesBelow, { l: NEWEST_SETFEE })).toBeGreaterThan(typeBound);
        expect(await countOf(ch, setFeesAfter, { l: BL })).toBeGreaterThan(typeBound);
        expect(await countOf(ch, `SELECT count() AS n FROM ${Table.Transactions}`)).toBeGreaterThan(2 * txBound);
      });

      it('reads one granule of tx_by_type and one of transactions', async () => {
        let cycle: SupplyCycle | undefined;
        const all = await logged(
          ch,
          async () => {
            cycle = await start(ch, xahau);
          },
          Table.TxByType,
          Table.Transactions,
        );
        // no network_state row: the reserves are the SetFee's
        expect([cycle?.reserveBase, cycle?.reserveInc]).toEqual([1_000_000n, 200_000n]);
        const typeReads = readsOf(all, Table.TxByType);
        const txReads = readsOf(all, Table.Transactions);
        expect(typeReads).toHaveLength(1);
        expect(txReads).toHaveLength(1);
        const typeBound = await bound(ch, Table.TxByType, 1, SET_FEES_UP_TO_L, { type: 'SetFee', l: BL });
        const txBound = await bound(ch, Table.Transactions, 1, 'ledger_index = {l:UInt32}', { l: NEWEST_SETFEE });
        expect(typeReads[0]).toBeLessThanOrEqual(typeBound);
        expect(txReads[0]).toBeLessThanOrEqual(txBound);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a supply cycle', () => {
    /** Runs the steps at the front of the plan while they are of `kind`. */
    const runWhile = async (
      ch: ClickHouseService,
      profile: typeof xrpl,
      cycle: SupplyCycle,
      kind: SupplyStep['kind'],
    ): Promise<SupplyCycle> => {
      let current = cycle;
      while (current.pending[0]?.kind === kind) current = await runSupplyStep(ch, profile, current);
      return current;
    };

    /** One cycle from the start to the write; the row it wrote. */
    const wholeCycle = async (ch: ClickHouseService, profile: typeof xrpl, amm?: SupplyAmmSight) => {
      const answer = await computeSupplyCycle(ch, profile, STARTED_AT, COMPUTED_AT, amm);
      if (!('ledger_index' in answer)) throw new Error(`no row was written: ${JSON.stringify(answer)}`);
      return answer;
    };

    /** The snapshot as the api reads it, without its version (which is the clock's). */
    const stored = async (ch: ClickHouseService): Promise<Omit<NetworkSupplyRow, 'version'>> => {
      const { version, ...rest } = (await newestSnapshot(ch)) as NetworkSupplyRow;
      expect(BigInt(version)).toBeGreaterThan(0n);
      return rest;
    };

    let tokens = 0;
    /** The same rows in the table twice, with merges stopped (the caller does): each insert has a token of its own, or the second is dropped. */
    const insertTwice = async (ch: ClickHouseService, table: Table, rows: object[]): Promise<void> => {
      const n = ++tokens;
      await ch.insert(table, rows, { dedupToken: `${table}-${n}-a` });
      await ch.insert(table, rows, { dedupToken: `${table}-${n}-b` });
    };

    // -----------------------------------------------------------------------------------------------------------------
    // The XRPL world. L is in the second partition of account_states (the ledgers from 10,000,000 on), the head 400 ledgers on, the
    // AMM job's cursor 100 ledgers before L.
    const XRPL_L = 10_000_500;
    const XRPL_HEAD = 10_000_900;
    const XRPL_CURSOR = 10_000_400;
    const ID = {
      lowest: 'r11LowestRange',
      modified: 'r4BCreatedThenModified',
      plain: 'r9dNeverModified',
      sameLedger: 'rBmTwoRowsOfOneLedger',
      shrunk: 'rEzOwnerCountShrinks',
      deletedBefore: 'rKqDeletedBeforeL',
      deletedAfter: 'rQaDeletedAfterL',
      deletedAtL: 'rWrDeletedAtL',
      recreated: 'rccDeletedThenCreatedAgain',
      afterL: 'rhhCreatedAfterL',
      highest: 'rzzHighestRange',
    };
    const COUNTED = [
      ID.lowest,
      ID.modified,
      ID.plain,
      ID.sameLedger,
      ID.shrunk,
      ID.deletedAfter,
      ID.recreated,
      ID.highest,
    ];

    async function seedXrpl(ch: ClickHouseService): Promise<void> {
      await ready(ch, { through: XRPL_L, head: XRPL_HEAD });
      // the reserves in force at L: the poll of L - 3; a poll after L does not count
      await ch.insert(Table.NetworkState, [
        stateRow(XRPL_L - 3, [1_000_000, 200_000]),
        stateRow(XRPL_L + 100, [9_000_000, 900_000]),
      ]);
      await ch.insert(Table.AccountStates, [
        accountState(ID.lowest, 4_000_000, 3),
        accountState(ID.modified, 3_000_000, 2),
        accountState(ID.modified, 10_000_100, 5),
        accountState(ID.modified, XRPL_L + 5, 9), // after L
        accountState(ID.plain, 9_999_990, 0),
        accountState(ID.sameLedger, 10_000_050, 3),
        accountState(ID.sameLedger, 10_000_050, 4, { tx_index: 7 }), // the later transaction of the ledger
        accountState(ID.shrunk, 5_000_000, 8),
        accountState(ID.shrunk, 10_000_400, 1),
        accountState(ID.deletedBefore, 4_000_000, 11),
        deletedState(ID.deletedBefore, 10_000_200),
        accountState(ID.deletedAfter, 4_500_000, 6),
        deletedState(ID.deletedAfter, XRPL_L + 1), // deleted after L: it exists at L
        accountState(ID.deletedAtL, 4_000_001, 2),
        deletedState(ID.deletedAtL, XRPL_L), // deleted in L itself: it does not exist at L
        accountState(ID.recreated, 3_500_000, 1),
        deletedState(ID.recreated, 9_000_000),
        accountState(ID.recreated, 10_000_300, 2), // created again
        accountState(ID.afterL, XRPL_L + 5, 5),
        accountState(ID.highest, 6_000_000, 7),
        // the accounts of the pools (one owner each): the pools of the cycle are left out
        ...[1, 2, 4, 5, 7, 8].map((n) => accountState(acct(n), 10_000_100, 1)),
        accountState(acct(3), 9_000_000, 1),
        deletedState(acct(3), 10_000_160),
        accountState(acct(6), 10_000_800, 1), // a pool created after L
      ]);
      // the newest row of each pool, as the amm_pools job left it
      await ch.insert(Table.AmmPools, [
        pool(acct(1), { last_ledger: 10_000_100, reserve_base: '1000.5' }),
        pool(acct(2), { ...COUNTER_NATIVE, last_ledger: 10_000_150, reserve_base: '7', reserve_counter: '20.25' }),
        pool(acct(3), { last_ledger: 10_000_160, reserve_base: '999', deleted: 1 }),
        pool(acct(4), { base_currency: 'EUR', base_issuer: ISSUER, last_ledger: 10_000_170, reserve_base: '42' }),
        pool(acct(5), { last_ledger: 10_000_600, reserve_base: '9999' }), // touched after L
        pool(acct(6), { last_ledger: 10_000_800, reserve_base: '5000' }), // created after L
        pool(acct(7), { last_ledger: 10_000_100, reserve_base: '1' }), // stale at L
      ]);
      const states = [
        ammState(acct(1), 10_000_100, { reserve_base: '1000.5', reserve_counter: '5' }),
        ammState(acct(2), 10_000_150, { ...COUNTER_NATIVE, reserve_base: '7', reserve_counter: '20.25' }),
        ammState(acct(3), 10_000_160, { reserve_base: '999', deleted: 1 }),
        ammState(acct(4), 10_000_170, { base_currency: 'EUR', base_issuer: ISSUER, reserve_base: '42' }),
        ammState(acct(5), 10_000_200, { reserve_base: '300', reserve_counter: '4' }),
        ammState(acct(5), 10_000_450, { reserve_base: '250.123456', reserve_counter: null }), // the counter is filled forward
        ammState(acct(5), 10_000_600, { reserve_base: '9999', reserve_counter: '4' }), // after L
        ammState(acct(6), 10_000_800, { reserve_base: '5000', reserve_counter: '1' }), // after L: all of it
        ammState(acct(7), 10_000_100, { reserve_base: '1' }),
        ammState(acct(7), 10_000_450, { reserve_base: '2.5' }), // the touch its row has not seen
        ammState(acct(8), 10_000_450, { reserve_base: '12', reserve_counter: '1' }), // a pool with no amm_pools row yet
      ];
      await ch.insert(Table.AmmPoolStates, states);
      await ch.insert(
        Table.AmmPoolTouches,
        states.map((s) => touch(s.ledger_index, s.amm_account)),
      );
    }

    // The Xahau world: L = 2,300,000, three partitions of ledgers.
    const XAHAU_L = 2_300_000;
    const XAHAU_HEAD = XAHAU_L + 40;
    const X = { one: 'rBmXahauOne', deleted: 'rKqXahauDeleted', three: 'rzzXahauThree', later: 'rEzXahauAfterL' };

    type Put = (table: Table, rows: object[]) => Promise<void>;

    async function seedXahau(ch: ClickHouseService, put: Put = (table, rows) => ch.insert(table, rows)): Promise<void> {
      await ch.insert(Table.Escrows, [
        sentinel({ amount_drops: '18406227318004', open_count: 2140, through_ledger: XAHAU_L, version: 1 }),
      ]);
      await put(Table.Ledgers, [
        ledgerRow(2, { fee_total: 100 }),
        ledgerRow(1_500_000, { fee_total: 2_000 }),
        ledgerRow(1_999_999, { fee_total: 30 }),
        ledgerRow(2_000_000, { fee_total: 400 }),
        ledgerRow(XAHAU_L, { fee_total: 5, total_coins: '613401782117306' }),
        ledgerRow(XAHAU_HEAD, { fee_total: 7_000_000 }), // after L
      ]);
      await put(Table.AccountStates, [
        accountState(X.one, 100, 1),
        accountState(X.one, 2_200_000, 2),
        accountState(X.deleted, 50, 3),
        deletedState(X.deleted, 2_250_000),
        accountState(X.three, 70, 4),
        accountState(X.later, XAHAU_L + 20, 9), // after L
      ]);
      await ch.insert(Table.RewardClaims, [
        claimRow(1_999_990, 'CLAIM1'), // in the slice before the mint it is the parent of
        claimRow(1_500_100, 'CLAIM2', { opt_out: 1 }),
      ]);
      await ch.insert(Table.GenesisMints, [
        mintRow(2_000_003, 1_000_000, 'CLAIM1'), // a reward, whose claim is 13 ledgers back, in another slice
        mintRow(1_500_104, 250_000, 'CLAIM2'), // a reward
        mintRow(5, 120_000_000, ''), // no parent: a genesis mint
        mintRow(1_200_000, 7, 'NOT-A-CLAIM'), // a parent that is no claim: a genesis mint
        mintRow(XAHAU_L, 30, ''), // in L itself
        mintRow(XAHAU_L + 30, 999, ''), // after L
      ]);
      await ch.insert(Table.Imports, [
        importRow(3, 5_000_000),
        importRow(1_700_000, 800_000),
        importRow(2_100_000, 12_345),
        importRow(XAHAU_L + 1, 77), // after L
      ]);
    }

    describe('one full cycle, every figure computed by hand', () => {
      it('XRPL: one full cycle writes the row computed by hand', async () => {
        const ch = await fresh();
        await seedXrpl(ch);
        // the premises of the world: the accounts of the cycle are in several ranges, and the state is in two partitions of P7
        expect(new Set(COUNTED.map(rangeOf)).size).toBeGreaterThanOrEqual(6);
        expect(
          await countOf(
            ch,
            `SELECT uniqExact(partition) AS n FROM system.parts
              WHERE database = currentDatabase() AND table = 'account_states' AND active`,
          ),
        ).toBe(2);

        const row = await wholeCycle(ch, xrpl, sight(XRPL_CURSOR));

        // L = 10,000,500: closed at T0 + L; the cycle began at STARTED_AT and the row was written 123 s later.
        // total_coins 99,985,312,374,716,318, so burned = 10^17 - that = 14,687,625,283,682 (XRPL has no history to read for it).
        // escrowed and its count are the sentinel's.
        // accounts: lowest, modified, plain, sameLedger, shrunk, deletedAfter, recreated, highest = 8, of owner counts
        //   3 + 5 + 0 + 4 + 1 + 6 + 2 + 7 = 28 (the deleted ones, the one created after L and the 8 pools' accounts are left out).
        // amm: the stored pools 1 and 2 (1,000.5 and 20.25 XRP: 1,000,500,000 + 20,250,000 drops; pool 3 is deleted, pool 4 has no
        //   native side), and at L the pools 5 (250.123456 XRP), 7 (2.5 XRP) and 8 (12 XRP; no amm_pools row): 250,123,456 +
        //   2,500,000 + 12,000,000; pool 6 has no state at L. 1,285,373,456 drops in 5 pools.
        // reserves: the poll of L - 3.
        expect(await stored(ch)).toEqual({
          ledger_index: 10_000_500,
          close_time: 1_770_000_500,
          started_at: 1_760_099_999,
          computed_at: 1_760_100_122,
          total_coins: '99985312374716318',
          burned: '14687625283682',
          escrowed: '35212847105402318',
          escrow_count: '12879',
          amm: '1285373456',
          amm_pools: 5,
          reserve_base: '1000000',
          reserve_inc: '200000',
          accounts: '8',
          owner_count: '28',
          minted_rewards: null,
          minted_import: null,
          minted_genesis: null,
        });
        // the row it returned is the one it wrote
        expect(await newestSnapshot(ch)).toEqual(row);
      });

      it('Xahau: one full cycle writes the row computed by hand', async () => {
        const ch = await fresh();
        await seedXahau(ch);

        const row = await wholeCycle(ch, xahau);

        // L = 2,300,000, closed at T0 + L. burned = the fees of the ledgers up to L: 100 + 2,000 + 30 + 400 + 5 = 2,535 (the 7,000,000
        // of the ledger after L is not in it). minted: rewards 1,000,000 + 250,000 = 1,250,000; imports 5,000,000 + 800,000 + 12,345 =
        // 5,812,345; genesis mints 120,000,000 + 7 + 30 = 120,000,037 (the 999 and the 77 after L are not in it). accounts: one and
        // three, of 2 + 4 = 6 owners. No AMM, and neither a network_state row nor a SetFee: no reserve values.
        expect(await stored(ch)).toEqual({
          ledger_index: 2_300_000,
          close_time: 1_762_300_000,
          started_at: 1_760_099_999,
          computed_at: 1_760_100_122,
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
        expect(await newestSnapshot(ch)).toEqual(row);
      });

      it('answers what it waits for when the cycle cannot start, and writes nothing', async () => {
        const ch = await fresh();
        expect(await computeSupplyCycle(ch, xahau, STARTED_AT, COMPUTED_AT)).toEqual({ waiting: 'escrows' });
        await ready(ch);
        expect(await computeSupplyCycle(ch, xrpl, STARTED_AT, COMPUTED_AT)).toEqual({ waiting: 'amm_pools' });
        expect(await newestSnapshot(ch)).toBeUndefined();
      });

      it('counts a ledger and an account state written twice once', async () => {
        const ch = await fresh();
        await stopMerges(ch, Table.Ledgers, Table.AccountStates);
        await seedXahau(ch, (table, rows) => insertTwice(ch, table, rows));
        // the premise: both are in the tables twice (no merge ran, and the second insert was not dropped by the dedup window)
        expect(await countOf(ch, `SELECT count() AS n FROM ${Table.Ledgers}`)).toBe(2 * 6);
        expect(await countOf(ch, `SELECT count() AS n FROM ${Table.AccountStates}`)).toBe(2 * 6);

        await wholeCycle(ch, xahau);

        // the figures of the world written once: burned 2,535 (not 5,070), 2 accounts of 6 owners (not 4 of 12)
        expect(await stored(ch)).toMatchObject({ burned: '2535', accounts: '2', owner_count: '6' });
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('the account ranges', () => {
      it('leaves out the accounts deleted at or before L and the AMM pool accounts', async () => {
        const ch = await fresh();
        await ready(ch, { head: L + 10 });
        await ch.insert(Table.AccountStates, [
          accountState('rLiveOne', 100, 2),
          accountState('rLiveTwo', 100, 1),
          accountState('rLiveTwo', 4_000, 3),
          accountState('rDeletedBeforeL', 100, 9),
          deletedState('rDeletedBeforeL', L - 1),
          accountState('rDeletedAtL', 100, 9),
          deletedState('rDeletedAtL', L),
          accountState('rDeletedAfterL', 100, 6),
          deletedState('rDeletedAfterL', L + 1),
          accountState('rOnlyAfterL', L + 1, 4),
          // the pools: one stored, one that is deleted (its account row is not), one that has no amm_pools row yet
          accountState(acct(1), 100, 1),
          accountState(acct(2), 100, 5),
          accountState(acct(3), 4_900, 7),
        ]);
        await ch.insert(Table.AmmPools, [pool(acct(1)), pool(acct(2), { deleted: 1 })]);
        await ch.insert(Table.AmmPoolStates, [ammState(acct(3), 4_900)]);
        await ch.insert(Table.AmmPoolTouches, [touch(4_900, acct(3))]);

        const cycle = await start(ch, xrpl, sight(4_000));
        expect(cycle.poolAccounts).toEqual([acct(1), acct(2), acct(3)]);
        const counted = await runWhile(ch, xrpl, cycle, 'accounts');
        // rLiveOne, rLiveTwo (its newest row, 3) and rDeletedAfterL (6): 3 accounts of 2 + 3 + 6 = 11 owners
        expect([counted.accounts, counted.ownerCount]).toEqual([3n, 11n]);
        expect(counted.pending.every((step) => step.kind !== 'accounts')).toBe(true);
      });

      it('gives each range the pool accounts inside it and no other, a few hundred, never the whole list', async () => {
        const ch = await fresh();
        // 15,000 pool accounts spread over the prefixes: the whole list would be about 525 KB of query parameter, over the 128 KiB a
        // request may carry
        const pools = Array.from(
          { length: 15_000 },
          (_, i) =>
            `r${SUPPLY_ACCOUNT_PREFIXES[(i * 7) % SUPPLY_ACCOUNT_PREFIXES.length]}Pool${String(i).padStart(8, '0')}`,
        ).sort();
        const query = jest.spyOn(ch, 'query');
        const done = await runWhile(
          ch,
          xrpl,
          cycleOf({
            poolAccounts: pools,
            pending: supplyAccountRanges().map((range) => ({ kind: 'accounts', range })),
          }),
          'accounts',
        );
        expect(done.pending).toEqual([]);
        const sent = query.mock.calls
          .filter(([sql]) => sql === SUPPLY_ACCOUNTS_SQL)
          .map(([, params]) => params as { lo: string; hi: string; pools: string[] });
        expect(sent).toHaveLength(106);
        for (const { lo, hi, pools: inside } of sent) {
          for (const account of inside) expect(account >= lo && account < hi).toBe(true);
          expect(JSON.stringify(inside).length).toBeLessThan(16 * 1024);
        }
        // every pool account went out once
        expect(sent.flatMap((s) => s.pools).sort()).toEqual(pools);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('the AMM steps', () => {
      /** A world at the XRPL's L with the head 200 ledgers on, so that the fill-forward window (160,000 ledgers) is below L. */
      const world = async (): Promise<ClickHouseService> => {
        const ch = await fresh();
        await ready(ch, { through: XRPL_L, head: XRPL_L + 200 });
        return ch;
      };

      it('fills a pool touched after L back to its state at L, the null of its newest row and a value out of the window included', async () => {
        const ch = await world();
        await ch.insert(Table.AmmPools, [
          // the pool was rebuilt after L: its row holds the state after L
          pool(acct(1), { last_ledger: XRPL_L + 100, reserve_base: '9999' }),
          pool(acct(2), { ...COUNTER_NATIVE, last_ledger: XRPL_L + 7, reserve_base: '10', reserve_counter: '1' }),
          pool(acct(3), { last_ledger: XRPL_L + 3, reserve_base: '500', deleted: 0 }),
        ]);
        await ch.insert(Table.AmmPoolStates, [
          // pool 1, native on the base side: the newest row at or before L has the base reserve and no counter reserve (the counter
          // is filled forward from the row before it)
          ammState(acct(1), XRPL_L - 300, { reserve_base: '300', reserve_counter: '4' }),
          ammState(acct(1), XRPL_L - 50, { reserve_base: '250.123456', reserve_counter: null }),
          ammState(acct(1), XRPL_L + 100, { reserve_base: '9999', reserve_counter: '4' }),
          // pool 2, native on the counter side: the counter reserve is null in the window and its value is about a million ledgers
          // back (160,000 are looked at first), so the fill-forward has to go further than its window to give the state at L
          ammState(acct(2), 9_000_000, { ...COUNTER_NATIVE, reserve_base: '8', reserve_counter: '77.5' }),
          ammState(acct(2), XRPL_L - 20, { ...COUNTER_NATIVE, reserve_base: '9', reserve_counter: null }),
          ammState(acct(2), XRPL_L + 7, { ...COUNTER_NATIVE, reserve_base: '10', reserve_counter: '1' }),
          // pool 3 was deleted before L, by a transaction that holds no reserve: the 500 of its older row is filled forward, and a
          // deleted pool holds nothing
          ammState(acct(3), XRPL_L - 100, { reserve_base: '500', reserve_counter: '5' }),
          ammState(acct(3), XRPL_L - 5, { reserve_base: null, reserve_counter: null, deleted: 1 }),
        ]);

        const cycle = await start(ch, xrpl, sight(XRPL_L));
        expect(stepsOf(cycle, 'amm')).toEqual([{ kind: 'amm', pools: [acct(1), acct(2), acct(3)] }]);
        expect([cycle.amm, cycle.ammPools]).toEqual([0n, 0]); // the rows past L are not counted at the start
        const filled = await runWhile(ch, xrpl, await runWhile(ch, xrpl, cycle, 'accounts'), 'amm');
        // pool 1: 250.123456 XRP; pool 2: 77.5 XRP
        expect([filled.amm, filled.ammPools]).toEqual([327_623_456n, 2]);
        expect(filled.poolsAtZero).toEqual([]);
      });

      it('a pool created after L holds nothing at L', async () => {
        const ch = await world();
        await ch.insert(Table.AmmPools, [
          pool(acct(1), { last_ledger: 100, reserve_base: '10' }),
          pool(acct(2), { last_ledger: XRPL_L + 50, reserve_base: '5000' }), // its only state row is past L
        ]);
        await ch.insert(Table.AmmPoolStates, [ammState(acct(2), XRPL_L + 50, { reserve_base: '5000' })]);
        const cycle = await runWhile(ch, xrpl, await start(ch, xrpl, sight(XRPL_L)), 'accounts');
        expect(cycle.pending).toEqual([{ kind: 'amm', pools: [acct(2)] }]);
        expect([cycle.amm, cycle.ammPools]).toEqual([10_000_000n, 1]);

        const after = await runSupplyStep(ch, xrpl, cycle);
        // the fill finds no row at or before L: nothing is added and nothing is wrong
        expect([after.amm, after.ammPools, after.poolsAtZero]).toEqual([10_000_000n, 1, []]);
        expect(after.pending).toEqual([]);
        expect(after.poolAccounts).toEqual([acct(1), acct(2)]);
      });

      it('counts a filled pool whose native reserve it cannot read at zero and lists it, so that no pool row stalls the cycle', async () => {
        const ch = await world();
        const pools = [
          pool(acct(1), { last_ledger: XRPL_L + 5 }),
          pool(acct(2), { last_ledger: XRPL_L + 5 }),
          pool(acct(3), { last_ledger: XRPL_L + 5 }),
          pool(acct(4), { ...COUNTER_NATIVE, last_ledger: XRPL_L + 5 }),
          pool(acct(5), { last_ledger: XRPL_L + 5, deleted: 1 }),
          pool(acct(6), { base_currency: 'EUR', base_issuer: ISSUER, last_ledger: XRPL_L + 5 }),
          pool(acct(7), { last_ledger: XRPL_L + 5 }),
        ];
        await ch.insert(Table.AmmPools, pools);
        const at = XRPL_L - 10;
        await ch.insert(Table.AmmPoolStates, [
          ammState(acct(1), at, { reserve_base: null, reserve_counter: '5' }), // the native side has never had a reserve
          ammState(acct(2), at, { reserve_base: '0.0000001' }), // not a whole number of drops
          ammState(acct(3), at, { reserve_base: 'abc' }),
          ammState(acct(4), at, { ...COUNTER_NATIVE, reserve_base: '5', reserve_counter: null }),
          ammState(acct(5), at, { reserve_base: null, deleted: 1 }), // deleted: nothing to know
          ammState(acct(6), at, { base_currency: 'EUR', base_issuer: ISSUER, reserve_base: null }), // no native side: nothing to know
          ammState(acct(7), at, { reserve_base: '20' }),
        ]);

        const cycle = await start(ch, xrpl, sight(XRPL_L));
        expect(stepsOf(cycle, 'amm')[0].pools).toHaveLength(7);
        const done = await runWhile(ch, xrpl, await runWhile(ch, xrpl, cycle, 'accounts'), 'amm');
        // only pool 7 is read: 20 XRP
        expect([done.amm, done.ammPools]).toEqual([20_000_000n, 1]);
        expect(done.poolsAtZero).toEqual([1, 2, 3, 4].map(acct));
        expect(done.pending).toEqual([]);
      });

      it('reads the deleted UInt8 of a filled pool as a number, whatever way the client writes it', async () => {
        const ch = await world();
        await ch.insert(Table.AmmPools, [
          pool(acct(1), { last_ledger: XRPL_L + 5 }),
          pool(acct(2), { last_ledger: XRPL_L + 5 }),
        ]);
        await ch.insert(Table.AmmPoolStates, [
          ammState(acct(1), XRPL_L - 10, { reserve_base: '500', deleted: 0 }),
          ammState(acct(1), XRPL_L - 5, { reserve_base: null, reserve_counter: null, deleted: 1 }),
          ammState(acct(2), XRPL_L - 10, { reserve_base: '20', deleted: 0 }),
        ]);
        const cycle = await runWhile(ch, xrpl, await start(ch, xrpl, sight(XRPL_L)), 'accounts');
        // a client that quotes its integers answers '0' (a text, and true) for a pool that is not deleted, and '1' for one that is
        const read = ch.query.bind(ch);
        jest
          .spyOn(ch, 'query')
          .mockImplementation((async (sql: string, params?: Record<string, unknown>) =>
            (await read(sql, params)).map((row: Record<string, unknown>) =>
              'newest_deleted' in row ? { ...row, newest_deleted: String(row.newest_deleted) } : row,
            )) as typeof ch.query);
        const done = await runSupplyStep(ch, xrpl, cycle);
        expect([done.amm, done.ammPools]).toEqual([20_000_000n, 1]);
      });

      it('lists a pool it cannot read once, beside the pools the start could not read', async () => {
        const ch = await world();
        await ch.insert(Table.AmmPools, [
          pool(acct(1), { last_ledger: 100, reserve_base: 'abc' }), // unreadable at the start
          pool(acct(2), { last_ledger: XRPL_L + 5 }),
          pool(acct(3), { last_ledger: XRPL_L + 5 }),
        ]);
        await ch.insert(Table.AmmPoolStates, [
          ammState(acct(2), XRPL_L - 10, { reserve_base: '12abc' }),
          ammState(acct(3), XRPL_L - 10, { reserve_base: '1' }),
        ]);
        const cycle = await start(ch, xrpl, sight(XRPL_L));
        expect(cycle.poolsAtZero).toEqual([acct(1)]);
        const done = await runWhile(ch, xrpl, await runWhile(ch, xrpl, cycle, 'accounts'), 'amm');
        expect(done.poolsAtZero).toEqual([acct(1), acct(2)]);
        expect([done.amm, done.ammPools]).toEqual([1_000_000n, 1]);
      });

      it('runs a step of 200 pools as one fill-forward and adds every pool of it', async () => {
        const ch = await world();
        const count = AMM_POOLS_CHUNK + 1; // two steps, the second of one pool
        await ch.insert(
          Table.AmmPools,
          Array.from({ length: count }, (_, i) => pool(acct(i + 1), { last_ledger: XRPL_L + 5 })),
        );
        await ch.insert(
          Table.AmmPoolStates,
          Array.from({ length: count }, (_, i) => ammState(acct(i + 1), XRPL_L - 10, { reserve_base: String(i + 1) })),
        );
        const cycle = await runWhile(ch, xrpl, await start(ch, xrpl, sight(XRPL_L)), 'accounts');
        expect(stepsOf(cycle, 'amm').map((s) => s.pools.length)).toEqual([AMM_POOLS_CHUNK, 1]);
        const first = await runSupplyStep(ch, xrpl, cycle);
        // pools 1 to 200 hold 1 to 200 XRP: 200 × 201 / 2 = 20,100 XRP
        expect([first.amm, first.ammPools]).toEqual([20_100_000_000n, AMM_POOLS_CHUNK]);
        const second = await runSupplyStep(ch, xrpl, first);
        expect([second.amm, second.ammPools]).toEqual([20_100_000_000n + 201_000_000n, AMM_POOLS_CHUNK + 1]);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('a step', () => {
      const BURNED_AND_MINTED: SupplyStep[] = [
        { kind: 'burned', from: 10, to: 11 },
        { kind: 'minted', from: 10, to: 11 },
        { kind: 'minted', from: 12, to: 12 },
      ];

      async function seedSmall(ch: ClickHouseService): Promise<void> {
        await ch.insert(Table.Ledgers, [
          ledgerRow(10, { fee_total: 7 }),
          ledgerRow(11, { fee_total: 9 }),
          ledgerRow(12, { fee_total: 1_000 }),
        ]);
        await ch.insert(Table.GenesisMints, [mintRow(10, 100, ''), mintRow(11, 20, 'CL'), mintRow(12, 4_000, '')]);
        await ch.insert(Table.RewardClaims, [claimRow(10, 'CL')]);
        await ch.insert(Table.Imports, [importRow(11, 3)]);
      }

      it('adds its result to the cycle, takes the step off the plan, and leaves the cycle it was given as it was', async () => {
        const ch = await fresh();
        await seedSmall(ch);
        // a frozen cycle: a step that changes a cycle in place throws
        const cycle = deepFreeze(
          cycleOf({
            burned: 5n,
            minted: { rewards: 1n, import: 2n, genesis_mint: 3n },
            pending: BURNED_AND_MINTED,
            steps: 3,
          }),
        );
        const burned = await runSupplyStep(ch, xahau, cycle);
        // the fees of the ledgers 10 and 11: 7 + 9 = 16 (the 1,000 of ledger 12 is not in the slice)
        expect(burned.burned).toBe(5n + 16n);
        expect(burned.pending).toEqual(BURNED_AND_MINTED.slice(1));
        expect(burned.minted).toEqual({ rewards: 1n, import: 2n, genesis_mint: 3n });

        const minted = await runSupplyStep(ch, xahau, burned);
        // the ledgers 10 and 11: a genesis mint of 100, a reward of 20 (its parent is the claim of ledger 10), an import of 3
        expect(minted.minted).toEqual({ rewards: 1n + 20n, import: 2n + 3n, genesis_mint: 3n + 100n });
        expect(minted.burned).toBe(21n);
        expect(minted.pending).toEqual(BURNED_AND_MINTED.slice(2));

        const last = await runSupplyStep(ch, xahau, minted);
        // ledger 12: a genesis mint of 4,000
        expect(last.minted).toEqual({ rewards: 21n, import: 5n, genesis_mint: 4_103n });
        expect(last.pending).toEqual([]);

        // the cycles it was given are as they were
        expect(cycle.burned).toBe(5n);
        expect(cycle.minted).toEqual({ rewards: 1n, import: 2n, genesis_mint: 3n });
        expect(cycle.pending).toHaveLength(3);
        expect(burned.minted).toEqual({ rewards: 1n, import: 2n, genesis_mint: 3n });
        expect(minted.pending).toHaveLength(1);
      });

      it('leaves the count of steps of the plan as the start made it', async () => {
        const ch = await fresh();
        await seedSmall(ch);
        const cycle = cycleOf({
          minted: { rewards: 0n, import: 0n, genesis_mint: 0n },
          pending: BURNED_AND_MINTED,
          steps: 3,
        });
        let current = cycle;
        while (current.pending.length > 0) current = await runSupplyStep(ch, xahau, current);
        // it is how many steps the plan had, the number a log line gives, not how many are left or done
        expect(current.steps).toBe(3);
      });

      it.each<[string, Partial<SupplyCycle>]>([
        ['accounts', { pending: [{ kind: 'accounts', range: { lo: 'r', hi: 's' } }] }],
        ['amm', { amm: 0n, pending: [{ kind: 'amm', pools: [acct(1)] }] }],
        ['burned', { pending: [{ kind: 'burned', from: 1, to: 10 }] }],
        [
          'minted',
          { minted: { rewards: 0n, import: 0n, genesis_mint: 0n }, pending: [{ kind: 'minted', from: 1, to: 10 }] },
        ],
      ])(
        'the %s step that throws leaves the cycle as it was, so that it is run again as it was',
        async (_kind, over) => {
          const ch = await fresh();
          const cycle = deepFreeze(cycleOf(over));
          const before = structuredClone(cycle);
          jest.spyOn(ch, 'query').mockRejectedValueOnce(new Error('the server went away'));
          await expect(runSupplyStep(ch, xrpl, cycle)).rejects.toThrow('the server went away');
          expect(cycle).toEqual(before);
          // the next try is the same step, and it works
          const again = await runSupplyStep(ch, xrpl, cycle);
          expect(again.pending).toEqual(before.pending.slice(1));
        },
      );

      it('throws when no step is left, and for a step the cycle has no use for, without a read', async () => {
        const ch = await fresh();
        const query = jest.spyOn(ch, 'query');
        await expect(runSupplyStep(ch, xrpl, cycleOf())).rejects.toThrow('no step');
        await expect(
          runSupplyStep(ch, xahau, cycleOf({ amm: null, pending: [{ kind: 'amm', pools: [acct(1)] }] })),
        ).rejects.toThrow('amm');
        await expect(
          runSupplyStep(ch, xrpl, cycleOf({ minted: null, pending: [{ kind: 'minted', from: 1, to: 2 }] })),
        ).rejects.toThrow('minted');
        expect(query).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('the snapshot row and its write', () => {
      const full = (): SupplyCycle =>
        cycleOf({
          ledger: 107_747_456,
          closeTime: 1_761_000_000,
          startedAt: 1_760_999_900,
          totalCoins: 99_985_312_374_716_318n,
          escrowed: 35_212_847_105_402_318n,
          escrowCount: 12_879,
          reserveBase: 1_000_000n,
          reserveInc: 200_000n,
          amm: 9_007_199_254_740_993n,
          ammPools: 14_594,
          accounts: 6_410_280n,
          ownerCount: 16_998_620n,
          burned: 14_687_625_283_682n,
          minted: { rewards: 41_203_318_512_207n, import: 8_102_233_104n, genesis_mint: 120_000n },
        });

      it('has the columns of network_supply in their order, the drops as decimal strings', async () => {
        const ch = await fresh();
        const row = supplySnapshotRow(full(), 1_761_000_100, 1_761_000_100_123);
        expect(row).toEqual({
          ledger_index: 107_747_456,
          close_time: 1_761_000_000,
          started_at: 1_760_999_900,
          computed_at: 1_761_000_100,
          total_coins: '99985312374716318',
          burned: '14687625283682',
          escrowed: '35212847105402318',
          escrow_count: '12879',
          amm: '9007199254740993',
          amm_pools: 14_594,
          reserve_base: '1000000',
          reserve_inc: '200000',
          accounts: '6410280',
          owner_count: '16998620',
          minted_rewards: '41203318512207',
          minted_import: '8102233104',
          minted_genesis: '120000',
          version: '1761000100123',
        });
        const columns = await ch.query<{ name: string }>(
          `SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {t:String} ORDER BY position`,
          { t: Table.NetworkSupply },
        );
        expect(Object.keys(row)).toEqual(columns.map((c) => c.name));
      });

      it('leaves NULL the parts the cycle does not have: no AMM, no reserve values, no minting', () => {
        const row = supplySnapshotRow(
          { ...full(), amm: null, ammPools: 0, reserveBase: null, reserveInc: null, minted: null },
          1_761_000_100,
          5,
        );
        expect(row).toMatchObject({
          amm: null,
          amm_pools: 0,
          reserve_base: null,
          reserve_inc: null,
          minted_rewards: null,
          minted_import: null,
          minted_genesis: null,
        });
        // and a zero is a zero, not a NULL: an AMM with no native coin, minting that has minted nothing
        const zeros = supplySnapshotRow(
          {
            ...full(),
            amm: 0n,
            minted: { rewards: 0n, import: 0n, genesis_mint: 0n },
            reserveBase: 0n,
            reserveInc: 0n,
          },
          1_761_000_100,
          5,
        );
        expect(zeros).toMatchObject({
          amm: '0',
          minted_rewards: '0',
          minted_import: '0',
          minted_genesis: '0',
          reserve_base: '0',
          reserve_inc: '0',
        });
      });

      it('stores the row as the api reads it back, NULLs included', async () => {
        const ch = await fresh();
        const cycle = { ...full(), amm: null, reserveBase: null, reserveInc: null, minted: null };
        const written = await writeSupplySnapshot(ch, cycle, 1_761_000_100);
        expect(written.computed_at).toBe(1_761_000_100);
        expect(await newestSnapshot(ch)).toEqual(written);
        expect(written).toMatchObject({ amm: null, reserve_base: null, reserve_inc: null, minted_import: null });
      });

      it('writes the same ledger again under a newer version, and the newest snapshot is the second', async () => {
        const ch = await fresh();
        await stopMerges(ch, Table.NetworkSupply);
        const first = await writeSupplySnapshot(ch, { ...full(), accounts: 1n }, 1_761_000_100);
        const second = await writeSupplySnapshot(ch, { ...full(), accounts: 2n }, 1_761_000_200);
        expect(BigInt(second.version)).toBeGreaterThan(BigInt(first.version));
        // two rows of the one key, until a merge
        expect(await countOf(ch, `SELECT count() AS n FROM ${Table.NetworkSupply}`)).toBe(2);
        expect(await newestSnapshot(ch)).toEqual(second);
        expect((await newestSnapshot(ch))?.accounts).toBe('2');
      });

      it('takes a version one above the newest of its own ledger when the clock is behind it, and none from another ledger', async () => {
        const ch = await fresh();
        const ahead = BigInt(Date.now()) + 3_600_000n; // a snapshot written by a clock an hour fast
        const base = supplySnapshotRow(full(), 1_761_000_100, 1);
        await ch.insert(Table.NetworkSupply, [{ ...base, version: String(ahead) }]);
        await ch.insert(Table.NetworkSupply, [
          { ...base, ledger_index: base.ledger_index + 1, version: String(ahead * 2n) },
        ]);

        const again = await writeSupplySnapshot(ch, full(), 1_761_000_200);
        expect(again.version).toBe(String(ahead + 1n)); // not the clock, and not the other ledger's
        const other = await writeSupplySnapshot(ch, { ...full(), ledger: full().ledger + 2 }, 1_761_000_200);
        expect(BigInt(other.version)).toBeLessThan(ahead); // a ledger of its own: the clock
      });

      it('writes nothing once aborted', async () => {
        const ch = await fresh();
        const aborted = new AbortController();
        aborted.abort();
        const read = ch.query.bind(ch);
        const query = jest.spyOn(ch, 'query');
        const insert = jest.spyOn(ch, 'insert');
        await expect(writeSupplySnapshot(ch, full(), 1_761_000_100, aborted.signal)).rejects.toBeInstanceOf(
          AggregateSetAborted,
        );
        expect(query).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();

        // aborted while the version is read: the insert is not made
        const late = new AbortController();
        query.mockImplementationOnce((async (sql: string, params?: Record<string, unknown>) => {
          const rows = await read(sql, params);
          late.abort();
          return rows;
        }) as typeof ch.query);
        await expect(writeSupplySnapshot(ch, full(), 1_761_000_100, late.signal)).rejects.toBeInstanceOf(
          AggregateSetAborted,
        );
        expect(insert).not.toHaveBeenCalled();
        expect(await newestSnapshot(ch)).toBeUndefined();
      });

      it('writes when its signal is not aborted', async () => {
        const ch = await fresh();
        const written = await writeSupplySnapshot(ch, full(), 1_761_000_100, new AbortController().signal);
        expect(await newestSnapshot(ch)).toEqual(written);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe('what the steps read', () => {
      // Each table holds, besides the rows a step needs, bulks of rows it must skip: more than the bound of the read, in the very parts
      // it reads (both sides of its rows) and in the other partitions. The merges are stopped, so every insert stays a part of its own.
      // The bound is the rows the read needs and two granules for each part that holds some of them.
      const currentDatabase = async (ch: ClickHouseService): Promise<string> =>
        ((await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db')) as { db: string }).db;

      interface Stage {
        keys: string[];
        condition: string;
        granules: [number, number];
      }

      /** The primary key stage of an `EXPLAIN indexes = 1`: the columns it searches, its condition, the granules it keeps of the table's. */
      async function primaryKeyStage(
        ch: ClickHouseService,
        sql: string,
        params: Record<string, unknown>,
      ): Promise<Stage> {
        const lines = (await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params)).map((r) =>
          r.explain.trim(),
        );
        const at = lines.indexOf('PrimaryKey');
        expect(at).toBeGreaterThan(-1);
        const keysAt = lines.indexOf('Keys:', at);
        const conditionAt = lines.findIndex((line, i) => i > at && line.startsWith('Condition:'));
        const granules = lines.slice(at).find((line) => line.startsWith('Granules:')) as string;
        const [kept, all] = granules.slice('Granules:'.length).trim().split('/').map(Number);
        return { keys: lines.slice(keysAt + 1, conditionAt), condition: lines[conditionAt], granules: [kept, all] };
      }

      describe('an account range', () => {
        const RANGE = supplyAccountRanges()[60];
        const PARTS = 4; // inserts, so parts
        const BULK = 30_000; // accounts below the range, and as many above it, in every part
        const BASE = 2_000; // accounts of the range in every part, at ledger 10 (owner count 2)
        const DELETED = 200; // of them, deleted at ledger 20
        const AFTER = 200; // other ones of them, with a row after L (owner count 9)
        const INSIDE = (BASE + DELETED + AFTER) * PARTS;
        const INSIDE_WHERE = 'account >= {lo:String} AND account < {hi:String}';
        const params = { lo: RANGE.lo, hi: RANGE.hi };
        let ch: ClickHouseService;

        beforeAll(async () => {
          ch = await fresh();
          await stopMerges(ch, Table.AccountStates);
          for (let part = 0; part < PARTS; part++) {
            // accounts `<prefix>p<part><n>`: a different one in every part; the columns in the table's order
            const accounts = (
              prefix: string,
              count: number,
              from: number,
              ledger: number,
              owner: number,
              deleted: number,
            ) => `
              SELECT concat({${prefix}:String}, 'p', toString({part:UInt8}), leftPad(toString(n.number + ${from}), 8, '0')),
                     toUInt32(${ledger}), toUInt32(0), toUInt16(0), '', toDateTime(1700000000, 'UTC'), '1', toUInt32(0),
                     toUInt32(1), toUInt32(${owner}), '', toUInt8(${deleted})
                FROM numbers(${count}) AS n`;
            await ch.command(
              `INSERT INTO ${Table.AccountStates} ${[
                accounts('below', BULK, 0, 10, 2, 0),
                accounts('lo', BASE, 0, 10, 2, 0),
                accounts('lo', DELETED, 0, 20, 0, 1),
                accounts('lo', AFTER, DELETED, L + 1, 9, 0),
                accounts('above', BULK, 0, 10, 2, 0),
              ].join('\nUNION ALL\n')}`,
              { below: 'r11', lo: RANGE.lo, above: 'rzz', part },
            );
          }
        });

        it('has a bulk each side of the range in every part, more than the bound of the read', async () => {
          expect(
            await countOf(ch, `SELECT count() AS n FROM ${Table.AccountStates} WHERE ${INSIDE_WHERE}`, params),
          ).toBe(INSIDE);
          expect(await partsWith(ch, Table.AccountStates, INSIDE_WHERE, params)).toBe(PARTS);
          expect(await granuleOf(ch, Table.AccountStates)).toBe(GRANULE);
          const limit = await bound(ch, Table.AccountStates, INSIDE, INSIDE_WHERE, params);
          expect(PARTS * BULK).toBeGreaterThan(limit);
          expect(
            await countOf(ch, `SELECT count() AS n FROM ${Table.AccountStates} WHERE account < {lo:String}`, params),
          ).toBe(PARTS * BULK);
          expect(
            await countOf(ch, `SELECT count() AS n FROM ${Table.AccountStates} WHERE account >= {hi:String}`, params),
          ).toBe(PARTS * BULK);
        });

        it('EXPLAIN: the primary key is searched on the account, and keeps a small part of the table', async () => {
          const stage = await primaryKeyStage(ch, SUPPLY_ACCOUNTS_SQL, { ...params, L, pools: [] });
          expect(stage.keys[0]).toBe('account');
          expect(stage.condition).toContain('account');
          expect(stage.granules[0] * 5).toBeLessThan(stage.granules[1]);
        });

        it('reads about the rows of its range and nothing of the table beyond them, and no other table', async () => {
          let cycle: SupplyCycle | undefined;
          const all = await logged(
            ch,
            async () => {
              cycle = await runSupplyStep(ch, xrpl, cycleOf({ pending: [{ kind: 'accounts', range: RANGE }] }));
            },
            Table.AccountStates,
          );
          expect(all).toHaveLength(1);
          const limit = await bound(ch, Table.AccountStates, INSIDE, INSIDE_WHERE, params);
          expect(all[0].read_rows).toBeLessThanOrEqual(limit);
          expect(all[0].read_rows).toBeGreaterThanOrEqual(INSIDE);
          expect(all[0].tables).toEqual([`${await currentDatabase(ch)}.${Table.AccountStates}`]);
          // the answer: 1,800 accounts of owner count 2 in every part (the deleted ones are out, and the row after L is not seen)
          expect([cycle?.accounts, cycle?.ownerCount]).toEqual([
            BigInt(PARTS * (BASE - DELETED)),
            BigInt(PARTS * 2 * (BASE - DELETED)),
          ]);
        });
      });

      describe('a burned slice', () => {
        // a partition of ledgers (2,000,000 to 2,059,999) in one part, the slice in the middle of it; two other partitions of 30,000
        const FROM = 2_025_000;
        const TO = 2_028_999;
        const NEEDED = TO - FROM + 1;
        const SLICE_WHERE = 'ledger_index BETWEEN {from:UInt32} AND {to:UInt32}';
        const params = { from: FROM, to: TO };
        let ch: ClickHouseService;

        beforeAll(async () => {
          ch = await fresh();
          await stopMerges(ch, Table.Ledgers);
          const ledgers = (base: number, rows: number) =>
            ch.command(
              `INSERT INTO ${Table.Ledgers} (ledger_index, ledger_hash, total_coins, close_time, fee_total, parser_version)
               SELECT toUInt32({base:UInt32} + n.number), concat('H', toString(n.number)), toUInt64(1), toDateTime(1700000000, 'UTC'),
                      toUInt64(if(toUInt32({base:UInt32} + n.number) BETWEEN {from:UInt32} AND {to:UInt32}, 3, 1000)),
                      toUInt16(${MINT_PARSER_VERSION})
                 FROM numbers({rows:UInt32}) AS n`,
              { base, rows, ...params },
            );
          await ledgers(2_000_000, 60_000);
          await ledgers(1_000_000, 30_000);
          await ledgers(3_000_000, 30_000);
        });

        it('has a bulk each side of the slice in its part, and in the partitions beside it, more than the bound of the read', async () => {
          expect(await countOf(ch, `SELECT count() AS n FROM ${Table.Ledgers} WHERE ${SLICE_WHERE}`, params)).toBe(
            NEEDED,
          );
          expect(await partsWith(ch, Table.Ledgers, SLICE_WHERE, params)).toBe(1);
          const limit = await bound(ch, Table.Ledgers, NEEDED, SLICE_WHERE, params);
          expect(
            await countOf(ch, `SELECT count() AS n FROM ${Table.Ledgers} WHERE ledger_index < {from:UInt32}`, params),
          ).toBe(
            55_000, // 25,000 below the slice in its part, 30,000 in the partition before it
          );
          expect(FROM - 2_000_000).toBeGreaterThan(limit); // below the slice, in its part
          expect(2_060_000 - TO - 1).toBeGreaterThan(limit); // above it
          expect(30_000).toBeGreaterThan(limit); // each of the other partitions
        });

        it('reads the ledgers of its slice and nothing else: no other table, no ledger beyond its ends', async () => {
          let cycle: SupplyCycle | undefined;
          const all = await logged(
            ch,
            async () => {
              cycle = await runSupplyStep(
                ch,
                xahau,
                cycleOf({ burned: 5n, pending: [{ kind: 'burned', from: FROM, to: TO }] }),
              );
            },
            Table.Ledgers,
          );
          expect(all).toHaveLength(1);
          const limit = await bound(ch, Table.Ledgers, NEEDED, SLICE_WHERE, params);
          expect(all[0].read_rows).toBeLessThanOrEqual(limit);
          expect(all[0].read_rows).toBeGreaterThanOrEqual(NEEDED);
          expect(all[0].tables).toEqual([`${await currentDatabase(ch)}.${Table.Ledgers}`]);
          // 3 drops of fee in each of the ledgers of the slice, on top of the 5 the cycle had
          expect(cycle?.burned).toBe(5n + BigInt(3 * NEEDED));
        });
      });

      describe('an amm step', () => {
        // two pools (the base and the counter of a pair are the native side of one each), each with 30,000 rows below the window of
        // the fill-forward, 2,000 in it, 30,000 after L; and 30,000 rows of other pools each side of them, in the same part
        const AL = 1_000_000;
        const FROM = AL - AMM_FILL_WINDOW_LEDGERS;
        const BELOW = 30_000;
        const WINDOW = 2_000;
        const AFTER = 30_000;
        const P = acct(100);
        const Q = acct(200);
        const WINDOW_WHERE = 'amm_account = {account:String} AND ledger_index BETWEEN {from:UInt32} AND {to:UInt32}';
        let ch: ClickHouseService;

        beforeAll(async () => {
          ch = await fresh();
          await stopMerges(ch, Table.AmmPoolStates);
          // a state row: its pair (the native side holds the reserve under test, the other 5 or 3), its place and its reserves
          const rows = (
            account: string,
            counter: boolean,
            count: number,
            first: number,
            reserve: string,
            lastRow?: string,
          ) => {
            const native =
              lastRow === undefined ? `'${reserve}'` : `if(n.number = ${count - 1}, '${lastRow}', '${reserve}')`;
            return `SELECT '${account}', toUInt32(${first} + n.number), toUInt32(0), '', toDateTime(1700000000, 'UTC'), 'AMMDeposit',
                   '${counter ? 'USD' : 'XRP'}', '${counter ? ISSUER : ''}', '${counter ? 'XRP' : 'USD'}', '${counter ? '' : ISSUER}',
                   ${counter ? "'3'" : native}, ${counter ? native : "'5'"}, toUInt8(0)
              FROM numbers(${count}) AS n`;
          };
          const pool = (account: string, counter: boolean, windowLast: string) => [
            rows(account, counter, BELOW, 100_000, '5'),
            rows(account, counter, WINDOW, 900_000, '5', windowLast),
            rows(account, counter, AFTER, AL + 1, '1000'),
          ];
          const other = (prefix: string, count: number) => `
            SELECT concat('${prefix}', leftPad(toString(n.number % 50), 2, '0')), toUInt32(100000 + n.number), toUInt32(0), '',
                   toDateTime(1700000000, 'UTC'), 'AMMDeposit', 'XRP', '', 'USD', '${ISSUER}', '5', '5', toUInt8(0)
              FROM numbers(${count}) AS n`;
          await ch.command(
            `INSERT INTO ${Table.AmmPoolStates}
               (amm_account, ledger_index, tx_index, tx_hash, close_time, tx_type, base_currency, base_issuer, counter_currency,
                counter_issuer, reserve_base, reserve_counter, deleted)
             ${[
               other('rAmm0000', 15_000),
               ...pool(P, false, '7.5'),
               ...pool(Q, true, '2.25'),
               other('rAmm0003', 15_000),
             ].join('\nUNION ALL\n')}`,
          );
          // another part, of other pools
          await ch.command(
            `INSERT INTO ${Table.AmmPoolStates}
               (amm_account, ledger_index, tx_index, tx_hash, close_time, tx_type, base_currency, base_issuer, counter_currency,
                counter_issuer, reserve_base, reserve_counter, deleted)
             ${other('rAmm0004', 30_000)}`,
          );
        });

        const limit = async (): Promise<number> => {
          let total = 0;
          for (const account of [P, Q]) {
            total += await bound(ch, Table.AmmPoolStates, WINDOW, WINDOW_WHERE, { account, from: FROM, to: AL });
          }
          return total;
        };

        it('has bulks to skip around the window of each pool, more than the bound of the read', async () => {
          for (const account of [P, Q]) {
            const own = { account, from: FROM, to: AL };
            expect(
              await countOf(ch, `SELECT count() AS n FROM ${Table.AmmPoolStates} WHERE ${WINDOW_WHERE}`, own),
            ).toBe(WINDOW);
            expect(await partsWith(ch, Table.AmmPoolStates, WINDOW_WHERE, own)).toBe(1);
            expect(
              await countOf(
                ch,
                `SELECT count() AS n FROM ${Table.AmmPoolStates} WHERE amm_account = {account:String} AND ledger_index < {from:UInt32}`,
                own,
              ),
            ).toBe(BELOW);
            expect(
              await countOf(
                ch,
                `SELECT count() AS n FROM ${Table.AmmPoolStates} WHERE amm_account = {account:String} AND ledger_index > {to:UInt32}`,
                own,
              ),
            ).toBe(AFTER);
          }
          // the bound of the read is that of the two pools, and each side of each pool is more than the bound of one
          const eachPool = (await limit()) / 2;
          expect(BELOW).toBeGreaterThan(eachPool);
          expect(AFTER).toBeGreaterThan(eachPool);
          expect(await granuleOf(ch, Table.AmmPoolStates)).toBe(GRANULE);
        });

        it('reads the window of its pools in the state rows and nothing else, and the pools at L are the ones it adds', async () => {
          let cycle: SupplyCycle | undefined;
          const all = await logged(
            ch,
            async () => {
              cycle = await runSupplyStep(
                ch,
                xrpl,
                cycleOf({ ledger: AL, amm: 0n, pending: [{ kind: 'amm', pools: [P, Q] }] }),
              );
            },
            Table.AmmPoolStates,
          );
          expect(all).toHaveLength(1);
          expect(all[0].read_rows).toBeLessThanOrEqual(await limit());
          expect(all[0].read_rows).toBeGreaterThanOrEqual(2 * WINDOW);
          expect(all[0].tables).toEqual([`${await currentDatabase(ch)}.${Table.AmmPoolStates}`]);
          // P: 7.5 XRP in the last row of its window; Q: 2.25 XRP on the counter side
          expect([cycle?.amm, cycle?.ammPools, cycle?.poolsAtZero]).toEqual([9_750_000n, 2, []]);
        });
      });
    });
  });
});

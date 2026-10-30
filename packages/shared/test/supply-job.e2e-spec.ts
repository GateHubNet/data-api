import { AMM_POOLS_CHUNK, POOLS_CHANGED_SINCE_SQL, poolsChangedSince } from '../src/aggregate/amm-pools.job';
import { supplyAccountRanges } from '../src/aggregate/supply';
import {
  stalePoolsUpTo,
  startSupplyCycle,
  SUPPLY_AMM_TOUCHED_LIMIT,
  SUPPLY_INTERVAL_MS,
  SUPPLY_MAX_LAG_LEDGERS,
  SUPPLY_START_WAIT_TICKS,
  SupplyAmmSight,
  SupplyCycle,
  SupplyStep,
} from '../src/aggregate/supply.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AmmPoolsRow, EscrowsRow, MINT_PARSER_VERSION, NetworkStateRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { getNetworkProfile } from '../src/network';
import { mintSlices } from '../src/query/supply';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The start of a supply cycle (`startSupplyCycle`) on a real ClickHouse: when a cycle starts and at which ledger, what the first
 * tick reads (the ledger L, the escrowed total, the reserve values, the first part of the AMM) and the plan of steps it leaves.
 *
 * Part 1 is the choice of L and the waits. Part 2 is the reads of the first tick on both networks. Part 3 is the AMM: the pools
 * that count at their stored row, the pools to fill forward, the set-aside pools and the rows that cannot be read. Part 4 is the
 * plan of steps and the start of the minted steps. Part 5 pins what the reserve lookups read, over bulks they must skip.
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
});

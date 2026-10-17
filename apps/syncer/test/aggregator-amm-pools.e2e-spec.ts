import {
  AmmPoolStatesRow,
  buildLedgerRows,
  ClickHouseService,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  parseContextFor,
  RatesService,
  recomputeAmmPools,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The `amm_pools` job of the `AggregatorService` against a real ClickHouse: the 16 whole mainnet ledgers of the AMM fixtures
 * (swaps, deposits, withdrawals, votes, bids, a create and a delete), written by the real `LedgerWriter`. What a pool holds is
 * checked against an oracle in `packages/shared/test/amm-pools-job.e2e-spec.ts`; here it is the job that is on trial: what a tick
 * writes, that the cursor is in the tables and so survives a restart, and the hook of `agg_dirty`.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const LEDGERS = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/amm')).list();
const STATES: AmmPoolStatesRow[] = LEDGERS.flatMap((raw) => buildLedgerRows(raw, ctx).ammPoolStates);
const POOLS = [...new Set(STATES.map((s) => s.amm_account))].sort();
const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The XRP/RLUSD pool: seven state rows over six ledgers. */
const RLUSD_POOL = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
const NEWEST_LEDGER = Math.max(...STATES.map((s) => s.ledger_index));
const NEWEST_CLOSE = Math.max(...LEDGERS.map((l) => l.header.close_time));
/** A moment after the ingest: the stats have nothing to do but jump from ledger to ledger. */
const NOW = new Date((NEWEST_CLOSE + 7200) * 1000);

interface StoredPool {
  amm_account: string;
  last_ledger: number;
  reserve_base: string | null;
  trading_fee: number | null;
  value_native: number | null;
  version: number;
}

describe('AggregatorService amm_pools job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database with the AMM ledgers in it. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_amm_pools_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    await new LedgerWriter(svc, ctx).write(LEDGERS);
    return svc;
  }

  /** An aggregator that has the pools job and, of the stats, only the walk from ledger to ledger (the stats have their own tests). */
  function aggregator(ch: ClickHouseService): AggregatorService {
    const svc = new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      ammPools: { rates: new RatesService(ch, 'XRP') },
      recompute: async () => 0,
    });
    aggregators.push(svc);
    return svc;
  }

  /** The newest version of each pool. */
  async function pools(ch: ClickHouseService): Promise<Map<string, StoredPool>> {
    const rows = await ch.query<StoredPool>(
      `SELECT amm_account, last_ledger, reserve_base, trading_fee, value_native, version
         FROM ${Table.AmmPools}
        ORDER BY amm_account, version DESC
        LIMIT 1 BY amm_account`,
    );
    return new Map(rows.map((r) => [r.amm_account, { ...r, version: Number(r.version) }]));
  }

  const rowCount = async (ch: ClickHouseService): Promise<number> =>
    Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${Table.AmmPools}`))?.n);

  /**
   * State rows made by hand, and their touches: the ledger writer writes both, and then the `ledgers` row of each new ledger
   * (the rows of a ledger that is not committed are not read).
   */
  async function insertStates(ch: ClickHouseService, rows: AmmPoolStatesRow[]): Promise<void> {
    await ch.insert(Table.AmmPoolStates, rows);
    await ch.insert(
      Table.AmmPoolTouches,
      rows.map(({ ledger_index, tx_index, amm_account }) => ({ ledger_index, tx_index, amm_account })),
    );
    const added = new Map(
      rows.filter((r) => r.ledger_index > NEWEST_LEDGER).map((r) => [r.ledger_index, r.close_time]),
    );
    await ch.insert(
      Table.Ledgers,
      [...added].map(([ledger, close]) => ({
        ledger_index: ledger,
        ledger_hash: String(ledger).padStart(64, 'D'),
        close_time: close,
      })),
    );
  }

  /** A state row of a pool, made by hand, at the ledger of one of its real rows. */
  function extraState(pool: string, ledger: number, over: Partial<AmmPoolStatesRow>): AmmPoolStatesRow {
    const real = STATES.find((s) => s.amm_account === pool && s.ledger_index === ledger) as AmmPoolStatesRow;
    return {
      ...real,
      tx_index: 9000,
      tx_hash: 'AB'.repeat(32),
      tx_type: 'AMMVote',
      reserve_base: null,
      reserve_counter: null,
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
    };
  }

  it('the first tick rebuilds every pool of the ledgers, from the tables', async () => {
    const ch = await fresh();
    expect(await rowCount(ch)).toBe(0);
    await aggregator(ch).tick(NOW);
    const all = await pools(ch);
    expect([...all.keys()].sort()).toEqual(POOLS);
    expect(all.size).toBeGreaterThan(50);
    expect(all.get(RLUSD_POOL)).toMatchObject({
      last_ledger: NEWEST_LEDGER,
      reserve_base: '2417282.053464318',
      trading_fee: 205,
      value_native: 3695382.069072,
    });
  });

  it('a second tick, and a restarted aggregator, rebuild nothing: the cursor is in the tables', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    const written = await rowCount(ch);
    expect(written).toBe(POOLS.length);

    await svc.tick(NOW);
    expect(await rowCount(ch)).toBe(written);

    // a new process: it finds where the job was from `amm_pool_states` and `amm_pools`, and has nothing to do
    await aggregator(ch).tick(NOW);
    expect(await rowCount(ch)).toBe(written);
  });

  it('a pool that fails every time is set aside: the others of the batch are written, and a restart finds it again', async () => {
    const ch = await fresh();
    const rates = new RatesService(ch, 'XRP');
    const failing = new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      ammPools: { rates },
      // the real recompute, except for one pool, as a pool the database cannot rebuild would be
      ammPoolsFunctions: {
        recompute: async (db, r, accounts, options) => {
          if (accounts.includes(RLUSD_POOL)) throw new Error('DB::Exception: Memory limit exceeded');
          return recomputeAmmPools(db, r, accounts, options);
        },
      },
      recompute: async () => 0,
    });
    aggregators.push(failing);
    await failing.tick(NOW);
    const written = await pools(ch);
    expect([...written.keys()].sort()).toEqual(POOLS.filter((p) => p !== RLUSD_POOL));

    // the process starts again (the set of pools to retry was in memory): the pool is stale in the tables, so it is found
    await aggregator(ch).tick(NOW);
    const all = await pools(ch);
    expect([...all.keys()].sort()).toEqual(POOLS);
    expect(all.get(RLUSD_POOL)).toMatchObject({ last_ledger: NEWEST_LEDGER, reserve_base: '2417282.053464318' });
  });

  it('a state row that arrives rebuilds its pool only, under a newer version', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    const before = await pools(ch);

    await insertStates(ch, [
      extraState(RLUSD_POOL, NEWEST_LEDGER, {
        ledger_index: NEWEST_LEDGER + 1,
        tx_type: 'Payment',
        reserve_base: '2500000',
        reserve_counter: '1800000',
      }),
    ]);
    await svc.tick(NOW);
    const after = await pools(ch);
    expect(after.get(RLUSD_POOL)).toMatchObject({
      last_ledger: NEWEST_LEDGER + 1,
      reserve_base: '2500000',
      value_native: 3_600_000,
      trading_fee: 205, // from the rows before
    });
    expect(after.get(RLUSD_POOL)?.version).toBeGreaterThan(before.get(RLUSD_POOL)?.version as number);
    for (const [account, pool] of before) if (account !== RLUSD_POOL) expect(after.get(account)).toEqual(pool);
    expect(await rowCount(ch)).toBe(POOLS.length + 1);
  });

  it('a restarted aggregator picks up the rows that arrived while it was down', async () => {
    const ch = await fresh();
    await aggregator(ch).tick(NOW);
    const before = await pools(ch);

    await insertStates(ch, [
      extraState(RLUSD_POOL, NEWEST_LEDGER, { ledger_index: NEWEST_LEDGER + 5, tx_type: 'AMMVote', trading_fee: 333 }),
    ]);
    await aggregator(ch).tick(NOW);
    const after = await pools(ch);
    expect(after.get(RLUSD_POOL)).toMatchObject({ last_ledger: NEWEST_LEDGER + 5, trading_fee: 333 });
    expect(await rowCount(ch)).toBe(POOLS.length + 1);
    for (const [account, pool] of before) if (account !== RLUSD_POOL) expect(after.get(account)).toEqual(pool);
  });

  it('the pools of an agg_dirty range are rebuilt although the cursor is past them, and only then', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);

    // a pool that never had a fee, and a row of it that a re-ingest of its ledger added behind the cursor
    const noFee = POOLS.find((p) =>
      STATES.filter((s) => s.amm_account === p).every((s) => s.trading_fee === null),
    ) as string;
    const old = STATES.find((s) => s.amm_account === noFee) as AmmPoolStatesRow;
    await insertStates(ch, [extraState(noFee, old.ledger_index, { trading_fee: 777 })]);
    const before = await pools(ch);
    await svc.tick(NOW);
    // the job looks forward from its cursor: the row is behind it
    expect((await pools(ch)).get(noFee)).toEqual(before.get(noFee));
    expect(before.get(noFee)?.trading_fee).toBeNull();

    // the ingest marks the hour of the ledger it rewrote
    const hour = Math.floor(old.close_time / 3600) * 3600;
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: hour, to: hour + 3600, created: Date.now() - 5000 },
    );
    await svc.tick(NOW);
    const after = await pools(ch);
    expect(after.get(noFee)).toMatchObject({ trading_fee: 777 });
    expect(after.get(noFee)?.version).toBeGreaterThan(before.get(noFee)?.version as number);
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);
    // the pools of the hour are rebuilt, the others of the database are not
    const inHour = new Set(
      STATES.filter((s) => Math.floor(s.close_time / 3600) * 3600 === hour).map((s) => s.amm_account),
    );
    expect(inHour.has(noFee)).toBe(true);
    for (const [account, pool] of before) {
      if (inHour.has(account)) expect(after.get(account)?.version).toBeGreaterThan(pool.version);
      else expect(after.get(account)).toEqual(pool);
    }
  });
});

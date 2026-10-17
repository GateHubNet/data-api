import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import {
  AMM_POOLS_CHUNK,
  AmmPoolsRecomputeAborted,
  ammPoolsWatermark,
  POOLS_CHANGED_SINCE_SQL,
  poolsChangedSince,
  poolsClosedIn,
  recomputeAmmPools,
} from '../src/aggregate/amm-pools.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AmmLiquidityRow, AmmPoolsRow, AmmPoolStatesRow, ExchangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, assetKey, canonicalPair } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `amm_pools` job on a real ClickHouse.
 *
 * Part 1 rebuilds every pool of the real mainnet AMM fixtures (`fixtures/xrpl/amm`, written through the real `LedgerWriter`)
 * and compares each with an oracle that fills the state rows forward in plain JavaScript, plus the pools whose answer was
 * worked out by hand from the rows. Part 2 is the edge cases on state rows made by hand (every field from its own row, the
 * order of rows, the value of a pool, versions, real duplicates, the abort). Part 3 is `poolsChangedSince`, with the proof that
 * it reads through the `ledger_mm` skip index on a table of several parts (Ruling R-A2), `ammPoolsWatermark` and
 * `poolsClosedIn`.
 */

const SEC = 1000;
const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 10) / SEC;

const ctx = parseContextFor(getNetworkProfile('xrpl'));
const AMM_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/amm')).list();
const AMM_BUILT = AMM_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

const ISSUER_A = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ISSUER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ISSUER_C = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE';
const ISSUER_D = 'rpvRJUcmqQqyCHCmYRPW9FXFAGQEcibVz9';
const XRP: Asset = { currency: 'XRP' };

/** The columns of `amm_pools` that a recompute fills from the newest non-null state, in the order of the row. */
const FILLED = [
  'lp_currency',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
] as const satisfies ReadonlyArray<keyof AmmPoolStatesRow & keyof AmmPoolsRow>;

/** The key order of a stored row, pinned. */
const POOL_KEYS = [
  'amm_account',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'lp_currency',
  'created_ledger',
  'created_by',
  'last_ledger',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
  'deleted',
  'value_native',
  'version',
];

/** A rate service that has no rate for anything (`dailyNativeRates` answers 0), over the real native currency. */
function noRates(): RatesService {
  return {
    nativeCurrency: 'XRP',
    dailyNativeRates: jest.fn(async (assets: Asset[], from: Date, to: Date) => {
      const days: string[] = [];
      for (let t = from.getTime(); t < to.getTime(); t += DAY * SEC) days.push(new Date(t).toISOString().slice(0, 10));
      return new Map(
        assets.map((a) => [
          assetKey(a),
          new Map(days.map((d) => [d, new BigNumber(a.currency === 'XRP' && !a.issuer ? 1 : 0)])),
        ]),
      );
    }),
  } as unknown as RatesService;
}

interface StoredPool extends Omit<AmmPoolsRow, 'version'> {
  version: number;
}

/** What a reader sees: the newest version of each pool, without FINAL. */
async function latest(ch: ClickHouseService): Promise<StoredPool[]> {
  const rows = await ch.query<AmmPoolsRow>(
    `SELECT * FROM ${Table.AmmPools} ORDER BY amm_account ASC, version DESC LIMIT 1 BY amm_account`,
  );
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

const byAccount = (rows: StoredPool[]): Map<string, StoredPool> => new Map(rows.map((r) => [r.amm_account, r]));

/** A state row made by hand: only what is given is set, the rest is null (not in the metadata of the transaction). */
function state(
  over: Partial<AmmPoolStatesRow> & Pick<AmmPoolStatesRow, 'amm_account' | 'ledger_index'>,
): AmmPoolStatesRow {
  return {
    tx_index: 0,
    tx_hash: `${over.ledger_index}-${over.tx_index ?? 0}`.padStart(64, 'A'),
    close_time: T0 + over.ledger_index,
    tx_type: 'Payment',
    base_currency: 'USD',
    base_issuer: ISSUER_A,
    counter_currency: 'XRP',
    counter_issuer: '',
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

/** A `ledgers` row: just enough for `ledgersClosedIn`. */
const ledgerRow = (ledger_index: number, close_time: number) => ({
  ledger_index,
  ledger_hash: `${ledger_index}`.padStart(64, 'C'),
  close_time,
});

describe('the amm_pools job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `amm_pools_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const accountsOf = (rows: AmmPoolStatesRow[]): string[] => [...new Set(rows.map((r) => r.amm_account))];

  // -------------------------------------------------------------------------------------------------------------------
  describe('the pools of the real AMM fixtures', () => {
    let ch: ClickHouseService;
    let rates: RatesService;
    let pools: Map<string, StoredPool>;
    const allStates: AmmPoolStatesRow[] = AMM_BUILT.flatMap((b) => b.ammPoolStates);
    const allLiquidity: AmmLiquidityRow[] = AMM_BUILT.flatMap((b) => b.ammLiquidity);

    beforeAll(async () => {
      ch = await fresh();
      await new LedgerWriter(ch, ctx).write(AMM_LEDGERS);
      rates = noRates();
      await recomputeAmmPools(ch, rates, accountsOf(allStates));
      pools = byAccount(await latest(ch));
    });

    const double = (reserve: unknown): number | null => (reserve === null ? null : 2 * Number(reserve));

    /** The oracle: the state rows of a pool in ledger order, each field the newest non-null value, written the plain way. */
    function expected(account: string): Record<string, unknown> {
      const rows = allStates
        .filter((r) => r.amm_account === account)
        .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index);
      const out: Record<string, unknown> = Object.fromEntries(FILLED.map((f) => [f, null]));
      for (const row of rows) for (const f of FILLED) if (row[f] !== null) out[f] = row[f];
      const last = rows[rows.length - 1];
      const create = allLiquidity.find((l) => l.amm_account === account && l.event === 'create');
      const nativeBase = last.base_currency === 'XRP' && last.base_issuer === '';
      const nativeCounter = last.counter_currency === 'XRP' && last.counter_issuer === '';
      return {
        ...out,
        amm_account: account,
        base_currency: last.base_currency,
        base_issuer: last.base_issuer,
        counter_currency: last.counter_currency,
        counter_issuer: last.counter_issuer,
        created_ledger: create ? create.ledger_index : null,
        created_by: create ? create.account : null,
        last_ledger: last.ledger_index,
        deleted: last.deleted,
        // no rates here: only the pools with the native currency have a value
        value_native: nativeBase ? double(out.reserve_base) : nativeCounter ? double(out.reserve_counter) : null,
      };
    }

    it('writes one row per pool the fixtures touch, and none for anything else', async () => {
      const accounts = accountsOf(allStates);
      expect(accounts.length).toBeGreaterThan(50);
      expect([...pools.keys()].sort()).toEqual([...accounts].sort());
      expect(await ch.query(`SELECT count() AS n FROM ${Table.AmmPools}`)).toEqual([{ n: accounts.length }]);
    });

    it('every pool equals the oracle that fills the state rows forward (all fields but the version)', () => {
      for (const account of pools.keys()) {
        const { version, ...row } = pools.get(account) as StoredPool;
        expect(version).toBeGreaterThan(0);
        expect([account, row]).toEqual([account, expected(account)]);
      }
    });

    it('the XRP/RLUSD pool: reserves and fee, auction slot and LP supply from the rows that carry them', () => {
      // seven rows; the AMMDeposit and the AMMWithdraw left the RLUSD line out, only the withdraw has the newest LP supply
      const pool = pools.get('rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3') as StoredPool;
      expect(pool).toMatchObject({
        base_currency: '524C555344000000000000000000000000000000',
        base_issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
        counter_currency: 'XRP',
        counter_issuer: '',
        lp_currency: '03B245BE580EC4F4386A751C084489EC4B514A2F',
        created_ledger: null,
        created_by: null,
        last_ledger: 107713744,
        reserve_base: '2417282.053464318', // the newest row, a payment
        reserve_counter: '1847691.034536',
        lp_supply: '1791055986.845366', // the AMMWithdraw four rows back
        trading_fee: 205,
        auction_holder: 'r4uKh2rHuarMZdAgSBYqqicX7MxPBegttw',
        auction_price: '131482.3939333034',
        auction_discounted_fee: 20,
        auction_expiration: 825786300,
        deleted: 0,
        value_native: 3695382.069072, // 2 x the XRP reserve
      });
    });

    it('a field absent from the newest rows keeps the value of the last row that had it (a bid, then swaps)', () => {
      const pool = pools.get('rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am') as StoredPool;
      expect(pool).toMatchObject({
        last_ledger: 107506489,
        reserve_base: '4794.265265945032', // the swaps after the bid
        reserve_counter: '3316.368141',
        lp_supply: '3340651.434735374', // the AMMBid, whose metadata has no reserves
        trading_fee: 220,
        auction_holder: 'r4S6hRiKREKkmMeqs8dpgyYAotGyck9g3h',
        auction_price: '294.354152174',
        value_native: 6632.736282,
      });
    });

    it('a pool whose AMMCreate was ingested has its ledger and creator; a pool first seen later has neither', () => {
      expect(pools.get('rUAEvY1XNvnkurE9RunV7u3yjh3jQsQPsG')).toMatchObject({
        created_ledger: 107612573,
        created_by: 'rEh4WnsrdmE7V1XeTsWi5dM7FHH8hYuea3',
        last_ledger: 107612573,
        reserve_base: '1000000',
        reserve_counter: '500',
        value_native: 1000,
      });
      const withoutCreate = [...pools.values()].filter((p) => p.created_ledger === null);
      expect(withoutCreate.length).toBe(pools.size - 1);
      for (const p of withoutCreate) expect(p.created_by).toBeNull();
    });

    it('a deleted pool is flagged, with the empty reserves of its last row', () => {
      expect(pools.get('rGLnUKdptCVobJKEkrwxtdyGZ98Evdmqdz')).toMatchObject({
        deleted: 1,
        last_ledger: 100132150,
        reserve_base: '0',
        reserve_counter: '0',
        lp_supply: '0',
        value_native: 0,
      });
      expect([...pools.values()].filter((p) => p.deleted === 1)).toHaveLength(1);
    });

    it('an IOU/IOU pool has no value without a rate, and the native pools have theirs', () => {
      const rlusdUsdc = pools.get('rfWfhoLj3LiaBpoxus3h7pEF8jXDMtyGqb') as StoredPool;
      expect(rlusdUsdc).toMatchObject({ reserve_base: '26112.53828344373', reserve_counter: '26108.29939269826' });
      expect(rlusdUsdc.value_native).toBeNull();
      const valued = [...pools.values()].filter((p) => p.value_native !== null);
      expect(valued.length).toBeGreaterThan(20);
      for (const p of valued) expect(p.base_currency === 'XRP' || p.counter_currency === 'XRP').toBe(true);
    });

    it('asked for the rate of the base first, on the day of the last state, and only for the pools without a native side', () => {
      const calls = (rates.dailyNativeRates as jest.Mock).mock.calls as Array<[Asset[], Date, Date]>;
      expect(calls.length).toBeGreaterThan(0);
      for (const [assets, from, to] of calls) {
        expect(to.getTime() - from.getTime()).toBe(DAY * SEC); // one day at a time
        expect(from.getTime() % (DAY * SEC)).toBe(0);
        expect(assets.every((a) => !(a.currency === 'XRP' && !a.issuer))).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('state rows made by hand', () => {
    const POOL = 'rPool000000000000000000000000000A';
    const OTHER = 'rPool000000000000000000000000000B';

    it('fills every field forward from the newest row that has it, whatever the order the rows were written in', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        // written newest first, to show that the order of the rows in the table is nothing
        state({ amm_account: POOL, ledger_index: 500, tx_index: 2, reserve_counter: '90.5', tx_type: 'AMMWithdraw' }),
        state({
          amm_account: POOL,
          ledger_index: 100,
          tx_index: 0,
          reserve_base: '10',
          reserve_counter: '20',
          lp_supply: '14.14',
          lp_currency: '03AA',
          trading_fee: 500,
          auction_holder: 'rA',
          auction_price: '1.5',
          auction_discounted_fee: 50,
          auction_expiration: 1000,
        }),
        state({ amm_account: POOL, ledger_index: 300, tx_index: 7, reserve_base: '12', trading_fee: 300 }),
        state({
          amm_account: POOL,
          ledger_index: 300,
          tx_index: 9,
          lp_supply: '15',
          auction_holder: 'rB',
          auction_price: '2.5',
          auction_expiration: 2000,
        }),
        state({ amm_account: POOL, ledger_index: 200, tx_index: 4, reserve_base: '11', auction_discounted_fee: 40 }),
        state({ amm_account: OTHER, ledger_index: 50, tx_index: 0, reserve_base: '1', reserve_counter: '2' }),
      ]);
      expect(await recomputeAmmPools(ch, noRates(), [POOL, OTHER])).toBe(2);
      const { version, ...pool } = byAccount(await latest(ch)).get(POOL) as StoredPool;
      expect(version).toBeGreaterThan(0);
      expect(pool).toEqual({
        amm_account: POOL,
        base_currency: 'USD',
        base_issuer: ISSUER_A,
        counter_currency: 'XRP',
        counter_issuer: '',
        lp_currency: '03AA', // only the first row
        created_ledger: null,
        created_by: null,
        last_ledger: 500,
        reserve_base: '12', // ledger 300 tx 7: the newest row with it
        reserve_counter: '90.5', // the newest row of all
        lp_supply: '15', // ledger 300 tx 9
        trading_fee: 300, // ledger 300 tx 7
        auction_holder: 'rB',
        auction_price: '2.5',
        auction_discounted_fee: 40, // ledger 200
        auction_expiration: 2000,
        deleted: 0,
        value_native: 181, // 2 x the XRP reserve, the counter, of the newest row
      });
      expect(byAccount(await latest(ch)).get(OTHER)).toMatchObject({
        last_ledger: 50,
        reserve_base: '1',
        reserve_counter: '2',
        lp_supply: null,
        lp_currency: null,
        trading_fee: null,
        auction_holder: null,
        auction_price: null,
        auction_discounted_fee: null,
        auction_expiration: null,
        value_native: 4,
      });
    });

    it('takes deleted from the newest row, and keeps the amounts of the rows before it when the newest has none', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: POOL, ledger_index: 10, reserve_base: '5', reserve_counter: '6', lp_supply: '5.4' }),
        state({ amm_account: POOL, ledger_index: 20, tx_type: 'AMMDelete', deleted: 1 }),
        // a pool that was flagged and then, for a reason of the data, has a newer row that is not
        state({ amm_account: OTHER, ledger_index: 10, deleted: 1, reserve_counter: '3' }),
        state({ amm_account: OTHER, ledger_index: 11, reserve_counter: '4' }),
      ]);
      await recomputeAmmPools(ch, noRates(), [POOL, OTHER]);
      const pools = byAccount(await latest(ch));
      expect(pools.get(POOL)).toMatchObject({
        deleted: 1,
        last_ledger: 20,
        reserve_base: '5',
        lp_supply: '5.4',
        value_native: 12,
      });
      expect(pools.get(OTHER)).toMatchObject({ deleted: 0, last_ledger: 11, reserve_counter: '4', value_native: 8 });
    });

    it('value_native is 2 x the native reserve whichever side the native currency is on, and null when it was never seen', async () => {
      const ch = await fresh();
      const nativeBase = 'rNativeBase0000000000000000000000';
      const neverSeen = 'rNeverSeen00000000000000000000000';
      await ch.insert(Table.AmmPoolStates, [
        state({
          amm_account: nativeBase,
          ledger_index: 10,
          base_currency: 'XRP',
          base_issuer: '',
          counter_currency: 'ZZZ',
          counter_issuer: ISSUER_B,
          reserve_base: '1234.567891',
          reserve_counter: '99',
        }),
        state({ amm_account: neverSeen, ledger_index: 10, reserve_base: '77', lp_supply: '3' }),
      ]);
      const rates = noRates();
      await recomputeAmmPools(ch, rates, [nativeBase, neverSeen]);
      const pools = byAccount(await latest(ch));
      expect(pools.get(nativeBase)?.value_native).toBe(2469.135782);
      expect(pools.get(neverSeen)?.value_native).toBeNull();
      // a native pool needs no rate, whatever the rates service can say
      expect(rates.dailyNativeRates).not.toHaveBeenCalled();
    });

    it('keeps the exact strings of the amounts: only value_native is a float', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({
          amm_account: POOL,
          ledger_index: 10,
          reserve_base: '0.1234567890123456',
          reserve_counter: '3333333.333333',
          lp_supply: '1e-7',
          auction_price: '9007199254740993.5',
        }),
      ]);
      await recomputeAmmPools(ch, noRates(), [POOL]);
      expect(byAccount(await latest(ch)).get(POOL)).toMatchObject({
        reserve_base: '0.1234567890123456',
        reserve_counter: '3333333.333333',
        lp_supply: '1e-7',
        auction_price: '9007199254740993.5',
        value_native: 6666666.666666,
      });
    });

    it('stores the row with its keys in the pinned order', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: POOL, ledger_index: 10, reserve_base: '1', reserve_counter: '2' }),
      ]);
      await recomputeAmmPools(ch, noRates(), [POOL]);
      const [row] = await ch.query(`SELECT * FROM ${Table.AmmPools}`);
      expect(Object.keys(row as object)).toEqual(POOL_KEYS);
    });

    it('rebuilds the pools of any number of accounts, a chunk at a time, once each', async () => {
      const ch = await fresh();
      const n = AMM_POOLS_CHUNK * 2 + 37;
      const accounts = Array.from({ length: n }, (_, i) => `rBulk${String(i).padStart(5, '0')}`);
      await ch.insert(
        Table.AmmPoolStates,
        accounts.map((a, i) =>
          state({ amm_account: a, ledger_index: 10 + i, reserve_base: '1', reserve_counter: String(i) }),
        ),
      );
      // a repeated account and one without rows count once or not at all
      expect(
        await recomputeAmmPools(ch, noRates(), [...accounts, accounts[3], 'rNoRows0000000000000000000000000']),
      ).toBe(n);
      const pools = await latest(ch);
      expect(pools).toHaveLength(n);
      expect(pools.map((p) => p.reserve_counter)).toEqual(accounts.map((_, i) => String(i)));
    });

    it('writes nothing for no accounts, and for accounts without state rows', async () => {
      const ch = await fresh();
      expect(await recomputeAmmPools(ch, noRates(), [])).toBe(0);
      expect(await recomputeAmmPools(ch, noRates(), [POOL])).toBe(0);
      expect(await latest(ch)).toEqual([]);
    });

    it('writes nothing once the signal is aborted: before the read, and just before the write', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: POOL, ledger_index: 10, reserve_base: '1', reserve_counter: '2' }),
      ]);
      const early = new AbortController();
      early.abort();
      await expect(recomputeAmmPools(ch, noRates(), [POOL], { signal: early.signal })).rejects.toBeInstanceOf(
        AmmPoolsRecomputeAborted,
      );

      // aborted while the rates are being looked up (an IOU/IOU pool): the write is dropped
      await ch.insert(Table.AmmPoolStates, [
        state({
          amm_account: OTHER,
          ledger_index: 11,
          base_issuer: ISSUER_A,
          counter_currency: 'EUR',
          counter_issuer: ISSUER_B,
          reserve_base: '1',
          reserve_counter: '2',
        }),
      ]);
      const late = new AbortController();
      const rates = noRates();
      (rates.dailyNativeRates as jest.Mock).mockImplementation(async () => {
        late.abort();
        return new Map();
      });
      await expect(recomputeAmmPools(ch, rates, [OTHER], { signal: late.signal })).rejects.toBeInstanceOf(
        AmmPoolsRecomputeAborted,
      );
      expect(await latest(ch)).toEqual([]);
    });

    it('writes nothing when the signal is aborted between the read and the write of a native pool, which needs no rates', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: POOL, ledger_index: 10, reserve_base: '1', reserve_counter: '2' }),
      ]);
      const controller = new AbortController();
      const query = ch.query.bind(ch) as (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>;
      jest.spyOn(ch, 'query').mockImplementation((async (sql: string, params?: Record<string, unknown>) => {
        const rows = await query(sql, params);
        if (sql.includes(`FROM ${Table.AmmPoolStates}`)) controller.abort(); // the shutdown begins as the read returns
        return rows;
      }) as typeof ch.query);
      await expect(recomputeAmmPools(ch, noRates(), [POOL], { signal: controller.signal })).rejects.toBeInstanceOf(
        AmmPoolsRecomputeAborted,
      );
      jest.restoreAllMocks();
      expect(await latest(ch)).toEqual([]);
    });

    describe('the creation of a pool', () => {
      const liquidity = (over: Partial<AmmLiquidityRow>): AmmLiquidityRow => ({
        amm_account: POOL,
        ledger_index: 10,
        tx_index: 1,
        tx_hash: 'C'.repeat(64),
        close_time: T0,
        account: 'rCreator',
        initiator: 'rCreator',
        event: 'create',
        mode: '',
        base_amount: '10',
        counter_amount: '20',
        lp_tokens: '14',
        base_amount_f: 10,
        counter_amount_f: 20,
        lp_tokens_f: 14,
        ...over,
      });

      it('is the ledger and the sender of the AMMCreate, not of a deposit, and the first should there be two', async () => {
        const ch = await fresh();
        await ch.insert(Table.AmmPoolStates, [
          state({ amm_account: POOL, ledger_index: 10, reserve_base: '10', reserve_counter: '20' }),
          state({ amm_account: POOL, ledger_index: 30, reserve_base: '12', reserve_counter: '22' }),
          state({ amm_account: OTHER, ledger_index: 40, reserve_base: '1', reserve_counter: '2' }),
        ]);
        await ch.insert(Table.AmmLiquidity, [
          liquidity({ ledger_index: 30, account: 'rLater', initiator: 'rLater', tx_hash: 'D'.repeat(64) }),
          liquidity({
            ledger_index: 20,
            event: 'deposit',
            mode: 'single_asset',
            account: 'rDepositor',
            initiator: 'rDepositor',
          }),
          liquidity({ ledger_index: 10 }),
          // a pool the create of which was not ingested has deposits only
          liquidity({
            amm_account: OTHER,
            ledger_index: 40,
            event: 'deposit',
            account: 'rDepositor',
            initiator: 'rDepositor',
          }),
        ]);
        await recomputeAmmPools(ch, noRates(), [POOL, OTHER]);
        const pools = byAccount(await latest(ch));
        expect(pools.get(POOL)).toMatchObject({ created_ledger: 10, created_by: 'rCreator', last_ledger: 30 });
        expect(pools.get(OTHER)).toMatchObject({ created_ledger: null, created_by: null, last_ledger: 40 });
      });
    });

    describe('versions', () => {
      it('a second recompute is idempotent: the same latest values under a newer version, both rows there until a merge', async () => {
        const ch = await fresh();
        await new LedgerWriter(ch, ctx).write(AMM_LEDGERS);
        const accounts = [...new Set(AMM_BUILT.flatMap((b) => b.ammPoolStates.map((s) => s.amm_account)))];
        await ch.command(`SYSTEM STOP MERGES ${Table.AmmPools}`);
        try {
          const rates = noRates();
          await recomputeAmmPools(ch, rates, accounts);
          const first = await latest(ch);
          await recomputeAmmPools(ch, rates, accounts);
          const second = await latest(ch);
          expect(second).toHaveLength(accounts.length);
          expect(await ch.query(`SELECT count() AS n FROM ${Table.AmmPools}`)).toEqual([{ n: 2 * accounts.length }]);
          const strip = (rows: StoredPool[]) => rows.map(({ version: _version, ...row }) => row);
          expect(strip(second)).toEqual(strip(first));
          second.forEach((row, i) => expect(row.version).toBeGreaterThan(first[i].version));
        } finally {
          await ch.command(`SYSTEM START MERGES ${Table.AmmPools}`);
        }
      });

      it('is never below one more than the newest version the pool has, even when the clock is behind it', async () => {
        const ch = await fresh();
        await ch.insert(Table.AmmPoolStates, [
          state({ amm_account: POOL, ledger_index: 10, reserve_base: '1', reserve_counter: '2' }),
        ]);
        await recomputeAmmPools(ch, noRates(), [POOL]);
        const [{ version: now }] = await latest(ch);
        // a version from the future (a clock that stepped back since): the next one still wins
        const future = now + 3 * DAY * SEC;
        await ch.insert(Table.AmmPools, [{ ...(await latest(ch))[0], version: future }]);
        await recomputeAmmPools(ch, noRates(), [POOL]);
        expect((await latest(ch))[0].version).toBe(future + 1);
        await recomputeAmmPools(ch, noRates(), [POOL]);
        expect((await latest(ch))[0].version).toBe(future + 2);
      });

      it('the pools of one call get their own versions: a pool with a high one does not hold the others up', async () => {
        const ch = await fresh();
        await ch.insert(Table.AmmPoolStates, [
          state({ amm_account: POOL, ledger_index: 10, reserve_base: '1', reserve_counter: '2' }),
          state({ amm_account: OTHER, ledger_index: 11, reserve_base: '1', reserve_counter: '2' }),
        ]);
        await recomputeAmmPools(ch, noRates(), [OTHER]);
        const [seen] = await latest(ch);
        await ch.insert(Table.AmmPools, [{ ...seen, version: seen.version + 10 * DAY * SEC }]);
        await recomputeAmmPools(ch, noRates(), [POOL, OTHER]);
        const pools = byAccount(await latest(ch));
        expect((pools.get(OTHER) as StoredPool).version).toBe(seen.version + 10 * DAY * SEC + 1);
        expect((pools.get(POOL) as StoredPool).version).toBeLessThan(seen.version + 10 * DAY * SEC);
      });
    });

    it('a real duplicate of a state row changes nothing', async () => {
      const ch = await fresh();
      const rows = [
        state({
          amm_account: POOL,
          ledger_index: 100,
          tx_index: 1,
          reserve_base: '10',
          reserve_counter: '20',
          lp_supply: '14',
          trading_fee: 500,
        }),
        state({
          amm_account: POOL,
          ledger_index: 200,
          tx_index: 3,
          reserve_counter: '25',
          auction_holder: 'rA',
          auction_price: '3',
        }),
      ];
      await ch.command(`SYSTEM STOP MERGES ${Table.AmmPoolStates}`);
      try {
        await ch.insert(Table.AmmPoolStates, rows);
        await recomputeAmmPools(ch, noRates(), [POOL]);
        const before = await latest(ch);
        // a SEPARATE insert of the same rows, not collapsed: the table holds every row twice
        await ch.command(
          `INSERT INTO ${Table.AmmPoolStates} SELECT * FROM ${Table.AmmPoolStates}`,
          {},
          { settings: { insert_deduplicate: 0 } },
        );
        expect(await ch.query(`SELECT count() AS n FROM ${Table.AmmPoolStates}`)).toEqual([{ n: 4 }]);

        await recomputeAmmPools(ch, noRates(), [POOL]);
        const after = await latest(ch);
        expect(after).toHaveLength(1);
        expect(after[0].version).toBeGreaterThan(before[0].version);
        const strip = ({ version: _version, ...row }: StoredPool) => row;
        expect(strip(after[0])).toEqual(strip(before[0]));
        expect(after[0]).toMatchObject({
          reserve_base: '10',
          reserve_counter: '25',
          lp_supply: '14',
          last_ledger: 200,
          value_native: 50,
        });
        // and the pools that changed: the duplicate rows name the pool once
        expect((await poolsChangedSince(ch, 0, 10)).accounts).toEqual([POOL]);
      } finally {
        await ch.command(`SYSTEM START MERGES ${Table.AmmPoolStates}`);
      }
    });

    describe('the value of an IOU/IOU pool, from the rates of the trades in exchanges', () => {
      const AAA: Asset = { currency: 'AAA', issuer: ISSUER_A };
      const BBB: Asset = { currency: 'BBB', issuer: ISSUER_B };
      const CCC: Asset = { currency: 'CCC', issuer: ISSUER_C };
      const DDD: Asset = { currency: 'DDD', issuer: ISSUER_D };
      const TRADE_DAY = T0 - (T0 % DAY) + 30 * DAY;
      let ch: ClickHouseService;
      let rates: RatesService;
      const P1 = 'rIouIou1000000000000000000000000'; // AAA/BBB on the day of the trades
      const P2 = 'rIouIou2000000000000000000000000'; // CCC/BBB: only the counter has a rate
      const P3 = 'rIouIou3000000000000000000000000'; // CCC/DDD: no rate at all
      const P4 = 'rIouIou4000000000000000000000000'; // AAA/BBB, last state three weeks after the trades: no rate any more
      const P5 = 'rIouIou5000000000000000000000000'; // AAA/BBB with both reserves unknown
      const P6 = 'rIouIou6000000000000000000000000'; // AAA/CCC: the base has a rate, the counter is unrated
      const P7 = 'rIouIou7000000000000000000000000'; // CCC/AAA: the counter has the rate, base reserve unknown

      beforeAll(async () => {
        ch = await fresh();
        // 12 trades each of AAA at 2 XRP and of BBB at 4 XRP on TRADE_DAY, so that the daily and the latest rate agree:
        // one native coin buys 0.5 AAA and 0.25 BBB
        const rows: ExchangesRow[] = [];
        const ledgerRows: Array<ReturnType<typeof ledgerRow>> = [];
        let k = 0;
        for (const [asset, price] of [
          [AAA, 2],
          [BBB, 4],
        ] as Array<[Asset, number]>) {
          const stored = canonicalPair(asset, XRP);
          for (let i = 0; i < 12; i++) {
            const close = TRADE_DAY + 3600 + k * 7;
            const ledger = 9000 + k;
            const [baseAmount, counterAmount] = stored.base.issuer
              ? ['10', String(10 * price)]
              : [String(10 * price), '10'];
            ledgerRows.push(ledgerRow(ledger, close));
            rows.push({
              base_currency: stored.base.currency,
              base_issuer: stored.base.issuer ?? '',
              counter_currency: stored.counter.currency,
              counter_issuer: stored.counter.issuer ?? '',
              ledger_index: ledger,
              tx_index: 1,
              node_index: 1,
              tx_hash: `${k++}`.padStart(64, 'F'),
              close_time: close,
              base_amount: baseAmount,
              counter_amount: counterAmount,
              base_amount_f: Number(baseAmount),
              counter_amount_f: Number(counterAmount),
              rate: String(Number(counterAmount) / Number(baseAmount)),
              rate_f: Number(counterAmount) / Number(baseAmount),
              buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
              seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
              taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
              provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
              offer_sequence: 1,
              amm_account: '',
              autobridged_currency: null,
              autobridged_issuer: null,
              tx_type: 'OfferCreate',
              client: null,
            });
          }
        }
        await ch.insert(Table.Ledgers, ledgerRows);
        await ch.insert(Table.Exchanges, rows);
        rates = new RatesService(ch, 'XRP');

        const iou = (
          account: string,
          base: Asset,
          counter: Asset,
          ledger: number,
          day: number,
          rb: string | null,
          rc: string | null,
        ) =>
          state({
            amm_account: account,
            ledger_index: ledger,
            close_time: day + 7200,
            base_currency: base.currency,
            base_issuer: base.issuer ?? '',
            counter_currency: counter.currency,
            counter_issuer: counter.issuer ?? '',
            reserve_base: rb,
            reserve_counter: rc,
          });
        await ch.insert(Table.AmmPoolStates, [
          iou(P1, AAA, BBB, 100, TRADE_DAY, '100', '40'),
          iou(P2, CCC, BBB, 100, TRADE_DAY, '500', '40'),
          iou(P3, CCC, DDD, 100, TRADE_DAY, '500', '40'),
          iou(P4, AAA, BBB, 90, TRADE_DAY, '100', '40'),
          iou(P4, AAA, BBB, 200, TRADE_DAY + 21 * DAY, '100', '40'),
          iou(P5, AAA, BBB, 100, TRADE_DAY, null, null),
          iou(P6, AAA, CCC, 100, TRADE_DAY, '30', '9000'),
          iou(P7, CCC, AAA, 100, TRADE_DAY, null, '30'),
        ]);
        await recomputeAmmPools(ch, rates, [P1, P2, P3, P4, P5, P6, P7]);
      });

      it('knows the rates it will be compared with', async () => {
        const found = await rates.dailyNativeRates(
          [AAA, BBB, CCC],
          new Date(TRADE_DAY * SEC),
          new Date((TRADE_DAY + DAY) * SEC),
        );
        const day = new Date(TRADE_DAY * SEC).toISOString().slice(0, 10);
        expect([AAA, BBB, CCC].map((a) => found.get(assetKey(a))?.get(day)?.toFixed())).toEqual(['0.5', '0.25', '0']);
      });

      const valueOf = async (account: string): Promise<number | null | undefined> =>
        byAccount(await latest(ch)).get(account)?.value_native;

      it('is 2 x the reserve of the base, divided by its rate (units of the asset per native coin)', async () => {
        expect(await valueOf(P1)).toBe(400); // 2 x 100 / 0.5
      });

      it('takes the rate of the counter when the base has none', async () => {
        expect(await valueOf(P2)).toBe(320); // 2 x 40 / 0.25
        expect(await valueOf(P7)).toBe(120); // 2 x 30 / 0.5 (the base reserve is not known, the counter has the rate)
      });

      it('takes the base even when the counter has a rate too', async () => {
        expect(await valueOf(P1)).not.toBe((2 * 40) / 0.25);
        expect(await valueOf(P6)).toBe(120); // 2 x 30 / 0.5; the counter's reserve (9000) is ignored
      });

      it('is missing when neither asset has a rate, or the reserve of the rated side is not known', async () => {
        expect(await valueOf(P3)).toBeNull();
        expect(await valueOf(P5)).toBeNull();
      });

      it('uses the rate of the day of the last state: three weeks after the trades the pool has no rate any more', async () => {
        const p4 = byAccount(await latest(ch)).get(P4) as StoredPool;
        expect(p4.last_ledger).toBe(200);
        expect(p4.value_native).toBeNull();
      });

      it('asks for the counter only of the pools whose base had no value', async () => {
        const spy = jest.spyOn(rates, 'dailyNativeRates');
        await recomputeAmmPools(ch, rates, [P1, P6]);
        // both pools are valued by their base: no second round for the counters
        expect(spy.mock.calls.map(([assets]) => assets.map(assetKey))).toEqual([[assetKey(AAA)]]);
        spy.mockClear();
        await recomputeAmmPools(ch, rates, [P2]);
        expect(spy.mock.calls.map(([assets]) => assets.map(assetKey))).toEqual([[assetKey(CCC)], [assetKey(BBB)]]);
        spy.mockRestore();
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('poolsChangedSince', () => {
    const acct = (n: number): string => `rWatch${String(n).padStart(3, '0')}00000000000000000000000`;

    it('lists the pools with a state row after the ledger, with the newest ledger of those rows', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: acct(1), ledger_index: 10 }),
        state({ amm_account: acct(1), ledger_index: 30 }),
        state({ amm_account: acct(2), ledger_index: 20 }),
        state({ amm_account: acct(3), ledger_index: 5 }),
      ]);
      expect(await poolsChangedSince(ch, 9, 100)).toEqual({ accounts: [acct(1), acct(2)], upTo: 30 });
      // strictly after: the row at the ledger is not a change since it, and the pools come in the order of their first change
      expect(await poolsChangedSince(ch, 10, 100)).toEqual({ accounts: [acct(2), acct(1)], upTo: 30 });
      expect(await poolsChangedSince(ch, 20, 100)).toEqual({ accounts: [acct(1)], upTo: 30 });
      expect(await poolsChangedSince(ch, 0, 100)).toEqual({ accounts: [acct(3), acct(1), acct(2)], upTo: 30 });
    });

    it('answers nothing, and stays where it is, when nothing changed (or there are no rows at all)', async () => {
      const ch = await fresh();
      expect(await poolsChangedSince(ch, 7, 100)).toEqual({ accounts: [], upTo: 7 });
      await ch.insert(Table.AmmPoolStates, [state({ amm_account: acct(1), ledger_index: 10 })]);
      expect(await poolsChangedSince(ch, 10, 100)).toEqual({ accounts: [], upTo: 10 });
      expect(await poolsChangedSince(ch, 4_000_000_000, 100)).toEqual({ accounts: [], upTo: 4_000_000_000 });
    });

    it('cuts at the limit on a ledger boundary: the pools before the first one left out, up to the ledger before it', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: acct(1), ledger_index: 10 }),
        state({ amm_account: acct(2), ledger_index: 20 }),
        state({ amm_account: acct(3), ledger_index: 30 }),
        state({ amm_account: acct(1), ledger_index: 40 }),
      ]);
      expect(await poolsChangedSince(ch, 0, 2)).toEqual({ accounts: [acct(1), acct(2)], upTo: 29 });
      expect(await poolsChangedSince(ch, 29, 2)).toEqual({ accounts: [acct(3), acct(1)], upTo: 40 });
      expect(await poolsChangedSince(ch, 0, 3)).toEqual({ accounts: [acct(1), acct(2), acct(3)], upTo: 40 });
    });

    it('returns every pool of a ledger that holds more of them than the limit, so that it always moves on', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        ...[1, 2, 3, 4, 5].map((n) => state({ amm_account: acct(n), ledger_index: 100 })),
        state({ amm_account: acct(6), ledger_index: 200 }),
      ]);
      const first = await poolsChangedSince(ch, 50, 2);
      expect(first).toEqual({ accounts: [1, 2, 3, 4, 5].map(acct), upTo: 100 });
      expect(await poolsChangedSince(ch, first.upTo, 2)).toEqual({ accounts: [acct(6)], upTo: 200 });
    });

    it('walked from a ledger it reaches every pool that changed, every step moves on, and it ends where the rows end', async () => {
      const ch = await fresh();
      const rows: AmmPoolStatesRow[] = [];
      // 40 pools, each with a few rows at scattered ledgers; some ledgers are shared by several pools
      for (let p = 1; p <= 40; p++) {
        for (const ledger of [1 + ((p * 7) % 13) * 10, 20 + ((p * 11) % 9) * 10, 150 + p]) {
          rows.push(state({ amm_account: acct(p), ledger_index: ledger, tx_index: p }));
        }
      }
      await ch.insert(Table.AmmPoolStates, rows);
      for (const limit of [1, 3, 7, 100]) {
        const seen = new Set<string>();
        let ledger = 0;
        for (let steps = 0; ; steps++) {
          expect(steps).toBeLessThan(200);
          const { accounts, upTo } = await poolsChangedSince(ch, ledger, limit);
          if (accounts.length === 0) {
            expect(upTo).toBe(ledger);
            break;
          }
          expect(upTo).toBeGreaterThan(ledger);
          // complete: every pool with a row in (ledger, upTo] is among the accounts
          const inRange = new Set(
            rows.filter((r) => r.ledger_index > ledger && r.ledger_index <= upTo).map((r) => r.amm_account),
          );
          for (const a of inRange) expect(accounts).toContain(a);
          accounts.forEach((a) => seen.add(a));
          ledger = upTo;
        }
        expect(ledger).toBe(190);
        expect(seen.size).toBe(40);
      }
    });

    describe('reads through the ledger index, not the table (Ruling R-A2)', () => {
      /**
       * Six parts, merges stopped, in one partition: the template row (ledger 1); four spread parts of 100,000 rows each in a
       * ledger range of its own (100 pools x 1000 ledgers: every granule of a part spans the whole range of the part); and one
       * clustered part of 100,000 rows in which the pools are in the order of their ledgers (pool k lives in the ledgers
       * `CLUSTER + 10k ...`, 1000 rows each), so that a granule holds a narrow range of ledgers.
       */
      const BASES = [1_000_000, 2_000_000, 3_000_000, 4_000_000];
      const CLUSTER = 5_000_000;
      const PER_PART = 100_000;
      const POOLS = 100;
      const GRANULE = 8192;
      /** Above the ledgers of pools 0..89 of the clustered part: pools 90..99, 10,000 rows, are left. */
      const ABOVE_CLUSTER = CLUSTER + 89 * 10 + 9;
      let ch: ClickHouseService;
      let db: string;

      beforeAll(async () => {
        ch = await fresh();
        db = ((await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db')) as { db: string }).db;
        await ch.command(`SYSTEM STOP MERGES ${Table.AmmPoolStates}`);
        await ch.insert(Table.AmmPoolStates, [
          state({ amm_account: 'rTemplate', ledger_index: 1, reserve_base: '1', reserve_counter: '2' }),
        ]);
        const copies = (replace: string, params: Record<string, unknown>) =>
          ch.command(
            `INSERT INTO ${Table.AmmPoolStates}
             SELECT tpl.* REPLACE (${replace})
               FROM (SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = 'rTemplate') AS tpl
              CROSS JOIN numbers({rows:UInt32}) AS n`,
            { rows: PER_PART, pools: POOLS, ...params },
            { settings: { insert_deduplicate: 0 } },
          );
        for (const base of BASES) {
          await copies(
            `concat('rBulk', toString(n.number % {pools:UInt32})) AS amm_account,
             toUInt32({base:UInt32} + intDiv(n.number, {pools:UInt32})) AS ledger_index`,
            { base },
          );
        }
        const per = PER_PART / POOLS;
        await copies(
          `concat('rClus', leftPad(toString(intDiv(n.number, {per:UInt32})), 3, '0')) AS amm_account,
           toUInt32({base:UInt32} + intDiv(n.number, {per:UInt32}) * 10 + n.number % 10) AS ledger_index,
           toUInt32(n.number % {per:UInt32}) AS tx_index`,
          { base: CLUSTER, per },
        );
      });

      interface Stage {
        parts: [number, number];
        granules: [number, number];
      }

      /** The `Parts: a/b` and `Granules: a/b` of a stage of an EXPLAIN indexes = 1 (`Min-Max`, or the skip index by its name). */
      async function stages(ledger: number): Promise<{ minMax: Stage; skip: Stage; names: string[] }> {
        const lines = (
          await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${POOLS_CHANGED_SINCE_SQL}`, { ledger, n: 101 })
        ).map((r) => r.explain.trim());
        const stage = (at: number): Stage => {
          const pair = (prefix: string): [number, number] => {
            const line = lines.slice(at).find((l) => l.startsWith(prefix)) as string;
            const [a, b] = line.slice(prefix.length).trim().split('/');
            return [Number(a), Number(b)];
          };
          return { parts: pair('Parts:'), granules: pair('Granules:') };
        };
        const minMax = lines.indexOf('Min-Max');
        const skip = lines.indexOf('Name: ledger_mm');
        expect([minMax, skip]).not.toContain(-1);
        return {
          minMax: stage(minMax),
          skip: stage(skip),
          names: lines.filter((l) => l.startsWith('Name: ')),
        };
      }

      /** The rows `system.query_log` says the watermark query read in one run of `run`. */
      async function rowsRead(run: () => Promise<unknown>): Promise<number> {
        const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
        await run();
        await ch.command('SYSTEM FLUSH LOGS');
        const rows = await ch.query<{ read_rows: string }>(
          `SELECT read_rows FROM system.query_log
            WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
              AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
              AND startsWith(query, 'SELECT amm_account, min(ledger_index)')
            ORDER BY query_start_time_microseconds`,
          { db, t, table: `${db}.${Table.AmmPoolStates}` },
        );
        expect(rows).toHaveLength(1);
        return Number(rows[0].read_rows);
      }
      const sinceLedger =
        (ledger: number, settings: Record<string, number> = {}) =>
        () =>
          ch.query(POOLS_CHANGED_SINCE_SQL, { ledger, n: 1001 }, settings);

      it('the table is six parts: four spread, one clustered, one row', async () => {
        const parts = await ch.query<{ rows: string }>(
          `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {t:String} AND active ORDER BY rows DESC`,
          { t: Table.AmmPoolStates },
        );
        expect(parts.map((p) => Number(p.rows))).toEqual([...Array(5).fill(PER_PART), 1]);
      });

      it('EXPLAIN: the ledger_mm skip index is there and usable; a ledger above old parts leaves one part of six', async () => {
        const all = await stages(0);
        expect(all.names).toEqual(['Name: ledger_mm']);
        expect(all.minMax.parts).toEqual([6, 6]);
        const newest = await stages(BASES[3] + PER_PART / POOLS);
        // the parts whose ledgers are all below are out before a granule is looked at: one part, 13 of the 66 granules
        expect(newest.minMax.parts).toEqual([1, 6]);
        expect(newest.minMax.granules).toEqual([Math.ceil(PER_PART / GRANULE), all.minMax.granules[1]]);
        expect(newest.skip.parts[1]).toBe(1);
      });

      it('EXPLAIN: within a part whose granules are narrow in ledgers the skip index drops the granules below the ledger', async () => {
        const stage = (await stages(ABOVE_CLUSTER)).skip;
        expect(stage.parts).toEqual([1, 1]);
        // 100,000 rows are 13 granules; pools 90..99 are the last 10,000 rows: the last three granules
        expect(stage.granules[1]).toBe(Math.ceil(PER_PART / GRANULE));
        expect(stage.granules[0]).toBeLessThanOrEqual(3);
      });

      it('read_rows: the parts and granules below the ledger are not read', async () => {
        const total = 5 * PER_PART + 1;
        expect(await rowsRead(sinceLedger(0))).toBeGreaterThanOrEqual(total);
        // two parts of the five (the newest spread one and the clustered one), and the others are not read
        const twoParts = await rowsRead(sinceLedger(BASES[3] - 1));
        expect(twoParts).toBeGreaterThanOrEqual(2 * PER_PART);
        expect(twoParts).toBeLessThanOrEqual(2 * PER_PART + 2 * GRANULE);
        // one part, whole: its granules all span the ledgers of the part
        const onePart = await rowsRead(sinceLedger(CLUSTER - 1));
        expect(onePart).toBeGreaterThanOrEqual(PER_PART);
        expect(onePart).toBeLessThanOrEqual(PER_PART + 2 * GRANULE);
        // nothing above the newest ledger
        expect(await rowsRead(sinceLedger(CLUSTER + 1000))).toBeLessThanOrEqual(GRANULE);
        // the last granules of the clustered part, where a scan of the part would read all of it
        const clustered = await rowsRead(sinceLedger(ABOVE_CLUSTER));
        expect(clustered).toBeLessThanOrEqual(3 * GRANULE);
        const noSkipIndex = await rowsRead(sinceLedger(ABOVE_CLUSTER, { use_skip_indexes: 0 }));
        expect(noSkipIndex).toBeGreaterThanOrEqual(PER_PART);
      });

      it('and finds the pools that changed, all of them, with the ledger it is complete up to', async () => {
        const { accounts, upTo } = await poolsChangedSince(ch, ABOVE_CLUSTER, 1000);
        expect(accounts).toEqual(Array.from({ length: 10 }, (_, k) => `rClus${String(90 + k).padStart(3, '0')}`));
        expect(upTo).toBe(CLUSTER + 99 * 10 + 9);
        expect((await poolsChangedSince(ch, BASES[3] - 1, 1000)).accounts).toHaveLength(POOLS + POOLS);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('ammPoolsWatermark', () => {
    const A = 'rMark00000000000000000000000000A';
    const B = 'rMark00000000000000000000000000B';

    it('is 0 for an empty table, and the ledger before the first row when no pool has been rebuilt', async () => {
      const ch = await fresh();
      expect(await ammPoolsWatermark(ch)).toBe(0);
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: A, ledger_index: 100 }),
        state({ amm_account: B, ledger_index: 250 }),
        state({ amm_account: A, ledger_index: 300 }),
      ]);
      expect(await ammPoolsWatermark(ch)).toBe(99);
    });

    it('is the newest ledger when every pool has seen all its rows, and moves back to the first row a pool has not seen', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: A, ledger_index: 100, reserve_base: '1', reserve_counter: '1' }),
        state({ amm_account: B, ledger_index: 250, reserve_base: '1', reserve_counter: '1' }),
      ]);
      await recomputeAmmPools(ch, noRates(), [A, B]);
      expect(await ammPoolsWatermark(ch)).toBe(250);

      // the live job's pools changed: B at 400 and A at 300; B is rebuilt, A is not
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: B, ledger_index: 400, reserve_base: '2', reserve_counter: '2' }),
        state({ amm_account: A, ledger_index: 300, reserve_base: '2', reserve_counter: '2' }),
      ]);
      await recomputeAmmPools(ch, noRates(), [B]);
      // B is up to 400, but A is behind at 300: the cursor is the ledger before A's first unseen row, not the newest ledger of
      // any pool (a pool rebuilt up to the head must not carry the cursor past the pools that wait)
      expect(await ammPoolsWatermark(ch)).toBe(299);
      await recomputeAmmPools(ch, noRates(), [A]);
      expect(await ammPoolsWatermark(ch)).toBe(400);
    });

    it('reads the newest version of a pool, so a rebuild that saw less is not mistaken for one that saw more', async () => {
      const ch = await fresh();
      await ch.insert(Table.AmmPoolStates, [
        state({ amm_account: A, ledger_index: 100 }),
        state({ amm_account: A, ledger_index: 200 }),
      ]);
      await recomputeAmmPools(ch, noRates(), [A]);
      expect(await ammPoolsWatermark(ch)).toBe(200);
      // rows past the newest version's last_ledger are unseen even though an older version may have seen them
      await ch.insert(Table.AmmPoolStates, [state({ amm_account: A, ledger_index: 250 })]);
      expect(await ammPoolsWatermark(ch)).toBe(249);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('poolsClosedIn', () => {
    it('finds the pools with a state row in the ledgers that closed in a window, and none for a window without ledgers', async () => {
      const ch = await fresh();
      await new LedgerWriter(ch, ctx).write(AMM_LEDGERS);
      const rates = new RatesService(ch, 'XRP');
      const closeOf = (index: number): number =>
        (AMM_LEDGERS.find((l) => l.header.ledger_index === index) as (typeof AMM_LEDGERS)[number]).header.close_time;
      const poolsAt = (index: number): string[] =>
        [
          ...new Set(
            AMM_BUILT.filter((b) => b.ledger.ledger_index === index).flatMap((b) =>
              b.ammPoolStates.map((s) => s.amm_account),
            ),
          ),
        ].sort();

      // the ledger of the XRP/RLUSD deposit: a window of a minute around its close time holds that ledger only
      const close = closeOf(107698848);
      expect(await poolsClosedIn(ch, rates, new Date((close - 30) * SEC), new Date((close + 30) * SEC))).toEqual(
        poolsAt(107698848),
      );
      expect(poolsAt(107698848)).toContain('rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3');
      // [from, to): the close time itself is in, the second after it is not
      expect(await poolsClosedIn(ch, rates, new Date(close * SEC), new Date((close + 1) * SEC))).toEqual(
        poolsAt(107698848),
      );
      expect(await poolsClosedIn(ch, rates, new Date((close + 1) * SEC), new Date((close + 2) * SEC))).toEqual([]);
      // a window of everything gives every pool
      const all = await poolsClosedIn(ch, rates, new Date(0), new Date(4_000_000_000 * SEC));
      expect(all).toEqual([...new Set(AMM_BUILT.flatMap((b) => b.ammPoolStates.map((s) => s.amm_account)))].sort());
    });
  });
});

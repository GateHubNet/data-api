import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import {
  AMM_DAILY_CHUNK,
  AMM_DAILY_CONFIG_VERSION,
  AMM_DAILY_STATES_SQL,
  AMM_DAILY_SWAPS_SQL,
  AMM_DAILY_TOUCHES_SQL,
  AmmDailyRecomputeAborted,
  ammDailyVersions,
  ammDaysDone,
  ammFirstDay,
  computeAmmDaily,
} from '../src/aggregate/amm-daily.job';
import { AMM_FILL_WINDOW_LEDGERS, committedHead } from '../src/aggregate/amm-pools.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import {
  AmmDailyRow,
  AmmGovernanceRow,
  AmmLiquidityRow,
  AmmPoolStatesRow,
  ExchangesRow,
  UnixSeconds,
} from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, assetKey } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { RIPPLE_EPOCH_MS } from '../src/util/time';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * The `amm_daily` job on a real ClickHouse.
 *
 * Part 1 computes every UTC day of the real mainnet AMM fixtures (`fixtures/xrpl/amm`, written through the real
 * `LedgerWriter`) and compares each pool-day with an oracle that works from the rows `buildLedgerRows` made, in plain
 * JavaScript, plus numbers worked out by hand. Part 2 is a world made by hand (a fee that changes during the day, a slot that
 * is held, authorised and expired, a pool with a vote only, a deposit only, a pool that is deleted that day). Part 3 is what
 * the readers rely on: one version per day, a pool-day that vanishes, the sentinel and its finality, `ammDaysDone`, real
 * duplicate rows, ledgers that are not committed, the abort. Part 4 proves that no read crosses the pairs (Rulings R-A3 and
 * R-A14) on a table of several parts.
 */

const SEC = 1000;
const DAY = 86_400;
const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / SEC;

const ctx = parseContextFor(getNetworkProfile('xrpl'));
const AMM_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/amm')).list();
const AMM_BUILT = AMM_LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

const ISSUER_A = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ISSUER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ISSUER_C = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE';
const ISSUER_D = 'rpvRJUcmqQqyCHCmYRPW9FXFAGQEcibVz9';
const XRP: Asset = { currency: 'XRP' };
const USD: Asset = { currency: 'USD', issuer: ISSUER_A };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER_B };
const GBP: Asset = { currency: 'GBP', issuer: ISSUER_C };
const AAA: Asset = { currency: 'AAA', issuer: ISSUER_D };
const DDD: Asset = { currency: 'DDD', issuer: ISSUER_D };

const utcDay = (seconds: number): string => new Date(seconds * SEC).toISOString().slice(0, 10);
const at = (seconds: number): Date => new Date(seconds * SEC);
const hash = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

/** The key order of a stored row, pinned. */
const DAILY_KEYS = [
  'amm_account',
  'day',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'swap_count',
  'volume_base',
  'volume_counter',
  'fees_base_est',
  'fees_counter_est',
  'deposit_count',
  'withdraw_count',
  'liquidity_in_base',
  'liquidity_in_counter',
  'liquidity_out_base',
  'liquidity_out_counter',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'value_native',
  'final',
  'config_version',
  'version',
];

// ---------------------------------------------------------------------------------------------------------------------
// Rates: a native currency, and the units of other assets one native coin buys (the rest have no rate)
// ---------------------------------------------------------------------------------------------------------------------

/** `dailyNativeRates` from a table, the ledger lookups of the real service over the real database. */
class TestRates extends RatesService {
  readonly asked: Array<{ assets: string[]; day: string }> = [];

  constructor(
    ch: ClickHouseService,
    private readonly unitsPerNative: Record<string, number> = {},
  ) {
    super(ch, 'XRP');
  }

  override async dailyNativeRates(assets: Asset[], from: Date, to: Date): Promise<Map<string, Map<string, BigNumber>>> {
    const days: string[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += DAY * SEC) days.push(utcDay(t / SEC));
    this.asked.push({ assets: assets.map(assetKey), day: days[0] });
    return new Map(
      assets.map((a) => {
        const units = a.currency === 'XRP' && !a.issuer ? 1 : (this.unitsPerNative[assetKey(a)] ?? 0);
        return [assetKey(a), new Map(days.map((d) => [d, new BigNumber(units)]))];
      }),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What a reader sees: the pool rows of the set whose version is the sentinel's
// ---------------------------------------------------------------------------------------------------------------------

interface StoredDaily extends Omit<AmmDailyRow, 'version' | 'swap_count' | 'deposit_count' | 'withdraw_count'> {
  version: number;
  swap_count: number;
  deposit_count: number;
  withdraw_count: number;
}

const numbers = (r: AmmDailyRow): StoredDaily => ({
  ...r,
  swap_count: Number(r.swap_count),
  deposit_count: Number(r.deposit_count),
  withdraw_count: Number(r.withdraw_count),
  version: Number(r.version),
});

async function sentinelOf(ch: ClickHouseService, day: string): Promise<StoredDaily | undefined> {
  const rows = await ch.query<AmmDailyRow>(
    `SELECT * FROM ${Table.AmmDaily} WHERE amm_account = '' AND day = {day:Date} ORDER BY version DESC LIMIT 1`,
    { day },
  );
  return rows[0] === undefined ? undefined : numbers(rows[0]);
}

/** The set of a day as a reader reads it: the sentinel, and the pool rows that carry its version (no FINAL). */
async function dayOf(
  ch: ClickHouseService,
  day: string,
): Promise<{ sentinel: StoredDaily; pools: Map<string, StoredDaily> }> {
  const sentinel = await sentinelOf(ch, day);
  if (!sentinel) throw new Error(`no sentinel for ${day}`);
  const rows = await ch.query<AmmDailyRow>(
    `SELECT * FROM ${Table.AmmDaily}
      WHERE amm_account != '' AND day = {day:Date} AND version = {version:UInt64}
      ORDER BY amm_account`,
    { day, version: sentinel.version },
  );
  return { sentinel, pools: new Map(rows.map((r) => [r.amm_account, numbers(r)])) };
}

const rowCount = async (ch: ClickHouseService, where = '1'): Promise<number> =>
  Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${Table.AmmDaily} WHERE ${where}`))?.n);

// ---------------------------------------------------------------------------------------------------------------------
// Rows made by hand
// ---------------------------------------------------------------------------------------------------------------------

interface PoolDef {
  account: string;
  base: Asset;
  counter: Asset;
}

const pool = (account: string, base: Asset, counter: Asset): PoolDef => ({
  account: account.padEnd(33, '0').slice(0, 33),
  base,
  counter,
});

/** The close time of every ledger of the hand-made world (unix seconds), filled by `commit`. */
const CLOSES = new Map<number, number>();

function state(p: PoolDef, ledger: number, tx: number, over: Partial<AmmPoolStatesRow> = {}): AmmPoolStatesRow {
  return {
    amm_account: p.account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: CLOSES.get(ledger) as UnixSeconds,
    tx_type: 'Payment',
    base_currency: p.base.currency,
    base_issuer: p.base.issuer ?? '',
    counter_currency: p.counter.currency,
    counter_issuer: p.counter.issuer ?? '',
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

interface SwapOptions {
  taker: string;
  /** Which side the pool received. */
  in: 'base' | 'counter';
  /** The absolute amounts of the pool's change. */
  base: string;
  counter: string;
  node?: number;
}

function swap(p: PoolDef, ledger: number, tx: number, o: SwapOptions): ExchangesRow {
  return {
    base_currency: p.base.currency,
    base_issuer: p.base.issuer ?? '',
    counter_currency: p.counter.currency,
    counter_issuer: p.counter.issuer ?? '',
    ledger_index: ledger,
    tx_index: tx,
    node_index: o.node ?? 3,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: CLOSES.get(ledger) as UnixSeconds,
    base_amount: o.base,
    counter_amount: o.counter,
    base_amount_f: Number(o.base),
    counter_amount_f: Number(o.counter),
    rate: '1',
    rate_f: 1,
    // the buyer received base: the pool when base flowed in
    buyer: o.in === 'base' ? p.account : o.taker,
    seller: o.in === 'base' ? o.taker : p.account,
    taker: o.taker,
    provider: p.account,
    offer_sequence: 0,
    amm_account: p.account,
    autobridged_currency: null,
    autobridged_issuer: null,
    tx_type: 'Payment',
    client: null,
  };
}

/** A trade against an offer, not a pool: it is in the same pair and must count for nothing. */
function orderBookTrade(p: PoolDef, ledger: number, tx: number, taker: string, base: string): ExchangesRow {
  return {
    ...swap(p, ledger, tx, { taker, in: 'base', base, counter: '1', node: 9 }),
    buyer: taker,
    seller: 'rMakerOfAnOffer00000000000000000',
    provider: 'rMakerOfAnOffer00000000000000000',
    offer_sequence: 77,
    amm_account: '',
    tx_type: 'OfferCreate',
  };
}

function liquidity(
  p: PoolDef,
  ledger: number,
  tx: number,
  event: string,
  base: string,
  counter: string,
  lp = '0',
): AmmLiquidityRow {
  return {
    amm_account: p.account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: CLOSES.get(ledger) as UnixSeconds,
    account: 'rLiquidityProvider0000000000000000',
    initiator: 'rLiquidityProvider0000000000000000',
    event,
    mode: event === 'deposit' || event === 'withdraw' ? 'two_asset' : '',
    base_amount: base,
    counter_amount: counter,
    lp_tokens: lp,
    base_amount_f: Number(base),
    counter_amount_f: Number(counter),
    lp_tokens_f: Number(lp),
  };
}

function bid(
  p: PoolDef,
  ledger: number,
  tx: number,
  holder: string,
  auth: string[],
  discounted: number,
  expiration: number,
): AmmGovernanceRow {
  return {
    amm_account: p.account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: CLOSES.get(ledger) as UnixSeconds,
    kind: 'bid',
    account: holder,
    fee_voted: null,
    trading_fee_after: null,
    bid_min: '5',
    bid_max: '5',
    price_paid: '5',
    slot_holder: holder,
    slot_discounted_fee: discounted,
    slot_expiration: expiration,
    auth_accounts: auth,
  };
}

/** An AMMVote: it says nothing of the auction slot (a reader of the bids must not take it for one). */
function vote(p: PoolDef, ledger: number, tx: number, account: string, fee: number): AmmGovernanceRow {
  return {
    ...bid(p, ledger, tx, account, [], 0, 0),
    kind: 'vote',
    fee_voted: fee,
    trading_fee_after: fee,
    bid_min: null,
    bid_max: null,
    price_paid: null,
    slot_holder: null,
    slot_discounted_fee: null,
    slot_expiration: null,
  };
}

const ledgerRow = (ledger_index: number, close_time: number) => ({
  ledger_index,
  ledger_hash: String(ledger_index).padStart(64, 'C'),
  close_time,
});

/** The `ledgers` rows (the commit markers) of ledgers whose close times are in `CLOSES`. */
async function commit(ch: ClickHouseService, ledgers: number[]): Promise<void> {
  await ch.insert(
    Table.Ledgers,
    ledgers.map((l) => ledgerRow(l, CLOSES.get(l) as number)),
  );
}

/** State rows with their touches (the ledger writer writes both). */
async function insertStates(ch: ClickHouseService, rows: AmmPoolStatesRow[]): Promise<void> {
  await ch.insert(Table.AmmPoolStates, rows);
  await ch.insert(
    Table.AmmPoolTouches,
    rows.map(({ ledger_index, tx_index, amm_account }) => ({ ledger_index, tx_index, amm_account })),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The hand-made world: 2026-03-09 (day 0), 2026-03-10 (day 1: the day under test), the day after it
// ---------------------------------------------------------------------------------------------------------------------

const D0 = Date.UTC(2026, 2, 9) / SEC;
const D1 = D0 + DAY;
const D2 = D1 + DAY;
const D1_KEY = utcDay(D1);
const D0_KEY = utcDay(D0);
const HOUR = 3600;
/** Ledgers: 900 on day 0; 1000-1003 on day 1; 1100 and 1101 on day 2 (the newest closes 2 h into it: day 1 is final). */
const LEDGER_CLOSES: Array<[number, number]> = [
  [900, D0 + 10 * HOUR],
  [1000, D1 + HOUR],
  [1001, D1 + 5 * HOUR],
  [1002, D1 + 12 * HOUR],
  [1003, D1 + 23 * HOUR + 1800],
  [1100, D2 + 1800],
  [1101, D2 + 2 * HOUR],
];
for (const [ledger, close] of LEDGER_CLOSES) CLOSES.set(ledger, close);

const TAKER_1 = 'rTakerOne0000000000000000000000';
const TAKER_2 = 'rTakerTwo0000000000000000000000';
const HOLDER = 'rSlotHolder000000000000000000000';
const FRIEND = 'rSlotFriend000000000000000000000';
const HOLDER_2 = 'rSlotHolderTwo00000000000000000';
const FRIEND_2 = 'rSlotFriendTwo00000000000000000';

const P = pool('rPoolP', USD, XRP);
const P2 = pool('rPoolP2', USD, XRP); // the same pair as P: its swaps must not count for P
const Q = pool('rPoolQ', EUR, USD);
const R = pool('rPoolR', GBP, XRP);
const S = pool('rPoolS', AAA, XRP);
const DEL = pool('rPoolDeleted', DDD, XRP);

/** The slots end in ripple seconds: the first at the end of day 1, the second at 06:00 of day 1. */
const SLOT_P_ENDS = D2 - RIPPLE_EPOCH_S;
const SLOT_P2_ENDS = D1 + 6 * HOUR - RIPPLE_EPOCH_S;

function handMadeRows() {
  const states: AmmPoolStatesRow[] = [
    // day 0
    state(P, 900, 0, {
      tx_type: 'AMMCreate',
      reserve_base: '1000',
      reserve_counter: '2000',
      lp_supply: '1414.2',
      lp_currency: '03A1',
      trading_fee: 300,
    }),
    state(P2, 900, 1, {
      tx_type: 'AMMCreate',
      reserve_base: '10000',
      reserve_counter: '10000',
      lp_supply: '10000',
      lp_currency: '03B2',
      trading_fee: 400,
      auction_holder: HOLDER_2,
      auction_price: '1',
      auction_discounted_fee: 40,
      auction_expiration: SLOT_P2_ENDS,
    }),
    state(Q, 900, 2, {
      tx_type: 'AMMCreate',
      reserve_base: '100',
      reserve_counter: '200',
      lp_supply: '300',
      lp_currency: '03C3',
      trading_fee: 600,
    }),
    state(R, 900, 3, {
      reserve_base: '50',
      reserve_counter: '70',
      lp_supply: '60',
      lp_currency: '03D4',
      trading_fee: 100,
    }),
    state(S, 900, 4, {
      reserve_base: '9',
      reserve_counter: '9',
      lp_supply: '9',
      lp_currency: '03E5',
      trading_fee: 100,
    }),
    state(DEL, 900, 5, {
      reserve_base: '10',
      reserve_counter: '10',
      lp_supply: '10',
      lp_currency: '03F6',
      trading_fee: 200,
    }),
    // day 1, pool P: two swaps at the fee of day 0, a vote, a bid, three swaps, a deposit, a withdrawal and a last swap
    state(P, 1000, 1, { reserve_base: '950.5', reserve_counter: '2100' }),
    state(P, 1000, 2, { reserve_base: '970.5', reserve_counter: '2061' }),
    state(P, 1001, 5, { tx_type: 'AMMVote', trading_fee: 500, lp_supply: '1414.2' }),
    state(P, 1001, 9, {
      tx_type: 'AMMBid',
      trading_fee: 500,
      lp_supply: '1409.2',
      auction_holder: HOLDER,
      auction_price: '5',
      auction_discounted_fee: 50,
      auction_expiration: SLOT_P_ENDS,
    }),
    // a vote after the bid: it carries no slot, and must not undo the authorised accounts of the bid
    state(P, 1002, 1, { tx_type: 'AMMVote', trading_fee: 500, lp_supply: '1409.2' }),
    state(P, 1002, 3, { reserve_base: '1970.5', reserve_counter: '161' }),
    state(P, 1002, 4, { reserve_base: '870.5', reserve_counter: '2161' }),
    state(P, 1002, 5, { reserve_base: '970.5', reserve_counter: '2066' }),
    state(P, 1002, 10, {
      tx_type: 'AMMDeposit',
      reserve_base: '980.5',
      reserve_counter: '2086',
      lp_supply: '1423.2',
      trading_fee: 500,
      auction_holder: HOLDER,
      auction_price: '5',
      auction_discounted_fee: 50,
      auction_expiration: SLOT_P_ENDS,
    }),
    state(P, 1003, 2, {
      tx_type: 'AMMWithdraw',
      reserve_base: '975.5',
      reserve_counter: '2076',
      lp_supply: '1418.2',
      trading_fee: 500,
      auction_holder: HOLDER,
      auction_price: '5',
      auction_discounted_fee: 50,
      auction_expiration: SLOT_P_ENDS,
    }),
    state(P, 1003, 7, { reserve_base: '970.6', reserve_counter: '2086' }),
    // pool P2: the slot of day 0 is in force until 06:00 of day 1 (and a vote of day 0 came after its bid)
    state(P2, 900, 6, { tx_type: 'AMMVote', trading_fee: 400, lp_supply: '10000' }),
    state(P2, 1000, 20, { reserve_base: '15000', reserve_counter: '9900' }),
    state(P2, 1000, 21, { reserve_base: '14000', reserve_counter: '19900' }),
    state(P2, 1002, 30, { reserve_base: '19000', reserve_counter: '19700' }),
    // pool Q: a vote only
    state(Q, 1001, 7, { tx_type: 'AMMVote', trading_fee: 700, lp_supply: '300' }),
    // pool R: a deposit only
    state(R, 1002, 12, {
      tx_type: 'AMMDeposit',
      reserve_base: '55',
      reserve_counter: '77',
      lp_supply: '66',
      trading_fee: 100,
    }),
    // pool DEL: a swap, then the withdrawal of everything, which deletes it
    state(DEL, 1001, 1, { reserve_base: '11', reserve_counter: '9' }),
    state(DEL, 1002, 40, {
      tx_type: 'AMMWithdraw',
      reserve_base: '0',
      reserve_counter: '0',
      lp_supply: '0',
      deleted: 1,
    }),
  ];

  const swaps: ExchangesRow[] = [
    swap(P, 1000, 1, { taker: TAKER_1, in: 'counter', base: '49.5', counter: '100' }),
    swap(P, 1000, 2, { taker: TAKER_2, in: 'base', base: '20', counter: '39' }),
    swap(P, 1002, 3, { taker: HOLDER, in: 'base', base: '1000', counter: '1900' }),
    swap(P, 1002, 4, { taker: FRIEND, in: 'counter', base: '1100', counter: '2000' }),
    swap(P, 1002, 5, { taker: TAKER_1, in: 'base', base: '100', counter: '95' }),
    swap(P, 1003, 7, { taker: TAKER_2, in: 'counter', base: '4.9', counter: '10' }),
    swap(P2, 1000, 20, { taker: HOLDER_2, in: 'base', base: '5000', counter: '100' }),
    swap(P2, 1000, 21, { taker: FRIEND_2, in: 'counter', base: '1000', counter: '10000' }),
    swap(P2, 1002, 30, { taker: HOLDER_2, in: 'base', base: '5000', counter: '200' }),
    swap(DEL, 1001, 1, { taker: TAKER_1, in: 'base', base: '1', counter: '1' }),
    // order-book trades of the same pair, and a pool swap of another day
    orderBookTrade(P, 1000, 40, HOLDER, '777'),
    orderBookTrade(P, 1002, 41, FRIEND, '888'),
  ];

  const liquidityRows: AmmLiquidityRow[] = [
    liquidity(P, 1002, 10, 'deposit', '10', '20', '14'),
    liquidity(P, 1003, 2, 'withdraw', '-5', '-10', '-5'),
    liquidity(R, 1002, 12, 'deposit', '5', '7', '6'),
    liquidity(DEL, 1002, 40, 'withdraw', '-11', '-9', '-10'),
    liquidity(P, 900, 0, 'create', '1000', '2000', '1414.2'),
  ];

  const bids: AmmGovernanceRow[] = [
    bid(P2, 900, 1, HOLDER_2, [FRIEND_2], 40, SLOT_P2_ENDS),
    vote(P2, 900, 6, TAKER_1, 400),
    bid(P, 1001, 9, HOLDER, [FRIEND], 50, SLOT_P_ENDS),
    vote(P, 1002, 1, TAKER_2, 500),
  ];
  return { states, swaps, liquidityRows, bids };
}

async function seedHandMade(ch: ClickHouseService): Promise<void> {
  const rows = handMadeRows();
  await insertStates(ch, rows.states);
  await ch.insert(Table.Exchanges, rows.swaps);
  await ch.insert(Table.AmmLiquidity, rows.liquidityRows);
  await ch.insert(Table.AmmGovernance, rows.bids);
  await commit(
    ch,
    LEDGER_CLOSES.map(([l]) => l),
  );
}

/** What a pool-day row holds, with the zeros of a pool that did nothing but be touched. */
function expected(p: PoolDef, over: Partial<StoredDaily>): Omit<StoredDaily, 'version'> {
  return {
    amm_account: p.account,
    day: D1_KEY,
    base_currency: p.base.currency,
    base_issuer: p.base.issuer ?? '',
    counter_currency: p.counter.currency,
    counter_issuer: p.counter.issuer ?? '',
    swap_count: 0,
    volume_base: '0',
    volume_counter: '0',
    fees_base_est: '0',
    fees_counter_est: '0',
    deposit_count: 0,
    withdraw_count: 0,
    liquidity_in_base: '0',
    liquidity_in_counter: '0',
    liquidity_out_base: '0',
    liquidity_out_counter: '0',
    reserve_base: null,
    reserve_counter: null,
    lp_supply: null,
    trading_fee: null,
    value_native: null,
    final: 0,
    config_version: AMM_DAILY_CONFIG_VERSION,
    ...over,
  };
}

const withoutVersion = ({ version: _version, ...rest }: StoredDaily): Omit<StoredDaily, 'version'> => rest;

describe('the amm_daily job (e2e)', () => {
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
    const config = { ...container.config, database: `amm_daily_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const rates = (ch: ClickHouseService, units: Record<string, number> = {}): TestRates => new TestRates(ch, units);

  // -------------------------------------------------------------------------------------------------------------------
  describe('the pools of the real AMM fixtures', () => {
    let ch: ClickHouseService;
    const days: string[] = [...new Set(AMM_LEDGERS.map((l) => utcDay(l.header.close_time)))].sort();
    const NEWEST_CLOSE = Math.max(...AMM_LEDGERS.map((l) => l.header.close_time));
    const allStates = AMM_BUILT.flatMap((b) => b.ammPoolStates);
    const allSwaps = AMM_BUILT.flatMap((b) => b.exchanges).filter((e) => e.amm_account !== '');
    const allLiquidity = AMM_BUILT.flatMap((b) => b.ammLiquidity);
    const allBids = AMM_BUILT.flatMap((b) => b.ammGovernance).filter((g) => g.kind === 'bid');
    const dayOfLedger = new Map(AMM_LEDGERS.map((l) => [l.header.ledger_index, utcDay(l.header.close_time)]));

    beforeAll(async () => {
      ch = await fresh();
      await new LedgerWriter(ch, ctx).write(AMM_LEDGERS);
      const r = rates(ch);
      for (const day of days) await computeAmmDaily(ch, r, at(Date.parse(`${day}T00:00:00Z`) / SEC));
    });

    const key = (ledger: number, tx: number): [number, number] => [ledger, tx];
    const before = (a: [number, number], b: [number, number]): boolean =>
      a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

    /**
     * The oracle: the day of a pool worked out from the rows the parser made, by looking at every row of the pool up to a
     * point (no running state): the fee of a swap is the last non-null fee up to it, the discount needs the last holder,
     * discounted fee and expiration up to it and, for a friend, the last bid up to it.
     */
    function oracle(day: string): Map<string, Omit<StoredDaily, 'version'>> {
      const ledgersOfDay = AMM_LEDGERS.filter((l) => dayOfLedger.get(l.header.ledger_index) === day).map(
        (l) => l.header.ledger_index,
      );
      const last = Math.max(...ledgersOfDay);
      const inDay = (ledger: number): boolean => ledgersOfDay.includes(ledger);
      const pools = [...new Set(allStates.filter((s) => inDay(s.ledger_index)).map((s) => s.amm_account))].sort();
      const out = new Map<string, Omit<StoredDaily, 'version'>>();
      for (const account of pools) {
        const states = allStates
          .filter((s) => s.amm_account === account && s.ledger_index <= last)
          .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index);
        const newest = states[states.length - 1];
        const lastNonNull = <K extends keyof AmmPoolStatesRow>(
          field: K,
          upTo: [number, number] = key(last, Number.MAX_SAFE_INTEGER),
        ): AmmPoolStatesRow[K] | null => {
          let found: AmmPoolStatesRow[K] | null = null;
          for (const s of states)
            if (before(key(s.ledger_index, s.tx_index), upTo) && s[field] !== null) found = s[field];
          return found;
        };

        let volume_base = new BigNumber(0);
        let volume_counter = new BigNumber(0);
        let fees_base = new BigNumber(0);
        let fees_counter = new BigNumber(0);
        let swap_count = 0;
        for (const s of allSwaps.filter((x) => x.amm_account === account && inDay(x.ledger_index))) {
          swap_count++;
          const upTo = key(s.ledger_index, s.tx_index);
          const input = new BigNumber(s.buyer === account ? s.base_amount : s.counter_amount);
          if (s.buyer === account) volume_base = volume_base.plus(input);
          else volume_counter = volume_counter.plus(input);
          let fee = lastNonNull('trading_fee', upTo);
          const holder = lastNonNull('auction_holder', upTo);
          const discounted = lastNonNull('auction_discounted_fee', upTo);
          const expires = lastNonNull('auction_expiration', upTo);
          const lastBid = allBids
            .filter((b) => b.amm_account === account && before(key(b.ledger_index, b.tx_index), upTo))
            .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index)
            .pop();
          const member =
            holder !== null &&
            (s.taker === holder || (lastBid?.slot_holder === holder && lastBid.auth_accounts.includes(s.taker)));
          const live = expires === null || s.close_time - RIPPLE_EPOCH_S < expires;
          if (member && live && discounted !== null) fee = discounted;
          const charged = fee === null ? new BigNumber(0) : input.times(fee).dividedBy(100000);
          if (s.buyer === account) fees_base = fees_base.plus(charged);
          else fees_counter = fees_counter.plus(charged);
        }

        let deposit_count = 0;
        let withdraw_count = 0;
        const flow = {
          in_base: new BigNumber(0),
          in_counter: new BigNumber(0),
          out_base: new BigNumber(0),
          out_counter: new BigNumber(0),
        };
        for (const l of allLiquidity.filter((x) => x.amm_account === account && inDay(x.ledger_index))) {
          if (l.event === 'create' || l.event === 'deposit') deposit_count++;
          if (l.event === 'withdraw' || l.event === 'clawback') withdraw_count++;
          const [b, c] = [new BigNumber(l.base_amount), new BigNumber(l.counter_amount)];
          if (b.gt(0)) flow.in_base = flow.in_base.plus(b);
          else flow.out_base = flow.out_base.minus(b);
          if (c.gt(0)) flow.in_counter = flow.in_counter.plus(c);
          else flow.out_counter = flow.out_counter.minus(c);
        }

        const reserve_base = lastNonNull('reserve_base');
        const reserve_counter = lastNonNull('reserve_counter');
        // no rates in this world: only a pool with the native currency has a value, and a deleted pool has none
        const nativeBase = newest.base_currency === 'XRP' && newest.base_issuer === '';
        const nativeCounter = newest.counter_currency === 'XRP' && newest.counter_issuer === '';
        const value =
          newest.deleted === 1
            ? null
            : nativeBase
              ? reserve_base === null
                ? null
                : 2 * Number(reserve_base)
              : nativeCounter
                ? reserve_counter === null
                  ? null
                  : 2 * Number(reserve_counter)
                : null;
        out.set(account, {
          amm_account: account,
          day,
          base_currency: newest.base_currency,
          base_issuer: newest.base_issuer,
          counter_currency: newest.counter_currency,
          counter_issuer: newest.counter_issuer,
          swap_count,
          volume_base: volume_base.toString(),
          volume_counter: volume_counter.toString(),
          fees_base_est: fees_base.toString(),
          fees_counter_est: fees_counter.toString(),
          deposit_count,
          withdraw_count,
          liquidity_in_base: flow.in_base.toString(),
          liquidity_in_counter: flow.in_counter.toString(),
          liquidity_out_base: flow.out_base.toString(),
          liquidity_out_counter: flow.out_counter.toString(),
          reserve_base,
          reserve_counter,
          lp_supply: lastNonNull('lp_supply'),
          trading_fee: lastNonNull('trading_fee'),
          value_native: value,
          final: 0,
          config_version: AMM_DAILY_CONFIG_VERSION,
        });
      }
      return out;
    }

    it('has a day for each of the eleven UTC days of the fixtures, five of the 16 ledgers on one of them', () => {
      expect(days).toHaveLength(11);
      expect(AMM_LEDGERS.filter((l) => dayOfLedger.get(l.header.ledger_index) === '2026-10-16')).toHaveLength(5);
    });

    it('every pool-day equals the oracle that looks at the rows of the pool up to each swap (all fields but the version)', async () => {
      let poolDays = 0;
      for (const day of days) {
        const { pools } = await dayOf(ch, day);
        const want = oracle(day);
        expect([...pools.keys()].sort()).toEqual([...want.keys()].sort());
        for (const [account, row] of pools) {
          expect([day, account, withoutVersion(row)]).toEqual([day, account, want.get(account)]);
          poolDays++;
        }
      }
      expect(poolDays).toBeGreaterThan(100);
    });

    it('every day has a sentinel: final up to 2026-10-16 (the newest ledger closed more than an hour after it), not 2026-10-17', async () => {
      expect(utcDay(NEWEST_CLOSE)).toBe('2026-10-17');
      for (const day of days) {
        const { sentinel, pools } = await dayOf(ch, day);
        expect({ day, final: sentinel.final }).toEqual({ day, final: day < '2026-10-17' ? 1 : 0 });
        expect(sentinel.config_version).toBe(AMM_DAILY_CONFIG_VERSION);
        expect([...pools.values()].every((p) => p.final === 0 && p.version === sentinel.version)).toBe(true);
      }
    });

    it('a day has the pools that a transaction touched that day, and no pool with only older history', async () => {
      const { pools } = await dayOf(ch, '2026-10-17');
      expect([...pools.keys()]).toEqual(['rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3']);
      const { pools: oct16 } = await dayOf(ch, '2026-10-16');
      expect(oct16.size).toBe(11);
    });

    it('the XRP/RLUSD pool on 2026-10-16: the amounts that went in, and the fee only from the row that shows it', async () => {
      // three swaps: 134 XRP in (the first, before any row shows the pool fee: no fee estimate), 0.766153 XRP in at a fee of 205,
      // and 543.870850376 RLUSD in at a fee of 205; two deposits (1010 XRP; 108.041216585 RLUSD and 82.769304 XRP)
      const row = (await dayOf(ch, '2026-10-16')).pools.get('rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3') as StoredDaily;
      expect(row).toMatchObject({
        swap_count: 3,
        volume_base: '543.870850376',
        volume_counter: '134.766153',
        fees_base_est: '1.1149352432708', // 543.870850376 x 205 / 100000
        fees_counter_est: '0.00157061365', // 0.766153 x 205 / 100000
        deposit_count: 2,
        withdraw_count: 0,
        liquidity_in_base: '108.041216585',
        liquidity_in_counter: '1092.769304',
        liquidity_out_base: '0',
        liquidity_out_counter: '0',
        trading_fee: 205,
      });
    });

    it('a day of one create: the creator deposit counts as a deposit, in the amounts of the new pool', async () => {
      const row = (await dayOf(ch, '2026-10-12')).pools.get('rUAEvY1XNvnkurE9RunV7u3yjh3jQsQPsG') as StoredDaily;
      expect(row).toMatchObject({
        swap_count: 0,
        deposit_count: 1,
        withdraw_count: 0,
        liquidity_in_base: '1000000',
        liquidity_in_counter: '500',
        reserve_base: '1000000',
        reserve_counter: '500',
        value_native: 1000,
      });
    });

    it('a day with only a vote has the pool with its fee and no swaps', async () => {
      const row = (await dayOf(ch, '2026-10-14')).pools.get('rhEypxvxNXMdMTd3GXpb6gTN1jvb4h3nef') as StoredDaily;
      expect(row).toMatchObject({ swap_count: 0, volume_base: '0', volume_counter: '0', trading_fee: 1000 });
    });

    it('the deleted pool still has its day, with the empty reserves of the end of it and no value', async () => {
      const row = (await dayOf(ch, '2025-11-11')).pools.get('rGLnUKdptCVobJKEkrwxtdyGZ98Evdmqdz') as StoredDaily;
      expect(row).toMatchObject({
        withdraw_count: 1,
        reserve_base: '0',
        reserve_counter: '0',
        lp_supply: '0',
        value_native: null,
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a day made by hand', () => {
    let ch: ClickHouseService;
    let r: TestRates;
    let pools: Map<string, StoredDaily>;
    let sentinel: StoredDaily;

    beforeAll(async () => {
      ch = await fresh();
      await seedHandMade(ch);
      r = rates(ch, { [assetKey(EUR)]: 4, [assetKey(USD)]: 2 });
      expect(await computeAmmDaily(ch, r, at(D1))).toBe(5);
      ({ pools, sentinel } = await dayOf(ch, D1_KEY));
    });

    it('has one row for each pool a transaction touched that day, and none for the pool that was last touched the day before', () => {
      expect([...pools.keys()].sort()).toEqual([P, P2, Q, R, DEL].map((p) => p.account).sort());
      expect(pools.has(S.account)).toBe(false);
    });

    it('pool P: six swaps, the amounts that went in by side, the estimated fees, the liquidity, the closing state and its value', () => {
      // volume: base in 20 + 1000 + 100, counter in 100 + 2000 + 10
      // fees: 20 x 300 + 1000 x 50 (the holder) + 100 x 500 = 106 000 / 100 000; 100 x 300 + 2000 x 50 (a friend) + 10 x 500
      expect(withoutVersion(pools.get(P.account) as StoredDaily)).toEqual(
        expected(P, {
          swap_count: 6,
          volume_base: '1120',
          volume_counter: '2110',
          fees_base_est: '1.06',
          fees_counter_est: '1.35',
          deposit_count: 1,
          withdraw_count: 1,
          liquidity_in_base: '10',
          liquidity_in_counter: '20',
          liquidity_out_base: '5',
          liquidity_out_counter: '10',
          reserve_base: '970.6',
          reserve_counter: '2086',
          lp_supply: '1418.2',
          trading_fee: 500,
          value_native: 4172, // twice the XRP reserve
        }),
      );
    });

    it('the swaps of another pool of the same pair, and the order-book trades of the pair, are not in it', () => {
      const row = pools.get(P.account) as StoredDaily;
      expect(row.swap_count).toBe(6); // 6 of the 9 swaps of the pair; the trades of 777 and 888 are not swaps
      expect(row.volume_base).not.toBe('1897');
    });

    it('pool P2 (the same pair): the slot of day 0 discounts its holder and its friend until it ends at 06:00, and not after', () => {
      // 5000 base in at the discounted 40 (before 06:00) = 2; 10000 counter in by the friend at 40 = 4; 5000 base in at 12:00,
      // the slot over: the pool fee of 400 = 20
      expect(withoutVersion(pools.get(P2.account) as StoredDaily)).toEqual(
        expected(P2, {
          swap_count: 3,
          volume_base: '10000',
          volume_counter: '10000',
          fees_base_est: '22',
          fees_counter_est: '4',
          reserve_base: '19000',
          reserve_counter: '19700',
          lp_supply: '10000',
          trading_fee: 400,
          value_native: 39400,
        }),
      );
    });

    it('pool Q (a vote only): a row of zeros with the fee after the vote, and the value of a pool without the native currency', () => {
      // twice the EUR reserve over the 4 EUR a native coin buys
      expect(withoutVersion(pools.get(Q.account) as StoredDaily)).toEqual(
        expected(Q, {
          reserve_base: '100',
          reserve_counter: '200',
          lp_supply: '300',
          trading_fee: 700,
          value_native: 50,
        }),
      );
    });

    it('pool R (a deposit only): the deposit and nothing else', () => {
      expect(withoutVersion(pools.get(R.account) as StoredDaily)).toEqual(
        expected(R, {
          deposit_count: 1,
          liquidity_in_base: '5',
          liquidity_in_counter: '7',
          reserve_base: '55',
          reserve_counter: '77',
          lp_supply: '66',
          trading_fee: 100,
          value_native: 154,
        }),
      );
    });

    it('a pool deleted during the day has its activity, the deleted state as its closing state, and no value', () => {
      expect(withoutVersion(pools.get(DEL.account) as StoredDaily)).toEqual(
        expected(DEL, {
          swap_count: 1,
          volume_base: '1',
          fees_base_est: '0.002', // 1 x 200 / 100000
          withdraw_count: 1,
          liquidity_out_base: '11',
          liquidity_out_counter: '9',
          reserve_base: '0',
          reserve_counter: '0',
          lp_supply: '0',
          trading_fee: 200, // the deleted state row does not carry it: the last value
          value_native: null,
        }),
      );
    });

    it('asked for the rates of the day itself, once per asset, and not for a pool with the native currency or a deleted pool', () => {
      expect(r.asked.every((a) => a.day === D1_KEY)).toBe(true);
      expect(r.asked.flatMap((a) => a.assets).sort()).toEqual([assetKey(EUR)]);
    });

    it('the sentinel is the row of amm_account "" with empty assets, zero amounts and null state, final, with the set version', () => {
      expect(sentinel).toEqual({
        amm_account: '',
        day: D1_KEY,
        base_currency: '',
        base_issuer: '',
        counter_currency: '',
        counter_issuer: '',
        swap_count: 0,
        volume_base: '0',
        volume_counter: '0',
        fees_base_est: '0',
        fees_counter_est: '0',
        deposit_count: 0,
        withdraw_count: 0,
        liquidity_in_base: '0',
        liquidity_in_counter: '0',
        liquidity_out_base: '0',
        liquidity_out_counter: '0',
        reserve_base: null,
        reserve_counter: null,
        lp_supply: null,
        trading_fee: null,
        value_native: null,
        final: 1, // the newest ledger closed 2 h into the next day
        config_version: AMM_DAILY_CONFIG_VERSION,
        version: sentinel.version,
      });
      expect([...pools.values()].every((p) => p.version === sentinel.version && p.final === 0)).toBe(true);
    });

    it('stores the rows with the columns in the order of the table', async () => {
      const [row] = await ch.query<Record<string, unknown>>(
        `SELECT * FROM ${Table.AmmDaily} WHERE amm_account = {a:String} AND day = {d:Date}`,
        { a: P.account, d: D1_KEY },
      );
      expect(Object.keys(row)).toEqual(DAILY_KEYS);
    });

    it('wrote the whole set in one insert: one part with the sentinel and the five pools', async () => {
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {t:String} AND active`,
        { t: Table.AmmDaily },
      );
      expect(parts.map((p) => Number(p.rows))).toEqual([6]);
    });

    it('day 0 is a day too: the creates of the day before, a set of its own', async () => {
      expect(await computeAmmDaily(ch, r, at(D0))).toBe(6);
      const { pools: day0, sentinel: s0 } = await dayOf(ch, D0_KEY);
      expect([...day0.keys()].sort()).toEqual([P, P2, Q, R, S, DEL].map((p) => p.account).sort());
      expect(s0.final).toBe(1);
      expect(day0.get(P.account)).toMatchObject({
        deposit_count: 1, // the AMMCreate
        liquidity_in_base: '1000',
        liquidity_in_counter: '2000',
        reserve_base: '1000',
        trading_fee: 300,
        swap_count: 0,
      });
      // the day under test is untouched
      expect((await dayOf(ch, D1_KEY)).pools.size).toBe(5);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('version sets', () => {
    it('recomputing is idempotent: the same rows under a newer version, and a reader sees the newest set only', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch, { [assetKey(EUR)]: 4 });
      await computeAmmDaily(ch, r, at(D1));
      const first = await dayOf(ch, D1_KEY);
      await computeAmmDaily(ch, r, at(D1));
      const second = await dayOf(ch, D1_KEY);

      expect(second.sentinel.version).toBeGreaterThan(first.sentinel.version);
      expect([...second.pools.values()].map(withoutVersion)).toEqual([...first.pools.values()].map(withoutVersion));
      expect(withoutVersion(second.sentinel)).toEqual(withoutVersion(first.sentinel));
      // merges aside, both sets are in the table
      expect(await rowCount(ch, `day = '${D1_KEY}'`)).toBe(12);
    });

    it('a pool-day that vanishes does not linger: the newer set has no row for it, and the older one is not read', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch);
      await computeAmmDaily(ch, r, at(D1));
      expect((await dayOf(ch, D1_KEY)).pools.has(Q.account)).toBe(true);

      // the vote of pool Q is re-ingested away: its touch is gone
      await ch.command(`DELETE FROM ${Table.AmmPoolTouches} WHERE amm_account = {a:String} AND ledger_index = 1001`, {
        a: Q.account,
      });
      await computeAmmDaily(ch, r, at(D1));
      const { pools } = await dayOf(ch, D1_KEY);
      expect(pools.has(Q.account)).toBe(false);
      expect(pools.size).toBe(4);
      // the old row is still stored, under the old version
      expect(await rowCount(ch, `amm_account = '${Q.account}' AND day = '${D1_KEY}'`)).toBe(1);
    });

    it('a day with no pool left is a sentinel of a newer version over the pools of the older one', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch);
      await computeAmmDaily(ch, r, at(D1));
      await ch.command(`DELETE FROM ${Table.AmmPoolTouches} WHERE ledger_index BETWEEN 1000 AND 1003`);
      expect(await computeAmmDaily(ch, r, at(D1))).toBe(0);
      const { pools, sentinel } = await dayOf(ch, D1_KEY);
      expect(pools.size).toBe(0);
      expect(sentinel.final).toBe(1);
    });

    it('the version is the clock in milliseconds, and one past the newest version of the day when that is higher', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch);
      await computeAmmDaily(ch, r, at(D1));
      const clockBefore = Number(
        (await ch.queryOne<{ ms: string }>('SELECT toUnixTimestamp64Milli(now64(3)) AS ms'))?.ms,
      );
      // a set from the future: the next one is one past it
      const future = clockBefore + 3_600_000;
      await ch.insert(Table.AmmDaily, [
        { ...(await sentinelOf(ch, D1_KEY)), version: future } as unknown as AmmDailyRow,
      ]);
      await computeAmmDaily(ch, r, at(D1));
      expect((await sentinelOf(ch, D1_KEY))?.version).toBe(future + 1);
    });

    it('days are independent versions: day 0 and day 1 each have their own', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch);
      await computeAmmDaily(ch, r, at(D1));
      await computeAmmDaily(ch, r, at(D0));
      const versions = await ammDailyVersions(ch, at(D0), at(D1));
      expect([...versions.keys()].sort()).toEqual([D0_KEY, D1_KEY]);
      expect(versions.get(D0_KEY)).toBe((await sentinelOf(ch, D0_KEY))?.version);
      expect(versions.get(D1_KEY)).toBe((await sentinelOf(ch, D1_KEY))?.version);
    });

    describe('finality (Ruling R86): the sentinel says whether the ingest had passed the day', () => {
      it('is final once the newest committed ledger closed an hour after the end of the day, to the second', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        const r = rates(ch);
        // ledgers of day 2: the newest is the last one that counts
        CLOSES.set(1101, D2 + HOUR - 1);
        await ch.command(`ALTER TABLE ${Table.Ledgers} DELETE WHERE ledger_index = 1101 SETTINGS mutations_sync = 2`);
        await commit(ch, [1101]);
        await computeAmmDaily(ch, r, at(D1));
        expect((await sentinelOf(ch, D1_KEY))?.final).toBe(0);

        CLOSES.set(1101, D2 + HOUR);
        await ch.command(`ALTER TABLE ${Table.Ledgers} DELETE WHERE ledger_index = 1101 SETTINGS mutations_sync = 2`);
        await commit(ch, [1101]);
        await computeAmmDaily(ch, r, at(D1));
        expect((await sentinelOf(ch, D1_KEY))?.final).toBe(1);
        CLOSES.set(1101, D2 + 2 * HOUR);
      });

      it('the day the ingest is in is not final, whatever the clock says', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        await computeAmmDaily(ch, rates(ch), at(D2));
        expect((await sentinelOf(ch, utcDay(D2)))?.final).toBe(0);
      });

      it('ammDaysDone counts a day only for a final set of the config version asked for', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        const r = rates(ch);
        await computeAmmDaily(ch, r, at(D1)); // final
        await computeAmmDaily(ch, r, at(D2)); // not final
        const days = [at(D0), at(D1), at(D2)];
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, days)).toEqual(new Set([D1_KEY]));
        // another config version: nothing is done, the days are computed again
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION + 1, days)).toEqual(new Set());
      });

      it('counts a day by its newest sentinel: a later set that is not final undoes it, a set stored twice counts once', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        const r = rates(ch);
        await computeAmmDaily(ch, r, at(D1));
        const sentinel = (await sentinelOf(ch, D1_KEY)) as StoredDaily;
        // the same sentinel written again (a real duplicate), and a newer one that says the day was not final
        await ch.command(`SYSTEM STOP MERGES ${Table.AmmDaily}`);
        await ch.command(
          `INSERT INTO ${Table.AmmDaily} SELECT * FROM ${Table.AmmDaily} WHERE amm_account = ''`,
          {},
          { settings: { insert_deduplicate: 0 } },
        );
        expect(await rowCount(ch, "amm_account = ''")).toBe(2);
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, [at(D1)])).toEqual(new Set([D1_KEY]));

        await ch.insert(Table.AmmDaily, [{ ...sentinel, final: 0, version: sentinel.version + 1 }]);
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, [at(D1)])).toEqual(new Set());
        await ch.insert(Table.AmmDaily, [{ ...sentinel, final: 1, config_version: 9, version: sentinel.version + 2 }]);
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, [at(D1)])).toEqual(new Set());
        expect(await ammDaysDone(ch, 9, [at(D1)])).toEqual(new Set([D1_KEY]));
      });

      it('ammDaysDone of no days is none, and a day is cut to its UTC midnight', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        await computeAmmDaily(ch, rates(ch), at(D1));
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, [])).toEqual(new Set());
        expect(await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, [at(D1 + 17 * HOUR)])).toEqual(new Set([D1_KEY]));
      });

      it('ammDailyVersions is the newest sentinel version of each day of a range, and nothing for a day without a set', async () => {
        const ch = await fresh();
        await seedHandMade(ch);
        expect((await ammDailyVersions(ch, at(D0), at(D2))).size).toBe(0);
        await computeAmmDaily(ch, rates(ch), at(D1));
        const versions = await ammDailyVersions(ch, at(D0), at(D2));
        expect([...versions.keys()]).toEqual([D1_KEY]);
        expect(await ammDailyVersions(ch, at(D2), at(D0))).toEqual(new Map());
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rows that are there twice (a real duplicate before the merge)', () => {
    it('are counted once: swaps, liquidity events, state rows, bids and touches', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const r = rates(ch, { [assetKey(EUR)]: 4 });
      await computeAmmDaily(ch, r, at(D1));
      const once = await dayOf(ch, D1_KEY);

      const tables = [
        Table.Exchanges,
        Table.AmmLiquidity,
        Table.AmmPoolStates,
        Table.AmmGovernance,
        Table.AmmPoolTouches,
      ];
      for (const table of tables) {
        await ch.command(`SYSTEM STOP MERGES ${table}`);
        const [{ n }] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
        await ch.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
        const [{ n: after }] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
        expect({ table, rows: Number(after) }).toEqual({ table, rows: 2 * Number(n) });
      }

      await computeAmmDaily(ch, r, at(D1));
      const twice = await dayOf(ch, D1_KEY);
      expect([...twice.pools.values()].map(withoutVersion)).toEqual([...once.pools.values()].map(withoutVersion));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('committed ledgers only (the ledger writer writes the ledgers row last)', () => {
    it('ignores the rows of a ledger above the head (its ledgers row is not there yet), and counts them once it is committed', async () => {
      const ch = await fresh();
      const rows = handMadeRows();
      await insertStates(ch, rows.states);
      await ch.insert(Table.Exchanges, rows.swaps);
      await ch.insert(Table.AmmLiquidity, rows.liquidityRows);
      await ch.insert(Table.AmmGovernance, rows.bids);
      await commit(ch, [900, 1000, 1001, 1002, 1003]); // the head is ledger 1003 ...
      // ... and ledger 1004, a quarter of an hour later in the same day, is being written: its rows are there, its ledgers row is not
      CLOSES.set(1004, D1 + 23 * HOUR + 2700);
      await insertStates(ch, [state(P, 1004, 1, { reserve_base: '5', reserve_counter: '6', trading_fee: 900 })]);
      await ch.insert(Table.Exchanges, [swap(P, 1004, 1, { taker: TAKER_1, in: 'base', base: '12345', counter: '1' })]);
      await ch.insert(Table.AmmLiquidity, [liquidity(P, 1004, 2, 'deposit', '1', '1', '1')]);
      expect(await committedHead(ch)).toBe(1003);
      const r = rates(ch);
      await computeAmmDaily(ch, r, at(D1));
      const without = (await dayOf(ch, D1_KEY)).pools.get(P.account) as StoredDaily;
      expect(without).toMatchObject({
        swap_count: 6,
        volume_base: '1120',
        deposit_count: 1,
        reserve_base: '970.6',
        trading_fee: 500,
      });

      await commit(ch, [1004]);
      await computeAmmDaily(ch, r, at(D1));
      const withIt = (await dayOf(ch, D1_KEY)).pools.get(P.account) as StoredDaily;
      expect(withIt).toMatchObject({
        swap_count: 7,
        volume_base: '13465',
        deposit_count: 2,
        reserve_base: '5',
        trading_fee: 900,
      });
    });

    it('caps the day at the head: a ledger of the day above the head read is not counted, and does not make the day final', async () => {
      const ch = await fresh();
      // only ledger 1000 is committed; ledger 1001 (same day) has all its rows but no ledgers row
      await ch.insert(Table.Ledgers, [ledgerRow(1000, CLOSES.get(1000) as number)]);
      const rows = handMadeRows();
      await insertStates(ch, rows.states);
      await ch.insert(Table.Exchanges, rows.swaps);
      await ch.insert(Table.AmmLiquidity, rows.liquidityRows);
      await ch.insert(Table.AmmGovernance, rows.bids);
      await computeAmmDaily(ch, rates(ch), at(D1));
      const { pools, sentinel } = await dayOf(ch, D1_KEY);
      expect(sentinel.final).toBe(0);
      expect([...pools.keys()].sort()).toEqual([P, P2].map((p) => p.account).sort());
      expect(pools.get(P.account)).toMatchObject({
        swap_count: 2,
        volume_base: '20',
        volume_counter: '100',
        reserve_base: '970.5',
        reserve_counter: '2061',
        trading_fee: 300,
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the fee state the day starts with, and what changes it during the day', () => {
    // every swap is 100000 of base in, so that the fee in units of 1/100000 is the fee estimate itself
    const X1 = pool('rPoolX1', USD, XRP);
    const X2 = pool('rPoolX2', USD, XRP);
    const X3 = pool('rPoolX3', USD, XRP);
    const Y = pool('rPoolY', USD, XRP);
    const H1 = 'rHolderOne000000000000000000000';
    const H2 = 'rHolderTwo000000000000000000000';
    const H3 = 'rHolderThree0000000000000000000';
    const N2 = 'rNewHolderTwo00000000000000000';
    const N3 = 'rNewHolderThree000000000000000';
    const FRIEND_1 = 'rFriendOne000000000000000000000';
    const T = 'rTakerThatPaysTheFee0000000000';
    const ripple = (unixSeconds: number): number => unixSeconds - RIPPLE_EPOCH_S;
    // pools of one pair share the key of an exchange row, so each has a node index of its own
    const nodes = new Map([
      [X1.account, 1],
      [X2.account, 2],
      [X3.account, 3],
      [Y.account, 4],
    ]);
    const buy = (p: PoolDef, ledger: number, tx: number, taker: string): ExchangesRow =>
      swap(p, ledger, tx, { taker, in: 'base', base: '100000', counter: '1', node: nodes.get(p.account) });

    let pools: Map<string, StoredDaily>;

    beforeAll(async () => {
      const ch = await fresh();
      const states = [
        // the slots and fees of day 0
        state(X1, 900, 10, {
          trading_fee: 300,
          auction_holder: H1,
          auction_discounted_fee: 40,
          auction_expiration: ripple(D1 + 20 * HOUR),
        }),
        state(X2, 900, 11, {
          trading_fee: 400,
          auction_holder: H2,
          auction_discounted_fee: 50,
          auction_expiration: ripple(D1 + 3 * HOUR),
        }),
        state(X3, 900, 12, {
          trading_fee: 300,
          auction_holder: H3,
          auction_discounted_fee: 50,
          auction_expiration: ripple(D1 + 22 * HOUR),
        }),
        // X1: a vote and a renewal of the bid of the holder (with a friend) in the FIRST ledger of the day, after three swaps
        state(X1, 1000, 4, { tx_type: 'AMMVote', trading_fee: 900, auction_discounted_fee: 60 }),
        state(X1, 1000, 6, {
          tx_type: 'AMMBid',
          trading_fee: 900,
          auction_holder: H1,
          auction_discounted_fee: 60,
          auction_expiration: ripple(D1 + 20 * HOUR),
        }),
        // X2: a new holder bids at noon, after the slot of day 0 ran out (at 03:00)
        state(X2, 1002, 1, {
          tx_type: 'AMMBid',
          trading_fee: 400,
          auction_holder: N2,
          auction_discounted_fee: 70,
          auction_expiration: ripple(D1 + 20 * HOUR),
        }),
        // X3: a new holder bids in the first ledger of the day
        state(X3, 1000, 2, {
          tx_type: 'AMMBid',
          trading_fee: 300,
          auction_holder: N3,
          auction_discounted_fee: 70,
          auction_expiration: ripple(D1 + 22 * HOUR),
        }),
        // Y: rows with one value each: a fee, a holder, a discounted fee, an expiration that is already over
        state(Y, 1000, 2, { trading_fee: 700 }),
        state(Y, 1000, 4, { auction_holder: T }),
        state(Y, 1000, 5, { auction_discounted_fee: 30 }),
        state(Y, 1000, 7, { auction_expiration: ripple(D1 + HOUR - 1) }),
      ];
      // the swaps of the pools, a state row each (the pools were touched)
      const swaps = [
        buy(X1, 1000, 1, H1), // the holder: 40
        buy(X1, 1000, 2, T), // before the vote of 1000/4: 300
        buy(X1, 1000, 3, FRIEND_1), // before the bid that authorises the friend, in the same ledger: 300
        buy(X1, 1001, 1, FRIEND_1), // after it: 60
        buy(X1, 1001, 2, T), // 900
        buy(X2, 1000, 1, H2), // the slot of day 0 is in force until 03:00: 50
        buy(X2, 1001, 1, H2), // 05:00, the slot is over and nobody has bid yet: 400
        buy(X2, 1002, 2, N2), // the new holder: 70
        buy(X3, 1000, 1, H3), // before the bid of 1000/2: 50
        buy(X3, 1000, 3, N3), // after it: 70
        buy(X3, 1000, 4, H3), // no longer the holder: 300
        buy(Y, 1000, 1, T), // no fee is known yet: 0
        buy(Y, 1000, 3, T), // the fee of 1000/2: 700
        buy(Y, 1000, 6, T), // the holder of 1000/4 with the discounted fee of 1000/5, no expiration known: 30
        buy(Y, 1001, 1, T), // 05:00, the slot ended at 01:00 (1000/7): 700
      ];
      await insertStates(ch, states);
      await ch.insert(
        Table.AmmPoolStates,
        [X1, X2, X3, Y].flatMap((p) =>
          // one row for every swap that has none, to touch the pool (no values)
          swaps.filter((x) => x.amm_account === p.account).map((x) => state(p, x.ledger_index, x.tx_index + 500)),
        ),
      );
      await ch.insert(
        Table.AmmPoolTouches,
        [X1, X2, X3, Y].flatMap((p) =>
          swaps
            .filter((x) => x.amm_account === p.account)
            .map((x) => ({ ledger_index: x.ledger_index, tx_index: x.tx_index + 500, amm_account: p.account })),
        ),
      );
      await ch.insert(Table.Exchanges, swaps);
      await ch.insert(Table.AmmGovernance, [
        bid(X1, 900, 10, H1, [], 40, ripple(D1 + 20 * HOUR)),
        bid(X2, 900, 11, H2, [], 50, ripple(D1 + 3 * HOUR)),
        bid(X3, 900, 12, H3, [], 50, ripple(D1 + 22 * HOUR)),
        bid(X1, 1000, 6, H1, [FRIEND_1], 60, ripple(D1 + 20 * HOUR)),
        bid(X2, 1002, 1, N2, [], 70, ripple(D1 + 20 * HOUR)),
        bid(X3, 1000, 2, N3, [], 70, ripple(D1 + 22 * HOUR)),
      ]);
      await commit(
        ch,
        LEDGER_CLOSES.map(([l]) => l),
      );
      await computeAmmDaily(ch, rates(ch), at(D1));
      pools = (await dayOf(ch, D1_KEY)).pools;
    });

    it('pool X1: a vote and a renewed bid in the first ledger of the day apply after the swaps that come before them', () => {
      // 40 (the holder) + 300 + 300 (the friend, not yet) + 60 (the friend, now) + 900
      expect(pools.get(X1.account)).toMatchObject({ swap_count: 5, volume_base: '500000', fees_base_est: '1600' });
    });

    it('pool X2: the holder of a slot that ran out is not discounted, although the pool has a newer slot later in the day', () => {
      expect(pools.get(X2.account)).toMatchObject({ swap_count: 3, volume_base: '300000', fees_base_est: '520' }); // 50 + 400 + 70
    });

    it('pool X3: a new holder in the first ledger of the day takes the discount over from the second swap on', () => {
      expect(pools.get(X3.account)).toMatchObject({ swap_count: 3, fees_base_est: '420' }); // 50 + 70 + 300
    });

    it('pool Y: rows that carry one value each (a fee, a holder, a discounted fee, an expiration) all count', () => {
      expect(pools.get(Y.account)).toMatchObject({ swap_count: 4, volume_base: '400000', fees_base_est: '1430' }); // 0 + 700 + 30 + 700
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the day is cut at the head even when more ledgers have been committed meanwhile', () => {
    /** Rates that find the ledgers of the day somewhere other than the head the job has read (a ledger committed since). */
    class Racing extends TestRates {
      constructor(
        ch: ClickHouseService,
        private readonly claim: { min: number; max: number },
      ) {
        super(ch);
      }
      override async ledgersClosedIn() {
        return this.claim;
      }
    }

    async function world(): Promise<ClickHouseService> {
      const ch = await fresh();
      const rows = handMadeRows();
      await insertStates(ch, rows.states);
      await ch.insert(Table.Exchanges, rows.swaps);
      await ch.insert(Table.AmmLiquidity, rows.liquidityRows);
      await ch.insert(Table.AmmGovernance, rows.bids);
      await commit(ch, [900, 1000]); // the head is ledger 1000: the rows of 1001-1003 are there, their ledgers are not committed
      return ch;
    }

    it('reads up to the head, whatever the range of the day says', async () => {
      const ch = await world();
      await computeAmmDaily(ch, new Racing(ch, { min: 1000, max: 1003 }), at(D1));
      const { pools, sentinel } = await dayOf(ch, D1_KEY);
      expect(sentinel.final).toBe(0);
      expect(pools.get(P.account)).toMatchObject({
        swap_count: 2,
        volume_base: '20',
        reserve_base: '970.5',
        trading_fee: 300,
      });
      expect([...pools.keys()].sort()).toEqual([P, P2].map((p) => p.account).sort());
    });

    it('a day that starts above the head has no ledger yet: a sentinel only', async () => {
      const ch = await world();
      expect(await computeAmmDaily(ch, new Racing(ch, { min: 1001, max: 1003 }), at(D1))).toBe(0);
      expect((await dayOf(ch, D1_KEY)).pools.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what is stored, and in which order', () => {
    it('inserts the sentinel first and then the pools by account, every row with its keys in the order of the type', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const insert = jest.spyOn(ch, 'insert');
      await computeAmmDaily(ch, rates(ch, { [assetKey(EUR)]: 4 }), at(D1));
      expect(insert).toHaveBeenCalledTimes(1);
      const [table, rows] = insert.mock.calls[0] as [Table, Array<Record<string, unknown>>];
      expect(table).toBe(Table.AmmDaily);
      expect(rows.map((r) => r.amm_account)).toEqual(
        ['', P, P2, Q, R, DEL].map((p) => (typeof p === 'string' ? p : p.account)).sort(),
      );
      expect(rows[0].amm_account).toBe('');
      for (const row of rows) expect(Object.keys(row)).toEqual(DAILY_KEYS);
      expect(new Set(rows.map((r) => r.version)).size).toBe(1);
    });

    it('reads 200 pools at a time: 450 pools are three reads of their state and of their swaps', async () => {
      const ch = await fresh();
      const crowd = Array.from({ length: 450 }, (_, i) => pool(`rCrowd${String(i).padStart(4, '0')}`, USD, XRP));
      await insertStates(
        ch,
        // the touches are in the order of the ledger: the last account first
        crowd.map((p, i) =>
          state(p, 1000, crowd.length - i, { reserve_base: '1', reserve_counter: '2', trading_fee: 100 }),
        ),
      );
      await commit(ch, [1000, 1100, 1101]);
      const query = jest.spyOn(ch, 'query');
      const insert = jest.spyOn(ch, 'insert');
      expect(await computeAmmDaily(ch, rates(ch), at(D1))).toBe(450);
      // the pools are written in the order of their account, whatever chunk they were read in
      const written = (insert.mock.calls[0][1] as Array<{ amm_account: string }>).map((r) => r.amm_account);
      expect(written).toEqual(['', ...crowd.map((p) => p.account).sort()]);
      const sqls = query.mock.calls.map(([sql]) => sql);
      expect(sqls.filter((sql) => sql === AMM_DAILY_STATES_SQL)).toHaveLength(3);
      expect(sqls.filter((sql) => sql === AMM_DAILY_SWAPS_SQL)).toHaveLength(3);
      expect((await dayOf(ch, D1_KEY)).pools.size).toBe(450);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the fill-forward window (Ruling R-A21): the state of a pool is read from a window of its history, then whole if need be', () => {
    const WINDOW = 40; // ledgers: the day starts at ledger 1000, so the window starts at 960
    const FULL = Number.MAX_SAFE_INTEGER;
    const ripple = (unixSeconds: number): number => unixSeconds - RIPPLE_EPOCH_S;
    const FUTURE = ripple(D1 + 20 * HOUR);
    const PAST = ripple(D1 - HOUR);
    const SLOT_HOLDER = 'rWindowSlotHolder0000000000000000';
    const OTHER_HOLDER = 'rWindowOtherHolder000000000000000';
    const STRANGER = 'rWindowStranger00000000000000000';

    type Values = Partial<AmmPoolStatesRow>;
    /** The values of the old rows (ledger 900, long before the window), and of the rows in the window (ledger 970). */
    const OLD: Values = {
      reserve_base: '1',
      reserve_counter: '2',
      lp_supply: '3',
      trading_fee: 111,
      auction_holder: SLOT_HOLDER,
      auction_discounted_fee: 40,
      auction_expiration: FUTURE,
    };
    const NEW: Values = {
      reserve_base: '10',
      reserve_counter: '20',
      lp_supply: '30',
      trading_fee: 222,
      auction_holder: OTHER_HOLDER,
      auction_discounted_fee: 60,
      auction_expiration: FUTURE,
    };
    const minus = (values: Values, column: keyof Values): Values => {
      const { [column]: _dropped, ...rest } = values;
      return rest;
    };

    interface Case {
      name: string;
      before: Values;
      inWindow: Values;
      /** Who swaps 100000 of base into the pool at the first ledger of the day. */
      taker: string;
      /** What the day has to say, whole-history or windowed alike. */
      expected: Partial<StoredDaily>;
    }
    const CASES: Case[] = [
      {
        name: 'reserve_base',
        before: OLD,
        inWindow: minus(NEW, 'reserve_base'),
        taker: STRANGER,
        expected: { reserve_base: '1', reserve_counter: '20', fees_base_est: '222' },
      },
      {
        name: 'reserve_counter',
        before: OLD,
        inWindow: minus(NEW, 'reserve_counter'),
        taker: STRANGER,
        expected: { reserve_base: '10', reserve_counter: '2', fees_base_est: '222' },
      },
      {
        name: 'lp_supply',
        before: OLD,
        inWindow: minus(NEW, 'lp_supply'),
        taker: STRANGER,
        expected: { lp_supply: '3', trading_fee: 222, fees_base_est: '222' },
      },
      {
        name: 'trading_fee',
        before: OLD,
        inWindow: minus(NEW, 'trading_fee'),
        taker: STRANGER,
        expected: { trading_fee: 111, fees_base_est: '111' },
      },
      // the slot values only matter to a swap of the holder: the holder of the old slot swaps
      {
        name: 'auction_holder',
        before: OLD,
        inWindow: { ...minus(NEW, 'auction_holder'), auction_discounted_fee: 40 },
        taker: SLOT_HOLDER,
        expected: { fees_base_est: '40' },
      },
      {
        name: 'auction_discounted_fee',
        before: OLD,
        inWindow: { ...minus(NEW, 'auction_discounted_fee'), auction_holder: SLOT_HOLDER },
        taker: SLOT_HOLDER,
        expected: { fees_base_est: '40' },
      },
      // a slot that ran out before the day: the rows of the window do not say so, the old row does
      {
        name: 'auction_expiration',
        before: { ...OLD, auction_expiration: PAST },
        inWindow: { ...minus(NEW, 'auction_expiration'), auction_holder: SLOT_HOLDER, auction_discounted_fee: 40 },
        taker: SLOT_HOLDER,
        expected: { fees_base_est: '222' },
      },
    ];
    const FRESH = pool('rWindowFresh', USD, XRP); // every value in the window
    const CREATED = pool('rWindowCreatedToday', USD, XRP); // no row before the day
    // old AMM-node rows (before the window) and one in the day; the fee at the start of the day is only needed by the swapper
    const LIQUIDITY_ONLY = pool('rWindowLiquidityOnly', USD, XRP);
    const SWAPPER = pool('rWindowSwapper', USD, XRP);
    // no swap, a row in the window with the LP supply and the reserves but not the fee, which only an old row has
    const FEELESS = pool('rWindowFeeless', USD, XRP);

    let ch: ClickHouseService;
    const pools = CASES.map((c) => pool(`rWindow_${c.name}`, USD, XRP));
    let windowed: Map<string, StoredDaily>;
    let whole: Map<string, StoredDaily>;
    let reads: Array<{ accounts: string[]; fill_from: number; fill_up_to: number }>;
    let written: string[];

    beforeAll(async () => {
      ch = await fresh();
      const states: AmmPoolStatesRow[] = [];
      const swaps: ExchangesRow[] = [];
      const add = (p: PoolDef, node: number, before: Values | undefined, inWindow: Values, taker: string): void => {
        if (before) states.push(state(p, 900, node, before));
        if (Object.keys(inWindow).length > 0) states.push(state(p, 970, node, inWindow));
        states.push(state(p, 1000, node, {})); // the swap touches the pool, and says nothing about its state
        swaps.push(swap(p, 1000, node, { taker, in: 'base', base: '100000', counter: '1', node }));
      };
      CASES.forEach((c, i) => add(pools[i], i + 1, c.before, c.inWindow, c.taker));
      add(FRESH, 20, OLD, NEW, STRANGER);
      add(CREATED, 21, undefined, {}, STRANGER);
      // the fee state at the start of the day is in the old row only, the closing state in the row of the day (which comes
      // after the swap, so the swap is charged at the old fee)
      for (const [p, node] of [
        [LIQUIDITY_ONLY, 30],
        [SWAPPER, 31],
      ] as const) {
        states.push(state(p, 900, node, OLD), state(p, 1000, node + 100, NEW));
      }
      swaps.push(swap(SWAPPER, 1000, 1, { taker: STRANGER, in: 'base', base: '100000', counter: '1', node: 31 }));
      states.push(
        state(FEELESS, 900, 40, OLD),
        state(FEELESS, 970, 40, minus(NEW, 'trading_fee')),
        state(FEELESS, 1000, 40, {}),
      );
      await insertStates(ch, states);
      await ch.insert(Table.Exchanges, swaps);
      await commit(
        ch,
        LEDGER_CLOSES.map(([l]) => l),
      );

      const query = jest.spyOn(ch, 'query');
      const insert = jest.spyOn(ch, 'insert');
      await computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: WINDOW });
      written = (insert.mock.calls[0][1] as Array<{ amm_account: string }>).map((r) => r.amm_account);
      reads = query.mock.calls
        .filter(([sql]) => String(sql) === AMM_DAILY_STATES_SQL)
        .map(([, params]) => params as (typeof reads)[number]);
      windowed = (await dayOf(ch, D1_KEY)).pools;
      await computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: FULL });
      whole = (await dayOf(ch, D1_KEY)).pools;
    });

    it('is about seven days of ledgers, as for amm_pools', () => {
      expect(AMM_FILL_WINDOW_LEDGERS).toBe(160_000);
    });

    it('reads the window first for all the pools and then, in older steps, only the pools that need more (Ruling R-A23)', () => {
      const all = [...pools, FRESH, CREATED, LIQUIDITY_ONLY, SWAPPER, FEELESS].map((p) => p.account).sort();
      expect(reads[0]).toMatchObject({ accounts: all, fill_from: 1000 - WINDOW, fill_up_to: 1003 });
      const later = reads.slice(1);
      // the steps read ledgers older than the window, never the window again
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((r) => r.fill_up_to < 1000 - WINDOW)).toBe(true);
      const walked = new Set(later.flatMap((r) => r.accounts));
      // a pool with every value in the window is not read again, and nor is a pool with no swap that day, whose fee at the
      // start of the day nobody needs although the window does not hold it, or a pool with nothing before the window (its
      // first state ledger is in the day: Ruling R-A25)
      expect(walked.has(FRESH.account)).toBe(false);
      expect(walked.has(LIQUIDITY_ONLY.account)).toBe(false);
      expect(walked.has(CREATED.account)).toBe(false);
      for (const p of [...pools, SWAPPER]) expect([p.account, walked.has(p.account)]).toEqual([p.account, true]);
      // one walk for the closing state and the fee state at the start of the day together: no range is read twice
      const ranges = later.map((r) => `${r.fill_from}-${r.fill_up_to}`);
      expect(new Set(ranges).size).toBe(ranges.length);
    });

    it('writes the pools in the order of their account, those read whole among them', () => {
      expect(written).toEqual([
        '',
        ...[...pools, FRESH, CREATED, LIQUIDITY_ONLY, SWAPPER, FEELESS].map((p) => p.account).sort(),
      ]);
    });

    it('gives the day it gives when it reads the whole history, pool by pool, all fields but the version', () => {
      expect([...windowed.keys()]).toEqual([...whole.keys()]);
      for (const [account, row] of windowed)
        expect([account, withoutVersion(row)]).toEqual([account, withoutVersion(whole.get(account) as StoredDaily)]);
      expect(windowed.size).toBe(CASES.length + 5);
    });

    it.each(CASES.map((c, i) => [c.name, i] as const))(
      'a pool whose %s was last set before the window has that value (and the fee it made)',
      (_name, i) => {
        expect(windowed.get(pools[i].account)).toMatchObject({
          swap_count: 1,
          volume_base: '100000',
          ...CASES[i].expected,
        });
      },
    );

    it('a pool with everything in the window has the values of the window', () => {
      expect(windowed.get(FRESH.account)).toMatchObject({
        reserve_base: '10',
        lp_supply: '30',
        trading_fee: 222,
        fees_base_est: '222',
      });
    });

    it('a pool with a swap has the fee it had at the start of the day, from the old row; one without has its closing state', () => {
      expect(windowed.get(SWAPPER.account)).toMatchObject({
        swap_count: 1,
        fees_base_est: '111',
        trading_fee: 222,
        reserve_base: '10',
      });
      expect(windowed.get(LIQUIDITY_ONLY.account)).toMatchObject({
        swap_count: 0,
        fees_base_est: '0',
        trading_fee: 222,
        reserve_base: '10',
      });
    });

    it('a pool without swaps still has its closing fee from the old row when the window does not hold it', () => {
      expect(windowed.get(FEELESS.account)).toMatchObject({
        swap_count: 0,
        trading_fee: 111,
        lp_supply: '30',
        reserve_base: '10',
      });
    });

    it('a pool created today has the values of the day only', () => {
      expect(windowed.get(CREATED.account)).toMatchObject({
        swap_count: 1,
        reserve_base: null,
        trading_fee: null,
        fees_base_est: '0',
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a chunk of 200 pools with values null for ever and a first state ledger near the head (Ruling R-A25)', () => {
    // a database ingested from a recent ledger: every pool is first seen without its AMM node, so its LP supply, its fee and
    // its slot are null in its whole history, which starts 1,200 ledgers before the day; half of the pools swap that day
    const BIG = 99_000_000;
    const FIRST = BIG - 1200;
    const WINDOW = 1000;
    const crowd = Array.from({ length: AMM_DAILY_CHUNK }, (_, i) =>
      pool(`rNullForever${String(i).padStart(4, '0')}`, USD, XRP),
    );
    let ch: ClickHouseService;
    /** The text of every query of the recompute, in order. */
    let sqls: string[];

    beforeAll(async () => {
      CLOSES.set(FIRST, D0 + 20 * HOUR);
      CLOSES.set(BIG, D1 + HOUR);
      CLOSES.set(BIG + 1, D2 + 2 * HOUR);
      ch = await fresh();
      await insertStates(
        ch,
        crowd.flatMap((p, i) => [
          state(p, FIRST, i, { reserve_base: '1', reserve_counter: '2' }),
          state(p, BIG, i, { reserve_base: '10', reserve_counter: '20' }),
        ]),
      );
      await ch.insert(
        Table.Exchanges,
        crowd
          .filter((_, i) => i % 2 === 0)
          .map((p, i) => swap(p, BIG, i * 2, { taker: TAKER_1, in: 'base', base: '100', counter: '1' })),
      );
      await commit(ch, [FIRST, BIG, BIG + 1]);
      const query = jest.spyOn(ch, 'query');
      expect(await computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: WINDOW })).toBe(AMM_DAILY_CHUNK);
      sqls = query.mock.calls.map(([sql]) => String(sql));
      query.mockRestore();
    });

    afterAll(() => {
      for (const ledger of [FIRST, BIG, BIG + 1]) CLOSES.delete(ledger);
    });

    it('reads the window, the first ledgers and one step: one walk for the closing state and the carry-in, not two to 0', () => {
      // the window and one step: the first ledgers are 200 ledgers before the window, less than half of the first span
      expect(sqls.filter((sql) => sql === AMM_DAILY_STATES_SQL)).toHaveLength(2);
      expect(
        sqls.filter((sql) => sql.includes('min(ledger_index) AS first_ledger') && !sql.includes('amm_pool_touches')),
      ).toHaveLength(1);
      // in all a constant handful: the head and its close, the first and last ledgers of the day (two), the touches, the window
      // and the liquidity, the swaps, the first ledgers, the step, the fee events and the bids (three), the version of the set;
      // the two walks of before (Ruling R-A23) made 33 reads of the states here, a window and two walks of 16 steps to ledger 0
      expect(sqls).toHaveLength(14);
    });

    it('and the day is the one of the whole history', async () => {
      const windowed = (await dayOf(ch, D1_KEY)).pools;
      await computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: Number.MAX_SAFE_INTEGER });
      const whole = (await dayOf(ch, D1_KEY)).pools;
      expect(windowed.size).toBe(AMM_DAILY_CHUNK);
      for (const [account, row] of windowed)
        expect([account, withoutVersion(row)]).toEqual([account, withoutVersion(whole.get(account) as StoredDaily)]);
      expect(windowed.get(crowd[0].account)).toMatchObject({
        swap_count: 1,
        reserve_base: '10',
        lp_supply: null,
        trading_fee: null,
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a pool with a long history (900,000 state rows in three parts) is read from its window (Ruling R-A21)', () => {
    const BASE = 1_000_000;
    const PART = 300_000;
    const BUSY = pool('rBusyHistory', USD, XRP);
    const DAY_FIRST = BASE + 3 * PART; // the first ledger of the day, just after the history
    const GRANULE = 8192;
    let ch: ClickHouseService;
    let db: string;

    beforeAll(async () => {
      ch = await fresh();
      db = ((await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db')) as { db: string }).db;
      await ch.command(`SYSTEM STOP MERGES ${Table.AmmPoolStates}`);
      CLOSES.set(1, D0);
      await ch.insert(Table.AmmPoolStates, [state(BUSY, 1, 0, { reserve_base: '1' })]);
      for (let part = 0; part < 3; part++) {
        // a row in every ledger with the reserves; one in a thousand is a transaction on the AMM node: the fee, the LP supply and the slot
        await ch.command(
          `INSERT INTO ${Table.AmmPoolStates}
           SELECT tpl.* REPLACE (
                    toUInt32({base:UInt32} + n.number) AS ledger_index,
                    toUInt32(0) AS tx_index,
                    toNullable('10') AS reserve_base,
                    toNullable('20') AS reserve_counter,
                    if(n.number % 1000 = 0, toNullable('30'), NULL) AS lp_supply,
                    if(n.number % 1000 = 0, toNullable(toUInt16(222)), NULL) AS trading_fee,
                    if(n.number % 1000 = 0, toNullable('rSomeHolder'), NULL) AS auction_holder,
                    if(n.number % 1000 = 0, toNullable(toUInt16(22)), NULL) AS auction_discounted_fee,
                    if(n.number % 1000 = 0, toNullable(toUInt32(1)), NULL) AS auction_expiration
                  )
             FROM (SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {pool:String} AND ledger_index = 1) AS tpl
            CROSS JOIN numbers({rows:UInt32}) AS n`,
          { base: BASE + part * PART, pool: BUSY.account, rows: PART },
          { settings: { insert_deduplicate: 0 } },
        );
      }
      // the day: two ledgers, the pool touched in the first, and a ledger a day later that makes it final
      await ch.insert(Table.Ledgers, [
        ledgerRow(DAY_FIRST, D1 + HOUR),
        ledgerRow(DAY_FIRST + 1, D1 + 5 * HOUR),
        ledgerRow(DAY_FIRST + 100, D2 + 2 * HOUR),
      ]);
      CLOSES.set(DAY_FIRST, D1 + HOUR);
      await insertStates(ch, [state(BUSY, DAY_FIRST, 0, { reserve_base: '11' })]);
    });

    async function stateReads(run: () => Promise<unknown>): Promise<number[]> {
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log
          WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
            AND position(query, 'argMaxIf(reserve_base') > 0
          ORDER BY query_start_time_microseconds`,
        { db, t, table: `${db}.${Table.AmmPoolStates}` },
      );
      return rows.map((r) => Number(r.read_rows));
    }

    it('is three parts of 300,000 rows', async () => {
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {t:String} AND active ORDER BY rows DESC`,
        { t: Table.AmmPoolStates },
      );
      expect(parts.map((p) => Number(p.rows)).slice(0, 3)).toEqual([PART, PART, PART]);
    });

    it('reads about the window (160,000 rows) for the closing state and the carry-in, not the 900,000 rows of the pool', async () => {
      const windowed = await stateReads(() => computeAmmDaily(ch, rates(ch), at(D1)));
      expect(windowed).toHaveLength(1); // every value is in the window: no read of the whole history
      expect(windowed[0]).toBeGreaterThanOrEqual(AMM_FILL_WINDOW_LEDGERS);
      expect(windowed[0]).toBeLessThanOrEqual(AMM_FILL_WINDOW_LEDGERS + 4 * GRANULE);
      // the control: the read of the whole history, which is what the job did
      const whole = await stateReads(() =>
        computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: Number.MAX_SAFE_INTEGER }),
      );
      expect(whole[0]).toBeGreaterThanOrEqual(3 * PART);
      expect(whole[0]).toBeGreaterThan(4 * windowed[0]);
    });

    it('and the day is the same as the day from the whole history', async () => {
      await computeAmmDaily(ch, rates(ch), at(D1));
      const windowed = (await dayOf(ch, D1_KEY)).pools.get(BUSY.account) as StoredDaily;
      await computeAmmDaily(ch, rates(ch), at(D1), { fillWindow: Number.MAX_SAFE_INTEGER });
      const whole = (await dayOf(ch, D1_KEY)).pools.get(BUSY.account) as StoredDaily;
      expect(withoutVersion(windowed)).toEqual(withoutVersion(whole));
      expect(windowed).toMatchObject({ reserve_base: '11', reserve_counter: '20', lp_supply: '30', trading_fee: 222 });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('days without anything', () => {
    it('a database without ledgers: a sentinel of the day, not final, and no pool', async () => {
      const ch = await fresh();
      expect(await computeAmmDaily(ch, rates(ch), at(D1))).toBe(0);
      const { sentinel, pools } = await dayOf(ch, D1_KEY);
      expect(pools.size).toBe(0);
      expect(sentinel.final).toBe(0);
    });

    it('a day without ledgers that the ingest has passed: a final sentinel only', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const gap = utcDay(D0 - DAY);
      expect(await computeAmmDaily(ch, rates(ch), at(D0 - DAY))).toBe(0);
      const { sentinel, pools } = await dayOf(ch, gap);
      expect(pools.size).toBe(0);
      expect(sentinel.final).toBe(1);
    });

    it('a day with ledgers but no pool touched: a final sentinel only', async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, [ledgerRow(5, D1 + HOUR), ledgerRow(6, D2 + 2 * HOUR)]);
      expect(await computeAmmDaily(ch, rates(ch), at(D1))).toBe(0);
      expect((await dayOf(ch, D1_KEY)).sentinel.final).toBe(1);
    });

    it('rejects an invalid date', async () => {
      const ch = await fresh();
      await expect(computeAmmDaily(ch, rates(ch), new Date('nonsense'))).rejects.toThrow(RangeError);
    });

    it('any instant of the day is the day', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      await computeAmmDaily(ch, rates(ch), at(D1 + 23 * HOUR + 3599));
      expect((await dayOf(ch, D1_KEY)).pools.size).toBe(5);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the abort at shutdown', () => {
    it('a recompute that is aborted before it starts writes nothing', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const controller = new AbortController();
      controller.abort();
      await expect(computeAmmDaily(ch, rates(ch), at(D1), { signal: controller.signal })).rejects.toThrow(
        AmmDailyRecomputeAborted,
      );
      expect(await rowCount(ch)).toBe(0);
    });

    it('and reads nothing either: an aborted signal is checked before the first query', async () => {
      const ch = await fresh();
      const controller = new AbortController();
      controller.abort();
      const query = jest.spyOn(ch, 'query');
      const insert = jest.spyOn(ch, 'insert');
      await expect(computeAmmDaily(ch, rates(ch), at(D1), { signal: controller.signal })).rejects.toThrow(
        AmmDailyRecomputeAborted,
      );
      expect(query).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('one that is aborted while it works writes nothing either: the signal is checked just before the insert', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      const controller = new AbortController();
      class Aborting extends TestRates {
        override async dailyNativeRates(assets: Asset[], from: Date, to: Date) {
          controller.abort();
          return super.dailyNativeRates(assets, from, to);
        }
      }
      await expect(
        computeAmmDaily(ch, new Aborting(ch, { [assetKey(EUR)]: 4 }), at(D1), { signal: controller.signal }),
      ).rejects.toThrow(AmmDailyRecomputeAborted);
      expect(await rowCount(ch)).toBe(0);
      expect(new AmmDailyRecomputeAborted().name).toBe('AmmDailyRecomputeAborted');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the first day with pool activity (where the back-fill starts)', () => {
    it('is none for a database without a touch', async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, [ledgerRow(5, D1)]);
      expect(await ammFirstDay(ch)).toBeUndefined();
    });

    it('is the close time of the ledger of the oldest touch', async () => {
      const ch = await fresh();
      await seedHandMade(ch);
      expect(await ammFirstDay(ch)).toBe(CLOSES.get(900));
    });

    it('is none while the ledger of the oldest touch is not committed', async () => {
      const ch = await fresh();
      await insertStates(ch, [state(P, 900, 0, { reserve_base: '1' })]);
      expect(await ammFirstDay(ch)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('no read crosses the pairs or the pools (Rulings R-A3 and R-A14), on tables of several parts', () => {
    const PAIRS = 5;
    const PER_PAIR = 60_000;
    const LEDGERS = 4;
    const GRANULE = 8192;
    let ch: ClickHouseService;
    let db: string;

    beforeAll(async () => {
      ch = await fresh();
      db = ((await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db')) as { db: string }).db;
      await seedHandMade(ch);
      for (const table of [Table.Exchanges, Table.AmmPoolStates, Table.AmmPoolTouches, Table.AmmLiquidity]) {
        await ch.command(`SYSTEM STOP MERGES ${table}`);
      }
      // other pairs: a part each, in the ledgers of the day under test (1000..1003), pools of their own
      for (let pair = 0; pair < PAIRS; pair++) {
        await ch.command(
          `INSERT INTO ${Table.Exchanges}
           SELECT tpl.* REPLACE (
                    concat('B', toString({pair:UInt32})) AS base_currency,
                    toUInt32(1000 + n.number % ${LEDGERS}) AS ledger_index,
                    toUInt32(intDiv(n.number, ${LEDGERS}) + 100) AS tx_index,
                    concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account,
                    toDateTime(${D1} + 3600) AS close_time
                  )
             FROM (SELECT * FROM ${Table.Exchanges} WHERE amm_account = {pool:String} LIMIT 1) AS tpl
            CROSS JOIN numbers({rows:UInt32}) AS n`,
          { pair, pool: P.account, rows: PER_PAIR },
          { settings: { insert_deduplicate: 0 } },
        );
      }
      // other pools: states, touches (far from the day) and liquidity
      await ch.command(
        `INSERT INTO ${Table.AmmPoolStates}
         SELECT tpl.* REPLACE (
                  concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account,
                  toUInt32(2000 + intDiv(n.number, 100)) AS ledger_index
                )
           FROM (SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {pool:String} AND ledger_index = 1000 LIMIT 1) AS tpl
          CROSS JOIN numbers({rows:UInt32}) AS n`,
        { pool: P.account, rows: 200_000 },
        { settings: { insert_deduplicate: 0 } },
      );
      await ch.command(
        `INSERT INTO ${Table.AmmPoolTouches}
         SELECT toUInt32(2000 + intDiv(n.number, 100)) AS ledger_index, toUInt32(n.number % 100) AS tx_index,
                concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account
           FROM numbers({rows:UInt32}) AS n`,
        { rows: 200_000 },
        { settings: { insert_deduplicate: 0 } },
      );
    });

    interface Read {
      query: string;
      read_rows: number;
    }

    /** Bids and votes of other pools in amm_governance (two parts, merges stopped): the reads of the bids of a pool must not read them. */
    const BULK_GOVERNANCE = 200_000;
    beforeAll(async () => {
      await ch.command(`SYSTEM STOP MERGES ${Table.AmmGovernance}`);
      for (let part = 0; part < 2; part++) {
        await ch.command(
          `INSERT INTO ${Table.AmmGovernance}
           SELECT tpl.* REPLACE (
                    concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account,
                    toUInt32(2000 + {part:UInt32} * 5000 + intDiv(n.number, 100)) AS ledger_index,
                    toUInt32(n.number % 100) AS tx_index
                  )
             FROM (SELECT * FROM ${Table.AmmGovernance} WHERE amm_account = {pool:String} LIMIT 1) AS tpl
            CROSS JOIN numbers({rows:UInt32}) AS n`,
          { part, pool: P2.account, rows: BULK_GOVERNANCE / 2 },
          { settings: { insert_deduplicate: 0 } },
        );
      }
    });

    /** A month of other pools' days in amm_daily (two parts, merges stopped): the reads of the sentinels must not read them. */
    const BULK_DAILY = 120_000;
    beforeAll(async () => {
      await ch.command(`SYSTEM STOP MERGES ${Table.AmmDaily}`);
      for (let part = 0; part < 2; part++) {
        await ch.command(
          `INSERT INTO ${Table.AmmDaily}
           SELECT concat('rBulk', leftPad(toString(n.number % 2000), 4, '0')) AS amm_account,
                  toDate('2026-03-01') + toUInt32(intDiv(n.number, 2000) % 28) AS day,
                  'USD' AS base_currency, '${ISSUER_A}' AS base_issuer, 'XRP' AS counter_currency, '' AS counter_issuer,
                  toUInt64(1) AS swap_count, '1' AS volume_base, '1' AS volume_counter, '0' AS fees_base_est,
                  '0' AS fees_counter_est, toUInt64(0) AS deposit_count, toUInt64(0) AS withdraw_count,
                  '0' AS liquidity_in_base, '0' AS liquidity_in_counter, '0' AS liquidity_out_base,
                  '0' AS liquidity_out_counter, CAST(NULL AS Nullable(String)) AS reserve_base,
                  CAST(NULL AS Nullable(String)) AS reserve_counter, CAST(NULL AS Nullable(String)) AS lp_supply,
                  CAST(NULL AS Nullable(UInt16)) AS trading_fee, CAST(NULL AS Nullable(Float64)) AS value_native,
                  toUInt8(0) AS final, toUInt32(1) AS config_version, toUInt64(1 + {part:UInt32}) AS version
             FROM numbers({rows:UInt32}) AS n`,
          { part, rows: BULK_DAILY / 2 },
          { settings: { insert_deduplicate: 0 } },
        );
      }
    });

    /** What `system.query_log` says the SELECTs on a table read while `run` ran. */
    async function readsOf(table: Table, run: () => Promise<unknown>): Promise<Read[]> {
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ query: string; read_rows: string }>(
        `SELECT query, read_rows FROM system.query_log
          WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
          ORDER BY query_start_time_microseconds`,
        { db, t, table: `${db}.${table}` },
      );
      return rows.map((x) => ({ query: x.query, read_rows: Number(x.read_rows) }));
    }

    const totalRows = async (table: Table): Promise<number> =>
      Number((await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${table}`))?.n);

    const explain = async (sql: string, params: Record<string, unknown>): Promise<string[]> =>
      (await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params)).map((x) => x.explain.trim());

    /** The `Granules: a/b` of the stage that starts at the line `at`. */
    function granules(lines: string[], at: number): [number, number] {
      const line = lines.slice(at).find((l) => l.startsWith('Granules:')) as string;
      const [a, b] = line.slice('Granules:'.length).trim().split('/');
      return [Number(a), Number(b)];
    }

    const swapParams = (): Record<string, unknown> => ({
      accounts: [P.account],
      base_currencies: [P.base.currency],
      base_issuers: [P.base.issuer],
      counter_currencies: [P.counter.currency],
      counter_issuers: [P.counter.issuer],
      first: 1000,
      last: 1003,
    });

    it('the exchanges are several parts of other pairs with the swaps of the day among them', async () => {
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {t:String} AND active`,
        { t: Table.Exchanges },
      );
      expect(parts.length).toBeGreaterThanOrEqual(PAIRS + 1);
      expect(await totalRows(Table.Exchanges)).toBeGreaterThan(PAIRS * PER_PAIR);
    });

    it('EXPLAIN: the swaps are read through the pair key and the ledger range, a few granules of the table', async () => {
      const lines = await explain(AMM_DAILY_SWAPS_SQL, swapParams());
      const key = lines.indexOf('PrimaryKey');
      expect(key).toBeGreaterThan(-1);
      const condition = lines.slice(key).find((l) => l.startsWith('Condition:')) as string;
      for (const column of ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer', 'ledger_index']) {
        expect(condition).toContain(column);
      }
      const [selected, total] = granules(lines, key);
      expect(total).toBeGreaterThan(30);
      expect(selected).toBeLessThanOrEqual(4);
    });

    it('EXPLAIN: the set index on amm_account is there to skip the granules of other pools of the pair', async () => {
      const lines = await explain(AMM_DAILY_SWAPS_SQL, swapParams());
      expect(lines).toContain('Name: amm_account_set');
    });

    it('read_rows: the swaps of a pool cost the granules of its own pair, not the table', async () => {
      const reads = await readsOf(Table.Exchanges, () => computeAmmDaily(ch, rates(ch), at(D1)));
      expect(reads).toHaveLength(1);
      const total = await totalRows(Table.Exchanges);
      expect(total).toBeGreaterThan(300_000);
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
      // and the control: the same read without the pair, over the ledger range alone, reads the other pairs
      const control = await readsOf(Table.Exchanges, () =>
        ch.query(
          `SELECT max(length(tx_hash)) FROM ${Table.Exchanges} WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}`,
          swapParams(),
        ),
      );
      expect(control[0].read_rows).toBeGreaterThan(PAIRS * PER_PAIR);
    });

    it('read_rows: without the skip index the pair key alone still bounds the read to the pair, never the other pairs', async () => {
      const reads = await readsOf(Table.Exchanges, () =>
        ch.query(AMM_DAILY_SWAPS_SQL, swapParams(), { use_skip_indexes: 0 }),
      );
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the active pools come from a range of the ledger-ordered touches, not the table', async () => {
      const explained = await explain(AMM_DAILY_TOUCHES_SQL, { first: 1000, last: 1003 });
      const key = explained.indexOf('PrimaryKey');
      expect(key).toBeGreaterThan(-1);
      expect(explained.slice(key).find((l) => l.startsWith('Condition:'))).toContain('ledger_index');

      const reads = await readsOf(Table.AmmPoolTouches, () => computeAmmDaily(ch, rates(ch), at(D1)));
      expect(reads).toHaveLength(1);
      expect(await totalRows(Table.AmmPoolTouches)).toBeGreaterThan(200_000);
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the closing state of a pool is its own rows, not the 200,000 rows of other pools', async () => {
      const reads = await readsOf(Table.AmmPoolStates, () => computeAmmDaily(ch, rates(ch), at(D1)));
      const total = await totalRows(Table.AmmPoolStates);
      expect(total).toBeGreaterThan(200_000);
      // the closing read, the events of the pools with swaps: every read is a few granules
      expect(reads.length).toBeGreaterThanOrEqual(2);
      for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the liquidity of the day is read through the pool key and the ledger range', async () => {
      const reads = await readsOf(Table.AmmLiquidity, () => computeAmmDaily(ch, rates(ch), at(D1)));
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the bids before the day and in it are read through the key of the pools with swaps, not the 200,000 bids of others', async () => {
      expect(await totalRows(Table.AmmGovernance)).toBeGreaterThanOrEqual(BULK_GOVERNANCE);
      const reads = await readsOf(Table.AmmGovernance, () => computeAmmDaily(ch, rates(ch), at(D1)));
      // the bid before the day (BID_CARRY_SQL) and the bids of the day (BIDS_SQL): P, P2 and DEL have swaps
      expect(reads).toHaveLength(2);
      for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the version of the day, and the days that are done, are read from the sentinels (a prefix of the key), not the month', async () => {
      expect(await totalRows(Table.AmmDaily)).toBeGreaterThan(100_000);
      const days = Array.from({ length: 28 }, (_, i) => at(Date.parse('2026-03-01T00:00:00Z') / SEC + i * DAY));
      const reads = await readsOf(Table.AmmDaily, async () => {
        await computeAmmDaily(ch, rates(ch), at(D1));
        await ammDaysDone(ch, AMM_DAILY_CONFIG_VERSION, days);
        await ammDailyVersions(ch, days[0], days[27]);
      });
      // the version of the day, the days done, the versions of the days: three reads, a few granules each
      expect(reads.map((r) => r.query.trim().split(/\s+/)[0])).toEqual(['SELECT', 'SELECT', 'SELECT']);
      expect(reads).toHaveLength(3);
      for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('still gives the right pool: the other pairs add nothing to its day', async () => {
      await computeAmmDaily(ch, rates(ch, { [assetKey(EUR)]: 4 }), at(D1));
      const row = (await dayOf(ch, D1_KEY)).pools.get(P.account) as StoredDaily;
      expect(row).toMatchObject({ swap_count: 6, volume_base: '1120', volume_counter: '2110' });
    });
  });
});

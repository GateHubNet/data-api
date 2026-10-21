import { RIPPLE_EPOCH_MS } from '../util/time';
import {
  AMM_DAILY_CHUNK,
  AMM_DAILY_CONFIG_VERSION,
  DayLiquidity,
  DaySwap,
  FeeEvent,
  FeeState,
  liquidityTotals,
  swapTotals,
} from './amm-daily.job';
import { VOLUME_DAY_SETTLE_MS } from './volume.job';

/**
 * The arithmetic of `amm_daily` that needs no database: the volume and the estimated fees of the swaps of a day, with the fee
 * that was in force at each swap, and the counts and flows of the liquidity events. The SQL around it (which pools, which rows,
 * the version sets) is in `test/amm-daily-job.e2e-spec.ts`.
 */

const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;
const POOL = 'rPool0000000000000000000000000A';
const HOLDER = 'rHolder00000000000000000000000A';
const FRIEND = 'rFriend00000000000000000000000A';
const OTHER = 'rOther000000000000000000000000A';

/** The unix time of ripple second `n`. */
const closeAt = (rippleSeconds: number): number => RIPPLE_EPOCH_S + rippleSeconds;
/** A slot that runs until ripple second 1000. */
const EXPIRES = 1000;

let n = 0;
/** A swap in which the pool received `base` (buyer is the pool) or `counter` (the seller is the pool). */
function swap(over: Partial<DaySwap> & { in: 'base' | 'counter' }): DaySwap {
  const { in: side, ...rest } = over;
  return {
    ledger_index: 100,
    tx_index: ++n,
    closed: closeAt(500),
    taker: OTHER,
    buyer: side === 'base' ? POOL : OTHER,
    base_amount: '1',
    counter_amount: '1',
    ...rest,
  };
}

const NO_FEE: FeeState = {
  trading_fee: null,
  auction_holder: null,
  auction_discounted_fee: null,
  auction_expiration: null,
  auth_holder: null,
  auth_accounts: [],
};
const feeOf = (trading_fee: number | null, over: Partial<FeeState> = {}): FeeState => ({
  ...NO_FEE,
  trading_fee,
  ...over,
});

/** A slot held by HOLDER at discount 20, authorising FRIEND, in force until `EXPIRES`. */
const SLOT: Partial<FeeState> = {
  auction_holder: HOLDER,
  auction_discounted_fee: 20,
  auction_expiration: EXPIRES,
  auth_holder: HOLDER,
  auth_accounts: [FRIEND],
};

describe('the constants of the job', () => {
  it('has a config version of 1 and chunks of 200 pools', () => {
    expect(AMM_DAILY_CONFIG_VERSION).toBe(1);
    expect(AMM_DAILY_CHUNK).toBe(200);
  });

  it('shares the settle time of the volume sets: a day is final an hour after it ends', () => {
    expect(VOLUME_DAY_SETTLE_MS).toBe(3_600_000);
  });
});

describe('swapTotals', () => {
  describe('the volume: the amounts that went into the pool, by side', () => {
    it('counts the base amount when the pool bought base, and the counter amount when it sold base', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '10', counter_amount: '5' }), // the pool took 10 base, gave 5 counter
          swap({ in: 'base', base_amount: '2.5', counter_amount: '1' }),
          swap({ in: 'counter', base_amount: '7', counter_amount: '3.25' }), // the pool took 3.25 counter, gave 7 base
        ],
        NO_FEE,
        [],
      );
      expect(totals).toMatchObject({ count: 3, volume_base: '12.5', volume_counter: '3.25' });
    });

    it('is the sum of the inputs and nothing of the outputs', () => {
      const only = swapTotals(POOL, [swap({ in: 'counter', base_amount: '1000', counter_amount: '1' })], NO_FEE, []);
      expect(only).toMatchObject({ count: 1, volume_base: '0', volume_counter: '1' });
    });

    it('adds exactly, however many decimals the amounts have', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '0.1' }),
          swap({ in: 'base', base_amount: '0.2' }),
          swap({ in: 'base', base_amount: '1234567.123456789012345' }),
        ],
        NO_FEE,
        [],
      );
      expect(totals.volume_base).toBe('1234567.423456789012345');
    });

    it('is zero for a day without swaps', () => {
      expect(swapTotals(POOL, [], feeOf(300), [])).toEqual({
        count: 0,
        volume_base: '0',
        volume_counter: '0',
        fees_base_est: '0',
        fees_counter_est: '0',
      });
    });

    it('takes the pool of the call as the pool: a swap whose buyer is another account is counter in', () => {
      const totals = swapTotals(
        'rSomebodyElse',
        [swap({ in: 'base', base_amount: '4', counter_amount: '9' })],
        NO_FEE,
        [],
      );
      expect(totals).toMatchObject({ volume_base: '0', volume_counter: '9' });
    });
  });

  describe('the estimated fees: the input times the fee over 100000', () => {
    it('charges the side that went in, in its own currency', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '1000', counter_amount: '1' }),
          swap({ in: 'counter', base_amount: '5', counter_amount: '200' }),
        ],
        feeOf(300),
        [],
      );
      expect(totals).toMatchObject({ fees_base_est: '3', fees_counter_est: '0.6' }); // 1000 x 300 / 100000, 200 x 300 / 100000
    });

    it('is exact: no rounding to 20 decimals', () => {
      const totals = swapTotals(POOL, [swap({ in: 'base', base_amount: '0.123456789012345678' })], feeOf(205), []);
      // 0.123456789012345678 x 205 / 100000 has 22 decimals: a division at BigNumber's default 20 would cut it
      expect(totals.fees_base_est).toBe('0.0002530864174753086399');
    });

    it('adds the fees of the swaps one by one', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100' }), swap({ in: 'base', base_amount: '300' })],
        feeOf(250),
        [],
      );
      expect(totals.fees_base_est).toBe('1'); // 400 x 250 / 100000
    });

    it('a swap with no known fee has a volume and leaves the fee of its side unknown (the pool was first seen without its AMM node)', () => {
      // Ruling R-A26: null, not 0; the other side has no swap and its fee of 0 is known
      const totals = swapTotals(POOL, [swap({ in: 'base', base_amount: '50' })], NO_FEE, []);
      expect(totals).toEqual({
        count: 1,
        volume_base: '50',
        volume_counter: '0',
        fees_base_est: null,
        fees_counter_est: '0',
      });
    });

    it('one side unknown and the other known: a side is unknown when any swap into it had no known fee', () => {
      const at = (tx: number): Pick<DaySwap, 'ledger_index' | 'tx_index'> => ({ ledger_index: 100, tx_index: tx });
      const totals = swapTotals(
        POOL,
        [
          // base in before the fee is first seen, base in after it: the base side is unknown however much is known
          swap({ in: 'base', base_amount: '1000', ...at(1) }),
          swap({ in: 'base', base_amount: '1000', ...at(9) }),
          // counter in after it: known
          swap({ in: 'counter', counter_amount: '200', ...at(10) }),
        ],
        NO_FEE,
        [{ ledger_index: 100, tx_index: 5, trading_fee: 300 }],
      );
      expect(totals).toEqual({
        count: 3,
        volume_base: '2000',
        volume_counter: '200',
        fees_base_est: null,
        fees_counter_est: '0.6', // 200 x 300 / 100000
      });
    });

    it('a fee of 0 charges nothing', () => {
      expect(swapTotals(POOL, [swap({ in: 'base', base_amount: '50' })], feeOf(0), []).fees_base_est).toBe('0');
    });
  });

  describe('the fee in force at each swap: the newest value of the rows up to the swap, filled forward', () => {
    const at = (ledger: number, tx: number): Pick<DaySwap, 'ledger_index' | 'tx_index'> => ({
      ledger_index: ledger,
      tx_index: tx,
    });

    it('starts from the fee the day was carried in with', () => {
      const totals = swapTotals(POOL, [swap({ in: 'base', base_amount: '1000', ...at(100, 1) })], feeOf(100), []);
      expect(totals.fees_base_est).toBe('1');
    });

    it('a row changes the fee for the swaps after it, not before it', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '1000', ...at(100, 1) }),
          swap({ in: 'base', base_amount: '1000', ...at(100, 5) }),
          swap({ in: 'base', base_amount: '1000', ...at(101, 0) }),
        ],
        feeOf(100),
        [{ ledger_index: 100, tx_index: 3, trading_fee: 500 }],
      );
      expect(totals.fees_base_est).toBe('11'); // 1000 x (100 + 500 + 500) / 100000
    });

    it('the row of the swap itself (same ledger and transaction) counts: a transaction has one row per pool', () => {
      const totals = swapTotals(POOL, [swap({ in: 'base', base_amount: '1000', ...at(100, 5) })], feeOf(100), [
        { ledger_index: 100, tx_index: 5, trading_fee: 400 },
      ]);
      expect(totals.fees_base_est).toBe('4');
    });

    it('tells the order by ledger first, then by transaction (not by the position in the list)', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '1000', ...at(100, 9) }),
          swap({ in: 'base', base_amount: '1000', ...at(99, 50) }),
        ],
        feeOf(100),
        [{ ledger_index: 100, tx_index: 2, trading_fee: 700 }],
      );
      // the swap in ledger 99 is before the row in ledger 100 whatever its transaction index; the one in 100/9 is after
      expect(totals.fees_base_est).toBe('8'); // 1000 x (100 + 700) / 100000
    });

    it('rows that come out of order, and swaps out of order, give the same answer', () => {
      const swaps = [
        swap({ in: 'base', base_amount: '1000', ...at(100, 1) }),
        swap({ in: 'counter', counter_amount: '2000', ...at(100, 8) }),
        swap({ in: 'base', base_amount: '3000', ...at(101, 2) }),
      ];
      const events: FeeEvent[] = [
        { ledger_index: 100, tx_index: 4, trading_fee: 200 },
        { ledger_index: 101, tx_index: 0, trading_fee: 300 },
      ];
      const forward = swapTotals(POOL, swaps, feeOf(100), events);
      const reversed = swapTotals(POOL, [...swaps].reverse(), feeOf(100), [...events].reverse());
      expect(reversed).toEqual(forward);
      expect(forward).toMatchObject({ fees_base_est: '10', fees_counter_est: '4' }); // 1000 x 100 + 3000 x 300; 2000 x 200
    });

    it('a row with a null fee leaves the fee as it was', () => {
      const totals = swapTotals(POOL, [swap({ in: 'base', base_amount: '1000', ...at(100, 9) })], feeOf(100), [
        { ledger_index: 100, tx_index: 3, trading_fee: null, auction_holder: HOLDER },
      ]);
      expect(totals.fees_base_est).toBe('1');
    });

    it('a fee that is first seen during the day applies from its row on, and the swaps before it have none', () => {
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '1000', ...at(100, 9) }),
          swap({ in: 'counter', counter_amount: '1000', ...at(100, 1) }),
        ],
        NO_FEE,
        [{ ledger_index: 100, tx_index: 5, trading_fee: 1000 }],
      );
      // the base swap is after the row: 1000 x 1000 / 100000; the counter swap before it has no known fee (Ruling R-A26)
      expect(totals).toMatchObject({ volume_base: '1000', fees_base_est: '10', fees_counter_est: null });
    });
  });

  describe('the discounted fee of the auction slot', () => {
    it('is charged to the slot holder instead of the trading fee', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: HOLDER })],
        feeOf(500, SLOT),
        [],
      );
      expect(totals.fees_base_est).toBe('20'); // 100000 x 20 / 100000, not x 500
    });

    it('is charged to an account the holder authorised', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'counter', counter_amount: '100000', taker: FRIEND })],
        feeOf(500, SLOT),
        [],
      );
      expect(totals.fees_counter_est).toBe('20');
    });

    it('is not charged to anyone else', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: OTHER })],
        feeOf(500, SLOT),
        [],
      );
      expect(totals.fees_base_est).toBe('500');
    });

    it('is not charged once the slot has expired (the fee stays in the AMM object after the slot runs out)', () => {
      const late = closeAt(EXPIRES); // the slot is in force while the ledger closed before its expiration
      const early = closeAt(EXPIRES - 1);
      const totals = swapTotals(
        POOL,
        [
          swap({ in: 'base', base_amount: '100000', taker: HOLDER, closed: early }),
          swap({ in: 'base', base_amount: '100000', taker: HOLDER, closed: late }),
          swap({ in: 'base', base_amount: '100000', taker: FRIEND, closed: late + 5000 }),
        ],
        feeOf(500, SLOT),
        [],
      );
      expect(totals.fees_base_est).toBe('1020'); // 20 + 500 + 500
    });

    it('a slot with no known expiration is taken as in force', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: HOLDER, closed: closeAt(5_000_000) })],
        feeOf(500, { ...SLOT, auction_expiration: null }),
        [],
      );
      expect(totals.fees_base_est).toBe('20');
    });

    it('needs a discounted fee: a holder without one pays the trading fee', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: HOLDER })],
        feeOf(500, { ...SLOT, auction_discounted_fee: null }),
        [],
      );
      expect(totals.fees_base_est).toBe('500');
    });

    it('a discounted fee of 0 is a discount to nothing', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: HOLDER })],
        feeOf(500, { ...SLOT, auction_discounted_fee: 0 }),
        [],
      );
      expect(totals.fees_base_est).toBe('0');
    });

    it('without a trading fee the holder still pays the discounted one', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: HOLDER })],
        feeOf(null, SLOT),
        [],
      );
      expect(totals.fees_base_est).toBe('20');
    });

    it('authorised accounts without a holder are nobody: no slot, no discount', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: FRIEND })],
        feeOf(500, { ...SLOT, auction_holder: null, auth_holder: null }),
        [],
      );
      expect(totals.fees_base_est).toBe('500');
    });

    it('does not authorise the friends of an earlier holder: the accounts count for the bid they came with', () => {
      const totals = swapTotals(
        POOL,
        [swap({ in: 'base', base_amount: '100000', taker: FRIEND })],
        feeOf(500, { ...SLOT, auction_holder: OTHER, auth_holder: HOLDER }),
        [],
      );
      expect(totals.fees_base_est).toBe('500');
    });

    describe('as the day goes on', () => {
      const ledger = (l: number, t: number) => ({ ledger_index: l, tx_index: t });

      it('a bid hands the slot to a new holder with its own authorised accounts', () => {
        const totals = swapTotals(
          POOL,
          [
            swap({ in: 'base', base_amount: '100000', taker: HOLDER, ...ledger(100, 1) }),
            swap({ in: 'base', base_amount: '100000', taker: HOLDER, ...ledger(100, 20) }),
            swap({ in: 'base', base_amount: '200000', taker: OTHER, ...ledger(100, 21) }),
            swap({ in: 'base', base_amount: '100000', taker: FRIEND, ...ledger(100, 22) }),
          ],
          feeOf(500, SLOT),
          [
            // OTHER outbids HOLDER at 100/10 and authorises nobody; its slot has a discounted fee of 30
            {
              ledger_index: 100,
              tx_index: 10,
              auction_holder: OTHER,
              auction_discounted_fee: 30,
              auction_expiration: EXPIRES,
              bid: { holder: OTHER, auth_accounts: [] },
            },
          ],
        );
        // HOLDER at the old slot 20; HOLDER after the bid 500; OTHER 200000 x 30 / 100000 = 60; FRIEND (the old holder's) 500
        expect(totals.fees_base_est).toBe('1080');
      });

      it('a vote changes the discounted fee of the slot, the holder and the authorised accounts stay', () => {
        const totals = swapTotals(
          POOL,
          [swap({ in: 'base', base_amount: '100000', taker: FRIEND, ...ledger(100, 30) })],
          feeOf(500, SLOT),
          [{ ledger_index: 100, tx_index: 10, trading_fee: 1000, auction_discounted_fee: 100 }],
        );
        expect(totals.fees_base_est).toBe('100');
      });

      it('an expired slot is replaced by a new one: the new holder is discounted, the old one is not', () => {
        const totals = swapTotals(
          POOL,
          [
            swap({ in: 'base', base_amount: '100000', taker: HOLDER, closed: closeAt(2000), ...ledger(100, 30) }),
            swap({ in: 'base', base_amount: '100000', taker: OTHER, closed: closeAt(2000), ...ledger(100, 31) }),
          ],
          feeOf(500, SLOT), // expired at 1000
          [
            {
              ledger_index: 100,
              tx_index: 10,
              auction_holder: OTHER,
              auction_discounted_fee: 50,
              auction_expiration: 3000,
              bid: { holder: OTHER, auth_accounts: [] },
            },
          ],
        );
        expect(totals.fees_base_est).toBe('550'); // HOLDER 500, OTHER 50
      });
    });
  });
});

describe('the keys of what the arithmetic returns, in order', () => {
  it('swapTotals: count, the volumes, the fees', () => {
    expect(Object.keys(swapTotals(POOL, [], NO_FEE, []))).toEqual([
      'count',
      'volume_base',
      'volume_counter',
      'fees_base_est',
      'fees_counter_est',
    ]);
  });

  it('liquidityTotals: the counts, the flows in, the flows out', () => {
    expect(Object.keys(liquidityTotals([]))).toEqual([
      'deposit_count',
      'withdraw_count',
      'liquidity_in_base',
      'liquidity_in_counter',
      'liquidity_out_base',
      'liquidity_out_counter',
    ]);
  });
});

describe('liquidityTotals', () => {
  let tx = 0;
  const event = (kind: string, base: string, counter: string): DayLiquidity => ({
    event: kind,
    base_amount: base,
    counter_amount: counter,
    ledger_index: 10,
    tx_index: ++tx,
  });
  const zero = {
    deposit_count: 0,
    withdraw_count: 0,
    liquidity_in_base: '0',
    liquidity_in_counter: '0',
    liquidity_out_base: '0',
    liquidity_out_counter: '0',
  };

  it('is all zeros for a day without liquidity events', () => {
    expect(liquidityTotals([])).toEqual(zero);
  });

  it('counts deposits and the amounts they put in, by side', () => {
    expect(liquidityTotals([event('deposit', '10', '5'), event('deposit', '2.5', '0')])).toEqual({
      ...zero,
      deposit_count: 2,
      liquidity_in_base: '12.5',
      liquidity_in_counter: '5',
    });
  });

  it('counts withdrawals and the amounts they took out, as positive numbers', () => {
    expect(liquidityTotals([event('withdraw', '-4', '-0.5'), event('withdraw', '0', '-1.25')])).toEqual({
      ...zero,
      withdraw_count: 2,
      liquidity_out_base: '4',
      liquidity_out_counter: '1.75',
    });
  });

  it('counts a create as a deposit (the first deposit of the pool) and a clawback as a withdrawal (forced out)', () => {
    expect(liquidityTotals([event('create', '1000', '500'), event('clawback', '-10', '-5')])).toEqual({
      ...zero,
      deposit_count: 1,
      withdraw_count: 1,
      liquidity_in_base: '1000',
      liquidity_in_counter: '500',
      liquidity_out_base: '10',
      liquidity_out_counter: '5',
    });
  });

  it('a delete is neither: it counts nothing, and its amounts (none) change nothing', () => {
    expect(liquidityTotals([event('delete', '0', '0')])).toEqual(zero);
  });

  it('splits a row by the sign of each side: an amount in one side and out of the other is both', () => {
    expect(liquidityTotals([event('deposit', '3', '-2')])).toEqual({
      ...zero,
      deposit_count: 1,
      liquidity_in_base: '3',
      liquidity_out_counter: '2',
    });
  });

  it('adds exactly', () => {
    expect(liquidityTotals([event('deposit', '0.1', '0'), event('deposit', '0.2', '0')]).liquidity_in_base).toBe('0.3');
  });
});

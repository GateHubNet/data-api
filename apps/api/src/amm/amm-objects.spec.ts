import {
  computedRange,
  POOL_COLUMNS,
  POOL_DAY_COLUMNS,
  POOL_STATE_COLUMNS,
  StoredPool,
  StoredPoolDay,
  StoredPoolState,
  toPoolCsvRow,
  toPoolDayCsvRow,
  toPoolDayObject,
  toPoolObject,
  toPoolStateCsvRow,
  toPoolStateObject,
} from './amm-objects';

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const POOL = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const HOLDER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

/** The pool of `amm_pools`, as the API reads it. Frozen, as an input must not be changed. */
const STORED: StoredPool = Object.freeze({
  amm_account: POOL,
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  lp_currency: '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6',
  created_ledger: 93663334,
  created_by: HOLDER,
  last_ledger: 107713744,
  reserve_base: '14055257.09731275',
  reserve_counter: '178.019159',
  lp_supply: '49919.30511225182',
  trading_fee: 612,
  auction_holder: HOLDER,
  auction_price: '12.5',
  auction_discounted_fee: 61,
  auction_expiration: 814_000_000,
  deleted: 0,
  value_native: 28_110_514.1946255,
});

/** A pool that was first seen in the middle of its life, has no rate and no auction slot. */
const BARE: StoredPool = Object.freeze({
  amm_account: POOL,
  base_currency: 'EUR',
  base_issuer: ISSUER,
  counter_currency: 'USD',
  counter_issuer: HOLDER,
  lp_currency: null,
  created_ledger: null,
  created_by: null,
  last_ledger: '100132150',
  reserve_base: null,
  reserve_counter: null,
  lp_supply: null,
  trading_fee: null,
  auction_holder: null,
  auction_price: null,
  auction_discounted_fee: null,
  auction_expiration: null,
  deleted: 1,
  value_native: null,
});

describe('toPoolObject', () => {
  it('has its keys in the pinned order: identity, pair, reserves, LP token, fee, auction slot, value, creation, last ledger, deleted', () => {
    expect(Object.keys(toPoolObject(STORED))).toEqual([
      'amm_account',
      'base_currency',
      'counter_currency',
      'counter_issuer',
      'reserve_base',
      'reserve_counter',
      'lp_supply',
      'lp_currency',
      'trading_fee',
      'auction_slot',
      'value_native',
      'created_ledger',
      'created_by',
      'last_ledger',
      'deleted',
    ]);
    // the issuer of the native currency is not there, and the base issuer of an issued one is
    expect(Object.keys(toPoolObject({ ...STORED, base_currency: 'EUR', base_issuer: ISSUER }))).toContain(
      'base_issuer',
    );
  });

  it('pins the key order of the auction slot', () => {
    expect(Object.keys(toPoolObject(STORED).auction_slot as object)).toEqual([
      'holder',
      'price',
      'discounted_fee',
      'expiration',
    ]);
  });

  it('serves the pair flat, in the stored order, and no key for the issuer of the native currency', () => {
    const pool = toPoolObject(STORED);
    expect(pool).toMatchObject({ base_currency: 'XRP', counter_currency: 'USD', counter_issuer: ISSUER });
    expect(pool).not.toHaveProperty('base_issuer');
    // never nested asset objects
    expect(pool).not.toHaveProperty('base');
    expect(pool).not.toHaveProperty('counter');
    expect(pool).not.toHaveProperty('asset');
    const issued = toPoolObject(BARE);
    expect(issued).toMatchObject({
      base_currency: 'EUR',
      base_issuer: ISSUER,
      counter_currency: 'USD',
      counter_issuer: HOLDER,
    });
  });

  it('serves the amounts as the exact strings stored, the fee and the ledgers as numbers, the value to 8 digits', () => {
    expect(toPoolObject(STORED)).toEqual({
      amm_account: POOL,
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      reserve_base: '14055257.09731275',
      reserve_counter: '178.019159',
      lp_supply: '49919.30511225182',
      lp_currency: '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6',
      trading_fee: 612,
      auction_slot: {
        holder: HOLDER,
        price: '12.5',
        discounted_fee: 61,
        // ripple seconds: 814,000,000 s after 2000-01-01
        expiration: '2025-10-17T07:06:40Z',
      },
      value_native: '28110514',
      created_ledger: 93663334,
      created_by: HOLDER,
      last_ledger: 107713744,
      deleted: false,
    });
    expect(typeof toPoolObject(STORED).value_native).toBe('string');
  });

  it('the value is a plain decimal of eight significant digits, trailing zeros dropped', () => {
    const value = (v: number): string | undefined => toPoolObject({ ...STORED, value_native: v }).value_native;
    expect(value(0.004)).toBe('0.004');
    expect(value(12.5)).toBe('12.5');
    expect(value(42)).toBe('42');
    expect(value(123)).toBe('123');
    expect(value(28_110_514.1946255)).toBe('28110514');
    expect(value(0.1 + 0.2)).toBe('0.3');
    // zero is a value: it is served, and not mistaken for a missing one
    expect(value(0)).toBe('0');
  });

  it('never writes the exponent form: not from 1e8 up, not from 1e-7 down, and not when the rounding crosses 1e8', () => {
    const value = (v: number): string | undefined => toPoolObject({ ...STORED, value_native: v }).value_native;
    // eight significant digits, the rest of the integer part zeros
    expect(value(123_456_789.5)).toBe('123456790');
    expect(value(2.5e11)).toBe('250000000000');
    expect(value(1e21)).toBe('1000000000000000000000');
    // 99999999.5 rounds to 1.0000000e+8 in eight digits
    expect(value(99_999_999.5)).toBe('100000000');
    expect(value(99_999_999)).toBe('99999999');
    // small values: the zeros after the point, then eight digits
    expect(value(1e-7)).toBe('0.0000001');
    expect(value(3.2e-8)).toBe('0.000000032');
    expect(value(1.23456789e-7)).toBe('0.00000012345679');
    expect(value(0.00001234)).toBe('0.00001234');
    for (const v of [1e-9, 1e-7, 1e7, 1e8, 99_999_999.5, 123_456_789.5, 2.5e11, 1e21, 5e-324]) {
      expect([v, value(v)]).toEqual([v, expect.not.stringMatching(/e/i)]);
    }
  });

  it('leaves out what the pool does not have: no key is ever undefined or null', () => {
    const pool = toPoolObject(BARE);
    expect(pool).toEqual({
      amm_account: POOL,
      base_currency: 'EUR',
      base_issuer: ISSUER,
      counter_currency: 'USD',
      counter_issuer: HOLDER,
      last_ledger: 100132150,
      deleted: true,
    });
    for (const value of Object.values(pool)) expect(value).not.toBeUndefined();
    expect(Object.keys(pool)).not.toContain('auction_slot');
  });

  it('deleted is a boolean on every pool', () => {
    expect(toPoolObject(STORED).deleted).toBe(false);
    expect(toPoolObject(BARE).deleted).toBe(true);
    expect(toPoolObject({ ...STORED, deleted: '1' }).deleted).toBe(true);
    expect(toPoolObject({ ...STORED, deleted: '0' }).deleted).toBe(false);
  });

  it('a fee of 0, a reserve of "0" and an auction price of "0" are values, not missing ones', () => {
    const pool = toPoolObject({
      ...STORED,
      trading_fee: 0,
      reserve_base: '0',
      reserve_counter: '0',
      lp_supply: '0',
      auction_price: '0',
      auction_discounted_fee: 0,
      auction_expiration: 0,
    });
    expect(pool).toMatchObject({ trading_fee: 0, reserve_base: '0', reserve_counter: '0', lp_supply: '0' });
    expect(pool.auction_slot).toEqual({
      holder: HOLDER,
      price: '0',
      discounted_fee: 0,
      expiration: '2000-01-01T00:00:00Z',
    });
  });

  it('counts that arrive as text are numbers', () => {
    const pool = toPoolObject({
      ...STORED,
      created_ledger: '93663334',
      last_ledger: '107713744',
      trading_fee: '612',
      auction_discounted_fee: '61',
      auction_expiration: '814000000',
    });
    expect(pool).toMatchObject({ created_ledger: 93663334, last_ledger: 107713744, trading_fee: 612 });
    expect(pool.auction_slot).toMatchObject({ discounted_fee: 61, expiration: '2025-10-17T07:06:40Z' });
  });

  it('the slot has the keys it has: a slot without a price leaves the price out, no slot at all leaves the slot out', () => {
    const partial = toPoolObject({ ...STORED, auction_price: null, auction_discounted_fee: null });
    expect(partial.auction_slot).toEqual({ holder: HOLDER, expiration: '2025-10-17T07:06:40Z' });
    expect(toPoolObject({ ...STORED, auction_holder: null }).auction_slot).toEqual({
      price: '12.5',
      discounted_fee: 61,
      expiration: '2025-10-17T07:06:40Z',
    });
  });

  it('does not change its input and serves no stored column that is internal', () => {
    const wide = { ...STORED, version: 12345, reserve_base_f: 1 } as StoredPool;
    const served = toPoolObject(wide);
    expect(served).not.toHaveProperty('version');
    expect(served).not.toHaveProperty('reserve_base_f');
    expect(STORED.value_native).toBe(28_110_514.1946255);
  });
});

describe('POOL_COLUMNS', () => {
  it('reads the columns of amm_pools that the pool is made of, and not the version', () => {
    const columns = POOL_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
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
    ]);
  });
});

describe('toPoolCsvRow', () => {
  it('has every column of the pool, in the pinned order, whatever the pool has (page-stable columns)', () => {
    const columns = [
      'amm_account',
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'reserve_base',
      'reserve_counter',
      'lp_supply',
      'lp_currency',
      'trading_fee',
      'auction_slot',
      'value_native',
      'created_ledger',
      'created_by',
      'last_ledger',
      'deleted',
    ];
    expect(Object.keys(toPoolCsvRow(toPoolObject(STORED)))).toEqual(columns);
    expect(Object.keys(toPoolCsvRow(toPoolObject(BARE)))).toEqual(columns);
  });

  it('is null (an empty cell) where the pool has none, and the slot is always the same four columns', () => {
    const row = toPoolCsvRow(toPoolObject(BARE));
    expect(row).toEqual({
      amm_account: POOL,
      base_currency: 'EUR',
      base_issuer: ISSUER,
      counter_currency: 'USD',
      counter_issuer: HOLDER,
      reserve_base: null,
      reserve_counter: null,
      lp_supply: null,
      lp_currency: null,
      trading_fee: null,
      auction_slot: { holder: null, price: null, discounted_fee: null, expiration: null },
      value_native: null,
      created_ledger: null,
      created_by: null,
      last_ledger: 100132150,
      deleted: true,
    });
    expect(Object.keys(row.auction_slot)).toEqual(['holder', 'price', 'discounted_fee', 'expiration']);
    // the same columns when it has a slot
    expect(Object.keys(toPoolCsvRow(toPoolObject(STORED)).auction_slot)).toEqual([
      'holder',
      'price',
      'discounted_fee',
      'expiration',
    ]);
  });

  it('is the pool, where the pool has the values', () => {
    const pool = toPoolObject(STORED);
    expect(toPoolCsvRow(pool)).toEqual({ ...pool, base_issuer: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A row of `amm_pool_states` as the history reads it, its values already carried forward. */
const STATE: StoredPoolState = Object.freeze({
  ledger_index: 107612573,
  tx_index: 29,
  tx_hash: 'A'.repeat(64),
  close_time: 1_792_000_000,
  tx_type: 'Payment',
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  reserve_base: '14032356.31276641',
  reserve_counter: '178.309685',
  lp_supply: '49919.3',
  lp_currency: '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6',
  trading_fee: 612,
  auction_holder: HOLDER,
  auction_price: '12.5',
  auction_discounted_fee: 61,
  auction_expiration: 814_000_000,
  deleted: 0,
});

describe('toPoolStateObject', () => {
  it('has its keys in the pinned order', () => {
    expect(Object.keys(toPoolStateObject(POOL, STATE))).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'tx_type',
      'executed_time',
      'base_currency',
      'counter_currency',
      'counter_issuer',
      'reserve_base',
      'reserve_counter',
      'lp_supply',
      'lp_currency',
      'trading_fee',
      'auction_slot',
      'deleted',
    ]);
  });

  it('serves the values after the transaction like a pool does: strings, numbers, the slot grouped, deleted a boolean', () => {
    expect(toPoolStateObject(POOL, STATE)).toEqual({
      amm_account: POOL,
      ledger_index: 107612573,
      tx_index: 29,
      tx_hash: 'A'.repeat(64),
      tx_type: 'Payment',
      executed_time: '2026-10-14T17:46:40Z',
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      reserve_base: '14032356.31276641',
      reserve_counter: '178.309685',
      lp_supply: '49919.3',
      lp_currency: '03A8F4B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6',
      trading_fee: 612,
      auction_slot: { holder: HOLDER, price: '12.5', discounted_fee: 61, expiration: '2025-10-17T07:06:40Z' },
      deleted: false,
    });
  });

  it('leaves out the values that are still unknown after carrying forward, and keeps a fee of 0', () => {
    const state = toPoolStateObject(POOL, {
      ...STATE,
      lp_supply: null,
      lp_currency: null,
      trading_fee: 0,
      auction_holder: null,
      auction_price: null,
      auction_discounted_fee: null,
      auction_expiration: null,
      deleted: 1,
    });
    expect(state).toMatchObject({ trading_fee: 0, deleted: true });
    for (const key of ['lp_supply', 'lp_currency', 'auction_slot']) expect(state).not.toHaveProperty(key);
  });

  it('has the same csv columns whatever the state has', () => {
    const full = Object.keys(toPoolStateCsvRow(toPoolStateObject(POOL, STATE)));
    const bare = Object.keys(
      toPoolStateCsvRow(toPoolStateObject(POOL, { ...STATE, lp_supply: null, auction_holder: null, base_issuer: '' })),
    );
    expect(bare).toEqual(full);
    expect(full).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'tx_type',
      'executed_time',
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'reserve_base',
      'reserve_counter',
      'lp_supply',
      'lp_currency',
      'trading_fee',
      'auction_slot',
      'deleted',
    ]);
  });
});

describe('POOL_STATE_COLUMNS', () => {
  it('reads the columns of amm_pool_states a state is made of, with the close time as unix seconds', () => {
    const columns = POOL_STATE_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'ledger_index',
      'tx_index',
      'tx_hash',
      'toUnixTimestamp(close_time) AS close_time',
      'tx_type',
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'reserve_base',
      'reserve_counter',
      'lp_supply',
      'lp_currency',
      'trading_fee',
      'auction_holder',
      'auction_price',
      'auction_discounted_fee',
      'auction_expiration',
      'deleted',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A day of `amm_daily` as the history reads it (UInt64 counts arrive as text). */
const DAY: StoredPoolDay = Object.freeze({
  day: '2026-10-15',
  base_currency: 'XRP',
  base_issuer: '',
  counter_currency: 'USD',
  counter_issuer: ISSUER,
  swap_count: '12',
  volume_base: '1500.5',
  volume_counter: '3.25',
  fees_base_est: '4.5015',
  fees_counter_est: '0.00975',
  deposit_count: '2',
  withdraw_count: '1',
  liquidity_in_base: '100',
  liquidity_in_counter: '0.5',
  liquidity_out_base: '20',
  liquidity_out_counter: '0.1',
  reserve_base: '14032356.31276641',
  reserve_counter: '178.309685',
  lp_supply: '49919.3',
  trading_fee: 612,
  value_native: 28_064_712.62553282,
});

describe('toPoolDayObject', () => {
  it('has its keys in the pinned order', () => {
    expect(Object.keys(toPoolDayObject(POOL, DAY))).toEqual([
      'amm_account',
      'date',
      'base_currency',
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
    ]);
  });

  it('serves the day as the time its UTC day starts, the counts as numbers and the amounts as the strings stored', () => {
    expect(toPoolDayObject(POOL, DAY)).toEqual({
      amm_account: POOL,
      date: '2026-10-15T00:00:00Z',
      base_currency: 'XRP',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      swap_count: 12,
      volume_base: '1500.5',
      volume_counter: '3.25',
      fees_base_est: '4.5015',
      fees_counter_est: '0.00975',
      deposit_count: 2,
      withdraw_count: 1,
      liquidity_in_base: '100',
      liquidity_in_counter: '0.5',
      liquidity_out_base: '20',
      liquidity_out_counter: '0.1',
      reserve_base: '14032356.31276641',
      reserve_counter: '178.309685',
      lp_supply: '49919.3',
      trading_fee: 612,
      value_native: '28064713',
    });
  });

  it('leaves out the closing state a day does not have, and the value that is none', () => {
    const day = toPoolDayObject(POOL, {
      ...DAY,
      reserve_base: null,
      reserve_counter: null,
      lp_supply: null,
      trading_fee: null,
      value_native: null,
    });
    for (const key of ['reserve_base', 'reserve_counter', 'lp_supply', 'trading_fee', 'value_native']) {
      expect(day).not.toHaveProperty(key);
    }
    // a count of 0 and a fee of 0 stay
    const quiet = toPoolDayObject(POOL, { ...DAY, swap_count: '0', trading_fee: 0, value_native: 0 });
    expect(quiet).toMatchObject({ swap_count: 0, trading_fee: 0, value_native: '0' });
  });

  it('leaves out a fee estimate that is unknown (Ruling R-A26), and keeps one of 0, in the pinned order', () => {
    // the base side had a swap with no known fee; the counter side had none, or only swaps with a known fee
    const day = toPoolDayObject(POOL, { ...DAY, fees_base_est: null, fees_counter_est: '0' });
    expect(day).not.toHaveProperty('fees_base_est');
    expect(day).toMatchObject({ fees_counter_est: '0' });
    expect(Object.keys(day).slice(5, 9)).toEqual(['swap_count', 'volume_base', 'volume_counter', 'fees_counter_est']);
    const unknown = toPoolDayObject(POOL, { ...DAY, fees_base_est: null, fees_counter_est: null });
    for (const key of ['fees_base_est', 'fees_counter_est']) expect(unknown).not.toHaveProperty(key);
    expect(Object.keys(unknown).slice(7, 9)).toEqual(['volume_counter', 'deposit_count']);
  });

  it('serves the value of a day like the value of a pool: a plain decimal, never the exponent form', () => {
    const value = (v: number): string | undefined => toPoolDayObject(POOL, { ...DAY, value_native: v }).value_native;
    expect(value(123_456_789.5)).toBe('123456790');
    expect(value(99_999_999.5)).toBe('100000000');
    expect(value(1e-7)).toBe('0.0000001');
    expect(value(3.2e-8)).toBe('0.000000032');
    expect(value(12.5)).toBe('12.5');
    expect(value(0)).toBe('0');
  });

  it('serves nothing that is internal (the version, the final flag, the config version)', () => {
    const served = toPoolDayObject(POOL, { ...DAY, version: 1, final: 1, config_version: 1 } as StoredPoolDay);
    for (const key of ['version', 'final', 'config_version', 'day']) expect(served).not.toHaveProperty(key);
  });

  it('has the same csv columns whatever the day has', () => {
    const full = Object.keys(toPoolDayCsvRow(toPoolDayObject(POOL, DAY)));
    const bare = Object.keys(
      toPoolDayCsvRow(toPoolDayObject(POOL, { ...DAY, reserve_base: null, value_native: null, base_issuer: '' })),
    );
    expect(bare).toEqual(full);
    expect(full).toContain('base_issuer');
    expect(full).toContain('value_native');
    const row = toPoolDayCsvRow(toPoolDayObject(POOL, { ...DAY, value_native: null }));
    expect(row).toMatchObject({ base_issuer: null, value_native: null });
    // an unknown fee estimate is an empty cell, in its column
    const unknown = toPoolDayCsvRow(toPoolDayObject(POOL, { ...DAY, fees_base_est: null, fees_counter_est: null }));
    expect(Object.keys(unknown)).toEqual(full);
    expect(unknown).toMatchObject({ fees_base_est: null, fees_counter_est: null });
  });
});

describe('POOL_DAY_COLUMNS', () => {
  it('reads the columns of amm_daily a day is made of, and neither the sentinel flag nor the version', () => {
    const columns = POOL_DAY_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
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
    ]);
  });
});

describe('computedRange', () => {
  it('has no range for no day', () => {
    expect(computedRange([])).toBeUndefined();
  });

  it('is a single day when there is one', () => {
    expect(computedRange(['2026-03-14'])).toEqual({ start: '2026-03-14', end: '2026-03-14' });
  });

  it('runs from the oldest day to the newest when no day is missing between them', () => {
    expect(computedRange(['2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'])).toEqual({
      start: '2026-03-12',
      end: '2026-03-15',
    });
  });

  it('ends the range at a hole: the start is the oldest day reached from the newest without a missing day', () => {
    expect(computedRange(['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'])).toEqual({
      start: '2026-01-04',
      end: '2026-01-05',
    });
    // a hole right under the newest day leaves that day alone
    expect(computedRange(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05'])).toEqual({
      start: '2026-01-05',
      end: '2026-01-05',
    });
    // the holes under the range do not matter
    expect(computedRange(['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-05'])).toEqual({
      start: '2026-01-03',
      end: '2026-01-05',
    });
  });

  it('takes the days in any order', () => {
    expect(computedRange(['2026-01-05', '2026-01-01', '2026-01-04', '2026-01-02'])).toEqual({
      start: '2026-01-04',
      end: '2026-01-05',
    });
    expect(computedRange(['2026-01-03', '2026-01-05', '2026-01-04'])).toEqual({
      start: '2026-01-03',
      end: '2026-01-05',
    });
  });

  it('counts a day given twice once', () => {
    expect(computedRange(['2026-01-02', '2026-01-02', '2026-01-03', '2026-01-03'])).toEqual({
      start: '2026-01-02',
      end: '2026-01-03',
    });
  });

  it('is contiguous across a month boundary, a leap day and a year boundary', () => {
    expect(computedRange(['2026-02-28', '2026-03-01', '2026-03-02'])).toEqual({
      start: '2026-02-28',
      end: '2026-03-02',
    });
    expect(computedRange(['2024-02-28', '2024-02-29', '2024-03-01'])).toEqual({
      start: '2024-02-28',
      end: '2024-03-01',
    });
    expect(computedRange(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])).toEqual({
      start: '2025-12-30',
      end: '2026-01-02',
    });
    // 28 February to 1 March is not contiguous in a leap year, 29 February is missing
    expect(computedRange(['2024-02-28', '2024-03-01'])).toEqual({ start: '2024-03-01', end: '2024-03-01' });
    // 31 December and 2 January have 1 January missing between them
    expect(computedRange(['2025-12-31', '2026-01-02'])).toEqual({ start: '2026-01-02', end: '2026-01-02' });
  });
});

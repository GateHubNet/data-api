import { AMM_LIQUIDITY_EVENTS } from '@gatehub/data-api-shared';
import {
  GOVERNANCE_COLUMNS,
  LIQUIDITY_COLUMNS,
  StoredGovernance,
  StoredLiquidity,
  toGovernanceCsvRow,
  toGovernanceObject,
  toLiquidityCsvRow,
  toLiquidityObject,
  toPositionObject,
} from './amm-objects';

const POOL = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const HOLDER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const LP = '03F5BC4D66B44AEAD668A84F094E08C8C13F5EE2';

/** A row of `amm_liquidity` as the API reads it. Frozen, as an input must not be changed. */
const LIQUIDITY: StoredLiquidity = Object.freeze({
  amm_account: POOL,
  ledger_index: 107703707,
  tx_index: 12,
  tx_hash: 'AB'.repeat(32),
  close_time: 1_792_168_891,
  account: HOLDER,
  initiator: HOLDER,
  event: 'deposit',
  mode: 'two_asset',
  base_amount: '82.769304',
  counter_amount: '108.06155',
  lp_tokens: '80142.9',
});

const VOTE: StoredGovernance = Object.freeze({
  amm_account: POOL,
  ledger_index: 107644916,
  tx_index: 12,
  tx_hash: 'CD'.repeat(32),
  close_time: 1_791_959_540,
  kind: 'vote',
  account: HOLDER,
  fee_voted: 1000,
  trading_fee_after: 1000,
  bid_min: null,
  bid_max: null,
  price_paid: null,
  slot_holder: null,
  slot_discounted_fee: null,
  slot_expiration: null,
  auth_accounts: [],
});

const BID: StoredGovernance = Object.freeze({
  amm_account: POOL,
  ledger_index: 106084525,
  tx_index: 79,
  tx_hash: 'EF'.repeat(32),
  close_time: 1_785_921_301,
  kind: 'bid',
  account: HOLDER,
  fee_voted: null,
  trading_fee_after: null,
  bid_min: '294.354152174',
  bid_max: '300',
  price_paid: '294.354152174',
  slot_holder: HOLDER,
  slot_discounted_fee: 22,
  // ripple seconds: 839,322,900 s after 2000-01-01
  slot_expiration: 839_322_900,
  auth_accounts: [ISSUER, POOL],
});

describe('AMM_LIQUIDITY_EVENTS', () => {
  it('is the set of events the parser writes: create, deposit, withdraw, clawback, delete', () => {
    expect([...AMM_LIQUIDITY_EVENTS].sort()).toEqual(['clawback', 'create', 'delete', 'deposit', 'withdraw']);
  });
});

describe('LIQUIDITY_COLUMNS', () => {
  it('reads the columns a liquidity event is made of, with the close time as unix seconds, and no Float64 shadow', () => {
    expect(LIQUIDITY_COLUMNS.split(',').map((c) => c.trim())).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'toUnixTimestamp(close_time) AS close_time',
      'account',
      'initiator',
      'event',
      'mode',
      'base_amount',
      'counter_amount',
      'lp_tokens',
    ]);
  });
});

describe('toLiquidityObject', () => {
  it('has its keys in the pinned order: the pool and the transaction, who, what, then the amounts', () => {
    expect(Object.keys(toLiquidityObject(LIQUIDITY))).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'account',
      'initiator',
      'event',
      'mode',
      'base_amount',
      'counter_amount',
      'lp_tokens',
    ]);
  });

  it('serves the amounts as the exact strings stored (signed), the positions as numbers, the time as fmtTime', () => {
    expect(toLiquidityObject(LIQUIDITY)).toEqual({
      amm_account: POOL,
      ledger_index: 107703707,
      tx_index: 12,
      tx_hash: 'AB'.repeat(32),
      executed_time: '2026-10-16T16:41:31Z',
      account: HOLDER,
      initiator: HOLDER,
      event: 'deposit',
      mode: 'two_asset',
      base_amount: '82.769304',
      counter_amount: '108.06155',
      lp_tokens: '80142.9',
    });
    const withdrawal = toLiquidityObject({
      ...LIQUIDITY,
      event: 'withdraw',
      base_amount: '-4.18049701822',
      counter_amount: '0',
      lp_tokens: '-4.16712896228',
    });
    expect(withdrawal).toMatchObject({
      base_amount: '-4.18049701822',
      counter_amount: '0',
      lp_tokens: '-4.16712896228',
    });
  });

  it('leaves the mode out where there is none (create, delete, clawback store an empty one): no key is ever empty', () => {
    const created = toLiquidityObject({ ...LIQUIDITY, event: 'create', mode: '' });
    expect(created).not.toHaveProperty('mode');
    expect(Object.keys(created)).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'account',
      'initiator',
      'event',
      'base_amount',
      'counter_amount',
      'lp_tokens',
    ]);
    for (const value of Object.values(created)) expect(value).not.toBe('');
  });

  it('keeps who from who started it: a clawback is the holder, started by the issuer', () => {
    const clawback = toLiquidityObject({ ...LIQUIDITY, event: 'clawback', mode: '', initiator: ISSUER });
    expect(clawback).toMatchObject({ account: HOLDER, initiator: ISSUER, event: 'clawback' });
  });

  it('counts that arrive as text are numbers', () => {
    expect(
      toLiquidityObject({ ...LIQUIDITY, ledger_index: '107703707', tx_index: '12', close_time: '1792168891' }),
    ).toMatchObject({ ledger_index: 107703707, tx_index: 12, executed_time: '2026-10-16T16:41:31Z' });
  });

  it('does not change its input and serves no Float64 shadow', () => {
    const wide = { ...LIQUIDITY, base_amount_f: 82.77 } as StoredLiquidity;
    expect(toLiquidityObject(wide)).not.toHaveProperty('base_amount_f');
    expect(LIQUIDITY.mode).toBe('two_asset');
  });
});

describe('toLiquidityCsvRow', () => {
  it('has every column in the pinned order whatever the event has: the mode is null where there is none', () => {
    const columns = Object.keys(toLiquidityObject(LIQUIDITY));
    expect(Object.keys(toLiquidityCsvRow(toLiquidityObject(LIQUIDITY)))).toEqual(columns);
    const created = toLiquidityCsvRow(toLiquidityObject({ ...LIQUIDITY, event: 'create', mode: '' }));
    expect(Object.keys(created)).toEqual(columns);
    expect(created.mode).toBeNull();
  });
});

describe('GOVERNANCE_COLUMNS', () => {
  it('reads the columns a vote or a bid is made of, with the close time as unix seconds', () => {
    expect(GOVERNANCE_COLUMNS.split(',').map((c) => c.trim())).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'toUnixTimestamp(close_time) AS close_time',
      'kind',
      'account',
      'fee_voted',
      'trading_fee_after',
      'bid_min',
      'bid_max',
      'price_paid',
      'slot_holder',
      'slot_discounted_fee',
      'slot_expiration',
      'auth_accounts',
    ]);
  });
});

describe('toGovernanceObject', () => {
  it('serves a vote with its keys in the pinned order', () => {
    const vote = toGovernanceObject(VOTE);
    expect(Object.keys(vote)).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'type',
      'account',
      'fee_voted',
      'trading_fee_after',
    ]);
    expect(vote).toEqual({
      amm_account: POOL,
      ledger_index: 107644916,
      tx_index: 12,
      tx_hash: 'CD'.repeat(32),
      executed_time: '2026-10-14T06:32:20Z',
      type: 'vote',
      account: HOLDER,
      fee_voted: 1000,
      trading_fee_after: 1000,
    });
  });

  it('serves a bid with its keys in the pinned order, the slot grouped with its accounts', () => {
    const bid = toGovernanceObject(BID);
    expect(Object.keys(bid)).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'type',
      'account',
      'bid_min',
      'bid_max',
      'price_paid',
      'auction_slot',
    ]);
    expect(Object.keys((bid as { auction_slot: object }).auction_slot)).toEqual([
      'holder',
      'discounted_fee',
      'expiration',
      'auth_accounts',
    ]);
    expect(bid).toEqual({
      amm_account: POOL,
      ledger_index: 106084525,
      tx_index: 79,
      tx_hash: 'EF'.repeat(32),
      executed_time: '2026-08-05T09:15:01Z',
      type: 'bid',
      account: HOLDER,
      bid_min: '294.354152174',
      bid_max: '300',
      price_paid: '294.354152174',
      auction_slot: {
        holder: HOLDER,
        discounted_fee: 22,
        // ripple seconds: 839,322,900 s after 2000-01-01
        expiration: '2026-08-06T09:15:00Z',
        auth_accounts: [ISSUER, POOL],
      },
    });
  });

  it('a fee of 0 is a value: a vote for 0 keeps both fees, a slot with a discounted fee of 0 keeps it', () => {
    expect(toGovernanceObject({ ...VOTE, fee_voted: 0, trading_fee_after: 0 })).toMatchObject({
      fee_voted: 0,
      trading_fee_after: 0,
    });
    const bid = toGovernanceObject({ ...BID, slot_discounted_fee: 0, price_paid: '0' });
    expect(bid).toMatchObject({ price_paid: '0', auction_slot: { discounted_fee: 0 } });
  });

  it('leaves out what the row does not have; the slot has no accounts as an empty list, and is left out with nothing in it', () => {
    const bare = toGovernanceObject({
      ...BID,
      bid_min: null,
      bid_max: null,
      price_paid: null,
      slot_holder: null,
      slot_discounted_fee: null,
      slot_expiration: null,
      auth_accounts: [],
    });
    expect(bare).not.toHaveProperty('auction_slot');
    expect(Object.keys(bare)).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'type',
      'account',
    ]);
    const noAccounts = toGovernanceObject({ ...BID, auth_accounts: [] });
    expect((noAccounts as { auction_slot: object }).auction_slot).toEqual({
      holder: HOLDER,
      discounted_fee: 22,
      expiration: '2026-08-06T09:15:00Z',
      auth_accounts: [],
    });
    const noVote = toGovernanceObject({ ...VOTE, fee_voted: null, trading_fee_after: null });
    expect(Object.keys(noVote)).toEqual([
      'amm_account',
      'ledger_index',
      'tx_index',
      'tx_hash',
      'executed_time',
      'type',
      'account',
    ]);
  });

  it('a vote serves nothing of a bid and a bid nothing of a vote, whatever the row holds', () => {
    expect(
      toGovernanceObject({ ...VOTE, bid_min: '1', price_paid: '1', slot_holder: HOLDER, auth_accounts: [POOL] }),
    ).toEqual(toGovernanceObject(VOTE));
    expect(toGovernanceObject({ ...BID, fee_voted: 5, trading_fee_after: 5 })).toEqual(toGovernanceObject(BID));
  });

  it('counts that arrive as text are numbers', () => {
    const bid = toGovernanceObject({ ...BID, slot_discounted_fee: '22', slot_expiration: '839322900', tx_index: '79' });
    expect(bid).toMatchObject({
      tx_index: 79,
      auction_slot: { discounted_fee: 22, expiration: '2026-08-06T09:15:00Z' },
    });
  });

  it('does not change its input; the accounts it serves are a copy', () => {
    const bid = toGovernanceObject(BID) as { auction_slot: { auth_accounts: string[] } };
    bid.auction_slot.auth_accounts.push('x');
    expect(BID.auth_accounts).toEqual([ISSUER, POOL]);
  });
});

describe('toGovernanceCsvRow', () => {
  const columns = [
    'amm_account',
    'ledger_index',
    'tx_index',
    'tx_hash',
    'executed_time',
    'type',
    'account',
    'fee_voted',
    'trading_fee_after',
    'bid_min',
    'bid_max',
    'price_paid',
    'auction_slot',
  ];

  it('has every column of both kinds in the pinned order, null where the row has none (a page of votes and bids has one header)', () => {
    for (const row of [VOTE, BID]) {
      expect(Object.keys(toGovernanceCsvRow(toGovernanceObject(row)))).toEqual(columns);
    }
    expect(toGovernanceCsvRow(toGovernanceObject(VOTE))).toEqual({
      amm_account: POOL,
      ledger_index: 107644916,
      tx_index: 12,
      tx_hash: 'CD'.repeat(32),
      executed_time: '2026-10-14T06:32:20Z',
      type: 'vote',
      account: HOLDER,
      fee_voted: 1000,
      trading_fee_after: 1000,
      bid_min: null,
      bid_max: null,
      price_paid: null,
      auction_slot: { holder: null, discounted_fee: null, expiration: null, auth_accounts: null },
    });
  });

  it('writes the accounts of a slot into one cell, separated by semicolons; none is null', () => {
    const row = toGovernanceCsvRow(toGovernanceObject(BID));
    expect(row.auction_slot).toEqual({
      holder: HOLDER,
      discounted_fee: 22,
      expiration: '2026-08-06T09:15:00Z',
      auth_accounts: `${ISSUER};${POOL}`,
    });
    expect(toGovernanceCsvRow(toGovernanceObject({ ...BID, auth_accounts: [] })).auction_slot.auth_accounts).toBeNull();
    expect(Object.keys(row.auction_slot)).toEqual(['holder', 'discounted_fee', 'expiration', 'auth_accounts']);
  });
});

describe('toPositionObject', () => {
  /** 141,421,356.2373095 LP tokens of a pool that has four times as many, 1000 XRP and 777.3 of the other asset. */
  const input = {
    pool: POOL,
    lp_currency: LP,
    lp_balance: '141421356.2373095',
    lp_supply: '565685424.949238',
    reserve_base: '1000',
    reserve_counter: '777.3',
    deleted: false,
  };

  it('has its keys in the pinned order: the pool, the LP token, the balance, the share, the amounts', () => {
    expect(Object.keys(toPositionObject(input) ?? {})).toEqual([
      'pool',
      'lp_currency',
      'lp_balance',
      'share',
      'base_amount',
      'counter_amount',
    ]);
  });

  it('is the share of the supply and the same share of each reserve, as exact decimal strings', () => {
    expect(toPositionObject(input)).toEqual({
      pool: POOL,
      lp_currency: LP,
      lp_balance: '141421356.2373095',
      share: '0.25',
      base_amount: '250',
      counter_amount: '194.325',
    });
  });

  it('a share that does not end is cut at 30 significant digits (rounded), the amounts the same, all plain decimals', () => {
    const third = toPositionObject({
      ...input,
      lp_balance: '1',
      lp_supply: '3',
      reserve_base: '1000',
      reserve_counter: '2',
    });
    expect(third).toEqual({
      pool: POOL,
      lp_currency: LP,
      lp_balance: '1',
      share: '0.333333333333333333333333333333',
      base_amount: '333.333333333333333333333333333',
      counter_amount: '0.666666666666666666666666666667',
    });
    // two thirds rounds up in the last digit
    expect(toPositionObject({ ...input, lp_balance: '2', lp_supply: '3', reserve_counter: '1' })?.share).toBe(
      '0.666666666666666666666666666667',
    );
  });

  it('computes with decimals, not floats: sums a float cannot hold are exact', () => {
    // 0.1 / 0.3 and a balance above 2^53
    expect(toPositionObject({ ...input, lp_balance: '0.1', lp_supply: '0.3' })?.share).toBe(
      '0.333333333333333333333333333333',
    );
    const big = toPositionObject({
      ...input,
      lp_balance: '9007199254740993',
      lp_supply: '9007199254740993',
      reserve_base: '99999999999.999999',
      reserve_counter: '12345678901234567.5',
    });
    expect(big).toMatchObject({
      lp_balance: '9007199254740993',
      share: '1',
      base_amount: '99999999999.999999',
      counter_amount: '12345678901234567.5',
    });
    // 17 and 18 digits of an amount survive a share of one half
    expect(
      toPositionObject({ ...input, lp_balance: '1', lp_supply: '2', reserve_base: '99999999999.999999' })?.base_amount,
    ).toBe('49999999999.9999995');
  });

  it('never writes the exponent form, small or large', () => {
    const tiny = toPositionObject({ ...input, lp_balance: '1e-15', lp_supply: '1e+15', reserve_base: '1e-10' });
    expect(tiny?.lp_balance).toBe('0.000000000000001');
    expect(tiny?.share).toBe('0.000000000000000000000000000001');
    expect(tiny?.base_amount).toBe(`0.${'0'.repeat(39)}1`);
    expect(tiny?.base_amount).not.toMatch(/e/i);
    const huge = toPositionObject({ ...input, lp_balance: '1e20', lp_supply: '1e20', reserve_base: '1e30' });
    expect(huge?.lp_balance).toBe('100000000000000000000');
    expect(huge?.base_amount).toBe('1000000000000000000000000000000');
  });

  it('omits an amount whose reserve is not known', () => {
    const noBase = toPositionObject({ ...input, reserve_base: null });
    expect(noBase).toEqual({
      pool: POOL,
      lp_currency: LP,
      lp_balance: '141421356.2373095',
      share: '0.25',
      counter_amount: '194.325',
    });
    expect(Object.keys(noBase ?? {})).toEqual(['pool', 'lp_currency', 'lp_balance', 'share', 'counter_amount']);
    expect(toPositionObject({ ...input, reserve_base: null, reserve_counter: null })).toEqual({
      pool: POOL,
      lp_currency: LP,
      lp_balance: '141421356.2373095',
      share: '0.25',
    });
  });

  it('a reserve of 0 is an amount of 0', () => {
    expect(toPositionObject({ ...input, reserve_base: '0' })?.base_amount).toBe('0');
  });

  it('has no position for a zero balance, however it is written', () => {
    for (const zero of ['0', '0.0', '-0', '0e5', '0.000']) {
      expect([zero, toPositionObject({ ...input, lp_balance: zero })]).toEqual([zero, undefined]);
    }
  });

  it('has no position for a pool without a supply, with a supply of 0, or a deleted one', () => {
    expect(toPositionObject({ ...input, lp_supply: null })).toBeUndefined();
    expect(toPositionObject({ ...input, lp_supply: '0' })).toBeUndefined();
    expect(toPositionObject({ ...input, lp_supply: '0.0' })).toBeUndefined();
    expect(toPositionObject({ ...input, deleted: true })).toBeUndefined();
    // a balance that is no number does not make a position either
    expect(toPositionObject({ ...input, lp_balance: 'x' })).toBeUndefined();
    expect(toPositionObject({ ...input, lp_supply: 'x' })).toBeUndefined();
  });

  it('does not change its input', () => {
    const frozen = Object.freeze({ ...input });
    expect(() => toPositionObject(frozen)).not.toThrow();
  });
});

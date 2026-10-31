import { NetworkSupplyRow } from '@gatehub/data-api-shared';
import type { Coverage } from '../common/feature-coverage.service';
import {
  AMM_KEYS,
  BURNED_KEYS,
  CIRCULATING_KEYS,
  ESCROWED_KEYS,
  MINTED_BODY_KEYS,
  MINTED_DAY_KEYSET,
  MINTED_KEYS,
  MINTED_ROW_KEYS,
  mintedRow,
  RESERVES_KEYS,
  SUPPLY_KEYS,
  SupplyCoverages,
  supplyFeaturesOf,
  supplyObject,
} from './supply-object';

/*
 * The figures are those of the examples of spec 5.1, worked out in drops (10^-6 of a coin): the XRPL row has 99,985,312,374.716318 XRP
 * in existence, of which 35,212,847,105.402318 are in open escrows; the Xahau row 613,401,782.117306 XAH, 18,406,227.318004 of them
 * escrowed and 49,425,551.616207 minted (41,203,318.512207 of rewards, 8,102,233.104 imported, 120,000 genesis mints).
 */

const unix = (iso: string): number => Date.parse(iso) / 1000;

const XRPL_ROW: NetworkSupplyRow = {
  ledger_index: 107_747_456,
  close_time: unix('2026-10-24T21:00:00Z'),
  started_at: unix('2026-10-24T20:59:12Z'),
  computed_at: unix('2026-10-24T21:01:47Z'),
  total_coins: '99985312374716318', // past 2^53: a float would lose it
  burned: '14687625283682',
  escrowed: '35212847105402318',
  escrow_count: '12879',
  amm: '46218377402915',
  amm_pools: 14_594,
  reserve_base: '1000000',
  reserve_inc: '200000',
  accounts: '6410280',
  owner_count: '16998620',
  minted_rewards: null,
  minted_import: null,
  minted_genesis: null,
  version: '1761339707000',
};

const XAHAU_ROW: NetworkSupplyRow = {
  ledger_index: 26_603_520,
  close_time: unix('2026-10-24T21:00:02Z'),
  started_at: unix('2026-10-24T21:00:00Z'),
  computed_at: unix('2026-10-24T21:00:31Z'),
  total_coins: '613401782117306',
  burned: '2318640227',
  escrowed: '18406227318004',
  escrow_count: '2140',
  amm: null,
  amm_pools: 0,
  reserve_base: '1000000',
  reserve_inc: '200000',
  accounts: '186412',
  owner_count: '412806',
  minted_rewards: '41203318512207',
  minted_import: '8102233104000',
  minted_genesis: '120000000000',
  version: '1761339631000',
};

const ESCROWS: Coverage = { from_ledger_index: 28_685_313, complete: true };
const FEES: Coverage = { from_ledger_index: 2, complete: true };
const AMM: Coverage = { from_ledger_index: 86_795_265, complete: true };
const STATES: Coverage = { from_ledger_index: 107_480_321, complete: false };
const MINTS: Coverage = { from_ledger_index: 2, complete: true };

const XRPL_COVERAGES: SupplyCoverages = { escrows: ESCROWS, amm: AMM, account_states: STATES };
const XAHAU_COVERAGES: SupplyCoverages = { escrows: FEES, fees: FEES, mints: MINTS, account_states: FEES };

/** The row with some columns replaced. */
const rowWith = (row: NetworkSupplyRow, over: Partial<NetworkSupplyRow>): NetworkSupplyRow => ({ ...row, ...over });

describe('the keys of the supply answer', () => {
  it('are the orders of spec 5.1', () => {
    expect([...SUPPLY_KEYS]).toEqual([
      'result',
      'ledger_index',
      'close_time',
      'computed_at',
      'currency',
      'total',
      'burned',
      'minted',
      'escrowed',
      'circulating',
      'amm',
      'reserves',
    ]);
    expect([...BURNED_KEYS]).toEqual(['amount', 'coverage']);
    expect([...MINTED_KEYS]).toEqual(['amount', 'rewards', 'import', 'genesis_mint', 'coverage']);
    expect([...ESCROWED_KEYS]).toEqual(['amount', 'escrows', 'coverage']);
    expect([...CIRCULATING_KEYS]).toEqual(['amount', 'coverage']);
    expect([...AMM_KEYS]).toEqual(['amount', 'pools', 'coverage']);
    expect([...RESERVES_KEYS]).toEqual(['amount', 'accounts', 'owner_count', 'base', 'increment', 'coverage']);
  });
});

describe('supplyObject', () => {
  it('answers the XRPL row in key order with exact amounts', () => {
    const answer = supplyObject(XRPL_ROW, 'XRP', XRPL_COVERAGES);
    expect(JSON.stringify(answer)).toBe(
      JSON.stringify({
        result: 'success',
        ledger_index: 107_747_456,
        close_time: '2026-10-24T21:00:00Z',
        computed_at: '2026-10-24T21:01:47Z',
        currency: 'XRP',
        total: '99985312374.716318',
        burned: { amount: '14687625.283682' },
        escrowed: { amount: '35212847105.402318', escrows: 12_879, coverage: ESCROWS },
        circulating: { amount: '64772465269.314', coverage: ESCROWS },
        amm: { amount: '46218377.402915', pools: 14_594, coverage: AMM },
        reserves: {
          amount: '9810004',
          accounts: 6_410_280,
          owner_count: 16_998_620,
          base: '1',
          increment: '0.2',
          coverage: STATES,
        },
      }),
    );
    // the keys are the constant's, whatever the values
    expect(Object.keys(answer)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'minted'));
    // XRPL burned is exact from the header and states no coverage; the counts are numbers, the amounts text
    expect(answer.burned).not.toHaveProperty('coverage');
    expect([
      answer.escrowed.escrows,
      answer.amm?.pools,
      answer.reserves?.accounts,
      answer.reserves?.owner_count,
    ]).toEqual([12_879, 14_594, 6_410_280, 16_998_620]);
  });

  it('answers the Xahau row with minted, burned coverage and no amm', () => {
    const answer = supplyObject(XAHAU_ROW, 'XAH', XAHAU_COVERAGES);
    expect(JSON.stringify(answer)).toBe(
      JSON.stringify({
        result: 'success',
        ledger_index: 26_603_520,
        close_time: '2026-10-24T21:00:02Z',
        computed_at: '2026-10-24T21:00:31Z',
        currency: 'XAH',
        total: '613401782.117306',
        burned: { amount: '2318.640227', coverage: FEES },
        minted: {
          amount: '49425551.616207',
          rewards: '41203318.512207',
          import: '8102233.104',
          genesis_mint: '120000',
          coverage: MINTS,
        },
        escrowed: { amount: '18406227.318004', escrows: 2140, coverage: FEES },
        circulating: { amount: '594995554.799302', coverage: FEES },
        reserves: {
          amount: '268973.2',
          accounts: 186_412,
          owner_count: 412_806,
          base: '1',
          increment: '0.2',
          coverage: FEES,
        },
      }),
    );
    expect(Object.keys(answer)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'amm'));
  });

  it('leaves out minted, amm and reserves when their columns are NULL', () => {
    const bare = rowWith(XRPL_ROW, { amm: null, amm_pools: 0, reserve_base: null, reserve_inc: null });
    const answer = supplyObject(bare, 'XRP', { escrows: ESCROWS });
    expect(Object.keys(answer)).toEqual([
      'result',
      'ledger_index',
      'close_time',
      'computed_at',
      'currency',
      'total',
      'burned',
      'escrowed',
      'circulating',
    ]);
    expect(JSON.stringify(answer)).not.toContain('null');
    // a Xahau row with no reserve values still has its minted part, and one with no mint columns has none
    const noReserves = supplyObject(rowWith(XAHAU_ROW, { reserve_base: null, reserve_inc: null }), 'XAH', {
      escrows: FEES,
      fees: FEES,
      mints: MINTS,
    });
    expect(Object.keys(noReserves)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'amm' && key !== 'reserves'));
    const noMinted = supplyObject(
      rowWith(XAHAU_ROW, { minted_rewards: null, minted_import: null, minted_genesis: null }),
      'XAH',
      { escrows: FEES, fees: FEES, account_states: FEES },
    );
    expect(Object.keys(noMinted)).toEqual(SUPPLY_KEYS.filter((key) => key !== 'amm' && key !== 'minted'));
  });

  it("puts each part's coverage last, and circulating repeats escrowed's", () => {
    const answer = supplyObject(rowWith(XAHAU_ROW, { amm: '1', amm_pools: 1 }), 'XAH', {
      ...XAHAU_COVERAGES,
      amm: AMM,
    });
    const parts = {
      burned: BURNED_KEYS,
      minted: MINTED_KEYS,
      escrowed: ESCROWED_KEYS,
      circulating: CIRCULATING_KEYS,
      amm: AMM_KEYS,
      reserves: RESERVES_KEYS,
    } as const;
    for (const [name, keys] of Object.entries(parts)) {
      const present = Object.keys(answer[name as keyof typeof parts] as object);
      expect([name, present]).toEqual([name, [...keys]]);
      expect([name, present[present.length - 1]]).toEqual([name, 'coverage']);
    }
    expect(answer.circulating.coverage).toEqual(answer.escrowed.coverage);
    // each part states its own: here the minted part is incomplete while the others are not
    const incomplete = supplyObject(XAHAU_ROW, 'XAH', {
      ...XAHAU_COVERAGES,
      mints: { from_ledger_index: 501, complete: false },
    });
    expect(incomplete.minted?.coverage).toEqual({ from_ledger_index: 501, complete: false });
    expect([incomplete.burned.coverage, incomplete.escrowed.coverage, incomplete.reserves?.coverage]).toEqual([
      FEES,
      FEES,
      FEES,
    ]);
    // a coverage with no ledger stored has no from_ledger_index
    const none = supplyObject(XRPL_ROW, 'XRP', { ...XRPL_COVERAGES, escrows: { complete: false } });
    expect(none.escrowed.coverage).toEqual({ complete: false });
    expect(none.circulating.coverage).toEqual({ complete: false });
  });

  it('does the sums in drops without a float: the amounts above 2^53 stay exact', () => {
    // 2^53 = 9007199254740992; the totals and escrows of XRPL are ten times that
    const big = rowWith(XRPL_ROW, {
      total_coins: '100000000000000000',
      escrowed: '99999999999999999',
      amm: '9007199254740993',
      accounts: '9007199254740993',
      owner_count: '0',
      reserve_base: '1',
    });
    const answer = supplyObject(big, 'XRP', XRPL_COVERAGES);
    expect(answer.total).toBe('100000000000');
    expect(answer.circulating.amount).toBe('0.000001');
    expect(answer.amm?.amount).toBe('9007199254.740993');
    // accounts × base + owner_count × increment, in drops
    expect(answer.reserves?.amount).toBe('9007199254.740993');
    expect(answer.reserves?.base).toBe('0.000001');
  });

  it('refuses a part with no coverage to state, rather than serve it without', () => {
    expect(() => supplyObject(XRPL_ROW, 'XRP', { escrows: ESCROWS, account_states: STATES })).toThrow('amm');
    expect(() => supplyObject(XRPL_ROW, 'XRP', { escrows: ESCROWS, amm: AMM })).toThrow('account_states');
    expect(() => supplyObject(XAHAU_ROW, 'XAH', { escrows: FEES, fees: FEES, account_states: FEES })).toThrow('mints');
  });
});

describe('supplyFeaturesOf', () => {
  it('names the features of the parts the row has: escrows always, fees where the network mints', () => {
    expect(supplyFeaturesOf(XRPL_ROW, false)).toEqual(['escrows', 'amm', 'account_states']);
    expect(supplyFeaturesOf(XAHAU_ROW, true)).toEqual(['escrows', 'fees', 'mints', 'account_states']);
  });

  it('asks nothing of a part the row does not have', () => {
    const noValues = rowWith(XRPL_ROW, { amm: null, reserve_base: null, reserve_inc: null });
    expect(supplyFeaturesOf(noValues, false)).toEqual(['escrows']);
    const noMints = rowWith(XAHAU_ROW, { minted_rewards: null, minted_import: null, minted_genesis: null });
    expect(supplyFeaturesOf(noMints, true)).toEqual(['escrows', 'fees', 'account_states']);
  });

  it('names exactly the coverages supplyObject needs', () => {
    for (const [row, mints] of [
      [XRPL_ROW, false],
      [XAHAU_ROW, true],
      [rowWith(XRPL_ROW, { amm: null, reserve_base: null, reserve_inc: null }), false],
    ] as const) {
      const coverages = Object.fromEntries(
        supplyFeaturesOf(row, mints).map((name) => [name, ESCROWS]),
      ) as unknown as SupplyCoverages;
      const answer = supplyObject(row, mints ? 'XAH' : 'XRP', coverages);
      // every part present states a coverage taken from the features asked, and no feature asked is left unused
      const used = [
        answer.burned.coverage,
        answer.minted?.coverage,
        answer.escrowed.coverage,
        answer.amm?.coverage,
        answer.reserves?.coverage,
      ].filter((coverage) => coverage !== undefined);
      expect(used).toHaveLength(supplyFeaturesOf(row, mints).length);
    }
  });
});

describe('the keys of the minted answer', () => {
  it('are the orders of spec 5.2', () => {
    // coverage right after result (D3's convention for lists), the rows last; a row has the sum first and then the three sources
    expect([...MINTED_BODY_KEYS]).toEqual(['result', 'coverage', 'marker', 'count', 'rows']);
    expect([...MINTED_ROW_KEYS]).toEqual(['date', 'amount', 'rewards', 'import', 'genesis_mint']);
  });

  it('page by the start of the day, in unix seconds', () => {
    // a keyset, not a key order: the marker is the one value `day`, a DateTime
    expect(MINTED_DAY_KEYSET).toEqual([{ column: 'day', type: 'DateTime' }]);
  });
});

describe('mintedRow', () => {
  const DAY_START = Date.parse('2026-10-22T00:00:00Z') / 1000;

  it('answers the day in key order, the sum of the three sources first', () => {
    const row = mintedRow(DAY_START, { rewards: 29_512_338_912n, import: 3_500_066_306n, genesis_mint: 0n });
    expect(JSON.stringify(row)).toBe(
      JSON.stringify({
        date: '2026-10-22T00:00:00Z',
        amount: '33012.405218',
        rewards: '29512.338912',
        import: '3500.066306',
        genesis_mint: '0',
      }),
    );
    expect(Object.keys(row)).toEqual([...MINTED_ROW_KEYS]);
  });

  it('answers a day without a mint as zeros', () => {
    expect(mintedRow(DAY_START, { rewards: 0n, import: 0n, genesis_mint: 0n })).toEqual({
      date: '2026-10-22T00:00:00Z',
      amount: '0',
      rewards: '0',
      import: '0',
      genesis_mint: '0',
    });
  });

  it('drops trailing zeros and keeps a drop', () => {
    const row = mintedRow(DAY_START, { rewards: 1_100_000n, import: 7n, genesis_mint: 40_000_000_000n });
    expect([row.rewards, row.import, row.genesis_mint, row.amount]).toEqual([
      '1.1',
      '0.000007',
      '40000',
      '40001.100007',
    ]);
  });

  it('adds the sources as bigints: sums past 2^53 are exact', () => {
    // 2^53 + 1 drops of every source: no number holds one of them, and their sum is 3 × (2^53 + 1)
    const big = 9_007_199_254_740_993n;
    const row = mintedRow(DAY_START, { rewards: big, import: big, genesis_mint: big });
    expect(row.rewards).toBe('9007199254.740993');
    expect(row.amount).toBe('27021597764.222979');
    expect(row.amount).toBe(
      ((big * 3n) / 1_000_000n).toString() + '.' + ((big * 3n) % 1_000_000n).toString().padStart(6, '0'),
    );
  });

  it('writes the date of a day in the middle of a year and of a leap day', () => {
    const rows = [
      Date.parse('2024-02-29T00:00:00Z') / 1000,
      Date.parse('2023-12-31T00:00:00Z') / 1000,
      Date.parse('2022-01-01T00:00:00Z') / 1000,
    ].map((start) => mintedRow(start, { rewards: 0n, import: 0n, genesis_mint: 0n }).date);
    expect(rows).toEqual(['2024-02-29T00:00:00Z', '2023-12-31T00:00:00Z', '2022-01-01T00:00:00Z']);
  });
});

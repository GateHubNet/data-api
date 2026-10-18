import { decimalQuotient, quotientEnds } from '../../test/support/decimal';
import { toPositionObject } from './amm-positions';

const POOL = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const LP = '03F5BC4D66B44AEAD668A84F094E08C8C13F5EE2';

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

  it('serves the exact quotient when it ends, however many digits it has: no rounding to 30 digits', () => {
    // 0.1234567890123456 * 9876543210.987654 / 1000 = 1219326.3113702171333485751812224 (32 digits, and it ends)
    const position = toPositionObject({
      ...input,
      lp_balance: '0.1234567890123456',
      lp_supply: '1000',
      reserve_base: '9876543210.987654',
      reserve_counter: '0.5',
    });
    expect(position).toEqual({
      pool: POOL,
      lp_currency: LP,
      lp_balance: '0.1234567890123456',
      share: '0.0001234567890123456',
      base_amount: '1219326.3113702171333485751812224',
      counter_amount: '0.0000617283945061728',
    });
    // 1 / 2^100 ends after 70 digits, with a divisor of 31 digits: 5^100 / 10^100
    const power = toPositionObject({ ...input, lp_balance: '1', lp_supply: '1267650600228229401496703205376' });
    expect(power?.share).toBe(`0.${(5n ** 100n).toString().padStart(100, '0')}`);
    // and the same quotient from the other side: a balance of 2^100 over a supply of 1 is the whole integer
    expect(toPositionObject({ ...input, lp_balance: '1267650600228229401496703205376', lp_supply: '1' })?.share).toBe(
      '1267650600228229401496703205376',
    );
  });

  it('keeps 30 significant digits of a quotient that does not end, whatever its size: from 1e-201 to 1e99', () => {
    const tiny = toPositionObject({ ...input, lp_balance: '1e-100', lp_supply: '3e+100', reserve_base: '1' });
    expect(tiny?.share).toBe(`0.${'0'.repeat(200)}${'3'.repeat(30)}`);
    expect(tiny?.base_amount).toBe(`0.${'0'.repeat(200)}${'3'.repeat(30)}`);
    const huge = toPositionObject({ ...input, lp_balance: '1', lp_supply: '3e-98', reserve_base: '1' });
    expect(huge?.share).toBe(`${'3'.repeat(30)}${'0'.repeat(68)}`);
    // rounds the 31st digit: 2/3
    expect(toPositionObject({ ...input, lp_balance: '2e-100', lp_supply: '3e+100' })?.share).toBe(
      `0.${'0'.repeat(200)}${'6'.repeat(29)}7`,
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

describe('toPositionObject against an exact fraction (the BigInt oracle of the e2e suites)', () => {
  // A deterministic generator (a 31-bit LCG) so a failure repeats.
  let seed = 20_261_018;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  /** A decimal of 1 to 17 digits with the point anywhere (also none) and, now and then, an exponent. */
  const decimal = (): string => {
    const digits = Array.from({ length: 1 + next(17) }, (_, i) => (i === 0 ? 1 + next(9) : next(10))).join('');
    const point = next(digits.length + 1);
    const text =
      point === digits.length ? digits : `${digits.slice(0, point)}.${digits.slice(point)}`.replace(/^\./, '0.');
    return next(4) === 0 ? `${text}e${next(61) - 30}` : text;
  };
  /** A supply that often ends in a quotient: a product of powers of 2 and 5 and a small number, or any decimal. */
  const supply = (): string => {
    if (next(2) === 0) return decimal();
    const m = BigInt(1 + next(9)) * 2n ** BigInt(next(50)) * 5n ** BigInt(next(22));
    return next(3) === 0 ? `${m}e${next(21) - 10}` : m.toString();
  };

  it('serves the exact quotient when it ends and 30 rounded digits when it does not, for 3000 random cases', () => {
    let ending = 0;
    for (let i = 0; i < 3000; i++) {
      const balance = decimal();
      const reserve = decimal();
      const total = supply();
      const position = toPositionObject({
        pool: POOL,
        lp_currency: LP,
        lp_balance: balance,
        lp_supply: total,
        reserve_base: reserve,
        reserve_counter: null,
        deleted: false,
      });
      const expected = {
        share: decimalQuotient([balance], total),
        base_amount: decimalQuotient([balance, reserve], total),
      };
      expect([balance, reserve, total, position?.share, position?.base_amount]).toEqual([
        balance,
        reserve,
        total,
        expected.share,
        expected.base_amount,
      ]);
      if (quotientEnds([balance, reserve], total)) ending++;
    }
    // the cases cover both kinds
    expect(ending).toBeGreaterThan(200);
    expect(ending).toBeLessThan(2900);
  });
});

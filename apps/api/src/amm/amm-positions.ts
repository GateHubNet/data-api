import BigNumber from 'bignumber.js';

/**
 * The Position of an LP-token balance (`GET /v2/accounts/:address/amm_positions`), under the rules of the other AMM objects
 * (`amm-objects.ts`): flat keys, strings for amounts, a key whose value is unknown left out. In this order:
 *   pool, lp_currency, lp_balance, share, base_amount?, counter_amount?
 *
 * `lp_balance` is the balance as stored, written as a plain decimal. `share` is `lp_balance / lp_supply` and each amount is
 * `lp_balance * reserve / lp_supply` (one division, so one rounding), the pool's `reserve_base` or `reserve_counter` (the
 * pair in the canonical order of the pool: `GET /v2/amm/pools/:pool` names it). They are worked out with decimals, never
 * floats, and written as plain decimals, never in the exponent form:
 *  - a quotient that ends is served whole, however many digits it has (the exact value; a divisor of 17 digits ends after
 *    at most about 60 more decimals);
 *  - a quotient that does not end is rounded (half up) to `POSITION_DIGITS` = 30 significant digits, whatever its size.
 * An amount whose reserve is unknown has no key.
 */

export interface PositionObject {
  pool: string;
  lp_currency: string;
  lp_balance: string;
  share: string;
  base_amount?: string;
  counter_amount?: string;
}

/** The significant digits of a quotient that does not end. */
export const POSITION_DIGITS = 30;

/** What a position is made of: the account's balance of an LP token, and its pool as of the ledger asked for. */
export interface PositionInput {
  pool: string;
  lp_currency: string;
  /** The balance of the account's line, as stored. */
  lp_balance: string;
  /** The supply of LP tokens of the pool; `null` when unknown. */
  lp_supply: string | null;
  reserve_base: string | null;
  reserve_counter: string | null;
  /** The pool had been deleted. */
  deleted: boolean;
}

const TEN = new BigNumber(10);

/** The decimal exponent of the last digit of a number: `1200` is 2, `0.034` is -3. */
const lastDigit = (x: BigNumber): number => (x.e as number) - x.sd() + 1;

/**
 * `n / d` as a plain decimal (neither is 0). The quotient is cut (not rounded) at `places` decimals, and then:
 *  - if the cut value times `d` is `n` again, the quotient ends within those decimals and the cut value is exact;
 *  - if not, it is rounded (half up) to `POSITION_DIGITS` significant digits. It was cut with at least three digits more
 *    than that, and a cut value is below the true one, so the digit it is rounded at decides as the true quotient's does.
 *
 * `places` is the larger of two bounds. A quotient that ends has at most `ceil(log2(10) * sd(d))` decimals once the units of
 * the last digits of `n` and `d` are taken out (the reduced denominator is 2^i 5^j, below the 10^sd(d) of `d`), shifted by
 * the difference of those units. A quotient that does not end needs `POSITION_DIGITS + 3` digits from its first one, which
 * is at the decimal exponent `e(n) - e(d)` or one below. The division is by whole numbers (`dividedToIntegerBy` of `n` scaled
 * by `10^places`), which does not depend on the decimal places BigNumber is configured with, so a quotient of 1e-201 or
 * 1e99 loses no digit.
 */
function quotient(n: BigNumber, d: BigNumber): string {
  const ends = Math.ceil(Math.log2(10) * d.sd()) - (lastDigit(n) - lastDigit(d));
  const significant = POSITION_DIGITS + 3 - ((n.e as number) - (d.e as number));
  const places = Math.max(0, ends, significant);
  const cut = n.times(TEN.pow(places)).dividedToIntegerBy(d).shiftedBy(-places);
  return cut.times(d).isEqualTo(n) ? cut.toFixed() : cut.precision(POSITION_DIGITS).toFixed();
}

/**
 * The Position of an LP-token balance, or `undefined` for a balance that is zero (or no number) and for a pool without a
 * supply (unknown or 0) or a deleted one: those hold nothing.
 */
export function toPositionObject(input: PositionInput): PositionObject | undefined {
  const balance = new BigNumber(input.lp_balance);
  const supply = input.lp_supply === null ? undefined : new BigNumber(input.lp_supply);
  if (balance.isNaN() || balance.isZero()) return undefined;
  if (input.deleted || supply === undefined || supply.isNaN() || supply.isZero()) return undefined;
  const amount = (reserve: string | null): string | undefined => {
    if (reserve === null) return undefined;
    const held = new BigNumber(reserve);
    if (held.isNaN()) return undefined;
    const product = balance.times(held);
    return product.isZero() ? '0' : quotient(product, supply);
  };
  const base = amount(input.reserve_base);
  const counter = amount(input.reserve_counter);
  return {
    pool: input.pool,
    lp_currency: input.lp_currency,
    lp_balance: balance.toFixed(),
    share: quotient(balance, supply),
    ...(base !== undefined && { base_amount: base }),
    ...(counter !== undefined && { counter_amount: counter }),
  };
}

import BigNumber from 'bignumber.js';
import type { LowSideLine } from '../aggregate/token-rules';

/**
 * Generated cases of the token history's rules (issuer analytics, Tasks 2 and 3): lines, state rows and amounts, from a seed,
 * so a failure can be replayed. Test-only: `src/test-utils` is excluded from the build.
 */

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)];

/** The edge amounts of the order key and the exact sums: the ledger's smallest and largest, and two that tie as doubles. */
export const EDGE_AMOUNTS = ['0', '1e-81', '9.999999999999999e80', '9007199254740992', '9007199254740993', '1', '1e40'];

/**
 * A positive ledger amount as plain decimal text, as the trust line parser writes it (`toFixed`): a mantissa of 1 to 16
 * significant digits and an exponent that keeps it inside the ledger's range (1e-81 to 9.999999999999999e95).
 */
export function generatedAmount(rnd: () => number): string {
  const digits = 1 + Math.floor(rnd() * 16);
  let mantissa = String(1 + Math.floor(rnd() * 9));
  for (let i = 1; i < digits; i++) mantissa += String(Math.floor(rnd() * 10));
  // the exponent of the leading digit, from -81 to 95
  const top = -81 + Math.floor(rnd() * 177);
  return new BigNumber(`${mantissa}e${top - (digits - 1)}`).toFixed();
}

const amountOrEdge = (rnd: () => number): string =>
  rnd() < 0.15 ? new BigNumber(pick(rnd, EDGE_AMOUNTS)).toFixed() : generatedAmount(rnd);

/** An LP token's currency: 40 hex digits starting with `03`. */
export const LP_CURRENCY = '03' + 'AB'.repeat(19);

const ACCOUNTS = [
  'rLowAccountAAAAAAAAAAAAAAAAAAAAAAA',
  'rLowAccountBBBBBBBBBBBBBBBBBBBBBBB',
  'rLowAccountCCCCCCCCCCCCCCCCCCCCCCC',
  'rLowAccountDDDDDDDDDDDDDDDDDDDDDDD',
];

/**
 * A line from its low account's side: a balance below, at or above 0, limits of 0 or above, every flag, a deleted node now and
 * then, and an LP currency now and then.
 */
export function generatedLowSideLine(rnd: () => number, ledger_index = 100): LowSideLine {
  const sign = rnd();
  const balance = sign < 0.3 ? '0' : sign < 0.65 ? '-' + amountOrEdge(rnd) : amountOrEdge(rnd);
  const limit = (): string => (rnd() < 0.35 ? '0' : amountOrEdge(rnd));
  const low = pick(rnd, ACCOUNTS);
  let high = pick(rnd, ACCOUNTS);
  if (high === low) high = ACCOUNTS[(ACCOUNTS.indexOf(low) + 1) % ACCOUNTS.length];
  return {
    account: low,
    counterparty: high,
    currency: rnd() < 0.05 ? LP_CURRENCY : pick(rnd, ['USD', 'EUR', '0158415500000000C1F76FF6ECB0BAC600000000']),
    balance: balance === '-0' ? '0' : balance,
    limit: limit(),
    limit_peer: limit(),
    authorized: rnd() < 0.5,
    peer_authorized: rnd() < 0.5,
    freeze: rnd() < 0.5,
    peer_freeze: rnd() < 0.5,
    ledger_index,
    deleted: rnd() < 0.1,
  };
}

/** A `trust_line_states` row of one side of a line: the columns the token side reads. */
export interface StateRowSide {
  account: string;
  counterparty: string;
  currency: string;
  balance: string;
  limit_peer: string;
  freeze: number;
  authorized: number;
  deleted: number;
}

const negatedText = (value: string): string => (value === '0' ? '0' : new BigNumber(value).negated().toFixed());

/** The two `trust_line_states` rows of a line, as the parser writes them: the low account's side, then the high one's. */
export function stateRowsOf(line: LowSideLine): [StateRowSide, StateRowSide] {
  const deleted = line.deleted ? 1 : 0;
  return [
    {
      account: line.account,
      counterparty: line.counterparty,
      currency: line.currency,
      balance: line.balance,
      limit_peer: line.limit_peer,
      freeze: line.freeze ? 1 : 0,
      authorized: line.authorized ? 1 : 0,
      deleted,
    },
    {
      account: line.counterparty,
      counterparty: line.account,
      currency: line.currency,
      balance: negatedText(line.balance),
      limit_peer: line.limit,
      freeze: line.peer_freeze ? 1 : 0,
      authorized: line.peer_authorized ? 1 : 0,
      deleted,
    },
  ];
}

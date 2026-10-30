/**
 * The arithmetic of the native supply (spec 2026-10-24-supply-design.md, 4.2, 4.3 and 5.1): the account ranges the state
 * is read in, the reserves, a pool's native side and the burned drops of a network with a cap. Pure: no read, no write. Every
 * amount is a `bigint` of drops, so no value passes through a float.
 */

/** The native coins the XRP Ledger was made with: 10^17 drops (100 billion XRP). Xahau has no such cap. */
export const NATIVE_CAP_DROPS = 10n ** 17n;

/** The XRPL base58 alphabet, in the order of the standard (not of the bytes). */
const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/**
 * The two characters after the `r` of an account: 58 × 58 = 3,364 pairs of the XRPL alphabet, in the order of the byte values
 * of the characters (`1` to `9`, `A` to `Z`, `a` to `z`), which is the order of `account` in `account_states` (a `String` sorts
 * by bytes). The first is `11` and the last `zz`.
 */
export const SUPPLY_ACCOUNT_PREFIXES: readonly string[] = (() => {
  const byByte = [...XRPL_ALPHABET].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
  return byByte.flatMap((first) => byByte.map((second) => first + second));
})();

/** The prefixes a read of `account_states` covers (spec 4.3): about 105 reads a cycle. */
export const SUPPLY_PREFIXES_PER_READ = 32;

/** A range of account IDs, `lo` included and `hi` left out: `account >= lo AND account < hi`. */
export interface AccountRange {
  lo: string;
  hi: string;
}

/**
 * The key space of accounts cut into 106 ranges of `SUPPLY_PREFIXES_PER_READ` prefixes each (the last holds 4), without a gap
 * or an overlap: range `k` is `['r' + P[32k], 'r' + P[32k + 32])`, except that the first starts at `r` itself and the last ends at
 * `s`, so that an address with a first character `r` is in exactly one of them whatever follows.
 */
export function supplyAccountRanges(): AccountRange[] {
  const ranges: AccountRange[] = [];
  for (let first = 0; first < SUPPLY_ACCOUNT_PREFIXES.length; first += SUPPLY_PREFIXES_PER_READ) {
    const next = SUPPLY_ACCOUNT_PREFIXES[first + SUPPLY_PREFIXES_PER_READ];
    ranges.push({
      lo: first === 0 ? 'r' : `r${SUPPLY_ACCOUNT_PREFIXES[first]}`,
      hi: next === undefined ? 's' : `r${next}`,
    });
  }
  return ranges;
}

/** The reserves the existing accounts must hold: `accounts × base + ownerCount × inc`, all in drops. */
export function reservesDrops(accounts: bigint, ownerCount: bigint, base: bigint, inc: bigint): bigint {
  return accounts * base + ownerCount * inc;
}

/** The columns of an `amm_pools` row that say what a pool holds in the native currency. */
export interface PoolReserves {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  /** The base side's reserve, exact decimal text in whole units (`null`: not known). */
  reserve_base: string | null;
  /** The counter side's reserve, as `reserve_base`. */
  reserve_counter: string | null;
  deleted: boolean;
}

const DROPS_DIGITS = 6;

/** Whole units of the native currency as exact decimal text (`"1.5"`) to drops, with no float on the way. */
function wholeUnitsToDrops(text: string): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  const places = match?.[2]?.replace(/0+$/, '') ?? '';
  if (match === null || places.length > DROPS_DIGITS) {
    throw new Error(`nativeReserveDrops: '${text}' is not a whole number of drops`);
  }
  return BigInt(match[1] + places.padEnd(DROPS_DIGITS, '0'));
}

/**
 * The native currency a pool holds, in drops: its `reserve_base` when the base is the native currency (`native` with no
 * issuer: an issued currency of the same code is not it), else its `reserve_counter` when the counter is, else 0. A pool that is
 * deleted holds nothing, and a native side with no reserve counts as nothing. The reserve is exact decimal text in whole
 * units; a text that is not a whole number of drops throws.
 */
export function nativeReserveDrops(pool: PoolReserves, native: string): bigint {
  if (pool.deleted) return 0n;
  const reserve =
    pool.base_currency === native && pool.base_issuer === ''
      ? pool.reserve_base
      : pool.counter_currency === native && pool.counter_issuer === ''
        ? pool.reserve_counter
        : null;
  return reserve === null ? 0n : wholeUnitsToDrops(reserve);
}

/** The drops the cap lost: `NATIVE_CAP_DROPS − totalCoins` (the XRP Ledger burns fees; it never mints). */
export function burnedFromCap(totalCoins: bigint): bigint {
  return NATIVE_CAP_DROPS - totalCoins;
}

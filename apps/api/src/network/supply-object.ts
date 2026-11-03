import { dropsToNative, MintSums, NetworkSupplyRow } from '@gatehub/data-api-shared';
import type { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import type { KeysetKey } from '../common/pagination';

/**
 * The answer of `GET /v2/network/supply` (spec 5.1): the newest snapshot of `network_supply`, with the keys in the order the spec
 * pins. A part that the snapshot does not have is left out, and `null` is never served.
 *
 * Amounts are exact decimal text in whole units: every figure is summed in `bigint` drops and goes through `dropsToNative` once
 * (the total of XRPL is past 2^53 drops, so no float is made of it). Counts are numbers.
 *  - `circulating` = `total` − `escrowed`, and says what `escrowed` says: the total needs no history, the escrows do.
 *  - `reserves.amount` = `accounts` × `base` + `owner_count` × `increment`: what the accounts must keep, at the reserve values of the
 *    snapshot ledger (the job leaves the values NULL when none is known there, and the part is left out).
 *  - `minted.amount` = `rewards` + `import` + `genesis_mint`, on a network that mints.
 *  - `amm` is there where AMM exists (its column is not NULL).
 *  - `burned` is the column as stored: 10^17 drops less the total on XRPL, which needs no history, and the fees of the indexed ledgers
 *    on Xahau, which have a `coverage`.
 * A part that is read from history ends with its `coverage` (`FeatureCoverageService`): the features it is asked of are
 * `supplyFeaturesOf`'s, and `supplyObject` takes them by name.
 *
 * The answer of `GET /v2/network/supply/minted` (spec 5.2) is here as well: its key orders and the row of a day (`mintedRow`).
 */

/** The keys of the answer, in order. */
export const SUPPLY_KEYS = [
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
] as const;
/** The keys of each part, in order (the amount first, its counts, then `coverage`). */
export const BURNED_KEYS = ['amount', 'coverage'] as const;
export const MINTED_KEYS = ['amount', 'rewards', 'import', 'genesis_mint', 'coverage'] as const;
export const ESCROWED_KEYS = ['amount', 'escrows', 'coverage'] as const;
export const CIRCULATING_KEYS = ['amount', 'coverage'] as const;
export const AMM_KEYS = ['amount', 'pools', 'coverage'] as const;
export const RESERVES_KEYS = ['amount', 'accounts', 'owner_count', 'base', 'increment', 'coverage'] as const;

/** The keys of the answer of `GET /v2/network/supply/minted`, in order: `coverage` right after `result`, the rows last. */
export const MINTED_BODY_KEYS = ['result', 'coverage', 'marker', 'count', 'rows'] as const;
/** The keys of a day of that answer, in order: the day's sum, then its three sources. A row has every key. */
export const MINTED_ROW_KEYS = ['date', 'amount', 'rewards', 'import', 'genesis_mint'] as const;
/**
 * The key of a day, and so its marker: the start of the day in unix seconds. A keyset (what `decodeMarker` checks a marker
 * against), not a key order: it is not one of the `*_KEYS` lists the reference names.
 */
export const MINTED_DAY_KEYSET: KeysetKey[] = [{ column: 'day', type: 'DateTime' }];

/**
 * The coverage of each feature the parts are read from, by the name it is registered under in `COVERAGE_FEATURES`. `escrows`
 * (D5) is the coverage of the escrowed and circulating parts and is always there. `fees` is Xahau's burned (given only on a network
 * that mints: XRPL's burned has none), `amm` the AMM part, `account_states` the reserves and `mints` the minted part.
 */
export interface SupplyCoverages {
  escrows: Coverage;
  fees?: Coverage;
  amm?: Coverage;
  account_states?: Coverage;
  mints?: Coverage;
}

/** The name of a feature the answer reads the coverage of. */
export type SupplyFeature = keyof SupplyCoverages;

export interface BurnedPart {
  amount: string;
  coverage?: Coverage;
}
export interface MintedPart {
  amount: string;
  rewards: string;
  import: string;
  genesis_mint: string;
  coverage: Coverage;
}
export interface EscrowedPart {
  amount: string;
  escrows: number;
  coverage: Coverage;
}
export interface CirculatingPart {
  amount: string;
  coverage: Coverage;
}
export interface AmmPart {
  amount: string;
  pools: number;
  coverage: Coverage;
}
export interface ReservesPart {
  amount: string;
  accounts: number;
  owner_count: number;
  base: string;
  increment: string;
  coverage: Coverage;
}

/** One UTC day of the minted answer: the sum of the three sources, and each source, in whole units of the native currency. */
export interface MintedRow {
  date: string;
  amount: string;
  rewards: string;
  import: string;
  genesis_mint: string;
}

/** The answer of `GET /v2/network/supply/minted`: `marker` is there only when the page has a next one. */
export interface MintedAnswer {
  result: 'success';
  coverage: Coverage;
  marker?: string;
  count: number;
  rows: MintedRow[];
}

export interface SupplyAnswer {
  result: 'success';
  ledger_index: number;
  close_time: string;
  computed_at: string;
  currency: 'XRP' | 'XAH';
  total: string;
  burned: BurnedPart;
  minted?: MintedPart;
  escrowed: EscrowedPart;
  circulating: CirculatingPart;
  amm?: AmmPart;
  reserves?: ReservesPart;
}

/** The drops of the three sources of the minted part, when the snapshot has them (a network that mints). */
function mintedOf(row: NetworkSupplyRow): { rewards: bigint; import: bigint; genesis: bigint } | undefined {
  if (row.minted_rewards === null || row.minted_import === null || row.minted_genesis === null) return undefined;
  return {
    rewards: BigInt(row.minted_rewards),
    import: BigInt(row.minted_import),
    genesis: BigInt(row.minted_genesis),
  };
}

/** The reserve values of the snapshot ledger, in drops, when it has them. */
function reservesOf(row: NetworkSupplyRow): { base: bigint; increment: bigint } | undefined {
  if (row.reserve_base === null || row.reserve_inc === null) return undefined;
  return { base: BigInt(row.reserve_base), increment: BigInt(row.reserve_inc) };
}

/**
 * The features whose coverage the answer for `row` states, one for each part it has that is read from history: `escrows` always,
 * `fees` on a network that mints (`hasMinting`: its burned is a sum over the stored ledgers), `mints` with the minted part, `amm`
 * with the AMM part and `account_states` with the reserves. The service asks these and no others.
 */
export function supplyFeaturesOf(row: NetworkSupplyRow, hasMinting: boolean): SupplyFeature[] {
  const features: SupplyFeature[] = ['escrows'];
  if (hasMinting) features.push('fees');
  if (mintedOf(row) !== undefined) features.push('mints');
  if (row.amm !== null) features.push('amm');
  if (reservesOf(row) !== undefined) features.push('account_states');
  return features;
}

/** The coverage of a feature of a part the row has: a missing one is a bug of the caller, and the part is not served without it. */
function stated(coverages: SupplyCoverages, feature: 'mints' | 'amm' | 'account_states'): Coverage {
  const coverage = coverages[feature];
  if (coverage === undefined) {
    throw new Error(
      `supplyObject: the snapshot has the part read from ${feature}, and no coverage of ${feature} was given`,
    );
  }
  return coverage;
}

/** Drops as the native currency in whole units, exact: `bigint` has no place in `dropsToNative`, its text does. */
const native = (drops: bigint | string | number): string => dropsToNative(drops.toString());

/** The answer for the snapshot `row` of a network whose native currency is `currency`, with the coverage of each part. */
export function supplyObject(row: NetworkSupplyRow, currency: 'XRP' | 'XAH', coverages: SupplyCoverages): SupplyAnswer {
  const escrowed = BigInt(row.escrowed);
  const circulating = BigInt(row.total_coins) - escrowed;
  const minted = mintedOf(row);
  const reserves = reservesOf(row);
  return {
    result: 'success',
    ledger_index: row.ledger_index,
    close_time: fmtTime(row.close_time),
    computed_at: fmtTime(row.computed_at),
    currency,
    total: native(row.total_coins),
    burned: { amount: native(row.burned), ...(coverages.fees && { coverage: coverages.fees }) },
    ...(minted && {
      minted: {
        amount: native(minted.rewards + minted.import + minted.genesis),
        rewards: native(minted.rewards),
        import: native(minted.import),
        genesis_mint: native(minted.genesis),
        coverage: stated(coverages, 'mints'),
      },
    }),
    escrowed: { amount: native(escrowed), escrows: Number(row.escrow_count), coverage: coverages.escrows },
    circulating: { amount: native(circulating), coverage: coverages.escrows },
    ...(row.amm !== null && {
      amm: { amount: native(row.amm), pools: row.amm_pools, coverage: stated(coverages, 'amm') },
    }),
    ...(reserves && {
      reserves: {
        amount: native(BigInt(row.accounts) * reserves.base + BigInt(row.owner_count) * reserves.increment),
        accounts: Number(row.accounts),
        owner_count: Number(row.owner_count),
        base: native(reserves.base),
        increment: native(reserves.increment),
        coverage: stated(coverages, 'account_states'),
      },
    }),
  };
}

/**
 * The row of the UTC day that starts at `dayStart` (unix seconds): `amount` is the sum of the three sources, all added in `bigint`
 * drops and turned to whole units once each (a day's sum can pass 2^53 drops, and no float is made of it).
 */
export function mintedRow(dayStart: number, sums: MintSums): MintedRow {
  return {
    date: fmtTime(dayStart),
    amount: native(sums.rewards + sums.import + sums.genesis_mint),
    rewards: native(sums.rewards),
    import: native(sums.import),
    genesis_mint: native(sums.genesis_mint),
  };
}

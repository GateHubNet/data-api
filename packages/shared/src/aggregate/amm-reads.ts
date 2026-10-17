import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { Asset } from '../query/asset';
import { volumesOf, VolumeSums } from '../query/decimal';
import { exchangeSumsSql, LedgerRange } from '../query/rates.service';

/**
 * The reads the AMM jobs share: which pools a range of ledgers touched, the pair of each pool, and the swaps of the pools
 * through that pair. `amm_daily` (the swaps of each pool, one by one) and the AMM volume (the swaps of each pool, summed) both
 * start here, so that the way they find their rows is written once.
 *
 * No read crosses the pairs (Ruling R-A3): the exchanges are never scanned across the pairs for the swaps. The pools come from
 * the narrow, ledger-ordered `amm_pool_touches` (Ruling R-A14), by a range of its primary key, each with the first ledger of the
 * range it was touched in; their pairs from `amm_pool_states` by the key of the pool and that ledger (two columns of its primary
 * key: about a granule a pool, however busy the pool); their swaps from
 * `exchanges` through the pair key (the four asset columns, then the ledgers, are a range of its primary key) and the
 * `amm_account_set` skip index. Pools are read in chunks of `AMM_CHUNK` (their accounts travel as an array parameter).
 */

/** How many pools one read covers. */
export const AMM_CHUNK = 200;

/** `items` in chunks of at most `size`. */
export function ammChunks<T>(items: readonly T[], size: number = AMM_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * The pools a transaction touched in a range of ledgers (`first` to `last`, both inclusive), each with the first ledger of the
 * range it was touched in (`first_ledger`), from the narrow ledger-ordered `amm_pool_touches`: a range of its primary key,
 * never the state table (ordered by pool) or the exchanges.
 */
export const AMM_TOUCHED_POOLS_SQL = `SELECT amm_account, min(ledger_index) AS first_ledger
  FROM ${Table.AmmPoolTouches}
 WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
 GROUP BY amm_account
 ORDER BY amm_account`;

/**
 * The pair of each of some pools: the assets of the first state row of the pool at `firsts[i]`, the first ledger it was touched
 * in (`first_ledger` of `AMM_TOUCHED_POOLS_SQL`; the arrays are zipped into `(amm_account, ledger_index)` pairs by the server, as
 * the pairs of the swaps are). A pool that was touched in a ledger has a state row in it (`amm_pool_touches` has one row for
 * each), and its pair never changes, so one row is enough; the read is two columns of the primary key of the states, about a
 * granule for each pool however many state rows a busy pool has in the window. The assets are in the canonical pair order, as the
 * exchanges of the pool have them.
 */
export const AMM_POOL_PAIRS_SQL = `SELECT amm_account, base_currency, base_issuer, counter_currency, counter_issuer
  FROM ${Table.AmmPoolStates}
 WHERE (amm_account, ledger_index) IN (SELECT arrayJoin(arrayZip({accounts:Array(String)}, {firsts:Array(UInt32)})))
 ORDER BY amm_account, ledger_index, tx_index
 LIMIT 1 BY amm_account`;

/**
 * Which exchanges are the swaps of some pools in a range of ledgers: the pair of the pool is the start of the primary key of
 * `exchanges` and the ledgers follow it, so the pairs (four arrays of text, zipped back into tuples by the server, as
 * `RatesService.pairSums` does) and the range are a range of the key; `amm_account` is the skip index
 * that leaves out the granules of other pools of a pair. The tuples and the accounts together are a few pairs more than the pools
 * (every pool of the chunk in every pair of the chunk), which the rows of the table never make a difference to: a pool's swaps
 * are in its own pair.
 */
export const AMM_SWAPS_WHERE = `(base_currency, base_issuer, counter_currency, counter_issuer) IN (
       SELECT arrayJoin(arrayZip({base_currencies:Array(String)}, {base_issuers:Array(String)}, {counter_currencies:Array(String)}, {counter_issuers:Array(String)}))
       )
   AND amm_account IN {accounts:Array(String)}
   AND ledger_index BETWEEN {first:UInt32} AND {last:UInt32}`;

/** The pair of a pool, `[base currency, base issuer, counter currency, counter issuer]` as `exchanges` stores it. */
export type PairColumns = readonly [string, string, string, string];

/** The parameters of a read of `AMM_SWAPS_WHERE`: the distinct pairs of the pools, the pools, the range of ledgers. */
export function ammSwapParams(
  pools: ReadonlyArray<{ account: string; pair: PairColumns }>,
  ledgers: { first: number; last: number },
): Record<string, unknown> {
  const pairs = [...new Map(pools.map((p) => [p.pair.join('\0'), p.pair])).values()];
  return {
    accounts: pools.map((p) => p.account),
    base_currencies: pairs.map((p) => p[0]),
    base_issuers: pairs.map((p) => p[1]),
    counter_currencies: pairs.map((p) => p[2]),
    counter_issuers: pairs.map((p) => p[3]),
    first: ledgers.first,
    last: ledgers.last,
  };
}

/**
 * The swaps of some pools summed per pool: every swap once (`LIMIT 1 BY` its key), the native legs of 0.0005 or less left out,
 * the same columns and the same rule as the sums of the trades of a pair (`exchangeSumsSql`).
 */
export const AMM_POOL_SUMS_SQL = exchangeSumsSql(AMM_SWAPS_WHERE, ['amm_account']);

/** The swaps of one pool in a range of ledgers, summed: `count` of them, the volumes of the base and of the counter. */
export interface AmmPoolVolume {
  account: string;
  base: Asset;
  counter: Asset;
  count: number;
  baseVolume: BigNumber;
  counterVolume: BigNumber;
}

interface PairRow {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
}

interface SumsRow extends VolumeSums {
  amm_account: string;
}

const assetOf = (currency: string, issuer: string): Asset => (issuer ? { currency, issuer } : { currency });

/**
 * The volume of the swaps of every pool in a range of ledgers (the committed ledgers of a window of time: the caller resolves
 * the window from `ledgers`), the pools that have any swap above the native dust, sorted by account. The pools are the ones the
 * touches name, read in chunks of `AMM_CHUNK`: for each chunk the pairs of the pools and then their swaps in one read.
 */
export async function ammPoolVolumes(ch: ClickHouseService, range: LedgerRange): Promise<AmmPoolVolume[]> {
  const ledgers = { first: range.min, last: range.max };
  const touched = await ch.query<{ amm_account: string; first_ledger: number | string }>(
    AMM_TOUCHED_POOLS_SQL,
    ledgers,
  );
  const out: AmmPoolVolume[] = [];
  for (const chunk of ammChunks(touched)) {
    const pairs = await ch.query<PairRow>(AMM_POOL_PAIRS_SQL, {
      accounts: chunk.map((row) => row.amm_account),
      firsts: chunk.map((row) => Number(row.first_ledger)),
    });
    if (pairs.length === 0) continue;
    const pools = pairs.map((p) => ({
      account: p.amm_account,
      pair: [p.base_currency, p.base_issuer, p.counter_currency, p.counter_issuer] as PairColumns,
    }));
    const sums = await ch.query<SumsRow>(AMM_POOL_SUMS_SQL, ammSwapParams(pools, ledgers));
    const byAccount = new Map(pairs.map((p) => [p.amm_account, p]));
    for (const row of sums) {
      const pair = byAccount.get(row.amm_account);
      // a group of dust only has no trade that counts
      if (!pair || Number(row.n) === 0) continue;
      const { base, counter } = volumesOf(row);
      out.push({
        account: row.amm_account,
        base: assetOf(pair.base_currency, pair.base_issuer),
        counter: assetOf(pair.counter_currency, pair.counter_issuer),
        count: Number(row.n),
        baseVolume: base,
        counterVolume: counter,
      });
    }
  }
  return out.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

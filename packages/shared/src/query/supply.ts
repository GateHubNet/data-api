import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { NetworkSupplyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';

/**
 * The reads of the supply that the `supply` job and the api share (spec 2026-10-24-supply-design.md, 3): the newest snapshot of
 * `network_supply` and the minted drops by source. Every value is bound as a query parameter, every sum is read as text so that no
 * amount passes through a float, and nothing is `FINAL`: a table that can hold a row twice is read by its key, in order, with
 * `LIMIT 1 BY`.
 */

/** The ledgers one read of the mint tables covers: one partition (`PARTITION BY intDiv(ledger_index, 1000000)`). */
export const SUPPLY_MINT_SLICE_LEDGERS = 1_000_000;

/**
 * The ledgers before a slice that its claims are read from: a reward's `ClaimReward` is at most 5 ledgers before the mint (a
 * recorded fact); the margin is 256, so that a slower hook still classifies.
 */
export const SUPPLY_PARENT_LEDGERS = 256;

/** Minted drops by source: the rewards (the parent is a `ClaimReward`), the imports, and the genesis mints (the rest). */
export interface MintSums {
  rewards: bigint;
  import: bigint;
  genesis_mint: bigint;
}

/** `[from, to]` cut at the multiples of `SUPPLY_MINT_SLICE_LEDGERS`: `[[from, 999999], [1000000, 1999999], …, […, to]]`. */
export function mintSlices(from: number, to: number): Array<[number, number]> {
  const slices: Array<[number, number]> = [];
  for (let start = from; start <= to; ) {
    const end = Math.min(to, (Math.floor(start / SUPPLY_MINT_SLICE_LEDGERS) + 1) * SUPPLY_MINT_SLICE_LEDGERS - 1);
    slices.push([start, end]);
    start = end + 1;
  }
  return slices;
}

const noMints = (): MintSums => ({ rewards: 0n, import: 0n, genesis_mint: 0n });

/** The claims whose hashes mark a mint as a reward: every `ClaimReward` of the ledgers, whatever its result. */
const CLAIMS = `(SELECT tx_hash FROM ${Table.RewardClaims} WHERE ledger_index BETWEEN {claimsFrom:UInt32} AND {to:UInt32})`;

/**
 * The genesis mints of a slice, by source. A reward is a mint whose `parent_tx_hash` is a claim; a mint without `EmitDetails` has
 * an empty parent, which is none, so it is a genesis mint. The inner select keeps the first row of each key (the table can hold a
 * row twice until a merge), in key order, so the read is the slice's rows.
 */
const genesisMintsSql = (byDay: boolean): string => `
SELECT ${byDay ? 'toString(toDate(close_time)) AS day, ' : ''}toString(sumIf(amount, parent_tx_hash IN ${CLAIMS})) AS rewards,
       toString(sumIf(amount, parent_tx_hash NOT IN ${CLAIMS})) AS genesis_mint
FROM (SELECT ${byDay ? 'close_time, ' : ''}amount, parent_tx_hash FROM ${Table.GenesisMints}
       WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}
       ORDER BY ledger_index, tx_index, mint_index LIMIT 1 BY ledger_index, tx_index, mint_index)${byDay ? '\nGROUP BY day' : ''}`;

/** The imports of a slice: the minted drops of each, deduplicated by `(ledger_index, tx_index)`. */
const importsSql = (byDay: boolean): string => `
SELECT ${byDay ? 'toString(toDate(close_time)) AS day, ' : ''}toString(sum(minted)) AS import
FROM (SELECT ${byDay ? 'close_time, ' : ''}minted FROM ${Table.Imports}
       WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}
       ORDER BY ledger_index, tx_index LIMIT 1 BY ledger_index, tx_index)${byDay ? '\nGROUP BY day' : ''}`;

interface GenesisRead {
  day?: string;
  rewards: string;
  genesis_mint: string;
}

interface ImportRead {
  day?: string;
  import: string;
}

/**
 * The drops minted over the ledgers `[from, to]`, by source: in total, or for each UTC day that has a mint (`YYYY-MM-DD`, from
 * the ledger's close time, in ascending order). The ledgers are read in the slices of `mintSlices`, one partition each, so the claims
 * a read builds are one slice's and the 256 ledgers before it. Callers cap `to` at the committed head. A range of no ledger
 * answers zero (or no day).
 */
export async function mintSums(ch: ClickHouseService, from: number, to: number, byDay: false): Promise<MintSums>;
export async function mintSums(
  ch: ClickHouseService,
  from: number,
  to: number,
  byDay: true,
): Promise<Map<string, MintSums>>;
export async function mintSums(
  ch: ClickHouseService,
  from: number,
  to: number,
  byDay: boolean,
): Promise<MintSums | Map<string, MintSums>> {
  const total = noMints();
  const days = new Map<string, MintSums>();
  /** The sums a row of `day` adds to: the one total, or the day's (created at its first row). */
  const sumsOf = (day: string | undefined): MintSums => {
    if (!byDay || day === undefined) return total;
    let sums = days.get(day);
    if (sums === undefined) days.set(day, (sums = noMints()));
    return sums;
  };

  for (const [sliceFrom, sliceTo] of mintSlices(from, to)) {
    const params = { from: sliceFrom, to: sliceTo, claimsFrom: Math.max(0, sliceFrom - SUPPLY_PARENT_LEDGERS) };
    const [genesis, imports] = await Promise.all([
      ch.query<GenesisRead>(genesisMintsSql(byDay), params),
      ch.query<ImportRead>(importsSql(byDay), params),
    ]);
    for (const row of genesis) {
      const sums = sumsOf(row.day);
      sums.rewards += BigInt(row.rewards);
      sums.genesis_mint += BigInt(row.genesis_mint);
    }
    for (const row of imports) sumsOf(row.day).import += BigInt(row.import);
  }

  if (!byDay) return total;
  return new Map([...days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The newest snapshot: the highest `ledger_index` and, within it, the highest `version`, or `undefined` before the first. The
 * `UInt64` columns are read as text and times as unix seconds, a `NULL` stays `NULL`.
 *
 * Two reads, each of one granule at the end of the key: the newest ledger (`ORDER BY ledger_index DESC LIMIT 1`), then every
 * version of it by the key (a handful of rows: one for each time the cycle was redone at that ledger), of which the highest is
 * taken here, as a number. One read, `ORDER BY ledger_index DESC, version DESC LIMIT 1`, would read the whole part: `version`
 * is not in the key, so the read in order cannot stop at the first row. Nor does the second read order by `version` in SQL: a
 * top row of a `SELECT *` is read twice (ClickHouse reads the order columns first, then the others).
 *
 * `version` is compared as the number it is: as the text it is returned in, `10` would sort below `9`.
 */
export async function newestSnapshot(ch: ClickHouseService): Promise<NetworkSupplyRow | undefined> {
  const newest = await ch.queryOne<{ ledger_index: number }>(
    `SELECT ledger_index FROM ${Table.NetworkSupply} ORDER BY ledger_index DESC LIMIT 1`,
  );
  if (newest === undefined) return undefined;
  const versions = await ch.query<NetworkSupplyRow>(
    `SELECT ledger_index,
            toUnixTimestamp(close_time) AS close_time, toUnixTimestamp(started_at) AS started_at,
            toUnixTimestamp(computed_at) AS computed_at,
            toString(total_coins) AS total_coins, toString(burned) AS burned, toString(escrowed) AS escrowed,
            toString(escrow_count) AS escrow_count, toString(amm) AS amm, amm_pools,
            toString(reserve_base) AS reserve_base, toString(reserve_inc) AS reserve_inc,
            toString(accounts) AS accounts, toString(owner_count) AS owner_count,
            toString(minted_rewards) AS minted_rewards, toString(minted_import) AS minted_import,
            toString(minted_genesis) AS minted_genesis, toString(version) AS version
       FROM ${Table.NetworkSupply} WHERE ledger_index = {ledger:UInt32}`,
    { ledger: newest.ledger_index },
  );
  return versions.reduce<NetworkSupplyRow | undefined>(
    (best, row) => (best === undefined || BigInt(row.version) > BigInt(best.version) ? row : best),
    undefined,
  );
}

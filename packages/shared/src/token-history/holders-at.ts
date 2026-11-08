import type { TokenKey } from '../aggregate/token-rules';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { exactSumColumns, exactSumOf } from '../query/decimal';
import type { TokenSide } from './token-side';

/**
 * Holders and totals of a token at a ledger N (spec 3.1, 3.2): the newest checkpoint at or before N, folded with the token's
 * changes after it. The same read serves the head and any indexed ledger, the api, the worker and the build.
 */

/** A counting line of a token at a ledger: its state, its first and newest activity, and the order key of its amount. */
export interface HolderAt extends Omit<TokenSide, 'issuer' | 'currency'> {
  first_ledger: number;
  last_ledger: number;
  exp: number;
  /** `UInt64`, as text. */
  mant: string;
}

/** The ledger of the token's newest checkpoint at or before `n` in generation `g`, 0 when none (an empty checkpoint at 0). */
export async function checkpointAt(ch: ClickHouseService, g: number, token: TokenKey, n: number): Promise<number> {
  const row = await ch.queryOne<{ cp: number | string }>(
    `SELECT max(checkpoint_ledger) AS cp FROM ${Table.TokenCheckpointHeads}
      WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
        AND checkpoint_ledger <= {n:UInt32}`,
    { g, issuer: token.issuer, currency: token.currency, n },
  );
  return Number(row?.cp ?? 0);
}

/** A first ledger that no line has: `min` of the candidates leaves it out. */
const NO_LEDGER = 4_294_967_295;

/**
 * Spec 3.1 as SQL: the counting lines of a token at `{n}`, one row per holder, unsorted, from the rows of its checkpoint at `{cp}`
 * (0: none) and its changes in `({cp}, {n}]`. Each holder's state is the newest of those rows (a checkpoint row ranks as
 * `(cp, 0, 0)`); `first_ledger` is the checkpoint's or else the first change where the line counted, `last_ledger` the newest
 * change. Both sources are key ranges of their tables. A row stored twice changes nothing here (`argMax`, `min` and `max` of the
 * same values), so no source needs deduplicating. Parameters: `{g}`, `{issuer}`, `{currency}`, `{cp}`, `{n}`, and with
 * `holderFilter: 'in'` `{holders:Array(String)}`. Columns: `holder, amount, counted, limit, frozen, authorized, escrowed, exp, mant,
 * first_ledger, last_ledger`. Ready to be wrapped for ordering, paging, grouping or an `INSERT … SELECT`.
 */
export function holdersAtSql(opts: { holderFilter?: 'in' } = {}): string {
  const holders = opts.holderFilter === 'in' ? ' AND holder IN {holders:Array(String)}' : '';
  return `SELECT holder,
       argMax(state, rank) AS s,
       tupleElement(s, 1) AS amount,
       tupleElement(s, 2) AS counted,
       tupleElement(s, 3) AS \`limit\`,
       tupleElement(s, 4) AS frozen,
       tupleElement(s, 5) AS authorized,
       tupleElement(s, 6) AS escrowed,
       tupleElement(s, 7) AS exp,
       tupleElement(s, 8) AS mant,
       min(first_candidate) AS first_ledger,
       max(last_candidate) AS last_ledger
  FROM (
    SELECT holder, tuple(checkpoint_ledger, toUInt32(0), toUInt16(0)) AS rank,
           tuple(amount, toUInt8(1), \`limit\`, frozen, authorized, escrowed, order_exp, order_mant) AS state,
           first_ledger AS first_candidate, last_ledger AS last_candidate
      FROM ${Table.TokenCheckpoints}
     WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
       AND checkpoint_ledger = {cp:UInt32}${holders}
    UNION ALL
    SELECT holder, tuple(ledger_index, tx_index, node_index) AS rank,
           tuple(amount_after, counted_after, \`limit\`, frozen, authorized, escrowed, order_exp, order_mant) AS state,
           if(counted_after = 1, ledger_index, toUInt32(${NO_LEDGER})) AS first_candidate, ledger_index AS last_candidate
      FROM ${Table.TokenHolderChanges}
     WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
       AND ledger_index > {cp:UInt32} AND ledger_index <= {n:UInt32}${holders}
  )
 GROUP BY holder
HAVING counted = 1`;
}

interface HolderRead {
  holder: string;
  amount: string;
  counted: number;
  limit: string;
  frozen: number;
  authorized: number;
  escrowed: string;
  exp: number;
  mant: string;
  first_ledger: number | string;
  last_ledger: number | string;
}

/** Every counting line of a token at `n` in generation `g`, unsorted (or only those of `opts.holders`). */
export async function holdersAt(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  n: number,
  opts: { holders?: string[] } = {},
): Promise<HolderAt[]> {
  const cp = await checkpointAt(ch, g, token, n);
  const rows = await ch.query<HolderRead>(
    `SELECT holder, amount, counted, \`limit\`, frozen, authorized, escrowed, exp, toString(mant) AS mant, first_ledger, last_ledger
       FROM (${holdersAtSql({ holderFilter: opts.holders === undefined ? undefined : 'in' })})`,
    { g, issuer: token.issuer, currency: token.currency, cp, n, ...(opts.holders && { holders: opts.holders }) },
  );
  return rows.map((r) => ({
    holder: r.holder,
    amount: r.amount,
    counted: r.counted === 1,
    limit: r.limit,
    frozen: r.frozen === 1,
    authorized: r.authorized === 1,
    escrowed: r.escrowed,
    first_ledger: Number(r.first_ledger),
    last_ledger: Number(r.last_ledger),
    exp: r.exp,
    mant: r.mant,
  }));
}

/** A token's totals at a ledger: its supply (exact text), holders and trust lines, and its first and newest change, when it has any. */
export interface TotalsAt {
  supply: string;
  holders: number;
  trust_lines: number;
  first_ledger?: number;
  last_ledger?: number;
}

/** The token's changes in `({cp}, {n}]`, each once (`LIMIT 1 BY` its key): the source of the totals' sums. */
const CHANGES_AFTER_SQL = `SELECT amount_before, amount_after, counted_before, counted_after
  FROM ${Table.TokenHolderChanges}
 WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
   AND ledger_index > {cp:UInt32} AND ledger_index <= {n:UInt32}
 LIMIT 1 BY ledger_index, tx_index, node_index, holder`;

/**
 * Spec 3.2: a token's totals at `n` without the fold. The supply is the checkpoint head's plus `Σ(amount_after − amount_before)` over
 * the changes after it, holders and trust lines the head's counts plus the sums of `(amount_after > 0) − (amount_before > 0)` and
 * `counted_after − counted_before`. The sums are exact (`exactSumOf`): when an amount does not fit the decimal, the same rows are
 * summed in BigNumber, and `onUnfit` (the caller's counter or log) is told.
 */
export async function totalsAt(
  ch: ClickHouseService,
  g: number,
  token: TokenKey,
  n: number,
  o: { onUnfit?: () => void } = {},
): Promise<TotalsAt> {
  const cp = await checkpointAt(ch, g, token, n);
  const params = { g, issuer: token.issuer, currency: token.currency, cp, n };
  const [head, sums, edges] = await Promise.all([
    cp === 0
      ? Promise.resolve(undefined)
      : ch.queryOne<{ supply: string; holders: string; trust_lines: string; first_ledger: number }>(
          `SELECT supply, toString(holders) AS holders, toString(trust_lines) AS trust_lines, first_ledger
             FROM ${Table.TokenCheckpointHeads}
            WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
              AND checkpoint_ledger = {cp:UInt32}
            LIMIT 1`,
          params,
        ),
    ch.queryOne<{
      after_exact: string | null;
      after_unfit: number;
      before_exact: string | null;
      before_unfit: number;
      holders: string;
      trust_lines: string;
    }>(
      `SELECT ${exactSumColumns('amount_after', 'after')}, ${exactSumColumns('amount_before', 'before')},
              toString(sum(toInt64(amount_after != '0') - toInt64(amount_before != '0'))) AS holders,
              toString(sum(toInt64(counted_after) - toInt64(counted_before))) AS trust_lines
         FROM (${CHANGES_AFTER_SQL})`,
      params,
    ),
    ch.queryOne<{ first_ledger: number | null; last_ledger: number | null }>(
      `SELECT (SELECT ledger_index FROM ${Table.TokenHolderChanges}
                WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
                  AND ledger_index <= {n:UInt32}
                ORDER BY ledger_index LIMIT 1) AS first_ledger,
              (SELECT ledger_index FROM ${Table.TokenHolderChanges}
                WHERE generation = {g:UInt32} AND issuer = {issuer:String} AND currency = {currency:String}
                  AND ledger_index <= {n:UInt32}
                ORDER BY ledger_index DESC LIMIT 1) AS last_ledger`,
      params,
    ),
  ]);
  const column = (name: 'amount_after' | 'amount_before') => async (): Promise<string[]> => {
    o.onUnfit?.();
    return (await ch.query<{ amount: string }>(`SELECT ${name} AS amount FROM (${CHANGES_AFTER_SQL})`, params)).map(
      (r) => r.amount,
    );
  };
  const after = await exactSumOf(sums?.after_exact ?? null, Number(sums?.after_unfit ?? 0), column('amount_after'));
  const before = await exactSumOf(sums?.before_exact ?? null, Number(sums?.before_unfit ?? 0), column('amount_before'));
  const supply = after.minus(before).plus(head?.supply ?? 0);
  const totals: TotalsAt = {
    supply: supply.isZero() ? '0' : supply.toFixed(),
    holders: Number(head?.holders ?? 0) + Number(sums?.holders ?? 0),
    trust_lines: Number(head?.trust_lines ?? 0) + Number(sums?.trust_lines ?? 0),
  };
  const first = head?.first_ledger ?? edges?.first_ledger;
  if (first != null && Number(first) > 0) totals.first_ledger = Number(first);
  if (edges?.last_ledger != null && Number(edges.last_ledger) > 0) totals.last_ledger = Number(edges.last_ledger);
  return totals;
}

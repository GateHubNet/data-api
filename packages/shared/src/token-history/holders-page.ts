import type { TokenKey } from '../aggregate/token-rules';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { checkpointAt, holdersAtSql } from './holders-at';
import { orderKeyOf } from './order-key';

/** A holder of a page of `/v2/tokens/{token}/holders` once it reads the token history (spec 5.5). */
export interface HolderOfPage {
  /** The holder's place by balance over the whole set, the largest first, then by address. */
  rank: number;
  holder: string;
  /** The amount; an MPT's escrowed part included. */
  balance: string;
  limit: string;
  frozen: boolean;
  authorized: boolean;
  escrowed: string;
  first_ledger: number;
  last_ledger: number;
}

/**
 * A page of a token's holders at `n` (spec 5.5), `limit + 1` rows at most so that the caller can tell there is more: the holders
 * (amount above 0) by the exact order key, the largest first and then by address (`descending`), or the reverse; after the holder
 * `after`, whose balance's order key the keyset compares. `rank` is the place in the largest-first order over the whole set, whatever
 * the page and the direction. Each page folds the token at `n` (`holdersAtSql`).
 */
export async function holdersPage(
  ch: ClickHouseService,
  g: number,
  token: TokenKey & { kind: 'issued' | 'mpt' },
  n: number,
  o: { descending: boolean; after?: { balance: string; holder: string }; limit: number },
): Promise<HolderOfPage[]> {
  const cp = await checkpointAt(ch, g, token, n);
  const key = o.after === undefined ? undefined : orderKeyOf(o.after.balance, token.kind);
  // largest first: (exp, mant) down, holder up; the reverse order is the exact reverse
  const keyset =
    key === undefined
      ? ''
      : o.descending
        ? `AND ((exp, mant) < ({exp:Int16}, {mant:UInt64}) OR ((exp, mant) = ({exp:Int16}, {mant:UInt64}) AND holder > {holder:String}))`
        : `AND ((exp, mant) > ({exp:Int16}, {mant:UInt64}) OR ((exp, mant) = ({exp:Int16}, {mant:UInt64}) AND holder < {holder:String}))`;
  const order = o.descending ? 'exp DESC, mant DESC, holder ASC' : 'exp ASC, mant ASC, holder DESC';
  const rows = await ch.query<{
    rank: number | string;
    holder: string;
    amount: string;
    limit: string;
    frozen: number;
    authorized: number;
    escrowed: string;
    first_ledger: number | string;
    last_ledger: number | string;
  }>(
    `SELECT rank, holder, amount, \`limit\`, frozen, authorized, escrowed, first_ledger, last_ledger
       FROM (SELECT *, row_number() OVER (ORDER BY exp DESC, mant DESC, holder ASC) AS rank
               FROM (${holdersAtSql()}) WHERE amount != '0')
      WHERE TRUE ${keyset}
      ORDER BY ${order}
      LIMIT {limit:UInt32}`,
    {
      g,
      issuer: token.issuer,
      currency: token.currency,
      cp,
      n,
      limit: o.limit + 1,
      ...(key !== undefined && { exp: key.exp, mant: key.mant.toString(), holder: o.after!.holder }),
    },
  );
  return rows.map((r) => ({
    rank: Number(r.rank),
    holder: r.holder,
    balance: r.amount,
    limit: r.limit,
    frozen: Number(r.frozen) === 1,
    authorized: Number(r.authorized) === 1,
    escrowed: r.escrowed,
    first_ledger: Number(r.first_ledger),
    last_ledger: Number(r.last_ledger),
  }));
}

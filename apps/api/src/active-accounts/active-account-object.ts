import { sumOf, VolumeSums } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtMillis } from '../common/format';
import { ExchangeObject, StoredExchange, toExchangeObject } from '../exchanges/exchange-object';

/** The role of an account in the exchanges of a group, as the exchange is stored. */
export const BUYER = 0;
export const SELLER = 1;

/**
 * What the query reads: the exchanges of one account in one role (`BUYER`: the account is the buyer of the stored
 * exchange, `SELLER`: its seller), with their count and the sums of their amounts (`volumeColumns`), in the stored
 * orientation of the pair. `first_pos` is the `(ledger_index, tx_index, node_index)` of the first of them.
 */
export interface AccountGroup extends VolumeSums {
  account: string;
  role: typeof BUYER | typeof SELLER;
  first_pos: [number, number, number];
}

/** What an account bought or sold: the volumes as text, as the original's `toString()` of a number wrote them. */
export interface ActiveSide {
  base_volume: string;
  counter_volume: string;
  count: number;
}

/** The exchange of an account as `activeAccounts.js` served it: the exchange of the API without its pair fields. */
export type ActiveExchange = Omit<
  ExchangeObject,
  'base_currency' | 'base_issuer' | 'counter_currency' | 'counter_issuer'
>;

/** An account of the answer, with the keys in the order of `organizeData` of the original. */
export interface ActiveAccount {
  buy: ActiveSide;
  sell: ActiveSide;
  account: string;
  base_volume: string;
  counter_volume: string;
  count: number;
  /** Only with `include_exchanges`: last, as the original added it. */
  exchanges?: ActiveExchange[];
}

/** The volumes and counts of a group, in the orientation of the pair as it was asked for. */
interface Oriented {
  n: number;
  base: string | null;
  counter: string | null;
  base_f: number | null;
  counter_f: number | null;
  unfit: number;
  /** `(ledger_index, tx_index, node_index, nth)`: where in the scan the account is first met. */
  pos: number[];
}

interface Entry {
  account: string;
  buy?: Oriented;
  sell?: Oriented;
}

const ZERO_SIDE: ActiveSide = { base_volume: '0', counter_volume: '0', count: 0 };

function sideOf(g: Oriented | undefined): ActiveSide {
  if (g === undefined) return { ...ZERO_SIDE };
  return {
    base_volume: sumOf(g.unfit, g.base, g.base_f).toString(),
    counter_volume: sumOf(g.unfit, g.counter, g.counter_f).toString(),
    count: g.n,
  };
}

/** Lexicographic order of two positions. */
function comparePos(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The accounts of a pair from the groups of `(account, role)`, as `organizeData` of the original made them from the
 * exchanges.
 *
 * The original walked the exchanges in key order and, for each, added it to its seller (`sell`) and to its buyer (`buy`),
 * the seller first. A pair asked for the other way round than it is stored had its exchanges inverted before that
 * (`invertPair`: the amounts, the buyer and the seller swap), so the stored buyer is the seller there. An account is
 * both sides of a trade with itself, and is counted on both.
 *
 * The accounts are sorted by base volume, the largest first; equal volumes keep the order in which the walk first met
 * the accounts (the sort of the original is stable and its accounts were in the order of insertion), which the first
 * position of each group gives: the stored exchange, then the seller before the buyer.
 *
 * The volumes are exact (see `sumOf`). The volumes of an account are the sums of its two sides, and fall back to the
 * Float64 sums when either side has an amount the exact sums cannot hold. `exchanges` is the number of exchanges: each
 * is in the groups of its buyer and of its seller.
 */
export function toActiveAccounts(
  groups: AccountGroup[],
  inverted: boolean,
): { accounts: ActiveAccount[]; exchanges: number } {
  const entries = new Map<string, Entry>();
  let rows = 0;
  for (const g of groups) {
    rows += g.n;
    // the buyer of the stored exchange buys, unless the pair is asked for the other way round
    const side: 'buy' | 'sell' = (g.role === BUYER) !== inverted ? 'buy' : 'sell';
    const oriented: Oriented = {
      n: g.n,
      base: inverted ? g.counter_sum : g.base_sum,
      counter: inverted ? g.base_sum : g.counter_sum,
      base_f: inverted ? g.counter_sum_f : g.base_sum_f,
      counter_f: inverted ? g.base_sum_f : g.counter_sum_f,
      unfit: g.unfit,
      pos: [...g.first_pos, side === 'sell' ? 0 : 1],
    };
    let entry = entries.get(g.account);
    if (!entry) entries.set(g.account, (entry = { account: g.account }));
    entry[side] = oriented;
  }

  const total = (e: Entry, exact: 'base' | 'counter', float: 'base_f' | 'counter_f'): BigNumber =>
    sumOf(
      (e.buy?.unfit ?? 0) + (e.sell?.unfit ?? 0),
      new BigNumber(e.buy?.[exact] ?? 0).plus(e.sell?.[exact] ?? 0).toFixed(),
      (e.buy?.[float] ?? 0) + (e.sell?.[float] ?? 0),
    );

  const list = [...entries.values()].map((e) => ({
    e,
    base: total(e, 'base', 'base_f'),
    counter: total(e, 'counter', 'counter_f'),
    pos: [e.buy, e.sell]
      .filter((g): g is Oriented => g !== undefined)
      .map((g) => g.pos)
      .sort(comparePos)[0],
  }));
  list.sort((a, b) => b.base.comparedTo(a.base) || comparePos(a.pos, b.pos));

  return {
    accounts: list.map(({ e, base, counter }) => ({
      buy: sideOf(e.buy),
      sell: sideOf(e.sell),
      account: e.account,
      base_volume: base.toString(),
      counter_volume: counter.toString(),
      count: (e.buy?.n ?? 0) + (e.sell?.n ?? 0),
    })),
    exchanges: rows / 2,
  };
}

const PAIR_FIELDS = new Set(['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer']);

/**
 * The exchange as `activeAccounts.js` attached it to an account: the exchange of the API (`toExchangeObject`, the keys of
 * the HBase row of the original) without the four fields of the pair, which `hbase.getExchanges` deleted from its rows
 * and this route did not set again, and with `executed_time` as `toISOString()` writes it, to the millisecond. The
 * pair asked for the other way round is inverted.
 */
export function toActiveExchange(row: StoredExchange, inverted: boolean): ActiveExchange {
  return Object.fromEntries(
    Object.entries(toExchangeObject(row, inverted))
      .filter(([key]) => !PAIR_FIELDS.has(key))
      .map(([key, value]) => [key, key === 'executed_time' ? fmtMillis(row.close_time) : value]),
  ) as unknown as ActiveExchange;
}

/**
 * Gives every account its `exchanges`: for each exchange, in the order given, first the list of its seller and then the
 * list of its buyer, the same object in both (a trade of an account with itself is twice in its list, as in the
 * original). Seller and buyer are those of the pair as asked for.
 */
export function attachExchanges(accounts: ActiveAccount[], rows: StoredExchange[], inverted: boolean): void {
  const byName = new Map(accounts.map((a) => [a.account, a]));
  for (const a of accounts) a.exchanges = [];
  for (const row of rows) {
    const exchange = toActiveExchange(row, inverted);
    byName.get(exchange.seller)?.exchanges?.push(exchange);
    byName.get(exchange.buyer)?.exchanges?.push(exchange);
  }
}

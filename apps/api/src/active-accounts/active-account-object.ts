import { ExchangesRow, sumOf, VolumeSums } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtMillis } from '../common/format';
import { EXCHANGE_COLUMNS, StoredExchange, toExchangeObject } from '../exchanges/exchange-object';

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

/**
 * The exchange of an account as `activeAccounts.js` served it: the HBase row after `formatExchanges`, as `GET
 * /v2/exchanges` serves it but with the four fields of the pair missing (`formatExchanges` deletes them and this route
 * does not set them again) and with the `client` (that route deletes it, this one deletes only the row key and the
 * time). The keys come in the order of the row: the columns of the `d` family, then those of the `f` family, each sorted
 * by name. A field the exchange does not have is left out.
 */
export interface ActiveExchange {
  base_amount: string;
  counter_amount: string;
  node_index: number;
  /** Counter per base, eight significant digits. */
  rate: string;
  tx_index: number;
  autobridged_currency?: string;
  autobridged_issuer?: string;
  buyer: string;
  /** What the importer recorded as the client of the transaction, when it knew it. */
  client?: string;
  /** `YYYY-MM-DDTHH:mm:ss.SSSZ`, the close time of the ledger. */
  executed_time: string;
  ledger_index: number;
  offer_sequence: number;
  provider: string;
  seller: string;
  taker: string;
  tx_hash: string;
  tx_type: string;
  /** The pool, on a swap against an AMM pool: the last key, and there only for a swap (see `ExchangeObject`). */
  amm_account?: string;
}

/** The columns of `exchanges` this route reads for the exchanges of the accounts: those of the API, and the client. */
export const ACTIVE_EXCHANGE_COLUMNS = `${EXCHANGE_COLUMNS}, client`;

/** A row of `exchanges` as `ACTIVE_EXCHANGE_COLUMNS` reads it. */
export type StoredActiveExchange = StoredExchange & Pick<ExchangesRow, 'client'>;

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

/**
 * The exchange as `activeAccounts.js` attached it to an account (see `ActiveExchange`): the exchange of the API
 * (`toExchangeObject`) without the pair, with the client and with `executed_time` as `toISOString()` writes it, to the
 * millisecond. The pair asked for the other way round is inverted (amounts, buyer, seller, rate); the client is of the
 * transaction and is the same from both sides.
 */
export function toActiveExchange(row: StoredActiveExchange, inverted: boolean): ActiveExchange {
  const e = toExchangeObject(row, inverted);
  return {
    base_amount: e.base_amount,
    counter_amount: e.counter_amount,
    node_index: e.node_index,
    rate: e.rate,
    tx_index: e.tx_index,
    ...(e.autobridged_currency !== undefined && { autobridged_currency: e.autobridged_currency }),
    ...(e.autobridged_issuer !== undefined && { autobridged_issuer: e.autobridged_issuer }),
    buyer: e.buyer,
    ...(row.client !== null && { client: row.client }),
    executed_time: fmtMillis(row.close_time),
    ledger_index: e.ledger_index,
    offer_sequence: e.offer_sequence,
    provider: e.provider,
    seller: e.seller,
    taker: e.taker,
    tx_hash: e.tx_hash,
    tx_type: e.tx_type,
    ...(e.amm_account !== undefined && { amm_account: e.amm_account }),
  };
}

/**
 * Gives every account its `exchanges`: for each exchange, in the order given, first the list of its seller and then the
 * list of its buyer, the same object in both (a trade of an account with itself is twice in its list, as in the
 * original). Seller and buyer are those of the pair as asked for.
 */
export function attachExchanges(accounts: ActiveAccount[], rows: StoredActiveExchange[], inverted: boolean): void {
  const byName = new Map(accounts.map((a) => [a.account, a]));
  for (const a of accounts) a.exchanges = [];
  for (const row of rows) {
    const exchange = toActiveExchange(row, inverted);
    byName.get(exchange.seller)?.exchanges?.push(exchange);
    byName.get(exchange.buyer)?.exchanges?.push(exchange);
  }
}

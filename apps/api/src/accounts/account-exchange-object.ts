import { ExchangesRow } from '@gatehub/data-api-shared';
import { EXCHANGE_COLUMNS, StoredExchange, toCsvRow, toExchangeObject } from '../exchanges/exchange-object';

/**
 * An exchange as the account route serves it (`accountExchanges.js`): the exchange of `GET /v2/exchanges` and, unlike
 * there, its `client` (the route does not strip it), and with the pair among the other fields instead of at the end
 * (the route does not delete and re-add the stored ones). The keys come in the order of the original: the columns of
 * HBase's `d` family, then those of the `f` family, each sorted by name. A field the exchange does not have is left out.
 */
export interface AccountExchangeObject {
  base_amount: string;
  counter_amount: string;
  node_index: number;
  /** Counter per base, eight significant digits. */
  rate: string;
  tx_index: number;
  autobridged_currency?: string;
  autobridged_issuer?: string;
  base_currency: string;
  base_issuer?: string;
  buyer: string;
  /** What the importer recorded as the client of the transaction, when it knew it. */
  client?: string;
  counter_currency: string;
  counter_issuer?: string;
  /** `YYYY-MM-DDTHH:mm:ssZ`, the close time of the ledger. */
  executed_time: string;
  ledger_index: number;
  offer_sequence: number;
  provider: string;
  seller: string;
  taker: string;
  tx_hash: string;
  tx_type: string;
}

/** The columns of `account_exchanges` the API reads: those of `exchanges`, and the client. */
export const ACCOUNT_EXCHANGE_COLUMNS = `${EXCHANGE_COLUMNS}, client`;

/** A row of `account_exchanges` as `ACCOUNT_EXCHANGE_COLUMNS` reads it. */
export type StoredAccountExchange = StoredExchange & Pick<ExchangesRow, 'client'>;

/**
 * The account route's Exchange of a stored row. `inverted` is as for `toExchangeObject`: the pair was asked for the
 * other way round than it is stored, so base and counter swap (and buyer and seller, and the rate is its inverse).
 */
export function toAccountExchangeObject(row: StoredAccountExchange, inverted = false): AccountExchangeObject {
  const e = toExchangeObject(row, inverted);
  return {
    base_amount: e.base_amount,
    counter_amount: e.counter_amount,
    node_index: e.node_index,
    rate: e.rate,
    tx_index: e.tx_index,
    ...(e.autobridged_currency !== undefined && { autobridged_currency: e.autobridged_currency }),
    ...(e.autobridged_issuer !== undefined && { autobridged_issuer: e.autobridged_issuer }),
    base_currency: e.base_currency,
    ...(e.base_issuer !== undefined && { base_issuer: e.base_issuer }),
    buyer: e.buyer,
    ...(row.client !== null && { client: row.client }),
    counter_currency: e.counter_currency,
    ...(e.counter_issuer !== undefined && { counter_issuer: e.counter_issuer }),
    executed_time: e.executed_time,
    ledger_index: e.ledger_index,
    offer_sequence: e.offer_sequence,
    provider: e.provider,
    seller: e.seller,
    taker: e.taker,
    tx_hash: e.tx_hash,
    tx_type: e.tx_type,
  };
}

/**
 * The exchange as a row of the CSV: the row of `GET /v2/exchanges` (every column in the order of the original, an empty
 * cell where the exchange has none) and, as a last column, the `client` of an exchange that has one. A CSV takes one
 * column for every key found in any row, so the column is there when some row of the page has a client and empty in the
 * others. The original rewrote its first row into the columns of the list and so dropped the client of that row only.
 */
export function toAccountCsvRow(exchange: AccountExchangeObject): ReturnType<typeof toCsvRow> & { client?: string } {
  return { ...toCsvRow(exchange), ...(exchange.client !== undefined && { client: exchange.client }) };
}

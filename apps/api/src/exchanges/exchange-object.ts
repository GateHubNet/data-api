import { ExchangesRow, ratio } from '@gatehub/data-api-shared';
import { fmtTime, precision8 } from '../common/format';

/**
 * An exchange as the Ripple API serves it (`getExchanges.js` on the row `lib/hbase/hbase-thrift/data.js` builds). The
 * keys come in the order of the original: the columns of HBase's `d` family, then those of the `f` family, each sorted
 * by name, and at the end the four fields of the pair that the route sets (it deletes the stored ones, which come back
 * last). A field the exchange does not have is left out: the native currency has no issuer, and only an autobridged
 * exchange has an autobridged currency and issuer. The client is stripped.
 */
export interface ExchangeObject {
  base_amount: string;
  counter_amount: string;
  node_index: number;
  /** Counter per base, eight significant digits. */
  rate: string;
  tx_index: number;
  autobridged_currency?: string;
  autobridged_issuer?: string;
  buyer: string;
  /** `YYYY-MM-DDTHH:mm:ssZ`, the close time of the ledger. */
  executed_time: string;
  ledger_index: number;
  offer_sequence: number;
  provider: string;
  seller: string;
  taker: string;
  tx_hash: string;
  tx_type: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
}

/** The columns of `exchanges` the API reads: what `StoredExchange` holds, with the close time as unix seconds. */
export const EXCHANGE_COLUMNS = [
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'ledger_index',
  'tx_index',
  'node_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'base_amount',
  'counter_amount',
  'rate',
  'buyer',
  'seller',
  'taker',
  'provider',
  'offer_sequence',
  'autobridged_currency',
  'autobridged_issuer',
  'tx_type',
].join(', ');

/** A row of `exchanges` as `EXCHANGE_COLUMNS` reads it. The Float64 shadows and the client are not read. */
export type StoredExchange = Pick<
  ExchangesRow,
  | 'base_currency'
  | 'base_issuer'
  | 'counter_currency'
  | 'counter_issuer'
  | 'ledger_index'
  | 'tx_index'
  | 'node_index'
  | 'tx_hash'
  | 'close_time'
  | 'base_amount'
  | 'counter_amount'
  | 'rate'
  | 'buyer'
  | 'seller'
  | 'taker'
  | 'provider'
  | 'offer_sequence'
  | 'autobridged_currency'
  | 'autobridged_issuer'
  | 'tx_type'
>;

/**
 * The Exchange of a stored row. `inverted` is a pair that was asked for the other way round than it is stored (see
 * `canonicalPair`): base and counter swap with their currencies, issuers and amounts, buyer and seller swap, and the rate
 * is its inverse. The rest of the exchange (taker, provider, offer, transaction) is the same from both sides.
 */
export function toExchangeObject(row: StoredExchange, inverted = false): ExchangeObject {
  const [base, counter] = inverted
    ? [
        { currency: row.counter_currency, issuer: row.counter_issuer, amount: row.counter_amount },
        { currency: row.base_currency, issuer: row.base_issuer, amount: row.base_amount },
      ]
    : [
        { currency: row.base_currency, issuer: row.base_issuer, amount: row.base_amount },
        { currency: row.counter_currency, issuer: row.counter_issuer, amount: row.counter_amount },
      ];
  return {
    base_amount: base.amount,
    counter_amount: counter.amount,
    node_index: row.node_index,
    rate: precision8(inverted ? ratio(1, row.rate) : row.rate),
    tx_index: row.tx_index,
    // `autobridged_issuer` is stored as null when the currency has none; '' is the same to a client
    ...(row.autobridged_currency !== null && { autobridged_currency: row.autobridged_currency }),
    ...(row.autobridged_issuer !== null &&
      row.autobridged_issuer !== '' && { autobridged_issuer: row.autobridged_issuer }),
    buyer: inverted ? row.seller : row.buyer,
    executed_time: fmtTime(row.close_time),
    ledger_index: row.ledger_index,
    offer_sequence: row.offer_sequence,
    provider: row.provider,
    seller: inverted ? row.buyer : row.seller,
    taker: row.taker,
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    base_currency: base.currency,
    // the issuer of the native currency is stored as '' and served as nothing
    ...(base.issuer !== '' && { base_issuer: base.issuer }),
    counter_currency: counter.currency,
    ...(counter.issuer !== '' && { counter_issuer: counter.issuer }),
  };
}

/** The columns of the CSV of exchanges, in the order `getExchanges.js` lists them. */
export const EXCHANGE_CSV_COLUMNS = [
  'base_currency',
  'base_issuer',
  'base_amount',
  'counter_amount',
  'counter_currency',
  'counter_issuer',
  'rate',
  'executed_time',
  'ledger_index',
  'buyer',
  'seller',
  'taker',
  'provider',
  'autobridged_currency',
  'autobridged_issuer',
  'offer_sequence',
  'tx_type',
  'tx_index',
  'node_index',
  'tx_hash',
] as const;

/**
 * The exchange as a row of the CSV: every column, in the order of the original, `null` (an empty cell) where the
 * exchange has none. The original rewrote its first row this way "to ensure consistent order and inclusion of all
 * fields", because a CSV takes its columns from the keys of the rows, and the first row may lack some.
 */
export function toCsvRow(
  exchange: ExchangeObject,
): Record<(typeof EXCHANGE_CSV_COLUMNS)[number], string | number | null> {
  const fields = exchange as unknown as Record<string, string | number | undefined>;
  return Object.fromEntries(EXCHANGE_CSV_COLUMNS.map((column) => [column, fields[column] ?? null])) as Record<
    (typeof EXCHANGE_CSV_COLUMNS)[number],
    string | number | null
  >;
}

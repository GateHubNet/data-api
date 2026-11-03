import { PathPaymentsRow } from '@gatehub/data-api-shared';
import { fmtTime } from '../common/format';

/**
 * A path payment as the API serves it (spec #4 §4), in this key order. The issuers are left out for the native
 * currency. `amm_pools` and `rippled_through` are accounts, in the order of the metadata.
 */
export interface PathPaymentObject {
  hash: string;
  ledger_index: number;
  /** `YYYY-MM-DDTHH:mm:ssZ`, the close time of the ledger. */
  executed_time: string;
  source: string;
  destination: string;
  delivered_amount: string;
  currency: string;
  issuer?: string;
  /** What left the source, the fee not included. */
  source_amount: string;
  source_currency: string;
  source_issuer?: string;
  offers_crossed: number;
  amm_pools: string[];
  rippled_through: string[];
}

/** The columns of `path_payments` the API reads, the close time as unix seconds. */
export const PATH_PAYMENT_COLUMNS = [
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'source',
  'destination',
  'delivered_amount',
  'currency',
  'issuer',
  'source_amount',
  'source_currency',
  'source_issuer',
  'offers_crossed',
  'amm_pools',
  'rippled_through',
].join(', ');

/** The API object of a stored path payment. */
export function toPathPaymentObject(row: PathPaymentsRow): PathPaymentObject {
  return {
    hash: row.tx_hash,
    ledger_index: row.ledger_index,
    executed_time: fmtTime(row.close_time),
    source: row.source,
    destination: row.destination,
    delivered_amount: row.delivered_amount,
    currency: row.currency,
    // the issuer of the native currency is stored as '' and served as nothing
    ...(row.issuer !== '' && { issuer: row.issuer }),
    source_amount: row.source_amount,
    source_currency: row.source_currency,
    ...(row.source_issuer !== '' && { source_issuer: row.source_issuer }),
    offers_crossed: row.offers_crossed,
    amm_pools: row.amm_pools,
    rippled_through: row.rippled_through,
  };
}

/**
 * A row of the CSV form: the same keys, with the two lists as one cell each, their accounts separated by a space. A
 * list in the CSV would otherwise be one column per position (`amm_pools[0]`, ...), which differs from page to page.
 */
export function toPathPaymentCsvRow(p: PathPaymentObject): Record<string, string | number> {
  return { ...p, amm_pools: p.amm_pools.join(' '), rippled_through: p.rippled_through.join(' ') };
}

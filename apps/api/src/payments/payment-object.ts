import { dropsToNative, PaymentsRow } from '@gatehub/data-api-shared';
import { fmtTime } from '../common/format';

/** A balance change of a payment, as the parser stores it: `counterparty` is `''` for the native currency. */
export interface PaymentBalanceChange {
  counterparty: string;
  currency: string;
  value: string;
}

/**
 * A payment as the Ripple API serves it (`getPayments.js` on the row `lib/hbase/hbase-thrift/data.js` builds). The keys
 * come in the order of the original: the columns of HBase's `d` family, then those of the `f` family, each sorted by
 * name, and at the end the `transaction_cost` that took the place of the stored `fee`. A field the payment does not
 * have is left out (a tag of 0 is a tag, ruling R10; the native currency has no issuer).
 */
export interface PaymentObject {
  amount: string;
  delivered_amount: string;
  destination_balance_changes: PaymentBalanceChange[];
  max_amount?: string;
  source_balance_changes: PaymentBalanceChange[];
  tx_index: number;
  currency: string;
  destination: string;
  destination_tag?: number;
  /** `YYYY-MM-DDTHH:mm:ssZ`, the close time of the ledger. */
  executed_time: string;
  invoice_id?: string;
  issuer?: string;
  ledger_index: number;
  source: string;
  source_currency: string;
  source_tag?: number;
  tx_hash: string;
  /** The fee in whole units of the native currency. */
  transaction_cost: string;
}

/** The columns of `payments` the API reads: what `StoredPayment` holds, with the two that need a conversion. */
export const PAYMENT_COLUMNS = [
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'source',
  'destination',
  'currency',
  'issuer',
  'amount',
  'delivered_amount',
  'max_amount',
  'source_currency',
  'source_tag',
  'destination_tag',
  'invoice_id',
  'toString(fee) AS fee',
  'source_balance_changes',
  'destination_balance_changes',
].join(', ');

/** A row of `payments` as `PAYMENT_COLUMNS` reads it: the fee as exact digits, the close time as unix seconds. */
export type StoredPayment = Pick<
  PaymentsRow,
  | 'ledger_index'
  | 'tx_index'
  | 'tx_hash'
  | 'close_time'
  | 'source'
  | 'destination'
  | 'currency'
  | 'issuer'
  | 'amount'
  | 'delivered_amount'
  | 'max_amount'
  | 'source_currency'
  | 'source_tag'
  | 'destination_tag'
  | 'invoice_id'
  | 'source_balance_changes'
  | 'destination_balance_changes'
> & { fee: string };

/** The API object of a stored payment. */
export function toPaymentObject(row: StoredPayment): PaymentObject {
  return {
    amount: row.amount,
    delivered_amount: row.delivered_amount,
    destination_balance_changes: JSON.parse(row.destination_balance_changes) as PaymentBalanceChange[],
    ...(row.max_amount !== null && { max_amount: row.max_amount }),
    source_balance_changes: JSON.parse(row.source_balance_changes) as PaymentBalanceChange[],
    tx_index: row.tx_index,
    currency: row.currency,
    destination: row.destination,
    ...(row.destination_tag !== null && { destination_tag: row.destination_tag }),
    executed_time: fmtTime(row.close_time),
    ...(row.invoice_id !== null && { invoice_id: row.invoice_id }),
    // the issuer of the native currency is stored as '' and served as nothing
    ...(row.issuer !== '' && { issuer: row.issuer }),
    ledger_index: row.ledger_index,
    source: row.source,
    source_currency: row.source_currency,
    ...(row.source_tag !== null && { source_tag: row.source_tag }),
    tx_hash: row.tx_hash,
    transaction_cost: dropsToNative(row.fee),
  };
}

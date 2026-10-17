import {
  AccountExchangesRow,
  AccountPaymentsRow,
  AccountsCreatedRow,
  AccountTransactionsRow,
  AccountTxBySequenceRow,
  BalanceChangesRow,
  CountMap,
  ExchangesRow,
  LedgerByHashRow,
  LedgersRow,
  PARSER_VERSION,
  PaymentsByCurrencyRow,
  PaymentsRow,
  TransactionsRow,
  TxByHashRow,
  TxByTypeRow,
} from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { AccountsCreatedParser } from '../parsers/accounts-created.parser';
import { AffectedAccountsParser } from '../parsers/affected-accounts.parser';
import { BalanceChangesParser } from '../parsers/balance-changes.parser';
import { ExchangeParser } from '../parsers/exchanges.parser';
import { FromClientParser } from '../parsers/from-client.parser';
import { ParseContext, ParserTx, senderAccount, toParserTx } from '../parsers/parser.interface';
import { PaymentParser } from '../parsers/payment.parser';
import { RawLedger } from './raw-ledger';

/** Every row one ledger writes, one array per table. `ledger` is the commit marker and is written last. */
export interface LedgerRows {
  ledger: LedgersRow;
  ledgerByHash: LedgerByHashRow;
  transactions: TransactionsRow[];
  txByHash: TxByHashRow[];
  txByType: TxByTypeRow[];
  accountTransactions: AccountTransactionsRow[];
  accountTxBySequence: AccountTxBySequenceRow[];
  payments: PaymentsRow[];
  paymentsByCurrency: PaymentsByCurrencyRow[];
  accountPayments: AccountPaymentsRow[];
  exchanges: ExchangesRow[];
  accountExchanges: AccountExchangesRow[];
  balanceChanges: BalanceChangesRow[];
  accountsCreated: AccountsCreatedRow[];
}

/** The `LedgerRows` properties that hold a list of rows, i.e. everything but `ledger` and `ledgerByHash`. */
export type ChildRowsKey = Exclude<keyof LedgerRows, 'ledger' | 'ledgerByHash'>;

/**
 * Every table that holds the rows of a ledger's transactions, with the `LedgerRows` property that fills it: all the
 * ledger-derived tables except `ledgers` and `ledger_by_hash`, which are the commit marker and are written separately.
 */
export const CHILD_TABLES: ReadonlyArray<[Table, ChildRowsKey]> = [
  [Table.Transactions, 'transactions'],
  [Table.TxByHash, 'txByHash'],
  [Table.TxByType, 'txByType'],
  [Table.AccountTransactions, 'accountTransactions'],
  [Table.AccountTxBySequence, 'accountTxBySequence'],
  [Table.Payments, 'payments'],
  [Table.PaymentsByCurrency, 'paymentsByCurrency'],
  [Table.AccountPayments, 'accountPayments'],
  [Table.Exchanges, 'exchanges'],
  [Table.AccountExchanges, 'accountExchanges'],
  [Table.BalanceChanges, 'balanceChanges'],
  [Table.AccountsCreated, 'accountsCreated'],
];

const paymentParser = new PaymentParser();
const exchangeParser = new ExchangeParser();
const balanceChangesParser = new BalanceChangesParser();
const accountsCreatedParser = new AccountsCreatedParser();
const affectedAccountsParser = new AffectedAccountsParser();
const fromClientParser = new FromClientParser();

/**
 * The Float64 shadow of an exact amount string (`*_f` columns, for sorting and aggregating). This is the one place an
 * amount goes through a Number; the String column next to it stays exact.
 */
function float(amount: string): number {
  return Number(amount);
}

/** A transaction's `Fee` in drops as an unsigned integer string; pseudo-transactions carry none, which is 0. */
function feeDrops(t: ParserTx): string {
  const fee = t.tx.Fee ?? '0';
  if (typeof fee !== 'string' || !/^\d+$/.test(fee)) {
    throw new Error(`Ledger ${t.ledger_index}: transaction ${t.hash} has an invalid Fee ${JSON.stringify(fee)}`);
  }
  return fee;
}

/**
 * The sender of a transaction for the index columns (`transactions.account`, `account_tx_by_sequence`,
 * `is_initiator`). Every transaction has an `Account` field; pseudo-transactions carry the zero account there, which
 * Xahau's `UNLReport` leaves empty (`""`): that is stored as the zero account too, while `tx_json` keeps the node's
 * `""` (`senderAccount`, ruling R95). A transaction without an `Account` string is malformed and rejected.
 */
function senderOf(t: ParserTx): string {
  const sender = senderAccount(t.tx);
  if (sender === undefined) {
    throw new Error(`Ledger ${t.ledger_index}: transaction ${t.hash} has no Account`);
  }
  return sender;
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * A ledger that cannot be turned into rows (a malformed transaction, a field a parser rejects). Parsing is pure, so it
 * fails the same way every time: retrying it, or fetching the ledger again, does not help (ruling R96). The live runner
 * halts on it and range-ingest fails the chunk at once; an operator has to look at the ledger.
 */
export class LedgerParseError extends Error {
  constructor(
    readonly ledgerIndex: number,
    readonly reason: string,
  ) {
    super(`Cannot parse ledger ${ledgerIndex}: ${reason}`);
    this.name = 'LedgerParseError';
  }
}

/** Whether `err` is a `LedgerParseError` (by name too, so that it holds across copies of this package). */
export function isLedgerParseError(err: unknown): err is LedgerParseError {
  return err instanceof LedgerParseError || (err instanceof Error && err.name === 'LedgerParseError');
}

/**
 * Parse one ledger into the rows of every ledger-derived table, plus the `ledgers` summary row.
 *
 * Pure: the same ledger always gives the same rows, nothing in `raw` is modified, and the result shares no objects with
 * it. Rows carry no `undefined`: an absent optional value is `null`, and the empty string stands for the native
 * currency's issuer and counterparty. Native amounts in `fee` columns are drops, every other amount is an exact decimal
 * string in whole units.
 *
 * Throws a `LedgerParseError` (with the ledger index and the reason) for anything it cannot parse.
 */
export function buildLedgerRows(raw: RawLedger, ctx: ParseContext): LedgerRows {
  try {
    return buildRows(raw, ctx);
  } catch (err) {
    if (isLedgerParseError(err)) throw err;
    throw new LedgerParseError(raw.header.ledger_index, err instanceof Error ? err.message : String(err));
  }
}

function buildRows(raw: RawLedger, ctx: ParseContext): LedgerRows {
  const { header } = raw;
  const closeTime = header.close_time;

  const rows: Omit<LedgerRows, 'ledger'> = {
    ledgerByHash: { ledger_hash: header.ledger_hash, ledger_index: header.ledger_index },
    transactions: [],
    txByHash: [],
    txByType: [],
    accountTransactions: [],
    accountTxBySequence: [],
    payments: [],
    paymentsByCurrency: [],
    accountPayments: [],
    exchanges: [],
    accountExchanges: [],
    balanceChanges: [],
    accountsCreated: [],
  };

  const typeCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  let feeTotal = 0n;
  let feeMin: bigint | undefined;
  let feeMax = 0n;

  for (const transaction of raw.transactions) {
    // The memo is read from the transaction alone, so parse it first and hand the parsers a transaction that has it.
    const bare = toParserTx(transaction, header, null);
    const t: ParserTx = { ...bare, client: fromClientParser.parse(bare) };
    const { tx_index: txIndex } = t;

    const sender = senderOf(t);
    const txType = String(t.tx.TransactionType);
    const result = String(t.meta.TransactionResult);
    const fee = feeDrops(t);

    tally(typeCounts, txType);
    tally(resultCounts, result);
    const drops = BigInt(fee);
    feeTotal += drops;
    if (feeMin === undefined || drops < feeMin) feeMin = drops;
    if (drops > feeMax) feeMax = drops;

    rows.transactions.push({
      ledger_index: header.ledger_index,
      tx_index: txIndex,
      hash: t.hash,
      tx_type: txType,
      result,
      account: sender,
      sequence: t.tx.Sequence ?? 0,
      fee,
      close_time: closeTime,
      tx_json: JSON.stringify(transaction.tx),
      meta_json: JSON.stringify(transaction.meta),
    });
    rows.txByHash.push({ hash: t.hash, ledger_index: header.ledger_index, tx_index: txIndex });
    rows.txByType.push({ tx_type: txType, ledger_index: header.ledger_index, tx_index: txIndex, result });

    for (const account of affectedAccountsParser.parse(t)) {
      rows.accountTransactions.push({
        account,
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        tx_type: txType,
        result,
        is_initiator: account === sender ? 1 : 0,
        close_time: closeTime,
      });
    }
    // A ticketed transaction has Sequence 0: keep it, the ticket is not a sequence.
    rows.accountTxBySequence.push({
      account: sender,
      sequence: t.tx.Sequence ?? 0,
      ledger_index: header.ledger_index,
      tx_index: txIndex,
    });

    const payment = paymentParser.parse(t, ctx);
    if (payment) {
      const issuer = payment.issuer ?? '';
      const sourceTag = payment.source_tag ?? null;
      const destinationTag = payment.destination_tag ?? null;
      const deliveredF = float(payment.delivered_amount);

      rows.payments.push({
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        tx_hash: t.hash,
        close_time: closeTime,
        source: payment.source,
        destination: payment.destination,
        currency: payment.currency,
        issuer,
        amount: payment.amount,
        delivered_amount: payment.delivered_amount,
        delivered_amount_f: deliveredF,
        max_amount: payment.max_amount ?? null,
        source_currency: payment.source_currency,
        source_tag: sourceTag,
        destination_tag: destinationTag,
        invoice_id: payment.invoice_id ?? null,
        fee: payment.fee_drops,
        source_balance_changes: JSON.stringify(payment.source_balance_changes),
        destination_balance_changes: JSON.stringify(payment.destination_balance_changes),
        client: t.client,
      });
      rows.paymentsByCurrency.push({
        currency: payment.currency,
        issuer,
        ledger_index: header.ledger_index,
        tx_index: txIndex,
      });

      const shared = {
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        tx_hash: t.hash,
        close_time: closeTime,
        currency: payment.currency,
        issuer,
        delivered_amount: payment.delivered_amount,
        delivered_amount_f: deliveredF,
        source_tag: sourceTag,
        destination_tag: destinationTag,
      };
      rows.accountPayments.push(
        { account: payment.source, direction: 'sent', counterparty: payment.destination, ...shared },
        { account: payment.destination, direction: 'received', counterparty: payment.source, ...shared },
      );
    }

    for (const exchange of exchangeParser.parse(t, ctx)) {
      const row: ExchangesRow = {
        base_currency: exchange.base_currency,
        base_issuer: exchange.base_issuer,
        counter_currency: exchange.counter_currency,
        counter_issuer: exchange.counter_issuer,
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        node_index: exchange.node_index,
        tx_hash: t.hash,
        close_time: closeTime,
        base_amount: exchange.base_amount,
        counter_amount: exchange.counter_amount,
        base_amount_f: float(exchange.base_amount),
        counter_amount_f: float(exchange.counter_amount),
        rate: exchange.rate,
        rate_f: float(exchange.rate),
        buyer: exchange.buyer,
        seller: exchange.seller,
        taker: exchange.taker,
        provider: exchange.provider,
        offer_sequence: exchange.offer_sequence,
        amm_account: '',
        autobridged_currency: exchange.autobridged_currency ?? null,
        autobridged_issuer: exchange.autobridged_issuer ?? null,
        tx_type: exchange.tx_type,
        client: t.client,
      };
      rows.exchanges.push(row);

      // Both parties see the exchange; a trade with oneself is one row for that account, not two.
      rows.accountExchanges.push({ account: exchange.buyer, ...row });
      if (exchange.seller !== exchange.buyer) rows.accountExchanges.push({ account: exchange.seller, ...row });
    }

    for (const change of balanceChangesParser.parse(t, ctx)) {
      rows.balanceChanges.push({
        account: change.account,
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        node_index: change.node_index,
        tx_hash: t.hash,
        close_time: closeTime,
        currency: change.currency,
        counterparty: change.counterparty,
        amount_change: change.amount_change,
        final_balance: change.final_balance,
        final_balance_f: float(change.final_balance),
        change_type: change.change_type,
        escrow_counterparty: change.escrow_counterparty ?? null,
        escrow_balance_change: change.escrow_balance_change ?? null,
        paychannel_counterparty: change.paychannel_counterparty ?? null,
        paychannel_fund_change: change.paychannel_fund_change ?? null,
        paychannel_fund_final_balance: change.paychannel_fund_final_balance ?? null,
        paychannel_final_balance: change.paychannel_final_balance ?? null,
        paychannel_balance_change: change.paychannel_balance_change ?? null,
        client: t.client,
      });
    }

    for (const created of accountsCreatedParser.parse(t, ctx)) {
      rows.accountsCreated.push({
        account: created.account,
        parent: created.parent,
        initial_balance: created.initial_balance,
        ledger_index: header.ledger_index,
        tx_index: txIndex,
        tx_hash: t.hash,
        inception: closeTime,
        genesis_balance: null,
        genesis_index: null,
      });
    }
  }

  const ledger: LedgersRow = {
    ledger_index: header.ledger_index,
    ledger_hash: header.ledger_hash,
    parent_hash: header.parent_hash,
    account_hash: header.account_hash,
    transaction_hash: header.transaction_hash,
    total_coins: header.total_coins,
    close_time: closeTime,
    parent_close_time: header.parent_close_time,
    close_time_resolution: header.close_time_resolution,
    close_flags: header.close_flags,
    tx_count: rows.transactions.length,
    type_counts: toCountMap(typeCounts),
    result_counts: toCountMap(resultCounts),
    payments_count: rows.payments.length,
    // Ripple's stats count exchanges, not the transactions that made them.
    exchanges_count: rows.exchanges.length,
    accounts_created: rows.accountsCreated.length,
    // Drops, as the reference `fees.js` sums them, without its division into whole units. No transactions: min is 0.
    fee_total: feeTotal.toString(),
    fee_min: (feeMin ?? 0n).toString(),
    fee_max: feeMax.toString(),
    parser_version: PARSER_VERSION,
  };
  return { ledger, ...rows };
}

/** A plain object with own data properties only, whatever the keys are called. */
function toCountMap(counts: Map<string, number>): CountMap {
  return Object.fromEntries(counts);
}

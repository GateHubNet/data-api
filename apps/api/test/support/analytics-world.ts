import { AccountTransactionsRow, BalanceChangesRow, ExchangesRow, Table } from '@gatehub/data-api-shared';
import type { Harness } from '../harness';

/**
 * A small world worked out by hand, over 2020-01 to 2020-06, for the suites of the aggregate routes (`stats/{family}`
 * with `interval`, and the routes under `analytics/`, which extend it). It is written into the tables the routes read:
 * `ledgers`, `balance_changes`, `account_transactions` and `exchanges` (the trades the rates are made of), with nothing
 * from the real ledgers in it. Every row is a constant below, so the expected answers can be worked out from this file.
 *
 * Only what a test needs is modelled: the lists are not complete books (a fee is a row only where a test is about the
 * fee), and the tables are independent of each other.
 *
 * The accounts:
 *  - `typical` (A): 100 XRP on 2020-01-15; 10 USD of `issuer` on 02-10; pays 20 XRP on 02-12 (and the fee); 30 more USD on
 *    03-05; the fee alone in the last second of March; sells 20 USD for 5 XRP on 04-20; owes 5 CAD to `counterparty` on
 *    05-06; holds 7 USD of `issuer2` (which no one trades) on 06-10. It sent 12 transactions.
 *  - `issuer`: 1000 XRP on 01-10, and it owes USD to `typical` (10, then 40) and to `counterparty` (5), and EUR to
 *    `counterparty` (3): lines with a negative balance. Its own USD has a rate on some days.
 *  - `counterparty` (B): receives what A pays, and holds 5 USD, 3 EUR of `issuer` and 5 CAD of A.
 *  - `issuer2`: an issuer whose currency never trades, so it has no rate. `stranger`: nothing at all.
 *
 * The rates: USD of `issuer` trades against XRP 12 times on 2020-02-10 (10 USD for 5 XRP: 2 USD per XRP) and 12 times on
 * 2020-04-20 (20 USD for 5 XRP: 4 USD per XRP), both at 12:30. The rate of a day is that of the trades of the day and of
 * the newest 50 within 14 days of it: USD has a rate of 2 on the days 02-10 to 02-24 and a rate of 4 on 04-20 to 05-04, and
 * none on any other day.
 */

export const TYPICAL = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
export const COUNTERPARTY = 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7';
export const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
export const ISSUER2 = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
export const STRANGER = 'rrrrUBy92h6worVCYERZcVCzgzgmHb17Dx';

/** The first ledger of the world; ledgers are numbered from it in the order of their times. */
const FIRST_LEDGER = 5_000_000;

/** `[account, time, tx_index, node_index, currency, counterparty, final_balance, amount_change, change_type]` */
export type ChangeSpec = [string, string, number, number, string, string, string, string, string];

const XRP = (account: string, time: string, tx: number, node: number, final: string, change: string, type: string) =>
  [account, time, tx, node, 'XRP', '', final, change, type] as ChangeSpec;
/** The fee row of a transaction: node -1, the native currency. */
const FEE = (account: string, time: string, tx: number, final: string): ChangeSpec =>
  XRP(account, time, tx, -1, final, '-0.000012', 'transaction_cost');
const IOU = (
  account: string,
  time: string,
  tx: number,
  node: number,
  currency: string,
  counterparty: string,
  final: string,
  change: string,
  type: string,
) => [account, time, tx, node, currency, counterparty, final, change, type] as ChangeSpec;

export const CHANGES: ChangeSpec[] = [
  // the typical account
  XRP(TYPICAL, '2020-01-15T10:00:00Z', 1, 1, '100', '100', 'payment_destination'),
  IOU(TYPICAL, '2020-02-10T11:00:00Z', 1, 1, 'USD', ISSUER, '10', '10', 'payment_destination'),
  FEE(TYPICAL, '2020-02-12T09:00:00Z', 1, '99.999988'),
  XRP(TYPICAL, '2020-02-12T09:00:00Z', 1, 2, '79.999988', '-20', 'payment_source'),
  IOU(TYPICAL, '2020-03-05T10:00:00Z', 1, 1, 'USD', ISSUER, '40', '30', 'payment_destination'),
  FEE(TYPICAL, '2020-03-31T23:59:59Z', 1, '79.999976'), // the fee alone, in the last second of March
  IOU(TYPICAL, '2020-04-20T12:00:00Z', 1, 1, 'USD', ISSUER, '20', '-20', 'exchange'),
  XRP(TYPICAL, '2020-04-20T12:00:00Z', 1, 2, '84.999976', '5', 'exchange'),
  IOU(TYPICAL, '2020-05-06T09:00:00Z', 1, 1, 'CAD', COUNTERPARTY, '-5', '-5', 'intermediary'), // what A owes
  IOU(TYPICAL, '2020-06-10T08:00:00Z', 1, 1, 'USD', ISSUER2, '7', '7', 'payment_destination'), // no trades: no rate

  // the issuer: owes lines, and holds some XRP
  XRP(ISSUER, '2020-01-10T09:00:00Z', 1, 1, '1000', '1000', 'payment_destination'),
  IOU(ISSUER, '2020-02-10T11:00:00Z', 1, 2, 'USD', TYPICAL, '-10', '-10', 'intermediary'),
  IOU(ISSUER, '2020-02-20T10:00:00Z', 1, 1, 'USD', COUNTERPARTY, '-5', '-5', 'intermediary'),
  IOU(ISSUER, '2020-03-05T10:00:00Z', 1, 2, 'USD', TYPICAL, '-40', '-30', 'intermediary'),
  IOU(ISSUER, '2020-04-02T10:00:00Z', 1, 1, 'EUR', COUNTERPARTY, '-3', '-3', 'intermediary'),

  // the counterparty
  XRP(COUNTERPARTY, '2020-02-12T09:00:00Z', 1, 3, '20', '20', 'payment_destination'),
  IOU(COUNTERPARTY, '2020-02-20T10:00:00Z', 1, 2, 'USD', ISSUER, '5', '5', 'payment_destination'),
  IOU(COUNTERPARTY, '2020-04-02T10:00:00Z', 1, 2, 'EUR', ISSUER, '3', '3', 'payment_destination'),
  IOU(COUNTERPARTY, '2020-05-06T09:00:00Z', 1, 2, 'CAD', TYPICAL, '5', '5', 'payment_destination'),
];

/** `[account, time, tx_index, tx_type, result, sent by the account]` */
export type TxSpec = [string, string, number, string, string, boolean];

export const TXS: TxSpec[] = [
  [TYPICAL, '2020-01-15T10:00:00Z', 1, 'Payment', 'tesSUCCESS', false], // received: not counted
  [TYPICAL, '2020-01-16T09:00:00Z', 1, 'TrustSet', 'tesSUCCESS', true],
  [TYPICAL, '2020-01-17T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [TYPICAL, '2020-01-17T09:00:00Z', 2, 'Payment', 'tesSUCCESS', true], // two in one ledger
  [TYPICAL, '2020-01-31T12:00:00Z', 1, 'OfferCreate', 'tecUNFUNDED_OFFER', true],
  [TYPICAL, '2020-02-03T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [TYPICAL, '2020-02-10T11:00:00Z', 1, 'Payment', 'tesSUCCESS', false],
  [TYPICAL, '2020-02-12T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [TYPICAL, '2020-02-14T09:00:00Z', 1, 'Payment', 'tecPATH_DRY', true],
  [TYPICAL, '2020-02-20T09:00:00Z', 1, 'OfferCancel', 'tesSUCCESS', false], // only touches it
  [TYPICAL, '2020-03-01T09:00:00Z', 1, 'AccountSet', 'tesSUCCESS', true], // a Sunday: the week of 02-24
  [TYPICAL, '2020-03-05T10:00:00Z', 1, 'Payment', 'tesSUCCESS', false],
  [TYPICAL, '2020-03-31T23:59:59Z', 1, 'Payment', 'tesSUCCESS', true], // the last second of March
  [TYPICAL, '2020-04-01T00:00:00Z', 1, 'OfferCreate', 'tesSUCCESS', true], // the first second of April
  [TYPICAL, '2020-04-20T12:00:00Z', 1, 'OfferCreate', 'tesSUCCESS', true],
  [TYPICAL, '2020-06-15T09:00:00Z', 1, 'Payment', 'tesSUCCESS', true],

  [ISSUER, '2020-02-10T11:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [ISSUER, '2020-02-20T10:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [ISSUER, '2020-03-05T10:00:00Z', 1, 'Payment', 'tesSUCCESS', true],
  [ISSUER, '2020-04-02T10:00:00Z', 1, 'Payment', 'tesSUCCESS', true],

  [COUNTERPARTY, '2020-02-12T09:00:00Z', 1, 'Payment', 'tesSUCCESS', false],
  [COUNTERPARTY, '2020-02-20T10:00:00Z', 1, 'Payment', 'tesSUCCESS', false],
  [COUNTERPARTY, '2020-04-02T10:00:00Z', 1, 'Payment', 'tesSUCCESS', false],
];

/** The trades of USD of `issuer` against XRP: `time` of the first of 12, a second apart; USD and XRP of each. */
export const TRADE_RUNS = [
  { time: '2020-02-10T12:30:00Z', usd: '10', xrp: '5' },
  { time: '2020-04-20T12:30:00Z', usd: '20', xrp: '5' },
];
export const TRADES_PER_RUN = 12;

const seconds = (time: string): number => Date.parse(time) / 1000;

/** The trades as `[time in seconds, usd, xrp]`, 12 for each run. */
const tradeRows = (): { time: number; usd: string; xrp: string }[] =>
  TRADE_RUNS.flatMap((run) =>
    Array.from({ length: TRADES_PER_RUN }, (_, i) => ({ time: seconds(run.time) + i, usd: run.usd, xrp: run.xrp })),
  );

/** What `seedAnalyticsWorld` hands back: the accounts, and where a time of the world is in the ledgers. */
export interface AnalyticsWorld {
  typical: string;
  counterparty: string;
  issuer: string;
  issuer2: string;
  /** An address with nothing at all. */
  stranger: string;
  /** The ledger that closed at a time of the world (`YYYY-MM-DDTHH:mm:ssZ`), `undefined` for any other time. */
  ledgerAt(time: string): number | undefined;
}

/**
 * Writes the world into the harness's database: a `ledgers` row for each time something happens in it, in the order of
 * the times (so close times do not decrease with the ledger index), then the rows of the account tables and the trades.
 */
export async function seedAnalyticsWorld(h: Harness): Promise<AnalyticsWorld> {
  const trades = tradeRows();
  const times = [
    ...new Set([
      ...CHANGES.map(([, time]) => seconds(time)),
      ...TXS.map(([, time]) => seconds(time)),
      ...trades.map((t) => t.time),
    ]),
  ].sort((a, b) => a - b);
  const ledgerOf = new Map(times.map((time, i) => [time, FIRST_LEDGER + i]));
  const ledger = (time: number): number => ledgerOf.get(time) as number;

  await h.ch.insert(
    Table.Ledgers,
    times.map((time) => ({
      ledger_index: ledger(time),
      ledger_hash: `${ledger(time)}`.padStart(64, 'C'),
      close_time: time,
    })),
  );

  await h.ch.insert(
    Table.BalanceChanges,
    CHANGES.map(
      ([account, time, tx_index, node_index, currency, counterparty, final_balance, amount_change, change_type]) =>
        ({
          account,
          ledger_index: ledger(seconds(time)),
          tx_index,
          node_index,
          tx_hash: `${tx_index}`.padStart(64, 'A'),
          close_time: seconds(time),
          currency,
          counterparty,
          amount_change,
          final_balance,
          final_balance_f: Number(final_balance),
          change_type,
          escrow_counterparty: null,
          escrow_balance_change: null,
          paychannel_counterparty: null,
          paychannel_fund_change: null,
          paychannel_fund_final_balance: null,
          paychannel_final_balance: null,
          paychannel_balance_change: null,
          client: null,
        }) satisfies BalanceChangesRow,
    ),
  );

  await h.ch.insert(
    Table.AccountTransactions,
    TXS.map(
      ([account, time, tx_index, tx_type, result, sent]) =>
        ({
          account,
          ledger_index: ledger(seconds(time)),
          tx_index,
          tx_type,
          result,
          is_initiator: sent ? 1 : 0,
          close_time: seconds(time),
        }) satisfies AccountTransactionsRow,
    ),
  );

  await h.ch.insert(
    Table.Exchanges,
    trades.map(
      (t, i) =>
        ({
          base_currency: 'USD',
          base_issuer: ISSUER,
          counter_currency: 'XRP',
          counter_issuer: '',
          ledger_index: ledger(t.time),
          tx_index: 100 + i,
          node_index: 1,
          tx_hash: `${100 + i}`.padStart(64, 'B'),
          close_time: t.time,
          base_amount: t.usd,
          counter_amount: t.xrp,
          base_amount_f: Number(t.usd),
          counter_amount_f: Number(t.xrp),
          rate: String(Number(t.xrp) / Number(t.usd)),
          rate_f: Number(t.xrp) / Number(t.usd),
          buyer: COUNTERPARTY,
          seller: COUNTERPARTY,
          taker: COUNTERPARTY,
          provider: COUNTERPARTY,
          offer_sequence: 1,
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        }) satisfies ExchangesRow,
    ),
  );

  return {
    typical: TYPICAL,
    counterparty: COUNTERPARTY,
    issuer: ISSUER,
    issuer2: ISSUER2,
    stranger: STRANGER,
    ledgerAt: (time) => ledgerOf.get(seconds(time)),
  };
}

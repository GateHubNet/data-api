import {
  AccountFlag,
  amountToValueString,
  deliveredAmount,
  dropsToNative,
  ParseContext,
  PaymentParser,
  TransactionsRow,
} from '@gatehub/data-api-shared';
import { fmtTxDate } from '../common/format';

/**
 * A row of the CSV of `GET /v2/accounts/:address/transactions`: one transaction as the account saw it, readable without
 * opening the raw transaction. Every column is there on every row, `null` (an empty cell) where the transaction has
 * nothing for it, so that the header is the same on every page. In this order:
 *   hash, ledger_index, executed_time, tx_type, result, initiator, counterparty, amount, currency, issuer, fee,
 *   flags_changed
 *
 *  - `initiator`: the account sent the transaction (its `Account`), rather than being only affected by it;
 *  - `counterparty`, `amount`, `currency`, `issuer`: from the mapping of the transaction type (`SIDES`), from the
 *    account's side. Amounts are exact decimal strings in whole units; the native currency has no issuer;
 *  - `fee`: in whole units of the native currency, on the transactions the account sent only;
 *  - `flags_changed`: the account flags of the account that the transaction set (`+Name`) or cleared (`-Name`), with the
 *    network's flag names, separated by a space: the set ones first, then the cleared ones, each in the order of their
 *    bits. Empty when the transaction changed none, or when no account state of the account was recorded for it
 *    (`AccountStateOfTx`).
 */
export interface TransactionSummary {
  hash: string;
  ledger_index: number;
  /** `YYYY-MM-DDTHH:mm:ss+00:00`, the `date` of the JSON list. */
  executed_time: string;
  tx_type: string;
  result: string;
  initiator: boolean;
  counterparty: string | null;
  amount: string | null;
  currency: string | null;
  issuer: string | null;
  fee: string | null;
  flags_changed: string | null;
}

type Json = Readonly<Record<string, any>>;

/** What a transaction type gives the account: the other party, and an amount with its currency and issuer. */
interface Side {
  counterparty?: string;
  amount?: string;
  currency?: string;
  issuer?: string;
}

/** The transaction, its metadata and its stored row, and the account whose side is asked for. */
interface Seen {
  tx: Json;
  meta: Json;
  row: TransactionsRow;
  account: string;
  ctx: ParseContext;
}

const payments = new PaymentParser();

/** An amount as it is on the wire, as value, currency and issuer (none for the native currency or an MPT). */
function amountSide(amount: unknown, ctx: ParseContext): Side {
  if (typeof amount !== 'object' || amount === null) {
    return { amount: amountToValueString(amount), currency: ctx.nativeCurrency };
  }
  const token = amount as Json;
  return {
    amount: amountToValueString(token),
    currency: token.currency ?? token.mpt_issuance_id,
    ...(token.issuer !== undefined && { issuer: token.issuer }),
  };
}

/**
 * Payment: the other party (the destination for the sender, the sender for the destination) and, when it succeeded,
 * the delivered amount. The amount and its issuer are the ones `account_payments` holds (`PaymentParser`): a partial
 * payment from before the fix, whose delivered amount is unknown, gives `Amount`, and an `Amount.issuer` that names a
 * party is resolved to the issuer the trust lines say. A payment to oneself or in MPTs, which that parser leaves out,
 * gives its delivered amount as it is. An account that is neither party (an issuer it rippled through, the owner of an
 * offer it took) gets nothing.
 */
function paymentSide({ tx, meta, row, account, ctx }: Seen): Side | undefined {
  const sent = tx.Account === account;
  if (!sent && tx.Destination !== account) return undefined;
  const counterparty: string = sent ? tx.Destination : tx.Account;
  if (meta.TransactionResult !== 'tesSUCCESS') return { counterparty };

  const parsed = payments.parse(
    {
      hash: row.hash,
      ledger_index: row.ledger_index,
      close_time: row.close_time,
      tx_index: row.tx_index,
      tx,
      meta,
      client: null,
    },
    ctx,
  );
  if (parsed) {
    return {
      counterparty,
      amount: parsed.delivered_amount,
      currency: parsed.currency,
      ...(parsed.issuer !== undefined && { issuer: parsed.issuer }),
    };
  }
  const delivered = deliveredAmount(tx, meta, row.ledger_index, ctx);
  return { counterparty, ...amountSide(delivered === 'unavailable' ? tx.Amount : delivered, ctx) };
}

/**
 * TrustSet: the peer of the trust line (the `LimitAmount` issuer for the sender, the sender for that issuer) and the
 * limit the sender set, with its currency and issuer.
 */
function trustSetSide({ tx, account }: Seen): Side | undefined {
  const limit: Json | undefined = tx.LimitAmount;
  if (typeof limit !== 'object' || limit === null) return undefined;
  const counterparty = tx.Account === account ? limit.issuer : limit.issuer === account ? tx.Account : undefined;
  if (counterparty === undefined) return undefined;
  return { counterparty, amount: limit.value, currency: limit.currency, issuer: limit.issuer };
}

/** The mapping per transaction type. A type that is not here (OfferCreate, AccountSet, ...) has no side. */
const SIDES: Record<string, (seen: Seen) => Side | undefined> = {
  Payment: paymentSide,
  TrustSet: trustSetSide,
};

/**
 * The state of the account that a transaction wrote in the account state history (`account_states`): its account root
 * after the transaction, and where that node is in the transaction's metadata.
 */
export interface AccountStateOfTx {
  /** The position of the AccountRoot node in `meta.AffectedNodes`. */
  node_index: number;
  /** `Flags` after the transaction. */
  flags: number;
}

/**
 * The account flags before the transaction: the `PreviousFields` of the account's node in the stored metadata. A node
 * modified without `Flags` there kept its flags; a created node had none (the account did not exist).
 */
function flagsBefore(meta: Json, state: AccountStateOfTx): number {
  const entry: Json | undefined = meta.AffectedNodes?.[state.node_index];
  if (entry?.CreatedNode) return 0;
  const node: Json | undefined = entry?.ModifiedNode ?? entry?.DeletedNode;
  const previous: unknown = node?.PreviousFields?.Flags;
  return typeof previous === 'number' ? previous : state.flags;
}

/**
 * `+Name` for each flag set from `before` to `after` and `-Name` for each one cleared, the set ones first, each in the
 * order of the list; `null` when none changed. A bit the network does not name is left out.
 */
export function flagChanges(before: number, after: number, names: readonly AccountFlag[]): string | null {
  const isSet = (flags: number, bit: number): boolean => ((flags >>> 0) & bit) >>> 0 === bit;
  const set = names.filter(({ bit }) => !isSet(before, bit) && isSet(after, bit)).map(({ name }) => `+${name}`);
  const cleared = names.filter(({ bit }) => isSet(before, bit) && !isSet(after, bit)).map(({ name }) => `-${name}`);
  const changes = [...set, ...cleared];
  return changes.length > 0 ? changes.join(' ') : null;
}

/** What a summary row needs besides the stored transaction: the account flags the network names, and the account's state. */
export interface SummaryContext {
  ctx: ParseContext;
  flagNames: readonly AccountFlag[];
  /** The account's state written by this transaction; none when it changed nothing of the account root. */
  state?: AccountStateOfTx;
}

/** The summary row of a stored transaction, from the side of `account`. */
export function toTransactionSummary(
  row: TransactionsRow,
  account: string,
  { ctx, flagNames, state }: SummaryContext,
): TransactionSummary {
  const tx = JSON.parse(row.tx_json) as Json;
  const meta = JSON.parse(row.meta_json) as Json;
  const initiator = row.account === account;
  const side = SIDES[row.tx_type]?.({ tx, meta, row, account, ctx }) ?? {};
  return {
    hash: row.hash,
    ledger_index: row.ledger_index,
    executed_time: fmtTxDate(row.close_time),
    tx_type: row.tx_type,
    result: row.result,
    initiator,
    counterparty: side.counterparty ?? null,
    amount: side.amount ?? null,
    currency: side.currency ?? null,
    issuer: side.issuer ?? null,
    fee: initiator ? dropsToNative(row.fee) : null,
    flags_changed: state ? flagChanges(flagsBefore(meta, state), state.flags, flagNames) : null,
  };
}

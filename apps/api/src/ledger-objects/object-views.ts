import {
  dropsToNative,
  isMptIssuanceId,
  mptAmountObject,
  Permission,
  permissionOf,
  TrackedObjectType,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { compact, fmtTime } from '../common/format';
import { CsvRow, toCsvRow } from '../nft/nft-objects';
import { channelStatus, ChannelStatus, checkStatus, CheckStatus, escrowStatus, EscrowStatus } from './object-status';

/**
 * The response objects of the escrow, check, payment channel and delegation routes (spec 5.1 to 5.7), written down here once
 * and pinned by the tests: each is built by a function that writes its keys in the order of its constant and leaves out the
 * keys it has no value for (`null` is never written).
 *
 * The input is a row of `object_changes` (`ObjectRead`) whose JSON columns the service has parsed. Its `fields` are the raw
 * ledger values of the node after the transaction: drops as text, issued-token and MPT amount objects, Ripple-epoch times,
 * numbers for the UInt32 fields. Times are written with `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`); a row's `close_time` is unix
 * seconds and a field's time is Ripple-epoch seconds (`rippleIso`).
 *
 * Escrow, in this order: escrow_id, account, sequence?, destination, amount, finish_after?, cancel_after?, condition?,
 *   fulfillment?, destination_tag?, source_tag?, transfer_rate?, status, created?, removed?
 *
 * Check: check_id, account, sequence?, destination, send_max, expiration?, invoice_id?, destination_tag?, source_tag?,
 *   delivered?, status, created?, removed?
 *
 * Payment channel: channel_id, account, sequence?, destination, amount, balance, remaining, settle_delay, public_key,
 *   expiration?, cancel_after?, destination_tag?, source_tag?, status, opened_with?, funds, claims, created?, removed?
 *
 * Event: event, ledger_index, time, tx_hash, tx_type, account, delegate?, result, then the type's keys (`EVENT_EXTRA_KEYS`).
 *
 * Delegation: delegation_id, account, authorize, permissions, updated, created?
 *
 * A CSV has the same columns on every page whatever the events of the page hold (a CSV takes its columns from the keys of the
 * rows, and a key that is left out would move them, so a page of `create` events and one of `finish` events would have two
 * headers): `objectEventCsvRow` and `delegationCsvRow` give every column of the type, `null` (an empty cell) where the object
 * has none, an amount's keys joined to its name with a dot (`amount.value`), and a delegation's permission names in one cell.
 */

// -- the keys ------------------------------------------------------------------------------------------------------------

/** `created` and `updated`: the place of a fact in the ledger history. */
export const OBJECT_REF_KEYS = ['ledger_index', 'time', 'tx_hash'] as const;
/** `removed`: the place of the deleting transaction. */
export const REMOVED_KEYS = ['ledger_index', 'time', 'tx_hash', 'tx_type'] as const;
/** The keys of an `ObjectAmount`, in order. */
export const AMOUNT_KEYS = ['currency', 'issuer', 'value', 'mpt_issuance_id'] as const;

/** The keys every event starts with (`account` is the transaction's sender). */
export const EVENT_KEYS = [
  'event',
  'ledger_index',
  'time',
  'tx_hash',
  'tx_type',
  'account',
  'delegate',
  'result',
] as const;

export const ESCROW_KEYS = [
  'escrow_id',
  'account',
  'sequence',
  'destination',
  'amount',
  'finish_after',
  'cancel_after',
  'condition',
  'fulfillment',
  'destination_tag',
  'source_tag',
  'transfer_rate',
  'status',
  'created',
  'removed',
] as const;

export const CHECK_KEYS = [
  'check_id',
  'account',
  'sequence',
  'destination',
  'send_max',
  'expiration',
  'invoice_id',
  'destination_tag',
  'source_tag',
  'delivered',
  'status',
  'created',
  'removed',
] as const;

export const PAYMENT_CHANNEL_KEYS = [
  'channel_id',
  'account',
  'sequence',
  'destination',
  'amount',
  'balance',
  'remaining',
  'settle_delay',
  'public_key',
  'expiration',
  'cancel_after',
  'destination_tag',
  'source_tag',
  'status',
  'opened_with',
  'funds',
  'claims',
  'created',
  'removed',
] as const;

/** What an event of each type adds to `EVENT_KEYS`, in order. */
export const EVENT_EXTRA_KEYS = {
  escrow: ['amount', 'fulfillment'],
  check: ['send_max', 'expiration', 'delivered'],
  payment_channel: ['amount', 'balance', 'amount_change', 'balance_change', 'expiration', 'settle_delay'],
} as const;

export const DELEGATION_KEYS = ['delegation_id', 'account', 'authorize', 'permissions', 'updated', 'created'] as const;
export const PERMISSION_KEYS = ['permission', 'kind', 'transaction_type'] as const;
export const LEDGER_OBJECT_KEYS = ['object_id', 'object_type', 'account', 'deleted', 'ledger_index'] as const;

/** The keys of the answers, in order: `coverage`, `ledger_index` and `close_time` come right after `result`. */
export const DETAIL_BODY_KEYS = {
  escrow: ['result', 'coverage', 'ledger_index', 'close_time', 'escrow', 'history', 'history_marker'],
  check: ['result', 'coverage', 'ledger_index', 'close_time', 'check', 'history', 'history_marker'],
  payment_channel: ['result', 'coverage', 'ledger_index', 'close_time', 'payment_channel', 'history', 'history_marker'],
} as const;
export const HISTORY_BODY_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'count',
  'marker',
  'history',
] as const;
export const DELEGATIONS_BODY_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'count',
  'marker',
  'delegations',
] as const;

/** The columns of the CSV of an event or a delegation: every key, an object's keys after its name and a dot. */
const flat = (keys: readonly string[], nested: Readonly<Record<string, readonly string[]>> = {}): string[] =>
  keys.flatMap((key) => (key in nested ? nested[key].map((inner) => `${key}.${inner}`) : [key]));

const AMOUNT_EXTRAS = ['amount', 'send_max', 'delivered', 'balance', 'amount_change', 'balance_change'];
const AMOUNT_COLUMNS = Object.fromEntries(AMOUNT_EXTRAS.map((key) => [key, AMOUNT_KEYS]));

/** The columns of the history CSV of each type: `EVENT_KEYS`, then the type's extras with their amounts flattened. */
export const EVENT_CSV_COLUMNS: Readonly<Record<keyof typeof EVENT_EXTRA_KEYS, string[]>> = {
  escrow: flat([...EVENT_KEYS, ...EVENT_EXTRA_KEYS.escrow], AMOUNT_COLUMNS),
  check: flat([...EVENT_KEYS, ...EVENT_EXTRA_KEYS.check], AMOUNT_COLUMNS),
  payment_channel: flat([...EVENT_KEYS, ...EVENT_EXTRA_KEYS.payment_channel], AMOUNT_COLUMNS),
};

/** The columns of the delegations CSV: `permissions` is one cell. */
export const DELEGATION_CSV_COLUMNS = flat(DELEGATION_KEYS, { updated: OBJECT_REF_KEYS, created: OBJECT_REF_KEYS });

// -- the input -----------------------------------------------------------------------------------------------------------

/** A row of `object_changes` as the service reads it: the JSON columns parsed, `close_time` in unix seconds. */
export interface ObjectRead {
  object_type: TrackedObjectType;
  object_id: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: number;
  tx_type: string;
  result: string;
  sender: string;
  delegate: string;
  action: 'created' | 'modified' | 'deleted';
  event: string;
  owner: string;
  counterparty: string;
  fields: Record<string, unknown>;
  previous: Record<string, unknown>;
  event_fields: Record<string, unknown>;
}

// -- the objects ---------------------------------------------------------------------------------------------------------

/** An amount: the native currency's code without an issuer, an issued token as on the ledger, or an MPT (spec 5.1). */
export type ObjectAmount = { currency: string; issuer?: string; value: string; mpt_issuance_id?: string };

/** The place of a fact in the ledger history (`created`, `updated`). */
export interface ObjectRef {
  ledger_index: number;
  time: string;
  tx_hash: string;
}

/** The transaction that deleted the object (`removed`). */
export interface RemovedRef extends ObjectRef {
  tx_type: string;
}

export interface EscrowObject {
  escrow_id: string;
  account: string;
  sequence?: number;
  destination: string;
  amount?: ObjectAmount;
  finish_after?: string;
  cancel_after?: string;
  condition?: string;
  fulfillment?: string;
  destination_tag?: number;
  source_tag?: number;
  transfer_rate?: number;
  status: EscrowStatus;
  created?: ObjectRef;
  removed?: RemovedRef;
}

export interface CheckObject {
  check_id: string;
  account: string;
  sequence?: number;
  destination: string;
  send_max?: ObjectAmount;
  expiration?: string;
  invoice_id?: string;
  destination_tag?: number;
  source_tag?: number;
  delivered?: ObjectAmount;
  status: CheckStatus;
  created?: ObjectRef;
  removed?: RemovedRef;
}

export interface PaymentChannelObject {
  channel_id: string;
  account: string;
  sequence?: number;
  destination: string;
  amount?: ObjectAmount;
  balance?: ObjectAmount;
  remaining?: ObjectAmount;
  settle_delay?: number;
  public_key?: string;
  expiration?: string;
  cancel_after?: string;
  destination_tag?: number;
  source_tag?: number;
  status: ChannelStatus;
  opened_with?: ObjectAmount;
  funds: number;
  claims: number;
  created?: ObjectRef;
  removed?: RemovedRef;
}

/** One event of an object's history: what the row says, then the facts of its type. */
export interface ObjectEvent {
  event: string;
  ledger_index: number;
  time: string;
  tx_hash: string;
  tx_type: string;
  account: string;
  delegate?: string;
  result: string;
  amount?: ObjectAmount;
  fulfillment?: string;
  send_max?: ObjectAmount;
  expiration?: string;
  delivered?: ObjectAmount;
  balance?: ObjectAmount;
  amount_change?: ObjectAmount;
  balance_change?: ObjectAmount;
  settle_delay?: number;
}

export interface DelegationObject {
  delegation_id: string;
  account: string;
  authorize: string;
  permissions: Permission[];
  updated: ObjectRef;
  created?: ObjectRef;
}

// -- helpers -------------------------------------------------------------------------------------------------------------

/** Unix seconds of Ripple-epoch zero (2000-01-01T00:00:00Z). */
const RIPPLE_EPOCH = 946_684_800;

/** A Ripple-epoch time (seconds) as `YYYY-MM-DDTHH:mm:ssZ`. */
export function rippleIso(seconds: number): string {
  return fmtTime(seconds + RIPPLE_EPOCH);
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Ripple-epoch field as ISO UTC, and as unix seconds (what the status rules take). */
const isoOf = (rippleSeconds: unknown): string | undefined => {
  const seconds = num(rippleSeconds);
  return seconds === undefined ? undefined : rippleIso(seconds);
};
const unixOf = (rippleSeconds: unknown): number | undefined => {
  const seconds = num(rippleSeconds);
  return seconds === undefined ? undefined : seconds + RIPPLE_EPOCH;
};

/**
 * A ledger amount as the API's amount object: drops of the native currency (`native`, `XRP` or `XAH`) converted to whole
 * units, an issued token with its `value` text and currency code as they are, an MPT as the data API's MPT amount object
 * (spec 5.1). `undefined` for anything else (an absent field, text that is not a number of drops, an object that names no
 * currency or issuance).
 */
export function objectAmount(raw: unknown, native: string): ObjectAmount | undefined {
  if (typeof raw === 'string') return /^\d+$/.test(raw) ? { currency: native, value: dropsToNative(raw) } : undefined;
  if (!isRecord(raw)) return undefined;
  const value = text(raw.value);
  if (value === undefined) return undefined;
  const id = text(raw.mpt_issuance_id);
  if (id !== undefined) return isMptIssuanceId(id) ? mptAmountObject(id, value) : undefined;
  const currency = text(raw.currency);
  const issuer = text(raw.issuer);
  return currency !== undefined && issuer !== undefined ? { currency, issuer, value } : undefined;
}

/** The same currency with another value (a computed one: its text is a plain decimal, never an exponent). */
const withValue = (amount: ObjectAmount, value: string): ObjectAmount => ({ ...amount, value });

/** `a - b` in the currency of `a`; `undefined` when either value is not a number. */
function difference(a: ObjectAmount | undefined, b: ObjectAmount | undefined): ObjectAmount | undefined {
  if (a === undefined || b === undefined) return undefined;
  const result = new BigNumber(a.value).minus(b.value);
  return result.isNaN() ? undefined : withValue(a, result.toFixed());
}

const isZero = (amount: ObjectAmount | undefined): boolean =>
  amount !== undefined && new BigNumber(amount.value).isZero();

const ref = (row: ObjectRead): ObjectRef => ({
  ledger_index: row.ledger_index,
  time: fmtTime(row.close_time),
  tx_hash: row.tx_hash,
});

const removedRef = (row: ObjectRead): RemovedRef => ({ ...ref(row), tx_type: row.tx_type });

/** The `removed` of an object whose newest row deleted it, and the event that did (`removedBy` of the status rules). */
const removal = (newest: ObjectRead): { removed?: RemovedRef; removedBy?: string } =>
  newest.action === 'deleted' ? { removed: removedRef(newest), removedBy: newest.event } : {};

/** `Sequence` of the node, else the sequence the creating transaction gave (a ticketed one, an object without a `Sequence`). */
const sequenceOf = (newest: ObjectRead, created: ObjectRead | undefined): number | undefined =>
  num(newest.fields.Sequence) ?? num(created?.event_fields.sequence);

// -- escrows, checks, payment channels -----------------------------------------------------------------------------------

/** An escrow from its newest row (its state, and its removal once deleted) and its created row when the index has it. */
export function escrowObject(
  newest: ObjectRead,
  created: ObjectRead | undefined,
  t: number,
  native: string,
): EscrowObject {
  const f = newest.fields;
  const { removed, removedBy } = removal(newest);
  return compact({
    escrow_id: newest.object_id,
    account: newest.owner,
    sequence: sequenceOf(newest, created),
    destination: newest.counterparty,
    amount: objectAmount(f.Amount, native),
    finish_after: isoOf(f.FinishAfter),
    cancel_after: isoOf(f.CancelAfter),
    condition: text(f.Condition),
    fulfillment: removed && text(newest.event_fields.fulfillment),
    destination_tag: num(f.DestinationTag),
    source_tag: num(f.SourceTag),
    transfer_rate: num(f.TransferRate),
    status: escrowStatus({ finishAfter: unixOf(f.FinishAfter), cancelAfter: unixOf(f.CancelAfter), removedBy }, t),
    created: created && ref(created),
    removed,
  });
}

/** A check from its newest row and its created row. */
export function checkObject(
  newest: ObjectRead,
  created: ObjectRead | undefined,
  t: number,
  native: string,
): CheckObject {
  const f = newest.fields;
  const { removed, removedBy } = removal(newest);
  return compact({
    check_id: newest.object_id,
    account: newest.owner,
    sequence: sequenceOf(newest, created),
    destination: newest.counterparty,
    send_max: objectAmount(f.SendMax, native),
    expiration: isoOf(f.Expiration),
    invoice_id: text(f.InvoiceID),
    destination_tag: num(f.DestinationTag),
    source_tag: num(f.SourceTag),
    delivered: removed && objectAmount(newest.event_fields.delivered, native),
    status: checkStatus({ expiration: unixOf(f.Expiration), removedBy }, t),
    created: created && ref(created),
    removed,
  });
}

/**
 * A channel's `Balance` after the row: the node's, or zero in the channel's currency when it has none (a created node omits a
 * zero). `undefined` when the node has a `Balance` that is not an amount, or no `Amount` to take the currency from.
 */
function balanceOf(fields: Record<string, unknown>, native: string): ObjectAmount | undefined {
  if (fields.Balance !== undefined) return objectAmount(fields.Balance, native);
  const amount = objectAmount(fields.Amount, native);
  return amount && withValue(amount, '0');
}

/** A payment channel from its newest row, its created row (the deposit it opened with) and the counts of its events. */
export function paymentChannelObject(
  newest: ObjectRead,
  created: ObjectRead | undefined,
  counts: { funds: number; claims: number },
  t: number,
  native: string,
): PaymentChannelObject {
  const f = newest.fields;
  const { removed, removedBy } = removal(newest);
  const amount = objectAmount(f.Amount, native);
  const balance = balanceOf(f, native);
  return compact({
    channel_id: newest.object_id,
    account: newest.owner,
    sequence: sequenceOf(newest, created),
    destination: newest.counterparty,
    amount,
    balance,
    remaining: difference(amount, balance),
    settle_delay: num(f.SettleDelay),
    public_key: text(f.PublicKey),
    expiration: isoOf(f.Expiration),
    cancel_after: isoOf(f.CancelAfter),
    destination_tag: num(f.DestinationTag),
    source_tag: num(f.SourceTag),
    status: channelStatus({ expiration: unixOf(f.Expiration), cancelAfter: unixOf(f.CancelAfter), removedBy }, t),
    opened_with: created && objectAmount(created.fields.Amount, native),
    funds: counts.funds,
    claims: counts.claims,
    created: created && ref(created),
    removed,
  });
}

// -- events --------------------------------------------------------------------------------------------------------------

/** What an escrow event adds: `amount` when it created the escrow, `fulfillment` when it finished it. */
function escrowExtras(row: ObjectRead, native: string): Partial<ObjectEvent> {
  return {
    amount: row.event === 'create' ? objectAmount(row.fields.Amount, native) : undefined,
    fulfillment: row.event === 'finish' ? text(row.event_fields.fulfillment) : undefined,
  };
}

/** What a check event adds: `send_max` and `expiration` when it created the check, `delivered` when it was cashed. */
function checkExtras(row: ObjectRead, native: string): Partial<ObjectEvent> {
  const create = row.event === 'create';
  return {
    send_max: create ? objectAmount(row.fields.SendMax, native) : undefined,
    expiration: create ? isoOf(row.fields.Expiration) : undefined,
    delivered: row.event === 'cash' ? objectAmount(row.event_fields.delivered, native) : undefined,
  };
}

/**
 * What a channel event adds: `amount` and `balance` after it, what each changed by when `previous` has it and the change is
 * not zero (after less before, in the channel's currency), `expiration` after it, `settle_delay` when it created the channel.
 */
function channelExtras(row: ObjectRead, native: string): Partial<ObjectEvent> {
  const { fields: f, previous: p } = row;
  const amount = objectAmount(f.Amount, native);
  const balance = balanceOf(f, native);
  const change = (after: ObjectAmount | undefined, before: unknown): ObjectAmount | undefined => {
    const delta = before === undefined ? undefined : difference(after, objectAmount(before, native));
    return isZero(delta) ? undefined : delta;
  };
  return {
    amount,
    balance,
    amount_change: change(amount, p.Amount),
    balance_change: change(balance, p.Balance),
    expiration: isoOf(f.Expiration),
    settle_delay: row.event === 'create' ? num(f.SettleDelay) : undefined,
  };
}

const EXTRAS: Partial<Record<TrackedObjectType, (row: ObjectRead, native: string) => Partial<ObjectEvent>>> = {
  Escrow: escrowExtras,
  Check: checkExtras,
  PayChannel: channelExtras,
};

/** An event of an object's history from its row: the transaction, then the facts of the object's type. */
export function objectEvent(row: ObjectRead, native: string): ObjectEvent {
  return compact({
    event: row.event,
    ledger_index: row.ledger_index,
    time: fmtTime(row.close_time),
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    account: row.sender,
    delegate: text(row.delegate),
    result: row.result,
    ...EXTRAS[row.object_type]?.(row, native),
  });
}

// -- delegations ---------------------------------------------------------------------------------------------------------

/**
 * A delegation from its newest row and its created row. Its permissions are the node's `Permissions[].Permission.
 * PermissionValue` (a transaction type's name or number, or a granular permission) through `permissionOf`, an entry with no
 * value left out; `transactionTypes` is the network's `TRANSACTION_TYPES`. `updated` is the newest row's place.
 */
export function delegationObject(
  newest: ObjectRead,
  created: ObjectRead | undefined,
  transactionTypes: Readonly<Record<string, number>>,
): DelegationObject {
  const entries: unknown[] = Array.isArray(newest.fields.Permissions) ? newest.fields.Permissions : [];
  const values = entries.map((entry) =>
    isRecord(entry) && isRecord(entry.Permission) ? entry.Permission.PermissionValue : undefined,
  );
  return compact({
    delegation_id: newest.object_id,
    account: newest.owner,
    authorize: newest.counterparty,
    permissions: values.filter((value) => value !== undefined).map((value) => permissionOf(value, transactionTypes)),
    updated: ref(newest),
    created: created && ref(created),
  });
}

// -- CSV -----------------------------------------------------------------------------------------------------------------

/** The CSV row of an event of `kind`: every column of `EVENT_CSV_COLUMNS[kind]`, `null` where the event has none. */
export function objectEventCsvRow(event: ObjectEvent, kind: keyof typeof EVENT_EXTRA_KEYS): CsvRow {
  return toCsvRow(event, EVENT_CSV_COLUMNS[kind]);
}

/** The CSV row of a delegation: every column of `DELEGATION_CSV_COLUMNS`, the permission names in one cell. */
export function delegationCsvRow(delegation: DelegationObject): CsvRow {
  const names = delegation.permissions.map((p) => p.permission).join(' ');
  return toCsvRow({ ...delegation, permissions: names }, DELEGATION_CSV_COLUMNS);
}

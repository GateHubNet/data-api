import { stableStringify } from '../util/stable-json';
import { ParseContext, ParserTx } from './parser.interface';

/** The ledger entry types whose history the index keeps (spec 1.1): the `LedgerEntryType` of the nodes it follows. */
export const TRACKED_OBJECT_TYPES = ['Escrow', 'Check', 'PayChannel', 'Delegate'] as const;
export type TrackedObjectType = (typeof TRACKED_OBJECT_TYPES)[number];

/**
 * The events a row of each type can have (spec 2.2): the one list of them, which the API validates its `event` filters
 * against. `update` is a change by a transaction the table does not expect.
 */
export const OBJECT_EVENTS: Readonly<Record<TrackedObjectType, readonly string[]>> = {
  Escrow: ['create', 'finish', 'cancel', 'removed', 'update'],
  Check: ['create', 'cash', 'cancel', 'removed', 'update'],
  PayChannel: ['create', 'fund', 'claim', 'close_request', 'renew', 'close', 'removed', 'update'],
  Delegate: ['set', 'delete', 'removed', 'update'],
};

/**
 * Not stored: what `fields` and `previous` leave out, at the top level of the node (spec 1.1). The thread fields say which
 * transaction touched the node last, and the others are the pages of the directories that list it.
 */
export const OBJECT_FIELD_EXCLUSIONS: readonly string[] = [
  'PreviousTxnID',
  'PreviousTxnLgrSeq',
  'OwnerNode',
  'DestinationNode',
  'IssuerNode',
];

/** `PaymentChannelClaim` `tfRenew`: asks to clear the channel's `Expiration`. */
export const TF_RENEW = 0x00010000;
/** `PaymentChannelClaim` `tfClose`: asks to close the channel (at once, or after its `SettleDelay`). */
export const TF_CLOSE = 0x00020000;

/** One created, modified or deleted node of a tracked type in a transaction's metadata (spec 2.1). */
export interface ParsedObjectChange {
  object_type: TrackedObjectType;
  /** The node's `LedgerIndex`, 64 hex digits, upper case. */
  object_id: string;
  action: 'created' | 'modified' | 'deleted';
  event: string;
  /** The object's `Account`. */
  owner: string;
  /** Its `Destination` (`Escrow`, `Check`, `PayChannel`) or `Authorize` (`Delegate`). */
  counterparty: string;
  /** The node's fields after the transaction (`NewFields` of a created node, else `FinalFields`), sorted-key JSON. */
  fields: string;
  /** `PreviousFields`, sorted-key JSON; `'{}'` when the node has none. */
  previous: string;
  /** The facts the event takes from the transaction (`sequence`, `fulfillment`, `delivered`), sorted-key JSON; `'{}'` when none. */
  event_fields: string;
}

type Json = Readonly<Record<string, any>>;
type Action = ParsedObjectChange['action'];

/** The three kinds of node in `meta.AffectedNodes`, and what each did to the object. */
const ACTIONS: Readonly<Record<string, Action>> = {
  CreatedNode: 'created',
  ModifiedNode: 'modified',
  DeletedNode: 'deleted',
};
const OPS = Object.keys(ACTIONS);

const isTracked = (type: unknown): type is TrackedObjectType =>
  (TRACKED_OBJECT_TYPES as readonly unknown[]).includes(type);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `flags` has `flag` set. (`&` wraps a UInt32 above 2^31 to a negative number, which only matters if it is 0.) */
const hasFlag = (flags: unknown, flag: number): boolean => typeof flags === 'number' && (flags & flag) !== 0;

/** `fields` without the top-level keys of `OBJECT_FIELD_EXCLUSIONS`, as sorted-key JSON. */
function stored(fields: Json | undefined): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!OBJECT_FIELD_EXCLUSIONS.includes(key)) kept[key] = value;
  }
  return stableStringify(kept);
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * The sequence an object created by `tx` is known by: its `Sequence`, or its `TicketSequence` when `Sequence` is 0 or
 * absent. Neither gives none: the key is left out, and a reader takes the sequence from the object's own `Sequence` field.
 * (A Xahau Hook-emitted transaction is the case: all 12 in the recorded Xahau ledgers have `Sequence` 0 and no ticket.)
 */
function sequenceOf(tx: Json): number | undefined {
  if (positiveInteger(tx.Sequence)) return tx.Sequence;
  if (positiveInteger(tx.TicketSequence)) return tx.TicketSequence;
  return undefined;
}

/**
 * The amount a cash delivered: the metadata's `DeliveredAmount` when it stores one (an issued-token cash does, a cash with
 * `DeliverMin` does), else the `delivered_amount` the node serves, else the transaction's `Amount` (a cash for an exact
 * amount delivers it or fails). Never `DeliverMin`, which is only the least the casher accepts. None when the metadata
 * and the transaction name no amount.
 */
function deliveredOf(tx: Json, meta: Json): unknown {
  return meta.DeliveredAmount ?? meta.delivered_amount ?? tx.Amount;
}

/**
 * The event of a node and the facts it takes from the transaction (spec 2.2): the first row of the table that matches, else
 * `update`.
 */
function eventOf(
  type: TrackedObjectType,
  action: Action,
  t: ParserTx,
  fields: Json,
  previous: Json | undefined,
): { event: string; facts: Record<string, unknown> } {
  const { tx, meta } = t;
  const by: unknown = tx.TransactionType;
  const sequence = sequenceOf(tx);
  const create = { event: 'create', facts: sequence === undefined ? {} : { sequence } };
  const plain = (event: string) => ({ event, facts: {} });

  switch (type) {
    case 'Escrow':
      if (action === 'created' && by === 'EscrowCreate') return create;
      if (action === 'deleted') {
        if (by === 'EscrowFinish') {
          return { event: 'finish', facts: typeof tx.Fulfillment === 'string' ? { fulfillment: tx.Fulfillment } : {} };
        }
        return plain(by === 'EscrowCancel' ? 'cancel' : 'removed');
      }
      break;

    case 'Check':
      if (action === 'created' && by === 'CheckCreate') return create;
      if (action === 'deleted') {
        if (by === 'CheckCash') {
          const delivered = deliveredOf(tx, meta);
          return { event: 'cash', facts: delivered === undefined ? {} : { delivered } };
        }
        return plain(by === 'CheckCancel' ? 'cancel' : 'removed');
      }
      break;

    case 'PayChannel':
      if (action === 'created' && by === 'PaymentChannelCreate') return create;
      if (action === 'deleted')
        return plain(by === 'PaymentChannelClaim' || by === 'PaymentChannelFund' ? 'close' : 'removed');
      if (action === 'modified' && by === 'PaymentChannelFund') return plain('fund');
      if (action === 'modified' && by === 'PaymentChannelClaim') {
        if (hasFlag(tx.Flags, TF_CLOSE) && 'Expiration' in fields) return plain('close_request');
        if (hasFlag(tx.Flags, TF_RENEW) && previous && 'Expiration' in previous && !('Expiration' in fields)) {
          return plain('renew');
        }
        return plain('claim');
      }
      break;

    case 'Delegate':
      if (by === 'DelegateSet' && action !== 'deleted') return plain('set');
      if (action === 'deleted') return plain(by === 'DelegateSet' ? 'delete' : 'removed');
      break;
  }
  return plain('update');
}

/**
 * Escrows, checks, payment channels and delegations: their history from transaction metadata (spec 2.1, 2.2).
 */
export class ObjectChangesParser {
  /**
   * A row for every created, modified or deleted node of a tracked type in `meta.AffectedNodes`, in that order, whatever the
   * transaction's result (the metadata of a `tec` transaction can carry a changed node too, though no recorded one does and the
   * recorded close of an expired channel is `tesSUCCESS`; the row keeps the result in the columns the writer adds). A modified node without `PreviousFields` was only threaded (its `PreviousTxnID` moved) and
   * changed nothing of the object: no row. A node of another type is skipped.
   *
   * The object is read from the node and nothing else: Xahau's `EscrowFinish` and `EscrowCancel` may name the escrow by
   * `EscrowID`, and then their `Owner` is the escrow's destination, but the deleted node is the escrow either way.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it (the JSON columns are text).
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedObjectChange[] {
    const rows: ParsedObjectChange[] = [];
    const nodes: readonly Json[] = t.meta.AffectedNodes ?? [];

    for (const wrapper of nodes) {
      const op = OPS.find((o) => isObject(wrapper?.[o]));
      if (!op) continue;
      const action = ACTIONS[op];
      const node: Json = wrapper[op];
      const type: unknown = node.LedgerEntryType;
      if (!isTracked(type)) continue;
      if (action === 'modified' && !isObject(node.PreviousFields)) continue;

      const fields: unknown = action === 'created' ? node.NewFields : node.FinalFields;
      if (!isObject(fields) || typeof node.LedgerIndex !== 'string') continue;
      const previous: Json | undefined = isObject(node.PreviousFields) ? node.PreviousFields : undefined;

      const { event, facts } = eventOf(type, action, t, fields, previous);
      const counterparty = type === 'Delegate' ? fields.Authorize : fields.Destination;
      rows.push({
        object_type: type,
        object_id: node.LedgerIndex.toUpperCase(),
        action,
        event,
        owner: typeof fields.Account === 'string' ? fields.Account : '',
        counterparty: typeof counterparty === 'string' ? counterparty : '',
        fields: stored(fields),
        previous: stored(previous),
        event_fields: stableStringify(facts),
      });
    }
    return rows;
  }
}

import type { ParserTx } from '../src/parsers/parser.interface';

/**
 * The oracle of the object changes parser tests: the rows `ObjectChangesParser.parse` has to return for one transaction,
 * decided from its metadata in plain JavaScript by the rules of sections 1.1, 2.1 and 2.2 of the ledger objects spec
 * (`docs/superpowers/specs/2026-10-24-ledger-objects-delegation-design.md`) and the controller's ruling for Task 4 (a cash
 * delivers the stored `DeliveredAmount`, else the `delivered_amount` the node serves, else `Amount`). The one case the spec
 * does not cover: a created row's `sequence` is left out when the transaction has neither a `Sequence` nor a
 * `TicketSequence` (as a Xahau Hook-emitted one has), and a reader takes the object's own `Sequence`. It imports nothing from the
 * parser: the event is looked up in `EVENT_RULES`, a table of `(type, action, TransactionType, condition) -> event` read in
 * order, the flag bits are tested by arithmetic, and the fields are filtered with a `Set`, so a mistake in one of them shows
 * up as a difference. The row's `fields`, `previous` and `event_fields` are plain objects here (the parser writes them as
 * sorted-key JSON text); the spec compares `JSON.parse` of the parser's text.
 *
 * Used by `src/parsers/object-changes.parser.spec.ts`, which compares the two over every recorded and synthetic transaction.
 */

type Json = Record<string, any>;

export interface OracleRow {
  object_type: string;
  object_id: string;
  action: 'created' | 'modified' | 'deleted';
  event: string;
  owner: string;
  counterparty: string;
  fields: Json;
  previous: Json;
  event_fields: Json;
}

/** The ledger entry types the index follows, and the field that names the other party of each. */
const COUNTERPARTY_FIELD: Readonly<Record<string, string>> = {
  Escrow: 'Destination',
  Check: 'Destination',
  PayChannel: 'Destination',
  Delegate: 'Authorize',
};

/** What a node's fields leave out (spec 1.1): the thread fields and the directory page numbers. */
const NOT_STORED = new Set(['PreviousTxnID', 'PreviousTxnLgrSeq', 'OwnerNode', 'DestinationNode', 'IssuerNode']);

/** `PaymentChannelClaim` flags (rippled): `tfRenew` is bit 16, `tfClose` bit 17. */
const BIT_RENEW = 16;
const BIT_CLOSE = 17;

const hasBit = (flags: unknown, bit: number): boolean =>
  typeof flags === 'number' && Math.floor(flags / 2 ** bit) % 2 === 1;

/** What a rule looks at: the transaction, its metadata and the node. */
interface Look {
  txType: string;
  flags: unknown;
  final: Json;
  previous: Json | undefined;
}

interface EventRule {
  type: string;
  actions: readonly ('created' | 'modified' | 'deleted')[];
  /** The transaction types it applies to; `undefined` is any. */
  by?: readonly string[];
  /** A further condition on the transaction's flags and the node's fields. */
  when?: (look: Look) => boolean;
  event: string;
}

const claimWithClose = (look: Look): boolean => hasBit(look.flags, BIT_CLOSE) && 'Expiration' in look.final;
const claimWithRenew = (look: Look): boolean =>
  hasBit(look.flags, BIT_RENEW) &&
  look.previous !== undefined &&
  'Expiration' in look.previous &&
  !('Expiration' in look.final);

/** Spec 2.2 in the order of its table. The first rule that applies gives the event; none is `update`. */
const EVENT_RULES: readonly EventRule[] = [
  { type: 'Escrow', actions: ['created'], by: ['EscrowCreate'], event: 'create' },
  { type: 'Escrow', actions: ['deleted'], by: ['EscrowFinish'], event: 'finish' },
  { type: 'Escrow', actions: ['deleted'], by: ['EscrowCancel'], event: 'cancel' },
  { type: 'Escrow', actions: ['deleted'], event: 'removed' },

  { type: 'Check', actions: ['created'], by: ['CheckCreate'], event: 'create' },
  { type: 'Check', actions: ['deleted'], by: ['CheckCash'], event: 'cash' },
  { type: 'Check', actions: ['deleted'], by: ['CheckCancel'], event: 'cancel' },
  { type: 'Check', actions: ['deleted'], event: 'removed' },

  { type: 'PayChannel', actions: ['created'], by: ['PaymentChannelCreate'], event: 'create' },
  { type: 'PayChannel', actions: ['deleted'], by: ['PaymentChannelClaim', 'PaymentChannelFund'], event: 'close' },
  { type: 'PayChannel', actions: ['deleted'], event: 'removed' },
  { type: 'PayChannel', actions: ['modified'], by: ['PaymentChannelFund'], event: 'fund' },
  {
    type: 'PayChannel',
    actions: ['modified'],
    by: ['PaymentChannelClaim'],
    when: claimWithClose,
    event: 'close_request',
  },
  { type: 'PayChannel', actions: ['modified'], by: ['PaymentChannelClaim'], when: claimWithRenew, event: 'renew' },
  { type: 'PayChannel', actions: ['modified'], by: ['PaymentChannelClaim'], event: 'claim' },

  { type: 'Delegate', actions: ['created', 'modified'], by: ['DelegateSet'], event: 'set' },
  { type: 'Delegate', actions: ['deleted'], by: ['DelegateSet'], event: 'delete' },
  { type: 'Delegate', actions: ['deleted'], event: 'removed' },
];

const ACTION_OF: Readonly<Record<string, OracleRow['action']>> = {
  CreatedNode: 'created',
  ModifiedNode: 'modified',
  DeletedNode: 'deleted',
};

function eventOf(type: string, action: OracleRow['action'], look: Look): string {
  const rule = EVENT_RULES.find(
    (r) =>
      r.type === type &&
      r.actions.includes(action) &&
      (r.by === undefined || r.by.includes(look.txType)) &&
      (r.when === undefined || r.when(look)),
  );
  return rule ? rule.event : 'update';
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** The facts an event takes from the transaction (spec 2.2, and the rulings in the header). */
function eventFieldsOf(event: string, tx: Json, meta: Json): Json {
  if (event === 'create') {
    if (positive(tx.Sequence)) return { sequence: tx.Sequence };
    if (positive(tx.TicketSequence)) return { sequence: tx.TicketSequence };
    return {};
  }
  if (event === 'finish') return tx.Fulfillment === undefined ? {} : { fulfillment: tx.Fulfillment };
  if (event === 'cash') {
    // Never DeliverMin: it is a floor, not what was delivered.
    const delivered = [meta.DeliveredAmount, meta.delivered_amount, tx.Amount].find((v) => v !== undefined);
    return delivered === undefined ? {} : { delivered };
  }
  return {};
}

function stored(fields: Json | undefined): Json {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => !NOT_STORED.has(key)));
}

/** The rows of the transaction, in the order of its `AffectedNodes`. */
export function objectOracle(t: ParserTx): OracleRow[] {
  const tx = t.tx as Json;
  const meta = t.meta as Json;
  const rows: OracleRow[] = [];

  for (const wrapper of (meta.AffectedNodes ?? []) as Json[]) {
    const [op, node] = Object.entries(wrapper)[0] as [string, Json];
    const action = ACTION_OF[op];
    const type: string = node.LedgerEntryType;
    if (action === undefined || COUNTERPARTY_FIELD[type] === undefined) continue;
    // A modified node without PreviousFields was only threaded: nothing of the object changed.
    if (action === 'modified' && node.PreviousFields === undefined) continue;

    const final: Json = action === 'created' ? node.NewFields : node.FinalFields;
    const event = eventOf(type, action, {
      txType: tx.TransactionType,
      flags: tx.Flags,
      final,
      previous: node.PreviousFields,
    });
    rows.push({
      object_type: type,
      object_id: String(node.LedgerIndex).toUpperCase(),
      action,
      event,
      owner: final.Account ?? '',
      counterparty: final[COUNTERPARTY_FIELD[type]] ?? '',
      fields: stored(final),
      previous: stored(node.PreviousFields),
      event_fields: eventFieldsOf(event, tx, meta),
    });
  }
  return rows;
}

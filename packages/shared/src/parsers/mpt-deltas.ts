import { isMptIssuanceId, mptIssuanceId } from '../util/mpt';

type Json = Readonly<Record<string, any>>;

/** What a transaction did to a node. */
export type MptNodeAction = 'created' | 'modified' | 'deleted';

/** A holder's `MPToken` node a transaction changed. Amounts are the ledger's integer units, an absent one 0. */
export interface MptHolderDelta {
  holder: string;
  /** In upper case. */
  mpt_issuance_id: string;
  /** Index of the node in `meta.AffectedNodes`. */
  node_index: number;
  action: MptNodeAction;
  /** `MPTAmount`, the spendable balance. */
  amount_before: bigint;
  amount_after: bigint;
  /** `LockedAmount`, the holder's part in escrow. */
  escrowed_before: bigint;
  escrowed_after: bigint;
  flags: number;
}

/** An `MPTokenIssuance` node a transaction changed. */
export interface MptIssuanceDelta {
  /** Built from the node's `Sequence` and `Issuer`: a create sent with a ticket has `tx.Sequence` 0. */
  mpt_issuance_id: string;
  issuer: string;
  sequence: number;
  /** Index of the node in `meta.AffectedNodes`. */
  node_index: number;
  action: MptNodeAction;
  outstanding_before: bigint;
  outstanding_after: bigint;
  /** `LockedAmount`, what is in escrow. */
  escrowed_before: bigint;
  escrowed_after: bigint;
  /** `NewFields` of a created node, else `FinalFields`. */
  fields: Json;
}

export interface MptDeltas {
  holders: MptHolderDelta[];
  issuances: MptIssuanceDelta[];
  /** What could not be read and a ledger cannot hold: an amount or flags read as 0, a node skipped because it has no ID. */
  anomalies: number;
}

/** The deleted `Escrow` node of an MPT escrow, which is what a finish and a cancel say of it. */
export interface MptEscrow {
  account: string;
  destination: string;
  /** In upper case. */
  mpt_issuance_id: string;
  /** The `value` of its `Amount`, as written. */
  value: unknown;
}

const UINT64_DIGITS = /^\d{1,20}$/;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT32_MAX = 0xffffffff;

/** The integer units of a `UInt64` field as the ledger writes it, a base-10 string; `undefined` for anything else. */
export function mptUnits(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !UINT64_DIGITS.test(value)) return undefined;
  const units = BigInt(value);
  return units <= UINT64_MAX ? units : undefined;
}

/** An integer field of at most `max`, as the ledger writes it; `undefined` for anything else. */
export function mptUInt(value: unknown, max: number = UINT32_MAX): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

/** The issuance of an MPT amount in upper case; `undefined` for any other amount, and for an ID that is not 48 hex digits. */
export function mptAmountIssuance(amount: unknown): string | undefined {
  const id = typeof amount === 'object' && amount !== null ? (amount as Json).mpt_issuance_id : undefined;
  return isMptIssuanceId(id) ? (id as string).toUpperCase() : undefined;
}

/**
 * The issuance of an MPT payment: `Amount` (or `DeliverMax`, which a later API version writes in its place) is an MPT, and
 * `SendMax`, `DeliveredAmount` and `delivered_amount` are the same MPT or say nothing. `undefined` otherwise, a mixed payment
 * among them: only MPTokensV2 can make one, and it is not enabled.
 */
export function mptPaymentIssuance(tx: Json, meta: Json): string | undefined {
  const id = mptAmountIssuance(tx.Amount ?? tx.DeliverMax);
  if (id === undefined) return undefined;
  for (const other of [tx.SendMax, meta.DeliveredAmount, meta.delivered_amount]) {
    if (other === undefined || other === null || other === 'unavailable') continue;
    if (mptAmountIssuance(other) !== id) return undefined;
  }
  return id;
}

function nodesOf(meta: Json): readonly Json[] {
  return Array.isArray(meta.AffectedNodes) ? meta.AffectedNodes : [];
}

/** The deleted `Escrow` node of a transaction when its `Amount` is an MPT. */
export function mptEscrowOf(meta: Json): MptEscrow | undefined {
  for (const entry of nodesOf(meta)) {
    const node: Json | undefined = entry?.DeletedNode;
    if (node?.LedgerEntryType !== 'Escrow') continue;
    const id = mptAmountIssuance(node.FinalFields?.Amount);
    if (id === undefined) continue;
    const { Account, Destination, Amount } = node.FinalFields as Json;
    return {
      account: typeof Account === 'string' ? Account : '',
      destination: typeof Destination === 'string' ? Destination : '',
      mpt_issuance_id: id,
      value: Amount.value,
    };
  }
  return undefined;
}

/**
 * Which holder of which issuance a successful transaction credited, and which one it put in escrow: the two cases in which a
 * field absent before can be added. Metadata alone cannot tell added from unchanged, since an added field is never in
 * `PreviousFields` (FINDINGS (1)), so the transaction says which.
 */
function addedFields(tx: Json, meta: Json): { credited?: HolderOf; escrowing?: HolderOf } {
  if (meta.TransactionResult !== 'tesSUCCESS') return {};
  switch (tx.TransactionType) {
    case 'Payment':
      return { credited: { holder: tx.Destination, id: mptAmountIssuance(tx.Amount ?? tx.DeliverMax) } };
    case 'EscrowCreate':
      return { escrowing: { holder: tx.Account, id: mptAmountIssuance(tx.Amount) } };
    case 'EscrowFinish': {
      const escrow = mptEscrowOf(meta);
      return { credited: { holder: escrow?.destination, id: escrow?.mpt_issuance_id } };
    }
    case 'EscrowCancel': {
      const escrow = mptEscrowOf(meta);
      return { credited: { holder: escrow?.account, id: escrow?.mpt_issuance_id } };
    }
    default:
      return {};
  }
}

interface HolderOf {
  holder: unknown;
  id: string | undefined;
}

const ACTIONS: ReadonlyArray<[string, MptNodeAction]> = [
  ['CreatedNode', 'created'],
  ['ModifiedNode', 'modified'],
  ['DeletedNode', 'deleted'],
];

/**
 * Every `MPToken` and `MPTokenIssuance` node a transaction created, modified or deleted, with its amounts before and after, in the
 * order of `meta.AffectedNodes`. Shared by `MptParser`, `PaymentParser` and `BalanceChangesParser`.
 *
 * A node modified without the key `PreviousFields` was only threaded and is left out. `PreviousFields: {}` is a change: a first
 * credit and an issuance's first escrow have it (FINDINGS (1)). After is the node's final fields (`NewFields` of a created one), a
 * field that fell to 0 having left them. Before, for a node that was not created, is:
 * - `MPTAmount`: the listed value, else 0 when the transaction is a success crediting this holder of this issuance (a Payment's
 *   destination, an EscrowFinish's destination, an EscrowCancel's owner), else the final value;
 * - `LockedAmount`, on token and issuance: the listed value, else 0 on a successful EscrowCreate of this issuance (on a token, by this
 *   holder), else the final value;
 * - `OutstandingAmount`: the listed value, else the final value (a first mint lists it, FINDINGS (1)).
 *
 * The conservation of `mpt-deltas.spec.ts` is the arbiter of these rules. Per transaction and issuance, the holders' changes of
 * `MPTAmount` and `LockedAmount` sum to the change of `OutstandingAmount`, and to 0 when the issuance's node is not in the metadata.
 *
 * Never throws, since a throw halts the live runner: an amount that is not a `UInt64` reads 0, flags that are not a `UInt32`
 * read 0, and a node whose ID cannot be made is skipped, each counted in `anomalies`. Pure: nothing in `tx` or `meta` is modified.
 */
export function mptDeltas(tx: Json, meta: Json): MptDeltas {
  const deltas: MptDeltas = { holders: [], issuances: [], anomalies: 0 };
  const { credited, escrowing } = addedFields(tx, meta);

  const units = (value: unknown): bigint => {
    if (value === undefined) return 0n;
    const read = mptUnits(value);
    if (read === undefined) deltas.anomalies += 1;
    return read ?? 0n;
  };

  nodesOf(meta).forEach((entry, node_index) => {
    const found = ACTIONS.find(([key]) => entry?.[key] !== undefined);
    if (found === undefined) return;
    const [key, action] = found;
    const node: Json = entry[key];
    if (node.LedgerEntryType !== 'MPToken' && node.LedgerEntryType !== 'MPTokenIssuance') return;
    if (action === 'modified' && node.PreviousFields === undefined) return;

    const fields: Json = (action === 'created' ? node.NewFields : node.FinalFields) ?? {};
    const previous: Json = node.PreviousFields ?? {};
    // Before a created node there is nothing; an added field was 0; anything else not listed did not change.
    const before = (field: string, after: bigint, added: boolean): bigint => {
      if (action === 'created') return 0n;
      if (previous[field] !== undefined) return units(previous[field]);
      return added ? 0n : after;
    };

    if (node.LedgerEntryType === 'MPToken') {
      const holder: unknown = fields.Account;
      const id: unknown = fields.MPTokenIssuanceID;
      if (typeof holder !== 'string' || holder === '' || !isMptIssuanceId(id as string)) {
        deltas.anomalies += 1;
        return;
      }
      const mpt_issuance_id = (id as string).toUpperCase();
      const amount_after = units(fields.MPTAmount);
      const escrowed_after = units(fields.LockedAmount);
      const flags = mptUInt(fields.Flags ?? 0);
      if (flags === undefined) deltas.anomalies += 1;
      deltas.holders.push({
        holder,
        mpt_issuance_id,
        node_index,
        action,
        amount_before: before(
          'MPTAmount',
          amount_after,
          credited?.holder === holder && credited.id === mpt_issuance_id,
        ),
        amount_after,
        escrowed_before: before(
          'LockedAmount',
          escrowed_after,
          escrowing?.holder === holder && escrowing.id === mpt_issuance_id,
        ),
        escrowed_after,
        flags: flags ?? 0,
      });
      return;
    }

    const issuer: unknown = fields.Issuer;
    const sequence: unknown = fields.Sequence;
    let mpt_issuance_id: string;
    try {
      mpt_issuance_id = mptIssuanceId(sequence as number, issuer as string);
    } catch {
      deltas.anomalies += 1;
      return;
    }
    const outstanding_after = units(fields.OutstandingAmount);
    const escrowed_after = units(fields.LockedAmount);
    deltas.issuances.push({
      mpt_issuance_id,
      issuer: issuer as string,
      sequence: sequence as number,
      node_index,
      action,
      outstanding_before: before('OutstandingAmount', outstanding_after, false),
      outstanding_after,
      escrowed_before: before('LockedAmount', escrowed_after, escrowing?.id === mpt_issuance_id),
      escrowed_after,
      fields,
    });
  });
  return deltas;
}

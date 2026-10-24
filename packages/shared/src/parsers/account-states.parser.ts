import { dropsToNative } from '../util/amount';
import { ParseContext, ParserTx } from './parser.interface';

/** The state of an account root after a transaction changed it. */
export interface ParsedAccountState {
  account: string;
  /** The node's position in `meta.AffectedNodes`. */
  node_index: number;
  /** The native balance in whole units, exact. */
  balance: string;
  flags: number;
  sequence: number;
  owner_count: number;
  /** Every field of the node as it was after the transaction (the created node's `NewFields`, else `FinalFields`). */
  fields: Readonly<Record<string, unknown>>;
  /** The node was deleted (AccountDelete): the account did not exist after the transaction. */
  deleted: boolean;
}

type Json = Readonly<Record<string, any>>;

const OPS = ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const;

function uint(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export class AccountStatesParser {
  /**
   * The state of every account root the transaction changed, in the order of `meta.AffectedNodes`: each created,
   * modified or deleted `AccountRoot` node, with its final fields. The result of the transaction does not matter: a
   * failed transaction still takes its fee and its sequence, and its metadata says so.
   *
   * A modified node without `PreviousFields` was only threaded (its `PreviousTxnID` moved) and changed nothing of the
   * account, so it has no state row. A created node lists only the fields that are not at their default, so an absent
   * `Flags`, `Sequence` or `OwnerCount` is 0 and an absent `Balance` is 0.
   *
   * Native amounts are drops on every network, so `ctx` only keeps the signature the same as the other parsers.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedAccountState[] {
    const states: ParsedAccountState[] = [];
    const nodes: readonly Json[] = t.meta.AffectedNodes ?? [];
    nodes.forEach((entry, index) => {
      const op = OPS.find((o) => entry?.[o]);
      if (!op) return;
      const node: Json = entry[op];
      if (node.LedgerEntryType !== 'AccountRoot') return;
      if (op === 'ModifiedNode' && !node.PreviousFields) return;
      const fields: Json | undefined = op === 'CreatedNode' ? node.NewFields : node.FinalFields;
      if (!fields || typeof fields.Account !== 'string') return;
      states.push({
        account: fields.Account,
        node_index: index,
        balance: dropsToNative(typeof fields.Balance === 'string' ? fields.Balance : '0'),
        flags: uint(fields.Flags),
        sequence: uint(fields.Sequence),
        owner_count: uint(fields.OwnerCount),
        fields: structuredClone(fields),
        deleted: op === 'DeletedNode',
      });
    });
    return states;
  }
}

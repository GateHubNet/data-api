import BigNumber from 'bignumber.js';
import { ParseContext, ParserTx } from './parser.interface';

/** The state of a trust line after a transaction changed it, from one of its two accounts. */
export interface ParsedTrustLineState {
  account: string;
  counterparty: string;
  currency: string;
  /** The node's position in `meta.AffectedNodes`. */
  node_index: number;
  /** The account's balance, exact: positive when the counterparty owes it. */
  balance: string;
  /** The account's own limit, exact. */
  limit: string;
  /** The counterparty's limit, exact. */
  limit_peer: string;
  no_ripple: boolean;
  no_ripple_peer: boolean;
  authorized: boolean;
  peer_authorized: boolean;
  freeze: boolean;
  peer_freeze: boolean;
  /** 0 when the account's side has none. */
  quality_in: number;
  quality_out: number;
  /** The RippleState `Flags` as stored, both sides. */
  flags: number;
  /** The node was deleted: the line did not exist after the transaction. */
  deleted: boolean;
}

type Json = Readonly<Record<string, any>>;

const OPS = ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const;

/** The RippleState flags of each side (`LEDGER_ENTRY_FLAGS.RippleState`; the same bits on Xahau). */
const LOW = { noRipple: 0x00100000, auth: 0x00040000, freeze: 0x00400000 } as const;
const HIGH = { noRipple: 0x00200000, auth: 0x00080000, freeze: 0x00800000 } as const;

function uint(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** An amount's value as plain decimal text: the ledger may write a limit as `1000000000000000e15`. */
function decimal(value: unknown): string {
  const n = new BigNumber(typeof value === 'string' ? value : '0');
  return n.isZero() ? '0' : n.toFixed();
}

function negated(value: string): string {
  return value === '0' ? '0' : new BigNumber(value).negated().toFixed();
}

export class TrustLineStatesParser {
  /**
   * The state of every trust line the transaction changed, in the order of `meta.AffectedNodes`, two per line: the low
   * account's side first, then the high account's. Each created, modified or deleted `RippleState` node counts, with its
   * final fields; the result of the transaction does not matter (its metadata says what it changed).
   *
   * The node's `Balance` is the low account's (positive: the high account owes it), so the high side has it negated.
   * `LowLimit`, `LowQualityIn`/`Out` and the `Low*` flags are the low account's settings, the `High*` ones the high
   * account's; each side has its own as `limit`, `no_ripple`, ... and the other's as `limit_peer`, `no_ripple_peer`, ...
   *
   * A modified node without `PreviousFields` changed nothing, so it has no rows. A created node lists only the fields
   * that are not at their default, so an absent `Flags` or quality is 0.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedTrustLineState[] {
    const states: ParsedTrustLineState[] = [];
    const nodes: readonly Json[] = t.meta.AffectedNodes ?? [];
    nodes.forEach((entry, index) => {
      const op = OPS.find((o) => entry?.[o]);
      if (!op) return;
      const node: Json = entry[op];
      if (node.LedgerEntryType !== 'RippleState') return;
      if (op === 'ModifiedNode' && !node.PreviousFields) return;
      const fields: Json | undefined = op === 'CreatedNode' ? node.NewFields : node.FinalFields;
      const low = fields?.LowLimit?.issuer;
      const high = fields?.HighLimit?.issuer;
      const currency = fields?.Balance?.currency;
      if (typeof low !== 'string' || typeof high !== 'string' || typeof currency !== 'string') return;

      const flags = uint(fields!.Flags);
      const balance = decimal(fields!.Balance.value);
      const lowLimit = decimal(fields!.LowLimit.value);
      const highLimit = decimal(fields!.HighLimit.value);
      const deleted = op === 'DeletedNode';
      states.push({
        account: low,
        counterparty: high,
        currency,
        node_index: index,
        balance,
        limit: lowLimit,
        limit_peer: highLimit,
        no_ripple: (flags & LOW.noRipple) !== 0,
        no_ripple_peer: (flags & HIGH.noRipple) !== 0,
        authorized: (flags & LOW.auth) !== 0,
        peer_authorized: (flags & HIGH.auth) !== 0,
        freeze: (flags & LOW.freeze) !== 0,
        peer_freeze: (flags & HIGH.freeze) !== 0,
        quality_in: uint(fields!.LowQualityIn),
        quality_out: uint(fields!.LowQualityOut),
        flags,
        deleted,
      });
      states.push({
        account: high,
        counterparty: low,
        currency,
        node_index: index,
        balance: negated(balance),
        limit: highLimit,
        limit_peer: lowLimit,
        no_ripple: (flags & HIGH.noRipple) !== 0,
        no_ripple_peer: (flags & LOW.noRipple) !== 0,
        authorized: (flags & HIGH.auth) !== 0,
        peer_authorized: (flags & LOW.auth) !== 0,
        freeze: (flags & HIGH.freeze) !== 0,
        peer_freeze: (flags & LOW.freeze) !== 0,
        quality_in: uint(fields!.HighQualityIn),
        quality_out: uint(fields!.HighQualityOut),
        flags,
        deleted,
      });
    });
    return states;
  }
}

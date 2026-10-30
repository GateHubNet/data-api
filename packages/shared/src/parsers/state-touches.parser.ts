import { changedAccountRoots } from './account-states.parser';
import { ParseContext, ParserTx, senderAccount } from './parser.interface';

/**
 * A trust line or an account whose token state a transaction may have changed (`state_touches`, spec 2.1). A `line` is a trust
 * line: `account` its low account, `counterparty` its high one, `currency` as the ledger writes it. An `account` is an account
 * root whose token settings may have changed: `counterparty` and `currency` are `''`.
 */
export interface ParsedStateTouch {
  kind: 'line' | 'account';
  account: string;
  counterparty: string;
  currency: string;
}

type Json = Readonly<Record<string, any>>;

const OPS = ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const;

/** The fields of an account root that a token's settings are read from: its flags, its transfer rate and its domain. */
const ACCOUNT_SETTINGS = ['Flags', 'TransferRate', 'Domain'] as const;

const hasKey = (fields: unknown, key: string): boolean =>
  typeof fields === 'object' && fields !== null && Object.prototype.hasOwnProperty.call(fields, key);

export class StateTouchesParser {
  /**
   * The trust lines and account roots a transaction changed that the token aggregate depends on, in the order of
   * `meta.AffectedNodes`, whatever the result of the transaction (spec 4): a failed transaction still takes its fee and
   * its sequence, and its metadata says what it changed.
   *
   * - `line`: a `RippleState` node that is created, deleted, or modified with `PreviousFields` (a node that was only
   *   threaded changed nothing: the rule of `trust_line_states`). `account` is `LowLimit.issuer`, `counterparty`
   *   `HighLimit.issuer` and `currency` `Balance.currency`, all of the node's final fields (`NewFields` of a created node,
   *   else `FinalFields`). LP currencies are written too: the job drops them.
   * - `account`: an `AccountRoot` that is created, deleted, or modified with `Flags`, `TransferRate` or `Domain` among its
   *   `PreviousFields`; and the root of the sender of an `AccountSet` that is modified with `PreviousFields` at all. A field
   *   that an account sets for the first time is not in `PreviousFields` (it is in `FinalFields` alone, as D4's
   *   `AccountDomainsParser` documents), so a first `Domain` or `TransferRate` shows only as the fee and the sequence
   *   that every transaction changes: the sender of an `AccountSet` is touched whatever else changed. A balance or sequence
   *   change of any other transaction makes no row.
   *
   * The sender is `senderAccount(t.tx)`, never the account that pays the fee: a delegated `AccountSet` changes the root of
   * its `Account`, and the delegate's root only loses the fee.
   *
   * A node without the fields it needs is skipped, never thrown (a ledger the parsers cannot read halts the ingest). Each
   * `(kind, account, counterparty, currency)` is written once per transaction.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedStateTouch[] {
    const touches: Array<{ node_index: number; touch: ParsedStateTouch }> = [];

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
      touches.push({ node_index: index, touch: { kind: 'line', account: low, counterparty: high, currency } });
    });

    const sender = t.tx.TransactionType === 'AccountSet' ? senderAccount(t.tx) : undefined;
    for (const { op, node_index, node } of changedAccountRoots(t)) {
      const fields: Json | undefined = op === 'CreatedNode' ? node.NewFields : node.FinalFields;
      const account = fields?.Account;
      if (typeof account !== 'string') continue;
      const settingsChanged = ACCOUNT_SETTINGS.some((key) => hasKey(node.PreviousFields, key));
      const sendsAccountSet = op === 'ModifiedNode' && account === sender;
      if (op === 'ModifiedNode' && !settingsChanged && !sendsAccountSet) continue;
      touches.push({ node_index, touch: { kind: 'account', account, counterparty: '', currency: '' } });
    }

    // The nodes of the two walks interleave as the metadata lists them.
    touches.sort((a, b) => a.node_index - b.node_index);
    const seen = new Set<string>();
    const result: ParsedStateTouch[] = [];
    for (const { touch } of touches) {
      const key = JSON.stringify([touch.kind, touch.account, touch.counterparty, touch.currency]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(touch);
    }
    return result;
  }
}

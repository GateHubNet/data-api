import { changedAccountRoots } from './account-states.parser';
import { ParseContext, ParserTx } from './parser.interface';

/** The Domain of an account root after a transaction changed it. */
export interface ParsedAccountDomain {
  account: string;
  /** The node's position in `meta.AffectedNodes`, as in `ParsedAccountState`. */
  node_index: number;
  /** The Domain after the transaction, as the ledger holds it (hex), `''` when the account has none. */
  domain_hex: string;
  /** The node was deleted (AccountDelete): the account did not exist after the transaction. */
  deleted: boolean;
  /** The Domain that the node ends with is not a hex string: `domain_hex` is `''` for it, and the build counts it. */
  invalid: boolean;
}

type Json = Readonly<Record<string, any>>;

/** An even number of hex digits, none at all included. */
const HEX = /^(?:[0-9A-Fa-f]{2})*$/;

/** Whether the fields have a `Domain` key: one that is `''` or `null` is still set. */
function hasDomain(fields: unknown): boolean {
  return typeof fields === 'object' && fields !== null && 'Domain' in fields;
}

export class AccountDomainsParser {
  /**
   * The Domain of every account root the transaction changed, after the transaction, in the order of
   * `meta.AffectedNodes` (spec 3.1). A row is written for each node of an account that has or had a Domain, whatever the
   * change was: an account whose Domain was set long ago is learnt at its next change.
   *
   * rippled lists a changed field's old value in `PreviousFields`, but a field that was added is not there and a removed
   * one is only there. So a Domain set for the first time is in `FinalFields` alone, a cleared one in `PreviousFields`
   * alone, a changed one in both, and any other change of an account with a Domain in `FinalFields` alone. "Set" is the
   * key being present, on either side.
   *
   * - a created node with `NewFields.Domain` gives that Domain;
   * - a modified node (`changedAccountRoots` leaves out one that was only threaded) gives `FinalFields.Domain`, else `''`;
   * - a deleted node gives `''` and `deleted`.
   *
   * The result of the transaction does not matter, and no transaction type is special (Xahau's `Import`, `SetHook` and
   * `GenesisMint` are read like any other): a failed transaction still takes its fee from the sender's root.
   *
   * A Domain that the node ends with (`NewFields` or `FinalFields`) and that is not a string of hex digits is written as
   * `''` with `invalid`, never thrown (a ledger the parsers cannot read halts the ingest). `PreviousFields.Domain` is not
   * read for its value: the old Domain is not written.
   *
   * Pure: nothing in `t` is modified, and the result shares no objects with it.
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedAccountDomain[] {
    const domains: ParsedAccountDomain[] = [];
    for (const { op, node_index, node } of changedAccountRoots(t)) {
      const fields: Json | undefined = op === 'CreatedNode' ? node.NewFields : node.FinalFields;
      if (!fields || typeof fields.Account !== 'string') continue;
      const finalSet = hasDomain(fields);
      if (!finalSet && (op === 'CreatedNode' || !hasDomain(node.PreviousFields))) continue;

      const valid = finalSet && typeof fields.Domain === 'string' && HEX.test(fields.Domain);
      domains.push({
        account: fields.Account,
        node_index,
        domain_hex: op !== 'DeletedNode' && valid ? fields.Domain : '',
        deleted: op === 'DeletedNode',
        invalid: finalSet && !valid,
      });
    }
    return domains;
  }
}

/**
 * The `version` of an `account_domains` row: `ledger_index * 2^32 + tx_index * 2^16 + node_index`, as decimal text (it passes
 * 2^53, so a `number` cannot hold it). It orders the changes of an account in the ledger's own order, and the newest row of
 * an account is its current Domain. A ledger has fewer than 65,536 transactions and a transaction fewer than 65,536 nodes
 * (`tx_index` and `node_index` are 16 bits in the table and in this sum).
 */
export function accountDomainVersion(ledgerIndex: number, txIndex: number, nodeIndex: number): string {
  return ((BigInt(ledgerIndex) << 32n) + (BigInt(txIndex) << 16n) + BigInt(nodeIndex)).toString();
}

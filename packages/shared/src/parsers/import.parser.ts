import { changedAccountRoots } from './account-states.parser';
import { ParseContext, ParserTx } from './parser.interface';

/** What an `Import` minted: the drops it added to the ledger's `total_coins` (plus the fee it burned, F5). */
export interface ParsedImport {
  /** The importing account (`Account`). */
  account: string;
  /** Drops, as a decimal string (plain digits), 0 or more. */
  minted: string;
  /** The `Import` created the `AccountRoot` (its first `Import`, which pays no fee). */
  account_created: boolean;
  /** The sum was below 0 (cannot happen by F5): `minted` is `'0'`, and the build counts it as an anomaly. */
  negative: boolean;
}

/** A native amount: drops, as a string of digits. */
const DIGITS = /^\d+$/;

/** The drops of a native amount, `undefined` for anything that is not a string of digits. */
const drops = (value: unknown): bigint | undefined =>
  typeof value === 'string' && DIGITS.test(value) ? BigInt(value) : undefined;

export class ImportParser {
  /**
   * The drops a successful Xahau `Import` minted (spec 2, F5 and FINDINGS fact 3 of `test/fixtures/xahau/mint`).
   *
   * xahaud adds to the header what it put into the account (`Import.cpp:1419-1420`): the whole new balance of an account the
   * `Import` creates, the rise of the balance of one that exists. The account paid the `Import`'s own `Fee` first (0 for a
   * creation, which xahaud requires), so the fee is added back to the rise and `total_coins` ends up changed by exactly the
   * mint less the burned fee, as for any fee:
   *
   * - the `AccountRoot` of `Account` as a `CreatedNode`: `NewFields.Balance` (counted from 0), `account_created`;
   * - as a `ModifiedNode`: `FinalFields.Balance - PreviousFields.Balance`, 0 when `PreviousFields` has no `Balance`;
   * - no such node: 0 (impossible; the result is the fee alone);
   * - then `+ Fee`. A negative total (impossible too) is `minted: '0'` with `negative: true`.
   *
   * Any other result, any other type and so every XRPL ledger gives `undefined`. The inner XRPL transaction's result does not
   * matter: an `Import` with a `tec` one still credits and has `tesSUCCESS` itself (F5).
   *
   * Drops are `bigint` while handled and plain digits in the result. Pure: nothing in `t` is modified, and a field that is
   * not what the ledger always has is read as 0, never thrown on (a ledger the parsers cannot read halts the ingest).
   */
  parse(t: ParserTx, _ctx: ParseContext): ParsedImport | undefined {
    if (t.tx.TransactionType !== 'Import' || t.meta.TransactionResult !== 'tesSUCCESS') return undefined;

    const account = typeof t.tx.Account === 'string' ? t.tx.Account : '';
    // (`changedAccountRoots` leaves out a node that was only threaded, which has no Balance change either.)
    const root = changedAccountRoots(t).find(({ op, node }) => {
      const fields = op === 'CreatedNode' ? node.NewFields : node.FinalFields;
      return op !== 'DeletedNode' && account !== '' && fields?.Account === account;
    });

    let change = 0n;
    if (root?.op === 'CreatedNode') {
      change = drops(root.node.NewFields.Balance) ?? 0n;
    } else if (root) {
      const final = drops(root.node.FinalFields.Balance);
      const previous = drops(root.node.PreviousFields?.Balance);
      if (final !== undefined && previous !== undefined) change = final - previous;
    }

    const total = change + (drops(t.tx.Fee) ?? 0n);
    return {
      account,
      minted: String(total < 0n ? 0n : total),
      account_created: root?.op === 'CreatedNode',
      negative: total < 0n,
    };
  }
}

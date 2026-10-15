import { BigNumber } from 'bignumber.js';
import { IParser, XrplTx } from './parser.interface';

export interface ParsedIssuerTrustline {
  currency: string;
  issuer: string;
  counterparty: string;
  balance: string;
  /** unix-seconds date of the ledger this snapshot reflects. */
  date: number;
  ledger_index: number;
}

/**
 * Derives issuer trustline snapshots straight from the transaction metadata's
 * RippleState nodes.
 *
 * This replaces the old per-transaction `account_lines` RPC (review finding H6),
 * which was both a throughput bottleneck (one network round-trip per tx) and
 * historically wrong (it always queried `ledger_index: 'validated'`, i.e. "now").
 * Reading the affected RippleState nodes gives the balance *as of this ledger* and
 * needs no network call. Rows are de-duplicated downstream by a ReplacingMergeTree
 * keyed on (issuer, currency, counterparty) with `ledger_index` as the version,
 * so the latest snapshot always wins.
 */
export class IssuersParser implements IParser<ParsedIssuerTrustline[]> {
  public parse(transaction: XrplTx): ParsedIssuerTrustline[] {
    const metadata = transaction.meta;
    if (!metadata) return [];

    const out: ParsedIssuerTrustline[] = [];
    for (const affNode of metadata.AffectedNodes as any[]) {
      const node = affNode.ModifiedNode || affNode.CreatedNode || affNode.DeletedNode;
      if (!node || node.LedgerEntryType !== 'RippleState') continue;

      const fields = node.FinalFields || node.NewFields;
      if (!fields?.Balance) continue;

      const balance = new BigNumber(fields.Balance.value);

      const currency: string = fields.Balance.currency;
      const high: string = fields.HighLimit.issuer;
      const low: string = fields.LowLimit.issuer;

      // RippleState balance is signed from the low account's perspective.
      // A positive balance => low holds currency issued by high; negative => the reverse.
      // A zero balance still gets a row (e.g. a trust line emptied/closed) so the
      // ReplacingMergeTree snapshot updates to 0 instead of keeping a stale non-zero
      // balance; the API filters out `latest_balance <= 0` at read time.
      const issuer = balance.isNegative() ? low : high;
      const counterparty = balance.isNegative() ? high : low;

      out.push({
        currency,
        issuer,
        counterparty,
        balance: balance.abs().toString(),
        date: transaction.date,
        ledger_index: transaction.ledger_index,
      });
    }

    return out;
  }
}

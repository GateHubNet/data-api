import { getAffectedAccounts } from 'ripple-lib-transactionparser';
import { ParserTx } from './parser.interface';

/** A classic address, as the index stores it: the values that start with `r`. */
function isAddress(value: unknown): value is string {
  return typeof value === 'string' && value[0] === 'r';
}

export class AffectedAccountsParser {
  /**
   * The accounts a transaction touched, each once, in the order they first appear in the metadata. Matches
   * `ledgerParser/affectedAccounts.js` of the Ripple Data API: `ripple-lib-transactionparser`'s
   * `getAffectedAccounts` (the `Account`, `Owner`, `Destination`, `Issuer` and `Target` fields, and the issuers of
   * `LowLimit`, `HighLimit`, `TakerPays` and `TakerGets`, read from `NewFields` of a created node and from
   * `FinalFields` of the others), keeping the values that start with `r`.
   *
   * The result of the transaction does not matter: a `tec` transaction still burned its fee and used a sequence number,
   * so it is listed under its sender and under every other account its metadata names. Not even a failure before the
   * ledger (`tef`, `ter`) changes that, the metadata is all this reads.
   *
   * One difference from the reference, which predates delegation: the transaction's `Delegate` is appended when the
   * metadata does not name it, so the delegate that signed a transaction for another account is always listed with it.
   * The metadata names the delegate when it paid a fee (its `AccountRoot` changed), and does not for a Batch inner
   * transaction, which pays none.
   *
   * Pure: the library builds new objects and nothing in `t` is modified.
   */
  parse(t: ParserTx): string[] {
    const accounts = getAffectedAccounts(t.meta).filter(isAddress);
    const delegate: unknown = t.tx.Delegate;
    if (isAddress(delegate) && !accounts.includes(delegate)) accounts.push(delegate);
    return accounts;
  }
}

import { getAffectedAccounts } from 'ripple-lib-transactionparser';
import { ParserTx } from './parser.interface';

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
   * Pure: the library builds new objects and nothing in `t` is modified.
   */
  parse(t: ParserTx): string[] {
    return getAffectedAccounts(t.meta).filter((account) => typeof account === 'string' && account[0] === 'r');
  }
}

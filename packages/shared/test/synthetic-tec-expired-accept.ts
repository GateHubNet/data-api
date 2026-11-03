import type { RawLedger } from '../src/ingest/raw-ledger';
import { syntheticHash } from './synthetic-hash';

type Json = Record<string, any>;

/** The recorded case it is made from: `sale_by_sell_offer`, the transaction of ledger 107874617 (see the manifest). */
export const EXPIRED_ACCEPT_BASE = 'sale_by_sell_offer';

/** The `Expiration` the synthetic offer has (Ripple seconds): 2026-10-24T16:03:20Z, before ledger 107874617 closed (16:08:12). */
export const EXPIRED_AT = 846173000;

/**
 * `synthetic-tec-expired-accept`: the metadata of the recorded `sale_by_sell_offer` (an `NFTokenAcceptOffer` of one sell offer,
 * ledger 107874617) made into the metadata rippled writes when that offer had expired (amendment
 * `fixExpiredNFTokenOfferRemoval`): the result is `tecEXPIRED`, the offer's `Expiration` is before the ledger, and the nodes are
 * what such a failure changes: the sender's fee and sequence, and the expired offer deleted, with its NFT's emptied sell
 * directory, its owner's directory and its owner's reserve (`OwnerCount` 3 to 2, no payment). No NFT moves: the pages and the
 * issuer's royalty are gone. Hand-made, never recorded (none was found in the recorded ledgers). `meta` is changed in place.
 */
export function expireAcceptedOffer(meta: Json): void {
  const kept: Json[] = [];
  for (const wrapper of meta.AffectedNodes as Json[]) {
    const op = Object.keys(wrapper)[0];
    const body = wrapper[op];
    if (body.LedgerEntryType === 'NFTokenPage') continue;
    if (body.LedgerEntryType === 'AccountRoot') {
      const account = body.FinalFields.Account;
      // the seller (the offer's owner): its reserve only, no payment; the buyer (the sender): the fee only
      if (account === 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz') {
        body.FinalFields.Balance = body.PreviousFields.Balance;
        body.PreviousFields = { OwnerCount: body.PreviousFields.OwnerCount };
      } else if (account === 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx') {
        body.FinalFields.Balance = String(BigInt(body.PreviousFields.Balance) - 12n);
      } else {
        continue; // the issuer: no royalty is paid
      }
    }
    if (body.LedgerEntryType === 'NFTokenOffer') body.FinalFields.Expiration = EXPIRED_AT;
    kept.push(wrapper);
  }
  meta.AffectedNodes = kept;
  meta.TransactionResult = 'tecEXPIRED';
}

/**
 * A copy of `raw` in which the transaction `hash` (the recorded `sale_by_sell_offer`) is `synthetic-tec-expired-accept`
 * (`expireAcceptedOffer`), under the hash `syntheticHash('synthetic-tec-expired-accept', hash)`. `raw` itself is not changed.
 */
export function withTecExpiredAccept(raw: RawLedger, hash: string): RawLedger {
  const copy = structuredClone(raw) as RawLedger;
  const t = copy.transactions.find((r) => r.hash === hash);
  if (!t) throw new Error(`${hash} is not in ledger ${raw.header.ledger_index}`);
  expireAcceptedOffer(t.meta as Json);
  t.hash = syntheticHash('synthetic-tec-expired-accept', hash);
  return copy;
}

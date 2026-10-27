import type { RawLedger } from '../src/ingest/raw-ledger';
import { syntheticHash } from './synthetic-hash';

type Json = Record<string, any>;

/** An MPT amount, which no NFT offer on mainnet is priced with. */
const MPT_AMOUNT = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '100' };

/** The hash a transaction of `withMptOffers` is given in place of its recorded `hash`. */
export const mptOfferHash = (hash: string): string => syntheticHash('synthetic-mpt-offer', hash);

/**
 * `synthetic-mpt-offer`: a copy of `raw` in which the offers of the transactions `hashes` (the transaction's `Amount` and
 * the created `NFTokenOffer`'s) are priced with an MPT amount. Hand-made, never recorded: the NFT parser drops the event
 * and counts it (`ParsedNft.skipped`), so that a ledger made with it has `diagnostics.nftSkipped` events to report. Each
 * altered transaction is given the hash `mptOfferHash(hash)`, so that none passes for the recorded one. `raw` itself is
 * not changed.
 */
export function withMptOffers(raw: RawLedger, hashes: readonly string[]): RawLedger {
  const copy = structuredClone(raw) as RawLedger;
  for (const t of copy.transactions.filter((r) => hashes.includes(r.hash))) {
    t.tx.Amount = MPT_AMOUNT;
    for (const wrapper of t.meta.AffectedNodes as Json[]) {
      if (wrapper.CreatedNode?.LedgerEntryType === 'NFTokenOffer') wrapper.CreatedNode.NewFields.Amount = MPT_AMOUNT;
    }
    t.hash = mptOfferHash(t.hash);
  }
  return copy;
}

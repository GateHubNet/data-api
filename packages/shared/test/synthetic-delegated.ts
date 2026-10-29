import type { RawTransaction } from '../src/ingest/raw-ledger';
import { syntheticHash } from './synthetic-hash';

type Json = Record<string, any>;

/**
 * The delegate of the synthetic delegated transactions: the genesis account of the XRP Ledger, which none of the recorded
 * transactions they are made from names. (The one delegation seen on the network, `rnt8Pb…` to `rw2X2G…`, only ever signed
 * OfferCreate and OfferCancel; see `xrpl/objects/FINDINGS.md` finding 8.)
 */
export const SYNTHETIC_DELEGATE = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

/** What the synthetic delegate holds after paying the fee, in drops. */
const DELEGATE_BALANCE = 100_000_000n;

/**
 * The recorded transaction `raw` as if its `Account` had delegated it: the same transaction with a `Delegate`, whose fee
 * the delegate paid instead of the sender (`synthetic-delegated-payment` and `synthetic-delegated-tec`: the name says
 * which recorded transaction it is made from and that it is no recording). The sender's `AccountRoot` keeps the fee it
 * paid in the recorded transaction (and keeps whatever else the transaction did to it, its `Sequence` included); the
 * delegate's loses it, in a `ModifiedNode` appended to the metadata. The hash is `syntheticHash(name, raw.hash)`, so none
 * passes for a recorded one. `raw` is not changed.
 *
 * Hand-made, never recorded: no Payment, and no transaction with a tec result, of a delegate was found on the network.
 */
export function delegatedFrom(
  raw: RawTransaction,
  name: string,
  delegate: string = SYNTHETIC_DELEGATE,
): RawTransaction {
  const copy = structuredClone(raw) as RawTransaction;
  const tx = copy.tx as Json;
  const meta = copy.meta as Json;
  const fee = BigInt(tx.Fee as string);
  if (fee === 0n) throw new Error(`${raw.hash} pays no fee: it has none for a delegate to take`);

  const sender = (meta.AffectedNodes as Json[])
    .map((wrapper) => Object.values(wrapper)[0] as Json)
    .find((node) => node.LedgerEntryType === 'AccountRoot' && node.FinalFields?.Account === tx.Account);
  if (!sender) throw new Error(`${raw.hash}: the metadata has no AccountRoot of its sender ${String(tx.Account)}`);

  // The sender still has what it paid as the fee; when nothing else moved its balance it did not change at all.
  const final = BigInt(sender.FinalFields.Balance as string) + fee;
  sender.FinalFields.Balance = String(final);
  if (String(final) === sender.PreviousFields?.Balance) delete sender.PreviousFields.Balance;

  tx.Delegate = delegate;
  (meta.AffectedNodes as Json[]).push({
    ModifiedNode: {
      FinalFields: { Account: delegate, Balance: String(DELEGATE_BALANCE), Flags: 0, OwnerCount: 0, Sequence: 1 },
      LedgerEntryType: 'AccountRoot',
      PreviousFields: { Balance: String(DELEGATE_BALANCE + fee) },
    },
  });

  copy.hash = syntheticHash(name, raw.hash);
  return copy;
}

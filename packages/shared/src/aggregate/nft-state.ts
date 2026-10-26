import type { NftEventName, NftKind } from '../parsers/nft.parser';

/**
 * The state of an NFT, folded from its events (spec section 3.1): the one pure function the `nft_state` job writes its
 * `nfts` and `account_nfts` rows from and the API's detail route renders an NFT with.
 *
 *  - **Owner.** The owner is the `to_account` of the newest `mint`, `sale` or `transfer`; a `burn` clears it, and a later
 *    `mint` sets it again (decision 19). An NFT that no indexed event names an owner of has none (`''`).
 *  - **Burned.** `burned` and `burned_at` hold only while the newest of those events (and of the burns) is a `burn`.
 *  - **URI.** `uri` is the one of the newest `mint` or `modify`; `digest` (URITokens) is the newest one an event names.
 *  - **Sales.** `sale_count` counts every sale, `last_sale` is the newest one.
 *  - **Offers** (`offer_create`, `offer_cancel`, `offer_removed`) count only for `first_ledger` and `last_ledger`.
 *  - **Owners.** Every account the NFT ever had as owner in the index: the `from_account` of a sale, a transfer or a burn,
 *    and the `to_account` of a mint, a sale or a transfer, first seen first (the seller of a sale before its buyer).
 */

/** The place of a fact in the ledger history: the transaction's ledger, hash and close time (unix seconds). */
export interface NftPoint {
  ledger_index: number;
  tx_hash: string;
  close_time: number;
}

/** One row of `nft_events`, the columns the fold reads. `close_time` is unix seconds. */
export interface NftEventRead {
  nft_id: string;
  ledger_index: number;
  tx_index: number;
  event_index: number;
  tx_hash: string;
  close_time: number;
  kind: NftKind;
  event: NftEventName;
  issuer: string;
  taxon: number | null;
  taxon_key: number;
  serial: number;
  nft_flags: number;
  transfer_fee: number;
  uri: string;
  digest: string;
  account: string;
  from_account: string;
  to_account: string;
  amount: string;
  currency: string;
  amount_issuer: string;
}

/** The state of an NFT after its events. */
export interface NftFold {
  nft_id: string;
  kind: NftKind;
  issuer: string;
  taxon: number | null;
  taxon_key: number;
  serial: number;
  nft_flags: number;
  transfer_fee: number;
  /** `''` when burned or when no indexed event names one. */
  owner: string;
  owner_since?: NftPoint;
  uri: string;
  digest: string;
  minted?: NftPoint & { by: string; to: string };
  burned: boolean;
  burned_at?: NftPoint & { by: string };
  sale_count: number;
  /**
   * The newest sale. `tx_index` and `event_index` are not columns of `nfts`: they are here, in memory only, so that the
   * converted price of the sale can be joined on `ledger_index:tx_index:event_index`.
   */
  last_sale?: NftPoint & {
    tx_index: number;
    event_index: number;
    amount: string;
    currency: string;
    amount_issuer: string;
  };
  first_ledger: number;
  last_ledger: number;
  /** The ledger of the first indexed event, when that event is a mint: what `itemCoverage` takes (Ruling 5). */
  created_ledger?: number;
  /** Every account it ever had as owner in the index, first seen first. */
  owners: string[];
}

const pointOf = (e: NftEventRead): NftPoint => ({
  ledger_index: e.ledger_index,
  tx_hash: e.tx_hash,
  close_time: e.close_time,
});

/**
 * The state of an NFT from its events, oldest first (`ledger_index`, `tx_index`, `event_index`: the order the events are
 * read in, each once). The identity columns (`issuer`, `taxon`, flags, fee ...) are those of the id, the same in every event
 * of an NFT; the newest event's are taken. Throws a `RangeError` for no event: an NFT without events has no state (the job
 * removes it).
 */
export function foldNftEvents(events: readonly NftEventRead[]): NftFold {
  if (events.length === 0) throw new RangeError('An NFT with no events has no state to fold');

  const first = events[0];
  const newest = events[events.length - 1];
  const owners = new Set<string>();
  const own = (account: string): void => {
    if (account !== '') owners.add(account);
  };

  let owner = '';
  let owner_since: NftPoint | undefined;
  let uri = '';
  let digest = '';
  let minted: NftFold['minted'];
  let burned_at: NftFold['burned_at'];
  let sale_count = 0;
  let last_sale: NftFold['last_sale'];

  for (const e of events) {
    if (e.digest !== '') digest = e.digest;
    switch (e.event) {
      case 'mint':
        own(e.to_account);
        owner = e.to_account;
        owner_since = owner === '' ? undefined : pointOf(e);
        burned_at = undefined;
        uri = e.uri;
        minted = { ...pointOf(e), by: e.account, to: e.to_account };
        break;
      case 'sale':
      case 'transfer':
        own(e.from_account);
        own(e.to_account);
        owner = e.to_account;
        owner_since = owner === '' ? undefined : pointOf(e);
        burned_at = undefined;
        if (e.event === 'sale') {
          sale_count++;
          last_sale = {
            ...pointOf(e),
            tx_index: e.tx_index,
            event_index: e.event_index,
            amount: e.amount,
            currency: e.currency,
            amount_issuer: e.amount_issuer,
          };
        }
        break;
      case 'burn':
        own(e.from_account);
        owner = '';
        owner_since = undefined;
        burned_at = { ...pointOf(e), by: e.account };
        break;
      case 'modify':
        uri = e.uri;
        break;
      default:
        // an offer: it moves first_ledger and last_ledger only
        break;
    }
  }

  return {
    nft_id: newest.nft_id,
    kind: newest.kind,
    issuer: newest.issuer,
    taxon: newest.taxon,
    taxon_key: newest.taxon_key,
    serial: newest.serial,
    nft_flags: newest.nft_flags,
    transfer_fee: newest.transfer_fee,
    owner,
    ...(owner_since && { owner_since }),
    uri,
    digest,
    ...(minted && { minted }),
    burned: burned_at !== undefined,
    ...(burned_at && { burned_at }),
    sale_count,
    ...(last_sale && { last_sale }),
    first_ledger: first.ledger_index,
    last_ledger: newest.ledger_index,
    ...(first.event === 'mint' && { created_ledger: first.ledger_index }),
    owners: [...owners],
  };
}

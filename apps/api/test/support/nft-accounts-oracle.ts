import { NFT_ROLES } from '@gatehub/data-api-shared';
import { Ev, Obj, nftOf } from './nfts-oracle';

/**
 * What the account suite (`account-nfts`) checks the account routes against: the accounts an event involves with their roles (spec
 * 2.6, written out here and not taken from the parser), the NFTs an account holds and the events it is named in, in plain
 * JavaScript over events, none of it from the code under test.
 */

/** The roles of the accounts an event involves: the issuer of a mint, burn or sale, the minter when it is not the issuer, ... */
export function rolesOfEvent(e: Ev): Map<string, string[]> {
  const offerEvent = ['offer_create', 'offer_cancel', 'offer_removed'].includes(e.event);
  const holder: Record<string, string> = {
    issuer: ['mint', 'burn', 'sale'].includes(e.event) ? e.issuer : '',
    minter: e.event === 'mint' && e.account !== e.issuer ? e.account : '',
    from: e.from_account,
    to: e.to_account,
    broker: e.broker,
    offer_owner: offerEvent ? e.account : '',
    destination: e.destination,
  };
  const roles = new Map<string, string[]>();
  for (const role of NFT_ROLES) {
    const account = holder[role];
    if (account === '') continue;
    roles.set(account, [...(roles.get(account) ?? []), role]);
  }
  return roles;
}

/** Every account that some event involves. */
export function accountsOf(events: Ev[]): string[] {
  return [...new Set(events.flatMap((e) => [...rolesOfEvent(e).keys()]))].sort();
}

/**
 * The events an account is named in (`account_nft_events`), in the order of the key, with the roles it has in each; the filters
 * are those of the route: the events (a member of the list), and the roles (any of the list).
 */
export function historyOf(events: Ev[], account: string, filter: { events?: string[]; roles?: string[] } = {}): Ev[] {
  return events
    .filter((e) => {
      const roles = rolesOfEvent(e).get(account);
      if (roles === undefined) return false;
      if (filter.events !== undefined && !filter.events.includes(e.event)) return false;
      return filter.roles === undefined || filter.roles.some((r) => roles.includes(r));
    })
    .sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.event_index - b.event_index);
}

/**
 * The NFTs an account holds as the route lists them (the NFTs of the collections, so with no converted price in `last_sale`): by
 * collection (issuer, then taxon), then serial, then id. `byNft` is the events of each NFT, oldest first, up to the head.
 */
export function holdingsOf(
  byNft: Map<string, Ev[]>,
  account: string,
  collection?: { issuer?: string; taxon_key?: number },
): Obj[] {
  return [...byNft.values()]
    .map((list) => ({ head: list[0], nft: nftOf(list, () => undefined) }))
    .filter(({ nft }) => nft.burned === false && nft.owner === account)
    .filter(({ head }) => collection?.issuer === undefined || head.issuer === collection.issuer)
    .filter(({ head }) => collection?.taxon_key === undefined || head.taxon_key === collection.taxon_key)
    .sort((a, b) => {
      const [x, y] = [a.head, b.head];
      return (
        (x.issuer < y.issuer ? -1 : x.issuer > y.issuer ? 1 : 0) ||
        x.taxon_key - y.taxon_key ||
        x.serial - y.serial ||
        (x.nft_id < y.nft_id ? -1 : x.nft_id > y.nft_id ? 1 : 0)
      );
    })
    .map(({ nft }) => nft);
}

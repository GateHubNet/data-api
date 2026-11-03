import { NftEventsRow, NftKind } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { accountAt, iso } from './amm';
import { SeedName, XAHAU_URITOKEN_DIR, XRPL_NFT_DIR } from './fixtures';
import { nftEventRow } from './nfts';

/**
 * What the NFT e2e suites (`nfts`, `nft-collections`, and the account and sales suites that follow) check the routes against:
 * the two networks' worlds, the NFTs made by hand (their transactions say `synthetic-…`) and an oracle in plain JavaScript over
 * events: the state of an NFT, its events and its open offers, none of it from the code under test.
 */

export type Obj = Record<string, unknown>;
export type Ev = NftEventsRow;

/** The keys of an object are those of `order` that it has, in that order (a key that is not in `order` is a failure). */
export function expectOrdered(object: Obj, order: readonly string[], label: unknown = ''): void {
  const keys = Object.keys(object);
  expect([label, keys]).toEqual([label, order.filter((k) => keys.includes(k))]);
}

/** The same object without the keys that are undefined, null or empty text: what the API leaves out. */
export const present = (o: Record<string, unknown>): Obj =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const compareKeys = (a: Ev, b: Ev): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.event_index - b.event_index;

// =====================================================================================================================
// The worlds: one per network

export interface World {
  seed: SeedName;
  network: 'xrpl' | 'xahau';
  kind: NftKind;
  native: string;
  dir: string;
  /** The network's start ledger for NFTs, as its amendments metadata file has it. */
  start: number;
  amendment: string;
}

export const WORLDS: World[] = [
  {
    seed: 'xrpl-nft',
    network: 'xrpl',
    kind: 'nftoken',
    native: 'XRP',
    dir: XRPL_NFT_DIR,
    start: 75_443_457,
    amendment: 'NonFungibleTokensV1_1',
  },
  {
    seed: 'xahau-uritoken',
    network: 'xahau',
    kind: 'uritoken',
    native: 'XAH',
    dir: XAHAU_URITOKEN_DIR,
    start: 1,
    amendment: 'URIToken',
  },
];

/** A ledger of a fixture set as the events made by hand are put in it. */
export interface Slot {
  index: number;
  close: number;
}

export const DAY = 86_400;
export const ALICE = accountAt(0xa1);
export const BOB = accountAt(0xa2);
export const CAROL = accountAt(0xa3);
export const DAVE = accountAt(0xa4);
export const ISSUER = accountAt(0x15);

/** An NFT id made of a number: 64 upper-case hex digits. */
export const synthId = (n: number): string =>
  `${'5'.repeat(8)}${'0'.repeat(48)}${n.toString(16).toUpperCase().padStart(8, '0')}`;
export const offerIdOf = (n: number): string => `${'0F'.repeat(28)}${n.toString(16).toUpperCase().padStart(8, '0')}`;

/** The NFTs made by hand, by name. */
export const FULL = synthId(1);
export const EXPIRED = synthId(2);
export const EXPIRED_REMOVED = synthId(3);
export const TWICE = synthId(4);
export const CUT = synthId(5);
export const ABOVE = synthId(6);
export const BUSY = synthId(7);
export const SYNTHETIC_IDS = [FULL, EXPIRED, EXPIRED_REMOVED, TWICE, CUT, ABOVE, BUSY];

/** The events made by hand for a network, in the five ledgers of the seed that come first. */
export function syntheticEvents(world: World, slots: Slot[], head: number): { rows: Ev[]; above: Ev[] } {
  const [l0, l1, l2, l3, l4] = slots;
  const xrpl = world.kind === 'nftoken';
  const identity = (id: string): Partial<Ev> =>
    xrpl
      ? {
          nft_id: id,
          kind: 'nftoken',
          issuer: ISSUER,
          taxon: 7,
          taxon_key: 7,
          serial: 70,
          nft_flags: 8,
          transfer_fee: 5000,
        }
      : {
          nft_id: id,
          kind: 'uritoken',
          issuer: ISSUER,
          taxon: null,
          taxon_key: 0,
          serial: 0,
          nft_flags: 1,
          transfer_fee: 0,
        };
  /** An event of an NFT in a slot: the sender is `account`. */
  const ev = (id: string, slot: Slot, tx: number, index: number, over: Partial<Ev>): Ev =>
    nftEventRow({
      ...identity(id),
      ledger_index: slot.index,
      close_time: slot.close,
      tx_index: tx,
      event_index: index,
      uri: '',
      account: '',
      from_account: '',
      to_account: '',
      ...over,
    });
  const mint = (id: string, slot: Slot, tx: number, to: string, by = to, over: Partial<Ev> = {}): Ev =>
    ev(id, slot, tx, 0, {
      tx_type: xrpl ? 'NFTokenMint' : 'URITokenMint',
      event: 'mint',
      account: by,
      to_account: to,
      uri: '697066733A2F2F73796E7468',
      digest: xrpl ? '' : 'AB'.repeat(32),
      ...over,
    });
  /** An offer event; a URIToken's one offer has the token's id for its own. */
  const offer = (
    event: 'offer_create' | 'offer_cancel' | 'offer_removed',
    id: string,
    slot: Slot,
    tx: number,
    index: number,
    n: number,
    owner: string,
    sell: boolean,
    amount: string,
    over: Partial<Ev> = {},
  ): Ev =>
    ev(id, slot, tx, index, {
      tx_type: {
        offer_create: xrpl ? 'NFTokenCreateOffer' : 'URITokenCreateSellOffer',
        offer_cancel: xrpl ? 'NFTokenCancelOffer' : 'URITokenCancelSellOffer',
        offer_removed: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
      }[event],
      event,
      account: owner,
      offer_id: xrpl ? offerIdOf(n) : id,
      is_sell_offer: sell ? 1 : 0,
      amount,
      amount_f: Number(amount),
      currency: world.native,
      ...over,
    });
  const sale = (
    id: string,
    slot: Slot,
    tx: number,
    index: number,
    n: number,
    from: string,
    to: string,
    amount: string,
    over: Partial<Ev> = {},
  ): Ev =>
    ev(id, slot, tx, index, {
      tx_type: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
      event: 'sale',
      account: to,
      from_account: from,
      to_account: to,
      offer_id: xrpl ? offerIdOf(n) : id,
      is_sell_offer: 1,
      amount,
      amount_f: Number(amount),
      currency: world.native,
      royalty_est: xrpl ? '0.5' : '',
      ...over,
    });

  const rows: Ev[] = [];

  // FULL: a life across the five ledgers. An offer is listed, then sold; two offers are made, one of them taken by a sale and
  // the other left when the NFT has moved on (XRPL keeps an offer of the previous owner); an offer is made and cancelled.
  rows.push(
    mint(FULL, l0, 1000, ALICE, xrpl ? ALICE : ISSUER),
    offer('offer_create', FULL, l0, 1001, 0, 1, ALICE, true, '10', {
      destination: BOB,
      expiration: l0.close + 7 * DAY,
    }),
    offer('offer_removed', FULL, l1, 1000, 0, 1, ALICE, true, '10', { removed_by: 'sale' }),
    sale(FULL, l1, 1000, 1, 1, ALICE, BOB, '10'),
  );
  if (xrpl) {
    rows.push(
      offer('offer_create', FULL, l2, 1000, 0, 2, BOB, true, '20'),
      offer('offer_create', FULL, l2, 1001, 0, 3, DAVE, false, '15'),
      ev(FULL, l3, 1000, 0, { tx_type: 'NFTokenModify', event: 'modify', account: BOB, uri: '6D6F646966696564' }),
      // BOB lists the NFT again (and it expires after the ledger l4), then CAROL takes the older offer: BOB's newer one stays
      offer('offer_create', FULL, l4, 1001, 0, 4, BOB, true, '30', { expiration: l4.close + 60 }),
      offer('offer_removed', FULL, l4, 1002, 0, 2, BOB, true, '20', { removed_by: 'sale' }),
      sale(FULL, l4, 1002, 1, 2, BOB, CAROL, '20'),
      offer('offer_create', FULL, l4, 1003, 0, 5, CAROL, true, '40'),
      offer('offer_cancel', FULL, l4, 1004, 0, 5, CAROL, true, '40'),
    );
  } else {
    // a token has one offer, with its own id: made, cancelled, made again; the last of them is open
    rows.push(
      offer('offer_create', FULL, l2, 1000, 0, 0, BOB, true, '20'),
      offer('offer_cancel', FULL, l3, 1000, 0, 0, BOB, true, '20'),
      offer('offer_create', FULL, l4, 1001, 0, 0, BOB, true, '30'),
    );
  }

  if (xrpl) {
    // EXPIRED: an offer that has expired and is still there; EXPIRED_REMOVED: one that was cleaned up by another transaction
    rows.push(
      mint(EXPIRED, l0, 1002, ALICE),
      offer('offer_create', EXPIRED, l0, 1003, 0, 6, ALICE, true, '5', { expiration: l0.close + 60 }),
      mint(EXPIRED_REMOVED, l0, 1004, ALICE),
      offer('offer_create', EXPIRED_REMOVED, l0, 1005, 0, 7, ALICE, true, '5', { expiration: l0.close + 60 }),
      offer('offer_removed', EXPIRED_REMOVED, l2, 1002, 0, 7, ALICE, true, '5', {
        removed_by: 'other',
        tx_type: 'OfferCreate',
      }),
    );
  }

  // TWICE: its rows are written twice (below), among them an open offer
  rows.push(
    mint(TWICE, l1, 1002, ALICE),
    ev(TWICE, l2, 1003, 0, {
      tx_type: xrpl ? 'NFTokenAcceptOffer' : 'Remit',
      event: 'transfer',
      account: BOB,
      from_account: ALICE,
      to_account: BOB,
    }),
    ...(xrpl
      ? [ev(TWICE, l2, 1004, 0, { tx_type: 'NFTokenModify', event: 'modify', account: BOB, uri: '6D6F64' })]
      : []),
    offer('offer_create', TWICE, l3, 1002, 0, 8, BOB, true, '9'),
  );

  // CUT: an NFT with an event below the head and one above it (its ledger is not committed)
  rows.push(mint(CUT, l1, 1003, ALICE));

  // BUSY: a mint and fourteen more events, every seventh one a modify (on Xahau, which has no modify, the cancel of the offer),
  // so that a filter on it matches one event of seven
  rows.push(mint(BUSY, l0, 1006, ALICE));
  for (let i = 0; i < 14; i++) {
    const slot = [l0, l1, l2, l3, l4][Math.floor(i / 3)];
    const tx = 1100 + i;
    if (i % 7 === 3) {
      rows.push(
        xrpl
          ? ev(BUSY, slot, tx, 0, {
              tx_type: 'NFTokenModify',
              event: 'modify',
              account: ALICE,
              uri: `6D${i.toString(16).padStart(2, '0')}`,
            })
          : offer('offer_cancel', BUSY, slot, tx, 0, 0, ALICE, true, String(i + 1)),
      );
    } else {
      rows.push(offer('offer_create', BUSY, slot, tx, 0, 100 + i, ALICE, xrpl ? i % 2 === 0 : true, String(i + 1)));
    }
  }

  // above the head: an event of CUT, and the only event of ABOVE
  const beyond: Slot = { index: head + 5, close: slots[slots.length - 1].close + 600 };
  const above = [
    ev(CUT, beyond, 1000, 0, {
      tx_type: xrpl ? 'NFTokenAcceptOffer' : 'URITokenBuy',
      event: 'transfer',
      account: DAVE,
      from_account: ALICE,
      to_account: DAVE,
    }),
    mint(ABOVE, beyond, 1001, ALICE),
  ];
  return { rows, above };
}

// =====================================================================================================================
// The oracle

/** The price of a sale in the native currency the API converts without a rate: a price in the native currency is itself. */
export const nativePrice = (e: Ev): string | undefined =>
  e.amount_issuer === '' ? new BigNumber(e.amount).toFixed() : undefined;

/** The NFT as the API serves it, from its events (oldest first, each once, up to the head). */
export function nftOf(list: Ev[], converted: (e: Ev) => string | undefined = nativePrice): Obj {
  let owner = '';
  let ownerSince: Ev | undefined;
  let mint: Ev | undefined;
  let burn: Ev | undefined;
  let uri = '';
  let digest = '';
  const sales: Ev[] = [];
  for (const e of list) {
    if (e.digest !== '') digest = e.digest;
    switch (e.event) {
      case 'mint':
        owner = e.to_account;
        ownerSince = e;
        burn = undefined;
        uri = e.uri;
        mint = e;
        break;
      case 'sale':
      case 'transfer':
        owner = e.to_account;
        ownerSince = e;
        burn = undefined;
        if (e.event === 'sale') sales.push(e);
        break;
      case 'burn':
        owner = '';
        ownerSince = undefined;
        burn = e;
        break;
      case 'modify':
        uri = e.uri;
        break;
    }
  }
  const newest = list[list.length - 1];
  const point = (e: Ev): Obj => ({
    ledger_index: e.ledger_index,
    tx_hash: e.tx_hash,
    executed_time: iso(e.close_time),
  });
  const last = sales[sales.length - 1];
  const xrpl = newest.kind === 'nftoken';
  return present({
    nft_id: newest.nft_id,
    kind: newest.kind,
    issuer: newest.issuer,
    taxon: xrpl ? newest.taxon : undefined,
    serial: xrpl ? newest.serial : undefined,
    flags: newest.nft_flags,
    transfer_fee: xrpl ? newest.transfer_fee : undefined,
    owner,
    owner_since: ownerSince && owner !== '' ? point(ownerSince) : undefined,
    uri,
    digest,
    minted: mint && { ...point(mint), by: mint.account, to: mint.to_account },
    burned: burn !== undefined,
    burned_at: burn && { ...point(burn), by: burn.account },
    sale_count: sales.length,
    last_sale:
      last &&
      present({
        amount: last.amount,
        currency: last.currency,
        amount_issuer: last.amount_issuer,
        converted_amount: converted(last),
        ...point(last),
      }),
  });
}

/** An event as the API serves it. */
export function eventOf(e: Ev, converted: (e: Ev) => string | undefined = nativePrice): Obj {
  const xrpl = e.kind === 'nftoken';
  return present({
    nft_id: e.nft_id,
    kind: e.kind,
    issuer: e.issuer,
    taxon: xrpl ? e.taxon : undefined,
    serial: xrpl ? e.serial : undefined,
    ledger_index: e.ledger_index,
    tx_index: e.tx_index,
    event_index: e.event_index,
    tx_hash: e.tx_hash,
    tx_type: e.tx_type,
    executed_time: iso(e.close_time),
    event: e.event,
    account: e.account,
    from: e.from_account,
    to: e.to_account,
    offer_id: e.offer_id,
    is_sell_offer: e.offer_id === '' ? undefined : e.is_sell_offer === 1,
    amount: e.amount,
    currency: e.currency,
    amount_issuer: e.amount_issuer,
    converted_amount: e.event === 'sale' ? converted(e) : undefined,
    destination: e.destination,
    expiration: e.expiration === null ? undefined : iso(e.expiration),
    broker: e.broker,
    broker_fee: e.broker_fee,
    royalty_est: e.royalty_est,
    removed_by: e.removed_by,
    uri: e.uri,
  });
}

/** The open offers of an NFT, newest first: the offers whose newest event is their creation. */
export function openOffersOf(list: Ev[]): Ev[] {
  const newest = new Map<string, Ev>();
  for (const e of list)
    if (['offer_create', 'offer_cancel', 'offer_removed'].includes(e.event)) newest.set(e.offer_id, e);
  return [...newest.values()].filter((e) => e.event === 'offer_create').sort((a, b) => compareKeys(b, a));
}

/** An open offer as the API serves it. */
export const offerOf = (e: Ev): Obj =>
  present({
    offer_id: e.offer_id,
    is_sell_offer: e.is_sell_offer === 1,
    owner: e.account,
    amount: e.amount,
    currency: e.currency,
    amount_issuer: e.amount_issuer,
    destination: e.destination,
    expiration: e.expiration === null ? undefined : iso(e.expiration),
    created_ledger: e.ledger_index,
    created_tx_hash: e.tx_hash,
    created_time: iso(e.close_time),
  });

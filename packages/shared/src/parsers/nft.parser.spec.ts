/**
 * NftParser (the XRPL half) over the recorded mainnet NFT cases (`test/fixtures/xrpl/nft`, README section "XRPL NFT
 * cases") and the synthetic cases below. A synthetic transaction is hand-made, never recorded: every one is named
 * `synthetic-…` and is a recorded transaction with a small, named edit of it, or (the first) built from the recorded
 * shapes of its nodes:
 *
 * - `synthetic-offer-removed-other` (not found on mainnet, FINDINGS "Not found"): an `AccountDelete` by the owner of the
 *   recorded `offer_cancel` offer, whose metadata deletes the account, its owner directory and that `NFTokenOffer`
 *   (rippled's DeleteAccount removes an account's offers), and credits the destination.
 * - `synthetic-cancel-by-destination`: `offer_cancel` sent by the offer's `Destination`, not its owner.
 * - `synthetic-page-merge`: `burn` with the owner's page of 23 tokens spread over two pages before it (as a burn that
 *   merges two pages leaves them): the second page is a DeletedNode and the first holds all 22 tokens left.
 * - `synthetic-page-merge-forward`: `burn` whose page is deleted after the burn removed a token from it and merged the
 *   rest forward into the owner's next page: its `FinalFields` lack the token, its `PreviousFields` have it.
 * - `synthetic-sale-merge-forward`: the same for `sale_by_sell_offer`: the seller's page is deleted and merged forward.
 * - `synthetic-no-transfer-fee`: `sale_by_sell_offer` with the transfer fee of the id set to 0, the issuer neither party.
 * - `synthetic-offers-in-node-order`: `offer_cancel` with a second deleted offer after it and two created offers, each
 *   pair in `AffectedNodes` order opposite to the order of offer ids and of NFT ids.
 * - `synthetic-link-only-page`: `offer_cancel` plus a ModifiedNode `NFTokenPage` whose only change is a link
 *   (`PreviousFields` hold `NextPageMin`), the neighbour of a page split, with tokens that did not change.
 * - `synthetic-mixed-order`: `mint` with two more minted ids (one sorting before, one after the recorded one), a burned id,
 *   a modified URI, a created offer first and a deleted offer last in `AffectedNodes`: every kind of the order rule.
 * - `synthetic-failed-mint`, `synthetic-failed-accept`: recorded transactions with a `tec` result and every node kept.
 * - `synthetic-mpt-offer`, `synthetic-mpt-mint-offer`, `synthetic-mpt-accept`: an offer, a mint's offer and an
 *   accepted offer priced with an MPT amount.
 * - `synthetic-burn-last-token`: `burn` of the only token of its page, which is deleted with that token in its
 *   `FinalFields` (rippled erases an emptied page without changing it first).
 * - `synthetic-issuer-buys`: `sale_by_sell_offer` whose buyer is the NFT's issuer.
 * - `synthetic-lower-case-id`: `mint_with_offer` with its id written in lower case, which the events write in upper case.
 * - `synthetic-fractional-drop`: `sale_by_sell_offer` at a price of 10.000011, whose royalty is a fraction of a drop.
 * - `synthetic-issued-exponent-form`: `sale_issued_currency` priced `1e-7`, as rippled writes small amounts.
 * - `synthetic-issued-royalty`: `sale_issued_currency` with the seller replaced, so that the issuer is neither party, and a
 *   transfer fee of 49.999% on a price of 9999999999999999.
 * - `synthetic-brokered-issued`: `brokered_sale_royalty` priced in an issued currency, with the same fee and price and a
 *   broker fee of 1000000.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { decodeAccountID } from 'ripple-address-codec';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import {
  NFT_EVENTS,
  NFT_ROLES,
  NftEventName,
  NftParser,
  NftRole,
  ParsedNft,
  ParsedNftEvent,
  rolesOf,
} from './nft.parser';
import { ParseContext, parseContextFor, ParserTx, toParserTx } from './parser.interface';

type Json = Record<string, any>;

const DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'xrpl', 'nft');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  cases: Record<string, { ledger: number; hash: string }>;
};
const source = FixtureLedgerSource.fromDir(DIR);
const XRPL: ParseContext = parseContextFor(getNetworkProfile('xrpl'));
const parser = new NftParser();
const parse = (t: ParserTx): ParsedNft => parser.parse(t, XRPL);

/** A recorded case by its manifest name, deep-frozen. */
async function recorded(name: string): Promise<ParserTx> {
  const c = manifest.cases[name];
  if (!c) throw new Error(`no recorded case ${name}`);
  const ledger = await source.fetch(c.ledger);
  const raw = ledger.transactions.find((t) => t.hash === c.hash);
  if (!raw) throw new Error(`${name}: ${c.hash} is not in ledger ${c.ledger}`);
  return deepFreeze(toParserTx(raw, ledger.header, null));
}

/** A deep-frozen copy of `t` after `edit` changed (copies of) its transaction and metadata. */
function variant(t: ParserTx, edit: (tx: Json, meta: Json) => void): ParserTx {
  const tx = structuredClone(t.tx) as Json;
  const meta = structuredClone(t.meta) as Json;
  edit(tx, meta);
  return deepFreeze({ ...t, tx, meta });
}

/** `t` with every occurrence of `from` replaced by `to` in its transaction and metadata (an id, an account). */
function replaced(t: ParserTx, from: string, to: string): ParserTx {
  const swap = (value: unknown) => JSON.parse(JSON.stringify(value).split(from).join(to));
  return deepFreeze({ ...t, tx: swap(t.tx), meta: swap(t.meta) });
}

/** The body (`ModifiedNode`, ... contents) of `AffectedNodes[index]`. */
const body = (meta: Json, index: number): Json => {
  const wrapper = meta.AffectedNodes[index];
  return wrapper[Object.keys(wrapper)[0]];
};

/** The first node of the metadata with this ledger entry type and operation. */
function nodeOf(t: ParserTx, type: string, op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'): Json {
  const wrapper = (t.meta.AffectedNodes as Json[]).find((w) => w[op]?.LedgerEntryType === type);
  if (!wrapper) throw new Error(`no ${op} ${type}`);
  return structuredClone(wrapper) as Json;
}

/** What `NFTokenID`s decode to, written down from the recorded transactions, not from the decoder. */
interface Known {
  id: string;
  issuer: string;
  taxon: number;
  serial: number;
  flags: number;
  fee: number;
}

const NFTS = {
  mint: {
    id: '0019000040FEFE9E7C73D4F8A4DC7A7A09DD13B724827F945B2680E5061B0D4A',
    issuer: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
    taxon: 0,
    serial: 102436170,
    flags: 25,
    fee: 0,
  },
  mintWithOffer: {
    id: '00181F40AF09C1D4B4D1E8031467F3508DFFADABEA73255FBE9F0F960655EBFA',
    issuer: 'rGxWAWXg8okZh29ojBRvEMpN5peQRV16Xu',
    taxon: 3,
    serial: 106294266,
    flags: 24,
    fee: 8000,
  },
  mintOnBehalf: {
    id: '001861A86D2DF313DD3688E9B156F47B99A8C80F4692DF244CEB911005FC3176',
    issuer: 'rwxH6YD51ygruAtDWixsgH5UUu6hmUi3AC',
    taxon: 1,
    serial: 100413814,
    flags: 24,
    fee: 25000,
  },
  burn: {
    id: '0019000040FEFE9E7C73D4F8A4DC7A7A09DD13B724827F9442666327061B0D8C',
    issuer: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
    taxon: 0,
    serial: 102436236,
    flags: 25,
    fee: 0,
  },
  burnRemovesOffers: {
    id: '00081388CFF1C6E01236757983B2F73D2A57B94FB165D29473F38DB90663D71D',
    issuer: 'rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f',
    taxon: 1,
    serial: 107206429,
    flags: 8,
    fee: 5000,
  },
  modify: {
    id: '00191F4072D67B49A7ED6E16B05851CF77CDC8475B5FD73836412B5105A01DC4',
    issuer: 'rB7UyKs9SwS4pX87tqtMjq4XRiEhkBfmuH',
    taxon: 14,
    serial: 94379460,
    flags: 25,
    fee: 8000,
  },
  sellOffer: {
    id: '000813886E50B2960CF48DCB644E85B412C660B4E1B01A87C283F9E6066AB54B',
    issuer: 'rBhJrnrN8Q6FQyDwg6ZrtoBa2QCicCEzug',
    taxon: 0,
    serial: 107656523,
    flags: 8,
    fee: 5000,
  },
  buyOffer: {
    id: '0008138882D0F98C64A1A0E6D15053589771AD08B8C13D53A655402C00000492',
    issuer: 'rUv6Bmw6GRQHgJaiVcXnnNFCeTMKUE6FCa',
    taxon: 1,
    serial: 1170,
    flags: 8,
    fee: 5000,
  },
  cancelled: {
    id: '001813881F9C83FE46F4EEC59D5E8C0B017F1791F856B88214F8C43106111595',
    issuer: 'rst9Sq8mVxK8b7BbgFs4VmnVtfm7N2qN4j',
    taxon: 1,
    serial: 101782933,
    flags: 24,
    fee: 5000,
  },
  soldBySellOffer: {
    id: '00081388EA968E3C54EE59C8FFBAF0944A3B8AD4797AB032EF22952605AD2A91',
    issuer: 'r4PP7gwuVfxzLPWFiJXjLUtvzA7F97CzT3',
    taxon: 10,
    serial: 95234705,
    flags: 8,
    fee: 5000,
  },
  soldByBuyOffer: {
    id: '000803E88ACAA32313BB87F729EF7DA56BD13C57BE46E3C8B0730F290481ED98',
    issuer: 'rDeizxSRo6JHjKnih9ivpPkyD2EgXQvhSB',
    taxon: 26,
    serial: 75623832,
    flags: 8,
    fee: 1000,
  },
  brokered: {
    id: '00190BB8DAEF366CB05EE8DCC919EF9A1AA24DD22B3D62C9D848920A0669E96F',
    issuer: 'rLxc1bt5defiLJ9gaZEJqQWnNKYNawrwMy',
    taxon: 0,
    serial: 107604335,
    flags: 25,
    fee: 3000,
  },
  soldForIssued: {
    id: '00081388048ECA9BA1C412A6BFFEEA29E21873E92DE6B3F3EA90AAA805041E13',
    issuer: 'rRamaNFTdhr1q7gjsDK1Q4baffxHUQfQ9',
    taxon: 6,
    serial: 84155923,
    flags: 8,
    fee: 5000,
  },
  transferred: {
    id: '0018C350C7DEC772B41E9496AA92D148C4FD64D239AA62985D24F44D05B7F6B4',
    issuer: 'rKDFM3xaC3B7ijWkX4iHcMTcLFgxW2dK74',
    taxon: 2,
    serial: 95942324,
    flags: 24,
    fee: 50000,
  },
  splitMint: {
    id: '00181F40AF09C1D4B4D1E8031467F3508DFFADABEA73255F79ED9C910655EBF7',
    issuer: 'rGxWAWXg8okZh29ojBRvEMpN5peQRV16Xu',
    taxon: 3,
    serial: 106294263,
    flags: 24,
    fee: 8000,
  },
} satisfies Record<string, Known>;

/** An event with every column at its absent value, the NFT's decoded columns and `fields` on top. */
function ev(nft: Known, event_index: number, event: NftEventName, fields: Partial<ParsedNftEvent>): ParsedNftEvent {
  return {
    nft_id: nft.id,
    event_index,
    kind: 'nftoken',
    event,
    issuer: nft.issuer,
    taxon: nft.taxon,
    taxon_key: nft.taxon,
    serial: nft.serial,
    nft_flags: nft.flags,
    transfer_fee: nft.fee,
    uri: '',
    digest: '',
    account: '',
    from_account: '',
    to_account: '',
    offer_id: '',
    is_sell_offer: 0,
    amount: '',
    currency: '',
    amount_issuer: '',
    destination: '',
    expiration: null,
    broker: '',
    broker_fee: '',
    royalty_est: '',
    removed_by: '',
    ...fields,
  };
}

const BROKER = 'rpx9JThQ2y37FaGeeJP7PXDUVEXY3PHZSC';
const XRPLAY = { currency: '5852506C61790000000000000000000000000000', issuer: 'rfUefeHzBZQGEs66znmX9rV6S9viGbxv9v' };
const USD = { currency: 'USD', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' };

const last = <T>(list: readonly T[]): T => list[list.length - 1];

/** The events of a transaction. */
const eventsOf = (t: ParserTx): ParsedNftEvent[] => parse(t).events;

describe('NftParser: recorded cases', () => {
  it('mint: one mint, to the owner of the page, from the sender, with the decoded id and the URI', async () => {
    const t = await recorded('mint');
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.mint, 0, 'mint', {
          account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          to_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          uri: t.tx.URI,
        }),
      ],
      skipped: 0,
    });
  });

  it('mint_with_offer: the mint, then its gift offer with the amount the transaction names', async () => {
    const t = await recorded('mint_with_offer');
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.mintWithOffer, 0, 'mint', {
          account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          to_account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          uri: t.tx.URI,
        }),
        // The created node has no Amount (a zero native amount is not stored): the transaction's "0" is the amount.
        ev(NFTS.mintWithOffer, 1, 'offer_create', {
          account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          offer_id: '7175449248947D620AD9BABE1396971F1185DF6C2DEE282A588AF3A06BD6CFDC',
          is_sell_offer: 1,
          amount: '0',
          currency: 'XRP',
          destination: 'rfin4yze7ZEygheDjknACfNFHYCLG43W7R',
          expiration: 1794113527,
        }),
      ],
      skipped: 0,
    });
  });

  it('mint_on_behalf: the minter is the account, the issuer the id’s, and rolesOf names both', async () => {
    const t = await recorded('mint_on_behalf');
    const { events } = parse(t);
    expect(events).toEqual([
      ev(NFTS.mintOnBehalf, 0, 'mint', {
        account: 'riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN',
        to_account: 'riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN',
        uri: t.tx.URI,
      }),
    ]);
    expect(events[0].issuer).toBe('rwxH6YD51ygruAtDWixsgH5UUu6hmUi3AC');
    expect([...rolesOf(events[0])]).toEqual([
      ['rwxH6YD51ygruAtDWixsgH5UUu6hmUi3AC', ['issuer']],
      ['riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN', ['minter', 'to']],
    ]);
  });

  it('burn: one burn, from the owner of the page', async () => {
    expect(parse(await recorded('burn'))).toEqual({
      events: [
        ev(NFTS.burn, 0, 'burn', {
          account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          from_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
        }),
      ],
      skipped: 0,
    });
  });

  it('burn_removes_offers: the offer the burn deleted is removed_by burn, first, then the burn', async () => {
    expect(parse(await recorded('burn_removes_offers'))).toEqual({
      events: [
        ev(NFTS.burnRemovesOffers, 0, 'offer_removed', {
          account: 'rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f',
          offer_id: 'C2EC7B13B82DDD2DB3E226B1812D953EE6EF6619EB04B712CD5554740289DB0E',
          is_sell_offer: 1,
          amount: '4',
          currency: 'XRP',
          destination: BROKER,
          removed_by: 'burn',
        }),
        ev(NFTS.burnRemovesOffers, 1, 'burn', {
          account: 'rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f',
          from_account: 'rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f',
        }),
      ],
      skipped: 0,
    });
  });

  it('modify: one modify with the new URI, and no owner', async () => {
    const t = await recorded('modify');
    expect(parse(t)).toEqual({
      events: [ev(NFTS.modify, 0, 'modify', { account: 'rB7UyKs9SwS4pX87tqtMjq4XRiEhkBfmuH', uri: t.tx.URI })],
      skipped: 0,
    });
  });

  it('sell_offer_create: a sell offer of the sender, with its price and destination', async () => {
    expect(parse(await recorded('sell_offer_create'))).toEqual({
      events: [
        ev(NFTS.sellOffer, 0, 'offer_create', {
          account: 'rHhvUexKKSJZG9vuZKX2kNendG2TXoavG9',
          offer_id: 'D6697EB570D95FBE80C369A2CCD9CF21CE04258B04829638313820058FE8CAEE',
          is_sell_offer: 1,
          amount: '19.98',
          currency: 'XRP',
          destination: BROKER,
        }),
      ],
      skipped: 0,
    });
  });

  it('buy_offer_create: a buy offer (is_sell_offer 0) of the sender, not of the NFT’s owner, with its expiration', async () => {
    expect(parse(await recorded('buy_offer_create'))).toEqual({
      events: [
        ev(NFTS.buyOffer, 0, 'offer_create', {
          account: 'rB1q8i6QaAJgSQdvbxGsP4pxsUv6QeTEWm',
          offer_id: '00FF9CF6539F6D9D0EB5B7FE487E0FA9B19AD7124B2B6D64D4F48E7CCFBAF972',
          is_sell_offer: 0,
          amount: '8.11',
          currency: 'XRP',
          destination: BROKER,
          expiration: 1792990326,
        }),
      ],
      skipped: 0,
    });
  });

  it('offer_cancel: the deleted offer is an offer_cancel of its owner', async () => {
    expect(parse(await recorded('offer_cancel'))).toEqual({
      events: [
        ev(NFTS.cancelled, 0, 'offer_cancel', {
          account: 'rf7Db55CXcWgqmHnb1Pjx1WVGNCqMNsyZ',
          offer_id: 'C094C217BD0396C55630195FA2C8677CF0D3961C8950BC50D827C036B532A9CF',
          is_sell_offer: 0,
          amount: '146.25',
          currency: 'XRP',
          destination: BROKER,
          expiration: 1793496181,
        }),
      ],
      skipped: 0,
    });
  });

  it('sale_by_sell_offer: the seller is the offer’s owner, the buyer the sender, and the issuer’s royalty is 0.5', async () => {
    expect(parse(await recorded('sale_by_sell_offer'))).toEqual({
      events: [
        ev(NFTS.soldBySellOffer, 0, 'offer_removed', {
          account: 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz',
          offer_id: 'D6DBB6452D44459FDA013C79708D2E699EA2340D5444AC1695FF621A80FDFBDE',
          is_sell_offer: 1,
          amount: '10',
          currency: 'XRP',
          destination: 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx',
          expiration: 1792858961,
          removed_by: 'sale',
        }),
        ev(NFTS.soldBySellOffer, 1, 'sale', {
          account: 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx',
          from_account: 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz',
          to_account: 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx',
          offer_id: 'D6DBB6452D44459FDA013C79708D2E699EA2340D5444AC1695FF621A80FDFBDE',
          is_sell_offer: 1,
          amount: '10',
          currency: 'XRP',
          royalty_est: '0.5',
        }),
      ],
      skipped: 0,
    });
  });

  it('sale_by_buy_offer: the seller is the sender (and the issuer), the buyer the offer’s owner, and no royalty', async () => {
    expect(parse(await recorded('sale_by_buy_offer'))).toEqual({
      events: [
        ev(NFTS.soldByBuyOffer, 0, 'offer_removed', {
          account: 'r47kUrvGHkHgxLi1KedaHzdUvbR9GTreEe',
          offer_id: '0ABE2264B31E8A9C7D483866EE1CCE4621E861F7D8A07F06E8B019F51CC54617',
          is_sell_offer: 0,
          amount: '0.000001',
          currency: 'XRP',
          removed_by: 'sale',
        }),
        ev(NFTS.soldByBuyOffer, 1, 'sale', {
          account: 'rDeizxSRo6JHjKnih9ivpPkyD2EgXQvhSB',
          from_account: 'rDeizxSRo6JHjKnih9ivpPkyD2EgXQvhSB',
          to_account: 'r47kUrvGHkHgxLi1KedaHzdUvbR9GTreEe',
          offer_id: '0ABE2264B31E8A9C7D483866EE1CCE4621E861F7D8A07F06E8B019F51CC54617',
          is_sell_offer: 0,
          amount: '0.000001',
          currency: 'XRP',
          royalty_est: '',
        }),
      ],
      skipped: 0,
    });
  });

  it('brokered_sale_royalty: both offers removed, then the sale at the buy offer’s price with the royalty FINDINGS checked', async () => {
    const { events } = parse(await recorded('brokered_sale_royalty'));
    expect(events).toEqual([
      ev(NFTS.brokered, 0, 'offer_removed', {
        account: 'rfivr3BK17R28wnVwpQQhSDvo2A2fmnEje',
        offer_id: '05BC61CFB58ABA8969C852FBF907CC687A442AD3ED64FB30EA41149ECD0F6780',
        is_sell_offer: 1,
        amount: '147.6165',
        currency: 'XRP',
        destination: BROKER,
        removed_by: 'sale',
      }),
      ev(NFTS.brokered, 1, 'offer_removed', {
        account: 'rLCscV9iDJpvje4ZCKxGjYAMNtBA1Ltauk',
        offer_id: '0DF63F5C3FCC30EE52E2622E64406E050A9F6A8537A4E74C6F1263ABDED88BBE',
        is_sell_offer: 0,
        amount: '150',
        currency: 'XRP',
        destination: BROKER,
        removed_by: 'sale',
      }),
      // The sale names the sell offer (Ruling 14). FINDINGS 4: (150000000 - 2383500) x 3000 / 100000 = 4428495 drops, the
      // rise of the issuer's balance.
      ev(NFTS.brokered, 2, 'sale', {
        account: BROKER,
        from_account: 'rfivr3BK17R28wnVwpQQhSDvo2A2fmnEje',
        to_account: 'rLCscV9iDJpvje4ZCKxGjYAMNtBA1Ltauk',
        offer_id: '05BC61CFB58ABA8969C852FBF907CC687A442AD3ED64FB30EA41149ECD0F6780',
        is_sell_offer: 1,
        amount: '150',
        currency: 'XRP',
        broker: BROKER,
        broker_fee: '2.3835',
        royalty_est: '4.428495',
      }),
    ]);
  });

  it('sale_issued_currency: the price is in its own currency, and the issuer who sells gets no royalty', async () => {
    expect(parse(await recorded('sale_issued_currency'))).toEqual({
      events: [
        ev(NFTS.soldForIssued, 0, 'offer_removed', {
          account: 'rRamaNFTdhr1q7gjsDK1Q4baffxHUQfQ9',
          offer_id: '58A18F1CF52EA11A65CFC2F1C168908C4AF315A08ECA5FA238A40A0D01A67CE8',
          is_sell_offer: 1,
          amount: '100',
          currency: XRPLAY.currency,
          amount_issuer: XRPLAY.issuer,
          removed_by: 'sale',
        }),
        ev(NFTS.soldForIssued, 1, 'sale', {
          account: 'rLTavNLNKhA1kf8KMfW5U4Q1TNGSUNdint',
          from_account: 'rRamaNFTdhr1q7gjsDK1Q4baffxHUQfQ9',
          to_account: 'rLTavNLNKhA1kf8KMfW5U4Q1TNGSUNdint',
          offer_id: '58A18F1CF52EA11A65CFC2F1C168908C4AF315A08ECA5FA238A40A0D01A67CE8',
          is_sell_offer: 1,
          amount: '100',
          currency: XRPLAY.currency,
          amount_issuer: XRPLAY.issuer,
          royalty_est: '',
        }),
      ],
      skipped: 0,
    });
  });

  it('transfer_zero_amount: a transfer, with no amount and no royalty', async () => {
    // The offer is removed by an NFTokenAcceptOffer, so spec 2.2 says `sale` (the transfer follows it).
    expect(parse(await recorded('transfer_zero_amount'))).toEqual({
      events: [
        ev(NFTS.transferred, 0, 'offer_removed', {
          account: 'riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN',
          offer_id: '54BADD751BFBEA1B178D0E766506F9AA712AD1D453EDB165B1E8D78C4356FFE2',
          is_sell_offer: 1,
          amount: '0',
          currency: 'XRP',
          destination: 'r4Xgqy68ykjLEJAkFQ7EaFs8VEdSiWkSeX',
          removed_by: 'sale',
        }),
        ev(NFTS.transferred, 1, 'transfer', {
          account: 'r4Xgqy68ykjLEJAkFQ7EaFs8VEdSiWkSeX',
          from_account: 'riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN',
          to_account: 'r4Xgqy68ykjLEJAkFQ7EaFs8VEdSiWkSeX',
          offer_id: '54BADD751BFBEA1B178D0E766506F9AA712AD1D453EDB165B1E8D78C4356FFE2',
          is_sell_offer: 1,
        }),
      ],
      skipped: 0,
    });
  });

  it('page_split_with_mint: exactly one mint, though three pages changed, then the mint’s offer', async () => {
    const t = await recorded('page_split_with_mint');
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.splitMint, 0, 'mint', {
          account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          to_account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          uri: t.tx.URI,
        }),
        ev(NFTS.splitMint, 1, 'offer_create', {
          account: 'rKqqb5QZXVAL3VqXJL6obfRGeHou1DtyBV',
          offer_id: 'CC22C15F44B8B424D655E220EB6B431B8525B4CEED6EDCEF80C0FE90552DF12A',
          is_sell_offer: 1,
          amount: '0',
          currency: 'XRP',
          destination: 'rfin4yze7ZEygheDjknACfNFHYCLG43W7R',
          expiration: 1794113527,
        }),
      ],
      skipped: 0,
    });
  });
});

/** The builders of the synthetic transactions of the header, by name. */
const builders: Record<string, () => Promise<ParserTx>> = {
  'synthetic-offer-removed-other': async () => {
    const base = await recorded('offer_cancel');
    const owner = 'rf7Db55CXcWgqmHnb1Pjx1WVGNCqMNsyZ';
    const offer = nodeOf(base, 'NFTokenOffer', 'DeletedNode');
    return deepFreeze({
      ...base,
      tx_index: 0,
      tx: {
        Account: owner,
        Destination: BROKER,
        Fee: '2000000',
        Flags: 0,
        Sequence: 107767033,
        TransactionType: 'AccountDelete',
      },
      meta: {
        TransactionIndex: 0,
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
          {
            DeletedNode: {
              LedgerEntryType: 'AccountRoot',
              LedgerIndex: 'A'.repeat(64),
              FinalFields: { Account: owner },
            },
          },
          {
            DeletedNode: {
              LedgerEntryType: 'DirectoryNode',
              LedgerIndex: 'B'.repeat(64),
              FinalFields: { Owner: owner },
            },
          },
          offer,
          {
            ModifiedNode: {
              LedgerEntryType: 'AccountRoot',
              LedgerIndex: 'C'.repeat(64),
              FinalFields: { Account: BROKER },
            },
          },
        ],
      },
    });
  },
  'synthetic-cancel-by-destination': async () =>
    variant(await recorded('offer_cancel'), (tx) => {
      tx.Account = BROKER;
    }),
  'synthetic-page-merge': async () =>
    variant(await recorded('burn'), (_tx, meta) => {
      const page = body(meta, 0);
      const before: Json[] = page.PreviousFields.NFTokens;
      // The page's 23 tokens were on two pages of its owner; the burn removed the 4th and merged what was left.
      page.PreviousFields.NFTokens = before.slice(0, 12);
      meta.AffectedNodes.push({
        DeletedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: `${page.LedgerIndex.slice(0, 40)}24827F945D1B3E9A061B0001`,
          FinalFields: { Flags: 0, NFTokens: before.slice(12), PreviousPageMin: page.LedgerIndex },
        },
      });
    }),
  'synthetic-page-merge-forward': async () =>
    variant(await recorded('burn'), (_tx, meta) => {
      const page = body(meta, 0);
      const before: Json[] = page.PreviousFields.NFTokens;
      const left: Json[] = page.FinalFields.NFTokens;
      const next = `${page.LedgerIndex.slice(0, 40)}FFFFFFFFFFFFFFFFFFFFFFFF`;
      const own = [{ NFToken: { NFTokenID: `${NFTS.burn.id.slice(0, -2)}F0`, URI: '697066733A2F2F4F574E' } }];
      // The burn took a token off the page (22 left of 23), then rippled merged the page forward and erased it: the final
      // array is the 22, the previous array the 23, and the 22 are on the next page now.
      meta.AffectedNodes[0] = {
        DeletedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: page.LedgerIndex,
          FinalFields: { Flags: 0, NFTokens: left, NextPageMin: next },
          PreviousFields: { NFTokens: before },
        },
      };
      meta.AffectedNodes.push({
        ModifiedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: next,
          FinalFields: { Flags: 0, NFTokens: [...own, ...left], PreviousPageMin: page.LedgerIndex },
          PreviousFields: { NFTokens: own },
        },
      });
    }),
  'synthetic-sale-merge-forward': async () =>
    variant(await recorded('sale_by_sell_offer'), (_tx, meta) => {
      // The seller's page (node 0) gave the sold token away and was merged forward into the seller's next page.
      const page = body(meta, 0);
      const before: Json[] = page.PreviousFields.NFTokens;
      const left: Json[] = page.FinalFields.NFTokens;
      const next = `${page.LedgerIndex.slice(0, 40)}FFFFFFFFFFFFFFFFFFFFFFFF`;
      const own = [
        { NFToken: { NFTokenID: `${NFTS.soldBySellOffer.id.slice(0, -2)}F0`, URI: '697066733A2F2F4F574E' } },
      ];
      meta.AffectedNodes[0] = {
        DeletedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: page.LedgerIndex,
          FinalFields: { Flags: 0, NFTokens: left },
          PreviousFields: { NFTokens: before },
        },
      };
      meta.AffectedNodes.push({
        ModifiedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: next,
          FinalFields: { Flags: 0, NFTokens: [...own, ...left] },
          PreviousFields: { NFTokens: own },
        },
      });
    }),
  'synthetic-no-transfer-fee': async () =>
    replaced(
      await recorded('sale_by_sell_offer'),
      NFTS.soldBySellOffer.id,
      `00080000${NFTS.soldBySellOffer.id.slice(8)}`,
    ),
  'synthetic-offers-in-node-order': async () => {
    const created = nodeOf(await recorded('sell_offer_create'), 'NFTokenOffer', 'CreatedNode');
    return variant(await recorded('offer_cancel'), (_tx, meta) => {
      // The recorded deleted offer comes first, then one with the smaller offer id and the smaller NFT id.
      const removed = structuredClone(meta.AffectedNodes[4]);
      removed.DeletedNode.LedgerIndex = `${'0'.repeat(63)}1`;
      removed.DeletedNode.FinalFields.NFTokenID = NFTS.sellOffer.id;
      meta.AffectedNodes.push(removed);
      // Two created offers: first one with the larger offer id and the larger NFT id, then the recorded one.
      const first = structuredClone(created);
      first.CreatedNode.LedgerIndex = 'F'.repeat(64);
      first.CreatedNode.NewFields.NFTokenID = NFTS.cancelled.id;
      meta.AffectedNodes.push(first, structuredClone(created));
    });
  },
  'synthetic-link-only-page': async () => {
    const mint = await recorded('mint');
    const tokens = (nodeOf(mint, 'NFTokenPage', 'ModifiedNode').ModifiedNode.FinalFields.NFTokens as Json[]).slice(
      0,
      3,
    );
    return variant(await recorded('offer_cancel'), (_tx, meta) => {
      meta.AffectedNodes.push({
        ModifiedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: `${'40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94'}24827F945D1B3E9A061B0001`,
          FinalFields: {
            Flags: 0,
            NFTokens: tokens,
            NextPageMin: `${'40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94'}24827F945D1B3E9A061B0002`,
          },
          PreviousFields: { NextPageMin: `${'40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94'}24827F945D1B3E9A061B0003` },
        },
      });
    });
  },
  'synthetic-mixed-order': async () => {
    const created = nodeOf(await recorded('sell_offer_create'), 'NFTokenOffer', 'CreatedNode');
    const deleted = nodeOf(await recorded('offer_cancel'), 'NFTokenOffer', 'DeletedNode');
    return variant(await recorded('mint'), (_tx, meta) => {
      const page = body(meta, 0);
      const tokens: Json[] = page.FinalFields.NFTokens;
      const entry = (id: string) => ({ NFToken: { NFTokenID: id, URI: '697066733A2F2F4D4958' } });
      // Two more new ids, one sorting before and one after the recorded mint's (…D4A); the last token is burned and the
      // first one's URI is replaced.
      tokens.push(entry(`${NFTS.mint.id.slice(0, -1)}B`), entry(`${NFTS.mint.id.slice(0, -1)}9`));
      tokens.splice(tokens.length - 3, 1);
      tokens[0].NFToken.URI = '697066733A2F2F4E4557';
      meta.AffectedNodes.unshift(created);
      meta.AffectedNodes.push(deleted);
    });
  },
  'synthetic-failed-mint': async () =>
    variant(await recorded('mint'), (_tx, meta) => {
      meta.TransactionResult = 'tecINSUFFICIENT_RESERVE';
    }),
  'synthetic-failed-accept': async () =>
    variant(await recorded('brokered_sale_royalty'), (_tx, meta) => {
      meta.TransactionResult = 'tecOBJECT_NOT_FOUND';
    }),
  'synthetic-mpt-offer': async () =>
    variant(await recorded('sell_offer_create'), (tx, meta) => {
      const amount = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '100' };
      tx.Amount = amount;
      body(meta, 4).NewFields.Amount = amount;
    }),
  'synthetic-mpt-mint-offer': async () =>
    variant(await recorded('mint_with_offer'), (tx, meta) => {
      const amount = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '100' };
      tx.Amount = amount;
      body(meta, 2).NewFields.Amount = amount;
    }),
  'synthetic-mpt-accept': async () =>
    variant(await recorded('sale_by_sell_offer'), (_tx, meta) => {
      body(meta, 6).FinalFields.Amount = {
        mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47',
        value: '100',
      };
    }),
  'synthetic-burn-last-token': async () =>
    variant(await recorded('burn'), (_tx, meta) => {
      const page = body(meta, 0);
      const burned = (page.PreviousFields.NFTokens as Json[]).find((e) => e.NFToken.NFTokenID === NFTS.burn.id);
      meta.AffectedNodes[0] = {
        DeletedNode: {
          LedgerEntryType: 'NFTokenPage',
          LedgerIndex: page.LedgerIndex,
          FinalFields: { Flags: 0, NFTokens: [burned] },
        },
      };
    }),
  'synthetic-issuer-buys': async () =>
    variant(await recorded('sale_by_sell_offer'), (_tx, meta) => {
      // Node 1 is the page that gains the NFT: it becomes a page of the NFT's issuer.
      const page = body(meta, 1);
      const issuer = Buffer.from(decodeAccountID(NFTS.soldBySellOffer.issuer)).toString('hex').toUpperCase();
      page.LedgerIndex = `${issuer}${page.LedgerIndex.slice(40)}`;
    }),
  'synthetic-lower-case-id': async () =>
    replaced(await recorded('mint_with_offer'), NFTS.mintWithOffer.id, NFTS.mintWithOffer.id.toLowerCase()),
  'synthetic-fractional-drop': async () =>
    variant(await recorded('sale_by_sell_offer'), (_tx, meta) => {
      body(meta, 6).FinalFields.Amount = '10000011';
    }),
  'synthetic-issued-exponent-form': async () =>
    variant(await recorded('sale_issued_currency'), (_tx, meta) => {
      body(meta, 2).FinalFields.Amount.value = '1e-7';
    }),
  'synthetic-issued-royalty': async () => {
    // The fee 49999 (0xC34F) in the id; the seller's page is another account's (the offer's owner follows), so the issuer
    // rRama… is neither party.
    const t = replaced(
      await recorded('sale_issued_currency'),
      NFTS.soldForIssued.id,
      `0008C34F${NFTS.soldForIssued.id.slice(8)}`,
    );
    return variant(t, (_tx, meta) => {
      const seller = 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec';
      const page = body(meta, 0);
      page.LedgerIndex = `40FEFE9E7C73D4F8A4DC7A7A09DD13B724827F94${page.LedgerIndex.slice(40)}`;
      body(meta, 2).FinalFields.Owner = seller;
      body(meta, 2).FinalFields.Amount.value = '9999999999999999';
    });
  },
  'synthetic-brokered-issued': async () => {
    const t = replaced(
      await recorded('brokered_sale_royalty'),
      NFTS.brokered.id,
      `0019C34F${NFTS.brokered.id.slice(8)}`,
    );
    return variant(t, (tx, meta) => {
      body(meta, 0).FinalFields.Amount = { ...USD, value: '9000000000000000' };
      body(meta, 1).FinalFields.Amount = { ...USD, value: '9999999999999999' };
      tx.NFTokenBrokerFee = { ...USD, value: '1000000' };
    });
  },
};

/** The synthetic transactions, each with its name as its hash, so that none passes for the recorded one it came from. */
const synthetic: Record<string, () => Promise<ParserTx>> = Object.fromEntries(
  Object.entries(builders).map(([name, build]) => [
    name,
    async () => deepFreeze({ ...(await build()), hash: name.toUpperCase() }),
  ]),
);

describe('NftParser: synthetic cases', () => {
  it('every one is named synthetic-…', () => {
    for (const name of Object.keys(synthetic)) expect(name).toMatch(/^synthetic-/);
  });

  it('synthetic-offer-removed-other: an offer deleted by an AccountDelete is removed_by other, of its owner', async () => {
    expect(parse(await synthetic['synthetic-offer-removed-other']())).toEqual({
      events: [
        ev(NFTS.cancelled, 0, 'offer_removed', {
          account: 'rf7Db55CXcWgqmHnb1Pjx1WVGNCqMNsyZ',
          offer_id: 'C094C217BD0396C55630195FA2C8677CF0D3961C8950BC50D827C036B532A9CF',
          is_sell_offer: 0,
          amount: '146.25',
          currency: 'XRP',
          destination: BROKER,
          expiration: 1793496181,
          removed_by: 'other',
        }),
      ],
      skipped: 0,
    });
  });

  it('synthetic-cancel-by-destination: the offer_cancel is the offer owner’s, not the sender’s', async () => {
    const [cancel] = eventsOf(await synthetic['synthetic-cancel-by-destination']());
    expect(cancel.event).toBe('offer_cancel');
    expect(cancel.account).toBe('rf7Db55CXcWgqmHnb1Pjx1WVGNCqMNsyZ');
  });

  it('an NFT that only moves to another page of its owner is no event', async () => {
    // synthetic-page-merge: hand-made, not recorded (see the header).
    const t = await synthetic['synthetic-page-merge']();
    const merged = last(t.meta.AffectedNodes as Json[]).DeletedNode.FinalFields.NFTokens as Json[];
    expect(merged).toHaveLength(11);
    // The recorded burn's one event, and nothing for the 11 tokens that changed page.
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.burn, 0, 'burn', {
          account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          from_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
        }),
      ],
      skipped: 0,
    });
  });

  it('a page whose only change is a link has no previous tokens, and its tokens are not minted (synthetic-link-only-page)', async () => {
    const t = await synthetic['synthetic-link-only-page']();
    const page = last(t.meta.AffectedNodes as Json[]);
    expect(Object.keys(page.ModifiedNode.PreviousFields)).toEqual(['NextPageMin']);
    expect(page.ModifiedNode.FinalFields.NFTokens).toHaveLength(3);
    // The link-only page gives no event: what is left is the cancel of the recorded `offer_cancel`.
    expect(parse(t)).toEqual(parse(await recorded('offer_cancel')));
    expect(eventsOf(t).map((e) => e.event)).toEqual(['offer_cancel']);
  });

  it('orders removals first, then mints, burns and modifies by kind and id, then creations (synthetic-mixed-order)', async () => {
    const { events } = parse(await synthetic['synthetic-mixed-order']());
    const minted = NFTS.mint.id.slice(0, -1);
    expect(events.map((e) => [e.event_index, e.event, e.nft_id, e.removed_by])).toEqual([
      [0, 'offer_removed', NFTS.cancelled.id, 'other'],
      [1, 'mint', `${minted}9`, ''],
      [2, 'mint', `${minted}A`, ''],
      [3, 'mint', `${minted}B`, ''],
      [4, 'burn', expect.stringMatching(/^[0-9A-F]{64}$/), ''],
      [5, 'modify', expect.stringMatching(/^[0-9A-F]{64}$/), ''],
      [6, 'offer_create', NFTS.sellOffer.id, ''],
    ]);
    // The burned token is not the modified one, and the modify carries the new URI.
    expect(events[4].nft_id).not.toBe(events[5].nft_id);
    expect(events[5].uri).toBe('697066733A2F2F4E4557');
  });

  it('a transaction that failed gives no event', async () => {
    // synthetic-failed-mint and synthetic-failed-accept: recorded transactions given a tec result.
    for (const name of ['synthetic-failed-mint', 'synthetic-failed-accept']) {
      const t = await synthetic[name]();
      expect(t.meta.TransactionResult).toMatch(/^tec/);
      expect(parse(t)).toEqual({ events: [], skipped: 0 });
    }
  });

  it('an MPT amount skips the event and counts it', async () => {
    // synthetic-mpt-offer, synthetic-mpt-mint-offer and synthetic-mpt-accept: hand-made (no MPT-priced NFT offer exists).
    // An offer priced in an MPT: no event, one skipped.
    expect(parse(await synthetic['synthetic-mpt-offer']())).toEqual({ events: [], skipped: 1 });
    // A mint with an MPT-priced offer: the mint stays, its offer is skipped.
    const mint = parse(await synthetic['synthetic-mpt-mint-offer']());
    expect(mint.events.map((e) => e.event)).toEqual(['mint']);
    expect(mint.skipped).toBe(1);
    // An accepted offer priced in an MPT: the offer's removal and the sale are each skipped.
    expect(parse(await synthetic['synthetic-mpt-accept']())).toEqual({ events: [], skipped: 2 });
  });

  it('a token removed from a page that is then merged forward and deleted is burned (synthetic-page-merge-forward)', async () => {
    const t = await synthetic['synthetic-page-merge-forward']();
    const deleted = body(t.meta as Json, 0);
    expect(Object.keys(t.meta.AffectedNodes[0])).toEqual(['DeletedNode']);
    expect(deleted.FinalFields.NFTokens).toHaveLength(22);
    expect(deleted.PreviousFields.NFTokens).toHaveLength(23);
    // One burn, of the token the deleted page's FinalFields lack; the 22 that moved to the next page give nothing.
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.burn, 0, 'burn', {
          account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          from_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
        }),
      ],
      skipped: 0,
    });
  });

  it('a sold token removed from a page that is then merged forward is the sale, not a mint (synthetic-sale-merge-forward)', async () => {
    const t = await synthetic['synthetic-sale-merge-forward']();
    expect(Object.keys(t.meta.AffectedNodes[0])).toEqual(['DeletedNode']);
    const { events } = parse(t);
    expect(events.map((e) => e.event)).toEqual(['offer_removed', 'sale']);
    // The events of the recorded sale, whose seller's page was a ModifiedNode.
    expect(parse(t)).toEqual(parse(await recorded('sale_by_sell_offer')));
  });

  it('a sale of an NFT without a transfer fee has no royalty, not a zero one (synthetic-no-transfer-fee)', async () => {
    const sale = eventsOf(await synthetic['synthetic-no-transfer-fee']()).find((e) => e.event === 'sale');
    expect(sale).toMatchObject({
      from_account: 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz',
      to_account: 'rnKd8CYrXwMoGn4R48onJGLShh1PcrFrTx',
      issuer: 'r4PP7gwuVfxzLPWFiJXjLUtvzA7F97CzT3',
      transfer_fee: 0,
      amount: '10',
      royalty_est: '',
    });
  });

  it('numbers cancelled and created offers in the order of AffectedNodes, not by offer id or NFT id (synthetic-offers-in-node-order)', async () => {
    const t = await synthetic['synthetic-offers-in-node-order']();
    const { events } = parse(t);
    expect(events.map((e) => [e.event_index, e.event, e.offer_id, e.nft_id])).toEqual([
      [0, 'offer_cancel', 'C094C217BD0396C55630195FA2C8677CF0D3961C8950BC50D827C036B532A9CF', NFTS.cancelled.id],
      [1, 'offer_cancel', `${'0'.repeat(63)}1`, NFTS.sellOffer.id],
      [2, 'offer_create', 'F'.repeat(64), NFTS.cancelled.id],
      [3, 'offer_create', 'D6697EB570D95FBE80C369A2CCD9CF21CE04258B04829638313820058FE8CAEE', NFTS.sellOffer.id],
    ]);
  });

  it('a page deleted with its last token is the token’s burn, not a move (synthetic-burn-last-token)', async () => {
    const t = await synthetic['synthetic-burn-last-token']();
    expect(body(t.meta as Json, 0)).toMatchObject({ LedgerEntryType: 'NFTokenPage' });
    expect(parse(t)).toEqual({
      events: [
        ev(NFTS.burn, 0, 'burn', {
          account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
          from_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
        }),
      ],
      skipped: 0,
    });
  });

  it('pays no royalty when the issuer is the buyer (synthetic-issuer-buys)', async () => {
    const sale = eventsOf(await synthetic['synthetic-issuer-buys']()).find((e) => e.event === 'sale');
    expect(sale).toMatchObject({
      from_account: 'rhv9jFwfWfH4Cd1uX4b3ACkdgDKASFz7Dz',
      to_account: 'r4PP7gwuVfxzLPWFiJXjLUtvzA7F97CzT3',
      issuer: 'r4PP7gwuVfxzLPWFiJXjLUtvzA7F97CzT3',
      transfer_fee: 5000,
      royalty_est: '',
    });
  });

  it('rounds the royalty of a native price down to a whole drop (synthetic-fractional-drop)', async () => {
    // 10000011 drops x 5000 / 100000 = 500000.55 drops: 500000 drops, not 500001.
    const sale = eventsOf(await synthetic['synthetic-fractional-drop']()).find((e) => e.event === 'sale');
    expect(sale).toMatchObject({ amount: '10.000011', currency: 'XRP', royalty_est: '0.5' });
  });

  it('writes an issued amount in plain decimal text, never with an exponent (synthetic-issued-exponent-form)', async () => {
    const events = eventsOf(await synthetic['synthetic-issued-exponent-form']());
    expect(events.map((e) => [e.event, e.amount])).toEqual([
      ['offer_removed', '0.0000001'],
      ['sale', '0.0000001'],
    ]);
  });

  it('takes the royalty of an issued price down to 16 significant digits (synthetic-issued-royalty)', async () => {
    // 9999999999999999 x 49999 / 100000 = 4999899999999999.50001: 16 digits, rounded down, not up.
    const sale = eventsOf(await synthetic['synthetic-issued-royalty']()).find((e) => e.event === 'sale');
    expect(sale).toMatchObject({
      from_account: 'ravC5cZreMZuKEWSrpra5nkWnfzPmrabec',
      to_account: 'rLTavNLNKhA1kf8KMfW5U4Q1TNGSUNdint',
      issuer: 'rRamaNFTdhr1q7gjsDK1Q4baffxHUQfQ9',
      transfer_fee: 49999,
      amount: '9999999999999999',
      currency: XRPLAY.currency,
      amount_issuer: XRPLAY.issuer,
      royalty_est: '4999899999999999',
    });
  });

  it('takes the broker’s cut off an issued price before the royalty (synthetic-brokered-issued)', async () => {
    // (9999999999999999 - 1000000) x 49999 / 100000 = 4999899999500009.50001, rounded down to 16 digits.
    const sale = eventsOf(await synthetic['synthetic-brokered-issued']()).find((e) => e.event === 'sale');
    expect(sale).toMatchObject({
      account: BROKER,
      broker: BROKER,
      amount: '9999999999999999',
      currency: USD.currency,
      amount_issuer: USD.issuer,
      broker_fee: '1000000',
      royalty_est: '4999899999500009',
    });
  });
});

describe('NftParser: rules over all cases', () => {
  const recordedNames = Object.keys(manifest.cases);

  /** Every recorded case and every synthetic one, loaded fresh and deep-frozen. */
  async function everyCase(): Promise<[string, ParserTx][]> {
    return [
      ...(await Promise.all(
        recordedNames.map(async (name): Promise<[string, ParserTx]> => [name, await recorded(name)]),
      )),
      ...(await Promise.all(
        Object.entries(synthetic).map(async ([name, build]): Promise<[string, ParserTx]> => [name, await build()]),
      )),
    ];
  }

  it('never writes to its input', async () => {
    for (const [name, t] of await everyCase()) {
      const snapshot = structuredClone(t);
      expect(Object.isFrozen(t.meta)).toBe(true);
      expect(() => parse(t)).not.toThrow();
      expect({ name, t }).toEqual({ name, t: snapshot });
    }
  });

  it('numbers the events of a transaction from 0, each once', async () => {
    let checked = 0;
    for (const [, t] of await everyCase()) {
      const { events } = parse(t);
      expect(events.map((e) => e.event_index)).toEqual(events.map((_, i) => i));
      checked += events.length;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('writes an id as 64 upper-case hex digits, whatever case the ledger had it in (synthetic-lower-case-id)', async () => {
    const t = await synthetic['synthetic-lower-case-id']();
    expect(JSON.stringify(t.meta)).toContain(NFTS.mintWithOffer.id.toLowerCase());
    // The id of the page's token and the id of the offer's NFT.
    expect(eventsOf(t).map((e) => [e.event, e.nft_id])).toEqual([
      ['mint', NFTS.mintWithOffer.id],
      ['offer_create', NFTS.mintWithOffer.id],
    ]);
  });

  it('writes every id as 64 upper-case hex digits and every event name as one of the eight', async () => {
    for (const [, t] of await everyCase()) {
      for (const e of eventsOf(t)) {
        expect(e.nft_id).toMatch(/^[0-9A-F]{64}$/);
        expect(NFT_EVENTS).toContain(e.event);
        expect(e.kind).toBe('nftoken');
        expect(e.taxon_key).toBe(e.taxon);
      }
    }
  });

  it('gives each NFToken transaction of the recorded ledgers its events, and every other transaction none', async () => {
    const counts: Record<string, number> = {};
    for (const ledger of source.list()) {
      for (const raw of ledger.transactions) {
        const t = deepFreeze(toParserTx(raw, ledger.header, null));
        const type = t.tx.TransactionType as string;
        const { events, skipped } = parse(t);
        const names = events.map((e) => e.event);
        const of = (name: string) => events.filter((e) => e.event === name);
        expect(skipped).toBe(0);
        counts[type] = (counts[type] ?? 0) + 1;
        if (t.meta.TransactionResult !== 'tesSUCCESS' || !type.startsWith('NFToken')) {
          expect(names).toEqual([]);
        } else if (type === 'NFTokenMint') {
          expect(names.filter((n) => n !== 'offer_create')).toEqual(['mint']);
          expect(of('offer_create')).toHaveLength(t.tx.Amount === undefined ? 0 : 1);
          expect(names[0]).toBe('mint');
        } else if (type === 'NFTokenBurn') {
          expect(of('burn').map((e) => e.nft_id)).toEqual([t.tx.NFTokenID]);
          expect(of('offer_removed').every((e) => e.removed_by === 'burn')).toBe(true);
          expect(last(names)).toBe('burn');
        } else if (type === 'NFTokenModify') {
          expect(of('modify').map((e) => e.nft_id)).toEqual([t.tx.NFTokenID]);
          expect(events).toHaveLength(1);
        } else if (type === 'NFTokenAcceptOffer') {
          const moved = events.filter((e) => e.event === 'sale' || e.event === 'transfer');
          expect(moved).toHaveLength(1);
          expect(names.filter((n) => n !== 'offer_removed')).toHaveLength(1);
          expect(last(names)).toBe(moved[0].event);
          expect(of('offer_removed').every((e) => e.removed_by === 'sale')).toBe(true);
          expect(of('offer_removed')).toHaveLength(t.tx.NFTokenSellOffer && t.tx.NFTokenBuyOffer ? 2 : 1);
        } else if (type === 'NFTokenCreateOffer') {
          expect(names).toEqual(['offer_create']);
          expect(events[0].is_sell_offer).toBe((t.tx.Flags & 1) === 1 ? 1 : 0);
          expect(events[0].account).toBe(t.tx.Account);
          expect(events[0].nft_id).toBe(t.tx.NFTokenID);
        } else if (type === 'NFTokenCancelOffer') {
          expect(names.every((n) => n === 'offer_cancel')).toBe(true);
          expect(events.every((e) => (t.tx.NFTokenOffers as string[]).includes(e.offer_id))).toBe(true);
          expect(events.length).toBeGreaterThan(0);
        }
      }
    }
    // The recorded ledgers' successful NFToken transactions (FINDINGS 1: 12 mints, 2 burns) are all of them seen.
    expect(counts).toMatchObject({
      NFTokenMint: 12,
      NFTokenBurn: 2,
      NFTokenModify: 1,
      NFTokenAcceptOffer: 5,
      NFTokenCreateOffer: 121,
      NFTokenCancelOffer: 8,
    });
  });
});

describe('rolesOf', () => {
  const entries = (e: ParsedNftEvent) => [...rolesOf(e)];

  it('has the seven roles of spec 2.6 in this order', () => {
    expect(NFT_ROLES).toEqual(['issuer', 'minter', 'from', 'to', 'broker', 'offer_owner', 'destination']);
  });

  it('rolesOf a brokered sale: issuer, from, to, broker; of an offer: offer_owner and destination', async () => {
    const sale = eventsOf(await recorded('brokered_sale_royalty')).find((e) => e.event === 'sale') as ParsedNftEvent;
    expect(entries(sale)).toEqual([
      ['rLxc1bt5defiLJ9gaZEJqQWnNKYNawrwMy', ['issuer']],
      ['rfivr3BK17R28wnVwpQQhSDvo2A2fmnEje', ['from']],
      ['rLCscV9iDJpvje4ZCKxGjYAMNtBA1Ltauk', ['to']],
      [BROKER, ['broker']],
    ]);
    const [offer] = eventsOf(await recorded('sell_offer_create'));
    expect(entries(offer)).toEqual([
      ['rHhvUexKKSJZG9vuZKX2kNendG2TXoavG9', ['offer_owner']],
      [BROKER, ['destination']],
    ]);
  });

  it('a removed and a cancelled offer have the roles of a created one, and no issuer', async () => {
    const [removed] = eventsOf(await recorded('burn_removes_offers'));
    expect(entries(removed)).toEqual([
      ['rKxWWCEDrwTWn9A8QxgKDW4VhwuCcd8W7f', ['offer_owner']],
      [BROKER, ['destination']],
    ]);
    const [cancel] = eventsOf(await recorded('offer_cancel'));
    expect(entries(cancel)).toEqual([
      ['rf7Db55CXcWgqmHnb1Pjx1WVGNCqMNsyZ', ['offer_owner']],
      [BROKER, ['destination']],
    ]);
  });

  it('an offer without a destination has only its owner', async () => {
    const [removed] = eventsOf(await recorded('sale_by_buy_offer'));
    expect(entries(removed)).toEqual([['r47kUrvGHkHgxLi1KedaHzdUvbR9GTreEe', ['offer_owner']]]);
  });

  it('an account with two roles is one entry, in the order of the roles', async () => {
    // A mint of one’s own NFT: the account is the issuer and the new owner.
    const [mint] = eventsOf(await recorded('mint'));
    expect(entries(mint)).toEqual([['ravC5cZreMZuKEWSrpra5nkWnfzPmrabec', ['issuer', 'to']]]);
    // A burn by the issuer of its own NFT.
    const [burn] = eventsOf(await recorded('burn'));
    expect(entries(burn)).toEqual([['ravC5cZreMZuKEWSrpra5nkWnfzPmrabec', ['issuer', 'from']]]);
    // The minter who is also the owner.
    const [onBehalf] = eventsOf(await recorded('mint_on_behalf'));
    const minter = rolesOf(onBehalf).get('riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN') as NftRole[];
    expect(minter).toEqual(['minter', 'to']);
  });

  it('a transfer has only from and to, and a modify nobody', async () => {
    const transfer = eventsOf(await recorded('transfer_zero_amount')).find(
      (e) => e.event === 'transfer',
    ) as ParsedNftEvent;
    expect(entries(transfer)).toEqual([
      ['riMCiWg8QBej6Y3osDVt3u8FJWo2ephuN', ['from']],
      ['r4Xgqy68ykjLEJAkFQ7EaFs8VEdSiWkSeX', ['to']],
    ]);
    const [modify] = eventsOf(await recorded('modify'));
    expect(entries(modify)).toEqual([]);
  });

  it('a sale by the issuer has the issuer as issuer and from', async () => {
    const sale = eventsOf(await recorded('sale_by_buy_offer')).find((e) => e.event === 'sale') as ParsedNftEvent;
    expect(entries(sale)).toEqual([
      ['rDeizxSRo6JHjKnih9ivpPkyD2EgXQvhSB', ['issuer', 'from']],
      ['r47kUrvGHkHgxLi1KedaHzdUvbR9GTreEe', ['to']],
    ]);
  });
});

describe('NftParser: the event names', () => {
  it('are the eight of nft_events, in the order of their Enum8', () => {
    expect(NFT_EVENTS).toEqual([
      'mint',
      'burn',
      'modify',
      'offer_create',
      'offer_cancel',
      'offer_removed',
      'sale',
      'transfer',
    ]);
  });
});

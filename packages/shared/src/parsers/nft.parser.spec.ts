/**
 * NftParser over the recorded mainnet NFT cases (`test/fixtures/xrpl/nft`, README section "XRPL NFT cases"), the recorded
 * Xahau URIToken cases (`test/fixtures/xahau/uritoken`, README section "Xahau URIToken cases") and the synthetic cases
 * below. A synthetic transaction is hand-made, never recorded: every one is named `synthetic-…` and is a recorded
 * transaction with a small, named edit of it, or (the first) built from the recorded shapes of its nodes.
 *
 * XRPL:
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
 *
 * Xahau (URITokens):
 *
 * - `synthetic-uritoken-mint-with-offer` (not found on Xahau, FINDINGS "Not found": no recorded `URITokenMint` carries an
 *   `Amount` or a `Destination`): `uritoken_mint` whose transaction carries `Amount` 2.5 XAH and a `Destination`, and
 *   whose created entry has both.
 * - `synthetic-uritoken-free-mint-with-offer`: the same at an `Amount` of "0", which the created entry leaves out (a native
 *   zero is not stored, as on XRPL), so the offer's amount is the transaction's.
 * - `synthetic-uritoken-mpt-mint-offer`: the same with an MPT `Amount` on the transaction and the entry.
 * - `synthetic-uritoken-buy-above-ask`: `uritoken_buy_above_ask` whose transaction `Amount` is raised to 4300 XAH, above the
 *   ask of 4200 XAH that the entry's `PreviousFields` hold (no buy above an ask was found, FINDINGS 2).
 * - `synthetic-uritoken-setremarks-with-offer`: the recorded `SetRemarks` of a URIToken that has no offer, with an `Amount`
 *   (an offer that stands) added to the entry's `FinalFields`, none to its `PreviousFields`.
 * - `synthetic-uritoken-cancel-with-destination`: `uritoken_sell_offer_cancel` whose entry also lost a `Destination`
 *   (listed in its `PreviousFields`, as the cleared `Amount` is).
 * - `synthetic-uritoken-relist`: `uritoken_sell_offer_create` over a standing offer: `PreviousFields` hold the old `Amount`
 *   (1800 XAH) and the entry has a `Destination`.
 * - `synthetic-uritoken-remit-two-tokens`: `remit_transfer` of a second URIToken, whose id sorts before the first and
 *   whose node comes after it (the order of the removals is the node order, the transfers' is the id order).
 * - `synthetic-uritoken-remit-no-offer`: `remit_transfer` of a token that had no sell offer (no `Amount` in `PreviousFields`).
 * - `synthetic-uritoken-mpt-offer`, `synthetic-uritoken-mpt-buy`: a sell offer, and a buy of one, priced with an MPT amount.
 * - `synthetic-uritoken-failed-mint`: `uritoken_mint` with a `tec` result and every node kept.
 * - `synthetic-uritoken-lower-case-id`: `uritoken_mint` with the entry's key written in lower case.
 */
import { BigNumber } from 'bignumber.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decodeAccountID } from 'ripple-address-codec';
import { nftOracle, nftOracleRoles } from '../../test/nft-oracle';
import { FixtureLedgerSource } from '../ingest/fixture-ledger-source';
import { getNetworkProfile } from '../network';
import { deepFreeze } from '../test-utils/deep-freeze';
import { dropsToNative } from '../util/amount';
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

const XAHAU_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'xahau', 'uritoken');
const xahauManifest = JSON.parse(readFileSync(join(XAHAU_DIR, 'manifest.json'), 'utf8')) as {
  cases: Record<string, { ledger: number; hash: string; burn?: { ledger: number; hash: string } }>;
};
const xahauSource = FixtureLedgerSource.fromDir(XAHAU_DIR);
const XAHAU: ParseContext = parseContextFor(getNetworkProfile('xahau'));
const parseXahau = (t: ParserTx): ParsedNft => parser.parse(t, XAHAU);

/** The transaction `hash` of ledger `ledger` in `from`, deep-frozen. */
async function transactionIn(
  from: FixtureLedgerSource,
  label: string,
  ledger: number,
  hash: string,
): Promise<ParserTx> {
  const l = await from.fetch(ledger);
  const raw = l.transactions.find((t) => t.hash === hash);
  if (!raw) throw new Error(`${label}: ${hash} is not in ledger ${ledger}`);
  return deepFreeze(toParserTx(raw, l.header, null));
}

/** A recorded case by its manifest name, deep-frozen. */
async function recorded(name: string): Promise<ParserTx> {
  const c = manifest.cases[name];
  if (!c) throw new Error(`no recorded case ${name}`);
  return transactionIn(source, name, c.ledger, c.hash);
}

/** A recorded Xahau URIToken case by its manifest name, deep-frozen. */
async function recordedUri(name: string): Promise<ParserTx> {
  const c = xahauManifest.cases[name];
  if (!c) throw new Error(`no recorded Xahau case ${name}`);
  return transactionIn(xahauSource, name, c.ledger, c.hash);
}

/** The recorded `SetRemarks` of the ledger of `remit_mint` (it touches that Remit's URIToken), deep-frozen. */
async function recordedSetRemarks(): Promise<ParserTx> {
  const ledger = await xahauSource.fetch(xahauManifest.cases.remit_mint.ledger);
  const raw = ledger.transactions.find((t) => t.tx.TransactionType === 'SetRemarks');
  if (!raw) throw new Error('no SetRemarks in the ledger of remit_mint');
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

/** Each synthetic transaction with its name as its hash, so that none passes for the recorded one it came from. */
const named = (made: Record<string, () => Promise<ParserTx>>): Record<string, () => Promise<ParserTx>> =>
  Object.fromEntries(
    Object.entries(made).map(([name, build]) => [
      name,
      async () => deepFreeze({ ...(await build()), hash: name.toUpperCase() }),
    ]),
  );

/** The synthetic transactions of XRPL. */
const synthetic = named(builders);

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

// ---------------------------------------------------------------------------------------------------------------------
// URITokens (Xahau)
// ---------------------------------------------------------------------------------------------------------------------

/** What a URIToken's columns are, written down from the recorded transactions, not from the parser. */
interface KnownUri {
  id: string;
  issuer: string;
  flags: number;
  digest: string;
}

const RODIN = 'rodinGM9xiKq7rDDnLPyieREkqGJ6zKyb';
const SELLER = 'r9gvUQxtV98nRAM26aknj4h6RXKyXCLMVS';
const EVR = { currency: 'EVR', issuer: 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8' };
const MPT_AMOUNT = { mpt_issuance_id: '0000012FFD9EE5DA93AC614B4DB94D7E0FCE415CA51BED47', value: '100' };

const URI_TOKENS = {
  minted: {
    id: 'E87FD7E7FDACFA2CE1DC37AD805A7295F84459D4911EAC79160F0D9E34BB6520',
    issuer: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
    flags: 1,
    digest: '',
  },
  listed: {
    id: '35B8D52858E0463C0F0FCCC73EFBE1D308F0AF71112035C4D45777EB9115E93D',
    issuer: RODIN,
    flags: 0,
    digest: 'A2C481BA71113364B53DA2C523047F18E97CEBD68D6E487D6F3801AB46075307',
  },
  cancelled: {
    id: '335AD14EDA481A2B0BB89F792EF6D137A48010DF29D4F90B8BD9B18DF6994FC8',
    issuer: RODIN,
    flags: 0,
    digest: '696795A3F27CBB294F55C43BDBB2DC43B02E386E5325DED66A6EEE8E7D29CBDD',
  },
  bought: {
    id: '9613336614047483F3AEC00173139D88FE9BA70720CAC2B46E12711A71A9AAE9',
    issuer: RODIN,
    flags: 0,
    digest: '772B38763E8E603AEE9BBB2026B8E9B97537ECC8867E46D042630C0B326B8736',
  },
  boughtForEvr: {
    id: '494E26BE7766A7DB12912C51055C0106DA39401BF2E60E86611FD00E48CDE99F',
    issuer: 'rNk6oeGA4BKsCraCEMg2g5YkbegcXFtPGV',
    flags: 1,
    digest: '',
  },
  burned: {
    id: 'F636CA189EF358200F80EE78744EB5876224B2F0A8F3DC97BC36A325DA4D3C46',
    issuer: 'r4gUH2cjAfXGFTBUXBnspYWpj4nprzgQgH',
    flags: 1,
    digest: '',
  },
  burnedByIssuer: {
    id: 'AB9EB74AAAF6437F3E368A312E3432D8D7BF548A997D1378186FB371178E40DF',
    issuer: 'rKXEKqg6V3rtiZZiJ97zHkm9Due5xrtRhW',
    flags: 1,
    digest: '',
  },
  remitted: {
    id: 'D615854CB2571F4F2EB1F0B23944996187519BCC5CA4CB700C692917A76200A9',
    issuer: RODIN,
    flags: 0,
    digest: '41544176331C26CE3F6BCCED2AD05EF61FCCC89D35A150DAB6E16648DFE882A3',
  },
  remitMinted: {
    id: '099E410166351A8C94AE6D76154CBF301C609282EAE659C1BF08AF46936867BF',
    issuer: RODIN,
    flags: 0,
    digest: 'DEFF6B5B0509266F4730849715FD58A84FA258C08A93E5C3D6E060710FD1BE44',
  },
  reminted: {
    id: 'E5ECD96D609E8E7C29C967D3D2FA542AE58FC9A05B9C4EAE7BFF608A7D0306A2',
    issuer: 'r4k1jdyThSDbPwbNrpiuqNCoRJ61y9N4Wj',
    flags: 1,
    digest: '',
  },
} satisfies Record<string, KnownUri>;

/** A URIToken event with every column at its absent value, the token's columns and `fields` on top. */
function uev(
  token: KnownUri,
  event_index: number,
  event: NftEventName,
  fields: Partial<ParsedNftEvent>,
): ParsedNftEvent {
  return {
    nft_id: token.id,
    event_index,
    kind: 'uritoken',
    event,
    issuer: token.issuer,
    taxon: null,
    taxon_key: 0,
    serial: 0,
    nft_flags: token.flags,
    transfer_fee: 0,
    uri: '',
    digest: token.digest,
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

/** The events of a Xahau transaction. */
const xahauEventsOf = (t: ParserTx): ParsedNftEvent[] => parseXahau(t).events;

/** The body of the `n`th `URIToken` node of the metadata. */
function uriBody(meta: Json, n = 0): Json {
  const bodies = (meta.AffectedNodes as Json[]).map((wrapper) => wrapper[Object.keys(wrapper)[0]]);
  return bodies.filter((b) => b.LedgerEntryType === 'URIToken')[n];
}

/** What a recorded amount is as event text: drops of XAH in whole units, or an issued amount's value. */
const amountText = (amount: unknown): string =>
  typeof amount === 'string' ? dropsToNative(amount) : new BigNumber((amount as Json).value).toFixed();

describe('NftParser: recorded Xahau URIToken cases', () => {
  it('uritoken_mint: one mint, by the issuer to itself, with the URI and the entry’s flags', async () => {
    const t = await recordedUri('uritoken_mint');
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.minted, 0, 'mint', {
          account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          to_account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          uri: t.tx.URI,
        }),
      ],
      skipped: 0,
    });
  });

  it('uritoken_sell_offer_create: an offer_create of the owner at the transaction’s price, naming the URIToken', async () => {
    expect(parseXahau(await recordedUri('uritoken_sell_offer_create'))).toEqual({
      events: [
        uev(URI_TOKENS.listed, 0, 'offer_create', {
          account: SELLER,
          offer_id: URI_TOKENS.listed.id,
          is_sell_offer: 1,
          amount: '2200',
          currency: 'XAH',
        }),
      ],
      skipped: 0,
    });
  });

  it('uritoken_sell_offer_cancel: an offer_cancel of the owner, at the amount the entry lost', async () => {
    expect(parseXahau(await recordedUri('uritoken_sell_offer_cancel'))).toEqual({
      events: [
        uev(URI_TOKENS.cancelled, 0, 'offer_cancel', {
          account: SELLER,
          offer_id: URI_TOKENS.cancelled.id,
          is_sell_offer: 1,
          amount: '1800',
          currency: 'XAH',
        }),
      ],
      skipped: 0,
    });
  });

  it('uritoken_buy_above_ask: the offer removed by the sale, then the sale at the transaction’s Amount, which the seller received', async () => {
    const t = await recordedUri('uritoken_buy_above_ask');
    const { events, skipped } = parseXahau(t);
    expect({ events, skipped }).toEqual({
      events: [
        uev(URI_TOKENS.bought, 0, 'offer_removed', {
          account: SELLER,
          offer_id: URI_TOKENS.bought.id,
          is_sell_offer: 1,
          amount: '4200',
          currency: 'XAH',
          removed_by: 'sale',
        }),
        uev(URI_TOKENS.bought, 1, 'sale', {
          account: 'rBkEp8W1yhBGLrvHFKKyrmSvniMFVJbPPg',
          from_account: SELLER,
          to_account: 'rBkEp8W1yhBGLrvHFKKyrmSvniMFVJbPPg',
          offer_id: URI_TOKENS.bought.id,
          is_sell_offer: 1,
          amount: '4200',
          currency: 'XAH',
        }),
      ],
      skipped: 0,
    });
    // FINDINGS 2: the price is the transaction's Amount, and it is what the seller's balance rose by.
    expect(events[1].amount).toBe(amountText(t.tx.Amount));
    const seller = (t.meta.AffectedNodes as Json[])
      .map((wrapper) => wrapper[Object.keys(wrapper)[0]])
      .find((b) => b.LedgerEntryType === 'AccountRoot' && b.FinalFields.Account === SELLER);
    const gained = new BigNumber(seller.FinalFields.Balance).minus(seller.PreviousFields.Balance);
    expect(events[1].amount).toBe(dropsToNative(gained.toFixed()));
  });

  it('uritoken_burn_with_offer: the standing offer removed by the burn, in its own currency, then the burn', async () => {
    expect(parseXahau(await recordedUri('uritoken_burn_with_offer'))).toEqual({
      events: [
        uev(URI_TOKENS.burned, 0, 'offer_removed', {
          account: 'r4gUH2cjAfXGFTBUXBnspYWpj4nprzgQgH',
          offer_id: URI_TOKENS.burned.id,
          is_sell_offer: 1,
          amount: '0.0001',
          currency: EVR.currency,
          amount_issuer: EVR.issuer,
          removed_by: 'burn',
        }),
        uev(URI_TOKENS.burned, 1, 'burn', {
          account: 'r4gUH2cjAfXGFTBUXBnspYWpj4nprzgQgH',
          from_account: 'r4gUH2cjAfXGFTBUXBnspYWpj4nprzgQgH',
        }),
      ],
      skipped: 0,
    });
  });

  it('remit_transfer: a transfer per id of URITokenIDs, and the offer the Remit cleared removed by transfer first', async () => {
    const t = await recordedUri('remit_transfer');
    const { events, skipped } = parseXahau(t);
    expect({ events, skipped }).toEqual({
      events: [
        uev(URI_TOKENS.remitted, 0, 'offer_removed', {
          account: SELLER,
          offer_id: URI_TOKENS.remitted.id,
          is_sell_offer: 1,
          amount: '3350',
          currency: 'XAH',
          removed_by: 'transfer',
        }),
        uev(URI_TOKENS.remitted, 1, 'transfer', {
          account: SELLER,
          from_account: SELLER,
          to_account: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
        }),
      ],
      skipped: 0,
    });
    expect(events.filter((e) => e.event === 'transfer').map((e) => e.nft_id)).toEqual(t.tx.URITokenIDs);
    // A Remit's Destination is the new owner, and its payments (Amounts) are not the price of anything.
    expect(t.tx.Destination).toBe(events[1].to_account);
    expect(events.some((e) => e.event === 'sale')).toBe(false);
  });

  it('remit_mint: the Remit’s MintURIToken is a mint for the destination, by the sender who issues it', async () => {
    const t = await recordedUri('remit_mint');
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.remitMinted, 0, 'mint', {
          account: RODIN,
          to_account: SELLER,
          uri: t.tx.MintURIToken.URI,
        }),
      ],
      skipped: 0,
    });
  });

  it('a burn and a re-mint of the same id are two lives of one URIToken', async () => {
    const mint = await recordedUri('uritoken_remint');
    const link = xahauManifest.cases.uritoken_remint.burn;
    if (!link) throw new Error('uritoken_remint has no burn in the manifest');
    const burn = await transactionIn(xahauSource, 'uritoken_remint burn', link.ledger, link.hash);
    const owner = 'r4k1jdyThSDbPwbNrpiuqNCoRJ61y9N4Wj';
    expect(burn.ledger_index).toBeLessThan(mint.ledger_index);
    expect(parseXahau(burn)).toEqual({
      events: [uev(URI_TOKENS.reminted, 0, 'burn', { account: owner, from_account: owner })],
      skipped: 0,
    });
    expect(parseXahau(mint)).toEqual({
      events: [uev(URI_TOKENS.reminted, 0, 'mint', { account: owner, to_account: owner, uri: mint.tx.URI })],
      skipped: 0,
    });
    expect(xahauEventsOf(burn)[0].nft_id).toBe(xahauEventsOf(mint)[0].nft_id);
  });

  it('a buy in an issued currency (Evernode, ledger 26763618, the burn’s of uritoken_remint): the price is that amount, and the seller is the issuer', async () => {
    const t = await transactionIn(
      xahauSource,
      'evernode buy',
      26763618,
      '30B0FE015F9CE2BACE93D95385CD8EA70AD68EB4B6380655C6352FBF1B5897D6',
    );
    const buyer = 'r9fT9gsDG4Zyodz9E2U6RG4Z3e4RD7tBa';
    const priced = { amount: '0.0011', currency: EVR.currency, amount_issuer: EVR.issuer };
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.boughtForEvr, 0, 'offer_removed', {
          account: URI_TOKENS.boughtForEvr.issuer,
          offer_id: URI_TOKENS.boughtForEvr.id,
          is_sell_offer: 1,
          removed_by: 'sale',
          ...priced,
        }),
        uev(URI_TOKENS.boughtForEvr, 1, 'sale', {
          account: buyer,
          from_account: URI_TOKENS.boughtForEvr.issuer,
          to_account: buyer,
          offer_id: URI_TOKENS.boughtForEvr.id,
          is_sell_offer: 1,
          ...priced,
        }),
      ],
      skipped: 0,
    });
  });

  it('a burn by the issuer of a token another account owns: from_account is the owner, account the sender (ledger 26763618)', async () => {
    const t = await transactionIn(
      xahauSource,
      'burn by the issuer',
      26763618,
      '82BF1D1E762335802A0552A13414904B3350FA2CD1404D10A64763BF6B183BBA',
    );
    const { events } = parseXahau(t);
    expect(events).toEqual([
      uev(URI_TOKENS.burnedByIssuer, 0, 'burn', {
        account: 'rKXEKqg6V3rtiZZiJ97zHkm9Due5xrtRhW',
        from_account: 'rLn3CeVysKVcrW1VSaiK5GCwxRm1FDXTN3',
      }),
    ]);
    expect([...rolesOf(events[0])]).toEqual([
      ['rKXEKqg6V3rtiZZiJ97zHkm9Due5xrtRhW', ['issuer']],
      ['rLn3CeVysKVcrW1VSaiK5GCwxRm1FDXTN3', ['from']],
    ]);
  });

  it('a SetRemarks that touches a URIToken changes neither its owner nor its offer, and gives no event (recorded in the ledger of remit_mint)', async () => {
    const t = await recordedSetRemarks();
    // It does touch a URIToken that has an owner and no offer.
    expect(uriBody(t.meta as Json).FinalFields).toMatchObject({ Owner: SELLER });
    expect(uriBody(t.meta as Json).FinalFields.Amount).toBeUndefined();
    expect(parseXahau(t)).toEqual({ events: [], skipped: 0 });
  });
});

/** The builders of the synthetic Xahau transactions of the header, by name. */
const uriBuilders: Record<string, () => Promise<ParserTx>> = {
  'synthetic-uritoken-mint-with-offer': async () =>
    variant(await recordedUri('uritoken_mint'), (tx, meta) => {
      tx.Amount = '2500000';
      tx.Destination = 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp';
      Object.assign(uriBody(meta).NewFields, { Amount: '2500000', Destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp' });
    }),
  'synthetic-uritoken-free-mint-with-offer': async () =>
    variant(await recordedUri('uritoken_mint'), (tx, meta) => {
      // The transaction offers the token for nothing; the created entry has the Destination but no Amount.
      tx.Amount = '0';
      tx.Destination = 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp';
      Object.assign(uriBody(meta).NewFields, { Destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp' });
    }),
  'synthetic-uritoken-mpt-mint-offer': async () =>
    variant(await recordedUri('uritoken_mint'), (tx, meta) => {
      tx.Amount = MPT_AMOUNT;
      uriBody(meta).NewFields.Amount = MPT_AMOUNT;
    }),
  'synthetic-uritoken-buy-above-ask': async () =>
    variant(await recordedUri('uritoken_buy_above_ask'), (tx) => {
      // The buyer pays 4300 XAH for a token asked at 4200 XAH (the entry's PreviousFields.Amount).
      tx.Amount = '4300000000';
    }),
  'synthetic-uritoken-setremarks-with-offer': async () =>
    variant(await recordedSetRemarks(), (_tx, meta) => {
      uriBody(meta).FinalFields.Amount = '2200000000';
    }),
  'synthetic-uritoken-cancel-with-destination': async () =>
    variant(await recordedUri('uritoken_sell_offer_cancel'), (_tx, meta) => {
      uriBody(meta).PreviousFields.Destination = 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp';
    }),
  'synthetic-uritoken-relist': async () =>
    variant(await recordedUri('uritoken_sell_offer_create'), (_tx, meta) => {
      const node = uriBody(meta);
      node.PreviousFields.Amount = '1800000000';
      node.FinalFields.Destination = 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp';
    }),
  'synthetic-uritoken-remit-two-tokens': async () =>
    variant(await recordedUri('remit_transfer'), (tx, meta) => {
      const first = (meta.AffectedNodes as Json[]).find((w) => w.ModifiedNode?.LedgerEntryType === 'URIToken') as Json;
      const second = structuredClone(first);
      // The second token's id sorts before the first's, and its node comes after the first's.
      second.ModifiedNode.LedgerIndex = `${'0'.repeat(63)}1`;
      second.ModifiedNode.PreviousFields.Amount = '1000000';
      meta.AffectedNodes.push(second);
      tx.URITokenIDs.push(second.ModifiedNode.LedgerIndex);
    }),
  'synthetic-uritoken-remit-no-offer': async () =>
    variant(await recordedUri('remit_transfer'), (_tx, meta) => {
      delete uriBody(meta).PreviousFields.Amount;
    }),
  'synthetic-uritoken-mpt-offer': async () =>
    variant(await recordedUri('uritoken_sell_offer_create'), (tx, meta) => {
      tx.Amount = MPT_AMOUNT;
      uriBody(meta).FinalFields.Amount = MPT_AMOUNT;
    }),
  'synthetic-uritoken-mpt-buy': async () =>
    variant(await recordedUri('uritoken_buy_above_ask'), (tx, meta) => {
      tx.Amount = MPT_AMOUNT;
      uriBody(meta).PreviousFields.Amount = MPT_AMOUNT;
    }),
  'synthetic-uritoken-failed-mint': async () =>
    variant(await recordedUri('uritoken_mint'), (_tx, meta) => {
      meta.TransactionResult = 'tecINSUFFICIENT_RESERVE';
    }),
  'synthetic-uritoken-lower-case-id': async () =>
    replaced(await recordedUri('uritoken_mint'), URI_TOKENS.minted.id, URI_TOKENS.minted.id.toLowerCase()),
};

/** The synthetic transactions of Xahau. */
const uriSynthetic = named(uriBuilders);

describe('NftParser: synthetic Xahau URIToken cases', () => {
  it('every one is named synthetic-…', () => {
    expect(Object.keys(uriSynthetic).length).toBeGreaterThan(0);
    for (const name of Object.keys(uriSynthetic)) expect(name).toMatch(/^synthetic-/);
  });

  it('synthetic-uritoken-mint-with-offer: the mint, then its offer with the amount and the destination (none is recorded on Xahau)', async () => {
    const t = await uriSynthetic['synthetic-uritoken-mint-with-offer']();
    expect(t.tx.Amount).toBe('2500000');
    expect(t.hash).toBe('SYNTHETIC-URITOKEN-MINT-WITH-OFFER');
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.minted, 0, 'mint', {
          account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          to_account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          uri: t.tx.URI,
        }),
        uev(URI_TOKENS.minted, 1, 'offer_create', {
          account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          offer_id: URI_TOKENS.minted.id,
          is_sell_offer: 1,
          amount: '2.5',
          currency: 'XAH',
          destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
        }),
      ],
      skipped: 0,
    });
  });

  it('synthetic-uritoken-cancel-with-destination: the cancelled offer keeps the destination the entry lost with its Amount', async () => {
    const [cancel] = xahauEventsOf(await uriSynthetic['synthetic-uritoken-cancel-with-destination']());
    expect(cancel).toEqual(
      uev(URI_TOKENS.cancelled, 0, 'offer_cancel', {
        account: SELLER,
        offer_id: URI_TOKENS.cancelled.id,
        is_sell_offer: 1,
        amount: '1800',
        currency: 'XAH',
        destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
      }),
    );
  });

  it('synthetic-uritoken-relist: an Amount that changed on the same owner is an offer_create at the new amount, with its destination', async () => {
    const t = await uriSynthetic['synthetic-uritoken-relist']();
    expect(uriBody(t.meta as Json).PreviousFields).toEqual({ Amount: '1800000000' });
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.listed, 0, 'offer_create', {
          account: SELLER,
          offer_id: URI_TOKENS.listed.id,
          is_sell_offer: 1,
          amount: '2200',
          currency: 'XAH',
          destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
        }),
      ],
      skipped: 0,
    });
  });

  it('synthetic-uritoken-remit-two-tokens: removals in node order, then a transfer per token by id', async () => {
    const t = await uriSynthetic['synthetic-uritoken-remit-two-tokens']();
    const second = { ...URI_TOKENS.remitted, id: `${'0'.repeat(63)}1` };
    expect(t.tx.URITokenIDs).toEqual([URI_TOKENS.remitted.id, second.id]);
    const move = { account: SELLER, from_account: SELLER, to_account: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp' };
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.remitted, 0, 'offer_removed', {
          account: SELLER,
          offer_id: URI_TOKENS.remitted.id,
          is_sell_offer: 1,
          amount: '3350',
          currency: 'XAH',
          removed_by: 'transfer',
        }),
        uev(second, 1, 'offer_removed', {
          account: SELLER,
          offer_id: second.id,
          is_sell_offer: 1,
          amount: '1',
          currency: 'XAH',
          removed_by: 'transfer',
        }),
        uev(second, 2, 'transfer', move),
        uev(URI_TOKENS.remitted, 3, 'transfer', move),
      ],
      skipped: 0,
    });
  });

  it('synthetic-uritoken-free-mint-with-offer: a mint offered at 0 has its offer, at the transaction’s amount', async () => {
    const t = await uriSynthetic['synthetic-uritoken-free-mint-with-offer']();
    expect(uriBody(t.meta as Json).NewFields.Amount).toBeUndefined();
    expect(t.tx.Amount).toBe('0');
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.minted, 0, 'mint', {
          account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          to_account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          uri: t.tx.URI,
        }),
        uev(URI_TOKENS.minted, 1, 'offer_create', {
          account: 'rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E',
          offer_id: URI_TOKENS.minted.id,
          is_sell_offer: 1,
          amount: '0',
          currency: 'XAH',
          destination: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
        }),
      ],
      skipped: 0,
    });
  });

  it('synthetic-uritoken-buy-above-ask: the offer removed is at the ask, the sale at what the transaction paid', async () => {
    const t = await uriSynthetic['synthetic-uritoken-buy-above-ask']();
    expect(uriBody(t.meta as Json).PreviousFields.Amount).toBe('4200000000');
    expect(t.tx.Amount).toBe('4300000000');
    const buyer = 'rBkEp8W1yhBGLrvHFKKyrmSvniMFVJbPPg';
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.bought, 0, 'offer_removed', {
          account: SELLER,
          offer_id: URI_TOKENS.bought.id,
          is_sell_offer: 1,
          amount: '4200',
          currency: 'XAH',
          removed_by: 'sale',
        }),
        uev(URI_TOKENS.bought, 1, 'sale', {
          account: buyer,
          from_account: SELLER,
          to_account: buyer,
          offer_id: URI_TOKENS.bought.id,
          is_sell_offer: 1,
          amount: '4300',
          currency: 'XAH',
        }),
      ],
      skipped: 0,
    });
  });

  it('synthetic-uritoken-setremarks-with-offer: a SetRemarks of a token with a standing offer is no offer_create', async () => {
    const t = await uriSynthetic['synthetic-uritoken-setremarks-with-offer']();
    expect(t.tx.TransactionType).toBe('SetRemarks');
    // The offer stands in the entry's FinalFields, and nothing changed it: PreviousFields do not list an Amount.
    expect(uriBody(t.meta as Json).FinalFields.Amount).toBe('2200000000');
    expect(uriBody(t.meta as Json).PreviousFields.Amount).toBeUndefined();
    expect(parseXahau(t)).toEqual({ events: [], skipped: 0 });
  });

  it('synthetic-uritoken-remit-no-offer: a token that had no offer is only transferred, and nothing is removed or skipped', async () => {
    const t = await uriSynthetic['synthetic-uritoken-remit-no-offer']();
    expect(uriBody(t.meta as Json).PreviousFields).toEqual({ Owner: SELLER });
    expect(parseXahau(t)).toEqual({
      events: [
        uev(URI_TOKENS.remitted, 0, 'transfer', {
          account: SELLER,
          from_account: SELLER,
          to_account: 'rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp',
        }),
      ],
      skipped: 0,
    });
  });

  it('an MPT amount skips the event and counts it (synthetic-uritoken-mpt-offer, -mpt-buy, -mpt-mint-offer)', async () => {
    // A sell offer priced in an MPT: no event, one skipped.
    expect(parseXahau(await uriSynthetic['synthetic-uritoken-mpt-offer']())).toEqual({ events: [], skipped: 1 });
    // A buy priced in an MPT: the offer's removal and the sale are each skipped, and the token's move is no event.
    expect(parseXahau(await uriSynthetic['synthetic-uritoken-mpt-buy']())).toEqual({ events: [], skipped: 2 });
    // A mint with an MPT-priced offer (synthetic-uritoken-mpt-mint-offer): the mint stays, its offer is skipped.
    const mint = parseXahau(await uriSynthetic['synthetic-uritoken-mpt-mint-offer']());
    expect(mint.events.map((e) => e.event)).toEqual(['mint']);
    expect(mint.skipped).toBe(1);
  });

  it('a transaction that failed gives no event (synthetic-uritoken-failed-mint)', async () => {
    const t = await uriSynthetic['synthetic-uritoken-failed-mint']();
    expect(t.meta.TransactionResult).toBe('tecINSUFFICIENT_RESERVE');
    expect(uriBody(t.meta as Json).LedgerEntryType).toBe('URIToken');
    expect(parseXahau(t)).toEqual({ events: [], skipped: 0 });
  });

  it('writes an id as 64 upper-case hex digits, whatever case the ledger had it in (synthetic-uritoken-lower-case-id)', async () => {
    const t = await uriSynthetic['synthetic-uritoken-lower-case-id']();
    expect(JSON.stringify(t.meta)).toContain(URI_TOKENS.minted.id.toLowerCase());
    expect(parseXahau(t).events.map((e) => e.nft_id)).toEqual([URI_TOKENS.minted.id]);
  });
});

describe('NftParser: URITokens, rules over all cases', () => {
  /** Every recorded Xahau case, its burn, and every synthetic one, loaded fresh and deep-frozen. */
  async function everyUriCase(): Promise<[string, ParserTx][]> {
    const link = xahauManifest.cases.uritoken_remint.burn as { ledger: number; hash: string };
    return [
      ...(await Promise.all(
        Object.keys(xahauManifest.cases).map(
          async (name): Promise<[string, ParserTx]> => [name, await recordedUri(name)],
        ),
      )),
      ['uritoken_remint burn', await transactionIn(xahauSource, 'uritoken_remint burn', link.ledger, link.hash)],
      ...(await Promise.all(
        Object.entries(uriSynthetic).map(async ([name, build]): Promise<[string, ParserTx]> => [name, await build()]),
      )),
    ];
  }

  it('never writes to its input', async () => {
    for (const [name, t] of await everyUriCase()) {
      const snapshot = structuredClone(t);
      expect(Object.isFrozen(t.meta)).toBe(true);
      expect(() => parseXahau(t)).not.toThrow();
      expect({ name, t }).toEqual({ name, t: snapshot });
    }
  });

  it('numbers the events of a transaction from 0, each once', async () => {
    let checked = 0;
    for (const [, t] of await everyUriCase()) {
      const { events } = parseXahau(t);
      expect(events.map((e) => e.event_index)).toEqual(events.map((_, i) => i));
      checked += events.length;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('gives a URIToken no taxon, serial or transfer fee, its issuer, flags and digest, and the id of its entry', async () => {
    for (const [, t] of await everyUriCase()) {
      for (const e of parseXahau(t).events) {
        expect(e.nft_id).toMatch(/^[0-9A-F]{64}$/);
        expect(NFT_EVENTS).toContain(e.event);
        expect(e).toMatchObject({ kind: 'uritoken', taxon: null, taxon_key: 0, serial: 0, transfer_fee: 0 });
        expect(e.royalty_est).toBe('');
        expect(e.expiration).toBeNull();
        expect(e.broker).toBe('');
        // The offers of a URIToken are its sell offer: they name the token's id.
        if (['offer_create', 'offer_cancel', 'offer_removed', 'sale'].includes(e.event)) {
          expect(e.offer_id).toBe(e.nft_id);
          expect(e.is_sell_offer).toBe(1);
        } else {
          expect(e.offer_id).toBe('');
          expect(e.is_sell_offer).toBe(0);
        }
        expect(e.uri === '' || e.event === 'mint').toBe(true);
        expect(e.removed_by === '' || e.event === 'offer_removed').toBe(true);
      }
    }
  });

  it('gives each URIToken and Remit transaction of the recorded ledgers its events, and every other transaction none', async () => {
    const counts: Record<string, number> = {};
    for (const ledger of xahauSource.list()) {
      for (const raw of ledger.transactions) {
        const t = deepFreeze(toParserTx(raw, ledger.header, null));
        const type = t.tx.TransactionType as string;
        const { events, skipped } = parseXahau(t);
        const names = events.map((e) => e.event);
        const of = (name: string) => events.filter((e) => e.event === name);
        expect(skipped).toBe(0);
        counts[type] = (counts[type] ?? 0) + (t.meta.TransactionResult === 'tesSUCCESS' ? 1 : 0);
        if (t.meta.TransactionResult !== 'tesSUCCESS' || !(type.startsWith('URIToken') || type === 'Remit')) {
          expect(names).toEqual([]);
        } else if (type === 'URITokenMint') {
          expect(names.filter((n) => n !== 'offer_create')).toEqual(['mint']);
          expect(of('offer_create')).toHaveLength(t.tx.Amount === undefined ? 0 : 1);
          expect(names[0]).toBe('mint');
          expect(events[0]).toMatchObject({ account: t.tx.Account, issuer: t.tx.Account, to_account: t.tx.Account });
        } else if (type === 'URITokenBurn') {
          expect(of('burn').map((e) => e.nft_id)).toEqual([t.tx.URITokenID]);
          expect(of('offer_removed').every((e) => e.removed_by === 'burn')).toBe(true);
          expect(last(names)).toBe('burn');
          expect(last(events).account).toBe(t.tx.Account);
        } else if (type === 'URITokenBuy') {
          expect(names).toEqual(['offer_removed', 'sale']);
          expect(of('offer_removed')[0].removed_by).toBe('sale');
          expect(of('sale')[0]).toMatchObject({
            nft_id: t.tx.URITokenID,
            account: t.tx.Account,
            to_account: t.tx.Account,
          });
          expect(of('sale')[0].amount).toBe(amountText(t.tx.Amount));
        } else if (type === 'URITokenCreateSellOffer') {
          expect(names).toEqual(['offer_create']);
          expect(events[0]).toMatchObject({ nft_id: t.tx.URITokenID, account: t.tx.Account });
          expect(events[0].amount).toBe(amountText(t.tx.Amount));
        } else if (type === 'URITokenCancelSellOffer') {
          expect(names).toEqual(['offer_cancel']);
          expect(events[0]).toMatchObject({ nft_id: t.tx.URITokenID, account: t.tx.Account });
        } else if (type === 'Remit') {
          expect(of('transfer').map((e) => e.nft_id)).toEqual([...(t.tx.URITokenIDs ?? [])].sort());
          expect(of('mint')).toHaveLength(t.tx.MintURIToken === undefined ? 0 : 1);
          expect(of('offer_removed').every((e) => e.removed_by === 'transfer')).toBe(true);
          expect(of('sale')).toEqual([]);
        }
      }
    }
    // The recorded ledgers' successful URIToken transactions are all seen, and a Remit that moves no URIToken gives none.
    expect(counts).toMatchObject({
      URITokenMint: 7,
      URITokenBurn: 8,
      URITokenBuy: 2,
      URITokenCreateSellOffer: 2,
      URITokenCancelSellOffer: 1,
      Remit: 3,
      SetRemarks: 1,
    });
  });
});

describe('rolesOf: URITokens', () => {
  const entries = (e: ParsedNftEvent) => [...rolesOf(e)];

  it('a sale: the issuer, the seller and the buyer; a Remit’s mint: the issuer and the new owner', async () => {
    const sale = xahauEventsOf(await recordedUri('uritoken_buy_above_ask')).find(
      (e) => e.event === 'sale',
    ) as ParsedNftEvent;
    expect(entries(sale)).toEqual([
      [RODIN, ['issuer']],
      [SELLER, ['from']],
      ['rBkEp8W1yhBGLrvHFKKyrmSvniMFVJbPPg', ['to']],
    ]);
    const [mint] = xahauEventsOf(await recordedUri('remit_mint'));
    expect(entries(mint)).toEqual([
      [RODIN, ['issuer']],
      [SELLER, ['to']],
    ]);
  });

  it('an offer of a URIToken: its owner, and the destination of an offer that has one (synthetic-uritoken-mint-with-offer)', async () => {
    const [, offer] = xahauEventsOf(await uriSynthetic['synthetic-uritoken-mint-with-offer']());
    expect(entries(offer)).toEqual([
      ['rPSpGgNCgSzfvyW1PveBL62Ph5VZFcQt6E', ['offer_owner']],
      ['rAucmWmE8yiueemhmrGh5MyD2mNjXfpQp', ['destination']],
    ]);
    const [cancel] = xahauEventsOf(await recordedUri('uritoken_sell_offer_cancel'));
    expect(entries(cancel)).toEqual([[SELLER, ['offer_owner']]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The invariants over every transaction of every set, and the oracle
// ---------------------------------------------------------------------------------------------------------------------

/** One transaction of one set, with the parse context of its network. */
interface AnyCase {
  /** The set and the case or the transaction hash. */
  name: string;
  network: 'xrpl' | 'xahau';
  t: ParserTx;
  ctx: ParseContext;
}

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** Every transaction of every ledger of a recorded set, deep-frozen. */
function transactionsOf(
  set: string,
  dir: string,
  network: 'xrpl' | 'xahau',
  ctx: ParseContext,
  ledgers = FixtureLedgerSource.fromDir(dir).list(),
): AnyCase[] {
  return ledgers.flatMap((ledger) =>
    ledger.transactions.map((raw) => ({
      name: `${set} ${ledger.header.ledger_index} ${raw.hash}`,
      network,
      t: deepFreeze(toParserTx(raw, ledger.header, null)),
      ctx,
    })),
  );
}

/** The sets that hold NFT transactions (the cases of Tasks 1, 4 and 5 and every other transaction of their ledgers). */
async function nftSets(): Promise<AnyCase[]> {
  const syntheticOf = async (
    made: Record<string, () => Promise<ParserTx>>,
    network: 'xrpl' | 'xahau',
    ctx: ParseContext,
  ) =>
    Promise.all(
      Object.entries(made).map(async ([name, build]): Promise<AnyCase> => ({ name, network, t: await build(), ctx })),
    );
  return [
    ...transactionsOf('xrpl/nft', DIR, 'xrpl', XRPL, source.list()),
    ...(await syntheticOf(synthetic, 'xrpl', XRPL)),
    ...transactionsOf('xahau/uritoken', XAHAU_DIR, 'xahau', XAHAU, xahauSource.list()),
    ...(await syntheticOf(uriSynthetic, 'xahau', XAHAU)),
  ];
}

/** The sets that no NFT transaction was picked for: whatever their transactions are. */
function otherSets(): AnyCase[] {
  return [
    ...transactionsOf('xrpl/recorded', join(FIXTURES, 'xrpl', 'recorded'), 'xrpl', XRPL),
    ...transactionsOf('xahau/recorded', join(FIXTURES, 'xahau', 'recorded'), 'xahau', XAHAU),
    ...transactionsOf('xrpl/ripple-mock', join(FIXTURES, 'xrpl', 'ripple-mock'), 'xrpl', XRPL),
  ];
}

const NFT_ENTRY_TYPES = new Set(['NFTokenPage', 'NFTokenOffer', 'URIToken']);

/** The nodes of the metadata, as `[operation, body]`. */
const nodesOf = (meta: Json): [string, Json][] =>
  ((meta.AffectedNodes ?? []) as Json[]).map((wrapper) => {
    const op = Object.keys(wrapper)[0];
    return [op, wrapper[op]];
  });

/** The ids a transaction's pages held before and after, over the union of its pages (never page by page). */
function pageIds(meta: Json): { before: Set<string>; after: Set<string> } {
  const before = new Set<string>();
  const after = new Set<string>();
  const ids = (tokens: Json[] | undefined) => (tokens ?? []).map((e) => (e.NFToken.NFTokenID as string).toUpperCase());
  for (const [op, node] of nodesOf(meta)) {
    if (node.LedgerEntryType !== 'NFTokenPage') continue;
    if (op !== 'CreatedNode') {
      for (const id of ids(node.PreviousFields?.NFTokens ?? node.FinalFields?.NFTokens)) before.add(id);
    }
    if (op !== 'DeletedNode') {
      for (const id of ids(node.FinalFields?.NFTokens ?? node.NewFields?.NFTokens)) after.add(id);
    }
  }
  return { before, after };
}

describe('every recorded and synthetic case', () => {
  let loaded: Promise<{ nft: AnyCase[]; other: AnyCase[] }> | undefined;
  /** Every transaction of every set, loaded once for the tests below. */
  const sets = () => (loaded ??= nftSets().then((nft) => ({ nft, other: otherSets() })));
  const every = async (): Promise<AnyCase[]> => {
    const { nft, other } = await sets();
    return [...nft, ...other];
  };

  it('has the recorded and the synthetic cases and the other sets to run over', async () => {
    const { nft, other } = await sets();
    expect(nft.length).toBeGreaterThan(100);
    expect(nft.filter((c) => c.name.startsWith('synthetic-')).length).toBe(
      Object.keys(synthetic).length + Object.keys(uriSynthetic).length,
    );
    expect(other.length).toBeGreaterThan(1000);
    for (const set of ['xrpl/recorded', 'xahau/recorded', 'xrpl/ripple-mock']) {
      expect(other.some((c) => c.name.startsWith(`${set} `))).toBe(true);
    }
  });

  it('the parser and the oracle give the same events', async () => {
    let withEvents = 0;
    for (const { name, t, ctx } of await every()) {
      const got = new NftParser().parse(t, ctx);
      const want = nftOracle(t, ctx.nativeCurrency);
      if (got.events.length > 0 || got.skipped > 0) withEvents += 1;
      // Cheap for the common case (nothing, or the same text); the matcher names the difference when there is one.
      if (JSON.stringify(got) !== JSON.stringify(want)) expect({ name, ...got }).toEqual({ name, ...want });
    }
    expect(withEvents).toBeGreaterThan(100);
  });

  it('the parser and the oracle give the same roles for every event', async () => {
    let checked = 0;
    for (const { name, t, ctx } of await every()) {
      for (const e of new NftParser().parse(t, ctx).events) {
        expect({ name, event: e.event, roles: [...rolesOf(e)] }).toEqual({
          name,
          event: e.event,
          roles: nftOracleRoles(e),
        });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('the ids of the events are the union of the page diffs', async () => {
    let diffs = 0;
    for (const { name, t, ctx, network } of await every()) {
      if (network !== 'xrpl') continue;
      const { before, after } = pageIds(t.meta);
      const events = new NftParser().parse(t, ctx).events;
      const ids = (names: string[]) => [...new Set(events.filter((e) => names.includes(e.event)).map((e) => e.nft_id))];
      const failed = t.meta.TransactionResult !== 'tesSUCCESS';
      // Gained over the union of the pages is minted, lost is burned, and what is on pages before and after is only ever
      // sold, transferred or modified: a page split or merge makes none of them.
      const minted = failed ? [] : [...after].filter((id) => !before.has(id));
      const burned = failed ? [] : [...before].filter((id) => !after.has(id));
      expect({ name, mint: ids(['mint']).sort(), burn: ids(['burn']).sort() }).toEqual({
        name,
        mint: minted.sort(),
        burn: burned.sort(),
      });
      for (const id of ids(['sale', 'transfer', 'modify'])) {
        expect({ name, id, held: before.has(id) && after.has(id) }).toEqual({ name, id, held: true });
      }
      if (minted.length + burned.length > 0) diffs += 1;
    }
    // The 12 mints and 2 burns recorded, and the hand-made ones.
    expect(diffs).toBeGreaterThanOrEqual(14);
  });

  it('each NFT has at most one owner after each transaction', async () => {
    let moved = 0;
    for (const { name, t, ctx } of await every()) {
      const byNft = new Map<string, ParsedNftEvent[]>();
      for (const e of new NftParser().parse(t, ctx).events) {
        if (e.event === 'mint' || e.event === 'burn' || e.event === 'sale' || e.event === 'transfer') {
          byNft.set(e.nft_id, [...(byNft.get(e.nft_id) ?? []), e]);
        }
      }
      for (const [id, events] of byNft) {
        // One event moves an NFT in a transaction (a mint, a burn, a sale or a transfer), never two: it has no two owners
        // after it, and none after a burn.
        expect({ name, id, events: events.map((e) => e.event) }).toEqual({ name, id, events: [events[0].event] });
        const [e] = events;
        const owners = (account: string) => ({ name, id, event: e.event, named: account !== '' });
        expect(owners(e.to_account)).toEqual({ ...owners(''), named: e.event !== 'burn' });
        expect(owners(e.from_account)).toEqual({ ...owners(''), named: e.event !== 'mint' });
        if (e.event === 'sale' || e.event === 'transfer') expect(e.from_account).not.toBe(e.to_account);
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(30);
  });

  it('(nft_id, event_index) is unique within a transaction', async () => {
    let checked = 0;
    for (const { name, t, ctx } of await every()) {
      const { events } = new NftParser().parse(t, ctx);
      const keys = events.map((e) => `${e.nft_id} ${e.event_index}`);
      expect({ name, keys: new Set(keys).size }).toEqual({ name, keys: keys.length });
      // The index alone is unique too: it numbers the transaction's events from 0.
      expect(events.map((e) => e.event_index)).toEqual(events.map((_, i) => i));
      checked += events.length;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("the decoded fields of a mint equal the transaction's NFTokenTaxon and TransferFee", async () => {
    let checked = 0;
    for (const { name, t, ctx, network } of await every()) {
      if (network !== 'xrpl' || t.tx.TransactionType !== 'NFTokenMint') continue;
      const mints = new NftParser().parse(t, ctx).events.filter((e) => e.event === 'mint');
      if (t.meta.TransactionResult !== 'tesSUCCESS') {
        expect({ name, mints }).toEqual({ name, mints: [] });
        continue;
      }
      // synthetic-mixed-order adds two hand-made ids to the one of the recorded mint: only the recorded one decodes to the
      // transaction's fields.
      if (name === 'synthetic-mixed-order') {
        expect(mints).toHaveLength(3);
        continue;
      }
      expect({ name, mints: mints.length }).toEqual({ name, mints: 1 });
      expect({
        name,
        taxon: mints[0].taxon,
        taxon_key: mints[0].taxon_key,
        transfer_fee: mints[0].transfer_fee,
        issuer: mints[0].issuer,
        nft_flags: mints[0].nft_flags,
      }).toEqual({
        name,
        taxon: t.tx.NFTokenTaxon,
        taxon_key: t.tx.NFTokenTaxon,
        transfer_fee: t.tx.TransferFee ?? 0,
        issuer: t.tx.Issuer ?? t.tx.Account,
        nft_flags: (t.tx.Flags ?? 0) & 0xffff,
      });
      checked += 1;
    }
    // The 12 recorded mints and the synthetic ones.
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it('a transaction without an NFT node gives nothing', async () => {
    let checked = 0;
    for (const { name, t, ctx } of (await sets()).other) {
      if (nodesOf(t.meta).some(([, node]) => NFT_ENTRY_TYPES.has(node.LedgerEntryType))) continue;
      expect({ name, ...new NftParser().parse(t, ctx) }).toEqual({ name, events: [], skipped: 0 });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

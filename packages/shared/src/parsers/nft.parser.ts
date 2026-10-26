import { BigNumber } from 'bignumber.js';
import { dropsToNative } from '../util/amount';
import { decodeNFTokenId, pageOwner } from '../util/nftoken-id';
import { RIPPLE_EPOCH_MS } from '../util/time';
import { LedgerNode, ledgerNodes } from './amm.parser';
import { ParseContext, ParserTx, senderAccount } from './parser.interface';

/**
 * The events of an NFT (spec §1.1, `nft_events.event`), in the order of the column's `Enum8`: the one list of them, which
 * the API validates the `event` filter of its routes against.
 */
export const NFT_EVENTS = [
  'mint',
  'burn',
  'modify',
  'offer_create',
  'offer_cancel',
  'offer_removed',
  'sale',
  'transfer',
] as const;
export type NftEventName = (typeof NFT_EVENTS)[number];

/** `nftoken` on XRPL, `uritoken` on Xahau. */
export type NftKind = 'nftoken' | 'uritoken';

/** What deleted an offer (`offer_removed`): an accepted offer, a burn of its NFT, a transfer of it, or anything else. */
export type OfferRemovedBy = 'sale' | 'burn' | 'transfer' | 'other';

/**
 * One event of an NFT or URIToken (spec §1.1), without the columns the transaction gives (`tx_hash`, `tx_type`, the
 * ledger, the time). An absent string is `''` and an absent number `null`. Amounts are exact decimal text in whole units;
 * the native currency is `ctx.nativeCurrency` with an `amount_issuer` of `''`.
 */
export interface ParsedNftEvent {
  /** 64 upper-case hex digits. */
  nft_id: string;
  /** The event's place among the transaction's events, from 0 (spec §2.5). */
  event_index: number;
  kind: NftKind;
  event: NftEventName;
  issuer: string;
  taxon: number | null;
  /** The taxon on XRPL, 0 on Xahau. */
  taxon_key: number;
  /** The id's sequence on XRPL, 0 on Xahau. */
  serial: number;
  nft_flags: number;
  /** In 1/100000. */
  transfer_fee: number;
  /** Hex as on the ledger: the new URI of a mint or a modify, else `''`. */
  uri: string;
  digest: string;
  /** Who did it: the offer's owner for an offer event, else the sender. */
  account: string;
  /** The owner before (burn, sale, transfer). */
  from_account: string;
  /** The owner after (mint, sale, transfer). */
  to_account: string;
  /** The `NFTokenOffer`'s `LedgerIndex`; on Xahau the URIToken id. */
  offer_id: string;
  is_sell_offer: 0 | 1;
  /** The offer's amount, or the sale's price. */
  amount: string;
  currency: string;
  amount_issuer: string;
  destination: string;
  /** Unix seconds. */
  expiration: number | null;
  broker: string;
  broker_fee: string;
  royalty_est: string;
  /** `offer_removed` only. */
  removed_by: OfferRemovedBy | '';
}

export interface ParsedNft {
  events: ParsedNftEvent[];
  /** Events dropped because their amount is an MPT (or is not an amount at all): spec §2.5. */
  skipped: number;
}

/** The roles an account has in an event (spec §2.6), in this order. */
export const NFT_ROLES = ['issuer', 'minter', 'from', 'to', 'broker', 'offer_owner', 'destination'] as const;
export type NftRole = (typeof NFT_ROLES)[number];

const OFFER_EVENTS: ReadonlySet<NftEventName> = new Set(['offer_create', 'offer_cancel', 'offer_removed']);

/**
 * Each account the event involves, with its roles (spec §2.6) in `NFT_ROLES` order; an account with two roles is one
 * entry. The issuer is only named by a mint, a burn and a sale, so that an issuer's history is not every offer on its NFTs;
 * a modify names nobody.
 */
export function rolesOf(e: ParsedNftEvent): Map<string, NftRole[]> {
  const holder: Record<NftRole, string> = {
    issuer: e.event === 'mint' || e.event === 'burn' || e.event === 'sale' ? e.issuer : '',
    minter: e.event === 'mint' && e.account !== e.issuer ? e.account : '',
    from: e.from_account,
    to: e.to_account,
    broker: e.broker,
    offer_owner: OFFER_EVENTS.has(e.event) ? e.account : '',
    destination: e.destination,
  };
  const roles = new Map<string, NftRole[]>();
  for (const role of NFT_ROLES) {
    const account = holder[role];
    if (account === '') continue;
    const held = roles.get(account);
    if (held) held.push(role);
    else roles.set(account, [role]);
  }
  return roles;
}

type Json = Readonly<Record<string, any>>;

const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;
/** `lsfSellNFToken`: the offer sells the NFT (a buy offer has no flags at all). */
const LSF_SELL_NFTOKEN = 1;
/** `TransferFee` is in 1/100000. */
const FEE_SCALE = 5;

/** The order of the events that change who has an NFT or what it says (spec §2.5): by kind, then by id. */
const OWNERSHIP_RANK: Readonly<Partial<Record<NftEventName, number>>> = {
  mint: 0,
  sale: 1,
  transfer: 2,
  burn: 3,
  modify: 4,
};

/** An amount as the event columns hold it. */
interface Priced {
  amount: string;
  currency: string;
  amount_issuer: string;
}

/**
 * An XRPL amount as exact text in whole units: drops of the native currency, or an issued currency's value. Undefined for
 * an MPT amount (`mpt_issuance_id`) and for anything that is not an amount.
 */
function readAmount(raw: unknown, ctx: ParseContext): Priced | undefined {
  if (typeof raw === 'string') {
    return /^[0-9]+$/.test(raw)
      ? { amount: dropsToNative(raw), currency: ctx.nativeCurrency, amount_issuer: '' }
      : undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { currency, issuer, value } = raw as Record<string, unknown>;
  if (typeof currency !== 'string' || typeof issuer !== 'string' || typeof value !== 'string') return undefined;
  const parsed = new BigNumber(value);
  return parsed.isNaN() ? undefined : { amount: parsed.toFixed(), currency, amount_issuer: issuer };
}

/** An NFT on a page of its owner. */
interface Holding {
  owner: string;
  uri: string;
}

/** The entries of an `NFTokens` array: id (upper-case) and `URI` (`''` when absent). */
function tokensOf(list: unknown): { id: string; uri: string }[] {
  if (!Array.isArray(list)) return [];
  const tokens: { id: string; uri: string }[] = [];
  for (const entry of list) {
    const token = entry?.NFToken;
    if (typeof token?.NFTokenID !== 'string') continue;
    tokens.push({ id: token.NFTokenID.toUpperCase(), uri: typeof token.URI === 'string' ? token.URI : '' });
  }
  return tokens;
}

/** The `LedgerIndex` of a node: `ledgerNodes` keeps the entry's fields but not its key. */
const ledgerIndexOf = (meta: Json, node: LedgerNode): string => meta.AffectedNodes[node.index][node.op].LedgerIndex;

/** An `NFTokenOffer` node: its key, the NFT it is for and its fields. */
interface OfferNode {
  node: LedgerNode;
  id: string;
  nftId: string;
  isSell: boolean;
}

/**
 * Who has each NFT (and with what `URI`) before the transaction and after it, from the transaction's `NFTokenPage` nodes
 * and the page keys. The ids of all pages are compared, never page by page: pages split and merge. A modified page held
 * its previous array before; a page whose tokens did not change (the neighbour of a split changes only a link) has no
 * previous array and held what it holds. A deleted page held its final array, and holds nothing; a created one held
 * nothing.
 */
function holdingsOf(
  meta: Json,
  nodes: readonly LedgerNode[],
): { before: Map<string, Holding>; after: Map<string, Holding> } {
  const before = new Map<string, Holding>();
  const after = new Map<string, Holding>();
  for (const node of nodes) {
    if (node.type !== 'NFTokenPage') continue;
    const owner = pageOwner(ledgerIndexOf(meta, node));
    if (node.op !== 'DeletedNode') {
      for (const { id, uri } of tokensOf(node.fields.NFTokens)) after.set(id, { owner, uri });
    }
    if (node.op === 'CreatedNode') continue;
    const previous =
      node.op === 'ModifiedNode' ? (node.previous.NFTokens ?? node.fields.NFTokens) : node.fields.NFTokens;
    for (const { id, uri } of tokensOf(previous)) before.set(id, { owner, uri });
  }
  return { before, after };
}

/** The `NFTokenOffer` nodes of the transaction, in the order of `AffectedNodes`. */
function offerNodesOf(meta: Json, nodes: readonly LedgerNode[]): OfferNode[] {
  const offers: OfferNode[] = [];
  for (const node of nodes) {
    if (node.type !== 'NFTokenOffer' || typeof node.fields.NFTokenID !== 'string') continue;
    offers.push({
      node,
      id: ledgerIndexOf(meta, node),
      nftId: node.fields.NFTokenID.toUpperCase(),
      isSell: ((node.fields.Flags ?? 0) & LSF_SELL_NFTOKEN) === LSF_SELL_NFTOKEN,
    });
  }
  return offers;
}

/** A blank event of an NFT, with the columns its id decodes to. */
function blankEvent(nftId: string, event: NftEventName): ParsedNftEvent {
  const decoded = decodeNFTokenId(nftId);
  return {
    nft_id: nftId,
    event_index: 0,
    kind: 'nftoken',
    event,
    issuer: decoded.issuer,
    taxon: decoded.taxon,
    taxon_key: decoded.taxon,
    serial: decoded.serial,
    nft_flags: decoded.flags,
    transfer_fee: decoded.transferFee,
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
  };
}

const byNftId = (a: ParsedNftEvent, b: ParsedNftEvent): number =>
  a.nft_id < b.nft_id ? -1 : a.nft_id > b.nft_id ? 1 : 0;

/** True when some node of the transaction is an `NFTokenPage` or an `NFTokenOffer`. */
function touchesNfts(meta: Json): boolean {
  const entries: readonly Json[] = meta.AffectedNodes ?? [];
  return entries.some((entry) => {
    const type = (entry?.CreatedNode ?? entry?.ModifiedNode ?? entry?.DeletedNode)?.LedgerEntryType;
    return type === 'NFTokenPage' || type === 'NFTokenOffer';
  });
}

/** What a transaction's deleted offers are: cancelled (an event of its own), or removed by an accept, a burn or another. */
function removalOf(type: unknown): OfferRemovedBy | 'cancel' {
  switch (type) {
    case 'NFTokenCancelOffer':
      return 'cancel';
    case 'NFTokenAcceptOffer':
      return 'sale';
    case 'NFTokenBurn':
      return 'burn';
    default:
      return 'other';
  }
}

/**
 * The issuer's cut of a sale (spec §2.3, rippled `acceptOffer`): the transfer fee of the price less the broker's cut,
 * rounded down to whole drops for the native currency and to 16 significant digits for an issued one (Ruling 13). `''`
 * when the NFT has no fee, or the issuer is the seller or the buyer, who pay no royalty to themselves.
 */
function royaltyOf(sale: ParsedNftEvent, price: Priced, brokerFee: BigNumber): string {
  if (sale.transfer_fee === 0 || sale.issuer === sale.from_account || sale.issuer === sale.to_account) return '';
  const cut = new BigNumber(price.amount).minus(brokerFee).multipliedBy(sale.transfer_fee).shiftedBy(-FEE_SCALE);
  const rounded =
    price.amount_issuer === '' ? cut.decimalPlaces(6, BigNumber.ROUND_DOWN) : cut.precision(16, BigNumber.ROUND_DOWN);
  return rounded.toFixed();
}

/**
 * An NFT that went from one owner to another (`moved` has them): a `sale` when an accepted offer with a non-zero amount
 * moved it, else a `transfer`; `'skipped'` when that amount is an MPT. `sell` and `buy` are the offers the transaction
 * accepted. The price is the accepted offer's `Amount`, in a brokered sale (both offers) the buy offer's, and the offer
 * the event names is the accepted one, in a brokered sale the sell offer (Ruling 14).
 */
function settle(
  moved: ParsedNftEvent,
  sell: OfferNode | undefined,
  buy: OfferNode | undefined,
  tx: Json,
  ctx: ParseContext,
): ParsedNftEvent | 'skipped' {
  const listed = sell ?? buy;
  if (!listed) return moved;
  const withOffer: ParsedNftEvent = { ...moved, offer_id: listed.id, is_sell_offer: listed.isSell ? 1 : 0 };
  const brokered = sell !== undefined && buy !== undefined;
  const price = readAmount((brokered ? buy : listed).node.fields.Amount ?? '0', ctx);
  if (!price) return 'skipped';
  if (new BigNumber(price.amount).isZero()) return withOffer;

  const sale: ParsedNftEvent = { ...withOffer, event: 'sale', ...price };
  let brokerFee = new BigNumber(0);
  if (brokered) {
    sale.broker = moved.account;
    if (tx.NFTokenBrokerFee !== undefined) {
      const fee = readAmount(tx.NFTokenBrokerFee, ctx);
      if (!fee) return 'skipped';
      sale.broker_fee = fee.amount;
      brokerFee = new BigNumber(fee.amount);
    }
  }
  sale.royalty_est = royaltyOf(sale, price, brokerFee);
  return sale;
}

/**
 * The XRPL NFT events of a transaction (spec §2.1–2.3, §2.5): who has each NFT before and after (from the
 * `NFTokenPage` nodes of the transaction, over the union of them), and the `NFTokenOffer` nodes it created and deleted.
 * Successful transactions only; pure, and never writes to its input.
 */
export class NftParser {
  parse(t: ParserTx, ctx: ParseContext): ParsedNft {
    if (t.meta.TransactionResult !== 'tesSUCCESS' || !touchesNfts(t.meta)) return { events: [], skipped: 0 };
    const nodes = ledgerNodes(t.meta);
    const sender = senderAccount(t.tx) ?? '';
    let skipped = 0;

    const { before, after } = holdingsOf(t.meta, nodes);
    const offers = offerNodesOf(t.meta, nodes);
    // The offers an NFTokenAcceptOffer consumed: the deleted offers its two offer fields name.
    const acceptedOffer = (field: string): OfferNode | undefined => {
      const id = t.tx[field];
      return typeof id === 'string' ? offers.find((o) => o.node.op === 'DeletedNode' && o.id === id) : undefined;
    };
    const sellOffer = acceptedOffer('NFTokenSellOffer');
    const buyOffer = acceptedOffer('NFTokenBuyOffer');

    /** The offer event of an offer node, or undefined (and one more skipped) when its amount is an MPT. */
    const offerEvent = (
      offer: OfferNode,
      event: NftEventName,
      removedBy: OfferRemovedBy | '',
    ): ParsedNftEvent | undefined => {
      const fields = offer.node.fields;
      // The ledger leaves a native zero out of a created node (FINDINGS xrpl 6, an STAmount's only default value): an
      // absent `Amount` is zero.
      const raw = fields.Amount ?? '0';
      const priced = readAmount(raw, ctx);
      if (!priced) {
        skipped++;
        return undefined;
      }
      return {
        ...blankEvent(offer.nftId, event),
        account: typeof fields.Owner === 'string' ? fields.Owner : '',
        offer_id: offer.id,
        is_sell_offer: offer.isSell ? 1 : 0,
        ...priced,
        destination: typeof fields.Destination === 'string' ? fields.Destination : '',
        expiration: typeof fields.Expiration === 'number' ? fields.Expiration + RIPPLE_EPOCH_S : null,
        removed_by: removedBy,
      };
    };

    // The events that come first: offers cancelled or removed, in the order of the nodes.
    const removals: ParsedNftEvent[] = [];
    const creations: ParsedNftEvent[] = [];
    const removal = removalOf(t.tx.TransactionType);
    for (const offer of offers) {
      let e: ParsedNftEvent | undefined;
      if (offer.node.op === 'CreatedNode') {
        e = offerEvent(offer, 'offer_create', '');
        if (e) creations.push(e);
      } else if (offer.node.op === 'DeletedNode') {
        e = removal === 'cancel' ? offerEvent(offer, 'offer_cancel', '') : offerEvent(offer, 'offer_removed', removal);
        if (e) removals.push(e);
      }
    }

    // The events of the NFTs themselves.
    const ownership: ParsedNftEvent[] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(id);
      const now = after.get(id);
      if (now && !was) {
        ownership.push({ ...blankEvent(id, 'mint'), account: sender, to_account: now.owner, uri: now.uri });
      } else if (was && !now) {
        ownership.push({ ...blankEvent(id, 'burn'), account: sender, from_account: was.owner });
      } else if (was && now && was.owner !== now.owner) {
        const transfer: ParsedNftEvent = {
          ...blankEvent(id, 'transfer'),
          account: sender,
          from_account: was.owner,
          to_account: now.owner,
        };
        const settled = settle(transfer, sellOffer, buyOffer, t.tx, ctx);
        if (settled === 'skipped') skipped++;
        else ownership.push(settled);
      } else if (was && now && was.uri !== now.uri) {
        ownership.push({ ...blankEvent(id, 'modify'), account: sender, uri: now.uri });
      }
    }
    ownership.sort((a, b) => (OWNERSHIP_RANK[a.event] ?? 0) - (OWNERSHIP_RANK[b.event] ?? 0) || byNftId(a, b));

    const events = [...removals, ...ownership, ...creations];
    events.forEach((e, i) => (e.event_index = i));
    return { events, skipped };
  }
}

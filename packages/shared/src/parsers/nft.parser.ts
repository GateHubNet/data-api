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
 * and the page keys. The ids of all pages are compared, never page by page: pages split and merge. A modified or deleted
 * page held its previous array before; a page whose tokens did not change (the neighbour of a split changes only a link)
 * has no previous array and held what it holds. A deleted page can have one: a token removed in the transaction and the
 * page then merged forward and deleted, which leaves the removed token only in `PreviousFields`. A deleted page holds
 * nothing afterwards; a created one held nothing before.
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
    const previous = node.previous.NFTokens ?? node.fields.NFTokens;
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

/** A blank event of an NFT or a URIToken: every column at its absent value. */
function bareEvent(nftId: string, event: NftEventName): ParsedNftEvent {
  return {
    nft_id: nftId,
    event_index: 0,
    kind: 'nftoken',
    event,
    issuer: '',
    taxon: null,
    taxon_key: 0,
    serial: 0,
    nft_flags: 0,
    transfer_fee: 0,
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

/** A blank event of an NFT, with the columns its id decodes to. */
function blankEvent(nftId: string, event: NftEventName): ParsedNftEvent {
  const decoded = decodeNFTokenId(nftId);
  return {
    ...bareEvent(nftId, event),
    issuer: decoded.issuer,
    taxon: decoded.taxon,
    taxon_key: decoded.taxon,
    serial: decoded.serial,
    nft_flags: decoded.flags,
    transfer_fee: decoded.transferFee,
  };
}

const byNftId = (a: ParsedNftEvent, b: ParsedNftEvent): number =>
  a.nft_id < b.nft_id ? -1 : a.nft_id > b.nft_id ? 1 : 0;

/** The ledger entries the parser reads: XRPL's NFTokens and their offers, Xahau's URITokens. */
const NFT_ENTRY_TYPES: ReadonlySet<string> = new Set(['NFTokenPage', 'NFTokenOffer', 'URIToken']);

/** True when some node of the transaction is an `NFTokenPage`, an `NFTokenOffer` or a `URIToken`. */
function touchesNfts(meta: Json): boolean {
  const entries: readonly Json[] = meta.AffectedNodes ?? [];
  return entries.some((entry) => {
    const type = (entry?.CreatedNode ?? entry?.ModifiedNode ?? entry?.DeletedNode)?.LedgerEntryType;
    return NFT_ENTRY_TYPES.has(type);
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

/** A string field of a ledger entry, `''` when absent. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The events of a transaction's `URIToken` nodes, by the lists `NftParser.parse` orders (spec §2.5). */
interface UriTokenEvents {
  /** Offers cancelled or removed, in the order of the nodes. */
  removals: ParsedNftEvent[];
  /** Mints, sales, transfers and burns. */
  ownership: ParsedNftEvent[];
  /** Offers created, in the order of the nodes. */
  creations: ParsedNftEvent[];
  skipped: number;
}

/**
 * The events of the `URIToken` nodes of a transaction (spec §2.4), from each node's diff and the transaction type:
 * - created: a `mint` for the entry's `Owner`, and an `offer_create` when it has an `Amount` (or its `URITokenMint` names
 *   one that the entry lacks: a native zero is not stored);
 * - deleted: an `offer_removed` (`burn`) when it had an `Amount` (kept in its `FinalFields`), and a `burn` of its `Owner`;
 * - `Owner` changed: in a `URITokenBuy`, the offer's `offer_removed` (`sale`) and a `sale` at the transaction's `Amount`;
 *   otherwise (a `Remit`) a `transfer`, with an `offer_removed` (`transfer`) when its `Amount` was cleared with it;
 * - same owner: the `Amount` cleared is an `offer_cancel`, and set or changed an `offer_create`.
 * The entry's key is the id, and the offer's: a URIToken has one sell offer, in its own `Amount` and `Destination`, which
 * the ledger drops from the entry when the offer ends, so a cleared offer is read from `PreviousFields`.
 *
 * An added field is not listed in `PreviousFields` (FINDINGS xahau 4): the `Amount` of a new sell offer is told only by
 * the transaction type, since a `SetRemarks` of a token with an offer shows the same node. An `Amount` that was changed is
 * listed with its old value, whatever the transaction. An MPT amount skips the event and counts it (spec §2.5).
 */
function uriTokenEvents(
  meta: Json,
  nodes: readonly LedgerNode[],
  tx: Json,
  sender: string,
  ctx: ParseContext,
): UriTokenEvents {
  const out: UriTokenEvents = { removals: [], ownership: [], creations: [], skipped: 0 };
  const isMint = tx.TransactionType === 'URITokenMint';
  const isBuy = tx.TransactionType === 'URITokenBuy';
  const setsOffer = tx.TransactionType === 'URITokenCreateSellOffer';

  for (const node of nodes) {
    if (node.type !== 'URIToken') continue;
    const id = ledgerIndexOf(meta, node).toUpperCase();
    const { fields, previous } = node;
    const owner = text(fields.Owner);

    /** The event of this token. */
    const tokenEvent = (event: NftEventName): ParsedNftEvent => ({
      ...bareEvent(id, event),
      kind: 'uritoken',
      issuer: text(fields.Issuer),
      nft_flags: typeof fields.Flags === 'number' ? fields.Flags : 0,
      digest: text(fields.Digest),
    });
    /** The offer event of its sell offer (`offered` holds the offer's `Amount` and `Destination`): `account` is the offer's owner. */
    const offerEvent = (
      event: NftEventName,
      account: string,
      offered: Json,
      removedBy: OfferRemovedBy | '',
    ): ParsedNftEvent | undefined => {
      const priced = readAmount(offered.Amount, ctx);
      if (!priced) {
        out.skipped++;
        return undefined;
      }
      return {
        ...tokenEvent(event),
        account,
        offer_id: id,
        is_sell_offer: 1,
        ...priced,
        destination: text(offered.Destination),
        removed_by: removedBy,
      };
    };
    const add = (list: ParsedNftEvent[], e: ParsedNftEvent | undefined): void => {
      if (e) list.push(e);
    };
    // The offer the entry held before the transaction: what it still has, else what the transaction cleared.
    const standing: Json = {
      Amount: previous.Amount ?? fields.Amount,
      Destination: previous.Destination ?? fields.Destination,
    };

    if (node.op === 'CreatedNode') {
      out.ownership.push({ ...tokenEvent('mint'), account: sender, to_account: owner, uri: text(fields.URI) });
      // A native zero is left out of a created entry (FINDINGS xrpl 6, an STAmount's only default value): a mint whose
      // transaction names an Amount that its entry lacks is offered at the transaction's.
      const offered: Json =
        fields.Amount === undefined && isMint && tx.Amount !== undefined ? { ...fields, Amount: tx.Amount } : fields;
      if (offered.Amount !== undefined) add(out.creations, offerEvent('offer_create', owner, offered, ''));
    } else if (node.op === 'DeletedNode') {
      if (fields.Amount !== undefined) add(out.removals, offerEvent('offer_removed', owner, standing, 'burn'));
      out.ownership.push({ ...tokenEvent('burn'), account: sender, from_account: owner });
    } else if (typeof previous.Owner === 'string' && previous.Owner !== owner) {
      // The token changed hands: the offer it had (if its `Amount` was cleared) is the previous owner's.
      if (previous.Amount !== undefined && fields.Amount === undefined) {
        add(out.removals, offerEvent('offer_removed', previous.Owner, standing, isBuy ? 'sale' : 'transfer'));
      }
      const moved: ParsedNftEvent = {
        ...tokenEvent(isBuy ? 'sale' : 'transfer'),
        account: sender,
        from_account: previous.Owner,
        to_account: owner,
      };
      if (!isBuy) {
        out.ownership.push(moved);
      } else {
        // The price is the transaction's Amount, paid to the seller; the sale is of the token's sell offer.
        const price = readAmount(tx.Amount, ctx);
        if (price) out.ownership.push({ ...moved, offer_id: id, is_sell_offer: 1, ...price });
        else out.skipped++;
      }
    } else if (fields.Amount === undefined) {
      if (previous.Amount !== undefined) add(out.removals, offerEvent('offer_cancel', owner, standing, ''));
    } else if (previous.Amount !== undefined || setsOffer) {
      add(out.creations, offerEvent('offer_create', owner, fields, ''));
    }
  }
  return out;
}

/**
 * The NFT events of a transaction: XRPL's (spec §2.1–2.3, §2.5), from who has each NFT before and after (the
 * `NFTokenPage` nodes of the transaction, over the union of them) and the `NFTokenOffer` nodes it created and deleted,
 * and Xahau's URIToken events (spec §2.4), from its `URIToken` nodes. No transaction has both. Successful transactions
 * only; pure, and never writes to its input.
 */
export class NftParser {
  parse(t: ParserTx, ctx: ParseContext): ParsedNft {
    if (t.meta.TransactionResult !== 'tesSUCCESS' || !touchesNfts(t.meta)) return { events: [], skipped: 0 };
    const nodes = ledgerNodes(t.meta);
    const sender = senderAccount(t.tx) ?? '';
    // A transaction has XRPL NFT nodes or URIToken nodes, never both: the lists below start with the URIToken events.
    const uriTokens = uriTokenEvents(t.meta, nodes, t.tx, sender, ctx);
    let skipped = uriTokens.skipped;

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
    const removals: ParsedNftEvent[] = uriTokens.removals;
    const creations: ParsedNftEvent[] = uriTokens.creations;
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
    const ownership: ParsedNftEvent[] = uriTokens.ownership;
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

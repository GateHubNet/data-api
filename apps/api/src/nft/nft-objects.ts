import { NftEventName, NftEventsRow, NftFold, NftKind } from '@gatehub/data-api-shared';
import { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';

/**
 * The objects of the NFT routes (spec section 5.1), written down here once and pinned by the tests: each is built by a function
 * that writes its keys in the order of its constant and leaves out the keys it has no value for (an absent string is `''` in
 * the tables, and an absent number `null`: neither is written).
 *
 * Times are `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`), amounts the exact text stored, `converted_amount` the price in the native
 * currency (text, at most 6 decimals, from `convertedSalePrices`). `flags` is the number, `transfer_fee` the number in 1/100000.
 * `taxon`, `serial` and `transfer_fee` are the XRPL id's: an NFT of Xahau (`uritoken`) has none of them. `is_sell_offer` is a
 * boolean (Ruling 10), and is there on the events that name an offer.
 *
 * Nft, in this order (`owner` is absent for a burned NFT and when no indexed event names one; `owner_since`, `minted` and
 * `burned_at` are points of the ledger history, `last_sale` the newest sale):
 *   nft_id, kind, issuer, taxon?, serial?, flags, transfer_fee?, owner?, owner_since?, uri?, digest?, minted?, burned,
 *   burned_at?, sale_count, last_sale?
 *
 * NftEvent (one row of `nft_events`; `account` is who did it, `from` and `to` the owner before and after; `converted_amount`
 * on sales only), in this order:
 *   nft_id, kind, issuer, taxon?, serial?, ledger_index, tx_index, event_index, tx_hash, tx_type, executed_time, event,
 *   account?, from?, to?, offer_id?, is_sell_offer?, amount?, currency?, amount_issuer?, converted_amount?, destination?,
 *   expiration?, broker?, broker_fee?, royalty_est?, removed_by?, uri?
 *
 * NftSale (one `sale` event; `mode` is `brokered` when a broker is set), in this order:
 *   nft_id, kind, issuer, taxon?, serial?, ledger_index, tx_index, event_index, tx_hash, executed_time, seller, buyer, mode,
 *   amount, currency, amount_issuer?, converted_amount?, broker?, broker_fee?, royalty_est?
 *
 * NftOffer (an open offer, from the `offer_create` event that made it), in this order:
 *   offer_id, is_sell_offer, owner, amount, currency, amount_issuer?, destination?, expiration?, created_ledger,
 *   created_tx_hash, created_time
 *
 * `royalty_est` is the parser's value: `''` (left out) when no royalty applies, and `'0'` when one applies and rounds to nothing.
 *
 * A CSV has the same columns on every page whatever the objects of the page hold (a CSV takes its columns from the keys of the
 * rows, and a key that is left out would move them): `toNftEventCsvRow` gives every column, `null` (an empty cell) where the
 * event has none.
 */

// -- the keys ------------------------------------------------------------------------------------------------------------

export const NFT_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'flags',
  'transfer_fee',
  'owner',
  'owner_since',
  'uri',
  'digest',
  'minted',
  'burned',
  'burned_at',
  'sale_count',
  'last_sale',
] as const;

/** `owner_since`, `first_mint` and `last_mint`: the place of a fact in the ledger history. */
export const POINT_KEYS = ['ledger_index', 'tx_hash', 'executed_time'] as const;
export const MINTED_KEYS = [...POINT_KEYS, 'by', 'to'] as const;
export const BURNED_AT_KEYS = [...POINT_KEYS, 'by'] as const;
export const LAST_SALE_KEYS = [
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'ledger_index',
  'tx_hash',
  'executed_time',
] as const;

export const NFT_EVENT_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'tx_type',
  'executed_time',
  'event',
  'account',
  'from',
  'to',
  'offer_id',
  'is_sell_offer',
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'destination',
  'expiration',
  'broker',
  'broker_fee',
  'royalty_est',
  'removed_by',
  'uri',
] as const;

export const NFT_SALE_KEYS = [
  'nft_id',
  'kind',
  'issuer',
  'taxon',
  'serial',
  'ledger_index',
  'tx_index',
  'event_index',
  'tx_hash',
  'executed_time',
  'seller',
  'buyer',
  'mode',
  'amount',
  'currency',
  'amount_issuer',
  'converted_amount',
  'broker',
  'broker_fee',
  'royalty_est',
] as const;

export const NFT_OFFER_KEYS = [
  'offer_id',
  'is_sell_offer',
  'owner',
  'amount',
  'currency',
  'amount_issuer',
  'destination',
  'expiration',
  'created_ledger',
  'created_tx_hash',
  'created_time',
] as const;

/** The keys of the answers, in order: `coverage` is the key right after `result`. */
export const NFT_BODY_KEYS = ['result', 'coverage', 'nft'] as const;
export const NFT_EVENTS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'events'] as const;
export const NFT_OFFERS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'offers'] as const;

// -- the objects ---------------------------------------------------------------------------------------------------------

/** The place of a fact in the ledger history. */
export interface PointObject {
  ledger_index: number;
  tx_hash: string;
  executed_time: string;
}

export interface MintedObject extends PointObject {
  by: string;
  to: string;
}

export interface BurnedAtObject extends PointObject {
  by: string;
}

export interface LastSaleObject {
  amount: string;
  currency: string;
  amount_issuer?: string;
  converted_amount?: string;
  ledger_index: number;
  tx_hash: string;
  executed_time: string;
}

export interface NftObject {
  nft_id: string;
  kind: NftKind;
  issuer: string;
  taxon?: number;
  serial?: number;
  flags: number;
  transfer_fee?: number;
  owner?: string;
  owner_since?: PointObject;
  uri?: string;
  digest?: string;
  minted?: MintedObject;
  burned: boolean;
  burned_at?: BurnedAtObject;
  sale_count: number;
  last_sale?: LastSaleObject;
}

export interface NftEventObject {
  nft_id: string;
  kind: NftKind;
  issuer: string;
  taxon?: number;
  serial?: number;
  ledger_index: number;
  tx_index: number;
  event_index: number;
  tx_hash: string;
  tx_type: string;
  executed_time: string;
  event: NftEventName;
  account?: string;
  from?: string;
  to?: string;
  offer_id?: string;
  is_sell_offer?: boolean;
  amount?: string;
  currency?: string;
  amount_issuer?: string;
  converted_amount?: string;
  destination?: string;
  expiration?: string;
  broker?: string;
  broker_fee?: string;
  royalty_est?: string;
  removed_by?: string;
  uri?: string;
}

/** An event as a CSV row: every column, `null` where the event has none. */
export type NftEventCsvRow = { [K in (typeof NFT_EVENT_KEYS)[number]]: string | number | boolean | null };

export interface NftSaleObject {
  nft_id: string;
  kind: NftKind;
  issuer: string;
  taxon?: number;
  serial?: number;
  ledger_index: number;
  tx_index: number;
  event_index: number;
  tx_hash: string;
  executed_time: string;
  seller: string;
  buyer: string;
  mode: 'direct' | 'brokered';
  amount: string;
  currency: string;
  amount_issuer?: string;
  converted_amount?: string;
  broker?: string;
  broker_fee?: string;
  royalty_est?: string;
}

export interface NftOfferObject {
  offer_id: string;
  is_sell_offer: boolean;
  owner: string;
  amount: string;
  currency: string;
  amount_issuer?: string;
  destination?: string;
  expiration?: string;
  created_ledger: number;
  created_tx_hash: string;
  created_time: string;
}

/** The answer of the detail route. */
export interface NftBody {
  result: 'success';
  coverage: Coverage;
  nft: NftObject;
}

/** The answer of the history route: the events, or their CSV rows. */
export interface NftEventsBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  marker?: string;
  events: NftEventObject[] | NftEventCsvRow[];
}

export interface NftOffersBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  marker?: string;
  offers: NftOfferObject[];
}

// -- the builders --------------------------------------------------------------------------------------------------------

/** `{ [key]: value }` where the text is not empty, else nothing: an absent string is `''`. */
const text = <K extends string>(key: K, value: string): { [P in K]?: string } =>
  (value !== '' ? { [key]: value } : {}) as { [P in K]?: string };

/** The `taxon` and `serial` of the id: XRPL only (Xahau's id encodes neither). */
const identity = (row: {
  kind: NftKind;
  taxon: number | null;
  serial: number;
}): { taxon?: number; serial?: number } => ({
  ...(row.kind === 'nftoken' && row.taxon !== null && { taxon: row.taxon }),
  ...(row.kind === 'nftoken' && { serial: row.serial }),
});

const point = (p: { ledger_index: number; tx_hash: string; close_time: number }): PointObject => ({
  ledger_index: p.ledger_index,
  tx_hash: p.tx_hash,
  executed_time: fmtTime(p.close_time),
});

/** An NFT from its fold (`foldNftEvents`), with the converted price of its last sale when it has one. */
export function toNftObject(f: NftFold, lastSaleConverted?: string): NftObject {
  const { owner_since: since, minted, burned_at: burnedAt, last_sale: sale } = f;
  return {
    nft_id: f.nft_id,
    kind: f.kind,
    issuer: f.issuer,
    ...(f.kind === 'nftoken' && f.taxon !== null && { taxon: f.taxon }),
    ...(f.kind === 'nftoken' && { serial: f.serial }),
    flags: f.nft_flags,
    ...(f.kind === 'nftoken' && { transfer_fee: f.transfer_fee }),
    ...text('owner', f.owner),
    ...(since && { owner_since: point(since) }),
    ...text('uri', f.uri),
    ...text('digest', f.digest),
    ...(minted && { minted: { ...point(minted), by: minted.by, to: minted.to } }),
    burned: f.burned,
    ...(burnedAt && { burned_at: { ...point(burnedAt), by: burnedAt.by } }),
    sale_count: f.sale_count,
    ...(sale && {
      last_sale: {
        amount: sale.amount,
        currency: sale.currency,
        ...text('amount_issuer', sale.amount_issuer),
        ...(lastSaleConverted !== undefined && { converted_amount: lastSaleConverted }),
        ledger_index: sale.ledger_index,
        tx_hash: sale.tx_hash,
        executed_time: fmtTime(sale.close_time),
      },
    }),
  };
}

/**
 * An event from its row, with the converted price when it is a sale that has one. The row of `account_nft_events` is mapped
 * to this row first (its `actor` is the `account` of the event).
 */
export function toNftEventObject(r: NftEventsRow, converted?: string): NftEventObject {
  return {
    nft_id: r.nft_id,
    kind: r.kind,
    issuer: r.issuer,
    ...identity(r),
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    event_index: r.event_index,
    tx_hash: r.tx_hash,
    tx_type: r.tx_type,
    executed_time: fmtTime(r.close_time),
    event: r.event,
    ...text('account', r.account),
    ...text('from', r.from_account),
    ...text('to', r.to_account),
    ...text('offer_id', r.offer_id),
    // the events that name an offer (an offer's own, and the sale or transfer that accepted it) say which side it was on
    ...(r.offer_id !== '' && { is_sell_offer: r.is_sell_offer === 1 }),
    ...text('amount', r.amount),
    ...text('currency', r.currency),
    ...text('amount_issuer', r.amount_issuer),
    ...(r.event === 'sale' && converted !== undefined && { converted_amount: converted }),
    ...text('destination', r.destination),
    ...(r.expiration !== null && { expiration: fmtTime(r.expiration) }),
    ...text('broker', r.broker),
    ...text('broker_fee', r.broker_fee),
    ...text('royalty_est', r.royalty_est),
    ...text('removed_by', r.removed_by),
    ...text('uri', r.uri),
  };
}

/** The CSV row of an event: every column of `NFT_EVENT_KEYS`, in its order, `null` where the event has none. */
export function toNftEventCsvRow(event: NftEventObject): NftEventCsvRow {
  const values = event as unknown as Record<string, string | number | boolean | undefined>;
  return Object.fromEntries(NFT_EVENT_KEYS.map((key) => [key, values[key] ?? null])) as NftEventCsvRow;
}

/** A sale from its `sale` event (a row of `nft_events` or `nft_sales`), with its converted price when it has one. */
export function toNftSaleObject(r: NftEventsRow, converted?: string): NftSaleObject {
  return {
    nft_id: r.nft_id,
    kind: r.kind,
    issuer: r.issuer,
    ...identity(r),
    ledger_index: r.ledger_index,
    tx_index: r.tx_index,
    event_index: r.event_index,
    tx_hash: r.tx_hash,
    executed_time: fmtTime(r.close_time),
    seller: r.from_account,
    buyer: r.to_account,
    mode: r.broker !== '' ? 'brokered' : 'direct',
    amount: r.amount,
    currency: r.currency,
    ...text('amount_issuer', r.amount_issuer),
    ...(converted !== undefined && { converted_amount: converted }),
    ...text('broker', r.broker),
    ...text('broker_fee', r.broker_fee),
    ...text('royalty_est', r.royalty_est),
  };
}

/** An open offer from the `offer_create` event that made it. */
export function toNftOfferObject(created: NftEventsRow): NftOfferObject {
  return {
    offer_id: created.offer_id,
    is_sell_offer: created.is_sell_offer === 1,
    owner: created.account,
    amount: created.amount,
    currency: created.currency,
    ...text('amount_issuer', created.amount_issuer),
    ...text('destination', created.destination),
    ...(created.expiration !== null && { expiration: fmtTime(created.expiration) }),
    created_ledger: created.ledger_index,
    created_tx_hash: created.tx_hash,
    created_time: fmtTime(created.close_time),
  };
}

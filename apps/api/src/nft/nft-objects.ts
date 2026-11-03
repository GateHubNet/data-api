import {
  NftCollectionsRow,
  NftEventName,
  NftEventsRow,
  NftFold,
  NftKind,
  NftPoint,
  NftsRow,
} from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import type { CsvRow } from '../common/csv.interceptor';
import { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';

// moved to `common/csv.interceptor.ts` with D9, which needs them too; the NFT routes and D6's token list go on importing them from here
export { toCsvRow } from '../common/csv.interceptor';
export type { CsvRow };

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
 * Collection (`nft_collections`; `taxon` is the XRPL taxon, `first_mint` and `last_mint` are left out for a collection with no
 * indexed mint, `volume_native` is the exact text of the sum of the converted prices of its sales), in this order:
 *   issuer, taxon?, kind, supply, holders, minted, burned, sales_count, volume_native, first_mint?, last_mint?, last_ledger
 *
 * CollectionDay (one UTC day of a collection with a sale, a mint or a burn; `avg_price_native` is the volume over the sales that
 * have a converted price and `min_price_native` the lowest, both left out on a day with no such sale), in this order:
 *   date, sales_count, volume_native, avg_price_native?, min_price_native?, mints, burns
 *
 * Holder, in this order: owner, held
 *
 * `royalty_est` is the parser's value: `''` (left out) when no royalty applies, and `'0'` when one applies and rounds to nothing.
 *
 * A CSV has the same columns on every page whatever the objects of the page hold (a CSV takes its columns from the keys of the
 * rows, and a key that is left out would move them): `toNftEventCsvRow` gives every column, `null` (an empty cell) where the
 * event has none, and `toCsvRow` does the same for the other objects (a nested object's keys are joined with a dot, as the CSV of
 * every route writes them: `owner_since.ledger_index`).
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

export const COLLECTION_KEYS = [
  'issuer',
  'taxon',
  'kind',
  'supply',
  'holders',
  'minted',
  'burned',
  'sales_count',
  'volume_native',
  'first_mint',
  'last_mint',
  'last_ledger',
] as const;

export const COLLECTION_DAY_KEYS = [
  'date',
  'sales_count',
  'volume_native',
  'avg_price_native',
  'min_price_native',
  'mints',
  'burns',
] as const;

export const HOLDER_KEYS = ['owner', 'held'] as const;

/** The keys of the answers, in order: `coverage` is the key right after `result`. */
export const NFT_BODY_KEYS = ['result', 'coverage', 'nft'] as const;
export const NFT_EVENTS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'events'] as const;
export const NFT_OFFERS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'offers'] as const;
export const COLLECTIONS_BODY_KEYS = ['result', 'coverage', 'total', 'count', 'marker', 'collections'] as const;
export const COLLECTION_BODY_KEYS = ['result', 'coverage', 'collection'] as const;
export const NFTS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'nfts'] as const;
export const HOLDERS_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'holders'] as const;
export const SALES_BODY_KEYS = ['result', 'coverage', 'count', 'marker', 'sales'] as const;
export const STATS_BODY_KEYS = ['result', 'coverage', 'count', 'days'] as const;

/** The columns of the CSV of each list whose objects have optional keys or nested objects: every key, a nested one after a dot. */
const flat = (keys: readonly string[], nested: Record<string, readonly string[]> = {}): string[] =>
  keys.flatMap((key) => (key in nested ? nested[key].map((inner) => `${key}.${inner}`) : [key]));

export const NFT_CSV_COLUMNS = flat(NFT_KEYS, {
  owner_since: POINT_KEYS,
  minted: MINTED_KEYS,
  burned_at: BURNED_AT_KEYS,
  last_sale: LAST_SALE_KEYS,
});
export const COLLECTION_CSV_COLUMNS = flat(COLLECTION_KEYS, { first_mint: POINT_KEYS, last_mint: POINT_KEYS });

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

export interface CollectionObject {
  issuer: string;
  taxon?: number;
  kind: NftKind;
  supply: number;
  holders: number;
  minted: number;
  burned: number;
  sales_count: number;
  volume_native: string;
  first_mint?: PointObject;
  last_mint?: PointObject;
  last_ledger: number;
}

export interface CollectionDayObject {
  date: string;
  sales_count: number;
  volume_native: string;
  avg_price_native?: string;
  min_price_native?: string;
  mints: number;
  burns: number;
}

export interface HolderObject {
  owner: string;
  held: number;
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

export interface CollectionsBody {
  result: 'success';
  coverage: Coverage;
  total: number;
  count: number;
  marker?: string;
  collections: CollectionObject[] | CsvRow[];
}

export interface CollectionBody {
  result: 'success';
  coverage: Coverage;
  collection: CollectionObject;
}

export interface NftsBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  marker?: string;
  nfts: NftObject[] | CsvRow[];
}

export interface HoldersBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  marker?: string;
  holders: HolderObject[];
}

export interface SalesBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  marker?: string;
  sales: NftSaleObject[] | CsvRow[];
}

export interface StatsBody {
  result: 'success';
  coverage: Coverage;
  count: number;
  days: CollectionDayObject[] | CsvRow[];
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

/**
 * An `nfts` row as `toNftObject` takes an NFT: the fold of the list routes, which read the aggregate and fold nothing. The row has
 * the facts of the fold but `owners` (`[]`: the list does not name the owners an NFT had), `created_ledger` (left out, the lists
 * carry no per-item coverage) and the `tx_index` and `event_index` of the last sale. Those two are 0 here, unknown, and nothing
 * reads them: a list does not join the price of a sale, so `last_sale` of the list routes has no `converted_amount` (the detail
 * folds the events and has it). The times are unix seconds (`toUnixTimestamp(...) AS ...` in the read); the numbers may be text
 * (ClickHouse writes a UInt64 as one).
 */
export function nftFoldOfRow(row: NftsRow): NftFold {
  /** The place of a fact: all of ledger, hash and time are set when the fact is, as the aggregator writes them. */
  const at = (ledger: number | null, tx: string, time: number | null): NftPoint | undefined =>
    ledger !== null && time !== null
      ? { ledger_index: Number(ledger), tx_hash: tx, close_time: Number(time) }
      : undefined;
  const since = row.owner !== '' ? at(row.owner_ledger, row.owner_tx, row.owner_time) : undefined;
  const minted = at(row.minted_ledger, row.minted_tx, row.minted_time);
  const burned = Number(row.burned) === 1 ? at(row.burned_ledger, row.burned_tx, row.burned_time) : undefined;
  const sold = at(row.last_sale_ledger, row.last_sale_tx, row.last_sale_time);
  return {
    nft_id: row.nft_id,
    kind: row.kind,
    issuer: row.issuer,
    taxon: row.taxon === null ? null : Number(row.taxon),
    taxon_key: Number(row.taxon_key),
    serial: Number(row.serial),
    nft_flags: Number(row.nft_flags),
    transfer_fee: Number(row.transfer_fee),
    owner: row.owner,
    ...(since && { owner_since: since }),
    uri: row.uri,
    digest: row.digest,
    ...(minted && { minted: { ...minted, by: row.minted_by, to: row.minted_to } }),
    burned: Number(row.burned) === 1,
    ...(burned && { burned_at: { ...burned, by: row.burned_by } }),
    sale_count: Number(row.sale_count),
    ...(sold && {
      last_sale: {
        ...sold,
        tx_index: 0,
        event_index: 0,
        amount: row.last_sale_amount,
        currency: row.last_sale_currency,
        amount_issuer: row.last_sale_amount_issuer,
      },
    }),
    first_ledger: Number(row.first_ledger),
    last_ledger: Number(row.last_ledger),
    owners: [],
  };
}

/** A collection from its `nft_collections` row (the newest version), the times as unix seconds. */
export function toCollectionObject(r: Omit<NftCollectionsRow, 'version'>): CollectionObject {
  const mint = (ledger: number | null, tx: string, time: number | null): PointObject | undefined =>
    ledger !== null && time !== null
      ? point({ ledger_index: Number(ledger), tx_hash: tx, close_time: Number(time) })
      : undefined;
  const first = mint(r.first_mint_ledger, r.first_mint_tx, r.first_mint_time);
  const last = mint(r.last_mint_ledger, r.last_mint_tx, r.last_mint_time);
  return {
    issuer: r.issuer,
    ...(r.kind === 'nftoken' && r.taxon !== null && { taxon: Number(r.taxon) }),
    kind: r.kind,
    supply: Number(r.supply),
    holders: Number(r.holders),
    minted: Number(r.minted),
    burned: Number(r.burned),
    sales_count: Number(r.sales_count),
    volume_native: new BigNumber(r.volume_native).toFixed(),
    ...(first && { first_mint: first }),
    ...(last && { last_mint: last }),
    last_ledger: Number(r.last_ledger),
  };
}

/** What the stats read gives for one UTC day (text for what ClickHouse writes as UInt64 or Decimal). */
export interface CollectionDayRow {
  /** `YYYY-MM-DD` of the day, UTC. */
  day: string;
  sales_count: number | string;
  mints: number | string;
  burns: number | string;
  /** How many of the day's sales have a converted price. */
  priced: number | string;
  /** The sum of the converted prices (a Decimal's text), `null` when no sale of the day has one. */
  volume: string | null;
  /** The lowest converted price, `null` when no sale of the day has one. */
  min_price: string | null;
}

/** The decimals of the average price: those of every price in the native currency. */
const PRICE_DECIMALS = 6;

/**
 * A day of a collection. The average is the exact volume over the number of converted sales, rounded to the 6th decimal (half
 * up), as the prices are; with no converted sale the day has `volume_native` `0` and neither price field.
 */
export function toCollectionDayObject(r: CollectionDayRow): CollectionDayObject {
  const priced = Number(r.priced);
  const volume = new BigNumber(r.volume ?? 0);
  return {
    date: `${r.day}T00:00:00Z`,
    sales_count: Number(r.sales_count),
    volume_native: volume.toFixed(),
    ...(priced > 0 &&
      r.min_price !== null && {
        avg_price_native: volume.dividedBy(priced).decimalPlaces(PRICE_DECIMALS, BigNumber.ROUND_HALF_UP).toFixed(),
        min_price_native: new BigNumber(r.min_price).toFixed(),
      }),
    mints: Number(r.mints),
    burns: Number(r.burns),
  };
}

/** A holder from its `nft_collection_holders` row. */
export function toHolderObject(r: { owner: string; held: number | string }): HolderObject {
  return { owner: r.owner, held: Number(r.held) };
}

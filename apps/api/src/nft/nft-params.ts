import { CollectionKey, NetworkFamily, NFT_EVENTS, NFT_ROLES, NftEventName, NftRole } from '@gatehub/data-api-shared';
import { isValidClassicAddress } from 'ripple-address-codec';
import { badRequest } from '../common/errors';
import { dateParam, endExclusive, first, Query } from '../common/params';

/**
 * The parameters of the NFT routes (spec section 5): each function reads one parameter and answers 400 with the message of
 * the spec for a value that is none. The routes call them in the order of the spec's common checks (the id, the dates, the
 * events, the type, the marker), so the first mistake of a request is the one that is reported.
 */

/** An NFT id: 64 hex digits, any case (the ids are stored upper-case). */
const NFT_ID = /^[0-9A-Fa-f]{64}$/;

/** `:nft_id`, upper-cased. 400 `invalid nft id` for anything that is not 64 hex digits. */
export function nftIdParam(raw: string): string {
  if (!NFT_ID.test(raw)) throw badRequest('invalid nft id');
  return raw.toUpperCase();
}

/** `:issuer`, a classic address as it is. 400 `invalid issuer address` for a text that is none. */
export function issuerParam(raw: string): string {
  if (!isValidClassicAddress(raw)) throw badRequest('invalid issuer address');
  return raw;
}

const MAX_UINT32 = 4_294_967_295;

/** `:taxon`, a decimal UInt32 (digits only, at most 4294967295). 400 `invalid taxon` for `-1`, `1.5`, `4294967296`, `0x1`, ... */
export function taxonParam(raw: string): number {
  if (!/^\d{1,10}$/.test(raw)) throw badRequest('invalid taxon');
  const taxon = Number(raw);
  if (taxon > MAX_UINT32) throw badRequest('invalid taxon');
  return taxon;
}

/**
 * The collection a path names (spec 5.8): `/{issuer}/{taxon}` on XRPL, `/{issuer}` on Xahau, whose NFTs have no taxon (its
 * `taxon_key` is 0). The other family's form names no collection here: `undefined`, which the route answers with a 404
 * `collection not found` once the rest of the request is checked. The issuer is checked first (400 `invalid issuer address`),
 * then the taxon of an XRPL path (400 `invalid taxon`); the taxon of a Xahau path is not read.
 */
export function collectionKeyParam(
  family: NetworkFamily,
  issuerRaw: string,
  taxonRaw?: string,
): CollectionKey | undefined {
  const issuer = issuerParam(issuerRaw);
  const xrpl = family === 'xrpl';
  if (xrpl !== (taxonRaw !== undefined)) return undefined;
  return { issuer, taxon_key: taxonRaw === undefined ? 0 : taxonParam(taxonRaw) };
}

/**
 * The members of a comma list, each checked against `allowed` (spelt exactly so), without repeats and in the order the request
 * names them. A missing or empty param is none (`undefined`); a member that is not allowed (an empty one too: `sale,`) answers
 * 400 `error`.
 */
function listParam<T extends string>(q: Query, name: string, allowed: readonly T[], error: string): T[] | undefined {
  const raw = first(q, name);
  if (raw === undefined || raw === '') return undefined;
  const members = raw.split(',');
  if (!members.every((member) => (allowed as readonly string[]).includes(member))) throw badRequest(error);
  return [...new Set(members as T[])];
}

/** `event`: a comma list of the events the parser writes (`NFT_EVENTS`). 400 `invalid event` when a member is none. */
export function eventsParam(q: Query): NftEventName[] | undefined {
  return listParam(q, 'event', NFT_EVENTS, 'invalid event');
}

/** `role`: a comma list of the roles an account has in an event (`NFT_ROLES`). 400 `invalid role` when a member is none. */
export function rolesParam(q: Query): NftRole[] | undefined {
  return listParam(q, 'role', NFT_ROLES, 'invalid role');
}

/** The sides of an offer: the offers that sell the NFT, or those that bid for it. */
export const OFFER_TYPES = ['sell', 'buy'] as const;
export type NftOfferType = (typeof OFFER_TYPES)[number];

/** `type`: `sell` or `buy`; missing or empty is both. 400 `invalid type` for anything else. */
export function offerTypeParam(q: Query): NftOfferType | undefined {
  const raw = first(q, 'type');
  if (raw === undefined || raw === '') return undefined;
  if (!(OFFER_TYPES as readonly string[]).includes(raw)) throw badRequest('invalid type');
  return raw as NftOfferType;
}

/** The sorts of the list of collections. */
export const COLLECTION_SORTS = ['volume', 'supply', 'holders'] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/** `sort`: `volume`, `supply` or `holders`; missing or empty is `volume`. 400 `invalid sort` for anything else. */
export function collectionSortParam(q: Query): CollectionSort {
  const raw = first(q, 'sort');
  if (raw === undefined || raw === '') return 'volume';
  if (!(COLLECTION_SORTS as readonly string[]).includes(raw)) throw badRequest('invalid sort');
  return raw as CollectionSort;
}

/** `descending` of the list of collections, which is on by default (the biggest first): off only for `false`, in any case. */
export function collectionDescendingParam(q: Query): boolean {
  return !/false/i.test(first(q, 'descending') ?? '');
}

/** The longest window of the daily stats of a collection: a year, and the day of a leap year. */
export const STATS_MAX_DAYS = 366;

/**
 * The window of the daily stats of a collection (spec 5.10): `start` is required, `end` (the end of the period the text names) is
 * now when it is missing, and the window is at most `STATS_MAX_DAYS` days. The checks come in the order of the parameters, and
 * before any read: 400 `invalid start date format`, `start is required` (the wording the API has for a parameter that is missing),
 * `invalid end date format`, `invalid window - use at most 366 days`. `endExclusive` is left out when there is no `end`: the
 * window then reaches the newest ledger.
 */
export function statsWindowParam(q: Query, now: Date = new Date()): { start: Date; endExclusive?: Date } {
  const start = dateParam(q, 'start', 'invalid start date format');
  if (start === undefined) throw badRequest('start is required');
  const end = dateParam(q, 'end', 'invalid end date format');
  const endsAt = end === undefined ? undefined : endExclusive(end);
  if ((endsAt ?? now).getTime() - start.date.getTime() > STATS_MAX_DAYS * 86_400_000) {
    throw badRequest('invalid window - use at most 366 days');
  }
  return { start: start.date, ...(endsAt !== undefined && { endExclusive: endsAt }) };
}

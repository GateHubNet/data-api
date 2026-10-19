import { badRequest } from '../common/errors';
import { decodeMarker, KeysetKey, KeyValue, paginate } from '../common/pagination';
import { first, limitParam, Query } from '../common/params';
import type { Directory, DirectoryEntry } from './directory';

/** The scopes of the list (spec 3.2): the trusted UNL, or the trusted UNL and everyone seen in the last 24 hours. */
export const SCOPES = ['unl', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
/** The most characters of a search. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * The key of the list order, as a marker holds it: the group (0 for a validator with a domain, 1 for the others), the text it
 * is sorted by within the group (its domain in lower case, empty in group 1) and its master key. The types are those of the
 * row the order is written for (`compareEntries`).
 */
export const MARKER_KEYS: KeysetKey[] = [
  { column: 'group', type: 'UInt16' },
  { column: 'sort', type: 'String' },
  { column: 'key', type: 'String' },
];

export type ListMarker = readonly [group: number, sort: string, key: string];

/** What a request for the list asks, checked. */
export interface ListRequest {
  scope: Scope;
  /** The id of a publisher of the directory. */
  publisher?: string;
  /** The ID of an amendment: upper-case, 64 hex digits. */
  amendment?: string;
  /** The search, in lower case. */
  q?: string;
  marker?: ListMarker;
  limit: number;
}

/** The page of the list: the entries and the marker of the next page, if there is one. */
export interface ListPage {
  rows: DirectoryEntry[];
  marker?: string;
}

const AMENDMENT_ID = /^[0-9a-f]{64}$/i;

/** The text of a parameter, an empty one being as good as none. */
function text(query: Query, name: string): string | undefined {
  const value = first(query, name);
  return value === '' ? undefined : value;
}

/**
 * The parameters of the list, checked in the order of the specification: `scope`, `publisher`, `amendment`, `q`, `marker`,
 * `limit` (which never fails). An empty parameter is a missing one; parameters that are not known are ignored.
 *
 * `amendmentId` gives the ID of a name the amendments know, `undefined` for one they do not. A 64-digit hex string is an ID
 * in either case, known or not: nobody may have voted for it, and then no validator is listed.
 */
export function parseListQuery(
  query: Query,
  directory: Pick<Directory, 'publishers'>,
  amendmentId: (name: string) => string | undefined,
): ListRequest {
  const scope = text(query, 'scope') ?? 'unl';
  if (!(SCOPES as readonly string[]).includes(scope)) throw badRequest('invalid scope');

  const publisher = text(query, 'publisher');
  if (publisher !== undefined && !directory.publishers.some((each) => each.id === publisher)) {
    throw badRequest('invalid publisher');
  }

  const amendmentRef = text(query, 'amendment');
  const amendment =
    amendmentRef === undefined
      ? undefined
      : AMENDMENT_ID.test(amendmentRef)
        ? amendmentRef.toUpperCase()
        : amendmentId(amendmentRef);
  if (amendmentRef !== undefined && amendment === undefined) throw badRequest('invalid amendment');

  const search = text(query, 'q');
  if (search !== undefined && [...search].length > MAX_SEARCH_LENGTH) throw badRequest('invalid search');

  const values = decodeMarker(first(query, 'marker'), MARKER_KEYS);
  const marker = values === undefined ? undefined : checkedMarker(values);

  return {
    scope: scope as Scope,
    ...(publisher !== undefined && { publisher }),
    ...(amendment !== undefined && { amendment }),
    ...(search !== undefined && { q: search.toLowerCase() }),
    ...(marker !== undefined && { marker }),
    limit: limitParam(query, { def: DEFAULT_LIMIT, max: MAX_LIMIT }),
  };
}

/** A marker of the list holds group 0 or 1, and for group 1 the empty text: the sort text of the validators without a domain. */
function checkedMarker(values: KeyValue[]): ListMarker {
  const [group, sort, key] = values;
  if ((group !== 0 && group !== 1) || (group === 1 && sort !== '')) throw badRequest('invalid marker');
  return [group, sort as string, key as string];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The place of an entry in the list: the key of its order, as a marker writes it. The order of places (`comparePlaces`) is the
 * order of the directory (`compareEntries`), which the tests hold them to: a marker resumes where the page it came from ended.
 */
export function placeOf(entry: Pick<DirectoryEntry, 'key' | 'domain'>): ListMarker {
  return entry.domain === undefined ? [1, '', entry.key] : [0, entry.domain.toLowerCase(), entry.key];
}

/** The order of two places (`placeOf`): the group, then the sort text, then the key. */
export function comparePlaces(a: ListMarker, b: ListMarker): number {
  return a[0] - b[0] || compareText(a[1], b[1]) || compareText(a[2], b[2]);
}

/** Whether the entry is within the scope and passes every filter of the request (not the marker). */
function selected(entry: DirectoryEntry, request: ListRequest): boolean {
  if (!(entry.unl || (request.scope === 'all' && entry.seen24h))) return false;
  if (request.publisher !== undefined && !entry.unlLists.includes(request.publisher)) return false;
  if (request.amendment !== undefined) {
    const wanted = request.amendment;
    if (!(entry.record?.amendments ?? []).some((each) => each.toUpperCase() === wanted)) return false;
  }
  if (request.q !== undefined) {
    const needle = request.q;
    const found = [entry.domain, entry.key, entry.signingKey].some(
      (field) => field !== undefined && field.toLowerCase().includes(needle),
    );
    if (!found) return false;
  }
  return true;
}

/**
 * One page of the list (spec 3.2): the entries of `Directory.ordered` within the scope that pass the filters, after the
 * marker, at most `limit` of them, with the marker of the last one when more follow. The marker is the place in the order and
 * not a position, so it resumes after a row that has left the list since. The directory is shared and is only read: a page is
 * a new array.
 */
export function listValidators(directory: Pick<Directory, 'ordered'>, request: ListRequest): ListPage {
  const after = request.marker;
  const rows = directory.ordered.filter(
    (entry) => selected(entry, request) && (after === undefined || comparePlaces(placeOf(entry), after) > 0),
  );
  return paginate(rows, request.limit, (entry) => [...placeOf(entry)]);
}

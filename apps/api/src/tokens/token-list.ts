import { wantsCsv } from '../common/csv.interceptor';
import { badRequest } from '../common/errors';
import type { Coverage } from '../common/feature-coverage.service';
import { fmtTime } from '../common/format';
import { decodeMarker, encodeMarker, KeysetKey } from '../common/pagination';
import { first, limitParam, Query } from '../common/params';
import type { CsvRow } from '../nft/nft-objects';

/**
 * The list of every kind of token, `GET /v2/tokens` (spec 5.1 and 8): the query and its checks, the marker, and the envelope
 * of the answer. A kind is a `TokenListService` registered under `TOKEN_LIST_SERVICES`; D9 adds `'mpt'` to `TOKEN_KINDS` and its
 * service to the map and changes nothing else here.
 */

/** The kinds of token the list takes. */
export const TOKEN_KINDS = ['issued'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** The parameters of the list, checked. `q` is trimmed and left out when empty; `marker` is the text the client sent. */
export interface TokenListQuery {
  kind: TokenKind;
  minHolders: number;
  q?: string;
  limit: number;
  marker?: string;
  csv: boolean;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_MIN_HOLDERS = 1_000_000_000;
const MAX_SEARCH_LENGTH = 64;

/**
 * The query of the list. Checks, in order: `kind` (`issued` when missing or empty, else 400 `invalid kind - use: issued`),
 * `min_holders` (0 when missing or empty, else plain digits from 0 to 1,000,000,000, else `invalid min_holders`), `q` (trimmed,
 * 1 to 64 characters, else `invalid search`; empty is none) and `limit` (200, at most 1000). The marker is checked by
 * `decodeTokenListMarker`, where the service reads it.
 */
export function parseTokenListQuery(query: Query): TokenListQuery {
  const kind = kindParam(query);
  const minHolders = minHoldersParam(query);
  const q = searchParam(query);
  const limit = limitParam(query, { def: DEFAULT_LIMIT, max: MAX_LIMIT });
  const marker = first(query, 'marker');
  return {
    kind,
    minHolders,
    ...(q !== undefined && { q }),
    limit,
    ...(marker !== undefined && marker !== '' && { marker }),
    csv: wantsCsv(query),
  };
}

function kindParam(query: Query): TokenKind {
  const kind = first(query, 'kind');
  if (kind === undefined || kind === '') return TOKEN_KINDS[0];
  if (!(TOKEN_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(`invalid kind - use: ${TOKEN_KINDS.join(', ')}`);
  }
  return kind as TokenKind;
}

function minHoldersParam(query: Query): number {
  const raw = first(query, 'min_holders');
  if (raw === undefined || raw === '') return 0;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 0 && n <= MAX_MIN_HOLDERS)) throw badRequest('invalid min_holders');
  return n;
}

function searchParam(query: Query): string | undefined {
  const q = (first(query, 'q') ?? '').trim();
  if (q === '') return undefined;
  // characters, not UTF-16 units (as the search of the validators counts)
  if ([...q].length > MAX_SEARCH_LENGTH) throw badRequest('invalid search');
  return q;
}

/**
 * The columns of the marker: the kind, then the key of the order of the list (spec 5.1): `holders` descending, then the issuer, then
 * the token's own key (`currency` for an issued token). The kind keeps a marker of one kind from being read as another's.
 */
const MARKER_KEYS: KeysetKey[] = [
  { column: 'kind', type: 'String' },
  { column: 'holders', type: 'UInt32' },
  { column: 'issuer', type: 'String' },
  { column: 'key', type: 'String' },
];

/** The marker of a page: the base64url JSON of the kind and the `(holders, issuer, key)` of its last row. */
export function encodeTokenListMarker(kind: TokenKind, holders: number, issuer: string, key: string): string {
  return encodeMarker([kind, holders, issuer, key]);
}

/**
 * `[holders, issuer, key]` of a marker, or `undefined` for the first page. Anything else answers 400 `invalid marker`
 * (`decodeMarker`'s checks), a marker of another kind included.
 */
export function decodeTokenListMarker(
  marker: string | undefined,
  kind: TokenKind,
): [number, string, string] | undefined {
  const values = decodeMarker(marker, MARKER_KEYS);
  if (values === undefined) return undefined;
  if (values[0] !== kind) throw badRequest('invalid marker');
  return [values[1] as number, values[2] as string, values[3] as string];
}

/** A page of the list, as a service reads it: the generation it answers from, the counts and the rows. */
export interface TokenListPage<Row, Totals> {
  ledgerIndex: number;
  /** Unix seconds: the close time of `ledgerIndex`. */
  closeTime: number;
  totals: Totals;
  /** The tokens the filters select, on all pages. */
  total: number;
  /** With `min_holders` above 0: the tokens that match the search but have fewer holders. */
  totalBelow?: number;
  rows: Row[];
  /** The marker of the next page; none on the last. */
  marker?: string;
}

/** The list of one kind. */
export interface TokenListService<Row = unknown, Totals = unknown> {
  readonly kind: TokenKind;
  /** The coverage of the answer (issued tokens: the feature `issued_tokens` of `FeatureCoverageService`). */
  coverage(): Promise<Coverage>;
  /**
   * The page, or `undefined` while there is no data yet (the no-generation answer). A marker that is none of the kind's is a 400 that
   * the call throws before any read: the controller starts the list first, so that nothing else is read for a bad marker.
   */
  list(q: TokenListQuery): Promise<TokenListPage<Row, Totals> | undefined>;
  /** The row of the CSV for a row of the list: the kind's fixed columns, an empty cell where the row has no value. */
  csvRow(row: Row): CsvRow;
}

/** The token that provides the services of the list, a `ReadonlyMap<TokenKind, TokenListService>`. */
export const TOKEN_LIST_SERVICES = Symbol('TOKEN_LIST_SERVICES');

/** The keys of the answer of the list, in order. */
export const TOKEN_LIST_KEYS = [
  'result',
  'coverage',
  'kind',
  'ledger_index',
  'close_time',
  'totals',
  'total',
  'total_below',
  'count',
  'marker',
  'tokens',
] as const;

/**
 * The answer of the list for any kind (spec 5.1 and 8), the keys in the order of `TOKEN_LIST_KEYS`: `total_below` and `marker` are
 * left out where they are not there. With no page (`undefined`: no data yet) it is `{ result, coverage, kind, count: 0, tokens: [] }`.
 */
export function tokenListBody(
  kind: TokenKind,
  coverage: Coverage,
  page: TokenListPage<unknown, unknown> | undefined,
): Record<string, unknown> {
  if (page === undefined) return { result: 'success', coverage, kind, count: 0, tokens: [] };
  return {
    result: 'success',
    coverage,
    kind,
    ledger_index: page.ledgerIndex,
    close_time: fmtTime(page.closeTime),
    totals: page.totals,
    total: page.total,
    ...(page.totalBelow !== undefined && { total_below: page.totalBelow }),
    count: page.rows.length,
    ...(page.marker !== undefined && { marker: page.marker }),
    tokens: page.rows,
  };
}

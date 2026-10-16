import { Request, Response } from 'express';
import { ParsedUrlQueryInput, stringify } from 'node:querystring';
import { badRequest } from './errors';

/**
 * Keyset (cursor) pagination for ClickHouse lists.
 *
 * A list is ordered by its unique key, and a marker is that key for the last row of a page: the next page is every row
 * after it, found with one tuple comparison `(k1, k2) > ({k0:T}, {k1:T})`. No OFFSET and no FINAL, so a page far into
 * the list costs the same as the first. A marker never holds a DateTime: the time axis of the tables is `ledger_index`.
 *
 * The page itself is read with `readDistinctPage` (`@gatehub/data-api-shared`): a plain `ORDER BY <whole key> LIMIT`
 * inside, which ClickHouse stops after the page, and the dedupe of rows written twice (`LIMIT 1 BY`) outside it. Both in
 * one SELECT made ClickHouse read most of the range (Ruling R106).
 */

/** The ClickHouse types a marker can hold. The key of a list is made of these. */
export type KeyType = 'UInt32' | 'UInt16' | 'Int16' | 'UInt64' | 'String' | 'DateTime';

/** One column of the ORDER BY of a list. `column` is code, never user input: it is written into the SQL text. */
export interface KeysetKey {
  column: string;
  type: KeyType;
}

export type KeyValue = string | number;

const MAX_UINT32 = 4_294_967_295;

/** What a value of the type looks like in a marker: JSON numbers for the integers (and the seconds of a DateTime). */
const VALID: Record<KeyType, (v: unknown) => boolean> = {
  UInt16: (v) => isIntegerBetween(v, 0, 65_535),
  UInt32: (v) => isIntegerBetween(v, 0, MAX_UINT32),
  UInt64: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
  Int16: (v) => isIntegerBetween(v, -32_768, 32_767),
  DateTime: (v) => isIntegerBetween(v, 0, MAX_UINT32),
  String: (v) => typeof v === 'string',
};

function isIntegerBetween(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** The marker of a page: the base64url of the JSON array of the key values of its last row. */
export function encodeMarker(values: KeyValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

// What a client can hand back: base64url as `encodeMarker` writes it, and (tolerated) the padded or plain base64 forms.
const MARKER_CHARS = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * The key values of a marker, or `undefined` for the first page (no marker). Anything that is not a marker of this
 * list answers 400 `invalid marker`: text that is not base64, JSON that is not an array, a different number of values
 * than the key has, or a value that does not fit the type of its column.
 */
export function decodeMarker(marker: string | undefined, keys: KeysetKey[]): KeyValue[] | undefined {
  if (marker === undefined || marker === '') return undefined;
  if (!MARKER_CHARS.test(marker)) throw badRequest('invalid marker');

  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid marker');
  }
  if (!Array.isArray(values) || values.length !== keys.length || !values.every((v, i) => VALID[keys[i].type](v))) {
    throw badRequest('invalid marker');
  }
  return values as KeyValue[];
}

/**
 * The tuple comparison that selects the rows after a marker, and its bound params (`k0`, `k1`, ... or `<prefix>0`, ...).
 * Ascending lists continue with `>`, descending ones with `<`. No `values` (the first page) gives an empty clause.
 * `values` come from `decodeMarker`, which has checked them against the same keys.
 *
 * With more than one column the first one is also bounded on its own (`a >= x AND (a, b) > (x, y)`): ClickHouse (26.8)
 * does not narrow the granules it reads by a tuple comparison, only by the plain one, so without it a page deep into a
 * list read every row from the start of the range up to the marker and threw them away. Pass the keys that follow the
 * columns the query fixes with `=` (the account, the pair): the bound has to be on the first column that varies.
 */
export function keysetClause(
  keys: KeysetKey[],
  descending: boolean,
  values?: KeyValue[],
  prefix = 'k',
): { clause: string; params: Record<string, unknown> } {
  if (values === undefined) return { clause: '', params: {} };
  if (values.length !== keys.length) {
    // paging from the start instead would make a client loop on the same page for ever
    throw new Error(`the key has ${keys.length} columns but ${values.length} value(s) were given`);
  }
  const columns = keys.map((k) => k.column).join(', ');
  const placeholders = keys.map((k, i) => `{${prefix}${i}:${k.type}}`).join(', ');
  const params: Record<string, unknown> = {};
  values.forEach((v, i) => (params[`${prefix}${i}`] = v));
  const tuple = `(${columns}) ${descending ? '<' : '>'} (${placeholders})`;
  const bound = `${keys[0].column} ${descending ? '<=' : '>='} {${prefix}0:${keys[0].type}}`;
  return { clause: keys.length > 1 ? `${bound} AND ${tuple}` : tuple, params };
}

/** The column names of a key, in its order (what `readDistinctPage` takes as `orderBy` and `unique`). */
export function columnsOf(keys: KeysetKey[]): string[] {
  return keys.map((k) => k.column);
}

/** `a ASC, b ASC` (or DESC): every column of the key in the same direction. */
export function orderByClause(keys: KeysetKey[], descending: boolean): string {
  const direction = descending ? 'DESC' : 'ASC';
  return keys.map((k) => `${k.column} ${direction}`).join(', ');
}

/**
 * A page of a list that was fetched with `LIMIT limit + 1`. The extra row only tells that there is more: it is cut, and
 * the marker is the key of the last row that is returned, so the next page starts with the row that was cut. With
 * `limit` rows or fewer there is no marker.
 */
export function paginate<T>(rows: T[], limit: number, keyOf: (row: T) => KeyValue[]): { rows: T[]; marker?: string } {
  if (rows.length <= limit) return { rows };
  const page = rows.slice(0, limit);
  return { rows: page, marker: encodeMarker(keyOf(page[page.length - 1])) };
}

// Characters that stay percent-encoded in the Link: shown raw they would change the URL (`+` is a space, `&` and `#`
// end the value, ...) or the header (`<`, `>`, `"`).
const KEEP_ENCODED = new Set(['%', '&', '+', '#', '=', '<', '>', '"']);

/**
 * `querystring.unescape` of the original, minus what it got wrong: Ripple decoded everything, so a `start` of
 * `…T00:00:00%2B00:00` came back as a raw `+` that a client reads as a space, and a non-ASCII value could not be put in
 * a header at all. Printable ASCII is decoded (`:` and `,` stay readable, as they were), the rest stays encoded.
 */
function readable(search: string): string {
  return search.replace(/%([0-9A-Fa-f]{2})/g, (encoded, hex: string) => {
    const code = parseInt(hex, 16);
    const char = String.fromCharCode(code);
    return code > 0x20 && code < 0x7f && !KEEP_ENCODED.has(char) ? char : encoded;
  });
}

/**
 * `Link: <url>; rel="next"` of a page that has a next one: the URL the client asked for, with `marker` set (in place if
 * the request had one, at the end if not). As in the original (`utils.addLinkHeader`) the URL is built from the
 * scheme and host of the request and the parsed query, and for a repeated param only the first value is kept, which
 * is the one the route used. Without a marker (the last page) there is no header.
 */
export function setLinkHeader(req: Request, res: Response, marker?: string): void {
  if (marker === undefined) return;

  const query = JSON.parse(JSON.stringify(req.query)) as ParsedUrlQueryInput;
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) query[name] = value[0];
  }
  query.marker = marker;

  const next = `${req.protocol}://${req.get('host')}${req.path}?${readable(stringify(query))}`;
  res.links({ next });
}

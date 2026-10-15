/**
 * Keyset (cursor) pagination for ClickHouse.
 *
 * Replaces Elasticsearch `search_after`. A marker is an opaque base64 token encoding
 * the sort-key tuple of the last row returned. The next page is everything strictly
 * after that tuple, in the requested direction — O(1) deep pagination, no OFFSET.
 */
export interface SortKey {
  /** Column name (trusted — comes from service code, never user input). */
  column: string;
  /** ClickHouse param type for the bound value, e.g. 'DateTime', 'UInt32', 'String'. */
  type: string;
}

export function encodeMarker(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeMarker(marker?: string): unknown[] | undefined {
  if (!marker) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the keyset WHERE fragment and bound params for a marker.
 * Returns an empty fragment when there is no marker (first page).
 */
export function keysetClause(
  keys: SortKey[],
  descending: boolean,
  marker: string | undefined,
  paramPrefix = 'k',
): { clause: string; params: Record<string, unknown> } {
  const values = decodeMarker(marker);
  if (!values || values.length !== keys.length) {
    return { clause: '', params: {} };
  }
  const op = descending ? '<' : '>';
  const cols = keys.map((k) => k.column).join(', ');
  const placeholders = keys.map((k, i) => `{${paramPrefix}${i}:${k.type}}`).join(', ');
  const params: Record<string, unknown> = {};
  keys.forEach((k, i) => (params[`${paramPrefix}${i}`] = values[i]));
  return { clause: `(${cols}) ${op} (${placeholders})`, params };
}

export function orderByClause(keys: SortKey[], descending: boolean): string {
  const dir = descending ? 'DESC' : 'ASC';
  return keys.map((k) => `${k.column} ${dir}`).join(', ');
}

/** Builds the next marker from the last row of a page (undefined if the page wasn't full). */
export function nextMarker<T extends Record<string, unknown>>(
  rows: T[],
  keys: SortKey[],
  limit: number,
): string | undefined {
  if (rows.length < limit || rows.length === 0) return undefined;
  const last = rows[rows.length - 1];
  return encodeMarker(keys.map((k) => last[k.column]));
}

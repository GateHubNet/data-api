/** Standard list-response envelope used across the API. */
export interface ListResponse<T> {
  result: 'success';
  marker?: string;
  count: number;
  [key: string]: unknown;
}

export function listResponse<T>(itemsKey: string, items: T[], marker?: string): ListResponse<T> {
  return { result: 'success', marker, count: items.length, [itemsKey]: items };
}

/** unix `date` column from ClickHouse comes back as a string/number; normalise to ISO. */
export function toIso(value: string | number | Date): string {
  if (value instanceof Date) return value.toISOString();
  // ClickHouse DateTime in JSONEachRow is 'YYYY-MM-DD HH:MM:SS' (UTC).
  if (typeof value === 'string' && value.includes(' ')) return new Date(value.replace(' ', 'T') + 'Z').toISOString();
  const n = Number(value);
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

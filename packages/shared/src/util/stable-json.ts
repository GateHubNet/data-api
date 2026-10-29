/**
 * `JSON.stringify` with the keys of every object sorted, by the default string order, at every depth: equal values give
 * equal text whatever order their keys were written in. The text is built here, not by sorting a copy, because an object
 * lists its integer-like keys first and in numeric order whatever the order they were added in. Values are written as
 * `JSON.stringify` writes them (a key of `undefined` is left out, `toJSON` is called, a top-level `undefined` gives
 * `undefined`).
 */
export function stableStringify(value: unknown): string {
  return stringify(value) as string;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON(): unknown }).toJSON();
  }
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item) ?? 'null').join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const text = stringify((value as Record<string, unknown>)[key]);
      if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

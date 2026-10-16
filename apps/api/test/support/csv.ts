/**
 * The `Content-Disposition` of a CSV download named `<name>.csv` (RFC 6266, M12): the name quoted for old clients and in
 * UTF-8 (`filename*`) for the others. For the plain ASCII names the routes give (no quote, backslash or `'()*`); the
 * escaping of the rest is the unit test's (`csv.interceptor.spec.ts`).
 */
export function csvDisposition(name: string): string {
  if (/["\\'()*]|[^\x20-\x7e]/.test(name)) throw new Error(`csvDisposition is for plain names: ${name}`);
  return `attachment; filename="${name}.csv"; filename*=UTF-8''${encodeURIComponent(`${name}.csv`)}`;
}

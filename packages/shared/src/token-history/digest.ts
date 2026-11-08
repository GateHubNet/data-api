import { createHash } from 'node:crypto';

/**
 * The `digest` of a snapshot (spec 5.7): the lower-case hex SHA-256 of the UTF-8 text of one line `<holder>,<balance>\n` per holder,
 * in the order given (the route's is the byte order of the addresses). The same on every page of a snapshot, whatever `exclude`
 * says, so a page can be checked against the whole and the whole against a recount.
 */
export function snapshotDigest(lines: Iterable<{ holder: string; balance: string }>): string {
  const hash = createHash('sha256');
  for (const { holder, balance } of lines) hash.update(`${holder},${balance}\n`, 'utf8');
  return hash.digest('hex');
}

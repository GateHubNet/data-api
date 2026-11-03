import { createHash } from 'crypto';

/**
 * The hash of a synthetic transaction `name` made from the recorded transaction `hash`: the upper-case SHA-256 hex of
 * `<name>:<hash>`, 64 hex digits as a transaction hash is, so that it fits the columns of one, and none passes for a recorded one.
 */
export const syntheticHash = (name: string, hash: string): string =>
  createHash('sha256').update(`${name}:${hash}`).digest('hex').toUpperCase();

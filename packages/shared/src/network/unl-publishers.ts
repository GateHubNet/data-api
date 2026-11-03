import { decodeNodePublic } from 'ripple-address-codec';

/** One validator list publisher of `GH_UNL_PUBLISHERS`. */
export interface UnlPublisherConfig {
  /** The URL without its scheme and trailing slash (`vl.ripple.com`). */
  id: string;
  url: string;
  /** The publisher's master public key: 66 hex digits, upper case, starting `ED`, `02` or `03`. */
  publicKey: string;
}

const PUBLIC_KEY = /^(?:ED|0[23])[0-9A-F]{64}$/i;

/**
 * The id of the fixed validator list of `GH_UNL_VALIDATORS` among the publishers: the `publisher` of its `unl_lists` and
 * `unl_publishers` rows. A configured publisher cannot take it (`parseUnlPublishers`).
 */
export const LOCAL_PUBLISHER_ID = 'local';

/** A publisher's id: its URL without the scheme and the trailing slash (`https://vl.ripple.com/` is `vl.ripple.com`). */
export function publisherIdOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

function isHttpsUrl(text: string): boolean {
  if (!/^https:\/\/[^/\s]/i.test(text)) return false;
  try {
    return new URL(text).hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Parse `GH_UNL_PUBLISHERS`: comma separated `url=publicKey` pairs. An entry splits at its last `=` (a URL may hold
 * one), and the entry and both sides are trimmed; empty entries are skipped. The URL has to be `https://`, the key 66
 * hex digits starting `ED`, `02` or `03` (any case, returned in upper case), and no URL or key is listed twice. A
 * failure is `GH_UNL_PUBLISHERS entry <n>: <why>`, with `n` the 1-based position among the non-empty entries. An id that
 * is `local` in any case is reserved for the fixed list (`LOCAL_PUBLISHER_ID`). An empty text means no publishers.
 */
export function parseUnlPublishers(text: string): UnlPublisherConfig[] {
  const publishers: UnlPublisherConfig[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .forEach((entry, index) => {
      const fail = (why: string): never => {
        throw new Error(`GH_UNL_PUBLISHERS entry ${index + 1}: ${why}`);
      };
      const split = entry.lastIndexOf('=');
      if (split < 0) return fail('must be url=key');
      const url = entry.slice(0, split).trim();
      const key = entry.slice(split + 1).trim();
      if (!isHttpsUrl(url)) return fail('the URL must be an https:// URL');
      if (!PUBLIC_KEY.test(key)) return fail('the key must be 66 hex digits starting ED, 02 or 03');
      const id = publisherIdOf(url);
      if (id.toLowerCase() === LOCAL_PUBLISHER_ID) return fail(`the id "${LOCAL_PUBLISHER_ID}" is reserved`);
      const publicKey = key.toUpperCase();
      if (ids.has(id.toLowerCase())) return fail('repeats a URL');
      if (keys.has(publicKey)) return fail('repeats a key');
      ids.add(id.toLowerCase());
      keys.add(publicKey);
      publishers.push({ id, url, publicKey });
    });
  return publishers;
}

function isNodePublicKey(text: string): boolean {
  try {
    decodeNodePublic(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `GH_UNL_VALIDATORS`, the validator list fixed in the configuration: comma separated validator public keys in the
 * base58 form (`n…`), the entries trimmed and the empty ones skipped. Every entry has to decode with `decodeNodePublic`
 * and be listed once. A failure is `GH_UNL_VALIDATORS entry <n>: <why>`, with `n` the 1-based position among the
 * non-empty entries. The keys are returned as given, in the order given; an empty text means no validators.
 */
export function parseUnlValidators(text: string): string[] {
  const keys: string[] = [];
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .forEach((entry, index) => {
      const fail = (why: string): never => {
        throw new Error(`GH_UNL_VALIDATORS entry ${index + 1}: ${why}`);
      };
      if (!isNodePublicKey(entry)) return fail('must be a validator public key (n…)');
      if (keys.includes(entry)) return fail('repeats a key');
      keys.push(entry);
    });
  return keys;
}

/**
 * rippled's rule for the number of lists that must name a validator: 1 below three lists, else ⌊n / 2⌋ + 1. `lists` counts
 * the publishers' lists and the fixed list of `GH_UNL_VALIDATORS` (rippled counts its own local list the same way).
 */
export function defaultUnlThreshold(lists: number): number {
  return lists < 3 ? 1 : Math.floor(lists / 2) + 1;
}

import { isProperlyFormedTomlDomain } from '@gatehub/data-api-shared';
import { promises as dnsPromises } from 'node:dns';
import { readFileSync } from 'node:fs';
import { ClientRequest } from 'node:http';
import { Agent, request } from 'node:https';
import { isIP, isIPv4, isIPv6, LookupFunction } from 'node:net';
import { join } from 'node:path';

/**
 * The only way the syncer makes an outbound HTTP request to a public host (UNL publishers and the domains validators
 * claim). A URL comes from configuration or from a validator's signed manifest, so it is untrusted: a request must not
 * be made to a private, loopback or reserved address (SSRF), not even through a DNS name that points there, a DNS
 * answer that changes between the check and the connect (rebinding), or a redirect. The rules are those of the design
 * (§8.1), fixed in code; no environment variable loosens any of them. `SafeFetchTestOptions` exist for tests only and
 * are reached through a constructor argument.
 */

export type FetchFailure =
  | 'domain_invalid'
  | 'dns_error'
  | 'blocked_address'
  | 'connect_error'
  | 'tls_error'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'redirect_rejected';

export class SafeFetchError extends Error {
  /** The status code of an `http_status` failure. */
  readonly statusCode?: number;
  /** The blocked range (CIDR) of a `blocked_address` failure. */
  readonly addressClass?: string;

  constructor(
    readonly reason: FetchFailure,
    message: string,
    details: { statusCode?: number; addressClass?: string } = {},
  ) {
    super(message);
    this.name = 'SafeFetchError';
    this.statusCode = details.statusCode;
    this.addressClass = details.addressClass;
  }
}

export interface FetchLimits {
  /** The time for the whole fetch: DNS, every redirect, the handshake and the body. */
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export const UNL_FETCH_LIMITS: FetchLimits = { timeoutMs: 20_000, maxBytes: 1_048_576, maxRedirects: 3 };
export const tomlFetchLimits = (timeoutMs: number): FetchLimits => ({ timeoutMs, maxBytes: 262_144, maxRedirects: 3 });

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * For tests. Every field replaces one rule of the outside world, and nothing else:
 * - `resolve` answers instead of the DNS (it must give every address of the host);
 * - `allowAddress` is the address policy, replacing the blocked ranges (a test admits the loopback address its local
 *   server listens on);
 * - `ca` is the certificate authority to trust instead of the default store (the certificate is still verified, and
 *   still checked against the domain);
 * - `connectPort` is the TCP port connected to instead of 443 (the URL still has to be on port 443).
 */
export interface SafeFetchTestOptions {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  allowAddress?: (address: string, family: 4 | 6) => boolean;
  ca?: string | Buffer;
  connectPort?: number;
}

export const SAFE_FETCHER = Symbol('SAFE_FETCHER');

/** The addresses that are not public (spec §8.1). `::ffff:0:0/96` is not listed: it is judged by its IPv4. */
const BLOCKED_IPV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const BLOCKED_IPV6 = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
  '100::/64',
  '64:ff9b::/96',
  '2002::/16',
];

interface Range {
  cidr: string;
  bytes: number[];
  prefix: number;
}

function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number);
}

/** The 16 bytes of an IPv6 address in any valid spelling (the URL parser writes it in one form, with the IPv4 tail as hex). */
function ipv6Bytes(address: string): number[] {
  const host = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const [head, tail] = host.split('::');
  const groups = (part: string | undefined): string[] => (part === undefined || part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = groups(tail);
  const all =
    tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return all.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function rangesOf(cidrs: string[], bytesOf: (address: string) => number[]): Range[] {
  return cidrs.map((cidr) => {
    const [address, prefix] = cidr.split('/');
    return { cidr, bytes: bytesOf(address), prefix: Number(prefix) };
  });
}

const RANGES_V4 = rangesOf(BLOCKED_IPV4, ipv4Bytes);
const RANGES_V6 = rangesOf(BLOCKED_IPV6, ipv6Bytes);

function rangeContaining(ranges: Range[], bytes: number[]): string | undefined {
  return ranges.find((range) => {
    for (let bits = range.prefix, i = 0; bits > 0; bits -= 8, i++) {
      const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
      if ((bytes[i] & mask) !== (range.bytes[i] & mask)) return false;
    }
    return true;
  })?.cidr;
}

/**
 * The range (CIDR) that makes `address` unusable, or `undefined` for a public address. An IPv4-mapped IPv6 address
 * (`::ffff:0:0/96`, in dotted or hex form) is judged by its IPv4 and named by the IPv4 range. Throws a `TypeError` for
 * a string that is not an IP address: nothing unknown passes as public.
 */
export function blockedRangeOf(address: string): string | undefined {
  if (isIPv4(address)) return rangeContaining(RANGES_V4, ipv4Bytes(address));
  if (isIPv6(address)) {
    const bytes = ipv6Bytes(address);
    const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    return mapped ? rangeContaining(RANGES_V4, bytes.slice(12)) : rangeContaining(RANGES_V6, bytes);
  }
  throw new TypeError(`not an IP address: ${address}`);
}

/** All the A and AAAA records of the host. "No such record" is an empty answer; any other failure is a `dns_error`. */
async function resolveAddresses(host: string): Promise<ResolvedAddress[]> {
  const records = (family: 4 | 6, lookup: Promise<string[]>): Promise<ResolvedAddress[]> =>
    lookup.then(
      (addresses) => addresses.map((address) => ({ address, family })),
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return [];
        throw new SafeFetchError('dns_error', `the DNS lookup of ${host} failed: ${err.code ?? err.message}`);
      },
    );
  const [v4, v6] = await Promise.all([records(4, dnsPromises.resolve4(host)), records(6, dnsPromises.resolve6(host))]);
  return [...v4, ...v6];
}

/** The `User-Agent` of the fetches of the validators worker: `gatehub-data-api/<version of apps/syncer/package.json> (validators)`. */
export function validatorsUserAgent(): string {
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return `gatehub-data-api/${version} (validators)`;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The codes with which Node reports a failed TLS handshake or a rejected certificate. */
const TLS_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'PATH_LENGTH_EXCEEDED',
  'HOSTNAME_MISMATCH',
]);

function failureOf(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const code = String((err as NodeJS.ErrnoException | undefined)?.code ?? '');
  const message = err instanceof Error ? err.message : String(err);
  // A peer that does not speak TLS fails the handshake with the socket error EPROTO and an OpenSSL message
  if (TLS_CODES.has(code) || /^ERR_(TLS|SSL|OSSL)_/.test(code) || (code === 'EPROTO' && /SSL routines/.test(message))) {
    return new SafeFetchError('tls_error', `TLS failed: ${code}`);
  }
  return new SafeFetchError('connect_error', `the connection failed: ${code || message}`);
}

function parseUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return url;
  } catch {
    return undefined;
  }
}

/** `https:`, port 443 (the URL parser drops it, so none is left), no credentials. */
const isPlainHttps = (url: URL): boolean =>
  url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '';

/** Rejects with `timeout` when the signal aborts before the promise settles. */
function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new SafeFetchError('timeout', 'the fetch ran out of time'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

type Hop = { kind: 'body'; body: Buffer } | { kind: 'redirect'; location: string };

export class SafeFetcher {
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly allowAddress: (address: string, family: 4 | 6) => boolean;

  constructor(
    private readonly userAgent: string,
    private readonly test: SafeFetchTestOptions = {},
  ) {
    this.resolve = test.resolve ?? resolveAddresses;
    this.allowAddress = test.allowAddress ?? ((address) => blockedRangeOf(address) === undefined);
  }

  /** Fetches `url` (a 200 answer) within the limits; throws `SafeFetchError`. The returned `url` is the one that answered. */
  async get(url: string, limits: FetchLimits, accept: string): Promise<{ url: string; body: Buffer }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      return await this.follow(url, limits, accept, controller.signal);
    } catch (err) {
      throw failureOf(err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async follow(
    first: string,
    limits: FetchLimits,
    accept: string,
    signal: AbortSignal,
  ): Promise<{ url: string; body: Buffer }> {
    let url = parseUrl(first);
    if (url === undefined || !isPlainHttps(url) || !isProperlyFormedTomlDomain(url.hostname)) {
      throw new SafeFetchError(
        'domain_invalid',
        'the URL is not https on port 443 without credentials, or its host is not a domain',
      );
    }
    for (let redirects = 0; ; redirects++) {
      const addresses = await this.checkedAddresses(url.hostname, signal);
      const hop = await this.requestOnce(url, addresses, accept, limits.maxBytes, signal);
      if (hop.kind === 'body') return { url: url.href, body: hop.body };
      if (redirects >= limits.maxRedirects) throw new SafeFetchError('redirect_rejected', 'too many redirects');
      const target = parseUrl(hop.location, url.href);
      if (target === undefined || !isPlainHttps(target)) {
        throw new SafeFetchError(
          'redirect_rejected',
          'a redirect to another scheme or port, to a URL with credentials, or to none',
        );
      }
      if (!isProperlyFormedTomlDomain(target.hostname)) {
        throw new SafeFetchError('domain_invalid', 'a redirect to a host that is not a domain');
      }
      url = target;
    }
  }

  /** Every address of the host, all of them judged: one that is not public refuses the host. */
  private async checkedAddresses(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
    let answers: ResolvedAddress[];
    try {
      answers = await beforeAbort(
        Promise.resolve().then(() => this.resolve(host)),
        signal,
      );
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError(
        'dns_error',
        `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new SafeFetchError('dns_error', `${host} has no address`);
    }
    for (const { address, family } of answers) {
      if (typeof address !== 'string' || isIP(address) !== family) {
        throw new SafeFetchError('dns_error', `${host} resolved to something that is not an IPv${family} address`);
      }
    }
    for (const { address, family } of answers) {
      if (!this.allowAddress(address, family)) {
        const addressClass = blockedRangeOf(address);
        throw new SafeFetchError('blocked_address', `${host} resolves to ${address}, which is not a public address`, {
          addressClass,
        });
      }
    }
    return answers;
  }

  /**
   * One GET to the addresses that were checked: the connection's `lookup` answers with them, so there is no second DNS
   * query to rebind. SNI and `Host` are the domain, and the certificate is verified against it. The agent is made here
   * and not taken from the environment, which no proxy variable reaches. The connection is closed afterwards.
   */
  private requestOnce(
    url: URL,
    addresses: ResolvedAddress[],
    accept: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Hop> {
    return new Promise<Hop>((resolve, reject) => {
      const agent = new Agent({ keepAlive: false });
      let req: ClientRequest | undefined;
      let settled = false;
      const settle = (outcome: Hop | SafeFetchError): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        req?.destroy();
        agent.destroy();
        if (outcome instanceof SafeFetchError) reject(outcome);
        else resolve(outcome);
      };
      const onAbort = (): void => settle(new SafeFetchError('timeout', 'the fetch ran out of time'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });

      // The host is a domain (its top-level label is alphabetic), never an IP literal, so Node always asks this lookup.
      // It answers with the checked addresses only; with several, Node tries them in turn (`options.all`).
      const lookup: LookupFunction = (_host, options, callback) => {
        if (options.all) {
          callback(
            null,
            addresses.map(({ address, family }) => ({ address, family })),
          );
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      };

      try {
        req = request(
          {
            agent,
            host: url.hostname,
            port: this.test.connectPort ?? 443,
            servername: url.hostname,
            method: 'GET',
            path: url.pathname + url.search,
            headers: { Host: url.hostname, Accept: accept, 'User-Agent': this.userAgent, Connection: 'close' },
            lookup,
            // Always on, so that NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot turn it off. The identity
            // check is Node's own, against `servername`.
            rejectUnauthorized: true,
            ...(this.test.ca === undefined ? {} : { ca: this.test.ca }),
          },
          (res) => {
            res.on('error', (err) => settle(failureOf(err)));
            const status = res.statusCode ?? 0;
            if (REDIRECT_STATUSES.has(status)) {
              const location = res.headers.location;
              settle(
                location
                  ? { kind: 'redirect', location }
                  : new SafeFetchError('http_status', `the server answered ${status} without a location`, {
                      statusCode: status,
                    }),
              );
              return;
            }
            if (status !== 200) {
              settle(new SafeFetchError('http_status', `the server answered ${status}`, { statusCode: status }));
              return;
            }
            const declared = res.headers['content-length'];
            if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
              settle(new SafeFetchError('too_large', `the body is ${declared} bytes, the limit is ${maxBytes}`));
              return;
            }
            const chunks: Buffer[] = [];
            let received = 0;
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received > maxBytes) {
                settle(new SafeFetchError('too_large', `the body is over the limit of ${maxBytes} bytes`));
              } else {
                chunks.push(chunk);
              }
            });
            res.on('end', () => settle({ kind: 'body', body: Buffer.concat(chunks) }));
            res.on('close', () => {
              if (!res.complete) {
                settle(new SafeFetchError('connect_error', 'the connection closed before the body was complete'));
              }
            });
          },
        );
        req.on('error', (err) => settle(failureOf(err)));
        req.end();
      } catch (err) {
        settle(failureOf(err));
      }
    });
  }
}

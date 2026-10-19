import { promises as dnsPromises } from 'node:dns';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import httpsModule, { Agent, createServer, RequestOptions, Server } from 'node:https';
import { AddressInfo, createServer as createTcpServer, Server as NetServer, Socket } from 'node:net';
import { join } from 'node:path';
import { TEST_TLS } from '../../test/support/tls';
import {
  blockedRangeOf,
  FetchFailure,
  FetchLimits,
  SAFE_FETCHER,
  SafeFetcher,
  SafeFetchError,
  SafeFetchTestOptions,
  tomlFetchLimits,
  UNL_FETCH_LIMITS,
  validatorsUserAgent,
} from './safe-fetch';

const SYNCER_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Nothing here touches the real network: the `.example` hosts are resolved by the `resolve` option to servers on
 * 127.0.0.1 (the certificate of `TEST_TLS` lists them), and the default resolver is only exercised through stubs of
 * `dns.promises`. Every server a test starts is closed in `afterEach`.
 */

const UA = 'gatehub-data-api/9.9.9 (validators)';
const ACCEPT = 'application/json';

interface Seen {
  host: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
}

interface Started {
  server: Server;
  port: number;
  seen: Seen[];
  /** The TCP connections accepted (a TLS handshake that fails still counts). */
  connections: () => number;
  /** The SNI name of every TLS connection. */
  serverNames: string[];
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** What closes every server a test started (https, plain http and raw TCP alike). */
const closers: (() => Promise<void>)[] = [];

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function closerOf(server: Server | ReturnType<typeof createHttpServer>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
}

async function startServer(handler: Handler): Promise<Started> {
  const seen: Seen[] = [];
  const serverNames: string[] = [];
  let connections = 0;
  const server = createServer(TEST_TLS, (req, res) => {
    seen.push({ host: req.headers.host, path: req.url, headers: req.headers });
    handler(req, res);
  });
  server.on('connection', () => (connections += 1));
  server.on('secureConnection', (socket) => serverNames.push(String(socket.servername)));
  // A client that refuses the certificate or gives up in the middle of a handshake is expected in some tests.
  server.on('tlsClientError', () => undefined);
  closers.push(closerOf(server));
  const port = await listen(server);
  return { server, port, seen, connections: () => connections, serverNames };
}

/** A plain HTTP server: it answers a TLS ClientHello with a 400, so a TLS client fails the handshake. */
async function startPlainServer(): Promise<number> {
  const server = createHttpServer((_req, res) => res.end('plain'));
  closers.push(closerOf(server));
  return listen(server);
}

/** A TCP server that accepts and says nothing, so a TLS handshake with it never completes. */
async function startSilentServer(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  );
  return listen(server);
}

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface Made {
  fetcher: SafeFetcher;
  /** The hosts the resolver was asked for, in order. */
  resolved: string[];
}

interface MakeOptions extends Partial<SafeFetchTestOptions> {
  userAgent?: string;
  /** The address a host resolves to; every other host resolves to 127.0.0.1. */
  addresses?: Record<string, string>;
}

/**
 * A fetcher that resolves every host to 127.0.0.1 (or to the address `addresses` names), admits only 127.0.0.1, trusts
 * the test certificate and connects to `port`.
 */
function makeFetcher(port: number, { userAgent = UA, addresses = {}, ...options }: MakeOptions = {}): Made {
  const resolved: string[] = [];
  const fetcher = new SafeFetcher(userAgent, {
    resolve: async (host) => {
      resolved.push(host);
      const address = addresses[host] ?? '127.0.0.1';
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    },
    allowAddress: (address) => address === '127.0.0.1',
    ca: TEST_TLS.cert,
    connectPort: port,
    ...options,
  });
  return { fetcher, resolved };
}

async function failureOf(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SafeFetchError);
    return err as SafeFetchError;
  }
  throw new Error('expected the fetch to fail, it succeeded');
}

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition did not become true in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ok =
  (body: string): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  };

const redirectTo =
  (location: string, status = 302): Handler =>
  (_req, res) => {
    res.writeHead(status, { Location: location });
    res.end();
  };

describe('blockedRangeOf', () => {
  /** One address inside each range of the spec (§8.1), at its edges and in the middle. */
  const BLOCKED: [address: string, range: string][] = [
    ['0.0.0.0', '0.0.0.0/8'],
    ['0.255.255.255', '0.0.0.0/8'],
    ['10.1.2.3', '10.0.0.0/8'],
    ['10.255.255.255', '10.0.0.0/8'],
    ['100.64.0.1', '100.64.0.0/10'],
    ['100.127.255.255', '100.64.0.0/10'],
    ['127.0.0.1', '127.0.0.0/8'],
    ['127.255.255.254', '127.0.0.0/8'],
    ['169.254.1.1', '169.254.0.0/16'],
    ['169.254.169.254', '169.254.0.0/16'],
    ['172.16.0.0', '172.16.0.0/12'],
    ['172.31.255.255', '172.16.0.0/12'],
    ['192.0.0.8', '192.0.0.0/24'],
    ['192.0.2.55', '192.0.2.0/24'],
    ['192.88.99.1', '192.88.99.0/24'],
    ['192.168.0.1', '192.168.0.0/16'],
    ['192.168.255.255', '192.168.0.0/16'],
    ['198.18.0.0', '198.18.0.0/15'],
    ['198.19.0.1', '198.18.0.0/15'],
    ['198.51.100.7', '198.51.100.0/24'],
    ['203.0.113.200', '203.0.113.0/24'],
    ['224.0.0.1', '224.0.0.0/4'],
    ['239.255.255.255', '224.0.0.0/4'],
    ['240.0.0.1', '240.0.0.0/4'],
    ['255.255.255.255', '240.0.0.0/4'],
    ['::', '::/128'],
    ['::1', '::1/128'],
    ['fc00::', 'fc00::/7'],
    ['fd00::1', 'fc00::/7'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fc00::/7'],
    ['fe80::1', 'fe80::/10'],
    ['febf:ffff::1', 'fe80::/10'],
    ['ff02::1', 'ff00::/8'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ff00::/8'],
    ['2001:db8::1', '2001:db8::/32'],
    ['2001:db8:ffff:ffff::1', '2001:db8::/32'],
    ['100::1', '100::/64'],
    ['100::ffff:ffff:ffff:ffff', '100::/64'],
    ['64:ff9b::1', '64:ff9b::/96'],
    ['64:ff9b::808:808', '64:ff9b::/96'],
    ['2002::1', '2002::/16'],
    ['2002:ffff::1', '2002::/16'],
    // special-purpose ranges added as defence in depth (the design's nine are above)
    ['::2', '::/96'], // IPv4-compatible
    ['::7f00:1', '::/96'],
    ['::127.0.0.1', '::/96'],
    ['::ffff:ffff', '::/96'],
    ['0:0:0:0:0:0:ffff:ffff', '::/96'],
    ['64:ff9b:1::1', '64:ff9b:1::/48'], // local-use NAT64 (RFC 8215)
    ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:1::/48'],
    ['2001::1', '2001::/23'], // IETF protocol assignments: Teredo, ORCHID
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::/23'],
    ['2001:10::1', '2001::/23'],
    ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2001::/23'],
    ['fec0::1', 'fec0::/10'], // deprecated site-local
    ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fec0::/10'],
    ['3fff::1', '3fff::/20'], // documentation (RFC 9637)
    ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff::/20'],
    ['5f00::1', '5f00::/16'], // SRv6 SIDs
    ['5f00:ffff::1', '5f00::/16'],
    ['100:0:0:1::1', '100:0:0:1::/64'], // dummy prefix
    ['100:0:0:1:ffff:ffff:ffff:ffff', '100:0:0:1::/64'],
    // ::ffff:0:0/96 is judged by its IPv4, dotted and hex, in any spelling
    ['::ffff:127.0.0.1', '127.0.0.0/8'],
    ['::ffff:7f00:1', '127.0.0.0/8'],
    ['::FFFF:7F00:0001', '127.0.0.0/8'],
    ['0:0:0:0:0:ffff:7f00:1', '127.0.0.0/8'],
    ['0000:0000:0000:0000:0000:ffff:127.0.0.1', '127.0.0.0/8'],
    ['::ffff:10.0.0.1', '10.0.0.0/8'],
    ['::ffff:a00:1', '10.0.0.0/8'],
    ['::ffff:169.254.169.254', '169.254.0.0/16'],
    ['::ffff:0.0.0.0', '0.0.0.0/8'],
    // so is ::ffff:0:0:0/96 (SIIT, IPv4-translated), dotted and hex
    ['::ffff:0:127.0.0.1', '127.0.0.0/8'],
    ['::ffff:0:7f00:1', '127.0.0.0/8'],
    ['::FFFF:0:7F00:0001', '127.0.0.0/8'],
    ['0:0:0:0:ffff:0:7f00:1', '127.0.0.0/8'],
    ['0000:0000:0000:0000:ffff:0000:127.0.0.1', '127.0.0.0/8'],
    ['::ffff:0:10.0.0.1', '10.0.0.0/8'],
    ['::ffff:0:a00:1', '10.0.0.0/8'],
    ['::ffff:0:169.254.169.254', '169.254.0.0/16'],
    ['::ffff:0:0.0.0.0', '0.0.0.0/8'],
  ];

  it('refuses every blocked range', () => {
    for (const [address, range] of BLOCKED) {
      expect({ address, range: blockedRangeOf(address) }).toEqual({ address, range });
    }
  });

  it('names exactly the listed ranges: the 15 IPv4 and 9 IPv6 of the design, and 7 more IPv6', () => {
    const designed = [
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
    const added = ['::/96', '64:ff9b:1::/48', '2001::/23', 'fec0::/10', '3fff::/20', '5f00::/16', '100:0:0:1::/64'];
    expect(designed).toHaveLength(24);
    expect(added).toHaveLength(7);
    expect([...new Set(BLOCKED.map(([, range]) => range))].sort()).toEqual([...designed, ...added].sort());
  });

  it('keeps the names of :: and ::1 although ::/96 contains them', () => {
    expect(blockedRangeOf('::')).toBe('::/128');
    expect(blockedRangeOf('::1')).toBe('::1/128');
    expect(blockedRangeOf('::2')).toBe('::/96');
  });

  it('lets public addresses through, also next to a blocked range', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '172.15.255.255',
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '126.255.255.255',
      '128.0.0.0',
      '169.253.255.255',
      '169.255.0.0',
      '192.0.1.0',
      '192.167.255.255',
      '192.169.0.0',
      '198.17.255.255',
      '198.20.0.0',
      '198.51.101.0',
      '203.0.114.0',
      '223.255.255.255',
      '93.184.216.34',
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '2001:db9::1',
      '100:0:0:2::1', // next to the dummy prefix 100:0:0:1::/64
      '100:0:1::1',
      '64:ff9b:2::1', // next to 64:ff9b:1::/48
      '64:ff9b:0:1::1',
      '2001:200::1', // next to 2001::/23
      'fe7f:ffff::1', // next to fe80::/10 and fec0::/10
      'fbff::1',
      '3fff:1000::1', // next to 3fff::/20
      '3ffe::1',
      '5eff::1', // next to 5f00::/16
      '5f01::1',
      '::1:0:0', // outside ::/96: the 96th bit is set
      '2003::1',
      '2a00:1450:4001::1',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '::ffff:172.32.0.1',
      '::ffff:0:8.8.8.8', // SIIT with a public IPv4
      '::ffff:0:808:808',
      '::ffff:0:172.32.0.1',
      '::ffff:1:7f00:1', // neither mapped nor translated: the group between is not 0
    ]) {
      expect({ address, range: blockedRangeOf(address) }).toEqual({ address, range: undefined });
    }
  });

  it('judges a zone-scoped address by the address itself', () => {
    expect(blockedRangeOf('fe80::1%eth0')).toBe('fe80::/10');
  });

  it('fails closed on something that is not an IP address', () => {
    for (const bad of ['', 'localhost', '127.1', '0x7f.0.0.1', '1.2.3', '1.2.3.4.5', '::g', '[::1]', ' 8.8.8.8']) {
      expect(() => blockedRangeOf(bad)).toThrow(TypeError);
    }
  });
});

describe('the limits and tokens', () => {
  it('pins the limits of the spec', () => {
    expect(UNL_FETCH_LIMITS).toEqual({ timeoutMs: 20_000, maxBytes: 1_048_576, maxRedirects: 3 });
    expect(tomlFetchLimits(10_000)).toEqual({ timeoutMs: 10_000, maxBytes: 262_144, maxRedirects: 3 });
    expect(tomlFetchLimits(2_500).timeoutMs).toBe(2_500);
  });

  it('has an injection token and a user agent of the syncer version', () => {
    expect(typeof SAFE_FETCHER).toBe('symbol');
    expect(String(SAFE_FETCHER)).toBe('Symbol(SAFE_FETCHER)');
    expect(validatorsUserAgent()).toBe(`gatehub-data-api/${SYNCER_VERSION} (validators)`);
  });

  it('describes a failure by its reason', () => {
    const err = new SafeFetchError('http_status', 'the host answered 503', { statusCode: 503 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SafeFetchError');
    expect(err.reason).toBe('http_status');
    expect(err.statusCode).toBe(503);
    expect(err.addressClass).toBeUndefined();
    expect(err.message).toBe('the host answered 503');
  });
});

describe('SafeFetcher', () => {
  describe('a plain fetch', () => {
    it('returns the body and the final url', async () => {
      const s = await startServer(ok('{"a":1}'));
      const { fetcher, resolved } = makeFetcher(s.port);
      const got = await fetcher.get('https://a.example/vl.json', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.url).toBe('https://a.example/vl.json');
      expect(got.body).toBeInstanceOf(Buffer);
      expect(got.body.toString('utf8')).toBe('{"a":1}');
      expect(resolved).toEqual(['a.example']);
    });

    it('accepts an explicit :443, a query string and a mixed-case host', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port);
      const got = await fetcher.get('https://A.Example:443/.well-known/x.toml?y=1#frag', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.body.toString()).toBe('x');
      expect(s.seen[0]).toMatchObject({ host: 'a.example', path: '/.well-known/x.toml?y=1' });
    });

    it('sends the user agent, Accept and Host, and uses the domain as SNI', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port);
      await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, 'application/toml, text/plain;q=0.5');
      expect(s.seen).toHaveLength(1);
      const headers = s.seen[0].headers;
      expect(headers['user-agent']).toBe(UA);
      expect(headers['accept']).toBe('application/toml, text/plain;q=0.5');
      expect(headers['host']).toBe('a.example');
      expect(headers['cookie']).toBeUndefined();
      expect(headers['accept-encoding']).toBeUndefined();
      expect(s.serverNames).toEqual(['a.example']);
    });

    it('sends the user agent of the syncer version when it is given validatorsUserAgent()', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port, { userAgent: validatorsUserAgent() });
      await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
      expect(s.seen[0].headers['user-agent']).toBe(`gatehub-data-api/${SYNCER_VERSION} (validators)`);
    });
  });

  describe('the url', () => {
    it.each<[string, string]>([
      ['http, not https', 'http://a.example/'],
      ['another port', 'https://a.example:8443/'],
      ['port 80', 'https://a.example:80/'],
      ['a username', 'https://user@a.example/'],
      ['a username and a password', 'https://user:pass@a.example/'],
      ['a password only', 'https://:pass@a.example/'],
      ['an IPv4 literal', 'https://93.184.216.34/'],
      ['a private IPv4 literal', 'https://10.0.0.1/'],
      ['an IPv6 literal', 'https://[::1]/'],
      ['a single label', 'https://localhost/'],
      ['a dotted host that is not a TOML domain', 'https://a.b/'],
      ['an underscore in the host', 'https://a_b.example/'],
      ['a trailing dot', 'https://a.example./'],
      ['a decimal IPv4 spelling', 'https://2130706433/'],
      ['not a url', 'not a url'],
      ['an empty string', ''],
      ['another scheme', 'ftp://a.example/'],
      ['a file url', 'file:///etc/passwd'],
    ])('refuses %s as domain_invalid, resolving and connecting to nothing', async (_why, url) => {
      const s = await startServer(ok('x'));
      const { fetcher, resolved } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get(url, UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('domain_invalid');
      expect(resolved).toEqual([]);
      expect(s.connections()).toBe(0);
    });
  });

  describe('DNS', () => {
    it('refuses a host with one private address among public ones', async () => {
      const s = await startServer(ok('x'));
      let asked = 0;
      const fetcher = new SafeFetcher(UA, {
        resolve: async () => {
          asked += 1;
          return [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.1', family: 4 },
          ];
        },
        ca: TEST_TLS.cert,
        connectPort: s.port,
      });
      const err = await failureOf(fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 3_000 }, ACCEPT));
      expect(err.reason).toBe('blocked_address');
      expect(err.addressClass).toBe('10.0.0.0/8');
      expect(asked).toBe(1);
      expect(s.connections()).toBe(0);
    });

    it('refuses loopback by default and names the range', async () => {
      const s = await startServer(ok('x'));
      const fetcher = new SafeFetcher(UA, {
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        ca: TEST_TLS.cert,
        connectPort: s.port,
      });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'blocked_address', addressClass: '127.0.0.0/8' });
      expect(s.connections()).toBe(0);
    });

    it.each<[string, { address: string; family: 4 | 6 }, string]>([
      ['an IPv6 loopback', { address: '::1', family: 6 }, '::1/128'],
      ['a unique local address', { address: 'fd12:3456::1', family: 6 }, 'fc00::/7'],
      ['an IPv4-mapped loopback (dotted)', { address: '::ffff:127.0.0.1', family: 6 }, '127.0.0.0/8'],
      ['an IPv4-mapped loopback (hex)', { address: '::ffff:7f00:1', family: 6 }, '127.0.0.0/8'],
      ['the metadata address', { address: '169.254.169.254', family: 4 }, '169.254.0.0/16'],
      ['a NAT64 address', { address: '64:ff9b::808:808', family: 6 }, '64:ff9b::/96'],
    ])('refuses %s', async (_why, answer, range) => {
      const fetcher = new SafeFetcher(UA, { resolve: async () => [answer] });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'blocked_address', addressClass: range });
    });

    it('is dns_error when the resolver fails, answers nothing, or answers what is not an address', async () => {
      for (const resolve of [
        async () => {
          throw new Error('boom');
        },
        async () => [],
        async () => [{ address: 'not-an-ip', family: 4 as const }],
        async () => [{ address: '::1', family: 4 as const }],
        async () => [{ address: '8.8.8.8', family: 6 as const }],
      ]) {
        const err = await failureOf(
          new SafeFetcher(UA, { resolve }).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT),
        );
        expect(err.reason).toBe('dns_error');
      }
    });

    describe('the default resolver (dns.promises stubbed)', () => {
      const dnsError = (code: string): Error => Object.assign(new Error(`query ${code}`), { code });

      it('asks for the A and the AAAA records and refuses if any of them is not public', async () => {
        const a = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue(['93.184.216.34']);
        const aaaa = jest.spyOn(dnsPromises, 'resolve6').mockResolvedValue(['fc00::1']);
        const err = await failureOf(new SafeFetcher(UA).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err).toMatchObject({ reason: 'blocked_address', addressClass: 'fc00::/7' });
        expect(a).toHaveBeenCalledWith('a.example');
        expect(aaaa).toHaveBeenCalledWith('a.example');
      });

      it('accepts a host that has only A records (no data for AAAA) and connects to the checked address', async () => {
        const s = await startServer(ok('via dns'));
        jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue(['127.0.0.1']);
        jest.spyOn(dnsPromises, 'resolve6').mockRejectedValue(dnsError('ENODATA'));
        const fetcher = new SafeFetcher(UA, {
          allowAddress: (address) => address === '127.0.0.1',
          ca: TEST_TLS.cert,
          connectPort: s.port,
        });
        const got = await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
        expect(got.body.toString()).toBe('via dns');
      });

      it('judges the AAAA records of a host whose A lookup says not found, and refuses a link-local one', async () => {
        jest.spyOn(dnsPromises, 'resolve4').mockRejectedValue(dnsError('ENOTFOUND'));
        jest.spyOn(dnsPromises, 'resolve6').mockResolvedValue(['fe80::1']);
        const err = await failureOf(new SafeFetcher(UA).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err).toMatchObject({ reason: 'blocked_address', addressClass: 'fe80::/10' });
      });

      it('is dns_error when neither family has a record', async () => {
        jest.spyOn(dnsPromises, 'resolve4').mockRejectedValue(dnsError('ENOTFOUND'));
        jest.spyOn(dnsPromises, 'resolve6').mockRejectedValue(dnsError('ENODATA'));
        const err = await failureOf(new SafeFetcher(UA).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err.reason).toBe('dns_error');
      });

      it('is dns_error when one family fails for another reason, however the other answered', async () => {
        jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue(['93.184.216.34']);
        jest.spyOn(dnsPromises, 'resolve6').mockRejectedValue(dnsError('ESERVFAIL'));
        const err = await failureOf(new SafeFetcher(UA).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err.reason).toBe('dns_error');
      });
    });
  });

  describe('pinning', () => {
    it('connects to the address it checked', async () => {
      const s = await startServer(ok('pinned'));
      let calls = 0;
      const fetcher = new SafeFetcher(UA, {
        // the first answer is the server, any later one would be 127.0.0.2, where nothing listens
        resolve: async () => [{ address: calls++ === 0 ? '127.0.0.1' : '127.0.0.2', family: 4 }],
        allowAddress: (address) => address.startsWith('127.0.0.'),
        ca: TEST_TLS.cert,
        connectPort: s.port,
      });
      const got = await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.body.toString()).toBe('pinned');
      expect(calls).toBe(1);
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].headers.host).toBe('a.example');
      expect(s.serverNames).toEqual(['a.example']);
    });

    it('tries the next checked address when the first one does not answer', async () => {
      const s = await startServer(ok('second'));
      const fetcher = new SafeFetcher(UA, {
        resolve: async () => [
          { address: '127.0.0.9', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        allowAddress: (address) => address.startsWith('127.0.0.'),
        ca: TEST_TLS.cert,
        connectPort: s.port,
      });
      // 127.0.0.9 is loopback too, but nothing listens there: Linux refuses the connection at once, macOS (whose lo0 has
      // 127.0.0.1 only) does not answer, and Node moves on to the next address after its attempt timeout
      const got = await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.body.toString()).toBe('second');
    });

    it('connects to the address returned and to no other: 127.0.0.2 is not turned into the server at 127.0.0.1', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port, { addresses: { 'a.example': '127.0.0.2' }, allowAddress: () => true });
      const err = await failureOf(fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 500 }, ACCEPT));
      // nothing listens there: refused on Linux, silent (so a timeout) on macOS, where lo0 has 127.0.0.1 only
      expect(['connect_error', 'timeout']).toContain(err.reason);
      expect(s.connections()).toBe(0);
    });
  });

  describe('redirects', () => {
    const chain =
      (hops: Record<string, string>): Handler =>
      (req, res) => {
        const next = hops[String(req.headers.host)];
        if (next === undefined) return ok('end of the chain')(req, res);
        return redirectTo(next)(req, res);
      };

    it('checks every redirect from the top', async () => {
      const s = await startServer(
        chain({
          'a.example': 'https://b.example/one',
          'b.example': 'https://c.example/two',
          'c.example': 'https://d.example/three',
        }),
      );
      const { fetcher, resolved } = makeFetcher(s.port);
      const got = await fetcher.get('https://a.example/start', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.body.toString()).toBe('end of the chain');
      expect(got.url).toBe('https://d.example/three');
      expect(resolved).toEqual(['a.example', 'b.example', 'c.example', 'd.example']);
      expect(s.seen.map((r) => [r.host, r.path])).toEqual([
        ['a.example', '/start'],
        ['b.example', '/one'],
        ['c.example', '/two'],
        ['d.example', '/three'],
      ]);
      expect(s.serverNames).toEqual(['a.example', 'b.example', 'c.example', 'd.example']);
      for (const r of s.seen) expect(r.headers['user-agent']).toBe(UA);
    });

    it('rejects the fourth redirect without requesting its target', async () => {
      const s = await startServer(
        chain({
          'a.example': 'https://b.example/',
          'b.example': 'https://c.example/',
          'c.example': 'https://d.example/',
          'd.example': 'https://e.example/',
        }),
      );
      const { fetcher, resolved } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('redirect_rejected');
      expect(resolved).toEqual(['a.example', 'b.example', 'c.example', 'd.example']);
      expect(s.seen).toHaveLength(4);
    });

    it('takes the redirect budget from the limits', async () => {
      const s = await startServer(chain({ 'a.example': 'https://b.example/', 'b.example': 'https://c.example/' }));
      const { fetcher } = makeFetcher(s.port);
      const none: FetchLimits = { ...UNL_FETCH_LIMITS, maxRedirects: 0 };
      expect((await failureOf(fetcher.get('https://b.example/', none, ACCEPT))).reason).toBe('redirect_rejected');
      const one: FetchLimits = { ...UNL_FETCH_LIMITS, maxRedirects: 1 };
      expect((await failureOf(fetcher.get('https://a.example/', one, ACCEPT))).reason).toBe('redirect_rejected');
      expect((await fetcher.get('https://b.example/', one, ACCEPT)).url).toBe('https://c.example/');
    });

    it('follows 301, 302, 303, 307 and 308, and a relative location on the same host', async () => {
      for (const status of [301, 302, 303, 307, 308]) {
        const s = await startServer((req, res) =>
          req.url === '/moved' ? ok(`after ${status}`)(req, res) : redirectTo('/moved', status)(req, res),
        );
        const { fetcher } = makeFetcher(s.port);
        const got = await fetcher.get('https://a.example/start', UNL_FETCH_LIMITS, ACCEPT);
        expect(got.body.toString()).toBe(`after ${status}`);
        expect(got.url).toBe('https://a.example/moved');
      }
    });

    it.each<[string, string]>([
      ['http', 'http://b.example/'],
      ['another port', 'https://b.example:8443/'],
      ['port 80', 'https://b.example:80/'],
      ['a username', 'https://user@b.example/'],
      ['a username and a password', 'https://user:pass@b.example/'],
      ['another scheme', 'ftp://b.example/'],
      ['a scheme-relative url with another port', '//b.example:8443/'],
      ['an unparsable location', 'https://'],
    ])('rejects a redirect to %s as redirect_rejected', async (_why, location) => {
      const s = await startServer(redirectTo(location));
      const { fetcher, resolved } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('redirect_rejected');
      expect(resolved).toEqual(['a.example']);
      expect(s.seen).toHaveLength(1);
    });

    it.each<[string, string]>([
      ['a single label', 'https://localhost/'],
      ['an IPv4 literal', 'https://10.0.0.1/'],
      ['an IPv6 literal', 'https://[::1]/'],
      ['a name that is not a TOML domain', 'https://a.b/'],
    ])('rejects a redirect to %s as domain_invalid', async (_why, location) => {
      const s = await startServer(redirectTo(location));
      const { fetcher, resolved } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('domain_invalid');
      expect(resolved).toEqual(['a.example']);
      expect(s.seen).toHaveLength(1);
    });

    it('refuses a redirect to a host that resolves to a blocked address', async () => {
      const s = await startServer(redirectTo('https://internal.example/secret'));
      const { fetcher, resolved } = makeFetcher(s.port, { addresses: { 'internal.example': '10.0.0.1' } });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'blocked_address', addressClass: '10.0.0.0/8' });
      expect(resolved).toEqual(['a.example', 'internal.example']);
      expect(s.seen).toHaveLength(1); // the first hop only
    });

    it('refuses a redirect to a host that resolves to the metadata address, though the first host was admitted', async () => {
      const s = await startServer(redirectTo('https://b.example/'));
      const { fetcher } = makeFetcher(s.port, { addresses: { 'b.example': '169.254.169.254' } });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'blocked_address', addressClass: '169.254.0.0/16' });
      expect(s.seen).toHaveLength(1);
    });

    it('refuses a redirect to a host that has one blocked address among admitted ones', async () => {
      const s = await startServer(redirectTo('https://b.example/'));
      const { fetcher } = makeFetcher(s.port, {
        resolve: async (host) =>
          host === 'b.example'
            ? [
                { address: '127.0.0.1', family: 4 },
                { address: '192.168.1.1', family: 4 },
              ]
            : [{ address: '127.0.0.1', family: 4 }],
      });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'blocked_address', addressClass: '192.168.0.0/16' });
      expect(s.seen).toHaveLength(1);
    });

    it('is dns_error when the target of a redirect does not resolve', async () => {
      const s = await startServer(redirectTo('https://b.example/'));
      const { fetcher } = makeFetcher(s.port, {
        resolve: async (host) => {
          if (host === 'b.example') throw new Error('NXDOMAIN');
          return [{ address: '127.0.0.1', family: 4 }];
        },
      });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('dns_error');
    });

    it('is http_status for a redirect status without a location, or with an empty one', async () => {
      const bare = await startServer((_req, res) => {
        res.writeHead(302);
        res.end();
      });
      const err = await failureOf(makeFetcher(bare.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err).toMatchObject({ reason: 'http_status', statusCode: 302 });
      const empty = await startServer(redirectTo('', 301));
      const err2 = await failureOf(makeFetcher(empty.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err2).toMatchObject({ reason: 'http_status', statusCode: 301 });
    });

    it('is http_status for 300 and 304, which are not followed', async () => {
      for (const status of [300, 304]) {
        const s = await startServer(redirectTo('https://b.example/', status));
        const err = await failureOf(makeFetcher(s.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err).toMatchObject({ reason: 'http_status', statusCode: status });
        expect(s.seen).toHaveLength(1);
      }
    });

    it('keeps no cookies between the hops or between calls', async () => {
      const s = await startServer((req, res) => {
        if (req.headers.host === 'a.example') {
          res.writeHead(302, {
            Location: 'https://b.example/',
            'Set-Cookie': ['sid=1; Path=/; Secure', 'other=2; Domain=example'],
          });
          res.end();
          return;
        }
        ok('final')(req, res);
      });
      const { fetcher } = makeFetcher(s.port);
      expect((await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT)).body.toString()).toBe('final');
      await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
      expect(s.seen).toHaveLength(4);
      for (const r of s.seen) expect(r.headers.cookie).toBeUndefined();
    });
  });

  describe('the status', () => {
    it.each([404, 500, 503, 204, 201, 206, 401, 403, 429])(
      'is http_status with the status code for %d',
      async (status) => {
        const s = await startServer((_req, res) => {
          res.writeHead(status);
          res.end(status === 204 ? undefined : 'nope');
        });
        const { fetcher } = makeFetcher(s.port);
        const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
        expect(err.reason).toBe('http_status');
        expect(err.statusCode).toBe(status);
      },
    );
  });

  describe('the size', () => {
    it('is too_large for a 300 KiB body under the TOML limits, counted while it is read', async () => {
      const s = await startServer((_req, res) => {
        res.writeHead(200); // no Content-Length: chunked
        const chunk = Buffer.alloc(30 * 1024, 0x61);
        for (let i = 0; i < 10; i++) res.write(chunk);
        res.end();
      });
      const { fetcher } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://a.example/', tomlFetchLimits(10_000), 'application/toml'));
      expect(err.reason).toBe('too_large');
    });

    it('stops reading an endless body at the cap', async () => {
      let closed = false;
      const s = await startServer((_req, res) => {
        res.on('close', () => (closed = true));
        res.writeHead(200);
        const chunk = Buffer.alloc(16 * 1024, 0x61);
        const pump = (): void => {
          while (!res.destroyed && res.write(chunk));
          if (!res.destroyed) res.once('drain', pump);
        };
        pump();
      });
      const { fetcher } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('too_large');
      await until(() => closed);
    });

    it('is too_large for a Content-Length above the cap, before a byte of the body is read', async () => {
      const s = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': '2000000' });
        res.flushHeaders(); // and then nothing: the refusal must not wait for the body
      });
      const { fetcher } = makeFetcher(s.port);
      const started = Date.now();
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('too_large');
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('is too_large for a declared 262145 bytes under the TOML limits, and accepts exactly 262144', async () => {
      const exactly = await startServer((_req, res) => res.end(Buffer.alloc(262_144, 0x62)));
      const got = await makeFetcher(exactly.port).fetcher.get(
        'https://a.example/',
        tomlFetchLimits(10_000),
        'application/toml',
      );
      expect(got.body).toHaveLength(262_144);
      const over = await startServer((_req, res) => res.end(Buffer.alloc(262_145, 0x62)));
      const err = await failureOf(
        makeFetcher(over.port).fetcher.get('https://a.example/', tomlFetchLimits(10_000), 'application/toml'),
      );
      expect(err.reason).toBe('too_large');
    });

    it('accepts exactly the cap of a chunked body and refuses one byte more', async () => {
      const send =
        (size: number): Handler =>
        (_req, res) => {
          res.writeHead(200);
          res.write(Buffer.alloc(size - 1, 0x63));
          res.end(Buffer.alloc(1, 0x63));
        };
      const limits: FetchLimits = { timeoutMs: 5_000, maxBytes: 1_000, maxRedirects: 3 };
      const exactly = await startServer(send(1_000));
      expect((await makeFetcher(exactly.port).fetcher.get('https://a.example/', limits, ACCEPT)).body).toHaveLength(
        1_000,
      );
      const over = await startServer(send(1_001));
      expect((await failureOf(makeFetcher(over.port).fetcher.get('https://a.example/', limits, ACCEPT))).reason).toBe(
        'too_large',
      );
    });

    it('does not decode a body: it is returned as the bytes sent', async () => {
      const raw = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80]);
      const s = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end(raw);
      });
      const got = await makeFetcher(s.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
      expect(got.body.equals(raw)).toBe(true);
    });
  });

  describe('time', () => {
    it('is timeout for a server that never answers', async () => {
      const s = await startServer(() => undefined);
      const { fetcher } = makeFetcher(s.port);
      const started = Date.now();
      const err = await failureOf(fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 200 }, ACCEPT));
      expect(err.reason).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('is timeout for a body that stalls', async () => {
      const s = await startServer((_req, res) => {
        res.writeHead(200);
        res.write('{"partial":');
      });
      const err = await failureOf(
        makeFetcher(s.port).fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 300 }, ACCEPT),
      );
      expect(err.reason).toBe('timeout');
    });

    it('is timeout for a server that never completes the TLS handshake', async () => {
      const port = await startSilentServer();
      const err = await failureOf(
        makeFetcher(port).fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 300 }, ACCEPT),
      );
      expect(err.reason).toBe('timeout');
    });

    it('is timeout for a resolver that never answers', async () => {
      const fetcher = new SafeFetcher(UA, { resolve: () => new Promise(() => undefined) });
      const err = await failureOf(fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 200 }, ACCEPT));
      expect(err.reason).toBe('timeout');
    });

    it('spans the redirects: the time of the hops is added up', async () => {
      const slow =
        (then: Handler): Handler =>
        (req, res) => {
          const timer = setTimeout(() => then(req, res), 150);
          res.on('close', () => clearTimeout(timer));
        };
      const s = await startServer((req, res) =>
        req.headers.host === 'a.example'
          ? slow(redirectTo('https://b.example/'))(req, res)
          : slow(ok('late'))(req, res),
      );
      const { fetcher } = makeFetcher(s.port);
      // each hop answers in 150 ms, under 250 ms, but the two together do not
      const err = await failureOf(fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 250 }, ACCEPT));
      expect(err.reason).toBe('timeout');
      expect(
        (await fetcher.get('https://a.example/', { ...UNL_FETCH_LIMITS, timeoutMs: 2_000 }, ACCEPT)).body.toString(),
      ).toBe('late');
    });

    it('clears its timer after a success and after a failure', async () => {
      const s = await startServer((req, res) =>
        req.url === '/bad' ? (res.writeHead(500), res.end()) : ok('x')(req, res),
      );
      const { fetcher } = makeFetcher(s.port);
      const set = jest.spyOn(global, 'setTimeout');
      const clear = jest.spyOn(global, 'clearTimeout');
      const limits: FetchLimits = { ...UNL_FETCH_LIMITS, timeoutMs: 31_337 }; // a delay no other timer has
      await fetcher.get('https://a.example/good', limits, ACCEPT);
      await failureOf(fetcher.get('https://a.example/bad', limits, ACCEPT));
      const ours = set.mock.calls.flatMap((call, i) =>
        call[1] === 31_337 ? [set.mock.results[i].value as unknown] : [],
      );
      expect(ours).toHaveLength(2);
      for (const timer of ours) expect(clear.mock.calls.some(([cleared]) => cleared === timer)).toBe(true);
    });
  });

  describe('the connection', () => {
    it('is tls_error without the CA of the test certificate', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port, { ca: undefined });
      const err = await failureOf(fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('tls_error');
    });

    it('is tls_error for a host the certificate does not list, though the CA is trusted', async () => {
      const s = await startServer(ok('x'));
      const { fetcher } = makeFetcher(s.port);
      const err = await failureOf(fetcher.get('https://z.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('tls_error');
      expect(s.seen).toHaveLength(0);
    });

    it('is tls_error for a redirect to a host the certificate does not list', async () => {
      const s = await startServer(redirectTo('https://z.example/'));
      const err = await failureOf(makeFetcher(s.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('tls_error');
    });

    it('is tls_error for a server that does not speak TLS', async () => {
      const port = await startPlainServer();
      const err = await failureOf(makeFetcher(port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('tls_error');
    });

    it('is connect_error when nothing listens on the port', async () => {
      const s = await startServer(ok('x'));
      const { port } = s;
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
      const err = await failureOf(makeFetcher(port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('connect_error');
    });

    it('is connect_error when the connection is cut in the middle of the body', async () => {
      const s = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('0123456789');
        setTimeout(() => req.socket.destroy(), 20);
      });
      const err = await failureOf(makeFetcher(s.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('connect_error');
    });

    it('is connect_error when the server closes without an answer', async () => {
      const s = await startServer((req) => req.socket.destroy());
      const err = await failureOf(makeFetcher(s.port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('connect_error');
    });

    // Node reads HTTP_PROXY / HTTPS_PROXY only at startup (and only with NODE_USE_ENV_PROXY, for its global agents), and
    // jest's process.env is a copy, so setting them here cannot change what Node does. This test shows that a fetch goes
    // direct with the variables set; the real guard is the assertion below ('asks Node for a verified connection ...')
    // that every request gets an Agent of its own, which no environment proxy reaches.
    it('ignores the proxy variables of the environment', async () => {
      const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
      const saved = names.map((name) => [name, process.env[name]] as const);
      for (const name of names) process.env[name] = 'http://127.0.0.1:1';
      try {
        const s = await startServer(ok('direct'));
        const { fetcher } = makeFetcher(s.port);
        const got = await fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT);
        expect(got.body.toString()).toBe('direct');
        expect(s.seen).toHaveLength(1);
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });

    it('asks Node for a verified connection to the domain, with its own agent and no override of the identity check', async () => {
      const s = await startServer(ok('x'));
      const request = jest.spyOn(httpsModule, 'request');
      await makeFetcher(s.port).fetcher.get('https://a.example/path?q=1', UNL_FETCH_LIMITS, ACCEPT);
      expect(request).toHaveBeenCalledTimes(1);
      const options = request.mock.calls[0][0] as RequestOptions;
      // NODE_TLS_REJECT_UNAUTHORIZED=0 only changes the default of this option, so it is set explicitly
      expect(options.rejectUnauthorized).toBe(true);
      expect(options).not.toHaveProperty('checkServerIdentity');
      expect(options.servername).toBe('a.example');
      expect(options.host).toBe('a.example');
      expect(options.path).toBe('/path?q=1');
      expect(options.agent).toBeInstanceOf(Agent);
      expect(options.agent).not.toBe(httpsModule.globalAgent);
      expect(options.ca).toBe(TEST_TLS.cert);
    });

    it('trusts the default store, not a test CA, when it is given none', async () => {
      const s = await startServer(ok('x'));
      const request = jest.spyOn(httpsModule, 'request');
      await failureOf(
        makeFetcher(s.port, { ca: undefined }).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT),
      );
      expect(request.mock.calls[0][0]).not.toHaveProperty('ca');
    });
  });

  describe('the cause of a failure', () => {
    it('keeps the socket error of a connect_error', async () => {
      const s = await startServer(ok('x'));
      const { port } = s;
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
      const err = await failureOf(makeFetcher(port).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('connect_error');
      expect((err.cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    });

    it('keeps the TLS error of a tls_error', async () => {
      const s = await startServer(ok('x'));
      const err = await failureOf(
        makeFetcher(s.port, { ca: undefined }).fetcher.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT),
      );
      expect(err.reason).toBe('tls_error');
      expect((err.cause as NodeJS.ErrnoException).code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    });

    it('keeps the error of a resolver that failed', async () => {
      const boom = new Error('boom');
      const err = await failureOf(
        new SafeFetcher(UA, { resolve: async () => Promise.reject(boom) }).get(
          'https://a.example/',
          UNL_FETCH_LIMITS,
          ACCEPT,
        ),
      );
      expect(err.reason).toBe('dns_error');
      expect(err.cause).toBe(boom);
    });

    it('keeps the error of the default resolver', async () => {
      const servfail = Object.assign(new Error('queryA ESERVFAIL a.example'), { code: 'ESERVFAIL' });
      jest.spyOn(dnsPromises, 'resolve4').mockRejectedValue(servfail);
      jest.spyOn(dnsPromises, 'resolve6').mockResolvedValue([]);
      const err = await failureOf(new SafeFetcher(UA).get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT));
      expect(err.reason).toBe('dns_error');
      expect(err.cause).toBe(servfail);
    });

    it('is not enumerable, like the cause of a built-in error', async () => {
      const boom = new Error('boom');
      const err = await failureOf(
        new SafeFetcher(UA, { resolve: async () => Promise.reject(boom) }).get(
          'https://a.example/',
          UNL_FETCH_LIMITS,
          ACCEPT,
        ),
      );
      expect(Object.keys(err)).not.toContain('cause');
      expect(Object.getOwnPropertyDescriptor(err, 'cause')).toMatchObject({ value: boom, enumerable: false });
    });

    it('is absent when nothing underneath failed', async () => {
      const s = await startServer((req, res) => {
        if (req.url === '/hang') return;
        if (req.url === '/big') {
          res.writeHead(200, { 'Content-Length': '99' });
          res.flushHeaders();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const { fetcher } = makeFetcher(s.port);
      const blocked = new SafeFetcher(UA, { resolve: async () => [{ address: '10.0.0.1', family: 4 }] });
      const failures: [FetchFailure, () => Promise<unknown>][] = [
        ['http_status', () => fetcher.get('https://a.example/missing', UNL_FETCH_LIMITS, ACCEPT)],
        ['too_large', () => fetcher.get('https://a.example/big', { ...UNL_FETCH_LIMITS, maxBytes: 10 }, ACCEPT)],
        ['timeout', () => fetcher.get('https://a.example/hang', { ...UNL_FETCH_LIMITS, timeoutMs: 100 }, ACCEPT)],
        ['domain_invalid', () => fetcher.get('http://a.example/', UNL_FETCH_LIMITS, ACCEPT)],
        ['blocked_address', () => blocked.get('https://a.example/', UNL_FETCH_LIMITS, ACCEPT)],
      ];
      for (const [reason, run] of failures) {
        const err = await failureOf(run());
        expect(err.reason).toBe(reason);
        expect(err.cause).toBeUndefined();
      }
    });
  });

  it('keeps working after a failure: a fetcher holds no state between calls', async () => {
    const s = await startServer((req, res) =>
      req.url === '/bad' ? (res.writeHead(500), res.end()) : ok('fine')(req, res),
    );
    const { fetcher } = makeFetcher(s.port);
    const outcomes: string[] = [];
    for (const path of ['/bad', '/good', '/bad', '/good']) {
      try {
        outcomes.push((await fetcher.get(`https://a.example${path}`, UNL_FETCH_LIMITS, ACCEPT)).body.toString());
      } catch (err) {
        outcomes.push((err as SafeFetchError).reason);
      }
    }
    expect(outcomes).toEqual(['http_status', 'fine', 'http_status', 'fine']);
  });
});

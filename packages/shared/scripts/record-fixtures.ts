/**
 * Record raw ledgers from a public rippled/xahaud node as gzipped test fixtures.
 *
 *   pnpm --filter @gatehub/data-api-shared record:fixtures -- \
 *     --network xrpl|xahau --endpoint <wss url> --out <dir> \
 *     [--ledgers 1,2,3] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]
 *
 * Writes into `--out`:
 *   <index>.json.gz          the rippled `ledger` result (`transactions: true, expand: true`, API v1)
 *   server_definitions.json  the `server_definitions` result
 *   server_info.json         the `server_info` result
 *   manifest.json            what was recorded and which wanted types were found / missing
 *
 * `--want` walks back from the validated head, one ledger at a time, and keeps a ledger only when it holds a wanted
 * TransactionType that has not been found yet. It stops when every wanted type is found or `--scan` ledgers have been
 * checked. A type counts as found on its first `tesSUCCESS` transaction unless `--any-result` is given.
 * Requests are sequential with a small delay so public servers are not hammered. Missing types are not an error.
 *
 * `--unl` records the validator lists of the network's default publishers instead of ledgers:
 *
 *   pnpm --filter @gatehub/data-api-shared record:fixtures -- --unl --network xrpl|xahau [--out <dir>]
 *
 * It GETs each publisher URL of the network profile (Node `https`, at most 3 redirects) and writes the body exactly as
 * served to `<out>/<publisher id>.json`; `--out` defaults to `test/fixtures/<network>/unl`. It needs no node endpoint
 * and takes none of the ledger options.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { request } from 'https';
import { join, resolve } from 'path';
import { Client } from 'xrpl';
import { gzipSync } from 'zlib';
import { getNetworkProfile, parseUnlPublishers, publisherIdOf } from '../src/network';

export interface Options {
  network: 'xrpl' | 'xahau';
  /** Record the validator lists of the default publishers instead of ledgers. */
  unl: boolean;
  /** The node endpoint; empty with `unl`. */
  endpoint: string;
  out: string;
  ledgers: number[];
  want: string[];
  scan: number;
  delayMs: number;
  anyResult: boolean;
}

interface FoundType {
  ledger: number;
  hash: string;
}

type LedgerResult = {
  ledger: { ledger_index: string | number; transactions?: unknown[] } & Record<string, unknown>;
} & Record<string, unknown>;

const MAX_GZ_BYTES = 2 * 1024 * 1024;

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: record-fixtures --network xrpl|xahau --endpoint <wss url> --out <dir>\n' +
      '         [--ledgers a,b,c] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]\n' +
      '       record-fixtures --unl --network xrpl|xahau [--out <dir>]',
  );
  process.exit(2);
}

/** The options that only make sense when recording ledgers from a node. */
const LEDGER_ONLY_OPTIONS = ['endpoint', 'ledgers', 'want', 'scan', 'delay-ms', 'any-result'];

export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (name === 'any-result' || name === 'unl') {
      flags.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
    values[name] = value;
  }
  const known = new Set(['network', 'endpoint', 'out', 'ledgers', 'want', 'scan', 'delay-ms']);
  for (const name of Object.keys(values)) if (!known.has(name)) usage(`unknown option --${name}`);

  const network = values.network;
  if (network !== 'xrpl' && network !== 'xahau') usage('--network must be xrpl or xahau');
  if (flags.has('unl')) {
    for (const name of LEDGER_ONLY_OPTIONS) {
      if (name in values || flags.has(name)) usage(`--${name} is for recording ledgers, not with --unl`);
    }
    return {
      network,
      unl: true,
      endpoint: '',
      out: resolve(values.out ?? join(__dirname, '..', 'test', 'fixtures', network, 'unl')),
      ledgers: [],
      want: [],
      scan: 0,
      delayMs: 0,
      anyResult: false,
    };
  }
  if (!values.endpoint) usage('--endpoint is required');
  if (!values.out) usage('--out is required');

  const toInt = (name: string, text: string): number => {
    if (!/^\d+$/.test(text)) usage(`--${name} must be a non-negative integer, got "${text}"`);
    return Number(text);
  };
  const ledgers = values.ledgers ? values.ledgers.split(',').map((s) => toInt('ledgers', s.trim())) : [];
  const want = values.want
    ? values.want
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const scan = values.scan === undefined ? 0 : toInt('scan', values.scan);
  if (want.length > 0 && scan === 0) usage('--want needs --scan N (N > 0)');
  if (want.length === 0 && values.scan !== undefined) usage('--scan only makes sense with --want');
  if (want.length === 0 && ledgers.length === 0) usage('give --ledgers and/or --want');

  return {
    network,
    unl: false,
    endpoint: values.endpoint,
    out: resolve(values.out),
    ledgers,
    want,
    scan,
    delayMs: values['delay-ms'] === undefined ? 75 : toInt('delay-ms', values['delay-ms']),
    anyResult: flags.has('any-result'),
  };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Servers that throttle say how long to wait, e.g. "rate limit: units quota (50000 per 10s) exhausted, retry in ~5770ms". */
function retryHintMs(err: unknown): number {
  const match = /retry in ~(\d+)\s*ms/i.exec(errorText(err));
  return match ? Number(match[1]) + 250 : 0;
}

/**
 * Retry a request. Failures that carry a server-supplied wait (rate limiting) are retried for as long as it takes, up to
 * a generous cap; any other failure is retried a few times with a growing delay and then thrown.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const attempts = 6;
  const maxThrottled = 120;
  let failures = 0;
  let throttled = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const hint = retryHintMs(err) || (/too busy|slowDown/i.test(errorText(err)) ? 3_000 : 0);
      if (hint > 0 && throttled < maxThrottled) {
        throttled++;
        console.warn(`${label} throttled (${errorText(err)}); waiting ${hint} ms`);
        await sleep(hint);
        continue;
      }
      failures++;
      if (failures >= attempts) throw err;
      const wait = Math.min(500 * 2 ** (failures - 1), 8_000);
      console.warn(`${label} failed (${errorText(err)}); retry ${failures}/${attempts - 1} in ${wait} ms`);
      await sleep(wait);
    }
  }
}

/** rippled answers `ledgerNotFound` (or `lgrNotFound`) when the node behind the endpoint lacks that ledger. */
function isLedgerNotFound(err: unknown): boolean {
  return /ledgerNotFound|lgrNotFound/i.test(errorText(err));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const UNL_MAX_REDIRECTS = 3;
const UNL_MAX_BYTES = 1024 * 1024;
const UNL_TIMEOUT_MS = 20_000;

/**
 * Where a redirect leads: `location` resolved against the URL it came from. Only `https://` is followed, and at most
 * `UNL_MAX_REDIRECTS` times (`followed` redirects were taken already).
 */
export function redirectTarget(from: string, location: string | undefined, followed: number): string {
  if (followed >= UNL_MAX_REDIRECTS) throw new Error(`${from}: more than ${UNL_MAX_REDIRECTS} redirects`);
  if (!location) throw new Error(`${from}: redirect without a Location`);
  const target = new URL(location, from);
  if (target.protocol !== 'https:') throw new Error(`${from}: redirect to ${target.protocol}// is refused`);
  return target.href;
}

/** GET a URL with Node `https` and return the body as served: at most 3 redirects, 20 s, 1 MiB. */
function fetchBody(url: string, followed = 0): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, reject) => {
    const req = request(
      url,
      { method: 'GET', timeout: UNL_TIMEOUT_MS, headers: { Accept: 'application/json' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          try {
            const next = redirectTarget(url, res.headers.location, followed);
            fetchBody(next, followed + 1).then(resolveBody, reject);
          } catch (err) {
            reject(err);
          }
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`${url}: HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > UNL_MAX_BYTES) {
            req.destroy(new Error(`${url}: more than ${UNL_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolveBody(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${url}: no answer within ${UNL_TIMEOUT_MS} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Record the validator list of each default publisher of the network, byte for byte as served. */
async function recordUnlLists(options: Options): Promise<void> {
  const profile = getNetworkProfile(options.network);
  const publishers = parseUnlPublishers(profile.defaultUnlPublishers);
  mkdirSync(options.out, { recursive: true });
  let failed = 0;
  for (const publisher of publishers) {
    console.log(`GET ${publisher.url}`);
    try {
      const body = await fetchBody(publisher.url);
      const list = JSON.parse(body.toString('utf8')) as { public_key?: unknown; version?: unknown };
      if (typeof list.public_key !== 'string') throw new Error('the body is not a validator list (no public_key)');
      const file = `${publisherIdOf(publisher.url)}.json`;
      writeFileSync(join(options.out, file), body);
      console.log(`  wrote ${file} (${body.length} bytes, version ${String(list.version)}, key ${list.public_key})`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${publisher.url}: ${errorText(err)}`);
    }
  }
  console.log(`\nrecorded ${publishers.length - failed} of ${publishers.length} lists into ${options.out}`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.unl) return recordUnlLists(options);
  const profile = getNetworkProfile(options.network);
  mkdirSync(options.out, { recursive: true });

  const client = new Client(options.endpoint, { timeout: 30_000, connectionTimeout: 20_000 });
  // No api_version is sent: both xrpl and xahau servers default to API v1.
  const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!client.isConnected()) await client.connect();
    const response = await client.request(command as never);
    return response.result as unknown as Record<string, unknown>;
  };

  const found = new Map<string, FoundType>();
  const recorded: { ledger: number; bytes: number; gzipBytes: number }[] = [];
  let scanned = 0;
  const skipped: number[] = [];
  let head = 0;
  let hasDefinitions = false;
  let failure: unknown;
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    console.warn('\ninterrupt received: finishing the current request, then writing the manifest');
  });

  const wanted = new Set(options.want);
  const write = (name: string, body: string | Buffer) => writeFileSync(join(options.out, name), body);

  /** Record the ledger's wanted types and return true when it holds at least one that was not found yet. */
  const inspect = (result: LedgerResult): boolean => {
    let isNew = false;
    const index = Number(result.ledger.ledger_index);
    for (const entry of result.ledger.transactions ?? []) {
      const t = entry as Record<string, unknown> & { metaData?: { TransactionResult?: string } };
      const type = t.TransactionType as string;
      if (!wanted.has(type) || found.has(type)) continue;
      if (!options.anyResult && t.metaData?.TransactionResult !== 'tesSUCCESS') continue;
      found.set(type, { ledger: index, hash: t.hash as string });
      isNew = true;
      console.log(`  found ${type} in ledger ${index}: ${t.hash as string}`);
    }
    return isNew;
  };

  const keep = (result: LedgerResult) => {
    const index = Number(result.ledger.ledger_index);
    const json = JSON.stringify(result);
    const gz = gzipSync(json, { level: 9 });
    write(`${index}.json.gz`, gz);
    recorded.push({ ledger: index, bytes: json.length, gzipBytes: gz.length });
    const note = gz.length > MAX_GZ_BYTES ? '  WARNING: larger than 2 MB gzipped' : '';
    console.log(`  wrote ${index}.json.gz (${gz.length} bytes gzipped, ${json.length} raw)${note}`);
  };

  const fetchLedger = (index: number) =>
    withRetry(`ledger ${index}`, () =>
      request({ command: 'ledger', ledger_index: index, transactions: true, expand: true }),
    ) as Promise<LedgerResult>;

  try {
    console.log(`connecting to ${options.endpoint} (${options.network})`);
    await client.connect();

    const info = await withRetry('server_info', () => request({ command: 'server_info' }));
    const serverInfo = info.info as Record<string, unknown> & {
      network_id?: number;
      validated_ledger?: { seq: number };
    };
    // XRPL mainnet reports network_id 0 or omits it; Xahau reports 21337.
    if (serverInfo.network_id !== undefined && serverInfo.network_id !== profile.networkId) {
      throw new Error(
        `${options.endpoint} reports network_id ${serverInfo.network_id}, but --network ${options.network} is ${profile.networkId}`,
      );
    }
    head = serverInfo.validated_ledger?.seq ?? 0;
    if (!head) throw new Error(`${options.endpoint} has no validated ledger`);
    write('server_info.json', JSON.stringify(info, null, 2) + '\n');
    console.log(`validated head: ${head}`);

    try {
      const definitions = await withRetry('server_definitions', () => request({ command: 'server_definitions' }));
      write('server_definitions.json', JSON.stringify(definitions, null, 2) + '\n');
      hasDefinitions = true;
      console.log(`wrote server_definitions.json (${Object.keys(definitions).length} top-level keys)`);
    } catch (err) {
      console.warn(`WARNING: no server_definitions from this node (${errorText(err)}); continuing without them`);
    }

    for (const index of options.ledgers) {
      if (interrupted) break;
      console.log(`ledger ${index}`);
      const result = await fetchLedger(index);
      inspect(result);
      keep(result);
      await sleep(options.delayMs);
    }

    for (let i = 0; wanted.size > 0 && i < options.scan && found.size < wanted.size && !interrupted; i++) {
      const index = head - i;
      if (index < 1) break;
      scanned++;
      let result: LedgerResult;
      try {
        result = await fetchLedger(index);
      } catch (err) {
        if (!isLedgerNotFound(err)) throw err;
        console.warn(`  skipping ledger ${index}: the node does not have it`);
        skipped.push(index);
        await sleep(options.delayMs);
        continue;
      }
      if (scanned % 100 === 0) {
        console.log(`scanned ${scanned}/${options.scan} (at ledger ${index}), found ${found.size}/${wanted.size}`);
      }
      if (inspect(result) && !recorded.some((r) => r.ledger === index)) keep(result);
      await sleep(options.delayMs);
    }
  } catch (err) {
    failure = err;
    console.error(`stopped early: ${errorText(err)}`);
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore: the connection may already be gone
    }
  }

  const missing = options.want.filter((type) => !found.has(type));
  const manifest = {
    network: options.network,
    endpoint: options.endpoint,
    recorded_at: new Date().toISOString(),
    validated_head: head,
    scan_limit: options.scan,
    scanned,
    skipped,
    any_result: options.anyResult,
    complete: failure === undefined && !interrupted,
    server_definitions: hasDefinitions,
    found: Object.fromEntries([...found.entries()].sort(([a], [b]) => a.localeCompare(b))),
    missing,
    ledgers: recorded.sort((a, b) => a.ledger - b.ledger),
  };
  // A run that died before recording anything must not overwrite the manifest of an earlier good run.
  if (failure === undefined || recorded.length > 0) write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\nrecorded ${recorded.length} ledgers, scanned ${scanned} (head ${head})`);
  for (const [type, hit] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  FOUND   ${type}: ledger ${hit.ledger} tx ${hit.hash}`);
  }
  for (const type of missing) console.log(`  MISSING ${type}`);
  if (failure !== undefined) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(errorText(err));
    process.exit(1);
  });
}

/**
 * Record raw ledgers from a public rippled/xahaud node as gzipped test fixtures.
 *
 *   pnpm --filter @gatehub/data-api-shared record:fixtures -- \
 *     --network xrpl|xahau --endpoint <wss url> --out <dir> \
 *     [--ledgers 1,2,3] [--txs HASH,HASH] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]
 *
 * Writes into `--out`:
 *   <index>.json.gz          the rippled `ledger` result (`transactions: true, expand: true`, API v1)
 *   server_definitions.json  the `server_definitions` result
 *   server_info.json         the `server_info` result
 *   manifest.json            what was recorded and which wanted types were found / missing
 *
 * `--txs` looks each transaction up with `tx`, takes its `ledger_index` and records that whole ledger, the same way
 * `--ledgers` does (a ledger holding several of the transactions, or also listed in `--ledgers`, is fetched once). The
 * lookup must be validated and the recorded ledger must contain the hash, else the run stops naming it. The manifest gets
 * a `txs` map: hash -> { ledger, type, result }. A `cases` object already in the manifest of `--out` is carried over, so
 * hand-written case names survive a re-recording.
 *
 * `--want` walks back from the validated head, one ledger at a time, and keeps a ledger only when it holds a wanted
 * TransactionType that has not been found yet. It stops when every wanted type is found or `--scan` ledgers have been
 * checked. A type counts as found on its first `tesSUCCESS` transaction unless `--any-result` is given.
 * Requests are sequential with a small delay so public servers are not hammered. Missing types are not an error.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Client } from 'xrpl';
import { gzipSync } from 'zlib';
import { getNetworkProfile } from '../src/network';

export interface Options {
  network: string;
  endpoint: string;
  out: string;
  ledgers: number[];
  want: string[];
  scan: number;
  delayMs: number;
  anyResult: boolean;
  /** Transaction hashes (64 upper-case hex digits); the ledger of each one is recorded. */
  txs: string[];
}

interface FoundType {
  ledger: number;
  hash: string;
}

type LedgerResult = {
  ledger: { ledger_index: string | number; transactions?: unknown[] } & Record<string, unknown>;
} & Record<string, unknown>;

const MAX_GZ_BYTES = 2 * 1024 * 1024;

const USAGE =
  'usage: record-fixtures --network xrpl|xahau --endpoint <wss url> --out <dir>\n' +
  '         [--ledgers a,b,c] [--txs HASH,HASH] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]';

/** Bad command line. `main` prints it with the usage text and exits with status 2. */
export class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (name === 'any-result') {
      flags.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
    values[name] = value;
  }
  const known = new Set(['network', 'endpoint', 'out', 'ledgers', 'txs', 'want', 'scan', 'delay-ms']);
  for (const name of Object.keys(values)) if (!known.has(name)) usage(`unknown option --${name}`);

  const network = values.network;
  if (network !== 'xrpl' && network !== 'xahau') usage('--network must be xrpl or xahau');
  if (!values.endpoint) usage('--endpoint is required');
  if (!values.out) usage('--out is required');

  const toInt = (name: string, text: string): number => {
    if (!/^\d+$/.test(text)) usage(`--${name} must be a non-negative integer, got "${text}"`);
    return Number(text);
  };
  const ledgers = values.ledgers ? values.ledgers.split(',').map((s) => toInt('ledgers', s.trim())) : [];
  const txs =
    values.txs === undefined
      ? []
      : values.txs.split(',').map((entry) => {
          const hash = entry.trim();
          if (!/^[0-9a-fA-F]{64}$/.test(hash)) usage(`--txs needs 64-digit hex transaction hashes, got "${hash}"`);
          return hash.toUpperCase();
        });
  const want = values.want
    ? values.want
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const scan = values.scan === undefined ? 0 : toInt('scan', values.scan);
  if (want.length > 0 && scan === 0) usage('--want needs --scan N (N > 0)');
  if (want.length === 0 && values.scan !== undefined) usage('--scan only makes sense with --want');
  if (want.length === 0 && ledgers.length === 0 && txs.length === 0) usage('give --ledgers and/or --want and/or --txs');

  return {
    network,
    endpoint: values.endpoint,
    out: resolve(values.out),
    ledgers,
    want,
    scan,
    delayMs: values['delay-ms'] === undefined ? 75 : toInt('delay-ms', values['delay-ms']),
    anyResult: flags.has('any-result'),
    txs,
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
async function withRetry<T>(label: string, fn: () => Promise<T>, env: Pick<RecorderEnv, 'warn'>): Promise<T> {
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
        env.warn(`${label} throttled (${errorText(err)}); waiting ${hint} ms`);
        await sleep(hint);
        continue;
      }
      failures++;
      if (failures >= attempts) throw err;
      const wait = Math.min(500 * 2 ** (failures - 1), 8_000);
      env.warn(`${label} failed (${errorText(err)}); retry ${failures}/${attempts - 1} in ${wait} ms`);
      await sleep(wait);
    }
  }
}

/** rippled answers `ledgerNotFound` (or `lgrNotFound`) when the node behind the endpoint lacks that ledger. */
function isLedgerNotFound(err: unknown): boolean {
  return /ledgerNotFound|lgrNotFound/i.test(errorText(err));
}

/** rippled answers `txnNotFound` for a hash it does not know, or one in a ledger it does not hold. */
function isTxNotFound(err: unknown): boolean {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return data?.error === 'txnNotFound' || /txnNotFound|transaction not found/i.test(errorText(err));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** The hand-written `cases` of a manifest from an earlier run, so a re-recording does not wipe them. */
function readCases(manifestPath: string, env: Pick<RecorderEnv, 'warn'>): unknown {
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return undefined; // no earlier manifest
  }
  try {
    return (JSON.parse(text) as { cases?: unknown }).cases;
  } catch (err) {
    env.warn(`WARNING: ${manifestPath} is not valid JSON (${errorText(err)}); not carrying anything over`);
    return undefined;
  }
}

/** What the recorder needs from a node. `main` backs it with an `xrpl.Client`; tests pass a stub. */
export interface RecorderNode {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** One request; resolves to the `result` of the response, rejects with the server's error. */
  request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface RecorderEnv {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /** Polled between requests; true stops the run and still writes the manifest. */
  isInterrupted: () => boolean;
}

export interface RecorderRun {
  /** The error that stopped the run early, if any. */
  failure: unknown;
  interrupted: boolean;
  /** Undefined when a run died before recording anything (the manifest of an earlier run is then left alone). */
  manifest: Record<string, unknown> | undefined;
}

const consoleEnv: RecorderEnv = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
  isInterrupted: () => false,
};

export async function recordFixtures(
  options: Options,
  node: RecorderNode,
  envOverrides: Partial<RecorderEnv> = {},
): Promise<RecorderRun> {
  const env: RecorderEnv = { ...consoleEnv, ...envOverrides };
  const profile = getNetworkProfile(options.network);
  mkdirSync(options.out, { recursive: true });

  const request = (command: Record<string, unknown>) => node.request(command);

  const found = new Map<string, FoundType>();
  const txInfo: Record<string, { ledger: number; type: string; result: string | undefined }> = {};
  /** Transaction hashes of every ledger kept so far, to check a `tx` answer against the ledger that was recorded. */
  const ledgerHashes = new Map<number, Set<string>>();
  const recorded: { ledger: number; bytes: number; gzipBytes: number }[] = [];
  let scanned = 0;
  const skipped: number[] = [];
  let head = 0;
  let hasDefinitions = false;
  let failure: unknown;
  let interrupted = false;
  const stopRequested = () => {
    if (!interrupted && env.isInterrupted()) interrupted = true;
    return interrupted;
  };

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
      env.log(`  found ${type} in ledger ${index}: ${t.hash as string}`);
    }
    return isNew;
  };

  const keep = (result: LedgerResult) => {
    const index = Number(result.ledger.ledger_index);
    const json = JSON.stringify(result);
    const gz = gzipSync(json, { level: 9 });
    write(`${index}.json.gz`, gz);
    recorded.push({ ledger: index, bytes: json.length, gzipBytes: gz.length });
    ledgerHashes.set(
      index,
      new Set((result.ledger.transactions ?? []).map((t) => String((t as { hash?: string }).hash).toUpperCase())),
    );
    const note = gz.length > MAX_GZ_BYTES ? '  WARNING: larger than 2 MB gzipped' : '';
    env.log(`  wrote ${index}.json.gz (${gz.length} bytes gzipped, ${json.length} raw)${note}`);
  };

  const fetchLedger = (index: number) =>
    withRetry(
      `ledger ${index}`,
      () => request({ command: 'ledger', ledger_index: index, transactions: true, expand: true }),
      env,
    ) as Promise<LedgerResult>;

  try {
    env.log(`connecting to ${options.endpoint} (${options.network})`);
    await node.connect();

    const info = await withRetry('server_info', () => request({ command: 'server_info' }), env);
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
    env.log(`validated head: ${head}`);

    try {
      const definitions = await withRetry('server_definitions', () => request({ command: 'server_definitions' }), env);
      write('server_definitions.json', JSON.stringify(definitions, null, 2) + '\n');
      hasDefinitions = true;
      env.log(`wrote server_definitions.json (${Object.keys(definitions).length} top-level keys)`);
    } catch (err) {
      env.warn(`WARNING: no server_definitions from this node (${errorText(err)}); continuing without them`);
    }

    for (const index of options.ledgers) {
      if (stopRequested()) break;
      env.log(`ledger ${index}`);
      const result = await fetchLedger(index);
      inspect(result);
      keep(result);
      await sleep(options.delayMs);
    }

    for (const hash of new Set(options.txs)) {
      if (stopRequested()) break;
      env.log(`tx ${hash}`);
      const lookup = await withRetry(
        `tx ${hash}`,
        async () => {
          try {
            return await request({ command: 'tx', transaction: hash });
          } catch (err) {
            // Not retried: asking again does not make an unknown hash known.
            if (isTxNotFound(err)) return undefined;
            throw err;
          }
        },
        env,
      );
      if (!lookup) {
        throw new Error(
          `transaction ${hash} not found on ${options.endpoint} (txnNotFound: unknown hash, or the node does not hold its ledger)`,
        );
      }
      const ledger = Number(lookup.ledger_index);
      if (!Number.isInteger(ledger) || ledger < 1) {
        throw new Error(`transaction ${hash}: ${options.endpoint} did not say which ledger it is in`);
      }
      if (lookup.validated !== true) {
        throw new Error(`transaction ${hash} is not validated yet (ledger ${ledger}); record it once it is`);
      }
      if (!ledgerHashes.has(ledger)) {
        const result = await fetchLedger(ledger);
        inspect(result);
        keep(result);
        await sleep(options.delayMs);
      }
      if (!ledgerHashes.get(ledger)?.has(hash)) {
        throw new Error(`transaction ${hash} is not in the ledger ${ledger} that ${options.endpoint} gave for it`);
      }
      const meta = (lookup.meta ?? lookup.metaData) as { TransactionResult?: string } | undefined;
      txInfo[hash] = { ledger, type: String(lookup.TransactionType), result: meta?.TransactionResult };
    }

    for (let i = 0; wanted.size > 0 && i < options.scan && found.size < wanted.size && !stopRequested(); i++) {
      const index = head - i;
      if (index < 1) break;
      scanned++;
      let result: LedgerResult;
      try {
        result = await fetchLedger(index);
      } catch (err) {
        if (!isLedgerNotFound(err)) throw err;
        env.warn(`  skipping ledger ${index}: the node does not have it`);
        skipped.push(index);
        await sleep(options.delayMs);
        continue;
      }
      if (scanned % 100 === 0) {
        env.log(`scanned ${scanned}/${options.scan} (at ledger ${index}), found ${found.size}/${wanted.size}`);
      }
      if (inspect(result) && !recorded.some((r) => r.ledger === index)) keep(result);
      await sleep(options.delayMs);
    }
  } catch (err) {
    failure = err;
    env.error(`stopped early: ${errorText(err)}`);
  } finally {
    try {
      await node.disconnect();
    } catch {
      // ignore: the connection may already be gone
    }
  }

  const missing = options.want.filter((type) => !found.has(type));
  const cases = readCases(join(options.out, 'manifest.json'), env);
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
    txs: txInfo,
    ...(cases === undefined ? {} : { cases }),
    ledgers: recorded.sort((a, b) => a.ledger - b.ledger),
  };
  // A run that died before recording anything must not overwrite the manifest of an earlier good run.
  const writeManifest = failure === undefined || recorded.length > 0;
  if (writeManifest) write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  env.log(`\nrecorded ${recorded.length} ledgers, scanned ${scanned} (head ${head})`);
  for (const [type, hit] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    env.log(`  FOUND   ${type}: ledger ${hit.ledger} tx ${hit.hash}`);
  }
  for (const type of missing) env.log(`  MISSING ${type}`);
  return { failure, interrupted, manifest: writeManifest ? manifest : undefined };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`error: ${err.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  const client = new Client(options.endpoint, { timeout: 30_000, connectionTimeout: 20_000 });
  // No api_version is sent: both xrpl and xahau servers default to API v1.
  const node: RecorderNode = {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    request: async (command) => {
      if (!client.isConnected()) await client.connect();
      const response = await client.request(command as never);
      return response.result as unknown as Record<string, unknown>;
    },
  };

  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    console.warn('\ninterrupt received: finishing the current request, then writing the manifest');
  });

  const run = await recordFixtures(options, node, { isInterrupted: () => interrupted });
  if (run.failure !== undefined) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(errorText(err));
    process.exit(1);
  });
}

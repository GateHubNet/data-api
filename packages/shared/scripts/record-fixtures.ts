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
 * a `txs` map: hash -> { ledger, type, result }. What an earlier run left in the manifest of `--out` is merged in, so a run
 * that adds to the directory keeps the rest: its `cases` (hand-written case names), its `txs` and its `ledgers` (the
 * latter two only while the `<index>.json.gz` files are still there). Everything else describes the current run.
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
 *
 * `--network-state` records what the validators worker asks the node for (spec 2.3) instead of ledgers:
 *
 *   pnpm --filter @gatehub/data-api-shared record:fixtures -- --network-state --network xrpl|xahau --endpoint <wss url>
 *     [--out <dir>] [--ledger <n>]
 *
 * It asks for the Amendments object at the validated ledger (or at ledger `--ledger`, which the node has to still hold:
 * the way to record a ledger with a disabled validator), then for the NegativeUNL and FeeSettings objects at that same
 * ledger, and for `server_info` and `feature` (both as of now), at most 2 requests in flight, and writes the answers as the node served
 * them to `<out>/{amendments,negative_unl,fee_settings,server_info,feature}.json`; `--out` defaults to
 * `test/fixtures/<network>/network-state`. An `entryNotFound` answer for the NegativeUNL (the object does not exist while
 * no validator is disabled) is recorded as the error message the node served. All five files are written together, or
 * none. It takes none of the ledger options.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { request as httpsRequest } from 'https';
import { join, resolve } from 'path';
import { Client } from 'xrpl';
import { gzipSync } from 'zlib';
import { getNetworkProfile, NetworkProfile, parseUnlPublishers, publisherIdOf } from '../src/network';
import {
  AMENDMENTS_OBJECT_INDEX,
  FEE_SETTINGS_OBJECT_INDEX,
  NEGATIVE_UNL_OBJECT_INDEX,
} from '../src/validators/ledger-objects';

export interface Options {
  network: 'xrpl' | 'xahau';
  /** Record the validator lists of the default publishers instead of ledgers. */
  unl: boolean;
  /** Record the ledger state the validators worker polls (Amendments, NegativeUNL, FeeSettings, `server_info`, `feature`). */
  networkState: boolean;
  /** The node endpoint; empty with `unl`. */
  endpoint: string;
  out: string;
  /** With `networkState`: the ledger to record the state of; none is the validated ledger. */
  ledger?: number;
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

/** What `main` prints after the error of a refused command line. */
export const USAGE =
  'usage: record-fixtures --network xrpl|xahau --endpoint <wss url> --out <dir>\n' +
  '         [--ledgers a,b,c] [--txs HASH,HASH] [--want TypeA,TypeB --scan N] [--delay-ms 75] [--any-result]\n' +
  '       record-fixtures --unl --network xrpl|xahau [--out <dir>]\n' +
  '       record-fixtures --network-state --network xrpl|xahau --endpoint <wss url> [--out <dir>] [--ledger <n>]';

/** Bad command line. `main` prints it with the usage text and exits with status 2. */
export class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

/** The options that only make sense when recording ledgers from a node. */
const LEDGER_ONLY_OPTIONS = ['endpoint', 'ledgers', 'txs', 'want', 'scan', 'delay-ms', 'any-result'];
/** The ones of them that `--network-state` has no use for (it takes `--endpoint`). */
const LEDGER_ONLY_WITHOUT_ENDPOINT = LEDGER_ONLY_OPTIONS.filter((name) => name !== 'endpoint');

export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (name === 'any-result' || name === 'unl' || name === 'network-state') {
      flags.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
    values[name] = value;
  }
  const known = new Set(['network', 'endpoint', 'out', 'ledger', 'ledgers', 'txs', 'want', 'scan', 'delay-ms']);
  for (const name of Object.keys(values)) if (!known.has(name)) usage(`unknown option --${name}`);

  const network = values.network;
  if (network !== 'xrpl' && network !== 'xahau') usage('--network must be xrpl or xahau');
  if (flags.has('unl') && flags.has('network-state')) usage('--unl and --network-state are separate modes');
  if ('ledger' in values && !flags.has('network-state')) usage('--ledger is only for --network-state');
  if (flags.has('network-state')) {
    for (const name of LEDGER_ONLY_WITHOUT_ENDPOINT) {
      if (name in values || flags.has(name)) usage(`--${name} is for recording ledgers, not with --network-state`);
    }
    if (!values.endpoint) usage('--endpoint is required');
    if (values.ledger !== undefined && !/^[1-9]\d*$/.test(values.ledger)) {
      usage(`--ledger must be a positive integer, got "${values.ledger}"`);
    }
    return {
      network,
      unl: false,
      networkState: true,
      endpoint: values.endpoint,
      out: resolve(values.out ?? join(__dirname, '..', 'test', 'fixtures', network, 'network-state')),
      ...(values.ledger === undefined ? {} : { ledger: Number(values.ledger) }),
      ledgers: [],
      want: [],
      scan: 0,
      delayMs: 0,
      anyResult: false,
      txs: [],
    };
  }
  if (flags.has('unl')) {
    for (const name of LEDGER_ONLY_OPTIONS) {
      if (name in values || flags.has(name)) usage(`--${name} is for recording ledgers, not with --unl`);
    }
    return {
      network,
      unl: true,
      networkState: false,
      endpoint: '',
      out: resolve(values.out ?? join(__dirname, '..', 'test', 'fixtures', network, 'unl')),
      ledgers: [],
      want: [],
      scan: 0,
      delayMs: 0,
      anyResult: false,
      txs: [],
    };
  }
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
    unl: false,
    networkState: false,
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
 * a generous cap; any other failure is retried a few times with a growing delay and then thrown. A failure that
 * `isFinal` calls final (an answer of the node, which asking again would not change) is thrown at once.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  env: Pick<RecorderEnv, 'warn'>,
  isFinal?: (err: unknown) => boolean,
): Promise<T> {
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
      if (isFinal?.(err)) throw err;
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

/** XRPL mainnet reports network_id 0 or omits it; Xahau reports 21337. `undefined` when the node is of the network. */
function networkIdProblem(
  info: { network_id?: number },
  profile: Pick<NetworkProfile, 'name' | 'networkId'>,
): string | undefined {
  if (info.network_id === undefined || info.network_id === profile.networkId) return undefined;
  return `reports network_id ${info.network_id}, but --network ${profile.name} is ${profile.networkId}`;
}

/**
 * Runs the tasks with at most `limit` of them in flight, and resolves with their results in the order of the tasks. After
 * a task fails nothing more is started; the rejection (the first failure) comes when the ones under way are over.
 */
export async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < tasks.length) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  if (failure !== undefined) throw failure.error;
  return results;
}

/** An answer of the node itself (`RippledError`): the error message the node served is in `data`. */
type RippledAnswer = Error & { data?: Record<string, unknown> };
/** Matched by name: the class differs across package copies. */
const isRippledError = (err: unknown): err is RippledAnswer => err instanceof Error && err.name === 'RippledError';

/** The error code of a rippled error answer (`entryNotFound`), or `''`. */
const rippledCode = (err: unknown): string =>
  isRippledError(err) && typeof err.data?.error === 'string' ? err.data.error : '';

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/** What `recordNetworkState` found. */
export interface NetworkStateRecording {
  /** The validated ledger of the Amendments answer, which the NegativeUNL and FeeSettings answers are of too. */
  ledgerIndex: number;
  /** `present`, or `entryNotFound` when the node served that error for the NegativeUNL (no validator is disabled). */
  negativeUnl: 'present' | 'entryNotFound';
}

/**
 * Asks the node for the ledger state of spec 2.3 and writes the answers as served, all together or not at all: the
 * Amendments object at the validated ledger L, then (at most 2 requests in flight) the NegativeUNL and FeeSettings objects
 * at L, `server_info` and `feature`. `request` gives a result or throws what the node answered (`RippledError`).
 */
export async function recordNetworkState(o: {
  network: 'xrpl' | 'xahau';
  /** The ledger to record the state of. Default: the validated ledger. */
  ledger?: number;
  request: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  write: (name: string, body: string) => void;
  /** Progress lines. Default: none. */
  log?: (line: string) => void;
}): Promise<NetworkStateRecording> {
  const profile = getNetworkProfile(o.network);
  const ask = async (name: string, command: Record<string, unknown>) => {
    try {
      return await o.request(command);
    } catch (err) {
      throw new Error(`${name}: ${errorText(err)}`);
    }
  };

  const amendments = await ask('amendments', {
    command: 'ledger_entry',
    index: AMENDMENTS_OBJECT_INDEX,
    ledger_index: o.ledger ?? 'validated',
  });
  const ledgerIndex = amendments.ledger_index;
  if (typeof ledgerIndex !== 'number' || !Number.isInteger(ledgerIndex) || ledgerIndex < 1) {
    throw new Error(`amendments: the answer has no ledger_index (${JSON.stringify(ledgerIndex)})`);
  }
  o.log?.(`amendments: ledger ${ledgerIndex}`);

  const at = (index: string) => ({ command: 'ledger_entry', index, ledger_index: ledgerIndex });
  let negativeUnlNotFound = false;
  const [negativeUnl, feeSettings, serverInfo, feature] = await runLimited(
    [
      async () => {
        try {
          return await o.request(at(NEGATIVE_UNL_OBJECT_INDEX));
        } catch (err) {
          // no validator is disabled: the object does not exist, and the node says so
          if (rippledCode(err) !== 'entryNotFound') throw new Error(`negative_unl: ${errorText(err)}`);
          negativeUnlNotFound = true;
          return (err as RippledAnswer).data ?? {};
        }
      },
      () => ask('fee_settings', at(FEE_SETTINGS_OBJECT_INDEX)),
      () => ask('server_info', { command: 'server_info' }),
      () => ask('feature', { command: 'feature' }),
    ],
    2,
  );

  const wrongNetwork = networkIdProblem((serverInfo.info ?? {}) as { network_id?: number }, profile);
  if (wrongNetwork) throw new Error(`server_info: the node ${wrongNetwork}`);

  o.write('amendments.json', json(amendments));
  o.write('negative_unl.json', json(negativeUnl));
  o.write('fee_settings.json', json(feeSettings));
  o.write('server_info.json', json(serverInfo));
  o.write('feature.json', json(feature));
  return { ledgerIndex, negativeUnl: negativeUnlNotFound ? 'entryNotFound' : 'present' };
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
    const req = httpsRequest(
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

/** A client of the endpoint, and a function that sends a command and gives its `result`. */
function nodeRequester(endpoint: string) {
  const client = new Client(endpoint, { timeout: 30_000, connectionTimeout: 20_000 });
  // No api_version is sent: both xrpl and xahau servers default to API v1.
  const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!client.isConnected()) await client.connect();
    const response = await client.request(command as never);
    return response.result as unknown as Record<string, unknown>;
  };
  return { client, request };
}

/** Record the ledger state the validators worker polls from the node, as served (see `recordNetworkState`). */
async function recordNetworkStateFromNode(options: Options): Promise<void> {
  mkdirSync(options.out, { recursive: true });
  const { client, request } = nodeRequester(options.endpoint);
  try {
    console.log(`connecting to ${options.endpoint} (${options.network})`);
    await client.connect();
    const recording = await recordNetworkState({
      network: options.network,
      ledger: options.ledger,
      log: console.log,
      // the answers of the node are final (an `entryNotFound` is not a failure to retry); a lost connection is retried
      request: (command) =>
        withRetry(
          String(command.command),
          () => request(command),
          consoleEnv,
          (err) => isRippledError(err),
        ),
      write: (name, body) => {
        writeFileSync(join(options.out, name), body);
        console.log(`  wrote ${name} (${body.length} bytes)`);
      },
    });
    console.log(
      `\nrecorded the network state at ledger ${recording.ledgerIndex} into ${options.out} (NegativeUNL: ${recording.negativeUnl})`,
    );
  } catch (err) {
    console.error(`stopped: ${errorText(err)}`);
    process.exitCode = 1;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore: the connection may already be gone
    }
  }
}

interface EarlierManifest {
  cases: unknown;
  txs: Record<string, unknown>;
  ledgers: { ledger: number }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What an earlier run left in `manifest.json` of `--out`, so a run that adds to the directory does not forget what is
 * already there: the hand-written `cases`, the `txs` and the recorded `ledgers`. A ledger counts only while its
 * `<index>.json.gz` is still in the directory, and a transaction only while its ledger does.
 */
function readEarlierManifest(dir: string, env: Pick<RecorderEnv, 'warn'>): EarlierManifest {
  const none: EarlierManifest = { cases: undefined, txs: {}, ledgers: [] };
  const manifestPath = join(dir, 'manifest.json');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return none; // no earlier manifest
  }
  let earlier: unknown;
  try {
    earlier = JSON.parse(text);
  } catch (err) {
    env.warn(`WARNING: ${manifestPath} is not valid JSON (${errorText(err)}); not carrying anything over`);
    return none;
  }
  if (!isRecord(earlier)) return none;

  const ledgers: { ledger: number }[] = [];
  for (const entry of Array.isArray(earlier.ledgers) ? earlier.ledgers : []) {
    if (!isRecord(entry) || !Number.isInteger(entry.ledger)) continue;
    const index = entry.ledger as number;
    if (existsSync(join(dir, `${index}.json.gz`))) ledgers.push({ ...entry, ledger: index });
    else env.warn(`WARNING: ledger ${index} of the earlier manifest has no ${index}.json.gz; dropping it`);
  }
  const kept = new Set(ledgers.map((l) => l.ledger));
  const txs: Record<string, unknown> = {};
  for (const [hash, info] of Object.entries(isRecord(earlier.txs) ? earlier.txs : {})) {
    if (isRecord(info) && kept.has(info.ledger as number)) txs[hash] = info;
  }
  return { cases: earlier.cases, txs, ledgers };
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
    const wrongNetwork = networkIdProblem(serverInfo, profile);
    if (wrongNetwork) throw new Error(`${options.endpoint} ${wrongNetwork}`);
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
      await sleep(options.delayMs);
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
  const earlier = readEarlierManifest(options.out, env);
  const ledgers = new Map<number, { ledger: number }>(earlier.ledgers.map((l) => [l.ledger, l]));
  for (const entry of recorded) ledgers.set(entry.ledger, entry);
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
    txs: { ...earlier.txs, ...txInfo },
    ...(earlier.cases === undefined ? {} : { cases: earlier.cases }),
    ledgers: [...ledgers.values()].sort((a, b) => a.ledger - b.ledger),
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

  if (options.unl) return recordUnlLists(options);
  if (options.networkState) return recordNetworkStateFromNode(options);

  const { client, request } = nodeRequester(options.endpoint);
  const node: RecorderNode = {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    request,
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

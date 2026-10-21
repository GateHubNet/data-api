import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { gunzipSync } from 'zlib';
import {
  AMENDMENTS_OBJECT_INDEX,
  FEE_SETTINGS_OBJECT_INDEX,
  NEGATIVE_UNL_OBJECT_INDEX,
} from '../src/validators/ledger-objects';
import {
  Options,
  parseArgs,
  RecorderNode,
  recordFixtures,
  recordNetworkState,
  redirectTarget,
  runLimited,
  USAGE,
  UsageError,
} from './record-fixtures';

const FIXTURES = resolve(__dirname, '..', 'test', 'fixtures');

/** The error and usage text printed for a refused command line, or `undefined` when parseArgs accepted it. */
function refusal(argv: string[]): string | undefined {
  try {
    parseArgs(argv);
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return `error: ${(err as Error).message}\n\n${USAGE}`;
  }
}

describe('record-fixtures arguments', () => {
  describe('recording ledgers', () => {
    const ledgers = [
      '--network',
      'xrpl',
      '--endpoint',
      'wss://s2.ripple.com',
      '--out',
      'somewhere',
      '--ledgers',
      '1,2',
    ];

    it('needs --endpoint and --out', () => {
      expect(parseArgs(ledgers)).toMatchObject({
        unl: false,
        network: 'xrpl',
        endpoint: 'wss://s2.ripple.com',
        out: resolve('somewhere'),
        ledgers: [1, 2],
      });
      expect(refusal(['--network', 'xrpl', '--out', 'somewhere', '--ledgers', '1'])).toContain(
        '--endpoint is required',
      );
      expect(refusal(['--network', 'xrpl', '--endpoint', 'wss://s2.ripple.com', '--ledgers', '1'])).toContain(
        '--out is required',
      );
    });

    it('needs a network and something to record', () => {
      expect(refusal(['--endpoint', 'wss://x', '--out', 'o', '--ledgers', '1'])).toContain(
        '--network must be xrpl or xahau',
      );
      expect(refusal(['--network', 'ripple', '--endpoint', 'wss://x', '--out', 'o', '--ledgers', '1'])).toContain(
        '--network must be xrpl or xahau',
      );
      expect(refusal(['--network', 'xahau', '--endpoint', 'wss://x', '--out', 'o'])).toContain(
        'give --ledgers and/or --want',
      );
    });

    it('lists the unl mode in its usage text', () => {
      expect(refusal(['--network', 'xrpl'])).toContain('record-fixtures --unl --network xrpl|xahau [--out <dir>]');
    });

    it('lists the network state mode in its usage text', () => {
      expect(refusal(['--network', 'xrpl'])).toContain(
        'record-fixtures --network-state --network xrpl|xahau --endpoint <wss url> [--out <dir>]',
      );
    });
  });

  describe('--unl', () => {
    it('needs only the network: no endpoint, no --out', () => {
      expect(parseArgs(['--unl', '--network', 'xrpl'])).toEqual({
        network: 'xrpl',
        unl: true,
        endpoint: '',
        networkState: false,
        out: join(FIXTURES, 'xrpl', 'unl'),
        ledgers: [],
        want: [],
        scan: 0,
        delayMs: 0,
        anyResult: false,
        txs: [],
      });
      expect(parseArgs(['--network', 'xahau', '--unl'])).toMatchObject({
        unl: true,
        network: 'xahau',
        out: join(FIXTURES, 'xahau', 'unl'),
      });
    });

    it('takes the pnpm "--" separator', () => {
      expect(parseArgs(['--', '--unl', '--network', 'xrpl']).unl).toBe(true);
    });

    it('takes an output directory', () => {
      expect(parseArgs(['--unl', '--network', 'xrpl', '--out', 'elsewhere'])).toMatchObject({
        out: resolve('elsewhere'),
      });
    });

    it('still needs a network', () => {
      expect(refusal(['--unl'])).toContain('--network must be xrpl or xahau');
      expect(refusal(['--unl', '--network', 'bitcoin'])).toContain('--network must be xrpl or xahau');
    });

    it('refuses the options that are for recording ledgers', () => {
      const unl = ['--unl', '--network', 'xrpl'];
      for (const extra of [
        ['--endpoint', 'wss://s2.ripple.com'],
        ['--ledgers', '1'],
        ['--txs', 'A'.repeat(64)],
        ['--want', 'Payment'],
        ['--scan', '10'],
        ['--delay-ms', '5'],
        ['--any-result'],
      ]) {
        expect(refusal([...unl, ...extra])).toContain(`${extra[0]} is for recording ledgers, not with --unl`);
      }
    });
  });

  describe('--network-state', () => {
    const state = ['--network-state', '--network', 'xrpl', '--endpoint', 'wss://s2.ripple.com'];

    it('needs the network and an endpoint, and not --out', () => {
      expect(parseArgs(state)).toEqual({
        network: 'xrpl',
        unl: false,
        networkState: true,
        endpoint: 'wss://s2.ripple.com',
        out: join(FIXTURES, 'xrpl', 'network-state'),
        ledgers: [],
        want: [],
        scan: 0,
        delayMs: 0,
        anyResult: false,
        txs: [],
      });
      expect(parseArgs(['--network', 'xahau', '--endpoint', 'wss://xahau.network', '--network-state'])).toMatchObject({
        networkState: true,
        network: 'xahau',
        endpoint: 'wss://xahau.network',
        out: join(FIXTURES, 'xahau', 'network-state'),
      });
    });

    it('takes the pnpm "--" separator and an output directory', () => {
      expect(parseArgs(['--', ...state]).networkState).toBe(true);
      expect(parseArgs([...state, '--out', 'elsewhere'])).toMatchObject({ out: resolve('elsewhere') });
    });

    it('takes the ledger to record the state of', () => {
      expect(parseArgs([...state, '--ledger', '26633715'])).toMatchObject({ networkState: true, ledger: 26633715 });
      expect(parseArgs(state).ledger).toBeUndefined();
      for (const bad of ['0', '-5', '1.5', 'validated', '012']) {
        expect(refusal([...state, '--ledger', bad])).toContain('--ledger must be a positive integer');
      }
    });

    it('refuses --ledger in the other modes', () => {
      expect(refusal(['--unl', '--network', 'xrpl', '--ledger', '5'])).toContain(
        '--ledger is only for --network-state',
      );
      expect(
        refusal(['--network', 'xrpl', '--endpoint', 'wss://x', '--out', 'o', '--ledgers', '1', '--ledger', '5']),
      ).toContain('--ledger is only for --network-state');
    });

    it('still needs a network, and now an endpoint', () => {
      expect(refusal(['--network-state', '--endpoint', 'wss://x'])).toContain('--network must be xrpl or xahau');
      expect(refusal(['--network-state', '--network', 'bitcoin', '--endpoint', 'wss://x'])).toContain(
        '--network must be xrpl or xahau',
      );
      expect(refusal(['--network-state', '--network', 'xrpl'])).toContain('--endpoint is required');
    });

    it('refuses the options that are for recording ledgers', () => {
      for (const extra of [
        ['--ledgers', '1'],
        ['--txs', 'A'.repeat(64)],
        ['--want', 'Payment'],
        ['--scan', '10'],
        ['--delay-ms', '5'],
        ['--any-result'],
      ]) {
        expect(refusal([...state, ...extra])).toContain(
          `${extra[0]} is for recording ledgers, not with --network-state`,
        );
      }
    });

    it('is a mode of its own: not with --unl', () => {
      expect(refusal([...state, '--unl'])).toContain('--unl and --network-state are separate modes');
    });

    it('leaves the ledger mode as it was: it does not turn on by itself', () => {
      const ledgers = ['--network', 'xrpl', '--endpoint', 'wss://s2.ripple.com', '--out', 'o', '--ledgers', '1'];
      expect(parseArgs(ledgers)).toMatchObject({ networkState: false, unl: false });
    });
  });
});

describe('runLimited', () => {
  it('runs every task, keeps the order of the results and never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const task = (n: number) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 - n));
      inFlight--;
      return n * 10;
    };
    expect(await runLimited([1, 2, 3, 4, 5].map(task), 2)).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    const task = (n: number) => async () => {
      started.push(n);
      if (n === 1) throw new Error('boom');
      return n;
    };
    await expect(runLimited([1, 2, 3, 4].map(task), 1)).rejects.toThrow('boom');
    expect(started).toEqual([1]);
  });
});

describe('recordNetworkState', () => {
  const LEDGER = 107_700_000;
  /** The node: `ledger_entry` of each object, `server_info` and `feature`. */
  function node(overrides: Record<string, () => Promise<Record<string, unknown>>> = {}) {
    const requests: Record<string, unknown>[] = [];
    let inFlight = 0;
    let peak = 0;
    const answers: Record<string, () => Promise<Record<string, unknown>>> = {
      [AMENDMENTS_OBJECT_INDEX]: async () => ({
        index: AMENDMENTS_OBJECT_INDEX,
        ledger_index: LEDGER,
        node: { LedgerEntryType: 'Amendments', Amendments: [] },
        validated: true,
      }),
      [NEGATIVE_UNL_OBJECT_INDEX]: async () => ({ index: NEGATIVE_UNL_OBJECT_INDEX, ledger_index: LEDGER, node: {} }),
      [FEE_SETTINGS_OBJECT_INDEX]: async () => ({ index: FEE_SETTINGS_OBJECT_INDEX, ledger_index: LEDGER, node: {} }),
      server_info: async () => ({ info: { network_id: 0, validation_quorum: 28 } }),
      feature: async () => ({ features: {} }),
      ...overrides,
    };
    const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
      requests.push(command);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const answer = answers[command.command === 'ledger_entry' ? String(command.index) : String(command.command)];
        return await answer();
      } finally {
        inFlight--;
      }
    };
    return { request, requests, peak: () => peak };
  }

  /** What a rippled error answer looks like once xrpl.js has thrown it. */
  const rippledError = (error: string) =>
    Object.assign(new Error(`${error} (message)`), {
      name: 'RippledError',
      data: { error, error_code: 21, error_message: 'Entry not found.', status: 'error', type: 'response' },
    });

  const record = async (n: ReturnType<typeof node>, network: 'xrpl' | 'xahau' = 'xrpl') => {
    const written: Record<string, string> = {};
    const result = await recordNetworkState({
      network,
      request: n.request,
      write: (name, body) => void (written[name] = String(body)),
    });
    return { written, result };
  };

  it('asks for the Amendments object at the validated ledger, then for the others at that ledger', async () => {
    const n = node();
    await record(n);
    expect(n.requests[0]).toEqual({
      command: 'ledger_entry',
      index: AMENDMENTS_OBJECT_INDEX,
      ledger_index: 'validated',
    });
    expect(n.requests.slice(1)).toEqual(
      expect.arrayContaining([
        { command: 'ledger_entry', index: NEGATIVE_UNL_OBJECT_INDEX, ledger_index: LEDGER },
        { command: 'ledger_entry', index: FEE_SETTINGS_OBJECT_INDEX, ledger_index: LEDGER },
        { command: 'server_info' },
        { command: 'feature' },
      ]),
    );
    expect(n.requests).toHaveLength(5);
  });

  it('asks for the ledger it is given instead of the validated one', async () => {
    const n = node();
    await recordNetworkState({ network: 'xrpl', ledger: LEDGER, request: n.request, write: () => undefined });
    expect(n.requests[0]).toEqual({ command: 'ledger_entry', index: AMENDMENTS_OBJECT_INDEX, ledger_index: LEDGER });
  });

  it('has at most 2 requests in flight', async () => {
    const n = node();
    await record(n);
    expect(n.peak()).toBe(2);
  });

  it('writes the five answers as served, only when all of them are in', async () => {
    const n = node();
    const { written, result } = await record(n);
    expect(Object.keys(written).sort()).toEqual([
      'amendments.json',
      'feature.json',
      'fee_settings.json',
      'negative_unl.json',
      'server_info.json',
    ]);
    expect(JSON.parse(written['amendments.json'])).toMatchObject({ ledger_index: LEDGER });
    expect(JSON.parse(written['server_info.json'])).toEqual({ info: { network_id: 0, validation_quorum: 28 } });
    expect(written['feature.json']).toBe('{\n  "features": {}\n}\n');
    expect(result).toEqual({ ledgerIndex: LEDGER, negativeUnl: 'present' });
  });

  it('records an entryNotFound answer for the NegativeUNL as the node served it', async () => {
    const n = node({
      [NEGATIVE_UNL_OBJECT_INDEX]: async () => {
        throw rippledError('entryNotFound');
      },
    });
    const { written, result } = await record(n);
    expect(JSON.parse(written['negative_unl.json'])).toMatchObject({ error: 'entryNotFound', status: 'error' });
    expect(result.negativeUnl).toBe('entryNotFound');
  });

  it('writes nothing, and says which request failed, when any other request fails', async () => {
    for (const [key, name] of [
      [AMENDMENTS_OBJECT_INDEX, 'amendments'],
      [FEE_SETTINGS_OBJECT_INDEX, 'fee_settings'],
      ['server_info', 'server_info'],
      ['feature', 'feature'],
    ]) {
      const n = node({
        [key]: async () => {
          throw rippledError('noNetwork');
        },
      });
      const written: Record<string, string> = {};
      await expect(
        recordNetworkState({
          network: 'xrpl',
          request: n.request,
          write: (file, body) => void (written[file] = String(body)),
        }),
      ).rejects.toThrow(new RegExp(`${name}.*noNetwork`));
      expect(written).toEqual({});
    }
  });

  it('refuses a NegativeUNL error that is not entryNotFound, and an entryNotFound of the FeeSettings', async () => {
    const written: Record<string, string> = {};
    const sink = {
      write: (file: string, body: string | Buffer) => void (written[file] = String(body)),
    };
    await expect(
      recordNetworkState({
        network: 'xrpl',
        request: node({
          [NEGATIVE_UNL_OBJECT_INDEX]: async () => {
            throw rippledError('lgrNotFound');
          },
        }).request,
        ...sink,
      }),
    ).rejects.toThrow(/negative_unl.*lgrNotFound/);
    await expect(
      recordNetworkState({
        network: 'xrpl',
        request: node({
          [FEE_SETTINGS_OBJECT_INDEX]: async () => {
            throw rippledError('entryNotFound');
          },
        }).request,
        ...sink,
      }),
    ).rejects.toThrow(/fee_settings.*entryNotFound/);
    expect(written).toEqual({});
  });

  it('refuses a node of the other network', async () => {
    const n = node({ server_info: async () => ({ info: { network_id: 21337 } }) });
    await expect(record(n, 'xrpl')).rejects.toThrow(/network_id 21337.*xrpl/);
    const x = node({ server_info: async () => ({ info: { network_id: 21337 } }) });
    await expect(record(x, 'xahau')).resolves.toBeDefined();
  });

  it('refuses an Amendments answer without a ledger index', async () => {
    const n = node({ [AMENDMENTS_OBJECT_INDEX]: async () => ({ node: {} }) });
    await expect(record(n)).rejects.toThrow(/ledger_index/);
  });
});

describe('redirectTarget', () => {
  it('follows a redirect to an https URL, absolute or relative', () => {
    expect(redirectTarget('https://vl.example.com/a', 'https://other.example.org/list', 0)).toBe(
      'https://other.example.org/list',
    );
    expect(redirectTarget('https://vl.example.com/a/b', '/list.json', 1)).toBe('https://vl.example.com/list.json');
    expect(redirectTarget('https://vl.example.com/a/b', 'c', 2)).toBe('https://vl.example.com/a/c');
  });

  it('follows at most 3 redirects', () => {
    expect(() => redirectTarget('https://vl.example.com/', '/next', 2)).not.toThrow();
    expect(() => redirectTarget('https://vl.example.com/', '/next', 3)).toThrow(/more than 3 redirects/);
  });

  it('refuses a redirect to http or without a place to go', () => {
    expect(() => redirectTarget('https://vl.example.com/', 'http://vl.example.com/', 0)).toThrow(/refused/);
    expect(() => redirectTarget('https://vl.example.com/', 'ftp://vl.example.com/', 0)).toThrow(/refused/);
    expect(() => redirectTarget('https://vl.example.com/', undefined, 0)).toThrow(/without a Location/);
    expect(() => redirectTarget('https://vl.example.com/', '', 0)).toThrow(/without a Location/);
  });
});

const HASH_A = 'A'.repeat(64);
const HASH_B = 'B'.repeat(63) + '1';
const HASH_C = 'C'.repeat(64);
const HASH_UNKNOWN = 'D'.repeat(63) + '9';

interface StubTx {
  hash: string;
  ledger: number;
  type?: string;
  result?: string;
  validated?: boolean;
}

/** A rippled error as xrpl.js raises it: `message` is the server's `error_message`, the whole response is in `data`. */
function rippledError(error: string, message: string): Error {
  return Object.assign(new Error(message), { data: { status: 'error', error, error_message: message } });
}

/**
 * A node holding the given transactions. A ledger holds every stub transaction of that ledger, so two hashes with the same
 * `ledger` end up in the same recorded ledger.
 */
function stubNode(txs: StubTx[], head = 1000) {
  const calls: Record<string, unknown>[] = [];
  const times: number[] = [];
  const ledgerOf = (index: number) => ({
    ledger: {
      ledger_index: String(index),
      transactions: txs
        .filter((t) => t.ledger === index)
        .map((t) => ({
          hash: t.hash,
          TransactionType: t.type ?? 'Payment',
          metaData: { TransactionResult: t.result ?? 'tesSUCCESS' },
        })),
    },
    ledger_index: index,
    validated: true,
  });
  const node: RecorderNode = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    request: async (command) => {
      calls.push(command);
      times.push(Date.now());
      switch (command.command) {
        case 'server_info':
          return { info: { validated_ledger: { seq: head } } };
        case 'server_definitions':
          return { FIELDS: [] };
        case 'tx': {
          const tx = txs.find((t) => t.hash === String(command.transaction).toUpperCase());
          if (!tx) throw rippledError('txnNotFound', 'Transaction not found.');
          return {
            hash: tx.hash,
            TransactionType: tx.type ?? 'Payment',
            ledger_index: tx.ledger,
            meta: { TransactionResult: tx.result ?? 'tesSUCCESS' },
            validated: tx.validated ?? true,
          };
        }
        case 'ledger':
          return ledgerOf(Number(command.ledger_index));
        default:
          throw new Error(`unexpected command ${String(command.command)}`);
      }
    },
  };
  return { node, calls, times, commands: (name: string) => calls.filter((c) => c.command === name) };
}

describe('record-fixtures', () => {
  let out: string;
  const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'record-fixtures-spec-'));
  });
  afterEach(() => {
    // `out` was created by this test, and so was everything in it.
    rmSync(out, { recursive: true, force: true });
  });

  const options = (extra: Partial<Options>): Options => ({
    network: 'xrpl',
    unl: false,
    networkState: false,
    endpoint: 'wss://stub.invalid',
    out,
    ledgers: [],
    want: [],
    scan: 0,
    delayMs: 0,
    anyResult: false,
    txs: [],
    ...extra,
  });
  const readJson = (name: string) => JSON.parse(readFileSync(join(out, name), 'utf8'));
  const readLedger = (index: number) => JSON.parse(gunzipSync(readFileSync(join(out, `${index}.json.gz`))).toString());
  const baseArgs = ['--network', 'xrpl', '--endpoint', 'wss://stub.invalid', '--out', '/nowhere'];

  describe('parseArgs', () => {
    it('reads --txs as a comma-separated list of transaction hashes, upper-cased', () => {
      const parsed = parseArgs([...baseArgs, '--txs', `${HASH_A.toLowerCase()}, ${HASH_B}`]);
      expect(parsed.txs).toEqual([HASH_A, HASH_B]);
    });

    it('accepts --txs on its own', () => {
      expect(() => parseArgs([...baseArgs, '--txs', HASH_A])).not.toThrow();
    });

    it('defaults --txs to none and still wants --ledgers or --want', () => {
      expect(parseArgs([...baseArgs, '--ledgers', '5']).txs).toEqual([]);
      expect(() => parseArgs(baseArgs)).toThrow(/give --ledgers and\/or --want and\/or --txs/);
    });

    it('rejects a value that is not a 64-digit hex transaction hash and names it', () => {
      expect(() => parseArgs([...baseArgs, '--txs', `${HASH_A},12345`])).toThrow(UsageError);
      expect(() => parseArgs([...baseArgs, '--txs', `${HASH_A},12345`])).toThrow(/"12345"/);
    });

    it('still rejects unknown options', () => {
      expect(() => parseArgs([...baseArgs, '--nope', '1'])).toThrow(/unknown option --nope/);
    });
  });

  describe('--txs', () => {
    it('resolves each hash to its ledger and records it once', async () => {
      const { node, commands } = stubNode([
        { hash: HASH_A, ledger: 500, type: 'AMMDeposit' },
        { hash: HASH_B, ledger: 500, type: 'Payment' },
        { hash: HASH_C, ledger: 600, type: 'OfferCreate' },
      ]);

      const run = await recordFixtures(options({ txs: [HASH_A, HASH_B, HASH_C] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('tx').map((c) => c.transaction)).toEqual([HASH_A, HASH_B, HASH_C]);
      expect(commands('ledger').map((c) => c.ledger_index)).toEqual([500, 600]);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['500.json.gz', '600.json.gz']);
      expect(readLedger(500).ledger.transactions.map((t: { hash: string }) => t.hash)).toEqual([HASH_A, HASH_B]);
      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500, 600]);
      expect(manifest.txs).toEqual({
        [HASH_A]: { ledger: 500, type: 'AMMDeposit', result: 'tesSUCCESS' },
        [HASH_B]: { ledger: 500, type: 'Payment', result: 'tesSUCCESS' },
        [HASH_C]: { ledger: 600, type: 'OfferCreate', result: 'tesSUCCESS' },
      });
      expect(manifest.complete).toBe(true);
    });

    it('does not fetch a ledger again that --ledgers already recorded', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      const run = await recordFixtures(options({ ledgers: [500], txs: [HASH_A] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('tx')).toHaveLength(1);
      expect(commands('ledger')).toHaveLength(1);
      const manifest = readJson('manifest.json');
      expect(manifest.ledgers).toHaveLength(1);
      expect(manifest.txs[HASH_A]).toEqual({ ledger: 500, type: 'Payment', result: 'tesSUCCESS' });
    });

    it('records a repeated hash once', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      await recordFixtures(options({ txs: [HASH_A, HASH_A] }), node, silent);

      expect(commands('ledger')).toHaveLength(1);
    });

    it('answers a hash the node does not know with an error that names it, without retrying', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const errors: string[] = [];

      const run = await recordFixtures(options({ txs: [HASH_A, HASH_UNKNOWN] }), node, {
        ...silent,
        error: (m) => errors.push(m),
      });

      expect(run.failure).toBeInstanceOf(Error);
      expect((run.failure as Error).message).toContain(HASH_UNKNOWN);
      expect((run.failure as Error).message).toMatch(/txnNotFound|not found/i);
      expect(errors.join('\n')).toContain(HASH_UNKNOWN);
      expect(commands('tx').filter((c) => c.transaction === HASH_UNKNOWN)).toHaveLength(1);
      // The work done before the bad hash is kept and the manifest says the run did not finish.
      expect(existsSync(join(out, '500.json.gz'))).toBe(true);
      expect(readJson('manifest.json').complete).toBe(false);
    });

    it('refuses a transaction that is not in a validated ledger yet', async () => {
      const { node, commands } = stubNode([{ hash: HASH_A, ledger: 500, validated: false }]);

      const run = await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      expect((run.failure as Error).message).toContain(HASH_A);
      expect((run.failure as Error).message).toMatch(/not validated/i);
      expect(commands('ledger')).toHaveLength(0);
    });

    it('refuses a ledger that does not hold the transaction the node said it was in', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const lying: RecorderNode = {
        ...node,
        request: async (command) =>
          command.command === 'tx' ? { ...(await node.request(command)), ledger_index: 501 } : node.request(command),
      };

      const run = await recordFixtures(options({ txs: [HASH_A] }), lying, silent);

      expect((run.failure as Error).message).toContain(HASH_A);
      expect((run.failure as Error).message).toContain('501');
    });

    it('keeps the hand-written cases of an earlier manifest when it rewrites the manifest', async () => {
      const cases = { swap_payment_xrp_iou: { ledger: 500, hash: HASH_A, type: 'Payment', note: 'kept' } };
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ cases, found: { Old: {} } }));
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);

      await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      const manifest = readJson('manifest.json');
      expect(manifest.cases).toEqual(cases);
      expect(manifest.found).toEqual({});
    });

    it('adds to the manifest of an earlier run: the txs, ledgers and cases of both runs are kept', async () => {
      const { node } = stubNode([
        { hash: HASH_A, ledger: 500, type: 'AMMDeposit' },
        { hash: HASH_B, ledger: 600, type: 'Payment' },
      ]);
      await recordFixtures(options({ txs: [HASH_A] }), node, silent);
      const cases = { deposit_two_asset: { ledger: 500, hash: HASH_A, type: 'AMMDeposit', note: 'hand-written' } };
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...readJson('manifest.json'), cases }));

      const run = await recordFixtures(options({ txs: [HASH_B] }), node, silent);

      expect(run.failure).toBeUndefined();
      const manifest = readJson('manifest.json');
      expect(manifest.txs).toEqual({
        [HASH_A]: { ledger: 500, type: 'AMMDeposit', result: 'tesSUCCESS' },
        [HASH_B]: { ledger: 600, type: 'Payment', result: 'tesSUCCESS' },
      });
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500, 600]);
      expect(manifest.cases).toEqual(cases);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['500.json.gz', '600.json.gz']);
    });

    it('records a ledger of an earlier run again without listing it twice', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      await recordFixtures(options({ txs: [HASH_A] }), node, silent);

      await recordFixtures(options({ ledgers: [500], txs: [HASH_A] }), node, silent);

      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([500]);
      expect(Object.keys(manifest.txs)).toEqual([HASH_A]);
    });

    it('drops an earlier ledger whose file is gone, with its txs, and says so', async () => {
      const { node } = stubNode([
        { hash: HASH_A, ledger: 500 },
        { hash: HASH_B, ledger: 600 },
        { hash: HASH_C, ledger: 700 },
      ]);
      await recordFixtures(options({ txs: [HASH_A, HASH_B] }), node, silent);
      rmSync(join(out, '500.json.gz'));
      const warnings: string[] = [];

      await recordFixtures(options({ txs: [HASH_C] }), node, { ...silent, warn: (m) => warnings.push(m) });

      const manifest = readJson('manifest.json');
      expect(manifest.ledgers.map((l: { ledger: number }) => l.ledger)).toEqual([600, 700]);
      expect(Object.keys(manifest.txs).sort()).toEqual([HASH_B, HASH_C].sort());
      expect(warnings.join('\n')).toContain('500');
    });

    it('starts a fresh manifest, with a warning, when the earlier one is not valid JSON', async () => {
      writeFileSync(join(out, 'manifest.json'), '{ not json');
      const { node } = stubNode([{ hash: HASH_A, ledger: 500 }]);
      const warnings: string[] = [];

      const run = await recordFixtures(options({ txs: [HASH_A] }), node, { ...silent, warn: (m) => warnings.push(m) });

      expect(run.failure).toBeUndefined();
      expect(warnings.join('\n')).toMatch(/not valid JSON/);
      expect(Object.keys(readJson('manifest.json').txs)).toEqual([HASH_A]);
    });

    it('pauses --delay-ms after every tx lookup and every ledger fetch', async () => {
      const { node, calls, times } = stubNode([
        { hash: HASH_A, ledger: 500 },
        { hash: HASH_B, ledger: 500 },
        { hash: HASH_C, ledger: 600 },
      ]);

      await recordFixtures(options({ txs: [HASH_A, HASH_B, HASH_C], delayMs: 40 }), node, silent);

      const spaced = calls
        .map((c, i) => ({ command: c.command, at: times[i] }))
        .filter((c) => c.command === 'tx' || c.command === 'ledger');
      expect(spaced.map((c) => c.command)).toEqual(['tx', 'ledger', 'tx', 'tx', 'ledger']);
      for (let i = 1; i < spaced.length; i++) expect(spaced[i].at - spaced[i - 1].at).toBeGreaterThanOrEqual(35);
    });
  });

  describe('--ledgers and --want (unchanged)', () => {
    it('records the given ledgers', async () => {
      const { node, commands } = stubNode([
        { hash: HASH_A, ledger: 700 },
        { hash: HASH_B, ledger: 701 },
      ]);

      const run = await recordFixtures(options({ ledgers: [700, 701] }), node, silent);

      expect(run.failure).toBeUndefined();
      expect(commands('ledger').map((c) => c.ledger_index)).toEqual([700, 701]);
      expect(existsSync(join(out, '700.json.gz'))).toBe(true);
      expect(existsSync(join(out, '701.json.gz'))).toBe(true);
      expect(existsSync(join(out, 'server_info.json'))).toBe(true);
      expect(readJson('manifest.json').txs).toEqual({});
    });

    it('walks back from the head and keeps only the ledger holding a wanted type', async () => {
      const { node } = stubNode([{ hash: HASH_A, ledger: 998, type: 'AMMBid' }], 1000);

      const run = await recordFixtures(options({ want: ['AMMBid', 'Clawback'], scan: 5 }), node, silent);

      expect(run.failure).toBeUndefined();
      const manifest = readJson('manifest.json');
      expect(manifest.found).toEqual({ AMMBid: { ledger: 998, hash: HASH_A } });
      expect(manifest.missing).toEqual(['Clawback']);
      expect(manifest.scanned).toBe(5);
      expect(readdirSync(out).filter((f) => f.endsWith('.json.gz'))).toEqual(['998.json.gz']);
    });
  });
});

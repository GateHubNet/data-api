import { join, resolve } from 'path';
import {
  AMENDMENTS_OBJECT_INDEX,
  FEE_SETTINGS_OBJECT_INDEX,
  NEGATIVE_UNL_OBJECT_INDEX,
} from '../src/validators/ledger-objects';
import { parseArgs, recordNetworkState, redirectTarget, runLimited } from './record-fixtures';

const FIXTURES = resolve(__dirname, '..', 'test', 'fixtures');

/** The error and usage text printed for a refused command line, or `undefined` when parseArgs accepted it. */
function refusal(argv: string[]): string | undefined {
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    parseArgs(argv);
    return undefined;
  } catch (err) {
    expect((err as Error).message).toBe('exit');
    expect(exit).toHaveBeenCalledWith(2);
    return error.mock.calls.map((call) => String(call[0])).join('');
  } finally {
    exit.mockRestore();
    error.mockRestore();
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

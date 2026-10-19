import { join, resolve } from 'path';
import { parseArgs, redirectTarget } from './record-fixtures';

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
  });

  describe('--unl', () => {
    it('needs only the network: no endpoint, no --out', () => {
      expect(parseArgs(['--unl', '--network', 'xrpl'])).toEqual({
        network: 'xrpl',
        unl: true,
        endpoint: '',
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

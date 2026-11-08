import { TOKEN_HISTORY_BUILD_THREADS } from '@gatehub/data-api-shared';
import { exitCodeOf, main, parseTokenHistoryBuildArgs, USAGE, UsageError } from './token-history-build';

describe('parseTokenHistoryBuildArgs', () => {
  it('parses --threads and defaults to 4', () => {
    expect(parseTokenHistoryBuildArgs([])).toEqual({ threads: TOKEN_HISTORY_BUILD_THREADS });
    expect(TOKEN_HISTORY_BUILD_THREADS).toBe(4);
    expect(parseTokenHistoryBuildArgs(['--threads', '8'])).toEqual({ threads: 8 });
    // `pnpm token-history:build -- --threads 2` hands the separator over
    expect(parseTokenHistoryBuildArgs(['--', '--threads', '2'])).toEqual({ threads: 2 });
    expect(parseTokenHistoryBuildArgs(['--help'])).toBe('help');
  });

  it('rejects --threads 0', () => {
    expect(() => parseTokenHistoryBuildArgs(['--threads', '0'])).toThrow(new UsageError('--threads must be a whole number from 1, got "0"'));
    expect(() => parseTokenHistoryBuildArgs(['--threads', 'many'])).toThrow(UsageError);
    expect(() => parseTokenHistoryBuildArgs(['--threads'])).toThrow(UsageError);
    expect(() => parseTokenHistoryBuildArgs(['--from', '1'])).toThrow(UsageError);
  });
});

describe('main', () => {
  it('prints the usage for --help and exits 2 for a wrong command line, without connecting to anything', async () => {
    const out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['--help'])).toBe(0);
      expect(out).toHaveBeenCalledWith(USAGE);
      expect(await main(['--threads', '0'])).toBe(2);
      expect(String(err.mock.calls[0][0])).toContain('--threads must be a whole number');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe('exitCodeOf', () => {
  it('is 2 for a refusal, 3 for a stop and 1 for anything else', async () => {
    const shared = await import('@gatehub/data-api-shared');
    expect(exitCodeOf(new shared.BuildRefused('range_ingest', 'a range-ingest is running'))).toBe(2);
    expect(exitCodeOf(new shared.BuildStopped('stopped'))).toBe(3);
    expect(exitCodeOf(new Error('boom'))).toBe(1);
  });
});

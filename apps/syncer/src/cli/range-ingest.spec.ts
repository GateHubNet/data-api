import { deleteSpans, main, parseRangeIngestArgs, USAGE, UsageError } from './range-ingest';

describe('parseRangeIngestArgs', () => {
  it('reads the flags of the CLI', () => {
    expect(
      parseRangeIngestArgs([
        '--from',
        '1000',
        '--to',
        '5999',
        '--chunk',
        '500',
        '--concurrency',
        '4',
        '--reprocess',
        '--run-id',
        'backfill-1',
      ]),
    ).toEqual({ from: 1000, to: 5999, chunkSize: 500, concurrency: 4, reprocess: true, runId: 'backfill-1' });
  });

  it('leaves the optional flags out when they are not given, so that the defaults of rangeIngest apply', () => {
    expect(parseRangeIngestArgs(['--from', '1', '--to', '2'])).toEqual({ from: 1, to: 2 });
  });

  it('accepts --flag=value and the separator pnpm hands over', () => {
    expect(parseRangeIngestArgs(['--', '--from=7', '--to=9'])).toEqual({ from: 7, to: 9 });
  });

  it('asks for the help text', () => {
    expect(parseRangeIngestArgs(['--help'])).toBe('help');
    expect(parseRangeIngestArgs(['-h'])).toBe('help');
  });

  it.each([
    [[], /--from is required/],
    [['--from', '1'], /--to is required/],
    [['--to', '1'], /--from is required/],
    [['--from', 'abc', '--to', '5'], /--from must be a non-negative integer, got "abc"/],
    [['--from', '1.5', '--to', '5'], /--from must be a non-negative integer/],
    [['--from', '-1', '--to', '5'], /--from/],
    [['--from', '1', '--to', '5', '--chunk', 'x'], /--chunk must be a non-negative integer/],
    [['--from', '1', '--to', '5', '--concurrency', '8e3'], /--concurrency must be a non-negative integer/],
    [['--from', '1', '--to', '5', '--nope'], /nope/],
    [['--from', '1', '--to', '5', 'extra'], /extra/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRangeIngestArgs(argv as string[])).toThrow(UsageError);
    expect(() => parseRangeIngestArgs(argv as string[])).toThrow(message);
  });
});

describe('main', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prints the usage and exits 2 for a wrong command line, before it touches the environment', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main(['--from', '1'])).resolves.toBe(2);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('--to is required'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(USAGE));
  });

  it('prints the usage and exits 0 for --help', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['--help'])).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith(USAGE);
  });
});

describe('deleteSpans', () => {
  it('is one span for consecutive ledgers and for ledgers with nothing committed in between', () => {
    expect(deleteSpans([5, 6, 7, 8], [])).toEqual([[5, 8]]);
    expect(deleteSpans([5, 9, 20], [])).toEqual([[5, 20]]);
    expect(deleteSpans([5], [])).toEqual([[5, 5]]);
  });

  it('splits where a committed ledger that is kept lies between two targets', () => {
    expect(deleteSpans([2, 12], [3, 4, 11])).toEqual([
      [2, 2],
      [12, 12],
    ]);
    expect(deleteSpans([6, 7, 8, 10, 11], [9])).toEqual([
      [6, 8],
      [10, 11],
    ]);
    expect(deleteSpans([1, 5, 9], [3, 7])).toEqual([
      [1, 1],
      [5, 5],
      [9, 9],
    ]);
  });

  it('ignores kept ledgers outside the targets', () => {
    expect(deleteSpans([10, 11, 12], [1, 2, 3, 20, 21])).toEqual([[10, 12]]);
    expect(deleteSpans([10, 15], [1, 9, 16, 17])).toEqual([[10, 15]]);
  });
});

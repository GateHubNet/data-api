import { getNetworkProfile, parseAmendmentsConfig } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { AmendmentsService } from './amendments.service';
import { assembleDirectory, Directory, DirectoryReads, RoundInfo } from './directory';
import { ValidatorDirectoryService } from './validator-directory.service';

const NOW = Date.UTC(2026, 9, 19, 15, 42, 53);
const NOW_S = NOW / 1000;
const FEES = { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' };
const ENABLED = 'AB'.repeat(32);
const VOTING = 'CD'.repeat(32);

const round: RoundInfo = {
  ledgerIndex: 1023,
  closeTime: NOW_S - 600,
  unlSize: 5,
  trusted: 5,
  threshold: 4,
  observed: 5,
  unl: [],
  negativeUnl: [],
  fees: FEES,
};

function directoryOf(over: Partial<DirectoryReads> = {}): Directory {
  return assembleDirectory({
    builtAt: NOW,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    state: { ledgerIndex: 1100, amendments: [ENABLED], majorities: [], negativeUnl: [], fees: FEES, nodeQuorum: 0 },
    publishers: [],
    lists: [],
    manifestMap: [],
    manifests: [],
    seen: [],
    activity: [],
    domains: [],
    sentinels: new Map(),
    hourly: new Map(),
    rounds: [round],
    votes: [],
    versions: [],
    ...over,
  });
}

type Sql = (sql: string) => unknown[];

/** A ClickHouse that answers each statement by what it reads; `queryOne` is a `query`, as the real service has it. */
function fakeClickHouse(answer: Sql = () => []) {
  const query = jest.fn(async (sql: string) => answer(sql));
  return { query, queryOne: async (sql: string) => (await query(sql))[0] };
}

/** The rows of the window: one stored round. */
const WINDOW_ROW = {
  ledger_index: 1023,
  newest_version: '9007199254740993',
  round_close: NOW_S - 600,
  round_trusted: 5,
  round_threshold: 4,
};
const isWindowRead = (sql: string): boolean => sql.includes("amendment_id = ''");
const isRoundsRead = (sql: string): boolean => sql.includes('amendment_id = {amendment:String}');
const isTalliesRead = (sql: string): boolean => sql.includes('amendment_id IN {ids:Array(String)}');

function setup(options: { ch?: ReturnType<typeof fakeClickHouse>; directory?: Directory; cache?: CacheService } = {}) {
  const ch = options.ch ?? fakeClickHouse((sql) => (isWindowRead(sql) ? [WINDOW_ROW] : []));
  const directory = options.directory ?? directoryOf();
  const directories = { get: jest.fn().mockResolvedValue(directory) };
  const config = parseAmendmentsConfig(
    { network: 'xrpl', updated: '2026-10-19', amendments: [{ name: 'Voting' }, { name: 'Enabled' }] },
    getNetworkProfile('xrpl'),
  );
  const svc = new AmendmentsService(
    ch as never,
    options.cache ?? new CacheService(),
    directories as unknown as ValidatorDirectoryService,
    config,
    getNetworkProfile('xrpl'),
  );
  return { svc, ch, directories, directory };
}

const count = (ch: ReturnType<typeof fakeClickHouse>, test: (sql: string) => boolean): number =>
  ch.query.mock.calls.filter(([sql]) => test(sql)).length;

describe('AmendmentsService', () => {
  /** How many reads one build makes. */
  async function readsPerBuild(): Promise<number> {
    const one = setup();
    await one.svc.get();
    return one.ch.query.mock.calls.length;
  }

  it('builds the amendments on the directory it is given', async () => {
    const { svc, directory, directories } = setup();
    const assembly = await svc.get();
    expect(assembly.directory).toBe(directory);
    expect(directories.get).toHaveBeenCalledTimes(1);
    expect(assembly.amendments.map((a) => a.name)).toEqual(expect.arrayContaining(['Voting', 'Enabled']));
    expect(assembly.byId.get(ENABLED)?.status).toBe('enabled');
  });

  it('makes one build for two concurrent calls, and both get the same assembly', async () => {
    const perBuild = await readsPerBuild();
    expect(perBuild).toBeGreaterThan(0);
    const { svc, ch } = setup();
    const [a, b] = await Promise.all([svc.get(), svc.get()]);
    expect(a).toBe(b);
    expect(ch.query).toHaveBeenCalledTimes(perBuild);
  });

  it('shares the build in flight when more callers come while it runs', async () => {
    const perBuild = await readsPerBuild();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ch = fakeClickHouse((sql) => (isWindowRead(sql) ? [WINDOW_ROW] : []));
    const { svc } = setup({ ch });
    ch.query.mockImplementation(async (sql: string) => {
      await gate;
      return isWindowRead(sql) ? [WINDOW_ROW] : [];
    });
    const first = svc.get();
    const second = svc.get();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = svc.get();
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(ch.query).toHaveBeenCalledTimes(perBuild);
  });

  it('answers a later call from the cache, within 10 seconds', async () => {
    const perBuild = await readsPerBuild();
    const { svc, ch } = setup();
    const first = await svc.get();
    expect(await svc.get()).toBe(first);
    expect(ch.query).toHaveBeenCalledTimes(perBuild);
  });

  it('does not cache a failed build: every caller of it fails, and the next call builds again', async () => {
    const ch = fakeClickHouse((sql) => (isWindowRead(sql) ? [WINDOW_ROW] : []));
    const { svc } = setup({ ch });
    ch.query.mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
    const results = await Promise.allSettled([svc.get(), svc.get()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(svc.get()).resolves.toMatchObject({ amendments: expect.any(Array) });
  });

  it('keeps an assembly per network when the cache is shared', async () => {
    const perBuild = await readsPerBuild();
    const cache = new CacheService();
    const xrpl = setup({ cache });
    const xahauCh = fakeClickHouse((sql) => (isWindowRead(sql) ? [WINDOW_ROW] : []));
    const xahau = new AmendmentsService(
      xahauCh as never,
      cache,
      { get: jest.fn().mockResolvedValue(directoryOf()) } as unknown as ValidatorDirectoryService,
      parseAmendmentsConfig({ network: 'xahau', updated: '2026-10-19', amendments: [] }, getNetworkProfile('xahau')),
      getNetworkProfile('xahau'),
    );
    await Promise.all([xrpl.svc.get(), xahau.get()]);
    expect(xrpl.ch.query).toHaveBeenCalledTimes(perBuild);
    expect(xahauCh.query).toHaveBeenCalledTimes(perBuild);
  });

  describe('reads', () => {
    it('reads the window of the rounds once per build, and the tallies of the newest round only', async () => {
      const { svc, ch } = setup();
      await svc.get();
      expect(count(ch, isWindowRead)).toBe(1);
      expect(count(ch, isTalliesRead)).toBe(1);
    });

    it('reads nothing of the votes without a stored round', async () => {
      const { svc, ch } = setup({ directory: directoryOf({ rounds: [] }) });
      await svc.get();
      expect(count(ch, isWindowRead)).toBe(0);
      expect(count(ch, isTalliesRead)).toBe(0);
      expect(count(ch, (sql) => sql.includes('validator_votes'))).toBe(0);
    });

    it('asks the tallies of the version of the newest sentinel, as the text it came as', async () => {
      const { svc, ch } = setup();
      await svc.get();
      const call = ch.query.mock.calls.find(([sql]) => isTalliesRead(sql)) as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(call[1]).toMatchObject({ round: 1023, version: '9007199254740993' });
    });
  });

  describe('find', () => {
    it('finds by name and by ID', async () => {
      const { svc } = setup();
      const assembly = await svc.get();
      expect(svc.find(assembly, 'voting')?.name).toBe('Voting');
      expect(svc.find(assembly, ENABLED.toLowerCase())?.id).toBe(ENABLED);
      expect(svc.find(assembly, 'Nope')).toBeUndefined();
    });
  });

  describe('rounds', () => {
    const tallyRows = [
      { ledger_index: 1023, round_yes: 4 },
      { ledger_index: 767, round_yes: 5 },
    ];
    const answer: Sql = (sql) =>
      isWindowRead(sql)
        ? [{ ...WINDOW_ROW, ledger_index: 767, newest_version: '8', round_close: NOW_S - 1000 }, WINDOW_ROW]
        : isRoundsRead(sql)
          ? tallyRows
          : [];

    it('is the rounds of the window with the yes of the amendment, and 0 for a round with no row', async () => {
      const { svc, directory } = setup({ ch: fakeClickHouse(answer) });
      const assembly = await svc.get();
      const view = assembly.byId.get(VOTING) ?? (assembly.amendments.find((a) => a.name === 'Voting') as never);
      const points = await svc.rounds(view, directory);
      expect(points.map((p) => [p.ledgerIndex, p.yes, p.passes])).toEqual([
        [767, 5, true],
        [1023, 4, false],
      ]);
    });

    it('reads the rounds of an amendment once, however many ask', async () => {
      const { svc, ch, directory } = setup({ ch: fakeClickHouse(answer) });
      const assembly = await svc.get();
      const view = assembly.amendments.find((a) => a.name === 'Voting') as never;
      const [a, b] = await Promise.all([svc.rounds(view, directory), svc.rounds(view, directory)]);
      expect(a).toBe(b);
      await svc.rounds(view, directory);
      expect(count(ch, isRoundsRead)).toBe(1);
    });

    it('reads the window once for the rounds of every amendment of the directory', async () => {
      const { svc, ch, directory } = setup({ ch: fakeClickHouse(answer) });
      const assembly = await svc.get();
      for (const view of assembly.amendments) await svc.rounds(view, directory);
      expect(count(ch, isWindowRead)).toBe(1);
    });

    it('reads nothing for an enabled amendment whose ledger is not known: it has no rounds', async () => {
      const { svc, ch, directory } = setup({ ch: fakeClickHouse(answer) });
      const assembly = await svc.get();
      const enabled = assembly.byId.get(ENABLED) as never;
      expect(await svc.rounds(enabled, directory)).toEqual([]);
      expect(count(ch, isRoundsRead)).toBe(0);
    });

    it('does not keep a failed read: the next call reads again', async () => {
      const { svc, ch, directory } = setup({ ch: fakeClickHouse(answer) });
      const assembly = await svc.get();
      const view = assembly.amendments.find((a) => a.name === 'Voting') as never;
      ch.query.mockRejectedValueOnce(new Error('down'));
      await expect(svc.rounds(view, directory)).rejects.toThrow('down');
      await expect(svc.rounds(view, directory)).resolves.toHaveLength(2);
    });
  });
});

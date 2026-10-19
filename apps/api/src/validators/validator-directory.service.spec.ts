import { getNetworkProfile, KEY_MAP_WITH, MANIFEST_MAP_SQL, mappedKey, Table } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { ValidatorDirectoryService } from './validator-directory.service';

/** A ClickHouse with empty tables: every read answers no rows. `queryOne` is a `query`, as the real service has it. */
function fakeClickHouse() {
  const query = jest.fn().mockResolvedValue([]);
  return { query, queryOne: async (...args: unknown[]) => ((await query(...args)) as unknown[])[0] };
}

function service(
  ch = fakeClickHouse(),
  cache = new CacheService(),
  network: 'xrpl' | 'xahau' = 'xrpl',
): { svc: ValidatorDirectoryService; ch: ReturnType<typeof fakeClickHouse> } {
  return { svc: new ValidatorDirectoryService(ch as never, cache, getNetworkProfile(network)), ch };
}

/**
 * A ClickHouse with a little of everything, so that every read of a build runs: a head, a final hour with its sentinel, and a
 * round of the last 24 hours. The rows of the validators are empty.
 */
function fakeClickHouseWithData(nowSeconds: number) {
  const hour = Math.floor(nowSeconds / 3600) * 3600 - 3600;
  const query = jest.fn(async (sql: string): Promise<unknown[]> => {
    if (sql.includes(`FROM ${Table.Ledgers}`)) return [{ ledger_index: 1000, closed: nowSeconds - 4 }];
    if (sql.includes(`FROM ${Table.ValidatorAgreementHourly}`) && sql.includes('LIMIT 1'))
      return [{ stored_hour: hour }];
    if (sql.includes('newest_final')) {
      return [{ sentinel_hour: hour, newest_version: '5', newest_final: 1, newest_ledgers: 900, newest_unobserved: 0 }];
    }
    if (sql.includes(`FROM ${Table.AmendmentTallies}`) && sql.includes('LIMIT 1')) {
      return [{ ledger_index: 1023, round_close: nowSeconds - 100 }];
    }
    if (sql.includes('round_unl_size')) {
      return [
        {
          ledger_index: 1023,
          newest_version: '7',
          round_close: nowSeconds - 100,
          round_unl_size: 0,
          round_trusted: 0,
          round_threshold: 1,
          round_observed: 0,
          round_unl: [],
          round_negative_unl: [],
          round_base_fee: '10',
          round_reserve_base: '1000000',
          round_reserve_inc: '200000',
        },
      ];
    }
    if (sql.includes(`FROM ${Table.AmendmentTallies}`)) return [{ ledger_index: 1023, newest_version: '7' }];
    return [];
  });
  return { query, queryOne: async (...args: unknown[]) => ((await query(...(args as [string]))) as unknown[])[0] };
}

describe('ValidatorDirectoryService', () => {
  /** How many reads one build makes. */
  async function readsPerBuild(): Promise<number> {
    const one = service();
    await one.svc.get();
    return one.ch.query.mock.calls.length;
  }

  it('builds a directory from the reads', async () => {
    const { svc } = service();
    const directory = await svc.get();
    expect(directory.entries.size).toBe(0);
    expect(directory.builtAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it('makes one build for two concurrent calls, and both get the same directory', async () => {
    const perBuild = await readsPerBuild();
    expect(perBuild).toBeGreaterThan(0);
    const { svc, ch } = service();
    const [a, b] = await Promise.all([svc.get(), svc.get()]);
    expect(a).toBe(b);
    expect(ch.query).toHaveBeenCalledTimes(perBuild);
  });

  it('shares the build in flight when more callers come while it runs', async () => {
    const perBuild = await readsPerBuild();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ch = fakeClickHouse();
    ch.query.mockImplementation(async () => {
      await gate;
      return [];
    });
    const { svc } = service(ch);
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
    const { svc, ch } = service();
    const first = await svc.get();
    const second = await svc.get();
    expect(second).toBe(first);
    expect(ch.query).toHaveBeenCalledTimes(perBuild);
  });

  it('does not cache a failed build: every caller of it fails, and the next call builds again', async () => {
    const ch = fakeClickHouse();
    ch.query.mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
    const { svc } = service(ch);
    const results = await Promise.allSettled([svc.get(), svc.get()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(svc.get()).resolves.toMatchObject({ entries: expect.any(Map) });
  });

  it('keeps a directory per network when the cache is shared', async () => {
    const perBuild = await readsPerBuild();
    const cache = new CacheService();
    const xrpl = service(fakeClickHouse(), cache, 'xrpl');
    const xahau = service(fakeClickHouse(), cache, 'xahau');
    await Promise.all([xrpl.svc.get(), xahau.svc.get()]);
    expect(xrpl.ch.query).toHaveBeenCalledTimes(perBuild);
    expect(xahau.ch.query).toHaveBeenCalledTimes(perBuild);
  });

  describe('the manifest map', () => {
    /** The statements and the parameters of one build over `fakeClickHouseWithData`. */
    async function oneBuild(): Promise<{ sql: string; params?: Record<string, unknown> }[]> {
      const ch = fakeClickHouseWithData(Math.floor(Date.now() / 1000));
      await service(ch as never).svc.get();
      return ch.query.mock.calls.map((call) => {
        const [sql, params] = call as unknown as [string, Record<string, unknown> | undefined];
        return { sql, params };
      });
    }

    it('is never a parameter of a statement: a map of every manifest stored would travel in the URL', async () => {
      const calls = await oneBuild();
      expect(calls.length).toBeGreaterThan(10);
      for (const { sql, params } of calls) {
        expect([sql, Object.keys(params ?? {}).filter((name) => name === 'ephemerals' || name === 'masters')]).toEqual([
          sql,
          [],
        ]);
      }
    });

    it('is computed inside every statement that adds up the rows of the validators', async () => {
      const calls = await oneBuild();
      const mapped = calls.filter(({ sql }) => sql.includes(mappedKey('validation_public_key')));
      for (const table of [
        Table.ValidatorSeen,
        Table.ValidatorDomains,
        Table.ValidatorValidations,
        Table.ValidatorAgreementHourly,
        Table.ValidatorVotes,
      ]) {
        expect([table, mapped.some(({ sql }) => sql.includes(`FROM ${table}`))]).toEqual([table, true]);
      }
      // the votes of the last 24 h and the versions of 30 days
      expect(mapped.filter(({ sql }) => sql.includes(`FROM ${Table.ValidatorVotes}`))).toHaveLength(2);
      for (const { sql } of mapped) expect(sql.trimStart().startsWith(`WITH ${KEY_MAP_WITH}`)).toBe(true);
    });

    it('is read on its own once, for the map the directory carries (signingToMaster)', async () => {
      const calls = await oneBuild();
      expect(calls.filter(({ sql }) => sql === MANIFEST_MAP_SQL)).toEqual([
        { sql: MANIFEST_MAP_SQL, params: undefined },
      ]);
    });

    it('carries the rows of that read as signingToMaster', async () => {
      const ch = fakeClickHouse();
      ch.query.mockImplementation(async (sql: string) =>
        sql === MANIFEST_MAP_SQL ? [{ ephemeral_key: 'n9Signing', map_master: 'nHMaster' }] : [],
      );
      const directory = await service(ch).svc.get();
      expect([...directory.signingToMaster]).toEqual([['n9Signing', 'nHMaster']]);
    });
  });

  describe('the search for the newest final hour', () => {
    it('goes back, 720 hours at a time, no further than the 400 days the table keeps an hour', async () => {
      const stored = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
      const query = jest.fn(async (sql: string): Promise<unknown[]> => {
        if (sql.includes(`FROM ${Table.ValidatorAgreementHourly}`) && sql.includes('LIMIT 1'))
          return [{ stored_hour: stored }];
        // sentinels, none final
        return [];
      });
      const ch = {
        query,
        queryOne: async (...args: unknown[]) => ((await query(...(args as [string]))) as unknown[])[0],
      };
      await service(ch as never).svc.get();
      const ranges = query.mock.calls
        .filter(([sql]) => sql.includes('newest_final'))
        .map((call) => (call as unknown as [string, { since: number; until: number }])[1]);
      expect(ranges[0]).toEqual({ since: stored - 719 * 3600, until: stored });
      // the ranges touch, and the last ends with the oldest hour the table keeps: 9,600 hours with the newest
      for (let i = 1; i < ranges.length; i++) expect(ranges[i].until).toBe(ranges[i - 1].since - 3600);
      expect(ranges[ranges.length - 1].since).toBe(stored - (400 * 24 - 1) * 3600);
      expect(ranges).toHaveLength(Math.ceil((400 * 24) / 720));
    });
  });
});

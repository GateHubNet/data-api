import { getNetworkProfile } from '@gatehub/data-api-shared';
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
});

import { ClickHouseService, RollupCoverage } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { AccountDayGroupsService, ROLLUP_COVERAGE_CACHE_MS } from './account-day-groups.service';

const ACCOUNT = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';

/** What `rollupCoverage` reads: the newest state row of the account, here with the coverage it is given (or none). */
function stateRows(coverage?: RollupCoverage): { rolled_from: string; rolled_through: string }[] {
  return coverage === undefined ? [] : [{ rolled_from: coverage.from, rolled_through: coverage.through }];
}

describe('AccountDayGroupsService', () => {
  let query: jest.Mock;
  let resolve: jest.Mock;
  let cache: CacheService;
  let metrics: PrometheusService;
  let service: AccountDayGroupsService;
  /** What the state of an account says, by account; changed by a test to move the coverage under the cache. */
  let coverage: Map<string, RollupCoverage>;

  /** The count of `api_account_day_groups_total` for a source (the registry is the process's, so tests compare deltas). */
  async function counted(source: string): Promise<number> {
    const { values } = await metrics.accountDayGroupsTotal.get();
    return values.find((v) => v.labels.source === source)?.value ?? 0;
  }

  beforeEach(() => {
    coverage = new Map();
    query = jest.fn(async (_sql: string, params: { account: string }) => stateRows(coverage.get(params.account)));
    resolve = jest.fn(async () => ({ min: 10, max: 20 }));
    cache = new CacheService();
    metrics = new PrometheusService();
    service = new AccountDayGroupsService(
      { query } as unknown as ClickHouseService,
      { resolve } as unknown as LedgerRangeResolver,
      cache,
      metrics,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps the coverage of an account for 60 s', () => {
    expect(ROLLUP_COVERAGE_CACHE_MS).toBe(60_000);
  });

  it('reads the raw rows of a window the account has no rollup for, with the ledgers the resolver finds', async () => {
    const source = await service.source('txs', ACCOUNT, '2020-01-01', '2020-01-10');
    expect(source?.sources).toEqual(['raw']);
    expect(source?.params).toMatchObject({ dg_account: ACCOUNT, dg_min0: 10, dg_max0: 20 });
    expect(resolve).toHaveBeenCalledWith(new Date('2020-01-01T00:00:00Z'), new Date('2020-01-11T00:00:00Z'));
  });

  it('reads the rollup for the days it covers and the raw rows for the rest, and counts each source once', async () => {
    coverage.set(ACCOUNT, { from: '2020-01-05', through: '2020-01-08' });
    const [raw, rollup] = [await counted('raw'), await counted('rollup')];
    const source = await service.source('lines', ACCOUNT, '2020-01-01', '2020-01-10');
    expect(source?.sources).toEqual(['raw', 'rollup']);
    expect(source?.params).toMatchObject({ dg_from: '2020-01-05', dg_through: '2020-01-08' });
    // two raw ranges (before and after the rollup) are one read of the raw source
    expect([(await counted('raw')) - raw, (await counted('rollup')) - rollup]).toEqual([1, 1]);
  });

  it('counts the rollup alone as a rollup read, and a window without any source as nothing', async () => {
    coverage.set(ACCOUNT, { from: '2020-01-01', through: '2020-01-31' });
    const [raw, rollup] = [await counted('raw'), await counted('rollup')];
    expect((await service.source('lines', ACCOUNT, '2020-01-05', '2020-01-08'))?.sources).toEqual(['rollup']);
    expect([(await counted('raw')) - raw, (await counted('rollup')) - rollup]).toEqual([0, 1]);

    resolve.mockResolvedValue(null);
    expect(await service.source('lines', 'rOther', '2020-01-05', '2020-01-08')).toBeNull();
    expect(await service.source('lines', ACCOUNT, '2020-01-09', '2020-01-08')).toBeNull();
    expect([(await counted('raw')) - raw, (await counted('rollup')) - rollup]).toEqual([0, 1]);
  });

  it('asks for the coverage of an account once a minute: a second read finds it in the cache', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    coverage.set(ACCOUNT, { from: '2020-01-01', through: '2020-01-31' });
    await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08');
    expect(query).toHaveBeenCalledTimes(1);
    expect(cache.get<RollupCoverage>(`rollup-coverage:${ACCOUNT}`)).toEqual({
      from: '2020-01-01',
      through: '2020-01-31',
    });

    // the state row moves: the cached coverage is still what the next reads use, until the minute is over
    coverage.delete(ACCOUNT);
    now.mockReturnValue(1_000_000 + ROLLUP_COVERAGE_CACHE_MS - 1);
    expect((await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08'))?.sources).toEqual(['rollup']);
    expect(query).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + ROLLUP_COVERAGE_CACHE_MS + 1);
    expect((await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08'))?.sources).toEqual(['raw']);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps the coverage of each account on its own, and keeps "no coverage" too', async () => {
    coverage.set('rWithRollup', { from: '2020-01-01', through: '2020-01-31' });
    expect((await service.source('txs', 'rWithRollup', '2020-01-05', '2020-01-08'))?.sources).toEqual(['rollup']);
    expect((await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08'))?.sources).toEqual(['raw']);
    expect(query).toHaveBeenCalledTimes(2);
    // an account without a rollup is not asked again either
    await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08');
    await service.source('lines', ACCOUNT, '2020-01-05', '2020-01-08');
    expect(query).toHaveBeenCalledTimes(2);
    // emptying the cache asks again
    cache.clear();
    await service.source('txs', ACCOUNT, '2020-01-05', '2020-01-08');
    expect(query).toHaveBeenCalledTimes(3);
  });
});

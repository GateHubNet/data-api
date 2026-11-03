import { ClickHouseService, getNetworkProfile } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { FeatureCoverageService } from '../common/feature-coverage.service';
import { TokenHoldersService } from './token-holders.service';
import { TokenMarkets } from './token-markets';
import { TOKENS_GENERATION_CACHE_KEY, TOKENS_GENERATION_CACHE_MS, TokensService } from './tokens.service';

const THROUGH = 107_900_000;
const CLOSE_TIME = 1_793_245_841;

/** The newest row of a live generation, as `readTokenGenerations` reads it. */
const LIVE_ROW = {
  generation: '7',
  state: 'live',
  config_version: 1,
  coverage_from: 32_570,
  head_ledger: THROUGH - 1_000,
  account_cursor: '',
  pass_done: 1,
  through_ledger: THROUGH,
  repair_from: 0,
  holders: 4_321,
  holders_ledger: THROUGH - 5,
  started_ms: '1793242241000',
  changed_ms: '1793245836000',
  version_text: '500',
};

/** A `TokensService` over a stub of ClickHouse that answers the two reads of `live()`, and the cache it keeps the generation in. */
function build(generations: unknown[] = [LIVE_ROW]) {
  const query = jest.fn(async (sql: string): Promise<unknown[]> => {
    if (sql.includes('FROM token_generations')) return Promise.resolve(generations);
    if (sql.includes('FROM ledgers')) return Promise.resolve([{ close_time: String(CLOSE_TIME) }]);
    throw new Error(`unexpected read: ${sql}`);
  });
  const cache = new CacheService();
  const service = new TokensService(
    { query } as unknown as ClickHouseService,
    cache,
    {} as FeatureCoverageService,
    {} as TokenMarkets,
    {} as TokenHoldersService,
    getNetworkProfile('xrpl'),
  );
  const generationReads = (): number =>
    query.mock.calls.filter(([sql]) => sql.includes('FROM token_generations')).length;
  return { query, cache, service, generationReads };
}

describe('TokensService.live', () => {
  afterEach(() => jest.useRealTimers());

  it('is the generation that is live, the ledger it is through and when that closed, and its distinct holders', async () => {
    const { service } = build();
    expect(await service.live()).toEqual({
      generation: 7,
      ledgerIndex: THROUGH,
      closeTime: CLOSE_TIME,
      holders: 4_321,
      holdersLedger: THROUGH - 5,
    });
  });

  it('is undefined while no generation is live (one that builds or is retired is not)', async () => {
    const { service, query } = build([
      { ...LIVE_ROW, generation: '3', state: 'retired' },
      { ...LIVE_ROW, generation: '4', state: 'building' },
    ]);
    expect(await service.live()).toBeUndefined();
    // and no ledger was asked for
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps the generation 5 s under one fixed key: read once within that time, and again after it', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-24T14:00:00Z') });
    const { service, cache, generationReads } = build();
    const wrap = jest.spyOn(cache, 'wrap');
    expect(TOKENS_GENERATION_CACHE_MS).toBe(5_000);

    await Promise.all([service.live(), service.live(), service.live()]);
    expect(generationReads()).toBe(1);
    // the one key and the one ttl, whoever asks
    expect(new Set(wrap.mock.calls.map(([key, ttl]) => `${key} ${ttl}`))).toEqual(
      new Set([`${TOKENS_GENERATION_CACHE_KEY} 5000`]),
    );

    // 4,999 ms later it is the same read, 1 ms after that (5 s) it is read again
    jest.setSystemTime(Date.now() + 4_999);
    await service.live();
    expect(generationReads()).toBe(1);
    jest.setSystemTime(Date.now() + 1);
    await service.live();
    expect(generationReads()).toBe(2);
    // and that read is kept for 5 s as well
    jest.setSystemTime(Date.now() + 4_999);
    await service.live();
    expect(generationReads()).toBe(2);
  });

  it('keeps no failure: a generation whose ledger is not stored fails every call until it is', async () => {
    const { service, query } = build();
    query.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM token_generations')) return Promise.resolve([LIVE_ROW]);
      return Promise.resolve([]);
    });
    await expect(service.live()).rejects.toThrow(`through ledger ${THROUGH}, which is not stored`);
    await expect(service.live()).rejects.toThrow('which is not stored');
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM token_generations'))).toHaveLength(2);
  });
});

describe('TokensService.token and holders: what is not a token needs no read', () => {
  const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
  const LP = `03${'AB'.repeat(19)}`;

  it('an LP token is not found without a read of anything', async () => {
    const { service, query } = build();
    expect(await service.token({ currency: LP, issuer: ISSUER })).toBeUndefined();
    expect(await service.holders({ currency: LP, issuer: ISSUER }, { limit: 10 })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('no live generation is not found, and the token is not read', async () => {
    const { service, query } = build([]);
    expect(await service.token({ currency: 'USD', issuer: ISSUER })).toBeUndefined();
    expect(await service.holders({ currency: 'USD', issuer: ISSUER }, { limit: 10 })).toBeUndefined();
    expect(query.mock.calls.every(([sql]) => sql.includes('FROM token_generations'))).toBe(true);
  });
});

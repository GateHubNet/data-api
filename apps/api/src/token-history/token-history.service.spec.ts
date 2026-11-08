import { CacheService } from '../common/cache.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { TOKEN_HISTORY_LIVE_CACHE_MS, TokenHistoryService } from './token-history.service';

/** A state row of `readTokenHistoryStates`'s read, as ClickHouse sends it. */
const stateRow = (o: Record<string, unknown>) => ({
  generation: 1,
  state: 'live',
  config_version: 1,
  coverage_from: 500,
  h0: 900,
  h1: 900,
  phase: 'done',
  account_cursor: '',
  token_cursor_issuer: '',
  token_cursor_currency: '',
  through_ledger: 1_000,
  levels_through: 1_000,
  started_ms: '1700000000000',
  changed_ms: '1700000000000',
  version_text: '1',
  ...o,
});

function fakeClickHouse(states: Record<string, unknown>[]) {
  const query = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes('token_history_state')) return states;
    if (sql.includes('ledger_by_hash')) return params?.hash === 'AB'.repeat(32) ? [{ ledger_index: 700 }] : [];
    if (sql.includes('FROM ledgers'))
      return [{ ledger_index: params?.n, close_time: 1_700_000_000 + Number(params?.n) }];
    throw new Error(`unexpected query ${sql}`);
  });
  return { query };
}

describe('TokenHistoryService', () => {
  afterEach(() => jest.useRealTimers());

  it('live is undefined before a generation is live', async () => {
    const ch = fakeClickHouse([stateRow({ state: 'building' })]);
    const svc = new TokenHistoryService(ch as never, new CacheService(), {} as LedgerRangeResolver);
    expect(await svc.live()).toBeUndefined();
  });

  it('live is the highest live generation, as of its levels_through, with its close time', async () => {
    const ch = fakeClickHouse([
      stateRow({ generation: 1, state: 'retired' }),
      stateRow({ generation: 2, through_ledger: 1_010, levels_through: 1_004, coverage_from: 600 }),
    ]);
    const svc = new TokenHistoryService(ch as never, new CacheService(), {} as LedgerRangeResolver);
    expect(await svc.live()).toEqual({ generation: 2, through: 1_004, close_time: 1_700_001_004, coverage_from: 600 });
  });

  it('live is kept 5 s under one key', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const ch = fakeClickHouse([stateRow({})]);
    const svc = new TokenHistoryService(ch as never, new CacheService(), {} as LedgerRangeResolver);
    await svc.live();
    await svc.live();
    expect(ch.query).toHaveBeenCalledTimes(2); // the states and the close time, once
    expect(TOKEN_HISTORY_LIVE_CACHE_MS).toBe(5_000);
    jest.setSystemTime(1_700_000_000_000 + TOKEN_HISTORY_LIVE_CACHE_MS + 1);
    await svc.live();
    expect(ch.query).toHaveBeenCalledTimes(4);
  });

  it('resolves a ledger through the stored hashes and the dates of LedgerRangeResolver', async () => {
    const ch = fakeClickHouse([stateRow({})]);
    const ranges = { ledgerAtOrBefore: jest.fn(async () => 950) } as unknown as LedgerRangeResolver;
    const svc = new TokenHistoryService(ch as never, new CacheService(), ranges);
    const live = (await svc.live())!;
    expect(await svc.resolveLedger({ ledger_hash: 'AB'.repeat(32) }, live)).toBe(700);
    expect(await svc.resolveLedger({ date: '2020-01-01' }, live)).toBe(950);
  });
});

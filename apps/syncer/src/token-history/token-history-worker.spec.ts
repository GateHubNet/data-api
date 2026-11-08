import { LIVE_INTENT_RUN_PREFIX, TokenHistoryStateRow } from '@gatehub/data-api-shared';
import { LIVE_INTENT_PREFIX } from '../ingest/live-runner';
import { TokenHistoryWorker } from './token-history-worker';
import { TokenHistorySteps } from './token-history.options';

/** A ClickHouse that knows the commit marker and the lease row, and nothing else. */
function fakeClickHouse(head: number | null) {
  return {
    query: jest.fn(async () => []),
    queryOne: jest.fn(async (sql: string) =>
      sql.includes('maxOrNull(ledger_index)') ? { checkpoint: head } : { holder: '', age_ms: '0', n: '0' },
    ),
    insert: jest.fn(),
    command: jest.fn(),
    commandSummary: jest.fn(),
  };
}

const live = (o: Partial<TokenHistoryStateRow> = {}): TokenHistoryStateRow => ({
  generation: 1,
  state: 'live',
  config_version: 1,
  coverage_from: 10,
  h0: 90,
  h1: 90,
  phase: 'done',
  account_cursor: '',
  token_cursor_issuer: '',
  token_cursor_currency: '',
  through_ledger: 100,
  levels_through: 100,
  started_at: 1_700_000_000,
  changed_at: 1_700_000_000,
  version: '1',
  ...o,
});

/** Steps that do nothing, over the given generations. */
function quietSteps(gens: TokenHistoryStateRow[], over: Partial<TokenHistorySteps> = {}): Partial<TokenHistorySteps> {
  return {
    readStates: jest.fn(async () => gens),
    applyLiveWindow: jest.fn(async () => ({ to: 100, changes: 0 })),
    catchUpLevels: jest.fn(async () => 100),
    repairOldestRange: jest.fn(async () => 'none' as const),
    promoteIfCaughtUp: jest.fn(async () => false),
    dropRetired: jest.fn(async () => []),
    rebuildNeeded: jest.fn(async () => undefined),
    dexThrough: jest.fn(async () => new Date(3_600_000)),
    oldestFinalPairHour: jest.fn(async () => undefined),
    dexHoursFromPairHourly: jest.fn(async () => 'not_final' as const),
    ...over,
  };
}

function fakeMetrics() {
  const labelled = () => ({ set: jest.fn(), inc: jest.fn(), remove: jest.fn(), reset: jest.fn(), observe: jest.fn() });
  return {
    tokenHistoryLagLedgers: labelled(),
    tokenHistoryRebuildNeeded: labelled(),
    tokenHistoryBuilding: labelled(),
    tokenHistoryWindowSeconds: labelled(),
    tokenHistoryErrorsTotal: labelled(),
    tokenHistoryUnfitSumsTotal: labelled(),
  };
}

const workerOf = (ch: unknown, steps: Partial<TokenHistorySteps>, metrics?: unknown) =>
  new TokenHistoryWorker(ch as never, { network: 'xrpl' } as never, { hasMpt: true } as never, undefined, {
    start: false,
    holder: 'w1',
    steps,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    now: () => 100_000_000,
  }, metrics as never);

describe('TokenHistoryWorker', () => {
  it('a pass does nothing without a committed ledger', async () => {
    const ch = fakeClickHouse(null);
    const steps = quietSteps([]);
    const worker = workerOf(ch, steps);
    await expect(worker.pass()).resolves.toEqual({ head: undefined });
    expect(ch.insert).not.toHaveBeenCalled();
    expect(ch.command).not.toHaveBeenCalled();
    expect(steps.readStates).not.toHaveBeenCalled();
  });

  it('rebuild_needed shows none on an empty database', async () => {
    const metrics = fakeMetrics();
    const steps = quietSteps([], { rebuildNeeded: jest.fn(async () => 'none' as const) });
    await workerOf(fakeClickHouse(100), steps, metrics).pass();
    expect(metrics.tokenHistoryRebuildNeeded.set).toHaveBeenCalledWith({ reason: 'none' }, 1);
    // no live generation: no lag
    expect(metrics.tokenHistoryLagLedgers.remove).toHaveBeenCalled();
  });

  it('the worker writes the DEX hour once pair_hourly is final', async () => {
    const hour = new Date(7_200_000);
    let final = false;
    const dex = jest.fn(async (_ch: unknown, h: Date) => (final && h.getTime() === hour.getTime() ? ('written' as const) : ('not_final' as const)));
    const steps = quietSteps([live()], { dexThrough: jest.fn(async () => hour), dexHoursFromPairHourly: dex });
    const worker = workerOf(fakeClickHouse(100), steps);
    await worker.pass();
    expect(dex).toHaveBeenCalledWith(expect.anything(), hour);
    expect(dex).toHaveBeenCalledTimes(1);
    final = true;
    const pass = await worker.pass();
    expect(pass.dexHours).toBe(1);
  });

  it('an error in one step is counted and the next pass runs', async () => {
    const metrics = fakeMetrics();
    let fail = true;
    const steps = quietSteps([live({ through_ledger: 99 })], {
      applyLiveWindow: jest.fn(async () => {
        if (fail) throw new Error('memory limit');
        return { to: 100, changes: 3 };
      }),
    });
    const worker = workerOf(fakeClickHouse(100), steps, metrics);
    await expect(worker.pass()).resolves.toMatchObject({ head: 100 });
    expect(metrics.tokenHistoryErrorsTotal.inc).toHaveBeenCalledWith({ step: 'live' });
    // the steps after the live window still ran
    expect(steps.dropRetired).toHaveBeenCalled();
    fail = false;
    await expect(worker.pass()).resolves.toMatchObject({ head: 100, windows: 1 });
    expect(metrics.tokenHistoryWindowSeconds.observe).toHaveBeenCalledTimes(1);
  });

  it('sets the lag and the building phase from the state rows', async () => {
    const metrics = fakeMetrics();
    const gens = [live({ levels_through: 95 }), live({ generation: 2, state: 'building', phase: 'levels' })];
    await workerOf(fakeClickHouse(100), quietSteps(gens), metrics).pass();
    expect(metrics.tokenHistoryLagLedgers.set).toHaveBeenCalledWith(5);
    expect(metrics.tokenHistoryBuilding.set).toHaveBeenCalledWith({ phase: 'levels' }, 1);
  });
});

describe('the range-ingest check of the token history', () => {
  it("leaves out the live runner's intents by the live runner's own prefix", () => {
    expect(LIVE_INTENT_RUN_PREFIX).toBe(LIVE_INTENT_PREFIX);
  });
});

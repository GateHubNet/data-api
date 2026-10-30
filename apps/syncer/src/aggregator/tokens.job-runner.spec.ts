import {
  ClickHouseService,
  getNetworkProfile,
  LedgerRange,
  LineKey,
  RatesService,
  TOKEN_PARSER_VERSION,
  TokenGenerationsRow,
  TokenKey,
  TOKENS_CONFIG_VERSION,
  TOKENS_HOUSEKEEPING_EVERY_TICKS,
  TOKENS_PASS_ACCOUNTS,
  TOKENS_PROMOTE_NEAR_HEAD,
  TOKENS_RETIRED_KEEP_MS,
  TOKENS_STATE_CHUNK,
  TOKENS_TOUCH_WINDOW,
  TOKENS_TOUCH_WINDOW_MAX_LINES,
  TokensAborted,
} from '@gatehub/data-api-shared';
import { AggregatorJobContext, AggregatorTick } from './job-context';
import { NFT_MAX_RETRY_MS, NFT_RETRY_MS } from './nft-state.job-runner';
import { AggregatorTokens, TOKENS_FUNCTIONS, TokensFunctions, TokensJobRunner } from './tokens.job-runner';

/**
 * The `tokens` job (`TokensJobRunner`), driven on its own over a hand-made context and fakes of the shared functions
 * (`TokensFunctions`) that keep `token_generations` in memory: what a run does and in which order, what it writes and when, how it
 * stops at its budget and goes on from the stored rows, and the hook of `agg_dirty`. The functions themselves are tested in
 * `packages/shared/test/tokens.job.e2e-spec.ts`; the real tables meet the runner in `aggregator-tokens.e2e-spec.ts`.
 */

const NOW = new Date('2026-10-16T12:34:56Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const BUDGET_MS = 4000;
const COVERAGE = 100;
const ISSUER = 'rIssuer';
const USD = '0000000000000000000000005553440000000000';
const PROFILE = getNetworkProfile('xrpl');

type Queue = Array<Error | undefined>;

/** A generation row as the table would hold it: live and complete unless the test says otherwise. */
const gen = (
  generation: number,
  state: TokenGenerationsRow['state'],
  o: Partial<TokenGenerationsRow> = {},
): TokenGenerationsRow => ({
  generation,
  state,
  config_version: TOKENS_CONFIG_VERSION,
  coverage_from: COVERAGE,
  head_ledger: 1000,
  account_cursor: '',
  pass_done: 1,
  through_ledger: 1000,
  repair_from: 0,
  holders: 0,
  holders_ledger: 0,
  started_at: NOW_SECONDS - 3600,
  changed_at: NOW_SECONDS - 3600,
  version: '1',
  ...o,
});

const token = (n: number): TokenKey => ({ issuer: `rIssuer${n}`, currency: USD });

/**
 * The fakes of the shared functions over a table of generations kept in memory, and everything they were asked, in order. A call
 * can take fake time (`costs`, by the name of the step), fail (`failures`: a queue, one entry per call, `undefined` for a call
 * that works), and tell the test what the table said at that moment (`onCall`).
 */
class World {
  gens = new Map<number, TokenGenerationsRow>();
  head = 1500;
  coverage: number | undefined = COVERAGE;
  floor = '0';
  /** Every call, in order: the name of the step or the line `step` was given. */
  events: string[] = [];
  /** Every generation row written, in order. */
  written: TokenGenerationsRow[] = [];
  /** Every version a write was given, in order. */
  versions: Array<{ what: string; version: string }> = [];
  windows: Array<{ from: number; head: number; window?: number }> = [];
  parserCalls: Array<{ from: number; to: number }> = [];
  applied: Array<{ generation: number; lines: LineKey[]; atLedger: number; version: string }> = [];
  recomputed: Array<{
    generation: number;
    tokens: TokenKey[];
    atLedger: number;
    version: string;
    rematch: 'all' | ReadonlySet<string>;
  }> = [];
  passes: Array<{ generation: number; after: string; through: string; head: number; version: string }> = [];
  passSizes: number[] = [];
  sweeps: Array<{ generation: number; version: string; after?: TokenKey; limit?: number }> = [];
  dropped: number[] = [];
  /** How many lines each ledger of a window has touched. */
  linesPerLedger = 1;
  /** The accounts the touches of every window name. */
  issuersOfWindow: string[] = [];
  /** The lowest parser version of the ledgers `(from, to]`. */
  parserFloor: (from: number, to: number) => number | null = () => TOKEN_PARSER_VERSION;
  /** The accounts that have trust lines, in key order, and how many a batch of the pass takes (the real one takes TOKENS_PASS_ACCOUNTS). */
  accounts: string[] = [];
  accountsPerBatch = 2;
  holders = 7;
  sweepAnswers: Array<{ rewritten: number; next?: TokenKey }> = [];
  costs = new Map<string, number>();
  failures = new Map<string, Queue>();
  onCall?: (name: string) => void;

  /** A pass that outlasts the runs of a test: many accounts, one a batch, and a batch takes the whole budget. */
  slowBuild(): void {
    this.accounts = Array.from({ length: 60 }, (_, i) => `r${String(i).padStart(3, '0')}`);
    this.accountsPerBatch = 1;
    this.costs.set('writePassLines', BUDGET_MS);
  }

  seed(...rows: TokenGenerationsRow[]): void {
    for (const row of rows) this.gens.set(row.generation, { ...row });
  }

  g(generation: number): TokenGenerationsRow {
    return this.gens.get(generation) as TokenGenerationsRow;
  }

  fail(name: string, ...errors: Array<Error | undefined>): void {
    this.failures.set(name, errors);
  }

  /** The calls without the reads every run makes. */
  trace(): string[] {
    return this.events.filter((e) => !['read', 'head', 'floor', 'coverage'].includes(e));
  }

  private step(name: string, event: string = name): void {
    this.events.push(event);
    this.onCall?.(name);
    const cost = this.costs.get(name);
    if (cost) jest.setSystemTime(Date.now() + cost);
    const error = this.failures.get(name)?.shift();
    if (error) throw error;
  }

  fns(): TokensFunctions {
    const aborted = (signal?: AbortSignal): void => {
      if (signal?.aborted) throw new TokensAborted();
    };
    return {
      readTokenGenerations: async () => {
        this.step('read');
        return [...this.gens.values()].sort((a, b) => a.generation - b.generation).map((g) => ({ ...g }));
      },
      writeTokenGeneration: async (_ch, row, signal) => {
        aborted(signal);
        this.step('write', `row g${row.generation} ${row.state} t${row.through_ledger}`);
        this.versions.push({ what: 'row', version: String(row.version) });
        this.written.push({ ...row });
        this.gens.set(row.generation, { ...row });
      },
      stateCoverageStart: async () => {
        this.step('coverage');
        return this.coverage;
      },
      tokensVersionFloor: async () => {
        this.step('floor');
        return this.floor;
      },
      head: async () => {
        this.step('head');
        return this.head;
      },
      nextPassAccounts: async (_ch, after, n) => {
        this.passSizes.push(n);
        this.step('accounts', `accounts ${after === '' ? "''" : after}`);
        return this.accounts.filter((a) => a > after).slice(0, this.accountsPerBatch);
      },
      writePassLines: async (_ch, p, signal) => {
        aborted(signal);
        this.passes.push(p);
        this.versions.push({ what: 'pass', version: p.version });
        this.step('writePassLines', `pass g${p.generation} (${p.after === '' ? "''" : p.after},${p.through}]`);
      },
      passTokens: async (_ch, p) => {
        this.step('passTokens', `passTokens g${p.generation}`);
        return [{ issuer: ISSUER, currency: USD }];
      },
      parserFloorOf: async (_ch, from, to) => {
        this.parserCalls.push({ from, to });
        this.step('parser', `parser ${from}-${to}`);
        return this.parserFloor(from, to);
      },
      touchesOfWindow: async (_ch, from, head, o = {}) => {
        // as the real one: halved while the window holds more distinct lines than `maxLines`, never below a ledger
        const maxLines = o.maxLines ?? TOKENS_TOUCH_WINDOW_MAX_LINES;
        let window = Math.max(1, Math.floor(o.window ?? TOKENS_TOUCH_WINDOW));
        while (window > 1 && window * this.linesPerLedger > maxLines) window = Math.max(1, Math.floor(window / 2));
        const to = Math.max(from, Math.min(from + window, head));
        this.windows.push({ from, head, window: o.window });
        this.step('window', `window ${from}-${to}`);
        if (to === from) return { to, lines: [], issuers: [] };
        const lines = Array.from({ length: (to - from) * this.linesPerLedger }, (_, i) => ({
          account: 'rLow',
          counterparty: 'rHigh',
          currency: String(i),
        }));
        return { to, lines, issuers: this.issuersOfWindow };
      },
      applyLineStates: async (_ch, p, signal) => {
        aborted(signal);
        this.applied.push({ generation: p.generation, lines: [...p.lines], atLedger: p.atLedger, version: p.version });
        this.versions.push({ what: 'apply', version: p.version });
        this.step('apply', `apply g${p.generation} @${p.atLedger}`);
        return [{ issuer: ISSUER, currency: USD }];
      },
      tokensOfIssuers: async (_ch, generation, issuers) => {
        this.step('issuers', `issuers g${generation}`);
        return issuers.map((issuer) => ({ issuer, currency: USD }));
      },
      recomputeTokens: async (_ch, p, signal) => {
        aborted(signal);
        this.recomputed.push({
          generation: p.generation,
          tokens: [...p.tokens],
          atLedger: p.atLedger,
          version: p.version,
          rematch: p.rematch,
        });
        this.versions.push({ what: 'recompute', version: p.version });
        this.step('recompute', `recompute g${p.generation} @${p.atLedger}`);
      },
      distinctHolders: async (_ch, generation) => {
        this.step('holders', `holders g${generation}`);
        return this.holders;
      },
      tomlSweep: async (_ch, p, signal) => {
        aborted(signal);
        this.sweeps.push({ generation: p.generation, version: p.version, after: p.after, limit: p.limit });
        this.versions.push({ what: 'sweep', version: p.version });
        this.step('sweep', `sweep g${p.generation}`);
        const answer = this.sweepAnswers.shift();
        return { rewritten: answer?.rewritten ?? 0, next: answer?.next };
      },
      dropTokenGeneration: async (_ch, generation) => {
        this.step('drop', `drop g${generation}`);
        this.dropped.push(generation);
      },
    };
  }
}

describe('TokensJobRunner', () => {
  let world: World;
  let closing: boolean;
  let abort: AbortController;
  let slice: LedgerRange | null;
  let ledgersClosedIn: jest.Mock;
  let failed: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let metrics: Record<'tokensLive' | 'tokensLagLedgers' | 'tokensBuilding' | 'tokensRepairLedgers', { set: jest.Mock }>;

  const context = (withMetrics = true): AggregatorJobContext => ({
    ch: {} as ClickHouseService,
    logger,
    metrics: withMetrics ? (metrics as never) : undefined,
    budgets: { tokens: BUDGET_MS } as AggregatorJobContext['budgets'],
    clock: () => Date.now(),
    closing: () => closing,
    mayStartSet: (tick) => !closing && Date.now() < tick.deadline,
    failed,
    versionsOf: async () => new Map(),
    latestCloseTime: async () => undefined,
    announceBackfill: () => undefined,
  });
  const make = (o: Partial<AggregatorTokens> = {}, withMetrics = true): TokensJobRunner =>
    new TokensJobRunner(
      context(withMetrics),
      { profile: PROFILE, rates: { ledgersClosedIn } as unknown as RatesService, ...o },
      world.fns(),
    );
  const tick = (): AggregatorTick => ({ now: new Date(), deadline: Date.now() + BUDGET_MS, signal: abort.signal });
  const run = (r: TokensJobRunner): Promise<void> => r.run(tick());
  const runs = async (r: TokensJobRunner, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await run(r);
  };
  const lastOf = (mock: jest.Mock): unknown => mock.mock.calls[mock.mock.calls.length - 1]?.[0];
  /** What the gauges were last set to. */
  const gauges = () => ({
    live: lastOf(metrics.tokensLive.set),
    lag: lastOf(metrics.tokensLagLedgers.set),
    building: lastOf(metrics.tokensBuilding.set),
    repair: lastOf(metrics.tokensRepairLedgers.set),
  });
  const minutes = (n: number): number => n * 60_000;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    world = new World();
    closing = false;
    abort = new AbortController();
    slice = null;
    ledgersClosedIn = jest.fn(async () => slice);
    failed = jest.fn();
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    metrics = {
      tokensLive: { set: jest.fn() },
      tokensLagLedgers: { set: jest.fn() },
      tokensBuilding: { set: jest.fn() },
      tokensRepairLedgers: { set: jest.fn() },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the shared functions by default', () => {
    expect(Object.keys(TOKENS_FUNCTIONS).sort()).toEqual(Object.keys(world.fns()).sort());
    for (const fn of Object.values(TOKENS_FUNCTIONS)) expect(typeof fn).toBe('function');
  });

  describe('a run', () => {
    it('runs live touches, repair, housekeeping, the building generation and the drop, in that order', async () => {
      const r = make();
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS); // nothing to do
      world.accounts = ['rA'];
      world.seed(
        gen(0, 'retired', { changed_at: NOW_SECONDS - 3600 }),
        gen(1, 'live', { through_ledger: 1000, repair_from: 1400 }),
        gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }),
      );
      world.events = [];
      await run(r); // the 11th
      expect(world.events.filter((e) => e !== 'read' && e !== 'head' && e !== 'floor')).toEqual([
        // live touches
        'window 1000-1500',
        'parser 1000-1500',
        'apply g1 @1500',
        'recompute g1 @1500',
        'row g1 live t1500',
        // repair of [1400, 1500]
        'window 1399-1500',
        'parser 1399-1500',
        'apply g1 @1500',
        'recompute g1 @1500',
        'row g1 live t1500',
        // housekeeping: the rebuild check, the distinct holders, the sweep
        'coverage',
        'holders g1',
        'row g1 live t1500',
        'sweep g1',
        // the building generation: its pass, its touches, its promotion
        "accounts ''",
        "pass g2 ('',rA]",
        'passTokens g2',
        'recompute g2 @1200',
        'row g2 building t1200',
        'accounts rA',
        'row g2 building t1200',
        'window 1200-1500',
        'parser 1200-1500',
        'apply g2 @1500',
        'recompute g2 @1500',
        'row g2 building t1500',
        'row g2 live t1500',
        'row g1 retired t1500',
        // the drop
        'drop g0',
      ]);
      expect(world.g(1)).toMatchObject({ state: 'retired', repair_from: 0, holders: 7, holders_ledger: 1500 });
      expect(world.g(2)).toMatchObject({ state: 'live', pass_done: 1, account_cursor: 'rA', through_ledger: 1500 });
      expect(world.passSizes).toEqual([TOKENS_PASS_ACCOUNTS, TOKENS_PASS_ACCOUNTS]);
    });

    it("applies the lines and the issuers of a window at its end: the tokens of both, rematching the window's issuers", async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.issuersOfWindow = ['rSetter'];
      world.linesPerLedger = 1;
      await run(make());
      expect(world.applied).toHaveLength(1);
      expect(world.applied[0]).toMatchObject({ generation: 1, atLedger: 1500 });
      expect(world.applied[0].lines).toHaveLength(500);
      expect(world.trace().slice(0, 5)).toEqual([
        'window 1000-1500',
        'parser 1000-1500',
        'apply g1 @1500',
        'issuers g1',
        'recompute g1 @1500',
      ]);
      const [recompute] = world.recomputed;
      expect(recompute.tokens).toEqual([
        { issuer: ISSUER, currency: USD },
        { issuer: 'rSetter', currency: USD },
      ]);
      expect(recompute.atLedger).toBe(1500);
      expect(recompute.rematch).toEqual(new Set(['rSetter']));
    });

    it('only moves through_ledger for a window with no touches', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.linesPerLedger = 0;
      await run(make());
      expect(world.trace()).toEqual(['window 1000-1500', 'parser 1000-1500', 'row g1 live t1500']);
      expect(world.g(1).through_ledger).toBe(1500);
    });

    it('does nothing at the head', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      await run(make());
      expect(world.trace()).toEqual([]);
    });

    it('stops at the budget and goes on next tick from the stored cursors', async () => {
      world.head = 6000;
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.costs.set('apply', 1500);
      const r = make();
      await run(r);
      expect(world.g(1).through_ledger).toBe(2500); // 3 windows: the 3rd started at 3 s, ended at 4.5 s
      expect(world.windows.map((w) => w.from)).toEqual([1000, 1500, 2000]);
      await run(r);
      expect(world.g(1).through_ledger).toBe(4000);
      expect(world.windows.map((w) => w.from).slice(3)).toEqual([2500, 3000, 3500]);
      // a restart forgets everything but the rows
      await run(make());
      expect(world.g(1).through_ledger).toBe(5500);
      expect(world.windows.map((w) => w.from).slice(6)).toEqual([4000, 4500, 5000]);
    });

    it('moves through_ledger only after the lines and the tokens of the window are written', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      const seen: Array<[string, number]> = [];
      world.onCall = (name) => {
        if (name === 'apply' || name === 'recompute') seen.push([name, world.g(1).through_ledger]);
      };
      await run(make());
      expect(seen).toEqual([
        ['apply', 1000],
        ['recompute', 1000],
      ]);
      expect(world.g(1).through_ledger).toBe(1500);
    });

    it('a crash between lines and tokens is repaired by the next run', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.fail('recompute', new Error('Code: 241. Memory limit exceeded'));
      const r = make();
      await expect(run(r)).rejects.toThrow('Memory limit exceeded');
      expect(world.g(1).through_ledger).toBe(1000);
      expect(world.applied).toHaveLength(1);
      await run(r);
      // the same window again, lines and tokens, and only then the cursor
      expect(world.applied.map((a) => [a.atLedger, a.generation])).toEqual([
        [1500, 1],
        [1500, 1],
      ]);
      expect(world.windows.map((w) => w.from)).toEqual([1000, 1000]);
      expect(world.g(1).through_ledger).toBe(1500);
    });

    it('does not start a generation without a ledger', async () => {
      world.head = 0;
      const r = make();
      await runs(r, 2);
      expect(world.written).toEqual([]);
      expect(world.events.filter((e) => e === 'coverage')).toEqual([]);
      // nor when no ledger is stored for the coverage
      world.head = 1500;
      world.coverage = undefined;
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS);
      expect(world.written).toEqual([]);
    });

    it('starts the first generation at the first run that has a ledger, not at the next housekeeping', async () => {
      world.head = 0;
      const r = make();
      await runs(r, 3);
      expect(world.written).toEqual([]);
      world.head = 1500;
      world.slowBuild();
      await run(r); // the 4th
      expect(world.written[0]).toMatchObject({ generation: 1, state: 'building', head_ledger: 1500 });
    });
  });

  describe('windows', () => {
    it('keeps the halved window in memory, from one window and one run to the next, and grows it when the touches ease', async () => {
      world.head = 2000;
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.linesPerLedger = 100; // 500 ledgers would be 50,000 lines: the window halves to 125 (12,500)
      const r = make();
      await run(r);
      expect(world.windows.map((w) => w.window)).toEqual([500, 125, 125, 125, 125, 125, 125, 125]);
      expect(world.windows.map((w) => w.from)).toEqual([1000, 1125, 1250, 1375, 1500, 1625, 1750, 1875]);
      expect(world.g(1).through_ledger).toBe(2000);
      // the next run starts from the window that worked
      world.head = 2500;
      world.windows = [];
      await run(r);
      expect(world.windows[0].window).toBe(125);
      // quiet ledgers: the window doubles at each window until it is the full one again
      world.head = 5000;
      world.linesPerLedger = 1;
      world.windows = [];
      await run(r);
      expect(world.windows.map((w) => w.window).slice(0, 5)).toEqual([125, 250, 500, 500, 500]);
    });

    it('keeps a window of its own for the repair', async () => {
      world.head = 2500;
      world.linesPerLedger = 100;
      world.seed(gen(1, 'live', { through_ledger: 2000, repair_from: 1000 }));
      await run(make());
      // the live touches learn 125; the repair starts from a full window of its own
      expect(world.windows.map((w) => w.window).slice(0, 6)).toEqual([500, 125, 125, 125, 500, 125]);
    });

    it('a window that keeps failing is retried at the next tick, and then backs off, doubling up to NFT_MAX_RETRY_MS', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.head = 1500;
      const boom = new Error('socket hang up');
      world.fail('apply', boom, boom, boom, boom, boom, boom, boom, boom, boom);
      const r = make();
      await expect(run(r)).rejects.toThrow('socket hang up'); // the first failure: tried again at the next tick
      expect(world.applied).toHaveLength(1);
      await expect(run(r)).rejects.toThrow('socket hang up'); // the second: now it waits
      expect(world.applied).toHaveLength(2);

      jest.setSystemTime(Date.now() + 1000);
      await run(r);
      expect(world.applied).toHaveLength(2); // waiting: not tried, and not a failure of this run
      jest.setSystemTime(Date.now() + NFT_RETRY_MS - 2000);
      await run(r);
      expect(world.applied).toHaveLength(2);

      jest.setSystemTime(Date.now() + 2000);
      await expect(run(r)).rejects.toThrow('socket hang up'); // after NFT_RETRY_MS
      expect(world.applied).toHaveLength(3);
      jest.setSystemTime(Date.now() + NFT_RETRY_MS + 1000);
      await run(r);
      expect(world.applied).toHaveLength(3); // twice as long now
      jest.setSystemTime(Date.now() + NFT_RETRY_MS);
      await expect(run(r)).rejects.toThrow('socket hang up');
      expect(world.applied).toHaveLength(4);

      // the wait doubles, up to the maximum
      let waited = NFT_RETRY_MS * 4;
      while (waited < NFT_MAX_RETRY_MS * 2) {
        jest.setSystemTime(Date.now() + Math.min(waited, NFT_MAX_RETRY_MS) + 1);
        await expect(run(r)).rejects.toThrow('socket hang up');
        waited *= 2;
      }
      const before = world.applied.length;
      jest.setSystemTime(Date.now() + NFT_MAX_RETRY_MS - 1000);
      await run(r);
      expect(world.applied).toHaveLength(before);

      // a window that works ends the streak: a failure after it is retried at once
      jest.setSystemTime(Date.now() + 2000);
      world.failures.clear();
      await run(r);
      expect(world.g(1).through_ledger).toBe(1500);
      world.head = 1600;
      world.fail('apply', boom);
      await expect(run(r)).rejects.toThrow('socket hang up');
      await run(r);
      expect(world.g(1).through_ledger).toBe(1600);
    });
  });

  describe('repair', () => {
    it('applies [repair_from, through_ledger] as the windows (repair_from - 1, through_ledger], at through_ledger, moving repair_from', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500, repair_from: 1000 }));
      await run(make());
      expect(world.windows).toEqual([
        { from: 999, head: 1500, window: 500 },
        { from: 1499, head: 1500, window: 500 },
      ]);
      // both the lines and the tokens of a repaired window are read at the generation's through_ledger, not at the window's end
      expect(world.applied.map((a) => a.atLedger)).toEqual([1500, 1500]);
      expect(world.recomputed.map((a) => a.atLedger)).toEqual([1500, 1500]);
      expect(world.written.filter((w) => w.generation === 1).map((w) => [w.through_ledger, w.repair_from])).toEqual([
        [1500, 1500], // the window (999, 1499] is done: the next starts at 1500
        [1500, 0], // past through_ledger: none left
      ]);
    });

    it('ends a repair that has nothing left by moving repair_from to 0', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500, repair_from: 1501 }));
      await run(make());
      expect(world.trace()).toEqual(['window 1500-1500', 'row g1 live t1500']);
      expect(world.g(1).repair_from).toBe(0);
    });

    it('gets half of the budget at most, so that the housekeeping and the generation that builds are not starved', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500, repair_from: 1 }), gen(2, 'building', { pass_done: 0 }));
      world.accounts = ['rA'];
      world.costs.set('apply', 1500);
      await run(make());
      // the first window ends at 1.5 s, the second at 3 s (past the half): the repair is cut there
      expect(world.windows.filter((w) => w.from < 1000)).toHaveLength(2);
      expect(world.g(1).repair_from).toBe(1001); // the second window was (499, 1000]
      // and the rest of the run did the rebuild check and the pass
      expect(world.events).toContain('coverage');
      expect(world.events).toContain("pass g2 ('',rA]");
    });

    it('an older-parser ledger in a repair window ends the repair and marks the rebuild, while the live touches go on', async () => {
      world.head = 1600;
      world.seed(gen(1, 'live', { through_ledger: 1500, repair_from: 300 }));
      world.parserFloor = (from) => (from < 1000 ? TOKEN_PARSER_VERSION - 1 : TOKEN_PARSER_VERSION);
      world.accounts = ['rA', 'rB', 'rC'];
      world.costs.set('writePassLines', 2500); // a pass of three batches takes more than a run
      const r = make();
      await run(r);
      // the live touches were applied (1500 -> 1600), the repair window was not
      expect(world.applied.map((a) => [a.generation, a.atLedger])).toEqual([[1, 1600]]);
      expect(world.g(1)).toMatchObject({ state: 'live', through_ledger: 1600 });
      // the repair stopped (the mark is kept in the row until the rebuild replaces the generation) and a generation was started
      expect(world.g(1).repair_from).toBe(300);
      expect(world.g(2)).toMatchObject({ state: 'building', head_ledger: 1600 });
      expect(world.parserCalls.filter((c) => c.from === 299)).toHaveLength(1);

      // the next ledgers are applied to the live generation, and the repair is not tried again
      world.head = 1700;
      await run(r);
      expect(world.g(1).through_ledger).toBe(1700);
      expect(world.parserCalls.filter((c) => c.from === 299)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parser'));
    });
  });

  describe('an older parser', () => {
    it('an older-parser ledger in a window starts a generation and the live one keeps serving', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.parserFloor = (from) => (from < 1500 ? TOKEN_PARSER_VERSION - 1 : TOKEN_PARSER_VERSION);
      world.accounts = ['rA', 'rB', 'rC'];
      world.accountsPerBatch = 1;
      world.costs.set('writePassLines', 2500);
      const r = make();
      await run(r);
      // the window was not applied, the cursor did not move, and the live generation is still the live one
      expect(world.applied).toEqual([]);
      expect(world.g(1)).toMatchObject({ state: 'live', through_ledger: 1000 });
      expect(world.g(2)).toMatchObject({ state: 'building', head_ledger: 1500, coverage_from: COVERAGE, pass_done: 0 });
      expect(gauges()).toEqual({ live: 1, lag: 500, building: 1, repair: 0 });
      // it is not tried again at every run
      expect(world.parserCalls.filter((c) => c.from === 1000)).toHaveLength(1);

      // new ledgers come in while it builds; the live generation is not moved over the ledger that cannot be applied, and
      // the generation that builds takes over as soon as its pass is done: it is past the live one
      world.head = 1600;
      await run(r);
      expect(world.parserCalls.filter((c) => c.from === 1000)).toHaveLength(1);
      expect(world.g(2)).toMatchObject({ state: 'live', pass_done: 1, through_ledger: 1500 });
      expect(world.g(1).state).toBe('retired');

      await run(r);
      expect(world.g(2)).toMatchObject({ state: 'live', through_ledger: 1600 });
      expect(gauges()).toEqual({ live: 1, lag: 0, building: 0, repair: 0 });
    });
  });

  describe('the pass', () => {
    it('walks the pass in batches and moves account_cursor only after the batch is written', async () => {
      world.head = 1300;
      world.seed(gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }));
      world.accounts = ['rA', 'rB', 'rC', 'rD', 'rE'];
      world.costs.set('writePassLines', 2000);
      world.fail('writePassLines', new Error('read timeout'));
      const r = make();
      await expect(run(r)).rejects.toThrow('read timeout');
      expect(world.g(2)).toMatchObject({ account_cursor: '', pass_done: 0 });

      await run(r); // the batch again, and the next: 2 s each
      expect(world.g(2)).toMatchObject({ account_cursor: 'rD', pass_done: 0 });
      expect(world.passes.map((p) => [p.after, p.through])).toEqual([
        ['', 'rB'], // failed
        ['', 'rB'],
        ['rB', 'rD'],
      ]);
      expect(world.passes.every((p) => p.generation === 2 && p.head === 1200)).toBe(true);

      await run(r); // the last account, the empty batch (pass_done) and the touches, then the promotion
      expect(world.passes.slice(3).map((p) => [p.after, p.through])).toEqual([['rD', 'rE']]);
      expect(world.g(2)).toMatchObject({ state: 'live', account_cursor: 'rE', pass_done: 1, through_ledger: 1300 });

      // the cursor of each batch is logged
      const logged = logger.log.mock.calls.map((c) => String(c[0])).join('\n');
      for (const cursor of ['rB', 'rD', 'rE']) expect(logged).toContain(cursor);
    });

    it('a row that fails to be written leaves the cursor, and the next run redoes the batch under a newer version', async () => {
      world.head = 1300;
      world.seed(gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }));
      world.accounts = ['rA', 'rB'];
      world.fail('write', new Error('insert failed'));
      const r = make();
      await expect(run(r)).rejects.toThrow('insert failed');
      expect(world.g(2).account_cursor).toBe('');
      await run(r);
      expect(world.passes.map((p) => [p.after, p.through])).toEqual([
        ['', 'rB'],
        ['', 'rB'],
      ]);
      expect(BigInt(world.passes[1].version)).toBeGreaterThan(BigInt(world.passes[0].version));
      expect(world.g(2).account_cursor).toBe('rB');
    });

    it('makes the tokens of a batch with rematch all, at the head_ledger of the generation', async () => {
      world.head = 1300;
      world.seed(gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }));
      world.accounts = ['rA'];
      await run(make());
      expect(world.recomputed[0]).toMatchObject({ generation: 2, atLedger: 1200, rematch: 'all' });
      expect(world.recomputed[0].tokens).toEqual([{ issuer: ISSUER, currency: USD }]);
    });

    it('does not apply touches before the pass is done', async () => {
      world.head = 1500;
      world.seed(gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }));
      world.accounts = ['rA', 'rB', 'rC'];
      world.accountsPerBatch = 1;
      world.costs.set('writePassLines', 2500);
      await run(make());
      expect(world.windows).toEqual([]);
      expect(world.g(2)).toMatchObject({ pass_done: 0, account_cursor: 'rB' });
    });

    it('backs off a batch of the pass that keeps failing', async () => {
      world.head = 1300;
      world.seed(gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }));
      world.accounts = ['rA'];
      const boom = new Error('Timeout');
      world.fail('writePassLines', boom, boom, boom);
      const r = make();
      await expect(run(r)).rejects.toThrow('Timeout');
      await expect(run(r)).rejects.toThrow('Timeout');
      expect(world.passes).toHaveLength(2);
      jest.setSystemTime(Date.now() + 1000);
      await run(r);
      expect(world.passes).toHaveLength(2);
      jest.setSystemTime(Date.now() + NFT_RETRY_MS);
      await expect(run(r)).rejects.toThrow('Timeout');
      expect(world.passes).toHaveLength(3);
    });
  });

  describe('promotion', () => {
    it('promotes a building generation once its pass is done and it has caught up, then retires the old one', async () => {
      world.seed(
        gen(1, 'live', { through_ledger: 1500 }),
        gen(2, 'building', { pass_done: 1, head_ledger: 1300, through_ledger: 1300 }),
      );
      await run(make());
      expect(world.trace()).toEqual([
        'window 1300-1500',
        'parser 1300-1500',
        'apply g2 @1500',
        'recompute g2 @1500',
        'row g2 building t1500',
        'row g2 live t1500', // the new one first,
        'row g1 retired t1500', // then the old one
      ]);
      const [, promoted, retired] = world.written;
      expect(promoted.state).toBe('live');
      expect(retired.state).toBe('retired');
      expect(BigInt(retired.version)).toBeGreaterThan(BigInt(promoted.version));
      expect(gauges()).toEqual({ live: 1, lag: 0, building: 0, repair: 0 });
    });

    it('does not promote one that is behind the live generation, or whose pass is not done', async () => {
      world.head = 3000;
      world.seed(
        gen(1, 'live', { through_ledger: 3000 }),
        gen(2, 'building', { pass_done: 1, head_ledger: 1000, through_ledger: 1000 }),
      );
      world.costs.set('apply', 1500);
      const r = make();
      await run(r);
      expect(world.g(2)).toMatchObject({ state: 'building', through_ledger: 2500 });
      expect(world.g(1).state).toBe('live');
      await run(r);
      expect(world.g(2)).toMatchObject({ state: 'live', through_ledger: 3000 });
      expect(world.g(1).state).toBe('retired');

      // the pass is not done: through_ledger at the head is not enough
      world.seed(gen(3, 'building', { pass_done: 0, head_ledger: 3000, through_ledger: 3000 }));
      world.accounts = ['rA', 'rB', 'rC'];
      world.accountsPerBatch = 1;
      world.costs.set('writePassLines', 2500);
      await run(r);
      expect(world.g(3).state).toBe('building');
    });

    it('without a live generation, promotes within 10 ledgers of the head', async () => {
      expect(TOKENS_PROMOTE_NEAR_HEAD).toBe(10);
      world.seed(gen(1, 'building', { pass_done: 1, head_ledger: 1490, through_ledger: 1490 }));
      await run(make());
      expect(world.trace()).toEqual(['row g1 live t1490']);

      // 11 ledgers behind: one window first
      world = new World();
      world.seed(gen(1, 'building', { pass_done: 1, head_ledger: 1489, through_ledger: 1489 }));
      await run(make());
      expect(world.trace()).toEqual([
        'window 1489-1500',
        'parser 1489-1500',
        'apply g1 @1500',
        'recompute g1 @1500',
        'row g1 building t1500',
        'row g1 live t1500',
      ]);
    });

    it('finishes a promotion whose retirement of the old generation failed', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'live', { through_ledger: 1500 }));
      await run(make());
      expect(world.trace()).toEqual(['row g1 retired t1500']);
      expect(world.g(2).state).toBe('live');
    });
  });

  describe('the rebuild check', () => {
    it('starts a generation when there is no live and no building one', async () => {
      world.accounts = [];
      await run(make());
      expect(world.written[0]).toMatchObject({
        generation: 1,
        state: 'building',
        config_version: TOKENS_CONFIG_VERSION,
        coverage_from: COVERAGE,
        head_ledger: 1500,
        account_cursor: '',
        pass_done: 0,
        through_ledger: 1500,
        repair_from: 0,
        holders: 0,
        started_at: NOW_SECONDS,
        changed_at: NOW_SECONDS,
      });
    });

    it('numbers a generation one above the highest, a retired one included', async () => {
      world.seed(gen(4, 'retired'), gen(2, 'retired'));
      await run(make());
      expect(world.written[0]).toMatchObject({ generation: 5, state: 'building' });
    });

    it('starts a generation when the live one has another config_version, or another coverage_from', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.slowBuild();
      await run(make({ configVersion: TOKENS_CONFIG_VERSION + 1 }));
      expect(world.g(2)).toMatchObject({ state: 'building', config_version: TOKENS_CONFIG_VERSION + 1 });
      expect(world.g(1).state).toBe('live');

      world = new World();
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.slowBuild();
      world.coverage = COVERAGE + 5;
      await run(make());
      expect(world.g(2)).toMatchObject({ state: 'building', coverage_from: COVERAGE + 5 });
      expect(world.g(1).state).toBe('live');
    });

    it('does not start another generation while one builds, or when the live one is as it should be', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'building', { pass_done: 0 }));
      world.slowBuild();
      await run(make());
      expect([...world.gens.keys()]).toEqual([1, 2]);
    });

    it('retires a stale building generation before starting another', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'building', { pass_done: 0 }));
      world.slowBuild();
      await run(make({ configVersion: TOKENS_CONFIG_VERSION + 1 }));
      expect(world.written.slice(0, 2).map((w) => [w.generation, w.state, w.config_version])).toEqual([
        [2, 'retired', TOKENS_CONFIG_VERSION],
        [3, 'building', TOKENS_CONFIG_VERSION + 1],
      ]);
      expect(world.g(1).state).toBe('live');
    });
  });

  describe('the drop', () => {
    it('drops a retired generation 15 minutes after it was retired, not before', async () => {
      expect(TOKENS_RETIRED_KEEP_MS).toBe(minutes(15));
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'retired', { changed_at: NOW_SECONDS }));
      const r = make();
      await run(r);
      jest.setSystemTime(NOW.getTime() + minutes(14) + 59_000);
      await run(r);
      expect(world.dropped).toEqual([]);
      jest.setSystemTime(NOW.getTime() + minutes(15)); // exactly: not yet more than
      await run(r);
      expect(world.dropped).toEqual([]);
      jest.setSystemTime(NOW.getTime() + minutes(15) + 1);
      await run(r);
      expect(world.dropped).toEqual([2]);
      // once: remembered
      jest.setSystemTime(NOW.getTime() + minutes(20));
      await run(r);
      expect(world.dropped).toEqual([2]);
      // a restart forgets, and drops again, which is harmless
      await run(make());
      expect(world.dropped).toEqual([2, 2]);
    });

    it('drops with the keep time of the options (the tests use 0)', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'retired', { changed_at: NOW_SECONDS }));
      jest.setSystemTime(NOW.getTime() + 1);
      await run(make({ retiredKeepMs: 0 }));
      expect(world.dropped).toEqual([2]);
    });

    it('a drop that fails is retried at the next run', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'retired', { changed_at: NOW_SECONDS - 3600 }));
      world.fail('drop', new Error('Code: 497. Not enough privileges'));
      const r = make();
      await expect(run(r)).rejects.toThrow('Not enough privileges');
      await run(r);
      expect(world.dropped).toEqual([2]);
    });
  });

  describe('housekeeping', () => {
    it('runs housekeeping on the 1st, 11th, 21st run', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      const r = make();
      const perRun: string[][] = [];
      for (let i = 1; i <= 21; i++) {
        world.events = [];
        await run(r);
        perRun.push(world.events.filter((e) => ['coverage', 'holders g1', 'sweep g1'].includes(e)));
      }
      const all = ['coverage', 'holders g1', 'sweep g1'];
      expect(TOKENS_HOUSEKEEPING_EVERY_TICKS).toBe(10);
      expect(perRun).toEqual(
        Array.from({ length: 21 }, (_, i) => (i === 0 ? ['coverage'] : i === 10 || i === 20 ? all : [])),
      );
    });

    it('does only the rebuild check at the first housekeeping: no distinct holders and no sweep', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      await run(make());
      expect(world.events).toContain('coverage');
      expect(world.events.filter((e) => e.startsWith('holders') || e.startsWith('sweep'))).toEqual([]);
      expect(world.g(1).holders_ledger).toBe(0);
    });

    it('does the first rebuild check at the next run when the first one could not (a failed read, no budget)', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.fail('read', new Error('connection refused'));
      const r = make();
      await expect(run(r)).rejects.toThrow('connection refused');
      world.events = [];
      await run(r);
      // the check, and only the check, as a first one
      expect(world.events.filter((e) => ['coverage', 'holders g1', 'sweep g1'].includes(e))).toEqual(['coverage']);
      world.events = [];
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS - 1); // runs 3 to 11
      expect(world.events.filter((e) => ['coverage', 'holders g1', 'sweep g1'].includes(e))).toEqual([
        'coverage',
        'holders g1',
        'sweep g1',
      ]);
    });

    it('writes the distinct holders into the live row with holders_ledger = its through_ledger', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1400, repair_from: 0 }));
      world.holders = 321;
      const r = make();
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS + 1);
      expect(world.g(1)).toMatchObject({ holders: 321, holders_ledger: 1500, through_ledger: 1500 });
    });

    it('sweeps the live generation only, from an in-memory cursor, TOKENS_STATE_CHUNK tokens per step', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }), gen(2, 'building', { pass_done: 0 }));
      world.slowBuild();
      world.sweepAnswers = [{ rewritten: 5, next: token(2000) }, { rewritten: 0, next: token(4000) }, { rewritten: 3 }];
      world.costs.set('sweep', 2000);
      const r = make();
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS + 1);
      // the 11th run: two steps (2 s each), and the budget is spent
      expect(world.sweeps.map((s) => [s.generation, s.after, s.limit])).toEqual([
        [1, undefined, TOKENS_STATE_CHUNK],
        [1, token(2000), TOKENS_STATE_CHUNK],
      ]);
      // the 21st goes on from where the 11th stopped, and ends the sweep
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS);
      expect(world.sweeps.slice(2).map((s) => [s.generation, s.after])).toEqual([[1, token(4000)]]);
      // the 31st starts again from the first token
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS);
      expect(world.sweeps.slice(3).map((s) => [s.generation, s.after])).toEqual([[1, undefined]]);
      expect(TOKENS_STATE_CHUNK).toBe(2000);
    });

    it('starts the sweep over on the generation that took over', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.sweepAnswers = [{ rewritten: 0, next: token(1) }];
      world.costs.set('sweep', 4000);
      const r = make();
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS + 1);
      expect(world.sweeps.map((s) => [s.generation, s.after])).toEqual([[1, undefined]]);
      // a rebuild took over
      world.seed(gen(1, 'retired'), gen(2, 'live', { through_ledger: 1500 }));
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS);
      expect(world.sweeps.slice(1).map((s) => [s.generation, s.after])).toEqual([[2, undefined]]);
    });

    it('a sweep step that fails leaves the cursor, and the next housekeeping does it again', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.sweepAnswers = [{ rewritten: 1, next: token(1) }];
      world.costs.set('sweep', 4000);
      world.fail('sweep', undefined, new Error('Timeout'));
      const r = make();
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS);
      await expect(run(r)).resolves.toBeUndefined(); // the 11th: the first step works and spends the budget
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS - 1);
      await expect(run(r)).rejects.toThrow('Timeout'); // the 21st
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS - 1);
      await run(r); // the 31st: from the same token
      expect(world.sweeps.map((s) => s.after)).toEqual([undefined, token(1), token(1)]);
    });
  });

  describe('versions', () => {
    it('gives versions that never go back, above the stored floor', async () => {
      const floor = 2_000_000_000_000n; // far above the clock (1.79e12)
      world.floor = floor.toString();
      world.head = 3000;
      world.seed(gen(1, 'live', { through_ledger: 1000, repair_from: 500 }), gen(2, 'building', { pass_done: 0 }));
      world.accounts = ['rA'];
      world.sweepAnswers = [{ rewritten: 0 }];
      const r = make();
      await runs(r, TOKENS_HOUSEKEEPING_EVERY_TICKS + 1);
      expect(world.versions.length).toBeGreaterThan(10);
      for (const { version } of world.versions) expect(BigInt(version)).toBeGreaterThan(floor);
      // the clock goes back: still above what was handed out
      jest.setSystemTime(NOW.getTime() - minutes(30));
      world.head = 3100;
      world.versions = [];
      await run(r);
      expect(world.versions.length).toBeGreaterThan(0);
      const all = world.written.map((w) => BigInt(w.version));
      expect(new Set(all).size).toBe(all.length); // no two rows of generations share a version
      for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThan(all[i - 1]);
    });

    it('is the clock in milliseconds when that is above the floor, and every write is above the one before it', async () => {
      world.floor = '5';
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      await run(make());
      expect(world.versions[0]).toEqual({ what: 'apply', version: String(NOW.getTime()) });
      let previous = 0n;
      for (const { what, version } of world.versions) {
        // the lines and the tokens of a window share a version (different tables); no write goes below an earlier one
        expect(BigInt(version)).toBeGreaterThanOrEqual(previous);
        if (what === 'row') expect(BigInt(version)).toBeGreaterThan(previous);
        previous = BigInt(version);
      }
    });

    it('reads the floor once, and again after a first run that could not read it', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      world.fail('floor', new Error('connection refused'));
      const r = make();
      await expect(run(r)).rejects.toThrow('connection refused');
      await runs(r, 3);
      expect(world.events.filter((e) => e === 'floor')).toHaveLength(2);
    });
  });

  describe('the hook of agg_dirty', () => {
    const SLICE_START = 1_790_000_000;
    const SLICE_END = SLICE_START + 10_800;

    it("the hook sets repair_from to the slice's first ledger and does nothing else", async () => {
      world.seed(
        gen(1, 'live', { through_ledger: 1500, holders: 9, holders_ledger: 1400 }),
        gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }),
      );
      world.slowBuild();
      const r = make();
      await run(r);
      world.events = [];
      world.written = [];
      // the building generation is behind the slice and has not reached it
      slice = { min: 1300, max: 1400 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(ledgersClosedIn).toHaveBeenCalledWith(new Date(SLICE_START * 1000), new Date(SLICE_END * 1000));
      expect(world.events).toEqual(['read', 'row g1 live t1500']);
      expect(world.written).toHaveLength(1);
      expect(world.written[0]).toMatchObject({ generation: 1, repair_from: 1300, holders: 9, holders_ledger: 1400 });

      // a slice above the lowest mark changes nothing: no row
      world.events = [];
      world.written = [];
      slice = { min: 1350, max: 1450 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.events).toEqual(['read']);
      expect(world.written).toEqual([]);

      // a lower one lowers the mark, of every generation that reaches it
      world.events = [];
      slice = { min: 1100, max: 1250 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.written.map((w) => [w.generation, w.repair_from])).toEqual([
        [1, 1100],
        [2, 1100],
      ]);
      expect(world.events).toEqual(['read', 'row g1 live t1500', 'row g2 building t1200']);
    });

    it('does not read or write the generations when the slice has no ledger', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      const r = make();
      await run(r);
      world.events = [];
      slice = null;
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.events).toEqual([]);
    });

    it('the hook leaves a slice below coverage_from to the rebuild check', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500, coverage_from: 100 }));
      const r = make();
      await run(r);
      world.written = [];
      slice = { min: 10, max: 99 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.written).toEqual([]);
      // a slice that reaches coverage_from is marked from there
      slice = { min: 50, max: 150 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.written.map((w) => w.repair_from)).toEqual([100]);
    });

    it('leaves out a generation whose through_ledger is below the slice, and a retired one', async () => {
      world.seed(
        gen(1, 'live', { through_ledger: 1500 }),
        gen(2, 'building', { pass_done: 0, head_ledger: 1000, through_ledger: 1000 }),
        gen(3, 'retired', { through_ledger: 1500 }),
      );
      world.slowBuild();
      const r = make();
      await run(r);
      world.written = [];
      slice = { min: 1200, max: 1300 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.written.map((w) => w.generation)).toEqual([1]);
    });

    it('throws before any read or write when this process has no version floor yet', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      slice = { min: 1300, max: 1400 };
      const r = make();
      await expect(r.ofSlice(SLICE_START, SLICE_END, tick())).rejects.toThrow('tokens');
      expect(ledgersClosedIn).not.toHaveBeenCalled();
      expect(world.events).toEqual([]);

      // nor after a first run that failed before it read the floor
      world.fail('read', new Error('connection refused'));
      await expect(run(r)).rejects.toThrow('connection refused');
      world.events = [];
      await expect(r.ofSlice(SLICE_START, SLICE_END, tick())).rejects.toThrow('tokens');
      expect(world.events).toEqual([]);
      expect(ledgersClosedIn).not.toHaveBeenCalled();
    });

    it('throws before any read or write when the last run failed, and works again after one that did not', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      slice = { min: 1100, max: 1200 };
      const r = make();
      await run(r); // reads the floor
      world.fail('apply', new Error('Memory limit exceeded'));
      world.head = 1600;
      await expect(run(r)).rejects.toThrow('Memory limit exceeded');
      world.events = [];
      ledgersClosedIn.mockClear();
      await expect(r.ofSlice(SLICE_START, SLICE_END, tick())).rejects.toThrow('tokens');
      expect(world.events).toEqual([]);
      expect(ledgersClosedIn).not.toHaveBeenCalled();

      await run(r);
      world.written = [];
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.written.map((w) => [w.generation, w.repair_from])).toEqual([[1, 1100]]);
    });

    it('does nothing once the shutdown has begun', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      const r = make();
      await run(r);
      world.events = [];
      closing = true;
      slice = { min: 1300, max: 1400 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.events).toEqual([]);
      expect(ledgersClosedIn).not.toHaveBeenCalled();
    });

    it('a repair mark made by the hook is worked off by the next run', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1500 }));
      const r = make();
      await run(r);
      slice = { min: 1300, max: 1400 };
      await r.ofSlice(SLICE_START, SLICE_END, tick());
      expect(world.g(1).repair_from).toBe(1300);
      world.windows = [];
      await run(r);
      expect(world.windows).toEqual([{ from: 1299, head: 1500, window: 500 }]); // [1300, 1500] is one window
      expect(world.g(1)).toMatchObject({ repair_from: 0, through_ledger: 1500 });
    });
  });

  describe('the gauges', () => {
    it('sets the four gauges', async () => {
      world.head = 3000;
      world.seed(
        gen(1, 'live', { through_ledger: 1000, repair_from: 800 }),
        gen(2, 'building', { pass_done: 0, head_ledger: 1000, through_ledger: 1000 }),
      );
      world.accounts = ['rA', 'rB', 'rC'];
      world.accountsPerBatch = 1;
      world.costs.set('apply', 5000); // one window of live touches takes the whole budget
      await run(make());
      expect(world.g(1).through_ledger).toBe(1500);
      expect(gauges()).toEqual({ live: 1, lag: 1500, building: 1, repair: 700 }); // 1500 - 800
    });

    it('sets 0 without a live generation, 1 for the building one', async () => {
      world.seed(gen(1, 'building', { pass_done: 0, head_ledger: 1000, through_ledger: 1000 }));
      world.accounts = ['rA', 'rB'];
      world.accountsPerBatch = 1;
      world.costs.set('writePassLines', 5000);
      await run(make());
      expect(gauges()).toEqual({ live: 0, lag: 0, building: 1, repair: 0 });
    });

    it('sets 0 everywhere with no ledger', async () => {
      world.head = 0;
      await run(make());
      expect(gauges()).toEqual({ live: 0, lag: 0, building: 0, repair: 0 });
    });

    it('sets the gauges after a failed run too, from a read of the generations and the head', async () => {
      world.head = 3000;
      world.seed(gen(1, 'live', { through_ledger: 1000, repair_from: 900 }));
      world.fail('apply', new Error('Memory limit exceeded'), new Error('Memory limit exceeded')); // the touches, the repair
      const r = make();
      world.events = [];
      await expect(run(r)).rejects.toThrow('Memory limit exceeded');
      expect(world.events.filter((e) => e === 'read')).toHaveLength(2); // the run's, and the gauges'
      expect(gauges()).toEqual({ live: 1, lag: 2000, building: 0, repair: 100 });

      // a stuck window shows as a lag that grows with the head
      world.head = 3500;
      world.fail('apply', new Error('Memory limit exceeded'), new Error('Memory limit exceeded'));
      await expect(run(r)).rejects.toThrow('Memory limit exceeded');
      expect(gauges().lag).toBe(2500);
    });

    it('counts a read of the gauges that fails on its own, and still throws the failure of the run', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.fail('apply', new Error('Memory limit exceeded'));
      world.fail('read', undefined, new Error('connection refused'));
      await expect(run(make())).rejects.toThrow('Memory limit exceeded');
      expect(failed).toHaveBeenCalledWith(
        'tokens',
        expect.objectContaining({ message: 'connection refused' }),
        ' reading the gauges',
      );
    });

    it('reads nothing for the gauges without metrics, or once the shutdown has begun', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.fail('apply', new Error('Memory limit exceeded'));
      await expect(run(make({}, false))).rejects.toThrow('Memory limit exceeded');
      expect(world.events.filter((e) => e === 'read')).toHaveLength(1);

      world.events = [];
      world.fail('apply', new Error('Memory limit exceeded'));
      const r = make();
      world.onCall = (name) => {
        if (name === 'apply') closing = true;
      };
      await expect(run(r)).rejects.toThrow('Memory limit exceeded');
      expect(world.events.filter((e) => e === 'read')).toHaveLength(1);
    });
  });

  describe('failures and the shutdown', () => {
    it('does nothing once the shutdown has begun', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      closing = true;
      await run(make());
      expect(world.events).toEqual([]);
    });

    it('writes nothing after the shutdown begins in the middle of a window, and does not read for the gauges', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.onCall = (name) => {
        if (name === 'apply') {
          closing = true;
          abort.abort();
        }
      };
      await run(make());
      expect(world.recomputed).toEqual([]);
      expect(world.written).toEqual([]);
      expect(world.g(1).through_ledger).toBe(1000);
      expect(world.events.filter((e) => e === 'read')).toHaveLength(1);
    });

    it('throws the TokensAborted of a function the shutdown cut short, without reading for the gauges or waiting before the next try', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.onCall = (name) => {
        if (name === 'apply') {
          closing = true;
          abort.abort();
        }
      };
      world.fail('apply', new TokensAborted());
      const r = make();
      await expect(run(r)).rejects.toBeInstanceOf(TokensAborted);
      expect(world.written).toEqual([]);
      expect(world.events.filter((e) => e === 'read')).toHaveLength(1);

      // an abort is not a failure of the window: the next process (here the same, the stop undone) tries it at once
      world.onCall = undefined;
      closing = false;
      abort = new AbortController();
      await run(r);
      expect(world.g(1).through_ledger).toBe(1500);
    });

    it('goes on with the other parts when one fails, throws the first failure and reports the others', async () => {
      world.head = 1300;
      world.seed(
        gen(1, 'live', { through_ledger: 1000 }),
        gen(2, 'building', { pass_done: 0, head_ledger: 1200, through_ledger: 1200 }),
        gen(3, 'retired', { changed_at: NOW_SECONDS - 3600 }),
      );
      world.accounts = ['rA'];
      world.fail('apply', new Error('live window failed'));
      world.fail('writePassLines', new Error('pass failed'));
      world.fail('drop', new Error('drop failed'));
      await expect(run(make())).rejects.toThrow('live window failed');
      expect(failed.mock.calls.map(([job, err]) => [job, (err as Error).message])).toEqual([
        ['tokens', 'pass failed'],
        ['tokens', 'drop failed'],
      ]);
    });

    it('stops the run when the generations cannot be read', async () => {
      world.seed(gen(1, 'live', { through_ledger: 1000 }));
      world.fail('read', new Error('connection refused'));
      await expect(run(make())).rejects.toThrow('connection refused');
      expect(world.trace()).toEqual([]);
    });
  });
});

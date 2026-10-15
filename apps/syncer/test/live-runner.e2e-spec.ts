import {
  buildLedgerRows,
  CHILD_TABLES,
  ClickHouseService,
  getNetworkProfile,
  LEDGER_KEYED_TABLES,
  LedgerNotAvailableError,
  LedgerSource,
  LedgerWriter,
  parseContextFor,
  RawLedger,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { SyncerConfig } from '../src/config/syncer.config';
import { ChainBreakError, LiveRunner, LiveRunnerOptions } from '../src/ingest/live-runner';
import { LedgerNotValidatedError } from '../src/ingest/rpc-ledger-source';
import { PrometheusService } from '../src/modules/prometheus/prometheus.service';
import { range, syntheticChain, SyntheticLedger } from './synthetic-chain';

/** `L(1)` .. `L(30)` = 9999986 .. 10000015: the chain crosses the partition boundary at ledger 10,000,000. */
const BASE = 9_999_985;
const L = (i: number): number => BASE + i;
const CHAIN = syntheticChain(L(1), 30);

const ctx = parseContextFor(getNetworkProfile('xrpl'));

/**
 * Tables whose sorting key holds the ledger index, so that their row count is exact until a merge. Every synthetic
 * ledger carries the template's transactions, so `tx_by_hash` (ORDER BY hash) collapses them at any merge: it is left out.
 */
const COUNTED_TABLES = LEDGER_KEYED_TABLES.map((t) => t.table).filter((t) => t !== Table.TxByHash);

type Counts = Record<string, number>;

/** What the counted tables hold when exactly the ledgers `L(1)` .. `last` of `CHAIN` are committed. */
function expectedCounts(last: number): Counts {
  const counts: Counts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, 0]));
  for (const { index, raw } of CHAIN) {
    if (index > last) continue;
    const rows = buildLedgerRows(raw, ctx);
    counts[Table.Ledgers] += 1;
    counts[Table.LedgerByHash] += 1;
    for (const [table, key] of CHILD_TABLES) {
      if (table in counts) counts[table] += (rows[key] as unknown[]).length;
    }
  }
  return counts;
}

/**
 * A node stand-in over a chain: `validatedHead()` reports `head`, `fetch()` serves the ledgers up to `available`
 * (default: the head) and fails with `LedgerNotValidatedError` while `notValidated` says so. It records every fetch.
 */
class TestSource implements LedgerSource {
  readonly fetches: number[] = [];
  /** Index -> how many more fetches of it fail with `LedgerNotValidatedError`. */
  readonly notValidated = new Map<number, number>();
  available: number;
  private readonly byIndex: Map<number, RawLedger>;

  constructor(
    public head: number,
    chain: SyntheticLedger[] = CHAIN,
  ) {
    this.available = head;
    this.byIndex = new Map(chain.map((l) => [l.index, l.raw]));
  }

  async validatedHead(): Promise<number> {
    return this.head;
  }

  async fetch(index: number): Promise<RawLedger> {
    this.fetches.push(index);
    const failures = this.notValidated.get(index) ?? 0;
    if (failures > 0) {
      this.notValidated.set(index, failures - 1);
      throw new LedgerNotValidatedError(index);
    }
    const ledger = this.byIndex.get(index);
    if (!ledger || index > this.available) throw new LedgerNotAvailableError(index);
    return ledger;
  }

  /** How often `index` was fetched. */
  fetchCount(index: number): number {
    return this.fetches.filter((i) => i === index).length;
  }
}

interface LogLine {
  level: 'log' | 'warn' | 'error' | 'debug';
  message: string;
}

function captureLogger() {
  const lines: LogLine[] = [];
  const add = (level: LogLine['level']) => (message: unknown) => {
    lines.push({ level, message: String(message) });
  };
  return { lines, log: add('log'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

function config(overrides: Partial<SyncerConfig> = {}): SyncerConfig {
  return {
    network: 'xrpl',
    catchupConcurrency: 4,
    catchupFlushLedgers: 7,
    catchupFlushTxs: 100_000,
    catchupFlushMs: 5_000,
    syncStartLedger: L(1),
    ledgerFetchTimeoutMs: 5_000,
    maxLagHealthy: 10,
    ...overrides,
  } as SyncerConfig;
}

/** `promise`, or a rejection naming `what` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('LiveRunner (e2e)', () => {
  let clickhouse: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const runners: LiveRunner[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    clickhouse = await startClickHouse();
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await clickhouse?.container.stop();
  });

  /** A migrated database of its own: no test sees another test's rows, lease or dedup log. */
  async function freshService(): Promise<ClickHouseService> {
    const cfg = { ...clickhouse.config, database: `live_runner_${++dbCounter}` };
    await runMigrations({ config: cfg, log: () => undefined });
    const svc = new ClickHouseService(cfg);
    services.push(svc);
    return svc;
  }

  interface RunnerParts {
    writer?: LedgerWriter;
    hints?: EventEmitter;
    cfg?: Partial<SyncerConfig>;
    metrics?: PrometheusService;
    options?: LiveRunnerOptions;
    ch?: ClickHouseService;
  }

  function makeRunner(svc: ClickHouseService, source: LedgerSource, parts: RunnerParts = {}) {
    const logger = captureLogger();
    const runner = new LiveRunner(
      source,
      parts.writer ?? new LedgerWriter(svc, ctx),
      parts.ch ?? svc,
      parts.hints ?? new EventEmitter(),
      config(parts.cfg),
      parts.metrics,
      undefined,
      { logger, ...parts.options },
    );
    runners.push(runner);
    return { runner, logger };
  }

  const count = async (svc: ClickHouseService, table: Table | string, where = '1'): Promise<number> =>
    Number((await svc.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  async function committedIndexes(svc: ClickHouseService): Promise<number[]> {
    const rows = await svc.query<{ i: number }>(`SELECT ledger_index AS i FROM ${Table.Ledgers} ORDER BY i`);
    return rows.map((r) => Number(r.i));
  }

  async function tableCounts(svc: ClickHouseService): Promise<Counts> {
    return Object.fromEntries(await Promise.all(COUNTED_TABLES.map(async (t) => [t, await count(svc, t)] as const)));
  }

  /** `count() == uniqExact(ledger_index, tx_index)` on `transactions`: no transaction row is there twice. */
  async function expectNoDuplicateTransactions(svc: ClickHouseService): Promise<void> {
    const row = await svc.queryOne<{ n: string; u: string }>(
      `SELECT count() AS n, uniqExact(ledger_index, tx_index) AS u FROM ${Table.Transactions}`,
    );
    expect(Number(row?.n)).toBeGreaterThan(0);
    expect(Number(row?.n)).toBe(Number(row?.u));
  }

  /** Rows of every ledger-keyed table above `index`. */
  async function rowsAbove(svc: ClickHouseService, index: number): Promise<Counts> {
    return Object.fromEntries(
      await Promise.all(
        LEDGER_KEYED_TABLES.map(
          async ({ table }) => [table, await count(svc, table, `ledger_index > ${index}`)] as const,
        ),
      ),
    );
  }

  const noRows = (): Counts => Object.fromEntries(LEDGER_KEYED_TABLES.map(({ table }) => [table, 0]));

  /** The child rows and `ledger_by_hash` of ledgers without their `ledgers` row: what a write that crashed leaves. */
  async function insertUncommitted(svc: ClickHouseService, ledgers: RawLedger[]): Promise<void> {
    const rows = ledgers.map((raw) => buildLedgerRows(raw, ctx));
    for (const [table, key] of CHILD_TABLES) {
      await svc.insert(
        table,
        rows.flatMap((r) => r[key] as unknown[]),
      );
    }
    await svc.insert(
      Table.LedgerByHash,
      rows.map((r) => r.ledgerByHash),
    );
  }

  async function gauge(metrics: PrometheusService, name: keyof PrometheusService): Promise<number | undefined> {
    const metric = metrics[name] as { get(): Promise<{ values: { value: number }[] }> };
    return (await metric.get()).values[0]?.value;
  }

  /** Records the `[first, last]` ledger of every `LedgerWriter.write()` batch. */
  function recordBatches(): number[][] {
    const batches: number[][] = [];
    const write = LedgerWriter.prototype.write;
    jest.spyOn(LedgerWriter.prototype, 'write').mockImplementation(function (this: LedgerWriter, ledgers) {
      const indexes = ledgers.map((l) => l.header.ledger_index);
      batches.push([Math.min(...indexes), Math.max(...indexes)]);
      return write.call(this, ledgers);
    });
    return batches;
  }

  const chainRaw = (...indexes: number[]): RawLedger[] =>
    indexes.map((i) => CHAIN.find((l) => l.index === i)?.raw ?? syntheticChain(i, 1)[0].raw);

  it('catches up from syncStartLedger to head and stops at lag 0', async () => {
    const svc = await freshService();
    const source = new TestSource(L(30));
    const metrics = new PrometheusService();
    const batches = recordBatches();
    // No flush by age and no head poll: the batches are exactly what the ledger threshold and the lag rule make, and
    // nothing but landing fetches wakes the loop (a pipeline that idles with room in its fetch window stalls).
    const { runner } = makeRunner(svc, source, {
      metrics,
      cfg: { catchupFlushMs: 600_000 },
      options: { headSilenceMs: 600_000 },
    });

    await within(runner.runOnce(), 10_000, 'Catching up 30 ledgers');

    // Batches of catchupFlushLedgers (7) while catching up; within one ledger of the head, one ledger per commit.
    expect(batches).toEqual([
      [L(1), L(7)],
      [L(8), L(14)],
      [L(15), L(21)],
      [L(22), L(28)],
      [L(29), L(29)],
      [L(30), L(30)],
    ]);

    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    expect(await tableCounts(svc)).toEqual(expectedCounts(L(30)));
    await expectNoDuplicateTransactions(svc);
    // Every ledger was fetched exactly once, and nothing below the start or above the head.
    expect([...source.fetches].sort((a, b) => a - b)).toEqual(range(L(1), L(30)));

    const status = runner.status();
    expect(status).toMatchObject({ state: 'live', checkpoint: L(30), head: L(30), lag: 0 });
    expect(status.lastCommitAt).toBeGreaterThan(Date.now() / 1000 - 30);
    expect(status.lastCommitAt).toBeLessThanOrEqual(Date.now() / 1000);

    expect(await gauge(metrics, 'checkpointLedger')).toBe(L(30));
    expect(await gauge(metrics, 'headLedger')).toBe(L(30));
    expect(await gauge(metrics, 'lagLedgers')).toBe(0);
    expect(await gauge(metrics, 'lastCommitTimestampSeconds')).toBeCloseTo(status.lastCommitAt as number, 3);
  });

  it('flushes a batch at catchupFlushTxs transactions, and when it is catchupFlushMs old', async () => {
    const txsPerLedger = CHAIN[0].raw.transactions.length;
    const byTxs = await freshService();
    const txBatches = recordBatches();
    const { runner } = makeRunner(byTxs, new TestSource(L(10)), {
      cfg: { catchupFlushTxs: 3 * txsPerLedger, catchupFlushMs: 600_000 },
    });
    await runner.runOnce();
    expect(txBatches).toEqual([
      [L(1), L(3)],
      [L(4), L(6)],
      [L(7), L(9)],
      [L(10), L(10)],
    ]);
    await runner.stop();
    jest.restoreAllMocks();

    const byAge = await freshService();
    const ageBatches = recordBatches();
    const slow = new TestSource(L(10));
    const fetch = slow.fetch.bind(slow);
    slow.fetch = async (index) => {
      if (index === L(3)) await new Promise((resolve) => setTimeout(resolve, 600));
      return fetch(index);
    };
    const { runner: aged } = makeRunner(byAge, slow, { cfg: { catchupFlushMs: 100 } });
    await aged.runOnce();
    // 1 and 2 are written once the batch is 100 ms old, long before 3 arrives.
    expect(ageBatches[0]).toEqual([L(1), L(2)]);
    expect(await committedIndexes(byAge)).toEqual(range(L(1), L(10)));
  });

  it('fills a gap when hints jump 10 → 13', async () => {
    const svc = await freshService();
    // The polled head stays at 10: only the hint can tell the runner about 13.
    const source = new TestSource(L(10));
    const hints = new EventEmitter();
    const { runner } = makeRunner(svc, source, { hints });

    await runner.onApplicationBootstrap();
    await waitFor(() => runner.status().checkpoint === L(10), 'the checkpoint to reach L(10)');
    expect(runner.status()).toMatchObject({ state: 'live', head: L(10), lag: 0 });

    source.available = L(13);
    hints.emit('ledgerClosed', {
      type: 'ledgerClosed',
      ledger_index: L(13),
      ledger_hash: CHAIN[12].raw.header.ledger_hash,
    });
    await waitFor(() => runner.status().checkpoint === L(13), 'the checkpoint to reach L(13)');

    expect(await committedIndexes(svc)).toEqual(range(L(1), L(13)));
    expect(source.fetchCount(L(11))).toBe(1);
    expect(source.fetchCount(L(12))).toBe(1);
    expect(runner.status()).toMatchObject({ state: 'live', checkpoint: L(13), head: L(13), lag: 0 });
  });

  it('retries unvalidated ledger until validated', async () => {
    const svc = await freshService();
    const source = new TestSource(L(30));
    source.notValidated.set(L(5), 2);
    const { runner, logger } = makeRunner(svc, source);

    await runner.runOnce();

    expect(source.fetchCount(L(5))).toBe(3);
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    await expectNoDuplicateTransactions(svc);
    const retries = logger.lines.filter(
      (l) => l.level === 'warn' && l.message.includes(`Ledger ${L(5)} is not validated`),
    );
    expect(retries).toHaveLength(2);
  });

  /** Fails its second `write()` after the child rows went in (the commit marker's insert throws). */
  class FailOnSecondWrite extends LedgerWriter {
    calls = 0;
    /** Rows of `transactions` above the checkpoint right after the failure: the orphans recovery has to remove. */
    orphanTransactions = 0;
    onFailure?: () => void;

    constructor(private readonly svc: ClickHouseService) {
      super(svc, ctx);
    }

    override async write(ledgers: RawLedger[]): Promise<void> {
      this.calls += 1;
      if (this.calls !== 2) return super.write(ledgers);
      const commitFails = Object.create(this.svc) as ClickHouseService;
      commitFails.insert = async (table, rows, opts) => {
        if (table === Table.LedgerByHash) throw new Error('injected failure after the child rows');
        return this.svc.insert(table, rows, opts);
      };
      try {
        // Same runId: these inserts are this writer's, and recovery must wait for exactly them.
        await new LedgerWriter(commitFails, ctx, { runId: this.runId }).write(ledgers);
      } catch (err) {
        const first = Math.min(...ledgers.map((l) => l.header.ledger_index));
        this.orphanTransactions = await count(this.svc, Table.Transactions, `ledger_index >= ${first}`);
        this.onFailure?.();
        throw err;
      }
    }
  }

  it('writer failure mid-batch is recovered', async () => {
    const svc = await freshService();
    const writer = new FailOnSecondWrite(svc);
    const { runner, logger } = makeRunner(svc, new TestSource(L(30)), { writer });

    await runner.runOnce();

    expect(writer.orphanTransactions).toBeGreaterThan(0); // the failure really left child rows behind
    expect(writer.calls).toBe(2); // the failed writer is never used again: a new runId carries on
    await expectNoDuplicateTransactions(svc);
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    expect(await tableCounts(svc)).toEqual(expectedCounts(L(30)));
    expect(runner.status()).toMatchObject({ state: 'live', checkpoint: L(30), lag: 0 });
    expect(runner.status().recovering).toBeUndefined();
    expect(logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('injected failure after the child rows'),
      }),
    );
  });

  it('keeps retrying a stuck recovery and writes nothing until it succeeds', async () => {
    const svc = await freshService();
    const events: string[] = [];
    let stuckChecks = 0;
    // awaitQuiescence throws while `stuckChecks` > 0, as it does for a mutation that does not finish.
    const runnerCh = Object.create(svc) as ClickHouseService;
    runnerCh.queryOne = (async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('system.processes') && stuckChecks > 0) {
        stuckChecks -= 1;
        events.push('stuck');
        throw new Error('injected: the ledger tables are not quiescent');
      }
      return svc.queryOne(sql, params);
    }) as ClickHouseService['queryOne'];
    const writer = new FailOnSecondWrite(svc);
    writer.onFailure = () => {
      events.push('write failed');
      stuckChecks = 2;
    };
    const write = LedgerWriter.prototype.write;
    jest.spyOn(LedgerWriter.prototype, 'write').mockImplementation(function (this: LedgerWriter, ledgers) {
      events.push('write');
      return write.call(this, ledgers);
    });
    const { runner, logger } = makeRunner(svc, new TestSource(L(30)), {
      writer,
      ch: runnerCh,
      options: { backoffInitialMs: 20, backoffMaxMs: 50 },
    });
    let statusWhileStuck: ReturnType<LiveRunner['status']> | undefined;
    const stuckLogged = jest.fn(() => (statusWhileStuck ??= runner.status()));
    logger.error = ((message: unknown) => {
      logger.lines.push({ level: 'error', message: String(message) });
      if (String(message).includes('injected: the ledger tables are not quiescent')) stuckLogged();
    }) as typeof logger.error;

    await runner.runOnce();

    const failedAt = events.indexOf('write failed');
    expect(failedAt).toBeGreaterThan(0);
    // Both stuck checks come before the next write: nothing is written while recovery is stuck.
    expect(events.slice(failedAt + 1, failedAt + 3)).toEqual(['stuck', 'stuck']);
    expect(stuckLogged).toHaveBeenCalledTimes(2);
    expect(statusWhileStuck).toMatchObject({ recovering: true, error: expect.stringContaining('not quiescent') });
    await expectNoDuplicateTransactions(svc);
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    expect(runner.status()).toMatchObject({ state: 'live', lag: 0 });
    expect(runner.status().recovering).toBeUndefined();
  });

  it('restart after crash cleans the uncommitted tail', async () => {
    const svc = await freshService();
    const { runner: first } = makeRunner(svc, new TestSource(L(20)));
    await first.runOnce();
    await first.stop();
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(20)));

    // A write that crashed after its child rows: 21-23 have rows but no commit marker; so has a stray ledger far above.
    await insertUncommitted(svc, chainRaw(L(21), L(22), L(23), L(40)));
    expect(await count(svc, Table.Transactions, `ledger_index > ${L(20)}`)).toBeGreaterThan(0);

    const { runner: second } = makeRunner(svc, new TestSource(L(30)));
    await second.runOnce();

    expect(await rowsAbove(svc, L(30))).toEqual(noRows()); // no orphans
    await expectNoDuplicateTransactions(svc); // no duplicates
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    expect(await tableCounts(svc)).toEqual(expectedCounts(L(30)));
  });

  it('deletes the orphans of a crashed first write before writing into an empty database', async () => {
    const svc = await freshService();
    await insertUncommitted(svc, chainRaw(L(1), L(2), L(3)));

    const { runner } = makeRunner(svc, new TestSource(L(30)));
    await runner.runOnce();

    await expectNoDuplicateTransactions(svc);
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
    expect(await tableCounts(svc)).toEqual(expectedCounts(L(30)));
  });

  it('parent_hash mismatch halts', async () => {
    const svc = await freshService();
    const forked = syntheticChain(L(1), 30, { breakAt: L(12) });
    const { runner, logger } = makeRunner(svc, new TestSource(L(30), forked));

    await expect(runner.runOnce()).rejects.toBeInstanceOf(ChainBreakError);

    expect(runner.status()).toMatchObject({ state: 'halted', checkpoint: L(11) });
    // The verified prefix is committed; nothing at or after the break is.
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(11)));
    expect(await rowsAbove(svc, L(11))).toEqual(noRows());
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: expect.stringContaining(`${L(12)}`) }),
    );
    // A halted runner stays halted.
    await expect(runner.runOnce()).rejects.toBeInstanceOf(ChainBreakError);
  });

  it('halts at boot when the stored checkpoint hash differs from the node', async () => {
    const svc = await freshService();
    const { runner: first } = makeRunner(svc, new TestSource(L(10)));
    await first.runOnce();
    await first.stop();

    const otherChain = syntheticChain(L(1), 30, { salt: 'other' });
    const source = new TestSource(L(30), otherChain);
    const { runner } = makeRunner(svc, source);
    await expect(runner.runOnce()).rejects.toThrow(ChainBreakError);

    expect(runner.status()).toMatchObject({ state: 'halted', checkpoint: L(10) });
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(10)));
    expect(source.fetches).toEqual([L(10)]);
  });

  it('polls the validated head when no hint arrives', async () => {
    const svc = await freshService();
    const source = new TestSource(L(5));
    const { runner } = makeRunner(svc, source, { options: { headSilenceMs: 100 } });

    await runner.onApplicationBootstrap();
    await waitFor(() => runner.status().checkpoint === L(5), 'the checkpoint to reach L(5)');
    source.head = L(9);
    source.available = L(9);
    await waitFor(() => runner.status().checkpoint === L(9), 'the checkpoint to reach L(9) without a hint');

    expect(await committedIndexes(svc)).toEqual(range(L(1), L(9)));
  });

  it('keeps the lag defined from the last known head while the node is unreachable', async () => {
    const svc = await freshService();
    const source = new TestSource(L(10));
    const hints = new EventEmitter();
    const { runner } = makeRunner(svc, source, { hints, options: { headSilenceMs: 50 } });
    await runner.onApplicationBootstrap();
    await waitFor(() => runner.status().checkpoint === L(10), 'the checkpoint to reach L(10)');

    // The node says 14 is validated, then goes away: fetches and head polls fail.
    hints.emit('ledgerClosed', { ledger_index: L(14) });
    source.validatedHead = async () => {
      throw new Error('NotConnectedError');
    };
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runner.status()).toMatchObject({ state: 'catching_up', checkpoint: L(10), head: L(14), lag: 4 });
  });

  describe('lease', () => {
    const otherHolder = 'other-host:42:0b6d1c2e';

    async function currentLease(svc: ClickHouseService): Promise<{ holder: string; heartbeatMs: number }> {
      const row = await svc.queryOne<{ holder: string; ms: string }>(
        `SELECT argMax(holder, heartbeat) AS holder, toUnixTimestamp64Milli(max(heartbeat)) AS ms
           FROM ${Table.SyncerLease} WHERE network = 'xrpl'`,
      );
      return { holder: row?.holder ?? '', heartbeatMs: Number(row?.ms) };
    }

    it("refuses to start while another holder's lease is fresh", async () => {
      const svc = await freshService();
      await svc.insert(Table.SyncerLease, [{ network: 'xrpl', holder: otherHolder, heartbeat: Date.now() / 1000 }]);
      const source = new TestSource(L(30));
      const { runner } = makeRunner(svc, source);

      await expect(runner.runOnce()).rejects.toThrow(`Another syncer holds the lease (${otherHolder})`);
      await expect(runner.onApplicationBootstrap()).rejects.toThrow(`Another syncer holds the lease (${otherHolder})`);

      expect(await count(svc, Table.Ledgers)).toBe(0);
      expect(source.fetches).toEqual([]);
      expect((await currentLease(svc)).holder).toBe(otherHolder);
    });

    it('ignores the lease of another network', async () => {
      const svc = await freshService();
      await svc.insert(Table.SyncerLease, [{ network: 'xahau', holder: otherHolder, heartbeat: Date.now() / 1000 }]);
      const { runner } = makeRunner(svc, new TestSource(L(3)));
      await expect(runner.runOnce()).resolves.toBeUndefined();
    });

    it('takes over a lease whose last heartbeat is older than 30 s', async () => {
      const svc = await freshService();
      await svc.insert(Table.SyncerLease, [
        { network: 'xrpl', holder: otherHolder, heartbeat: (Date.now() - 31_000) / 1000 },
      ]);
      const { runner } = makeRunner(svc, new TestSource(L(3)));

      await runner.runOnce();

      expect(await committedIndexes(svc)).toEqual(range(L(1), L(3)));
      expect((await currentLease(svc)).holder).toBe(runner.holder);
    });

    it('heartbeats in fractional seconds and releases the lease on stop, so that the next syncer starts at once', async () => {
      const svc = await freshService();
      const before = Date.now();
      const { runner: first } = makeRunner(svc, new TestSource(L(3)), { options: { heartbeatMs: 50 } });
      await first.runOnce();

      expect(first.holder).toMatch(new RegExp(`^${hostname()}:${process.pid}:[0-9a-f-]{36}$`));
      const lease = await currentLease(svc);
      expect(lease.holder).toBe(first.holder);
      // Stored in seconds with a fraction: a millisecond integer would read as a date thousands of years away.
      expect(lease.heartbeatMs).toBeGreaterThanOrEqual(before - 1_000);
      expect(lease.heartbeatMs).toBeLessThanOrEqual(Date.now() + 1_000);
      await waitFor(async () => (await currentLease(svc)).heartbeatMs > lease.heartbeatMs, 'a later heartbeat');

      const { runner: second } = makeRunner(svc, new TestSource(L(5)));
      await expect(second.runOnce()).rejects.toThrow(`Another syncer holds the lease (${first.holder})`);

      await first.stop();
      expect((await currentLease(svc)).holder).toBe('');

      await second.runOnce();
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(5)));
      expect((await currentLease(svc)).holder).toBe(second.holder);
    });
  });
});

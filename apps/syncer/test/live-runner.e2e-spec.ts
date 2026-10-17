import {
  buildLedgerRows,
  CHILD_TABLES,
  ClickHouseService,
  getNetworkProfile,
  LEDGER_KEYED_TABLES,
  LedgerNotAvailableError,
  LedgerParseError,
  LedgerSource,
  LedgerWriter,
  LedgerWriteResult,
  NodeThrottledError,
  parseContextFor,
  RawLedger,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { SyncerConfig } from '../src/config/syncer.config';
import {
  ChainBreakError,
  LeaseLostError,
  LEDGERS_PARTITION_SIZE,
  LiveRunner,
  LiveRunnerOptions,
} from '../src/ingest/live-runner';
import { LedgerNotValidatedError } from '../src/ingest/rpc-ledger-source';
import { PrometheusService } from '../src/modules/prometheus/prometheus.service';
import { ammTemplate, range, syntheticChain, SyntheticLedger } from './synthetic-chain';

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

/** What the counted tables hold when exactly the ledgers `L(1)` .. `last` of `chain` are committed. */
function expectedCounts(last: number, chain: SyntheticLedger[] = CHAIN): Counts {
  const counts: Counts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, 0]));
  for (const { index, raw } of chain) {
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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  const databases = new Map<ClickHouseService, string>();

  async function freshService(): Promise<ClickHouseService> {
    const cfg = { ...clickhouse.config, database: `live_runner_${++dbCounter}` };
    await runMigrations({ config: cfg, log: () => undefined });
    const svc = new ClickHouseService(cfg);
    services.push(svc);
    databases.set(svc, cfg.database);
    return svc;
  }

  /** Another client (own sockets) for the database of `svc`. */
  function secondClient(svc: ClickHouseService): ClickHouseService {
    const other = new ClickHouseService({ ...clickhouse.config, database: databases.get(svc) as string });
    services.push(other);
    return other;
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

  /** Rows of every ledger-keyed table below `index`. */
  async function rowsBelow(svc: ClickHouseService, index: number): Promise<Counts> {
    return Object.fromEntries(
      await Promise.all(
        LEDGER_KEYED_TABLES.map(
          async ({ table }) => [table, await count(svc, table, `ledger_index < ${index}`)] as const,
        ),
      ),
    );
  }

  /** The newest lease row of `xrpl` (what a runner reads). */
  async function currentLease(svc: ClickHouseService): Promise<{ holder: string; heartbeatMs: number }> {
    const row = await svc.queryOne<{ holder: string; ms: string }>(
      `SELECT argMax(holder, heartbeat) AS holder, toUnixTimestamp64Milli(max(heartbeat)) AS ms
         FROM ${Table.SyncerLease} WHERE network = 'xrpl'`,
    );
    return { holder: row?.holder ?? '', heartbeatMs: Number(row?.ms) };
  }

  /** Another syncer takes the lease: a lease row newer than every other, with its holder. */
  async function takeOverLease(svc: ClickHouseService, holder: string): Promise<void> {
    await svc.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat)
       SELECT 'xrpl', {holder:String}, now64(3) + toIntervalSecond(1)`,
      { holder },
    );
  }

  interface LiveIntent {
    range_start: number;
    range_end: number;
    run_id: string;
    status: string;
    updated_ms: number;
  }

  /** Every live first-write intent row of `ingest_log`, oldest first. */
  async function liveIntentRows(svc: ClickHouseService): Promise<LiveIntent[]> {
    const rows = await svc.query<LiveIntent>(
      `SELECT range_start, range_end, run_id, toString(status) AS status, toUnixTimestamp64Milli(updated_at) AS updated_ms
         FROM ${Table.IngestLog} WHERE startsWith(run_id, 'live:') ORDER BY updated_at`,
    );
    return rows.map((r) => ({
      ...r,
      range_start: Number(r.range_start),
      range_end: Number(r.range_end),
      updated_ms: Number(r.updated_ms),
    }));
  }

  /** Starts of the live intents whose latest status is still 'started'. */
  async function unfinishedLiveIntents(svc: ClickHouseService): Promise<number[]> {
    const rows = await svc.query<{ start: number }>(
      `SELECT range_start AS start FROM (
         SELECT range_start, argMax(status, updated_at) AS last_status FROM ${Table.IngestLog}
          WHERE startsWith(run_id, 'live:') GROUP BY range_start, range_end
       ) WHERE last_status = 'started' ORDER BY start`,
    );
    return rows.map((r) => Number(r.start));
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

  it('never lets one commit span two ledgers partitions', async () => {
    const svc = await freshService();
    const batches = recordBatches();
    // L(14) = 9,999,999 and L(15) = 10,000,000: batches of 10 would put both into one commit.
    const { runner } = makeRunner(svc, new TestSource(L(30)), {
      cfg: { catchupFlushLedgers: 10, catchupFlushMs: 600_000 },
      options: { headSilenceMs: 600_000 },
    });

    await within(runner.runOnce(), 10_000, 'Catching up 30 ledgers');

    expect(batches).toEqual([
      [L(1), L(10)],
      [L(11), L(14)],
      [L(15), L(24)],
      [L(25), L(29)],
      [L(30), L(30)],
    ]);
    const partition = (index: number) => Math.floor(index / LEDGERS_PARTITION_SIZE);
    for (const [first, last] of batches) expect(partition(first)).toBe(partition(last));
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
  });

  it('does not append to a due batch while its write waits for the lease', async () => {
    const svc = await freshService();
    const txsPerLedger = CHAIN[0].raw.transactions.length;
    let leaseChecksFailed = 0;
    let armed = false;
    // The lease check fails once (ClickHouse hiccup, not a takeover) when the first batch is due: its tip is L(14) =
    // 9,999,999, and it is also at catchupFlushLedgers and catchupFlushTxs.
    const runnerCh = Object.create(svc) as ClickHouseService;
    runnerCh.insert = (async (table: string, rows: unknown[], opts?: Record<string, unknown>) => {
      if (table === Table.IngestLog) armed = true; // the boot is done: the next lease check is the first flush's
      return svc.insert(table, rows, opts);
    }) as ClickHouseService['insert'];
    runnerCh.queryOne = (async (sql: string, params?: Record<string, unknown>) => {
      if (armed && sql.includes('dateDiff')) {
        armed = false;
        leaseChecksFailed += 1;
        throw new Error('injected: ClickHouse hiccup during the lease check');
      }
      return svc.queryOne(sql, params);
    }) as ClickHouseService['queryOne'];
    // Every lease confirmation looks stale, so every write checks the lease first.
    const realNow = performance.now.bind(performance);
    let shift = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => realNow() + (shift += 3_600_000));
    const batches = recordBatches();
    const { runner, logger } = makeRunner(svc, new TestSource(L(30)), {
      ch: runnerCh,
      cfg: { catchupFlushLedgers: 14, catchupFlushTxs: 14 * txsPerLedger, catchupFlushMs: 600_000 },
      options: { headSilenceMs: 600_000, backoffInitialMs: 50 },
    });

    await within(runner.runOnce(), 10_000, 'Catching up 30 ledgers');

    expect(leaseChecksFailed).toBe(1);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('injected: ClickHouse hiccup') }),
    );
    // The due batch was written as it was once the lease was confirmed: no ledger was added while it waited.
    expect(batches).toEqual([
      [L(1), L(14)],
      [L(15), L(28)],
      [L(29), L(29)],
      [L(30), L(30)],
    ]);
    const partition = (index: number) => Math.floor(index / LEDGERS_PARTITION_SIZE);
    for (const [first, last] of batches) {
      expect(partition(first)).toBe(partition(last));
      expect(last - first + 1).toBeLessThanOrEqual(14);
    }
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
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

    override async write(ledgers: RawLedger[]): Promise<LedgerWriteResult> {
      this.calls += 1;
      if (this.calls !== 2) return super.write(ledgers);
      const commitFails = Object.create(this.svc) as ClickHouseService;
      commitFails.insert = async (table, rows, opts) => {
        if (table === Table.LedgerByHash) throw new Error('injected failure after the child rows');
        return this.svc.insert(table, rows, opts);
      };
      try {
        // Same runId: these inserts are this writer's, and recovery must wait for exactly them.
        return await new LedgerWriter(commitFails, ctx, { runId: this.runId }).write(ledgers);
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

  describe('AMM rows and syncer_amm_unclassified_total', () => {
    /** Transactions per ledger that touch a pool the parser cannot classify (see `ammTemplate`). */
    const UNCLASSIFIED_PER_LEDGER = 2;
    // Every ledger: an AMMCreate, an AMMVote and 10 swaps against pools of two recorded mainnet ledgers, and 2 pools
    // that give no row.
    const AMM_CHAIN = syntheticChain(L(1), 12, { template: ammTemplate(UNCLASSIFIED_PER_LEDGER) });

    /** What the parser could not classify in the ledgers `L(1)` .. `last` of the chain. */
    const unclassifiedUpTo = (last: number): number =>
      AMM_CHAIN.filter((l) => l.index <= last).reduce(
        (sum, l) => sum + buildLedgerRows(l.raw, ctx).diagnostics.ammUnclassified,
        0,
      );

    /** The counter now. It is process-wide, so a test compares it with its value before. */
    const unclassified = async (metrics: PrometheusService): Promise<number> =>
      (await metrics.ammUnclassifiedTotal.get()).values[0]?.value ?? 0;

    it('the chain has rows for all four AMM tables and two unclassified pools per ledger', () => {
      expect(unclassifiedUpTo(L(12))).toBe(12 * UNCLASSIFIED_PER_LEDGER);
      const counts = expectedCounts(L(12), AMM_CHAIN);
      for (const table of [Table.AmmPoolStates, Table.AmmLiquidity, Table.AccountAmmLiquidity, Table.AmmGovernance]) {
        expect([table, counts[table] > 0]).toEqual([table, true]);
      }
    });

    it('writes the AMM rows with the ledgers and adds the pools it could not classify to the counter', async () => {
      const svc = await freshService();
      const metrics = new PrometheusService();
      const before = await unclassified(metrics);
      const { runner } = makeRunner(svc, new TestSource(L(12), AMM_CHAIN), { metrics });

      await within(runner.runOnce(), 20_000, 'Catching up 12 AMM ledgers');

      expect(await committedIndexes(svc)).toEqual(range(L(1), L(12)));
      expect(await tableCounts(svc)).toEqual(expectedCounts(L(12), AMM_CHAIN));
      expect(await unclassified(metrics)).toBe(before + 12 * UNCLASSIFIED_PER_LEDGER);
    });

    it('adds nothing for a chain without AMM activity', async () => {
      const svc = await freshService();
      const metrics = new PrometheusService();
      const before = await unclassified(metrics);
      const { runner } = makeRunner(svc, new TestSource(L(10)), { metrics });

      await runner.runOnce();

      expect(await committedIndexes(svc)).toEqual(range(L(1), L(10)));
      expect(await unclassified(metrics)).toBe(before);
    });

    it('counts a batch once: not for a write that failed and was recovered, only for the one that committed', async () => {
      const svc = await freshService();
      const metrics = new PrometheusService();
      const before = await unclassified(metrics);
      // The second batch fails after its child rows went in; recovery deletes them and writes the batch again.
      const writer = new FailOnSecondWrite(svc);
      const { runner } = makeRunner(svc, new TestSource(L(12), AMM_CHAIN), { metrics, writer });

      await within(runner.runOnce(), 20_000, 'Catching up 12 AMM ledgers through a failed write');

      expect(writer.orphanTransactions).toBeGreaterThan(0); // the failure really left rows behind
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(12)));
      expect(await tableCounts(svc)).toEqual(expectedCounts(L(12), AMM_CHAIN));
      expect(await unclassified(metrics)).toBe(before + 12 * UNCLASSIFIED_PER_LEDGER);
    });

    it('counts the ledgers committed before a ledger the parser rejects, and no more', async () => {
      const svc = await freshService();
      const chain = syntheticChain(L(1), 12, { template: ammTemplate(UNCLASSIFIED_PER_LEDGER), malformedAt: L(10) });
      const metrics = new PrometheusService();
      const before = await unclassified(metrics);
      // Batches of 7: L(1)..L(7) commit, then L(8)..L(14) holds the bad ledger: its prefix L(8)..L(9) commits too.
      const { runner } = makeRunner(svc, new TestSource(L(12), chain), { metrics });

      await expect(runner.runOnce()).rejects.toBeInstanceOf(LedgerParseError);

      expect(await committedIndexes(svc)).toEqual(range(L(1), L(9)));
      expect(await unclassified(metrics)).toBe(before + 9 * UNCLASSIFIED_PER_LEDGER);
    });
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

  it('cleans up after a crashed first write that started below the current head (no GH_SYNC_START_LEDGER)', async () => {
    const svc = await freshService();
    const before = Date.now();
    // A first boot starts at the head of its moment, L(5), records that intent, and dies with its first write in flight.
    const stuck = new TestSource(L(5));
    stuck.fetch = () => new Promise<RawLedger>(() => undefined);
    const { runner: first } = makeRunner(svc, stuck, { cfg: { syncStartLedger: undefined } });
    const firstRun = first.runOnce();
    await waitFor(async () => (await liveIntentRows(svc)).length === 1, 'the first-write intent');
    await first.stop();
    await firstRun;

    const [intent] = await liveIntentRows(svc);
    // Keyed (start, 0): range_end 0 is a sentinel no range-ingest chunk can have (ruling R26).
    expect(intent).toMatchObject({
      range_start: L(5),
      range_end: 0,
      run_id: `live:${first.bootId}`,
      status: 'started',
    });
    // updated_at went in as fractional seconds: a millisecond integer would read as a date thousands of years away.
    expect(intent.updated_ms).toBeGreaterThanOrEqual(before - 1_000);
    expect(intent.updated_ms).toBeLessThanOrEqual(Date.now() + 1_000);
    // ...and its write got as far as the child rows of L(5) and L(6), not their commit marker.
    await insertUncommitted(svc, chainRaw(L(5), L(6)));
    // A range-ingest chunk that starts at the same ledger, newer and done, merged with everything: it must not swallow the
    // intent (with the key (start, start) the merge would keep only the chunk's row).
    await svc.insert(Table.IngestLog, [
      { range_start: L(5), range_end: L(5), run_id: 'range:chunk', status: 'done', updated_at: Date.now() / 1000 + 1 },
    ]);
    await svc.command(`OPTIMIZE TABLE ${Table.IngestLog} FINAL`);
    expect(await unfinishedLiveIntents(svc)).toEqual([L(5)]);

    // The next boot starts at the head of its own moment, L(12): above those rows.
    const { runner: second } = makeRunner(svc, new TestSource(L(12)), { cfg: { syncStartLedger: undefined } });
    await second.runOnce();

    expect(await rowsBelow(svc, L(12))).toEqual(noRows()); // no orphans left below the new start
    expect(await committedIndexes(svc)).toEqual([L(12)]);
    await expectNoDuplicateTransactions(svc);
    // After the first commit no intent is left unfinished, the crashed one included.
    expect(await unfinishedLiveIntents(svc)).toEqual([]);
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

  /** How often the runner halted for `reason`, so far (the counter is process-wide). */
  async function halts(metrics: PrometheusService, reason: string): Promise<number> {
    const { values } = await metrics.ingestHaltsTotal.get();
    return values.find((v) => v.labels.reason === reason)?.value ?? 0;
  }

  it('halts on a ledger the parser rejects: commits the ledgers before it and does not retry (ruling R96)', async () => {
    const svc = await freshService();
    const chain = syntheticChain(L(1), 30, { malformedAt: L(12) });
    const source = new TestSource(L(30), chain);
    const metrics = new PrometheusService();
    const before = await halts(metrics, 'parse_error');
    // Batches of 7: L(1)..L(7) commit, then L(8)..L(14) holds the bad ledger: its prefix L(8)..L(11) commits too.
    const { runner, logger } = makeRunner(svc, source, { metrics });

    await expect(runner.runOnce()).rejects.toBeInstanceOf(LedgerParseError);

    expect(runner.status()).toMatchObject({
      state: 'halted',
      checkpoint: L(11),
      error: expect.stringContaining(`Cannot parse ledger ${L(12)}`),
    });
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(11)));
    expect(await rowsAbove(svc, L(11))).toEqual(noRows());
    expect(source.fetchCount(L(12))).toBe(1); // not "recovered" and fetched again
    expect(await halts(metrics, 'parse_error')).toBe(before + 1);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining(`Ingest halted until an operator intervenes: Cannot parse ledger ${L(12)}`),
      }),
    );
    expect(logger.lines.some((l) => l.message.includes('Recovered'))).toBe(false);
    // A halted runner stays halted.
    await expect(runner.runOnce()).rejects.toBeInstanceOf(LedgerParseError);
  });

  it('halts at once when the first ledger of a batch is the one the parser rejects', async () => {
    const svc = await freshService();
    const chain = syntheticChain(L(1), 30, { malformedAt: L(8) });
    const { runner } = makeRunner(svc, new TestSource(L(30), chain));

    await expect(runner.runOnce()).rejects.toMatchObject({ name: 'LedgerParseError', ledgerIndex: L(8) });

    expect(runner.status()).toMatchObject({ state: 'halted', checkpoint: L(7) });
    expect(await committedIndexes(svc)).toEqual(range(L(1), L(7)));
    expect(await rowsAbove(svc, L(7))).toEqual(noRows());
  });

  it('counts a chain break as a halt too', async () => {
    const svc = await freshService();
    const metrics = new PrometheusService();
    const before = await halts(metrics, 'chain_break');
    const { runner } = makeRunner(svc, new TestSource(L(30), syntheticChain(L(1), 30, { breakAt: L(12) })), {
      metrics,
    });
    await expect(runner.runOnce()).rejects.toBeInstanceOf(ChainBreakError);
    expect(await halts(metrics, 'chain_break')).toBe(before + 1);
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

  it('waits as long as a rate-limited node asks before it fetches again, without a warning per fetch (ruling R98)', async () => {
    const svc = await freshService();
    const source = new TestSource(L(10));
    const fetchedAt = new Map<number, number[]>();
    const fetch = source.fetch.bind(source);
    let throttled = 0;
    jest.spyOn(source, 'fetch').mockImplementation(async (index: number) => {
      fetchedAt.set(index, [...(fetchedAt.get(index) ?? []), Date.now()]);
      if (index === L(3) && throttled++ === 0) {
        throw new NodeThrottledError(['wss://node.example'], 600, 'rate limit: retry in ~350ms');
      }
      return fetch(index);
    });
    const { runner, logger } = makeRunner(svc, source, { options: { backoffInitialMs: 20, backoffMaxMs: 50 } });

    await runner.runOnce();

    expect(await committedIndexes(svc)).toEqual(range(L(1), L(10)));
    const [first, second] = fetchedAt.get(L(3)) ?? [];
    expect(second - first).toBeGreaterThanOrEqual(580); // the hint, not the 20 ms backoff
    // The node client logs the pause once; the runner does not add a warning for every fetch it holds back.
    expect(logger.lines.filter((l) => l.level === 'warn' && l.message.includes('rate limit'))).toEqual([]);
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

    it('judges the age of a lease on the ClickHouse server clock, not the local one', async () => {
      const svc = await freshService();
      await svc.command(
        `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl', {holder:String}, now64(3)`,
        { holder: otherHolder },
      );
      // This host's clock runs an hour ahead: on it, the lease would look an hour old.
      const realNow = Date.now.bind(Date);
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 3_600_000);
      // The ClickHouse client ages its keep-alive sockets with Date.now(): the runner gets a client whose sockets are all
      // made on the shifted clock, and the shared one is not used until the clock is back.
      const { runner } = makeRunner(svc, new TestSource(L(3)), { ch: secondClient(svc) });

      await expect(runner.runOnce()).rejects.toThrow(`Another syncer holds the lease (${otherHolder})`);
      clock.mockRestore();
      expect((await currentLease(svc)).holder).toBe(otherHolder);
    });

    it('halts when another syncer takes the lease over, and writes nothing more', async () => {
      const svc = await freshService();
      const source = new TestSource(L(5));
      const hints = new EventEmitter();
      const { runner } = makeRunner(svc, source, { hints, options: { heartbeatMs: 50 } });
      await runner.onApplicationBootstrap();
      await waitFor(() => runner.status().checkpoint === L(5), 'the checkpoint to reach L(5)');

      await takeOverLease(svc, otherHolder);
      await waitFor(() => runner.status().state === 'halted', 'the runner to halt');
      expect(runner.status()).toMatchObject({
        state: 'halted',
        checkpoint: L(5),
        error: `lease lost to ${otherHolder}`,
      });
      await expect(runner.runOnce()).rejects.toBeInstanceOf(LeaseLostError);

      const writes = recordBatches();
      source.available = L(9);
      hints.emit('ledgerClosed', { ledger_index: L(9) });
      await pause(300);
      expect(writes).toEqual([]);
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(5)));

      await runner.stop();
      expect((await currentLease(svc)).holder).toBe(otherHolder); // not released over the new holder
    });

    it("does not overwrite a takeover that lands between a heartbeat's check and its renewal", async () => {
      const svc = await freshService();
      let armed = false;
      // Right after the heartbeat has read the lease (still ours), another syncer writes its own row.
      const runnerCh = Object.create(svc) as ClickHouseService;
      runnerCh.queryOne = (async (sql: string, params?: Record<string, unknown>) => {
        const row = await svc.queryOne(sql, params);
        if (armed && sql.includes('dateDiff')) {
          armed = false;
          await svc.command(
            `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl', {holder:String}, now64(3)`,
            { holder: otherHolder },
          );
        }
        return row;
      }) as ClickHouseService['queryOne'];
      const { runner } = makeRunner(svc, new TestSource(L(5)), { ch: runnerCh, options: { heartbeatMs: 50 } });
      await runner.onApplicationBootstrap();
      await waitFor(() => runner.status().checkpoint === L(5), 'the checkpoint to reach L(5)');

      armed = true;
      await waitFor(() => runner.status().state === 'halted', 'the runner to halt');
      expect(runner.status().error).toBe(`lease lost to ${otherHolder}`);
      expect((await currentLease(svc)).holder).toBe(otherHolder);
    });

    it('re-checks a stale lease before writing, and halts instead of writing when it was taken over', async () => {
      const svc = await freshService();
      const source = new TestSource(L(5));
      const hints = new EventEmitter();
      // No heartbeat fires during the test: only the check before a write can notice the takeover.
      const { runner } = makeRunner(svc, source, { hints, options: { heartbeatMs: 600_000 } });
      await runner.onApplicationBootstrap();
      await waitFor(() => runner.status().checkpoint === L(5), 'the checkpoint to reach L(5)');

      // The process stalled for an hour (its last lease confirmation is that old), and meanwhile another syncer took over.
      await takeOverLease(svc, otherHolder);
      const realNow = performance.now.bind(performance);
      jest.spyOn(performance, 'now').mockImplementation(() => realNow() + 3_600_000);
      const writes = recordBatches();
      source.available = L(8);
      hints.emit('ledgerClosed', { ledger_index: L(8) });

      await waitFor(() => runner.status().state === 'halted', 'the runner to halt');
      expect(runner.status().error).toBe(`lease lost to ${otherHolder}`);
      expect(writes).toEqual([]);
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(5)));
    });

    it('releases the lease within moments of stop() even while a boot fetch never answers', async () => {
      const svc = await freshService();
      const { runner: first } = makeRunner(svc, new TestSource(L(3)));
      await first.runOnce();
      await first.stop();

      const silent = new TestSource(L(10));
      silent.fetch = () => new Promise<RawLedger>(() => undefined);
      const { runner } = makeRunner(svc, silent);
      await runner.onApplicationBootstrap(); // the boot check fetches the checkpoint L(3): no answer, ever
      await pause(100);
      expect((await currentLease(svc)).holder).toBe(runner.holder);

      await within(runner.stop(), 3_000, 'stop()');
      expect((await currentLease(svc)).holder).toBe('');
    });

    it('heartbeats on the server clock and releases the lease on stop, so that the next syncer starts at once', async () => {
      const svc = await freshService();
      const before = Date.now();
      const { runner: first } = makeRunner(svc, new TestSource(L(3)), { options: { heartbeatMs: 50 } });
      await first.runOnce();

      expect(first.holder).toMatch(new RegExp(`^${hostname()}:${process.pid}:[0-9a-f-]{36}$`));
      const lease = await currentLease(svc);
      expect(lease.holder).toBe(first.holder);
      // A sane time (written by the server with now64(3)), not a date thousands of years away.
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

import { ClickHouseSettings } from '@clickhouse/client';
import {
  buildLedgerRows,
  CHILD_TABLES,
  ClickHouseService,
  CommandOptions,
  committedCheckpoint,
  FixtureLedgerSource,
  getNetworkProfile,
  InsertOptions,
  LEDGER_KEYED_TABLES,
  LedgerNotAvailableError,
  LedgerSource,
  LedgerWriter,
  parseContextFor,
  RawLedger,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { rangeIngest, RangeIngestOptions } from '../src/cli/range-ingest';
import { range, syntheticChain } from './synthetic-chain';

const ctx = parseContextFor(getNetworkProfile('xrpl'));

/** The 54 ripple-mock ledgers: sparse, over ten 1000-ledger buckets and five `ledgers` partitions. */
const FIXTURES: RawLedger[] = FixtureLedgerSource.fromDir(
  join(__dirname, '../../../packages/shared/test/fixtures/xrpl/ripple-mock'),
).list();
const FIXTURE_INDEXES = FIXTURES.map((l) => l.header.ledger_index);
const FIXTURE_FROM = FIXTURE_INDEXES[0];
const FIXTURE_TO = FIXTURE_INDEXES[FIXTURE_INDEXES.length - 1];

/** `L(1)` .. `L(30)` = 9999986 .. 10000015: the chain crosses the partition boundary at ledger 10,000,000. */
const BASE = 9_999_985;
const L = (i: number): number => BASE + i;
const CHAIN = syntheticChain(L(1), 30);
const CHAIN_RAW = CHAIN.map((l) => l.raw);

const ALL_TABLES: Table[] = LEDGER_KEYED_TABLES.map((t) => t.table);
/**
 * Every synthetic ledger carries the template's transactions, so `tx_by_hash` (ORDER BY hash) collapses them at any
 * merge: its count is only exact for the fixtures.
 */
const CHAIN_TABLES: Table[] = ALL_TABLES.filter((t) => t !== Table.TxByHash);

type Counts = Record<string, number>;

/** What `tables` hold when exactly `ledgers` are committed, from the rows `buildLedgerRows` makes. */
function expectedCounts(ledgers: RawLedger[], tables: Table[]): Counts {
  const counts: Counts = Object.fromEntries(tables.map((t) => [t, 0]));
  for (const raw of ledgers) {
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
 * A node stand-in: serves `ledgers` by index (`LedgerNotAvailableError` for any other), records every fetch and how
 * many were in flight at once, and can delay or fail fetches.
 */
class TestSource implements LedgerSource {
  readonly fetches: number[] = [];
  /** Index -> how many more fetches of it fail with a plain error. */
  readonly failures = new Map<number, number>();
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  private readonly byIndex: Map<number, RawLedger>;

  constructor(ledgers: RawLedger[]) {
    this.byIndex = new Map(ledgers.map((l) => [l.header.ledger_index, l]));
  }

  async validatedHead(): Promise<number> {
    return Math.max(...this.byIndex.keys());
  }

  async fetch(index: number): Promise<RawLedger> {
    this.fetches.push(index);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await pause(this.delayMs);
      const failing = this.failures.get(index) ?? 0;
      if (failing > 0) {
        this.failures.set(index, failing - 1);
        throw new Error(`fetch of ${index} failed`);
      }
      const ledger = this.byIndex.get(index);
      if (!ledger) throw new LedgerNotAvailableError(index);
      return ledger;
    } finally {
      this.inFlight -= 1;
    }
  }

  fetchCount(index: number): number {
    return this.fetches.filter((i) => i === index).length;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface LogLine {
  level: 'log' | 'warn' | 'error';
  message: string;
}

function captureLogger() {
  const lines: LogLine[] = [];
  const add = (level: LogLine['level']) => (message: unknown) => {
    lines.push({ level, message: String(message) });
  };
  return { lines, log: add('log'), warn: add('warn'), error: add('error') };
}

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** Options that keep the failure paths fast and the output of the suite clean. */
const FAST: Partial<RangeIngestOptions> = { retryBackoffMs: 1, quiescenceTimeoutMs: 5_000, logger: QUIET };

describe('rangeIngest (e2e)', () => {
  let clickhouse: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    clickhouse = await startClickHouse();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await clickhouse?.container.stop();
  });

  /** A migrated database of its own: no test sees another test's rows, intents, lease or dedup log. */
  async function freshService(): Promise<ClickHouseService> {
    const cfg = { ...clickhouse.config, database: `range_ingest_${++dbCounter}` };
    await runMigrations({ config: cfg, log: () => undefined });
    const svc = new ClickHouseService(cfg);
    services.push(svc);
    return svc;
  }

  const count = async (svc: ClickHouseService, table: Table | string, where = '1'): Promise<number> =>
    Number((await svc.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  async function tableCounts(svc: ClickHouseService, tables: Table[]): Promise<Counts> {
    return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(svc, t)] as const)));
  }

  async function committedIndexes(svc: ClickHouseService): Promise<number[]> {
    const rows = await svc.query<{ i: number }>(`SELECT ledger_index AS i FROM ${Table.Ledgers} ORDER BY i`);
    return rows.map((r) => Number(r.i));
  }

  /** `count() == uniqExact(ledger_index, tx_index)` on `transactions`: no transaction row is there twice. */
  async function expectNoDuplicateTransactions(svc: ClickHouseService): Promise<void> {
    const row = await svc.queryOne<{ n: string; u: string }>(
      `SELECT count() AS n, uniqExact(ledger_index, tx_index) AS u FROM ${Table.Transactions}`,
    );
    expect(Number(row?.n)).toBeGreaterThan(0);
    expect(Number(row?.n)).toBe(Number(row?.u));
  }

  interface Intent {
    start: number;
    end: number;
    status: string;
    runId: string;
  }

  /** The newest row of every `ingest_log` key, as the runner reads it. */
  async function intents(svc: ClickHouseService, where = '1'): Promise<Intent[]> {
    const rows = await svc.query<{ range_start: number; range_end: number; last_status: string; last_run_id: string }>(
      `SELECT range_start, range_end, argMax(status, updated_at) AS last_status, argMax(run_id, updated_at) AS last_run_id
         FROM ${Table.IngestLog} WHERE ${where} GROUP BY range_start, range_end ORDER BY range_start, range_end`,
    );
    return rows.map((r) => ({
      start: Number(r.range_start),
      end: Number(r.range_end),
      status: r.last_status,
      runId: r.last_run_id,
    }));
  }

  const keys = (list: Intent[]): Array<[number, number]> => list.map((i) => [i.start, i.end]);

  /** A 'started' intent as a crashed range run leaves it. */
  async function seedIntent(
    svc: ClickHouseService,
    start: number,
    end: number,
    runId: string,
    status: 'started' | 'done' = 'started',
  ): Promise<void> {
    // updated_at is DateTime64(3): a JSON number is read as seconds, so it is sent as fractional seconds.
    await svc.insert(Table.IngestLog, [
      { range_start: start, range_end: end, run_id: runId, status, updated_at: Date.now() / 1000 },
    ]);
  }

  /** Child rows and `ledger_by_hash` without the `ledgers` row: what a write that died before its commit leaves. */
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

  /** A live syncer's lease row, `ageSeconds` old on the server's clock. */
  async function seedLease(svc: ClickHouseService, holder: string, ageSeconds: number): Promise<void> {
    await svc.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat)
       SELECT 'xrpl', {holder:String}, now64(3) - toIntervalSecond({age:UInt32})`,
      { holder, age: ageSeconds },
    );
  }

  /**
   * Records, in order, what the runner does to ClickHouse that matters for recovery: `quiesce:<id>` for every
   * `awaitQuiescence` look at the server (it passes the id as `exact`), `delete:<prefix>` for every DELETE (the prefix
   * of its query id), `insert:<table>:<runId>` for every ledger insert and `intent:<status>:<runId>` for every
   * `ingest_log` row.
   */
  function recordEvents(svc: ClickHouseService, failFirstLedgersInsert = false): string[] {
    const events: string[] = [];
    const runIdOf = (queryId?: string): string => (queryId ?? '').split(':')[0];

    const insert = svc.insert.bind(svc);
    let failed = false;
    jest.spyOn(svc, 'insert').mockImplementation((async (
      table: Table | string,
      rows: unknown[],
      opts?: InsertOptions,
    ) => {
      if (opts?.queryId) events.push(`insert:${table}:${runIdOf(opts.queryId)}`);
      if (failFirstLedgersInsert && table === Table.Ledgers && !failed) {
        failed = true;
        events.push(`fail:${runIdOf(opts?.queryId)}`);
        throw new Error('injected: the commit insert failed');
      }
      return insert(table, rows, opts);
    }) as typeof svc.insert);

    const queryOne = svc.queryOne.bind(svc);
    jest.spyOn(svc, 'queryOne').mockImplementation(((
      sql: string,
      params?: Record<string, unknown>,
      settings?: ClickHouseSettings,
    ) => {
      if (typeof params?.exact === 'string') events.push(`quiesce:${params.exact}`);
      return queryOne(sql, params, settings);
    }) as typeof svc.queryOne);

    const command = svc.command.bind(svc);
    jest.spyOn(svc, 'command').mockImplementation(((
      sql: string,
      params?: Record<string, unknown>,
      opts?: CommandOptions,
    ) => {
      if (/^\s*DELETE/.test(sql)) events.push(`delete:${(opts?.queryId ?? '').split(':delete:')[0]}`);
      if (/^\s*INSERT INTO ingest_log/.test(sql)) events.push(`intent:${params?.status}:${params?.runId}`);
      return command(sql, params, opts);
    }) as typeof svc.command);
    return events;
  }

  const hourFloor = (seconds: number): number => Math.floor(seconds / 3600) * 3600;

  /** The distinct `agg_dirty` windows, as `from-to` unix seconds, ascending. */
  async function dirtyWindows(svc: ClickHouseService): Promise<Array<[number, number]>> {
    const rows = await svc.query<{ f: number; t: number }>(
      `SELECT DISTINCT toUnixTimestamp(from_hour) AS f, toUnixTimestamp(to_hour) AS t FROM ${Table.AggDirty} ORDER BY f, t`,
    );
    return rows.map((r) => [Number(r.f), Number(r.t)]);
  }

  describe('explicit index list', () => {
    it('ingests an explicit index list', async () => {
      const svc = await freshService();
      const source = new TestSource(FIXTURES);

      const result = await rangeIngest(source, svc, ctx, {
        from: FIXTURE_FROM,
        to: FIXTURE_TO,
        indexes: FIXTURE_INDEXES,
        ...FAST,
      });

      // The 54 ledgers sit in ten 1000-ledger buckets: ten chunks.
      expect(result).toEqual({ chunksDone: 10, ledgers: 54 });
      expect(await committedIndexes(svc)).toEqual(FIXTURE_INDEXES);
      expect(await tableCounts(svc, ALL_TABLES)).toEqual(expectedCounts(FIXTURES, ALL_TABLES));
      expect(await count(svc, Table.Payments)).toBe(182);
      expect([...source.fetches].sort((a, b) => a - b)).toEqual(FIXTURE_INDEXES);

      // One intent per chunk, bounded by the first and last ledger of the chunk, every one done.
      const buckets = new Map<number, number[]>();
      for (const i of FIXTURE_INDEXES)
        buckets.set(Math.floor(i / 1000), [...(buckets.get(Math.floor(i / 1000)) ?? []), i]);
      const log = await intents(svc);
      expect(keys(log)).toEqual([...buckets.values()].map((b) => [b[0], b[b.length - 1]]));
      expect(log.every((i) => i.status === 'done')).toBe(true);
    });

    it('fetches only the listed indexes inside [from, to]', async () => {
      const svc = await freshService();
      const source = new TestSource(FIXTURES);
      const from = 11_118_861;
      const to = 11_119_600;
      const inside = FIXTURE_INDEXES.filter((i) => i >= from && i <= to);
      expect(inside.length).toBeGreaterThan(2);

      const result = await rangeIngest(source, svc, ctx, { from, to, indexes: FIXTURE_INDEXES, ...FAST });

      expect(result.ledgers).toBe(inside.length);
      expect([...source.fetches].sort((a, b) => a - b)).toEqual(inside);
      expect(await committedIndexes(svc)).toEqual(inside);
    });

    it('never swallows LedgerNotAvailableError: it stops the run and leaves the chunk as an unfinished intent', async () => {
      const svc = await freshService();
      const missing = FIXTURE_INDEXES[20];
      const source = new TestSource(FIXTURES.filter((l) => l.header.ledger_index !== missing));

      await expect(
        rangeIngest(source, svc, ctx, { from: FIXTURE_FROM, to: FIXTURE_TO, indexes: FIXTURE_INDEXES, ...FAST }),
      ).rejects.toBeInstanceOf(LedgerNotAvailableError);

      // Not retried, and nothing of its chunk is committed.
      expect(source.fetchCount(missing)).toBe(1);
      const bucket = Math.floor(missing / 1000);
      expect((await committedIndexes(svc)).filter((i) => Math.floor(i / 1000) === bucket)).toEqual([]);
      const unfinished = (await intents(svc)).filter((i) => i.status === 'started');
      expect(unfinished).toHaveLength(1);
      expect(unfinished[0].start).toBeLessThanOrEqual(missing);
      expect(unfinished[0].end).toBeGreaterThanOrEqual(missing);
      // The chunks before it are complete, and the later chunks were not started.
      expect(await committedIndexes(svc)).toEqual(FIXTURE_INDEXES.filter((i) => i < Math.floor(missing / 1000) * 1000));
    });

    it('rejects an index that is not an integer', async () => {
      const svc = await freshService();
      await expect(
        rangeIngest(new TestSource(FIXTURES), svc, ctx, { from: 1, to: 100, indexes: [5, 2.5] }),
      ).rejects.toThrow(/index/i);
    });
  });

  describe('a contiguous range', () => {
    it('ingests aligned chunks and never lets a chunk span a partition', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST });

      // 9999986..9999999 and 10000000..10000015: the boundary of the 1,000,000-ledger `ledgers` partition.
      expect(result).toEqual({ chunksDone: 2, ledgers: 30 });
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(30)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW, CHAIN_TABLES));
      expect(keys(await intents(svc))).toEqual([
        [L(1), 9_999_999],
        [10_000_000, L(30)],
      ]);
    });

    it('aligns chunks to multiples of the chunk size', async () => {
      const svc = await freshService();

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, {
        from: L(1),
        to: L(30),
        chunkSize: 10,
        ...FAST,
      });

      expect(result).toEqual({ chunksDone: 4, ledgers: 30 });
      expect(keys(await intents(svc))).toEqual([
        [9_999_986, 9_999_989],
        [9_999_990, 9_999_999],
        [10_000_000, 10_000_009],
        [10_000_010, 10_000_015],
      ]);
    });

    it('fetches up to `concurrency` ledgers of a chunk at once', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);
      source.delayMs = 20;

      await rangeIngest(source, svc, ctx, { from: L(15), to: L(30), concurrency: 3, ...FAST });

      expect(source.maxInFlight).toBe(3);
      expect(await committedIndexes(svc)).toEqual(range(L(15), L(30)));
    });

    it('fetches eight at once by default', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);
      source.delayMs = 20;

      await rangeIngest(source, svc, ctx, { from: L(15), to: L(30), ...FAST });

      expect(source.maxInFlight).toBe(8);
    });

    it('skips the ledgers that are already committed and writes only the missing ones', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 5)); // L(1)..L(5)
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(14), ...FAST });

      expect(result).toEqual({ chunksDone: 1, ledgers: 9 });
      expect(source.fetches.sort((a, b) => a - b)).toEqual(range(L(6), L(14)));
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(14)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
    });

    it('does nothing for a range that is complete, except to mark the hours of the ledgers it skipped', async () => {
      const svc = await freshService();
      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(30), ...FAST });
      const logBefore = await count(svc, Table.IngestLog);
      const window = await dirtyWindows(svc);
      expect(window).toHaveLength(1);
      await svc.command(`TRUNCATE TABLE ${Table.AggDirty}`); // the marks an earlier, killed run never wrote
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST });

      expect(result).toEqual({ chunksDone: 2, ledgers: 0 });
      expect(source.fetches).toEqual([]);
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW, CHAIN_TABLES));
      expect(await count(svc, Table.IngestLog)).toBe(logBefore);
      // One row, from the close times that `ledgers` holds.
      expect(await count(svc, Table.AggDirty)).toBe(1);
      expect(await dirtyWindows(svc)).toEqual(window);
    });

    it('never swallows LedgerNotAvailableError for a gap in a contiguous range', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW.filter((l) => l.header.ledger_index !== L(20)));

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST })).rejects.toMatchObject({
        name: 'LedgerNotAvailableError',
        ledgerIndex: L(20),
      });

      expect(source.fetchCount(L(20))).toBe(1);
      // The first chunk (9999986..9999999) is complete; the second never wrote its ledgers.
      expect(await committedIndexes(svc)).toEqual(range(L(1), 9_999_999));
      expect((await intents(svc)).map((i) => i.status)).toEqual(['done', 'started']);
    });

    it('retries a fetch that failed, without touching what is committed', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);
      source.failures.set(L(7), 1);
      const logger = captureLogger();

      const result = await rangeIngest(source, svc, ctx, { ...FAST, from: L(1), to: L(14), logger });

      expect(result.ledgers).toBe(14);
      expect(source.fetchCount(L(7))).toBe(2);
      expect(logger.lines.some((l) => l.level === 'warn' && l.message.includes(`fetch of ${L(7)} failed`))).toBe(true);
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
    });
  });

  describe('recovery', () => {
    it("redo of a 'started' intent deletes and rewrites the chunk", async () => {
      const svc = await freshService();
      // A run that crashed after the commit and before it marked the chunk done: all 14 ledgers are in, the intent is open.
      await new LedgerWriter(svc, ctx, { runId: 'crashed-run' }).write(CHAIN_RAW.slice(0, 14));
      await seedIntent(svc, L(1), 9_999_999, 'crashed-run');
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST });

      // The first chunk was redone although its ledgers were committed; the second was new.
      expect(result).toEqual({ chunksDone: 2, ledgers: 30 });
      expect(source.fetches.sort((a, b) => a - b)).toEqual(range(L(1), L(30)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW, CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
      expect((await intents(svc)).map((i) => i.status)).toEqual(['done', 'done']);
    });

    it("redo of a 'started' intent removes the child rows of a write that never committed", async () => {
      const svc = await freshService();
      await insertUncommitted(svc, CHAIN_RAW.slice(0, 14));
      await seedIntent(svc, L(1), 9_999_999, 'crashed-run');
      expect(await count(svc, Table.Transactions)).toBeGreaterThan(0);

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });

      expect(result).toEqual({ chunksDone: 1, ledgers: 14 });
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
    });

    it('treats an unfinished intent of different bounds that overlaps a chunk as that chunk being unfinished', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx, { runId: 'crashed-run' }).write(CHAIN_RAW.slice(0, 14));
      // The crashed run worked in chunks of 5: its open chunk is L(6)..L(10).
      await seedIntent(svc, L(6), L(10), 'crashed-run');
      const source = new TestSource(CHAIN_RAW);

      await rangeIngest(source, svc, ctx, { from: L(1), to: L(14), ...FAST });

      expect(source.fetches.sort((a, b) => a - b)).toEqual(range(L(1), L(14)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      // The chunk is done, and so is the older intent it covered.
      expect((await intents(svc)).map((i) => [i.start, i.end, i.status])).toEqual([
        [L(1), 9_999_999, 'done'],
        [L(6), L(10), 'done'],
      ]);
    });

    it('waits for the run of an unfinished intent before it deletes', async () => {
      const svc = await freshService();
      await seedIntent(svc, L(1), 9_999_999, 'crashed-run');
      const events = recordEvents(svc);

      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });

      const firstDelete = events.findIndex((e) => e.startsWith('delete:'));
      expect(firstDelete).toBeGreaterThan(-1);
      expect(events.indexOf('quiesce:crashed-run')).toBeGreaterThan(-1);
      expect(events.indexOf('quiesce:crashed-run')).toBeLessThan(firstDelete);
    });

    it('recovers a failed write as the writer documents: quiesce, delete, quiesce, retry under a new runId', async () => {
      const svc = await freshService();
      const events = recordEvents(svc, true);
      const logger = captureLogger();

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, {
        ...FAST,
        from: L(1),
        to: L(14),
        logger,
      });

      expect(result).toEqual({ chunksDone: 1, ledgers: 14 });
      // The rows of the failed attempt were deleted before the retry, and the retry did not reuse the dedup tokens.
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);

      const failedRun = (events.find((e) => e.startsWith('fail:')) as string).replace('fail:', '');
      const firstDelete = events.findIndex((e) => e.startsWith('delete:'));
      const prefix = events[firstDelete].replace('delete:', '');
      const failIndex = events.indexOf(`fail:${failedRun}`);
      const quiesceFailed = events.indexOf(`quiesce:${failedRun}`, failIndex);
      const quiescePrefix = events.indexOf(`quiesce:${prefix}`, firstDelete);
      expect(failIndex).toBeGreaterThan(-1);
      expect(quiesceFailed).toBeGreaterThan(failIndex);
      expect(firstDelete).toBeGreaterThan(quiesceFailed);
      expect(quiescePrefix).toBeGreaterThan(firstDelete);
      // Only after all of that does the retry write, under another runId; the failed run did write its child rows.
      const retried = events.findIndex((e, i) => i > quiescePrefix && e.startsWith(`insert:${Table.Transactions}:`));
      expect(retried).toBeGreaterThan(quiescePrefix);
      expect(events[retried]).not.toBe(`insert:${Table.Transactions}:${failedRun}`);
      expect(events).toContain(`insert:${Table.Transactions}:${failedRun}`);
      // The intent is logged before the first write; the retry's run id only after the failed run was waited for and deleted.
      const firstIntent = events.indexOf(`intent:started:${failedRun}`);
      expect(firstIntent).toBeGreaterThan(-1);
      expect(firstIntent).toBeLessThan(events.findIndex((e) => e.startsWith('insert:')));
      const retryIntent = events.findIndex(
        (e) => e.startsWith('intent:started:') && e !== `intent:started:${failedRun}`,
      );
      expect(retryIntent).toBeGreaterThan(quiescePrefix);
      expect(retryIntent).toBeLessThan(retried);
      expect(events[events.length - 1]).toMatch(/^insert:|^intent:done:/);
      expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
    });

    it('gives up after `maxAttempts` attempts and leaves the chunk as an unfinished intent', async () => {
      const svc = await freshService();
      const insert = svc.insert.bind(svc);
      let attempts = 0;
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) {
          attempts += 1;
          throw new Error('injected: the commit insert always fails');
        }
        return insert(table, rows, opts);
      });

      await expect(
        rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), maxAttempts: 2, ...FAST }),
      ).rejects.toThrow('injected: the commit insert always fails');

      expect(attempts).toBe(2);
      expect(await count(svc, Table.Ledgers)).toBe(0);
      expect((await intents(svc)).map((i) => i.status)).toEqual(['started']);
      jest.restoreAllMocks();

      // The next run redoes the chunk: it deletes what the failed attempts left.
      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });
      expect(result).toEqual({ chunksDone: 1, ledgers: 14 });
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
    });
  });

  describe('reprocess', () => {
    it('reprocess rewrites without duplicates', async () => {
      const svc = await freshService();
      const options = { from: FIXTURE_FROM, to: FIXTURE_TO, indexes: FIXTURE_INDEXES, ...FAST };
      await rangeIngest(new TestSource(FIXTURES), svc, ctx, options);
      const source = new TestSource(FIXTURES);

      const result = await rangeIngest(source, svc, ctx, { ...options, reprocess: true });

      expect(result).toEqual({ chunksDone: 10, ledgers: 54 });
      expect([...source.fetches].sort((a, b) => a - b)).toEqual(FIXTURE_INDEXES);
      // Exact counts straight away, with no OPTIMIZE: the old rows are gone, not merged away later.
      expect(await tableCounts(svc, ALL_TABLES)).toEqual(expectedCounts(FIXTURES, ALL_TABLES));
      await expectNoDuplicateTransactions(svc);
    });

    it('reprocess of a contiguous range rewrites every ledger of it, and only those', async () => {
      const svc = await freshService();
      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(30), ...FAST });
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(5), to: L(20), reprocess: true, ...FAST });

      expect(result.ledgers).toBe(16);
      expect(source.fetches.sort((a, b) => a - b)).toEqual(range(L(5), L(20)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW, CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
    });

    it('does not touch committed ledgers between the listed indexes of a reprocess', async () => {
      const svc = await freshService();
      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });

      // Only L(2) and L(12) are reprocessed: L(3)..L(11) between them must survive the delete.
      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, {
        from: L(1),
        to: L(14),
        indexes: [L(2), L(12)],
        reprocess: true,
        ...FAST,
      });

      expect(result.ledgers).toBe(2);
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(14)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
    });
  });

  describe('replacing a committed chunk', () => {
    /** The first 14 ledgers of the chain, committed. */
    async function committedChunk(): Promise<ClickHouseService> {
      const svc = await freshService();
      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });
      return svc;
    }

    async function expectChunkIntact(svc: ClickHouseService): Promise<void> {
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(14)));
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
    }

    it('reprocess with a ledger missing from the source fails with LedgerNotAvailableError and leaves the committed rows intact', async () => {
      const svc = await committedChunk();
      const source = new TestSource(CHAIN_RAW.filter((l) => l.header.ledger_index !== L(7)));

      await expect(
        rangeIngest(source, svc, ctx, { from: L(1), to: L(14), reprocess: true, ...FAST }),
      ).rejects.toBeInstanceOf(LedgerNotAvailableError);

      expect(source.fetchCount(L(7))).toBe(1);
      await expectChunkIntact(svc);
    });

    it('reprocess with a ledger the parser rejects fails and leaves the committed rows intact', async () => {
      const svc = await committedChunk();
      // L(7) now has a transaction with a Fee that is not a number: buildLedgerRows throws on it.
      const malformed = CHAIN_RAW.map((raw) =>
        raw.header.ledger_index === L(7)
          ? {
              ...raw,
              transactions: raw.transactions.map((t, i) => (i === 0 ? { ...t, tx: { ...t.tx, Fee: 'abc' } } : t)),
            }
          : raw,
      );
      const source = new TestSource(malformed);

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(14), reprocess: true, ...FAST })).rejects.toThrow(
        /invalid Fee "abc"/,
      );

      // A parser error does not go away: no retry, and nothing was deleted or written.
      expect(source.fetchCount(L(7))).toBe(1);
      await expectChunkIntact(svc);
    });

    it('reprocess whose fetches keep failing gives up with the committed rows intact', async () => {
      const svc = await committedChunk();
      const source = new TestSource(CHAIN_RAW);
      source.failures.set(L(7), 100);

      await expect(
        rangeIngest(source, svc, ctx, { from: L(1), to: L(14), reprocess: true, maxAttempts: 3, ...FAST }),
      ).rejects.toThrow(`fetch of ${L(7)} failed`);

      expect(source.fetchCount(L(7))).toBe(3);
      await expectChunkIntact(svc);
    });

    it('redo of an unfinished intent whose ledger the source lacks leaves the committed rows intact, and the intent open', async () => {
      const svc = await committedChunk();
      await seedIntent(svc, L(1), 9_999_999, 'crashed-run');
      const source = new TestSource(CHAIN_RAW.filter((l) => l.header.ledger_index !== L(3)));

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(14), ...FAST })).rejects.toBeInstanceOf(
        LedgerNotAvailableError,
      );

      await expectChunkIntact(svc);
      expect((await intents(svc)).map((i) => i.status)).toEqual(['started']);

      // The node has the ledger again: the open intent is redone.
      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });
      expect(result).toEqual({ chunksDone: 1, ledgers: 14 });
      await expectChunkIntact(svc);
      await expectNoDuplicateTransactions(svc);
      expect((await intents(svc)).map((i) => i.status)).toEqual(['done']);
    });

    it('fetches and parses the replacement before it deletes anything', async () => {
      const svc = await committedChunk();
      const events = recordEvents(svc);
      const source = new TestSource(CHAIN_RAW);
      const fetch = source.fetch.bind(source);
      jest.spyOn(source, 'fetch').mockImplementation(async (index) => {
        events.push(`fetch:${index}`);
        return fetch(index);
      });

      await rangeIngest(source, svc, ctx, { from: L(1), to: L(14), reprocess: true, ...FAST });

      const lastFetch = events.map((e) => e.startsWith('fetch:')).lastIndexOf(true);
      const firstDelete = events.findIndex((e) => e.startsWith('delete:'));
      expect(firstDelete).toBeGreaterThan(-1);
      expect(lastFetch).toBeGreaterThan(-1);
      expect(lastFetch).toBeLessThan(firstDelete);
      await expectChunkIntact(svc);
    });
  });

  describe('run id', () => {
    it('appends a per-invocation nonce to a user supplied run id, so that a reprocess under the same id loses nothing', async () => {
      const svc = await freshService();
      const options = { from: L(1), to: L(14), runId: 'backfill-1', ...FAST };

      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, options);
      const first = (await intents(svc)).map((i) => i.runId);
      // Same runId, after a delete: without the nonce the dedup log of the tables would drop every row of the rewrite.
      await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { ...options, reprocess: true });
      const second = (await intents(svc)).map((i) => i.runId);

      for (const runId of [...first, ...second]) expect(runId).toMatch(/^backfill-1:[0-9a-f-]{8,}$/);
      expect(second[0]).not.toBe(first[0]);
      expect(await count(svc, Table.Ledgers)).toBe(14);
      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 14), CHAIN_TABLES));
      await expectNoDuplicateTransactions(svc);
    });

    it('refuses a run id that looks like a live intent', async () => {
      const svc = await freshService();
      await expect(
        rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), runId: 'live:mine' }),
      ).rejects.toThrow(/live:/);
      expect(await count(svc, Table.IngestLog)).toBe(0);
    });
  });

  describe('live intents (R26)', () => {
    it('ignores the live runner’s intents: never redone, deleted or marked done', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 14));
      // The live runner's first-write intent: key (start, 0), run_id `live:<bootId>`, still open.
      await seedIntent(svc, L(1), 0, 'live:boot-1');
      await seedIntent(svc, L(3), 0, 'live:boot-2');
      // The run id alone marks an intent as the live runner's, whatever its key: this one even overlaps the chunk.
      await seedIntent(svc, L(2), L(9), 'live:boot-3');
      const liveBefore = await svc.query(`SELECT * FROM ${Table.IngestLog} ORDER BY range_start`);
      const source = new TestSource(CHAIN_RAW);

      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(14), ...FAST });

      // Had the live intents counted as unfinished chunks, the committed ledgers would have been redone.
      expect(result).toEqual({ chunksDone: 1, ledgers: 0 });
      expect(source.fetches).toEqual([]);
      expect(
        await svc.query(`SELECT * FROM ${Table.IngestLog} WHERE startsWith(run_id, 'live:') ORDER BY range_start`),
      ).toEqual(liveBefore);
      expect(await count(svc, Table.IngestLog)).toBe(3);
    });

    it('does not mistake a live intent for its own chunk when the chunk starts at the same ledger', async () => {
      const svc = await freshService();
      await seedIntent(svc, L(1), 0, 'live:boot-1');

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });

      expect(result).toEqual({ chunksDone: 1, ledgers: 14 });
      const live = await intents(svc, "startsWith(run_id, 'live:')");
      expect(live).toEqual([{ start: L(1), end: 0, status: 'started', runId: 'live:boot-1' }]);
      expect((await intents(svc, "NOT startsWith(run_id, 'live:')")).map((i) => i.status)).toEqual(['done']);
    });
  });

  describe('a live syncer (R27)', () => {
    it('refuses a range that reaches above the live checkpoint while the lease is fresh', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 10)); // checkpoint L(10)
      await seedLease(svc, 'host:1:abc', 1);
      const source = new TestSource(CHAIN_RAW);

      await expect(rangeIngest(source, svc, ctx, { from: L(5), to: L(30), ...FAST })).rejects.toThrow(
        `Range [${L(5)},${L(30)}] reaches above the live checkpoint ${L(10)} while a live syncer holds the lease (host:1:abc)`,
      );

      expect(source.fetches).toEqual([]);
      expect(await count(svc, Table.IngestLog)).toBe(0);
      expect(await committedIndexes(svc)).toEqual(range(L(1), L(10)));
    });

    it('refuses when nothing is committed yet and the lease is fresh', async () => {
      const svc = await freshService();
      await seedLease(svc, 'host:1:abc', 1);

      await expect(
        rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST }),
      ).rejects.toThrow(/reaches above the live checkpoint .* while a live syncer holds the lease \(host:1:abc\)/);
      expect(await count(svc, Table.Ledgers)).toBe(0);
    });

    it('allows a range at or below the live checkpoint', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 10));
      await seedLease(svc, 'host:1:abc', 1);

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, {
        from: L(1),
        to: L(10),
        reprocess: true,
        ...FAST,
      });

      expect(result).toEqual({ chunksDone: 1, ledgers: 10 });
    });

    it('allows a range above the checkpoint when the lease is stale (older than 30 s on the server clock)', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 10));
      await seedLease(svc, 'host:1:abc', 60);

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(5), to: L(20), ...FAST });

      expect(result.ledgers).toBe(10);
      expect(await committedCheckpoint(svc)).toBe(L(20));
    });

    it('allows a range above the checkpoint when the lease was released', async () => {
      const svc = await freshService();
      await seedLease(svc, 'host:1:abc', 5);
      await svc.command(
        `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl', '', now64(3) + toIntervalSecond(1)`,
      );

      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), ...FAST });

      expect(result.ledgers).toBe(14);
    });

    it('checks again after the fetch: a live syncer that boots while the first chunk is fetched stops the run before it writes', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);
      const fetch = source.fetch.bind(source);
      jest.spyOn(source, 'fetch').mockImplementation(async (index) => {
        if (index === L(1)) await seedLease(svc, 'host:2:def', 0);
        return fetch(index);
      });

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST })).rejects.toThrow(
        /while a live syncer holds the lease \(host:2:def\)/,
      );

      expect(await count(svc, Table.Ledgers)).toBe(0);
      expect((await intents(svc)).map((i) => i.status)).toEqual(['started']);
    });

    it('stops when a live syncer takes the lease in the middle of the run, after the chunks that were finished', async () => {
      const svc = await freshService();
      const source = new TestSource(CHAIN_RAW);
      const fetch = source.fetch.bind(source);
      // The live syncer boots while the second chunk (from 10,000,000) is fetched.
      jest.spyOn(source, 'fetch').mockImplementation(async (index) => {
        if (index === L(15)) await seedLease(svc, 'host:2:def', 0);
        return fetch(index);
      });

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(30), ...FAST })).rejects.toThrow(
        /while a live syncer holds the lease \(host:2:def\)/,
      );

      expect(await committedIndexes(svc)).toEqual(range(L(1), 9_999_999));
    });

    it('keeps the committed ledgers of a chunk it is about to replace when a live syncer appears while it fetches', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(CHAIN_RAW.slice(0, 10)); // checkpoint L(10)
      await seedIntent(svc, L(1), 9_999_999, 'crashed-run'); // the chunk reaches above it: L(11)..L(14) are still to come
      const source = new TestSource(CHAIN_RAW);
      const fetch = source.fetch.bind(source);
      jest.spyOn(source, 'fetch').mockImplementation(async (index) => {
        if (index === L(1)) await seedLease(svc, 'host:2:def', 0);
        return fetch(index);
      });

      await expect(rangeIngest(source, svc, ctx, { from: L(1), to: L(14), ...FAST })).rejects.toThrow(
        /while a live syncer holds the lease \(host:2:def\)/,
      );

      expect(await tableCounts(svc, CHAIN_TABLES)).toEqual(expectedCounts(CHAIN_RAW.slice(0, 10), CHAIN_TABLES));
    });
  });

  describe('agg_dirty', () => {
    it('writes agg_dirty', async () => {
      const svc = await freshService();

      await rangeIngest(new TestSource(FIXTURES), svc, ctx, {
        from: FIXTURE_FROM,
        to: FIXTURE_TO,
        indexes: FIXTURE_INDEXES,
        ...FAST,
      });

      // One row per chunk, from the start of the hour of its earliest ledger to the end of the hour of its latest.
      const buckets = new Map<number, number[]>();
      for (const l of FIXTURES) {
        const bucket = Math.floor(l.header.ledger_index / 1000);
        buckets.set(bucket, [...(buckets.get(bucket) ?? []), l.header.close_time]);
      }
      const expected = [...buckets.values()].map((closes): [number, number] => [
        hourFloor(Math.min(...closes)),
        hourFloor(Math.max(...closes)) + 3600,
      ]);
      const distinct = [...new Map(expected.map((w) => [w.join('-'), w])).values()].sort(
        (a, b) => a[0] - b[0] || a[1] - b[1],
      );
      expect(await dirtyWindows(svc)).toEqual(distinct);
      for (const [from, to] of distinct) {
        expect(from % 3600).toBe(0);
        expect(to % 3600).toBe(0);
      }
      // created_at is a DateTime64(3) written as fractional seconds: a ms integer would land in the year 50000+.
      const created = await svc.queryOne<{ lo: number; hi: number }>(
        `SELECT toUnixTimestamp(min(created_at)) AS lo, toUnixTimestamp(max(created_at)) AS hi FROM ${Table.AggDirty}`,
      );
      expect(Math.abs(Number(created?.lo) - Date.now() / 1000)).toBeLessThan(120);
      expect(Math.abs(Number(created?.hi) - Date.now() / 1000)).toBeLessThan(120);

      // Together they cover what the `ledgers` table says about the ingested ledgers.
      const stored = await svc.queryOne<{ lo: number; hi: number }>(
        `SELECT toUnixTimestamp(min(close_time)) AS lo, toUnixTimestamp(max(close_time)) AS hi FROM ${Table.Ledgers}`,
      );
      expect(distinct[0][0]).toBe(hourFloor(Number(stored?.lo)));
      expect(distinct[distinct.length - 1][1]).toBe(hourFloor(Number(stored?.hi)) + 3600);
    });

    it('covers a range that ends exactly on an hour boundary', async () => {
      const svc = await freshService();
      const onTheHour = hourFloor(CHAIN_RAW[0].header.close_time) + 3600;
      // Same ledgers, the last one closing exactly on the hour (the ledger's close time is not part of its hash here).
      const ledgers = CHAIN_RAW.slice(0, 3).map((raw, i) => ({
        ...raw,
        header: { ...raw.header, close_time: onTheHour - 20 + i * 10 },
      }));
      expect(ledgers[2].header.close_time).toBe(onTheHour);

      await rangeIngest(new TestSource(ledgers), svc, ctx, { from: L(1), to: L(3), ...FAST });

      const row = await svc.queryOne<{ f: number; t: number }>(
        `SELECT toUnixTimestamp(from_hour) AS f, toUnixTimestamp(to_hour) AS t FROM ${Table.AggDirty}`,
      );
      expect(Number(row?.f)).toBe(onTheHour - 3600);
      // The ledger closed at hh:00:00 belongs to the next hour, which must be inside the window.
      expect(Number(row?.t)).toBe(onTheHour + 3600);
    });

    /** The chain with every ledger in an hour of its own, so that each chunk has a window of its own. */
    const T0 = hourFloor(CHAIN_RAW[0].header.close_time);
    const HOURLY = CHAIN_RAW.map((raw, i) => ({ ...raw, header: { ...raw.header, close_time: T0 + i * 3600 + 5 } }));
    const hours = (n: number): number => T0 + n * 3600;

    it('marks a chunk right after it is done: a run aborted on chunk 3 has marked chunks 1 and 2, and a rerun that skips them marks them again', async () => {
      const svc = await freshService();
      // Chunks of 10: L(1)..L(4), L(5)..L(14), L(15)..L(24), L(25)..L(30). The node lacks a ledger of the third.
      const lacking = new TestSource(HOURLY.filter((l) => l.header.ledger_index !== L(20)));

      await expect(
        rangeIngest(lacking, svc, ctx, { from: L(1), to: L(30), chunkSize: 10, ...FAST }),
      ).rejects.toBeInstanceOf(LedgerNotAvailableError);

      expect(await committedIndexes(svc)).toEqual(range(L(1), L(14)));
      expect(await dirtyWindows(svc)).toEqual([
        [hours(0), hours(4)],
        [hours(4), hours(14)],
      ]);

      // A run killed before it marked anything (or before the fix): the marks are gone, the ledgers are committed.
      await svc.command(`TRUNCATE TABLE ${Table.AggDirty}`);
      const source = new TestSource(HOURLY);
      const result = await rangeIngest(source, svc, ctx, { from: L(1), to: L(30), chunkSize: 10, ...FAST });

      expect(result).toEqual({ chunksDone: 4, ledgers: 16 });
      expect(source.fetches.sort((a, b) => a - b)).toEqual(range(L(15), L(30)));
      expect(await dirtyWindows(svc)).toEqual([
        [hours(0), hours(14)], // the skipped chunks 1 and 2, read from `ledgers`
        [hours(14), hours(24)],
        [hours(24), hours(30)],
      ]);
    });

    it('marks the skipped ledgers also when the run fails', async () => {
      const svc = await freshService();
      await rangeIngest(new TestSource(HOURLY), svc, ctx, { from: L(1), to: L(14), chunkSize: 10, ...FAST });
      await svc.command(`TRUNCATE TABLE ${Table.AggDirty}`);
      const lacking = new TestSource(HOURLY.filter((l) => l.header.ledger_index !== L(20)));

      await expect(
        rangeIngest(lacking, svc, ctx, { from: L(1), to: L(30), chunkSize: 10, ...FAST }),
      ).rejects.toBeInstanceOf(LedgerNotAvailableError);

      expect(await dirtyWindows(svc)).toEqual([[hours(0), hours(14)]]);
    });
  });

  describe('options', () => {
    it.each([
      [700, /chunkSize.*1000000/],
      [0, /chunkSize/],
      [-1000, /chunkSize/],
      [2_000_000, /chunkSize.*1000000/],
      [1000.5, /chunkSize/],
      [Number.NaN, /chunkSize/],
    ])('refuses chunkSize %p: it must be a positive integer that divides 1,000,000', async (chunkSize, message) => {
      const svc = await freshService();
      await expect(
        rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, { from: L(1), to: L(14), chunkSize }),
      ).rejects.toThrow(message);
      expect(await count(svc, Table.IngestLog)).toBe(0);
    });

    it.each([1, 10, 1000, 8, 1_000_000])('accepts chunkSize %p', async (chunkSize) => {
      const svc = await freshService();
      const result = await rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, {
        from: L(1),
        to: L(3),
        chunkSize,
        ...FAST,
      });
      expect(result.ledgers).toBe(3);
    });

    it.each([
      [{ from: 20, to: 10 }, /range/i],
      [{ from: 0, to: 10 }, /range/i],
      [{ from: 1.5, to: 10 }, /range/i],
      [{ from: 1, to: 2 ** 32 }, /range/i],
      [{ from: 1, to: 10, concurrency: 0 }, /concurrency/],
      [{ from: 1, to: 10, concurrency: 1.5 }, /concurrency/],
      [{ from: 1, to: 10, maxAttempts: 0 }, /maxAttempts/],
      [{ from: 1, to: 10, runId: '' }, /runId/],
    ] as Array<[RangeIngestOptions, RegExp]>)('refuses the options %j', async (opts, message) => {
      const svc = await freshService();
      await expect(rangeIngest(new TestSource(CHAIN_RAW), svc, ctx, opts)).rejects.toThrow(message);
    });

    it('is a no-op for an index list with nothing inside [from, to]', async () => {
      const svc = await freshService();
      const source = new TestSource(FIXTURES);

      const result = await rangeIngest(source, svc, ctx, { from: 5, to: 10, indexes: FIXTURE_INDEXES, ...FAST });

      expect(result).toEqual({ chunksDone: 0, ledgers: 0 });
      expect(source.fetches).toEqual([]);
      expect(await count(svc, Table.AggDirty)).toBe(0);
    });
  });
});

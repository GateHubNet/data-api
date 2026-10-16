import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows, CHILD_TABLES, LedgerParseError, LedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import {
  awaitQuiescence,
  committedCheckpoint,
  deleteLedgerRange,
  deleteLedgersAbove,
  LEDGER_KEYED_TABLES,
  missingLedgers,
  storedLedgerHash,
} from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { RawLedger } from '../src/ingest/raw-ledger';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const LEDGERS: RawLedger[] = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const BUILT = LEDGERS.map((raw) => buildLedgerRows(raw, ctx));

/** The fixture ledgers are sparse and spread over several partitions: P6 1, 2, 11, 20, 29 and P7 0, 1, 2. */
const index = (i: number): number => LEDGERS[i].header.ledger_index;

const ALL_TABLES: Table[] = LEDGER_KEYED_TABLES.map((t) => t.table);

type Counts = Record<string, number>;

/** What the tables hold when exactly the ledgers matching `keep` were written, from the rows `buildLedgerRows` makes. */
function expectedCounts(keep: (ledgerIndex: number) => boolean = () => true): Counts {
  const counts: Counts = Object.fromEntries(ALL_TABLES.map((t) => [t, 0]));
  for (const rows of BUILT) {
    if (!keep(rows.ledger.ledger_index)) continue;
    counts[Table.Ledgers] += 1;
    counts[Table.LedgerByHash] += 1;
    for (const [table, key] of CHILD_TABLES) counts[table] += (rows[key] as unknown[]).length;
  }
  return counts;
}

describe('LedgerWriter and ingest state (e2e)', () => {
  let ch: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    ch = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await ch?.container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A migrated database of its own, so a test never sees another test's rows or dedup log. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...ch.config, database: `lw_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const count = async (svc: ClickHouseService, table: Table | string, where = '1'): Promise<number> =>
    Number((await svc.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${table} WHERE ${where}`))?.n);

  /** Ids of the running queries that belong to `prefix`. */
  async function runningQueryIds(svc: ClickHouseService, prefix: string): Promise<string[]> {
    const rows = await svc.query<{ query_id: string }>(
      'SELECT query_id FROM system.processes WHERE startsWith(query_id, {prefix:String})',
      { prefix },
    );
    return rows.map((r) => r.query_id);
  }

  /** Poll `check` until it is true; false when it never is within `timeoutMs`. */
  async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async function storedCounts(svc: ClickHouseService): Promise<Counts> {
    return Object.fromEntries(await Promise.all(ALL_TABLES.map(async (t) => [t, await count(svc, t)] as const)));
  }

  const rowsAbove = async (svc: ClickHouseService, cp: number): Promise<Counts> =>
    Object.fromEntries(
      await Promise.all(ALL_TABLES.map(async (t) => [t, await count(svc, t, `ledger_index > ${cp}`)] as const)),
    );

  /** Insert the child rows and `ledger_by_hash` of ledgers, but not their `ledgers` row: a write that died before it. */
  async function insertUncommitted(svc: ClickHouseService, rows: LedgerRows[]): Promise<void> {
    for (const [table, key] of CHILD_TABLES)
      await svc.insert(
        table,
        rows.flatMap((r) => r[key] as unknown[]),
      );
    await svc.insert(
      Table.LedgerByHash,
      rows.map((r) => r.ledgerByHash),
    );
  }

  describe('write', () => {
    it('writes all fixtures and commit counts match', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      expect(await count(svc, Table.Ledgers)).toBe(54);
      expect(await count(svc, Table.Payments)).toBe(182);
      expect(await storedCounts(svc)).toEqual(expectedCounts());
      expect(await committedCheckpoint(svc)).toBe(index(53));
      expect(await storedLedgerHash(svc, index(7))).toBe(LEDGERS[7].header.ledger_hash);
      expect(await storedLedgerHash(svc, 1)).toBeUndefined();
    });

    it('commits the same rows when the ledgers arrive in several batches of one writer', async () => {
      const svc = await freshService();
      const writer = new LedgerWriter(svc, ctx);
      for (let i = 0; i < LEDGERS.length; i += 10) await writer.write(LEDGERS.slice(i, i + 10));

      expect(await storedCounts(svc)).toEqual(expectedCounts());
    });

    it('re-writing the same ledgers with a new runId duplicates rows until a merge: recovery must delete, not rely on dedup', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      expect(await count(svc, Table.Payments)).toBe(364);
      expect(await count(svc, Table.Ledgers)).toBe(108);

      const expected = expectedCounts();
      for (const table of ALL_TABLES) {
        await svc.command(`OPTIMIZE TABLE ${table} FINAL`);
        const key = (
          await svc.queryOne<{ sorting_key: string }>(
            'SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {t:String}',
            { t: table },
          )
        )?.sorting_key;
        const row = await svc.queryOne<{ n: string | number; u: string | number }>(
          `SELECT count() AS n, uniqExact(${key}) AS u FROM ${table}`,
        );
        expect([table, Number(row?.n), Number(row?.u)]).toEqual([table, expected[table], expected[table]]);
      }
    });

    it('same runId retry is deduplicated', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx, { runId: 'retry-run' }).write(LEDGERS);
      await new LedgerWriter(svc, ctx, { runId: 'retry-run' }).write(LEDGERS);

      expect(await count(svc, Table.Payments)).toBe(182);
      expect(await storedCounts(svc)).toEqual(expectedCounts());
    });

    it('chunks inserts above maxRowsPerInsert, with a token per chunk, children first and the commit marker last', async () => {
      const svc = await freshService();
      const events: string[] = [];
      const calls: Array<{ table: string; rows: number; token: string | undefined }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        events.push(`start:${table}`);
        calls.push({ table, rows: rows.length, token: opts?.dedupToken });
        await real(table, rows, opts);
        events.push(`end:${table}`);
      });

      const writer = new LedgerWriter(svc, ctx, { runId: 'run-x', maxRowsPerInsert: 100 });
      await writer.write(LEDGERS);

      const first = index(0);
      const last = index(53);
      const transactions = calls.filter((c) => c.table === Table.Transactions);
      expect(transactions.length).toBeGreaterThan(1);
      expect(transactions).toHaveLength(Math.ceil(933 / 100));
      expect(transactions.every((c) => c.rows <= 100)).toBe(true);
      expect(transactions.map((c) => c.rows).reduce((a, b) => a + b, 0)).toBe(933);
      expect(transactions.map((c) => c.token)).toEqual(
        transactions.map((_, n) => `run-x:transactions:${first}-${last}:${n}`),
      );
      // Every token of the run is distinct.
      const tokens = calls.map((c) => c.token);
      expect(new Set(tokens).size).toBe(tokens.length);

      // The 12 child tables start together, before any of them has finished.
      const childTables = new Set<string>(CHILD_TABLES.map(([t]) => t));
      const firstStarts = events.slice(0, childTables.size);
      expect(new Set(firstStarts)).toEqual(new Set([...childTables].map((t) => `start:${t}`)));

      const lastChildEnd = Math.max(
        ...events.map((e, i) => (e.startsWith('end:') && childTables.has(e.slice(4)) ? i : -1)),
      );
      const byHashStart = events.indexOf(`start:${Table.LedgerByHash}`);
      const byHashEnd = events.indexOf(`end:${Table.LedgerByHash}`);
      const ledgersStart = events.indexOf(`start:${Table.Ledgers}`);
      expect(byHashStart).toBeGreaterThan(lastChildEnd);
      expect(ledgersStart).toBeGreaterThan(byHashEnd);
      expect(events[events.length - 1]).toBe(`end:${Table.Ledgers}`);
      expect(events.filter((e) => e === `start:${Table.Ledgers}`)).toHaveLength(1);

      expect(await storedCounts(svc)).toEqual(expectedCounts());
    });

    it('skips tables that have no rows, but still commits the ledger', async () => {
      const svc = await freshService();
      const empty: RawLedger = { header: LEDGERS[0].header, transactions: [] };
      const spy = jest.spyOn(svc, 'insert');

      await new LedgerWriter(svc, ctx).write([empty]);

      expect(spy.mock.calls.map((c) => c[0])).toEqual([Table.LedgerByHash, Table.Ledgers]);
      expect(await count(svc, Table.Ledgers)).toBe(1);
    });

    it('fails with a LedgerParseError naming the ledger before it inserts anything (ruling R96)', async () => {
      const svc = await freshService();
      const spy = jest.spyOn(svc, 'insert');
      const bad = index(5);
      const ledgers = LEDGERS.slice(0, 10).map((raw) =>
        raw.header.ledger_index === bad
          ? {
              ...raw,
              transactions: raw.transactions.map((t, i) => (i === 0 ? { ...t, tx: { ...t.tx, Fee: 'x' } } : t)),
            }
          : raw,
      );
      expect(LEDGERS[5].transactions.length).toBeGreaterThan(0);

      await expect(new LedgerWriter(svc, ctx).write(ledgers)).rejects.toMatchObject({
        name: 'LedgerParseError',
        ledgerIndex: bad,
      });
      await expect(new LedgerWriter(svc, ctx).write(ledgers)).rejects.toBeInstanceOf(LedgerParseError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('writing no ledgers does nothing', async () => {
      const svc = await freshService();
      const spy = jest.spyOn(svc, 'insert');
      await new LedgerWriter(svc, ctx).write([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects an invalid maxRowsPerInsert', async () => {
      const svc = await freshService();
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new LedgerWriter(svc, ctx, { maxRowsPerInsert: bad })).toThrow(/maxRowsPerInsert/);
      }
    });

    it('commits the ledgers rows in ascending order, in one insert unless the batch exceeds maxRowsPerInsert', async () => {
      const svc = await freshService();
      const ledgerInserts: Array<{ indexes: number[]; token: string | undefined }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) {
          ledgerInserts.push({
            indexes: (rows as Array<{ ledger_index: number }>).map((r) => r.ledger_index),
            token: opts?.dedupToken,
          });
        }
        await real(table, rows, opts);
      });
      // Handed over out of order.
      const shuffled = [LEDGERS[3], LEDGERS[1], LEDGERS[2], LEDGERS[0]];
      const sorted = [0, 1, 2, 3].map(index);

      await new LedgerWriter(svc, ctx, { runId: 'asc' }).write(shuffled);
      expect(ledgerInserts).toEqual([{ indexes: sorted, token: `asc:ledgers:${sorted[0]}-${sorted[3]}:0` }]);

      ledgerInserts.length = 0;
      await new LedgerWriter(svc, ctx, { runId: 'asc2', maxRowsPerInsert: 3 }).write(shuffled);
      expect(ledgerInserts).toEqual([
        { indexes: sorted.slice(0, 3), token: `asc2:ledgers:${sorted[0]}-${sorted[3]}:0` },
        { indexes: sorted.slice(3), token: `asc2:ledgers:${sorted[0]}-${sorted[3]}:1` },
      ]);
    });

    it('waits for every in-flight child insert before it throws, and then writes no commit marker', async () => {
      const svc = await freshService();
      let inFlight = 0;
      const attempted: string[] = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        attempted.push(table);
        inFlight += 1;
        try {
          if (table === Table.TxByType) throw new Error('boom');
          await real(table, rows, opts);
        } finally {
          inFlight -= 1;
        }
      });

      await expect(new LedgerWriter(svc, ctx).write(LEDGERS)).rejects.toThrow('boom');

      expect(inFlight).toBe(0);
      expect(attempted).not.toContain(Table.LedgerByHash);
      expect(attempted).not.toContain(Table.Ledgers);
      expect(await count(svc, Table.Ledgers)).toBe(0);
    });
  });

  describe('committedCheckpoint, storedLedgerHash and missingLedgers', () => {
    it('are empty on an empty database', async () => {
      const svc = await freshService();
      expect(await committedCheckpoint(svc)).toBeUndefined();
      expect(await storedLedgerHash(svc, 123)).toBeUndefined();
      expect(await missingLedgers(svc, 5, 8)).toEqual([5, 6, 7, 8]);
    });

    it('missingLedgers finds the gaps in a sparse set', async () => {
      const svc = await freshService();
      const lo = 11_119_599;
      const hi = 11_119_615;
      const present = LEDGERS.filter((l) => l.header.ledger_index >= lo && l.header.ledger_index <= hi);
      await new LedgerWriter(svc, ctx).write(present);

      const have = new Set(present.map((l) => l.header.ledger_index));
      const gaps: number[] = [];
      for (let i = lo; i <= hi; i++) if (!have.has(i)) gaps.push(i);
      expect(gaps).toEqual([11_119_605, 11_119_606]);

      expect(await missingLedgers(svc, lo, hi)).toEqual(gaps);
      // Bounds are inclusive and a range can stick out on both sides.
      expect(await missingLedgers(svc, 11_119_605, 11_119_606)).toEqual(gaps);
      expect(await missingLedgers(svc, 11_119_598, 11_119_600)).toEqual([11_119_598]);
      expect(await missingLedgers(svc, 11_119_615, 11_119_617)).toEqual([11_119_616, 11_119_617]);
      expect(await missingLedgers(svc, 11_119_600, 11_119_600)).toEqual([]);
      expect(await missingLedgers(svc, 9, 7)).toEqual([]);
    });

    it('only a ledgers row counts as present: the child rows of an uncommitted ledger do not', async () => {
      const svc = await freshService();
      await insertUncommitted(svc, [BUILT[0]]);
      expect(await committedCheckpoint(svc)).toBeUndefined();
      expect(await missingLedgers(svc, index(0), index(0))).toEqual([index(0)]);
    });

    it('rejects arguments that are not UInt32 integers', async () => {
      const svc = await freshService();
      await expect(missingLedgers(svc, -1, 5)).rejects.toThrow(/invalid ledger range start/i);
      await expect(missingLedgers(svc, 1, 2 ** 32)).rejects.toThrow(/invalid ledger range end/i);
      await expect(storedLedgerHash(svc, 1.5)).rejects.toThrow(/invalid ledger index/i);
      await expect(deleteLedgersAbove(svc, Number.NaN)).rejects.toThrow(/invalid checkpoint/i);
      await expect(deleteLedgerRange(svc, 5, 4)).rejects.toThrow(/invalid ledger range 5-4/i);
    });
  });

  describe('deleteLedgersAbove', () => {
    it('removes the child rows of uncommitted ledgers from every ledger-keyed table, and nothing else', async () => {
      const svc = await freshService();
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));
      await insertUncommitted(svc, BUILT.slice(committed));
      // A table that is not keyed by ledger must survive.
      await svc.insert(Table.FeeStats, [
        {
          ts: 1_700_000_000.123,
          current_ledger_size: 1,
          expected_ledger_size: 2,
          current_queue_size: 3,
          max_queue_size: 4,
          pct_max_queue_size: 0.5,
          median_fee: '10',
          minimum_fee: '10',
          open_ledger_fee: '10',
        },
      ]);

      const cp = await committedCheckpoint(svc);
      expect(cp).toBe(index(committed - 1));
      const before = await rowsAbove(svc, cp!);
      // The uncommitted ledgers put rows into every child table and ledger_by_hash, over several partitions.
      for (const table of ALL_TABLES) {
        if (table === Table.Ledgers) expect(before[table]).toBe(0);
        else expect([table, before[table] > 0]).toEqual([table, true]);
      }

      const commands: string[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        commands.push(sql);
        await real(sql, params, opts);
      });
      await deleteLedgersAbove(svc, cp!);

      const after = await rowsAbove(svc, cp!);
      expect(after).toEqual(Object.fromEntries(ALL_TABLES.map((t) => [t, 0])));
      expect(await storedCounts(svc)).toEqual(expectedCounts((i) => i <= cp!));
      expect(await count(svc, Table.FeeStats)).toBe(1);

      // The DELETEs hit exactly the ledger-keyed tables, partition by partition where the table is partitioned.
      const hit = commands.map((c) => /^\s*DELETE FROM (\w+)/.exec(c)?.[1]);
      expect(hit.every((t) => t !== undefined)).toBe(true);
      expect(new Set(hit)).toEqual(new Set(ALL_TABLES));
      for (const sql of commands) {
        const table = /^\s*DELETE FROM (\w+)/.exec(sql)![1];
        const partitioned = LEDGER_KEYED_TABLES.find((t) => t.table === table)!.partitionSize !== undefined;
        expect(sql.includes('IN PARTITION')).toBe(partitioned);
      }
    });

    it('does not touch partitions at or below the checkpoint partition, only the partitions above it', async () => {
      const svc = await freshService();
      // cp is the 40th ledger, in P6 partition 11 / P7 partition 1: partitions 1 and 2 (P6) and 0 (P7) are older.
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));
      await insertUncommitted(svc, BUILT.slice(committed));

      const params: unknown[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, p, opts) => {
        if (/IN PARTITION/.test(sql)) params.push({ sql, ...p });
        await real(sql, p, opts);
      });
      await deleteLedgersAbove(svc, index(committed - 1));

      const partitionsOf = (table: string): number[] =>
        (params as Array<{ sql: string; partition: string }>)
          .filter((p) => new RegExp(`DELETE FROM ${table} `).test(p.sql))
          .map((p) => Number(p.partition))
          .sort((a, b) => a - b);
      expect(partitionsOf(Table.Transactions)).toEqual([11, 20, 29]);
      // Ledger 20,005,122 has transactions but no payment, so payments has no partition 20.
      expect(partitionsOf(Table.Payments)).toEqual([11, 29]);
      expect(partitionsOf(Table.TxByHash)).toEqual([1, 2]);
    });

    it('is a no-op on committed data when nothing is above the checkpoint', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      await deleteLedgersAbove(svc, index(53));
      expect(await storedCounts(svc)).toEqual(expectedCounts());
    });

    it('cleans up a failed write so a new LedgerWriter can redo it without duplicates', async () => {
      const svc = await freshService();
      const committed = 40;
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, committed));

      // The commit marker fails: children and ledger_by_hash are in, the ledgers rows are not.
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(new LedgerWriter(svc, ctx).write(LEDGERS.slice(committed))).rejects.toThrow('commit failed');
      failing.mockRestore();

      const cp = await committedCheckpoint(svc);
      expect(cp).toBe(index(committed - 1));
      expect((await storedCounts(svc))[Table.Payments]).toBe(expectedCounts()[Table.Payments]);
      expect(await missingLedgers(svc, index(committed), index(committed))).toEqual([index(committed)]);

      await deleteLedgersAbove(svc, cp!);
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(committed));

      expect(await storedCounts(svc)).toEqual(expectedCounts());
      expect(await committedCheckpoint(svc)).toBe(index(53));
    });

    it('documents the dedup pitfall: a writer that outlives the delete has its child rows dropped, so recovery needs a new LedgerWriter', async () => {
      const svc = await freshService();
      const survivor = new LedgerWriter(svc, ctx, { runId: 'survivor' });
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(survivor.write(LEDGERS)).rejects.toThrow('commit failed');
      failing.mockRestore();

      await deleteLedgersAbove(svc, 0);
      expect(await count(svc, Table.Payments)).toBe(0);

      // The dedup log still remembers the tokens of the first attempt, so the same writer re-inserts nothing but the
      // commit marker: ledgers claim to be committed, their rows are gone.
      await survivor.write(LEDGERS);
      expect(await count(svc, Table.Ledgers)).toBe(54);
      expect(await count(svc, Table.Payments)).toBe(0);
    });
  });

  describe('withNewRunId', () => {
    it('returns a writer with a fresh runId (or the given one) and the same limits', async () => {
      const svc = await freshService();
      const writer = new LedgerWriter(svc, ctx, { runId: 'first', maxRowsPerInsert: 100 });

      const rotated = writer.withNewRunId();
      expect(rotated).not.toBe(writer);
      expect(rotated.runId).not.toBe('first');
      expect(rotated.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(writer.withNewRunId('given').runId).toBe('given');
      expect(writer.runId).toBe('first');

      const spy = jest.spyOn(svc, 'insert');
      await rotated.write(LEDGERS);
      expect(spy.mock.calls.filter((c) => c[0] === Table.Transactions)).toHaveLength(Math.ceil(933 / 100));
    });

    it('lets a writer that failed rewrite after deleteLedgersAbove without losing its child rows', async () => {
      const svc = await freshService();
      const failedWriter = new LedgerWriter(svc, ctx, { runId: 'failed-run' });
      const real = svc.insert.bind(svc);
      const failing = jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        if (table === Table.Ledgers) throw new Error('commit failed');
        await real(table, rows, opts);
      });
      await expect(failedWriter.write(LEDGERS)).rejects.toThrow('commit failed');
      failing.mockRestore();

      await deleteLedgersAbove(svc, 0);
      expect(await count(svc, Table.Payments)).toBe(0);

      await failedWriter.withNewRunId().write(LEDGERS);

      expect(await storedCounts(svc)).toEqual(expectedCounts());
      expect(await count(svc, Table.Payments)).toBe(182);
    });
  });

  describe('deleteLedgerRange', () => {
    it('deletes the ledgers in [from, to] from every ledger-keyed table, across partitions, and keeps the rest', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      // P6 partitions 2, 11 and 20 and P7 partitions 0, 1 and 2 are touched; the first and the last two ledgers stay.
      const from = index(1);
      const to = index(51);
      expect(to).toBe(20_005_122);
      await deleteLedgerRange(svc, from, to);

      expect(await storedCounts(svc)).toEqual(expectedCounts((i) => i < from || i > to));
      expect(await committedCheckpoint(svc)).toBe(index(53));
    });

    it('deletes a range that sits inside a partition and leaves the neighbours in it', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      await deleteLedgerRange(svc, 11_119_600, 11_119_604);

      expect(await storedCounts(svc)).toEqual(expectedCounts((i) => i < 11_119_600 || i > 11_119_604));
    });

    it('lets a ledger range be rewritten by a new writer without duplicates', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      await deleteLedgerRange(svc, index(10), index(20));
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(10, 21));

      expect(await storedCounts(svc)).toEqual(expectedCounts());
    });

    it('removes the commit marker first: a range delete never leaves a ledgers row without its rows', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);

      const order: string[] = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        order.push(/^\s*DELETE FROM (\w+)/.exec(sql)?.[1] ?? sql);
        await real(sql, params, opts);
      });
      await deleteLedgerRange(svc, index(0), index(53));

      expect(order[0]).toBe(Table.Ledgers);
    });
  });

  describe('query ids', () => {
    /** Finished queries with an id under `prefix`, from the query log. */
    async function loggedQueries(svc: ClickHouseService, prefix: string): Promise<string[]> {
      await svc.command('SYSTEM FLUSH LOGS');
      const rows = await svc.query<{ query_id: string }>(
        `SELECT query_id FROM system.query_log
          WHERE type = 'QueryFinish' AND startsWith(query_id, {prefix:String}) ORDER BY query_id`,
        { prefix },
      );
      return rows.map((r) => r.query_id);
    }

    it('LedgerWriter sends every insert with the dedup token as its query_id', async () => {
      const svc = await freshService();
      const seen: Array<{ table: string; queryId?: string; dedupToken?: string }> = [];
      const real = svc.insert.bind(svc);
      jest.spyOn(svc, 'insert').mockImplementation(async (table, rows, opts) => {
        seen.push({ table, queryId: opts?.queryId, dedupToken: opts?.dedupToken });
        await real(table, rows, opts);
      });

      await new LedgerWriter(svc, ctx, { runId: 'qid-run', maxRowsPerInsert: 100 }).write(LEDGERS);

      expect(seen.length).toBeGreaterThan(CHILD_TABLES.length);
      for (const call of seen) {
        expect(call.queryId).toBe(call.dedupToken);
        expect(call.queryId).toMatch(new RegExp(`^qid-run:${call.table}:${index(0)}-${index(53)}:\\d+$`));
      }
      // The server saw them: one finished INSERT per call, under the runId.
      jest.restoreAllMocks();
      const logged = (await loggedQueries(svc, 'qid-run:')).sort();
      expect(logged).toEqual(seen.map((c) => c.queryId!).sort());
    });

    it('an insert with a query_id shows up in system.processes while it runs', async () => {
      const svc = await freshService();
      // A column whose default sleeps makes a real INSERT slow enough to catch.
      await svc.command(
        'CREATE TABLE slow_insert (a UInt8, b UInt8 DEFAULT toUInt8(sleepEachRow(0.4))) ENGINE = Memory',
      );

      const running = svc.insert('slow_insert', [{ a: 1 }, { a: 2 }, { a: 3 }], { queryId: 'live:insert:1' });
      const seen = await eventually(async () => (await runningQueryIds(svc, 'live:')).length > 0);
      await running;

      expect(seen).toBe(true);
      expect(await runningQueryIds(svc, 'live:')).toEqual([]);
      expect(await count(svc, 'slow_insert')).toBe(3);
    });

    it('deleteLedgersAbove and deleteLedgerRange tag each statement and make the lightweight delete synchronous', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS);
      const calls: Array<{ sql: string; queryId?: string; sync?: unknown }> = [];
      const real = svc.command.bind(svc);
      jest.spyOn(svc, 'command').mockImplementation(async (sql, params, opts) => {
        calls.push({ sql, queryId: opts?.queryId, sync: opts?.settings?.lightweight_deletes_sync });
        await real(sql, params, opts);
      });

      await deleteLedgersAbove(svc, index(39), { queryIdPrefix: 'tagged-above' });
      await deleteLedgerRange(svc, index(0), index(10), { queryIdPrefix: 'tagged-range' });
      await deleteLedgerRange(svc, index(11), index(12));

      const deletes = calls.filter((c) => /^\s*DELETE FROM/.test(c.sql));
      expect(deletes.every((c) => c.sync === '2')).toBe(true);

      const ids = (prefix: string) => deletes.filter((c) => c.queryId?.startsWith(prefix)).map((c) => c.queryId!);
      for (const id of [...ids('tagged-above'), ...ids('tagged-range')]) {
        expect(id).toMatch(/^tagged-(above|range):delete:[a-z_]+:(\d+|all)$/);
      }
      expect(new Set(ids('tagged-above').map((id) => id.split(':')[2]))).toEqual(new Set(ALL_TABLES));
      expect(ids('tagged-above').find((id) => id.startsWith('tagged-above:delete:accounts_created:'))).toBe(
        'tagged-above:delete:accounts_created:all',
      );
      expect(ids('tagged-above')).toContain('tagged-above:delete:transactions:11');
      expect(new Set(ids('tagged-above')).size).toBe(ids('tagged-above').length);
      // Without a prefix there is no query_id.
      expect(
        deletes.slice(ids('tagged-above').length + ids('tagged-range').length).every((c) => c.queryId === undefined),
      ).toBe(true);

      // And the server ran exactly those statements under those ids.
      expect(await loggedQueries(svc, 'tagged-above:delete:')).toEqual(ids('tagged-above').sort());
    });
  });

  describe('awaitQuiescence', () => {
    /** Start a query that sleeps for about `seconds`, under a query_id, without waiting for it. */
    const sleeper = (svc: ClickHouseService, queryId: string, seconds: number): Promise<void> =>
      svc.raw
        .command({
          query: `SELECT sleepEachRow(0.25) FROM numbers(${Math.round(seconds * 4)}) SETTINGS max_block_size = 1`,
          query_id: queryId,
        })
        .then(() => undefined);

    it('returns immediately when nothing matches', async () => {
      const svc = await freshService();
      const started = Date.now();
      await awaitQuiescence(svc, 'nobody-runs-this', { pollMs: 5000, timeoutMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('waits for a long-running query with the prefix', async () => {
      const svc = await freshService();
      let done = false;
      const slow = sleeper(svc, 'quiet-run:slow:1', 1.5).then(() => {
        done = true;
      });
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-run')).length > 0)).toBe(true);

      await awaitQuiescence(svc, 'quiet-run', { pollMs: 50, timeoutMs: 20_000 });

      expect(done).toBe(true);
      await slow;
    });

    it('matches the prefix as a whole id part: a sibling runId is neither awaited nor killed', async () => {
      const svc = await freshService();
      const sibling = sleeper(svc, 'quiet-run2:slow:1', 1.5);
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-run2')).length > 0)).toBe(true);

      const started = Date.now();
      await awaitQuiescence(svc, 'quiet-run', { pollMs: 50, timeoutMs: 300 });

      expect(Date.now() - started).toBeLessThan(1000);
      await expect(sibling).resolves.toBeUndefined();
    });

    it('kills the queries that are still running after the timeout', async () => {
      const svc = await freshService();
      // The client warns when the socket of the query it is waiting for is closed by the kill (sometimes, depending on
      // timing): expected here, so it is kept out of the output; any other warning still goes through.
      const warn = console.warn.bind(console);
      jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('socket was closed or ended before the response was fully read')) warn(...args);
      });
      const stuck = sleeper(svc, 'quiet-kill:slow:1', 30);
      const outcome = stuck.then(
        () => 'finished',
        () => 'killed',
      );
      expect(await eventually(async () => (await runningQueryIds(svc, 'quiet-kill')).length > 0)).toBe(true);

      const started = Date.now();
      await awaitQuiescence(svc, 'quiet-kill', { pollMs: 50, timeoutMs: 400 });

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await runningQueryIds(svc, 'quiet-kill')).toEqual([]);
      expect(await outcome).toBe('killed');
    });

    it('waits for pending mutations of the ledger tables, and throws when they cannot finish', async () => {
      const svc = await freshService();
      await new LedgerWriter(svc, ctx).write(LEDGERS.slice(0, 2));

      // With merges (and so mutations) stopped, an ALTER DELETE stays pending.
      await svc.command(`SYSTEM STOP MERGES ${Table.LedgerByHash}`);
      try {
        await svc.command(
          `ALTER TABLE ${Table.LedgerByHash} DELETE WHERE ledger_index < 0 SETTINGS mutations_sync = 0`,
        );
        await expect(awaitQuiescence(svc, 'quiet-mut', { pollMs: 50, timeoutMs: 300 })).rejects.toThrow(
          /not quiescent.*mutation/is,
        );
      } finally {
        await svc.command(`SYSTEM START MERGES ${Table.LedgerByHash}`);
      }
      await awaitQuiescence(svc, 'quiet-mut', { pollMs: 50, timeoutMs: 20_000 });
    });

    it('rejects an empty prefix: it would match every query', async () => {
      const svc = await freshService();
      await expect(awaitQuiescence(svc, '')).rejects.toThrow(/prefix/i);
    });
  });

  describe('schema contract', () => {
    it('LEDGER_KEYED_TABLES is the set of tables with a dedup window, partitioned as declared', async () => {
      const svc = await freshService();
      const tables = await svc.query<{ name: string; partition_key: string }>(
        "SELECT name, partition_key FROM system.tables WHERE database = currentDatabase() AND engine_full LIKE '%non_replicated_deduplication_window%'",
      );
      expect(new Set(tables.map((t) => t.name))).toEqual(new Set(ALL_TABLES));
      // The ledgers table and the child tables are exactly the ones LedgerWriter writes.
      expect(new Set(ALL_TABLES)).toEqual(
        new Set([Table.Ledgers, Table.LedgerByHash, ...CHILD_TABLES.map(([t]) => t)]),
      );

      for (const { table, partitionSize } of LEDGER_KEYED_TABLES) {
        const stored = tables.find((t) => t.name === table)!.partition_key;
        expect([table, stored]).toEqual([
          table,
          partitionSize === undefined ? '' : `intDiv(ledger_index, ${partitionSize})`,
        ]);
      }
    });
  });
});

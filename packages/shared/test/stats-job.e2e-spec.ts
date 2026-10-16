import { join } from 'node:path';
import { recomputeStatsHourly, StatsRecomputeAborted } from '../src/aggregate/stats.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { LedgersRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { RawLedger } from '../src/ingest/raw-ledger';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * `recomputeStatsHourly` on a real ClickHouse.
 *
 * Seeded with the 54 mock ledgers of the original Ripple test suite through the real `LedgerWriter` (10 distinct hours
 * between 2013 and 2017), and checked against an oracle that adds the ledgers up in plain JavaScript: the transaction
 * and result counts from the raw transactions, the payment / exchange / account counts from the rows the writer stores.
 */

const HOUR = 3600;
const DAY = 86_400;
const MAX_UINT32 = 4_294_967_295;
const SQL_DELETE = { lightweight_deletes_sync: '2' } as const;

const profile = getNetworkProfile('xrpl');
const ctx = parseContextFor(profile);
const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();

interface Expected {
  hour: number;
  transaction_count: number;
  payments_count: number;
  exchanges_count: number;
  accounts_created: number;
  ledger_count: number;
  first_close_time: number;
  last_close_time: number;
  type_counts: Record<string, number>;
  result_counts: Record<string, number>;
}

const hourOf = (seconds: number): number => Math.floor(seconds / HOUR) * HOUR;

/** The stats of every hour the ledgers close in, added up the plain way. */
function oracle(list: RawLedger[]): Expected[] {
  const byHour = new Map<number, Expected>();
  for (const ledger of list) {
    const row: LedgersRow = buildLedgerRows(ledger, ctx).ledger;
    const hour = hourOf(ledger.header.close_time);
    let e = byHour.get(hour);
    if (!e) {
      e = {
        hour,
        transaction_count: 0,
        payments_count: 0,
        exchanges_count: 0,
        accounts_created: 0,
        ledger_count: 0,
        first_close_time: ledger.header.close_time,
        last_close_time: ledger.header.close_time,
        type_counts: {},
        result_counts: {},
      };
      byHour.set(hour, e);
    }
    e.transaction_count += ledger.transactions.length;
    e.payments_count += row.payments_count;
    e.exchanges_count += row.exchanges_count;
    e.accounts_created += row.accounts_created;
    e.ledger_count += 1;
    e.first_close_time = Math.min(e.first_close_time, ledger.header.close_time);
    e.last_close_time = Math.max(e.last_close_time, ledger.header.close_time);
    for (const t of ledger.transactions) {
      const type = String(t.tx.TransactionType);
      const result = String(t.meta.TransactionResult);
      e.type_counts[type] = (e.type_counts[type] ?? 0) + 1;
      e.result_counts[result] = (e.result_counts[result] ?? 0) + 1;
    }
  }
  return [...byHour.values()].sort((a, b) => a.hour - b.hour);
}

interface Stored {
  hour: number;
  transaction_count: number;
  payments_count: number;
  exchanges_count: number;
  accounts_created: number;
  ledger_count: number;
  first_close_time: number;
  last_close_time: number;
  type_counts: Record<string, number>;
  result_counts: Record<string, number>;
  version: number;
}

const ALL_HOURS: [Date, Date] = [new Date(0), new Date(MAX_UINT32 * 1000)];
const at = (seconds: number): Date => new Date(seconds * 1000);

describe('recomputeStatsHourly (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database of its own, with the mock ledgers in `ledgers` unless `seed` is false. */
  async function fresh(seed = true): Promise<ClickHouseService> {
    const config = { ...container.config, database: `stats_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    if (seed) await new LedgerWriter(svc, ctx).write(ledgers);
    return svc;
  }

  /** The newest version of every hour, without FINAL: what a reader sees. */
  async function latest(ch: ClickHouseService): Promise<Stored[]> {
    const rows = await ch.query<Stored>(
      `SELECT toUnixTimestamp(hour) AS hour, transaction_count, payments_count, exchanges_count, accounts_created,
              ledger_count, toUnixTimestamp(first_close_time) AS first_close_time,
              toUnixTimestamp(last_close_time) AS last_close_time, type_counts, result_counts, version
         FROM ${Table.StatsHourly}
        ORDER BY hour, version DESC
        LIMIT 1 BY hour`,
    );
    return rows.map((r) => ({
      hour: Number(r.hour),
      transaction_count: Number(r.transaction_count),
      payments_count: Number(r.payments_count),
      exchanges_count: Number(r.exchanges_count),
      accounts_created: Number(r.accounts_created),
      ledger_count: Number(r.ledger_count),
      first_close_time: Number(r.first_close_time),
      last_close_time: Number(r.last_close_time),
      type_counts: numbers(r.type_counts),
      result_counts: numbers(r.result_counts),
      version: Number(r.version),
    }));
  }
  const numbers = (map: Record<string, number | string>): Record<string, number> =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Number(v)]));
  const withoutVersion = (rows: Stored[]): Omit<Stored, 'version'>[] => rows.map(({ version: _v, ...rest }) => rest);
  const count = async (ch: ClickHouseService, table: Table, final = false): Promise<number> =>
    Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}${final ? ' FINAL' : ''}`))[0].n);

  describe('on the 54 mock ledgers', () => {
    const expected = oracle(ledgers);

    it('the mock ledgers close in 10 hours of 7 days', () => {
      expect(expected).toHaveLength(10);
      expect(new Set(expected.map((e) => Math.floor(e.hour / DAY))).size).toBe(7);
      expect(expected.reduce((n, e) => n + e.ledger_count, 0)).toBe(54);
    });

    it('writes a row per hour that has ledgers, equal to the oracle, and returns how many it wrote', async () => {
      const ch = await fresh();
      const written = await recomputeStatsHourly(ch, ...ALL_HOURS);
      expect(written).toBe(10);
      expect(withoutVersion(await latest(ch))).toEqual(expected);
    });

    it('counts the payments, exchanges and created accounts of the ledgers', async () => {
      const ch = await fresh();
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const rows = await latest(ch);
      expect(rows.reduce((n, r) => n + r.payments_count, 0)).toBeGreaterThan(0);
      expect(rows.reduce((n, r) => n + r.exchanges_count, 0)).toBe(158);
      expect(rows.reduce((n, r) => n + r.accounts_created, 0)).toBeGreaterThan(0);
      expect(rows.reduce((n, r) => n + r.transaction_count, 0)).toBe(
        ledgers.reduce((n, l) => n + l.transactions.length, 0),
      );
    });

    it('recompute twice is idempotent: the same latest values, and the same rows once merged', async () => {
      const ch = await fresh();
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const first = await latest(ch);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const second = await latest(ch);

      expect(withoutVersion(second)).toEqual(withoutVersion(first));
      expect(withoutVersion(second)).toEqual(expected);
      // the second run wrote its own, newer, version of every hour
      for (const [i, row] of second.entries()) expect(row.version).toBeGreaterThan(first[i].version);
      // once ClickHouse has merged the versions there is one row per hour and the sums are the same
      expect(await count(ch, Table.StatsHourly, true)).toBe(10);
      const sums = await ch.query<{ ledgers: string; txs: string }>(
        `SELECT sum(ledger_count) AS ledgers, sum(transaction_count) AS txs FROM ${Table.StatsHourly} FINAL`,
      );
      expect(Number(sums[0].ledgers)).toBe(54);
      expect(Number(sums[0].txs)).toBe(expected.reduce((n, e) => n + e.transaction_count, 0));
    });

    it('stamps the version with the time of the write in milliseconds', async () => {
      const ch = await fresh();
      const before = Date.now();
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const after = Date.now();
      for (const row of await latest(ch)) {
        expect(row.version).toBeGreaterThanOrEqual(before - 2000);
        expect(row.version).toBeLessThanOrEqual(after + 2000);
      }
    });

    it('recomputes only the hours of the range, and widens a range that cuts an hour to the whole hour', async () => {
      const ch = await fresh();
      const target = expected[4];
      // from 20 minutes into the hour to 20 minutes into the next: both hours are recomputed whole
      const written = await recomputeStatsHourly(ch, at(target.hour + 1200), at(target.hour + HOUR + 1200));
      expect(written).toBe(expected.filter((e) => e.hour === target.hour || e.hour === target.hour + HOUR).length);
      expect(withoutVersion(await latest(ch))).toEqual(
        expected.filter((e) => e.hour === target.hour || e.hour === target.hour + HOUR),
      );
    });

    it('a range is exclusive at its end: the hour that starts at toHourExclusive is left alone', async () => {
      const ch = await fresh();
      const target = expected[2];
      await recomputeStatsHourly(ch, at(target.hour), at(target.hour + HOUR));
      expect(withoutVersion(await latest(ch))).toEqual([target]);
    });

    it('slices of one day add up to the same rows as one big run', async () => {
      const ch = await fresh();
      const first = expected[0].hour;
      const last = expected[expected.length - 1].hour + HOUR;
      let total = 0;
      for (let from = hourOf(first); from < last; from += DAY * 400) {
        total += await recomputeStatsHourly(ch, at(from), at(Math.min(from + DAY * 400, last)));
      }
      expect(total).toBe(10);
      expect(withoutVersion(await latest(ch))).toEqual(expected);
    });

    it('writes nothing, and reads nothing, for an empty or reversed range', async () => {
      const ch = await fresh();
      const query = jest.spyOn(ch, 'query');
      expect(await recomputeStatsHourly(ch, at(1_000_000 * HOUR), at(1_000_000 * HOUR))).toBe(0);
      expect(await recomputeStatsHourly(ch, at(2_000_000 * HOUR), at(1_000_000 * HOUR))).toBe(0);
      expect(query).not.toHaveBeenCalled();
      expect(await count(ch, Table.StatsHourly)).toBe(0);
    });

    it('writes no row for an hour without ledgers and without a stats row', async () => {
      const ch = await fresh();
      const written = await recomputeStatsHourly(ch, at(hourOf(1_300_000_000)), at(hourOf(1_300_000_000) + 5 * DAY));
      expect(written).toBe(0);
      expect(await count(ch, Table.StatsHourly)).toBe(0);
    });

    it('rejects a date that is not a date', async () => {
      const ch = await fresh(false);
      await expect(recomputeStatsHourly(ch, new Date(Number.NaN), at(HOUR))).rejects.toThrow(RangeError);
      await expect(recomputeStatsHourly(ch, at(0), new Date(Number.NaN))).rejects.toThrow(RangeError);
    });
  });

  describe('an hour whose ledgers are gone', () => {
    const expected = oracle(ledgers);

    async function withoutLedgersOf(hour: number): Promise<ClickHouseService> {
      const ch = await fresh();
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      await ch.command(
        `DELETE FROM ${Table.Ledgers} WHERE close_time >= toDateTime({from:UInt32}, 'UTC') AND close_time < toDateTime({to:UInt32}, 'UTC')`,
        { from: hour, to: hour + HOUR },
        { settings: SQL_DELETE },
      );
      return ch;
    }

    it('gets a zero row, so that the old counts do not survive', async () => {
      const gone = expected[3];
      const ch = await withoutLedgersOf(gone.hour);
      const before = await latest(ch);
      expect(before.find((r) => r.hour === gone.hour)?.ledger_count).toBe(gone.ledger_count);

      const written = await recomputeStatsHourly(ch, ...ALL_HOURS);
      // the 9 hours that still have ledgers, and the zero row of the one that has none
      expect(written).toBe(10);
      const after = await latest(ch);
      expect(after).toHaveLength(10);
      expect(after.find((r) => r.hour === gone.hour)).toMatchObject({
        hour: gone.hour,
        transaction_count: 0,
        payments_count: 0,
        exchanges_count: 0,
        accounts_created: 0,
        ledger_count: 0,
        type_counts: {},
        result_counts: {},
      });
      expect(withoutVersion(after).filter((r) => r.ledger_count > 0)).toEqual(
        expected.filter((e) => e.hour !== gone.hour),
      );
      // the zero row is newer than the row it replaces
      const zero = after.find((r) => r.hour === gone.hour) as Stored;
      expect(zero.version).toBeGreaterThan(before.find((r) => r.hour === gone.hour)?.version as number);
    });

    it('is zeroed once: the next run does not write the zero row again, and the values stay', async () => {
      const gone = expected[3];
      const ch = await withoutLedgersOf(gone.hour);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const first = await latest(ch);
      // the 9 hours with ledgers again; the hour whose newest row is the zero row has nothing to zero
      expect(await recomputeStatsHourly(ch, ...ALL_HOURS)).toBe(9);
      const second = await latest(ch);
      expect(withoutVersion(second)).toEqual(withoutVersion(first));
      expect(second.find((r) => r.hour === gone.hour)?.version).toBe(first.find((r) => r.hour === gone.hour)?.version);
    });

    it('leaves an hour outside the range alone', async () => {
      const gone = expected[3];
      const ch = await withoutLedgersOf(gone.hour);
      // the range stops one hour short of the gone hour
      await recomputeStatsHourly(ch, at(0), at(gone.hour));
      const after = await latest(ch);
      expect(after.find((r) => r.hour === gone.hour)?.ledger_count).toBe(gone.ledger_count);
    });

    it('comes back to life when the ledgers do', async () => {
      const gone = expected[3];
      const ch = await withoutLedgersOf(gone.hour);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      await new LedgerWriter(ch, ctx)
        .withNewRunId()
        .write(ledgers.filter((l) => hourOf(l.header.close_time) === gone.hour));
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      expect(withoutVersion(await latest(ch))).toEqual(expected);
    });
  });

  describe('when ledgers were written twice', () => {
    it('counts a ledger once (merges stopped, a separate second insert)', async () => {
      const ch = await fresh();
      // `SYSTEM STOP MERGES` needs the database the service is bound to
      const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      await ch.command(`SYSTEM STOP MERGES ${database}.${Table.Ledgers}`);
      await ch.command(
        `INSERT INTO ${Table.Ledgers} SELECT * FROM ${Table.Ledgers}`,
        {},
        {
          settings: { insert_deduplicate: 0 },
        },
      );
      expect(await count(ch, Table.Ledgers)).toBe(108);

      await recomputeStatsHourly(ch, ...ALL_HOURS);
      expect(withoutVersion(await latest(ch))).toEqual(oracle(ledgers));
    });
  });

  describe('when the stats were written twice', () => {
    it('reads the newest version of an hour, however many rows it has', async () => {
      const ch = await fresh();
      const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      await ch.command(`SYSTEM STOP MERGES ${database}.${Table.StatsHourly}`);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      expect(await count(ch, Table.StatsHourly)).toBe(30);
      expect(withoutVersion(await latest(ch))).toEqual(oracle(ledgers));
    });
  });

  describe('aborting', () => {
    it('writes nothing once the signal is aborted, and says so', async () => {
      const ch = await fresh();
      const controller = new AbortController();
      const query = ch.query.bind(ch);
      // the abort comes while the aggregation is being read: the insert after it must not happen
      jest.spyOn(ch, 'query').mockImplementation(async (...args: Parameters<typeof query>) => {
        const rows = await query(...args);
        controller.abort();
        return rows;
      });
      await expect(recomputeStatsHourly(ch, ...ALL_HOURS, { signal: controller.signal })).rejects.toBeInstanceOf(
        StatsRecomputeAborted,
      );
      jest.restoreAllMocks();
      expect(await count(ch, Table.StatsHourly)).toBe(0);
    });

    it('refuses to start with a signal that is aborted already', async () => {
      const ch = await fresh();
      const query = jest.spyOn(ch, 'query');
      await expect(recomputeStatsHourly(ch, ...ALL_HOURS, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        StatsRecomputeAborted,
      );
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('the SQL', () => {
    it('reads the ledgers without FINAL, deduped by ledger_index in a subquery that filters on close_time', async () => {
      const ch = await fresh();
      const query = jest.spyOn(ch, 'query');
      await recomputeStatsHourly(ch, ...ALL_HOURS);
      const sql = query.mock.calls.map(([q]) => String(q));
      for (const text of sql) expect(text).not.toMatch(/\bFINAL\b/);
      const aggregation = sql.find((q) => new RegExp(`FROM ${Table.Ledgers}\\b`).test(q)) as string;
      expect(aggregation).toMatch(/LIMIT 1 BY ledger_index/);
      expect(aggregation).toMatch(/close_time >= toDateTime\(\{from:UInt32\}, 'UTC'\)/);
      expect(aggregation).toMatch(/close_time < toDateTime\(\{to:UInt32\}, 'UTC'\)/);
      expect(aggregation).toMatch(/GROUP BY hour/);
      for (const [, params] of query.mock.calls) {
        expect(Object.keys(params as object).sort()).toEqual(['from', 'to']);
      }
    });

    it('filters the ledgers on the close_time index: it prunes granules and reads no other range', async () => {
      const ch = await fresh();
      const hour = oracle(ledgers)[4].hour;
      const query = jest.spyOn(ch, 'query');
      await recomputeStatsHourly(ch, at(hour), at(hour + HOUR));
      const [sql, params] = query.mock.calls.find(([q]) => new RegExp(`FROM ${Table.Ledgers}\\b`).test(String(q))) as [
        string,
        Record<string, unknown>,
      ];
      jest.restoreAllMocks();
      const plan = (await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params))
        .map((r) => r.explain)
        .join('\n');
      expect(plan).toMatch(/close_time_mm/);
      expect(plan).toMatch(/Granules: \d+\/\d+/);
    });
  });
});

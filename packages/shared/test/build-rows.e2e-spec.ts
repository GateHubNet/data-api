import { join } from 'node:path';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows, CHILD_TABLES, LedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

const FIXTURES = join(__dirname, 'fixtures');

/** Every table `buildLedgerRows` fills, with the property of `LedgerRows` that holds its rows. */
const TABLES: ReadonlyArray<[Table, keyof LedgerRows]> = [
  [Table.Ledgers, 'ledger'],
  [Table.LedgerByHash, 'ledgerByHash'],
  ...CHILD_TABLES,
];

type Row = Record<string, unknown>;

/** Reads give back what was written when UInt64 is quoted (exact) and DateTime is a unix timestamp. */
const READ_SETTINGS = {
  output_format_json_quote_64bit_integers: 1,
  date_time_output_format: 'unix_timestamp',
} as const;

/** Key order does not matter to ClickHouse or to a comparison of rows. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Row)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const asText = (rows: Row[]): string[] => rows.map((r) => JSON.stringify(canonical(r))).sort();

/** The first difference between two sets of rows, or `undefined` when they hold the same rows. */
function firstDifference(stored: Row[], written: Row[]): string | undefined {
  const a = asText(stored);
  const b = asText(written);
  if (a.length !== b.length) return `${a.length} rows stored, ${b.length} written`;
  const at = a.findIndex((text, i) => text !== b[i]);
  return at < 0 ? undefined : `row ${at}\n  stored:  ${a[at]}\n  written: ${b[at]}`;
}

interface Scenario {
  /** Test name. */
  name: string;
  database: string;
  network: 'xrpl' | 'xahau';
  dir: string;
  ledgers: number;
  /** The number of payments the Ripple Data API finds in these ledgers, when it is known. */
  payments?: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'ripple-mock', database: 'rows_mock', network: 'xrpl', dir: 'xrpl/ripple-mock', ledgers: 54, payments: 182 },
  { name: 'recorded xrpl', database: 'rows_xrpl', network: 'xrpl', dir: 'xrpl/recorded', ledgers: 9 },
  { name: 'recorded xahau', database: 'rows_xahau', network: 'xahau', dir: 'xahau/recorded', ledgers: 6 },
];

describe('buildLedgerRows into ClickHouse (e2e)', () => {
  let ch: StartedClickHouse;

  beforeAll(async () => {
    ch = await startClickHouse();
  });

  afterAll(async () => {
    await ch?.container.stop();
  });

  describe.each(SCENARIOS)('$name', (scenario) => {
    let svc: ClickHouseService;
    /** What was inserted, per table. */
    const inserted = new Map<Table, Row[]>();

    beforeAll(async () => {
      const config = { ...ch.config, database: scenario.database };
      await runMigrations({ config, log: () => undefined });
      svc = new ClickHouseService(config);

      const ctx = parseContextFor(getNetworkProfile(scenario.network));
      const ledgers = FixtureLedgerSource.fromDir(join(FIXTURES, scenario.dir)).list();
      expect(ledgers).toHaveLength(scenario.ledgers);
      for (const [table] of TABLES) inserted.set(table, []);

      // One insert per table per ledger, the way the ledger writer will: the ledger row is the commit marker, last.
      for (const raw of ledgers) {
        const rows = buildLedgerRows(raw, ctx);
        const dedupToken = (table: Table) => `e2e:${table}:${raw.header.ledger_index}`;
        for (const [table, key] of [...TABLES].reverse()) {
          const value = rows[key] as unknown as Row | Row[];
          const list = Array.isArray(value) ? value : [value];
          inserted.get(table)!.push(...list);
          await svc.insert(table, list, { dedupToken: dedupToken(table) });
        }
      }
    });

    afterAll(async () => {
      await svc?.onModuleDestroy();
    });

    const count = async (table: Table): Promise<number> =>
      Number((await svc.queryOne<{ n: string }>(`SELECT count() AS n FROM ${table}`, {}, READ_SETTINGS))?.n);

    it('inserts every row into a migrated schema: count() equals the rows written, in every table', async () => {
      for (const [table] of TABLES) {
        expect([table, await count(table)]).toEqual([table, inserted.get(table)!.length]);
      }
      expect(await count(Table.Ledgers)).toBe(scenario.ledgers);
    });

    /** A DateTime comes back as a quoted unix timestamp; the rows hold it as a number. */
    const dateTimeColumns = async (table: Table): Promise<string[]> =>
      (
        await svc.query<{ name: string }>(
          "SELECT name FROM system.columns WHERE database = {db:String} AND table = {table:String} AND type LIKE 'DateTime%'",
          { db: scenario.database, table },
        )
      ).map((c) => c.name);

    it.each(TABLES.map(([table]) => table))('%s: every row reads back exactly as written', async (table) => {
      // `ingested_at` is the server default, not part of the rows.
      const columns = table === Table.Ledgers ? '* EXCEPT ingested_at' : '*';
      const stored = await svc.query<Row>(`SELECT ${columns} FROM ${table}`, {}, READ_SETTINGS);
      const times = await dateTimeColumns(table);
      for (const row of stored) for (const column of times) if (column in row) row[column] = Number(row[column]);

      expect(firstDifference(stored, inserted.get(table)!)).toBeUndefined();
    });

    if (scenario.payments !== undefined) {
      it('stores the known number of payments, both in the table and in the ledger summaries', async () => {
        const row = await svc.queryOne<{ n: string; summed: string }>(
          'SELECT (SELECT count() FROM payments) AS n, (SELECT sum(payments_count) FROM ledgers) AS summed',
          {},
          READ_SETTINGS,
        );
        expect(Number(row?.n)).toBe(scenario.payments);
        expect(Number(row?.summed)).toBe(scenario.payments);
      });
    }

    if (scenario.payments !== undefined) {
      it('keeps NULL, 0 and real tags apart in the Nullable columns', async () => {
        const written = inserted.get(Table.Payments)!;
        const tally = (field: string) => ({
          null: written.filter((r) => r[field] === null).length,
          zero: written.filter((r) => r[field] === 0).length,
          set: written.filter((r) => typeof r[field] === 'number' && r[field] !== 0).length,
        });
        const stored = async (field: string) => {
          const row = await svc.queryOne<Record<string, string>>(
            `SELECT countIf(${field} IS NULL) AS \`null\`, countIf(${field} = 0) AS zero, ` +
              `countIf(${field} > 0) AS \`set\` FROM payments`,
            {},
            READ_SETTINGS,
          );
          return { null: Number(row?.null), zero: Number(row?.zero), set: Number(row?.set) };
        };

        // The ledgers hold a source tag of 0 (kept, ruling R10), absent tags and real ones.
        expect(tally('source_tag')).toEqual({ null: 179, zero: 2, set: 1 });
        expect(tally('destination_tag').null).toBeGreaterThan(0);
        expect(tally('destination_tag').set).toBeGreaterThan(0);
        expect(await stored('source_tag')).toEqual(tally('source_tag'));
        expect(await stored('destination_tag')).toEqual(tally('destination_tag'));
      });
    }

    it('stores the ledger summary with exact UInt64 values and maps', async () => {
      const [ledger] = await svc.query<Row>(
        'SELECT ledger_index, total_coins, fee_total, fee_min, fee_max, type_counts, result_counts, tx_count ' +
          'FROM ledgers ORDER BY ledger_index DESC LIMIT 1',
        {},
        READ_SETTINGS,
      );
      const last = inserted
        .get(Table.Ledgers)!
        .reduce((a, b) => ((b.ledger_index as number) > (a.ledger_index as number) ? b : a));
      expect(ledger).toMatchObject({
        ledger_index: last.ledger_index,
        total_coins: last.total_coins,
        fee_total: last.fee_total,
        type_counts: last.type_counts,
        tx_count: last.tx_count,
      });
      // The numbers are what the reference sums.
      expect(String(ledger.total_coins)).toMatch(/^\d{15,17}$/);
    });
  });
});

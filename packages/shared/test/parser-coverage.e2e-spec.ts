import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { LedgersRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { deleteLedgerRange } from '../src/ingest/ingest-state';
import { coverageFrom, newestLedgerBelowVersion } from '../src/query/parser-coverage';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * Where the rows of a parser version start (`parser-coverage.ts`) on a real ClickHouse. Only `ledgers` matters: the
 * commit marker carries the `parser_version` of the parser that wrote the ledger.
 */

const hash = (ledgerIndex: number, version: number): string =>
  `${ledgerIndex.toString(16)}${version.toString(16)}`.toUpperCase().padStart(64, '0');

/** A ledger written by the parser `version`. */
const ledger = (ledger_index: number, parser_version: number): LedgersRow => ({
  ...SAMPLE_ROWS[Table.Ledgers],
  ledger_index,
  ledger_hash: hash(ledger_index, parser_version),
  parser_version,
});

describe('parser coverage (e2e)', () => {
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

  /** A migrated database of its own: a test never sees the ledgers of another, nor the dedup log of its inserts. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `parser_coverage_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** The ledgers of `ledgers` as `[ledger_index, parser_version]`, each written by its parser. */
  async function store(ch: ClickHouseService, ...stored: [number, number][]): Promise<void> {
    await ch.insert(
      Table.Ledgers,
      stored.map(([index, version]) => ledger(index, version)),
    );
  }

  const answers = async (ch: ClickHouseService, version: number) => ({
    newest: await newestLedgerBelowVersion(ch, version),
    from: await coverageFrom(ch, version),
  });

  it('starts one ledger above the newest ledger an older parser wrote', async () => {
    const ch = await freshService();
    await store(ch, [10, 3], [11, 4], [12, 3], [20, 5], [21, 5]);
    expect(await answers(ch, 5)).toEqual({ newest: 12, from: 13 });
  });

  it('starts at the oldest stored ledger when no older parser wrote one', async () => {
    const ch = await freshService();
    await store(ch, [20, 5], [21, 5]);
    expect(await answers(ch, 5)).toEqual({ newest: null, from: 20 });
  });

  it('does not care about gaps in the ledger numbers', async () => {
    const ch = await freshService();
    // ledgers 16 to 29 are not stored: the coverage still starts right above the newest ledger of the older parser
    await store(ch, [20, 5], [15, 4], [30, 5]);
    expect(await answers(ch, 5)).toEqual({ newest: 15, from: 16 });
  });

  it('answers null and null when no ledger is stored', async () => {
    const ch = await freshService();
    expect(await answers(ch, 5)).toEqual({ newest: null, from: null });
  });

  it('counts a ledger of the version itself as covered, and a ledger of a newer one too', async () => {
    const ch = await freshService();
    await store(ch, [10, 5], [11, 6], [12, 3]);
    expect(await answers(ch, 5)).toEqual({ newest: 12, from: 13 });
    expect(await answers(ch, 6)).toEqual({ newest: 12, from: 13 });
    expect(await answers(ch, 3)).toEqual({ newest: null, from: 10 });
  });

  it('counts a reprocessed ledger, whose old row was deleted, only by its new version', async () => {
    const ch = await freshService();
    await store(ch, [10, 3], [11, 4], [12, 3], [20, 5], [21, 5]);
    expect(await answers(ch, 5)).toEqual({ newest: 12, from: 13 });

    // the reprocess: delete the ledger, write it again with the current parser
    await deleteLedgerRange(ch, 12, 12);
    await store(ch, [12, 5]);

    expect(await answers(ch, 5)).toEqual({ newest: 11, from: 12 });
  });
});

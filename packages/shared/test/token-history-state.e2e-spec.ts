import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { IngestLogRow, LedgersRow, TokenHistoryStateRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import {
  mptCoverageComplete,
  rangeIngestRunning,
  tokenHistoryCoverageFrom,
  unbrokenRunStart,
} from '../src/token-history/coverage-start';
import {
  buildingTokenHistory,
  liveTokenHistory,
  nextGeneration,
  readTokenHistoryStates,
  writeTokenHistoryState,
} from '../src/token-history/state';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

const ledgerRow = (ledger: number, parser_version = 10): LedgersRow => ({
  ...SAMPLE_ROWS[Table.Ledgers],
  ledger_index: ledger,
  ledger_hash: String(ledger).padStart(64, 'C'),
  close_time: 1_700_000_000 + ledger * 4,
  parser_version,
});

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The state of a generation with every column but the two the writer sets. */
const state = (o: Partial<TokenHistoryStateRow> = {}): Omit<TokenHistoryStateRow, 'version' | 'changed_at'> => ({
  generation: 1,
  state: 'building',
  config_version: 1,
  coverage_from: 30,
  h0: 50,
  h1: 0,
  phase: 'changes',
  account_cursor: '',
  token_cursor_issuer: '',
  token_cursor_currency: '',
  through_ledger: 50,
  levels_through: 50,
  started_at: 1_700_000_000.5,
  ...o,
});

describe('the token history state and coverage (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_state_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  describe('unbrokenRunStart', () => {
    it('unbrokenRunStart finds the start of the run that reaches the head', async () => {
      const ch = await fresh();
      await ch.insert(
        Table.Ledgers,
        [...range(10, 20), ...range(30, 50)].map((l) => ledgerRow(l)),
      );
      expect(await unbrokenRunStart(ch, 50)).toBe(30);
      // a head inside the older run reaches back to its start
      expect(await unbrokenRunStart(ch, 15)).toBe(10);
    });

    it('it is the first ledger with no gap', async () => {
      const ch = await fresh();
      await ch.insert(
        Table.Ledgers,
        range(10, 50).map((l) => ledgerRow(l)),
      );
      expect(await unbrokenRunStart(ch, 50)).toBe(10);
      // a gap of one ledger just below the head
      const gap = await fresh();
      await gap.insert(
        Table.Ledgers,
        [...range(10, 48), 50].map((l) => ledgerRow(l)),
      );
      expect(await unbrokenRunStart(gap, 50)).toBe(50);
    });

    it('is undefined when the head is not stored', async () => {
      const ch = await fresh();
      expect(await unbrokenRunStart(ch, 50)).toBeUndefined();
      await ch.insert(
        Table.Ledgers,
        range(10, 20).map((l) => ledgerRow(l)),
      );
      expect(await unbrokenRunStart(ch, 50)).toBeUndefined();
    });

    it('is not fooled by a ledger stored twice beside a gap', async () => {
      const ch = await fresh();
      // no merge may collapse the two rows of 45 while the test reads them
      await ch.command(`SYSTEM STOP MERGES ${Table.Ledgers}`);
      // 30-50 with 40 missing, and 45 written twice (a re-ingest before the merge): count() of [30, 50] equals its span
      await ch.insert(
        Table.Ledgers,
        [...range(30, 39), ...range(41, 50)].map((l) => ledgerRow(l)),
      );
      await ch.insert(Table.Ledgers, [{ ...ledgerRow(45), ingested_at: 1_700_000_999 }]);
      const n = await ch.queryOne<{ n: string }>(
        `SELECT toString(count()) AS n FROM ${Table.Ledgers} WHERE ledger_index BETWEEN 30 AND 50`,
      );
      expect(n?.n).toBe('21');
      expect(await unbrokenRunStart(ch, 50)).toBe(41);
    });

    it('is not fooled by two gaps whose ledgers two duplicates make up for in the count and the sum', async () => {
      const ch = await fresh();
      await ch.command(`SYSTEM STOP MERGES ${Table.Ledgers}`);
      // 30-50 with 42 and 44 missing, and 41 and 45 written twice: count() and sum() of [40, 50] are those of a whole range
      await ch.insert(
        Table.Ledgers,
        range(30, 50)
          .filter((l) => l !== 42 && l !== 44)
          .map((l) => ledgerRow(l)),
      );
      await ch.insert(
        Table.Ledgers,
        [41, 45].map((l) => ({ ...ledgerRow(l), ingested_at: 1_700_000_999 })),
      );
      const figures = await ch.queryOne<{ n: string; s: string }>(
        `SELECT toString(count()) AS n, toString(sum(ledger_index)) AS s FROM ${Table.Ledgers} WHERE ledger_index BETWEEN 40 AND 50`,
      );
      expect(figures).toEqual({ n: '11', s: String(((40 + 50) * 11) / 2) });
      expect(await unbrokenRunStart(ch, 50)).toBe(45);
    });
  });

  describe('mptCoverageComplete', () => {
    const ENABLED = 99_226_369; // MPTokensV1 on the XRP Ledger

    it('is complete from the MPTokensV1 ledger only while every ledger from there was written by parser 10 or later', async () => {
      const ch = await fresh();
      await ch.insert(
        Table.Ledgers,
        range(ENABLED - 5, ENABLED + 5).map((l) => ledgerRow(l, 10)),
      );
      expect(await mptCoverageComplete(ch, 'xrpl', ENABLED - 5)).toBe(true);
      expect(await mptCoverageComplete(ch, 'xrpl', ENABLED + 1)).toBe(false);
      // a ledger above the enable ledger written by an older parser: its MPT states are missing, the MPT history is not whole
      await ch.insert(Table.Ledgers, [ledgerRow(ENABLED + 6, 9)]);
      expect(await mptCoverageComplete(ch, 'xrpl', ENABLED - 5)).toBe(false);
      // one below it does not matter: no MPT existed then
      const below = await fresh();
      await below.insert(Table.Ledgers, [
        ...range(ENABLED - 5, ENABLED + 5).map((l) => ledgerRow(l, 10)),
        ledgerRow(ENABLED - 9, 9),
      ]);
      expect(await mptCoverageComplete(below, 'xrpl', ENABLED - 9)).toBe(true);
      // no enable ledger known: never complete
      expect(await mptCoverageComplete(ch, 'xrpl-testnet', 1)).toBe(false);
    });
  });

  describe('tokenHistoryCoverageFrom', () => {
    it('tokenHistoryCoverageFrom never goes below the state coverage', async () => {
      const ch = await fresh();
      await ch.insert(
        Table.Ledgers,
        range(30, 50).map((l) => ledgerRow(l, l === 35 ? 2 : 10)),
      );
      expect(await unbrokenRunStart(ch, 50)).toBe(30);
      expect(await tokenHistoryCoverageFrom(ch, 50)).toBe(36);
    });

    it('is the start of the head run when the state coverage is below it', async () => {
      const ch = await fresh();
      await ch.insert(
        Table.Ledgers,
        [...range(10, 20), ...range(30, 50)].map((l) => ledgerRow(l)),
      );
      expect(await tokenHistoryCoverageFrom(ch, 50)).toBe(30);
    });
  });

  describe('rangeIngestRunning', () => {
    const intent = (o: Partial<IngestLogRow>): IngestLogRow => ({
      range_start: 100,
      range_end: 199,
      run_id: 'run-1',
      status: 'started',
      updated_at: 1_700_000_000.1,
      ...o,
    });

    it('rangeIngestRunning sees a started range and ignores live intents', async () => {
      const ch = await fresh();
      expect(await rangeIngestRunning(ch)).toBe(false);
      // a live runner's first-write intent, never finished: not a range-ingest
      await ch.insert(Table.IngestLog, [intent({ range_end: 0, run_id: 'live:boot-1' })]);
      expect(await rangeIngestRunning(ch)).toBe(false);
      // a range chunk that started
      await ch.insert(Table.IngestLog, [intent({})]);
      expect(await rangeIngestRunning(ch)).toBe(true);
      // and was done
      await ch.insert(Table.IngestLog, [intent({ status: 'done', updated_at: 1_700_000_001.1 })]);
      expect(await rangeIngestRunning(ch)).toBe(false);
    });
  });

  describe('the state rows', () => {
    it('the newest state row of a generation wins', async () => {
      const ch = await fresh();
      expect(await readTokenHistoryStates(ch)).toEqual([]);
      await writeTokenHistoryState(ch, state({ phase: 'changes' }));
      await writeTokenHistoryState(ch, state({ phase: 'levels', h1: 60, account_cursor: 'rZ' }));
      await writeTokenHistoryState(ch, state({ generation: 2, state: 'building', coverage_from: 10 }));
      const rows = await readTokenHistoryStates(ch);
      expect(rows.map((r) => [r.generation, r.phase, r.h1, r.account_cursor])).toEqual([
        [1, 'levels', 60, 'rZ'],
        [2, 'changes', 0, ''],
      ]);
      expect(rows[0]).toMatchObject({ started_at: 1_700_000_000.5, coverage_from: 30, state: 'building' });
      expect(typeof rows[0].version).toBe('string');
      expect(BigInt(rows[0].version)).toBeGreaterThan(0n);
      expect(rows[0].changed_at).toBeGreaterThan(1_700_000_000);
    });

    it('writes each version above the stored maximum, even when the clock is behind it', async () => {
      const ch = await fresh();
      const ahead = String(Date.now() + 3_600_000);
      await ch.insert(Table.TokenHistoryState, [{ ...state(), changed_at: 1_700_000_000, version: ahead }]);
      await writeTokenHistoryState(ch, state({ phase: 'done' }));
      const [row] = await readTokenHistoryStates(ch);
      expect(row.phase).toBe('done');
      expect(BigInt(row.version)).toBe(BigInt(ahead) + 1n);
    });

    it('picks the live and the building generations, and the next one', () => {
      const row = (generation: number, s: TokenHistoryStateRow['state']): TokenHistoryStateRow => ({
        ...state({ generation, state: s }),
        changed_at: 0,
        version: '1',
      });
      const rows = [row(1, 'retired'), row(2, 'live'), row(3, 'building'), row(4, 'retired')];
      expect(liveTokenHistory(rows)?.generation).toBe(2);
      expect(buildingTokenHistory(rows)?.generation).toBe(3);
      expect(nextGeneration(rows)).toBe(5);
      expect(nextGeneration([])).toBe(1);
      expect(liveTokenHistory([])).toBeUndefined();
      expect(buildingTokenHistory([row(1, 'live')])).toBeUndefined();
    });
  });
});

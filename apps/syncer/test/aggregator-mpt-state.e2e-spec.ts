import {
  buildLedgerRows,
  ClickHouseService,
  committedHead,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  mptIssuerOf,
  parseContextFor,
  RatesService,
  rebuildMptIssuances,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The `mpt_state` job of the `AggregatorService` against a real ClickHouse: the recorded MPT ledgers, written by the real `LedgerWriter`.
 * What an issuance holds is checked against an oracle in `packages/shared/test/mpt-state-job.e2e-spec.ts`; here it is the job that is on
 * trial: what a tick writes, that the cursor is in the tables and so survives a restart, the hook of `agg_dirty`, and that no path through
 * the runner leaves a pair behind what its issuance's `last_ledger` claims.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const LEDGERS = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/mpt')).list();
const BUILT = LEDGERS.map((raw) => buildLedgerRows(raw, ctx));
const ISSUANCE_IDS = [
  ...new Set(BUILT.flatMap((b) => [...b.mptIssuanceStates, ...b.mptHolderStates]).map((r) => r.mpt_issuance_id)),
].sort();
const PAIRS = [
  ...new Set(BUILT.flatMap((b) => b.mptHolderStates).map((r) => `${r.mpt_issuance_id} ${r.holder}`)),
].sort();
const NEWEST_CLOSE = Math.max(...LEDGERS.map((l) => l.header.close_time));
const NEWEST_LEDGER = Math.max(...LEDGERS.map((l) => l.header.ledger_index));
/** A moment after the ingest: the stats have nothing to do but jump from ledger to ledger. */
const NOW = new Date((NEWEST_CLOSE + 7200) * 1000);
const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

// Recorded (packages/shared/test/fixtures/xrpl/mpt/manifest.json): three holders, the escrows of escrow_create and escrow_finish
const ESCROWED = '0663EB64E8DDA74A98C6C70B740E67C7A2D1509EE78C163A';
const CLOSE_OF_ESCROWED = LEDGERS.find((l) => l.header.ledger_index === 107211751)?.header.close_time as number;

interface StoredIssuance {
  mpt_issuance_id: string;
  holders: number;
  last_ledger: number;
  version: number;
}

interface StoredHolder {
  mpt_issuance_id: string;
  holder: string;
  amount: string;
  version: number;
}

describe('AggregatorService mpt_state job (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.close();
    await container?.container.stop();
  });

  /** A migrated database with the MPT ledgers in it. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_mpt_state_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    await new LedgerWriter(svc, ctx).write(LEDGERS);
    return svc;
  }

  /** An aggregator that has the MPT job and, of the stats, only the walk from ledger to ledger (the stats have their own tests). */
  function aggregator(ch: ClickHouseService): AggregatorService {
    const svc = new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      mptState: { rates: new RatesService(ch, 'XRP') },
      recompute: async () => 0,
    });
    aggregators.push(svc);
    return svc;
  }

  const issuancesOf = (ch: ClickHouseService): Promise<StoredIssuance[]> =>
    ch.query<StoredIssuance>(
      `SELECT mpt_issuance_id, holders, last_ledger, version FROM ${Table.MptIssuances}
        ORDER BY mpt_issuance_id, version DESC LIMIT 1 BY mpt_issuance_id`,
    );
  const holdersOf = (ch: ClickHouseService): Promise<StoredHolder[]> =>
    ch.query<StoredHolder>(
      `SELECT mpt_issuance_id, holder, toString(amount) AS amount, version FROM ${Table.MptHolders}
        ORDER BY mpt_issuance_id, holder, version DESC LIMIT 1 BY mpt_issuance_id, holder`,
    );
  const countOf = async (ch: ClickHouseService, table: Table): Promise<number> =>
    Number((await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${table}`))?.n);

  /** A touch of a holder at a new committed ledger, with its state row: `amount` units, as the ledger writer leaves it. */
  async function touchHolder(ch: ClickHouseService, ledger: number, holder: string, amount: string): Promise<void> {
    await ch.insert(Table.MptHolderStates, [
      {
        holder,
        mpt_issuance_id: ESCROWED,
        ledger_index: ledger,
        tx_index: 0,
        node_index: 0,
        tx_hash: `synthetic-${ledger}`,
        tx_type: 'Payment',
        close_time: NEWEST_CLOSE + (ledger - NEWEST_LEDGER),
        amount,
        escrowed_amount: '0',
        flags: 0,
        deleted: 0,
      },
    ]);
    await ch.insert(Table.MptTouches, [{ ledger_index: ledger, tx_index: 0, mpt_issuance_id: ESCROWED, holder }]);
    await ch.insert(Table.Ledgers, [
      {
        ledger_index: ledger,
        ledger_hash: `${ledger}`.padStart(64, 'C'),
        close_time: NEWEST_CLOSE + (ledger - NEWEST_LEDGER),
      },
    ]);
  }

  /** A touch of the issuance's own node at a new committed ledger, with its state row. */
  async function touchIssuance(ch: ClickHouseService, ledger: number): Promise<void> {
    const close = NEWEST_CLOSE + (ledger - NEWEST_LEDGER);
    await ch.insert(Table.MptIssuanceStates, [
      {
        mpt_issuance_id: ESCROWED,
        ledger_index: ledger,
        tx_index: 0,
        node_index: 0,
        tx_hash: `synthetic-${ledger}`,
        tx_type: 'MPTokenIssuanceSet',
        close_time: close,
        issuer: mptIssuerOf(ESCROWED),
        sequence: Number.parseInt(ESCROWED.slice(0, 8), 16),
        flags: 104,
        asset_scale: 2,
        maximum_amount: '1000000000000',
        outstanding_amount: '954219',
        escrowed_amount: '0',
        transfer_fee: 0,
        metadata_hex: '',
        deleted: 0,
      },
    ]);
    await ch.insert(Table.MptTouches, [{ ledger_index: ledger, tx_index: 0, mpt_issuance_id: ESCROWED, holder: '' }]);
    await ch.insert(Table.Ledgers, [
      { ledger_index: ledger, ledger_hash: `${ledger}`.padStart(64, 'C'), close_time: close },
    ]);
  }

  /** The ingest marks the hour of a ledger it rewrote. */
  async function markDirty(ch: ClickHouseService, close: number): Promise<void> {
    const hour = Math.floor(close / 3600) * 3600;
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: hour, to: hour + 3600, created: Date.now() - 5000 },
    );
  }

  it('the first tick writes every issuance and holder of the recorded ledgers', async () => {
    const ch = await fresh();
    await aggregator(ch).tick(NOW);
    expect((await issuancesOf(ch)).map((r) => r.mpt_issuance_id)).toEqual(ISSUANCE_IDS);
    expect((await holdersOf(ch)).map((r) => `${r.mpt_issuance_id} ${r.holder}`).sort()).toEqual(PAIRS);
    const row = (await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED) as StoredIssuance;
    expect(row).toMatchObject({ holders: 3, last_ledger: 107211751 });
  });

  it('a second tick with no new ledger writes nothing, and neither does a restarted aggregator: the cursor is in the tables', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    const [issuanceRows, holderRows] = [await countOf(ch, Table.MptIssuances), await countOf(ch, Table.MptHolders)];
    expect(issuanceRows).toBe(ISSUANCE_IDS.length);
    expect(holderRows).toBe(PAIRS.length);

    await svc.tick(NOW);
    expect(await countOf(ch, Table.MptIssuances)).toBe(issuanceRows);
    expect(await countOf(ch, Table.MptHolders)).toBe(holderRows);

    await aggregator(ch).tick(NOW);
    expect(await countOf(ch, Table.MptIssuances)).toBe(issuanceRows);
    expect(await countOf(ch, Table.MptHolders)).toBe(holderRows);
  });

  it('a touch that arrives rebuilds its issuance and that pair only, and a restart picks up what arrived while it was down', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    const before = new Map((await holdersOf(ch)).map((h) => [`${h.mpt_issuance_id} ${h.holder}`, h.version]));
    const issuancesBefore = await countOf(ch, Table.MptIssuances);
    const someone = 'rNewHolderOfTheEscrowedIssuance000';

    await touchHolder(ch, NEWEST_LEDGER + 1, someone, '5');
    await svc.tick(NOW);
    expect(await countOf(ch, Table.MptIssuances)).toBe(issuancesBefore + 1);
    expect(await countOf(ch, Table.MptHolders)).toBe(before.size + 1);
    expect((await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED)).toMatchObject({
      holders: 4,
      last_ledger: NEWEST_LEDGER + 1,
    });

    await touchHolder(ch, NEWEST_LEDGER + 2, someone, '6');
    await aggregator(ch).tick(NOW);
    expect((await holdersOf(ch)).find((h) => h.holder === someone)).toMatchObject({ amount: '6' });
  });

  it('a holder touched while the issuance is set aside is rebuilt by its retry, which holds only the ID', async () => {
    const ch = await fresh();
    const failing = new Set<string>([ESCROWED]);
    const rebuild: typeof rebuildMptIssuances = async (db, stale, head, o) => {
      if (stale.some((s) => failing.has(s.id))) throw new Error('DB::Exception: memory limit');
      await rebuildMptIssuances(db, stale, head, o);
    };
    // a clock of its own: the wait of the retry is what this test goes past
    let nowMs = NOW.getTime();
    const svc = new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      now: () => nowMs,
      mptState: { rates: new RatesService(ch, 'XRP') },
      mptStateFunctions: { rebuild },
      recompute: async () => 0,
    });
    aggregators.push(svc);

    // the other issuances of the batch work, so it goes aside at once, and the cursor goes on without it
    await svc.tick(NOW);
    const seen = await issuancesOf(ch);
    expect(seen.map((r) => r.mpt_issuance_id)).not.toContain(ESCROWED);
    expect(seen).toHaveLength(ISSUANCE_IDS.length - 1);

    // the cursor has gone past it, to the head, and these touches are in no batch: the issuance waits for its retry
    const later = 'rTouchedWhileTheIssuanceWasAside00';
    await touchHolder(ch, NEWEST_LEDGER + 1, later, '11');
    await svc.tick(NOW);
    expect(await holdersOf(ch)).not.toEqual(expect.arrayContaining([expect.objectContaining({ holder: later })]));

    failing.clear();
    nowMs += 5 * 60_000;
    await svc.tick(NOW);
    const holders = (await holdersOf(ch)).filter((h) => h.mpt_issuance_id === ESCROWED);
    expect(holders.map((h) => h.holder)).toContain(later);
    expect(holders).toHaveLength(4);
    expect((await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED)).toMatchObject({
      holders: 4,
      last_ledger: NEWEST_LEDGER + 1,
    });
  });

  it('the hook of a slice at a newer head rebuilds what the live job has not reached, and the live job finds nothing left behind', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);

    // a touch the live job has not read, and a state row of the issuance above it, which lifts what the row has seen past that touch;
    // then the slice of an older ledger of the same issuance is rewritten behind the aggregator, and its hook runs before the live job
    const later = 'rTouchedBeforeTheHookRanItsSlice00';
    await touchHolder(ch, NEWEST_LEDGER + 1, later, '13');
    await touchIssuance(ch, NEWEST_LEDGER + 2);
    await markDirty(ch, CLOSE_OF_ESCROWED);

    await svc.tick(NOW);
    expect((await holdersOf(ch)).find((h) => h.holder === later)).toMatchObject({ amount: '13' });
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);
    expect((await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED)).toMatchObject({
      holders: 4,
      last_ledger: NEWEST_LEDGER + 2,
    });
  });

  it('a re-ingest that drops the rows of a pair: its row goes by the hook, and the issuance is rebuilt from what is left', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    expect((await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED)).toMatchObject({ holders: 3 });

    // the re-ingest of the last ledger of the issuance drops its rows there: one holder has no state row left
    const ledger = 107211751;
    for (const table of [Table.MptHolderStates, Table.MptIssuanceStates, Table.MptTouches]) {
      await ch.command(
        `DELETE FROM ${table} WHERE ledger_index = {ledger:UInt32}`,
        { ledger },
        { settings: { lightweight_deletes_sync: '2' } },
      );
    }
    await markDirty(ch, CLOSE_OF_ESCROWED);
    await svc.tick(NOW);

    const holders = (await holdersOf(ch)).filter((h) => h.mpt_issuance_id === ESCROWED);
    // the one whose only row was there is gone; the other that had a row there goes back to its older one
    expect(holders.map((h) => [h.holder.slice(0, 8), h.amount]).sort()).toEqual([
      ['rBoJ7MWP', '277073'],
      ['rw4tVZXo', '636146'],
    ]);
    expect((await issuancesOf(ch)).find((r) => r.mpt_issuance_id === ESCROWED)).toMatchObject({
      holders: 2,
      last_ledger: 107211749,
    });
    expect(await committedHead(ch)).toBe(NEWEST_LEDGER);
  });
});

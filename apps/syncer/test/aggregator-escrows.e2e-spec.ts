import {
  buildLedgerRows,
  ClickHouseService,
  escrowId,
  ESCROWS_STEP_LEDGERS,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  ObjectChangesRow,
  parseContextFor,
  RatesService,
  readEscrowed,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The `escrows` job of the `AggregatorService` against a real ClickHouse: the 22 whole mainnet ledgers of the object fixtures
 * (`fixtures/xrpl/objects`: 191 cancelled and 7 created token escrows, a finished native escrow whose creation is not indexed,
 * a native timed escrow of 0.5 XRP that is still open, and a token escrow made and finished), written by the real `LedgerWriter`.
 * What a step writes is checked against an oracle in `packages/shared/test/escrows.job.e2e-spec.ts`; here it is the job that is on
 * trial: that the ticks walk the history from its first ledger in steps within the budget, that the sentinel follows the head at
 * every tick, that the watermark is in the table so that a restart goes on, and the hook of `agg_dirty`.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const LEDGERS = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/objects')).list();
const ESCROW_CHANGES: ObjectChangesRow[] = LEDGERS.flatMap((raw) => buildLedgerRows(raw, ctx).objectChanges).filter(
  (row) => row.object_type === 'Escrow',
);
const FIRST_LEDGER = Math.min(...LEDGERS.map((l) => l.header.ledger_index));
const HEAD = Math.max(...LEDGERS.map((l) => l.header.ledger_index));
const NEWEST_CLOSE = Math.max(...LEDGERS.map((l) => l.header.close_time));
/** A moment after the ingest: the stats have nothing to do but jump from ledger to ledger. */
const NOW = new Date((NEWEST_CLOSE + 7200) * 1000);

const NOOP = (): void => undefined;
/** Passed on every lightweight DELETE so that it returns once it has been applied. */
const SYNC_DELETE = { settings: { lightweight_deletes_sync: '2' } } as const;

// Recorded (packages/shared/test/fixtures/xrpl/objects/manifest.json): the native timed escrow made in ledger 107897249, still
// open at the head: 0.5 XRP.
const TIMED_OWNER = 'rNeJW71pMjKy42j5jn7vnWZAbmuU6SKs6V';
const TIMED_SEQUENCE = 107_896_555;
const TIMED = escrowId(TIMED_OWNER, TIMED_SEQUENCE);
const TIMED_LEDGER = 107_897_249;
const OPEN_NATIVE = { drops: '500000', open: 1 };

/** The ledgers the steps of a run from the start of history to the head end at: a step is `ESCROWS_STEP_LEDGERS` ledgers. */
const STEP_ENDS: number[] = [];
for (let end = FIRST_LEDGER - 1 + ESCROWS_STEP_LEDGERS; end < HEAD; end += ESCROWS_STEP_LEDGERS) STEP_ENDS.push(end);
STEP_ENDS.push(HEAD);

/** The fake metrics of the aggregator and of the escrows job: what is set and counted is read from the mocks. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  escrowsLagLedgers: { set: jest.fn() },
  escrowsOpen: { set: jest.fn() },
});
type FakeMetrics = ReturnType<typeof fakeMetrics>;

/** The values a gauge was set to, in order. */
const valuesOf = (gauge: { set: jest.Mock }): number[] => gauge.set.mock.calls.map(([value]) => value);

interface StoredEscrow {
  escrow_id: string;
  owner: string;
  currency: string;
  amount: string;
  amount_drops: string;
  created_ledger: number | null;
  last_ledger: number;
  deleted: number;
  version: number;
}

describe('AggregatorService escrows job (e2e)', () => {
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

  /**
   * A migrated database of its own with the recorded ledgers in it (written by the real `LedgerWriter`). The merges of `escrows`
   * are stopped unless `counted` is false, so that the rows a tick writes stay where they were written and can be counted (the
   * mutations stop with them: a lightweight DELETE that waits for its mutation would not return).
   */
  async function fresh(counted = true): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_escrows_${++dbCounter}` };
    await runMigrations({ config, log: NOOP });
    const svc = new ClickHouseService(config);
    services.push(svc);
    await new LedgerWriter(svc, ctx).write(LEDGERS);
    if (counted) await svc.command(`SYSTEM STOP MERGES ${config.database}.${Table.Escrows}`);
    return svc;
  }

  /** An aggregator that has the escrows job and, of the stats, only the walk from ledger to ledger (the stats have their own tests). */
  function aggregator(
    ch: ClickHouseService,
    options: Partial<ConstructorParameters<typeof AggregatorService>[3]> = {},
  ): { svc: AggregatorService; metrics: FakeMetrics; errors: jest.Mock } {
    const metrics = fakeMetrics();
    const errors = jest.fn();
    const svc = new AggregatorService(ch, metrics as never, undefined, {
      logger: { log: NOOP, warn: NOOP, debug: NOOP, error: errors },
      escrows: { rates: new RatesService(ch, 'XRP'), nativeCurrency: 'XRP' },
      recompute: async () => 0,
      ...options,
    });
    aggregators.push(svc);
    return { svc, metrics, errors };
  }

  /** Ticks until the lag of the job is 0, and says how many ticks it took. */
  async function catchUp(
    { svc, metrics }: { svc: AggregatorService; metrics: FakeMetrics },
    most = 5,
  ): Promise<number> {
    let ticks = 0;
    do {
      await svc.tick(NOW);
      ticks++;
    } while (valuesOf(metrics.escrowsLagLedgers).at(-1) !== 0 && ticks < most);
    return ticks;
  }

  /** The newest version of each escrow (the sentinel is not one). */
  async function escrowsOf(ch: ClickHouseService): Promise<Map<string, StoredEscrow>> {
    const rows = await ch.query<Omit<StoredEscrow, 'version'> & { version: string | number; drops: string }>(
      `SELECT escrow_id, owner, currency, amount, toString(amount_drops) AS drops, created_ledger, last_ledger, deleted,
              toUInt64(version) AS version
         FROM ${Table.Escrows}
        WHERE escrow_id != ''
        ORDER BY escrow_id, version DESC
        LIMIT 1 BY escrow_id`,
    );
    return new Map(
      rows.map(({ drops, version, ...row }) => [
        row.escrow_id,
        { ...row, amount_drops: drops, version: Number(version) } as StoredEscrow,
      ]),
    );
  }

  /** Every row of the sentinel, oldest first. */
  async function sentinels(ch: ClickHouseService) {
    const rows = await ch.query<{ drops: string; open_count: string; through_ledger: number; version: string }>(
      `SELECT toString(amount_drops) AS drops, open_count, through_ledger, toUInt64(version) AS version
         FROM ${Table.Escrows}
        WHERE escrow_id = ''
        ORDER BY version ASC`,
    );
    return rows.map((r) => ({
      drops: r.drops,
      open: Number(r.open_count),
      through_ledger: Number(r.through_ledger),
      version: Number(r.version),
    }));
  }

  /**
   * The oracle: the open native escrows at a ledger from the newest `object_changes` row of each escrow, written another way than
   * the job's (an `argMax` over a group, the amount read from the JSON of the fields, not the rows of `escrows`).
   */
  async function recount(ch: ClickHouseService, to: number): Promise<{ drops: string; open: number }> {
    const [row] = await ch.query<{ open: string; drops: string }>(
      `SELECT count() AS open, toString(sum(native_drops)) AS drops
         FROM (
              SELECT argMax(action, (ledger_index, tx_index)) AS last_action,
                     argMax(fields, (ledger_index, tx_index)) AS last_fields,
                     JSONType(last_fields, 'Amount') = 'String' AS is_native,
                     if(is_native, toUInt64OrZero(JSONExtractString(last_fields, 'Amount')), 0) AS native_drops
                FROM ${Table.ObjectChanges}
               WHERE object_type = 'Escrow' AND ledger_index <= {to:UInt32}
               GROUP BY object_id
              )
        WHERE last_action != 'deleted' AND is_native`,
      { to },
    );
    return { drops: row.drops, open: Number(row.open) };
  }

  /** Marks the hour a ledger closed in, as the ingest of a re-run of the ledger does. */
  async function markHourOf(ch: ClickHouseService, closeTime: number): Promise<void> {
    const hour = Math.floor(closeTime / 3600) * 3600;
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: hour, to: hour + 3600, created: Date.now() - 5000 },
    );
  }

  const closeOf = (ledger: number): number =>
    LEDGERS.find((l) => l.header.ledger_index === ledger)?.header.close_time as number;

  it('builds the escrows table to the head and reports lag 0', async () => {
    const ch = await fresh();
    expect(await readEscrowed(ch)).toBeUndefined();
    const running = aggregator(ch);
    await catchUp(running);
    const { metrics, errors } = running;

    // the lag is never the whole head: the job starts at the first ledger of the history, and ends at the head
    expect(valuesOf(metrics.escrowsLagLedgers).at(-1)).toBe(0);
    for (const lag of valuesOf(metrics.escrowsLagLedgers)) expect(lag).toBeLessThan(HEAD - FIRST_LEDGER);
    expect(valuesOf(metrics.escrowsOpen).at(-1)).toBe(OPEN_NATIVE.open);
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'escrows' });

    // the sentinel is the total a recount from the object_changes rows gives, as of the head
    const escrowed = await readEscrowed(ch);
    expect(escrowed).toEqual({ ...OPEN_NATIVE, through_ledger: HEAD });
    expect(escrowed).toEqual({ ...(await recount(ch, HEAD)), through_ledger: HEAD });

    // one row per escrow of the recordings, and the open native one is what the ledger had
    const escrows = await escrowsOf(ch);
    expect([...escrows.keys()].sort()).toEqual([...new Set(ESCROW_CHANGES.map((r) => r.object_id))].sort());
    expect(escrows.size).toBeGreaterThan(190);
    expect(escrows.get(TIMED)).toMatchObject({
      owner: TIMED_OWNER,
      currency: 'XRP',
      amount: '0.5',
      amount_drops: '500000',
      created_ledger: TIMED_LEDGER,
      last_ledger: TIMED_LEDGER,
      deleted: 0,
    });
    expect(
      [...escrows.values()].filter((e) => e.deleted === 0 && e.currency === 'XRP').map((e) => e.escrow_id),
    ).toEqual([TIMED]);

    // the steps began at the ledger before the first one stored and moved a step at a time: no `through_ledger` below it (a walk
    // from ledger 0 would have written a hundred of them), and none the `ledgers` table does not reach
    const reached = [...new Set((await sentinels(ch)).map((s) => s.through_ledger))];
    expect(reached).toEqual(STEP_ENDS);
  });

  it('writes a newer sentinel every tick with no new ledger', async () => {
    const ch = await fresh();
    const running = aggregator(ch);
    await catchUp(running);
    const before = await sentinels(ch);
    const escrowsBefore = await escrowsOf(ch);

    await running.svc.tick(NOW);
    await running.svc.tick(NOW);
    const after = await sentinels(ch);
    expect(after).toHaveLength(before.length + 2);
    const written = after.slice(before.length);
    expect(written[0].version).toBeGreaterThan(before[before.length - 1].version);
    expect(written[1].version).toBeGreaterThan(written[0].version);
    // the head did not move, so neither did the watermark or the total
    for (const row of written) expect(row).toMatchObject({ ...OPEN_NATIVE, through_ledger: HEAD });
    expect(valuesOf(running.metrics.escrowsLagLedgers).slice(-2)).toEqual([0, 0]);
    // and no escrow was written again
    expect(await escrowsOf(ch)).toEqual(escrowsBefore);
    expect(running.errors).not.toHaveBeenCalled();
  });

  it('takes one step a tick with a budget of 0, and a new process goes on from the sentinel', async () => {
    const ch = await fresh();
    const lags: number[] = [];
    for (const end of STEP_ENDS) {
      // a process of its own at every tick: the watermark is in the table
      const running = aggregator(ch, { budgetsMs: { escrows: 0 } });
      await running.svc.tick(NOW);
      expect((await readEscrowed(ch))?.through_ledger).toBe(end);
      lags.push(valuesOf(running.metrics.escrowsLagLedgers).at(-1) as number);
      expect(running.errors).not.toHaveBeenCalled();
    }
    expect(lags).toEqual(STEP_ENDS.map((end) => HEAD - end));
    expect(lags.at(-1)).toBe(0);
    expect(await readEscrowed(ch)).toEqual({ ...OPEN_NATIVE, through_ledger: HEAD });
    expect((await sentinels(ch)).map((s) => s.through_ledger)).toEqual(STEP_ENDS);
  });

  it('recomputes the escrows of an agg_dirty range after their rows changed, and drops the one whose rows are gone', async () => {
    const ch = await fresh(false);
    const running = aggregator(ch);
    await catchUp(running);
    const escrowsBefore = await escrowsOf(ch);
    const sentinelsBefore = await sentinels(ch);
    expect(escrowsBefore.get(TIMED)).toMatchObject({ amount_drops: '500000' });

    // a re-ingest of the ledger that made the escrow wrote a row that the first run did not have: the escrow was modified, and
    // holds 0.9 XRP now. The cursor of the job is past the ledger, so only the range of agg_dirty can bring it into the table.
    const made = ESCROW_CHANGES.find((r) => r.object_id === TIMED) as ObjectChangesRow;
    await ch.insert(Table.ObjectChanges, [
      {
        ...made,
        tx_index: 90,
        tx_hash: 'synthetic-reingest',
        action: 'modified',
        event: 'update',
        fields: JSON.stringify({ ...JSON.parse(made.fields), Amount: '900000' }),
      },
    ]);
    await running.svc.tick(NOW);
    const untouched = await escrowsOf(ch);
    expect(untouched.get(TIMED)).toEqual(escrowsBefore.get(TIMED));

    await markHourOf(ch, closeOf(TIMED_LEDGER));
    await running.svc.tick(NOW);
    const changed = await escrowsOf(ch);
    expect(changed.get(TIMED)).toMatchObject({
      amount: '0.9',
      amount_drops: '900000',
      created_ledger: TIMED_LEDGER,
      last_ledger: TIMED_LEDGER,
      deleted: 0,
    });
    expect(changed.get(TIMED)?.version).toBeGreaterThan(escrowsBefore.get(TIMED)?.version as number);
    // the escrows of the hour were recomputed, and the others of the table were not
    for (const [id, row] of escrowsBefore) if (id !== TIMED) expect(changed.get(id)).toEqual(row);
    // the sentinel has the new total at the watermark it had, written by the hook after the step of the tick
    const sentinelRows = await sentinels(ch);
    expect(sentinelRows.at(-1)).toMatchObject({ drops: '900000', open: 1, through_ledger: HEAD });
    expect(sentinelRows.at(-1)?.version).toBeGreaterThan(sentinelsBefore.at(-1)?.version as number);
    expect(await readEscrowed(ch)).toEqual({ drops: '900000', open: 1, through_ledger: HEAD });
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);

    // a parser fix: the re-ingest of the ledger no longer finds the escrow at all. It has no row left to be rebuilt from, so it is
    // removed, and the total falls to nothing. Nothing touches it any more: its `last_ledger` is what names the range.
    await ch.command(`DELETE FROM ${Table.ObjectChanges} WHERE object_id = {id:String}`, { id: TIMED }, SYNC_DELETE);
    await markHourOf(ch, closeOf(TIMED_LEDGER));
    await running.svc.tick(NOW);
    const gone = await escrowsOf(ch);
    expect(gone.has(TIMED)).toBe(false);
    expect(await ch.query(`SELECT 1 FROM ${Table.Escrows} WHERE escrow_id = {id:String}`, { id: TIMED })).toEqual([]);
    expect(gone.size).toBe(escrowsBefore.size - 1);
    expect(await readEscrowed(ch)).toEqual({ drops: '0', open: 0, through_ledger: HEAD });
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);
    // the gauge follows the sentinel at the next step (the step of the tick that corrected it ran before the hook did)
    await running.svc.tick(NOW);
    expect(valuesOf(running.metrics.escrowsOpen).at(-1)).toBe(0);
    expect(running.errors).not.toHaveBeenCalled();
    expect(running.metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
  });
});

import { ClickHouseService, NodeClient, runMigrations, Table } from '@gatehub/data-api-shared';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { FeeStatsPoller } from '../src/fees/fee-stats-poller';

/**
 * The poller against a real ClickHouse: what the unit specs cannot show is how `fee_stats.ts` (a `DateTime64(3, 'UTC')`)
 * reads the number the poller writes. It is unix seconds with the milliseconds as a fraction; a millisecond integer would
 * be read as a date 1000 times further on.
 */

const FEE = {
  current_ledger_size: '46',
  current_queue_size: '13',
  drops: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '12' },
  expected_ledger_size: '24',
  max_queue_size: '480',
  status: 'success',
};

interface Stored {
  text: string;
  ms: number;
  current_ledger_size: number;
  expected_ledger_size: number;
  current_queue_size: number;
  max_queue_size: number;
  pct_max_queue_size: number;
  median_fee: string;
  minimum_fee: string;
  open_ledger_fee: string;
}

describe('FeeStatsPoller (e2e)', () => {
  let clickhouse: StartedClickHouse;
  let ch: ClickHouseService;

  beforeAll(async () => {
    clickhouse = await startClickHouse();
    const config = { ...clickhouse.config, database: 'fee_stats_e2e' };
    await runMigrations({ config, log: () => undefined });
    ch = new ClickHouseService(config);
  });

  afterAll(async () => {
    await ch?.onModuleDestroy();
    await clickhouse?.container.stop();
  });

  /** A poller whose clock reads `at` (not `Date.now` itself: the ClickHouse client keeps its sockets by it). */
  const poller = (request: jest.Mock, at: string) =>
    new FeeStatsPoller({ request } as unknown as NodeClient, ch, undefined, undefined, {
      now: () => Date.parse(at),
    });
  /** The rows a test wrote itself: those with a `ts` in `[from, until)` (ISO times), so that no test reads another's. */
  const stored = (from: string, until: string): Promise<Stored[]> =>
    ch.query<Stored>(
      `SELECT toString(ts) AS text, toUnixTimestamp64Milli(ts) AS ms, current_ledger_size, expected_ledger_size,
              current_queue_size, max_queue_size, pct_max_queue_size,
              toString(median_fee) AS median_fee, toString(minimum_fee) AS minimum_fee,
              toString(open_ledger_fee) AS open_ledger_fee
         FROM ${Table.FeeStats}
        WHERE ts >= fromUnixTimestamp64Milli({from:Int64}, 'UTC') AND ts < fromUnixTimestamp64Milli({until:Int64}, 'UTC')
        ORDER BY ts`,
      { from: Date.parse(from), until: Date.parse(until) },
    );

  it('writes a row per sample, whose ts keeps the milliseconds', async () => {
    const request = jest.fn(async () => FEE);
    await poller(request, '2026-10-16T12:00:00.123Z').sample();
    await poller(request, '2026-10-16T12:00:05.007Z').sample();

    expect(request.mock.calls[0]).toEqual([{ command: 'fee' }, expect.any(Object)]);
    const rows = await stored('2026-10-16T12:00:00Z', '2026-10-16T12:00:10Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      text: '2026-10-16 12:00:00.123',
      ms: Date.parse('2026-10-16T12:00:00.123Z'),
      current_ledger_size: 46,
      expected_ledger_size: 24,
      current_queue_size: 13,
      max_queue_size: 480,
      pct_max_queue_size: 2.71,
      median_fee: '5000',
      minimum_fee: '10',
      open_ledger_fee: '12',
    });
    expect(rows[1].text).toBe('2026-10-16 12:00:05.007');
  });

  it('is partitioned by the month of ts: a sample lands in the partition of its own month', async () => {
    const request = jest.fn(async () => FEE);
    // its own samples, in months no other test writes to
    await poller(request, '2031-03-15T10:00:00.250Z').sample();
    await poller(request, '2031-04-02T00:00:00.000Z').sample();
    await poller(request, '2031-03-31T23:59:59.999Z').sample();

    const rows = await ch.query<{ ms: number; partition: string }>(
      `SELECT toUnixTimestamp64Milli(ts) AS ms, _partition_id AS partition
         FROM ${Table.FeeStats}
        WHERE ts >= fromUnixTimestamp64Milli({from:Int64}, 'UTC') AND ts < fromUnixTimestamp64Milli({until:Int64}, 'UTC')
        ORDER BY ts`,
      { from: Date.parse('2031-01-01T00:00:00Z'), until: Date.parse('2032-01-01T00:00:00Z') },
    );
    expect(rows.map((r) => [new Date(Number(r.ms)).toISOString(), r.partition])).toEqual([
      ['2031-03-15T10:00:00.250Z', '203103'],
      ['2031-03-31T23:59:59.999Z', '203103'], // the last millisecond of March is still March
      ['2031-04-02T00:00:00.000Z', '203104'],
    ]);
  });

  it('stores a fee above 2^53 drops exactly (UInt64)', async () => {
    const request = jest.fn(async () => ({ ...FEE, drops: { ...FEE.drops, median_fee: '9007199254740993' } }));
    await poller(request, '2026-10-16T12:01:00.000Z').sample();
    const rows = await stored('2026-10-16T12:01:00Z', '2026-10-16T12:01:01Z');
    expect(rows.map((r) => r.median_fee)).toEqual(['9007199254740993']);
  });
});

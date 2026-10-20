import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { UTC_DAY_MS } from '../query/account-day-groups';
import {
  ACCOUNT_PARTITION_ROWS_FLOOR,
  ACCOUNT_ROLLUP_SLICE_ROWS,
  ADDRESS_SLICE_CHARS,
  BALANCE_PARTITION_LEDGERS,
  countPartitionSlice,
  firstChangeDay,
  partitionOf,
  promotionSlice,
  recountPartition,
  writePartitionSet,
} from './account-rollups.job';
import { AggregateSetAborted } from './aggregate-sets';

describe('the constants', () => {
  it('are the values of the spec', () => {
    expect(ACCOUNT_PARTITION_ROWS_FLOOR).toBe(10_000);
    expect(ACCOUNT_ROLLUP_SLICE_ROWS).toBe(2_000_000);
    expect(BALANCE_PARTITION_LEDGERS).toBe(10_000_000);
  });
});

describe('ADDRESS_SLICE_CHARS', () => {
  it('is the 58 characters of the base58 alphabet, in code-point order and distinct', () => {
    expect(ADDRESS_SLICE_CHARS).toHaveLength(58);
    expect(ADDRESS_SLICE_CHARS.join('')).toBe('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    expect(new Set(ADDRESS_SLICE_CHARS).size).toBe(58);
    expect([...ADDRESS_SLICE_CHARS].sort()).toEqual([...ADDRESS_SLICE_CHARS]);
  });
});

describe('partitionOf', () => {
  it('is the partition of balance_changes a ledger is in (intDiv(ledger_index, 10000000))', () => {
    expect(partitionOf(0)).toBe(0);
    expect(partitionOf(9_999_999)).toBe(0);
    expect(partitionOf(10_000_000)).toBe(1);
    expect(partitionOf(19_999_999)).toBe(1);
    expect(partitionOf(20_000_000)).toBe(2);
  });
});

describe('promotionSlice', () => {
  it('is as many whole days as hold about 2,000,000 rows, ending at the through day', () => {
    const slice = promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 100_000 });
    expect(slice).toEqual({ fromDay: '2020-12-12', throughDay: '2020-12-31' });
    // 20 days, both ends included
    expect(
      (Date.parse(`${slice.throughDay}T00:00:00Z`) - Date.parse(`${slice.fromDay}T00:00:00Z`)) / UTC_DAY_MS + 1,
    ).toBe(20);
  });

  it('is one day when a day alone holds more than a slice', () => {
    expect(promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 5_000_000 })).toEqual({
      fromDay: '2020-12-31',
      throughDay: '2020-12-31',
    });
    // a day of exactly a slice is one day too
    expect(promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 2_000_000 })).toEqual({
      fromDay: '2020-12-31',
      throughDay: '2020-12-31',
    });
  });

  it('rounds the days down: 1,500,000 rows a day is one day, 600,000 is three', () => {
    expect(promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 1_500_000 }).fromDay).toBe(
      '2020-12-31',
    );
    expect(promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 600_000 }).fromDay).toBe(
      '2020-12-29',
    );
  });

  it('never starts before the first day', () => {
    expect(promotionSlice({ firstDay: '2020-12-25', throughDay: '2020-12-31', rowsPerDay: 100_000 })).toEqual({
      fromDay: '2020-12-25',
      throughDay: '2020-12-31',
    });
    expect(promotionSlice({ firstDay: '2020-12-31', throughDay: '2020-12-31', rowsPerDay: 1 })).toEqual({
      fromDay: '2020-12-31',
      throughDay: '2020-12-31',
    });
  });

  it('crosses months and years by the calendar, leap days included', () => {
    expect(promotionSlice({ firstDay: '2019-01-01', throughDay: '2020-03-02', rowsPerDay: 100_000 })).toEqual({
      fromDay: '2020-02-12',
      throughDay: '2020-03-02',
    });
    expect(promotionSlice({ firstDay: '2013-01-01', throughDay: '2015-01-10', rowsPerDay: 100_000 })).toEqual({
      fromDay: '2014-12-22',
      throughDay: '2015-01-10',
    });
  });

  it('takes the whole range when the rows of a day are unknown (0) rather than looping on an infinite slice', () => {
    expect(promotionSlice({ firstDay: '2020-01-01', throughDay: '2020-12-31', rowsPerDay: 0 })).toEqual({
      fromDay: '2020-01-01',
      throughDay: '2020-12-31',
    });
  });

  it('rejects a day that is not a day', () => {
    expect(() => promotionSlice({ firstDay: '2020-02-30', throughDay: '2020-12-31', rowsPerDay: 1 })).toThrow(
      RangeError,
    );
  });
});

/** A `ClickHouseService` that answers the slice reads with `slices(i)` and the version read with a fixed clock. */
function fakeService(slices: (i: number) => { account: string; n: string }[] = () => []): {
  ch: ClickHouseService;
  reads: { sql: string; params: Record<string, unknown> }[];
  inserts: { table: string; rows: unknown[] }[];
} {
  const reads: { sql: string; params: Record<string, unknown> }[] = [];
  const inserts: { table: string; rows: unknown[] }[] = [];
  const query = (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    if (sql.includes(`FROM ${Table.BalanceChanges}`)) {
      reads.push({ sql, params });
      return Promise.resolve(slices(reads.length - 1));
    }
    return Promise.resolve([{ newest: 0, now_ms: 1_760_000_000_000 }]);
  };
  const ch = {
    query,
    queryOne: async (sql: string, params: Record<string, unknown>) => (await query(sql, params))[0],
    insert: (table: string, rows: unknown[]) => {
      inserts.push({ table, rows });
      return Promise.resolve();
    },
  } as unknown as ClickHouseService;
  return { ch, reads, inserts };
}

describe('countPartitionSlice', () => {
  it('reads one slice of the partition: the key range of its character up to the next one, and writes nothing', async () => {
    const chars = [...ADDRESS_SLICE_CHARS];
    for (const i of [0, 1, 40, 57]) {
      const { ch, reads, inserts } = fakeService();
      expect(await countPartitionSlice(ch, 3, i)).toEqual([]);
      expect(reads).toHaveLength(1);
      expect(reads[0].params).toEqual({
        p_min: 30_000_000,
        p_max: 39_999_999,
        floor: 10_000,
        ...(i > 0 && { lo: `r${chars[i]}` }),
        ...(i < 57 && { hi: `r${chars[i + 1]}` }),
      });
      expect(reads[0].sql.includes('account >= {lo:String}')).toBe(i > 0);
      expect(reads[0].sql.includes('account < {hi:String}')).toBe(i < 57);
      expect(inserts).toEqual([]);
    }
  });

  it('returns the accounts the slice keeps, with their rows as numbers', async () => {
    const { ch } = fakeService(() => [
      { account: 'rBeta', n: '10000' },
      { account: 'rGamma', n: '55555555555' },
    ]);
    expect(await countPartitionSlice(ch, 1, 40)).toEqual([
      { account: 'rBeta', rows: 10_000 },
      { account: 'rGamma', rows: 55_555_555_555 },
    ]);
  });

  it('rejects a slice that is not one of the 58, before it reads', async () => {
    for (const slice of [-1, 58, 1.5, Number.NaN]) {
      const { ch, reads } = fakeService();
      await expect(countPartitionSlice(ch, 0, slice)).rejects.toBeInstanceOf(RangeError);
      expect(reads).toHaveLength(0);
    }
  });

  it('throws AggregateSetAborted before the read when the signal is aborted', async () => {
    const { ch, reads } = fakeService();
    const controller = new AbortController();
    controller.abort();
    await expect(countPartitionSlice(ch, 0, 5, { signal: controller.signal })).rejects.toBeInstanceOf(
      AggregateSetAborted,
    );
    expect(reads).toHaveLength(0);
  });
});

describe('writePartitionSet', () => {
  it('writes the accounts and the sentinel in one insert under one version, and returns how many accounts it wrote', async () => {
    const { ch, reads, inserts } = fakeService();
    const accounts = [
      { account: 'rAlpha', rows: 12_000 },
      { account: 'rBeta', rows: 10_000 },
    ];
    expect(await writePartitionSet(ch, 2, accounts)).toBe(2);
    expect(reads).toHaveLength(0);
    const version = 1_760_000_000_000;
    expect(inserts).toEqual([
      {
        table: Table.AccountPartitionRows,
        rows: [
          { partition: 2, account: 'rAlpha', rows: 12_000, version },
          { partition: 2, account: 'rBeta', rows: 10_000, version },
          { partition: 2, account: '', rows: 0, version },
        ],
      },
    ]);
  });

  it('writes the sentinel alone for no account', async () => {
    const { ch, inserts } = fakeService();
    expect(await writePartitionSet(ch, 0, [])).toBe(0);
    expect(inserts[0].rows).toEqual([{ partition: 0, account: '', rows: 0, version: 1_760_000_000_000 }]);
  });

  it('writes nothing when the signal is aborted', async () => {
    const { ch, inserts } = fakeService();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writePartitionSet(ch, 0, [{ account: 'rAlpha', rows: 12_000 }], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AggregateSetAborted);
    expect(inserts).toHaveLength(0);
  });
});

describe('recountPartition', () => {
  it('reads the partition in 58 slices, the first without a lower bound and the last without an upper one', async () => {
    const { ch, reads } = fakeService();
    await recountPartition(ch, 3);
    expect(reads).toHaveLength(58);
    const chars = [...ADDRESS_SLICE_CHARS];
    reads.forEach(({ sql, params }, i) => {
      expect(params).toEqual({
        p_min: 30_000_000,
        p_max: 39_999_999,
        floor: 10_000,
        ...(i > 0 && { lo: `r${chars[i]}` }),
        ...(i < 57 && { hi: `r${chars[i + 1]}` }),
      });
      expect(sql.includes('account >= {lo:String}')).toBe(i > 0);
      expect(sql.includes('account < {hi:String}')).toBe(i < 57);
      expect(sql).toContain('ledger_index BETWEEN {p_min:UInt32} AND {p_max:UInt32}');
      expect(sql).toContain('HAVING count() >= {floor:UInt64}');
    });
    expect(reads[0].params).not.toHaveProperty('lo');
    expect(reads[57].params).not.toHaveProperty('hi');
  });

  it('writes the accounts it keeps and the sentinel in one insert under one version, and returns how many it kept', async () => {
    const { ch, inserts } = fakeService((i) =>
      i === 0
        ? [{ account: 'rAlpha', n: '12000' }]
        : i === 40
          ? [
              { account: 'rBeta', n: '10000' },
              { account: 'rGamma', n: '55555555555' },
            ]
          : [],
    );
    expect(await recountPartition(ch, 1)).toBe(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(Table.AccountPartitionRows);
    const version = 1_760_000_000_000;
    expect(inserts[0].rows).toEqual([
      { partition: 1, account: 'rAlpha', rows: 12_000, version },
      { partition: 1, account: 'rBeta', rows: 10_000, version },
      { partition: 1, account: 'rGamma', rows: 55_555_555_555, version },
      { partition: 1, account: '', rows: 0, version },
    ]);
  });

  it('writes the sentinel alone for a partition with no heavy account: it has been counted, and has none', async () => {
    const { ch, inserts } = fakeService();
    expect(await recountPartition(ch, 0)).toBe(0);
    expect(inserts[0].rows).toEqual([{ partition: 0, account: '', rows: 0, version: 1_760_000_000_000 }]);
  });

  it('throws AggregateSetAborted before any read when the signal is aborted', async () => {
    const { ch, reads, inserts } = fakeService();
    const controller = new AbortController();
    controller.abort();
    await expect(recountPartition(ch, 0, { signal: controller.signal })).rejects.toBeInstanceOf(AggregateSetAborted);
    expect(reads).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('stops at the next slice after an abort and writes nothing', async () => {
    const controller = new AbortController();
    const { ch, reads, inserts } = fakeService((i) => {
      if (i === 9) controller.abort();
      return [{ account: 'rAlpha', n: '20000' }];
    });
    await expect(recountPartition(ch, 0, { signal: controller.signal })).rejects.toBeInstanceOf(AggregateSetAborted);
    expect(reads).toHaveLength(10);
    expect(inserts).toHaveLength(0);
  });

  it('writes nothing when the abort comes after the last slice', async () => {
    const controller = new AbortController();
    const { ch, inserts } = fakeService((i) => {
      if (i === 57) controller.abort();
      return [];
    });
    await expect(recountPartition(ch, 0, { signal: controller.signal })).rejects.toBeInstanceOf(AggregateSetAborted);
    expect(inserts).toHaveLength(0);
  });
});

describe('firstChangeDay', () => {
  it('is a key-ordered read of one row of the account, the UTC day of its close time', async () => {
    const calls: { sql: string; params: Record<string, unknown> }[] = [];
    const ch = {
      query: (sql: string, params: Record<string, unknown>) => {
        calls.push({ sql, params });
        return Promise.resolve([{ day: '2016-03-04' }]);
      },
    } as unknown as ClickHouseService;
    expect(await firstChangeDay(ch, 'rAlpha')).toBe('2016-03-04');
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ account: 'rAlpha' });
    expect(calls[0].sql).toContain("toString(toDate(close_time, 'UTC'))");
    expect(calls[0].sql).toContain('WHERE account = {account:String}');
    expect(calls[0].sql).toContain('ORDER BY account, ledger_index, tx_index, node_index');
    expect(calls[0].sql).toMatch(/LIMIT 1\s*$/);
  });

  it('is undefined for an account without a balance change', async () => {
    const ch = { query: () => Promise.resolve([]) } as unknown as ClickHouseService;
    expect(await firstChangeDay(ch, 'rNobody')).toBeUndefined();
  });
});

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { CHILD_TABLES } from './build-rows';
import { deleteLedgerRange, deleteLedgersAbove, LEDGER_KEYED_TABLES } from './ingest-state';

const P6 = 1_000_000;
const P7 = 10_000_000;

const AMM_LEDGER_TABLES = [
  Table.AmmPoolStates,
  Table.AmmPoolTouches,
  Table.AmmLiquidity,
  Table.AccountAmmLiquidity,
  Table.AmmGovernance,
];

interface Delete {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * A ClickHouseService that only records: `system.parts` answers with the partition ids `partitionsOf` gives for the
 * table asked about, and every DELETE is kept.
 */
function recordingClickHouse(partitionsOf: (table: string) => string[]): { ch: ClickHouseService; deletes: Delete[] } {
  const deletes: Delete[] = [];
  const ch = {
    query: async (_sql: string, params: { table: string }) =>
      partitionsOf(params.table).map((partition) => ({ partition })),
    command: async (sql: string, params: Record<string, unknown> = {}) => {
      deletes.push({ sql, params });
    },
  } as unknown as ClickHouseService;
  return { ch, deletes };
}

/** Every table has the partitions 0 to 29, whatever its partition size: enough for any range the tests delete. */
const allPartitions = (): string[] => Array.from({ length: 30 }, (_, i) => String(i));

const deletedFrom = (deletes: Delete[], table: Table): Delete[] =>
  deletes.filter((d) => new RegExp(`^\\s*DELETE FROM ${table}\\b`).test(d.sql));

describe('LEDGER_KEYED_TABLES', () => {
  it('lists the five AMM ledger tables, partitioned by intDiv(ledger_index, 10000000) but amm_pool_touches by a million', () => {
    for (const table of AMM_LEDGER_TABLES) {
      const partitionSize = table === Table.AmmPoolTouches ? P6 : P7;
      expect(LEDGER_KEYED_TABLES.filter((t) => t.table === table)).toEqual([{ table, partitionSize }]);
    }
  });

  it('does not list the AMM aggregates: a ledger rewrite must not touch them', () => {
    const tables = LEDGER_KEYED_TABLES.map((t) => t.table);
    expect(tables).not.toContain(Table.AmmPools);
    expect(tables).not.toContain(Table.AmmDaily);
  });

  it('lists every table once and keeps the commit marker first', () => {
    const tables = LEDGER_KEYED_TABLES.map((t) => t.table);
    expect(new Set(tables).size).toBe(tables.length);
    expect(tables[0]).toBe(Table.Ledgers);
  });

  it('is the commit marker, ledger_by_hash and every table the ledger writer fills (CHILD_TABLES), and nothing else', () => {
    const tables = LEDGER_KEYED_TABLES.map((t) => t.table);
    expect(new Set(tables)).toEqual(
      new Set([Table.Ledgers, Table.LedgerByHash, ...CHILD_TABLES.map(([table]) => table)]),
    );
    expect(tables).toHaveLength(2 + CHILD_TABLES.length);
  });
});

describe('deleteLedgerRange covers the AMM ledger tables', () => {
  it('deletes the range from each of them, in the partitions that can hold it (P7; P6 for the touches)', async () => {
    const { ch, deletes } = recordingClickHouse(allPartitions);

    // Ledgers 25,000,000 to 26,000,000 lie in P7 partition 2 only, and in P6 partitions 25 and 26.
    await deleteLedgerRange(ch, 25_000_000, 26_000_000);

    for (const table of AMM_LEDGER_TABLES) {
      const mine = deletedFrom(deletes, table);
      const partitions = table === Table.AmmPoolTouches ? ['25', '26'] : ['2'];
      expect(mine.map((d) => d.params.partition)).toEqual(partitions);
      for (const d of mine) {
        expect(d.sql).toContain('IN PARTITION ID {partition:String}');
        expect(d.sql).toContain('ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}');
        expect(d.params).toEqual({ from: 25_000_000, to: 26_000_000, partition: d.params.partition });
      }
    }
  });

  it('visits every partition a range spans, and none beyond', async () => {
    const { ch, deletes } = recordingClickHouse(allPartitions);

    await deleteLedgerRange(ch, 9_999_999, 20_000_000);

    for (const table of AMM_LEDGER_TABLES) {
      const partitions =
        table === Table.AmmPoolTouches ? Array.from({ length: 12 }, (_, i) => String(i + 9)) : ['0', '1', '2'];
      expect(deletedFrom(deletes, table).map((d) => d.params.partition)).toEqual(partitions);
    }
  });

  it('asks system.parts about the AMM tables, so only partitions that exist are visited', async () => {
    const asked: string[] = [];
    const { ch, deletes } = recordingClickHouse((table) => {
      asked.push(table);
      return table === Table.AmmLiquidity ? ['1'] : [];
    });

    await deleteLedgerRange(ch, 0, 99_999_999);

    expect(asked).toEqual(expect.arrayContaining(AMM_LEDGER_TABLES));
    expect(deletedFrom(deletes, Table.AmmLiquidity).map((d) => d.params.partition)).toEqual(['1']);
    expect(deletedFrom(deletes, Table.AmmPoolStates)).toEqual([]);
    expect(deletedFrom(deletes, Table.AmmGovernance)).toEqual([]);
  });

  it('never deletes from the AMM aggregates', async () => {
    const { ch, deletes } = recordingClickHouse(allPartitions);

    await deleteLedgerRange(ch, 0, 99_999_999);

    expect(deletedFrom(deletes, Table.AmmPools)).toEqual([]);
    expect(deletedFrom(deletes, Table.AmmDaily)).toEqual([]);
  });
});

describe('deleteLedgersAbove covers the AMM ledger tables', () => {
  it('deletes everything above the checkpoint from each of them, partition by partition from the checkpoint partition', async () => {
    const { ch, deletes } = recordingClickHouse(allPartitions);

    await deleteLedgersAbove(ch, 12_345_678);

    for (const table of AMM_LEDGER_TABLES) {
      const mine = deletedFrom(deletes, table);
      // from the partition of the checkpoint: P7 partition 1, P6 partition 12
      expect(mine.map((d) => d.params.partition)).toEqual(
        allPartitions().slice(table === Table.AmmPoolTouches ? 12 : 1),
      );
      for (const d of mine) {
        expect(d.sql).toContain('ledger_index > {checkpoint:UInt32}');
        expect(d.params.checkpoint).toBe(12_345_678);
      }
    }
  });
});

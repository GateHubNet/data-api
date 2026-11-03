import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { rebuildMptIssuances } from './mpt-state.job';

const ID = '0000012A9AB7E5A9F3DE1D7F1E8B2C4D5F6A7B8C9D0E1F20';

describe('rebuildMptIssuances', () => {
  it('rebuilds an issuance with more touched holders than a call can take as arguments', async () => {
    const touched = Array.from({ length: 200_000 }, (_, i) => ({ id: ID, who: `r${i}`, newest: '90' }));
    const read = new Set<string>();
    const query = jest.fn(async (sql: string, params?: { holders?: string[] }) => {
      if (sql.includes(`FROM ${Table.MptTouches}`) && sql.includes('GROUP BY id, who')) return touched;
      for (const holder of params?.holders ?? []) read.add(holder);
      return [];
    });
    const ch = {
      query,
      queryOne: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    } as unknown as ClickHouseService;

    await rebuildMptIssuances(ch, [{ id: ID, holders: [] }], 100);

    expect(read.size).toBe(touched.length);
  });
});

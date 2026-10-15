import { createClient } from '@clickhouse/client';
import { ClickHouseConfig } from './clickhouse.config';
import { ClickHouseService } from './clickhouse.service';

jest.mock('@clickhouse/client', () => ({ createClient: jest.fn() }));

const config: ClickHouseConfig = {
  url: 'http://ch:8123',
  username: 'u',
  password: 'p',
  database: 'xrpl',
  requestTimeout: 1000,
  maxOpenConnections: 2,
  maxExecutionTime: 30,
  maxQueryMemoryBytes: 2048,
};

describe('ClickHouseService', () => {
  const client = { query: jest.fn(), insert: jest.fn(), command: jest.fn(), ping: jest.fn(), close: jest.fn() };
  let service: ClickHouseService;

  beforeEach(() => {
    jest.resetAllMocks();
    (createClient as jest.Mock).mockReturnValue(client);
    client.query.mockResolvedValue({ json: async () => [{ a: 1 }] });
    service = new ClickHouseService(config);
  });

  it('does not set global insert_deduplicate / async_insert settings on the client', () => {
    const options = (createClient as jest.Mock).mock.calls[0][0];
    expect(options).toMatchObject({ url: 'http://ch:8123', database: 'xrpl' });
    expect(options.clickhouse_settings ?? {}).not.toHaveProperty('insert_deduplicate');
    expect(options.clickhouse_settings ?? {}).not.toHaveProperty('async_insert');
  });

  describe('insert', () => {
    it('always sends async_insert: 0, and insert_deduplication_token only when a dedupToken is given', async () => {
      await service.insert('t', [{ a: 1 }], { dedupToken: 'run1:t:1-2' });
      expect(client.insert).toHaveBeenLastCalledWith({
        table: 't',
        values: [{ a: 1 }],
        format: 'JSONEachRow',
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: 'run1:t:1-2' },
      });

      await service.insert('t', [{ a: 1 }]);
      expect(client.insert.mock.calls[1][0].clickhouse_settings).toEqual({ async_insert: 0 });
    });

    it('sends query_id only when a queryId is given', async () => {
      await service.insert('t', [{ a: 1 }], { dedupToken: 'tok', queryId: 'run1:t:1-2:0' });
      expect(client.insert).toHaveBeenLastCalledWith({
        table: 't',
        values: [{ a: 1 }],
        format: 'JSONEachRow',
        query_id: 'run1:t:1-2:0',
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: 'tok' },
      });

      await service.insert('t', [{ a: 1 }]);
      expect(client.insert.mock.calls[1][0]).not.toHaveProperty('query_id');
    });

    it('skips empty batches', async () => {
      await service.insert('t', [], { dedupToken: 'x' });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('accepts interface-typed rows', async () => {
      interface Row {
        a: number;
      }
      const rows: Row[] = [{ a: 1 }];
      await service.insert<Row>('t', rows);
      expect(client.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('query', () => {
    it('binds params, applies the safety guards and merges per-call settings over them', async () => {
      await service.query('SELECT {x:UInt8}', { x: 1 });
      expect(client.query).toHaveBeenLastCalledWith({
        query: 'SELECT {x:UInt8}',
        query_params: { x: 1 },
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 30, max_memory_usage: '2048' },
      });

      await service.query('SELECT 1', {}, { max_execution_time: 120, readonly: '1' });
      expect(client.query.mock.calls[1][0].clickhouse_settings).toEqual({
        max_execution_time: 120,
        max_memory_usage: '2048',
        readonly: '1',
      });
    });

    it('queryOne returns the first row and forwards settings', async () => {
      client.query.mockResolvedValue({ json: async () => [{ a: 1 }, { a: 2 }] });
      await expect(service.queryOne('SELECT 1', {}, { max_execution_time: 5 })).resolves.toEqual({ a: 1 });
      expect(client.query.mock.calls[0][0].clickhouse_settings.max_execution_time).toBe(5);

      client.query.mockResolvedValue({ json: async () => [] });
      await expect(service.queryOne('SELECT 1')).resolves.toBeUndefined();
    });
  });

  it('command sends query_id and merges settings over wait_end_of_query when given', async () => {
    await service.command(
      'DELETE FROM t WHERE k > {k:UInt32}',
      { k: 5 },
      {
        queryId: 'p:delete:t:1',
        settings: { lightweight_deletes_sync: '2' },
      },
    );
    expect(client.command).toHaveBeenLastCalledWith({
      query: 'DELETE FROM t WHERE k > {k:UInt32}',
      query_params: { k: 5 },
      query_id: 'p:delete:t:1',
      clickhouse_settings: { wait_end_of_query: 1, lightweight_deletes_sync: '2' },
    });
  });

  it('command binds params and waits for the end of the query', async () => {
    await service.command('DELETE FROM t WHERE k > {k:UInt32}', { k: 5 });
    expect(client.command).toHaveBeenLastCalledWith({
      query: 'DELETE FROM t WHERE k > {k:UInt32}',
      query_params: { k: 5 },
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  });
});

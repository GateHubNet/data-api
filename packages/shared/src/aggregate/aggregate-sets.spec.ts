import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { AggregateSetAborted, newestLedgerClose, nextSetVersion, throwIfSetAborted } from './aggregate-sets';

/** A `ClickHouseService` whose `query` answers with `rows` and remembers what it was asked. */
function fakeService(rows: unknown[]): { ch: ClickHouseService; calls: { sql: string; params: unknown }[] } {
  const calls: { sql: string; params: unknown }[] = [];
  const query = (sql: string, params: unknown): Promise<unknown[]> => {
    calls.push({ sql, params });
    return Promise.resolve(rows);
  };
  const ch = {
    query,
    queryOne: async (sql: string, params: unknown) => (await query(sql, params))[0],
  } as unknown as ClickHouseService;
  return { ch, calls };
}

describe('nextSetVersion', () => {
  const where = "currency = '' AND issuer = '' AND day = {day:Date}";
  const params = { day: '2016-06-15' };

  it('is one past the newest version of the set when that is ahead of the clock', async () => {
    const { ch } = fakeService([{ newest: 5000, now_ms: 4000 }]);
    expect(await nextSetVersion(ch, Table.NativeRatesDaily, where, params)).toBe(5001);
  });

  it('is the clock in milliseconds for a set that does not exist yet (the newest of no row is 0), UInt64 text included', async () => {
    expect(
      await nextSetVersion(fakeService([{ newest: 0, now_ms: 9 }]).ch, Table.NativeRatesDaily, where, params),
    ).toBe(9);
    expect(
      await nextSetVersion(
        fakeService([{ newest: '1760000000000', now_ms: '1760000000500' }]).ch,
        Table.NativeRatesDaily,
        where,
        params,
      ),
    ).toBe(1_760_000_000_500);
  });

  it('asks for the newest version and the ClickHouse clock of the table and the set, with the values bound', async () => {
    const { ch, calls } = fakeService([{ newest: 0, now_ms: 9 }]);
    await nextSetVersion(ch, Table.NativeRatesDaily, where, params);
    expect(calls).toEqual([
      {
        sql: `SELECT toUInt64(max(version)) AS newest, toUnixTimestamp64Milli(now64(3)) AS now_ms FROM native_rates_daily WHERE ${where}`,
        params,
      },
    ]);
  });
});

describe('throwIfSetAborted', () => {
  it('throws AggregateSetAborted for an aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfSetAborted(controller.signal)).toThrow(AggregateSetAborted);
    try {
      throwIfSetAborted(controller.signal);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AggregateSetAborted');
    }
  });

  it('does nothing for a signal that is not aborted, and for none', () => {
    expect(() => throwIfSetAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfSetAborted(undefined)).not.toThrow();
    expect(() => throwIfSetAborted()).not.toThrow();
  });
});

describe('newestLedgerClose', () => {
  it('is the close time of the highest ledger, in unix seconds, UInt32 text included', async () => {
    expect(await newestLedgerClose(fakeService([{ closed: 1_465_992_000 }]).ch)).toBe(1_465_992_000);
    expect(await newestLedgerClose(fakeService([{ closed: '1465992000' }]).ch)).toBe(1_465_992_000);
  });

  it('is undefined when there is no ledger, and reads the end of the primary key of ledgers', async () => {
    const { ch, calls } = fakeService([]);
    expect(await newestLedgerClose(ch)).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(
      'SELECT toUnixTimestamp(close_time) AS closed FROM ledgers ORDER BY ledger_index DESC LIMIT 1',
    );
  });
});

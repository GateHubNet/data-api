import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { DistinctPage, distinctPageSql, readDistinctPage, readGrowingCap } from './distinct-page';

/** A ClickHouseService whose `query` answers from `answer(params)` and records every call. */
function fakeClickHouse(answer: (params: Record<string, unknown>) => Record<string, unknown>[]) {
  const calls: { sql: string; params: Record<string, unknown>; settings: unknown }[] = [];
  const ch = {
    query: jest.fn(async (sql: string, params: Record<string, unknown> = {}, settings: unknown = {}) => {
      calls.push({ sql, params, settings });
      return answer(params);
    }),
  } as unknown as ClickHouseService;
  return { ch, calls };
}

const PAGE: DistinctPage = {
  columns: 'ledger_index, tx_index',
  table: Table.AccountTransactions,
  where: ['account = {account:String}', 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'],
  orderBy: ['account', 'ledger_index', 'tx_index'],
  unique: ['ledger_index', 'tx_index'],
  descending: false,
  params: { account: 'rA', min: 1, max: 9 },
  limit: 3,
};

/** `n` rows as the outer query returns them: the key, and how many rows the inner read had (`count() OVER ()`). */
const rows = (n: number, read: number) =>
  Array.from({ length: n }, (_, i) => ({ ledger_index: 5, tx_index: i, distinct_page_read: String(read) }));

describe('distinctPageSql', () => {
  const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

  it('reads the whole key with a plain LIMIT inside, and dedupes and cuts the page outside it', () => {
    expect(squash(distinctPageSql(PAGE))).toBe(
      squash(`SELECT *, count() OVER () AS distinct_page_read
                FROM (SELECT ledger_index, tx_index
                        FROM account_transactions
                       WHERE account = {account:String} AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                       ORDER BY account ASC, ledger_index ASC, tx_index ASC
                       LIMIT {distinct_page_cap:UInt32})
               ORDER BY ledger_index ASC, tx_index ASC
               LIMIT 1 BY ledger_index, tx_index
               LIMIT {distinct_page_limit:UInt32}`),
    );
  });

  it('descending reverses both orders; no condition leaves out the WHERE', () => {
    const sql = squash(distinctPageSql({ ...PAGE, where: [], descending: true }));
    expect(sql).toContain('FROM account_transactions ORDER BY account DESC, ledger_index DESC, tx_index DESC LIMIT');
    expect(sql).toContain(') ORDER BY ledger_index DESC, tx_index DESC LIMIT 1 BY ledger_index, tx_index LIMIT');
    expect(sql).not.toContain('WHERE');
  });

  it('the LIMIT BY is never in the same SELECT as the read of the table', () => {
    const inner = /FROM \((SELECT[\s\S]*?)\)\s*ORDER BY/.exec(distinctPageSql(PAGE))?.[1] as string;
    expect(inner).toContain(`FROM ${Table.AccountTransactions}`);
    expect(inner).not.toContain('LIMIT 1 BY');
    expect(inner).toMatch(/ORDER BY account ASC, ledger_index ASC, tx_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}$/);
  });
});

describe('readDistinctPage', () => {
  it('one read when the page is full: the rows without the count of the inner read', async () => {
    const { ch, calls } = fakeClickHouse(() => rows(3, 6));
    const page = await readDistinctPage(ch, PAGE);
    expect(page).toEqual([
      { ledger_index: 5, tx_index: 0 },
      { ledger_index: 5, tx_index: 1 },
      { ledger_index: 5, tx_index: 2 },
    ]);
    expect(calls).toHaveLength(1);
    // the caller's params and the two of the read; the inner read has room for as many duplicates as rows
    expect(calls[0].params).toEqual({
      account: 'rA',
      min: 1,
      max: 9,
      distinct_page_limit: 3,
      distinct_page_cap: 3 + 16,
    });
  });

  it('the slack is the page itself once the page is larger than the minimum', async () => {
    const { ch, calls } = fakeClickHouse(() => []);
    await readDistinctPage(ch, { ...PAGE, limit: 201 });
    expect(calls[0].params).toMatchObject({ distinct_page_limit: 201, distinct_page_cap: 402 });
  });

  it('one read when the page is short because the range ended (the inner read was not capped)', async () => {
    const { ch, calls } = fakeClickHouse(() => rows(2, 5));
    expect(await readDistinctPage(ch, PAGE)).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('nothing in the range: one read, no rows', async () => {
    const { ch, calls } = fakeClickHouse(() => []);
    expect(await readDistinctPage(ch, PAGE)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads again with four times the slack while duplicates took all of it', async () => {
    // caps 19, 67, 259: the duplicates fill the first two, the third read is not capped
    const { ch, calls } = fakeClickHouse((params) => {
      const cap = params.distinct_page_cap as number;
      return cap < 200 ? rows(2, cap) : rows(3, 250);
    });
    expect(await readDistinctPage(ch, PAGE)).toHaveLength(3);
    expect(calls.map((c) => c.params.distinct_page_cap)).toEqual([19, 67, 259]);
    expect(calls.every((c) => c.params.distinct_page_limit === 3)).toBe(true);
  });

  it('stops when a capped read is short but the cap cannot grow (the last value of a UInt32)', async () => {
    const { ch, calls } = fakeClickHouse((params) => rows(1, params.distinct_page_cap as number));
    const page = await readDistinctPage(ch, { ...PAGE, limit: 1_000_000_000 });
    expect(page).toHaveLength(1);
    expect(calls.map((c) => c.params.distinct_page_cap)).toEqual([2_000_000_000, 4_294_967_295]);
  });

  it('passes the settings on', async () => {
    const { ch, calls } = fakeClickHouse(() => []);
    await readDistinctPage(ch, { ...PAGE, settings: { max_threads: 1 } });
    expect(calls[0].settings).toEqual({ max_threads: 1 });
  });
});

describe('readGrowingCap', () => {
  it('starts with at least minRoom of room, and grows it four times while capped reads come out short', async () => {
    const caps: number[] = [];
    const result = await readGrowingCap(
      6,
      async (cap) => {
        caps.push(cap);
        return { result: cap, found: cap < 100_000 ? 2 : 6, read: cap };
      },
      8192,
    );
    expect(caps).toEqual([6 + 8192, 6 + 4 * 8192, 6 + 16 * 8192]);
    expect(result).toBe(6 + 16 * 8192);
  });

  it('one read when it was not capped, however little it found', async () => {
    const read = jest.fn(async (cap: number) => ({ result: 'done', found: 0, read: cap - 1 }));
    expect(await readGrowingCap(10, read)).toBe('done');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

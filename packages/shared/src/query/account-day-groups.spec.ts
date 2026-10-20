import { ClickHouseService } from '../clickhouse/clickhouse.service';
import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  AccountDayGroups,
  DAY_GROUP_COLUMNS,
  DAY_GROUPS_EPOCH,
  DayGroupFamily,
  LedgerRangeOf,
  mergedExactSum,
  rawDayGroupsSql,
  rollupCoverage,
  RollupCoverage,
} from './account-day-groups';

const FAMILIES: DayGroupFamily[] = ['lines', 'txs', 'trades'];
const ACCOUNT = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

/** The two ranges of the OR form of a raw read, as the brief spells them. */
const TWO_RANGES =
  'ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32} OR ledger_index BETWEEN {dg_min1:UInt32} AND {dg_max1:UInt32}';

/** The text of a statement with its white space squeezed, so that the layout of a template is not what a test pins. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ');

describe('constants', () => {
  it('say which version of the rollups is current and where a read of everything up to starts', () => {
    expect(ACCOUNT_ROLLUP_CONFIG_VERSION).toBe(1);
    expect(DAY_GROUPS_EPOCH).toBe('2000-01-01');
  });

  it('list the columns of every family, in the order of the brief', () => {
    expect(DAY_GROUP_COLUMNS.lines).toEqual([
      'day',
      'currency',
      'counterparty',
      'change_type',
      'owes',
      'count',
      'in_sum',
      'out_sum',
      'unfit',
      'in_sum_f',
      'out_sum_f',
      'end_balance',
    ]);
    expect(DAY_GROUP_COLUMNS.txs).toEqual(['day', 'tx_type', 'result', 'count']);
    expect(DAY_GROUP_COLUMNS.trades).toEqual([
      'day',
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'count',
      'base_sum',
      'counter_sum',
      'bought_sum',
      'sold_sum',
      'bought_counter_sum',
      'sold_counter_sum',
      'unfit',
      'base_sum_f',
      'counter_sum_f',
      'bought_sum_f',
      'sold_sum_f',
      'bought_counter_sum_f',
      'sold_counter_sum_f',
    ]);
  });
});

describe('mergedExactSum', () => {
  it('sums a column of exact text as a Decimal256(30), 0 when no row has an exact term', () => {
    expect(mergedExactSum('in_sum')).toBe("ifNull(toString(sum(toDecimal256OrNull(in_sum, 30))), '0')");
  });
});

describe('rawDayGroupsSql', () => {
  it.each(FAMILIES)('%s: a key range of one account, each row once, no FINAL', (family) => {
    const sql = flat(rawDayGroupsSql(family, { accounts: 'one', ranges: 1 }));
    expect(sql).toContain('account = {dg_account:String}');
    expect(sql).toContain('(ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32})');
    expect(sql).not.toContain('dg_min1');
    expect(sql).not.toContain('dg_accounts');
    expect(sql).toMatch(/ORDER BY account, ledger_index, tx_index(, node_index)? LIMIT 1 BY ledger_index, tx_index/);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it.each(FAMILIES)('%s: two ranges are an OR in one condition', (family) => {
    const sql = flat(rawDayGroupsSql(family, { accounts: 'one', ranges: 2 }));
    expect(sql).toContain(`(${TWO_RANGES})`);
  });

  it.each(FAMILIES)('%s: many accounts read an array, keep the account first and key the rows by it', (family) => {
    const sql = flat(rawDayGroupsSql(family, { accounts: 'many', ranges: 1 }));
    expect(sql).toContain('account IN {dg_accounts:Array(String)}');
    expect(sql).not.toContain('{dg_account:String}');
    expect(sql).toMatch(/LIMIT 1 BY account, ledger_index, tx_index/);
    expect(sql).toMatch(/^SELECT account, (toDate\(close_time, 'UTC'\) AS )?day, /);
  });

  it('lines: the end balance is the last of the line and day, over every change type of it', () => {
    const one = flat(rawDayGroupsSql('lines', { accounts: 'one', ranges: 1 }));
    expect(one).toContain('OVER (PARTITION BY day, currency, counterparty) AS end_balance');
    expect(one).toContain('GROUP BY day, currency, counterparty, change_type, owes');
    expect(one).toContain('abs(toFloat64OrZero(amount_change)) < 1e36');
    const many = flat(rawDayGroupsSql('lines', { accounts: 'many', ranges: 1 }));
    expect(many).toContain('OVER (PARTITION BY account, day, currency, counterparty) AS end_balance');
    expect(many).toContain('GROUP BY account, day, currency, counterparty, change_type, owes');
  });

  it('txs: only the transactions the account sent', () => {
    expect(flat(rawDayGroupsSql('txs', { accounts: 'one', ranges: 1 }))).toContain('is_initiator = 1');
  });

  it('trades: the buyer and the seller are each side of the account, with no dust condition', () => {
    const sql = flat(rawDayGroupsSql('trades', { accounts: 'one', ranges: 1 }));
    expect(sql).toContain('buyer = account AS bought');
    expect(sql).toContain('seller = account AS sold');
    expect(sql).not.toContain('0.0005');
  });
});

describe('rollupCoverage', () => {
  const rowsOf = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue(rows) }) as unknown as ClickHouseService;

  it('is the days of the newest state row of the account when it is of the current config version and has both days', async () => {
    const ch = rowsOf([{ rolled_from: '2020-03-01', rolled_through: '2020-06-30' }]);
    await expect(rollupCoverage(ch, ACCOUNT)).resolves.toEqual({ from: '2020-03-01', through: '2020-06-30' });
    const [sql, params] = (ch.query as jest.Mock).mock.calls[0];
    expect(params).toEqual({ account: ACCOUNT, configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION });
    // the newest row decides first, then its version and its days: an older row with coverage does not come back
    const text = flat(sql);
    expect(text.indexOf('LIMIT 1')).toBeLessThan(text.indexOf('config_version = {configVersion:UInt32}'));
    expect(text).toContain('rolled_from IS NOT NULL AND rolled_through IS NOT NULL');
    expect(text).not.toMatch(/\bFINAL\b/i);
  });

  it('is undefined when no row is left', async () => {
    await expect(rollupCoverage(rowsOf([]), ACCOUNT)).resolves.toBeUndefined();
  });

  it('is undefined for days that run backwards', async () => {
    const ch = rowsOf([{ rolled_from: '2020-07-01', rolled_through: '2020-06-30' }]);
    await expect(rollupCoverage(ch, ACCOUNT)).resolves.toBeUndefined();
  });
});

describe('AccountDayGroups.source', () => {
  const ch = {} as ClickHouseService;
  const WINDOW = ['2020-01-01', '2020-12-31'] as const;

  /** A fake `ranges`: the ledger index of a time is its day in the year 2020, so a range is easy to read. */
  function fakeRanges(missing: string[] = []): jest.Mock<ReturnType<LedgerRangeOf>, Parameters<LedgerRangeOf>> {
    return jest.fn(async (from: Date, toExclusive: Date) => {
      if (missing.includes(from.toISOString().slice(0, 10))) return null;
      const index = (d: Date): number => Math.round((d.getTime() - Date.UTC(2019, 11, 31)) / 86_400_000);
      return { min: 1000 * index(from), max: 1000 * index(toExclusive) - 1 };
    });
  }

  const groups = (ranges: LedgerRangeOf, coverage?: RollupCoverage) =>
    new AccountDayGroups(ch, ranges, async () => coverage);

  it('rollup days where they cover the window, and a raw range on each side of them', async () => {
    const ranges = fakeRanges();
    const source = await groups(ranges, { from: '2020-03-01', through: '2020-06-30' }).source(
      'lines',
      ACCOUNT,
      ...WINDOW,
    );

    expect(ranges.mock.calls.map(([from, to]) => [from.toISOString(), to.toISOString()])).toEqual([
      ['2020-01-01T00:00:00.000Z', '2020-03-01T00:00:00.000Z'],
      ['2020-07-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'],
    ]);
    expect(source?.sources).toEqual(['raw', 'rollup']);
    // 2020-01-01 is day 1 and 2020-03-01 is day 61 (2020 is a leap year): [1, 61) and [183, 367)
    expect(source?.params).toEqual({
      dg_account: ACCOUNT,
      dg_from: '2020-03-01',
      dg_through: '2020-06-30',
      dg_min0: 1000,
      dg_max0: 60_999,
      dg_min1: 183_000,
      dg_max1: 366_999,
    });
    const sql = flat(source?.sql ?? '');
    expect(sql).toContain(TWO_RANGES);
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('FROM account_lines_daily');
    expect(sql).toContain('FROM balance_changes');
    expect(sql).toContain('day BETWEEN {dg_from:Date} AND {dg_through:Date}');
  });

  it('a coverage outside the window gives the raw read only, over the whole window', async () => {
    const ranges = fakeRanges();
    const source = await groups(ranges, { from: '2021-01-01', through: '2021-06-30' }).source(
      'txs',
      ACCOUNT,
      ...WINDOW,
    );

    expect(ranges).toHaveBeenCalledTimes(1);
    expect(ranges.mock.calls[0].map((d) => d.toISOString())).toEqual([
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    ]);
    expect(source?.sources).toEqual(['raw']);
    expect(source?.params).toEqual({ dg_account: ACCOUNT, dg_min0: 1000, dg_max0: 366_999 });
    const sql = flat(source?.sql ?? '');
    expect(sql).toContain('FROM account_transactions');
    expect(sql).not.toContain('UNION');
    expect(sql).not.toContain('account_tx_daily');
    expect(sql).not.toContain('dg_min1');
  });

  it('no coverage at all is the raw read as well', async () => {
    const source = await groups(fakeRanges()).source('trades', ACCOUNT, ...WINDOW);
    expect(source?.sources).toEqual(['raw']);
    expect(flat(source?.sql ?? '')).toContain('FROM account_exchanges');
  });

  it('a coverage that holds the whole window gives the rollup only, and resolves no range', async () => {
    const ranges = fakeRanges();
    const source = await groups(ranges, { from: '2019-06-01', through: '2021-03-31' }).source(
      'trades',
      ACCOUNT,
      ...WINDOW,
    );

    expect(ranges).not.toHaveBeenCalled();
    expect(source?.sources).toEqual(['rollup']);
    // the days read are those of the window, not those of the coverage
    expect(source?.params).toEqual({ dg_account: ACCOUNT, dg_from: '2020-01-01', dg_through: '2020-12-31' });
    const sql = flat(source?.sql ?? '');
    expect(sql).toContain('FROM account_trades_daily');
    expect(sql).not.toContain('balance_changes');
    expect(sql).not.toContain('account_exchanges');
    expect(sql).not.toContain('UNION');
  });

  it('a coverage that starts inside the window leaves a raw range after it only, and one that ends inside, before it only', async () => {
    const early = fakeRanges();
    const startsInside = await groups(early, { from: '2020-03-01', through: '2021-03-31' }).source(
      'lines',
      ACCOUNT,
      ...WINDOW,
    );
    expect(early.mock.calls.map(([from, to]) => [from.toISOString(), to.toISOString()])).toEqual([
      ['2020-01-01T00:00:00.000Z', '2020-03-01T00:00:00.000Z'],
    ]);
    expect(startsInside?.sources).toEqual(['raw', 'rollup']);
    expect(startsInside?.params).toMatchObject({ dg_from: '2020-03-01', dg_through: '2020-12-31', dg_min0: 1000 });
    expect(startsInside?.params).not.toHaveProperty('dg_min1');

    const late = fakeRanges();
    const endsInside = await groups(late, { from: '2019-03-01', through: '2020-06-30' }).source(
      'lines',
      ACCOUNT,
      ...WINDOW,
    );
    expect(late.mock.calls.map(([from, to]) => [from.toISOString(), to.toISOString()])).toEqual([
      ['2020-07-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'],
    ]);
    expect(endsInside?.params).toMatchObject({ dg_from: '2020-01-01', dg_through: '2020-06-30', dg_min0: 183_000 });
  });

  it('a raw part without ledgers is dropped: the other one is the only range', async () => {
    const source = await groups(fakeRanges(['2020-01-01']), { from: '2020-03-01', through: '2020-06-30' }).source(
      'lines',
      ACCOUNT,
      ...WINDOW,
    );
    expect(source?.sources).toEqual(['raw', 'rollup']);
    expect(source?.params).toEqual({
      dg_account: ACCOUNT,
      dg_from: '2020-03-01',
      dg_through: '2020-06-30',
      dg_min0: 183_000,
      dg_max0: 366_999,
    });
    const sql = flat(source?.sql ?? '');
    expect(sql).toContain('(ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32})');
    expect(sql).not.toContain('dg_min1');

    // both dropped: the rollup alone
    const none = await groups(fakeRanges(['2020-01-01', '2020-07-01']), {
      from: '2020-03-01',
      through: '2020-06-30',
    }).source('lines', ACCOUNT, ...WINDOW);
    expect(none?.sources).toEqual(['rollup']);
    expect(none?.params).toEqual({ dg_account: ACCOUNT, dg_from: '2020-03-01', dg_through: '2020-06-30' });
  });

  it('nothing at all gives null: no coverage and no ledgers, or a window that runs backwards', async () => {
    await expect(groups(fakeRanges(['2020-01-01'])).source('lines', ACCOUNT, ...WINDOW)).resolves.toBeNull();
    await expect(
      groups(fakeRanges(['2020-01-01']), { from: '2021-01-01', through: '2021-02-01' }).source(
        'lines',
        ACCOUNT,
        ...WINDOW,
      ),
    ).resolves.toBeNull();
    const ranges = fakeRanges();
    await expect(groups(ranges).source('lines', ACCOUNT, '2020-12-31', '2020-01-01')).resolves.toBeNull();
    expect(ranges).not.toHaveBeenCalled();
  });

  it('one day is a window as well', async () => {
    const ranges = fakeRanges();
    const source = await groups(ranges).source('lines', ACCOUNT, '2020-02-29', '2020-02-29');
    expect(ranges.mock.calls[0].map((d) => d.toISOString())).toEqual([
      '2020-02-29T00:00:00.000Z',
      '2020-03-01T00:00:00.000Z',
    ]);
    expect(source?.sources).toEqual(['raw']);
  });

  it('asks the coverage of the account it reads, and says no to a day that is none', async () => {
    const coverageOf = jest.fn().mockResolvedValue(undefined);
    const dg = new AccountDayGroups(ch, fakeRanges(), coverageOf);
    await dg.source('lines', ACCOUNT, ...WINDOW);
    expect(coverageOf).toHaveBeenCalledWith(ACCOUNT);
    await expect(dg.source('lines', ACCOUNT, '2020-02-30', '2020-03-01')).rejects.toThrow(RangeError);
    await expect(dg.source('lines', ACCOUNT, '2020-02-01', 'yesterday')).rejects.toThrow(RangeError);
  });
});

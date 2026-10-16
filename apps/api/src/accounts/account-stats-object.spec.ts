import BigNumber from 'bignumber.js';
import {
  ratedAssets,
  rateSpans,
  StatsRates,
  StoredBalance,
  toTransactionStats,
  toValueStats,
  VALUE_DAYS_PER_RATE_CALL,
} from './account-stats-object';

/** Freezes the whole structure: the functions are pure and a write to their input would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const OTHER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';

const native = (day: string, balance: string): StoredBalance => ({ day, currency: 'XRP', counterparty: '', balance });
const usd = (day: string, balance: string, counterparty = ISSUER): StoredBalance => ({
  day,
  currency: 'USD',
  counterparty,
  balance,
});

/** `USD.<issuer>` -> day -> units of USD per XRP */
function rates(entries: Record<string, Record<string, string>>): StatsRates {
  return new Map(
    Object.entries(entries).map(([asset, days]) => [
      asset,
      new Map(Object.entries(days).map(([day, rate]) => [day, new BigNumber(rate)])),
    ]),
  );
}

describe('toTransactionStats', () => {
  it('is {date, transaction_count, result, type}, the date at midnight, the maps sorted by key', () => {
    const row = deepFreeze({
      day: '2015-01-14',
      n: 5,
      results: { tesSUCCESS: 3, tecUNFUNDED_PAYMENT: 1, tecPATH_DRY: 1 },
      types: { TrustSet: 1, Payment: 3, OfferCreate: 1 },
    });
    const stats = toTransactionStats(row);
    expect(stats).toEqual({
      date: '2015-01-14T00:00:00Z',
      transaction_count: 5,
      result: { tecPATH_DRY: 1, tecUNFUNDED_PAYMENT: 1, tesSUCCESS: 3 },
      type: { OfferCreate: 1, Payment: 3, TrustSet: 1 },
    });
    expect(Object.keys(stats)).toEqual(['date', 'transaction_count', 'result', 'type']);
    expect(Object.keys(stats.result)).toEqual(['tecPATH_DRY', 'tecUNFUNDED_PAYMENT', 'tesSUCCESS']);
    expect(Object.keys(stats.type)).toEqual(['OfferCreate', 'Payment', 'TrustSet']);
  });
});

describe('ratedAssets', () => {
  it('lists the issued currencies the account holds, each once, with the issuer being the counterparty', () => {
    const balances = deepFreeze([
      native('', '100'),
      usd('', '5'),
      usd('2020-03-02', '7'),
      usd('2020-03-02', '3', OTHER),
      { day: '2020-03-02', currency: 'EUR', counterparty: ISSUER, balance: '1' },
    ]);
    expect(ratedAssets(balances, 'XRP')).toEqual([
      { currency: 'USD', issuer: ISSUER },
      { currency: 'USD', issuer: OTHER },
      { currency: 'EUR', issuer: ISSUER },
    ]);
  });

  it('leaves out a line that is never positive: what the account owes is not held, and an empty line is nothing', () => {
    expect(ratedAssets([usd('', '-5'), usd('2020-03-02', '0', OTHER)], 'XRP')).toEqual([]);
    // positive on any day is enough
    expect(ratedAssets([usd('', '-5'), usd('2020-03-02', '1e-30')], 'XRP')).toEqual([
      { currency: 'USD', issuer: ISSUER },
    ]);
  });

  it('has no rate to ask for the native currency', () => {
    expect(ratedAssets([native('', '100'), native('2020-03-02', '90')], 'XRP')).toEqual([]);
    // the native currency of another network is an ordinary line
    expect(ratedAssets([{ day: '', currency: 'XAH', counterparty: '', balance: '5' }], 'XRP')).toEqual([]);
  });
});

describe('rateSpans', () => {
  it('is one span from the first day to the day after the last', () => {
    expect(rateSpans(['2020-03-02', '2020-03-09', '2020-03-10'])).toEqual([
      { from: new Date('2020-03-02T00:00:00Z'), toExclusive: new Date('2020-03-11T00:00:00Z') },
    ]);
  });

  it('is none for no days', () => {
    expect(rateSpans([])).toEqual([]);
  });

  it('starts another span when one would run over what a single call of the rates takes', () => {
    expect(VALUE_DAYS_PER_RATE_CALL).toBeLessThan(3660);
    const first = Date.parse('2005-01-01T00:00:00Z');
    const day = (n: number): string => new Date(first + n * 86_400_000).toISOString().slice(0, 10);
    const spans = rateSpans([
      day(0),
      day(100),
      day(VALUE_DAYS_PER_RATE_CALL - 1),
      day(VALUE_DAYS_PER_RATE_CALL),
      day(7000),
    ]);
    expect(spans.map((s) => [s.from.toISOString().slice(0, 10), s.toExclusive.toISOString().slice(0, 10)])).toEqual([
      [day(0), day(VALUE_DAYS_PER_RATE_CALL)],
      [day(VALUE_DAYS_PER_RATE_CALL), day(VALUE_DAYS_PER_RATE_CALL + 1)],
      [day(7000), day(7001)],
    ]);
    for (const s of spans) {
      expect((s.toExclusive.getTime() - s.from.getTime()) / 86_400_000).toBeLessThanOrEqual(VALUE_DAYS_PER_RATE_CALL);
    }
  });
});

describe('toValueStats', () => {
  const input = (
    days: [string, number][],
    balances: StoredBalance[],
    rate: StatsRates = new Map(),
  ): Parameters<typeof toValueStats>[0] =>
    deepFreeze({ native: 'XRP', days: days.map(([day, n]) => ({ day, n })), balances, rates: rate });

  it('is {date, account_value, balance_change_count}, the value a string', () => {
    const rows = toValueStats(input([['2015-01-14', 3]], [native('2015-01-14', '12.5')]));
    expect(rows).toEqual([{ date: '2015-01-14T00:00:00Z', account_value: '12.5', balance_change_count: 3 }]);
    expect(Object.keys(rows[0])).toEqual(['date', 'account_value', 'balance_change_count']);
    expect(typeof rows[0].account_value).toBe('string');
  });

  it('is the value as a string also where the original made a number of it: 0 and whole amounts', () => {
    const rows = toValueStats(
      input(
        [
          ['2015-01-14', 1],
          ['2015-01-15', 1],
        ],
        [native('2015-01-14', '100'), native('2015-01-15', '0')],
      ),
    );
    expect(rows.map((r) => r.account_value)).toEqual(['100', '0']);
  });

  it('carries a balance forward across the days it was not touched', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-05', 2],
          ['2020-03-09', 1],
        ],
        [native('2020-03-02', '10'), native('2020-03-05', '4'), native('2020-03-09', '1')],
      ),
    );
    expect(rows.map((r) => r.account_value)).toEqual(['10', '4', '1']);
  });

  it('starts from the balances before the first day, and the lines a day does not touch keep theirs', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-03', 1],
        ],
        [native('', '100'), usd('', '10'), native('2020-03-02', '90'), usd('2020-03-03', '2')],
        rates({ [`USD.${ISSUER}`]: { '2020-03-02': '2', '2020-03-03': '2' } }),
      ),
    );
    // day 1: 90 XRP + 10 USD (at 2 USD per XRP: 5); day 2: 90 + 2 / 2
    expect(rows.map((r) => r.account_value)).toEqual(['95', '91']);
  });

  it('counts a change of a day that is not a row of its own: the next row has it', () => {
    // 2020-03-03 only paid the fee: it is not in `days`, but the balance it left is carried to 2020-03-04
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-04', 1],
        ],
        [native('2020-03-02', '10'), native('2020-03-03', '9.999988'), native('2020-03-04', '9.999988')],
      ),
    );
    expect(rows.map((r) => r.account_value)).toEqual(['10', '9.999988']);
    const feeOnly = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-04', 1],
        ],
        [native('2020-03-02', '10'), native('2020-03-03', '9.999988')],
      ),
    );
    expect(feeOnly.map((r) => r.account_value)).toEqual(['10', '9.999988']);
  });

  it('takes the last balance of a line on a day: the rows hold one balance for each day and line', () => {
    const rows = toValueStats(input([['2020-03-02', 2]], [native('2020-03-02', '7')]));
    expect(rows[0].account_value).toBe('7');
  });

  it('converts an issued currency with the rate of each day: units of the currency per native coin', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-03', 1],
          ['2020-03-04', 1],
        ],
        [usd('2020-03-02', '10')],
        rates({ [`USD.${ISSUER}`]: { '2020-03-02': '2', '2020-03-03': '4', '2020-03-04': '0.5' } }),
      ),
    );
    // the same 10 USD, on three days of three rates
    expect(rows.map((r) => r.account_value)).toEqual(['5', '2.5', '20']);
  });

  it('counts an issued currency that has no rate that day as 0, and one with a rate of 0, and one never asked for', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-03', 1],
        ],
        [native('2020-03-02', '1'), usd('2020-03-02', '10'), usd('2020-03-02', '10', OTHER)],
        rates({ [`USD.${ISSUER}`]: { '2020-03-02': '0' }, [`USD.${OTHER}`]: { '2020-03-03': '5' } }),
      ),
    );
    // day 1: no rate for USD.ISSUER (0) and none for USD.OTHER on that day; day 2: 10 USD / 5 for OTHER only
    expect(rows.map((r) => r.account_value)).toEqual(['1', '3']);
    expect(toValueStats(input([['2020-03-02', 1]], [usd('2020-03-02', '10')])).map((r) => r.account_value)).toEqual([
      '0',
    ]);
  });

  it('does not count what the account owes: a negative balance of an issued currency is worth 0', () => {
    const rows = toValueStats(
      input(
        [['2020-03-02', 1]],
        [native('2020-03-02', '50'), usd('2020-03-02', '-1000'), usd('2020-03-02', '10', OTHER)],
        rates({ [`USD.${ISSUER}`]: { '2020-03-02': '1' }, [`USD.${OTHER}`]: { '2020-03-02': '2' } }),
      ),
    );
    expect(rows[0].account_value).toBe('55');
  });

  it('adds exactly: 0.1 + 0.2 is 0.3 and not 0.30000000000000004', () => {
    const rows = toValueStats(
      input(
        [['2020-03-02', 2]],
        [native('2020-03-02', '0.1'), { day: '2020-03-02', currency: 'XRP', counterparty: 'rX', balance: '0.2' }],
      ),
    );
    // the second is an issued currency called XRP, not the native one: no rate, so only the native 0.1 counts
    expect(rows[0].account_value).toBe('0.1');
    const sum = toValueStats(
      input(
        [['2020-03-02', 2]],
        [native('2020-03-02', '0.1'), usd('2020-03-02', '0.2')],
        rates({ [`USD.${ISSUER}`]: { '2020-03-02': '1' } }),
      ),
    );
    expect(sum[0].account_value).toBe('0.3');
  });

  it('cuts a quotient to the 17 significant digits the reports use, and adds the quotients exactly', () => {
    const rows = toValueStats(
      input([['2020-03-02', 1]], [usd('2020-03-02', '1')], rates({ [`USD.${ISSUER}`]: { '2020-03-02': '3' } })),
    );
    expect(rows[0].account_value).toBe('0.33333333333333333');
  });

  it('writes a value as BigNumber does: plain up to 1e21, then in exponent form', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-03', 1],
        ],
        [native('2020-03-02', '999999999999999999999'), native('2020-03-03', '1e+21')],
      ),
    );
    expect(rows.map((r) => r.account_value)).toEqual(['999999999999999999999', '1e+21']);
  });

  it('writes the days in the order given (the caller reverses them for descending) and does not change its input', () => {
    const rows = toValueStats(
      input(
        [
          ['2020-03-02', 1],
          ['2020-03-03', 1],
        ],
        [native('2020-03-02', '1'), native('2020-03-03', '2')],
      ),
    );
    expect(rows.map((r) => r.date)).toEqual(['2020-03-02T00:00:00Z', '2020-03-03T00:00:00Z']);
  });

  it('is none for no days', () => {
    expect(toValueStats(input([], [native('', '5')]))).toEqual([]);
  });
});

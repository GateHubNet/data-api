import { DayRates } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { dayText } from '../network/volume-buckets';
import {
  balanceChangesAnswer,
  balancesAnswer,
  CHANGE_TYPE_ORDER,
  changeAsset,
  ChangeAssetRow,
  ChangeBucketRow,
  counterpartiesAnswer,
  exchangesAnswer,
  ratedChangeAssets,
  ratedCounterpartyAssets,
  ratedPairAssets,
  StoredChangeGroup,
  StoredCounterparty,
  StoredCounterpartySum,
  StoredLine,
  StoredLineBucket,
  StoredPairGroup,
  toBalanceChanges,
  toBalanceLines,
  toBalanceRows,
  toCounterparties,
  toExchangePairs,
} from './account-analytics-object';
import { analyticsWindow } from './analytics-window';

/** Freezes the whole structure: the functions are pure and a write to their input would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const OTHER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const ACCOUNT = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);

// ---------------------------------------------------------------------------------------------------------------------

describe('the key orders', () => {
  const window = analyticsWindow({ start: '2026-09-20', end: '2026-10-19' }, NOW, 'default-day');

  describe('balances', () => {
    const lines: StoredLine[] = [
      { currency: 'XRP', counterparty: '', balance: '12480.256114' },
      { currency: 'USD', counterparty: ISSUER, balance: '3120.5' },
    ];
    const answer = balancesAnswer(window, {
      linesTotal: 7,
      lines: toBalanceLines(lines),
      rows: toBalanceRows(
        lines,
        [
          { currency: 'XRP', counterparty: '', label: '2026-09-20', balance: '12011.5' },
          { currency: 'USD', counterparty: ISSUER, label: '2026-09-20', balance: '3000' },
        ],
        [ms('2026-09-20')],
      ),
    });

    it('the answer is result, start, end, interval, lines_total, lines, count, rows', () => {
      expect(Object.keys(answer)).toEqual([
        'result',
        'start',
        'end',
        'interval',
        'lines_total',
        'lines',
        'count',
        'rows',
      ]);
      expect(answer).toMatchObject({
        result: 'success',
        start: '2026-09-20T00:00:00Z',
        end: '2026-10-20T00:00:00Z',
        interval: 'day',
        lines_total: 7,
        count: 2,
      });
    });

    it('a line is currency, counterparty?, balance: the native currency has no counterparty', () => {
      expect(answer.lines.map((l) => Object.keys(l))).toEqual([
        ['currency', 'balance'],
        ['currency', 'counterparty', 'balance'],
      ]);
      expect(answer.lines).toEqual([
        { currency: 'XRP', balance: '12480.256114' },
        { currency: 'USD', counterparty: ISSUER, balance: '3120.5' },
      ]);
    });

    it('a row is date, currency, counterparty?, balance', () => {
      expect(answer.rows.map((r) => Object.keys(r))).toEqual([
        ['date', 'currency', 'balance'],
        ['date', 'currency', 'counterparty', 'balance'],
      ]);
      expect(answer.rows[1]).toEqual({
        date: '2026-09-20T00:00:00Z',
        currency: 'USD',
        counterparty: ISSUER,
        balance: '3000',
      });
    });

    it('the interval of the window is the one served, day when the window has none', () => {
      const week = analyticsWindow({ interval: 'week', end: '2026-10-19' }, NOW, 'default-day');
      expect(balancesAnswer(week, { linesTotal: 0, lines: [], rows: [] }).interval).toBe('week');
      const none = analyticsWindow({}, NOW, 'optional');
      expect(balancesAnswer(none, { linesTotal: 0, lines: [], rows: [] }).interval).toBe('day');
    });
  });

  describe('balance changes', () => {
    const group = (
      day: string,
      type: string,
      currency: string,
      issuer: string,
      n: number,
      inn: string,
      out: string,
    ): StoredChangeGroup => ({
      day,
      change_type: type,
      currency,
      issuer,
      n,
      in_sum: inn,
      out_sum: out,
      unfit: 0,
      in_sum_f: Number(inn),
      out_sum_f: Number(out),
    });
    const groups = [
      group('2026-09-21', 'transaction_cost', 'XRP', '', 3, '0', '0.000036'),
      group('2026-09-21', '', 'USD', ISSUER, 2, '120', '300'),
    ];
    const rates: DayRates = new Map([[`USD.${ISSUER}`, new Map([['2026-09-21', new BigNumber(2)]])]]);

    it('without interval: result, start, end, totals, count, rows', () => {
      const none = analyticsWindow({ start: '2026-09-20', end: '2026-10-19' }, NOW, 'optional');
      const answer = balanceChangesAnswer(none, toBalanceChanges({ native: 'XRP', groups, rates }));
      expect(Object.keys(answer)).toEqual(['result', 'start', 'end', 'totals', 'count', 'rows']);
      expect(answer.count).toBe(2);
    });

    it('with interval: interval follows end', () => {
      const month = analyticsWindow({ start: '2026-09-20', end: '2026-10-19', interval: 'month' }, NOW, 'optional');
      const answer = balanceChangesAnswer(
        month,
        toBalanceChanges({ native: 'XRP', groups, rates, bucketOf: (d) => `${d.slice(0, 7)}-01` }),
      );
      expect(Object.keys(answer)).toEqual(['result', 'start', 'end', 'interval', 'totals', 'count', 'rows']);
      expect(answer).toMatchObject({ start: '2026-09-01T00:00:00Z', end: '2026-11-01T00:00:00Z', interval: 'month' });
    });

    it('a total is change_type?, count, in_value, out_value, net_value', () => {
      const { totals } = toBalanceChanges({ native: 'XRP', groups, rates });
      expect(totals.map((t) => Object.keys(t))).toEqual([
        ['change_type', 'count', 'in_value', 'out_value', 'net_value'],
        ['count', 'in_value', 'out_value', 'net_value'],
      ]);
      expect(totals).toEqual([
        { change_type: 'transaction_cost', count: 3, in_value: '0', out_value: '0.000036', net_value: '-0.000036' },
        { count: 2, in_value: '60', out_value: '150', net_value: '-90' },
      ]);
    });

    it('a row without interval is change_type?, currency, issuer?, count, in, out, in_value, out_value', () => {
      const { rows } = toBalanceChanges({ native: 'XRP', groups, rates });
      expect(rows.map((r) => Object.keys(r))).toEqual([
        ['change_type', 'currency', 'count', 'in', 'out', 'in_value', 'out_value'],
        ['currency', 'issuer', 'count', 'in', 'out', 'in_value', 'out_value'],
      ]);
      expect(rows[1]).toEqual({
        currency: 'USD',
        issuer: ISSUER,
        count: 2,
        in: '120',
        out: '300',
        in_value: '60',
        out_value: '150',
      });
    });

    it('a row with interval is date, change_type?, count, in_value, out_value', () => {
      const { rows } = toBalanceChanges({ native: 'XRP', groups, rates, bucketOf: (d) => d });
      expect(rows.map((r) => Object.keys(r))).toEqual([
        ['date', 'change_type', 'count', 'in_value', 'out_value'],
        ['date', 'count', 'in_value', 'out_value'],
      ]);
      expect(rows[0]).toEqual({
        date: '2026-09-21T00:00:00Z',
        change_type: 'transaction_cost',
        count: 3,
        in_value: '0',
        out_value: '0.000036',
      });
    });
  });
});

describe('the key orders of counterparties and exchanges', () => {
  const window = analyticsWindow({ start: '2026-09-20', end: '2026-10-19' }, NOW, 'none');

  it('counterparties: the answer is result, start, end, sort, total, count, counterparties', () => {
    const answer = counterpartiesAnswer(window, 'value', {
      total: 14,
      counterparties: [
        {
          account: OTHER,
          sent_value: '4820',
          received_value: '0',
          total_value: '4820',
          payments_sent: 9,
          payments_received: 0,
          first: '2026-09-21T10:11:12Z',
          last: '2026-10-17T08:00:01Z',
        },
      ],
    });
    expect(Object.keys(answer)).toEqual(['result', 'start', 'end', 'sort', 'total', 'count', 'counterparties']);
    expect(answer).toMatchObject({
      result: 'success',
      start: '2026-09-20T00:00:00Z',
      end: '2026-10-20T00:00:00Z',
      sort: 'value',
      total: 14,
      count: 1,
    });
    expect(counterpartiesAnswer(window, 'count', { total: 0, counterparties: [] })).toMatchObject({
      sort: 'count',
      total: 0,
      count: 0,
      counterparties: [],
    });
  });

  it('a counterparty is account, sent_value, received_value, total_value, payments_sent, payments_received, first, last', () => {
    const [entry] = toCounterparties({
      native: 'XRP',
      sort: 'value',
      limit: 20,
      chosen: [
        {
          counterparty: OTHER,
          payments_sent: 2,
          payments_received: 1,
          first_at: 1_600_000_000,
          last_at: 1_600_086_400,
        },
      ],
      sums: [
        {
          counterparty: OTHER,
          side: 'sent',
          currency: 'XRP',
          issuer: '',
          day: '2020-09-13',
          amount_sum: '5',
          unfit: 0,
          amount_sum_f: 5,
        },
      ],
      rates: new Map(),
    });
    expect(Object.keys(entry)).toEqual([
      'account',
      'sent_value',
      'received_value',
      'total_value',
      'payments_sent',
      'payments_received',
      'first',
      'last',
    ]);
    expect(entry).toEqual({
      account: OTHER,
      sent_value: '5',
      received_value: '0',
      total_value: '5',
      payments_sent: 2,
      payments_received: 1,
      first: '2020-09-13T12:26:40Z',
      last: '2020-09-14T12:26:40Z',
    });
  });

  it('exchanges: the answer is result, start, end, total, count, pairs', () => {
    const answer = exchangesAnswer(window, { total: 4, pairs: [] });
    expect(Object.keys(answer)).toEqual(['result', 'start', 'end', 'total', 'count', 'pairs']);
    expect(answer).toEqual({
      result: 'success',
      start: '2026-09-20T00:00:00Z',
      end: '2026-10-20T00:00:00Z',
      total: 4,
      count: 0,
      pairs: [],
    });
    expect(exchangesAnswer(window, { total: 9, pairs: [{} as never, {} as never] })).toMatchObject({
      total: 9,
      count: 2,
    });
  });

  it('a pair is base_currency, base_issuer?, counter_currency, counter_issuer?, count, base_volume, counter_volume, bought, sold, bought_counter, sold_counter, native_volume?', () => {
    const group = (extra: Partial<StoredPairGroup>): StoredPairGroup => ({
      day: '2026-09-21',
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
      counter_issuer: '',
      n: 9,
      base_sum: '3500',
      counter_sum: '8420',
      bought_sum: '1500',
      sold_sum: '2000',
      bought_counter_sum: '3610',
      sold_counter_sum: '4810',
      unfit: 0,
      base_sum_f: 3500,
      counter_sum_f: 8420,
      bought_sum_f: 1500,
      sold_sum_f: 2000,
      bought_counter_sum_f: 3610,
      sold_counter_sum_f: 4810,
      ...extra,
    });
    // a native side: native_volume is that side's volume, and the issuer of the native side is left out
    const [native] = toExchangePairs({ native: 'XRP', groups: [group({})], rates: new Map(), limit: 20 }).pairs;
    expect(Object.keys(native)).toEqual([
      'base_currency',
      'base_issuer',
      'counter_currency',
      'count',
      'base_volume',
      'counter_volume',
      'bought',
      'sold',
      'bought_counter',
      'sold_counter',
      'native_volume',
    ]);
    expect(native).toEqual({
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XRP',
      count: 9,
      base_volume: '3500',
      counter_volume: '8420',
      bought: '1500',
      sold: '2000',
      bought_counter: '3610',
      sold_counter: '4810',
      native_volume: '8420',
    });
    // two issued sides, both issuers; no rate on any day: no native_volume
    const [issued] = toExchangePairs({
      native: 'XRP',
      groups: [group({ counter_currency: 'EUR', counter_issuer: OTHER })],
      rates: new Map(),
      limit: 20,
    }).pairs;
    expect(Object.keys(issued)).toEqual([
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      'count',
      'base_volume',
      'counter_volume',
      'bought',
      'sold',
      'bought_counter',
      'sold_counter',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('toBalanceRows', () => {
  const xrp: StoredLine = { currency: 'XRP', counterparty: '', balance: '90' };
  const usd: StoredLine = { currency: 'USD', counterparty: ISSUER, balance: '-5' };
  const stored = (line: StoredLine, label: string, balance: string): StoredLineBucket => ({
    currency: line.currency,
    counterparty: line.counterparty,
    label,
    balance,
  });
  const buckets = ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01'].map(ms);

  it('carries the last balance over the buckets without a change', () => {
    const rows = toBalanceRows(
      [xrp],
      deepFreeze([stored(xrp, '2020-01-01', '100'), stored(xrp, '2020-03-01', '90')]),
      buckets,
    );
    expect(rows.map((r) => [r.date.slice(0, 10), r.balance])).toEqual([
      ['2020-01-01', '100'],
      ['2020-02-01', '100'],
      ['2020-03-01', '90'],
      ['2020-04-01', '90'],
    ]);
  });

  it('a line that changed before the window has rows from the first bucket, with the balance it had', () => {
    const rows = toBalanceRows([xrp], [stored(xrp, '', '100'), stored(xrp, '2020-03-01', '90')], buckets);
    expect(rows.map((r) => [r.date.slice(0, 10), r.balance])).toEqual([
      ['2020-01-01', '100'],
      ['2020-02-01', '100'],
      ['2020-03-01', '90'],
      ['2020-04-01', '90'],
    ]);
  });

  it('a line that changed before the window and not in it has a row for every bucket', () => {
    const rows = toBalanceRows([xrp], [stored(xrp, '', '100')], buckets);
    expect(rows.map((r) => r.balance)).toEqual(['100', '100', '100', '100']);
  });

  it('a line has rows from the bucket of its first change, not before', () => {
    const rows = toBalanceRows([usd], [stored(usd, '2020-03-01', '-5')], buckets);
    expect(rows.map((r) => [r.date.slice(0, 10), r.balance])).toEqual([
      ['2020-03-01', '-5'],
      ['2020-04-01', '-5'],
    ]);
  });

  it('an owed balance is negative, and a line back at 0 keeps its rows of "0"', () => {
    const rows = toBalanceRows([usd], [stored(usd, '2020-01-01', '-5'), stored(usd, '2020-02-01', '0')], buckets);
    expect(rows.map((r) => r.balance)).toEqual(['-5', '0', '0', '0']);
  });

  it('is ordered by date, then by the order of the lines, whatever the order the stored balances come in', () => {
    const rows = toBalanceRows(
      [usd, xrp],
      [
        stored(xrp, '2020-02-01', '1'),
        stored(usd, '2020-02-01', '2'),
        stored(usd, '2020-01-01', '3'),
        stored(xrp, '2020-01-01', '4'),
      ],
      buckets.slice(0, 2),
    );
    expect(rows.map((r) => [r.date.slice(0, 10), r.currency, r.balance])).toEqual([
      ['2020-01-01', 'USD', '3'],
      ['2020-01-01', 'XRP', '4'],
      ['2020-02-01', 'USD', '2'],
      ['2020-02-01', 'XRP', '1'],
    ]);
  });

  it('keeps the balance text exactly as stored', () => {
    const rows = toBalanceRows([xrp], [stored(xrp, '2020-01-01', '1.2300e-7')], buckets.slice(0, 1));
    expect(rows[0].balance).toBe('1.2300e-7');
  });

  it('has no row for a line without a stored balance, and none when there is no bucket', () => {
    expect(toBalanceRows([xrp, usd], [stored(usd, '2020-02-01', '5')], buckets).map((r) => r.currency)).toEqual([
      'USD',
      'USD',
      'USD',
    ]);
    expect(toBalanceRows([xrp], [stored(xrp, '', '1')], [])).toEqual([]);
  });

  it('the labels are the starts of the buckets whatever the interval: weeks and months by their day', () => {
    const weeks = ['2020-02-03', '2020-02-10'].map(ms);
    const rows = toBalanceRows([xrp], [stored(xrp, '2020-02-10', '7')], weeks);
    expect(rows).toEqual([{ date: '2020-02-10T00:00:00Z', currency: 'XRP', balance: '7' }]);
    expect(dayText(weeks[1])).toBe('2020-02-10');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('toBalanceChanges', () => {
  const group = (
    day: string,
    type: string,
    currency: string,
    issuer: string,
    n: number,
    inn: string,
    out: string,
    extra: Partial<StoredChangeGroup> = {},
  ): StoredChangeGroup => ({
    day,
    change_type: type,
    currency,
    issuer,
    n,
    in_sum: inn,
    out_sum: out,
    unfit: 0,
    in_sum_f: Number(inn),
    out_sum_f: Number(out),
    ...extra,
  });
  const rates = (entries: Record<string, Record<string, string>>): DayRates =>
    new Map(
      Object.entries(entries).map(([asset, days]) => [
        asset,
        new Map(Object.entries(days).map(([day, rate]) => [day, new BigNumber(rate)])),
      ]),
    );
  const USD = `USD.${ISSUER}`;

  it('is nothing for nothing', () => {
    expect(toBalanceChanges({ native: 'XRP', groups: [], rates: new Map() })).toEqual({ totals: [], rows: [] });
    expect(toBalanceChanges({ native: 'XRP', groups: [], rates: new Map(), bucketOf: (d) => d })).toEqual({
      totals: [],
      rows: [],
    });
  });

  it('the native currency is worth itself, an issued amount its amount over the rate of its day, 0 without one', () => {
    const { rows } = toBalanceChanges({
      native: 'XRP',
      groups: deepFreeze([
        group('2020-02-10', 'payment_destination', 'XRP', '', 1, '100', '0'),
        group('2020-02-10', 'payment_destination', 'USD', ISSUER, 1, '10', '0'),
        group('2020-02-11', 'payment_destination', 'USD', ISSUER, 1, '30', '0'),
        group('2020-02-10', 'payment_destination', 'EUR', ISSUER, 1, '8', '0'),
      ]),
      rates: deepFreeze(rates({ [USD]: { '2020-02-10': '2', '2020-02-11': '0' } })),
    });
    expect(rows).toEqual([
      expect.objectContaining({ currency: 'XRP', in: '100', in_value: '100' }),
      // 10 / 2; the 30 of the next day have a rate of 0, so are worth 0
      expect.objectContaining({ currency: 'USD', issuer: ISSUER, count: 2, in: '40', in_value: '5' }),
      // no rate at all
      expect.objectContaining({ currency: 'EUR', issuer: ISSUER, in: '8', in_value: '0' }),
    ]);
  });

  it('the quotient is cut to 17 significant digits per group and day, and the sum of the values is exact', () => {
    const { totals, rows } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-02-10', 'exchange', 'USD', ISSUER, 1, '1', '0'),
        group('2020-02-11', 'exchange', 'USD', ISSUER, 1, '1', '0'),
      ],
      rates: rates({ [USD]: { '2020-02-10': '3', '2020-02-11': '3' } }),
    });
    // 1/3 cut to 17 digits twice, not 2/3 cut once (0.66666666666666667)
    expect(rows[0]).toMatchObject({ in_value: '0.66666666666666666' });
    expect(totals[0]).toMatchObject({ in_value: '0.66666666666666666', net_value: '0.66666666666666666' });
  });

  it('values the in and the out of a group on their own: net_value is in_value minus out_value', () => {
    const { totals } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-04-20', 'exchange', 'USD', ISSUER, 1, '0', '20'),
        group('2020-04-20', 'exchange', 'XRP', '', 1, '5', '0'),
        group('2020-04-21', 'exchange', 'XRP', '', 1, '0', '7.5'),
      ],
      rates: rates({ [USD]: { '2020-04-20': '4' } }),
    });
    expect(totals).toEqual([
      { change_type: 'exchange', count: 3, in_value: '5', out_value: '12.5', net_value: '-7.5' },
    ]);
  });

  it('adds exact decimals: 0.1 + 0.2 is 0.3, not 0.30000000000000004', () => {
    const { rows } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-01-01', 'payment_destination', 'XRP', '', 1, '0.1', '0'),
        group('2020-01-02', 'payment_destination', 'XRP', '', 1, '0.2', '0'),
      ],
      rates: new Map(),
    });
    expect(rows[0]).toMatchObject({ in: '0.3', in_value: '0.3', count: 2 });
  });

  it('uses the Float64 sums for a group that holds an amount the decimals cannot, as everything else does', () => {
    const { rows } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-01-01', 'payment_destination', 'USD', ISSUER, 2, '5', '3', {
          unfit: 1,
          in_sum_f: 7.5,
          out_sum_f: 3.25,
        }),
      ],
      rates: rates({ [USD]: { '2020-01-01': '1' } }),
    });
    expect(rows[0]).toMatchObject({ in: '7.5', out: '3.25', in_value: '7.5', out_value: '3.25' });
  });

  it('counts a change of an owed line as the account issuing its own currency: the issuer is the one the group has', () => {
    // the service folds the lines the account owes on into the asset of the account itself; the group holds that issuer
    const owed = group('2020-02-10', 'intermediary', 'USD', ACCOUNT, 1, '0', '10');
    expect(changeAsset(owed)).toEqual({ currency: 'USD', issuer: ACCOUNT });
    const { rows } = toBalanceChanges({
      native: 'XRP',
      groups: [owed],
      rates: rates({ [`USD.${ACCOUNT}`]: { '2020-02-10': '2' } }),
    });
    expect(rows).toEqual([
      {
        change_type: 'intermediary',
        currency: 'USD',
        issuer: ACCOUNT,
        count: 1,
        in: '0',
        out: '10',
        in_value: '0',
        out_value: '5',
      },
    ]);
    expect(changeAsset(group('2020-02-10', 'exchange', 'XRP', '', 1, '1', '0'))).toEqual({ currency: 'XRP' });
  });

  it('totals: one per change type with a change, in CHANGE_TYPE_ORDER, the unclassified last', () => {
    expect(CHANGE_TYPE_ORDER).toEqual([
      'transaction_cost',
      'payment_destination',
      'payment_source',
      'exchange',
      'intermediary',
      'escrow_create',
      'escrow_finish',
      'escrow_cancel',
      'paychannel_fund',
      'paychannel_payout',
    ]);
    const shuffled = [
      '',
      'paychannel_payout',
      'exchange',
      'escrow_cancel',
      'transaction_cost',
      'intermediary',
      'weird',
    ];
    const { totals } = toBalanceChanges({
      native: 'XRP',
      groups: shuffled.map((type) => group('2020-01-01', type, 'XRP', '', 1, '1', '0')),
      rates: new Map(),
    });
    // a type that is none of the ten comes after them and before the unclassified
    expect(totals.map((t) => t.change_type)).toEqual([
      'transaction_cost',
      'exchange',
      'intermediary',
      'escrow_cancel',
      'paychannel_payout',
      'weird',
      undefined,
    ]);
    expect(Object.keys(totals[6])).toEqual(['count', 'in_value', 'out_value', 'net_value']);
  });

  it('rows without interval: by type, then in_value + out_value largest first, then currency and issuer', () => {
    const { rows } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-01-01', 'exchange', 'XRP', '', 1, '5', '0'),
        group('2020-01-01', 'exchange', 'USD', ISSUER, 1, '0', '20'),
        group('2020-01-01', 'exchange', 'USD', OTHER, 1, '0', '20'),
        group('2020-01-01', 'transaction_cost', 'XRP', '', 1, '0', '0.000012'),
        group('2020-01-01', 'payment_destination', 'XRP', '', 1, '100', '0'),
        group('2020-01-01', 'payment_destination', 'USD', ISSUER, 1, '6', '0'),
        group('2020-01-01', 'payment_destination', 'EUR', ISSUER, 1, '9', '0'),
      ],
      rates: rates({ [USD]: { '2020-01-01': '4' }, [`USD.${OTHER}`]: { '2020-01-01': '4' } }),
    });
    expect((rows as ChangeAssetRow[]).map((r) => [r.change_type, r.currency, r.issuer])).toEqual([
      ['transaction_cost', 'XRP', undefined],
      // 100 XRP, then 6 USD at 4 (1.5), then 9 EUR with no rate (0)
      ['payment_destination', 'XRP', undefined],
      ['payment_destination', 'USD', ISSUER],
      ['payment_destination', 'EUR', ISSUER],
      // 5 and 5 and 5: USD of the two issuers by their issuer text (rM… before rv…), then XRP by currency
      ['exchange', 'USD', OTHER],
      ['exchange', 'USD', ISSUER],
      ['exchange', 'XRP', undefined],
    ]);
  });

  it('rows with interval: per bucket and change type, by date, then type; the days of a bucket are added', () => {
    const bucketOf = (day: string): string => (day < '2020-02-01' ? '2020-01-01' : '2020-02-01');
    const { rows, totals } = toBalanceChanges({
      native: 'XRP',
      groups: [
        group('2020-02-10', 'payment_source', 'XRP', '', 1, '0', '20'),
        group('2020-01-15', 'payment_destination', 'XRP', '', 1, '100', '0'),
        group('2020-01-20', 'payment_destination', 'XRP', '', 2, '3', '0'),
        group('2020-01-20', 'transaction_cost', 'XRP', '', 1, '0', '0.000012'),
        group('2020-02-10', 'payment_destination', 'USD', ISSUER, 1, '10', '0'),
        group('2020-02-11', 'payment_destination', 'USD', ISSUER, 1, '10', '0'),
      ],
      rates: rates({ [USD]: { '2020-02-10': '2', '2020-02-11': '5' } }),
      bucketOf,
    });
    expect(rows as ChangeBucketRow[]).toEqual([
      { date: '2020-01-01T00:00:00Z', change_type: 'transaction_cost', count: 1, in_value: '0', out_value: '0.000012' },
      { date: '2020-01-01T00:00:00Z', change_type: 'payment_destination', count: 3, in_value: '103', out_value: '0' },
      // 10 / 2 and 10 / 5, each on its own day
      { date: '2020-02-01T00:00:00Z', change_type: 'payment_destination', count: 2, in_value: '7', out_value: '0' },
      { date: '2020-02-01T00:00:00Z', change_type: 'payment_source', count: 1, in_value: '0', out_value: '20' },
    ]);
    // the totals do not depend on the buckets
    expect(totals.map((t) => [t.change_type, t.count])).toEqual([
      ['transaction_cost', 1],
      ['payment_destination', 5],
      ['payment_source', 1],
    ]);
  });
});

describe('ratedChangeAssets', () => {
  const g = (day: string, currency: string, issuer: string, inn: string, out: string): StoredChangeGroup => ({
    day,
    change_type: 'exchange',
    currency,
    issuer,
    n: 1,
    in_sum: inn,
    out_sum: out,
    unfit: 0,
    in_sum_f: Number(inn),
    out_sum_f: Number(out),
  });

  it('asks for the issued assets that moved and the days they moved on, each once, and for no native currency', () => {
    expect(
      ratedChangeAssets([
        g('2020-02-11', 'USD', ISSUER, '1', '0'),
        g('2020-02-10', 'USD', ISSUER, '0', '2'),
        g('2020-02-10', 'EUR', OTHER, '3', '0'),
        g('2020-02-12', 'XRP', '', '3', '0'),
        // a change of 0 is worth 0 at any rate
        g('2020-02-13', 'CAD', ISSUER, '0', '0'),
      ]),
    ).toEqual({
      assets: [
        { currency: 'USD', issuer: ISSUER },
        { currency: 'EUR', issuer: OTHER },
      ],
      days: ['2020-02-10', '2020-02-11'],
    });
  });

  it('an issuer makes an asset an issued one, whatever its currency: XRP of an issuer (Xahau) is rated, XAH is not', () => {
    const groups = [g('2020-02-10', 'XRP', ISSUER, '1', '0'), g('2020-02-10', 'XAH', '', '1', '0')];
    expect(ratedChangeAssets(groups).assets).toEqual([{ currency: 'XRP', issuer: ISSUER }]);
  });

  it('is nothing for groups that moved only the native currency', () => {
    expect(ratedChangeAssets([g('2020-02-10', 'XRP', '', '1', '0')])).toEqual({ assets: [], days: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('toCounterparties', () => {
  const USD = `USD.${ISSUER}`;
  const B = 'rBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const C = 'rCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const D = 'rDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const rates = (entries: Record<string, Record<string, string>>): DayRates =>
    new Map(
      Object.entries(entries).map(([asset, days]) => [
        asset,
        new Map(Object.entries(days).map(([day, rate]) => [day, new BigNumber(rate)])),
      ]),
    );
  const chosen = (counterparty: string, sent: number, received: number): StoredCounterparty => ({
    counterparty,
    payments_sent: sent,
    payments_received: received,
    first_at: 1_580_000_000,
    last_at: 1_590_000_000,
  });
  const sum = (
    counterparty: string,
    side: 'sent' | 'received',
    currency: string,
    issuer: string,
    day: string,
    amount: string,
    extra: Partial<StoredCounterpartySum> = {},
  ): StoredCounterpartySum => ({
    counterparty,
    side,
    currency,
    issuer,
    day,
    amount_sum: amount,
    unfit: 0,
    amount_sum_f: Number(amount),
    ...extra,
  });
  const run = (
    over: Partial<Parameters<typeof toCounterparties>[0]> &
      Pick<Parameters<typeof toCounterparties>[0], 'chosen' | 'sums'>,
  ) => toCounterparties({ native: 'XRP', sort: 'value', limit: 20, rates: new Map(), ...over });

  it('values each sum at the rate of its day: the native currency is itself, an issued amount over its rate, 0 without one', () => {
    const [entry] = run({
      chosen: [chosen(B, 3, 2)],
      sums: deepFreeze([
        sum(B, 'sent', 'XRP', '', '2020-02-10', '7'),
        sum(B, 'sent', 'USD', ISSUER, '2020-02-10', '20'), // 20 / 2
        sum(B, 'sent', 'USD', ISSUER, '2020-04-20', '40'), // 40 / 4
        sum(B, 'received', 'USD', ISSUER, '2020-03-01', '6'), // no rate that day
        sum(B, 'received', 'EUR', OTHER, '2020-02-10', '3'), // no rate at all
      ]),
      rates: rates({ [USD]: { '2020-02-10': '2', '2020-04-20': '4' } }),
    });
    expect(entry).toMatchObject({ sent_value: '27', received_value: '0', total_value: '27' });
  });

  it('sent and received are valued apart, and the total is their sum', () => {
    const [entry] = run({
      chosen: [chosen(B, 1, 1)],
      sums: [sum(B, 'sent', 'XRP', '', '2020-02-10', '3.5'), sum(B, 'received', 'XRP', '', '2020-02-11', '1.25')],
    });
    expect(entry).toMatchObject({ sent_value: '3.5', received_value: '1.25', total_value: '4.75' });
  });

  it('the quotient is cut to 17 significant digits per counterparty, side, asset and day, and the sums are exact', () => {
    const [entry] = run({
      chosen: [chosen(B, 2, 0)],
      sums: [sum(B, 'sent', 'USD', ISSUER, '2020-02-10', '1'), sum(B, 'sent', 'USD', ISSUER, '2020-02-11', '1')],
      rates: rates({ [USD]: { '2020-02-10': '3', '2020-02-11': '3' } }),
    });
    // 1 / 3 = 0.33333333333333333 (17 digits), twice
    expect(entry.sent_value).toBe('0.66666666666666666');
  });

  it('adds exact decimals: 0.1 and 0.2 are 0.3', () => {
    const [entry] = run({
      chosen: [chosen(B, 2, 0)],
      sums: [sum(B, 'sent', 'XRP', '', '2020-02-10', '0.1'), sum(B, 'sent', 'XRP', '', '2020-02-11', '0.2')],
    });
    expect(entry.sent_value).toBe('0.3');
  });

  it('uses the Float64 sum of a group that holds an amount a decimal cannot', () => {
    const [entry] = run({
      chosen: [chosen(B, 2, 0)],
      sums: [sum(B, 'sent', 'XRP', '', '2020-02-10', '1', { unfit: 1, amount_sum_f: 1.5 })],
    });
    expect(entry.sent_value).toBe('1.5');
  });

  it('sort=value: the largest total value first, then the account; the exact value decides what the Float64 one ties', () => {
    // the Float64 values of B and C are the same (2^53), and their exact values differ by one: C is the larger
    const found = run({
      chosen: [chosen(B, 1, 0), chosen(C, 1, 0), chosen(D, 1, 0)],
      sums: [
        sum(B, 'sent', 'XRP', '', '2020-02-10', '9007199254740992'),
        sum(C, 'sent', 'XRP', '', '2020-02-10', '9007199254740993', { amount_sum_f: 9007199254740992 }),
        sum(D, 'sent', 'XRP', '', '2020-02-10', '9007199254740992'),
      ],
    });
    expect(found.map((c) => [c.account, c.total_value])).toEqual([
      [C, '9007199254740993'],
      [B, '9007199254740992'],
      [D, '9007199254740992'],
    ]);
  });

  it('sort=count: payments_sent + payments_received, largest first, then the account, whatever the values', () => {
    const found = run({
      sort: 'count',
      chosen: [chosen(D, 1, 1), chosen(B, 1, 0), chosen(C, 0, 2)],
      sums: [
        sum(B, 'sent', 'XRP', '', '2020-02-10', '1000'),
        sum(C, 'received', 'XRP', '', '2020-02-10', '1'),
        sum(D, 'sent', 'XRP', '', '2020-02-10', '1'),
      ],
    });
    expect(found.map((c) => c.account)).toEqual([C, D, B]);
  });

  it('serves the first limit of them', () => {
    const accounts = [B, C, D];
    const input = {
      chosen: accounts.map((a) => chosen(a, 1, 0)),
      sums: accounts.map((a, i) => sum(a, 'sent', 'XRP', '', '2020-02-10', String(i + 1))),
    };
    expect(run({ ...input, limit: 2 }).map((c) => c.account)).toEqual([D, C]);
    expect(run({ ...input, limit: 1 }).map((c) => c.account)).toEqual([D]);
    expect(run({ ...input, limit: 10 })).toHaveLength(3);
  });

  it('first and last are the times of the first and the last payment', () => {
    const [entry] = run({ chosen: [chosen(B, 1, 0)], sums: [sum(B, 'sent', 'XRP', '', '2020-02-10', '1')] });
    expect([entry.first, entry.last]).toEqual(['2020-01-26T00:53:20Z', '2020-05-20T18:40:00Z']);
  });

  it('a counterparty without a sum is worth 0, and nothing for nothing', () => {
    expect(run({ chosen: [chosen(B, 1, 0)], sums: [] })[0]).toMatchObject({ total_value: '0', payments_sent: 1 });
    expect(run({ chosen: [], sums: [] })).toEqual([]);
  });

  it('ratedCounterpartyAssets asks for the issued assets that moved and the days, each once, and for no native currency', () => {
    expect(
      ratedCounterpartyAssets([
        sum(B, 'sent', 'USD', ISSUER, '2020-02-11', '1'),
        sum(C, 'received', 'USD', ISSUER, '2020-02-10', '2'),
        sum(B, 'sent', 'EUR', OTHER, '2020-02-10', '3'),
        sum(B, 'sent', 'XRP', '', '2020-02-12', '3'),
        sum(B, 'sent', 'CAD', ISSUER, '2020-02-13', '0'),
      ]),
    ).toEqual({
      assets: [
        { currency: 'USD', issuer: ISSUER },
        { currency: 'EUR', issuer: OTHER },
      ],
      days: ['2020-02-10', '2020-02-11'],
    });
    expect(ratedCounterpartyAssets([sum(B, 'sent', 'XRP', '', '2020-02-12', '3')])).toEqual({ assets: [], days: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('toExchangePairs', () => {
  const USD = `USD.${ISSUER}`;
  const EUR = `EUR.${OTHER}`;
  const rates = (entries: Record<string, Record<string, string>>): DayRates =>
    new Map(
      Object.entries(entries).map(([asset, days]) => [
        asset,
        new Map(Object.entries(days).map(([day, rate]) => [day, new BigNumber(rate)])),
      ]),
    );
  /** A day group of the pair USD (of ISSUER) / XRP unless said otherwise. The sums are those of its two volumes. */
  const group = (
    day: string,
    base: string,
    counter: string,
    extra: Partial<StoredPairGroup> = {},
  ): StoredPairGroup => ({
    day,
    base_currency: 'USD',
    base_issuer: ISSUER,
    counter_currency: 'XRP',
    counter_issuer: '',
    n: 1,
    base_sum: base,
    counter_sum: counter,
    bought_sum: base,
    sold_sum: '0',
    bought_counter_sum: counter,
    sold_counter_sum: '0',
    unfit: 0,
    base_sum_f: Number(base),
    counter_sum_f: Number(counter),
    bought_sum_f: Number(base),
    sold_sum_f: 0,
    bought_counter_sum_f: Number(counter),
    sold_counter_sum_f: 0,
    ...extra,
  });
  const eurUsd = (day: string, base: string, counter: string, n = 1): StoredPairGroup =>
    group(day, base, counter, {
      base_currency: 'EUR',
      base_issuer: OTHER,
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      n,
    });
  const run = (groups: StoredPairGroup[], r: DayRates = new Map(), limit = 20) =>
    toExchangePairs({ native: 'XRP', groups: deepFreeze(groups), rates: r, limit });

  it('adds the days of a pair up: count, the volumes, bought, sold, and the counter of those', () => {
    const { total, pairs } = run([
      group('2020-02-10', '10', '5', {
        n: 2,
        bought_sum: '4',
        sold_sum: '6',
        bought_counter_sum: '2',
        sold_counter_sum: '3',
      }),
      group('2020-02-11', '0.5', '0.25', {
        n: 1,
        bought_sum: '0',
        sold_sum: '0.5',
        bought_counter_sum: '0',
        sold_counter_sum: '0.25',
      }),
    ]);
    expect(total).toBe(1);
    expect(pairs[0]).toMatchObject({
      count: 3,
      base_volume: '10.5',
      counter_volume: '5.25',
      bought: '4',
      sold: '6.5',
      bought_counter: '2',
      sold_counter: '3.25',
    });
  });

  it('native_volume of a pair with a native side is that side: the counter, or the base', () => {
    const { pairs } = run([
      group('2020-02-10', '10', '5'),
      group('2020-02-11', '0.5', '0.25'),
      group('2020-02-10', '8', '3', {
        base_currency: 'XRP',
        base_issuer: '',
        counter_currency: 'ZAR',
        counter_issuer: OTHER,
      }),
    ]);
    expect(pairs.map((p) => [p.base_currency, p.counter_currency, p.native_volume])).toEqual([
      ['XRP', 'ZAR', '8'],
      ['USD', 'XRP', '5.25'],
    ]);
  });

  it("without a native side: per day the base volume over the base's rate, else the counter volume over the counter's rate, summed", () => {
    const { pairs } = run(
      [
        eurUsd('2020-02-10', '30', '60'), // the base has a rate: 30 / 0.5 = 60
        eurUsd('2020-02-11', '10', '20'), // only the counter: 20 / 4 = 5
        eurUsd('2020-02-12', '10', '20'), // neither: nothing
        eurUsd('2020-02-13', '9', '18'), // both: the base's, 9 / 3 = 3
      ],
      rates({
        [EUR]: { '2020-02-10': '0.5', '2020-02-12': '0', '2020-02-13': '3' },
        [USD]: { '2020-02-10': '2', '2020-02-11': '4', '2020-02-13': '6' },
      }),
    );
    expect(pairs[0].native_volume).toBe('68');
  });

  it('is left out when no day of the pair had a rate', () => {
    const { pairs } = run([eurUsd('2020-02-10', '30', '60')], rates({ [EUR]: { '2020-02-10': '0' } }));
    expect(pairs[0]).not.toHaveProperty('native_volume');
    expect(Object.keys(pairs[0])).not.toContain('native_volume');
  });

  it('the quotient is cut to 17 significant digits per pair and day', () => {
    const { pairs } = run(
      [eurUsd('2020-02-10', '1', '1'), eurUsd('2020-02-11', '1', '1')],
      rates({ [EUR]: { '2020-02-10': '3', '2020-02-11': '3' } }),
    );
    expect(pairs[0].native_volume).toBe('0.66666666666666666');
  });

  it('sorts by native_volume, the largest first; the pairs without one last, by count; then by the pair', () => {
    const noRate = (base: string, n: number): StoredPairGroup =>
      group('2020-02-10', '1', '1', {
        base_currency: base,
        base_issuer: OTHER,
        counter_currency: 'CCC',
        counter_issuer: OTHER,
        n,
      });
    const { pairs, total } = run([
      // native volumes 5, 5 and 7: the two of 5 are USD of two issuers, and the pair key tells them apart (OTHER sorts first)
      group('2020-02-10', '1', '5'),
      group('2020-02-10', '1', '5', { base_issuer: OTHER }),
      group('2020-02-10', '1', '7', { base_currency: 'AAA', base_issuer: OTHER }),
      // and three pairs without one: by count, then the pair
      noRate('BBB', 2),
      noRate('DDD', 5),
      noRate('AAB', 2),
    ]);
    expect(total).toBe(6);
    expect(pairs.map((p) => [p.base_currency, p.base_issuer, p.counter_currency])).toEqual([
      ['AAA', OTHER, 'XRP'],
      ['USD', OTHER, 'XRP'],
      ['USD', ISSUER, 'XRP'],
      ['DDD', OTHER, 'CCC'],
      ['AAB', OTHER, 'CCC'],
      ['BBB', OTHER, 'CCC'],
    ]);
  });

  it('serves the first limit pairs and counts them all', () => {
    const groups = ['A', 'B', 'C'].map((c, i) => group('2020-02-10', '1', String(i + 1), { base_currency: c }));
    const { total, pairs } = run(groups, new Map(), 2);
    expect([total, pairs.map((p) => p.base_currency)]).toEqual([3, ['C', 'B']]);
  });

  it('uses the Float64 sums of a group that holds an amount a decimal cannot', () => {
    const { pairs } = run([
      group('2020-02-10', '1', '5', { unfit: 1, base_sum_f: 1.5, counter_sum_f: 5.5, bought_sum_f: 1.5 }),
    ]);
    expect(pairs[0]).toMatchObject({ base_volume: '1.5', counter_volume: '5.5', bought: '1.5', native_volume: '5.5' });
  });

  it('is nothing for nothing', () => {
    expect(run([])).toEqual({ total: 0, pairs: [] });
  });

  it('ratedPairAssets asks for the issued sides of the pairs without a native side, and the days of their groups', () => {
    expect(
      ratedPairAssets(
        [
          eurUsd('2020-02-11', '1', '1'),
          eurUsd('2020-02-10', '1', '1'),
          group('2020-02-12', '1', '1'), // a native counter: no rate is needed
          group('2020-02-13', '1', '1', {
            base_currency: 'XRP',
            base_issuer: '',
            counter_currency: 'ZAR',
            counter_issuer: OTHER,
          }),
        ],
        'XRP',
      ),
    ).toEqual({
      assets: [
        { currency: 'EUR', issuer: OTHER },
        { currency: 'USD', issuer: ISSUER },
      ],
      days: ['2020-02-10', '2020-02-11'],
    });
    expect(ratedPairAssets([group('2020-02-12', '1', '1')], 'XRP')).toEqual({ assets: [], days: [] });
  });
});

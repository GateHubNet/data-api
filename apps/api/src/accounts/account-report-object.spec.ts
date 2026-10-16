import BigNumber from 'bignumber.js';
import {
  ratedAssets,
  ReportRates,
  StoredCounterparty,
  StoredCounterpartyCount,
  StoredReportGroup,
  StoredReportPayment,
  toReports,
} from './account-report-object';

const ACCOUNT = 'rAccount';
const MWJ = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const KIC = 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** A group of the query: exact sums, nothing that did not fit a decimal. */
function group(
  day: string,
  dir: 'sent' | 'received',
  currency: string,
  issuer: string,
  n: number,
  sum: string,
  max: string,
  extra: Partial<StoredReportGroup> = {},
): StoredReportGroup {
  return {
    day,
    dir,
    currency,
    issuer,
    n,
    amount_sum: sum,
    amount_max: max,
    unfit: 0,
    amount_sum_f: Number(sum),
    amount_max_f: Number(max),
    ...extra,
  };
}

const rates = (entries: Record<string, Record<string, string>>): ReportRates =>
  new Map(
    Object.entries(entries).map(([asset, days]) => [
      asset,
      new Map(Object.entries(days).map(([day, rate]) => [day, new BigNumber(rate)])),
    ]),
  );

const build = (
  input: {
    days?: string[];
    groups?: StoredReportGroup[];
    rates?: ReportRates;
    native?: string;
    counts?: StoredCounterpartyCount[];
    list?: StoredCounterparty[];
    payments?: StoredReportPayment[];
  } = {},
) =>
  toReports(
    deepFreeze({
      account: ACCOUNT,
      native: input.native ?? 'XRP',
      days: input.days ?? ['2015-01-14'],
      groups: input.groups ?? [],
      rates: input.rates ?? new Map(),
      counterparties: { counts: input.counts, list: input.list },
      payments: input.payments,
    }),
  );

describe('toReports', () => {
  it('has a zero report for each day, with its keys in the order of the route', () => {
    const reports = build({ days: ['2015-01-14', '2015-01-15'] });
    expect(reports).toEqual([
      {
        account: ACCOUNT,
        date: '2015-01-14T00:00:00Z',
        high_value_received: '0',
        high_value_sent: '0',
        total_value_received: '0',
        total_value_sent: '0',
        total_value: '0',
        payments_sent: 0,
        payments_received: 0,
        receiving_counterparties: 0,
        sending_counterparties: 0,
      },
      expect.objectContaining({ date: '2015-01-15T00:00:00Z', total_value: '0' }),
    ]);
    expect(Object.keys(reports[0])).toEqual([
      'account',
      'date',
      'high_value_received',
      'high_value_sent',
      'total_value_received',
      'total_value_sent',
      'total_value',
      'payments_sent',
      'payments_received',
      'receiving_counterparties',
      'sending_counterparties',
    ]);
  });

  it('has no day for no days', () => {
    expect(build({ days: [] })).toEqual([]);
  });

  it('adds up the native amounts: the sum and the largest of each direction, and both for total_value', () => {
    const [r] = build({
      groups: [
        group('2015-01-14', 'sent', 'XRP', '', 3, '16.5', '10'),
        group('2015-01-14', 'received', 'XRP', '', 2, '502.25', '500'),
      ],
    });
    expect(r).toMatchObject({
      high_value_sent: '10',
      high_value_received: '500',
      total_value_sent: '16.5',
      total_value_received: '502.25',
      total_value: '518.75',
      payments_sent: 3,
      payments_received: 2,
    });
  });

  it('is exact where floats are not: 0.1 and 0.2 are 0.3', () => {
    const [r] = build({
      groups: [
        group('2015-01-14', 'sent', 'XRP', '', 2, '0.300000000000000000000000000000', '0.2'),
        group('2015-01-14', 'received', 'XRP', '', 1, '0.1', '0.1'),
      ],
    });
    expect([r.total_value_sent, r.total_value_received, r.total_value]).toEqual(['0.3', '0.1', '0.4']);
  });

  it('keeps the days apart', () => {
    const reports = build({
      days: ['2015-01-14', '2015-01-15', '2015-01-16'],
      groups: [
        group('2015-01-16', 'received', 'XRP', '', 1, '7', '7'),
        group('2015-01-14', 'sent', 'XRP', '', 1, '3', '3'),
      ],
    });
    expect(reports.map((r) => [r.date, r.total_value_sent, r.total_value_received])).toEqual([
      ['2015-01-14T00:00:00Z', '3', '0'],
      ['2015-01-15T00:00:00Z', '0', '0'],
      ['2015-01-16T00:00:00Z', '0', '7'],
    ]);
  });

  describe('an issued currency', () => {
    it('is the amount over the rate of its day (units per native coin), the largest one by its own amount', () => {
      const [a, b] = build({
        days: ['2015-01-14', '2015-01-15'],
        groups: [
          group('2015-01-14', 'sent', 'CNY', KIC, 2, '30', '20'),
          group('2015-01-14', 'received', 'CNY', KIC, 1, '5', '5'),
          group('2015-01-15', 'sent', 'CNY', KIC, 1, '30', '30'),
        ],
        rates: rates({ [`CNY.${KIC}`]: { '2015-01-14': '2', '2015-01-15': '6' } }),
      });
      expect(a).toMatchObject({
        high_value_sent: '10',
        total_value_sent: '15',
        high_value_received: '2.5',
        total_value_received: '2.5',
        total_value: '17.5',
        payments_sent: 2,
        payments_received: 1,
      });
      // the next day has its own rate
      expect(b).toMatchObject({ high_value_sent: '5', total_value_sent: '5', total_value: '5' });
    });

    it('is added to the native amounts, and the largest value is the largest across currencies', () => {
      const [r] = build({
        groups: [
          group('2015-01-14', 'received', 'XRP', '', 1, '4', '4'),
          group('2015-01-14', 'received', 'CNY', KIC, 2, '100', '60'),
          group('2015-01-14', 'received', 'EUR', MWJ, 1, '3', '3'),
        ],
        rates: rates({ [`CNY.${KIC}`]: { '2015-01-14': '10' }, [`EUR.${MWJ}`]: { '2015-01-14': '0.5' } }),
      });
      // CNY: 100 / 10 = 10 in total, 60 / 10 = 6 at most. EUR: 3 / 0.5 = 6
      expect(r).toMatchObject({ high_value_received: '6', total_value_received: '20', total_value: '20' });
      expect(r.payments_received).toBe(4);
      const [bigger] = build({
        groups: [
          group('2015-01-14', 'received', 'XRP', '', 1, '9', '9'),
          group('2015-01-14', 'received', 'CNY', KIC, 1, '60', '60'),
        ],
        rates: rates({ [`CNY.${KIC}`]: { '2015-01-14': '10' } }),
      });
      expect(bigger.high_value_received).toBe('9');
    });

    it('counts as 0 where it has no rate: 0, a day without one, or an asset the rates know nothing of', () => {
      const [a, b] = build({
        days: ['2015-01-14', '2015-01-15'],
        groups: [
          group('2015-01-14', 'sent', 'CNY', KIC, 2, '30', '20'),
          group('2015-01-14', 'sent', 'EUR', MWJ, 1, '8', '8'),
          group('2015-01-14', 'received', 'XRP', '', 1, '1', '1'),
          group('2015-01-15', 'sent', 'CNY', KIC, 1, '30', '30'),
        ],
        rates: rates({ [`CNY.${KIC}`]: { '2015-01-14': '0' } }),
      });
      expect(a).toMatchObject({
        high_value_sent: '0',
        total_value_sent: '0',
        total_value_received: '1',
        total_value: '1',
        payments_sent: 3,
        payments_received: 1,
      });
      expect(b).toMatchObject({ high_value_sent: '0', total_value: '0', payments_sent: 1 });
    });

    it('counts as 0 without an issuer, whatever the rates say', () => {
      const [r] = build({
        groups: [group('2015-01-14', 'sent', 'USD', '', 1, '50', '50')],
        rates: rates({ USD: { '2015-01-14': '1' } }),
      });
      expect(r).toMatchObject({ total_value_sent: '0', high_value_sent: '0', payments_sent: 1 });
    });

    it('cuts a quotient to 17 significant digits, whatever its size, and is exact where it is', () => {
      const third = (sum: string, rate: string): string =>
        build({
          groups: [group('2015-01-14', 'sent', 'CNY', KIC, 1, sum, sum)],
          rates: rates({ [`CNY.${KIC}`]: { '2015-01-14': rate } }),
        })[0].total_value_sent;
      expect(third('100', '3')).toBe('33.333333333333333');
      expect(third('1', '3e18')).toBe('3.3333333333333333e-19');
      expect(third('2e+30', '3')).toBe('6.6666666666666667e+29');
      expect(third('1.5', '0.25')).toBe('6');
    });
  });

  describe('the native currency', () => {
    it('is the one of the network: XAH on Xahau, and an issued XRP there is an issued currency', () => {
      const [xahau] = build({
        native: 'XAH',
        groups: [
          group('2015-01-14', 'received', 'XAH', '', 1, '12', '12'),
          group('2015-01-14', 'received', 'XRP', KIC, 1, '9', '9'),
        ],
        rates: rates({ [`XRP.${KIC}`]: { '2015-01-14': '3' } }),
      });
      expect(xahau).toMatchObject({ total_value_received: '15', high_value_received: '12' });
      // on the XRP Ledger the same XAH group is an issuer-less issued currency, which counts 0
      const [xrpl] = build({ groups: [group('2015-01-14', 'received', 'XAH', '', 1, '12', '12')] });
      expect(xrpl.total_value_received).toBe('0');
    });
  });

  describe('amounts a decimal cannot hold whole', () => {
    it('are summed as floats, the sum and the largest', () => {
      const [r] = build({
        groups: [
          group('2015-01-14', 'sent', 'XRP', '', 2, '1', '1', {
            unfit: 1,
            amount_sum_f: 1e40 + 1,
            amount_max_f: 1e40,
          }),
        ],
      });
      expect(r.total_value_sent).toBe('1e+40');
      expect(r.high_value_sent).toBe('1e+40');
    });

    it('count as 0 when there is nothing to sum', () => {
      const [r] = build({
        groups: [
          group('2015-01-14', 'sent', 'XRP', '', 1, '0', '0', {
            amount_sum: null,
            amount_max: null,
            amount_sum_f: null,
            amount_max_f: null,
          }),
        ],
      });
      expect(r.total_value_sent).toBe('0');
    });
  });

  describe('the counterparties', () => {
    it('are counted: those of the payments it sent are receiving, those of the payments it received sending', () => {
      const [r] = build({
        counts: [
          { day: '2015-01-14', dir: 'sent', n: 4 },
          { day: '2015-01-14', dir: 'received', n: 2 },
        ],
      });
      expect([r.receiving_counterparties, r.sending_counterparties]).toEqual([4, 2]);
    });

    it('are the list, in the order they came, with accounts', () => {
      const [r] = build({
        days: ['2015-01-14', '2015-01-15'],
        list: [
          { day: '2015-01-14', dir: 'sent', counterparty: 'rB' },
          { day: '2015-01-14', dir: 'sent', counterparty: 'rA' },
          { day: '2015-01-14', dir: 'received', counterparty: 'rC' },
        ],
      });
      expect(r.receiving_counterparties).toEqual(['rB', 'rA']);
      expect(r.sending_counterparties).toEqual(['rC']);
      const reports = build({ days: ['2015-01-14', '2015-01-15'], list: [] });
      expect([reports[1].receiving_counterparties, reports[1].sending_counterparties]).toEqual([[], []]);
    });
  });

  describe('the payments', () => {
    const payments: StoredReportPayment[] = [
      { day: '2015-01-14', tx_hash: 'AA', amount: '500', currency: 'XRP', issuer: '', type: 'received' },
      { day: '2015-01-14', tx_hash: 'BB', amount: '1.5', currency: 'CNY', issuer: KIC, type: 'sent' },
      { day: '2015-01-15', tx_hash: 'CC', amount: '2', currency: 'XRP', issuer: '', type: 'sent' },
    ];

    it('are left out unless asked for', () => {
      expect(build({ days: ['2015-01-14'] })[0]).not.toHaveProperty('payments');
    });

    it('are those of the day, in the order given, last in the report, without an issuer for the native currency', () => {
      const [a, b, c] = build({ days: ['2015-01-14', '2015-01-15', '2015-01-16'], payments });
      expect(Object.keys(a).pop()).toBe('payments');
      expect(a.payments).toEqual([
        { tx_hash: 'AA', amount: '500', currency: 'XRP', type: 'received' },
        { tx_hash: 'BB', amount: '1.5', currency: 'CNY', issuer: KIC, type: 'sent' },
      ]);
      expect(Object.keys((a.payments ?? [])[1])).toEqual(['tx_hash', 'amount', 'currency', 'issuer', 'type']);
      expect(b.payments).toEqual([{ tx_hash: 'CC', amount: '2', currency: 'XRP', type: 'sent' }]);
      expect(c.payments).toEqual([]);
    });
  });

  it('does not change its input or share objects with it', () => {
    const counts: StoredCounterpartyCount[] = [{ day: '2015-01-14', dir: 'sent', n: 1 }];
    const [r] = build({ counts, groups: [group('2015-01-14', 'sent', 'XRP', '', 1, '1', '1')] });
    expect(r.payments_sent).toBe(1);
    // (the build above froze every input deeply: an assignment to one would have thrown)
  });
});

describe('ratedAssets', () => {
  it('are the issued currencies with an issuer, each once', () => {
    expect(
      ratedAssets(
        [
          group('2015-01-14', 'sent', 'XRP', '', 1, '1', '1'),
          group('2015-01-14', 'sent', 'CNY', KIC, 1, '1', '1'),
          group('2015-01-14', 'received', 'CNY', KIC, 1, '1', '1'),
          group('2015-01-15', 'received', 'CNY', KIC, 1, '1', '1'),
          group('2015-01-14', 'received', 'EUR', MWJ, 1, '1', '1'),
          group('2015-01-14', 'received', 'USD', '', 1, '1', '1'),
        ],
        'XRP',
      ),
    ).toEqual([
      { currency: 'CNY', issuer: KIC },
      { currency: 'EUR', issuer: MWJ },
    ]);
  });

  it('are none for the native currency alone, which is the one of the network', () => {
    expect(ratedAssets([group('2015-01-14', 'sent', 'XAH', '', 1, '1', '1')], 'XAH')).toEqual([]);
    expect(ratedAssets([], 'XRP')).toEqual([]);
  });
});

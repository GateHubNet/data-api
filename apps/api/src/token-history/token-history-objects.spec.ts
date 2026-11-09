import {
  BUCKET_KEYS,
  COUNTERPARTY_KEYS,
  counterpartyRow,
  DISTRIBUTION_KEYS,
  distributionAnswer,
  distributionBucket,
  FLOWS_KEYS,
  FLOWS_PERIOD_KEYS,
  FLOWS_TOTALS_KEYS,
  flowsAnswer,
  flowsPeriod,
  flowsTotals,
  HOLDER_ROW_EXTRA_KEYS,
  ISSUER_TOKEN_KEYS,
  ISSUER_TOKENS_ANSWER_KEYS,
  issuerTokenRow,
  issuerTokensAnswer,
  SNAPSHOT_KEYS,
  SNAPSHOT_ROW_KEYS,
  snapshotAnswer,
  snapshotRow,
  SUMMARY_KEYS,
  SUMMARY_TOKEN_KEYS,
  SUMMARY_WINDOW_KEYS,
  summaryAnswer,
  summaryToken,
  summaryWindow,
  SUPPLY_ANSWER_KEYS,
  SUPPLY_ROW_KEYS,
  supplyAnswer,
  supplyRow,
  toIssuerTokenCsvRow,
  toSnapshotCsvRow,
  toSupplyCsvRow,
  WITHOUT_EXCLUDED_KEYS,
  withoutExcluded,
} from './token-history-objects';
import { SAMPLES } from './token-history-samples';

/** The same object with its keys in the reverse order, and every optional key named once more with `undefined`. */
const shuffled = (o: object, optional: readonly string[]): Record<string, unknown> => ({
  ...Object.fromEntries(optional.map((k) => [k, undefined])),
  ...Object.fromEntries(Object.entries(o).reverse()),
});

describe('the token history objects', () => {
  it('pins the orders of spec 5', () => {
    expect(ISSUER_TOKEN_KEYS).toEqual([
      'currency',
      'code',
      'kind',
      'supply',
      'holders',
      'trust_lines',
      'first_ledger',
      'last_ledger',
    ]);
    expect(SUMMARY_WINDOW_KEYS).toEqual([
      'start',
      'end',
      'issued',
      'redeemed',
      'clawed_back',
      'transferred',
      'transfers',
      'changes',
      'unknown_before',
      'exchanged',
      'trades',
      'exchanged_through',
    ]);
    expect(SUPPLY_ROW_KEYS).toEqual([
      'time',
      'ledger_index',
      'supply',
      'holders',
      'trust_lines',
      'issued',
      'redeemed',
      'clawed_back',
      'net',
      'unknown_before',
      'without_excluded',
    ]);
    expect(BUCKET_KEYS).toEqual(['min', 'max', 'holders', 'balance']);
    expect(COUNTERPARTY_KEYS).toEqual(['account', 'received', 'sent', 'net', 'changes']);
    expect(SNAPSHOT_ROW_KEYS).toEqual(['holder', 'balance', 'escrowed', 'limit', 'frozen', 'authorized']);
    expect(HOLDER_ROW_EXTRA_KEYS).toEqual(['first_ledger', 'last_ledger', 'escrowed']);
    expect(SNAPSHOT_KEYS.slice(0, 10)).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'ledger_hash',
      'close_time',
      'token',
      'supply',
      'holders',
      'trust_lines',
      'digest',
    ]);
    expect(FLOWS_PERIOD_KEYS).toEqual(['start', ...FLOWS_TOTALS_KEYS]);
  });

  it('the builders give the keys in their *_KEYS order and leave absent keys out', () => {
    const cases: [string, (o: never) => object, readonly string[], object, readonly string[]][] = [
      ['issuerTokensAnswer', issuerTokensAnswer, ISSUER_TOKENS_ANSWER_KEYS, SAMPLES.issuerTokens, ['marker']],
      ['issuerTokenRow', issuerTokenRow, ISSUER_TOKEN_KEYS, SAMPLES.issuerTokens.tokens[0], ['code']],
      ['summaryAnswer', summaryAnswer, SUMMARY_KEYS, SAMPLES.summary, ['excluded', 'without_excluded']],
      ['summaryToken', summaryToken, SUMMARY_TOKEN_KEYS, SAMPLES.summary.token, ['code']],
      [
        'summaryWindow',
        summaryWindow,
        SUMMARY_WINDOW_KEYS,
        SAMPLES.summary.windows['24h'],
        ['exchanged', 'trades', 'exchanged_through'],
      ],
      ['supplyAnswer', supplyAnswer, SUPPLY_ANSWER_KEYS, SAMPLES.supply, ['excluded', 'marker']],
      ['supplyRow', supplyRow, SUPPLY_ROW_KEYS, SAMPLES.supply.rows[0], ['without_excluded']],
      ['withoutExcluded', withoutExcluded, WITHOUT_EXCLUDED_KEYS, SAMPLES.summary.without_excluded!, []],
      [
        'distributionAnswer',
        distributionAnswer,
        DISTRIBUTION_KEYS,
        SAMPLES.distribution,
        ['excluded', 'without_excluded'],
      ],
      ['distributionBucket', distributionBucket, BUCKET_KEYS, SAMPLES.distribution.buckets[0], []],
      ['flowsAnswer', flowsAnswer, FLOWS_KEYS, SAMPLES.flows, []],
      [
        'flowsTotals',
        flowsTotals,
        FLOWS_TOTALS_KEYS,
        SAMPLES.flows.totals,
        ['exchanged', 'trades', 'exchanged_through'],
      ],
      [
        'flowsPeriod',
        flowsPeriod,
        FLOWS_PERIOD_KEYS,
        SAMPLES.flows.periods[0],
        ['exchanged', 'trades', 'exchanged_through'],
      ],
      ['counterpartyRow', counterpartyRow, COUNTERPARTY_KEYS, SAMPLES.flows.counterparties[0], []],
      ['snapshotAnswer', snapshotAnswer, SNAPSHOT_KEYS, SAMPLES.snapshot, ['without_excluded', 'excluded', 'marker']],
      ['snapshotRow', snapshotRow, SNAPSHOT_ROW_KEYS, SAMPLES.snapshot.balances[0], ['escrowed']],
    ];
    for (const [name, build, keys, sample, optional] of cases) {
      const full = build(shuffled(sample, []) as never);
      expect({ name, keys: Object.keys(full) }).toEqual({ name, keys: keys.filter((k) => k in sample) });
      const without = Object.fromEntries(Object.entries(sample).filter(([k]) => !optional.includes(k)));
      const built = build(shuffled(without, optional) as never);
      expect({ name, keys: Object.keys(built) }).toEqual({
        name,
        keys: keys.filter((k) => k in sample && !optional.includes(k)),
      });
    }
  });

  it('the CSV rows have every column, empty where the row has no value', () => {
    expect(
      Object.keys(toIssuerTokenCsvRow(issuerTokenRow({ ...SAMPLES.issuerTokens.tokens[0], code: undefined }))),
    ).toEqual([...ISSUER_TOKEN_KEYS]);
    const supply = toSupplyCsvRow(SAMPLES.supply.rows[0]);
    expect(Object.keys(supply)).toEqual([
      ...SUPPLY_ROW_KEYS.filter((k) => k !== 'without_excluded'),
      'without_excluded.supply',
      'without_excluded.holders',
      'without_excluded.trust_lines',
    ]);
    expect(Object.keys(toSnapshotCsvRow(SAMPLES.snapshot.balances[0]))).toEqual([...SNAPSHOT_ROW_KEYS]);
  });
});

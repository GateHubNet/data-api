import { HolderRow } from '../tokens/token-objects';
import {
  DistributionAnswer,
  FlowsAnswer,
  IssuerTokensAnswer,
  SnapshotAnswer,
  SummaryAnswer,
  SummaryWindow,
  SupplyAnswer,
} from './token-history-objects';

/**
 * One answer of each token history route, as the route writes it: the tests check the builders and the schemas against them, and
 * the API reference shows them. The figures fit together only loosely; they are shapes, not a ledger's state.
 */

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const HOLDER_A = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const HOLDER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const COVERAGE = { from_ledger_index: 32_570, complete: true };
const ENVELOPE = { coverage: COVERAGE, ledger_index: 99_000_000, close_time: '2026-11-08T12:00:00Z' } as const;

const window = (start: string): SummaryWindow => ({
  start,
  end: '2026-11-08T12:00:00Z',
  issued: '1500',
  redeemed: '250.5',
  clawed_back: '0',
  transferred: '98000.25',
  transfers: 412,
  changes: 1_031,
  unknown_before: 0,
  exchanged: '45000',
  trades: 87,
  exchanged_through: '2026-11-08T11:00:00Z',
});

const holders: { holders: HolderRow[] } & Record<string, unknown> = {
  result: 'success',
  ...ENVELOPE,
  supply: '1250000.5',
  count: 2,
  marker: 'WyIxMDAiLCJyTXdqWWVkamM3cXF0S1lWTGlBY2NKU21Dd2loNExuRTJxIl0',
  holders: [
    {
      rank: 1,
      holder: HOLDER_A,
      balance: '1000000',
      share: '0.799999',
      limit: '1000000000',
      frozen: false,
      authorized: false,
      first_ledger: 80_000_000,
      last_ledger: 98_999_000,
    } as HolderRow,
  ],
};

export const SAMPLES = {
  issuerTokens: {
    result: 'success',
    ...ENVELOPE,
    count: 2,
    marker: 'WyJVU0QiXQ',
    tokens: [
      {
        currency: 'USD',
        code: 'USD',
        kind: 'issued',
        supply: '1250000.5',
        holders: 1_204,
        trust_lines: 1_530,
        first_ledger: 40_000_000,
        last_ledger: 98_999_000,
      },
      {
        currency: '00000007B5F762798A53D543A014CAF8B297CFF8F2F937E8',
        kind: 'mpt',
        supply: '500000',
        holders: 12,
        trust_lines: 14,
        first_ledger: 99_226_400,
        last_ledger: 99_226_500,
      },
    ],
  } satisfies IssuerTokensAnswer,
  summary: {
    result: 'success',
    ...ENVELOPE,
    token: { currency: 'USD', issuer: ISSUER, kind: 'issued', code: 'USD' },
    supply: '1250000.5',
    holders: 1_204,
    trust_lines: 1_530,
    without_excluded: { supply: '250000.5', holders: 1_203, trust_lines: 1_529 },
    excluded: [HOLDER_A],
    first_ledger: 40_000_000,
    first_time: '2018-08-01T10:00:00Z',
    last_ledger: 98_999_000,
    last_time: '2026-11-08T11:00:00Z',
    windows: {
      '24h': window('2026-11-07T12:00:00Z'),
      '7d': window('2026-11-01T12:00:00Z'),
      '30d': window('2026-10-09T12:00:00Z'),
    },
  } satisfies SummaryAnswer,
  supply: {
    result: 'success',
    ...ENVELOPE,
    interval: 'day',
    excluded: [HOLDER_A],
    count: 1,
    marker: 'WzE3NjI1NjAwMDBd',
    rows: [
      {
        time: '2026-11-07T00:00:00Z',
        ledger_index: 98_980_000,
        supply: '1250000.5',
        holders: 1_204,
        trust_lines: 1_530,
        issued: '1500',
        redeemed: '250.5',
        clawed_back: '0',
        net: '1249.5',
        unknown_before: 0,
        without_excluded: { supply: '250000.5', holders: 1_203, trust_lines: 1_529 },
      },
    ],
  } satisfies SupplyAnswer,
  flows: {
    result: 'success',
    ...ENVELOPE,
    start: '2026-10-01T00:00:00Z',
    end: '2026-11-01T00:00:00Z',
    interval: 'day',
    totals: {
      issued: '1500',
      redeemed: '250.5',
      clawed_back: '0',
      transferred: '98000.25',
      transfers: 412,
      unknown_before: 0,
      exchanged: '45000',
      trades: 87,
      exchanged_through: '2026-11-01T00:00:00Z',
    },
    periods: [
      {
        start: '2026-10-01T00:00:00Z',
        issued: '1500',
        redeemed: '250.5',
        clawed_back: '0',
        transferred: '98000.25',
        transfers: 412,
        unknown_before: 0,
      },
    ],
    counterparties: [{ account: HOLDER_B, received: '5000', sent: '7500.25', net: '-2500.25', changes: 31 }],
  } satisfies FlowsAnswer,
  distribution: {
    result: 'success',
    ...ENVELOPE,
    supply: '1250000.5',
    holders: 1_204,
    buckets: [
      { min: '0.1', max: '1', holders: 3, balance: '1.5' },
      { min: '1', max: '10', holders: 0, balance: '0' },
    ],
    top: { '10': { balance: '1200000', share: '0.959999' }, '100': { balance: '1250000.5', share: '1.000000' } },
    excluded: [HOLDER_A],
    without_excluded: {
      supply: '250000.5',
      holders: 1_203,
      trust_lines: 1_529,
      buckets: [{ min: '0.1', max: '1', holders: 3, balance: '1.5' }],
      top: { '10': { balance: '200000', share: '0.799998' }, '100': { balance: '250000.5', share: '1.000000' } },
    },
  } satisfies DistributionAnswer,
  snapshot: {
    result: 'success',
    ...ENVELOPE,
    ledger_hash: 'AB'.repeat(32),
    token: { currency: 'USD', issuer: ISSUER, kind: 'issued', code: 'USD' },
    supply: '1250000.5',
    holders: 1_204,
    trust_lines: 1_530,
    digest: '7026d968e9ec57f2fee6c54aefb39a9a9ba0124f6900af79799c4e003c0dc589',
    without_excluded: { supply: '250000.5', holders: 1_203, trust_lines: 1_529 },
    excluded: [HOLDER_A],
    count: 1,
    marker: 'WyJyTXdqWWVkamM3cXF0S1lWTGlBY2NKU21Dd2loNExuRTJxIl0',
    balances: [{ holder: HOLDER_A, balance: '1000000', limit: '1000000000', frozen: false, authorized: false }],
  } satisfies SnapshotAnswer,
  holders,
};

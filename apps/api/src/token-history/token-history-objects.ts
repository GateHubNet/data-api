import { CsvRow, toCsvRow } from '../common/csv.interceptor';
import { Coverage } from '../common/feature-coverage.service';
import { HOLDER_ROW_KEYS } from '../tokens/token-objects';

/**
 * The answers of the token history's routes (spec 5): their keys in the order of `*_KEYS`, and builders that write them in that
 * order and leave a key with no value out (never `null`). Amounts are text, counts and ledgers numbers, times `YYYY-MM-DDTHH:mm:ssZ`.
 */

/** The object of `o`'s keys of `keys`, in that order, without those whose value is `undefined`; any other key is dropped. */
function ordered<T extends object>(o: T, keys: readonly string[]): T {
  const values = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (values[key] !== undefined) out[key] = values[key];
  return out as T;
}

export type TokenKindName = 'issued' | 'mpt';

// -- common ----------------------------------------------------------------------------------------------------------------

/** The figures without the excluded addresses (spec 5.0). */
export interface WithoutExcluded {
  supply: string;
  holders: number;
  trust_lines: number;
}
export const WITHOUT_EXCLUDED_KEYS = ['supply', 'holders', 'trust_lines'] as const;
export const withoutExcluded = (o: WithoutExcluded): WithoutExcluded => ordered(o, WITHOUT_EXCLUDED_KEYS);

/** The token of an answer: the currency (an issuance ID for an MPT), its issuer, its kind and its code as text, when it has one. */
export interface SummaryToken {
  currency: string;
  issuer: string;
  kind: TokenKindName;
  code?: string;
}
export const SUMMARY_TOKEN_KEYS = ['currency', 'issuer', 'kind', 'code'] as const;
export const summaryToken = (o: SummaryToken): SummaryToken => ordered(o, SUMMARY_TOKEN_KEYS);

// -- 5.1 the issuer's tokens -----------------------------------------------------------------------------------------------

export interface IssuerTokenRow {
  currency: string;
  code?: string;
  kind: TokenKindName;
  supply: string;
  holders: number;
  trust_lines: number;
  first_ledger: number;
  last_ledger: number;
}
export const ISSUER_TOKEN_KEYS = [
  'currency',
  'code',
  'kind',
  'supply',
  'holders',
  'trust_lines',
  'first_ledger',
  'last_ledger',
] as const;
export const issuerTokenRow = (o: IssuerTokenRow): IssuerTokenRow => ordered(o, ISSUER_TOKEN_KEYS);

export interface IssuerTokensAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  count: number;
  marker?: string;
  tokens: IssuerTokenRow[];
}
export const ISSUER_TOKENS_ANSWER_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'count',
  'marker',
  'tokens',
] as const;
export const issuerTokensAnswer = (o: IssuerTokensAnswer): IssuerTokensAnswer => ordered(o, ISSUER_TOKENS_ANSWER_KEYS);

// -- 5.2 the summary -------------------------------------------------------------------------------------------------------

export interface SummaryWindow {
  start: string;
  end: string;
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  transfers: number;
  changes: number;
  unknown_before: number;
  exchanged?: string;
  trades?: number;
  exchanged_through?: string;
}
export const SUMMARY_WINDOW_KEYS = [
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
] as const;
export const summaryWindow = (o: SummaryWindow): SummaryWindow => ordered(o, SUMMARY_WINDOW_KEYS);

export interface SummaryAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  token: SummaryToken;
  supply: string;
  holders: number;
  trust_lines: number;
  without_excluded?: WithoutExcluded;
  excluded?: string[];
  first_ledger?: number;
  first_time?: string;
  last_ledger?: number;
  last_time?: string;
  windows: { '24h': SummaryWindow; '7d': SummaryWindow; '30d': SummaryWindow };
}
export const SUMMARY_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'token',
  'supply',
  'holders',
  'trust_lines',
  'without_excluded',
  'excluded',
  'first_ledger',
  'first_time',
  'last_ledger',
  'last_time',
  'windows',
] as const;
export const summaryAnswer = (o: SummaryAnswer): SummaryAnswer => ordered(o, SUMMARY_KEYS);

// -- 5.3 the supply series -------------------------------------------------------------------------------------------------

export interface SupplyRow {
  time: string;
  ledger_index: number;
  supply: string;
  holders: number;
  trust_lines: number;
  issued: string;
  redeemed: string;
  clawed_back: string;
  /** `issued − redeemed − clawed_back`, signed. */
  net: string;
  unknown_before: number;
  without_excluded?: WithoutExcluded;
}
export const SUPPLY_ROW_KEYS = [
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
] as const;
export const supplyRow = (o: SupplyRow): SupplyRow => ordered(o, SUPPLY_ROW_KEYS);

export interface SupplyAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  interval: 'day' | 'hour' | 'ledger';
  excluded?: string[];
  count: number;
  marker?: string;
  rows: SupplyRow[];
}
export const SUPPLY_ANSWER_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'interval',
  'excluded',
  'count',
  'marker',
  'rows',
] as const;
export const supplyAnswer = (o: SupplyAnswer): SupplyAnswer => ordered(o, SUPPLY_ANSWER_KEYS);

// -- 5.4 the distribution --------------------------------------------------------------------------------------------------

/** A power of ten of the balances: `min` inclusive, `max` exclusive, as text (an MPT's in raw units). */
export interface DistributionBucket {
  min: string;
  max: string;
  holders: number;
  balance: string;
}
export const BUCKET_KEYS = ['min', 'max', 'holders', 'balance'] as const;
export const distributionBucket = (o: DistributionBucket): DistributionBucket => ordered(o, BUCKET_KEYS);

export interface TopEntry {
  balance: string;
  share: string;
}
export const TOP_ENTRY_KEYS = ['balance', 'share'] as const;
export interface DistributionTop {
  '10': TopEntry;
  '100': TopEntry;
}

export interface DistributionWithoutExcluded extends WithoutExcluded {
  buckets: DistributionBucket[];
  top: DistributionTop;
}
export const DISTRIBUTION_WITHOUT_KEYS = ['supply', 'holders', 'trust_lines', 'buckets', 'top'] as const;

export interface DistributionAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  supply: string;
  holders: number;
  buckets: DistributionBucket[];
  top: DistributionTop;
  excluded?: string[];
  without_excluded?: DistributionWithoutExcluded;
}
export const DISTRIBUTION_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'supply',
  'holders',
  'buckets',
  'top',
  'excluded',
  'without_excluded',
] as const;
export const distributionAnswer = (o: DistributionAnswer): DistributionAnswer => ordered(o, DISTRIBUTION_KEYS);

// -- 5.6 the flows ---------------------------------------------------------------------------------------------------------

export interface FlowsTotals {
  issued: string;
  redeemed: string;
  clawed_back: string;
  transferred: string;
  transfers: number;
  unknown_before: number;
  exchanged?: string;
  trades?: number;
  exchanged_through?: string;
}
export const FLOWS_TOTALS_KEYS = [
  'issued',
  'redeemed',
  'clawed_back',
  'transferred',
  'transfers',
  'unknown_before',
  'exchanged',
  'trades',
  'exchanged_through',
] as const;
export const flowsTotals = (o: FlowsTotals): FlowsTotals => ordered(o, FLOWS_TOTALS_KEYS);

export interface FlowsPeriod extends FlowsTotals {
  start: string;
}
export const FLOWS_PERIOD_KEYS = ['start', ...FLOWS_TOTALS_KEYS] as const;
export const flowsPeriod = (o: FlowsPeriod): FlowsPeriod => ordered(o, FLOWS_PERIOD_KEYS);

export interface Counterparty {
  account: string;
  received: string;
  sent: string;
  /** `received − sent`, signed. */
  net: string;
  changes: number;
}
export const COUNTERPARTY_KEYS = ['account', 'received', 'sent', 'net', 'changes'] as const;
export const counterpartyRow = (o: Counterparty): Counterparty => ordered(o, COUNTERPARTY_KEYS);

export interface FlowsAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  close_time: string;
  start: string;
  end: string;
  interval: 'day' | 'hour' | 'month';
  totals: FlowsTotals;
  periods: FlowsPeriod[];
  counterparties: Counterparty[];
}
export const FLOWS_KEYS = [
  'result',
  'coverage',
  'ledger_index',
  'close_time',
  'start',
  'end',
  'interval',
  'totals',
  'periods',
  'counterparties',
] as const;
export const flowsAnswer = (o: FlowsAnswer): FlowsAnswer => ordered(o, FLOWS_KEYS);

// -- 5.7 the snapshot ------------------------------------------------------------------------------------------------------

export interface SnapshotRow {
  holder: string;
  /** For an MPT, `amount + escrowed`. */
  balance: string;
  escrowed?: string;
  limit: string;
  frozen: boolean;
  authorized: boolean;
}
export const SNAPSHOT_ROW_KEYS = ['holder', 'balance', 'escrowed', 'limit', 'frozen', 'authorized'] as const;
export const snapshotRow = (o: SnapshotRow): SnapshotRow => ordered(o, SNAPSHOT_ROW_KEYS);

export interface SnapshotAnswer {
  result: 'success';
  coverage: Coverage;
  ledger_index: number;
  ledger_hash: string;
  close_time: string;
  token: SummaryToken;
  supply: string;
  holders: number;
  trust_lines: number;
  digest: string;
  without_excluded?: WithoutExcluded;
  excluded?: string[];
  count: number;
  marker?: string;
  balances: SnapshotRow[];
}
export const SNAPSHOT_KEYS = [
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
  'without_excluded',
  'excluded',
  'count',
  'marker',
  'balances',
] as const;
export const snapshotAnswer = (o: SnapshotAnswer): SnapshotAnswer => ordered(o, SNAPSHOT_KEYS);

// -- 5.5 the holders of D6 -------------------------------------------------------------------------------------------------

/** The keys a holder row of D6's `/holders` gains once it reads the token history: after D6's own, `escrowed` for an MPT. */
export const HOLDER_ROW_EXTRA_KEYS = ['first_ledger', 'last_ledger', 'escrowed'] as const;

/** A holder row of D6's `/holders` once it reads the token history: D6's keys (`HOLDER_ROW_KEYS`), then the extra ones. */
export const HOLDER_ROW_TOKEN_HISTORY_KEYS = [...HOLDER_ROW_KEYS, ...HOLDER_ROW_EXTRA_KEYS] as const;

// -- CSV -------------------------------------------------------------------------------------------------------------------

export function toIssuerTokenCsvRow(row: IssuerTokenRow): CsvRow {
  return toCsvRow(row, ISSUER_TOKEN_KEYS);
}

/** A supply row of the CSV: the row's keys, and with `exclude` the three `without_excluded.*` columns (every row of an answer has them or none). */
export function toSupplyCsvRow(row: SupplyRow): CsvRow {
  const own = SUPPLY_ROW_KEYS.filter((k) => k !== 'without_excluded');
  const without = row.without_excluded === undefined ? [] : WITHOUT_EXCLUDED_KEYS.map((k) => `without_excluded.${k}`);
  return toCsvRow(row, [...own, ...without]);
}

export function toSnapshotCsvRow(row: SnapshotRow): CsvRow {
  return toCsvRow(row, SNAPSHOT_ROW_KEYS);
}

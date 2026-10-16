import { Asset, assetKey, ratio, sumOf } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';

/** The side of a payment for the account whose report it is. */
export type ReportSide = 'sent' | 'received';

/**
 * What the aggregate query reads: the payments of one account on one UTC day, in one direction and one currency
 * (`GROUP BY day, dir, currency, issuer`), with their count, the exact sum and the largest of their delivered amounts,
 * and the same two as floats for the amounts a decimal cannot hold whole (`unfit` counts those: if there are any, the
 * floats are used, as `sumOf` has it).
 */
export interface StoredReportGroup {
  /** `YYYY-MM-DD` */
  day: string;
  dir: ReportSide;
  currency: string;
  /** `''` for the native currency */
  issuer: string;
  n: number;
  amount_sum: string | null;
  amount_max: string | null;
  unfit: number;
  amount_sum_f: number | null;
  amount_max_f: number | null;
}

/** How many different counterparties the account had on a day in one direction (without `accounts`). */
export interface StoredCounterpartyCount {
  day: string;
  dir: ReportSide;
  n: number;
}

/** A counterparty of the account on a day in one direction (with `accounts`), given in the order of its first payment. */
export interface StoredCounterparty {
  day: string;
  dir: ReportSide;
  counterparty: string;
}

/** A payment of a day (with `payments`), given in the order of the ledgers. */
export interface StoredReportPayment {
  day: string;
  tx_hash: string;
  amount: string;
  currency: string;
  /** `''` for the native currency */
  issuer: string;
  type: ReportSide;
}

/** The rate of each asset against the native currency for each day: `assetKey -> YYYY-MM-DD -> units per native coin`. */
export type ReportRates = Map<string, Map<string, BigNumber>>;

/** A payment of a report, as `accountPayments.js` kept it: the issuer is absent for the native currency. */
export interface ReportPayment {
  tx_hash: string;
  /** The delivered amount. */
  amount: string;
  currency: string;
  issuer?: string;
  type: ReportSide;
}

/**
 * The report of an account on a UTC day, with the keys in the order of the route. The values are in the native
 * currency of the network. `receiving_counterparties` are the accounts the account paid, `sending_counterparties` the
 * ones that paid it; each is their count, or the accounts themselves with `accounts`.
 */
export interface Report {
  account: string;
  /** `YYYY-MM-DDT00:00:00Z` */
  date: string;
  high_value_received: string;
  high_value_sent: string;
  total_value_received: string;
  total_value_sent: string;
  total_value: string;
  payments_sent: number;
  payments_received: number;
  receiving_counterparties: number | string[];
  sending_counterparties: number | string[];
  /** Only with `payments`: last, as the original added it. */
  payments?: ReportPayment[];
}

export interface ReportInput {
  account: string;
  /** The native currency of the network. */
  native: string;
  /** `YYYY-MM-DD`, oldest first. */
  days: string[];
  groups: StoredReportGroup[];
  rates: ReportRates;
  /** `list` (with `accounts`) gives the counterparties themselves, else `counts` their number. */
  counterparties: { counts?: StoredCounterpartyCount[]; list?: StoredCounterparty[] };
  /** Only with `payments`. */
  payments?: StoredReportPayment[];
}

const ZERO = new BigNumber(0);
const ZEROS = { total: ZERO, high: ZERO };

const isNative = (currency: string, issuer: string, native: string): boolean => currency === native && !issuer;

/**
 * The issued currencies whose rate a report needs: those of the groups that have an issuer, each once. The native
 * currency is itself, and an issued one without an issuer has no rate (the original counted it as 0: "this should not
 * happen").
 */
export function ratedAssets(groups: StoredReportGroup[], native: string): Asset[] {
  const assets = new Map<string, Asset>();
  for (const g of groups) {
    if (isNative(g.currency, g.issuer, native) || !g.issuer) continue;
    const asset = { currency: g.currency, issuer: g.issuer };
    assets.set(assetKey(asset), asset);
  }
  return [...assets.values()];
}

/** The significant digits of a quotient: what the double the original printed could tell apart. */
const QUOTIENT_DIGITS = 17;

/**
 * What the payments of a group are worth in the native currency: the sum of their amounts and the largest of them. The
 * original normalized each payment (the amount over the rate of the pair native/currency at its time) and added the
 * results up; the rate here is the one of the day, which is the same for every payment of a group, so the sum of the
 * quotients is the quotient of the sum and the largest quotient is the quotient of the largest.
 *
 * The native currency is worth itself, to the drop. An issued currency is worth 0 without an issuer, and where it has
 * no rate (0 or none for the day); where it has one the quotient is cut to 17 significant digits, the precision of the
 * rate itself being what it is (BigNumber's own 20 decimal places would give a small value fewer digits than a large
 * one).
 */
function worth(g: StoredReportGroup, native: string, rates: ReportRates): { total: BigNumber; high: BigNumber } {
  const total = sumOf(g.unfit, g.amount_sum, g.amount_sum_f);
  const high = new BigNumber((g.unfit > 0 ? g.amount_max_f : g.amount_max) ?? 0);
  if (isNative(g.currency, g.issuer, native)) return { total, high };
  if (!g.issuer) return ZEROS;
  const rate = rates.get(assetKey({ currency: g.currency, issuer: g.issuer }))?.get(g.day);
  if (!rate || !rate.gt(0)) return ZEROS;
  return {
    total: ratio(total, rate).precision(QUOTIENT_DIGITS),
    high: ratio(high, rate).precision(QUOTIENT_DIGITS),
  };
}

interface Side {
  n: number;
  total: BigNumber;
  high: BigNumber;
}

const sideKey = (day: string, dir: ReportSide): string => `${day}|${dir}`;

/** The reports of an account for the days given, one for each, whether or not it had a payment. */
export function toReports(input: ReportInput): Report[] {
  const sides = new Map<string, Side>();
  for (const g of input.groups) {
    const { total, high } = worth(g, input.native, input.rates);
    const key = sideKey(g.day, g.dir);
    const side = sides.get(key) ?? { n: 0, total: ZERO, high: ZERO };
    sides.set(key, { n: side.n + g.n, total: side.total.plus(total), high: BigNumber.max(side.high, high) });
  }

  const counts = new Map((input.counterparties.counts ?? []).map((c) => [sideKey(c.day, c.dir), c.n]));
  const lists = new Map<string, string[]>();
  for (const c of input.counterparties.list ?? []) {
    const key = sideKey(c.day, c.dir);
    lists.set(key, [...(lists.get(key) ?? []), c.counterparty]);
  }
  const withAccounts = input.counterparties.list !== undefined;
  const counterparties = (day: string, dir: ReportSide): number | string[] =>
    withAccounts ? (lists.get(sideKey(day, dir)) ?? []) : (counts.get(sideKey(day, dir)) ?? 0);

  const payments = new Map<string, ReportPayment[]>();
  for (const p of input.payments ?? []) {
    const list = payments.get(p.day) ?? [];
    list.push({
      tx_hash: p.tx_hash,
      amount: p.amount,
      currency: p.currency,
      ...(p.issuer !== '' && { issuer: p.issuer }),
      type: p.type,
    });
    payments.set(p.day, list);
  }

  return input.days.map((day): Report => {
    const sent = sides.get(sideKey(day, 'sent')) ?? { n: 0, total: ZERO, high: ZERO };
    const received = sides.get(sideKey(day, 'received')) ?? { n: 0, total: ZERO, high: ZERO };
    return {
      account: input.account,
      date: `${day}T00:00:00Z`,
      high_value_received: received.high.toString(),
      high_value_sent: sent.high.toString(),
      total_value_received: received.total.toString(),
      total_value_sent: sent.total.toString(),
      total_value: sent.total.plus(received.total).toString(),
      payments_sent: sent.n,
      payments_received: received.n,
      // the accounts the account paid receive from it, the ones that paid it send to it
      receiving_counterparties: counterparties(day, 'sent'),
      sending_counterparties: counterparties(day, 'received'),
      ...(input.payments !== undefined && { payments: payments.get(day) ?? [] }),
    };
  });
}

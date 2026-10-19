import { ClickHouseService, DailyRates, exactAmount, NetworkProfile, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { bucketStart, dayText, VolumeInterval } from '../network/volume-buckets';
import {
  ratedAssets,
  ratedDays,
  Report,
  ReportInput,
  StoredCounterparty,
  StoredCounterpartyCount,
  StoredReportGroup,
  StoredReportPayment,
  toReports,
} from './account-report-object';
import { bucketOfDaySql } from './analytics-window';

const DAY_MS = 86_400_000;

/** What `GET /v2/accounts/:address/reports` is asked for; the values are already validated. */
export interface AccountReportsQuery {
  account: string;
  /** The UTC days the reports are made of, `YYYY-MM-DD`, oldest first (`reportWindow`). */
  days: string[];
  /** The start of each report, `YYYY-MM-DD`, oldest first: the days, or the buckets of the `interval` (`reportWindow`). */
  buckets: string[];
  /** The bucket of a report. */
  interval: VolumeInterval;
  /** The counterparties themselves instead of their number. */
  accounts: boolean;
  /** The payments of each day. */
  payments: boolean;
}

/** The UTC day of a payment, `YYYY-MM-DD`. */
const DAY = "toString(toDate(close_time, 'UTC'))";

/**
 * The start of the bucket of a payment, `YYYY-MM-DD`: for `day` the day itself, which is `DAY` to the letter. The
 * counterparties are read by bucket, not added up from the days (one paid on two days of a week is one in it).
 */
const bucketOf = (interval: VolumeInterval): string =>
  `toString(${bucketOfDaySql(interval, "toDate(close_time, 'UTC')")})`;

/**
 * The side of a payment for the account. A payment to oneself has a row of each side (`sent` and `received`, two keys
 * of `account_payments` since R112, so a merge keeps both), and the original counted it once, as the sender's: it
 * tested `payment.account === payment.data.source` first, and only the rest was the receiver's side
 * (`lib/aggregation/accountPayments.js`). So both rows are the sender's here (the counterparty is the account itself),
 * whichever of them `LIMIT 1 BY` reads, and a payment to oneself is never in `payments_received` nor in
 * `sending_counterparties`.
 */
const SIDE = "if(counterparty = account, 'sent', toString(direction))";

/**
 * The rows of the account in the ledgers `[min, max]`, each payment once. The tables are not collapsed before a merge
 * and no FINAL is used, so a row that was written twice would be read twice, and a payment to oneself has two rows even
 * after a merge: `LIMIT 1 BY` the payment (`ledger_index, tx_index`) keeps one. The ORDER BY is the whole key of
 * `account_payments` (`account, ledger_index, tx_index, direction`), account included though it is fixed: ClickHouse then
 * reads the table in the order of its primary key and does not sort, as a suffix alone could make it read the whole
 * history of the account and sort it.
 */
function read(columns: string): string {
  return `SELECT ${columns} FROM ${Table.AccountPayments}
           WHERE account = {account:String} AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
           ORDER BY account, ledger_index, tx_index, direction
           LIMIT 1 BY ledger_index, tx_index`;
}

/**
 * The reports of an account (`getAggregateAccountPayments` of the original, which read the buckets `lib/aggregation/
 * accountPayments.js` filled as the payments came in; here they are made when they are asked for).
 *
 * The days become one range of ledgers (`LedgerRangeResolver`), and everything is read from the narrow
 * `account_payments`, in the order of its key (`ORDER BY account, ledger_index, tx_index, direction`, a row for each side of a
 * payment, with the currency, issuer and delivered amount). ClickHouse adds the payments up per day, direction and
 * currency (exact decimal sums, with the Float64 fallback of `decimal.ts`) and counts or lists the counterparties; only
 * those groups come back, not the payments, which are read only for `payments=true`.
 *
 * With an `interval` (`week` or `month`; `day` is as it always was) a report is a bucket: the groups stay per day, so that
 * each day is valued at its own rate and `toReports` adds the days of a bucket up, and the counterparties are counted or
 * listed over the bucket by the same queries, grouped by the start of the bucket.
 *
 * The value of an issued currency is its amount over the rate of its day (`DailyRates`, asked for the issued currencies
 * seen, on the days they were paid on: the stored sets of the days that have one, the rest computed on read). The original
 * used the rate of the moment of each payment, which it asked HBase for one by one; a rate per day is the same for every
 * payment of the day, which is what lets ClickHouse add them up first. It is the rate at the end of the day: the trades of
 * the day, and the last trades of the 14 days before it.
 */
@Injectable()
export class AccountReportsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly rates: DailyRates,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The report of each bucket asked for (each day, with `day`), oldest first. */
  async reports(q: AccountReportsQuery): Promise<Report[]> {
    const input: ReportInput = {
      account: q.account,
      native: this.profile.nativeCurrency,
      days: q.days,
      buckets: q.buckets,
      bucketOf: (day) => dayText(bucketStart(Date.parse(`${day}T00:00:00Z`), q.interval)),
      groups: [],
      rates: new Map(),
      counterparties: q.accounts ? { list: [] } : { counts: [] },
      ...(q.payments && { payments: [] }),
    };
    if (q.days.length === 0) return toReports(input);

    const from = new Date(`${q.days[0]}T00:00:00Z`);
    const toExclusive = new Date(Date.parse(`${q.days[q.days.length - 1]}T00:00:00Z`) + DAY_MS);
    const range = await this.ranges.resolve(from, toExclusive);
    if (!range) return toReports(input);
    const params = { account: q.account, min: range.min, max: range.max };

    const [groups, counterparties, payments] = await Promise.all([
      this.groups(params),
      q.accounts ? this.counterpartyList(params, q.interval) : this.counterpartyCounts(params, q.interval),
      q.payments ? this.payments(params) : undefined,
    ]);

    const assets = ratedAssets(groups, input.native);
    const rates = assets.length > 0 ? await this.rates.rates(assets, ratedDays(groups, input.native)) : new Map();
    return toReports({
      ...input,
      groups,
      rates,
      counterparties: q.accounts
        ? { list: counterparties as StoredCounterparty[] }
        : { counts: counterparties as StoredCounterpartyCount[] },
      ...(payments !== undefined && { payments }),
    });
  }

  /** The payments of each day, direction and currency: their count, and the sum and the largest of their amounts. */
  private groups(params: Record<string, unknown>): Promise<StoredReportGroup[]> {
    return this.ch.query<StoredReportGroup>(
      `SELECT day, dir, currency, issuer,
              toUInt32(count()) AS n,
              toString(sum(delivered_exact)) AS amount_sum,
              toString(max(delivered_exact)) AS amount_max,
              toUInt32(countIf(delivered_exact IS NULL)) AS unfit,
              sumKahan(delivered_amount_f) AS amount_sum_f,
              max(delivered_amount_f) AS amount_max_f
         FROM (${read(`${DAY} AS day, ${SIDE} AS dir, currency, issuer, delivered_amount_f, ${exactAmount('delivered_amount')} AS delivered_exact`)})
        GROUP BY day, dir, currency, issuer`,
      params,
    );
  }

  /** How many different accounts the account paid and was paid by in each bucket (`day` is its start). */
  private counterpartyCounts(
    params: Record<string, unknown>,
    interval: VolumeInterval,
  ): Promise<StoredCounterpartyCount[]> {
    return this.ch.query<StoredCounterpartyCount>(
      `SELECT day, dir, toUInt32(uniqExact(counterparty)) AS n
         FROM (${read(`${bucketOf(interval)} AS day, ${SIDE} AS dir, counterparty`)})
        GROUP BY day, dir`,
      params,
    );
  }

  /** The accounts it paid and was paid by in each bucket, each once, in the order of the first payment in it. */
  private counterpartyList(params: Record<string, unknown>, interval: VolumeInterval): Promise<StoredCounterparty[]> {
    return this.ch.query<StoredCounterparty>(
      `SELECT day, dir, counterparty
         FROM (${read(`${bucketOf(interval)} AS day, ${SIDE} AS dir, counterparty, ledger_index, tx_index`)})
        GROUP BY day, dir, counterparty
        ORDER BY day, dir, min(tuple(ledger_index, tx_index))`,
      params,
    );
  }

  /** Every payment, in the order of the ledgers. */
  private payments(params: Record<string, unknown>): Promise<StoredReportPayment[]> {
    return this.ch.query<StoredReportPayment>(
      read(`${DAY} AS day, tx_hash, delivered_amount AS amount, currency, issuer, ${SIDE} AS type`),
      params,
    );
  }
}

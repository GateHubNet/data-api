import {
  AccountDayGroups,
  ClickHouseService,
  DayGroupFamily,
  DayGroupsSource,
  rollupCoverage,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** How long the days an account's rollups cover are kept: the aggregator moves them once a day, or once a slice. */
export const ROLLUP_COVERAGE_CACHE_MS = 60_000;

/**
 * The day groups of an account (`AccountDayGroups` of the shared package) as the API reads them: the ledger ranges of the
 * raw part come from the `LedgerRangeResolver`, the days the account's rollups cover from its state row, kept for a minute
 * per account in the `CacheService` (a heavy account is read many times a minute, its state changes a few times a day), and
 * each source a read uses is counted in `api_account_day_groups_total{source}`, once per read.
 */
@Injectable()
export class AccountDayGroupsService {
  private readonly groups: AccountDayGroups;

  constructor(
    ch: ClickHouseService,
    ranges: LedgerRangeResolver,
    cache: CacheService,
    private readonly metrics: PrometheusService,
  ) {
    this.groups = new AccountDayGroups(
      ch,
      (from, toExclusive) => ranges.resolve(from, toExclusive),
      (account) =>
        cache.wrap(`rollup-coverage:${account}`, ROLLUP_COVERAGE_CACHE_MS, () => rollupCoverage(ch, account)),
    );
  }

  /**
   * The groups of `family` of the UTC days `fromDay` to `throughDay` (`YYYY-MM-DD`, both included) of an account, as a
   * SELECT to use as a subquery with its bound params, or `null` when no day of the window has a source.
   */
  async source(
    family: DayGroupFamily,
    account: string,
    fromDay: string,
    throughDay: string,
  ): Promise<DayGroupsSource | null> {
    const found = await this.groups.source(family, account, fromDay, throughDay);
    for (const source of found?.sources ?? []) this.metrics.accountDayGroupsTotal.inc({ source });
    return found;
  }
}

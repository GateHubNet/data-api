import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  firstChangeDay,
  RatesService,
  RollupCoverage,
  Table,
  writeAccountRollups,
  writeRollupStates,
} from '@gatehub/data-api-shared';
import type { ApiClient, Harness } from '../harness';

/**
 * Rolls an account up the way the syncer's aggregator does, for the days of `coverage` (`YYYY-MM-DD`, both included): the
 * rollup rows and sentinels of those days, then the state row that says the account is covered by them. The app keeps
 * the coverage of an account for 60 s, so the cache is emptied through the test route of `cache-controllers.ts` (the
 * harness has to be started with `CACHE_CONTROLLERS`): the next request reads the new coverage.
 *
 * A second call for the same account writes a newer state row, so its coverage replaces the first; a day that is not
 * covered any more is read from the raw rows again.
 */
export async function rollUp(h: Harness, api: ApiClient, account: string, coverage: RollupCoverage): Promise<void> {
  // only the ledgers of a window are asked of it: the native currency makes no difference
  const rates = new RatesService(h.ch, 'XRP');
  await writeAccountRollups(
    h.ch,
    (from, toExclusive) => rates.ledgersClosedIn(from, toExclusive),
    [account],
    coverage.from,
    coverage.through,
  );
  const [counted] = await h.ch.query<{ n: string }>(
    `SELECT count() AS n FROM ${Table.BalanceChanges} WHERE account = {account:String}`,
    { account },
  );
  await writeRollupStates(h.ch, [
    {
      account,
      rows: Number(counted.n),
      firstDay: (await firstChangeDay(h.ch, account)) ?? coverage.from,
      rolledFrom: coverage.from,
      rolledThrough: coverage.through,
      configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
    },
  ]);
  await api.ok('/v2/test-cache/clear', 'result');
}

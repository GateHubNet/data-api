import { ClickHouseService, RatesService, Table } from '@gatehub/data-api-shared';
import { AggregatorOptions, AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * What the two e2e suites of the account and market jobs (`aggregator-aggregates` and `aggregator-aggregates-amm`)
 * share: the fake metrics, the aggregator they build, its generous budgets, and the readers of the sentinels of the
 * rates and of the heavy accounts' rollups.
 */

const NOOP = (): void => undefined;

/** The metrics of the aggregator and of the account and market jobs, over fakes. */
export const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  pairHourlyMissingHours: { set: jest.fn() },
  marketsLiveAgeSeconds: { set: jest.fn() },
  marketsLiveAmmShareKnown: { set: jest.fn() },
  ratesDailyMissingDays: { set: jest.fn() },
  accountRollupsHeavyAccounts: { set: jest.fn() },
  accountRollupsPendingAccounts: { set: jest.fn() },
});
export type FakeMetrics = ReturnType<typeof fakeMetrics>;

/** The aggregators `aggregator()` built in this suite (jest loads a module once per suite), for `stopAggregators`. */
const built: AggregatorService[] = [];

/**
 * An aggregator with the account and market jobs (and the stats jobs; the volume jobs have their own e2e), with
 * `aggregates` over the world's rates and 5 as the size of a heavy account. Its errors are collected in `errors`.
 */
export function aggregator(
  ch: ClickHouseService,
  metrics: FakeMetrics,
  options: AggregatorOptions = {},
): { svc: AggregatorService; errors: jest.Mock } {
  const errors = jest.fn();
  const svc = new AggregatorService(ch, metrics as never, undefined, {
    logger: { log: NOOP, warn: NOOP, debug: NOOP, error: errors },
    aggregates: { rates: new RatesService(ch, 'XRP'), accountRollupMinRows: 5 },
    ...options,
  });
  built.push(svc);
  return { svc, errors };
}

/** Stops every aggregator `aggregator()` built; for the `afterAll` of a suite. */
export async function stopAggregators(): Promise<void> {
  for (const svc of built.splice(0)) await svc.stop();
}

/** Budgets that are never the limit of a tick or of a job (a slow machine must not make a test flaky). */
export const GENEROUS: AggregatorOptions = {
  tickBudgetMs: 10 * 60_000,
  budgetsMs: {
    pair_hourly: 5 * 60_000,
    markets_live: 5 * 60_000,
    rates_daily: 5 * 60_000,
    account_rollups: 5 * 60_000,
  },
};

/** `[version, stale]` of every sentinel written for a day of `native_rates_daily`, oldest first (merges stopped). */
export async function rateSentinels(ch: ClickHouseService, day: string): Promise<Array<[number, number]>> {
  const rows = await ch.query<{ version: number | string; stale: number | string }>(
    `SELECT toUInt64(version) AS version, stale FROM ${Table.NativeRatesDaily}
      WHERE currency = '' AND issuer = '' AND day = {day:Date} ORDER BY version`,
    { day },
  );
  return rows.map((r): [number, number] => [Number(r.version), Number(r.stale)]);
}

/** The versions of the sentinels of an (account, day) rollup set, oldest first (merges are stopped). */
export async function rollupSentinels(ch: ClickHouseService, account: string, day: string): Promise<number[]> {
  const rows = await ch.query<{ version: number | string }>(
    `SELECT toUInt64(version) AS version FROM ${Table.AccountRollupDays}
      WHERE account = {account:String} AND day = {day:Date} ORDER BY version`,
    { account, day },
  );
  return rows.map((r) => Number(r.version));
}

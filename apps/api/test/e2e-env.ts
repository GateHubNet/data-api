/** The URL of the ClickHouse server every e2e suite shares (each suite creates its own database on it). */
export const E2E_CLICKHOUSE_URL = 'GH_E2E_CLICKHOUSE_URL';

/** Where `globalSetup` leaves the container for `globalTeardown` (both run in the jest parent process). */
export const E2E_CLICKHOUSE_HANDLE = '__GH_E2E_CLICKHOUSE__';

/** The URL of the shared ClickHouse server; an e2e suite run outside `pnpm test:e2e` has none. */
export function clickHouseUrl(): string {
  const url = process.env[E2E_CLICKHOUSE_URL];
  if (!url) {
    throw new Error(
      `${E2E_CLICKHOUSE_URL} is not set: run the e2e suites through "pnpm test:e2e" (jest globalSetup starts ClickHouse)`,
    );
  }
  return url;
}

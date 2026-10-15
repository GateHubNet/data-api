import { startClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { E2E_CLICKHOUSE_HANDLE, E2E_CLICKHOUSE_URL } from './e2e-env';

/**
 * Starts ONE ClickHouse container for all e2e suites of the API and exports its URL through the environment, which
 * the test files inherit. A suite never writes to the server's default database: `startHarness()` gives each app a
 * fresh random one.
 */
export default async function globalSetup(): Promise<void> {
  const clickhouse = await startClickHouse();
  (globalThis as Record<string, unknown>)[E2E_CLICKHOUSE_HANDLE] = clickhouse;
  process.env[E2E_CLICKHOUSE_URL] = clickhouse.url;
}

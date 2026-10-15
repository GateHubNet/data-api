import { StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { E2E_CLICKHOUSE_HANDLE } from './e2e-env';

export default async function globalTeardown(): Promise<void> {
  const clickhouse = (globalThis as Record<string, unknown>)[E2E_CLICKHOUSE_HANDLE] as StartedClickHouse | undefined;
  await clickhouse?.container.stop();
}

/** Strongly-typed syncer configuration, read once from the environment. */
export interface SyncerConfig {
  xrplEndpoint: string;
  networkId: number;
  runMigrationsOnBoot: boolean;
  backfillEnabled: boolean;
  backfillStartLedger?: number;
  backfillEndLedger?: number;
  backfillWorkers: number;
  /** Flush to ClickHouse once this many ledgers are buffered. */
  backfillBatchLedgers: number;
  /** Split [start,end] into N contiguous slices; this instance handles slice #index. */
  shardIndex: number;
  shardTotal: number;
  subscribeLive: boolean;
  fetchThrottleMs: number;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

export function syncerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncerConfig {
  const endpoint = env.GH_XRPL_NODE_ENDPOINT;
  if (!endpoint) {
    throw new Error('GH_XRPL_NODE_ENDPOINT is required.');
  }
  return {
    xrplEndpoint: endpoint,
    networkId: num(env.GH_XRPL_NETWORK_ID) ?? 0,
    runMigrationsOnBoot: env.GH_RUN_MIGRATIONS_ON_BOOT !== 'false',
    backfillEnabled: env.GH_BACKFILL_ENABLED === 'true',
    backfillStartLedger: num(env.GH_BACKFILL_START_LEDGER),
    backfillEndLedger: num(env.GH_BACKFILL_END_LEDGER),
    backfillWorkers: num(env.GH_BACKFILL_WORKERS) ?? 8,
    backfillBatchLedgers: num(env.GH_BACKFILL_BATCH_LEDGERS) ?? 500,
    shardIndex: num(env.GH_BACKFILL_SHARD_INDEX) ?? 0,
    shardTotal: num(env.GH_BACKFILL_SHARD_TOTAL) ?? 1,
    subscribeLive: env.GH_SUBSCRIBE_LIVE === 'true',
    fetchThrottleMs: num(env.GH_FETCH_THROTTLE_MS) ?? 100,
  };
}

export const SYNCER_CONFIG = Symbol('SYNCER_CONFIG');

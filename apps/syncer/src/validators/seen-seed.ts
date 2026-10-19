import { ClickHouseService, Table } from '@gatehub/data-api-shared';

/**
 * How much newer than the oldest validation the oldest `first_seen` may be before `validator_seen` is taken for one that was
 * not seeded: the collector's own first rows are written within the hour of its start, the history is far older than that.
 */
export const SEED_TOLERANCE_SECONDS = 3600;

export interface SeedOptions {
  /** Aborted at shutdown: no further partition is started. */
  signal?: AbortSignal;
}

/**
 * Fills `validator_seen` from `validations` (spec 1.5) when it was not filled yet: when the table has no row, or when its oldest
 * `first_seen` is more than an hour newer than the oldest validation of the oldest active partition of `validations` (the
 * collector wrote its first rows before the seeding did). One row per validator key of `validations` with its first and last
 * time of receipt and its newest ledger. The collector keeps the table up to date from then on, so a validator is "first seen"
 * by this deployment even after the 90 days of `validations` are gone.
 *
 * The seeding is one `INSERT ... SELECT` per partition of `validations`, newest first, so that each statement fits the request
 * timeout of ClickHouse. The order is what makes an interrupted seeding (a failure, a shutdown) show: the oldest partition is the
 * last one done, so until it is, the oldest `first_seen` is still newer than the oldest validation and the next start seeds again.
 * `min` and `max` are idempotent, so a partition done twice, or beside the collector's rows, is harmless.
 *
 * Resolves `true` when it seeded at least one partition and `false` when there was nothing to do. It throws when ClickHouse
 * fails; what was inserted stays.
 */
export async function seedValidatorSeen(
  ch: Pick<ClickHouseService, 'query' | 'command'>,
  options: SeedOptions = {},
): Promise<boolean> {
  const partitions = await ch.query<{ partition_id: string }>(
    `SELECT DISTINCT partition_id
       FROM system.parts
      WHERE database = currentDatabase() AND table = {table:String} AND active
      ORDER BY partition_id DESC`,
    { table: Table.Validations },
  );
  if (partitions.length === 0) return false;
  const oldest = partitions[partitions.length - 1].partition_id;

  const seen = await ch.query<{ seen_rows: number | string; oldest_seen: number | string }>(
    `SELECT count() AS seen_rows, toUnixTimestamp64Milli(min(first_seen)) AS oldest_seen FROM ${Table.ValidatorSeen}`,
  );
  if (Number(seen[0]?.seen_rows ?? 0) > 0) {
    const validated = await ch.query<{ oldest_validation: number | string }>(
      `SELECT toUnixTimestamp64Milli(min(first_datetime)) AS oldest_validation
         FROM ${Table.Validations}
        WHERE _partition_id = {partition:String}`,
      { partition: oldest },
    );
    const oldestValidation = Number(validated[0]?.oldest_validation ?? 0);
    if (Number(seen[0].oldest_seen) <= oldestValidation + SEED_TOLERANCE_SECONDS * 1000) return false;
  }

  let seeded = false;
  for (const { partition_id: partition } of partitions) {
    if (options.signal?.aborted) return seeded;
    await ch.command(
      `INSERT INTO ${Table.ValidatorSeen} (validation_public_key, first_seen, last_seen, last_ledger_index)
       SELECT validation_public_key, min(first_datetime), max(last_datetime), max(ledger_index)
         FROM ${Table.Validations}
        WHERE _partition_id = {partition:String}
        GROUP BY validation_public_key`,
      { partition },
    );
    seeded = true;
  }
  return seeded;
}

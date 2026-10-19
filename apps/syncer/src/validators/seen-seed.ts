import { ClickHouseService, Table } from '@gatehub/data-api-shared';

/**
 * Fills `validator_seen` from `validations` the first time the worker starts (spec 1.5): when the table holds no row, one row per
 * validator key of `validations` with its first and last time of receipt and its newest ledger. The collector keeps the table up to
 * date from then on, so a validator is "first seen" by this deployment even after the 90 days of `validations` are gone.
 * Resolves `true` when it seeded and `false` when the table already had a row, and then does nothing. The seeding is idempotent
 * (`min` and `max`), so one that ran twice, or beside the collector's own first rows, is harmless.
 */
export async function seedValidatorSeen(ch: Pick<ClickHouseService, 'query' | 'command'>): Promise<boolean> {
  const present = await ch.query(`SELECT 1 FROM ${Table.ValidatorSeen} LIMIT 1`);
  if (present.length > 0) return false;
  await ch.command(
    `INSERT INTO ${Table.ValidatorSeen} (validation_public_key, first_seen, last_seen, last_ledger_index)
     SELECT validation_public_key, min(first_datetime), max(last_datetime), max(ledger_index)
       FROM ${Table.Validations}
      GROUP BY validation_public_key`,
  );
  return true;
}

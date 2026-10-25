import { ClickHouseService, LOCAL_PUBLISHER_ID, StoredUnlList, Table } from '@gatehub/data-api-shared';
import { SyncerConfig, unlPublishersOf, unlThresholdOf, unlValidatorsOf } from '../config/syncer.config';

interface StoredListRow {
  publisher: string;
  publisher_key: string;
  sequence: number | string;
  version: number | string;
  effective: number | string | null;
  expiration: number | string;
  validators: string[];
  fetched_ms: number | string;
}

/**
 * The lists the given publishers served, as stored in `unl_lists`: one entry per `(publisher, sequence)`, the newest row
 * (by `fetched_at`) standing for it, in the order of the table's key, each with the key it was served under
 * (`publisherKey`). Without publishers there is nothing to read.
 */
export async function readStoredLists(
  ch: Pick<ClickHouseService, 'query'>,
  publishers: readonly string[],
): Promise<StoredUnlList[]> {
  if (publishers.length === 0) return [];
  const rows = await ch.query<StoredListRow>(
    `SELECT publisher, sequence,
            argMax(publisher_key, fetched_at) AS publisher_key,
            argMax(version, fetched_at) AS version,
            toUnixTimestamp(argMax(effective, fetched_at)) AS effective,
            toUnixTimestamp(argMax(expiration, fetched_at)) AS expiration,
            argMax(validators, fetched_at) AS validators,
            toUnixTimestamp64Milli(max(fetched_at)) AS fetched_ms
       FROM ${Table.UnlLists}
      WHERE publisher IN {publishers:Array(String)}
      GROUP BY publisher, sequence
      ORDER BY publisher, sequence`,
    { publishers: [...publishers] },
  );
  return rows.map((row) => ({
    publisher: row.publisher,
    publisherKey: row.publisher_key,
    sequence: Number(row.sequence),
    version: Number(row.version),
    ...(row.effective === null ? {} : { effective: Number(row.effective) }),
    expiration: Number(row.expiration),
    validators: row.validators,
    fetchedAt: Number(row.fetched_ms) / 1000,
  }));
}

/** What a run of a compute job (`rounds`, `agreement`) reads once, and the rounds or hours of the run share. */
export interface ListContext {
  /** Every list of `publishers`, whatever key it was served under: a round or an hour reads the past. */
  lists: StoredUnlList[];
  /** The ids of the configured publishers, then `local` when the fixed list (`GH_UNL_VALIDATORS`) is not empty. */
  publishers: string[];
  /** The number of lists that must name a validator for it to be trusted (`unlThresholdOf`, which counts the fixed list too). */
  threshold: number;
}

/**
 * The `ListContext` of a run: the stored lists of the configured publishers and, when the fixed list is not empty, of the
 * publisher `local` that stores it, and the threshold.
 */
export async function loadListContext(
  ch: Pick<ClickHouseService, 'query'>,
  cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlValidators' | 'unlThreshold'>,
): Promise<ListContext> {
  const publishers = unlPublishersOf(cfg).map((publisher) => publisher.id);
  if (unlValidatorsOf(cfg).length > 0) publishers.push(LOCAL_PUBLISHER_ID);
  return { lists: await readStoredLists(ch, publishers), publishers, threshold: unlThresholdOf(cfg) };
}

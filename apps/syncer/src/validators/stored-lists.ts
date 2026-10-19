import { ClickHouseService, StoredUnlList, Table } from '@gatehub/data-api-shared';

interface StoredListRow {
  publisher: string;
  sequence: number | string;
  version: number | string;
  effective: number | string | null;
  expiration: number | string;
  validators: string[];
  fetched_ms: number | string;
}

/**
 * The lists the given publishers served, as stored in `unl_lists`: one entry per `(publisher, sequence)`, the newest row
 * (by `fetched_at`) standing for it, in the order of the table's key. Without publishers there is nothing to read.
 */
export async function readStoredLists(
  ch: Pick<ClickHouseService, 'query'>,
  publishers: readonly string[],
): Promise<StoredUnlList[]> {
  if (publishers.length === 0) return [];
  const rows = await ch.query<StoredListRow>(
    `SELECT publisher, sequence,
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
    sequence: Number(row.sequence),
    version: Number(row.version),
    ...(row.effective === null ? {} : { effective: Number(row.effective) }),
    expiration: Number(row.expiration),
    validators: row.validators,
    fetchedAt: Number(row.fetched_ms) / 1000,
  }));
}

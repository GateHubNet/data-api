import { ClickHouseService, SharedTable } from '@gatehub/data-api-shared';
import type { NamesAndLabels, NamesAndLabelsSet } from './names-and-labels.service';

/**
 * The name of every address of a names table (`account_names` of the shared database, `account_network_names` of a
 * network's): the newest row of an address wins (largest `added_at`; at the same instant a removal wins), and the
 * address has no name when that row is a removal (`removed = 1`) or names nothing. The newest row of each address is
 * kept with `argMax`, never `FINAL` (ADR-0003): the tables are append-only and keep every row.
 */
export async function newestNames(ch: ClickHouseService, table: string): Promise<Map<string, string>> {
  const rows = await ch.query<{ address: string; name: string }>(
    `SELECT address, newest.1 AS name
       FROM (SELECT address, argMax((name, removed), (added_at, removed)) AS newest FROM ${table} GROUP BY address)
      WHERE newest.2 = 0 AND newest.1 != ''`,
  );
  return new Map(rows.map((row) => [row.address, row.name]));
}

/** The account names (ADR-0014): `account_names` of the shared database, the same on every network (`newestNames`). */
export const ACCOUNT_NAMES: NamesAndLabelsSet = {
  name: 'account names',
  async load({ ch, shared }) {
    const names = await newestNames(ch, `${shared}.${SharedTable.AccountNames}`);
    return new Map<string, NamesAndLabels>([...names].map(([address, name]) => [address, { account_name: name }]));
  },
};

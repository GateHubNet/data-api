import { Table } from '@gatehub/data-api-shared';
import type { NamesAndLabels, NamesAndLabelsSet } from './names-and-labels.service';

/**
 * The account network names (ADR-0014): `account_network_names` of the app's own network database, so a name given on
 * one network shows on that network only. The rules are those of the account names: the newest row of an address wins
 * (largest `added_at`; at the same instant a removal wins), and the address has no network name when that row is a
 * removal (`removed = 1`) or names nothing. Every address's newest row is taken with `LIMIT 1 BY`, never `FINAL`: the
 * table is append-only and keeps every row.
 */
export const ACCOUNT_NETWORK_NAMES: NamesAndLabelsSet = {
  name: 'account network names',
  async load({ ch }) {
    const rows = await ch.query<{ address: string; name: string }>(
      `SELECT address, name
         FROM (
           SELECT address, name, removed
             FROM ${Table.AccountNetworkNames}
            ORDER BY address, added_at DESC, removed DESC
            LIMIT 1 BY address
         )
        WHERE removed = 0 AND name != ''`,
    );
    return new Map<string, NamesAndLabels>(rows.map((row) => [row.address, { account_network_name: row.name }]));
  },
};

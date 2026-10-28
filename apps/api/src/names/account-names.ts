import { SharedTable } from '@gatehub/data-api-shared';
import type { NamesAndLabels, NamesAndLabelsSet } from './names-and-labels.service';

/**
 * The account names (ADR-0014): `account_names` of the shared database, the same on every network. The newest row of an
 * address wins (largest `added_at`; at the same instant a removal wins), and the address has no name when that row is a
 * removal (`removed = 1`) or names nothing. Every address's newest row is taken with `LIMIT 1 BY`, never `FINAL`: the
 * table is append-only and keeps every row.
 */
export const ACCOUNT_NAMES: NamesAndLabelsSet = {
  name: 'account names',
  async load({ ch, shared }) {
    const rows = await ch.query<{ address: string; name: string }>(
      `SELECT address, name
         FROM (
           SELECT address, name, removed
             FROM ${shared}.${SharedTable.AccountNames}
            ORDER BY address, added_at DESC, removed DESC
            LIMIT 1 BY address
         )
        WHERE removed = 0 AND name != ''`,
    );
    return new Map<string, NamesAndLabels>(rows.map((row) => [row.address, { account_name: row.name }]));
  },
};

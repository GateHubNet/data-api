import { AccountLabel, SharedTable } from '@gatehub/data-api-shared';
import type { NamesAndLabels, NamesAndLabelsSet } from './names-and-labels.service';

/** One label of an address in `account_labels`: its description, and who says so and where when the operator said. */
export interface AccountLabelData {
  description: string;
  /** Who says so; left out when nobody is named. */
  source?: string;
  /** A link to where it is said; left out when there is none. */
  url?: string;
}

/** `account_labels` of `account_data`: the labels of the address keyed by label, in the order scam, spam, advisory. */
export type AccountLabels = Partial<Record<AccountLabel, AccountLabelData>>;

/**
 * The labels (ADR-0014): `account_labels` of the shared database, the same on every network. The newest row of each
 * (address, label) wins (largest `added_at`; at the same instant a removal wins), and the address does not have that
 * label when that row is a removal (`removed = 1`). Every key's newest row is taken with `LIMIT 1 BY`, never `FINAL`:
 * the table is append-only and keeps every row. The labels of an address come in the order of the label `Enum8`.
 */
export const ACCOUNT_LABELS: NamesAndLabelsSet = {
  name: 'account labels',
  async load({ ch, shared }) {
    const rows = await ch.query<{
      address: string;
      label: AccountLabel;
      description: string;
      source: string;
      url: string;
    }>(
      // the Enum8 orders by its values (scam, spam, advisory); its name as a string would order alphabetically
      `SELECT address, toString(label_enum) AS label, description, source, url
         FROM (
           SELECT address, label AS label_enum, description, source, url, removed
             FROM ${shared}.${SharedTable.AccountLabels}
            ORDER BY address, label_enum, added_at DESC, removed DESC
            LIMIT 1 BY address, label_enum
         )
        WHERE removed = 0
        ORDER BY address, label_enum`,
    );
    const labels = new Map<string, AccountLabels>();
    for (const { address, label, description, source, url } of rows) {
      const data: AccountLabelData = { description };
      if (source !== '') data.source = source;
      if (url !== '') data.url = url;
      labels.set(address, { ...labels.get(address), [label]: data });
    }
    return new Map<string, NamesAndLabels>([...labels].map(([address, of]) => [address, { account_labels: of }]));
  },
};

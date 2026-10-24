import { Table } from '@gatehub/data-api-shared';
import { newestNames } from './account-names';
import type { NamesAndLabels, NamesAndLabelsSet } from './names-and-labels.service';

/**
 * The account network names (ADR-0014): `account_network_names` of the app's own network database, so a name given on
 * one network shows on that network only. The rules are those of the account names (`newestNames`).
 */
export const ACCOUNT_NETWORK_NAMES: NamesAndLabelsSet = {
  name: 'account network names',
  async load({ ch }) {
    const names = await newestNames(ch, Table.AccountNetworkNames);
    return new Map<string, NamesAndLabels>(
      [...names].map(([address, name]) => [address, { account_network_name: name }]),
    );
  },
};

import { Injectable } from '@nestjs/common';
import { AccountDomainsService } from './account-domains.service';
import { AccountLabels } from './account-labels';
import { DisplayName, displayNameOf } from './display-name';
import { DomainTomlsService } from './domain-tomls.service';
import { NamesAndLabelsService } from './names-and-labels.service';

/**
 * What `GET /v2/account_names` says of one address (spec 5.2). The keys come in this order and a key without a value is left out,
 * never `null`.
 */
export interface AccountNameData {
  address: string;
  /** The name to show and what stands behind it; absent when nothing names the address. */
  display_name?: DisplayName;
  /** The account domain, whatever its state: it is verified exactly when `display_name.kind` is `verified`. */
  domain?: string;
  account_name?: string;
  account_network_name?: string;
  /** `account_labels` of the names service as it is, keyed scam, spam, advisory. */
  labels?: AccountLabels;
}

/**
 * The display names of addresses (spec 5.3): the account domains (`AccountDomainsService`), the toml directory
 * (`DomainTomlsService`) and the operator's names and labels (`NamesAndLabelsService`) put together with `displayNameOf`.
 */
@Injectable()
export class DisplayNamesService {
  constructor(
    private readonly domains: AccountDomainsService,
    private readonly tomls: DomainTomlsService,
    private readonly names: NamesAndLabelsService,
  ) {}

  /**
   * One entry per address asked, in the order asked (a repeated address is answered at each place), from one read of the account
   * domains of the distinct addresses. Rejects when that read fails: there is no answer without the domains.
   *
   * Until the toml directory has loaded the names and labels are served all the same, but no address is verified and no domain is
   * a name (spec decision 14).
   */
  async of(addresses: readonly string[]): Promise<AccountNameData[]> {
    const domains = await this.domains.current([...new Set(addresses)]);
    const directoryLoaded = this.tomls.loaded;
    return addresses.map((address) => {
      const domain = domains.get(address);
      const { account_name, account_network_name, account_labels } = this.names.of(address);
      const displayName = displayNameOf({
        address,
        domain,
        listed: domain !== undefined && directoryLoaded ? this.tomls.listed(domain) : undefined,
        directoryLoaded,
        accountName: account_name,
        accountNetworkName: account_network_name,
      });

      const data: AccountNameData = { address };
      if (displayName !== undefined) data.display_name = displayName;
      if (domain !== undefined) data.domain = domain;
      if (account_name !== undefined) data.account_name = account_name;
      if (account_network_name !== undefined) data.account_network_name = account_network_name;
      if (account_labels !== undefined) data.labels = account_labels;
      return data;
    });
  }
}

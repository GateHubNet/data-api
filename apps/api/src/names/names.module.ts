import { Module } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { AccountDomainsService } from './account-domains.service';
import { DomainTomlsService } from './domain-tomls.service';
import { NamesAndLabelsService } from './names-and-labels.service';
import { NAMES_CACHE } from './names-cache';

/**
 * What the api knows of the names of accounts (ADR-0014, spec 5.3): the names and labels the operator writes by hand
 * (`NamesAndLabelsService`, in memory, one instance and one reload timer for the whole app), the account domain of an address
 * read from the ledger-derived `account_domains` (`AccountDomainsService`), and the toml store (`DomainTomlsService`: the
 * directory of what each toml says of its accounts, and the row of one domain). `AccountsModule` imports it for the names of
 * `GET /v2/accounts/{address}`, and the modules that read the tomls import it for `DomainTomlsService`.
 *
 * The answers read on request (the domain of each address asked, the row of each domain asked) are kept in a `CacheService` of
 * their own (`NAMES_CACHE`), so that the many keys they make cannot push the answers of the shared one out.
 */
@Module({
  providers: [
    { provide: NAMES_CACHE, useFactory: (): CacheService => new CacheService() },
    NamesAndLabelsService,
    AccountDomainsService,
    DomainTomlsService,
  ],
  exports: [NamesAndLabelsService, AccountDomainsService, DomainTomlsService],
})
export class NamesModule {}

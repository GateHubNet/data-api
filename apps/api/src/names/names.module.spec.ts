import { ClickHouseService, getNetworkProfile } from '@gatehub/data-api-shared';
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CacheService } from '../common/cache.service';
import { ApiConfig, NETWORK_PROFILE, SHARED_DATABASE } from '../config/api.config';
import { AccountDomainsService } from './account-domains.service';
import { DisplayNamesService } from './display-names.service';
import { DomainTomlsService } from './domain-tomls.service';
import { NamesAndLabelsService } from './names-and-labels.service';
import { NAMES_CACHE } from './names-cache';
import { NamesModule } from './names.module';

const query = jest.fn(async (): Promise<unknown[]> => []);

/** What the CommonModule gives every endpoint module; its ClickHouse answers with no row, or fails. */
@Global()
@Module({
  providers: [
    { provide: ClickHouseService, useValue: { query } },
    { provide: ApiConfig, useValue: { namesAndLabelsReloadMs: 60_000 } },
    { provide: NETWORK_PROFILE, useValue: getNetworkProfile('xrpl') },
    { provide: SHARED_DATABASE, useValue: 'shared' },
    CacheService,
  ],
  exports: [ClickHouseService, ApiConfig, NETWORK_PROFILE, SHARED_DATABASE, CacheService],
})
class FakeCommonModule {}

/** What a module that imports the NamesModule can inject. */
@Injectable()
class Consumer {
  constructor(
    readonly names: NamesAndLabelsService,
    readonly domains: AccountDomainsService,
    readonly tomls: DomainTomlsService,
    readonly displayNames: DisplayNamesService,
  ) {}
}

@Module({ imports: [NamesModule], providers: [Consumer] })
class ConsumerModule {}

describe('NamesModule', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue([]);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('exports the names and labels, the account domains, the toml directory and the display names, and keeps what they read on request in a CacheService of its own', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakeCommonModule, ConsumerModule] }).compile();
    const consumer = moduleRef.get(Consumer);
    expect(consumer.names).toBeInstanceOf(NamesAndLabelsService);
    expect(consumer.domains).toBeInstanceOf(AccountDomainsService);
    expect(consumer.tomls).toBeInstanceOf(DomainTomlsService);
    expect(consumer.displayNames).toBeInstanceOf(DisplayNamesService);

    // NAMES_CACHE is not the shared one: the account domains and the toml rows go to it, and nothing of them to the shared cache
    const shared = moduleRef.get(CacheService);
    const cache = moduleRef.get<CacheService>(NAMES_CACHE, { strict: false });
    expect(cache).toBeInstanceOf(CacheService);
    expect(cache).not.toBe(shared);
    await consumer.domains.current(['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh']);
    await consumer.tomls.get('northpeak.example');
    expect(cache.get('account-domain:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe('');
    expect(shared.get('account-domain:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBeUndefined();
    cache.clear();
    expect(cache.get('account-domain:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBeUndefined();
  });

  it('starts when the database cannot be read: the names and the directory warn, and the boot goes on', async () => {
    query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'));
    const moduleRef = await Test.createTestingModule({ imports: [FakeCommonModule, ConsumerModule] }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    const { tomls } = moduleRef.get(Consumer);
    expect(tomls.loaded).toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not load the toml directory, keeping the last one: connect ECONNREFUSED 127.0.0.1:1',
    );
    await moduleRef.close();
  });
});

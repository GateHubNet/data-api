import { getNetworkProfile, TomlAccount } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { AccountLabels } from './account-labels';
import { DisplayNamesService } from './display-names.service';
import { DomainTomlsService, TOML_LISTINGS_SQL } from './domain-tomls.service';
import type { NamesAndLabels } from './names-and-labels.service';

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const LOWTIDE = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const HARBOR = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const NONE = 'rLUEXYuLiQptky37CqLcm9USQpPiz5rkpD';

const NORTHPEAK = 'northpeak.example';
const LOWTIDE_DOMAIN = 'lowtide.example';

const ADVISORY: AccountLabels = {
  advisory: { description: 'Withdrawals paused since 2026-10-01', url: 'https://harbor.example/status' },
};

interface World {
  /** The account domain of each address (an address missing from it has none). */
  domains?: Record<string, string>;
  /** What the newest row of each domain's toml says of its accounts, address to `desc` (no network: it counts everywhere). */
  tomls?: Record<string, Record<string, string>>;
  /** What the operator's names and labels add to each address. */
  names?: Record<string, NamesAndLabels>;
}

/**
 * `DisplayNamesService` over the real `DomainTomlsService`, whose ClickHouse answers `TOML_LISTINGS_SQL` as the statement does
 * (the newest row of each domain asked, the entries of the addresses asked), and the two other services it composes, from what
 * a test sets; each call is recorded.
 */
function setup(world: World = {}) {
  const current = jest.fn(
    async (addresses: readonly string[]): Promise<Map<string, string | undefined>> =>
      new Map(addresses.map((address) => [address, world.domains?.[address]])),
  );
  const query = jest.fn(async (sql: string, params: { domains: string[]; addresses: string[] }) => {
    if (sql !== TOML_LISTINGS_SQL) throw new Error(`unexpected statement: ${sql}`);
    return params.domains.flatMap((domain) => {
      const entries = world.tomls?.[domain];
      if (entries === undefined) return [];
      const listed: TomlAccount[] = Object.entries(entries)
        .filter(([address]) => params.addresses.includes(address))
        .map(([address, desc]) => ({ address, network: '', desc }));
      return [{ domain, listed }];
    });
  });
  const tomls = new DomainTomlsService({ query } as never, getNetworkProfile('xrpl'), new CacheService());
  const of = jest.fn((address: string): NamesAndLabels => world.names?.[address] ?? {});
  const svc = new DisplayNamesService({ current } as never, tomls, { of } as never);
  return { svc, current, query, of };
}

describe('DisplayNamesService.of', () => {
  it('answers each requested address at its place, a repeat at each, with one read of the domains of the distinct addresses', async () => {
    const { svc, current, of } = setup({ domains: { [TREASURY]: NORTHPEAK } });

    const answers = await svc.of([TREASURY, PAYROLL, TREASURY]);

    expect(answers.map((a) => a.address)).toEqual([TREASURY, PAYROLL, TREASURY]);
    expect(answers[0]).toEqual(answers[2]);
    expect(answers[0]).not.toBe(answers[2]);
    expect(current).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledWith([TREASURY, PAYROLL]);
    expect(of.mock.calls.map(([address]) => address)).toEqual([TREASURY, PAYROLL, TREASURY]);
  });

  it('answers no address at all with no entries', async () => {
    const { svc } = setup();
    expect(await svc.of([])).toEqual([]);
  });

  it('gives the listed desc as the verified name, and the domain with it', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: NORTHPEAK },
      tomls: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury', [PAYROLL]: 'Northpeak Payroll' } },
    });
    expect(await svc.of([TREASURY])).toEqual([
      { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: NORTHPEAK },
    ]);
  });

  it('reads the tomls once for the batch, by key: the distinct domains of the addresses that have one, and those addresses', async () => {
    const { svc, query } = setup({
      domains: { [TREASURY]: NORTHPEAK, [PAYROLL]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN },
      tomls: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
    });

    await svc.of([TREASURY, NONE, PAYROLL, LOWTIDE, TREASURY]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(TOML_LISTINGS_SQL, {
      domains: [NORTHPEAK, LOWTIDE_DOMAIN],
      addresses: [TREASURY, PAYROLL, LOWTIDE],
    });
  });

  it('does not let the toml of another domain vouch for an address: only its own domain verifies it', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: LOWTIDE_DOMAIN, [PAYROLL]: NORTHPEAK },
      // northpeak.example lists TREASURY, whose domain is lowtide.example
      tomls: {
        [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury', [PAYROLL]: 'Northpeak Payroll' },
        [LOWTIDE_DOMAIN]: {},
      },
    });
    expect(await svc.of([TREASURY, PAYROLL])).toEqual([
      { address: TREASURY, display_name: { text: LOWTIDE_DOMAIN, kind: 'domain' }, domain: LOWTIDE_DOMAIN },
      { address: PAYROLL, display_name: { text: 'Northpeak Payroll', kind: 'verified' }, domain: NORTHPEAK },
    ]);
  });

  it('keeps the domain of an account whatever its display name: verified, account name, unverified or none', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: NORTHPEAK, [PAYROLL]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN, [HARBOR]: LOWTIDE_DOMAIN },
      tomls: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
      names: { [PAYROLL]: { account_name: 'Payroll Desk' } },
    });

    const answers = await svc.of([TREASURY, PAYROLL, LOWTIDE, NONE, HARBOR]);

    expect(answers).toEqual([
      { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: NORTHPEAK },
      {
        address: PAYROLL,
        display_name: { text: 'Payroll Desk', kind: 'account' },
        domain: NORTHPEAK,
        account_name: 'Payroll Desk',
      },
      { address: LOWTIDE, display_name: { text: LOWTIDE_DOMAIN, kind: 'domain' }, domain: LOWTIDE_DOMAIN },
      { address: NONE },
      { address: HARBOR, display_name: { text: LOWTIDE_DOMAIN, kind: 'domain' }, domain: LOWTIDE_DOMAIN },
    ]);
  });

  it('serves the account name, the network name and the labels whatever the display name is, and the labels as they are', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: NORTHPEAK },
      tomls: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
      names: {
        [TREASURY]: { account_name: 'Treasury', account_network_name: 'cold wallet', account_labels: ADVISORY },
        [HARBOR]: { account_network_name: 'hot wallet', account_labels: ADVISORY },
      },
    });

    const answers = await svc.of([TREASURY, HARBOR, NONE]);

    expect(answers[0]).toEqual({
      address: TREASURY,
      display_name: { text: 'Northpeak Treasury', kind: 'verified' },
      domain: NORTHPEAK,
      account_name: 'Treasury',
      account_network_name: 'cold wallet',
      labels: ADVISORY,
    });
    expect(answers[0].labels).toBe(ADVISORY);
    expect(answers[1]).toEqual({
      address: HARBOR,
      display_name: { text: 'hot wallet', kind: 'account' },
      account_network_name: 'hot wallet',
      labels: ADVISORY,
    });
    expect(answers[2]).toEqual({ address: NONE });
  });

  it('answers an address that is no account with its names and labels and no domain', async () => {
    const { svc } = setup({ names: { [NONE]: { account_name: 'Harborline Exchange', account_labels: ADVISORY } } });
    expect(await svc.of([NONE])).toEqual([
      {
        address: NONE,
        display_name: { text: 'Harborline Exchange', kind: 'account' },
        account_name: 'Harborline Exchange',
        labels: ADVISORY,
      },
    ]);
  });

  it('keys an entry in the order address, display_name, domain, account_name, account_network_name, labels, and leaves out what it has not', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN },
      names: {
        [TREASURY]: { account_name: 'Treasury', account_network_name: 'cold wallet', account_labels: ADVISORY },
      },
    });

    const [full, domainOnly, empty] = await svc.of([TREASURY, LOWTIDE, NONE]);

    expect(Object.keys(full)).toEqual([
      'address',
      'display_name',
      'domain',
      'account_name',
      'account_network_name',
      'labels',
    ]);
    expect(Object.keys(full.display_name ?? {})).toEqual(['text', 'kind']);
    expect(Object.keys(domainOnly)).toEqual(['address', 'display_name', 'domain']);
    expect(Object.keys(empty)).toEqual(['address']);
  });

  it('rejects when the account domains cannot be read: no answer without domains', async () => {
    const { svc, current, query } = setup({ names: { [TREASURY]: { account_name: 'Treasury' } } });
    current.mockRejectedValue(new Error('read failed'));

    await expect(svc.of([TREASURY])).rejects.toThrow('read failed');
    expect(query).not.toHaveBeenCalled();
  });

  describe('when the tomls cannot be read', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    const world: World = {
      domains: { [TREASURY]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN },
      // the toml lists the account, but it cannot be read: nothing is vouched for
      tomls: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
      names: {
        [TREASURY]: { account_name: 'Treasury', account_labels: ADVISORY },
        [LOWTIDE]: { account_labels: ADVISORY },
      },
    };

    it('serves the names, the labels and the domains, but no verified or domain kind in that answer, and warns', async () => {
      const { svc, query } = setup(world);
      query.mockRejectedValueOnce(new Error('connection refused'));

      const answers = await svc.of([TREASURY, LOWTIDE, NONE]);

      expect(answers).toEqual([
        {
          address: TREASURY,
          display_name: { text: 'Treasury', kind: 'account' },
          domain: NORTHPEAK,
          account_name: 'Treasury',
          labels: ADVISORY,
        },
        { address: LOWTIDE, domain: LOWTIDE_DOMAIN, labels: ADVISORY },
        { address: NONE },
      ]);
      expect(Object.keys(answers[1])).not.toContain('display_name');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Could not read the tomls of the account domains, no domain is a name in this answer: connection refused',
      );
    });

    it('keeps nothing of the failure: the next call reads the tomls again and verifies', async () => {
      const { svc, query } = setup(world);
      query.mockRejectedValueOnce(new Error('connection refused'));
      await svc.of([TREASURY, LOWTIDE]);

      const answers = await svc.of([TREASURY, LOWTIDE]);

      expect(query).toHaveBeenCalledTimes(2);
      expect(answers.map((a) => a.display_name)).toEqual([
        { text: 'Northpeak Treasury', kind: 'verified' },
        { text: LOWTIDE_DOMAIN, kind: 'domain' },
      ]);
    });
  });

  it('reads no toml when no address has a domain', async () => {
    const { svc, query } = setup({ names: { [TREASURY]: { account_name: 'Treasury' } } });
    expect(await svc.of([TREASURY, PAYROLL])).toEqual([
      { address: TREASURY, display_name: { text: 'Treasury', kind: 'account' }, account_name: 'Treasury' },
      { address: PAYROLL },
    ]);
    expect(query).not.toHaveBeenCalled();
  });
});

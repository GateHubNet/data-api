import { AccountLabels } from './account-labels';
import { DisplayNamesService } from './display-names.service';
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
  /** What each toml in the directory says of its accounts, address to `desc`. */
  directory?: Record<string, Record<string, string>>;
  /** False until the directory has loaded. */
  loaded?: boolean;
  /** What the operator's names and labels add to each address. */
  names?: Record<string, NamesAndLabels>;
}

/** The three services `DisplayNamesService` composes, from what a test sets; each call is recorded. */
function setup(world: World = {}) {
  const current = jest.fn(
    async (addresses: readonly string[]): Promise<Map<string, string | undefined>> =>
      new Map(addresses.map((address) => [address, world.domains?.[address]])),
  );
  const listed = jest.fn((domain: string) => {
    const entries = world.directory?.[domain];
    return entries === undefined ? undefined : new Map(Object.entries(entries));
  });
  const tomls = {
    get loaded() {
      return world.loaded ?? true;
    },
    listed,
  };
  const of = jest.fn((address: string): NamesAndLabels => world.names?.[address] ?? {});
  const svc = new DisplayNamesService({ current } as never, tomls as never, { of } as never);
  return { svc, current, listed, of };
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
    const { svc, listed } = setup({
      domains: { [TREASURY]: NORTHPEAK },
      directory: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury', [PAYROLL]: 'Northpeak Payroll' } },
    });
    expect(await svc.of([TREASURY])).toEqual([
      { address: TREASURY, display_name: { text: 'Northpeak Treasury', kind: 'verified' }, domain: NORTHPEAK },
    ]);
    expect(listed).toHaveBeenCalledWith(NORTHPEAK);
  });

  it('keeps the domain of an account whatever its display name: verified, account name, unverified or none', async () => {
    const { svc } = setup({
      domains: { [TREASURY]: NORTHPEAK, [PAYROLL]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN, [HARBOR]: LOWTIDE_DOMAIN },
      directory: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
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
      directory: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
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
    const { svc, current } = setup({ names: { [TREASURY]: { account_name: 'Treasury' } } });
    current.mockRejectedValue(new Error('read failed'));

    await expect(svc.of([TREASURY])).rejects.toThrow('read failed');
  });

  it('serves names and labels but no verified or domain kind while the directory has not loaded', async () => {
    const { svc, listed } = setup({
      loaded: false,
      domains: { [TREASURY]: NORTHPEAK, [LOWTIDE]: LOWTIDE_DOMAIN },
      // the directory would list the account; before the first load nothing is vouched for
      directory: { [NORTHPEAK]: { [TREASURY]: 'Northpeak Treasury' } },
      names: {
        [TREASURY]: { account_name: 'Treasury', account_labels: ADVISORY },
        [LOWTIDE]: { account_labels: ADVISORY },
      },
    });

    const answers = await svc.of([TREASURY, LOWTIDE]);

    expect(answers).toEqual([
      {
        address: TREASURY,
        display_name: { text: 'Treasury', kind: 'account' },
        domain: NORTHPEAK,
        account_name: 'Treasury',
        labels: ADVISORY,
      },
      { address: LOWTIDE, domain: LOWTIDE_DOMAIN, labels: ADVISORY },
    ]);
    expect(Object.keys(answers[1])).not.toContain('display_name');
    expect(listed).not.toHaveBeenCalled();
  });

  it('does not look an address up in the directory when it has no domain', async () => {
    const { svc, listed } = setup({ names: { [TREASURY]: { account_name: 'Treasury' } } });
    await svc.of([TREASURY, PAYROLL]);
    expect(listed).not.toHaveBeenCalled();
  });
});

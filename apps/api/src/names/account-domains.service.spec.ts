import { Table } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { ACCOUNT_DOMAIN_TTL_MS, ACCOUNT_DOMAINS_SQL, AccountDomainsService } from './account-domains.service';

const NORTHPEAK = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HARBOR = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const QUILL = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const NONE = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

/** The Domain field of the ledger: the text as upper-case hex. */
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** What `account_domains` holds of an account, as the statement gives it: the newest row's hex and `deleted`. */
interface Stored {
  top_hex: string;
  gone: number;
}

/** A ClickHouse that answers the statement for the addresses asked, from what it stores (an address without a row has none). */
function fakeClickHouse(stored: Record<string, Stored>) {
  const query = jest.fn(async (_sql: string, params?: { addresses: string[] }) =>
    (params?.addresses ?? [])
      .filter((account) => account in stored)
      .map((account) => ({ account, ...stored[account] })),
  );
  return { query };
}

function setup(stored: Record<string, Stored>) {
  const ch = fakeClickHouse(stored);
  const cache = new CacheService();
  const svc = new AccountDomainsService(ch as never, cache);
  return { ch, cache, svc };
}

const askedOf = (ch: ReturnType<typeof fakeClickHouse>): string[][] =>
  ch.query.mock.calls.map(([, params]) => (params as { addresses: string[] }).addresses);

describe('AccountDomainsService.current', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the newest row of the addresses by key, as a statement of one table with every value a parameter', async () => {
    expect(ACCOUNT_DOMAINS_SQL).toContain(`FROM ${Table.AccountDomains}`);
    expect(ACCOUNT_DOMAINS_SQL).toContain('argMax(domain_hex, version) AS top_hex');
    expect(ACCOUNT_DOMAINS_SQL).toContain('argMax(deleted, version) AS gone');
    expect(ACCOUNT_DOMAINS_SQL).toContain('WHERE account IN {addresses:Array(String)}');
    expect(ACCOUNT_DOMAINS_SQL).toContain('GROUP BY account');
    expect(ACCOUNT_DOMAINS_SQL).not.toMatch(/\bFINAL\b/);
    const { ch, svc } = setup({});
    await svc.current([NORTHPEAK]);
    expect(ch.query).toHaveBeenCalledWith(ACCOUNT_DOMAINS_SQL, { addresses: [NORTHPEAK] });
  });

  it('gives the account domain of the newest row, lower case', async () => {
    const { svc } = setup({ [NORTHPEAK]: { top_hex: hexOf('NorthPeak.Example'), gone: 0 } });
    expect(await svc.current([NORTHPEAK])).toEqual(new Map([[NORTHPEAK, 'northpeak.example']]));
  });

  it('gives undefined for a deleted account, a Domain that is empty, a Domain that is not a domain and an address with no row', async () => {
    const { svc } = setup({
      [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 1 },
      [HARBOR]: { top_hex: '', gone: 0 },
      [QUILL]: { top_hex: hexOf('https://quill.example/'), gone: 0 },
    });
    const got = await svc.current([NORTHPEAK, HARBOR, QUILL, NONE]);
    // every address is a key of the answer, none has a domain
    expect([...got.keys()]).toEqual([NORTHPEAK, HARBOR, QUILL, NONE]);
    expect([...got.values()]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('answers an empty list without reading', async () => {
    const { ch, svc } = setup({});
    expect(await svc.current([])).toEqual(new Map());
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('reads a repeated address once, and every distinct address in one statement', async () => {
    const { ch, svc } = setup({
      [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 0 },
      [HARBOR]: { top_hex: hexOf('harbor.example'), gone: 0 },
    });
    const got = await svc.current([NORTHPEAK, HARBOR, NORTHPEAK, NORTHPEAK]);
    expect(askedOf(ch)).toEqual([[NORTHPEAK, HARBOR]]);
    expect(got).toEqual(
      new Map([
        [NORTHPEAK, 'northpeak.example'],
        [HARBOR, 'harbor.example'],
      ]),
    );
  });

  it('keeps each answer for 60 s: a second call reads nothing for the addresses it has, and only the misses after', async () => {
    expect(ACCOUNT_DOMAIN_TTL_MS).toBe(60_000);
    const { ch, svc } = setup({
      [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 0 },
      [HARBOR]: { top_hex: hexOf('harbor.example'), gone: 0 },
    });
    await svc.current([NORTHPEAK, NONE]);
    expect(askedOf(ch)).toEqual([[NORTHPEAK, NONE]]);

    // both are kept, the one with no domain too: nothing is read
    const again = await svc.current([NONE, NORTHPEAK]);
    expect(ch.query).toHaveBeenCalledTimes(1);
    expect(again).toEqual(
      new Map([
        [NONE, undefined],
        [NORTHPEAK, 'northpeak.example'],
      ]),
    );

    // a new address is the only miss
    const third = await svc.current([NORTHPEAK, HARBOR, NONE]);
    expect(askedOf(ch)).toEqual([[NORTHPEAK, NONE], [HARBOR]]);
    expect(third).toEqual(
      new Map([
        [NORTHPEAK, 'northpeak.example'],
        [HARBOR, 'harbor.example'],
        [NONE, undefined],
      ]),
    );
  });

  it('keeps an answer under account-domain:<address>, with no domain as the empty text', async () => {
    const { cache, svc } = setup({ [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 0 } });
    await svc.current([NORTHPEAK, NONE]);
    expect(cache.get(`account-domain:${NORTHPEAK}`)).toBe('northpeak.example');
    expect(cache.get(`account-domain:${NONE}`)).toBe('');
  });

  it('reads an address again when its 60 s are over', async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    const { ch, svc } = setup({ [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 0 } });
    await svc.current([NORTHPEAK]);
    now.mockReturnValue(start + ACCOUNT_DOMAIN_TTL_MS - 1);
    await svc.current([NORTHPEAK]);
    expect(ch.query).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + ACCOUNT_DOMAIN_TTL_MS + 1);
    await svc.current([NORTHPEAK]);
    expect(ch.query).toHaveBeenCalledTimes(2);
  });

  it('rejects when the read fails, and keeps nothing of it', async () => {
    const { ch, cache, svc } = setup({ [NORTHPEAK]: { top_hex: hexOf('northpeak.example'), gone: 0 } });
    ch.query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(svc.current([NORTHPEAK, HARBOR])).rejects.toThrow('connection refused');
    expect(cache.get(`account-domain:${NORTHPEAK}`)).toBeUndefined();
    expect(cache.get(`account-domain:${HARBOR}`)).toBeUndefined();
    // the next call reads again, both addresses
    expect(await svc.current([NORTHPEAK, HARBOR])).toEqual(
      new Map([
        [NORTHPEAK, 'northpeak.example'],
        [HARBOR, undefined],
      ]),
    );
    expect(askedOf(ch)).toEqual([
      [NORTHPEAK, HARBOR],
      [NORTHPEAK, HARBOR],
    ]);
  });
});

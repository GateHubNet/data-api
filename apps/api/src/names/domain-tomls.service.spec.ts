import { getNetworkProfile, STORED_TOMLS_SQL, Table, TomlAccount } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { DOMAIN_TOML_TTL_MS, DomainTomlsService, TOML_LISTING_TTL_MS, TOML_LISTINGS_SQL } from './domain-tomls.service';

const NORTHPEAK = 'northpeak.example';
const HARBOR = 'harbor.example';
const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const TESTNET_ONLY = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const UNLISTED = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

/** A row of `STORED_TOMLS_SQL` as ClickHouse gives it: the milliseconds of a `DateTime64` quoted, a NULL as `null`. */
const storedRow = (domain: string, over: Record<string, unknown> = {}) => ({
  domain,
  toml_url: `https://${domain}/.well-known/xrp-ledger.toml`,
  status: 'ok',
  reason: '',
  status_code: 0,
  checked_ms: '1761290400410',
  fetched_ms: '1761290400410',
  next_check: 1761376800,
  failures: 0,
  modified_s: '1759363200',
  expires_s: null,
  accounts: [{ address: TREASURY, network: '', desc: 'Northpeak Treasury' }],
  currencies: [],
  validators: [],
  principals: ['Mara Lindqvist'],
  ...over,
});

/**
 * A ClickHouse with the listings statement and the stored-toml statement, each answered from what a test sets. The listings
 * are answered as the statement does: the newest row of each domain asked that has one, with the entries of the addresses
 * asked only, in the order of the row.
 */
function fakeClickHouse() {
  const state = {
    /** The `accounts` of the newest row of each domain. */
    tomls: new Map<string, TomlAccount[]>(),
    stored: new Map<string, ReturnType<typeof storedRow>>(),
  };
  const query = jest.fn(async (sql: string, params?: { domains?: string[]; addresses?: string[] }) => {
    if (sql === TOML_LISTINGS_SQL) {
      return (params?.domains ?? []).flatMap((domain) => {
        const accounts = state.tomls.get(domain);
        return accounts === undefined
          ? []
          : [{ domain, listed: accounts.filter((a) => (params?.addresses ?? []).includes(a.address)) }];
      });
    }
    if (sql === STORED_TOMLS_SQL) return (params?.domains ?? []).flatMap((d) => state.stored.get(d) ?? []);
    throw new Error(`unexpected statement: ${sql}`);
  });
  const reads = (sql: string): number => query.mock.calls.filter(([s]) => s === sql).length;
  return { query, state, listingReads: () => reads(TOML_LISTINGS_SQL), storedReads: () => reads(STORED_TOMLS_SQL) };
}

function setup(profile = getNetworkProfile('xrpl')) {
  const ch = fakeClickHouse();
  const cache = new CacheService();
  const svc = new DomainTomlsService(ch as never, profile, cache);
  return { ch, cache, svc };
}

const NORTHPEAK_ACCOUNTS: TomlAccount[] = [
  { address: TREASURY, network: '', desc: 'Northpeak Treasury' },
  { address: PAYROLL, network: 'main', desc: 'Northpeak Payroll' },
  { address: TESTNET_ONLY, network: 'testnet', desc: 'Northpeak Test' },
];

describe('DomainTomlsService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('listings', () => {
    it('reads the newest row of the domains asked, by key, and only the entries of the addresses asked, with no value in the statement', () => {
      expect(TOML_LISTINGS_SQL).toContain(`FROM ${Table.DomainTomls}`);
      expect(TOML_LISTINGS_SQL).toContain('WHERE domain IN {domains:Array(String)}');
      expect(TOML_LISTINGS_SQL).toContain('ORDER BY domain, checked_at DESC');
      expect(TOML_LISTINGS_SQL).toContain('LIMIT 1 BY domain');
      expect(TOML_LISTINGS_SQL).toContain(
        "arrayFilter(a -> has({addresses:Array(String)}, tupleElement(a, 'address')), accounts) AS listed",
      );
      expect(TOML_LISTINGS_SQL).not.toMatch(/\bFINAL\b/);
    });

    it('gives each address the entry of its own domain that counts on the network, in one read of the distinct domains', async () => {
      const { ch, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      ch.state.tomls.set(HARBOR, [{ address: UNLISTED, network: '', desc: 'Harbor Desk' }]);

      const listings = await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [PAYROLL, NORTHPEAK],
          [TESTNET_ONLY, NORTHPEAK],
          [UNLISTED, HARBOR],
        ]),
      );

      expect([...listings]).toEqual([
        [TREASURY, { desc: 'Northpeak Treasury' }],
        [PAYROLL, { desc: 'Northpeak Payroll' }],
        // listed for the test network only: not here
        [TESTNET_ONLY, null],
        [UNLISTED, { desc: 'Harbor Desk' }],
      ]);
      expect(ch.query).toHaveBeenCalledTimes(1);
      expect(ch.query).toHaveBeenCalledWith(TOML_LISTINGS_SQL, {
        domains: [NORTHPEAK, HARBOR],
        addresses: [TREASURY, PAYROLL, TESTNET_ONLY, UNLISTED],
      });
    });

    it('counts the names of the network of the profile: testnet entries on a testnet', async () => {
      const { ch, svc } = setup(getNetworkProfile('xrpl-testnet'));
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      const listings = await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [PAYROLL, NORTHPEAK],
          [TESTNET_ONLY, NORTHPEAK],
        ]),
      );
      expect([...listings.values()]).toEqual([{ desc: 'Northpeak Treasury' }, null, { desc: 'Northpeak Test' }]);
    });

    it('takes the first entry of an address that counts, and its desc as it is, an empty one too', async () => {
      const { ch, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, [
        { address: TREASURY, network: 'testnet', desc: 'Not on this network' },
        { address: TREASURY, network: '', desc: 'First that counts' },
        { address: TREASURY, network: 'main', desc: 'Second that counts' },
        { address: PAYROLL, network: 'mainnet', desc: '' },
      ]);
      const listings = await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [PAYROLL, NORTHPEAK],
        ]),
      );
      expect([...listings.values()]).toEqual([{ desc: 'First that counts' }, { desc: '' }]);
    });

    it('does not let the toml of another domain vouch for an address', async () => {
      const { ch, svc } = setup();
      // harbor.example lists TREASURY, whose domain is northpeak.example; northpeak.example lists only PAYROLL
      ch.state.tomls.set(HARBOR, [{ address: TREASURY, network: '', desc: 'Harbor says Treasury' }]);
      ch.state.tomls.set(NORTHPEAK, [{ address: PAYROLL, network: '', desc: 'Northpeak Payroll' }]);
      const listings = await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [PAYROLL, HARBOR],
        ]),
      );
      expect([...listings.values()]).toEqual([null, null]);
    });

    it('lists no address of a domain without a row', async () => {
      const { svc } = setup();
      expect([...(await svc.listings(new Map([[TREASURY, NORTHPEAK]])))]).toEqual([[TREASURY, null]]);
    });

    it('reads nothing for no address', async () => {
      const { ch, svc } = setup();
      expect((await svc.listings(new Map())).size).toBe(0);
      expect(ch.query).not.toHaveBeenCalled();
    });

    it('keeps each answer 60 s by domain and address, a null one too, and reads only what it does not keep', async () => {
      expect(TOML_LISTING_TTL_MS).toBe(60_000);
      const start = Date.now();
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      const { ch, cache, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [UNLISTED, NORTHPEAK],
        ]),
      );
      expect(cache.get(`toml-listing:${NORTHPEAK}:${TREASURY}`)).toEqual({ desc: 'Northpeak Treasury' });
      expect(cache.get(`toml-listing:${NORTHPEAK}:${UNLISTED}`)).toBeNull();

      // a later change of the toml is not seen within the 60 s; an address not kept is read alone
      ch.state.tomls.set(NORTHPEAK, [{ address: UNLISTED, network: '', desc: 'Now listed' }, ...NORTHPEAK_ACCOUNTS]);
      now.mockReturnValue(start + TOML_LISTING_TTL_MS - 1);
      const kept = await svc.listings(
        new Map([
          [TREASURY, NORTHPEAK],
          [UNLISTED, NORTHPEAK],
          [PAYROLL, NORTHPEAK],
        ]),
      );
      expect([...kept.values()]).toEqual([{ desc: 'Northpeak Treasury' }, null, { desc: 'Northpeak Payroll' }]);
      expect(ch.query).toHaveBeenCalledTimes(2);
      expect(ch.query).toHaveBeenLastCalledWith(TOML_LISTINGS_SQL, { domains: [NORTHPEAK], addresses: [PAYROLL] });

      // after it, read again
      now.mockReturnValue(start + TOML_LISTING_TTL_MS + 1);
      expect((await svc.listings(new Map([[UNLISTED, NORTHPEAK]]))).get(UNLISTED)).toEqual({ desc: 'Now listed' });
      expect(ch.listingReads()).toBe(3);
    });

    it('reads an address again under another domain: a kept answer is of the domain it was read for', async () => {
      const { ch, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      ch.state.tomls.set(HARBOR, [{ address: TREASURY, network: '', desc: 'Harbor Treasury' }]);
      expect((await svc.listings(new Map([[TREASURY, NORTHPEAK]]))).get(TREASURY)).toEqual({
        desc: 'Northpeak Treasury',
      });
      expect((await svc.listings(new Map([[TREASURY, HARBOR]]))).get(TREASURY)).toEqual({ desc: 'Harbor Treasury' });
      expect(ch.listingReads()).toBe(2);
    });

    it('rejects when the read fails, and keeps nothing of it', async () => {
      const { ch, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      ch.query.mockRejectedValueOnce(new Error('connection refused'));
      await expect(svc.listings(new Map([[TREASURY, NORTHPEAK]]))).rejects.toThrow('connection refused');
      expect((await svc.listings(new Map([[TREASURY, NORTHPEAK]]))).get(TREASURY)).toEqual({
        desc: 'Northpeak Treasury',
      });
      expect(ch.listingReads()).toBe(2);
    });

    it('keeps the answers apart from the shared cache entries: in the cache it was given', async () => {
      const { ch, cache, svc } = setup();
      ch.state.tomls.set(NORTHPEAK, NORTHPEAK_ACCOUNTS);
      await svc.listings(new Map([[TREASURY, NORTHPEAK]]));
      expect(cache.get(`toml-listing:${NORTHPEAK}:${TREASURY}`)).toEqual({ desc: 'Northpeak Treasury' });
    });
  });

  describe('get', () => {
    it('gives the newest row of the domain, read by key, with its times in seconds', async () => {
      const { ch, svc } = setup();
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      const row = await svc.get(NORTHPEAK);
      expect(ch.query).toHaveBeenCalledWith(STORED_TOMLS_SQL, { domains: [NORTHPEAK] });
      expect(row).toMatchObject({
        domain: NORTHPEAK,
        toml_url: `https://${NORTHPEAK}/.well-known/xrp-ledger.toml`,
        status: 'ok',
        checked_at: 1761290400.41,
        fetched_at: 1761290400.41,
        modified: 1759363200,
        expires: null,
        accounts: [{ address: TREASURY, network: '', desc: 'Northpeak Treasury' }],
        principals: ['Mara Lindqvist'],
      });
    });

    it('reads a domain once in 60 s, and again after', async () => {
      expect(DOMAIN_TOML_TTL_MS).toBe(60_000);
      const start = Date.now();
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      const { ch, svc } = setup();
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      const first = await svc.get(NORTHPEAK);
      now.mockReturnValue(start + DOMAIN_TOML_TTL_MS - 1);
      expect(await svc.get(NORTHPEAK)).toBe(first);
      expect(ch.storedReads()).toBe(1);

      now.mockReturnValue(start + DOMAIN_TOML_TTL_MS + 1);
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK, { status: 'failed', reason: 'timeout' }));
      expect((await svc.get(NORTHPEAK))?.status).toBe('failed');
      expect(ch.storedReads()).toBe(2);
    });

    it('keeps a miss too: a domain with no row is read once in 60 s', async () => {
      const start = Date.now();
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      const { ch, svc } = setup();
      expect(await svc.get(HARBOR)).toBeUndefined();
      expect(await svc.get(HARBOR)).toBeUndefined();
      expect(ch.storedReads()).toBe(1);

      // each domain is kept by itself
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      expect((await svc.get(NORTHPEAK))?.domain).toBe(NORTHPEAK);
      expect(ch.storedReads()).toBe(2);

      now.mockReturnValue(start + DOMAIN_TOML_TTL_MS + 1);
      ch.state.stored.set(HARBOR, storedRow(HARBOR));
      expect((await svc.get(HARBOR))?.domain).toBe(HARBOR);
    });

    it('shares one read between the calls that come while it runs', async () => {
      const { ch, svc } = setup();
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      const [a, b] = await Promise.all([svc.get(NORTHPEAK), svc.get(NORTHPEAK)]);
      expect(a).toBe(b);
      expect(ch.storedReads()).toBe(1);
    });

    it('rejects when the read fails, and keeps nothing of it', async () => {
      const { ch, svc } = setup();
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      ch.query.mockRejectedValueOnce(new Error('connection refused'));
      await expect(svc.get(NORTHPEAK)).rejects.toThrow('connection refused');
      expect((await svc.get(NORTHPEAK))?.domain).toBe(NORTHPEAK);
      expect(ch.storedReads()).toBe(2);
    });

    it('keeps the rows apart from the shared cache entries: under domain-toml:<domain> in the cache it was given', async () => {
      const { ch, cache, svc } = setup();
      ch.state.stored.set(NORTHPEAK, storedRow(NORTHPEAK));
      await svc.get(NORTHPEAK);
      expect((cache.get(`domain-toml:${NORTHPEAK}`) as { domain: string }).domain).toBe(NORTHPEAK);
    });
  });
});

import { getNetworkProfile, STORED_TOMLS_SQL, Table } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { ApiConfig } from '../config/api.config';
import { DOMAIN_TOML_TTL_MS, DomainTomlsService, TOML_DIRECTORY_SQL } from './domain-tomls.service';

const NORTHPEAK = 'northpeak.example';
const HARBOR = 'harbor.example';
const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PAYROLL = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const TESTNET_ONLY = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const RELOAD_MS = 60_000;

interface DirectoryRow {
  domain: string;
  accounts: { address: string; network: string; desc: string }[];
}

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

/** A ClickHouse with the directory statement and the stored-toml statement, each answered from what a test sets. */
function fakeClickHouse() {
  const state = {
    directory: [] as DirectoryRow[],
    stored: new Map<string, ReturnType<typeof storedRow>>(),
    failDirectory: undefined as Error | undefined,
  };
  const query = jest.fn(async (sql: string, params?: { domains?: string[] }) => {
    if (sql === TOML_DIRECTORY_SQL) {
      if (state.failDirectory) throw state.failDirectory;
      return state.directory;
    }
    if (sql === STORED_TOMLS_SQL) return (params?.domains ?? []).flatMap((d) => state.stored.get(d) ?? []);
    throw new Error(`unexpected statement: ${sql}`);
  });
  const reads = (sql: string): number => query.mock.calls.filter(([s]) => s === sql).length;
  return { query, state, directoryReads: () => reads(TOML_DIRECTORY_SQL), storedReads: () => reads(STORED_TOMLS_SQL) };
}

function setup(profile = getNetworkProfile('xrpl')) {
  const ch = fakeClickHouse();
  const cache = new CacheService();
  const config = { namesAndLabelsReloadMs: RELOAD_MS } as ApiConfig;
  const svc = new DomainTomlsService(ch as never, config, profile, cache);
  return { ch, cache, svc };
}

const NORTHPEAK_DIRECTORY: DirectoryRow[] = [
  {
    domain: NORTHPEAK,
    accounts: [
      { address: TREASURY, network: '', desc: 'Northpeak Treasury' },
      { address: PAYROLL, network: 'main', desc: 'Northpeak Payroll' },
      { address: TESTNET_ONLY, network: 'testnet', desc: 'Northpeak Test' },
    ],
  },
];

describe('DomainTomlsService', () => {
  let warn: jest.SpyInstance;
  let services: DomainTomlsService[];

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    services = [];
  });
  afterEach(async () => {
    await Promise.all(services.map((svc) => svc.onModuleDestroy()));
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const started = (s: ReturnType<typeof setup>) => {
    services.push(s.svc);
    return s;
  };

  describe('the directory', () => {
    it('reads the newest row of each domain with accounts, from the table of the store, as a statement with no value in it', () => {
      expect(TOML_DIRECTORY_SQL).toContain(`FROM ${Table.DomainTomls}`);
      expect(TOML_DIRECTORY_SQL).toContain('ORDER BY domain, checked_at DESC');
      expect(TOML_DIRECTORY_SQL).toContain('LIMIT 1 BY domain');
      expect(TOML_DIRECTORY_SQL).toContain('WHERE notEmpty(accounts)');
      expect(TOML_DIRECTORY_SQL).not.toMatch(/\bFINAL\b/);
    });

    it('is not loaded before the init: loaded is false and no domain is listed', () => {
      const { svc } = started(setup());
      expect(svc.loaded).toBe(false);
      expect(svc.listed(NORTHPEAK)).toBeUndefined();
    });

    it('lists, for a domain, the entries that count on the network: no network or a name of it, not another', async () => {
      const s = started(setup());
      s.ch.state.directory = NORTHPEAK_DIRECTORY;
      await s.svc.onModuleInit();
      expect(s.svc.loaded).toBe(true);
      const listed = s.svc.listed(NORTHPEAK);
      expect([...(listed ?? [])]).toEqual([
        [TREASURY, 'Northpeak Treasury'],
        [PAYROLL, 'Northpeak Payroll'],
      ]);
      // not a domain of the directory
      expect(s.svc.listed(HARBOR)).toBeUndefined();
      expect(s.ch.directoryReads()).toBe(1);
    });

    it('counts the names of the network of the profile: testnet entries on a testnet', async () => {
      const s = started(setup(getNetworkProfile('xrpl-testnet')));
      s.ch.state.directory = NORTHPEAK_DIRECTORY;
      await s.svc.onModuleInit();
      expect([...(s.svc.listed(NORTHPEAK) ?? [])]).toEqual([
        [TREASURY, 'Northpeak Treasury'],
        [TESTNET_ONLY, 'Northpeak Test'],
      ]);
    });

    it('keeps the first desc of a repeated address, and no domain whose entries all count elsewhere', async () => {
      const s = started(setup());
      s.ch.state.directory = [
        {
          domain: NORTHPEAK,
          accounts: [
            { address: TREASURY, network: 'testnet', desc: 'Not on this network' },
            { address: TREASURY, network: '', desc: 'First that counts' },
            { address: TREASURY, network: 'main', desc: 'Second that counts' },
          ],
        },
        { domain: HARBOR, accounts: [{ address: TESTNET_ONLY, network: 'testnet', desc: 'Harbor Test' }] },
      ];
      await s.svc.onModuleInit();
      expect([...(s.svc.listed(NORTHPEAK) ?? [])]).toEqual([[TREASURY, 'First that counts']]);
      expect(s.svc.listed(HARBOR)).toBeUndefined();
      expect(s.svc.loaded).toBe(true);
    });

    it('does not reject the init when the first load fails: it warns, and the directory is not loaded', async () => {
      const s = started(setup());
      s.ch.state.failDirectory = new Error('connection refused');
      await expect(s.svc.onModuleInit()).resolves.toBeUndefined();
      expect(s.svc.loaded).toBe(false);
      expect(s.svc.listed(NORTHPEAK)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Could not load the toml directory, keeping the last one: connection refused');
    });

    it('loads again every reload interval: the first load that failed is made up, a later one replaces the directory', async () => {
      jest.useFakeTimers();
      const s = started(setup());
      s.ch.state.failDirectory = new Error('connection refused');
      await s.svc.onModuleInit();
      expect(s.svc.loaded).toBe(false);

      // the next reload succeeds
      s.ch.state.failDirectory = undefined;
      s.ch.state.directory = NORTHPEAK_DIRECTORY;
      await jest.advanceTimersByTimeAsync(RELOAD_MS);
      expect(s.svc.loaded).toBe(true);
      expect(s.svc.listed(NORTHPEAK)?.get(TREASURY)).toBe('Northpeak Treasury');
      expect(warn).toHaveBeenCalledTimes(1);

      // and the one after it replaces what was loaded: the domain that left is gone, the new one is listed
      s.ch.state.directory = [
        { domain: HARBOR, accounts: [{ address: PAYROLL, network: '', desc: 'Harbor Payroll' }] },
      ];
      await jest.advanceTimersByTimeAsync(RELOAD_MS);
      expect(s.svc.listed(NORTHPEAK)).toBeUndefined();
      expect(s.svc.listed(HARBOR)?.get(PAYROLL)).toBe('Harbor Payroll');
      expect(s.ch.directoryReads()).toBe(3);
    });

    it('keeps the directory when a later reload fails, and warns once for it', async () => {
      jest.useFakeTimers();
      const s = started(setup());
      s.ch.state.directory = NORTHPEAK_DIRECTORY;
      await s.svc.onModuleInit();
      expect(warn).not.toHaveBeenCalled();

      s.ch.state.failDirectory = new Error('timeout');
      await jest.advanceTimersByTimeAsync(RELOAD_MS);
      expect(s.ch.directoryReads()).toBe(2);
      expect(s.svc.loaded).toBe(true);
      expect(s.svc.listed(NORTHPEAK)?.get(PAYROLL)).toBe('Northpeak Payroll');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Could not load the toml directory, keeping the last one: timeout');
    });

    it('stops reloading when it is destroyed', async () => {
      jest.useFakeTimers();
      const s = started(setup());
      await s.svc.onModuleInit();
      await s.svc.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(RELOAD_MS * 3);
      expect(s.ch.directoryReads()).toBe(1);
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

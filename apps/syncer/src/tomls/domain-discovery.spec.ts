import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import {
  DISCOVERY_SQL,
  DomainDiscovery,
  domainsOf,
  grownDomains,
  TOML_DISCOVERY_INTERVAL_MS,
} from './domain-discovery';

/** The Domain field of an account as the ledger holds it: the bytes of the text, as upper-case hex. */
const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

type Row = { domain_hex: string; accounts: number | string };

/** A ClickHouse that answers the discovery read with the given answers, one per read; an `Error` is a read that fails. */
function fakeClickHouse(...answers: (Row[] | Error)[]) {
  const query = jest.fn(async (_sql: string, _params?: Record<string, unknown>) => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected read');
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { ch: { query } as unknown as Pick<ClickHouseService, 'query'>, query };
}

const fakeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** A clock that reads the given times (ms) one after the other, the last one for ever after. */
const clockOf =
  (...times: number[]) =>
  () =>
    times.length > 1 ? (times.shift() as number) : times[0];

const gaugeSeconds = async (prometheus: PrometheusService): Promise<number | undefined> =>
  (await prometheus.tomlsDiscoverySeconds.get()).values[0]?.value;

describe('domainsOf', () => {
  it('drops what names no domain and adds up the spellings of one domain', () => {
    const { domains, dropped } = domainsOf([
      { domain_hex: hex('Example.com'), accounts: 2 },
      { domain_hex: hex('example.com'), accounts: 3 },
      { domain_hex: hex('https://x.com'), accounts: 4 },
    ]);

    expect(domains).toEqual(new Map([['example.com', 5]]));
    expect(dropped).toBe(1);
  });

  it('reads the counts ClickHouse sends as quoted UInt64 text', () => {
    const { domains, dropped } = domainsOf([
      { domain_hex: hex('a.example'), accounts: '2' },
      { domain_hex: hex('A.example'), accounts: '40' },
      { domain_hex: hex('b.example'), accounts: '1' },
    ]);

    expect(domains).toEqual(
      new Map([
        ['a.example', 42],
        ['b.example', 1],
      ]),
    );
    expect(dropped).toBe(0);
  });

  it('drops hex that is not a hex string, and a domain that is not well formed', () => {
    const { domains, dropped } = domainsOf([
      { domain_hex: 'not hex', accounts: 1 },
      { domain_hex: hex('has space.example'), accounts: 1 },
      { domain_hex: hex('localhost'), accounts: 1 },
      { domain_hex: hex('ok.example'), accounts: 1 },
    ]);

    expect([...domains.keys()]).toEqual(['ok.example']);
    expect(dropped).toBe(3);
  });

  it('is empty for no rows', () => {
    expect(domainsOf([])).toEqual({ domains: new Map(), dropped: 0 });
  });
});

describe('grownDomains', () => {
  it('names none when there is no previous map (the first discovery after a start)', () => {
    expect(
      grownDomains(
        undefined,
        new Map([
          ['a.example', 3],
          ['b.example', 1],
        ]),
      ),
    ).toEqual([]);
  });

  it('names the domains more accounts name than before, and the new ones, sorted', () => {
    const previous = new Map([['a.example', 2]]);
    const next = new Map([
      ['c.example', 1],
      ['a.example', 3],
      ['b.example', 1],
    ]);

    expect(grownDomains(previous, next)).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('does not name a domain whose count fell or stayed, or one that is gone', () => {
    const previous = new Map([
      ['fell.example', 5],
      ['stayed.example', 2],
      ['grew.example', 2],
      ['gone.example', 9],
    ]);
    const next = new Map([
      ['fell.example', 4],
      ['stayed.example', 2],
      ['grew.example', 3],
    ]);

    expect(grownDomains(previous, next)).toEqual(['grew.example']);
  });

  it('names every domain after an empty previous map', () => {
    expect(grownDomains(new Map(), new Map([['a.example', 1]]))).toEqual(['a.example']);
  });
});

describe('DomainDiscovery', () => {
  const DOMAINS_A = [
    { domain_hex: hex('a.example'), accounts: 2 },
    { domain_hex: hex('b.example'), accounts: 1 },
  ];
  const DOMAINS_B = [
    { domain_hex: hex('a.example'), accounts: 3 },
    { domain_hex: hex('b.example'), accounts: 1 },
    { domain_hex: hex('c.example'), accounts: 1 },
  ];

  it('runs every five minutes', () => {
    expect(TOML_DISCOVERY_INTERVAL_MS).toBe(300_000);
  });

  it('reads the current domain of every account, of the table by name, with the newest row of an account by argMax', () => {
    expect(DISCOVERY_SQL).toContain(`FROM ${Table.AccountDomains} GROUP BY account`);
    expect(DISCOVERY_SQL).toContain('argMax(domain_hex, version) AS top_hex');
    expect(DISCOVERY_SQL).toContain('argMax(deleted, version) AS gone');
    expect(DISCOVERY_SQL).toContain("WHERE top_hex != '' AND gone = 0");
    expect(DISCOVERY_SQL).toContain('GROUP BY top_hex');
    expect(DISCOVERY_SQL).not.toMatch(/\bFINAL\b/i);
  });

  it('has discovered nothing before the first read', () => {
    const { ch } = fakeClickHouse();
    const discovery = new DomainDiscovery(ch, new PrometheusService());

    expect(discovery.current.size).toBe(0);
    expect(discovery.namedAnew('a.example')).toBe(false);
  });

  it('reads with DISCOVERY_SQL and keeps the domains of the read, with their account counts', async () => {
    const { ch, query } = fakeClickHouse([
      ...DOMAINS_A,
      { domain_hex: hex('https://x.com'), accounts: '7' },
      { domain_hex: hex('A.example'), accounts: '5' },
    ]);
    const discovery = new DomainDiscovery(ch, new PrometheusService(), { logger: fakeLogger() });

    await discovery.discover();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(DISCOVERY_SQL);
    expect(discovery.current).toEqual(
      new Map([
        ['a.example', 7],
        ['b.example', 1],
      ]),
    );
  });

  it('names no domain anew at the first discovery, and the domains more accounts name at the next one', async () => {
    const { ch } = fakeClickHouse(DOMAINS_A, DOMAINS_B);
    const discovery = new DomainDiscovery(ch, new PrometheusService());

    await discovery.discover();
    for (const domain of ['a.example', 'b.example', 'c.example']) expect(discovery.namedAnew(domain)).toBe(false);

    await discovery.discover();
    expect(discovery.namedAnew('a.example')).toBe(true); // 2 accounts, now 3
    expect(discovery.namedAnew('b.example')).toBe(false); // 1, still 1
    expect(discovery.namedAnew('c.example')).toBe(true); // not named before
    expect(discovery.current).toEqual(
      new Map([
        ['a.example', 3],
        ['b.example', 1],
        ['c.example', 1],
      ]),
    );
  });

  it('forgets that a domain was named anew once it is checked, and only that one', async () => {
    const { ch } = fakeClickHouse(DOMAINS_A, DOMAINS_B);
    const discovery = new DomainDiscovery(ch, new PrometheusService());
    await discovery.discover();
    await discovery.discover();

    discovery.checked('a.example');
    discovery.checked('unknown.example'); // nothing to forget

    expect(discovery.namedAnew('a.example')).toBe(false);
    expect(discovery.namedAnew('c.example')).toBe(true);
  });

  it('keeps a domain named anew through the next discovery that does not grow it, until it is checked', async () => {
    const { ch } = fakeClickHouse(DOMAINS_A, DOMAINS_B, DOMAINS_B);
    const discovery = new DomainDiscovery(ch, new PrometheusService());
    await discovery.discover();
    await discovery.discover();

    await discovery.discover();

    expect(discovery.namedAnew('a.example')).toBe(true);
    discovery.checked('a.example');
    expect(discovery.namedAnew('a.example')).toBe(false);
  });

  it('records the seconds the read took in syncer_tomls_discovery_seconds', async () => {
    const { ch } = fakeClickHouse(DOMAINS_A);
    const prometheus = new PrometheusService();
    const discovery = new DomainDiscovery(ch, prometheus, { now: clockOf(1_000_000, 1_001_250) });

    await discovery.discover();

    expect(await gaugeSeconds(prometheus)).toBe(1.25);
    expect(await prometheus.getMetrics()).toMatch(/^syncer_tomls_discovery_seconds 1\.25$/m);
  });

  it('records the seconds a read took even when it fails, so that a read that outgrows its limits shows', async () => {
    const { ch } = fakeClickHouse(DOMAINS_A, new Error('read failed'));
    const prometheus = new PrometheusService();
    // the reads take 2 s, then 79 s before they fail
    const discovery = new DomainDiscovery(ch, prometheus, { now: clockOf(10_000, 12_000, 20_000, 99_000) });
    await discovery.discover();
    expect(await gaugeSeconds(prometheus)).toBe(2);

    await expect(discovery.discover()).rejects.toThrow('read failed');

    expect(await gaugeSeconds(prometheus)).toBe(79);
  });

  it('rejects when the read fails, and keeps the domains, the named-anew set and the previous map as they were', async () => {
    const grown = [{ domain_hex: hex('a.example'), accounts: 4 }, ...DOMAINS_B.slice(1)];
    const { ch } = fakeClickHouse(DOMAINS_A, DOMAINS_B, new Error('read failed'), grown);
    const discovery = new DomainDiscovery(ch, new PrometheusService());
    await discovery.discover();
    await discovery.discover();
    const before = discovery.current;

    await expect(discovery.discover()).rejects.toThrow('read failed');

    expect(discovery.current).toBe(before);
    expect(discovery.namedAnew('a.example')).toBe(true);
    expect(discovery.namedAnew('c.example')).toBe(true);

    // the previous map is the one before the failure (a: 3, b: 1, c: 1), neither gone nor empty: only a grows over it
    discovery.checked('a.example');
    discovery.checked('c.example');
    await discovery.discover();
    expect(discovery.namedAnew('a.example')).toBe(true);
    expect(discovery.namedAnew('b.example')).toBe(false);
    expect(discovery.namedAnew('c.example')).toBe(false);
  });

  it('stops naming a domain anew once no account names it, and names it anew again when one does', async () => {
    const { ch } = fakeClickHouse(
      DOMAINS_A,
      DOMAINS_B,
      [
        { domain_hex: hex('b.example'), accounts: 1 },
        { domain_hex: hex('c.example'), accounts: 1 },
      ],
      DOMAINS_B,
    );
    const discovery = new DomainDiscovery(ch, new PrometheusService());
    await discovery.discover();
    await discovery.discover();
    expect(discovery.namedAnew('a.example')).toBe(true);
    expect(discovery.namedAnew('c.example')).toBe(true);

    await discovery.discover(); // nobody names a.example now
    expect(discovery.namedAnew('a.example')).toBe(false);
    expect(discovery.namedAnew('c.example')).toBe(true); // still named, not checked

    await discovery.discover(); // a.example is back, with 3 accounts
    expect(discovery.namedAnew('a.example')).toBe(true);
    expect(discovery.namedAnew('b.example')).toBe(false);
  });

  it('names nothing anew at the first read that works after a start whose first read failed (no previous map yet)', async () => {
    const { ch } = fakeClickHouse(new Error('read failed'), DOMAINS_B);
    const discovery = new DomainDiscovery(ch, new PrometheusService());

    await expect(discovery.discover()).rejects.toThrow('read failed');
    expect(discovery.current.size).toBe(0);
    await discovery.discover();

    expect(discovery.current.size).toBe(3);
    for (const domain of ['a.example', 'b.example', 'c.example']) expect(discovery.namedAnew(domain)).toBe(false);
  });

  describe('ready', () => {
    it('settles after the first discover(), and not before', async () => {
      let answer!: (rows: Row[]) => void;
      const query = jest.fn(() => new Promise<Row[]>((resolve) => (answer = resolve)));
      const discovery = new DomainDiscovery(
        { query } as unknown as Pick<ClickHouseService, 'query'>,
        new PrometheusService(),
      );
      let settled = false;
      void discovery.ready.then(() => (settled = true));

      const running = discovery.discover();
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      answer(DOMAINS_A);
      await running;
      await discovery.ready;
      expect(settled).toBe(true);
    });

    it('settles, and does not reject, when the first read failed', async () => {
      const { ch } = fakeClickHouse(new Error('read failed'));
      const discovery = new DomainDiscovery(ch, new PrometheusService());

      await expect(discovery.discover()).rejects.toThrow('read failed');

      await expect(discovery.ready).resolves.toBeUndefined();
    });
  });

  describe('the log', () => {
    it('says once per discovery how many values named no domain, and shows none of them', async () => {
      const { ch } = fakeClickHouse(
        [...DOMAINS_A, { domain_hex: hex('https://secret.example/x'), accounts: 1 }, { domain_hex: 'ZZ', accounts: 1 }],
        [...DOMAINS_A, { domain_hex: hex('https://secret.example/x'), accounts: 1 }],
      );
      const logger = fakeLogger();
      const discovery = new DomainDiscovery(ch, new PrometheusService(), { logger });

      await discovery.discover();
      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(logger.log.mock.calls[0][0]).toBe('Discovery dropped 2 Domain value(s) that name no domain');

      await discovery.discover();
      expect(logger.log).toHaveBeenCalledTimes(2);
      expect(logger.log.mock.calls[1][0]).toBe('Discovery dropped 1 Domain value(s) that name no domain');

      const logged = JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
      expect(logged).not.toContain('secret');
      expect(logged).not.toContain(hex('https://secret.example/x'));
      expect(logged).not.toContain('ZZ');
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('says nothing when every value names a domain', async () => {
      const { ch } = fakeClickHouse(DOMAINS_A);
      const logger = fakeLogger();
      const discovery = new DomainDiscovery(ch, new PrometheusService(), { logger });

      await discovery.discover();

      expect(logger.log).not.toHaveBeenCalled();
    });
  });
});

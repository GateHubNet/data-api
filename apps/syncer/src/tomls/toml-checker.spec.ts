import {
  DomainTomlsRow,
  EMPTY_TOML_CONTENT,
  getNetworkProfile,
  NetworkProfile,
  okTomlRow,
  readToml,
  STORED_TOMLS_SQL,
  Table,
  tomlUrlOf,
} from '@gatehub/data-api-shared';
import { encodeAccountID } from 'ripple-address-codec';
import { SafeFetchError, tomlFetchLimits } from '../validators/safe-fetch';
import {
  dueDomains,
  TOML_FETCH_CONCURRENCY,
  TOML_NAMED_ANEW_AFTER_S,
  TOML_PASS_LIMIT,
  TOML_SCHEDULE_SQL,
  TOML_WRITE_BATCH,
  TomlChecker,
  TomlSchedule,
} from './toml-checker';

// Every domain, address and name below is hand-written test data, not a recorded file.

const NOW_MS = Date.parse('2026-10-28T12:00:00.000Z');
/** A whole second, so that the sums with the hour and the day below are whole seconds too. */
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86_400;
const RECHECK_MS = DAY * 1000;
const TIMEOUT_MS = 7_000;

const ACCOUNT = encodeAccountID(Buffer.alloc(20, 1));
/** A file that reads as TOML and names one account and one principal. */
const FILE = `[[ACCOUNTS]]\naddress = "${ACCOUNT}"\nnetwork = "main"\ndesc = "Treasury"\n\n[[PRINCIPALS]]\nname = "Ada North"\n`;
const XRPL = getNetworkProfile('xrpl');

const url = (domain: string, profile: Pick<NetworkProfile, 'tomlPath'> = XRPL) => tomlUrlOf(domain, profile);
/** `count` domains, `d001.example` on: in the order of their names. */
const names = (count: number, prefix = 'd'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}.example`);
const served = (text: string) => ({ url: 'unused', body: Buffer.from(text) });

/** A promise a test settles by hand: a fetch that is still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets the promises that are ready run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(what: string, probe: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (probe()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// -- the fakes ------------------------------------------------------------------------------------------------------------

/** A ClickHouse that holds the newest row of each domain and answers the two reads of the checker as the real one would. */
class FakeStore {
  readonly rows = new Map<string, DomainTomlsRow>();
  /** What each insert was given, in order. */
  readonly batches: DomainTomlsRow[][] = [];
  /** An insert fails from the `failFrom`th on (the first unless said), with this error. */
  failInserts?: Error;
  failFrom = 1;
  private inserts = 0;
  /** While set, the read of the stored rows of the domains to check waits for it. */
  holdStoredRead?: Promise<void>;

  readonly query = jest.fn(async (sql: string, params?: Record<string, unknown>): Promise<unknown[]> => {
    if (sql === TOML_SCHEDULE_SQL) {
      return [...this.rows.values()].map((row) => ({
        domain: row.domain,
        next_check: row.next_check_at,
        // an Int64: ClickHouse sends it quoted
        checked_ms: String(Math.round(row.checked_at * 1000)),
        fails: row.failures,
      }));
    }
    if (sql === STORED_TOMLS_SQL) {
      await this.holdStoredRead;
      const wanted = (params as { domains: string[] }).domains;
      return wanted.flatMap((domain) => {
        const row = this.rows.get(domain);
        if (row === undefined) return [];
        return [
          {
            domain: row.domain,
            toml_url: row.toml_url,
            status: row.status,
            reason: row.reason,
            status_code: row.status_code,
            checked_ms: String(Math.round(row.checked_at * 1000)),
            fetched_ms: row.fetched_at === null ? null : String(Math.round(row.fetched_at * 1000)),
            next_check: row.next_check_at,
            failures: row.failures,
            modified_s: row.modified,
            expires_s: row.expires,
            accounts: row.accounts,
            currencies: row.currencies,
            validators: row.validators,
            principals: row.principals,
          },
        ];
      });
    }
    throw new Error(`unexpected read: ${sql}`);
  });

  readonly insert = jest.fn(async (table: string, rows: DomainTomlsRow[]): Promise<void> => {
    if (table !== Table.DomainTomls) throw new Error(`unexpected insert into ${table}`);
    this.inserts++;
    if (this.failInserts !== undefined && this.inserts >= this.failFrom) throw this.failInserts;
    this.batches.push(rows);
    for (const row of rows) {
      const prev = this.rows.get(row.domain);
      if (prev === undefined || row.checked_at >= prev.checked_at) this.rows.set(row.domain, row);
    }
  });

  get written(): DomainTomlsRow[] {
    return this.batches.flat();
  }

  /** A domain that was read OK `ageS` seconds before `NOW`, with the recheck time given (a day unless said). */
  seed(domain: string, o: { ageS?: number; recheckMs?: number; over?: Partial<DomainTomlsRow> } = {}): DomainTomlsRow {
    const now = NOW - (o.ageS ?? 0);
    const row = {
      ...okTomlRow({
        domain,
        tomlUrl: url(domain),
        content: readToml(FILE, XRPL, now),
        now,
        recheckMs: o.recheckMs ?? RECHECK_MS,
      }),
      ...o.over,
    };
    this.rows.set(domain, row);
    return row;
  }
}

/** The discovery as the checker uses it: the domains accounts name, and the named-anew set that `checked()` empties. */
class FakeDiscovery {
  current = new Map<string, number>();
  readonly anew = new Set<string>();
  readonly namedAnew = jest.fn((domain: string) => this.anew.has(domain));
  readonly checked = jest.fn((domain: string) => {
    this.anew.delete(domain);
  });
}

function setup(o: { domains?: string[]; profile?: NetworkProfile } = {}) {
  const ch = new FakeStore();
  const clock = { ms: NOW_MS };
  const fetcher = {
    get: jest.fn(async (_url: string, _limits: unknown, _accept: string): Promise<{ url: string; body: Buffer }> => {
      throw new SafeFetchError('dns_error', 'unexpected fetch');
    }),
  };
  const metrics = {
    tomlsChecksTotal: { inc: jest.fn() },
    tomlsDomains: { set: jest.fn() },
    tomlsDue: { set: jest.fn() },
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const discovery = new FakeDiscovery();
  for (const domain of o.domains ?? []) discovery.current.set(domain, 1);
  const profile = o.profile ?? XRPL;
  const checker = new TomlChecker(
    { tomlRecheckMs: RECHECK_MS, domainFetchTimeoutMs: TIMEOUT_MS } as never,
    profile,
    ch as never,
    metrics as never,
    fetcher as never,
    discovery as never,
    { now: () => clock.ms, logger },
  );
  /** Answers the fetch of each URL (a text, or an error to throw); a URL with no answer is a 404. */
  const serve = (answers: Record<string, string | Error>) => {
    fetcher.get.mockImplementation(async (u: string) => {
      const answer = answers[u];
      if (answer === undefined) throw new SafeFetchError('http_status', 'not found', { statusCode: 404 });
      if (answer instanceof Error) throw answer;
      return served(answer);
    });
  };
  /** Answers every fetch with the same text. */
  const serveAll = (text = FILE) => fetcher.get.mockImplementation(async () => served(text));
  const fetched = () => fetcher.get.mock.calls.map((c) => c[0]);
  const outcomes = () => metrics.tomlsChecksTotal.inc.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);
  /** `syncer_tomls_domains` as the last pass left it. */
  const gauge = () => {
    const calls = metrics.tomlsDomains.set.mock.calls as [{ status: string }, number][];
    return Object.fromEntries(calls.slice(-3).map(([labels, value]) => [labels.status, value]));
  };
  const lines = () =>
    [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => c[0]);
  return { ch, clock, fetcher, metrics, logger, discovery, checker, serve, serveAll, fetched, outcomes, gauge, lines };
}

// -- dueDomains -----------------------------------------------------------------------------------------------------------

describe('dueDomains', () => {
  const schedule = (nextCheckAt: number, o: Partial<TomlSchedule> = {}): TomlSchedule => ({
    nextCheckAt,
    checkedAt: NOW - 100,
    failures: 0,
    ...o,
  });
  const due = (o: {
    discovered: string[];
    schedule?: Record<string, TomlSchedule>;
    anew?: string[];
    limit?: number;
    now?: number;
  }) =>
    dueDomains({
      discovered: new Map(o.discovered.map((domain) => [domain, 1])),
      schedule: new Map(Object.entries(o.schedule ?? {})),
      namedAnew: (domain) => (o.anew ?? []).includes(domain),
      now: o.now ?? NOW,
      limit: o.limit,
    });

  it('is due with no schedule, when its next check has come, and not before', () => {
    expect(
      due({
        discovered: ['new.example', 'now.example', 'later.example', 'past.example'],
        schedule: {
          'now.example': schedule(NOW),
          'later.example': schedule(NOW + 1),
          'past.example': schedule(NOW - 1),
        },
      }),
    ).toEqual(['new.example', 'past.example', 'now.example']);
  });

  it('orders the never checked, then the named anew, then the oldest next check, then the domain', () => {
    const result = due({
      discovered: [
        'tie-b.example',
        'old.example',
        'z-never.example',
        'b-anew.example',
        'tie-a.example',
        'older.example',
        'c-anew.example',
        'a-never.example',
        'd-anew-past.example',
      ],
      schedule: {
        // named anew and checked over an hour ago, though the next check is far off
        'b-anew.example': schedule(NOW + 20, { checkedAt: NOW - 4_000 }),
        'c-anew.example': schedule(NOW + 10, { checkedAt: NOW - 4_000 }),
        'd-anew-past.example': schedule(NOW - 5_000, { checkedAt: NOW - 4_000 }),
        'old.example': schedule(NOW - 500),
        'older.example': schedule(NOW - 900),
        'tie-a.example': schedule(NOW - 100),
        'tie-b.example': schedule(NOW - 100),
      },
      anew: ['b-anew.example', 'c-anew.example', 'd-anew-past.example'],
    });

    expect(result).toEqual([
      'a-never.example',
      'z-never.example',
      'd-anew-past.example',
      'c-anew.example',
      'b-anew.example',
      'older.example',
      'old.example',
      'tie-a.example',
      'tie-b.example',
    ]);
  });

  it('checks a named-anew domain at most hourly', () => {
    // the next check is a day off: only the name can make it due
    const when = (checkedAgoS: number, anew: boolean) =>
      due({
        discovered: ['a.example'],
        schedule: { 'a.example': schedule(NOW + DAY, { checkedAt: NOW - checkedAgoS }) },
        anew: anew ? ['a.example'] : [],
      });

    expect(TOML_NAMED_ANEW_AFTER_S).toBe(3_600);
    expect(when(3_599, true)).toEqual([]);
    expect(when(3_600, true)).toEqual([]);
    expect(when(3_601, true)).toEqual(['a.example']);
    // checked long ago, but no account names it anew and the next check is not due
    expect(when(7_200, false)).toEqual([]);
  });

  it('is due when its next check has come, named anew or not, whenever it was last checked', () => {
    const result = due({
      discovered: ['a.example'],
      schedule: { 'a.example': schedule(NOW - 1, { checkedAt: NOW - 10 }) },
      anew: ['a.example'],
    });
    expect(result).toEqual(['a.example']);
  });

  it('never gives a domain that is not discovered, whatever its schedule says', () => {
    expect(
      due({
        discovered: ['a.example'],
        schedule: { 'a.example': schedule(NOW + DAY), 'stored.example': schedule(NOW - DAY) },
        anew: ['stored.example'],
      }),
    ).toEqual([]);
  });

  it('gives the first 300 by default, and the first `limit` when it is given', () => {
    const discovered = names(450);
    expect(TOML_PASS_LIMIT).toBe(300);
    expect(due({ discovered })).toEqual(discovered.slice(0, 300));
    expect(due({ discovered, limit: 5 })).toEqual(discovered.slice(0, 5));
    expect(due({ discovered, limit: Infinity })).toEqual(discovered);
  });
});

// -- the checker ----------------------------------------------------------------------------------------------------------

describe('TomlChecker', () => {
  describe('which domains are checked', () => {
    it('fetches each discovered domain that is due once, and no stored domain that no account names', async () => {
      const t = setup({ domains: ['a.example', 'b.example', 'c.example'] });
      // c.example is read, and not due until tomorrow; stored.example is stored, overdue and named by no account
      t.ch.seed('c.example');
      t.ch.seed('stored.example', { ageS: 3 * DAY });
      t.serveAll();

      expect(await t.checker.pass()).toBe(2);

      expect(t.fetched().sort()).toEqual([url('a.example'), url('b.example')]);
      expect(t.ch.written.map((row) => row.domain).sort()).toEqual(['a.example', 'b.example']);
    });

    it('checks a domain whose next check has come, with the row it has stored carried over', async () => {
      const t = setup({ domains: ['a.example'] });
      // read two hours ago to be read again after one
      t.ch.seed('a.example', { ageS: 2 * HOUR, recheckMs: HOUR * 1000 });
      t.serve({ [url('a.example')]: new SafeFetchError('http_status', 'unavailable', { statusCode: 503 }) });

      await t.checker.pass();

      // a transient failure within the 24 h of the read: the content stays, the read time too
      const [row] = t.ch.written;
      expect(row).toMatchObject({
        domain: 'a.example',
        status: 'failed',
        reason: 'http_status',
        status_code: 503,
        failures: 1,
        fetched_at: NOW - 2 * HOUR,
        accounts: [{ address: ACCOUNT, network: 'main', desc: 'Treasury' }],
        principals: ['Ada North'],
      });
      expect(row.next_check_at).toBe(NOW + HOUR);
    });

    it('checks at most 300 a pass, the never checked first and then the oldest next check', async () => {
      const never = names(250, 'n');
      const overdue = names(100, 'o');
      const t = setup({ domains: [...overdue, ...never] });
      // the later the name, the older the next check
      overdue.forEach((domain, i) => t.ch.seed(domain, { ageS: DAY + 1 + i }));
      t.serveAll();

      expect(await t.checker.pass()).toBe(TOML_PASS_LIMIT);

      expect(new Set(t.fetched()).size).toBe(300);
      const checked = new Set(t.ch.written.map((row) => row.domain));
      for (const domain of never) expect(checked.has(domain)).toBe(true);
      // 50 of the 100 overdue: the ones whose next check is the oldest, the last 50 names
      for (const domain of overdue.slice(50)) expect(checked.has(domain)).toBe(true);
      for (const domain of overdue.slice(0, 50)) expect(checked.has(domain)).toBe(false);
    });

    it('fetches 300 of 450 domains never checked, and leaves 150 still due', async () => {
      const t = setup({ domains: names(450) });
      t.serveAll();

      expect(await t.checker.pass()).toBe(300);

      expect(t.fetcher.get).toHaveBeenCalledTimes(300);
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(150);
      // the next pass takes the rest
      expect(await t.checker.pass()).toBe(150);
      expect(t.fetcher.get).toHaveBeenCalledTimes(450);
      expect(new Set(t.fetched()).size).toBe(450);
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(0);
    });

    it('checks a domain named anew when it was checked over an hour ago, and not before', async () => {
      const t = setup({ domains: ['a.example', 'b.example'] });
      t.ch.seed('a.example', { ageS: 3_599 });
      t.ch.seed('b.example', { ageS: 3_601 });
      t.discovery.anew.add('a.example');
      t.discovery.anew.add('b.example');
      t.serveAll();

      await t.checker.pass();

      expect(t.fetched()).toEqual([url('b.example')]);
      expect(t.discovery.checked).toHaveBeenCalledTimes(1);
      expect(t.discovery.checked).toHaveBeenCalledWith('b.example');
      expect(t.discovery.namedAnew('b.example')).toBe(false);
      expect(t.discovery.namedAnew('a.example')).toBe(true);
    });

    it('leaves the mark of a domain named anew after its fetch started, whether the row waits or the fetch is under way', async () => {
      const t = setup({ domains: ['c.example', 'a.example', 'b.example'] });
      // c.example is named anew when the pass starts; a.example and b.example are not (yet)
      t.discovery.anew.add('c.example');
      const gates = new Map<string, ReturnType<typeof deferred<{ url: string; body: Buffer }>>>();
      t.fetcher.get.mockImplementation((u: string) => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.set(u, gate);
        return gate.promise;
      });

      const pass = t.checker.pass();
      await until('three fetches', () => gates.size === 3);
      // a.example is answered and its row waits in the buffer; b.example is still under way
      gates.get(url('a.example'))?.resolve(served(FILE));
      await settle();
      // a discovery now finds more accounts naming a.example and b.example
      t.discovery.anew.add('a.example');
      t.discovery.anew.add('b.example');
      gates.get(url('b.example'))?.resolve(served(FILE));
      gates.get(url('c.example'))?.resolve(served(FILE));

      expect(await pass).toBe(3);

      // the marks of the checks that began after them stay; the one that was there at the start goes
      expect(t.discovery.checked).toHaveBeenCalledTimes(1);
      expect(t.discovery.checked).toHaveBeenCalledWith('c.example');
      expect(t.discovery.namedAnew('c.example')).toBe(false);
      expect(t.discovery.namedAnew('a.example')).toBe(true);
      expect(t.discovery.namedAnew('b.example')).toBe(true);
    });

    it('reads the newest row of the domains it checks only, by one bound array', async () => {
      const t = setup({ domains: names(450) });
      t.ch.seed('stored.example', { ageS: 5 * DAY });
      t.serveAll();

      await t.checker.pass();

      const reads = t.ch.query.mock.calls;
      expect(reads.map((c) => c[0])).toEqual([TOML_SCHEDULE_SQL, STORED_TOMLS_SQL]);
      expect((reads[1][1] as { domains: string[] }).domains).toEqual(names(300));
    });

    it('reads no row when nothing is due, logs no line for the idle pass, and sets the gauges all the same', async () => {
      const t = setup({ domains: ['a.example'] });
      t.ch.seed('a.example');

      expect(await t.checker.pass()).toBe(0);

      expect(t.ch.query.mock.calls.map((c) => c[0])).toEqual([TOML_SCHEDULE_SQL]);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.insert).not.toHaveBeenCalled();
      // nothing checked and nothing still due: an idle minute is not logged
      expect(t.logger.log).not.toHaveBeenCalled();
      expect(t.gauge()).toEqual({ ok: 1, failed: 0, unchecked: 0 });
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(0);
    });

    it('logs the line again as soon as a domain is due, and again when the pass checked it', async () => {
      const t = setup({ domains: ['a.example'] });
      t.ch.seed('a.example');
      await t.checker.pass();
      expect(t.logger.log).not.toHaveBeenCalled();

      t.clock.ms += 2 * DAY * 1000;
      t.serveAll();
      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(1);
      expect(t.logger.log).toHaveBeenLastCalledWith('Tomls: 1 checked (1 ok, 0 failed), 0 still due');

      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(1);
    });

    it('checks nothing before a discovery has found a domain', async () => {
      const t = setup();
      t.ch.seed('stored.example', { ageS: 5 * DAY });

      expect(await t.checker.pass()).toBe(0);

      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.gauge()).toEqual({ ok: 0, failed: 0, unchecked: 0 });
    });
  });

  describe('the fetches', () => {
    it('fetches https://{domain}{tomlPath} of the network with the toml limits and accept header', async () => {
      const profile = getNetworkProfile('xahau');
      const t = setup({ domains: ['a.example'], profile });
      t.serveAll();

      await t.checker.pass();

      expect(profile.tomlPath).not.toBe(XRPL.tomlPath);
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      expect(t.fetcher.get).toHaveBeenCalledWith(
        `https://a.example${profile.tomlPath}`,
        tomlFetchLimits(TIMEOUT_MS),
        'application/toml, text/plain, */*',
      );
      expect(t.ch.written[0].toml_url).toBe(`https://a.example${profile.tomlPath}`);
    });

    it('has at most 16 fetches in flight', async () => {
      const t = setup({ domains: names(40) });
      let open = 0;
      let most = 0;
      const gates: ReturnType<typeof deferred<{ url: string; body: Buffer }>>[] = [];
      t.fetcher.get.mockImplementation(async () => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.push(gate);
        open++;
        most = Math.max(most, open);
        try {
          return await gate.promise;
        } finally {
          open--;
        }
      });

      const pass = t.checker.pass();
      await until('16 fetches under way', () => gates.length === 16);
      await settle();
      // no 17th while 16 are open
      expect(gates.length).toBe(16);
      expect(TOML_FETCH_CONCURRENCY).toBe(16);

      let resolved = 0;
      while (resolved < 40) {
        await until('a fetch to settle', () => gates.length > resolved);
        gates[resolved++].resolve(served(FILE));
        await settle();
      }

      expect(await pass).toBe(40);
      expect(most).toBe(16);
      expect(t.fetcher.get).toHaveBeenCalledTimes(40);
      expect(new Set(t.fetched()).size).toBe(40);
    });

    it('stamps each row with the time its file arrived, and reads the file by that time', async () => {
      const t = setup({ domains: ['a.example', 'b.example'] });
      // a modified date 10 s past the day after the start of the pass: more than a day after the fetch of a.example (which
      // takes 2.5 s), no more than a day after the fetch of b.example (which takes 40 s)
      const text = `${FILE}\n[METADATA]\nmodified = ${new Date((NOW + DAY + 10) * 1000).toISOString()}\n`;
      const gates = new Map<string, ReturnType<typeof deferred<{ url: string; body: Buffer }>>>();
      t.fetcher.get.mockImplementation((u: string) => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.set(u, gate);
        return gate.promise;
      });

      const pass = t.checker.pass();
      await until('both fetches', () => gates.size === 2);
      t.clock.ms = NOW_MS + 2_500;
      gates.get(url('a.example'))?.resolve(served(text));
      await settle();
      t.clock.ms = NOW_MS + 40_000;
      gates.get(url('b.example'))?.resolve(served(text));
      await pass;

      const [a, b] = t.ch.written;
      expect(a).toMatchObject({ domain: 'a.example', checked_at: NOW + 2.5, fetched_at: NOW + 2.5, modified: null });
      expect(a.next_check_at).toBe(Math.ceil(NOW + 2.5 + DAY));
      expect(b).toMatchObject({ domain: 'b.example', checked_at: NOW + 40, fetched_at: NOW + 40 });
      expect(b.modified).toBe(NOW + DAY + 10);
    });
  });

  describe('the rows', () => {
    it('writes the row okTomlRow gives for a file that reads as TOML', async () => {
      const t = setup({ domains: ['a.example'] });
      t.serve({ [url('a.example')]: FILE });

      await t.checker.pass();

      expect(t.ch.written).toEqual([
        okTomlRow({
          domain: 'a.example',
          tomlUrl: url('a.example'),
          content: readToml(FILE, XRPL, NOW),
          now: NOW,
          recheckMs: RECHECK_MS,
        }),
      ]);
      expect(t.ch.written[0].next_check_at).toBe(NOW + DAY);
    });

    it('writes a toml_invalid row, a definite failure, for a body that is not TOML', async () => {
      const t = setup({ domains: ['a.example'] });
      t.serve({ [url('a.example')]: 'this is = = not toml' });

      await t.checker.pass();

      expect(t.ch.written).toEqual([
        {
          domain: 'a.example',
          toml_url: url('a.example'),
          status: 'failed',
          reason: 'toml_invalid',
          status_code: 0,
          checked_at: NOW,
          fetched_at: null,
          next_check_at: NOW + DAY,
          failures: 1,
          ...EMPTY_TOML_CONTENT,
        },
      ]);
      expect(t.outcomes()).toEqual(['toml_invalid']);
    });

    it('keeps the reason and the status code of a failure of the fetcher', async () => {
      const t = setup({ domains: ['a.example', 'b.example', 'c.example', 'd.example'] });
      t.serve({
        [url('a.example')]: new SafeFetchError('timeout', 'x'),
        [url('b.example')]: new SafeFetchError('too_large', 'x'),
        [url('c.example')]: new SafeFetchError('blocked_address', 'x', { addressClass: '10.0.0.0/8' }),
        // d.example has no answer: a 404
      });

      await t.checker.pass();

      const byDomain = Object.fromEntries(t.ch.written.map((row) => [row.domain, row]));
      expect(byDomain['a.example']).toMatchObject({ reason: 'timeout', status_code: 0, next_check_at: NOW + HOUR });
      expect(byDomain['b.example']).toMatchObject({ reason: 'too_large', status_code: 0, next_check_at: NOW + DAY });
      expect(byDomain['c.example']).toMatchObject({ reason: 'blocked_address', status_code: 0 });
      expect(byDomain['d.example']).toMatchObject({ reason: 'http_status', status_code: 404, failures: 1 });
    });

    it('counts the failures in a row from the row stored, and backs off 1, 2, then 4 days', async () => {
      const t = setup({ domains: ['a.example'] });
      t.serve({});
      const days: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        await t.checker.pass();
        const row = t.ch.written[pass];
        days.push((row.next_check_at - row.checked_at) / DAY);
        t.clock.ms += 8 * DAY * 1000;
      }
      expect(t.ch.written.map((row) => row.failures)).toEqual([1, 2, 3]);
      expect(days).toEqual([1, 2, 4]);
    });

    it('treats an error that is not the fetcher’s as a connect_error, and warns once of the names of the errors', async () => {
      const t = setup({ domains: ['a.example', 'b.example', 'c.example'] });
      t.fetcher.get.mockImplementation(async (u: string) => {
        if (u === url('a.example')) throw new TypeError('boom');
        if (u === url('b.example')) throw new TypeError('boom');
        throw 'not an error' as unknown as Error;
      });

      await t.checker.pass();

      expect(t.ch.written.map((row) => [row.reason, row.failures, row.next_check_at - NOW])).toEqual([
        ['connect_error', 1, HOUR],
        ['connect_error', 1, HOUR],
        ['connect_error', 1, HOUR],
      ]);
      expect(t.outcomes()).toEqual(['connect_error', 'connect_error', 'connect_error']);
      // one line for the pass, with the names and counts, nothing else of the errors
      const warns = t.logger.warn.mock.calls.map((c) => String(c[0]));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toBe(
        "Tomls: 3 checks failed with an error that is not the fetcher's or the parser's own (TypeError x2, string)",
      );
      expect(JSON.stringify(t.lines())).not.toContain('boom');
    });
  });

  describe('the writes', () => {
    it('writes in batches of 50 and at the end', async () => {
      const t = setup({ domains: names(120) });
      t.serveAll();

      expect(await t.checker.pass()).toBe(120);

      expect(TOML_WRITE_BATCH).toBe(50);
      expect(t.ch.batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
      expect(new Set(t.ch.written.map((row) => row.domain)).size).toBe(120);
    });

    it('writes a pass of fewer than 50 checks in one insert at the end', async () => {
      const t = setup({ domains: names(7) });
      t.serveAll();

      await t.checker.pass();

      expect(t.ch.batches.map((batch) => batch.length)).toEqual([7]);
      expect(t.ch.insert).toHaveBeenCalledWith(Table.DomainTomls, expect.any(Array));
    });

    it('writes a pass of exactly 50 checks in one insert', async () => {
      const t = setup({ domains: names(50) });
      t.serveAll();

      await t.checker.pass();

      expect(t.ch.batches.map((batch) => batch.length)).toEqual([50]);
    });

    it('rejects when ClickHouse cannot be written, counts nothing of it, and checks the domain again next time', async () => {
      const t = setup({ domains: ['a.example'] });
      t.discovery.anew.add('a.example');
      t.serveAll();
      t.ch.failInserts = new Error('ClickHouse is down');

      await expect(t.checker.pass()).rejects.toThrow('ClickHouse is down');
      expect(t.outcomes()).toEqual([]);
      expect(t.discovery.checked).not.toHaveBeenCalled();
      expect(t.discovery.namedAnew('a.example')).toBe(true);
      expect(t.logger.log).not.toHaveBeenCalled();

      t.ch.failInserts = undefined;
      expect(await t.checker.pass()).toBe(1);
      expect(t.outcomes()).toEqual(['ok']);
      expect(t.discovery.checked).toHaveBeenCalledWith('a.example');
    });

    it('shows the rows written before a failed insert in the gauges, and counts only those', async () => {
      const t = setup({ domains: names(60) });
      t.serveAll();
      // the batch of 50 is written, the 10 at the end of the pass are not
      t.ch.failInserts = new Error('ClickHouse is down');
      t.ch.failFrom = 2;

      await expect(t.checker.pass()).rejects.toThrow('ClickHouse is down');

      expect(t.ch.batches.map((batch) => batch.length)).toEqual([50]);
      expect(t.outcomes()).toHaveLength(50);
      expect(t.gauge()).toEqual({ ok: 50, failed: 0, unchecked: 10 });
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(10);
    });

    it('rejects when a read fails', async () => {
      const t = setup({ domains: ['a.example'] });
      t.ch.query.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(t.checker.pass()).rejects.toThrow('ClickHouse is down');
      expect(t.fetcher.get).not.toHaveBeenCalled();
    });

    it('is the pass under way when it is called during one', async () => {
      const t = setup({ domains: ['a.example'] });
      const gate = deferred<{ url: string; body: Buffer }>();
      t.fetcher.get.mockImplementation(() => gate.promise);

      const first = t.checker.pass();
      const second = t.checker.pass();
      expect(second).toBe(first);
      await until('the fetch', () => t.fetcher.get.mock.calls.length === 1);
      gate.resolve(served(FILE));

      expect(await first).toBe(1);
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('the metrics', () => {
    it('counts each check written as ok or by its reason, and sets the gauges over the discovered domains', async () => {
      const t = setup({ domains: ['ok.example', 'bad.example', 'gone.example', 'late.example', 'unchecked.example'] });
      // late.example failed before and is not due; ok.example is read before and not due either
      t.ch.seed('ok.example');
      t.ch.seed('late.example', { over: { status: 'failed', reason: 'timeout', failures: 2 } });
      // not discovered: counts in no gauge
      t.ch.seed('stored.example', { over: { status: 'failed', reason: 'timeout', failures: 1 } });
      t.serve({
        [url('bad.example')]: 'not = = toml',
        [url('gone.example')]: new SafeFetchError('http_status', 'x', { statusCode: 404 }),
        [url('unchecked.example')]: FILE,
      });

      expect(await t.checker.pass()).toBe(3);

      expect(t.outcomes().sort()).toEqual(['http_status', 'ok', 'toml_invalid']);
      // ok: ok.example and unchecked.example; failed: bad, gone and late
      expect(t.gauge()).toEqual({ ok: 2, failed: 3, unchecked: 0 });
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(0);
    });

    it('sets every status each pass, an empty one to 0', async () => {
      const t = setup({ domains: ['a.example'] });
      t.serveAll();

      await t.checker.pass();

      const calls = t.metrics.tomlsDomains.set.mock.calls as [{ status: string }, number][];
      expect(calls.map(([labels, value]) => [labels.status, value])).toEqual([
        ['ok', 1],
        ['failed', 0],
        ['unchecked', 0],
      ]);
    });

    it('counts the domains that are not checked yet as unchecked, and the due beyond the pass as still due', async () => {
      const t = setup({ domains: names(305) });
      // 300 are checked, d001 (the first in order) fails with a timeout and the others read
      t.fetcher.get.mockImplementation(async (u: string) => {
        if (u === url('d001.example')) throw new SafeFetchError('timeout', 'x');
        return served(FILE);
      });

      await t.checker.pass();

      expect(t.gauge()).toEqual({ ok: 299, failed: 1, unchecked: 5 });
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(5);
    });

    it('counts a failed row of the pass as ok again once a later pass reads the file', async () => {
      const t = setup({ domains: ['a.example'] });
      t.serve({});
      await t.checker.pass();
      expect(t.gauge()).toEqual({ ok: 0, failed: 1, unchecked: 0 });

      t.clock.ms += 2 * DAY * 1000;
      t.serveAll();
      await t.checker.pass();
      expect(t.gauge()).toEqual({ ok: 1, failed: 0, unchecked: 0 });
      expect(t.ch.written.map((row) => row.failures)).toEqual([1, 0]);
    });
  });

  describe('what is logged', () => {
    it('logs one line a pass: the checks written, how they went and how many are still due', async () => {
      const t = setup({ domains: names(8) });
      t.serve({
        [url('d001.example')]: FILE,
        [url('d002.example')]: FILE,
        [url('d003.example')]: FILE,
        [url('d004.example')]: 'not = = toml',
      });

      await t.checker.pass();

      // d005 to d008 are 404s
      expect(t.logger.log).toHaveBeenCalledTimes(1);
      expect(t.logger.log).toHaveBeenCalledWith('Tomls: 8 checked (3 ok, 5 failed), 0 still due');
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('counts what is still due in the line', async () => {
      const t = setup({ domains: names(350) });
      t.serveAll();

      await t.checker.pass();

      expect(t.logger.log).toHaveBeenCalledWith('Tomls: 300 checked (300 ok, 0 failed), 50 still due');
    });

    it('warns once a pass of the fetches that were blocked, with the count and five domains of the seven', async () => {
      const blocked = names(7, 'b');
      const t = setup({ domains: [...blocked, 'ok.example'] });
      t.fetcher.get.mockImplementation(async (u: string) => {
        if (u === url('ok.example')) return served(FILE);
        throw new SafeFetchError('blocked_address', 'x', { addressClass: '10.0.0.0/8' });
      });

      await t.checker.pass();

      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.logger.warn).toHaveBeenCalledWith(
        'Tomls: 7 fetches blocked (blocked_address): "b001.example", "b002.example", "b003.example", "b004.example", "b005.example"',
      );
      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line).not.toContain('b006.example');
      expect(line).not.toContain('b007.example');
      // the blocked address class is not in the line
      expect(line).not.toContain('10.0.0.0');
    });

    it('names the five first blocked domains in the order of their names, whichever answers first', async () => {
      const blocked = names(7, 'b');
      const t = setup({ domains: blocked });
      // the later the name, the sooner it answers
      t.fetcher.get.mockImplementation(async (u: string) => {
        const rank = blocked.findIndex((domain) => url(domain) === u);
        for (let i = 0; i < 7 - rank; i++) await settle();
        throw new SafeFetchError('blocked_address', 'x');
      });

      await t.checker.pass();

      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line.indexOf('b001.example')).toBeGreaterThan(-1);
      expect(line.indexOf('b001.example')).toBeLessThan(line.indexOf('b005.example'));
      expect(line).not.toContain('b006.example');
    });

    it('warns of a single blocked fetch in the singular, and quotes and cuts the domain', async () => {
      const long = `${'x'.repeat(200)}.example`;
      const t = setup({ domains: [long] });
      t.serve({ [url(long)]: new SafeFetchError('blocked_address', 'x') });

      await t.checker.pass();

      expect(t.logger.warn).toHaveBeenCalledWith(
        `Tomls: 1 fetch blocked (blocked_address): ${JSON.stringify(`${'x'.repeat(128)}...`)}`,
      );
    });

    it('does not warn when no fetch was blocked', async () => {
      const t = setup({ domains: names(3) });
      t.serve({});
      await t.checker.pass();
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('logs no body, principal or email', async () => {
      const t = setup({ domains: ['file.example', 'down.example', 'blocked.example', 'odd.example'] });
      const withPrincipal =
        `${FILE}\n[[PRINCIPALS]]\nname = "Mara"\nemail = "mara@northpeak.example"\n` +
        'twitter = "@maranorthpeak"\ngithub = "maranorthpeak"\n';
      t.serve({
        [url('file.example')]: withPrincipal,
        [url('down.example')]: new SafeFetchError('http_status', 'HTTP 503: secret-body', {
          statusCode: 503,
          cause: new Error('secret-body'),
        }),
        [url('blocked.example')]: new SafeFetchError('blocked_address', 'blocked: secret-body', {
          addressClass: '10.0.0.0/8',
        }),
        [url('odd.example')]: new TypeError('secret-body from mara@northpeak.example'),
      });

      await t.checker.pass();

      const calls = [...t.logger.log.mock.calls, ...t.logger.warn.mock.calls, ...t.logger.error.mock.calls];
      // the pass, the blocked fetch and the unexpected error each logged a line
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect(call).toHaveLength(1);
        expect(typeof call[0]).toBe('string');
        const line = String(call[0]).toLowerCase();
        expect(line).not.toContain('mara');
        expect(line).not.toContain('secret-body');
        expect(line).not.toContain('@');
      }
      // the principal's name is stored, and nothing of the email or the social handles
      const stored = JSON.stringify(t.ch.written);
      expect(stored).toContain('Mara');
      expect(stored.toLowerCase()).not.toContain('mara@');
      expect(stored.toLowerCase()).not.toContain('email');
      expect(stored.toLowerCase()).not.toContain('twitter');
      expect(stored.toLowerCase()).not.toContain('github');
      expect(stored.toLowerCase()).not.toContain('maranorthpeak');
      expect(stored).not.toContain('secret-body');
    });
  });

  describe('stop', () => {
    it('starts no fetch after it, waits for the ones under way, and writes what is done', async () => {
      const t = setup({ domains: names(40) });
      const gates: ReturnType<typeof deferred<{ url: string; body: Buffer }>>[] = [];
      t.fetcher.get.mockImplementation(() => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.push(gate);
        return gate.promise;
      });
      const pass = t.checker.pass();
      await until('16 fetches under way', () => gates.length === 16);
      // three are done: their rows wait in the buffer, and their lanes start three more
      gates.slice(0, 3).forEach((g) => g.resolve(served(FILE)));
      await until('19 fetches started', () => gates.length === 19);

      let stopped = false;
      const stopping = t.checker.stop().then(() => (stopped = true));
      // the three that are done free their lanes; with the checker stopped no fetch starts for them
      gates.slice(3, 6).forEach((g) => g.resolve(served(FILE)));
      await settle();
      await settle();
      expect(gates.length).toBe(19);
      expect(stopped).toBe(false);
      expect(t.ch.insert).not.toHaveBeenCalled();

      gates.slice(6).forEach((g) => g.resolve(served(FILE)));
      await stopping;

      expect(await pass).toBe(19);
      expect(t.fetcher.get).toHaveBeenCalledTimes(19);
      // the checks that were done and the ones that were under way, all written, in the one insert at the end
      expect(t.ch.batches.map((batch) => batch.length)).toEqual([19]);
      expect(t.outcomes()).toHaveLength(19);
      expect(t.logger.log).toHaveBeenCalledWith('Tomls: 19 checked (19 ok, 0 failed), 21 still due');

      // the 21 that were not started are still due
      expect(t.gauge()).toEqual({ ok: 19, failed: 0, unchecked: 21 });
    });

    it('writes a batch of 50 and then the rest when the fetches under way fill the buffer after it', async () => {
      const t = setup({ domains: names(100) });
      const gates: ReturnType<typeof deferred<{ url: string; body: Buffer }>>[] = [];
      t.fetcher.get.mockImplementation(() => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.push(gate);
        return gate.promise;
      });
      const pass = t.checker.pass();
      // 40 are answered one by one, each lane starting another: 56 fetches started, 40 rows waiting, 16 under way
      let done = 0;
      while (done < 40) {
        await until('a fetch under way', () => gates.length > done);
        gates[done++].resolve(served(FILE));
        await settle();
      }
      expect(gates.length).toBe(56);
      expect(t.ch.insert).not.toHaveBeenCalled();

      const stopping = t.checker.stop();
      // the 16 under way finish: the tenth makes the 50, the other six wait for the end
      gates.slice(40).forEach((g) => g.resolve(served(FILE)));
      await stopping;

      expect(await pass).toBe(56);
      expect(t.fetcher.get).toHaveBeenCalledTimes(56);
      expect(t.ch.batches.map((batch) => batch.length)).toEqual([50, 6]);
      expect(t.outcomes()).toHaveLength(56);
      expect(t.logger.log).toHaveBeenCalledWith('Tomls: 56 checked (56 ok, 0 failed), 44 still due');
    });

    it('starts no fetch when it is called while the stored rows are being read, and logs what is still due', async () => {
      const t = setup({ domains: names(5) });
      const read = deferred<void>();
      t.ch.holdStoredRead = read.promise;
      t.serveAll();

      const pass = t.checker.pass();
      await until('the read of the stored rows', () => t.ch.query.mock.calls.length === 2);
      let stopped = false;
      const stopping = t.checker.stop().then(() => (stopped = true));
      await settle();
      expect(stopped).toBe(false);

      read.resolve();
      await stopping;

      expect(await pass).toBe(0);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.insert).not.toHaveBeenCalled();
      // nothing was checked and five are still due: the line is logged, the gauges show them
      expect(t.logger.log).toHaveBeenCalledWith('Tomls: 0 checked (0 ok, 0 failed), 5 still due');
      expect(t.gauge()).toEqual({ ok: 0, failed: 0, unchecked: 5 });
      expect(t.metrics.tomlsDue.set).toHaveBeenLastCalledWith(5);
    });

    it('makes no pass once stopped', async () => {
      const t = setup({ domains: ['a.example'] });
      await t.checker.stop();
      expect(await t.checker.pass()).toBe(0);
      expect(t.ch.query).not.toHaveBeenCalled();
      expect(t.fetcher.get).not.toHaveBeenCalled();
    });

    it('resolves at once when no pass is under way', async () => {
      const t = setup();
      await expect(t.checker.stop()).resolves.toBeUndefined();
    });
  });
});

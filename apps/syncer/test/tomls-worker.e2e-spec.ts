import {
  ACCOUNT_DOMAINS_SEED_BUCKETS,
  ACCOUNT_DOMAINS_SEED_SQL,
  AccountDomainsRow,
  accountDomainVersion,
  ClickHouseService,
  DOMAIN_PARSER_VERSION,
  STORED_TOMLS_SQL,
  Table,
} from '@gatehub/data-api-shared';
import { encodeAccountID } from 'ripple-address-codec';
import { WorkerName } from '../src/config/syncer.config';
import { assertTomlsSchema, TOMLS_MIGRATION } from '../src/core/schema-check';
import { TOML_SCHEDULE_SQL } from '../src/tomls/toml-checker';
import { TomlsWorkerOptions } from '../src/tomls/tomls.options';
import { readsOf, resetTomlsMetrics, startTomlsApp, TomlsApp, TomlsAppOptions } from './support/tomls-env';
import {
  MigratedClickHouse,
  startMigratedClickHouse,
  startTestWeb,
  TestWeb,
  waitFor,
  WEB_SILENCE,
} from './support/validators-env';

/**
 * The tomls worker against a real ClickHouse and an HTTPS server that serves hand-written TOML files for fictional
 * `*.example` domains (`https://ok.example/.well-known/xrp-ledger.toml`, ...). The worker is booted as the application boots
 * it (the core module of the syncer, with no node), its passes are made by the test with a fake clock, and nothing leaves the
 * machine: the fetches resolve the names to 127.0.0.1 and trust the test certificate (whose SAN lists only the hosts the specs
 * use, so a host it lacks fails with `tls_error`).
 */

const TOML_PATH = '/.well-known/xrp-ledger.toml';
const HOUR = 3_600;
const DAY = 86_400;

const OK = 'ok.example';
const MISSING = 'missing.example';
const DOWN = 'down.example';
const SLOW = 'slow.example';
const BAD = 'bad.example';
const BIG = 'big.example';
const MOVED = 'moved.example';

const TREASURY = encodeAccountID(Buffer.alloc(20, 200));
const OPERATIONS = encodeAccountID(Buffer.alloc(20, 201));

/** A classic address of its own for each number. */
const addressOf = (n: number): string => {
  const id = Buffer.alloc(20);
  id.writeUInt32BE(n, 16);
  return encodeAccountID(id);
};

/** The Domain field of an account as the ledger holds it: the bytes of the text, as upper-case hex. */
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** A toml as a domain might publish it. Hand-written test data, not a recorded file. */
const tomlOf = (accounts: string[]): string =>
  [
    '# Hand-written test data, not recorded from any real domain.',
    '[METADATA]',
    'modified = 2026-10-19T12:00:00.000Z',
    '',
    '[[PRINCIPALS]]',
    'name = "Example Holdings"',
    '',
    ...accounts.flatMap((address) => [
      '[[ACCOUNTS]]',
      `address = "${address}"`,
      'network = "main"',
      'desc = "treasury"',
      '',
    ]),
  ].join('\n');

interface TomlRow {
  domain: string;
  last_status: string;
  last_reason: string;
  last_code: number;
  toml_url: string;
  checked_ms: number | string;
  fetched_ms: number | string | null;
  next_check: number;
  last_failures: number;
  addresses: string[];
  principals: string[];
}

describe('the tomls worker (e2e)', () => {
  let db: MigratedClickHouse;
  let web: TestWeb;
  const apps: TomlsApp[] = [];
  /** The clock of the worker, in milliseconds: whole seconds, moved by the tests. */
  const clock = { ms: 0 };
  const seconds = () => clock.ms / 1000;
  let accountCounter = 0;
  let ledgerCounter = 1_000;

  beforeAll(async () => {
    db = await startMigratedClickHouse('tomls_e2e');
    web = await startTestWeb();
  });

  afterAll(async () => {
    await web.stop();
    await db.stop();
  });

  beforeEach(async () => {
    clock.ms = Math.floor(Date.now() / 1000) * 1000;
    web.clear();
    resetTomlsMetrics();
    for (const table of [Table.DomainTomls, Table.AccountDomains, Table.AccountStates, Table.Ledgers]) {
      await db.ch.command(`TRUNCATE TABLE ${table}`);
    }
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.stop()));
  });

  /** The worker with the clock of the test and, unless the test says otherwise, no loops: the test makes the passes. */
  async function boot(o: { config?: TomlsAppOptions['config']; worker?: TomlsWorkerOptions } = {}): Promise<TomlsApp> {
    const app = await startTomlsApp({
      clickhouse: db.config,
      web,
      config: o.config,
      worker: { now: () => clock.ms, ...o.worker },
    });
    apps.push(app);
    return app;
  }

  /** `accounts` accounts name `domain` in their ledger Domain, each a row of `account_domains` of a ledger of its own. */
  async function nameDomain(domain: string, accounts = 1, hex = hexOf(domain)): Promise<void> {
    const rows: AccountDomainsRow[] = Array.from({ length: accounts }, () => {
      const ledger = ledgerCounter++;
      return {
        account: addressOf(++accountCounter),
        ledger_index: ledger,
        tx_index: 1,
        node_index: 0,
        version: accountDomainVersion(ledger, 1, 0),
        domain_hex: hex,
        deleted: 0,
      };
    });
    await db.ch.insert(Table.AccountDomains, rows);
  }

  /**
   * The newest row of every domain of `domain_tomls`, `ORDER BY ... LIMIT 1 BY`: an `argMax` of a nullable column skips the
   * NULLs, so it would give the `fetched_at` of an older row for a row that has none.
   */
  const tomlRows = () =>
    db.ch.query<TomlRow>(
      `SELECT domain, status AS last_status, reason AS last_reason, status_code AS last_code, toml_url,
              toUnixTimestamp64Milli(checked_at) AS checked_ms,
              toUnixTimestamp64Milli(fetched_at) AS fetched_ms,
              toUnixTimestamp(next_check_at) AS next_check,
              failures AS last_failures,
              arrayMap(a -> tupleElement(a, 'address'), accounts) AS addresses,
              principals
         FROM ${Table.DomainTomls}
        ORDER BY domain, checked_at DESC
        LIMIT 1 BY domain`,
    );

  const rowOf = async (domain: string): Promise<TomlRow> => {
    const row = (await tomlRows()).find((r) => r.domain === domain);
    if (row === undefined) throw new Error(`no row for ${domain}`);
    return row;
  };

  /** How many times the web server was asked for the toml of the domain. */
  const fetches = (domain: string): number =>
    web.requests.filter((r) => r.host === domain && r.path === TOML_PATH).length;

  /** The counter `syncer_tomls_checks_total` of an outcome. */
  async function counted(app: TomlsApp, outcome: string): Promise<number> {
    const { values } = await app.metrics.tomlsChecksTotal.get();
    return values.filter((v) => v.labels.outcome === outcome).reduce((n, v) => n + v.value, 0);
  }

  /** The gauge `syncer_tomls_domains` by status; `undefined` for a status that was never set. */
  async function domainsGauge(app: TomlsApp): Promise<Record<string, number>> {
    const { values } = await app.metrics.tomlsDomains.get();
    return Object.fromEntries(values.map((v) => [String(v.labels.status), v.value]));
  }

  /** Serves the seven domains of the spec: a file that reads, and six ways not to. */
  function serveTheSeven(): void {
    web.serveToml(OK, TOML_PATH, tomlOf([TREASURY, OPERATIONS]));
    // MISSING has no route: a 404
    web.serve(DOWN, TOML_PATH, { status: 503, body: 'down for maintenance' });
    web.serve(SLOW, TOML_PATH, WEB_SILENCE);
    web.serveToml(BAD, TOML_PATH, 'a = ');
    web.serveToml(BIG, TOML_PATH, `# ${'x'.repeat(300 * 1024)}\n`);
    web.serve(MOVED, TOML_PATH, { status: 302, headers: { location: `http://${MOVED}/` }, body: '' });
  }

  describe('one pass', () => {
    it('writes one row per domain: ok with its accounts, and the reason of every way a fetch fails', async () => {
      serveTheSeven();
      for (const domain of [OK, MISSING, DOWN, SLOW, BAD, BIG, MOVED]) await nameDomain(domain);
      const app = await boot();

      await app.discovery.discover();
      expect(app.discovery.loaded).toBe(true);
      expect([...app.discovery.current.keys()].sort()).toEqual([BAD, BIG, DOWN, MISSING, MOVED, OK, SLOW]);
      expect(await app.checker.pass()).toBe(7);

      const rows = await tomlRows();
      expect(rows.map((r) => [r.domain, r.last_status, r.last_reason, r.last_code])).toEqual([
        [BAD, 'failed', 'toml_invalid', 0],
        [BIG, 'failed', 'too_large', 0],
        [DOWN, 'failed', 'http_status', 503],
        [MISSING, 'failed', 'http_status', 404],
        [MOVED, 'failed', 'redirect_rejected', 0],
        [OK, 'ok', '', 0],
        [SLOW, 'failed', 'timeout', 0],
      ]);
      const ok = await rowOf(OK);
      expect(ok.addresses).toEqual([TREASURY, OPERATIONS]);
      expect(ok.principals).toEqual(['Example Holdings']);
      expect(ok.last_failures).toBe(0);
      expect(ok.toml_url).toBe(`https://${OK}${TOML_PATH}`);
      expect(Number(ok.checked_ms)).toBe(clock.ms);
      expect(Number(ok.fetched_ms)).toBe(clock.ms);
      expect(ok.next_check).toBe(seconds() + HOUR); // the suite's GH_TOML_RECHECK_MS: 1 h
      for (const failed of rows.filter((r) => r.domain !== OK)) {
        expect(failed.last_failures).toBe(1);
        expect(failed.fetched_ms).toBeNull();
        expect(failed.addresses).toEqual([]);
      }
      // a 503 is transient (an hour), the rest are definite (a day)
      expect((await rowOf(DOWN)).next_check).toBe(seconds() + HOUR);
      expect((await rowOf(SLOW)).next_check).toBe(seconds() + HOUR);
      expect((await rowOf(MISSING)).next_check).toBe(seconds() + DAY);
      expect((await rowOf(BAD)).next_check).toBe(seconds() + DAY);
    });

    it('fetches each domain once, from the tomls worker, and counts every outcome', async () => {
      serveTheSeven();
      for (const domain of [OK, MISSING, DOWN, SLOW, BAD, BIG, MOVED]) await nameDomain(domain);
      const app = await boot();
      await app.discovery.discover();
      await app.checker.pass();

      for (const domain of [OK, MISSING, DOWN, SLOW, BAD, BIG, MOVED]) expect(fetches(domain)).toBe(1);
      for (const request of web.requests) {
        expect(request.headers['user-agent']).toMatch(/^gatehub-data-api\/\S+ \(tomls\)$/);
      }
      expect(await counted(app, 'ok')).toBe(1);
      expect(await counted(app, 'http_status')).toBe(2);
      for (const outcome of ['timeout', 'toml_invalid', 'too_large', 'redirect_rejected']) {
        expect(await counted(app, outcome)).toBe(1);
      }
      expect(await domainsGauge(app)).toEqual({ ok: 1, failed: 6, unchecked: 0 });
      expect((await app.metrics.tomlsDue.get()).values[0].value).toBe(0);
    });

    it('fetches nothing a toml holds, and reads nothing but the toml of the domains accounts name', async () => {
      web.serveToml(
        OK,
        TOML_PATH,
        `${tomlOf([TREASURY])}\n[[CURRENCIES]]\ncode = "EXM"\nissuer = "${OPERATIONS}"\ndisplay_icon = "https://icons.example/x.png"\n`,
      );
      await nameDomain(OK);
      const app = await boot();
      await app.discovery.discover();
      await app.checker.pass();

      expect(web.requests.map((r) => `${r.host}${r.path}`)).toEqual([`${OK}${TOML_PATH}`]);
    });
  });

  describe('the schedule', () => {
    it('does not read ok.example again at +59 min, and does at +1 h 1 s', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await nameDomain(OK);
      const app = await boot();
      await app.discovery.discover();

      expect(await app.checker.pass()).toBe(1);
      expect(fetches(OK)).toBe(1);

      clock.ms += 59 * 60_000;
      expect(await app.checker.pass()).toBe(0);
      expect(fetches(OK)).toBe(1);

      clock.ms += 2 * 60_000 + 1_000; // +1 h 1 s in all
      expect(await app.checker.pass()).toBe(1);
      expect(fetches(OK)).toBe(2);
    });

    it('keeps a verified name through a 503 within the grace, and loses it after', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await nameDomain(OK);
      const app = await boot();
      await app.discovery.discover();
      const t0 = clock.ms;

      await app.checker.pass();
      expect((await rowOf(OK)).last_status).toBe('ok');

      web.serve(OK, TOML_PATH, { status: 503, body: 'down for maintenance' });

      clock.ms = t0 + (HOUR + 1) * 1000;
      expect(await app.checker.pass()).toBe(1);
      const within = await rowOf(OK);
      expect([within.last_status, within.last_reason, within.last_code]).toEqual(['failed', 'http_status', 503]);
      expect(within.addresses).toEqual([TREASURY]);
      expect(within.principals).toEqual(['Example Holdings']);
      expect(Number(within.fetched_ms)).toBe(t0);
      expect(within.last_failures).toBe(1);

      clock.ms = t0 + (DAY + 1) * 1000;
      expect(await app.checker.pass()).toBe(1);
      const after = await rowOf(OK);
      expect([after.last_status, after.last_reason, after.last_code]).toEqual(['failed', 'http_status', 503]);
      expect(after.addresses).toEqual([]);
      expect(after.principals).toEqual([]);
      expect(after.fetched_ms).toBeNull();
    });

    it('checks a domain named anew within the hour, although its next check is a day away, and not before', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await nameDomain(OK);
      const app = await boot({ config: { tomlRecheckMs: DAY * 1000 } });
      await app.discovery.discover();
      await app.checker.pass();
      expect((await rowOf(OK)).next_check).toBe(seconds() + DAY);
      expect(fetches(OK)).toBe(1);

      await nameDomain(OK, 2); // two more accounts name it
      await app.discovery.discover();
      expect(app.discovery.namedAnew(OK)).toBe(true);
      expect(app.discovery.current.get(OK)).toBe(3);

      clock.ms += 59 * 60_000;
      expect(await app.checker.pass()).toBe(0);
      expect(fetches(OK)).toBe(1);

      clock.ms += 2 * 60_000 + 1_000; // +1 h 1 s in all
      expect(await app.checker.pass()).toBe(1);
      expect(fetches(OK)).toBe(2);
      expect(app.discovery.namedAnew(OK)).toBe(false);

      // checked, so it waits for its day again
      clock.ms += 2 * HOUR * 1000;
      expect(await app.checker.pass()).toBe(0);
      expect(fetches(OK)).toBe(2);
    });

    it('leaves a stored domain no account names any more alone', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await db.ch.insert(Table.AccountDomains, [
        {
          account: TREASURY,
          ledger_index: 10,
          tx_index: 1,
          node_index: 0,
          version: accountDomainVersion(10, 1, 0),
          domain_hex: hexOf(OK),
          deleted: 0,
        },
      ]);
      const app = await boot();
      await app.discovery.discover();
      await app.checker.pass();
      expect(fetches(OK)).toBe(1);

      // the account clears its Domain: a newer row with none
      await db.ch.insert(Table.AccountDomains, [
        {
          account: TREASURY,
          ledger_index: 11,
          tx_index: 1,
          node_index: 0,
          version: accountDomainVersion(11, 1, 0),
          domain_hex: '',
          deleted: 0,
        },
      ]);
      await app.discovery.discover();
      expect(app.discovery.current.size).toBe(0);
      clock.ms += 3 * DAY * 1000;
      expect(await app.checker.pass()).toBe(0);
      expect(fetches(OK)).toBe(1);
    });
  });

  describe('the seed of account_domains', () => {
    /** The rows of `account_states` that matter to the seed. */
    const state = (account: string, ledger: number, domain: string | undefined, deleted = 0) => ({
      account,
      ledger_index: ledger,
      tx_index: 1,
      node_index: 2,
      fields: JSON.stringify(domain === undefined ? { Account: account } : { Account: account, Domain: domain }),
      deleted,
    });

    const SEED = 'seed.example';
    const NAMED = encodeAccountID(Buffer.alloc(20, 1));
    const GONE = encodeAccountID(Buffer.alloc(20, 2));
    const CLEARED = encodeAccountID(Buffer.alloc(20, 3));
    const LATE = encodeAccountID(Buffer.alloc(20, 4));
    const X = 120;

    async function seedAll(x = X): Promise<void> {
      for (let bucket = 0; bucket < ACCOUNT_DOMAINS_SEED_BUCKETS; bucket++) {
        await db.ch.command(ACCOUNT_DOMAINS_SEED_SQL, { X: x, bucket });
      }
    }

    beforeEach(async () => {
      // the ledgers an older parser wrote: 100 to X; and one newer than X, which has parser version 6
      await db.ch.insert(Table.Ledgers, [
        ...Array.from({ length: X - 99 }, (_, i) => ({
          ledger_index: 100 + i,
          ledger_hash: `${100 + i}`.padStart(64, 'A'),
          parser_version: DOMAIN_PARSER_VERSION - 1,
        })),
        { ledger_index: X + 1, ledger_hash: 'B'.repeat(64), parser_version: DOMAIN_PARSER_VERSION },
      ]);
      await db.ch.insert(Table.AccountStates, [
        state(NAMED, 105, hexOf('old.example')), // its newest state row at or below X is the next one
        state(NAMED, 110, hexOf(SEED)),
        state(GONE, 106, hexOf('gone.example')),
        state(GONE, 112, hexOf('gone.example'), 1), // deleted since
        state(CLEARED, 107, ''),
        state(LATE, X + 5, hexOf('late.example')), // after X: the parser of this version writes it
      ]);
    });

    it('finds the last ledger of the older parser, as the operator reads it', async () => {
      const [row] = await db.ch.query<{ x: number | null }>(
        `SELECT maxOrNull(ledger_index) AS x FROM ${Table.Ledgers} WHERE parser_version < {version:UInt16}`,
        { version: DOMAIN_PARSER_VERSION },
      );
      expect(row.x).toBe(X);
    });

    it('writes the current Domain of each account with one, on its newest state row at or below X, and discovery finds it', async () => {
      const app = await boot();
      await seedAll();

      const rows = await db.ch.query<{
        account: string;
        ledger_index: number;
        tx_index: number;
        node_index: number;
        version: string;
        domain_hex: string;
        deleted: number;
      }>(
        `SELECT account, ledger_index, tx_index, node_index, toString(version) AS version, domain_hex, deleted
           FROM ${Table.AccountDomains} ORDER BY account`,
      );
      expect(rows).toEqual([
        {
          account: NAMED,
          ledger_index: 110,
          tx_index: 1,
          node_index: 2,
          version: accountDomainVersion(110, 1, 2),
          domain_hex: hexOf(SEED),
          deleted: 0,
        },
      ]);

      await app.discovery.discover();
      expect(app.discovery.current).toEqual(new Map([[SEED, 1]]));
      // with no check made: the seed reads the ledger, it fetches nothing
      expect(web.requests).toEqual([]);
    });

    it('puts each of many accounts in exactly one of its 16 buckets: one row for every account with a Domain, none twice', async () => {
      // 100 more accounts with a Domain, over three domains, each on a state row at or below X; and some that name none
      const named = Array.from({ length: 100 }, (_, i) => addressOf(5_000 + i));
      const domainOf = (i: number) => ['seed.example', 'seed-b.example', 'seed-c.example'][i % 3];
      await db.ch.insert(Table.AccountStates, [
        ...named.map((account, i) => ({ ...state(account, 100 + (i % 20), hexOf(domainOf(i))), node_index: i % 5 })),
        ...Array.from({ length: 20 }, (_, i) => state(addressOf(6_000 + i), 101 + i, i % 2 === 0 ? '' : undefined)),
        ...Array.from({ length: 10 }, (_, i) => state(addressOf(7_000 + i), 101 + i, hexOf('gone.example'), 1)),
      ]);
      // the accounts the seed must write (the current Domain of each, in one pass over all of them), by the bucket each falls in
      const expected = await db.ch.query<{ bucket: number; accounts: string }>(
        `SELECT bucket, count() AS accounts
           FROM (SELECT toUInt8(cityHash64(account) % ${ACCOUNT_DOMAINS_SEED_BUCKETS}) AS bucket,
                        argMax(JSONExtractString(fields, 'Domain'), (ledger_index, tx_index, node_index)) AS current_domain,
                        argMax(deleted, (ledger_index, tx_index, node_index)) AS gone
                   FROM ${Table.AccountStates}
                  WHERE ledger_index <= {X:UInt32}
                  GROUP BY account, bucket)
          WHERE current_domain != '' AND gone = 0
          GROUP BY bucket ORDER BY bucket`,
        { X },
      );
      const total = expected.reduce((sum, row) => sum + Number(row.accounts), 0);
      expect(total).toBe(101); // the 100 and NAMED
      // the premise: the accounts fall in many buckets, so that a statement that misses or repeats a bucket shows
      expect(expected.length).toBeGreaterThanOrEqual(12);

      await db.ch.command(`SYSTEM STOP MERGES ${Table.AccountDomains}`);
      try {
        let written = 0;
        for (let bucket = 0; bucket < ACCOUNT_DOMAINS_SEED_BUCKETS; bucket++) {
          await db.ch.command(ACCOUNT_DOMAINS_SEED_SQL, { X, bucket });
          written += Number(expected.find((row) => row.bucket === bucket)?.accounts ?? 0);
          const [{ rows }] = await db.ch.query<{ rows: string }>(`SELECT count() AS rows FROM ${Table.AccountDomains}`);
          expect(Number(rows)).toBe(written); // this bucket wrote its accounts and no other bucket's
        }
        const [{ rows, accounts }] = await db.ch.query<{ rows: string; accounts: string }>(
          `SELECT count() AS rows, uniqExact(account) AS accounts FROM ${Table.AccountDomains}`,
        );
        expect([Number(rows), Number(accounts)]).toEqual([101, 101]);
      } finally {
        await db.ch.command(`SYSTEM START MERGES ${Table.AccountDomains}`);
      }

      const app = await boot();
      await app.discovery.discover();
      // 34, 33 and 33 of the hundred, and NAMED, who names seed.example
      expect(app.discovery.current).toEqual(
        new Map([
          [SEED, 35],
          ['seed-b.example', 33],
          ['seed-c.example', 33],
        ]),
      );
    });

    it('changes nothing discovery sees when it runs twice, and names nothing anew', async () => {
      const app = await boot();
      await seedAll();
      await app.discovery.discover();
      expect(app.discovery.current).toEqual(new Map([[SEED, 1]]));

      await seedAll();
      await app.discovery.discover();

      expect(app.discovery.current).toEqual(new Map([[SEED, 1]]));
      expect(app.discovery.namedAnew(SEED)).toBe(false);
    });

    it('is overtaken by the row the live parser writes for a later change of the Domain', async () => {
      const app = await boot();
      await seedAll();
      await db.ch.insert(Table.AccountDomains, [
        {
          account: NAMED,
          ledger_index: X + 3,
          tx_index: 0,
          node_index: 1,
          version: accountDomainVersion(X + 3, 0, 1),
          domain_hex: hexOf('later.example'),
          deleted: 0,
        },
      ]);

      await app.discovery.discover();

      expect(app.discovery.current).toEqual(new Map([['later.example', 1]]));
    });
  });

  describe('the bounds of the reads (spec 7)', () => {
    it('reads account_domains once, in full, for a discovery: read_rows is the rows of the table', async () => {
      // four parts of 600 rows over the same 600 accounts (a row a change of Domain), merges stopped, so that the rows of the
      // table do not change under the read
      await db.ch.command(`SYSTEM STOP MERGES ${Table.AccountDomains}`);
      try {
        for (let part = 0; part < 4; part++) {
          await db.ch.insert(
            Table.AccountDomains,
            Array.from({ length: 600 }, (_, i): AccountDomainsRow => {
              const ledger = 5_000 + part * 600 + i;
              return {
                account: addressOf(i + 1),
                ledger_index: ledger,
                tx_index: 1,
                node_index: 0,
                version: accountDomainVersion(ledger, 1, 0),
                domain_hex: hexOf(`d${(part * 7 + i) % 50}.example`),
                deleted: 0,
              };
            }),
          );
        }
        const [{ rows }] = await db.ch.query<{ rows: string }>(`SELECT count() AS rows FROM ${Table.AccountDomains}`);
        expect(Number(rows)).toBe(2_400);
        const app = await boot();

        const reads = await readsOf(db.ch, db.config.database, Table.AccountDomains, () => app.discovery.discover());

        expect(reads).toHaveLength(1);
        expect(reads[0].read_rows).toBe(2_400);
        // the newest row of each of the 600 accounts is the one of the last part
        expect(app.discovery.current.size).toBe(50);
        expect([...app.discovery.current.values()].reduce((sum, n) => sum + n, 0)).toBe(600);
      } finally {
        await db.ch.command(`SYSTEM START MERGES ${Table.AccountDomains}`);
      }
    });

    it('reads domain_tomls once, in full, for the schedule of a pass: read_rows is the rows of the table', async () => {
      await db.ch.command(`SYSTEM STOP MERGES ${Table.DomainTomls}`);
      try {
        // three parts, the checks of 300 domains over three days, none of them discovered, so none is due
        for (let part = 0; part < 3; part++) {
          await db.ch.insert(
            Table.DomainTomls,
            Array.from({ length: 300 }, (_, i) => ({
              domain: `stored${String(i).padStart(3, '0')}.example`,
              toml_url: `https://stored${String(i).padStart(3, '0')}.example${TOML_PATH}`,
              status: 'failed',
              reason: 'http_status',
              status_code: 404,
              checked_at: seconds() - (3 - part) * DAY,
              fetched_at: null,
              next_check_at: Math.ceil(seconds()) + DAY,
              failures: part + 1,
            })),
          );
        }
        const app = await boot();
        await app.discovery.discover();

        const reads = await readsOf(db.ch, db.config.database, Table.DomainTomls, () => app.checker.pass());

        expect(reads).toHaveLength(1);
        expect(reads[0].query).toContain(TOML_SCHEDULE_SQL);
        expect(reads[0].read_rows).toBe(900);
      } finally {
        await db.ch.command(`SYSTEM START MERGES ${Table.DomainTomls}`);
      }
    });

    it('reads the full rows of the domains a pass checks by the primary key', async () => {
      await db.ch.insert(Table.DomainTomls, [
        {
          domain: OK,
          toml_url: `https://${OK}${TOML_PATH}`,
          status: 'failed',
          reason: 'http_status',
          status_code: 404,
          checked_at: seconds(),
          fetched_at: null,
          next_check_at: Math.ceil(seconds()),
          failures: 1,
        },
      ]);

      const plan = await db.ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${STORED_TOMLS_SQL}`, { domains: [OK] });

      const text = plan.map((line) => line.explain).join('\n');
      expect(text).toMatch(/PrimaryKey\s+Keys:\s+domain\s+Condition: \(domain in 1-element set\)/);
    });
  });

  describe('a database without the tables of 012', () => {
    /** Runs `run` with `table` renamed away, as a database that never had it. */
    async function without(table: Table, run: () => Promise<void>): Promise<void> {
      await db.ch.command(`RENAME TABLE ${table} TO ${table}_away`);
      try {
        await run();
      } finally {
        await db.ch.command(`RENAME TABLE ${table}_away TO ${table}`);
      }
    }

    it('is seen by the schema check on the real system.tables, naming the table that is missing', async () => {
      const warn = jest.fn();
      await assertTomlsSchema(db.ch, new Set<WorkerName>(['tomls']), db.config.database, { warn });

      await without(Table.DomainTomls, async () => {
        await expect(
          assertTomlsSchema(db.ch, new Set<WorkerName>(['tomls']), db.config.database, { warn }),
        ).rejects.toThrow(`lacks the schema of ${TOMLS_MIGRATION} (table ${Table.DomainTomls})`);
        // a syncer without the tomls worker is not concerned
        await assertTomlsSchema(db.ch, new Set<WorkerName>(['ingest']), db.config.database, { warn });
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('fails the boot of the application, instead of a worker that fails at once and looks idle', async () => {
      await without(Table.AccountDomains, async () => {
        await expect(startTomlsApp({ clickhouse: db.config, web })).rejects.toThrow(
          `lacks the schema of ${TOMLS_MIGRATION} (table ${Table.AccountDomains})`,
        );
      });
    });
  });

  describe('a discovery that fails from the start', () => {
    it('is logged by the name and type of the error, never its message, and no pass claims an empty store', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await nameDomain(OK);
      // the ClickHouse client reports a failed query to the console on its own: not the worker's log, and not this test's output
      const clientErrors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnings: string[] = [];
      const logger = { log: () => undefined, warn: (line: string) => void warnings.push(line), error: () => undefined };
      // booted with its loops off (the tables are there, or the boot would fail), so that the table can be taken away
      // before the first discovery and the check loop watched from its first pass
      const app = await boot({ worker: { logger } });
      let renamedBack = false;
      await db.ch.command(`RENAME TABLE ${Table.AccountDomains} TO account_domains_away`);
      try {
        // a pass of the check loop reads `ready` once, before it decides whether to run
        const ready = app.discovery.ready;
        let checkPasses = 0;
        Object.defineProperty(app.discovery, 'ready', {
          get: () => {
            checkPasses++;
            return ready;
          },
        });
        app.options.start = Object.assign(app.options.start ?? {}, { discovery: true, checks: true });
        await app.worker.onApplicationBootstrap();

        await waitFor('the failed discovery to be logged', async () => warnings.length > 0 && warnings);
        await waitFor('the first pass of the check loop', async () => checkPasses > 0);
        // what the pass did with the failed discovery is over by the next turn of the event loop
        await new Promise((resolve) => setImmediate(resolve));

        expect(warnings).toEqual(['Toml discovery: the pass failed: Error (UNKNOWN_TABLE)']);
        expect(warnings.join('\n')).not.toContain('account_domains');
        expect(app.discovery.loaded).toBe(false);
        // nothing was claimed: no check, no row, no gauge of the domains; the read's own gauge shows it was tried
        expect(await tomlRows()).toEqual([]);
        expect(web.requests).toEqual([]);
        expect((await app.metrics.tomlsChecksTotal.get()).values).toEqual([]);
        expect((await app.metrics.tomlsDomains.get()).values).toEqual([]);
        expect((await app.metrics.tomlsDiscoverySeconds.get()).values).toHaveLength(1);

        // the table is back and a discovery works: the next pass checks what it finds
        await db.ch.command(`RENAME TABLE account_domains_away TO ${Table.AccountDomains}`);
        renamedBack = true;
        await app.discovery.discover();
        expect(app.discovery.loaded).toBe(true);
        expect(await app.checker.pass()).toBe(1);
        expect(await domainsGauge(app)).toEqual({ ok: 1, failed: 0, unchecked: 0 });
      } finally {
        clientErrors.mockRestore();
        if (!renamedBack) await db.ch.command(`RENAME TABLE account_domains_away TO ${Table.AccountDomains}`);
      }
    });
  });

  describe('the worker with its loops', () => {
    it('discovers, then checks, with its real loops', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      web.serveToml(BAD, TOML_PATH, 'a = ');
      await nameDomain(OK);
      await nameDomain(BAD);
      const app = await boot({ worker: { start: { discovery: true, checks: true } } });

      await waitFor('both domains to be checked', async () => (await tomlRows()).length === 2);

      expect((await rowOf(OK)).last_status).toBe('ok');
      expect((await rowOf(BAD)).last_reason).toBe('toml_invalid');
      expect(app.discovery.loaded).toBe(true);
    });

    it('with GH_DOMAIN_VERIFICATION=false says so once and reads no toml', async () => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      await nameDomain(OK);
      const lines: string[] = [];
      const logger = {
        log: (line: string) => void lines.push(line),
        warn: (line: string) => void lines.push(line),
        error: () => undefined,
      };
      const app = await boot({
        config: { domainVerification: false },
        worker: { logger, start: { discovery: true, checks: true } },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(lines).toEqual(['Toml checks are off (GH_DOMAIN_VERIFICATION=false): no toml is read']);
      expect(web.requests).toEqual([]);
      expect(await tomlRows()).toEqual([]);
      expect(app.discovery.loaded).toBe(false);
    });

    // A stop starts nothing more, waits for the fetches under way and writes what is done, so the client of ClickHouse must be
    // open for that last insert. On a signal nothing closes it (the process exits); when the application is closed, Nest runs the
    // `onModuleDestroy` hooks of every module first (the worker's stop is one) and the `onApplicationShutdown` hooks after
    // them (ClickHouseService closes its client in one): the events say which came last.
    it.each([
      [
        'on the shutdown signal (the cleanup registered with ShutdownSignals)',
        (app: TomlsApp) => app.worker.stop(),
        ['insert'],
      ],
      ['when the application is closed (module destroy)', (app: TomlsApp) => app.stop(), ['insert', 'close']],
    ])('writes what the pass under way has done when it is stopped %s', async (_when, stop, events) => {
      web.serveToml(OK, TOML_PATH, tomlOf([TREASURY]));
      web.serve(SLOW, TOML_PATH, WEB_SILENCE);
      await nameDomain(OK);
      await nameDomain(SLOW);
      const app = await boot({ worker: { start: { discovery: false, checks: true } } });
      await app.discovery.discover();

      // when the app writes and when it closes its client of ClickHouse
      const happened: string[] = [];
      const service = app.app.get(ClickHouseService);
      const insert = service.insert.bind(service);
      jest.spyOn(service, 'insert').mockImplementation(async (table, rows, opts) => {
        await insert(table, rows, opts);
        happened.push('insert');
      });
      const closeClient = service.raw.close.bind(service.raw);
      jest.spyOn(service.raw, 'close').mockImplementation(async () => {
        happened.push('close');
        await closeClient();
      });

      // the loop's first pass is under way: ok.example is read, slow.example waits for its 500 ms
      await waitFor('the pass to ask for slow.example', async () => fetches(SLOW) > 0);
      expect(await tomlRows()).toEqual([]);

      await stop(app);

      const rows = await tomlRows();
      expect(rows.map((r) => [r.domain, r.last_status, r.last_reason])).toEqual([
        [OK, 'ok', ''],
        [SLOW, 'failed', 'timeout'],
      ]);
      // the one insert of the pass (two rows, one batch) is done before the client is closed
      expect(happened).toEqual(events);
    });
  });
});

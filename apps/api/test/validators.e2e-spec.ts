import { Table } from '@gatehub/data-api-shared';
import type { Directory } from '../src/validators/directory';
import { PUBLISHER_KEYS, SUMMARY_KEYS } from '../src/validators/summary-object';
import type { ValidatorDirectoryService } from '../src/validators/validator-directory.service';
import { ApiClient, Harness, HarnessOptions, NO_RATE_LIMIT, startHarness } from './harness';
import { BULK_BASES, BULK_PER_PART, insertBulk, LoggedRead, readsOf } from './support/read-rows';
import {
  DAY,
  fleet,
  FleetScenario,
  HEAD_LEDGER,
  HOUR,
  insertDomains,
  insertHours,
  insertLists,
  insertManifests,
  insertPublishers,
  insertRound,
  insertSeen,
  insertState,
  PUBLISHER_KEY,
  RC1,
  seedFleet,
  serverVersion,
  VOTING_LEDGER,
} from './support/validators-seed';

/**
 * `GET /v2/network/validators/summary` on a real ClickHouse: the summary of a fleet of 35 trusted validators on two
 * publishers (one list current, one expired with a failed newest attempt), the answer with every publisher unavailable and
 * with an empty database, the formats and the key order, `Cache-Control` and the errors, one build of the directory for
 * requests within 10 s, the version sets of rounds and hours, Xahau, and the routes of the original that stay 404.
 *
 * The directory is cached for 10 s, so each scenario has an app of its own (the cache is the app's).
 */

const SUMMARY = '/v2/network/validators/summary';

/** `2026-10-19T15:42:45Z` */
const time = (seconds: number): string => `${new Date(Math.round(seconds * 1000)).toISOString().slice(0, 19)}Z`;
/** `2026-10-19T15:40:02.114Z` */
const instant = (seconds: number): string => new Date(Math.round(seconds * 1000)).toISOString();

const MILLIS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/**
 * A harness and a way to read the directory its app built. The service class has to come from the registry of the app
 * (`jest.isolateModulesAsync` in the harness), which the `controllers` callback of the harness runs in.
 */
async function startWithDirectory(
  options: HarnessOptions,
): Promise<{ h: Harness; directory: () => Promise<Directory> }> {
  let service: typeof ValidatorDirectoryService | undefined;
  const h = await startHarness({
    ...options,
    controllers: async () => {
      ({ ValidatorDirectoryService: service } = await import('../src/validators/validator-directory.service'));
      return [];
    },
  });
  return { h, directory: () => h.app.get(service as typeof ValidatorDirectoryService).get() };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ===================================================================================================================
// the fleet
// ===================================================================================================================

describe('GET /v2/network/validators/summary: a fleet of 35 trusted validators (XRPL)', () => {
  let h: Harness;
  let api: ApiClient;
  let scenario: FleetScenario;
  let firstBuild: Awaited<ReturnType<typeof readsOf>>;
  let firstAnswer: { status: number; body: Record<string, any>; cacheControl?: string };
  let askedAt: number;
  let answeredAt: number;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
    api = await h.api();
    scenario = await seedFleet(h.ch);
    // two requests together: the first of this app, so they are the first build
    askedAt = Date.now();
    firstBuild = await readsOf(h, Table.ValidatorSeen, async () => {
      const [a] = await Promise.all([api.get(SUMMARY), api.get(SUMMARY)]);
      firstAnswer = { status: a.status, body: a.body, cacheControl: a.headers['cache-control'] };
    });
    answeredAt = Date.now();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('answers the summary of the fleet: figures, formats and publishers', () => {
    const s = scenario;
    expect(firstAnswer.status).toBe(200);
    expect(firstAnswer.body).toEqual({
      result: 'success',
      ledger_index: HEAD_LEDGER,
      close_time: time(s.headClose),
      // 34 of the UNL (unl[33] was never seen; unl[34] was seen under its signing key) and 20 others seen in 24 h
      validators: { seen_24h: 54, unl_seen_24h: 34, others_seen_24h: 20, all: 55 },
      unl: {
        trusted: 35,
        threshold: 1,
        publishers: [
          {
            id: 'unl.xrplf.org',
            url: 'https://unl.xrplf.org',
            public_key: PUBLISHER_KEY['unl.xrplf.org'],
            status: 'expired',
            sequence: 2_026_070_302,
            version: 1,
            expiration: time(s.expirationB),
            fetched: instant(s.fetchedB),
            validators: 34,
            seen_24h: 33,
            last_error: 'http_status',
            last_error_at: instant(s.failedAtB),
          },
          {
            id: 'vl.ripple.com',
            url: 'https://vl.ripple.com',
            public_key: PUBLISHER_KEY['vl.ripple.com'],
            status: 'ok',
            sequence: 85,
            version: 1,
            expiration: time(s.expirationA),
            fetched: instant(s.fetchedA),
            validators: 35,
            seen_24h: 34,
          },
        ],
      },
      quorum: { value: 28, unl_size: 35, negative_unl: 1, node: 28 },
      negative_unl: [{ validation_public_key: s.unl[4].key, first_ledger: 107_747_000 }],
      negative_unl_pending: { to_reenable: s.unl[4].key },
      fees: { base_fee: '0.00001', reserve_base: '1', reserve_inc: '0.2' },
      next_flag_ledger: {
        ledger_index: 107_748_352,
        voting_ledger: 107_748_351,
        // 169 ledgers at 4 s
        expected: time(s.headClose + 169 * 4),
      },
      latest_version: '3.4.1',
      versions: [
        { version: '3.5.0-rc1', unl: 0, all: 3 },
        { version: '3.4.1', unl: 30, all: 40 },
        { version: '3.4.0', unl: 4, all: 9 },
      ],
      versions_unknown: { unl: 1, all: 2 },
      agreement_through: time(s.newestHour + HOUR),
      votes_through_ledger: VOTING_LEDGER,
      updated: expect.stringMatching(MILLIS),
    });
  });

  it('says when the directory was built', () => {
    const updated = Date.parse(firstAnswer.body.updated);
    expect(updated).toBeGreaterThanOrEqual(askedAt - 1);
    expect(updated).toBeLessThanOrEqual(answeredAt);
  });

  it('lists the keys in the order of SUMMARY_KEYS, a publisher in the order of PUBLISHER_KEYS', () => {
    expect(Object.keys(firstAnswer.body)).toEqual([...SUMMARY_KEYS]);
    expect(Object.keys(firstAnswer.body.unl)).toEqual(['trusted', 'threshold', 'publishers']);
    expect(Object.keys(firstAnswer.body.unl.publishers[0])).toEqual([...PUBLISHER_KEYS]);
    // the publisher with a list that has not failed has no last_error
    expect(Object.keys(firstAnswer.body.unl.publishers[1])).toEqual(PUBLISHER_KEYS.slice(0, 10));
    expect(Object.keys(firstAnswer.body.validators)).toEqual(['seen_24h', 'unl_seen_24h', 'others_seen_24h', 'all']);
    expect(Object.keys(firstAnswer.body.quorum)).toEqual(['value', 'unl_size', 'negative_unl', 'node']);
    expect(Object.keys(firstAnswer.body.fees)).toEqual(['base_fee', 'reserve_base', 'reserve_inc']);
    expect(Object.keys(firstAnswer.body.next_flag_ledger)).toEqual(['ledger_index', 'voting_ledger', 'expected']);
  });

  it('never has a null', () => {
    expect(JSON.stringify(firstAnswer.body)).not.toContain('null');
  });

  it('sends Cache-Control: private, max-age=30', () => {
    expect(firstAnswer.cacheControl).toBe('private, max-age=30');
  });

  it('makes one build for two requests: one read of validator_seen', () => {
    expect(firstBuild).toHaveLength(1);
  });

  it('serves a later request within 10 s from the directory it has: no read at all', async () => {
    const reads = await readsOf(h, Table.ValidatorSeen, async () => {
      expect((await api.get(SUMMARY)).status).toBe(200);
    });
    expect(reads).toHaveLength(0);
  });

  it('ignores parameters', async () => {
    const res = await api.get(`${SUMMARY}?limit=1&format=csv&marker=x&scope=all`);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('requires the API key', async () => {
    const res = await h.http().get(SUMMARY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('maps the keys through the manifest map: a validator seen and voting under its signing key counts for its master', () => {
    // unl[34] was seen under its signing key within 24 h (its master key three days ago): it is seen, and its votes (recorded
    // under the signing key) give it the version 3.4.0
    const [v340] = firstAnswer.body.versions.filter((v: { version: string }) => v.version === '3.4.0');
    expect(v340).toEqual({ version: '3.4.0', unl: 4, all: 9 });
    expect(firstAnswer.body.validators.unl_seen_24h).toBe(34);
  });

  describe('the SQL of a build', () => {
    it('binds its values, uses no FINAL, and takes its tables from the Table enum', async () => {
      const queries: string[] = [];
      const params: Record<string, unknown>[] = [];
      const fresh = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
      try {
        await seedFleet(fresh.ch);
        const original = fresh.ch.query.bind(fresh.ch);
        jest.spyOn(fresh.ch, 'query').mockImplementation(((
          sql: string,
          p: Record<string, unknown> = {},
          s?: object,
        ) => {
          queries.push(sql);
          params.push(p);
          return original(sql, p, s as never);
        }) as never);
        const res = await (await fresh.api()).get(SUMMARY);
        expect(res.status).toBe(200);
      } finally {
        await fresh.close();
      }
      expect(queries.length).toBeGreaterThan(10);
      const tables = Object.values(Table) as string[];
      for (const sql of queries) {
        expect(sql).not.toMatch(/\bFROM\s+[\w.]+\s+FINAL\b/i);
        // every table a statement reads is one of the Table enum
        for (const [, name] of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9.]*)/gi)) {
          expect([...tables, 'system.parts']).toContain(name);
        }
      }
      // nothing a request or a row says is in the text of a statement: no key, no hash, no number from the data
      const text = queries.join('\n');
      expect(text).not.toMatch(/\bnH[1-9A-HJ-NP-Za-km-z]{20,}/);
      expect(text).not.toContain('107748');
    });

    it('maps the keys through the manifest map in every read that adds up rows by validator', async () => {
      const queries: string[] = [];
      const fresh = await startHarness({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
      try {
        await seedFleet(fresh.ch, { activity: true });
        const original = fresh.ch.query.bind(fresh.ch);
        jest.spyOn(fresh.ch, 'query').mockImplementation(((
          sql: string,
          p: Record<string, unknown> = {},
          s?: object,
        ) => {
          queries.push(sql);
          return original(sql, p, s as never);
        }) as never);
        expect((await (await fresh.api()).get(SUMMARY)).status).toBe(200);
      } finally {
        await fresh.close();
      }
      const mapped =
        'transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key)';
      const readsFrom = (table: Table): string[] => queries.filter((sql) => sql.includes(`FROM ${table}`));
      // validator_seen, validator_validations and validator_votes: every statement
      for (const table of [Table.ValidatorSeen, Table.ValidatorValidations, Table.ValidatorVotes]) {
        expect(readsFrom(table).length).toBeGreaterThan(0);
        for (const sql of readsFrom(table)) expect([table, sql.includes(mapped)]).toEqual([table, true]);
      }
      // validator_agreement_hourly: the statement of the rows of the validators (the others read the sentinels, key '')
      const hours = readsFrom(Table.ValidatorAgreementHourly);
      expect(hours.filter((sql) => sql.includes(mapped))).toHaveLength(1);
      expect(
        hours.filter((sql) => !sql.includes(mapped)).every((sql) => sql.includes("validation_public_key = ''")),
      ).toBe(true);
      // the map itself is read once, from validator_manifests
      expect(queries.filter((sql) => sql.includes('argMax(master_key, seq)'))).toHaveLength(1);
    });
  });
});

// ===================================================================================================================
// the directory itself
// ===================================================================================================================

describe('the validator directory of a fleet of 35 trusted validators (XRPL)', () => {
  let h: Harness;
  let scenario: FleetScenario;
  let directory: Directory;

  beforeAll(async () => {
    const started = await startWithDirectory({ seed: 'none', network: 'xrpl', env: NO_RATE_LIMIT });
    h = started.h;
    scenario = await seedFleet(h.ch, { activity: true });
    directory = await started.directory();
  });
  afterAll(async () => {
    await h?.close();
  });

  const entry = (key: string) => {
    const found = directory.entries.get(key);
    if (!found) throw new Error(`no entry for ${key}`);
    return found;
  };

  it('has an entry for every key of validator_seen (merged into the masters) and of the lists in use', () => {
    // 33 + unl[34] + 20 others + 2 lapsed + 1 dormant seen, and unl[33] on the lists only
    expect(directory.entries.size).toBe(58);
    expect(directory.entries.has(scenario.unl[34].ephemeral)).toBe(false);
    expect(directory.signingToMaster.get(scenario.unl[34].ephemeral)).toBe(scenario.unl[34].key);
    expect(directory.trusted.size).toBe(35);
    expect(directory.threshold).toBe(1);
    expect(directory.quorum).toEqual({ value: 28, unlSize: 35, negativeOnUnl: 1, node: 28 });
  });

  it('is listed when on a list or seen within 30 days, and seen within 24 hours when it was', () => {
    const [unl33, dormant, lapsed] = [
      entry(scenario.unl[33].key),
      entry(scenario.dormant.key),
      entry(scenario.lapsed[0].key),
    ];
    expect(unl33).toMatchObject({ unl: true, listed: true, seen24h: false });
    expect(unl33.firstSeen).toBeUndefined();
    expect(dormant).toMatchObject({ unl: false, listed: false, seen24h: false });
    expect(lapsed).toMatchObject({ unl: false, listed: true, seen24h: false });
    expect(directory.ordered).toHaveLength(57);
    expect(directory.ordered.some((e) => e.key === scenario.dormant.key)).toBe(false);
  });

  it('merges the sightings of a signing key into its master: first seen the earliest, last seen the latest', () => {
    const merged = entry(scenario.unl[34].key);
    expect(merged.seen24h).toBe(true);
    // the master key was last seen three days ago, its signing key 90 s ago
    expect(merged.lastSeen).toBeCloseTo(scenario.now - 90.5, 2);
    expect(merged.firstSeen).toBeCloseTo(scenario.now - 90 * 86_400, 2);
  });

  it('orders the list with a domain first, by domain, then by key', () => {
    const keys = directory.ordered.map((e) => e.key);
    expect(keys.slice(0, 2)).toEqual([scenario.unl[0].key, scenario.unl[1].key]);
    const rest = keys.slice(2);
    expect(rest).toEqual([...rest].sort());
  });

  it('reads the newest manifest: the domain, the signing key it rotated to, and how many signing keys it used', () => {
    expect(entry(scenario.unl[0].key)).toMatchObject({
      domain: 'northpeak.example',
      signingKey: scenario.rotated.base58,
      manifest: {
        sequence: 2,
        signingKey: scenario.rotated.base58,
        signingKeysSeen: 2,
        domain: 'northpeak.example',
      },
    });
    expect(entry(scenario.unl[2].key).manifest).toEqual({
      sequence: 1,
      signingKey: scenario.unl[2].ephemeral,
      signingKeysSeen: 1,
    });
  });

  it('gives the verification of the domain: verified with the accounts, unverified with the reason', () => {
    expect(entry(scenario.unl[0].key).domainState).toEqual({
      status: 'verified',
      tomlUrl: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      checked: expect.closeTo(scenario.now - 600.511, 2),
      verified: expect.closeTo(scenario.now - 600.511, 2),
      accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    });
    expect(entry(scenario.unl[1].key).domainState).toEqual({
      status: 'unverified',
      reason: 'not_listed',
      tomlUrl: 'https://shoreline.example/.well-known/xrp-ledger.toml',
      checked: expect.closeTo(scenario.now - 700.25, 2),
    });
    expect(entry(scenario.unl[2].key).domainState).toBeUndefined();
  });

  it('knows the newest validation of each validator among the last 300 ledgers, under whichever key it was recorded', () => {
    expect(entry(scenario.unl[0].key)).toMatchObject({ currentIndex: HEAD_LEDGER, partial: false });
    // unl[1] has only a partial validation of the head
    expect(entry(scenario.unl[1].key)).toMatchObject({ currentIndex: HEAD_LEDGER, partial: true });
    // unl[34]'s validations are recorded under its signing key
    expect(entry(scenario.unl[34].key)).toMatchObject({ currentIndex: HEAD_LEDGER, partial: false });
    expect(entry(scenario.unl[33].key).currentIndex).toBeUndefined();
    expect(entry(scenario.lapsed[0].key).currentIndex).toBeUndefined();
  });

  describe('agreement', () => {
    // the validators the fleet tracks in every hour, in the order the seed writes them: row `i`, hour `back` hours before the
    // newest (the seed: missed 1 when (i + back) % 17 = 0, else 0)
    const tracked = (): string[] => [
      ...scenario.unl.slice(0, 33).map((m) => m.key),
      scenario.unl[34].key,
      ...scenario.others.map((m) => m.key),
    ];
    const missedIn = (i: number, hours: number): number =>
      range(0, hours - 1).filter((back) => (i + back) % 17 === 0).length;

    it('has the newest final hour and the 1 h and 24 h windows of a validator, complete', () => {
      expect(directory.newestFinalHour).toBe(scenario.newestHour);
      const keys = tracked();
      for (const i of [0, 4, 17, 33, 34, 40, 53]) {
        const e = entry(keys[i]);
        const m1 = missedIn(i, 1);
        const m24 = missedIn(i, 24);
        expect(e.agreement1h).toMatchObject({ missed: m1, total: 900, incomplete: false });
        expect(e.agreement1h.score).toBe(((900 - m1) / 900).toFixed(4));
        expect(e.agreement24h).toMatchObject({ missed: m24, total: 24 * 900, incomplete: false });
        expect(e.agreement24h.score).toBe(((24 * 900 - m24) / (24 * 900)).toFixed(4));
      }
    });

    it('flags the 30-day window incomplete: the seed holds 48 hours', () => {
      const e = entry(tracked()[0]);
      expect(e.agreement30d).toMatchObject({ total: 48 * 900, missed: missedIn(0, 48), incomplete: true });
    });

    it('counts the hours recorded under a signing key for its master', () => {
      // unl[34] is the 34th tracked validator (index 33): its hours back 24 to 47 are stored under its signing key
      const e = entry(scenario.unl[34].key);
      expect(e.agreement30d).toMatchObject({ total: 48 * 900, missed: missedIn(33, 48), incomplete: true });
      expect(e.agreement24h).toMatchObject({ total: 24 * 900, missed: missedIn(33, 24) });
      expect(directory.entries.has(scenario.unl[34].ephemeral)).toBe(false);
    });

    it('lists 30 UTC days, the days with no sentinel incomplete', () => {
      const e = entry(tracked()[1]);
      expect(e.daily).toHaveLength(30);
      expect(e.daily[29].date).toBe(new Date(scenario.newestHour * 1000).toISOString().slice(0, 10));
      expect(e.daily[0]).toEqual({ date: expect.any(String), missed: 0, total: 0, incomplete: true, partial: 0 });
    });

    it('has the windows with no rows, and no score, for a validator that was not tracked', () => {
      expect(entry(scenario.lapsed[0].key).agreement24h).toEqual({
        missed: 0,
        total: 0,
        incomplete: false,
        partial: 0,
      });
    });
  });

  describe('records', () => {
    it('is the newest full vote of a validator within 24 h of the newest round, whoever it is', () => {
      const newest = scenario.roundLedger(0);
      for (const m of [scenario.unl[0], scenario.unl[34], scenario.others[0]]) {
        expect(entry(m.key).record).toMatchObject({ ledger_index: newest, validation_public_key: m.key, full: 1 });
      }
      expect(entry(scenario.unl[33].key).record).toBeUndefined();
      // the lapsed validators voted ten days ago
      expect(entry(scenario.lapsed[0].key).record).toBeUndefined();
    });

    it('is counted only at rounds where the validator was on the UNL and off the negative UNL', () => {
      // unl[4] was on the negative UNL at the newest round: its record is that round's, its counted record the one before
      expect(entry(scenario.unl[4].key).record?.ledger_index).toBe(scenario.roundLedger(0));
      expect(entry(scenario.unl[4].key).countedRecord?.ledger_index).toBe(scenario.roundLedger(1));
      expect(entry(scenario.unl[5].key).countedRecord?.ledger_index).toBe(scenario.roundLedger(0));
      // not a member of the UNL: no counted record
      expect(entry(scenario.others[0].key).countedRecord).toBeUndefined();
    });

    it('fills the fees a vote leaves out with the fees in force at its round', () => {
      expect(entry(scenario.unl[2].key).recordFees).toEqual({
        base_fee: '12',
        reserve_base: '1000000',
        reserve_inc: '200000',
      });
      expect(entry(scenario.unl[3].key).recordFees).toEqual({
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
      });
    });

    it('has the newest round with its UNL, negative UNL and fees', () => {
      expect(directory.newestRound).toMatchObject({
        ledgerIndex: scenario.roundLedger(0),
        closeTime: scenario.roundClose(0),
        unlSize: 35,
        trusted: 35,
        negativeUnl: [scenario.unl[4].key],
        fees: { base_fee: '10', reserve_base: '1000000', reserve_inc: '200000' },
      });
      expect(directory.newestRound?.unl).toHaveLength(35);
    });
  });

  describe('versions', () => {
    it('decodes the newest version of the last 30 days, under whichever key the vote was recorded', () => {
      expect(entry(scenario.unl[0].key)).toMatchObject({
        version: { version: '3.4.1', release: true },
        versionLatest: true,
      });
      expect(entry(scenario.unl[31].key)).toMatchObject({ version: { version: '3.4.0' }, versionLatest: false });
      // unl[34]'s votes are stored under its signing key
      expect(entry(scenario.unl[34].key).version?.version).toBe('3.4.0');
      expect(entry(scenario.others[16].key).version?.version).toBe('3.5.0-rc1');
      // the last two of the others reported no version
      expect(entry(scenario.others[19].key).version).toBeUndefined();
      expect(entry(scenario.others[19].key).versionLatest).toBeUndefined();
    });

    it('takes the version of a validator seen only in an older round from that round', () => {
      expect(entry(scenario.lapsed[0].key).version?.version).toBe('3.4.0');
    });

    it('has the latest version among the release builds of the trusted validators', () => {
      expect(directory.latest?.version).toBe('3.4.1');
    });
  });
});

// ===================================================================================================================
// every publisher unavailable, an empty database, headers and failures
// ===================================================================================================================

describe('GET /v2/network/validators/summary: with every publisher unavailable', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    const now = Date.now() / 1000;
    await insertPublishers(h.ch, [
      { publisher: 'vl.ripple.com', checked_at: now - 20.5, status: 'error', error: 'timeout', last_ok_at: null },
      { publisher: 'unl.xrplf.org', checked_at: now - 10, status: 'error', error: 'dns_error', last_ok_at: null },
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers with every publisher unavailable', async () => {
    const res = await (await h.api()).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body.unl.trusted).toBe(0);
    expect(res.body.quorum.value).toBe(0);
    expect(res.body.unl.threshold).toBe(1);
    expect(res.body.unl.publishers).toEqual([
      {
        id: 'unl.xrplf.org',
        url: 'https://unl.xrplf.org',
        public_key: PUBLISHER_KEY['unl.xrplf.org'],
        status: 'unavailable',
        last_error: 'dns_error',
        last_error_at: expect.stringMatching(MILLIS),
      },
      {
        id: 'vl.ripple.com',
        url: 'https://vl.ripple.com',
        public_key: PUBLISHER_KEY['vl.ripple.com'],
        status: 'unavailable',
        last_error: 'timeout',
        last_error_at: expect.stringMatching(MILLIS),
      },
    ]);
  });
});

describe.each(['xrpl', 'xahau'] as const)(
  'GET /v2/network/validators/summary: with an empty database (%s)',
  (network) => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness({ seed: 'none', network, env: NO_RATE_LIMIT });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('answers 200 with exactly the keys that have a value', async () => {
      const res = await (await h.api()).get(SUMMARY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        result: 'success',
        validators: { seen_24h: 0, unl_seen_24h: 0, others_seen_24h: 0, all: 0 },
        unl: { trusted: 0, publishers: [] },
        quorum: { value: 0, unl_size: 0, negative_unl: 0 },
        negative_unl: [],
        versions: [],
        versions_unknown: { unl: 0, all: 0 },
        updated: expect.stringMatching(MILLIS),
      });
      expect(Object.keys(res.body)).toEqual([
        'result',
        'validators',
        'unl',
        'quorum',
        'negative_unl',
        'versions',
        'versions_unknown',
        'updated',
      ]);
    });
  },
);

describe('GET /v2/network/validators/summary: when ClickHouse fails', () => {
  let h: Harness;

  beforeAll(async () => {
    // an app that has not built a directory yet: a built one is answered from the cache for 10 s
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is a failure of the route: 500 unable to retrieve validator(s), no-store, and the failure is not cached', async () => {
    const api = await h.api();
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('Code: 241. Memory limit exceeded'));
    const failed = await api.get(SUMMARY);
    expect([failed.status, failed.body]).toEqual([
      500,
      { result: 'error', message: 'unable to retrieve validator(s)' },
    ]);
    expect(failed.headers['cache-control']).toBe('no-store');
    // the cause is not sent
    expect(JSON.stringify(failed.body)).not.toContain('Memory limit');

    spy.mockRestore();
    const recovered = await api.get(SUMMARY);
    expect(recovered.status).toBe(200);
    expect(recovered.headers['cache-control']).toBe('private, max-age=30');
  });
});

describe('GET /v2/network/validators/summary: with GH_CACHE_CONTROL empty', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: { ...NO_RATE_LIMIT, GH_CACHE_CONTROL: '' } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('sends no-store on an error and no Cache-Control on a success', async () => {
    const api = await h.api();
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('down'));
    const failed = await api.get(SUMMARY);
    expect(failed.status).toBe(500);
    expect(failed.headers['cache-control']).toBe('no-store');

    spy.mockRestore();
    const ok = await api.get(SUMMARY);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBeUndefined();
  });
});

// ===================================================================================================================
// version sets
// ===================================================================================================================

describe('GET /v2/network/validators/summary: version sets', () => {
  let h: Harness;
  let body: Record<string, any>;
  let directory: Directory;
  let hourBefore: number;
  let members: ReturnType<typeof fleet>;

  beforeAll(async () => {
    const started = await startWithDirectory({ seed: 'none', env: NO_RATE_LIMIT });
    h = started.h;
    members = fleet('xrpl', 3);
    const [a, b, ghost] = members;
    const now = Math.floor(Date.now() / 1000);
    // a rewritten round and a rewritten hour must not be mixed: stop the merges that would hide the older sets
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ValidatorVotes}`);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.AmendmentTallies}`);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ValidatorAgreementHourly}`);

    await insertLists(h.ch, [
      { publisher: 'vl.ripple.com', sequence: 1, expiration: now + 86_400, validators: [a.key, b.key] },
    ]);
    await insertPublishers(h.ch, [{ publisher: 'vl.ripple.com', checked_at: now - 10 }]);
    await insertState(h.ch, [{ ledger_index: HEAD_LEDGER, polled_at: now - 5 }]);
    await insertSeen(
      h.ch,
      members.map((m) => ({ key: m.key, first: now - 86_400, last: now - 30 })),
    );

    const close = now - 600;
    // the round was written once with three validators and again, as a newer version, with two of them and other versions
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: 1_000,
      unl: [a.key, b.key, ghost.key],
      votes: [
        { key: a.key, serverVersion: serverVersion(3, 3, 0) },
        { key: b.key, serverVersion: serverVersion(3, 3, 0) },
        { key: ghost.key, serverVersion: serverVersion(3, 9, 9) },
      ],
    });
    await insertRound(h.ch, {
      ledgerIndex: VOTING_LEDGER,
      closeTime: close,
      version: 2_000,
      unl: [a.key, b.key],
      votes: [
        { key: a.key, serverVersion: serverVersion(3, 4, 1) },
        { key: b.key, serverVersion: serverVersion(3, 4, 1, RC1) },
      ],
    });

    // an hour written final with three validators, and again, as a newer version, with other figures for two of them; the
    // hour after it was final and is now not
    hourBefore = Math.floor(now / HOUR) * HOUR - 2 * HOUR;
    // (one insert for each version: rows of one key in one insert are collapsed on the way in)
    await insertHours(h.ch, [
      {
        hour: hourBefore,
        version: 1_000,
        rows: [
          { key: a.key, agreed: 800, missed: 100 },
          { key: ghost.key, agreed: 500, missed: 400 },
        ],
      },
      { hour: hourBefore + HOUR, version: 1_000, final: true },
    ]);
    await insertHours(h.ch, [
      {
        hour: hourBefore,
        version: 2_000,
        rows: [
          { key: a.key, agreed: 900, missed: 0 },
          { key: b.key, agreed: 890, missed: 10 },
        ],
      },
      { hour: hourBefore + HOUR, version: 2_000, final: false },
    ]);
    body = (await (await h.api()).get(SUMMARY)).body;
    directory = await started.directory();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('reads only the rows of the version of the newest sentinel of a round', () => {
    // a is on 3.4.1; b on 3.4.1-rc1 (the older set said 3.3.0); the ghost is in the older set only: no version
    expect(body.versions).toEqual([
      { version: '3.4.1', unl: 1, all: 1 },
      { version: '3.4.1-rc1', unl: 1, all: 1 },
    ]);
    expect(body.versions_unknown).toEqual({ unl: 0, all: 1 });
    expect(body.latest_version).toBe('3.4.1');
    expect(directory.newestRound?.unl).toEqual([members[0].key, members[1].key]);
    expect(directory.entries.get(members[2].key)).toMatchObject({ unl: false });
    expect(directory.entries.get(members[2].key)?.record).toBeUndefined();
  });

  it('has the ledger of the ledger state, without a close time, when no ledger is indexed', () => {
    expect(body.ledger_index).toBe(HEAD_LEDGER);
    expect('close_time' in body).toBe(false);
    expect(body.next_flag_ledger).toEqual({ ledger_index: 107_748_352, voting_ledger: 107_748_351 });
  });

  it('reads only the sentinel of the newest version of an hour: a newer, not final set makes the hour not final', () => {
    // hourBefore + 1 h is not final in its newest version, so the newest final hour is hourBefore
    expect(body.agreement_through).toBe(time(hourBefore + HOUR));
    expect(directory.newestFinalHour).toBe(hourBefore);
  });

  it('reads only the rows of the version of the newest sentinel of an hour', () => {
    const [a, b, ghost] = members.map((m) => directory.entries.get(m.key));
    expect(a?.agreement1h).toEqual({ missed: 0, total: 900, score: '1.0000', incomplete: false, partial: 0 });
    expect(b?.agreement1h).toEqual({ missed: 10, total: 900, score: '0.9889', incomplete: false, partial: 0 });
    // the ghost has a row in the older set only
    expect(ghost?.agreement1h).toEqual({ missed: 0, total: 0, incomplete: false, partial: 0 });
  });
});

// ===================================================================================================================
// Xahau
// ===================================================================================================================

describe('GET /v2/network/validators/summary: on Xahau', () => {
  let h: Harness;
  let body: Record<string, any>;
  let directory: Directory;

  beforeAll(async () => {
    const started = await startWithDirectory({ seed: 'none', network: 'xahau', env: NO_RATE_LIMIT });
    h = started.h;
    const members = fleet('xahau', 4);
    const now = Math.floor(Date.now() / 1000);
    await insertLists(h.ch, [
      {
        publisher: 'vl.xahau.org',
        sequence: 2_026_092_401,
        expiration: now + 86_400,
        validators: members.map((m) => m.key),
      },
    ]);
    await insertPublishers(h.ch, [{ publisher: 'vl.xahau.org', checked_at: now - 10 }]);
    await insertManifests(h.ch, [
      { ephemeral_key: members[0].ephemeral, master_key: members[0].key, seq: 1, domain: 'north.example' },
      { ephemeral_key: members[1].ephemeral, master_key: members[1].key, seq: 1, domain: 'south.example' },
      { ephemeral_key: members[2].ephemeral, master_key: members[2].key, seq: 1 },
      { ephemeral_key: members[3].ephemeral, master_key: members[3].key, seq: 1 },
    ]);
    await insertDomains(h.ch, [
      {
        validation_public_key: members[1].key,
        domain: 'south.example',
        toml_url: 'https://south.example/.well-known/xahau.toml',
        checked_at: now - 100,
      },
    ]);
    await insertSeen(
      h.ch,
      members.map((m) => ({ key: m.key, first: now - 86_400, last: now - 30 })),
    );
    // 3.10.13 build 4119 and 4120 are 2026.10.13 (the year counts from 2023), 3.9.2 is 2026.9.2
    await insertRound(h.ch, {
      ledgerIndex: 26_633_471,
      closeTime: now - 600,
      unl: members.map((m) => m.key),
      votes: [
        { key: members[0].key, serverVersion: serverVersion(3, 10, 13, 0, 4119) },
        { key: members[1].key, serverVersion: serverVersion(3, 10, 13, 0, 4120) },
        { key: members[2].key, serverVersion: serverVersion(3, 9, 2, 0, 1) },
        { key: members[3].key, serverVersion: serverVersion(3, 10, 14, RC1, 7) },
      ],
    });
    body = (await (await h.api()).get(SUMMARY)).body;
    directory = await started.directory();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('names the versions with the year offset, without the build, and groups the builds of a version', () => {
    expect(body.unl.publishers[0]).toMatchObject({ id: 'vl.xahau.org', public_key: PUBLISHER_KEY['vl.xahau.org'] });
    expect(body.versions).toEqual([
      { version: '2026.10.14-rc1', unl: 1, all: 1 },
      { version: '2026.10.13', unl: 2, all: 2 },
      { version: '2026.9.2', unl: 1, all: 1 },
    ]);
    expect(body.latest_version).toBe('2026.10.13');
    expect(body.quorum).toEqual({ value: 4, unl_size: 4, negative_unl: 0 });
  });

  it('keeps the build number of a validator, which the summary leaves out', () => {
    const members = fleet('xahau', 4);
    expect(directory.entries.get(members[0].key)?.version).toMatchObject({ version: '2026.10.13', build: 4119 });
    expect(directory.entries.get(members[1].key)?.version).toMatchObject({ version: '2026.10.13', build: 4120 });
    expect(directory.entries.get(members[3].key)?.version).toMatchObject({ version: '2026.10.14-rc1', build: 7 });
    expect(directory.latest).toMatchObject({ version: '2026.10.13', release: true });
  });

  it('reads the TOML of Xahau at /.well-known/xahau.toml', () => {
    const members = fleet('xahau', 4);
    // not checked yet: the address the check will fetch
    expect(directory.entries.get(members[0].key)?.domainState).toEqual({
      status: 'pending',
      tomlUrl: 'https://north.example/.well-known/xahau.toml',
    });
    expect(directory.entries.get(members[1].key)?.domainState).toMatchObject({
      status: 'verified',
      tomlUrl: 'https://south.example/.well-known/xahau.toml',
    });
    expect(directory.entries.get(members[2].key)?.domainState).toBeUndefined();
  });
});

// ===================================================================================================================
// the routes of the original that stay 404
// ===================================================================================================================

describe('the routes of the original that this API does not serve', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
  });
  afterAll(async () => {
    await h?.close();
  });

  it.each([
    '/v2/network/validators/nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6/manifests',
    '/v2/network/validators/nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6/reports',
    '/v2/network/validator_reports',
    '/v2/network/rippled_versions',
  ])('answers 404 Cannot GET for %s', async (path) => {
    const res = await (await h.api()).get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ result: 'error', message: `Cannot GET ${path}` });
  });
});

// ===================================================================================================================
// the reads stay within their window
// ===================================================================================================================

describe('the reads of the directory stay within their window (read_rows over a bulk of four parts)', () => {
  // Ruling R106 for the three big tables the directory reads: validator_validations (the last 300 ledgers),
  // validator_agreement_hourly (the 720 hours of the window) and validator_votes (the rounds of the last 30 days). Each has a
  // bulk of four parts of 200,000 rows outside its window (see support/read-rows.ts for the ledger tables; the hours lie
  // 50 to 380 days back), and a request must read about the rows of the window and a granule of every part, not the bulk.
  const GRANULE = 8192;
  /** The part of the real data and the four of the bulk. */
  const PARTS = 1 + BULK_BASES.length;

  let h: Harness;
  let scenario: FleetScenario;
  const reads: Record<string, LoggedRead[]> = {};

  /** The most rows a read of a window of `window` rows may read: the window and a granule of every part. */
  const bound = (window: number): number => window + PARTS * GRANULE;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    scenario = await seedFleet(h.ch, { hours: 720, activity: true });

    // validations: four parts of one validator each, in the partition of the head (ledgers 107,700,000 and on, three hashes a
    // ledger, all below the last 300), so that the partition cannot be what keeps the bulk out of the read
    await insertBulk(
      h,
      Table.ValidatorValidations,
      `SELECT * FROM ${Table.ValidatorValidations} ORDER BY validation_public_key, ledger_index LIMIT 1`,
      {},
      (base) =>
        `toUInt32(107700000 + intDiv(n.number, 3)) AS ledger_index, toString(n.number) AS ledger_hash, ` +
        `'nHBulkValidator${BULK_BASES.indexOf(base)}' AS validation_public_key`,
      140_000,
    );
    // votes: four validators a ledger in the same ledger ranges
    await insertBulk(
      h,
      Table.ValidatorVotes,
      `SELECT * FROM ${Table.ValidatorVotes} ORDER BY ledger_index, validation_public_key LIMIT 1`,
      {},
      (base) =>
        `toUInt32(${base} + intDiv(n.number, 4)) AS ledger_index, ` +
        `concat('nHBulk', toString(n.number % 4)) AS validation_public_key`,
    );
    // hours: 2,000 hours of 100 validators a part, the parts one after the other from 380 days back, the last ending 48
    // days back (a hour is kept 400 days)
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.ValidatorAgreementHourly}`);
    for (let part = 0; part < BULK_BASES.length; part++) {
      const start = scenario.newestHour - (380 - 83 * part) * DAY;
      await h.ch.command(
        `INSERT INTO ${Table.ValidatorAgreementHourly}
         SELECT tpl.* REPLACE (toDateTime({start:UInt32} + intDiv(n.number, 100) * 3600, 'UTC') AS hour,
                               concat('nHBulk', toString(n.number % 100)) AS validation_public_key)
           FROM (SELECT * FROM ${Table.ValidatorAgreementHourly} WHERE validation_public_key != '' LIMIT 1) AS tpl
          CROSS JOIN numbers({rows:UInt32}) AS n`,
        { start, rows: BULK_PER_PART },
        { settings: { insert_deduplicate: 0 } },
      );
    }

    // one build of the directory, under the log of the reads of the three tables
    reads.validations = await readsOf(h, Table.ValidatorValidations, async () => {
      reads.hours = await readsOf(h, Table.ValidatorAgreementHourly, async () => {
        reads.votes = await readsOf(h, Table.ValidatorVotes, async () => {
          expect((await (await h.api()).get(SUMMARY)).status).toBe(200);
        });
      });
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('has a bulk of four parts of 100,000 rows or more in every table', async () => {
    for (const table of [Table.ValidatorValidations, Table.ValidatorVotes, Table.ValidatorAgreementHourly]) {
      const [row] = await h.ch.query<{ parts: string }>(
        `SELECT count() AS parts FROM system.parts
          WHERE database = {db:String} AND table = {table:String} AND active AND rows >= {bulk:UInt64}`,
        { db: h.database, table, bulk: 100_000 },
      );
      expect([table, Number(row.parts)]).toEqual([table, BULK_BASES.length]);
    }
  });

  it('reads the validations of the last 300 ledgers, not the table', () => {
    // 54 validators for each of the 301 ledgers
    expect(reads.validations.length).toBeGreaterThan(0);
    for (const read of reads.validations) expect(read.read_rows).toBeLessThanOrEqual(bound(54 * 301));
  });

  it('reads the hours of the window, not the table', () => {
    // 720 hours of 54 validators and a sentinel
    expect(reads.hours.length).toBeGreaterThan(0);
    for (const read of reads.hours) expect(read.read_rows).toBeLessThanOrEqual(bound(720 * 55));
  });

  it('reads the votes of the rounds of the last 30 days, not the table', () => {
    // 4 rounds of 54 votes and an old round of 2
    expect(reads.votes.length).toBeGreaterThan(0);
    for (const read of reads.votes) expect(read.read_rows).toBeLessThanOrEqual(bound(4 * 54 + 2));
  });
});

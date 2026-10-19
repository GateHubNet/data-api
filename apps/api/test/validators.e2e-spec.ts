import { Table } from '@gatehub/data-api-shared';
import { join } from 'node:path';
import type { Directory } from '../src/validators/directory';
import { PUBLISHER_KEYS, SUMMARY_KEYS } from '../src/validators/summary-object';
import type { ValidatorDirectoryService } from '../src/validators/validator-directory.service';
import {
  AGREEMENT_KEYS,
  DAILY_KEYS,
  DETAIL_AMENDMENT_VOTES_KEYS,
  DETAIL_TAIL_KEYS,
  DOMAIN_VERIFICATION_KEYS,
  FEE_VOTE_KEYS,
  LIST_BODY_KEYS,
  MANIFEST_KEYS,
  VALIDATOR_ROW_KEYS,
  VOTE_ENTRY_KEYS,
} from '../src/validators/validator-object';
import { ApiClient, Harness, HarnessOptions, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { BULK_BASES, BULK_PER_PART, insertBulk, LoggedRead, readsOf } from './support/read-rows';
import {
  BOARD_IDS,
  BOARD_NAMES,
  BoardScenario,
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
  seedAmendmentBoard,
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
 * `GET /v2/network/validators` and `GET /v2/network/validators/{key}` on the same fleet, on the board of the amendments
 * spec (the votes on the amendments, unknown ones included) and on Xahau: the scopes and filters of the list, its order,
 * markers and CSV, the detail by a master key, a signing key and 66 hex digits, and the failures.
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
      // validator_seen, validator_validations, validator_votes and validator_domains: every statement
      for (const table of [
        Table.ValidatorSeen,
        Table.ValidatorValidations,
        Table.ValidatorVotes,
        Table.ValidatorDomains,
      ]) {
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
    // northpeak, shoreline, tidewater
    expect(keys.slice(0, 3)).toEqual([scenario.unl[0].key, scenario.unl[1].key, scenario.others[1].key]);
    const rest = keys.slice(3);
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

  it('maps the key of a domain check recorded under a signing key to its master', () => {
    // the check of tidewater.example was stored under the signing key of others[1]
    expect(entry(scenario.others[1].key)).toMatchObject({ domain: 'tidewater.example' });
    expect(entry(scenario.others[1].key).domainState).toEqual({
      status: 'verified',
      tomlUrl: 'https://tidewater.example/.well-known/xrp-ledger.toml',
      checked: expect.closeTo(scenario.now - 300.125, 2),
      verified: expect.closeTo(scenario.now - 300.125, 2),
    });
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

// A version is a UInt64 (a wall-clock millisecond today). These are above 2^53, where a JavaScript number is not exact: a reader
// that turns a version into a number looks for rows that are not there.
const OLDER_ROUND = '9007199254740991';
const NEWER_ROUND = '9007199254740993';
const OLDER_HOUR = '9007199254740993';
const NEWER_HOUR = '9007199254740995';

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
      version: OLDER_ROUND,
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
      version: NEWER_ROUND,
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
        version: OLDER_HOUR,
        rows: [
          { key: a.key, agreed: 800, missed: 100 },
          { key: ghost.key, agreed: 500, missed: 400 },
        ],
      },
      { hour: hourBefore + HOUR, version: OLDER_HOUR, final: true },
    ]);
    await insertHours(h.ch, [
      {
        hour: hourBefore,
        version: NEWER_HOUR,
        rows: [
          { key: a.key, agreed: 900, missed: 0 },
          { key: b.key, agreed: 890, missed: 10 },
        ],
      },
      { hour: hourBefore + HOUR, version: NEWER_HOUR, final: false },
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
// a stall above a complete window
// ===================================================================================================================

describe.each([
  ['30 hours, more than the 24 of slack of a first version of the read', 30],
  ['800 hours, more than a range of 720 of the search', 800],
])('the directory when %s are not final above a complete window of final hours', (_name, stalled) => {
  let h: Harness;
  let body: Record<string, any>;
  let directory: Directory;
  let finalHour: number;
  let members: ReturnType<typeof fleet>;

  beforeAll(async () => {
    const started = await startWithDirectory({ seed: 'none', env: NO_RATE_LIMIT });
    h = started.h;
    members = fleet('xrpl', 2);
    const now = Math.floor(Date.now() / 1000);
    await insertLists(h.ch, [
      { publisher: 'vl.ripple.com', sequence: 1, expiration: now + 86_400, validators: members.map((m) => m.key) },
    ]);
    await insertPublishers(h.ch, [{ publisher: 'vl.ripple.com', checked_at: now - 10 }]);
    await insertSeen(
      h.ch,
      members.map((m) => ({ key: m.key, first: now - 86_400, last: now - 30 })),
    );
    // 720 final hours, then hours that are not final up to the previous hour
    finalHour = Math.floor(now / HOUR) * HOUR - (stalled + 1) * HOUR;
    const hours = (from: number, count: number, final: boolean, agreed: number, missed: number) =>
      range(0, count - 1).map((i) => ({
        hour: from + i * HOUR,
        version: Date.now(),
        final,
        rows: [{ key: members[0].key, agreed, missed }],
      }));
    await insertHours(h.ch, hours(finalHour - 719 * HOUR, 720, true, 899, 1));
    await insertHours(h.ch, hours(finalHour + HOUR, stalled, false, 500, 50));
    body = (await (await h.api()).get(SUMMARY)).body;
    directory = await started.directory();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('takes the newest final hour, not the newest hour stored', () => {
    expect(directory.newestFinalHour).toBe(finalHour);
    expect(body.agreement_through).toBe(time(finalHour + HOUR));
  });

  it('has the 30-day window complete, with the 720 hours of it', () => {
    const entry = directory.entries.get(members[0].key);
    expect(entry?.agreement30d).toEqual({
      missed: 720,
      total: 720 * 900,
      score: '0.9989',
      incomplete: false,
      partial: 0,
    });
    expect(entry?.agreement24h).toMatchObject({ total: 24 * 900, incomplete: false });
    expect(entry?.agreement1h).toMatchObject({ total: 900, missed: 1, incomplete: false });
    // the hours above the newest final hour are not in any window
    expect(entry?.daily[entry.daily.length - 1]).toMatchObject({ incomplete: true });
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
// the list and the detail of a validator
// ===================================================================================================================

const LIST = '/v2/network/validators';
const detailOf = (key: string): string => `${LIST}/${key}`;

/** The vote of every validator of the fleet, and so the only amendment of that scenario (nameless). */
const FLEET_AMENDMENT = '98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76';
const FIXTURE = join(__dirname, 'support', 'amendments-xrpl.json');
/** Metadata files with no amendment (made for the tests): the only amendments are the ones validators vote for. */
const NO_AMENDMENTS = {
  xrpl: join(__dirname, 'support', 'amendments-none-xrpl.json'),
  xahau: join(__dirname, 'support', 'amendments-none-xahau.json'),
} as const;

type Answer = { status: number; body: Record<string, any>; headers: Record<string, string>; text: string };

/** What the seed of the fleet puts in the window of validator `i` of its tracked ones: the newest `hours` hours of 900 ledgers each. */
function seededWindow(i: number, hours: number, complete: boolean) {
  const backs = range(0, hours - 1);
  const missed = backs.filter((back) => (i + back) % 17 === 0).length;
  const partial = backs.filter((back) => (i + back) % 17 === 0 && (i + back) % 34 === 0).length;
  const total = hours * 900;
  return { missed, total, score: ((total - missed) / total).toFixed(4), incomplete: !complete, partial };
}

/** The keys of an object that a key list says come in that order, the ones the object has. */
const orderedBy = (keys: readonly string[], object: object): string[] => keys.filter((key) => key in object);

describe('GET /v2/network/validators and /{key}: a fleet of 35 trusted validators (XRPL)', () => {
  let started: Awaited<ReturnType<typeof startWithDirectory>>;
  let h: Harness;
  let api: ApiClient;
  let s: FleetScenario;
  let unlList: Answer;
  let allList: Answer;
  let directoryBefore: string;
  let directoryAfter: string;
  let sameDirectory: boolean;

  /** The master keys of a list, in order. */
  const keys = (answer: Answer): string[] =>
    answer.body.validators.map((row: { validation_public_key: string }) => row.validation_public_key);
  const rowOf = (answer: Answer, key: string): Record<string, any> => {
    const found = answer.body.validators.find(
      (row: { validation_public_key: string }) => row.validation_public_key === key,
    );
    if (!found) throw new Error(`no row for ${key}`);
    return found;
  };
  /** The order of the list: with a domain first, by domain, then the rest by key. */
  const sortedKeys = (withDomain: string[], rest: string[]): string[] => [...withDomain, ...[...rest].sort()];

  beforeAll(async () => {
    started = await startWithDirectory({
      seed: 'none',
      network: 'xrpl',
      env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: NO_AMENDMENTS.xrpl },
    });
    h = started.h;
    api = await h.api();
    s = await seedFleet(h.ch, { activity: true });
    unlList = await api.get(LIST);
    allList = await api.get(`${LIST}?scope=all`);
    // the directory the requests are made on, before and after a series of them (all within the 10 s it is kept)
    const before = await started.directory();
    directoryBefore = JSON.stringify([...before.entries.values()]);
    await api.get(`${LIST}?scope=all&q=e&limit=2`);
    await api.get(`${LIST}?scope=all&publisher=vl.ripple.com&amendment=${FLEET_AMENDMENT}&format=csv`);
    await api.get(detailOf(s.unl[0].key));
    await api.get(detailOf(s.dormant.key));
    const after = await started.directory();
    directoryAfter = JSON.stringify([...after.entries.values()]);
    sameDirectory = before === after;
  });
  afterAll(async () => {
    await h?.close();
  });

  // -- the list -----------------------------------------------------------------------------------------------------

  describe('the list: scope=unl, the default', () => {
    it('lists the trusted UNL, seen or not: the 35 members, the two with a domain first', () => {
      expect(unlList.status).toBe(200);
      expect(unlList.body.result).toBe('success');
      expect(unlList.body.count).toBe(35);
      expect(unlList.body.validators).toHaveLength(35);
      expect(keys(unlList)).toEqual(
        sortedKeys(
          [s.unl[0].key, s.unl[1].key],
          s.unl.slice(2).map((m) => m.key),
        ),
      );
    });

    it('has the keys of LIST_BODY_KEYS in order, with no marker when everything fits', () => {
      expect(Object.keys(unlList.body)).toEqual(['result', 'count', 'validators']);
      expect([...LIST_BODY_KEYS]).toEqual(['result', 'count', 'marker', 'validators']);
    });

    it('includes a member of the UNL that was never seen, with what it has: its windows, its lists, its signing key', () => {
      expect(rowOf(unlList, s.unl[33].key)).toEqual({
        validation_public_key: s.unl[33].key,
        agreement_1h: { missed: 0, total: 0, incomplete: false, partial: 0 },
        agreement_24h: { missed: 0, total: 0, incomplete: false, partial: 0 },
        unl: true,
        agreement_30d: { missed: 0, total: 0, incomplete: true, partial: 0 },
        signing_key: s.unl[33].ephemeral,
        unl_lists: ['unl.xrplf.org', 'vl.ripple.com'],
        negative_unl: false,
      });
    });

    it('leaves out the others, those seen only within 30 days and the one seen 40 days ago', () => {
      const listed = new Set(keys(unlList));
      for (const other of [...s.others, ...s.lapsed, s.dormant]) expect(listed.has(other.key)).toBe(false);
    });

    it('is the row of the specification for a validator with everything: northpeak.example', () => {
      expect(rowOf(unlList, s.unl[0].key)).toEqual({
        validation_public_key: s.unl[0].key,
        domain: 'northpeak.example',
        current_index: HEAD_LEDGER,
        agreement_1h: seededWindow(0, 1, true),
        agreement_24h: seededWindow(0, 24, true),
        partial: false,
        unl: true,
        agreement_30d: seededWindow(0, 48, false),
        signing_key: s.rotated.base58,
        domain_verification: {
          status: 'verified',
          toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
          checked: instant(s.now - 600.511),
          verified: instant(s.now - 600.511),
          accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
        },
        unl_lists: ['unl.xrplf.org', 'vl.ripple.com'],
        negative_unl: false,
        version: '3.4.1',
        version_latest: true,
        server_version: serverVersion(3, 4, 1),
        fee_vote: { ledger_index: VOTING_LEDGER, base_fee: '0.00001', reserve_base: '1', reserve_inc: '0.2' },
        amendment_votes: { ledger_index: VOTING_LEDGER, yes: [{ id: FLEET_AMENDMENT }] },
        first_seen: instant(s.now - 90 * DAY),
        last_seen: instant(s.now - 60.25),
      });
    });

    it('lists the keys of every row in the order of VALIDATOR_ROW_KEYS, and never has a null', () => {
      for (const row of unlList.body.validators) {
        expect(Object.keys(row)).toEqual(orderedBy(VALIDATOR_ROW_KEYS, row));
        expect(Object.keys(row.agreement_1h)).toEqual(orderedBy(AGREEMENT_KEYS, row.agreement_1h));
        expect(Object.keys(row.agreement_24h)).toEqual(orderedBy(AGREEMENT_KEYS, row.agreement_24h));
        expect(Object.keys(row.agreement_30d)).toEqual(orderedBy(AGREEMENT_KEYS, row.agreement_30d));
        if (row.domain_verification) {
          expect(Object.keys(row.domain_verification)).toEqual(
            orderedBy(DOMAIN_VERIFICATION_KEYS, row.domain_verification),
          );
        }
        if (row.fee_vote) expect(Object.keys(row.fee_vote)).toEqual([...FEE_VOTE_KEYS]);
        if (row.amendment_votes) expect(Object.keys(row.amendment_votes)).toEqual(['ledger_index', 'yes']);
      }
      expect(Object.keys(rowOf(unlList, s.unl[0].key))).toEqual(
        [...VALIDATOR_ROW_KEYS].filter((key) => key !== 'version_build'),
      );
      expect(JSON.stringify(unlList.body)).not.toContain('null');
    });

    it('says partial for a validator whose newest validation was partial', () => {
      expect(rowOf(unlList, s.unl[1].key)).toMatchObject({ current_index: HEAD_LEDGER, partial: true });
    });

    it('has the fee vote of a validator: its own base fee and the fees in force for the rest', () => {
      // unl[2] voted a base fee of 12 drops; the reserves are the ones in force at the round
      expect(rowOf(unlList, s.unl[2].key).fee_vote).toEqual({
        ledger_index: VOTING_LEDGER,
        base_fee: '0.000012',
        reserve_base: '1',
        reserve_inc: '0.2',
      });
      expect(rowOf(unlList, s.unl[3].key).fee_vote).toEqual({
        ledger_index: VOTING_LEDGER,
        base_fee: '0.00001',
        reserve_base: '1',
        reserve_inc: '0.2',
      });
    });

    it('says which validator is on the negative UNL', () => {
      expect(rowOf(unlList, s.unl[4].key).negative_unl).toBe(true);
      expect(rowOf(unlList, s.unl[5].key).negative_unl).toBe(false);
    });

    it('gives the verification of a domain: unverified with its reason, absent without a domain', () => {
      expect(rowOf(unlList, s.unl[1].key).domain_verification).toEqual({
        status: 'unverified',
        reason: 'not_listed',
        toml_url: 'https://shoreline.example/.well-known/xrp-ledger.toml',
        checked: instant(s.now - 700.25),
      });
      expect(rowOf(unlList, s.unl[2].key)).not.toHaveProperty('domain_verification');
      expect(rowOf(unlList, s.unl[2].key)).not.toHaveProperty('domain');
    });

    it('counts a validator seen and voting under its signing key for its master: unl[34]', () => {
      expect(rowOf(unlList, s.unl[34].key)).toMatchObject({
        current_index: HEAD_LEDGER,
        version: '3.4.0',
        version_latest: false,
        amendment_votes: { ledger_index: VOTING_LEDGER },
        last_seen: instant(s.now - 90.5),
        first_seen: instant(s.now - 90 * DAY),
      });
      expect(rowOf(unlList, s.unl[34].key).agreement_30d.total).toBe(48 * 900);
    });

    it('sends Cache-Control: private, max-age=30', () => {
      expect(unlList.headers['cache-control']).toBe('private, max-age=30');
    });
  });

  describe('the list: scope=all', () => {
    it('adds the 20 others seen in 24 hours to the UNL, and not those seen only within 30 days', () => {
      expect(allList.body.count).toBe(55);
      const others = s.others.map((m) => m.key);
      const rest = [...s.unl.slice(2).map((m) => m.key), ...others.filter((key) => key !== s.others[1].key)];
      expect(keys(allList)).toEqual(sortedKeys([s.unl[0].key, s.unl[1].key, s.others[1].key], rest));
      const listed = new Set(keys(allList));
      for (const lapsed of [...s.lapsed, s.dormant]) expect(listed.has(lapsed.key)).toBe(false);
    });

    it('has the others with what they have: tidewater.example, its verification recorded under a signing key', () => {
      expect(rowOf(allList, s.others[1].key)).toMatchObject({
        domain: 'tidewater.example',
        unl: false,
        unl_lists: [],
        negative_unl: false,
        domain_verification: {
          status: 'verified',
          toml_url: 'https://tidewater.example/.well-known/xrp-ledger.toml',
          checked: instant(s.now - 300.125),
          verified: instant(s.now - 300.125),
        },
      });
      expect(rowOf(allList, s.others[1].key).domain_verification).not.toHaveProperty('accounts');
    });

    it('says what a validator off the UNL votes: its version, fee vote and amendments', () => {
      expect(rowOf(allList, s.others[16].key)).toMatchObject({ version: '3.5.0-rc1', version_latest: true });
      expect(rowOf(allList, s.others[19].key)).not.toHaveProperty('version');
      expect(rowOf(allList, s.others[19].key)).not.toHaveProperty('server_version');
      expect(rowOf(allList, s.others[0].key).amendment_votes).toEqual({
        ledger_index: VOTING_LEDGER,
        yes: [{ id: FLEET_AMENDMENT }],
      });
    });

    it('answers scope=x with 400 invalid scope', async () => {
      const res = await api.get(`${LIST}?scope=x`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid scope' }]);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('filters', () => {
    it('filters by publisher: the validators on its list in use', async () => {
      const xrplf = await api.get(`${LIST}?publisher=unl.xrplf.org`);
      expect(xrplf.status).toBe(200);
      // its list is expired and still in use: 34 validators, the last UNL member (never seen) is not on it
      expect(keys(xrplf)).toEqual(
        sortedKeys(
          [s.unl[0].key, s.unl[1].key],
          s.unl.slice(2, 34).map((m) => m.key),
        ),
      );
      for (const row of xrplf.body.validators) expect(row.unl_lists).toContain('unl.xrplf.org');
      const ripple = await api.get(`${LIST}?publisher=vl.ripple.com`);
      expect(ripple.body.count).toBe(35);
    });

    it('applies the scope and the publisher together', async () => {
      const res = await api.get(`${LIST}?publisher=unl.xrplf.org&scope=all`);
      expect(res.body.count).toBe(34);
    });

    it('answers a publisher it does not know with 400 invalid publisher', async () => {
      const res = await api.get(`${LIST}?publisher=example.com`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid publisher' }]);
    });

    it('filters by amendment ID, in either case: the validators whose record votes for it', async () => {
      const upper = await api.get(`${LIST}?scope=all&amendment=${FLEET_AMENDMENT}`);
      // 54 voted: every validator seen in 24 hours; the member of the UNL never seen did not
      expect(upper.body.count).toBe(54);
      expect(keys(upper)).not.toContain(s.unl[33].key);
      const lower = await api.get(`${LIST}?scope=all&amendment=${FLEET_AMENDMENT.toLowerCase()}`);
      expect(keys(lower)).toEqual(keys(upper));
      for (const row of upper.body.validators) {
        expect(row.amendment_votes.yes.map((entry: { id: string }) => entry.id)).toContain(FLEET_AMENDMENT);
      }
    });

    it('answers an ID nobody voted for with an empty list, and a name nobody knows with 400 invalid amendment', async () => {
      const none = await api.get(`${LIST}?amendment=${'0F'.repeat(32)}`);
      expect([none.status, none.body]).toEqual([200, { result: 'success', count: 0, validators: [] }]);
      for (const bad of ['NoSuchAmendment', 'AB'.repeat(31), 'zz'.repeat(32)]) {
        const res = await api.get(`${LIST}?amendment=${bad}`);
        expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid amendment' }]);
      }
    });

    it('searches the domain, without regard to case', async () => {
      const res = await api.get(`${LIST}?q=NorthPeak`);
      expect(keys(res)).toEqual([s.unl[0].key]);
      const both = await api.get(`${LIST}?q=.example&scope=all`);
      expect(keys(both)).toEqual([s.unl[0].key, s.unl[1].key, s.others[1].key]);
    });

    it('searches a master key by a part of it', async () => {
      const part = s.unl[7].key.slice(4, 20);
      const res = await api.get(`${LIST}?q=${part.toLowerCase()}`);
      expect(keys(res)).toEqual([s.unl[7].key]);
    });

    it('searches a signing key by a part of it: the one unl[0] rotated to, not the one before it', async () => {
      const rotated = await api.get(`${LIST}?q=${s.rotated.base58.slice(3, 22)}`);
      expect(keys(rotated)).toEqual([s.unl[0].key]);
      const older = await api.get(`${LIST}?q=${s.unl[0].ephemeral}`);
      expect(older.body.count).toBe(0);
      const current = await api.get(`${LIST}?q=${s.unl[9].ephemeral}`);
      expect(keys(current)).toEqual([s.unl[9].key]);
    });

    it('searches within the scope: tidewater.example is off the UNL', async () => {
      expect((await api.get(`${LIST}?q=tidewater`)).body.count).toBe(0);
      expect(keys(await api.get(`${LIST}?q=tidewater&scope=all`))).toEqual([s.others[1].key]);
    });

    it('allows a search of 100 characters and refuses 101 with 400 invalid search', async () => {
      expect((await api.get(`${LIST}?q=${'a'.repeat(100)}`)).status).toBe(200);
      const res = await api.get(`${LIST}?q=${'a'.repeat(101)}`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid search' }]);
    });

    it('applies every filter together', async () => {
      const res = await api.get(
        `${LIST}?scope=all&publisher=vl.ripple.com&amendment=${FLEET_AMENDMENT}&q=${encodeURIComponent('.example')}`,
      );
      expect(keys(res)).toEqual([s.unl[0].key, s.unl[1].key]);
    });

    it('checks in the order scope, publisher, amendment, search, marker', async () => {
      const message = async (query: string): Promise<string> => (await api.get(`${LIST}?${query}`)).body.message;
      const q = 'a'.repeat(101);
      expect(await message(`scope=x&publisher=x&amendment=x&q=${q}&marker=%25%25%25`)).toBe('invalid scope');
      expect(await message(`publisher=x&amendment=x&q=${q}&marker=%25%25%25`)).toBe('invalid publisher');
      expect(await message(`amendment=x&q=${q}&marker=%25%25%25`)).toBe('invalid amendment');
      expect(await message(`q=${q}&marker=%25%25%25`)).toBe('invalid search');
      expect(await message('marker=%25%25%25')).toBe('invalid marker');
    });

    it('ignores the parameters it does not know', async () => {
      const res = await api.get(`${LIST}?foo=bar&sort=desc&descending=true&strict=false`);
      expect(keys(res)).toEqual(keys(unlList));
    });
  });

  describe('paging', () => {
    it.each([1, 2, 3])('concatenates the pages of limit=%i to the unpaged list', async (limit) => {
      const pages = await api.pages<Answer['body']>(`${LIST}?scope=all`, limit, 'validators');
      const walked = pages.flatMap((page) =>
        page.validators.map((row: { validation_public_key: string }) => row.validation_public_key),
      );
      expect(walked).toEqual(keys(allList));
      // every page but the last is full and has the marker; the last has none
      for (const page of pages.slice(0, -1)) {
        expect(page.count).toBe(limit);
        expect(page.marker).toEqual(expect.any(String));
      }
      expect(pages[pages.length - 1]).not.toHaveProperty('marker');
      expect(pages).toHaveLength(Math.ceil(55 / limit));
    });

    it('has the marker of the last row, base64url of [group, sort text, master key], and the Link header', async () => {
      const first = await api.get(`${LIST}?scope=all&limit=3`);
      expect(first.body.count).toBe(3);
      expect(Object.keys(first.body)).toEqual([...LIST_BODY_KEYS]);
      const decoded = JSON.parse(Buffer.from(first.body.marker, 'base64url').toString('utf8'));
      // the third of the list is tidewater.example, the last with a domain
      expect(decoded).toEqual([0, 'tidewater.example', s.others[1].key]);
      expect(first.headers.link).toMatch(
        new RegExp(
          `^<http://[^>]+/v2/network/validators\\?scope=all&limit=3&marker=${first.body.marker}>; rel="next"$`,
        ),
      );
      const second = await api.get(`${LIST}?scope=all&limit=3&marker=${first.body.marker}`);
      // the first without a domain: group 1, the empty text
      expect(JSON.parse(Buffer.from(second.body.marker, 'base64url').toString('utf8'))).toEqual([
        1,
        '',
        second.body.validators[2].validation_public_key,
      ]);
      expect(keys(second)).toEqual(keys(allList).slice(3, 6));
    });

    it('has no Link header on the last page', async () => {
      const last = await api.get(`${LIST}?scope=all&limit=1000`);
      expect(last.headers.link).toBeUndefined();
      expect(last.body).not.toHaveProperty('marker');
    });

    it('resumes after a marker whose row is gone', async () => {
      const marker = Buffer.from(JSON.stringify([1, '', 'nHAAAA'])).toString('base64url');
      const res = await api.get(`${LIST}?scope=all&marker=${marker}`);
      expect(keys(res)).toEqual(
        keys(allList).filter((key) => key > 'nHAAAA' && !keys(allList).slice(0, 3).includes(key)),
      );
    });

    it('answers a marker it cannot read with 400 invalid marker', async () => {
      const bad = [
        '%25%25%25',
        Buffer.from('[2,"a","b"]').toString('base64url'),
        Buffer.from('[0,"a"]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
        Buffer.from('[0,1,"b"]').toString('base64url'),
      ];
      for (const marker of bad) {
        const res = await api.get(`${LIST}?marker=${marker}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('takes limit as it is taken everywhere: 200 by default, 1000 at most', async () => {
      expect((await api.get(`${LIST}?scope=all&limit=0`)).body.count).toBe(55);
      expect((await api.get(`${LIST}?scope=all&limit=5000`)).body.count).toBe(55);
      expect((await api.get(`${LIST}?scope=all&limit=10`)).body.count).toBe(10);
    });
  });

  describe('format=csv', () => {
    const cells = (line: string): string[] => line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    let csv: Answer;

    beforeAll(async () => {
      csv = await api.get(`${LIST}?format=csv`);
    });

    it('is validators.csv, one row for each validator of the page', () => {
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toBe(csvDisposition('validators'));
      expect(csv.text.split('\n')).toHaveLength(1 + 35);
    });

    it('flattens the rows: a column for each nested key, the master key first', () => {
      const [header, first] = csv.text.split('\n');
      const columns = cells(header);
      expect(columns.slice(0, 3)).toEqual(['validation_public_key', 'domain', 'current_index']);
      expect(columns).toEqual(
        expect.arrayContaining([
          'agreement_24h.score',
          'agreement_30d.incomplete',
          'domain_verification.accounts[0]',
          'unl_lists[0]',
          'unl_lists[1]',
          'fee_vote.base_fee',
          'amendment_votes.yes[0].id',
          'last_seen',
        ]),
      );
      expect(cells(first)[0]).toBe(s.unl[0].key);
      expect(cells(first)[columns.indexOf('fee_vote.base_fee')]).toBe('0.00001');
    });

    it('follows the filters and the page', async () => {
      const res = await api.get(`${LIST}?format=csv&q=northpeak`);
      expect(res.text.split('\n')).toHaveLength(2);
      const paged = await api.get(`${LIST}?format=csv&limit=4`);
      expect(paged.text.split('\n')).toHaveLength(5);
      expect(paged.headers.link).toMatch(/rel="next"/);
    });

    it('sends Cache-Control: private, max-age=30 as the JSON does', () => {
      expect(csv.headers['cache-control']).toBe('private, max-age=30');
    });
  });

  // -- the detail -----------------------------------------------------------------------------------------------------

  describe('the detail of a validator', () => {
    let northpeak: Answer;

    beforeAll(async () => {
      northpeak = await api.get(detailOf(s.unl[0].key));
    });

    const daily = (answer: Answer): Record<string, any>[] => answer.body.daily_agreement;

    it('is the flat object: the row, then the manifest, the days and the result', () => {
      expect(northpeak.status).toBe(200);
      const { daily_agreement: days, ...rest } = northpeak.body;
      expect(rest).toEqual({
        ...rowOf(unlList, s.unl[0].key),
        amendment_votes: {
          ledger_index: VOTING_LEDGER,
          yes: [{ id: FLEET_AMENDMENT }],
          votes: [{ id: FLEET_AMENDMENT, status: 'voting', vote: 'yes' }],
        },
        manifest: { sequence: 2, signing_key: s.rotated.base58, signing_keys_seen: 2, domain: 'northpeak.example' },
        result: 'success',
      });
      expect(days).toHaveLength(30);
    });

    it('lists its keys in the order of the row, then DETAIL_TAIL_KEYS', () => {
      expect(Object.keys(northpeak.body)).toEqual(
        [...VALIDATOR_ROW_KEYS, ...DETAIL_TAIL_KEYS].filter((key) => key !== 'version_build'),
      );
      expect(Object.keys(northpeak.body.amendment_votes)).toEqual([...DETAIL_AMENDMENT_VOTES_KEYS]);
      expect(Object.keys(northpeak.body.amendment_votes.votes[0])).toEqual(
        orderedBy(VOTE_ENTRY_KEYS, northpeak.body.amendment_votes.votes[0]),
      );
      expect(Object.keys(northpeak.body.manifest)).toEqual([...MANIFEST_KEYS]);
      expect(JSON.stringify(northpeak.body)).not.toContain('null');
    });

    it('has 30 days of agreement, the oldest first, the last of them the day of the newest final hour', () => {
      const days = daily(northpeak);
      expect(days).toHaveLength(30);
      const dates = days.map((day) => day.date);
      expect(dates).toEqual([...dates].sort());
      expect(new Set(dates).size).toBe(30);
      expect(dates[29]).toBe(new Date(s.newestHour * 1000).toISOString().slice(0, 10));
      for (const day of days) expect(Object.keys(day)).toEqual(orderedBy(DAILY_KEYS, day));
      // no hour was recorded 29 days ago: nothing was held, nothing to score, and the day is not complete
      expect(days[0]).toEqual({ date: dates[0], missed: 0, total: 0, incomplete: true, partial: 0 });
    });

    it('adds the days up to the window of 30 days, and finishes the newest day with the newest final hour', () => {
      const days = daily(northpeak);
      const sum = (field: 'total' | 'missed' | 'partial'): number => days.reduce((all, day) => all + day[field], 0);
      const thirty = northpeak.body.agreement_30d;
      expect([sum('total'), sum('missed'), sum('partial')]).toEqual([thirty.total, thirty.missed, thirty.partial]);
      const hourOfDay = new Date(s.newestHour * 1000).getUTCHours();
      expect(days[29]).toMatchObject({ total: (hourOfDay + 1) * 900, incomplete: hourOfDay !== 23 });
    });

    it('has the vote of every amendment being decided: the one of the fleet, yes', () => {
      expect(northpeak.body.amendment_votes.votes).toEqual([{ id: FLEET_AMENDMENT, status: 'voting', vote: 'yes' }]);
    });

    it('answers a signing key with the validator it belongs to, which it names as validation_public_key', async () => {
      const current = await api.get(detailOf(s.rotated.base58));
      expect(current.status).toBe(200);
      expect(current.body).toEqual(northpeak.body);
      // a signing key it left is still its signing key
      const older = await api.get(detailOf(s.unl[0].ephemeral));
      expect(older.body.validation_public_key).toBe(s.unl[0].key);
      const other = await api.get(detailOf(s.unl[2].ephemeral));
      expect(other.body.validation_public_key).toBe(s.unl[2].key);
      // a validator whose master key was seen only under its signing key
      expect((await api.get(detailOf(s.unl[34].ephemeral))).body.validation_public_key).toBe(s.unl[34].key);
    });

    it('answers 66 hex digits as the key they are, in either case, a master or a signing key', async () => {
      const hex = s.unl[0].master.publicKeyHex;
      expect(hex).toMatch(/^ED[0-9A-F]{64}$/);
      for (const spelled of [hex, hex.toLowerCase()]) {
        const res = await api.get(detailOf(spelled));
        expect([res.status, res.body]).toEqual([200, northpeak.body]);
      }
      const signing = await api.get(detailOf(s.unl[2].signing.publicKeyHex.toLowerCase()));
      expect(signing.body.validation_public_key).toBe(s.unl[2].key);
    });

    it('answers a validator seen 40 days ago, which no list has', async () => {
      const res = await api.get(detailOf(s.dormant.key));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        validation_public_key: s.dormant.key,
        unl: false,
        unl_lists: [],
        first_seen: instant(s.now - 80 * DAY),
        last_seen: instant(s.now - 40 * DAY),
        manifest: { sequence: 1, signing_key: s.dormant.ephemeral, signing_keys_seen: 1 },
        amendment_votes: { yes: [], votes: [{ id: FLEET_AMENDMENT, status: 'voting', vote: 'none' }] },
        result: 'success',
      });
      expect(res.body.amendment_votes).not.toHaveProperty('ledger_index');
      expect(res.body.daily_agreement).toHaveLength(30);
      // it is not listed
      expect(keys(allList)).not.toContain(s.dormant.key);
    });

    it('answers a validator seen 3 days ago with the version of its last vote, and no record: none, no ledger_index', async () => {
      const res = await api.get(detailOf(s.lapsed[0].key));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        version: '3.4.0',
        version_latest: false,
        server_version: serverVersion(3, 4, 0),
      });
      expect(res.body).not.toHaveProperty('fee_vote');
      expect(res.body.amendment_votes).toEqual({
        yes: [],
        votes: [{ id: FLEET_AMENDMENT, status: 'voting', vote: 'none' }],
      });
      expect(Object.keys(res.body.amendment_votes)).toEqual(['yes', 'votes']);
    });

    it('answers the member of the UNL that was never seen, with its manifest and no first_seen', async () => {
      const res = await api.get(detailOf(s.unl[33].key));
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('first_seen');
      expect(res.body).not.toHaveProperty('last_seen');
      expect(res.body.unl).toBe(true);
      expect(res.body.manifest).toEqual({ sequence: 1, signing_key: s.unl[33].ephemeral, signing_keys_seen: 1 });
    });

    it('answers a key of the right form that nobody knows with 404 Validator not found', async () => {
      const unknown = fleet('xrpl', 60)[59];
      for (const key of [unknown.key, unknown.ephemeral, unknown.master.publicKeyHex]) {
        const res = await api.get(detailOf(key));
        expect([res.status, res.body]).toEqual([404, { result: 'error', message: 'Validator not found' }]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('answers a key that is none with 400 invalid validator public key', async () => {
      const bad = [
        'nothing',
        'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        s.unl[0].master.publicKeyHex.slice(2),
        `04${s.unl[0].master.publicKeyHex.slice(2)}`,
        `${s.unl[0].master.publicKeyHex}00`,
        s.unl[0].key.slice(0, -2),
      ];
      for (const key of bad) {
        const res = await api.get(detailOf(key));
        expect([key, res.status, res.body]).toEqual([
          key,
          400,
          { result: 'error', message: 'invalid validator public key' },
        ]);
      }
    });

    it('is JSON only: format=csv is ignored', async () => {
      const res = await api.get(`${detailOf(s.unl[0].key)}?format=csv&limit=1&marker=x`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual(northpeak.body);
    });

    it('sends Cache-Control: private, max-age=30', () => {
      expect(northpeak.headers['cache-control']).toBe('private, max-age=30');
    });

    it('does not take summary for a key: the summary is still the summary', async () => {
      const res = await api.get(`${LIST}/summary`);
      expect(res.status).toBe(200);
      expect(res.body.validators).toEqual({ seen_24h: 54, unl_seen_24h: 34, others_seen_24h: 20, all: 55 });
    });
  });

  describe('the shared directory and the reads', () => {
    it('is not changed by any of the answers: the same directory, entry for entry', () => {
      expect(sameDirectory).toBe(true);
      expect(directoryAfter).toBe(directoryBefore);
    });

    it('serves the list and the detail from the directory and the amendments it has: no read at all within 10 s', async () => {
      // a build right before the measure, so that the 10 s of the directory and of the assembly are not over
      expect((await api.get(LIST)).status).toBe(200);
      const reads = await readsOf(h, Table.ValidatorSeen, async () => {
        expect((await api.get(`${LIST}?scope=all&limit=5`)).status).toBe(200);
        expect((await api.get(detailOf(s.unl[0].key))).status).toBe(200);
      });
      expect(reads).toHaveLength(0);
    });
  });
});

// ===================================================================================================================
// the amendments a validator votes on
// ===================================================================================================================

describe('GET /v2/network/validators and /{key}: the votes on the amendments of a board (XRPL)', () => {
  let h: Harness;
  let api: ApiClient;
  let b: BoardScenario;

  const keys = (answer: Answer): string[] =>
    answer.body.validators.map((row: { validation_public_key: string }) => row.validation_public_key);
  /** unl[0] and unl[1] have a domain: first, then the others by key. */
  const unlOrder = (indexes: number[]): string[] => {
    const withDomain = indexes.filter((i) => i < 2).map((i) => b.unl[i].key);
    return [
      ...withDomain,
      ...indexes
        .filter((i) => i >= 2)
        .map((i) => b.unl[i].key)
        .sort(),
    ];
  };

  beforeAll(async () => {
    h = (
      await startWithDirectory({
        seed: 'none',
        network: 'xrpl',
        env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: FIXTURE },
      })
    ).h;
    api = await h.api();
    b = await seedAmendmentBoard(h.ch);
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('the list', () => {
    it('filters by the name of an amendment: the validators whose record votes for it', async () => {
      const res = await api.get(`${LIST}?amendment=${BOARD_NAMES.voting}`);
      expect(res.status).toBe(200);
      // TestVoting has four yes votes: unl[0..3]
      expect(keys(res)).toEqual(unlOrder([0, 1, 2, 3]));
      for (const row of res.body.validators) {
        expect(row.amendment_votes.yes).toContainEqual({ id: BOARD_IDS.voting, name: BOARD_NAMES.voting });
      }
    });

    it('filters by the name in any case when only one amendment has it, and by the ID in either case', async () => {
      const expected = unlOrder([0, 1, 2, 3]);
      expect(keys(await api.get(`${LIST}?amendment=${BOARD_NAMES.voting.toLowerCase()}`))).toEqual(expected);
      expect(keys(await api.get(`${LIST}?amendment=${BOARD_IDS.voting}`))).toEqual(expected);
      expect(keys(await api.get(`${LIST}?amendment=${BOARD_IDS.voting.toLowerCase()}`))).toEqual(expected);
    });

    it('counts the validators of the UNL that vote for an amendment, and those off the UNL with scope=all', async () => {
      // 31 yes in the newest round; others[0] votes for it too, and others[3] (seen 3 days ago) does as well
      expect((await api.get(`${LIST}?amendment=${BOARD_NAMES.majority}`)).body.count).toBe(31);
      const all = await api.get(`${LIST}?amendment=${BOARD_NAMES.majority}&scope=all`);
      expect(all.body.count).toBe(32);
      expect(keys(all)).toContain(b.others[0].key);
      expect(keys(all)).not.toContain(b.others[3].key);
    });

    it('lists a validator off the UNL for an amendment only it votes for, and none on the UNL', async () => {
      expect((await api.get(`${LIST}?amendment=${BOARD_IDS.votedByOther}`)).body.count).toBe(0);
      const all = await api.get(`${LIST}?amendment=${BOARD_IDS.votedByOther}&scope=all`);
      expect(keys(all)).toEqual([b.others[0].key]);
    });

    it('names the amendments of a yes list from the metadata and from the node, not those with no name', async () => {
      const res = await api.get(`${LIST}?q=northpeak`);
      expect(res.body.validators[0].amendment_votes).toEqual({
        ledger_index: VOTING_LEDGER,
        yes: [
          { id: BOARD_IDS.majority, name: 'TestMajority' },
          { id: BOARD_IDS.voting, name: 'TestVoting' },
          { id: BOARD_IDS.enabledLedger, name: 'TestEnabledLedger' },
          { id: BOARD_IDS.majorityNameless },
          { id: BOARD_IDS.nodeOnly, name: 'NodeNamedOnly' },
          { id: BOARD_IDS.unsupportedVoted, name: 'StillVoted' },
        ],
      });
    });

    it('answers 400 invalid amendment for a name that is none', async () => {
      const res = await api.get(`${LIST}?amendment=TestNothing`);
      expect([res.status, res.body]).toEqual([400, { result: 'error', message: 'invalid amendment' }]);
    });

    it('searches the domains of the board', async () => {
      expect(keys(await api.get(`${LIST}?q=shoreline`))).toEqual([b.unl[1].key]);
      expect(keys(await api.get(`${LIST}?q=tidewater&scope=all`))).toEqual([b.others[0].key]);
    });
  });

  describe('the detail', () => {
    let first: Answer;
    let none: Answer;
    let nothing: Answer;

    beforeAll(async () => {
      first = await api.get(detailOf(b.unl[0].key));
      // unl[35] is on the UNL and never voted; others[1] voted for nothing
      none = await api.get(detailOf(b.unl[35].key));
      nothing = await api.get(detailOf(b.others[1].key));
    });

    it('has a vote for every amendment being decided, in the order of the amendments, unknown ones included', () => {
      expect(first.body.amendment_votes.votes).toEqual([
        { id: BOARD_IDS.majorityNameless, status: 'majority', vote: 'yes' },
        { id: BOARD_IDS.majority, name: BOARD_NAMES.majority, status: 'majority', vote: 'yes' },
        { id: BOARD_IDS.voting, name: BOARD_NAMES.voting, status: 'voting', vote: 'yes' },
        { id: BOARD_IDS.unsupportedVoted, name: 'StillVoted', status: 'voting', vote: 'yes' },
        { id: BOARD_IDS.nodeOnly, name: 'NodeNamedOnly', status: 'voting', vote: 'yes' },
        { id: BOARD_IDS.idle, name: BOARD_NAMES.idle, status: 'voting', vote: 'no' },
        { id: BOARD_IDS.votedByOther, status: 'voting', vote: 'no' },
        { id: BOARD_IDS.unknown, status: 'unknown', vote: 'no' },
      ]);
    });

    it('holds an unknown amendment without a name (G4), and leaves out the enabled and the obsolete ones', () => {
      const unknown = first.body.amendment_votes.votes.find((vote: { id: string }) => vote.id === BOARD_IDS.unknown);
      expect(unknown).toEqual({ id: BOARD_IDS.unknown, status: 'unknown', vote: 'no' });
      expect(unknown).not.toHaveProperty('name');
      const ids = first.body.amendment_votes.votes.map((vote: { id: string }) => vote.id);
      for (const left of [
        BOARD_IDS.enabledLedger,
        BOARD_IDS.enabledFile,
        BOARD_IDS.enabledBare,
        BOARD_IDS.obsolete,
        BOARD_IDS.obsoleteNode,
      ]) {
        expect(ids).not.toContain(left);
      }
      // what it voted for stays in its yes list, enabled or not
      expect(first.body.amendment_votes.yes.map((entry: { id: string }) => entry.id)).toContain(
        BOARD_IDS.enabledLedger,
      );
    });

    it('lists the keys of the votes, of every vote and of the amendment_votes in order', () => {
      expect(Object.keys(first.body.amendment_votes)).toEqual([...DETAIL_AMENDMENT_VOTES_KEYS]);
      for (const vote of first.body.amendment_votes.votes) {
        expect(Object.keys(vote)).toEqual(orderedBy(VOTE_ENTRY_KEYS, vote));
      }
    });

    it('says none for every amendment, with an empty yes and no ledger_index, for a validator that never voted', () => {
      expect(none.status).toBe(200);
      expect(none.body.amendment_votes).toEqual({
        yes: [],
        votes: [
          { id: BOARD_IDS.majorityNameless, status: 'majority', vote: 'none' },
          { id: BOARD_IDS.majority, name: BOARD_NAMES.majority, status: 'majority', vote: 'none' },
          { id: BOARD_IDS.voting, name: BOARD_NAMES.voting, status: 'voting', vote: 'none' },
          { id: BOARD_IDS.unsupportedVoted, name: 'StillVoted', status: 'voting', vote: 'none' },
          { id: BOARD_IDS.nodeOnly, name: 'NodeNamedOnly', status: 'voting', vote: 'none' },
          { id: BOARD_IDS.idle, name: BOARD_NAMES.idle, status: 'voting', vote: 'none' },
          { id: BOARD_IDS.votedByOther, status: 'voting', vote: 'none' },
          { id: BOARD_IDS.unknown, status: 'unknown', vote: 'none' },
        ],
      });
      expect(Object.keys(none.body.amendment_votes)).toEqual(['yes', 'votes']);
      expect(none.body).not.toHaveProperty('fee_vote');
    });

    it('says no, not none, for a validator whose record votes for nothing', () => {
      expect(nothing.body.amendment_votes.ledger_index).toBe(VOTING_LEDGER);
      expect(nothing.body.amendment_votes.yes).toEqual([]);
      expect(nothing.body.amendment_votes.votes.map((vote: { vote: string }) => vote.vote)).toEqual(
        Array(8).fill('no'),
      );
    });

    it('answers a validator whose votes were recorded under its signing key', async () => {
      const res = await api.get(detailOf(b.unl[5].ephemeral));
      expect(res.body.validation_public_key).toBe(b.unl[5].key);
      // unl[5] votes for the amendments with more than 5 yes votes: of the ones being decided, the two majorities
      expect(
        res.body.amendment_votes.votes
          .filter((vote: { vote: string }) => vote.vote === 'yes')
          .map((vote: { id: string }) => vote.id),
      ).toEqual([BOARD_IDS.majorityNameless, BOARD_IDS.majority]);
    });
  });
});

// ===================================================================================================================
// Xahau
// ===================================================================================================================

describe('GET /v2/network/validators and /{key}: on Xahau', () => {
  let h: Harness;
  let api: ApiClient;
  let members: ReturnType<typeof fleet>;
  let list: Answer;
  const XA = 'AA'.repeat(32);

  beforeAll(async () => {
    h = (
      await startWithDirectory({
        seed: 'none',
        network: 'xahau',
        env: { ...NO_RATE_LIMIT, GH_AMENDMENTS_CONFIG: NO_AMENDMENTS.xahau },
      })
    ).h;
    api = await h.api();
    members = fleet('xahau', 5);
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
    // the fifth has no manifest
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
        accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
      },
    ]);
    await insertSeen(
      h.ch,
      members.map((m) => ({ key: m.key, first: now - 86_400, last: now - 30 })),
    );
    // 3.10.13 builds 4119 and 4120 are 2026.10.13, 3.9.2 is 2026.9.2, 3.10.14-rc1 is a candidate of a newer version
    await insertRound(h.ch, {
      ledgerIndex: 26_633_471,
      closeTime: now - 600,
      unl: members.map((m) => m.key),
      votes: [
        { key: members[0].key, amendments: [XA], serverVersion: serverVersion(3, 10, 13, 0, 4119), base_fee: 20 },
        { key: members[1].key, serverVersion: serverVersion(3, 10, 13, 0, 4120) },
        { key: members[2].key, serverVersion: serverVersion(3, 9, 2, 0, 1) },
        { key: members[3].key, serverVersion: serverVersion(3, 10, 14, RC1, 7) },
      ],
    });
    list = await api.get(LIST);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists the UNL of Xahau: the validators with a domain first, then by key', () => {
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(5);
    expect(list.body.validators.map((row: { validation_public_key: string }) => row.validation_public_key)).toEqual([
      members[0].key,
      members[1].key,
      ...[2, 3, 4].map((i) => members[i].key).sort(),
    ]);
  });

  it('has the build of a validator after its version, and the year of the version counted from 2023', () => {
    const north = list.body.validators[0];
    expect(north).toMatchObject({ version: '2026.10.13', version_build: 4119, version_latest: true });
    const keysOfNorth = Object.keys(north);
    expect(keysOfNorth.indexOf('version_build')).toBe(keysOfNorth.indexOf('version') + 1);
    expect(keysOfNorth).toEqual(orderedBy(VALIDATOR_ROW_KEYS, north));
    expect(list.body.validators[1]).toMatchObject({ version: '2026.10.13', version_build: 4120 });
    const byKey = (key: string) =>
      list.body.validators.find((row: { validation_public_key: string }) => row.validation_public_key === key);
    expect(byKey(members[2].key)).toMatchObject({ version: '2026.9.2', version_build: 1, version_latest: false });
    expect(byKey(members[3].key)).toMatchObject({ version: '2026.10.14-rc1', version_build: 7, version_latest: true });
    expect(byKey(members[4].key)).not.toHaveProperty('version');
    expect(byKey(members[4].key)).not.toHaveProperty('version_build');
  });

  it('checks the TOML of Xahau at /.well-known/xahau.toml: pending before a check, verified with its accounts after', () => {
    expect(list.body.validators[0].domain_verification).toEqual({
      status: 'pending',
      toml_url: 'https://north.example/.well-known/xahau.toml',
    });
    expect(list.body.validators[1].domain_verification).toMatchObject({
      status: 'verified',
      toml_url: 'https://south.example/.well-known/xahau.toml',
      accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    });
  });

  it('says the fee a validator voted for in whole units, and the fees in force for what it left out', () => {
    expect(list.body.validators[0].fee_vote).toEqual({
      ledger_index: 26_633_471,
      base_fee: '0.00002',
      reserve_base: '1',
      reserve_inc: '0.2',
    });
  });

  it('has the detail of a validator with its build, its pending verification and the votes of Xahau', async () => {
    const res = await api.get(detailOf(members[0].ephemeral));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      validation_public_key: members[0].key,
      domain: 'north.example',
      signing_key: members[0].ephemeral,
      version: '2026.10.13',
      version_build: 4119,
      amendment_votes: {
        ledger_index: 26_633_471,
        yes: [{ id: XA }],
        votes: [{ id: XA, status: 'voting', vote: 'yes' }],
      },
      manifest: { sequence: 1, signing_key: members[0].ephemeral, signing_keys_seen: 1, domain: 'north.example' },
      result: 'success',
    });
    // no validation of the last 300 ledgers is stored here: no current_index and no partial
    expect(Object.keys(res.body)).toEqual(orderedBy([...VALIDATOR_ROW_KEYS, ...DETAIL_TAIL_KEYS], res.body));
    expect(res.body).not.toHaveProperty('current_index');
  });

  it('has the detail of a validator with no manifest: no signing_key and no manifest', async () => {
    const res = await api.get(detailOf(members[4].key));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('signing_key');
    expect(res.body).not.toHaveProperty('manifest');
    expect(res.body).not.toHaveProperty('domain');
    expect(res.body.unl).toBe(true);
    // no hour of agreement is final yet
    expect(res.body.daily_agreement).toEqual([]);
    expect(Object.keys(res.body).slice(-2)).toEqual(['daily_agreement', 'result']);
  });

  it('answers a hex key on Xahau too', async () => {
    const res = await api.get(detailOf(members[1].master.publicKeyHex.toLowerCase()));
    expect(res.body.validation_public_key).toBe(members[1].key);
  });
});

// ===================================================================================================================
// failures and the transport
// ===================================================================================================================

describe('GET /v2/network/validators and /{key}: when ClickHouse fails', () => {
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
    const key = fleet('xrpl', 1)[0].key;
    const spy = jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('Code: 241. Memory limit exceeded'));
    for (const path of [LIST, `${LIST}?format=csv`, detailOf(key)]) {
      const failed = await api.get(path);
      expect([path, failed.status, failed.body]).toEqual([
        path,
        500,
        { result: 'error', message: 'unable to retrieve validator(s)' },
      ]);
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(failed.body)).not.toContain('Memory limit');
    }
    // a key that is none is refused before anything is read
    const refused = await api.get(detailOf('nothing'));
    expect([refused.status, refused.body]).toEqual([400, { result: 'error', message: 'invalid validator public key' }]);

    spy.mockRestore();
    const recovered = await api.get(LIST);
    expect(recovered.status).toBe(200);
    expect(recovered.headers['cache-control']).toBe('private, max-age=30');
    // nobody is known: an empty list, and 404 for a key
    expect(recovered.body).toEqual({ result: 'success', count: 0, validators: [] });
    expect((await api.get(detailOf(key))).status).toBe(404);
  });

  it('requires the API key', async () => {
    for (const path of [LIST, detailOf(fleet('xrpl', 1)[0].key)]) {
      const res = await h.http().get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ result: 'error', message: 'Missing or invalid API key.' });
    }
  });
});

describe('GET /v2/network/validators and /{key}: with GH_CACHE_CONTROL empty', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: { ...NO_RATE_LIMIT, GH_CACHE_CONTROL: '' } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('sends no Cache-Control on a success and no-store on an error', async () => {
    const api = await h.api();
    const list = await api.get(LIST);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBeUndefined();
    const missing = await api.get(detailOf(fleet('xrpl', 1)[0].key));
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
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
  let directoryOf: () => Promise<Directory>;

  /** The most rows a read of a window of `window` rows may read: the window and a granule of every part. */
  const bound = (window: number): number => window + PARTS * GRANULE;

  beforeAll(async () => {
    const started = await startWithDirectory({ seed: 'none', env: NO_RATE_LIMIT });
    h = started.h;
    directoryOf = started.directory;
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

  it('has the 30-day window complete with the 720 hours seeded: the read starts at the first hour of the window (P6)', async () => {
    const directory = await directoryOf();
    expect(directory.newestFinalHour).toBe(scenario.newestHour);
    for (const m of [scenario.unl[0], scenario.unl[34], scenario.others[19]]) {
      // every validator is tracked in every hour with 900 ledgers (agreed and missed); unl[34]'s older hours are stored under its signing key
      expect(directory.entries.get(m.key)?.agreement30d).toMatchObject({
        total: 720 * 900,
        incomplete: false,
      });
    }
    // 29 whole days before the day of the newest hour are complete, that day itself is not (the newest hour is not its last)
    const daily = directory.entries.get(scenario.unl[0].key)?.daily ?? [];
    expect(daily.slice(0, 29).filter((day) => day.incomplete)).toEqual([]);
  });

  it('reads the votes of the rounds of the last 30 days, not the table', () => {
    // 4 rounds of 54 votes and an old round of 2
    expect(reads.votes.length).toBeGreaterThan(0);
    for (const read of reads.votes) expect(read.read_rows).toBeLessThanOrEqual(bound(4 * 54 + 2));
  });
});

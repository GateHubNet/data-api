import {
  getNetworkProfile,
  KEY_MAP_WITH,
  MANIFEST_MAP_SQL,
  mappedKey,
  NetworkProfile,
  Table,
  UnlListsRow,
  ValidatorDomainsRow,
  ValidatorManifestsRow,
} from '@gatehub/data-api-shared';
import { encodeAccountID } from 'ripple-address-codec';
import { makeManifest, TestKey, testKey } from '../../../../packages/shared/src/test-utils/validator-keys';
import {
  DomainChecker,
  DomainReason,
  isTransientReason,
  MANIFEST_LOOKUP_INTERVAL_MS,
  nextDomainRow,
} from './domain-checker';
import { SafeFetchError, tomlFetchLimits } from './safe-fetch';

// Every TOML text below is hand-written test data, not a recorded file.

const NOW_MS = Date.parse('2026-10-19T12:00:00.000Z');
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86_400;
const RECHECK_MS = 6 * 3_600_000;

const KEY = 'nHUBvDGzZWNgxzsEQzMy3JR7sDDz5wPiuDnj4hZdZpDeM2yeu6gy';
const TOML_URL = 'https://a.example/.well-known/xrp-ledger.toml';
const ACCOUNT_1 = encodeAccountID(Buffer.alloc(20, 1));
const ACCOUNT_2 = encodeAccountID(Buffer.alloc(20, 2));

describe('isTransientReason', () => {
  it.each<[DomainReason, number | undefined, boolean]>([
    ['dns_error', undefined, true],
    ['connect_error', undefined, true],
    ['tls_error', undefined, true],
    ['timeout', undefined, true],
    ['http_status', 500, true],
    ['http_status', 503, true],
    ['http_status', 599, true],
    ['http_status', 429, true],
    ['http_status', 404, false],
    ['http_status', 403, false],
    ['http_status', 400, false],
    ['http_status', 499, false],
    ['http_status', 204, false],
    ['http_status', 301, false],
    ['http_status', undefined, false],
    ['not_listed', undefined, false],
    ['toml_invalid', undefined, false],
    ['too_large', undefined, false],
    ['redirect_rejected', undefined, false],
    ['blocked_address', undefined, false],
    ['domain_invalid', undefined, false],
    ['manifest_unverified', undefined, false],
    ['', undefined, false],
  ])('%s (status %s) is transient: %s', (reason, statusCode, transient) => {
    expect(isTransientReason(reason, statusCode)).toBe(transient);
  });
});

describe('nextDomainRow', () => {
  const check = (o: Partial<Parameters<typeof nextDomainRow>[1]> = {}): Parameters<typeof nextDomainRow>[1] => ({
    key: KEY,
    domain: 'a.example',
    tomlUrl: TOML_URL,
    reason: '',
    ...o,
  });
  const previous = (o: Partial<ValidatorDomainsRow> = {}): ValidatorDomainsRow => ({
    validation_public_key: KEY,
    domain: 'a.example',
    status: 'verified',
    reason: '',
    status_code: 0,
    toml_url: TOML_URL,
    checked_at: NOW - 6 * HOUR,
    verified_at: NOW - 6 * HOUR,
    next_check_at: NOW - 1,
    accounts: [ACCOUNT_1],
    ...o,
  });

  it('is verified, with the accounts, when the check succeeded, and is checked again after the recheck interval', () => {
    expect(nextDomainRow(undefined, check({ accounts: [ACCOUNT_1, ACCOUNT_2] }), NOW, RECHECK_MS)).toEqual({
      validation_public_key: KEY,
      domain: 'a.example',
      status: 'verified',
      reason: '',
      status_code: 0,
      toml_url: TOML_URL,
      checked_at: NOW,
      verified_at: NOW,
      next_check_at: NOW + 6 * HOUR,
      accounts: [ACCOUNT_1, ACCOUNT_2],
    });
  });

  it('is verified with no accounts when the file lists none', () => {
    expect(nextDomainRow(undefined, check(), NOW, RECHECK_MS)).toMatchObject({ status: 'verified', accounts: [] });
  });

  it('replaces the accounts and the verification time of an earlier success', () => {
    const row = nextDomainRow(previous(), check({ accounts: [ACCOUNT_2] }), NOW, RECHECK_MS);
    expect(row).toMatchObject({ status: 'verified', verified_at: NOW, accounts: [ACCOUNT_2] });
  });

  it('uses the recheck interval it is given and a whole second for the next check', () => {
    expect(nextDomainRow(undefined, check(), NOW, 90_000).next_check_at).toBe(NOW + 90);
    expect(nextDomainRow(undefined, check(), NOW + 0.25, 1_000).next_check_at).toBe(NOW + 2);
  });

  it.each<DomainReason>([
    'not_listed',
    'toml_invalid',
    'too_large',
    'redirect_rejected',
    'blocked_address',
    'domain_invalid',
    'manifest_unverified',
  ])(
    'is unverified with the reason %s, without accounts, and is checked again after the recheck interval',
    (reason) => {
      expect(nextDomainRow(undefined, check({ reason }), NOW, RECHECK_MS)).toEqual({
        validation_public_key: KEY,
        domain: 'a.example',
        status: 'unverified',
        reason,
        status_code: 0,
        toml_url: TOML_URL,
        checked_at: NOW,
        verified_at: null,
        next_check_at: NOW + 6 * HOUR,
        accounts: [],
      });
    },
  );

  it('is unverified with the status code of a 4xx answer other than 429, and is checked again after the recheck interval', () => {
    expect(nextDomainRow(undefined, check({ reason: 'http_status', statusCode: 404 }), NOW, RECHECK_MS)).toMatchObject({
      status: 'unverified',
      reason: 'http_status',
      status_code: 404,
      next_check_at: NOW + 6 * HOUR,
      accounts: [],
    });
  });

  it('keeps the time of the last success and drops the accounts at a definite failure, even right after a success', () => {
    const row = nextDomainRow(previous({ verified_at: NOW - 600 }), check({ reason: 'not_listed' }), NOW, RECHECK_MS);
    expect(row).toMatchObject({ status: 'unverified', reason: 'not_listed', verified_at: NOW - 600, accounts: [] });
  });

  it('keeps verified through a transient failure within 24 h', () => {
    const prev = previous({ verified_at: NOW - 23 * HOUR, accounts: [ACCOUNT_1, ACCOUNT_2] });
    for (const failure of [
      check({ reason: 'timeout' }),
      check({ reason: 'dns_error' }),
      check({ reason: 'connect_error' }),
      check({ reason: 'tls_error' }),
      check({ reason: 'http_status', statusCode: 503 }),
      check({ reason: 'http_status', statusCode: 429 }),
    ]) {
      expect(nextDomainRow(prev, failure, NOW, RECHECK_MS)).toEqual({
        validation_public_key: KEY,
        domain: 'a.example',
        status: 'verified',
        reason: '',
        status_code: 0,
        toml_url: TOML_URL,
        checked_at: NOW,
        verified_at: NOW - 23 * HOUR,
        next_check_at: NOW + HOUR,
        accounts: [ACCOUNT_1, ACCOUNT_2],
      });
    }
  });

  it('keeps verified up to the last second of the 24 h and no longer', () => {
    const failure = check({ reason: 'timeout' });
    expect(nextDomainRow(previous({ verified_at: NOW - DAY + 1 }), failure, NOW, RECHECK_MS).status).toBe('verified');
    expect(nextDomainRow(previous({ verified_at: NOW - DAY - 1 }), failure, NOW, RECHECK_MS).status).toBe('unverified');
  });

  it('is unverified with the transient reason, and no accounts, after 24 h of failures', () => {
    const prev = previous({ verified_at: NOW - 25 * HOUR, accounts: [ACCOUNT_1] });
    expect(nextDomainRow(prev, check({ reason: 'timeout' }), NOW, RECHECK_MS)).toEqual({
      validation_public_key: KEY,
      domain: 'a.example',
      status: 'unverified',
      reason: 'timeout',
      status_code: 0,
      toml_url: TOML_URL,
      checked_at: NOW,
      verified_at: NOW - 25 * HOUR,
      next_check_at: NOW + HOUR,
      accounts: [],
    });
  });

  it('is unverified with the status code when a 5xx answer goes on for more than 24 h', () => {
    const prev = previous({ verified_at: NOW - 30 * HOUR });
    expect(nextDomainRow(prev, check({ reason: 'http_status', statusCode: 502 }), NOW, RECHECK_MS)).toMatchObject({
      status: 'unverified',
      reason: 'http_status',
      status_code: 502,
      next_check_at: NOW + HOUR,
      accounts: [],
    });
  });

  it('is unverified at a transient failure when there was no success, or the last row was unverified', () => {
    expect(nextDomainRow(undefined, check({ reason: 'timeout' }), NOW, RECHECK_MS)).toMatchObject({
      status: 'unverified',
      reason: 'timeout',
      verified_at: null,
      next_check_at: NOW + HOUR,
      accounts: [],
    });
    const failed = previous({ status: 'unverified', reason: 'timeout', verified_at: NOW - HOUR, accounts: [] });
    expect(nextDomainRow(failed, check({ reason: 'timeout' }), NOW, RECHECK_MS)).toMatchObject({
      status: 'unverified',
      reason: 'timeout',
      verified_at: NOW - HOUR,
      accounts: [],
    });
  });

  it('does not keep verified through a definite failure inside the 24 h', () => {
    const prev = previous({ verified_at: NOW - HOUR });
    for (const failure of [
      check({ reason: 'http_status', statusCode: 404 }),
      check({ reason: 'toml_invalid' }),
      check({ reason: 'blocked_address' }),
    ]) {
      expect(nextDomainRow(prev, failure, NOW, RECHECK_MS)).toMatchObject({ status: 'unverified', accounts: [] });
    }
  });

  it('records the URL it fetched, or would have, and does not change the row it was given', () => {
    const prev = previous();
    const frozen = JSON.stringify(prev);
    const row = nextDomainRow(prev, check({ tomlUrl: 'https://a.example/x.toml', reason: 'timeout' }), NOW, RECHECK_MS);
    expect(row.toml_url).toBe('https://a.example/x.toml');
    expect(JSON.stringify(prev)).toBe(frozen);
    expect(row.accounts).not.toBe(prev.accounts);
  });
});

// -- the checker --------------------------------------------------------------------------------------------------

const PUBLISHER_KEY = testKey('dc-publisher');
const OTHER_PUBLISHER_KEY = testKey('dc-other-publisher');
const ID = 'unl.example';
const ID_2 = 'vl.example';
const PUBLISHER_KEY_2 = testKey('dc-publisher-2');
const PUBLISHERS = `https://${ID}=${PUBLISHER_KEY.publicKeyHex},https://${ID_2}=${PUBLISHER_KEY_2.publicKeyHex}`;

interface Val {
  master: TestKey;
  signing: TestKey;
}
const validator = (n: number): Val => ({
  master: testKey(`dc-validator-${n}`),
  signing: testKey(`dc-validator-${n}-signing`),
});

/** A `validator_manifests` row the way the collector or a list writes it, from a manifest that verifies. */
function manifestRow(v: Val, o: { seq?: number; domain?: string; hex?: string; source?: 'stream' | 'unl' } = {}) {
  const seq = o.seq ?? 1;
  return {
    ephemeral_key: v.signing.base58,
    master_key: v.master.base58,
    seq,
    domain: o.domain ?? '',
    manifest: o.hex ?? makeManifest({ master: v.master, signing: v.signing, sequence: seq, domain: o.domain }),
    source: o.source ?? ('unl' as const),
  } satisfies ValidatorManifestsRow;
}

function listRow(o: Partial<UnlListsRow> & { sequence: number }): UnlListsRow {
  return {
    publisher: ID,
    publisher_key: PUBLISHER_KEY.publicKeyHex,
    version: 1,
    effective: null,
    expiration: NOW + 30 * DAY,
    validators: [],
    blob_sha256: 'AB'.repeat(32),
    fetched_at: NOW - HOUR,
    response: '{}',
    ...o,
  };
}

/**
 * A ClickHouse that keeps what is inserted and answers the reads of the checker (the stored lists, the validators seen,
 * the newest manifests, the stored domain rows) from it, in the shape of the real queries' columns.
 */
class FakeClickHouse {
  lists: UnlListsRow[] = [];
  seen: { key: string; lastSeen: number }[] = [];
  manifests: ValidatorManifestsRow[] = [];
  domains: ValidatorDomainsRow[] = [];
  readonly inserts: { table: string; rows: unknown[] }[] = [];
  failInserts?: Error;

  readonly query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    if (sql.includes(Table.UnlLists)) {
      const wanted = params.publishers as string[];
      const newest = new Map<string, UnlListsRow>();
      for (const l of this.lists.filter((row) => wanted.includes(row.publisher))) {
        const id = `${l.publisher}\u0000${l.sequence}`;
        const held = newest.get(id);
        if (held === undefined || l.fetched_at >= held.fetched_at) newest.set(id, l);
      }
      return [...newest.values()].map((l) => ({
        publisher: l.publisher,
        publisher_key: l.publisher_key,
        sequence: Number(l.sequence),
        version: l.version,
        effective: l.effective,
        expiration: l.expiration,
        validators: l.validators,
        fetched_ms: Math.round(l.fetched_at * 1000),
      }));
    }
    if (sql.includes(Table.ValidatorSeen)) {
      // each key is mapped through the manifest map the statement computes (`WITH key_map`: the master of the highest seq per
      // ephemeral key, rows without a master left out) and the masters are grouped
      if (!sql.includes(`WITH ${KEY_MAP_WITH}`))
        throw new Error('the read of the validators seen does not map its keys');
      const top = new Map<string, ValidatorManifestsRow>();
      for (const m of this.manifests.filter((row) => row.master_key !== '')) {
        const held = top.get(m.ephemeral_key);
        if (held === undefined || m.seq > held.seq) top.set(m.ephemeral_key, m);
      }
      const mapped = this.seen
        .filter((s) => s.lastSeen >= (params.since as number))
        .map((s) => top.get(s.key)?.master_key ?? s.key);
      return [...new Set(mapped)].sort().map((master) => ({ master }));
    }
    if (sql.includes(Table.ValidatorManifests)) {
      const wanted = params.keys as string[];
      const top = new Map<string, ValidatorManifestsRow>();
      for (const m of this.manifests.filter((row) => wanted.includes(row.master_key))) {
        const held = top.get(m.master_key);
        // the highest seq; among equals the one with raw bytes
        if (
          held === undefined ||
          m.seq > held.seq ||
          (m.seq === held.seq && held.manifest === '' && m.manifest !== '')
        ) {
          top.set(m.master_key, m);
        }
      }
      return [...top.values()].map((m) => ({
        master_key: m.master_key,
        top_domain: m.domain,
        top_manifest: m.manifest,
      }));
    }
    if (sql.includes(Table.ValidatorDomains)) {
      const wanted = params.keys as string[];
      const newest = new Map<string, ValidatorDomainsRow>();
      for (const d of this.domains.filter((row) => wanted.includes(row.validation_public_key))) {
        const id = `${d.validation_public_key}\u0000${d.domain}`;
        const held = newest.get(id);
        if (held === undefined || d.checked_at >= held.checked_at) newest.set(id, d);
      }
      return [...newest.values()].map((d) => ({
        validation_public_key: d.validation_public_key,
        domain: d.domain,
        status: d.status,
        reason: d.reason,
        status_code: d.status_code,
        toml_url: d.toml_url,
        // Int64 columns come as text in JSON
        checked_ms: String(Math.round(d.checked_at * 1000)),
        verified_ms: d.verified_at === null ? null : String(Math.round(d.verified_at * 1000)),
        next_check: d.next_check_at,
        accounts: d.accounts,
      }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  readonly insert = jest.fn(async (table: string, rows: unknown[]) => {
    if (this.failInserts) throw this.failInserts;
    this.inserts.push({ table, rows });
    if (table === Table.ValidatorManifests) this.manifests.push(...(rows as ValidatorManifestsRow[]));
    if (table === Table.ValidatorDomains) this.domains.push(...(rows as ValidatorDomainsRow[]));
  });

  rowsOf<T>(table: Table): T[] {
    return this.inserts.filter((i) => i.table === table).flatMap((i) => i.rows as T[]);
  }

  get written(): ValidatorDomainsRow[] {
    return this.rowsOf<ValidatorDomainsRow>(Table.ValidatorDomains);
  }
}

/** A promise a test settles by hand: a fetch that is still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toml = (...keys: string[]) => keys.map((k) => `[[VALIDATORS]]\npublic_key = "${k}"\n`).join('\n');
const served = (text: string) => ({ url: 'unused', body: Buffer.from(text) });

/** Lets the promises that are ready run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(what: string, probe: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (probe()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function setup(o: { profile?: NetworkProfile; publishers?: string; recheckMs?: number; timeoutMs?: number } = {}) {
  const ch = new FakeClickHouse();
  const clock = { ms: NOW_MS };
  const fetcher = {
    get: jest.fn(async (_url: string, _limits: unknown, _accept: string): Promise<{ url: string; body: Buffer }> => {
      throw new SafeFetchError('dns_error', 'unexpected fetch');
    }),
  };
  const node = { request: jest.fn(async (_request?: unknown, _options?: unknown): Promise<unknown> => ({})) };
  const metrics = { validatorsDomainChecksTotal: { inc: jest.fn() } };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const cfg = {
    unlPublishers: o.publishers ?? PUBLISHERS,
    unlValidators: '',
    domainRecheckMs: o.recheckMs ?? RECHECK_MS,
    domainFetchTimeoutMs: o.timeoutMs ?? 10_000,
  };
  const checker = new DomainChecker(
    cfg as never,
    o.profile ?? getNetworkProfile('xrpl'),
    ch as never,
    metrics as never,
    fetcher as never,
    node as never,
    { now: () => clock.ms, logger },
  );
  /** Answers the fetch of each URL (a text, or an error to throw); a URL with no answer is a 404. */
  const serve = (answers: Record<string, string | Error>) => {
    fetcher.get.mockImplementation(async (url: string) => {
      const answer = answers[url];
      if (answer === undefined) throw new SafeFetchError('http_status', 'not found', { statusCode: 404 });
      if (answer instanceof Error) throw answer;
      return served(answer);
    });
  };
  const fetched = () => fetcher.get.mock.calls.map((c) => c[0]);
  const outcomes = () =>
    metrics.validatorsDomainChecksTotal.inc.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);
  return { ch, clock, fetcher, node, metrics, logger, checker, serve, fetched, outcomes };
}

const url = (domain: string, path = '/.well-known/xrp-ledger.toml') => `https://${domain}${path}`;

describe('DomainChecker', () => {
  describe('which validators are checked', () => {
    it('checks the masters of the list in use of each configured publisher', async () => {
      const t = setup();
      const [a, b, c] = [validator(1), validator(2), validator(3)];
      t.ch.lists.push(
        listRow({ sequence: 5, validators: [a.master.base58] }),
        listRow({
          publisher: ID_2,
          publisher_key: PUBLISHER_KEY_2.publicKeyHex,
          sequence: 2,
          validators: [b.master.base58],
        }),
      );
      t.ch.manifests.push(
        manifestRow(a, { domain: 'a.example' }),
        manifestRow(b, { domain: 'b.example' }),
        manifestRow(c, { domain: 'c.example' }),
      );
      t.serve({ [url('a.example')]: toml(a.master.base58), [url('b.example')]: toml(b.master.base58) });

      expect(await t.checker.pass()).toBe(2);
      expect(t.fetched().sort()).toEqual([url('a.example'), url('b.example')]);
      expect(t.ch.written.map((r) => [r.validation_public_key, r.status])).toEqual(
        expect.arrayContaining([
          [a.master.base58, 'verified'],
          [b.master.base58, 'verified'],
        ]),
      );
    });

    it('takes the validators of the list in use, not of a superseded one', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      t.ch.lists.push(
        listRow({ sequence: 5, validators: [a.master.base58, b.master.base58] }),
        listRow({ sequence: 6, validators: [a.master.base58], fetched_at: NOW - 600 }),
      );
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }), manifestRow(b, { domain: 'b.example' }));
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('takes the validators of an expired list when it is the only one a publisher has', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.lists.push(listRow({ sequence: 5, expiration: NOW - DAY, validators: [a.master.base58] }));
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('takes no master from a list stored under another key of the same publisher', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      t.ch.lists.push(
        listRow({ sequence: 5, validators: [a.master.base58] }),
        // a later and higher-numbered list of the publisher id, served under a key that is not the configured one
        listRow({
          sequence: 9,
          publisher_key: OTHER_PUBLISHER_KEY.publicKeyHex,
          validators: [b.master.base58],
          fetched_at: NOW - 60,
        }),
      );
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }), manifestRow(b, { domain: 'b.example' }));
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('takes the validators seen in the last 30 days and no others', async () => {
      const t = setup();
      const [recent, edge, old, never] = [validator(1), validator(2), validator(3), validator(4)];
      t.ch.seen.push(
        { key: recent.master.base58, lastSeen: NOW - 60 },
        { key: edge.master.base58, lastSeen: NOW - 29 * DAY },
        { key: old.master.base58, lastSeen: NOW - 31 * DAY },
      );
      t.ch.manifests.push(
        manifestRow(recent, { domain: 'a.example' }),
        manifestRow(edge, { domain: 'b.example' }),
        manifestRow(old, { domain: 'c.example' }),
        manifestRow(never, { domain: 'd.example' }),
      );
      t.serve({});

      await t.checker.pass();
      expect(t.fetched().sort()).toEqual([url('a.example'), url('b.example')]);
    });

    it('maps a key seen only under its signing key to its master through the manifests', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      // a was seen under its signing key, b under its master key
      t.ch.seen.push({ key: a.signing.base58, lastSeen: NOW - 60 }, { key: b.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }), manifestRow(b, { domain: 'b.example' }));
      t.serve({ [url('a.example')]: toml(a.master.base58) });

      expect(await t.checker.pass()).toBe(2);
      expect(t.fetched().sort()).toEqual([url('a.example'), url('b.example')]);
      expect(t.ch.written.map((r) => r.validation_public_key).sort()).toEqual(
        [a.master.base58, b.master.base58].sort(),
      );
    });

    it('checks a master once when it was seen under its master key and under its signing keys', async () => {
      const t = setup();
      const a = validator(1);
      const rotated = validator(1).signing; // the same key again: one manifest
      expect(rotated.base58).toBe(a.signing.base58);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 }, { key: a.signing.base58, lastSeen: NOW - 30 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({});

      expect(await t.checker.pass()).toBe(1);
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('takes the window of a master from the latest sighting under any of its keys', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 40 * DAY }, { key: a.signing.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({});
      expect(await t.checker.pass()).toBe(1);
    });

    it('leaves a key the manifests do not know as it is, so it has no manifest and nothing to check', async () => {
      const t = setup();
      t.ch.seen.push({ key: validator(1).signing.base58, lastSeen: NOW - 60 });
      expect(await t.checker.pass()).toBe(0);
      expect(t.fetcher.get).not.toHaveBeenCalled();
    });

    it('maps the keys of the validators seen inside the read: the map is never a parameter, nor a read of its own', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.signing.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({});
      await t.checker.pass();
      const seenRead = t.ch.query.mock.calls.find(([sql]) => String(sql).includes(Table.ValidatorSeen));
      expect(seenRead?.[0]).toContain(`WITH ${KEY_MAP_WITH}`);
      expect(seenRead?.[0]).toContain(`${mappedKey('validation_public_key')} AS master`);
      for (const [sql, params] of t.ch.query.mock.calls) {
        expect([sql, Object.keys(params ?? {}).filter((name) => name === 'ephemerals' || name === 'masters')]).toEqual([
          sql,
          [],
        ]);
      }
      expect(t.ch.query.mock.calls.filter(([sql]) => sql === MANIFEST_MAP_SQL)).toEqual([]);
      // and the master is checked
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('checks a validator that is both on a list and seen once', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.lists.push(listRow({ sequence: 5, validators: [a.master.base58] }));
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({});

      expect(await t.checker.pass()).toBe(1);
      expect(t.fetched()).toEqual([url('a.example')]);
    });

    it('does nothing, and asks nothing, when no validator is known', async () => {
      const t = setup();
      expect(await t.checker.pass()).toBe(0);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.node.request).not.toHaveBeenCalled();
      expect(t.ch.inserts).toEqual([]);
    });

    it('uses the newest manifest of a master, the one with the highest sequence', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(
        manifestRow(a, { seq: 2, domain: 'old.example' }),
        manifestRow(a, { seq: 7, domain: 'new.example' }),
        manifestRow(a, { seq: 4, domain: 'mid.example' }),
      );
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual([url('new.example')]);
    });

    it('checks nothing for a validator whose newest manifest names no domain, and writes no row', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { seq: 1, domain: 'a.example' }), manifestRow(a, { seq: 2 }));

      expect(await t.checker.pass()).toBe(0);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([]);
      expect(t.outcomes()).toEqual([]);
    });

    it('checks nothing for a validator with no manifest', async () => {
      const t = setup();
      t.ch.seen.push({ key: validator(1).master.base58, lastSeen: NOW - 60 });
      expect(await t.checker.pass()).toBe(0);
      expect(t.node.request).not.toHaveBeenCalled();
    });
  });

  describe('the manifest', () => {
    it('takes the domain from the verified manifest, not from the column the collector wrote', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push({ ...manifestRow(a, { domain: 'a.example' }), domain: 'liar.example', source: 'stream' });
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual([url('a.example')]);
      expect(t.ch.written.map((r) => r.domain)).toEqual(['a.example']);
    });

    it('is manifest_unverified, with no fetch, when the signatures do not verify', async () => {
      const t = setup();
      const a = validator(1);
      const good = makeManifest({ master: a.master, signing: a.signing, sequence: 1, domain: 'good.example' });
      const tampered = good.replace(
        Buffer.from('good.example').toString('hex').toUpperCase(),
        Buffer.from('evil.example').toString('hex').toUpperCase(),
      );
      expect(tampered).not.toBe(good);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push({ ...manifestRow(a, { domain: 'evil.example' }), manifest: tampered, source: 'stream' });

      expect(await t.checker.pass()).toBe(1);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([
        expect.objectContaining({
          validation_public_key: a.master.base58,
          domain: 'evil.example',
          status: 'unverified',
          reason: 'manifest_unverified',
          toml_url: url('evil.example'),
          accounts: [],
        }),
      ]);
      expect(t.outcomes()).toEqual(['manifest_unverified']);
    });

    it('is manifest_unverified when the bytes are not a manifest', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push({ ...manifestRow(a, { domain: 'a.example' }), manifest: 'DEADBEEF' });

      await t.checker.pass();
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([expect.objectContaining({ domain: 'a.example', reason: 'manifest_unverified' })]);
    });

    it("is manifest_unverified when the manifest is another master key's", async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      // b's genuine manifest under a's key
      t.ch.manifests.push({ ...manifestRow(b, { domain: 'b.example' }), master_key: a.master.base58 });

      await t.checker.pass();
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([
        expect.objectContaining({ validation_public_key: a.master.base58, reason: 'manifest_unverified' }),
      ]);
    });

    it('writes no row for an unverified manifest that claims no domain', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push({ ...manifestRow(a), manifest: 'DEADBEEF', domain: '' });
      expect(await t.checker.pass()).toBe(0);
      expect(t.ch.written).toEqual([]);
    });

    it('yields to the event loop every 50 verifications, and not for a manifest it has verified already', async () => {
      const t = setup();
      const vals = Array.from({ length: 120 }, (_, i) => validator(i + 1));
      vals.forEach((v, i) => {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `d${i}.example` }));
      });
      t.serve({});
      const yielded = jest.spyOn(globalThis, 'setImmediate');
      try {
        expect(await t.checker.pass()).toBe(100);
        // 120 verifications: after the 50th and the 100th
        expect(yielded).toHaveBeenCalledTimes(2);

        yielded.mockClear();
        t.clock.ms += 60_000;
        expect(await t.checker.pass()).toBe(20);
        expect(yielded).not.toHaveBeenCalled();
      } finally {
        yielded.mockRestore();
      }
    });

    it('prefers the row with the raw bytes among rows of the same sequence', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(
        { ...manifestRow(a, { seq: 3, domain: 'a.example' }), manifest: '', source: 'stream' },
        manifestRow(a, { seq: 3, domain: 'a.example' }),
      );
      t.serve({});
      await t.checker.pass();
      expect(t.fetched()).toEqual([url('a.example')]);
      expect(t.node.request).not.toHaveBeenCalled();
    });
  });

  describe('a manifest without raw bytes (rows from before migration 002)', () => {
    const answerFor = (v: Val, o: { domain?: string; seq?: number; master?: string } = {}) => ({
      details: {
        domain: o.domain ?? 'a.example',
        ephemeral_key: v.signing.base58,
        master_key: o.master ?? v.master.base58,
        seq: o.seq ?? 3,
      },
      manifest: Buffer.from(
        makeManifest({ master: v.master, signing: v.signing, sequence: o.seq ?? 3, domain: o.domain ?? 'a.example' }),
        'hex',
      ).toString('base64'),
      requested: v.master.base58,
    });

    function preMigration(t: ReturnType<typeof setup>, v: Val) {
      t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push({ ...manifestRow(v, { seq: 3 }), manifest: '', domain: '', source: 'stream' });
    }

    it('asks the node, stores the answer as an rpc row, and checks the domain in a later pass', async () => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      t.node.request.mockResolvedValue(answerFor(a));
      t.serve({ [url('a.example')]: toml(a.master.base58) });

      expect(await t.checker.pass()).toBe(0);
      expect(t.node.request).toHaveBeenCalledTimes(1);
      expect(t.node.request).toHaveBeenCalledWith(
        { command: 'manifest', public_key: a.master.base58 },
        { timeoutMs: 5_000, retries: 0 },
      );
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toEqual([
        {
          ephemeral_key: a.signing.base58,
          master_key: a.master.base58,
          seq: 3,
          domain: 'a.example',
          manifest: makeManifest({ master: a.master, signing: a.signing, sequence: 3, domain: 'a.example' }),
          source: 'rpc',
        },
      ]);
      expect(t.fetcher.get).not.toHaveBeenCalled();

      t.clock.ms += 60_000;
      expect(await t.checker.pass()).toBe(1);
      expect(t.fetched()).toEqual([url('a.example')]);
      expect(t.ch.written).toEqual([expect.objectContaining({ status: 'verified', domain: 'a.example' })]);
      // the bytes are there now: the node is not asked again
      expect(t.node.request).toHaveBeenCalledTimes(1);
    });

    it('asks a key at most once in 10 minutes, whatever the answer was', async () => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      t.node.request.mockRejectedValue(new Error('the node is busy'));

      await t.checker.pass();
      expect(t.node.request).toHaveBeenCalledTimes(1);
      t.clock.ms += MANIFEST_LOOKUP_INTERVAL_MS - 1_000;
      await t.checker.pass();
      await t.checker.pass();
      expect(t.node.request).toHaveBeenCalledTimes(1);
      t.clock.ms += 1_000;
      await t.checker.pass();
      expect(t.node.request).toHaveBeenCalledTimes(2);
      t.clock.ms += MANIFEST_LOOKUP_INTERVAL_MS - 1;
      await t.checker.pass();
      expect(t.node.request).toHaveBeenCalledTimes(2);
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toEqual([]);
      expect(t.ch.written).toEqual([]);
    });

    it('does not fetch while the node cannot be asked, and reports the failures once per pass without the error object', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      preMigration(t, a);
      preMigration(t, b);
      t.node.request.mockRejectedValue(Object.assign(new Error('NodeClient is stopped'), { extra: 'SECRET' }));

      expect(await t.checker.pass()).toBe(0);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const [message, ...rest] = t.logger.warn.mock.calls[0] as unknown[];
      expect(typeof message).toBe('string');
      expect(message).toContain('2 of 2');
      expect(rest).toEqual([]);
      expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain('SECRET');
    });

    const rippledError = (code: unknown, message = 'The node says no.') =>
      Object.assign(new Error(message), { name: 'RippledError', data: { error: code, status: 'error' } });

    it('counts the answers of the node that are errors and names their codes, only the codes, in one warn', async () => {
      const t = setup();
      const vals = [validator(1), validator(2), validator(3)];
      vals.forEach((v) => preMigration(t, v));
      const codes = ['actNotFound', 'actNotFound', 'slowDown'];
      let i = 0;
      t.node.request.mockImplementation(async () => {
        throw rippledError(codes[i++], 'The account was not found, SECRET-MESSAGE');
      });

      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const [line, ...rest] = t.logger.warn.mock.calls[0] as unknown[];
      expect(rest).toEqual([]);
      expect(line).toContain('3 of 3');
      expect(line).toContain('actNotFound x2');
      expect(line).toContain('slowDown');
      expect(line).not.toContain('SECRET-MESSAGE');
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toEqual([]);
    });

    it('says what the codes are in the same warn as the lookups that could not be made', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      preMigration(t, a);
      preMigration(t, b);
      t.node.request.mockImplementation(async (request: unknown) => {
        if ((request as { public_key: string }).public_key === a.master.base58) throw rippledError('actNotFound');
        throw new Error('NodeClient is stopped');
      });

      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line).toContain('1 of 2 manifest lookups failed');
      expect(line).toContain('NodeClient is stopped');
      expect(line).toContain('1 of 2');
      expect(line).toContain('actNotFound');
    });

    it.each([
      ['no code', undefined],
      ['a code that is not text', 12],
      ['a code with a line break', 'bad\ncode'],
      ['a code that is far too long', 'x'.repeat(200)],
    ])('names %s as unknown', async (_name, code) => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      t.node.request.mockRejectedValue(rippledError(code));
      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line).toContain('unknown');
      expect(line).not.toContain('\n');
      expect(line.length).toBeLessThan(200);
    });

    it('says nothing when every answer of the node was usable', async () => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      t.node.request.mockResolvedValue(answerFor(a));
      await t.checker.pass();
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ['the answer is for another master key', (v: Val) => answerFor(v, { master: validator(9).master.base58 })],
      ['the answer has no manifest', (v: Val) => ({ ...answerFor(v), manifest: undefined })],
      ['the manifest is not base64', (v: Val) => ({ ...answerFor(v), manifest: 'not base64!' })],
      [
        'the answer has no ephemeral key',
        (v: Val) => ({ details: { ...answerFor(v).details, ephemeral_key: undefined } }),
      ],
      [
        'the sequence is not a number',
        (v: Val) => ({ ...answerFor(v), details: { ...answerFor(v).details, seq: 'x' } }),
      ],
      ['the answer is empty', () => ({})],
      ['the answer is not an object', () => null],
    ])('stores nothing when %s', async (_name, answer) => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      t.node.request.mockResolvedValue(answer(a));

      await t.checker.pass();
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toEqual([]);
      expect(t.fetcher.get).not.toHaveBeenCalled();
    });

    it('stores an answer whose manifest does not verify, and the later pass finds it manifest_unverified', async () => {
      const t = setup();
      const a = validator(1);
      preMigration(t, a);
      const answer = answerFor(a);
      // the node claims a domain the signed manifest does not have
      const lie = Buffer.from(
        makeManifest({ master: a.master, signing: a.signing, sequence: 3, domain: 'a.example' }).replace(
          Buffer.from('a.example').toString('hex').toUpperCase(),
          Buffer.from('b.example').toString('hex').toUpperCase(),
        ),
        'hex',
      ).toString('base64');
      t.node.request.mockResolvedValue({
        ...answer,
        manifest: lie,
        details: { ...answer.details, domain: 'b.example' },
      });

      await t.checker.pass();
      expect(t.ch.rowsOf<ValidatorManifestsRow>(Table.ValidatorManifests)).toEqual([
        expect.objectContaining({ source: 'rpc', domain: 'b.example' }),
      ]);
      t.clock.ms += 60_000;
      await t.checker.pass();
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([expect.objectContaining({ domain: 'b.example', reason: 'manifest_unverified' })]);
    });

    it('asks for at most 100 keys in a pass, and at most 4 at a time', async () => {
      const t = setup();
      const vals = Array.from({ length: 130 }, (_, i) => validator(i + 1));
      vals.forEach((v) => preMigration(t, v));
      let inFlight = 0;
      let peak = 0;
      const gates: ReturnType<typeof deferred<unknown>>[] = [];
      t.node.request.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const gate = deferred<unknown>();
        gates.push(gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      });

      const pass = t.checker.pass();
      await until('4 lookups under way', () => gates.length === 4);
      await settle();
      expect(gates.length).toBe(4);
      for (let i = 0; i < 100; i++) {
        await until(`lookup ${i} under way`, () => gates.length > i);
        gates[i].resolve({});
      }
      await pass;
      await settle();
      expect(t.node.request).toHaveBeenCalledTimes(100);
      expect(peak).toBe(4);
    });
  });

  describe('the domain', () => {
    it.each([
      ['an IP literal', '203.0.113.7'],
      ['a name with a port', 'a.example:8443'],
      ['a name with a path', 'a.example/path'],
      ['a single label', 'localhost'],
      ['a name with a space', 'exa mple.com'],
      ['a name with an underscore', 'a_b.example'],
      ['a name that starts with a hyphen', '-a.example'],
      ['a name with a user', 'user@a.example'],
    ])('is domain_invalid for %s, before any DNS query', async (_name, domain) => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain }));

      expect(await t.checker.pass()).toBe(1);
      expect(t.fetcher.get).not.toHaveBeenCalled();
      expect(t.ch.written).toEqual([
        expect.objectContaining({ domain, status: 'unverified', reason: 'domain_invalid', accounts: [] }),
      ]);
      expect(t.outcomes()).toEqual(['domain_invalid']);
    });

    it('fetches https://{domain}/.well-known/xrp-ledger.toml within the TOML limits, accepting toml or text', async () => {
      const t = setup({ timeoutMs: 7_500 });
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'northpeak.example' }));
      t.serve({ [url('northpeak.example')]: toml(a.master.base58) });

      await t.checker.pass();
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      expect(t.fetcher.get).toHaveBeenCalledWith(
        'https://northpeak.example/.well-known/xrp-ledger.toml',
        tomlFetchLimits(7_500),
        'application/toml, text/plain, */*',
      );
    });

    it('fetches /.well-known/xahau.toml on Xahau, and does not fall back to the other name', async () => {
      const t = setup({ profile: getNetworkProfile('xahau') });
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'northpeak.example' }));
      t.serve({});

      await t.checker.pass();
      expect(t.fetched()).toEqual(['https://northpeak.example/.well-known/xahau.toml']);
      expect(t.ch.written).toEqual([
        expect.objectContaining({
          toml_url: 'https://northpeak.example/.well-known/xahau.toml',
          reason: 'http_status',
          status_code: 404,
        }),
      ]);
    });

    it('fetches once for the validators that name one domain, and judges each against the file', async () => {
      const t = setup();
      const [a, b, c] = [validator(1), validator(2), validator(3)];
      for (const v of [a, b, c]) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: 'shared.example' }));
      }
      t.serve({
        [url('shared.example')]: `${toml(a.master.base58, c.master.base58)}\n[[ACCOUNTS]]\naddress = "${ACCOUNT_1}"\n`,
      });

      expect(await t.checker.pass()).toBe(3);
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      const byKey = Object.fromEntries(t.ch.written.map((r) => [r.validation_public_key, r]));
      expect(byKey[a.master.base58]).toMatchObject({ status: 'verified', accounts: [ACCOUNT_1] });
      expect(byKey[b.master.base58]).toMatchObject({ status: 'unverified', reason: 'not_listed', accounts: [] });
      expect(byKey[c.master.base58]).toMatchObject({ status: 'verified', accounts: [ACCOUNT_1] });
      expect(t.outcomes().sort()).toEqual(['not_listed', 'verified', 'verified']);
    });

    it('fetches once for a domain written in two cases', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      for (const [v, domain] of [
        [a, 'Shared.Example'],
        [b, 'shared.example'],
      ] as const) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain }));
      }
      t.serve({});
      await t.checker.pass();
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      expect(t.ch.written).toHaveLength(2);
    });

    it('does not fetch for the validator whose manifest does not verify, but does for the others that name the domain', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      const forged = makeManifest({
        master: b.master,
        signing: b.signing,
        sequence: 1,
        domain: 'shared.example',
      }).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
      for (const v of [a, b]) t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'shared.example' }), {
        ...manifestRow(b, { domain: 'shared.example' }),
        manifest: forged,
      });
      t.serve({ [url('shared.example')]: toml(a.master.base58, b.master.base58) });

      await t.checker.pass();
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      const byKey = Object.fromEntries(t.ch.written.map((r) => [r.validation_public_key, r.reason]));
      expect(byKey).toEqual({ [a.master.base58]: '', [b.master.base58]: 'manifest_unverified' });
    });
  });

  describe('what the file says', () => {
    async function checkWith(fetchResult: string | Error, domain = 'a.example') {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain }));
      t.serve({
        [url(domain)]: fetchResult instanceof Error ? fetchResult : fetchResult.replace('KEY', a.master.base58),
      });
      await t.checker.pass();
      return { t, a, row: t.ch.written[0] };
    }

    it('verifies the domain of a file that lists the key, with its accounts', async () => {
      const { row, a } = await checkWith(
        `# Hand-written test data\n${toml('KEY')}\n[[ACCOUNTS]]\naddress = "${ACCOUNT_2}"\n`,
      );
      expect(row).toEqual({
        validation_public_key: a.master.base58,
        domain: 'a.example',
        status: 'verified',
        reason: '',
        status_code: 0,
        toml_url: url('a.example'),
        checked_at: NOW,
        verified_at: NOW,
        next_check_at: NOW + 6 * HOUR,
        accounts: [ACCOUNT_2],
      });
    });

    it('is not_listed for a file that does not list the key', async () => {
      const { row } = await checkWith(
        `${toml('nHBt9fsb4849WmZiCds4r5TXyBeQjqnH5kzPtqgMAQMgi39YZRPa')}\n[[ACCOUNTS]]\naddress = "${ACCOUNT_1}"\n`,
      );
      expect(row).toMatchObject({ status: 'unverified', reason: 'not_listed', accounts: [] });
    });

    it('is toml_invalid for a file that is not TOML', async () => {
      const { row } = await checkWith('<html>not found</html>');
      expect(row).toMatchObject({ status: 'unverified', reason: 'toml_invalid', accounts: [] });
    });

    it('is http_status with the code for a 404, a definite failure', async () => {
      const { row } = await checkWith(new SafeFetchError('http_status', 'status 404', { statusCode: 404 }));
      expect(row).toMatchObject({
        status: 'unverified',
        reason: 'http_status',
        status_code: 404,
        next_check_at: NOW + 6 * HOUR,
      });
    });

    it.each<[string, DomainReason, number | undefined]>([
      ['a name that does not resolve', 'dns_error', undefined],
      ['a refused connection', 'connect_error', undefined],
      ['a bad certificate', 'tls_error', undefined],
      ['a timeout', 'timeout', undefined],
      ['a 503', 'http_status', 503],
      ['a 429', 'http_status', 429],
    ])('is a transient failure, checked again in an hour, for %s', async (_name, reason, statusCode) => {
      const failure = new SafeFetchError(reason as 'dns_error', 'x', { statusCode });
      const { row } = await checkWith(failure);
      expect(row).toMatchObject({ status: 'unverified', reason, status_code: statusCode ?? 0 });
      expect(row).toMatchObject({ next_check_at: NOW + HOUR, accounts: [] });
    });

    it.each<[DomainReason, string | undefined]>([
      ['too_large', undefined],
      ['redirect_rejected', undefined],
      ['domain_invalid', undefined],
      ['blocked_address', '10.0.0.0/8'],
    ])('is a definite failure, checked again in 6 h, for %s', async (reason, addressClass) => {
      const { row } = await checkWith(new SafeFetchError(reason as 'too_large', 'x', { addressClass }));
      expect(row).toMatchObject({ status: 'unverified', reason, next_check_at: NOW + 6 * HOUR });
    });

    it("counts a failure of the connection that is not the fetcher's own as connect_error", async () => {
      const { row } = await checkWith(new Error('something else'));
      expect(row).toMatchObject({ reason: 'connect_error', status: 'unverified' });
    });

    it("names an error that is not the fetcher's own, once a pass and without its message or object", async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      for (const [v, domain] of [
        [a, 'a.example'],
        [b, 'b.example'],
      ] as const) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain }));
      }
      t.fetcher.get.mockRejectedValue(Object.assign(new TypeError('SECRET-MESSAGE'), { extra: 'SECRET-FIELD' }));

      expect(await t.checker.pass()).toBe(2);
      expect(t.ch.written.map((r) => r.reason)).toEqual(['connect_error', 'connect_error']);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const [line, ...rest] = t.logger.warn.mock.calls[0] as unknown[];
      expect(rest).toEqual([]);
      expect(line).toContain('TypeError');
      expect(line).toContain('2 fetches');
      expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain('SECRET');

      // a pass of its own: one more line
      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(2);
    });

    it('names each kind of such an error once, also what is not an error object, and nothing when there is none', async () => {
      const t = setup();
      const vals = [validator(1), validator(2), validator(3)];
      const failures: unknown[] = [
        new RangeError('x'),
        'SECRET string',
        Object.assign(new Error('x'), { name: 'bad\nname' }),
      ];
      vals.forEach((v, i) => {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `d${i}.example` }));
      });
      t.fetcher.get.mockImplementation(async (u: string) => {
        throw failures[Number(/d(\d)\.example/.exec(u)?.[1])];
      });
      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line).toContain('RangeError');
      expect(line).toContain('string');
      expect(line).toContain('Error');
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('\n');

      const quiet = setup();
      const c = validator(4);
      quiet.ch.seen.push({ key: c.master.base58, lastSeen: NOW - 60 });
      quiet.ch.manifests.push(manifestRow(c, { domain: 'a.example' }));
      quiet.serve({ [url('a.example')]: new SafeFetchError('timeout', 'x') });
      await quiet.checker.pass();
      expect(quiet.logger.warn).not.toHaveBeenCalled();
    });

    it('verifies a file that starts with a byte order mark', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.fetcher.get.mockResolvedValue({
        url: 'unused',
        body: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(`${toml(a.master.base58)}\n[[ACCOUNTS]]\naddress = "${ACCOUNT_1}"\n`),
        ]),
      });
      await t.checker.pass();
      expect(t.ch.written).toEqual([expect.objectContaining({ status: 'verified', accounts: [ACCOUNT_1] })]);
    });

    it('counts the outcome of every check: verified, or the reason', async () => {
      const verified = await checkWith(toml('KEY'));
      expect(verified.t.outcomes()).toEqual(['verified']);
      const failed = await checkWith(new SafeFetchError('http_status', 'x', { statusCode: 404 }));
      expect(failed.t.outcomes()).toEqual(['http_status']);
    });
  });

  describe('when a domain is checked', () => {
    function oneValidator(t: ReturnType<typeof setup>, domain = 'a.example') {
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain }));
      return a;
    }

    it('does not check a pair again before its next check time, and does at that time', async () => {
      const t = setup();
      const a = oneValidator(t);
      t.serve({ [url('a.example')]: toml(a.master.base58) });

      expect(await t.checker.pass()).toBe(1);
      for (let minutes = 1; minutes < 360; minutes += 59) {
        t.clock.ms = NOW_MS + minutes * 60_000;
        expect(await t.checker.pass()).toBe(0);
      }
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
      t.clock.ms = NOW_MS + 6 * 3_600_000;
      expect(await t.checker.pass()).toBe(1);
      expect(t.fetcher.get).toHaveBeenCalledTimes(2);
    });

    it("checks a changed domain at once, as a new pair, and leaves the old pair's row alone", async () => {
      const t = setup();
      const a = oneValidator(t);
      t.serve({ [url('a.example')]: toml(a.master.base58), [url('b.example')]: toml(a.master.base58) });
      await t.checker.pass();

      t.ch.manifests.push(manifestRow(a, { seq: 2, domain: 'b.example' }));
      t.clock.ms += 60_000;
      expect(await t.checker.pass()).toBe(1);
      expect(t.fetched()).toEqual([url('a.example'), url('b.example')]);
      expect(t.ch.written.map((r) => r.domain)).toEqual(['a.example', 'b.example']);
    });

    it('checks never-checked pairs first, then the oldest next check time, at most 100 a pass', async () => {
      const t = setup();
      const fresh = Array.from({ length: 5 }, (_, i) => validator(1000 + i));
      const known = Array.from({ length: 100 }, (_, i) => validator(2000 + i));
      for (const [i, v] of known.entries()) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `k${i}.example` }));
        t.ch.domains.push({
          validation_public_key: v.master.base58,
          domain: `k${i}.example`,
          status: 'unverified',
          reason: 'not_listed',
          status_code: 0,
          toml_url: url(`k${i}.example`),
          checked_at: NOW - 7 * HOUR,
          verified_at: null,
          // the later in the list, the more recently due, so that the order of the list is not the order wanted
          next_check_at: NOW - 100 - (99 - i) * 10,
          accounts: [],
        });
      }
      for (const [i, v] of fresh.entries()) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `f${i}.example` }));
      }
      t.serve({});

      expect(await t.checker.pass()).toBe(100);
      const fetched = t.fetched();
      expect(fetched).toHaveLength(100);
      // the five never checked
      for (let i = 0; i < 5; i++) expect(fetched).toContain(url(`f${i}.example`));
      // then the oldest next check times: known i has next_check_at NOW - 100 - (99 - i) * 10, so the oldest are the low i
      for (let i = 0; i < 95; i++) expect(fetched).toContain(url(`k${i}.example`));
      for (let i = 95; i < 100; i++) expect(fetched).not.toContain(url(`k${i}.example`));
      // the five left over are done by the next pass
      t.clock.ms += 60_000;
      expect(await t.checker.pass()).toBe(5);
      expect(t.fetcher.get).toHaveBeenCalledTimes(105);
    });

    it('makes at most 4 fetches at a time', async () => {
      const t = setup();
      const vals = Array.from({ length: 12 }, (_, i) => validator(i + 1));
      vals.forEach((v, i) => {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `d${i}.example` }));
      });
      let inFlight = 0;
      let peak = 0;
      const gates: ReturnType<typeof deferred<{ url: string; body: Buffer }>>[] = [];
      t.fetcher.get.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.push(gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      });

      const pass = t.checker.pass();
      await until('4 fetches under way', () => gates.length === 4);
      await settle();
      expect(gates.length).toBe(4);
      for (let i = 0; i < 12; i++) {
        await until(`fetch ${i} under way`, () => gates.length > i);
        gates[i].resolve(served(''));
      }
      expect(await pass).toBe(12);
      expect(peak).toBe(4);
      expect(t.ch.written).toHaveLength(12);
    });

    it('does not make a second fetch of a domain while the first is on its way, and shares it', async () => {
      const t = setup();
      const [a, b] = [validator(1), validator(2)];
      for (const v of [a, b]) {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: 'shared.example' }));
      }
      const gate = deferred<{ url: string; body: Buffer }>();
      t.fetcher.get.mockImplementation(() => gate.promise);
      const first = t.checker.pass();
      await until('the fetch', () => t.fetcher.get.mock.calls.length === 1);
      // a pass called while one is under way is that pass
      const second = t.checker.pass();
      gate.resolve(served(toml(a.master.base58)));
      expect(await first).toBe(2);
      expect(await second).toBe(2);
      expect(t.fetcher.get).toHaveBeenCalledTimes(1);
    });

    it('writes the rows of a domain as soon as it is done, and the time of the check is the time it finished', async () => {
      const t = setup();
      const a = oneValidator(t);
      const gate = deferred<{ url: string; body: Buffer }>();
      t.fetcher.get.mockImplementation(() => gate.promise);
      const pass = t.checker.pass();
      await until('the fetch', () => t.fetcher.get.mock.calls.length === 1);
      t.clock.ms += 4_500;
      gate.resolve(served(toml(a.master.base58)));
      await pass;
      expect(t.ch.written).toEqual([expect.objectContaining({ checked_at: NOW + 4.5, verified_at: NOW + 4.5 })]);
    });

    it('keeps a verified domain verified through a transient failure, and the row says so', async () => {
      const t = setup();
      const a = oneValidator(t);
      t.serve({ [url('a.example')]: `${toml(a.master.base58)}\n[[ACCOUNTS]]\naddress = "${ACCOUNT_1}"\n` });
      await t.checker.pass();

      t.serve({ [url('a.example')]: new SafeFetchError('timeout', 'timed out') });
      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      expect(t.ch.written[1]).toMatchObject({
        status: 'verified',
        reason: '',
        verified_at: NOW,
        accounts: [ACCOUNT_1],
        next_check_at: NOW + 6 * HOUR + HOUR,
      });
      // the failure is counted for what it was
      expect(t.outcomes()).toEqual(['verified', 'timeout']);

      // and after 24 h of failures it is unverified
      t.clock.ms += 19 * 3_600_000;
      await t.checker.pass();
      expect(t.ch.written[2]).toMatchObject({
        status: 'unverified',
        reason: 'timeout',
        accounts: [],
        verified_at: NOW,
      });
    });

    it('reads the earlier row of a pair from the store, so a restart changes nothing', async () => {
      const t = setup();
      const a = oneValidator(t);
      t.serve({ [url('a.example')]: toml(a.master.base58) });
      await t.checker.pass();
      const again = setup();
      again.ch.manifests = t.ch.manifests;
      again.ch.seen = t.ch.seen;
      again.ch.domains = t.ch.domains;
      again.serve({});
      expect(await again.checker.pass()).toBe(0);
      expect(again.fetcher.get).not.toHaveBeenCalled();
    });
  });

  describe('what is logged', () => {
    it('logs the result of a domain when it changes, and only then', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({ [url('a.example')]: toml(a.master.base58) });

      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(1);
      expect(t.logger.log.mock.calls[0][0]).toContain('a.example');
      expect(t.logger.log.mock.calls[0][0]).toContain('is verified');

      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(1);
      expect(t.logger.warn).not.toHaveBeenCalled();

      t.serve({});
      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(2);
      const line = t.logger.log.mock.calls[1][0] as string;
      expect(line).toContain('a.example');
      expect(line).toContain('unverified');
      expect(line).toContain('http_status');
      expect(line).toContain('404');

      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      expect(t.logger.log).toHaveBeenCalledTimes(2);
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('logs a blocked fetch at warn with the domain and the address class, and nothing else of the failure', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'internal.example' }));
      t.serve({
        [url('internal.example')]: new SafeFetchError('blocked_address', 'the host resolves to a blocked address', {
          addressClass: '10.0.0.0/8',
          cause: new Error('SECRET-CAUSE'),
        }),
      });

      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const line = String(t.logger.warn.mock.calls[0][0]);
      expect(line).toContain('internal.example');
      expect(line).toContain('10.0.0.0/8');
      expect(line).toContain('blocked_address');
      for (const level of ['log', 'warn', 'error'] as const) {
        for (const call of t.logger[level].mock.calls) {
          expect(call).toHaveLength(1);
          expect(typeof call[0]).toBe('string');
        }
      }
      expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain('SECRET-CAUSE');
    });

    it('logs a blocked fetch at every check, not only when the result changes', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'internal.example' }));
      t.serve({
        [url('internal.example')]: new SafeFetchError('blocked_address', 'x', { addressClass: '127.0.0.0/8' }),
      });
      await t.checker.pass();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      t.clock.ms += 6 * 3_600_000;
      await t.checker.pass();
      // the result did not change, the fetch was blocked again
      expect(t.logger.warn).toHaveBeenCalledTimes(2);
      expect(String(t.logger.warn.mock.calls[1][0])).toContain('127.0.0.0/8');
    });

    it('never logs the body of a response, nor a domain with control characters as it is', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example\nFAKE LOG LINE' }));
      await t.checker.pass();
      const b = validator(2);
      t.ch.seen.push({ key: b.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(b, { domain: 'b.example' }));
      t.serve({ [url('b.example')]: 'password = "SECRET-BODY"\nthis is not toml' });
      await t.checker.pass();
      const lines = [...t.logger.log.mock.calls, ...t.logger.warn.mock.calls].map((c) => String(c[0]));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain('SECRET-BODY');
        expect(line).not.toContain('\n');
      }
    });
  });

  describe('failures', () => {
    it('rejects when ClickHouse cannot be written, counts nothing, and checks the pair again next time', async () => {
      const t = setup();
      const a = validator(1);
      t.ch.seen.push({ key: a.master.base58, lastSeen: NOW - 60 });
      t.ch.manifests.push(manifestRow(a, { domain: 'a.example' }));
      t.serve({ [url('a.example')]: toml(a.master.base58) });
      t.ch.failInserts = new Error('ClickHouse is down');

      await expect(t.checker.pass()).rejects.toThrow('ClickHouse is down');
      expect(t.outcomes()).toEqual([]);

      t.ch.failInserts = undefined;
      expect(await t.checker.pass()).toBe(1);
      expect(t.outcomes()).toEqual(['verified']);
    });

    it('rejects when a read fails', async () => {
      const t = setup();
      t.ch.query.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(t.checker.pass()).rejects.toThrow('ClickHouse is down');
    });
  });

  describe('stop', () => {
    it('waits for the fetches under way, writes nothing for them, and starts no more', async () => {
      const t = setup();
      const vals = Array.from({ length: 8 }, (_, i) => validator(i + 1));
      vals.forEach((v, i) => {
        t.ch.seen.push({ key: v.master.base58, lastSeen: NOW - 60 });
        t.ch.manifests.push(manifestRow(v, { domain: `d${i}.example` }));
      });
      const gates: ReturnType<typeof deferred<{ url: string; body: Buffer }>>[] = [];
      t.fetcher.get.mockImplementation(() => {
        const gate = deferred<{ url: string; body: Buffer }>();
        gates.push(gate);
        return gate.promise;
      });
      const pass = t.checker.pass();
      await until('4 fetches under way', () => gates.length === 4);

      let stopped = false;
      const stopping = t.checker.stop().then(() => (stopped = true));
      await settle();
      expect(stopped).toBe(false);
      gates.forEach((g) => g.resolve(served('')));
      await stopping;
      expect(await pass).toBe(0);
      expect(t.fetcher.get).toHaveBeenCalledTimes(4);
      expect(t.ch.written).toEqual([]);
      expect(t.outcomes()).toEqual([]);
    });

    it('makes no pass once stopped', async () => {
      const t = setup();
      await t.checker.stop();
      expect(await t.checker.pass()).toBe(0);
      expect(t.ch.query).not.toHaveBeenCalled();
    });
  });
});

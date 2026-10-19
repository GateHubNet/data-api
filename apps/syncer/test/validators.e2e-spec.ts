import {
  AMENDMENTS_OBJECT_INDEX,
  FEE_SETTINGS_OBJECT_INDEX,
  getNetworkProfile,
  listInUse,
  loadAmendmentsConfig,
  NEGATIVE_UNL_OBJECT_INDEX,
  Table,
} from '@gatehub/data-api-shared';
import { readFileSync } from 'fs';
import { join } from 'path';
import { encodeAccountID } from 'ripple-address-codec';
import {
  makeManifest,
  makeUnlBlob,
  makeUnlResponse,
  TestKey,
  testKey,
} from '../../../packages/shared/src/test-utils/validator-keys';
import { NetworkStatePoller } from '../src/validators/network-state-poller';
import { readStoredLists } from '../src/validators/stored-lists';
import {
  FakeNode,
  ledgerEntries,
  MigratedClickHouse,
  NODE_SILENCE,
  resetValidatorsMetrics,
  startFakeNode,
  startMigratedClickHouse,
  startTestWeb,
  startValidatorsApp,
  TestWeb,
  ValidatorsApp,
  ValidatorsAppOptions,
  waitFor,
} from './support/validators-env';

/**
 * The validators worker against a real ClickHouse, a node and an HTTPS publisher (`https://unl.example`) that serve
 * lists signed with test keys, and HTTPS domains (`https://northpeak.example`, ...) that serve hand-written TOML files.
 * The worker is booted as the application boots it (the core module of the syncer), and nothing leaves the machine: the
 * fetches resolve the names to 127.0.0.1 and trust the test certificate.
 */

const DAY = 86_400;
const PUBLISHER = testKey('e2e-publisher');
const SIGNING_1 = testKey('e2e-publisher-signing-1');
const SIGNING_2 = testKey('e2e-publisher-signing-2');
const OTHER_PUBLISHER = testKey('e2e-other-publisher');
const V1 = testKey('e2e-validator-1');
const V1_SIGNING = testKey('e2e-validator-1-signing');
const V2 = testKey('e2e-validator-2');
const V3 = testKey('e2e-validator-3');
const V3_SIGNING = testKey('e2e-validator-3-signing');
const V1_MANIFEST = makeManifest({ master: V1, signing: V1_SIGNING, sequence: 4, domain: 'v1.example' });
const V3_MANIFEST = makeManifest({ master: V3, signing: V3_SIGNING, sequence: 1 });

const ID = 'unl.example';
const PUBLISHERS = `https://unl.example=${PUBLISHER.publicKeyHex}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A list as `https://unl.example` serves it. */
function list(
  o: {
    sequence?: number;
    expiration?: number;
    effective?: number;
    manifestSequence?: number;
    signing?: ReturnType<typeof testKey>;
    refreshInterval?: number;
  } = {},
): Record<string, unknown> {
  return makeUnlResponse({
    publisher: PUBLISHER,
    publisherSigning: o.signing ?? SIGNING_1,
    manifestSequence: o.manifestSequence,
    refreshInterval: o.refreshInterval,
    blobs: [
      {
        blob: makeUnlBlob({
          sequence: o.sequence ?? 7,
          expiration: o.expiration ?? nowSeconds() + 30 * DAY,
          effective: o.effective,
          validators: [
            { master: V1, manifestHex: V1_MANIFEST },
            { master: V2 },
            { master: V3, manifestHex: V3_MANIFEST },
          ],
        }),
      },
    ],
  });
}

interface ListRow {
  publisher: string;
  publisher_key: string;
  sequence: string;
  version: number;
  effective: number | null;
  expiration: number;
  validators: string[];
  blob_sha256: string;
  fetched_ms: number | string;
  response: string;
}

interface PublisherRow {
  publisher: string;
  url: string;
  publisher_key: string;
  configured: number;
  threshold: number;
  status: string;
  error: string;
  last_ok_ms: number | string | null;
}

describe('the validators worker (e2e)', () => {
  let db: MigratedClickHouse;
  let web: TestWeb;
  let node: FakeNode;
  let apps: ValidatorsApp[] = [];

  beforeAll(async () => {
    db = await startMigratedClickHouse('validators_e2e');
    web = await startTestWeb();
    node = await startFakeNode();
  });

  afterAll(async () => {
    await web?.stop();
    await node?.stop();
    await db?.stop();
  });

  beforeEach(async () => {
    web.clear();
    resetValidatorsMetrics();
    for (const table of [Table.UnlLists, Table.UnlPublishers, Table.ValidatorManifests]) {
      await db.ch.command(`TRUNCATE TABLE ${table}`);
    }
  });

  afterEach(async () => {
    const running = apps;
    apps = [];
    for (const app of running) await app.stop();
  });

  async function boot(
    publishers: string = PUBLISHERS,
    worker: ValidatorsAppOptions['worker'] = {},
  ): Promise<ValidatorsApp> {
    const app = await startValidatorsApp({
      clickhouse: db.config,
      node,
      web,
      config: { unlPublishers: publishers },
      worker: { start: { state: false }, ...worker },
    });
    apps.push(app);
    return app;
  }

  /** How often the worker counted `outcome` for the publisher. */
  async function counted(app: ValidatorsApp, outcome: string, publisher = ID): Promise<number> {
    const { values } = await app.metrics.validatorsUnlFetchesTotal.get();
    return values
      .filter((v) => v.labels.publisher === publisher && v.labels.outcome === outcome)
      .reduce((n, v) => n + v.value, 0);
  }

  /** Resolves when the fetch the worker makes at start is done and counted (the loop runs on its own after boot). */
  async function firstAttempt(app: ValidatorsApp, outcome: string, publisher = ID): Promise<void> {
    await waitFor(`the first fetch to count ${outcome}`, async () => (await counted(app, outcome, publisher)) >= 1);
  }

  async function gauge(app: ValidatorsApp, name: 'validatorsUnlExpirySeconds' | 'validatorsUnlSize', publisher = ID) {
    const { values } = await app.metrics[name].get();
    return values.find((v) => v.labels.publisher === publisher)?.value;
  }

  const storedLists = () =>
    db.ch.query<ListRow>(
      `SELECT publisher, publisher_key, toString(sequence) AS sequence, version, toUnixTimestamp(effective) AS effective,
              toUnixTimestamp(expiration) AS expiration, validators, blob_sha256,
              toUnixTimestamp64Milli(fetched_at) AS fetched_ms, response
         FROM ${Table.UnlLists} ORDER BY publisher, sequence`,
    );

  const publisherRows = () =>
    db.ch.query<PublisherRow>(
      `SELECT publisher, argMax(url, checked_at) AS url, argMax(publisher_key, checked_at) AS publisher_key,
              argMax(configured, checked_at) AS configured, argMax(threshold, checked_at) AS threshold,
              argMax(status, checked_at) AS status, argMax(error, checked_at) AS error,
              toUnixTimestamp64Milli(argMax(last_ok_at, checked_at)) AS last_ok_ms
         FROM ${Table.UnlPublishers} GROUP BY publisher ORDER BY publisher`,
    );

  const publisherRow = async (id: string) => (await publisherRows()).find((r) => r.publisher === id);

  it('stores a new list, its validator manifests and an ok publisher row', async () => {
    const body = list({ sequence: 7, effective: nowSeconds() - DAY, expiration: nowSeconds() + 30 * DAY });
    web.serveJson('unl.example', '/', body);
    const before = Date.now();

    const app = await boot();
    await firstAttempt(app, 'ok');
    const after = Date.now();

    const rows = await storedLists();
    expect(rows).toEqual([
      {
        publisher: ID,
        publisher_key: PUBLISHER.publicKeyHex,
        sequence: '7',
        version: 1,
        effective: expect.any(Number),
        expiration: expect.any(Number),
        validators: [V1.base58, V2.base58, V3.base58].sort(),
        blob_sha256: expect.stringMatching(/^[0-9A-F]{64}$/),
        fetched_ms: expect.anything(),
        response: JSON.stringify(body),
      },
    ]);
    expect(rows[0].effective).toBeGreaterThan(nowSeconds() - DAY - 5);
    expect(rows[0].effective).toBeLessThan(nowSeconds() - DAY + 5);
    expect(Number(rows[0].fetched_ms)).toBeGreaterThanOrEqual(before);
    expect(Number(rows[0].fetched_ms)).toBeLessThanOrEqual(after);

    // the validator manifests inside it, with the source
    const manifests = await db.ch.query<Record<string, unknown>>(
      `SELECT ephemeral_key, master_key, seq, domain, manifest, source FROM ${Table.ValidatorManifests} ORDER BY master_key`,
    );
    expect(manifests).toEqual(
      [
        {
          ephemeral_key: V1_SIGNING.base58,
          master_key: V1.base58,
          seq: 4,
          domain: 'v1.example',
          manifest: V1_MANIFEST,
          source: 'unl',
        },
        {
          ephemeral_key: V3_SIGNING.base58,
          master_key: V3.base58,
          seq: 1,
          domain: '',
          manifest: V3_MANIFEST,
          source: 'unl',
        },
      ].sort((a, b) => (a.master_key < b.master_key ? -1 : 1)),
    );

    // an ok publisher row
    expect(await publisherRows()).toEqual([
      {
        publisher: ID,
        url: 'https://unl.example',
        publisher_key: PUBLISHER.publicKeyHex,
        configured: 1,
        threshold: 1,
        status: 'ok',
        error: '',
        last_ok_ms: expect.anything(),
      },
    ]);
    const lastOk = Number((await publisherRow(ID))?.last_ok_ms);
    expect(lastOk).toBeGreaterThanOrEqual(before);
    expect(lastOk).toBeLessThanOrEqual(after);

    // the gauges of the list in use
    expect(await gauge(app, 'validatorsUnlSize')).toBe(3);
    expect(await gauge(app, 'validatorsUnlExpirySeconds')).toBeGreaterThan(30 * DAY - 60);
    expect(web.requests.map((r) => `${r.host}${r.path}`)).toEqual(['unl.example/']);
    expect(web.requests[0].headers['user-agent']).toMatch(/^gatehub-data-api\/\S+ \(validators\)$/);
    expect(web.requests[0].headers.accept).toBe('application/json');
  });

  it('writes nothing for the same sequence again', async () => {
    web.serveJson('unl.example', '/', list({ sequence: 7 }));
    const app = await boot();
    await firstAttempt(app, 'ok');
    const manifestsBefore = await db.ch.query(`SELECT count() AS n FROM ${Table.ValidatorManifests}`);

    expect(await app.fetcher.fetchOnce(ID)).toBe('unchanged');

    expect(await counted(app, 'unchanged')).toBe(1);
    expect(await storedLists()).toHaveLength(1);
    expect(await db.ch.query(`SELECT count() AS n FROM ${Table.ValidatorManifests}`)).toEqual(manifestsBefore);
    expect(await publisherRow(ID)).toMatchObject({ status: 'ok', error: '' });
  });

  it('stores a newer sequence beside the old one, and refuses an older one as stale', async () => {
    web.serveJson('unl.example', '/', list({ sequence: 7 }));
    const app = await boot();
    await firstAttempt(app, 'ok');

    web.serveJson('unl.example', '/', list({ sequence: 8 }));
    expect(await app.fetcher.fetchOnce(ID)).toBe('ok');
    web.serveJson('unl.example', '/', list({ sequence: 6 }));
    expect(await app.fetcher.fetchOnce(ID)).toBe('stale');

    expect((await storedLists()).map((r) => r.sequence)).toEqual(['7', '8']);
    expect(await publisherRow(ID)).toMatchObject({ status: 'error', error: 'stale' });
  });

  it('never stores a list that fails verification', async () => {
    web.serveJson('unl.example', '/', list({ sequence: 7 }));
    const app = await boot();
    await firstAttempt(app, 'ok');
    const lastOk = (await publisherRow(ID))?.last_ok_ms;

    // a newer list whose signature was tampered with
    const tampered = list({ sequence: 8 });
    tampered.signature = (tampered.signature as string).replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    web.serveJson('unl.example', '/', tampered);

    expect(await app.fetcher.fetchOnce(ID)).toBe('signature_invalid');

    expect((await storedLists()).map((r) => r.sequence)).toEqual(['7']);
    expect(await publisherRow(ID)).toMatchObject({ status: 'error', error: 'signature_invalid', last_ok_ms: lastOk });
    expect(await counted(app, 'signature_invalid')).toBe(1);
  });

  it('keeps using an expired list', async () => {
    let clock = Math.floor(Date.now() / 1000) * 1000; // whole seconds, so the gauge is exact
    const t0 = clock / 1000;
    web.serveJson('unl.example', '/', list({ sequence: 7, expiration: t0 + 3600 }));
    const app = await boot(PUBLISHERS, { now: () => clock });
    await firstAttempt(app, 'ok');
    expect(await gauge(app, 'validatorsUnlExpirySeconds')).toBe(3600);

    // two hours later the publisher serves a newer list that is expired too
    clock += 2 * 3600 * 1000;
    web.serveJson('unl.example', '/', list({ sequence: 8, expiration: t0 + 1800 }));
    expect(await app.fetcher.fetchOnce(ID)).toBe('expired');

    expect(await publisherRow(ID)).toMatchObject({ status: 'error', error: 'expired' });
    const inUse = listInUse(await readStoredLists(db.ch, [ID]), ID, clock / 1000);
    expect(inUse?.expired).toBe(true);
    expect(inUse?.list.sequence).toBe(7);
    expect((await storedLists()).map((r) => r.sequence)).toEqual(['7']);
    expect(await gauge(app, 'validatorsUnlExpirySeconds')).toBe(-3600);
    expect(await gauge(app, 'validatorsUnlSize')).toBe(3);
  });

  it('marks a publisher no longer configured', async () => {
    web.serveJson('unl.example', '/', list({ sequence: 7 }));
    const first = await boot();
    await firstAttempt(first, 'ok');
    await first.stop();
    apps = [];
    const lastOk = (await publisherRow(ID))?.last_ok_ms;

    // restarted with another publisher
    web.serveJson(
      'a.example',
      '/',
      makeUnlResponse({
        publisher: OTHER_PUBLISHER,
        publisherSigning: SIGNING_1,
        blobs: [
          { blob: makeUnlBlob({ sequence: 1, expiration: nowSeconds() + 30 * DAY, validators: [{ master: V2 }] }) },
        ],
      }),
    );
    const second = await boot(`https://a.example=${OTHER_PUBLISHER.publicKeyHex}`);

    // the old publisher is kept as it was, but no longer configured; the new one has its row from the start
    expect(await publisherRows()).toEqual([
      expect.objectContaining({ publisher: 'a.example', configured: 1, status: 'ok', error: '' }),
      expect.objectContaining({ publisher: ID, configured: 0, status: 'ok', error: '', last_ok_ms: lastOk }),
    ]);
    await firstAttempt(second, 'ok', 'a.example');
    expect((await storedLists()).map((r) => [r.publisher, r.sequence])).toEqual([
      ['a.example', '1'],
      [ID, '7'],
    ]);
    expect(await publisherRow('a.example')).toMatchObject({ configured: 1, status: 'ok' });
    expect(web.requests.map((r) => r.host)).toEqual(['unl.example', 'a.example']); // the old one is not fetched again
  });

  it('records a publisher that cannot be fetched', async () => {
    const app = await boot(); // nothing is served: 404
    await firstAttempt(app, 'http_status');

    expect(await publisherRow(ID)).toMatchObject({
      configured: 1,
      status: 'error',
      error: 'http_status',
      last_ok_ms: null,
    });
    expect(await storedLists()).toEqual([]);
    expect(await gauge(app, 'validatorsUnlSize')).toBeUndefined();

    // the publisher is back
    web.serveJson('unl.example', '/', list({ sequence: 3 }));
    expect(await app.fetcher.fetchOnce(ID)).toBe('ok');
    expect(await publisherRow(ID)).toMatchObject({ status: 'ok', error: '' });
  });

  describe('a replay of an older publisher manifest', () => {
    // sequence 2 of the manifest moved the publisher to SIGNING_2; a body that brings back sequence 1 is signed by the old key
    const current = (sequence: number) => list({ sequence, manifestSequence: 2, signing: SIGNING_2 });
    const replay = (sequence: number) => list({ sequence, manifestSequence: 1, signing: SIGNING_1 });

    it('is refused, and nothing is written to unl_lists', async () => {
      web.serveJson('unl.example', '/', current(7));
      const app = await boot();
      await firstAttempt(app, 'ok');

      web.serveJson('unl.example', '/', replay(8));
      expect(await app.fetcher.fetchOnce(ID)).toBe('signature_invalid');

      expect((await storedLists()).map((r) => r.sequence)).toEqual(['7']);
      expect(await publisherRow(ID)).toMatchObject({ status: 'error', error: 'signature_invalid' });
    });

    it('is refused after a restart too, from the manifest of the newest stored response', async () => {
      web.serveJson('unl.example', '/', current(7));
      const first = await boot();
      await firstAttempt(first, 'ok');
      await first.stop();
      apps = [];
      resetValidatorsMetrics();

      web.serveJson('unl.example', '/', replay(8));
      const second = await boot();
      await firstAttempt(second, 'signature_invalid');
      expect((await storedLists()).map((r) => r.sequence)).toEqual(['7']);

      // the real publisher is not locked out
      web.serveJson('unl.example', '/', current(9));
      expect(await second.fetcher.fetchOnce(ID)).toBe('ok');
      expect((await storedLists()).map((r) => r.sequence)).toEqual(['7', '9']);
    });
  });

  it('numbers the lists of a new key at the same URL anew: its lower sequence is new, not stale', async () => {
    web.serveJson('unl.example', '/', list({ sequence: 7 }));
    const first = await boot();
    await firstAttempt(first, 'ok');
    await first.stop();
    apps = [];
    resetValidatorsMetrics();

    // the publisher moved to another master key, at the same address, and counts from 3 again
    web.serveJson(
      'unl.example',
      '/',
      makeUnlResponse({
        publisher: OTHER_PUBLISHER,
        publisherSigning: SIGNING_1,
        blobs: [
          {
            blob: makeUnlBlob({
              sequence: 3,
              expiration: nowSeconds() + 10 * DAY,
              validators: [{ master: V2 }],
            }),
          },
        ],
      }),
    );
    const second = await boot(`https://unl.example=${OTHER_PUBLISHER.publicKeyHex}`);
    await firstAttempt(second, 'ok');

    expect((await storedLists()).map((r) => [r.sequence, r.publisher_key])).toEqual([
      ['3', OTHER_PUBLISHER.publicKeyHex],
      ['7', PUBLISHER.publicKeyHex],
    ]);
    expect(await publisherRows()).toEqual([
      expect.objectContaining({
        publisher: ID,
        publisher_key: OTHER_PUBLISHER.publicKeyHex,
        configured: 1,
        status: 'ok',
        error: '',
      }),
    ]);
    // the list in use is the new key's: its size and its expiry, not those of the old key's list
    expect(await gauge(second, 'validatorsUnlSize')).toBe(1);
    expect(await gauge(second, 'validatorsUnlExpirySeconds')).toBeLessThan(10 * DAY + 5);
    expect(await second.fetcher.fetchOnce(ID)).toBe('unchanged');
  });

  it('remembers the manifest of the configured key when the newest stored response is of another key', async () => {
    // the publisher's key moves from one master key to another and back; the manifest of sequence 2 moved the first to SIGNING_2
    web.serveJson('unl.example', '/', list({ sequence: 7, manifestSequence: 2, signing: SIGNING_2 }));
    const first = await boot();
    await firstAttempt(first, 'ok');
    await first.stop();
    apps = [];
    resetValidatorsMetrics();

    web.serveJson(
      'unl.example',
      '/',
      makeUnlResponse({
        publisher: OTHER_PUBLISHER,
        publisherSigning: SIGNING_1,
        blobs: [
          { blob: makeUnlBlob({ sequence: 3, expiration: nowSeconds() + 10 * DAY, validators: [{ master: V2 }] }) },
        ],
      }),
    );
    const other = await boot(`https://unl.example=${OTHER_PUBLISHER.publicKeyHex}`);
    await firstAttempt(other, 'ok');
    await other.stop();
    apps = [];
    resetValidatorsMetrics();

    // back to the first key, and a body replays its manifest of sequence 1: the newest response stored is the other key's,
    // but it is the first key's own newest that counts
    web.serveJson('unl.example', '/', list({ sequence: 8, manifestSequence: 1, signing: SIGNING_1 }));
    const back = await boot();
    await firstAttempt(back, 'signature_invalid');

    expect((await storedLists()).map((r) => [r.sequence, r.publisher_key])).toEqual([
      ['3', OTHER_PUBLISHER.publicKeyHex],
      ['7', PUBLISHER.publicKeyHex],
    ]);
  });

  describe('readStoredLists', () => {
    it('reads the lists of the given publishers, the newest row of a sequence standing for it', async () => {
      const row = (o: Record<string, unknown>) => ({
        publisher: ID,
        publisher_key: PUBLISHER.publicKeyHex,
        sequence: 7,
        version: 1,
        effective: null,
        expiration: 2_000_000_000,
        validators: ['nHA'],
        blob_sha256: 'AB',
        fetched_at: 1_800_000_000.5,
        response: '{}',
        ...o,
      });
      await db.ch.insert(Table.UnlLists, [
        row({ validators: ['nHOld'], fetched_at: 1_800_000_000.5 }),
        row({ validators: ['nHNew1', 'nHNew2'], effective: 1_790_000_000, fetched_at: 1_800_000_100.25 }),
        row({ sequence: 8, expiration: 2_100_000_000, validators: ['nHB'], fetched_at: 1_800_000_200 }),
        row({
          publisher: 'other.example',
          publisher_key: OTHER_PUBLISHER.publicKeyHex,
          sequence: 3,
          validators: ['nHC'],
        }),
        // a newer row wins over an older one of the same sequence, NULL (no effective time) and key included
        row({ sequence: 9, effective: 1_790_000_000, fetched_at: 1_800_000_000 }),
        row({ sequence: 9, effective: null, fetched_at: 1_800_000_300, publisher_key: OTHER_PUBLISHER.publicKeyHex }),
      ]);

      expect(await readStoredLists(db.ch, [ID])).toEqual([
        {
          publisher: ID,
          publisherKey: PUBLISHER.publicKeyHex,
          sequence: 7,
          version: 1,
          effective: 1_790_000_000,
          expiration: 2_000_000_000,
          validators: ['nHNew1', 'nHNew2'],
          fetchedAt: 1_800_000_100.25,
        },
        {
          publisher: ID,
          publisherKey: PUBLISHER.publicKeyHex,
          sequence: 8,
          version: 1,
          expiration: 2_100_000_000,
          validators: ['nHB'],
          fetchedAt: 1_800_000_200,
        },
        {
          publisher: ID,
          publisherKey: OTHER_PUBLISHER.publicKeyHex,
          sequence: 9,
          version: 1,
          expiration: 2_000_000_000,
          validators: ['nHA'],
          fetchedAt: 1_800_000_300,
        },
      ]);
      expect(
        (await readStoredLists(db.ch, [ID, 'other.example'])).map((l) => [l.publisher, l.sequence, l.publisherKey]),
      ).toEqual([
        ['other.example', 3, OTHER_PUBLISHER.publicKeyHex],
        [ID, 7, PUBLISHER.publicKeyHex],
        [ID, 8, PUBLISHER.publicKeyHex],
        [ID, 9, OTHER_PUBLISHER.publicKeyHex],
      ]);
      expect(await readStoredLists(db.ch, ['nobody.example'])).toEqual([]);
      expect(await readStoredLists(db.ch, [])).toEqual([]);
    });
  });

  describe('domain verification', () => {
    const TOML_PATH = '/.well-known/xrp-ledger.toml';
    const NORTHPEAK = 'northpeak.example';
    const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
    const OTHER_ACCOUNT = encodeAccountID(Buffer.alloc(20, 7));
    const HOUR = 3_600;
    const clock = { ms: 0 };

    interface Val {
      master: TestKey;
      signing: TestKey;
    }
    const val = (n: number): Val => ({ master: testKey(`e2e-dom-${n}`), signing: testKey(`e2e-dom-${n}-signing`) });

    /** A TOML file as a validator's domain might publish it. Hand-written test data, not a recorded file. */
    const toml = (key: string, accounts: string[] = []): string =>
      [
        '# Hand-written test data, not recorded from any real domain.',
        '[METADATA]',
        'modified = 2026-10-19T12:00:00.000Z',
        '',
        '[[PRINCIPALS]]',
        'name = "North Peak Validators"',
        '',
        '[[VALIDATORS]]',
        `public_key = "${key}"`,
        'network = "main"',
        'owner_country = "SI"',
        '',
        ...accounts.flatMap((address) => ['[[ACCOUNTS]]', `address = "${address}"`, 'desc = "treasury"', '']),
      ].join('\n');

    interface DomainRow {
      validation_public_key: string;
      domain: string;
      status: string;
      reason: string;
      status_code: number;
      toml_url: string;
      checked_ms: number | string;
      verified_ms: number | string | null;
      next_check: number;
      accounts: string[];
    }

    const domainRows = () =>
      db.ch.query<DomainRow>(
        `SELECT validation_public_key, domain,
                argMax(status, checked_at) AS status, argMax(reason, checked_at) AS reason,
                argMax(status_code, checked_at) AS status_code, argMax(toml_url, checked_at) AS toml_url,
                toUnixTimestamp64Milli(max(checked_at)) AS checked_ms,
                toUnixTimestamp64Milli(argMax(verified_at, checked_at)) AS verified_ms,
                toUnixTimestamp(argMax(next_check_at, checked_at)) AS next_check,
                argMax(accounts, checked_at) AS accounts
           FROM ${Table.ValidatorDomains}
          GROUP BY validation_public_key, domain
          ORDER BY validation_public_key, domain`,
      );

    /** The manifest rows as the collector or a list would have written them; `raw: false` is a row from before 002. */
    async function putManifest(
      v: Val,
      o: { seq?: number; domain?: string; hex?: string; raw?: boolean; source?: 'stream' | 'unl' } = {},
    ): Promise<string> {
      const seq = o.seq ?? 1;
      const hex = o.hex ?? makeManifest({ master: v.master, signing: v.signing, sequence: seq, domain: o.domain });
      await db.ch.insert(Table.ValidatorManifests, [
        {
          ephemeral_key: v.signing.base58,
          master_key: v.master.base58,
          seq,
          domain: o.domain ?? '',
          manifest: o.raw === false ? '' : hex,
          source: o.source ?? 'unl',
        },
      ]);
      return hex;
    }

    /** The validator was seen `secondsAgo` seconds ago, under its master key unless `key` says another. */
    async function putSeen(v: Val, secondsAgo = 60, key: string = v.master.base58): Promise<void> {
      const last = clock.ms / 1000 - secondsAgo;
      await db.ch.insert(Table.ValidatorSeen, [
        { validation_public_key: key, first_seen: last - 1_000, last_seen: last, last_ledger_index: 100 },
      ]);
    }

    /** A stored list of the publisher `unl.example`, served under `key` (default the configured one). */
    async function putList(validators: string[], o: { key?: string; sequence?: number } = {}): Promise<void> {
      await db.ch.insert(Table.UnlLists, [
        {
          publisher: ID,
          publisher_key: o.key ?? PUBLISHER.publicKeyHex,
          sequence: o.sequence ?? 1,
          version: 1,
          effective: null,
          expiration: clock.ms / 1000 + 30 * DAY,
          validators: [...validators].sort(),
          blob_sha256: 'AB'.repeat(32),
          fetched_at: clock.ms / 1000 - HOUR,
          response: '{}',
        },
      ]);
    }

    /** The worker with the clock of the test and, unless the test says otherwise, no loops: the test makes the passes. */
    async function bootDomains(
      o: {
        config?: ValidatorsAppOptions['config'];
        worker?: ValidatorsAppOptions['worker'];
        node?: FakeNode;
        profile?: ValidatorsAppOptions['profile'];
      } = {},
    ): Promise<ValidatorsApp> {
      const app = await startValidatorsApp({
        clickhouse: db.config,
        node: o.node ?? node,
        web,
        config: { unlPublishers: PUBLISHERS, ...o.config },
        worker: { now: () => clock.ms, start: { unl: false, domains: false, state: false }, ...o.worker },
        profile: o.profile,
      });
      apps.push(app);
      return app;
    }

    async function counted(app: ValidatorsApp, outcome: string): Promise<number> {
      const { values } = await app.metrics.validatorsDomainChecksTotal.get();
      return values.filter((v) => v.labels.outcome === outcome).reduce((n, v) => n + v.value, 0);
    }

    beforeEach(async () => {
      // whole seconds: the next check time is a whole second
      clock.ms = Math.floor(Date.now() / 1000) * 1000;
      node.requests.length = 0;
      delete node.answers.manifest;
      for (const table of [Table.ValidatorDomains, Table.ValidatorSeen]) await db.ch.command(`TRUNCATE TABLE ${table}`);
    });

    it('verifies a domain whose hand-written TOML lists the key, and stores the accounts it names', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putList([v.master.base58]);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58, [OTHER_ACCOUNT, GENESIS, 'not an address']));
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);

      expect(await domainRows()).toEqual([
        {
          validation_public_key: v.master.base58,
          domain: NORTHPEAK,
          status: 'verified',
          reason: '',
          status_code: 0,
          toml_url: `https://${NORTHPEAK}/.well-known/xrp-ledger.toml`,
          checked_ms: expect.anything(),
          verified_ms: expect.anything(),
          next_check: Math.ceil(clock.ms / 1000 + 6 * HOUR),
          accounts: [GENESIS, OTHER_ACCOUNT].sort(),
        },
      ]);
      const [row] = await domainRows();
      expect(Number(row.checked_ms)).toBe(clock.ms);
      expect(Number(row.verified_ms)).toBe(clock.ms);
      expect(web.requests).toEqual([
        expect.objectContaining({
          host: NORTHPEAK,
          path: TOML_PATH,
          headers: expect.objectContaining({ accept: 'application/toml, text/plain, */*' }),
        }),
      ]);
      expect(await counted(app, 'verified')).toBe(1);
    });

    it('is not_listed when the file lists other keys only, and reads no account from it', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(val(2).master.base58, [GENESIS]));
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ status: 'unverified', reason: 'not_listed', status_code: 0, accounts: [] }),
      ]);
      expect(await counted(app, 'not_listed')).toBe(1);
    });

    it('is toml_invalid when the file is not TOML', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serveToml(NORTHPEAK, TOML_PATH, '<html>Welcome to North Peak</html>');
      const app = await bootDomains();
      await app.domains.pass();
      expect(await domainRows()).toEqual([expect.objectContaining({ status: 'unverified', reason: 'toml_invalid' })]);
    });

    it('is http_status 404 when the domain has no file, and checks again in 6 h', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({
          status: 'unverified',
          reason: 'http_status',
          status_code: 404,
          verified_ms: null,
          next_check: Math.ceil(clock.ms / 1000 + 6 * HOUR),
          accounts: [],
        }),
      ]);
      expect(await counted(app, 'http_status')).toBe(1);
    });

    it('follows a redirect to the other name of the site, and still names the URL of the domain', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serve(NORTHPEAK, TOML_PATH, {
        status: 302,
        headers: { location: `https://www.${NORTHPEAK}${TOML_PATH}` },
        body: '',
      });
      web.serveToml(`www.${NORTHPEAK}`, TOML_PATH, toml(v.master.base58, [GENESIS]));
      const app = await bootDomains();

      await app.domains.pass();
      expect(await domainRows()).toEqual([
        expect.objectContaining({
          status: 'verified',
          toml_url: `https://${NORTHPEAK}${TOML_PATH}`,
          accounts: [GENESIS],
        }),
      ]);
      expect(web.requests.map((r) => r.host)).toEqual([NORTHPEAK, `www.${NORTHPEAK}`]);
    });

    it('is manifest_unverified, without a fetch, for a manifest with a tampered signature', async () => {
      const v = val(1);
      const good = makeManifest({ master: v.master, signing: v.signing, sequence: 1, domain: 'a.example' });
      const tampered = good.replace(
        Buffer.from('a.example').toString('hex').toUpperCase(),
        Buffer.from('b.example').toString('hex').toUpperCase(),
      );
      expect(tampered).not.toBe(good);
      // what the stream said: the manifest and the domain it claims
      await putManifest(v, { domain: 'b.example', hex: tampered, source: 'stream' });
      await putSeen(v);
      web.serveToml('b.example', TOML_PATH, toml(v.master.base58));
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);
      expect(web.requests).toEqual([]);
      expect(await domainRows()).toEqual([
        expect.objectContaining({
          domain: 'b.example',
          status: 'unverified',
          reason: 'manifest_unverified',
          accounts: [],
        }),
      ]);
      expect(await counted(app, 'manifest_unverified')).toBe(1);
    });

    it('is domain_invalid, without a fetch, for a domain that is an IP address', async () => {
      const v = val(1);
      await putManifest(v, { domain: '203.0.113.7' });
      await putSeen(v);
      const app = await bootDomains();
      expect(await app.domains.pass()).toBe(1);
      expect(web.requests).toEqual([]);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ domain: '203.0.113.7', status: 'unverified', reason: 'domain_invalid' }),
      ]);
    });

    it('asks the node for a manifest stored before 002, keeps its answer as an rpc row, and checks it in a later pass', async () => {
      const v = val(1);
      const hex = makeManifest({ master: v.master, signing: v.signing, sequence: 3, domain: NORTHPEAK });
      // the row the collector wrote before 002: no domain, no raw bytes
      await putManifest(v, { seq: 3, raw: false, source: 'stream' });
      await putSeen(v);
      node.answers.manifest = (request) => ({
        details: {
          domain: NORTHPEAK,
          ephemeral_key: v.signing.base58,
          master_key: request.public_key,
          seq: 3,
        },
        manifest: Buffer.from(hex, 'hex').toString('base64'),
        requested: request.public_key,
      });
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58, [GENESIS]));
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(0);
      expect(node.requests.filter((r) => r.command === 'manifest')).toEqual([
        expect.objectContaining({ command: 'manifest', public_key: v.master.base58 }),
      ]);
      expect(
        await db.ch.query(
          `SELECT ephemeral_key, master_key, seq, domain, manifest, source FROM ${Table.ValidatorManifests} WHERE source = 'rpc'`,
        ),
      ).toEqual([
        {
          ephemeral_key: v.signing.base58,
          master_key: v.master.base58,
          seq: 3,
          domain: NORTHPEAK,
          manifest: hex,
          source: 'rpc',
        },
      ]);
      expect(web.requests).toEqual([]);
      expect(await domainRows()).toEqual([]);

      // the answer is checked in the next pass, and the node is not asked again
      clock.ms += 60_000;
      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ domain: NORTHPEAK, status: 'verified', accounts: [GENESIS] }),
      ]);
      expect(node.requests.filter((r) => r.command === 'manifest')).toHaveLength(1);
    });

    it('does not take the word of the node for a manifest: an answer that does not verify is manifest_unverified', async () => {
      const v = val(1);
      const hex = makeManifest({ master: v.master, signing: v.signing, sequence: 3, domain: 'a.example' });
      const lie = hex.replace(
        Buffer.from('a.example').toString('hex').toUpperCase(),
        Buffer.from('b.example').toString('hex').toUpperCase(),
      );
      await putManifest(v, { seq: 3, raw: false, source: 'stream' });
      await putSeen(v);
      node.answers.manifest = (request) => ({
        details: { domain: 'b.example', ephemeral_key: v.signing.base58, master_key: request.public_key, seq: 3 },
        manifest: Buffer.from(lie, 'hex').toString('base64'),
      });
      web.serveToml('b.example', TOML_PATH, toml(v.master.base58));
      const app = await bootDomains();

      await app.domains.pass();
      clock.ms += 60_000;
      await app.domains.pass();
      expect(web.requests).toEqual([]);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ domain: 'b.example', reason: 'manifest_unverified' }),
      ]);
    });

    it('takes the validators on the list in use or seen in the last 30 days, and no master from the list of another key', async () => {
      const [seen, longGone, listed, otherKey] = [val(1), val(2), val(3), val(4)];
      await putManifest(seen, { domain: 'a.example' });
      await putManifest(longGone, { domain: 'b.example' });
      await putManifest(listed, { domain: 'c.example' });
      await putManifest(otherKey, { domain: 'd.example' });
      await putSeen(seen, 5 * DAY);
      await putSeen(longGone, 31 * DAY);
      await putList([listed.master.base58]);
      // a list of the same publisher id under a key that is not the configured one: not the list in use
      await putList([otherKey.master.base58], { key: OTHER_PUBLISHER.publicKeyHex, sequence: 9 });
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(2);
      expect((await domainRows()).map((r) => r.domain).sort()).toEqual(['a.example', 'c.example']);
      expect(web.requests.map((r) => r.host).sort()).toEqual(['a.example', 'c.example']);
    });

    it('uses the newest manifest of a master: its domain, and a change of domain is a new pair', async () => {
      const v = val(1);
      await putManifest(v, { seq: 1, domain: 'a.example' });
      await putSeen(v);
      web.serveToml('a.example', TOML_PATH, toml(v.master.base58));
      web.serveToml('b.example', TOML_PATH, toml(v.master.base58, [GENESIS]));
      const app = await bootDomains();
      await app.domains.pass();
      expect((await domainRows()).map((r) => [r.domain, r.status])).toEqual([['a.example', 'verified']]);

      await putManifest(v, { seq: 2, domain: 'b.example' });
      clock.ms += 60_000;
      expect(await app.domains.pass()).toBe(1);
      expect((await domainRows()).map((r) => [r.domain, r.status, r.accounts])).toEqual([
        ['a.example', 'verified', []],
        ['b.example', 'verified', [GENESIS]],
      ]);
    });

    it('maps a validator seen only under its signing key to its master through the manifests, and checks the master', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v, 60, v.signing.base58);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58, [GENESIS]));
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ validation_public_key: v.master.base58, status: 'verified', accounts: [GENESIS] }),
      ]);
    });

    it('takes the validators seen under a master and its signing key as one, and the latest sighting of either', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v, 40 * DAY);
      await putSeen(v, 60, v.signing.base58);
      const app = await bootDomains();
      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([expect.objectContaining({ validation_public_key: v.master.base58 })]);
    });

    it('reads the validators seen when no manifest is stored at all', async () => {
      await putSeen(val(1));
      const app = await bootDomains();
      expect(await app.domains.pass()).toBe(0);
      expect(await domainRows()).toEqual([]);
    });

    it('verifies a TOML file that starts with a byte order mark', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serveToml(NORTHPEAK, TOML_PATH, `\uFEFF${toml(v.master.base58, [GENESIS])}`);
      const app = await bootDomains();

      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ status: 'verified', reason: '', accounts: [GENESIS] }),
      ]);
    });

    it('names the code of the error the node answers a manifest request with, in one warn', async () => {
      const v = val(1);
      await putManifest(v, { seq: 3, raw: false, source: 'stream' });
      await putSeen(v);
      // the fake node has no `manifest` answer: it answers with the error `unknownCmd`
      const lines: string[] = [];
      const logger = { log: () => undefined, warn: (line: string) => void lines.push(line), error: () => undefined };
      const app = await bootDomains({ worker: { logger } });

      expect(await app.domains.pass()).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('1 of 1');
      expect(lines[0]).toContain('unknownCmd');
      expect(await domainRows()).toEqual([]);
    });

    it('keeps a verified domain verified through a failing website for 24 h, then says why it is not', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58, [GENESIS]));
      const app = await bootDomains();
      await app.domains.pass();
      const verifiedAt = clock.ms;

      // the website starts failing; it is checked again after 6 h
      web.serveToml(NORTHPEAK, TOML_PATH, 'maintenance', 503);
      clock.ms = verifiedAt + 6 * HOUR * 1000;
      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([
        expect.objectContaining({
          status: 'verified',
          reason: '',
          status_code: 0,
          accounts: [GENESIS],
          next_check: Math.ceil(clock.ms / 1000 + HOUR),
        }),
      ]);
      expect(Number((await domainRows())[0].verified_ms)).toBe(verifiedAt);

      // not yet due: nothing is asked
      clock.ms += 30 * 60 * 1000;
      expect(await app.domains.pass()).toBe(0);

      // an hour later it fails again, and still within 24 h of the last success
      clock.ms = verifiedAt + 7 * HOUR * 1000;
      expect(await app.domains.pass()).toBe(1);
      expect(await domainRows()).toEqual([expect.objectContaining({ status: 'verified', accounts: [GENESIS] })]);

      // after 24 h of failures it is unverified, says why, and has no accounts; the last success is remembered
      clock.ms = verifiedAt + 25 * HOUR * 1000;
      expect(await app.domains.pass()).toBe(1);
      const [row] = await domainRows();
      expect(row).toMatchObject({ status: 'unverified', reason: 'http_status', status_code: 503, accounts: [] });
      expect(Number(row.verified_ms)).toBe(verifiedAt);
      expect(await counted(app, 'verified')).toBe(1);
      expect(await counted(app, 'http_status')).toBe(3);
    });

    it('is blocked_address for a domain that resolves to a private address, and logs it at warn with the address class', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      const lines: string[] = [];
      const logger = { log: () => undefined, warn: (line: string) => void lines.push(line), error: () => undefined };
      // the real address policy, and a DNS that answers with a private address
      const app = await bootDomains({
        worker: { logger, fetch: { resolve: async () => [{ address: '10.1.2.3', family: 4 }] } },
      });

      await app.domains.pass();
      expect(web.requests).toEqual([]);
      expect(await domainRows()).toEqual([
        expect.objectContaining({ status: 'unverified', reason: 'blocked_address', next_check: expect.anything() }),
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(NORTHPEAK);
      expect(lines[0]).toContain('10.0.0.0/8');
      expect(await counted(app, 'blocked_address')).toBe(1);
    });

    it('fetches /.well-known/xahau.toml on Xahau, and does not fall back to the other name', async () => {
      const xahauNode = await startFakeNode({
        server_info: { info: { complete_ledgers: '1-100', validated_ledger: { seq: 100 }, network_id: 21337 } },
      });
      let app: ValidatorsApp | undefined;
      try {
        const v = val(1);
        await putManifest(v, { domain: NORTHPEAK });
        await putSeen(v);
        web.serveToml(NORTHPEAK, '/.well-known/xahau.toml', toml(v.master.base58, [GENESIS]));
        web.serveToml(NORTHPEAK, TOML_PATH, toml(val(2).master.base58));
        app = await bootDomains({ node: xahauNode, profile: getNetworkProfile('xahau') });

        expect(await app.domains.pass()).toBe(1);
        expect(web.requests.map((r) => r.path)).toEqual(['/.well-known/xahau.toml']);
        expect(await domainRows()).toEqual([
          expect.objectContaining({
            status: 'verified',
            toml_url: `https://${NORTHPEAK}/.well-known/xahau.toml`,
            accounts: [GENESIS],
          }),
        ]);
      } finally {
        if (app !== undefined) {
          await app.stop();
          apps = apps.filter((a) => a !== app);
        }
        await xahauNode.stop();
      }
    });

    it('checks domains from boot while GH_DOMAIN_VERIFICATION is true', async () => {
      const v = val(1);
      await putManifest(v, { domain: NORTHPEAK });
      await putSeen(v);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58, [GENESIS]));
      await bootDomains({ worker: { start: { unl: false, state: false } } });

      const [row] = await waitFor('the first pass to write a row', async () => {
        const rows = await domainRows();
        return rows.length > 0 && rows;
      });
      expect(row).toMatchObject({ domain: NORTHPEAK, status: 'verified', accounts: [GENESIS] });
    });

    it('makes no check, no fetch and no row while GH_DOMAIN_VERIFICATION is false', async () => {
      const v = val(1);
      const pre = val(2);
      await putManifest(v, { domain: NORTHPEAK });
      await putManifest(pre, { raw: false, source: 'stream' });
      await putSeen(v);
      await putSeen(pre);
      web.serveToml(NORTHPEAK, TOML_PATH, toml(v.master.base58));
      const app = await bootDomains({
        config: { domainVerification: false },
        worker: { start: { unl: false, state: false } },
      });

      // the loop would have made its first pass by now
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await domainRows()).toEqual([]);
      expect(web.requests).toEqual([]);
      expect(node.requests.filter((r) => r.command === 'manifest')).toEqual([]);
      expect(await counted(app, 'verified')).toBe(0);
    });
  });

  describe('network state and amendment names', () => {
    const FIXTURES = join(__dirname, '../../../packages/shared/test/fixtures');
    type Network = 'xrpl' | 'xahau';
    /** What `record-fixtures --network-state` saved from the public node of the network, as the node served it. */
    const recorded = (network: Network, name: string): any =>
      JSON.parse(readFileSync(join(FIXTURES, network, 'network-state', `${name}.json`), 'utf8'));
    const NO_METADATA = 'AB'.repeat(32);
    /** An amendment the shipped metadata names (RequireFullyCanonicalSig). */
    const NAMED = '00C1FC4A53E60AB02C864641002B3172F38677E29C26C5406685179B37E1EDAC';
    const NAMED_2 = '157D2D480E006395B76F948E3E07A45A05FE10230D88A7993C71F97AE4B1F2D1';

    let stateNode: FakeNode;
    /** The warn lines the worker logged, in order. */
    let warnings: string[] = [];

    beforeAll(async () => {
      stateNode = await startFakeNode();
    });

    afterAll(async () => {
      await stateNode?.stop();
    });

    beforeEach(async () => {
      warnings = [];
      stateNode.requests.length = 0;
      for (const table of [Table.NetworkState, Table.AmendmentFeatures, Table.AmendmentTallies]) {
        await db.ch.command(`TRUNCATE TABLE ${table}`);
      }
    });

    /** The node answers as the recorded files of `network` say: the answers it served, errors included. */
    function answerRecorded(network: Network): void {
      stateNode.answers.server_info = recorded(network, 'server_info');
      stateNode.answers.feature = recorded(network, 'feature');
      stateNode.answers.ledger_entry = ledgerEntries({
        [AMENDMENTS_OBJECT_INDEX]: recorded(network, 'amendments'),
        [NEGATIVE_UNL_OBJECT_INDEX]: recorded(network, 'negative_unl'),
        [FEE_SETTINGS_OBJECT_INDEX]: recorded(network, 'fee_settings'),
      });
    }

    /** The worker with the answers of `network`; the loops of the state are off unless the test turns them on. */
    async function bootState(
      o: { network?: Network; worker?: ValidatorsAppOptions['worker']; answers?: boolean } = {},
    ): Promise<ValidatorsApp> {
      const network = o.network ?? 'xrpl';
      if (o.answers !== false) answerRecorded(network);
      const app = await startValidatorsApp({
        clickhouse: db.config,
        node: stateNode,
        web,
        profile: getNetworkProfile(network),
        worker: {
          logger: { log: () => undefined, warn: (line: string) => void warnings.push(line), error: () => undefined },
          nodeRequestTimeoutMs: 500,
          ...o.worker,
          start: { unl: false, domains: false, state: false, ...o.worker?.start },
        },
      });
      apps.push(app);
      return app;
    }

    interface StateRow {
      ledger_index: number;
      ledger_hash: string;
      polled_ms: number | string;
      amendments: string[];
      majority_ids: string[];
      majority_since: number[];
      nunl_keys: string[];
      nunl_first: number[];
      to_disable: string;
      to_reenable: string;
      base_fee: string;
      reserve_base: string;
      reserve_inc: string;
      node_quorum: number;
    }

    const stateRows = () =>
      db.ch.query<StateRow>(
        `SELECT ledger_index, ledger_hash, toUnixTimestamp64Milli(polled_at) AS polled_ms, amendments,
                arrayMap(m -> tupleElement(m, 'amendment'), majorities) AS majority_ids,
                arrayMap(m -> toUnixTimestamp(tupleElement(m, 'since')), majorities) AS majority_since,
                arrayMap(v -> tupleElement(v, 'validation_public_key'), negative_unl) AS nunl_keys,
                arrayMap(v -> tupleElement(v, 'first_ledger'), negative_unl) AS nunl_first,
                to_disable, to_reenable, toString(base_fee) AS base_fee, toString(reserve_base) AS reserve_base,
                toString(reserve_inc) AS reserve_inc, node_quorum
           FROM ${Table.NetworkState} ORDER BY ledger_index, polled_at`,
      );

    interface FeatureRow {
      amendment_id: string;
      name: string;
      supported: number;
      polled_ms: number | string;
    }

    const featureRows = () =>
      db.ch.query<FeatureRow>(
        `SELECT amendment_id, name, supported, toUnixTimestamp64Milli(polled_at) AS polled_ms
           FROM ${Table.AmendmentFeatures} ORDER BY amendment_id, polled_at`,
      );

    /** How often the worker counted `outcome` for the request of the node. */
    async function polled(app: ValidatorsApp, request: string, outcome: string): Promise<number> {
      const { values } = await app.metrics.validatorsNodePollsTotal.get();
      return values
        .filter((v) => v.labels.request === request && v.labels.outcome === outcome)
        .reduce((n, v) => n + v.value, 0);
    }

    const gauge = async (app: ValidatorsApp) => (await app.metrics.amendmentsWithoutMetadata.get()).values[0]?.value;

    describe('the ledger state', () => {
      it('writes one network_state row at the ledger the node answered, from the answers recorded from the XRPL', async () => {
        const app = await bootState();
        const before = Date.now();
        expect(await app.state.pollState()).toBe(true);
        const after = Date.now();

        const amendments = recorded('xrpl', 'amendments');
        const rows = await stateRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          ledger_index: 107760758,
          ledger_hash: '75B3F5DE8A04C31028C08CD612921551DEA6B16C3F3203D0F2B509221830EF19',
          amendments: amendments.node.Amendments,
          majority_ids: ['98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76'],
          majority_since: [844853670 + 946684800],
          nunl_keys: [],
          nunl_first: [],
          to_disable: '',
          to_reenable: '',
          base_fee: '10',
          reserve_base: '1000000',
          reserve_inc: '200000',
          node_quorum: 28,
        });
        expect(Number(rows[0].polled_ms)).toBeGreaterThanOrEqual(before);
        expect(Number(rows[0].polled_ms)).toBeLessThanOrEqual(after);
      });

      it('asks for the Amendments object at the validated ledger and for the other objects at that ledger', async () => {
        const app = await bootState();
        await app.state.pollState();
        const asked = stateNode.requests.filter((r) => r.command === 'ledger_entry');
        expect(asked).toHaveLength(3);
        expect(asked.find((r) => r.index === AMENDMENTS_OBJECT_INDEX)).toMatchObject({ ledger_index: 'validated' });
        for (const index of [NEGATIVE_UNL_OBJECT_INDEX, FEE_SETTINGS_OBJECT_INDEX]) {
          expect(asked.find((r) => r.index === index)).toMatchObject({ ledger_index: 107760758 });
        }
        expect(stateNode.requests.filter((r) => r.command === 'server_info')).toHaveLength(2); // the boot check, and the poll
        for (const request of ['amendments', 'negative_unl', 'fee_settings', 'server_info']) {
          expect(await polled(app, request, 'ok')).toBe(1);
          expect(await polled(app, request, 'error')).toBe(0);
        }
      });

      it('reads the disabled validator and the two majorities from the answers recorded from Xahau', async () => {
        const app = await bootState({ network: 'xahau' });
        expect(await app.state.pollState()).toBe(true);
        const [row] = await stateRows();
        expect(row).toMatchObject({
          ledger_index: 26633715,
          nunl_keys: ['nHUqZcdCzkccxHQJp43M7nTTbHDbj2Yv9R1ty8zM1zFbtQFPnDu7'],
          nunl_first: [26615296],
          to_disable: '',
          to_reenable: '',
          majority_ids: [
            '2339E37C9DCD516CABC37FE91C4BBBFBA3EA152FD45331C3C18F183129AEF65F',
            '6902B1DEAFD9C05D0E897EBEF5A5F7C563D1F9681EA957C4C6B0874C8E009E1A',
          ],
          majority_since: [845332143 + 946684800, 845352140 + 946684800],
          base_fee: '10',
          node_quorum: 0,
        });
        expect(row.amendments).toHaveLength(75);
      });

      it('writes empty arrays when the node says entryNotFound for the NegativeUNL, and counts that request as ok', async () => {
        const app = await bootState();
        expect(recorded('xrpl', 'negative_unl')).toMatchObject({ error: 'entryNotFound', status: 'error' });
        await app.state.pollState();
        const [row] = await stateRows();
        expect(row).toMatchObject({ nunl_keys: [], nunl_first: [], to_disable: '', to_reenable: '' });
        expect(await polled(app, 'negative_unl', 'ok')).toBe(1);
        expect(await polled(app, 'negative_unl', 'error')).toBe(0);
      });

      it('writes the validators to disable and to re-enable in base58, and reads the legacy fees', async () => {
        const app = await bootState();
        // hand-written answers (not recorded): the form of a ledger before the XRPFees amendment, with a pending change
        const key = recorded('xahau', 'negative_unl').node.DisabledValidators[0].DisabledValidator.PublicKey;
        stateNode.answers.ledger_entry = ledgerEntries({
          [AMENDMENTS_OBJECT_INDEX]: recorded('xrpl', 'amendments'),
          [NEGATIVE_UNL_OBJECT_INDEX]: { ledger_index: 107760758, node: { ValidatorToDisable: key } },
          [FEE_SETTINGS_OBJECT_INDEX]: {
            ledger_index: 107760758,
            node: { BaseFee: '000000000000000A', ReserveBase: 10000000, ReserveIncrement: 2000000 },
          },
        });
        expect(await app.state.pollState()).toBe(true);
        const [row] = await stateRows();
        expect(row).toMatchObject({
          to_disable: 'nHUqZcdCzkccxHQJp43M7nTTbHDbj2Yv9R1ty8zM1zFbtQFPnDu7',
          to_reenable: '',
          base_fee: '10',
          reserve_base: '10000000',
          reserve_inc: '2000000',
        });
      });

      it('writes no row, and counts an error, when server_info does not answer in time; the next poll is the retry', async () => {
        const app = await bootState();
        stateNode.answers.server_info = () => NODE_SILENCE;
        expect(await app.state.pollState()).toBe(false);
        expect(await stateRows()).toEqual([]);
        expect(await polled(app, 'server_info', 'error')).toBe(1);
        expect(await polled(app, 'server_info', 'ok')).toBe(0);
        // the others were answered and counted all the same
        for (const request of ['amendments', 'negative_unl', 'fee_settings']) {
          expect(await polled(app, request, 'ok')).toBe(1);
        }
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('server_info');

        stateNode.answers.server_info = recorded('xrpl', 'server_info');
        expect(await app.state.pollState()).toBe(true);
        expect(await stateRows()).toHaveLength(1);
        expect(await polled(app, 'server_info', 'ok')).toBe(1);
      });

      it('writes no row when the node answers the Amendments object with an error, and asks for nothing else', async () => {
        const app = await bootState();
        stateNode.answers.ledger_entry = ledgerEntries({});
        stateNode.requests.length = 0;
        expect(await app.state.pollState()).toBe(false);
        expect(await stateRows()).toEqual([]);
        expect(stateNode.requests.map((r) => r.command)).toEqual(['ledger_entry']);
        expect(await polled(app, 'amendments', 'error')).toBe(1);
        expect(warnings).toEqual([expect.stringContaining('entryNotFound')]);
      });

      it('writes no row when the FeeSettings object is not there: it always is', async () => {
        const app = await bootState();
        stateNode.answers.ledger_entry = ledgerEntries({
          [AMENDMENTS_OBJECT_INDEX]: recorded('xrpl', 'amendments'),
          [NEGATIVE_UNL_OBJECT_INDEX]: recorded('xrpl', 'negative_unl'),
        });
        expect(await app.state.pollState()).toBe(false);
        expect(await stateRows()).toEqual([]);
        expect(await polled(app, 'fee_settings', 'error')).toBe(1);
        expect(await polled(app, 'negative_unl', 'ok')).toBe(1);
      });

      it('writes a row for every poll, one per ledger answered', async () => {
        const app = await bootState();
        await app.state.pollState();
        const next = { ...recorded('xrpl', 'amendments'), ledger_index: 107760800 };
        stateNode.answers.ledger_entry = ledgerEntries({
          [AMENDMENTS_OBJECT_INDEX]: next,
          [NEGATIVE_UNL_OBJECT_INDEX]: recorded('xrpl', 'negative_unl'),
          [FEE_SETTINGS_OBJECT_INDEX]: recorded('xrpl', 'fee_settings'),
        });
        await app.state.pollState();
        expect((await stateRows()).map((r) => r.ledger_index)).toEqual([107760758, 107760800]);
      });
    });

    describe('the features', () => {
      it('writes an amendment_features row for each amendment of the answer recorded from the XRPL', async () => {
        const app = await bootState();
        const before = Date.now();
        expect(await app.state.pollFeatures()).toBe(true);
        const after = Date.now();

        const features = recorded('xrpl', 'feature').features;
        const rows = await featureRows();
        expect(rows).toHaveLength(115);
        expect(rows.map((r) => r.amendment_id)).toEqual(Object.keys(features).sort());
        for (const row of rows) {
          expect(row.name).toBe(features[row.amendment_id].name);
          expect(row.supported).toBe(features[row.amendment_id].supported ? 1 : 0);
          expect(Number(row.polled_ms)).toBeGreaterThanOrEqual(before);
          expect(Number(row.polled_ms)).toBeLessThanOrEqual(after);
        }
        expect(rows.filter((r) => r.supported === 0)).toHaveLength(11);
        expect(await polled(app, 'feature', 'ok')).toBe(1);
        // the answer of the node is all there is: nothing asked besides `feature`
        expect(stateNode.requests.filter((r) => r.command !== 'server_info')).toEqual([
          expect.objectContaining({ command: 'feature' }),
        ]);
      });

      it('keeps an amendment the node has no name for, with an empty name', async () => {
        const app = await bootState();
        stateNode.answers.feature = {
          features: { [NO_METADATA]: { enabled: false, supported: false }, [NAMED]: { name: 'X', supported: true } },
        };
        await app.state.pollFeatures();
        expect(await featureRows()).toEqual([
          expect.objectContaining({ amendment_id: NAMED, name: 'X', supported: 1 }),
          expect.objectContaining({ amendment_id: NO_METADATA, name: '', supported: 0 }),
        ]);
      });

      it('writes nothing, and counts an error, when the feature request fails', async () => {
        const app = await bootState();
        stateNode.answers.feature = () => NODE_SILENCE;
        expect(await app.state.pollFeatures()).toBe(false);
        expect(await featureRows()).toEqual([]);
        expect(await polled(app, 'feature', 'error')).toBe(1);
      });
    });

    describe('the gauge of the amendments without metadata', () => {
      it('is 1 for an amendment the metadata does not name, with one warning, not repeated on the next poll', async () => {
        const app = await bootState();
        stateNode.answers.feature = {
          features: {
            [NAMED]: { name: 'RequireFullyCanonicalSig', enabled: true, supported: true },
            [NO_METADATA]: { enabled: false, supported: false },
          },
        };
        await app.state.pollFeatures();
        await app.state.updateMetadataGauge();
        expect(await gauge(app)).toBe(1);
        expect(warnings).toEqual([`amendment ${NO_METADATA} has no metadata entry`]);

        await app.state.pollFeatures();
        await app.state.updateMetadataGauge();
        expect(await gauge(app)).toBe(1);
        expect(warnings).toHaveLength(1);
      });

      it('is 0 for the amendments recorded from the XRPL and from Xahau, which the shipped metadata all names', async () => {
        for (const network of ['xrpl', 'xahau'] as const) {
          warnings.length = 0;
          const app = await bootState({ network });
          await app.state.pollState();
          await app.state.pollFeatures();
          await app.state.updateMetadataGauge();
          expect(await gauge(app)).toBe(0);
          expect(warnings).toEqual([]);
          await app.stop();
          apps = apps.filter((a) => a !== app);
          await db.ch.command(`TRUNCATE TABLE ${Table.NetworkState}`);
          await db.ch.command(`TRUNCATE TABLE ${Table.AmendmentFeatures}`);
        }
        // the same, worked out from the metadata and the recorded answers
        for (const network of ['xrpl', 'xahau'] as const) {
          const byId = loadAmendmentsConfig(getNetworkProfile(network)).byId;
          const seen = [
            ...Object.keys(recorded(network, 'feature').features),
            ...recorded(network, 'amendments').node.Amendments,
          ];
          expect(seen.filter((id) => !byId.has(id))).toEqual([]);
        }
      });

      it('reads the newest rows of the features, the state and the tallies, and nothing older', async () => {
        const app = await bootState();
        const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => String(n).repeat(64));
        const [OLD_FEATURE, NEW_FEATURE, OLD_ENABLED, NEW_ENABLED, NEW_MAJORITY, OLD_ROUND, NEW_ROUND] = ids;
        const OLD_VERSION = ids[0].replace(/1/g, '9');
        // recent times: `network_state` keeps its rows 100 days, and a row older than that is not kept at all
        const now = Math.floor(Date.now() / 1000);

        // two feature polls: only the newest one counts
        await db.ch.insert(Table.AmendmentFeatures, [
          { amendment_id: OLD_FEATURE, name: '', supported: 0, polled_at: now - 600.5 },
          { amendment_id: NAMED, name: 'RequireFullyCanonicalSig', supported: 1, polled_at: now - 600.5 },
          { amendment_id: NEW_FEATURE, name: '', supported: 0, polled_at: now - 0.25 },
          { amendment_id: NAMED, name: 'RequireFullyCanonicalSig', supported: 1, polled_at: now - 0.25 },
        ]);
        // two state polls: the newest ledger counts, its enabled list and its majorities
        const state = {
          ledger_hash: '',
          polled_at: now - 60.5,
          negative_unl: [],
          to_disable: '',
          to_reenable: '',
          base_fee: '10',
          reserve_base: '1000000',
          reserve_inc: '200000',
          node_quorum: 28,
        };
        await db.ch.insert(Table.NetworkState, [
          { ...state, ledger_index: 100, amendments: [OLD_ENABLED, NAMED], majorities: [] },
          {
            ...state,
            ledger_index: 200,
            amendments: [NEW_ENABLED, NAMED],
            majorities: [{ amendment: NEW_MAJORITY, since: now - 3600 }],
          },
        ]);
        // two rounds, and two versions of the newest one: the newest version of the newest round counts
        const tally = {
          close_time: 1_760_000_000,
          yes: 1,
          trusted: 1,
          threshold: 1,
          unl_size: 1,
          observed: 1,
          unl: [],
          negative_unl: [],
          base_fee: '10',
          reserve_base: '1000000',
          reserve_inc: '200000',
        };
        await db.ch.insert(Table.AmendmentTallies, [
          { ...tally, ledger_index: 255, amendment_id: OLD_ROUND, version: '1760000000100' },
          { ...tally, ledger_index: 255, amendment_id: '', version: '1760000000100' },
          { ...tally, ledger_index: 511, amendment_id: OLD_VERSION, version: '1760000000200' },
          { ...tally, ledger_index: 511, amendment_id: '', version: '1760000000200' },
          { ...tally, ledger_index: 511, amendment_id: NEW_ROUND, version: '1760000000300' },
          { ...tally, ledger_index: 511, amendment_id: NAMED_2, version: '1760000000300' },
          { ...tally, ledger_index: 511, amendment_id: '', version: '1760000000300' },
        ]);

        await app.state.updateMetadataGauge();
        expect(await gauge(app)).toBe(4);
        expect(warnings.sort()).toEqual(
          [NEW_FEATURE, NEW_ENABLED, NEW_MAJORITY, NEW_ROUND]
            .sort()
            .map((id) => `amendment ${id} has no metadata entry`),
        );
      });

      it('is 0, and quiet, when nothing is stored yet', async () => {
        const app = await bootState();
        await app.state.updateMetadataGauge();
        expect(await gauge(app)).toBe(0);
        expect(warnings).toEqual([]);
      });
    });

    describe('the loops', () => {
      it('poll the state and the features from boot, and update the gauge after the feature poll', async () => {
        const gaugeUpdates = jest.spyOn(NetworkStatePoller.prototype, 'updateMetadataGauge');
        try {
          const app = await bootState({ worker: { start: { state: true } } });
          await waitFor('the state, the features and the gauge', async () => {
            const [state, features] = await Promise.all([stateRows(), featureRows()]);
            return state.length > 0 && features.length > 0 && gaugeUpdates.mock.calls.length > 0;
          });
          await waitFor(
            'the gauge update to end',
            async () => (await gaugeUpdates.mock.results[0]?.value) === undefined,
          );
          expect(await gauge(app)).toBe(0);
          expect((await stateRows())[0].ledger_index).toBe(107760758);
          expect(await featureRows()).toHaveLength(115);
        } finally {
          gaugeUpdates.mockRestore();
        }
      });

      it('make no request when start.state is false', async () => {
        const app = await bootState();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(stateNode.requests.filter((r) => r.command !== 'server_info')).toEqual([]);
        expect(await polled(app, 'amendments', 'ok')).toBe(0);
      });
    });
  });
});

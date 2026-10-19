import {
  AMENDMENTS_OBJECT_INDEX,
  FEE_SETTINGS_OBJECT_INDEX,
  getNetworkProfile,
  LedgerWriter,
  listInUse,
  loadAmendmentsConfig,
  NEGATIVE_UNL_OBJECT_INDEX,
  NetworkStateRow,
  parseContextFor,
  Table,
  ValidationsRow,
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
import { SyncerConfig } from '../src/config/syncer.config';
import { PrometheusService } from '../src/modules/prometheus/prometheus.service';
import { ComputeTick } from '../src/validators/compute-loop';
import { NetworkStatePoller } from '../src/validators/network-state-poller';
import { RoundsJob } from '../src/validators/rounds.job';
import * as seenSeed from '../src/validators/seen-seed';
import { seedValidatorSeen } from '../src/validators/seen-seed';
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
import { syntheticChain, syntheticHash } from './synthetic-chain';

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

      it('writes no row when the node answers for another ledger than the one asked for', async () => {
        const app = await bootState({ network: 'xahau' });
        stateNode.answers.ledger_entry = ledgerEntries({
          [AMENDMENTS_OBJECT_INDEX]: recorded('xahau', 'amendments'),
          [NEGATIVE_UNL_OBJECT_INDEX]: { ...recorded('xahau', 'negative_unl'), ledger_index: 26633716 },
          [FEE_SETTINGS_OBJECT_INDEX]: recorded('xahau', 'fee_settings'),
        });
        expect(await app.state.pollState()).toBe(false);
        expect(await stateRows()).toEqual([]);
        expect(await polled(app, 'negative_unl', 'error')).toBe(1);
        expect(await polled(app, 'fee_settings', 'ok')).toBe(1);
        expect(warnings).toEqual([expect.stringMatching(/negative_unl.*26633716.*26633715/)]);
      });

      it('writes a row for every poll, one per ledger answered', async () => {
        const app = await bootState();
        await app.state.pollState();
        // the next ledger: the objects are answered for it (the NegativeUNL as before: not there)
        const at = (name: string) => ({ ...recorded('xrpl', name), ledger_index: 107760800 });
        stateNode.answers.ledger_entry = ledgerEntries({
          [AMENDMENTS_OBJECT_INDEX]: at('amendments'),
          [NEGATIVE_UNL_OBJECT_INDEX]: recorded('xrpl', 'negative_unl'),
          [FEE_SETTINGS_OBJECT_INDEX]: at('fee_settings'),
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
          await gaugeUpdates.mock.results[0].value; // the update the loop started, to its end
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
  describe('voting rounds and tallies', () => {
    const ctx = parseContextFor(getNetworkProfile('xrpl'));
    /** Voting ledgers: 256k - 1. */
    const R1 = 511;
    const R2 = 767;
    const R3 = 1023;
    /** Four validators of the test-signed list, one that is not on it, and a signing key of the first. */
    const [K1, K2, K3, K4, OUTSIDER] = ['k1', 'k2', 'k3', 'k4', 'outsider'].map((label) => testKey(`rounds-${label}`));
    const K1_SIGNING = testKey('rounds-k1-signing');
    const K2_SIGNING = testKey('rounds-k2-signing');
    const [AM_A, AM_B, AM_C, AM_D, AM_E, AM_Z] = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((x) => x.repeat(32));
    /** The ledger R2 + 1 closed two hours ago, the ledgers 4 s apart. */
    const END = nowSeconds() - 2 * 3600;
    const closeOf = (index: number): number => END + (index - (R2 + 1)) * 4;

    /** The rows the voting rounds read and write, and the ledger tables the test writes. */
    const TABLES = [
      Table.Ledgers,
      Table.LedgerByHash,
      Table.Transactions,
      Table.TxByType,
      Table.Validations,
      Table.ValidatorManifests,
      Table.ValidatorSeen,
      Table.ValidatorVotes,
      Table.AmendmentTallies,
      Table.NetworkState,
    ];

    /** The log lines of the jobs of the test. */
    let warnings: string[] = [];

    beforeEach(async () => {
      warnings = [];
      for (const table of TABLES) await db.ch.command(`TRUNCATE TABLE ${table}`);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /**
     * Writes the synthetic ledgers `first .. first + count - 1` of each group, closing at `closeTime(index)`, through the real
     * ledger writer.
     */
    async function writeLedgersClosing(
      closeTime: (index: number) => number,
      ...groups: Array<[first: number, count: number]>
    ): Promise<void> {
      const ledgers = groups.flatMap(([first, count]) =>
        syntheticChain(first, count, { closeTime }).map((ledger) => ledger.raw),
      );
      await new LedgerWriter(db.ch, ctx).write(ledgers);
    }

    /** The same, closing as the chain of the tests does: 4 s apart, ending two hours ago. */
    const writeLedgers = (...groups: Array<[first: number, count: number]>) => writeLedgersClosing(closeOf, ...groups);

    /** The ledgers around the voting ledgers R1 and R2. */
    const writeBaseLedgers = () => writeLedgers([R1 - 1, 3], [R2 - 1, 3]);

    /** A validation of `ledger` (of the hash of the synthetic ledger unless `hash` says another) as the collector stores it. */
    async function validate(
      key: string,
      ledger: number,
      o: {
        amendments?: string[];
        full?: boolean;
        hash?: string;
        signing?: string;
        at?: number;
        baseFee?: string;
        reserveBase?: string;
        reserveInc?: string;
        serverVersion?: string;
      } = {},
    ): Promise<void> {
      const at = o.at ?? closeOf(ledger) + 3.5;
      const row: ValidationsRow = {
        ledger_hash: o.hash ?? syntheticHash(ledger),
        validation_public_key: key,
        count: 1,
        first_datetime: at,
        last_datetime: at,
        ledger_index: ledger,
        reporter_public_key: '',
        ephemeral_public_key: o.signing ?? '',
        signature: '',
        signing_time: 0,
        flags: 0,
        full: o.full === false ? 0 : 1,
        amendments: o.amendments === undefined || o.amendments.length === 0 ? '' : JSON.stringify(o.amendments),
        base_fee: o.baseFee ?? null,
        load_fee: null,
        reserve_base: o.reserveBase ?? null,
        reserve_inc: o.reserveInc ?? null,
        server_version: o.serverVersion ?? null,
      };
      await db.ch.insert(Table.Validations, [row]);
    }

    /** The four validators of the list each send a full validation of `ledger` that votes for `amendments`. */
    async function validateAll(ledger: number, amendments: string[]): Promise<void> {
      for (const key of [K1, K2, K3, K4]) await validate(key.base58, ledger, { amendments });
    }

    /** A `SetFee` pseudo-transaction in `ledger`, in `transactions` and in its index. */
    async function seedSetFee(ledger: number, fields: Record<string, unknown>): Promise<void> {
      const account = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';
      await db.ch.insert(Table.Transactions, [
        {
          ledger_index: ledger,
          tx_index: 0,
          hash: syntheticHash(ledger, 'setfee'),
          tx_type: 'SetFee',
          result: 'tesSUCCESS',
          account,
          sequence: 0,
          fee: 0,
          close_time: closeOf(ledger),
          tx_json: JSON.stringify({ TransactionType: 'SetFee', Account: account, Fee: '0', Sequence: 0, ...fields }),
          meta_json: '{}',
        },
      ]);
      await db.ch.insert(Table.TxByType, [
        { tx_type: 'SetFee', ledger_index: ledger, tx_index: 0, result: 'tesSUCCESS' },
      ]);
    }

    const networkState = (ledger: number, over: Partial<NetworkStateRow> = {}): NetworkStateRow => ({
      ledger_index: ledger,
      ledger_hash: '',
      polled_at: closeOf(ledger) + 1,
      amendments: [],
      majorities: [],
      negative_unl: [],
      to_disable: '',
      to_reenable: '',
      base_fee: '10',
      reserve_base: '1000000',
      reserve_inc: '200000',
      node_quorum: 0,
      ...over,
    });

    /** The worker, started only for its UNL loop, with `validators` on the list `https://unl.example` serves. */
    async function bootWithList(validators = [K1, K2, K3, K4]): Promise<ValidatorsApp> {
      web.serveJson(
        'unl.example',
        '/',
        makeUnlResponse({
          publisher: PUBLISHER,
          publisherSigning: SIGNING_1,
          blobs: [
            {
              blob: makeUnlBlob({
                sequence: 3,
                expiration: nowSeconds() + 30 * DAY,
                validators: validators.map((master) => ({ master })),
              }),
            },
          ],
        }),
      );
      const app = await boot(PUBLISHERS, { start: { state: false, domains: false, compute: false } });
      await firstAttempt(app, 'ok');
      return app;
    }

    /** A job of its own over the database of the test (a restart is another one). */
    function makeJob(now?: () => number): RoundsJob {
      const cfg = Object.assign(new SyncerConfig(), { unlPublishers: PUBLISHERS });
      const logger = { log: () => undefined, warn: (line: string) => void warnings.push(line), error: () => undefined };
      return new RoundsJob(db.ch, cfg, new PrometheusService(), { now, logger });
    }

    /** The tick of a job at `ms` (the clock of the job says the same), with a minute to spare. */
    const tickAt = (ms: number): ComputeTick => ({
      now: ms,
      deadline: ms + 60_000,
      signal: new AbortController().signal,
    });

    /** Runs a job now. */
    const runNow = (job: RoundsJob) => job.run(tickAt(Date.now()));

    /** Runs a job as if it were `ms` (unix milliseconds). */
    const runAt = (ms: number) => makeJob(() => ms).run(tickAt(ms));

    interface VoteOut {
      validation_public_key: string;
      ledger_hash: string;
      close_time: number;
      full: number;
      amendments: string[];
      base_fee: string | null;
      reserve_base: string | null;
      reserve_inc: string | null;
      server_version: string | null;
      version: string;
    }

    const votesOf = (ledger: number) =>
      db.ch.query<VoteOut>(
        `SELECT validation_public_key, ledger_hash, toUnixTimestamp(close_time) AS close_time, full, amendments,
                toString(base_fee) AS base_fee, toString(reserve_base) AS reserve_base, toString(reserve_inc) AS reserve_inc,
                toString(server_version) AS server_version, toString(version) AS version
           FROM ${Table.ValidatorVotes} WHERE ledger_index = {ledger:UInt32} ORDER BY validation_public_key`,
        { ledger },
      );

    interface TallyOut {
      amendment_id: string;
      close_time: number;
      yes: number;
      trusted: number;
      threshold: number;
      unl_size: number;
      observed: number;
      unl: string[];
      negative_unl: string[];
      base_fee: string;
      reserve_base: string;
      reserve_inc: string;
      version: string;
    }

    const talliesOf = (ledger: number) =>
      db.ch.query<TallyOut>(
        `SELECT amendment_id, toUnixTimestamp(close_time) AS close_time, yes, trusted, threshold, unl_size, observed, unl,
                negative_unl, toString(base_fee) AS base_fee, toString(reserve_base) AS reserve_base,
                toString(reserve_inc) AS reserve_inc, toString(version) AS version
           FROM ${Table.AmendmentTallies} WHERE ledger_index = {ledger:UInt32} ORDER BY amendment_id`,
        { ledger },
      );

    /** The amendment rows of a round as `[id, yes]`, without the sentinel. */
    const yesOf = (rows: TallyOut[]) =>
      rows.filter((row) => row.amendment_id !== '').map((row) => [row.amendment_id, row.yes]);

    const sentinelsOf = () =>
      db.ch.query<{ ledger_index: number; version: string }>(
        `SELECT ledger_index, toString(version) AS version FROM ${Table.AmendmentTallies}
          WHERE amendment_id = '' ORDER BY ledger_index, version`,
      );

    /** Each round with a sentinel and the version of its newest sentinel: the set a reader takes. */
    const currentSentinels = () =>
      db.ch.query<{ ledger_index: number; version: string }>(
        `SELECT ledger_index, toString(max(version)) AS version FROM ${Table.AmendmentTallies}
          WHERE amendment_id = '' GROUP BY ledger_index ORDER BY ledger_index`,
      );

    const currentVersionOf = async (ledger: number) =>
      (await currentSentinels()).find((row) => row.ledger_index === ledger)?.version;

    /** The votes of the round of the version of its newest sentinel. */
    const currentVotes = async (ledger: number) => {
      const version = await currentVersionOf(ledger);
      return (await votesOf(ledger)).filter((vote) => vote.version === version);
    };

    /** The tallies of the round of the version of its newest sentinel. */
    const currentTallies = async (ledger: number) => {
      const version = await currentVersionOf(ledger);
      return (await talliesOf(ledger)).filter((row) => row.version === version);
    };

    /** The sentinel of a round the ingest lacked, as the job writes it: `closeTime` is that of the first ledger above it. */
    const seedMissingRound = (round: number, closeTime: number, version = 1000) =>
      db.ch.insert(Table.AmendmentTallies, [
        {
          ledger_index: round,
          amendment_id: '',
          close_time: closeTime,
          yes: 0,
          trusted: 0,
          threshold: 1,
          unl_size: 4,
          observed: 0,
          unl: UNL_KEYS,
          negative_unl: [],
          base_fee: '0',
          reserve_base: '0',
          reserve_inc: '0',
          version,
        },
      ]);

    const lagOf = async () => (await new PrometheusService().validatorsRoundsLagLedgers.get()).values[0]?.value;

    const sorted = (keys: string[]) => [...keys].sort();

    /** What `validator_seen` holds: the first and last time and the newest ledger of each key. */
    const seenRows = async () =>
      (
        await db.ch.query<{ key: string; first_ms: number | string; last_ms: number | string; ledger: number }>(
          `SELECT validation_public_key AS key, toUnixTimestamp64Milli(min(first_seen)) AS first_ms,
                  toUnixTimestamp64Milli(max(last_seen)) AS last_ms, max(last_ledger_index) AS ledger
             FROM ${Table.ValidatorSeen} GROUP BY validation_public_key ORDER BY validation_public_key`,
        )
      ).map((r) => ({ ...r, first_ms: Number(r.first_ms), last_ms: Number(r.last_ms) }));

    const byKey = <T extends { key: string }>(rows: T[]) => [...rows].sort((a, b) => (a.key < b.key ? -1 : 1));

    const UNL_KEYS = sorted([K1, K2, K3, K4].map((key) => key.base58));

    it('writes votes and tallies of each round, sentinel last', async () => {
      await bootWithList();
      await writeBaseLedgers();
      // fees: the SetFee in force at each round (the one after R2 is not), the legacy form among them
      await seedSetFee(300, { BaseFeeDrops: '10', ReserveBaseDrops: '1000000', ReserveIncrementDrops: '200000' });
      await seedSetFee(600, {
        BaseFee: '000000000000000F',
        ReferenceFeeUnits: 10,
        ReserveBase: 20000000,
        ReserveIncrement: 5000000,
      });
      await seedSetFee(800, { BaseFeeDrops: '99', ReserveBaseDrops: '99', ReserveIncrementDrops: '99' });
      // the negative UNL of the newest state at or before each round, and the majorities of the newest state
      await db.ch.insert(Table.NetworkState, [
        networkState(400),
        networkState(700, {
          negative_unl: [{ validation_public_key: K4.base58, first_ledger: 650 }],
          majorities: [{ amendment: AM_D, since: closeOf(700) }],
        }),
      ]);
      // round 1: A has four yes, B one (K4), C is the vote of a validator that is not on the list
      for (const key of [K1, K2, K3]) await validate(key.base58, R1, { amendments: [AM_A] });
      await validate(K4.base58, R1, { amendments: [AM_A, AM_B], serverVersion: '5817044467490840576' });
      await validate(OUTSIDER.base58, R1, {
        amendments: [AM_C],
        baseFee: '12',
        reserveBase: '1000000',
        reserveInc: '200000',
      });
      // round 2: K4 is on the negative UNL, so its vote of the round does not count and its record of round 1 stays
      for (const key of [K1, K2]) await validate(key.base58, R2, { amendments: [AM_A] });
      await validate(K3.base58, R2, { amendments: [AM_A, AM_E] });
      await validate(K4.base58, R2, { amendments: [] });
      await validate(OUTSIDER.base58, R2, { amendments: [AM_A] });

      const insert = jest.spyOn(db.ch, 'insert');
      const before = Date.now();
      await runNow(makeJob());
      const after = Date.now();

      // round 1: the votes of the validators that signed the ledger, the earliest sighting's values
      const votes1 = await votesOf(R1);
      expect(votes1.map((v) => v.validation_public_key)).toEqual(
        sorted([K1, K2, K3, K4, OUTSIDER].map((k) => k.base58)),
      );
      const byKey = (votes: VoteOut[], key: string) => votes.find((v) => v.validation_public_key === key);
      expect(byKey(votes1, K4.base58)).toMatchObject({
        ledger_hash: syntheticHash(R1),
        close_time: closeOf(R1),
        full: 1,
        amendments: [AM_A, AM_B],
        base_fee: null,
        reserve_base: null,
        reserve_inc: null,
        server_version: '5817044467490840576',
      });
      expect(byKey(votes1, OUTSIDER.base58)).toMatchObject({
        amendments: [AM_C],
        base_fee: '12',
        reserve_base: '1000000',
        reserve_inc: '200000',
        server_version: null,
      });
      expect(byKey(votes1, K1.base58)?.amendments).toEqual([AM_A]);

      const tallies1 = await talliesOf(R1);
      expect(yesOf(tallies1)).toEqual([
        [AM_A, 4],
        [AM_B, 1],
        [AM_D, 0], // in a majority in the newest state, with no vote
      ]);
      const sentinel1 = tallies1.find((row) => row.amendment_id === '');
      expect(sentinel1).toMatchObject({
        close_time: closeOf(R1),
        yes: 0,
        trusted: 4,
        threshold: 3,
        unl_size: 4,
        observed: 4,
        unl: UNL_KEYS,
        negative_unl: [],
        base_fee: '10',
        reserve_base: '1000000',
        reserve_inc: '200000',
      });
      for (const row of tallies1) expect(row).toMatchObject({ trusted: 4, threshold: 3, unl_size: 4, observed: 4 });

      // round 2: K4's carried record gives A and B their votes; fees from the legacy SetFee of ledger 600
      const tallies2 = await talliesOf(R2);
      expect(yesOf(tallies2)).toEqual([
        [AM_A, 4],
        [AM_B, 1],
        [AM_D, 0],
        [AM_E, 1],
      ]);
      expect(tallies2.find((row) => row.amendment_id === '')).toMatchObject({
        close_time: closeOf(R2),
        trusted: 4,
        threshold: 3,
        unl_size: 4,
        observed: 4, // the validation of K4 was seen, though it does not count
        unl: UNL_KEYS,
        negative_unl: [K4.base58],
        base_fee: '15',
        reserve_base: '20000000',
        reserve_inc: '5000000',
      });
      const votes2 = await votesOf(R2);
      expect(votes2.map((v) => v.validation_public_key)).toEqual(
        sorted([K1, K2, K3, K4, OUTSIDER].map((k) => k.base58)),
      );

      // one version per round, shared by its votes and its tallies: wall-clock milliseconds
      for (const rows of [
        [...votes1, ...tallies1],
        [...votes2, ...tallies2],
      ]) {
        const versions = new Set(rows.map((row) => row.version));
        expect(versions.size).toBe(1);
        expect(Number([...versions][0])).toBeGreaterThanOrEqual(before);
        expect(Number([...versions][0])).toBeLessThanOrEqual(after);
      }

      // the votes go in before the tallies, and the sentinel is the last row of the tallies
      const written = insert.mock.calls
        .filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies)
        .map(
          ([table, rows]) =>
            [table, (rows as Array<{ amendment_id?: string }>).map((row) => row.amendment_id)] as const,
        );
      expect(written.map(([table]) => table)).toEqual([
        Table.ValidatorVotes,
        Table.AmendmentTallies,
        Table.ValidatorVotes,
        Table.AmendmentTallies,
      ]);
      for (const [table, ids] of written) {
        if (table !== Table.AmendmentTallies) continue;
        expect(ids[ids.length - 1]).toBe('');
        expect(ids.filter((id) => id === '')).toHaveLength(1);
      }

      // nothing is behind: the newest committed voting ledger is the newest stored round
      expect(await lagOf()).toBe(0);
      expect(warnings).toEqual([]);
    });

    it('takes the fees of the newest ledger state when the index holds no SetFee', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await db.ch.insert(Table.NetworkState, [
        networkState(900, { base_fee: '11', reserve_base: '1100000', reserve_inc: '210000' }),
      ]);
      await validateAll(R1, [AM_A]);
      await validateAll(R2, [AM_A]);

      await runNow(makeJob());

      for (const round of [R1, R2]) {
        expect((await talliesOf(round)).find((row) => row.amendment_id === '')).toMatchObject({
          base_fee: '11',
          reserve_base: '1100000',
          reserve_inc: '210000',
        });
      }
    });

    it('counts a vote recorded under the signing key for its master', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await db.ch.insert(Table.ValidatorManifests, [
        { ephemeral_key: K1_SIGNING.base58, master_key: K1.base58, seq: 2, domain: '', manifest: '', source: 'stream' },
        { ephemeral_key: K2_SIGNING.base58, master_key: K2.base58, seq: 1, domain: '', manifest: '', source: 'stream' },
      ]);
      // K1 was recorded under its signing key before the manifest was known
      await validate(K1_SIGNING.base58, R1, { amendments: [AM_A], signing: K1_SIGNING.base58 });
      // K2 under both, the signing key first: the earliest sighting's values are the vote
      await validate(K2_SIGNING.base58, R1, { amendments: [AM_A], at: closeOf(R1) + 2 });
      await validate(K2.base58, R1, { amendments: [AM_B], at: closeOf(R1) + 4 });
      await validate(K3.base58, R1, { amendments: [AM_A] });
      await validate(K4.base58, R1, { amendments: [AM_A] });

      await runNow(makeJob());

      const votes = await votesOf(R1);
      expect(votes.map((v) => v.validation_public_key)).toEqual(sorted([K1, K2, K3, K4].map((k) => k.base58)));
      expect(votes.find((v) => v.validation_public_key === K2.base58)?.amendments).toEqual([AM_A]);
      const tallies = await talliesOf(R1);
      expect(yesOf(tallies)).toEqual([[AM_A, 4]]);
      expect(tallies.find((row) => row.amendment_id === '')).toMatchObject({ trusted: 4, observed: 4 });
    });

    it('ignores validations of another hash at V', async () => {
      await bootWithList();
      await writeBaseLedgers();
      // all four validated a ledger of another hash at the voting ledger, with other votes
      for (const key of [K1, K2, K3, K4]) {
        await validate(key.base58, R1, { amendments: [AM_B, AM_C], hash: 'E'.repeat(64) });
      }
      // only K1 validated the ledger that was ingested
      await validate(K1.base58, R1, { amendments: [AM_A] });

      await runNow(makeJob());

      expect((await votesOf(R1)).map((v) => [v.validation_public_key, v.ledger_hash, v.amendments])).toEqual([
        [K1.base58, syntheticHash(R1), [AM_A]],
      ]);
      const tallies = await talliesOf(R1);
      expect(yesOf(tallies)).toEqual([[AM_A, 1]]);
      expect(tallies.find((row) => row.amendment_id === '')).toMatchObject({
        trusted: 1,
        threshold: 1,
        unl_size: 4,
        observed: 1,
      });
      expect(warnings).toContain('round 511: recorded 1 of 4 UNL validations, below quorum 4');
    });

    it('writes an observed-0 sentinel for a voting ledger the ingest lacks', async () => {
      await bootWithList();
      // the ledgers around R1 and R3, none of R2
      await writeLedgers([R1 - 1, 3], [R3 - 1, 3]);
      await db.ch.insert(Table.NetworkState, [networkState(400)]);
      await validateAll(R1, [AM_A]);
      // K4 does not validate round 3
      for (const key of [K1, K2, K3]) await validate(key.base58, R3, { amendments: [AM_B] });

      await runNow(makeJob());

      expect(await votesOf(R2)).toEqual([]);
      const gap = await talliesOf(R2);
      expect(gap).toEqual([
        {
          amendment_id: '',
          // the first committed ledger above R2
          close_time: closeOf(R3 - 1),
          yes: 0,
          trusted: 0,
          threshold: 1,
          unl_size: 4,
          observed: 0,
          unl: UNL_KEYS,
          negative_unl: [],
          base_fee: '10',
          reserve_base: '1000000',
          reserve_inc: '200000',
          version: expect.any(String),
        },
      ]);
      expect(warnings).toContain('round 767: recorded 0 of 4 UNL validations, below quorum 4');
      // the round after it builds on the records of the first (within 24 h): K4's is the only one it has
      const tallies3 = await talliesOf(R3);
      expect(yesOf(tallies3)).toEqual([
        [AM_A, 1],
        [AM_B, 3],
      ]);
      expect(tallies3.find((row) => row.amendment_id === '')).toMatchObject({ trusted: 4, threshold: 3, observed: 3 });
      expect(warnings).toContain('round 1023: recorded 3 of 4 UNL validations, below quorum 4');
      expect((await sentinelsOf()).map((row) => row.ledger_index)).toEqual([R1, R2, R3]);
    });

    it('resumes from the newest stored round after a restart', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      await validateAll(R2, [AM_A]);

      // the first run is at a time when only round 1 is ready: 120 s after it closed
      await runAt((closeOf(R1) + 600) * 1000);
      const afterFirst = await sentinelsOf();
      expect(afterFirst.map((row) => row.ledger_index)).toEqual([R1]);
      // round 2 is on its way: the newest committed voting ledger (R2) is 256 ahead
      expect(await lagOf()).toBe(256);

      // a new job instance (a restart) writes the next round only, and leaves the first alone
      const insert = jest.spyOn(db.ch, 'insert');
      await runNow(makeJob());
      const written = insert.mock.calls.flatMap(([table, rows]) =>
        table === Table.AmendmentTallies
          ? (rows as Array<{ ledger_index: number }>).map((row) => row.ledger_index)
          : [],
      );
      expect(new Set(written)).toEqual(new Set([R2]));
      const afterSecond = await sentinelsOf();
      expect(afterSecond.map((row) => row.ledger_index)).toEqual([R1, R2]);
      expect(afterSecond[0]).toEqual(afterFirst[0]);
      expect(await lagOf()).toBe(0);

      // and with nothing new, a job writes nothing
      insert.mockClear();
      await runNow(makeJob());
      expect(
        insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
      ).toEqual([]);
    });

    describe('which rounds', () => {
      const rounds = async () => (await sentinelsOf()).map((row) => row.ledger_index);

      it('waits until 120 s after the voting ledger closed', async () => {
        await bootWithList();
        await writeBaseLedgers();
        await validateAll(R1, [AM_A]);

        await runAt((closeOf(R1) + 119) * 1000);
        expect(await rounds()).toEqual([]);
        await runAt((closeOf(R1) + 120) * 1000);
        expect(await rounds()).toEqual([R1]);
      });

      it('waits for the ingest to reach the voting ledger', async () => {
        await bootWithList();
        await writeLedgers([R1 - 1, 2]); // 510 and 511, nothing above
        await validateAll(R1, [AM_A]);
        await runNow(makeJob());
        // the voting ledger itself is committed: it is a round
        expect(await rounds()).toEqual([R1]);
        // the next voting ledger is not there at all
        await runNow(makeJob());
        expect(await rounds()).toEqual([R1]);
      });

      it('starts at the first voting ledger at or after the lowest ledger of the oldest validations', async () => {
        await bootWithList();
        await writeBaseLedgers();
        // validations of round 2 only, and a record of one with no ledger index, which says nothing
        await validateAll(R2, [AM_A]);
        await validate(K1.base58, 0, { hash: 'D'.repeat(64) });

        await runNow(makeJob());

        expect(await rounds()).toEqual([R2]);
      });

      it('takes the lowest ledger of the oldest partition of validations, not of all of them', async () => {
        await bootWithList();
        await writeBaseLedgers();
        // received two days ago: the oldest partition, holding round 2 only; today's holds round 1 (a late arrival)
        await validateAll(R2, [AM_A]);
        for (const key of [K1, K2, K3, K4]) {
          await validate(key.base58, R2, { amendments: [AM_A], at: END - 2 * DAY });
        }
        await validate(K1.base58, R1, { amendments: [AM_A] });

        await runNow(makeJob());

        expect(await rounds()).toEqual([R2]);
      });

      it('starts no earlier than the first ledger the ingest holds', async () => {
        await bootWithList();
        // the ingest began after round 1: 512 is the lowest ledger
        await writeLedgers([R1 + 1, 2], [R2 - 1, 3]);
        await validateAll(R1, [AM_A]);
        await validateAll(R2, [AM_A]);

        await runNow(makeJob());

        expect(await rounds()).toEqual([R2]);
      });

      it('does nothing while there are no validations or no ledgers', async () => {
        await bootWithList();
        const insert = jest.spyOn(db.ch, 'insert');
        await runNow(makeJob()); // neither
        await writeBaseLedgers();
        await runNow(makeJob()); // ledgers only
        await validateAll(R1, [AM_A]);
        await db.ch.command(`TRUNCATE TABLE ${Table.Ledgers}`);
        const probes = jest.spyOn(db.ch, 'queryOne');
        await runNow(makeJob()); // validations only
        // the ingest is asked first, and without ledgers the partitions of validations are left alone
        const asked = probes.mock.calls.map(([sql]) => String(sql));
        expect(asked.some((sql) => sql.includes(Table.Ledgers))).toBe(true);
        expect(
          asked.filter((sql) => sql.includes('system.parts') || sql.includes(`FROM ${Table.Validations}`)),
        ).toEqual([]);
        expect(await rounds()).toEqual([]);
        expect(
          insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
        ).toEqual([]);
      });

      it('stops starting rounds at the deadline of the tick', async () => {
        await bootWithList();
        await writeBaseLedgers();
        await validateAll(R1, [AM_A]);
        await validateAll(R2, [AM_A]);
        // a clock that moves a second each time it is read: the deadline is passed after the first round
        const start = Date.now();
        let reads = 0;
        const job = makeJob(() => start + 1000 * reads++);

        await job.run({ now: start, deadline: start + 500, signal: new AbortController().signal });

        expect(await rounds()).toEqual([R1]);
        // the lag shows the round that is left
        expect(await lagOf()).toBe(256);
        // the next tick goes on with it
        await runNow(makeJob());
        expect(await rounds()).toEqual([R1, R2]);
      });
    });

    describe('a voting ledger that arrives late', () => {
      /** The tallies that were inserted, as `[round, ...]` in the order of the inserts. */
      const talliesWritten = (insert: jest.SpyInstance) =>
        insert.mock.calls.flatMap(([table, rows]) =>
          table === Table.AmendmentTallies ? [(rows as Array<{ ledger_index: number }>)[0].ledger_index] : [],
        );

      it('redoes the round with its votes, and the rounds after it that carry from it, each as a newer version', async () => {
        await bootWithList();
        // the ingest has the ledgers around rounds 1 and 3, and not round 2 yet
        await writeLedgers([R1 - 1, 3], [R3 - 1, 3]);
        await validateAll(R1, [AM_A]);
        await validateAll(R2, [AM_B]); // the validations of round 2 were recorded all the same
        for (const key of [K1, K2, K3]) await validate(key.base58, R3, { amendments: [AM_C] }); // K4 sends none in round 3
        await runNow(makeJob());

        const first = await currentSentinels();
        expect(first.map((row) => row.ledger_index)).toEqual([R1, R2, R3]);
        expect(await currentVotes(R2)).toEqual([]);
        expect((await currentTallies(R2))[0]).toMatchObject({
          amendment_id: '',
          observed: 0,
          trusted: 0,
          close_time: closeOf(R3 - 1),
        });
        // round 3 as it was first done: the record of K4 is the one of round 1
        expect(yesOf(await currentTallies(R3))).toEqual([
          [AM_A, 1],
          [AM_C, 3],
        ]);

        // the ledger arrives
        await writeLedgers([R2 - 1, 3]);
        const insert = jest.spyOn(db.ch, 'insert');
        await runNow(makeJob());

        const second = await currentSentinels();
        expect(second.map((row) => row.ledger_index)).toEqual([R1, R2, R3]);
        // round 1 is not touched, rounds 2 and 3 are new versions
        expect(second[0]).toEqual(first[0]);
        expect(Number(second[1].version)).toBeGreaterThan(Number(first[1].version));
        expect(Number(second[2].version)).toBeGreaterThan(Number(first[2].version));
        // round 2 has its votes and the close time of its own ledger
        const votes2 = await currentVotes(R2);
        expect(votes2.map((v) => v.validation_public_key)).toEqual(UNL_KEYS);
        expect(votes2.every((v) => v.ledger_hash === syntheticHash(R2) && v.close_time === closeOf(R2))).toBe(true);
        const tallies2 = await currentTallies(R2);
        expect(yesOf(tallies2)).toEqual([[AM_B, 4]]);
        expect(tallies2.find((row) => row.amendment_id === '')).toMatchObject({
          close_time: closeOf(R2),
          trusted: 4,
          observed: 4,
        });
        // round 3 with the corrected carry: K4's record is now the one of round 2
        expect(yesOf(await currentTallies(R3))).toEqual([
          [AM_B, 1],
          [AM_C, 3],
        ]);
        // the rounds after the late one first and the late one last: a run cut short leaves it to be done again
        expect(talliesWritten(insert)).toEqual([R3, R2]);

        // the late round is not a candidate any more
        insert.mockClear();
        await runNow(makeJob());
        expect(
          insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
        ).toEqual([]);
      });

      describe('a gap of two voting ledgers', () => {
        const R4 = 1279;
        const R5 = 1535;
        /** The first ledger after the gap. */
        const AFTER_GAP = 800;
        let closeAt!: (index: number) => number;
        let first: Array<{ ledger_index: number; version: string }>;

        /**
         * Rounds 1 and 2 are missing from the ingest, with ledger 800 the first one after them (so both sentinels carry its close
         * time, 3 500 s after round 1). Round 3 closes 4 000 s after round 1 and nobody validated its ledger: it is real, with
         * nothing observed and nothing trusted. Round 4 closes 40 000 s after round 1, within 24 h of both late rounds. Round 5
         * closes at 87 400 s: past the 24 h window of round 1, inside that of round 2. K4 votes in rounds 1 and 2 only. Run once,
         * with the gap.
         */
        async function gapOfTwo(): Promise<void> {
          const base = nowSeconds() - 3 * DAY;
          const closes = new Map([
            [255, base - 1000],
            [R1, base],
            [R2, base + 3000],
            [AFTER_GAP, base + 3500],
            [R3, base + 4000],
            [R4, base + 40_000],
            [R5, base + 87_400],
          ]);
          closeAt = (index) => closes.get(index) ?? base - 5000;
          const validateAt = (
            key: TestKey,
            ledger: number,
            amendments: string[],
            over: { full?: boolean; hash?: string } = {},
          ) => validate(key.base58, ledger, { amendments, at: (closes.get(ledger) ?? base) + 3.5, ...over });
          await bootWithList();
          await writeLedgersClosing(closeAt, [255, 1], [AFTER_GAP, 1], [R3, 1], [R4, 1], [R5, 1]);
          await validateAt(K1, 255, [], { full: false }); // there, to start from, and no record
          for (const key of [K1, K2, K3, K4]) await validateAt(key, R1, [AM_A]);
          for (const key of [K1, K2, K3, K4]) await validateAt(key, R2, [AM_B]);
          await validateAt(K1, R3, [AM_C], { hash: 'E'.repeat(64) }); // a ledger that was not ingested
          for (const key of [K1, K2, K3]) await validateAt(key, R4, [AM_C]);
          for (const key of [K1, K2, K3]) await validateAt(key, R5, [AM_D]);
          await runNow(makeJob());
          first = await currentSentinels();
          expect(first.map((row) => row.ledger_index)).toEqual([255, R1, R2, R3, R4, R5]);
          // both are sealed with the close time of the ledger after the gap
          for (const round of [R1, R2]) {
            expect((await currentTallies(round))[0]).toMatchObject({
              observed: 0,
              trusted: 0,
              close_time: closeAt(AFTER_GAP),
            });
          }
          // round 3 is sealed too, with its own close time; K4 has no record in rounds 4 and 5
          expect((await currentTallies(R3))[0]).toMatchObject({ observed: 0, trusted: 0, close_time: closeAt(R3) });
          for (const round of [R4, R5]) {
            expect((await currentTallies(round)).find((row) => row.amendment_id === '')?.trusted).toBe(3);
          }
        }

        /** The ledgers of the gap arrive. */
        const gapFilled = () => writeLedgersClosing(closeAt, [R1, 1], [R2, 1]);

        /** Every round of the gap and after it has the votes it should, K4's record being that of round 2 from then on. */
        async function expectRoundsRight(): Promise<void> {
          const sentinelOf = async (round: number) =>
            (await currentTallies(round)).find((row) => row.amendment_id === '');
          expect((await currentVotes(R1)).map((v) => v.validation_public_key)).toEqual(UNL_KEYS);
          expect(yesOf(await currentTallies(R1))).toEqual([[AM_A, 4]]);
          expect(await sentinelOf(R1)).toMatchObject({ close_time: closeAt(R1), trusted: 4, observed: 4 });
          expect((await currentVotes(R2)).map((v) => v.validation_public_key)).toEqual(UNL_KEYS);
          expect(yesOf(await currentTallies(R2))).toEqual([[AM_B, 4]]);
          expect(await sentinelOf(R2)).toMatchObject({ close_time: closeAt(R2), trusted: 4, observed: 4 });
          // a real round with nothing observed carries the records of the late rounds now
          expect(yesOf(await currentTallies(R3))).toEqual([[AM_B, 4]]);
          expect(await sentinelOf(R3)).toMatchObject({ close_time: closeAt(R3), trusted: 4, observed: 0 });
          expect(yesOf(await currentTallies(R4))).toEqual([
            [AM_B, 1],
            [AM_C, 3],
          ]);
          expect(await sentinelOf(R4)).toMatchObject({ trusted: 4, observed: 3 });
          // closing after round 1 by more than 24 h, and inside the 24 h of round 2
          expect(yesOf(await currentTallies(R5))).toEqual([
            [AM_B, 1],
            [AM_D, 3],
          ]);
          expect(await sentinelOf(R5)).toMatchObject({ trusted: 4, observed: 3 });
        }

        it('redoes each round with its votes, and every round between them and after them', async () => {
          await gapOfTwo();
          await gapFilled();

          await runNow(makeJob());

          await expectRoundsRight();
          const second = await currentSentinels();
          expect(second[0]).toEqual(first[0]); // before the gap
          for (const index of [1, 2, 3, 4, 5]) {
            expect(Number(second[index].version)).toBeGreaterThan(Number(first[index].version));
          }
          // nothing is left to do
          const insert = jest.spyOn(db.ch, 'insert');
          await runNow(makeJob());
          expect(
            insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
          ).toEqual([]);
        });

        it('leaves the second round a late round after the first is redone, and a run cut short between them goes on', async () => {
          await gapOfTwo();
          await gapFilled();
          const controller = new AbortController();
          const real = db.ch.insert.bind(db.ch);
          // the shutdown comes when the unit of round 1 is over
          jest.spyOn(db.ch, 'insert').mockImplementation(async (table, rows, opts) => {
            await real(table, rows, opts);
            if (table === Table.AmendmentTallies && (rows as Array<{ ledger_index: number }>)[0].ledger_index === R1) {
              controller.abort();
            }
          });

          await makeJob().run({ now: Date.now(), deadline: Date.now() + 60_000, signal: controller.signal });
          jest.restoreAllMocks();

          // round 1 has its votes; round 2 is still sealed, and so is round 5, which was not touched
          expect((await currentVotes(R1)).length).toBe(4);
          expect((await currentTallies(R2))[0]).toMatchObject({
            observed: 0,
            trusted: 0,
            close_time: closeAt(AFTER_GAP),
          });
          expect(await currentVotes(R2)).toEqual([]);
          expect((await currentTallies(R5)).find((row) => row.amendment_id === '')?.trusted).toBe(3);

          await runNow(makeJob());

          await expectRoundsRight();
        });
      });

      it('finishes the rewrite of a round that was complete once its votes are in, though the shutdown comes', async () => {
        await bootWithList();
        await writeLedgers([R1 - 1, 3], [R3 - 1, 3]);
        await validateAll(R1, [AM_A]);
        await validateAll(R2, [AM_B]);
        for (const key of [K1, K2, K3]) await validate(key.base58, R3, { amendments: [AM_C] });
        await runNow(makeJob());
        const before = await currentVersionOf(R3);
        await writeLedgers([R2 - 1, 3]);
        const controller = new AbortController();
        const real = db.ch.insert.bind(db.ch);
        // the shutdown comes right after the votes of round 3, the round after the late one, are in
        jest.spyOn(db.ch, 'insert').mockImplementation(async (table, rows, opts) => {
          await real(table, rows, opts);
          if (table === Table.ValidatorVotes && (rows as Array<{ ledger_index: number }>)[0].ledger_index === R3) {
            controller.abort();
          }
        });

        await makeJob().run({ now: Date.now(), deadline: Date.now() + 60_000, signal: controller.signal });
        jest.restoreAllMocks();

        // round 3 is complete in its new version: its sentinel is in, and a merge of the votes keeps the set it names
        const after = await currentVersionOf(R3);
        expect(Number(after)).toBeGreaterThan(Number(before));
        await db.ch.command(`OPTIMIZE TABLE ${Table.ValidatorVotes} FINAL`);
        const votes = await currentVotes(R3);
        expect(votes.map((v) => v.validation_public_key)).toEqual(sorted([K1, K2, K3].map((k) => k.base58)));
        expect(votes.every((v) => v.version === after)).toBe(true);
        // the late round, written last, is still to do
        expect((await currentTallies(R2))[0]).toMatchObject({ observed: 0, trusted: 0 });

        await runNow(makeJob());
        expect(yesOf(await currentTallies(R3))).toEqual([
          [AM_B, 1],
          [AM_C, 3],
        ]);
        expect((await currentVotes(R2)).length).toBe(4);
      });

      it('does not redo a round that was real with observed 0', async () => {
        await bootWithList();
        await writeBaseLedgers();
        // validations of another hash only: both rounds are done with nobody observed
        await validate(K1.base58, R1, { hash: 'E'.repeat(64) });
        await runNow(makeJob());
        const first = await currentSentinels();
        expect(first.map((row) => row.ledger_index)).toEqual([R1, R2]);
        expect(await currentTallies(R1)).toEqual([
          expect.objectContaining({ amendment_id: '', observed: 0, trusted: 0, close_time: closeOf(R1) }),
        ]);

        const insert = jest.spyOn(db.ch, 'insert');
        await runNow(makeJob());

        expect(
          insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
        ).toEqual([]);
        expect(await currentSentinels()).toEqual(first);
      });

      describe('older than the validations are kept', () => {
        /** A round of the ingest that was missing, now there, `days` ago, the job's sentinel of it already stored. */
        async function missingRoundArrived(days: number): Promise<void> {
          const base = nowSeconds() - days * DAY;
          await bootWithList();
          await writeLedgersClosing((index) => base + (index - R2) * 4, [R2 - 1, 3]);
          await seedMissingRound(R2, base + 4000);
          if (days < 90)
            for (const key of [K1, K2, K3, K4]) await validate(key.base58, R2, { amendments: [AM_A], at: base + 3.5 });
        }

        it('leaves a round alone whose ledger is older than that', async () => {
          await missingRoundArrived(100);
          const insert = jest.spyOn(db.ch, 'insert');
          await runNow(makeJob());
          expect(
            insert.mock.calls.filter(([table]) => table === Table.ValidatorVotes || table === Table.AmendmentTallies),
          ).toEqual([]);
          expect(await currentSentinels()).toEqual([{ ledger_index: R2, version: '1000' }]);
        });

        it('redoes one whose ledger is inside it', async () => {
          await missingRoundArrived(80);
          await runNow(makeJob());
          expect(Number((await currentSentinels())[0].version)).toBeGreaterThan(1000);
          expect((await currentTallies(R2)).find((row) => row.amendment_id === '')).toMatchObject({
            observed: 4,
            trusted: 4,
          });
          expect(yesOf(await currentTallies(R2))).toEqual([[AM_A, 4]]);
        });
      });

      it('redoes the rounds up to 86 400 s after the late ledger, and no later one', async () => {
        const base = nowSeconds() - 3 * DAY;
        // round 0 (ledger 255), then round 1 closing at `base`, round 2 exactly a day after it and round 3 a second later
        const closes = new Map([
          [255, base - 1000],
          [R1, base],
          [R2, base + 86_400],
          [R3, base + 86_401],
        ]);
        const closeAt = (index: number) => closes.get(index) ?? base - 5000;
        const validateAt = (key: TestKey, ledger: number, amendments: string[]) =>
          validate(key.base58, ledger, { amendments, at: (closes.get(ledger) ?? base) + 3.5 });
        await bootWithList();
        await writeLedgersClosing(closeAt, [255, 1], [R2, 1], [R3, 1]); // round 1 is missing
        await validateAt(K1, 255, []);
        for (const key of [K1, K2, K3, K4]) await validateAt(key, R1, [AM_A]);
        for (const key of [K1, K2, K3]) await validateAt(key, R2, [AM_B]);
        for (const key of [K1, K2, K3]) await validateAt(key, R3, [AM_B]);
        await runNow(makeJob());
        const first = await currentSentinels();
        expect(first.map((row) => row.ledger_index)).toEqual([255, R1, R2, R3]);
        expect((await currentTallies(R2)).find((row) => row.amendment_id === '')?.trusted).toBe(3);

        await writeLedgersClosing(closeAt, [R1, 1]);
        await runNow(makeJob());

        const second = await currentSentinels();
        expect(second[0]).toEqual(first[0]); // before the late round
        expect(Number(second[1].version)).toBeGreaterThan(Number(first[1].version)); // the late round
        expect(Number(second[2].version)).toBeGreaterThan(Number(first[2].version)); // closing 86 400 s after it
        expect(second[3]).toEqual(first[3]); // closing 86 401 s after it
        // round 2 now carries the vote of K4 from round 1; round 3 is a second too late for it
        expect((await currentTallies(R2)).find((row) => row.amendment_id === '')?.trusted).toBe(4);
        expect((await currentTallies(R3)).find((row) => row.amendment_id === '')?.trusted).toBe(3);
      });
    });

    it('carries a vote of a round stored exactly 86 400 s earlier, and not one a second older', async () => {
      const base = nowSeconds() - 3 * DAY;
      const closes = new Map([
        [R1, base],
        [R2, base + 86_400],
        [R3, base + 86_401],
      ]);
      const closeAt = (index: number) => closes.get(index) ?? base - 5000;
      await bootWithList();
      await writeLedgersClosing(closeAt, [R1, 1], [R2, 1], [R3, 1]);
      const at = (ledger: number) => (closes.get(ledger) ?? base) + 3.5;
      // K4 votes in round 1 only
      for (const key of [K1, K2, K3, K4]) await validate(key.base58, R1, { amendments: [AM_A], at: at(R1) });
      for (const key of [K1, K2, K3]) await validate(key.base58, R2, { amendments: [AM_A], at: at(R2) });
      for (const key of [K1, K2, K3]) await validate(key.base58, R3, { amendments: [AM_A], at: at(R3) });

      await runNow(makeJob());

      // the sentinel of round 1 is 86 400 s before the close of round 2: its record still counts there
      expect((await currentTallies(R2)).find((row) => row.amendment_id === '')).toMatchObject({
        trusted: 4,
        observed: 3,
      });
      expect(yesOf(await currentTallies(R2))).toEqual([[AM_A, 4]]);
      expect((await currentTallies(R3)).find((row) => row.amendment_id === '')).toMatchObject({
        trusted: 3,
        observed: 3,
      });
      expect(yesOf(await currentTallies(R3))).toEqual([[AM_A, 3]]);
    });

    it('carries the vote of a history row stored under a signing key for its master', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await db.ch.insert(Table.ValidatorManifests, [
        { ephemeral_key: K2_SIGNING.base58, master_key: K2.base58, seq: 1, domain: '', manifest: '', source: 'stream' },
      ]);
      for (const key of [K1, K3, K4]) await validate(key.base58, R1, { amendments: [AM_A] });
      for (const key of [K1, K3, K4]) await validate(key.base58, R2, { amendments: [AM_A] });
      await runAt((closeOf(R1) + 600) * 1000); // round 1 only
      // a vote of K2 stored in round 1 under its signing key, from before the manifest was known
      const version = Number(await currentVersionOf(R1));
      await db.ch.insert(Table.ValidatorVotes, [
        {
          ledger_index: R1,
          validation_public_key: K2_SIGNING.base58,
          ledger_hash: syntheticHash(R1),
          close_time: closeOf(R1),
          full: 1,
          amendments: [AM_A],
          base_fee: null,
          reserve_base: null,
          reserve_inc: null,
          server_version: null,
          version,
        },
      ]);

      await runNow(makeJob()); // round 2: K2 sends nothing

      // the record of K2 is the one it has under its signing key
      expect((await currentTallies(R2)).find((row) => row.amendment_id === '')).toMatchObject({
        trusted: 4,
        observed: 3,
      });
      expect(yesOf(await currentTallies(R2))).toEqual([[AM_A, 4]]);
    });

    it('warns about the observed members that are off the negative UNL, as rippled counts them', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await db.ch.insert(Table.NetworkState, [
        networkState(400, { negative_unl: [{ validation_public_key: K4.base58, first_ledger: 300 }] }),
      ]);
      // round 1: K1, K2 and K4 (on the negative UNL) validate: 3 observed, 2 count, the quorum is 3 of 4 less one
      for (const key of [K1, K2, K4]) await validate(key.base58, R1, { amendments: [AM_A] });
      // round 2: K1, K2 and K3 validate: 3 count
      for (const key of [K1, K2, K3]) await validate(key.base58, R2, { amendments: [AM_A] });

      await runNow(makeJob());

      expect(warnings).toEqual(['round 511: recorded 2 of 4 UNL validations, below quorum 3']);
      // the stored figure is the plain count
      expect((await currentTallies(R1)).find((row) => row.amendment_id === '')?.observed).toBe(3);
      expect((await currentTallies(R2)).find((row) => row.amendment_id === '')?.observed).toBe(3);
    });

    it('writes no sentinel once the shutdown began, and redoes the round as a newer set', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      const controller = new AbortController();
      const real = db.ch.insert.bind(db.ch);
      // the shutdown comes between the votes and the tallies of round 1
      jest.spyOn(db.ch, 'insert').mockImplementation(async (table, rows, opts) => {
        await real(table, rows, opts);
        if (table === Table.ValidatorVotes) controller.abort();
      });

      await makeJob().run({ now: Date.now(), deadline: Date.now() + 60_000, signal: controller.signal });

      expect(await sentinelsOf()).toEqual([]);
      const half = await votesOf(R1);
      expect(half).toHaveLength(4);
      jest.restoreAllMocks();

      await runNow(makeJob());

      const sentinels = await sentinelsOf();
      expect(sentinels.map((row) => row.ledger_index)).toEqual([R1, R2]);
      expect(Number(sentinels[0].version)).toBeGreaterThan(Number(half[0].version));
    });

    it('writes nothing for a tick whose signal is already aborted', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      const controller = new AbortController();
      controller.abort();
      const insert = jest.spyOn(db.ch, 'insert');

      await makeJob().run({ now: Date.now(), deadline: Date.now() + 60_000, signal: controller.signal });

      expect(insert).not.toHaveBeenCalled();
    });

    it('writes a version newer than anything stored for the round', async () => {
      await bootWithList();
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      // a half-written set from a crash, with a version in the future: votes and no sentinel, so no round
      const future = Date.now() + 3_600_000;
      await db.ch.insert(Table.ValidatorVotes, [
        {
          ledger_index: R1,
          validation_public_key: OUTSIDER.base58,
          ledger_hash: syntheticHash(R1),
          close_time: closeOf(R1),
          full: 1,
          amendments: [AM_Z],
          base_fee: null,
          reserve_base: null,
          reserve_inc: null,
          server_version: null,
          version: future,
        },
      ]);

      await runNow(makeJob());

      const sentinels = await sentinelsOf();
      expect(sentinels.map((row) => row.ledger_index)).toEqual([R1, R2]);
      expect(Number(sentinels[0].version)).toBe(future + 1);
      expect((await talliesOf(R1)).every((row) => row.version === sentinels[0].version)).toBe(true);
      // the set of the round is the rows of the sentinel's version: the half-written row is of an older one
      const set = (await votesOf(R1)).filter((v) => v.version === sentinels[0].version);
      expect(set.map((v) => v.validation_public_key)).toEqual(sorted([K1, K2, K3, K4].map((k) => k.base58)));
    });

    it('builds on the rows of the newest version of a stored round and no other', async () => {
      await bootWithList();
      await writeBaseLedgers();
      for (const key of [K1, K2, K4]) await validate(key.base58, R1, { amendments: [AM_A] });
      // K3's validation of round 1 is partial: it makes no record
      await validate(K3.base58, R1, { amendments: [AM_A], full: false });
      await validate(K1.base58, R2, { amendments: [AM_A] });
      await validate(K2.base58, R2, { amendments: [AM_A] });
      await validate(K4.base58, R2, { amendments: [AM_A] });
      await runAt((closeOf(R1) + 600) * 1000); // round 1 only
      expect((await sentinelsOf()).map((row) => row.ledger_index)).toEqual([R1]);

      // an older version of round 1 turns up (a stale writer): a full vote of K3 and a sentinel
      await db.ch.insert(Table.ValidatorVotes, [
        {
          ledger_index: R1,
          validation_public_key: K3.base58,
          ledger_hash: syntheticHash(R1),
          close_time: closeOf(R1),
          full: 1,
          amendments: [AM_Z],
          base_fee: null,
          reserve_base: null,
          reserve_inc: null,
          server_version: null,
          version: 1,
        },
      ]);
      await db.ch.insert(Table.AmendmentTallies, [
        {
          ledger_index: R1,
          amendment_id: '',
          close_time: closeOf(R1),
          yes: 0,
          trusted: 0,
          threshold: 1,
          unl_size: 0,
          observed: 0,
          unl: [],
          negative_unl: [],
          base_fee: '0',
          reserve_base: '0',
          reserve_inc: '0',
          version: 1,
        },
      ]);

      await runNow(makeJob()); // round 2, on top of round 1

      // K3 has no record: its full vote is of an old version, and it did not validate round 2
      const tallies = await talliesOf(R2);
      expect(yesOf(tallies)).toEqual([[AM_A, 3]]);
      expect(tallies.find((row) => row.amendment_id === '')).toMatchObject({ trusted: 3, unl_size: 4, observed: 3 });
    });

    it('seeds validator_seen once from validations', async () => {
      await validate(K1.base58, R1, { at: END + 100.25 });
      await validate(K1.base58, R2, { at: END + 900.5 });
      await validate(K2.base58, R1, { at: END + 150 });
      const seen = () =>
        db.ch.query<{ key: string; first_ms: number | string; last_ms: number | string; ledger: number }>(
          `SELECT validation_public_key AS key, toUnixTimestamp64Milli(min(first_seen)) AS first_ms,
                  toUnixTimestamp64Milli(max(last_seen)) AS last_ms, max(last_ledger_index) AS ledger
             FROM ${Table.ValidatorSeen} GROUP BY validation_public_key ORDER BY validation_public_key`,
        );

      expect(await seedValidatorSeen(db.ch)).toBe(true);
      const expected = [
        { key: K1.base58, first_ms: (END + 100.25) * 1000, last_ms: (END + 900.5) * 1000, ledger: R2 },
        { key: K2.base58, first_ms: (END + 150) * 1000, last_ms: (END + 150) * 1000, ledger: R1 },
      ].sort((a, b) => (a.key < b.key ? -1 : 1));
      expect((await seen()).map((r) => ({ ...r, first_ms: Number(r.first_ms), last_ms: Number(r.last_ms) }))).toEqual(
        expected,
      );

      // it has rows now: a later call seeds nothing, whatever validations holds
      await validate(K3.base58, R1, { at: END + 200 });
      expect(await seedValidatorSeen(db.ch)).toBe(false);
      expect((await seen()).map((r) => r.key)).toEqual(expected.map((r) => r.key));
    });

    it('does not seed validator_seen when it already has a row', async () => {
      await validate(K1.base58, R1);
      await db.ch.insert(Table.ValidatorSeen, [
        { validation_public_key: K4.base58, first_seen: 1_760_000_000, last_seen: 1_760_000_000, last_ledger_index: 1 },
      ]);
      expect(await seedValidatorSeen(db.ch)).toBe(false);
      const rows = await db.ch.query<{ key: string }>(
        `SELECT validation_public_key AS key FROM ${Table.ValidatorSeen}`,
      );
      expect(rows).toEqual([{ key: K4.base58 }]);
    });

    describe('seeding validator_seen', () => {
      /** The `YYYYMMDD` of the partition of `validations` a validation received at `seconds` is in. */
      const partitionOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10).replace(/-/g, '');

      it('seeds again when the collector wrote its first rows before the seeding did', async () => {
        await validate(K1.base58, R1, { at: END + 100 });
        await validate(K2.base58, R1, { at: END + 120 });
        // the collector's own row for K1, written a second more than an hour after the oldest validation
        await db.ch.insert(Table.ValidatorSeen, [
          { validation_public_key: K1.base58, first_seen: END + 3701, last_seen: END + 3701, last_ledger_index: R2 },
        ]);

        expect(await seedValidatorSeen(db.ch)).toBe(true);

        expect(await seenRows()).toEqual(
          byKey([
            { key: K1.base58, first_ms: (END + 100) * 1000, last_ms: (END + 3701) * 1000, ledger: R2 },
            { key: K2.base58, first_ms: (END + 120) * 1000, last_ms: (END + 120) * 1000, ledger: R1 },
          ]),
        );
        // it is complete now
        expect(await seedValidatorSeen(db.ch)).toBe(false);
      });

      it('leaves it alone when its oldest row is no more than an hour newer than the oldest validation', async () => {
        await validate(K1.base58, R1, { at: END + 100 });
        await db.ch.insert(Table.ValidatorSeen, [
          { validation_public_key: K4.base58, first_seen: END + 3700, last_seen: END + 3700, last_ledger_index: 1 },
        ]);

        expect(await seedValidatorSeen(db.ch)).toBe(false);

        expect((await seenRows()).map((r) => r.key)).toEqual([K4.base58]);
      });

      it('has nothing to seed from when validations has no partition', async () => {
        expect(await seedValidatorSeen(db.ch)).toBe(false);
        expect(await seenRows()).toEqual([]);
      });

      it('seeds a partition at a time, the newest first', async () => {
        await validate(K1.base58, R1, { at: END - 2 * DAY + 10 });
        await validate(K2.base58, R2, { at: END + 50 });
        const command = jest.spyOn(db.ch, 'command');

        expect(await seedValidatorSeen(db.ch)).toBe(true);

        const seeded = command.mock.calls
          .filter(([sql]) => String(sql).includes(Table.ValidatorSeen))
          .map(([, params]) => (params as { partition: string }).partition);
        expect(seeded).toEqual([partitionOf(END + 50), partitionOf(END - 2 * DAY + 10)]);
        expect(await seenRows()).toEqual(
          byKey([
            { key: K1.base58, first_ms: (END - 2 * DAY + 10) * 1000, last_ms: (END - 2 * DAY + 10) * 1000, ledger: R1 },
            { key: K2.base58, first_ms: (END + 50) * 1000, last_ms: (END + 50) * 1000, ledger: R2 },
          ]),
        );
      });

      it('is finished by the next start when it was cut short, because the oldest partition is the last one done', async () => {
        await validate(K1.base58, R1, { at: END - 2 * DAY + 10 });
        await validate(K2.base58, R2, { at: END + 50 });
        const controller = new AbortController();
        const real = db.ch.command.bind(db.ch);
        // the shutdown comes after the first partition
        jest.spyOn(db.ch, 'command').mockImplementation(async (sql, params, opts) => {
          await real(sql, params, opts);
          if (String(sql).includes(Table.ValidatorSeen)) controller.abort();
        });

        expect(await seedValidatorSeen(db.ch, { signal: controller.signal })).toBe(true);
        expect((await seenRows()).map((r) => r.key)).toEqual([K2.base58]);
        jest.restoreAllMocks();

        // the oldest validation is still older than the oldest row by days: it goes on
        expect(await seedValidatorSeen(db.ch)).toBe(true);
        expect((await seenRows()).map((r) => r.key)).toEqual(
          byKey([{ key: K1.base58 }, { key: K2.base58 }]).map((r) => r.key),
        );
        expect(await seedValidatorSeen(db.ch)).toBe(false);
      });
    });

    it('leaves the worker booted, with its compute loop running, when the seeding fails', async () => {
      const seeding = jest.spyOn(seenSeed, 'seedValidatorSeen').mockRejectedValue(new Error('seed down'));
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      await validateAll(R2, [AM_A]);
      const lines: string[] = [];
      await boot(PUBLISHERS, {
        start: { unl: false, domains: false, state: false, compute: true },
        logger: { log: () => undefined, warn: (line: string) => void lines.push(line), error: () => undefined },
      });

      await waitFor('both rounds', async () => (await sentinelsOf()).length >= 2);
      expect(seeding).toHaveBeenCalledTimes(1);
      expect(lines).toEqual(['Seeding validator_seen failed: seed down; it is tried again at the next start']);
      expect(await seenRows()).toEqual([]);
    });

    it('is run by the worker at start, which seeds validator_seen in the background', async () => {
      await writeBaseLedgers();
      await validateAll(R1, [AM_A]);
      await validateAll(R2, [AM_A]);
      const app = await boot(PUBLISHERS, { start: { unl: false, domains: false, state: false, compute: true } });

      await waitFor('both rounds', async () => (await sentinelsOf()).length >= 2);
      // the loop counts the run when the job has returned
      const counted = async (outcome: string) =>
        (await app.metrics.validatorsJobsTotal.get()).values
          .filter((v) => v.labels.job === 'rounds' && v.labels.outcome === outcome)
          .reduce((n, v) => n + v.value, 0);
      await waitFor('the run to be counted', async () => (await counted('ok')) >= 1);
      expect(await counted('error')).toBe(0);
      const seen = await db.ch.query<{ key: string }>(
        `SELECT validation_public_key AS key FROM ${Table.ValidatorSeen} GROUP BY validation_public_key ORDER BY key`,
      );
      expect(seen.map((r) => r.key)).toEqual(UNL_KEYS);
    });
  });
});

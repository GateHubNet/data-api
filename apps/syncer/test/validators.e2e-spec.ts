import { listInUse, Table } from '@gatehub/data-api-shared';
import {
  makeManifest,
  makeUnlBlob,
  makeUnlResponse,
  testKey,
} from '../../../packages/shared/src/test-utils/validator-keys';
import { readStoredLists } from '../src/validators/stored-lists';
import {
  FakeNode,
  MigratedClickHouse,
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
 * lists signed with test keys. The worker is booted as the application boots it (the core module of the syncer), and
 * nothing leaves the machine: the fetches resolve the names to 127.0.0.1 and trust the test certificate.
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
      worker,
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
});

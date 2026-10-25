import {
  ClickHouseService,
  REVOKED_SEQUENCE,
  Table,
  UnlListsRow,
  UnlPublishersRow,
  ValidatorManifestsRow,
} from '@gatehub/data-api-shared';
import {
  makeManifest,
  makeUnlBlob,
  makeUnlResponse,
  TestKey,
  testKey,
} from '../../../../packages/shared/src/test-utils/validator-keys';
import { SafeFetchError, UNL_FETCH_LIMITS } from './safe-fetch';
import { UnlFetcher, UnlOutcome } from './unl-fetcher';

const NOW_MS = Date.parse('2026-10-19T12:00:00.000Z');
const NOW = NOW_MS / 1000;
const DAY = 86_400;

const PUBLISHER = testKey('publisher');
const SIGNING = testKey('publisher-signing');
const OLD_SIGNING = testKey('publisher-signing-old');
const OTHER_PUBLISHER = testKey('other-publisher');
const V1 = testKey('validator-1');
const V1_SIGNING = testKey('validator-1-signing');
const V2 = testKey('validator-2');
const V2_SIGNING = testKey('validator-2-signing');
const V3 = testKey('validator-3');

const URL1 = 'https://unl.example';
const ID1 = 'unl.example';
const URL2 = 'https://a.example/vl';
const ID2 = 'a.example/vl';

const V1_MANIFEST = makeManifest({ master: V1, signing: V1_SIGNING, sequence: 3, domain: 'v1.example' });
const V2_MANIFEST = makeManifest({ master: V2, signing: V2_SIGNING, sequence: 9 });

const QUIET = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** A list as a publisher serves it, signed by the test publisher. */
function served(
  o: {
    sequence?: number;
    expiration?: number;
    effective?: number;
    validators?: { master: TestKey; manifestHex?: string }[];
    refreshInterval?: number;
    manifestSequence?: number;
    publisherSigning?: TestKey;
    signer?: TestKey;
    blob?: string;
    publisher?: TestKey;
  } = {},
): Record<string, unknown> {
  return makeUnlResponse({
    publisher: o.publisher ?? PUBLISHER,
    publisherSigning: o.publisherSigning ?? SIGNING,
    manifestSequence: o.manifestSequence,
    refreshInterval: o.refreshInterval,
    blobs: [
      {
        blob:
          o.blob ??
          makeUnlBlob({
            sequence: o.sequence ?? 7,
            expiration: o.expiration ?? NOW + 30 * DAY,
            effective: o.effective,
            validators: o.validators ?? [{ master: V1, manifestHex: V1_MANIFEST }, { master: V2 }],
          }),
        signer: o.signer,
      },
    ],
  });
}

type Fetched = { url: string; body: Buffer };

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

/** A stored `unl_lists` row, as the fetcher writes one. */
function listRow(o: Partial<UnlListsRow> & { sequence: number }): UnlListsRow {
  return {
    publisher: ID1,
    publisher_key: PUBLISHER.publicKeyHex,
    version: 1,
    effective: null,
    expiration: NOW + 30 * DAY,
    validators: [V1.base58, V2.base58].sort(),
    blob_sha256: 'AB'.repeat(32),
    fetched_at: NOW - 3600,
    response: JSON.stringify(served({ sequence: o.sequence })),
    ...o,
  };
}

/**
 * A ClickHouse that keeps what is inserted and answers the three reads of the fetcher (the stored lists, the newest stored
 * response of a publisher, the stored publisher rows) from it, in the shape of the real queries' columns.
 */
class FakeClickHouse {
  lists: UnlListsRow[] = [];
  publishers: UnlPublishersRow[] = [];
  readonly inserts: { table: string; rows: unknown[] }[] = [];
  readonly reads: string[] = [];
  failInserts?: Error;

  readonly query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    if (sql.includes(Table.UnlPublishers)) {
      this.reads.push('publishers');
      return this.newest(
        this.publishers,
        (r) => r.publisher,
        (r) => r.checked_at,
      ).map((r) => ({
        ...r,
        last_ok_ms: r.last_ok_at === null ? null : Math.round(r.last_ok_at * 1000),
      }));
    }
    const wanted = (params.publishers ?? [params.publisher]) as string[];
    const own = this.lists.filter((l) => wanted.includes(l.publisher));
    if (sql.includes('DESC')) {
      this.reads.push('response');
      const newest = [...own]
        .filter((l) => l.publisher_key === params.key)
        .sort((a, b) => b.fetched_at - a.fetched_at)[0];
      return newest ? [{ response: newest.response }] : [];
    }
    this.reads.push('lists');
    return this.newest(
      own,
      (l) => `${l.publisher}\u0000${l.sequence}`,
      (l) => l.fetched_at,
    )
      .map((l) => ({
        publisher: l.publisher,
        publisher_key: l.publisher_key,
        sequence: Number(l.sequence),
        version: l.version,
        effective: l.effective,
        expiration: l.expiration,
        validators: l.validators,
        fetched_ms: Math.round(l.fetched_at * 1000),
      }))
      .sort((a, b) => a.publisher.localeCompare(b.publisher) || a.sequence - b.sequence);
  });

  readonly insert = jest.fn(async (table: string, rows: unknown[]) => {
    if (this.failInserts) throw this.failInserts;
    this.inserts.push({ table, rows });
    if (table === Table.UnlLists) this.lists.push(...(rows as UnlListsRow[]));
    if (table === Table.UnlPublishers) this.publishers.push(...(rows as UnlPublishersRow[]));
  });

  private newest<T>(rows: T[], key: (row: T) => string, version: (row: T) => number): T[] {
    const best = new Map<string, T>();
    for (const row of rows) {
      const held = best.get(key(row));
      if (!held || version(row) >= version(held)) best.set(key(row), row);
    }
    return [...best.values()];
  }

  rowsOf<T>(table: Table): T[] {
    return this.inserts.filter((i) => i.table === table).flatMap((i) => i.rows as T[]);
  }

  /** The `unl_publishers` rows written so far, the newest last. */
  get publisherRows(): UnlPublishersRow[] {
    return this.rowsOf<UnlPublishersRow>(Table.UnlPublishers);
  }
}

function setup(
  o: {
    publishers?: string;
    threshold?: number;
    refreshMs?: number;
    serve?: unknown;
    start?: boolean;
  } = {},
) {
  const ch = new FakeClickHouse();
  const metrics = {
    validatorsUnlFetchesTotal: { inc: jest.fn() },
    validatorsUnlExpirySeconds: { set: jest.fn() },
    validatorsUnlSize: { set: jest.fn() },
  };
  const logger = QUIET();
  const fetches: { url: string; at: number }[] = [];
  /** What the next fetches answer: a body (object or text), an error to throw, or a function of the URL. */
  const state: { answer: unknown } = { answer: o.serve ?? served() };
  const get = jest.fn(async (url: string, _limits: unknown, _accept: string): Promise<Fetched> => {
    fetches.push({ url, at: Date.now() });
    const answer = typeof state.answer === 'function' ? (state.answer as (u: string) => unknown)(url) : state.answer;
    if (answer instanceof Error) throw answer;
    return { url, body: Buffer.from(typeof answer === 'string' ? answer : JSON.stringify(answer)) };
  });
  const fetcher = new UnlFetcher(
    {
      unlPublishers: o.publishers ?? `${URL1}=${PUBLISHER.publicKeyHex}`,
      unlValidators: '',
      unlThreshold: o.threshold ?? 0,
      unlRefreshMs: o.refreshMs ?? 300_000,
    },
    ch as unknown as ClickHouseService,
    metrics as never,
    { get },
    { now: () => Date.now(), logger },
  );
  return { fetcher, ch, metrics, logger, get, fetches, state };
}

const TWO_PUBLISHERS = `${URL1}=${PUBLISHER.publicKeyHex},${URL2}=${OTHER_PUBLISHER.publicKeyHex}`;

describe('UnlFetcher', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW_MS });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('schedule', () => {
    it('fetches every publisher at start, through the safe fetcher with the UNL limits', async () => {
      const t = setup({ publishers: TWO_PUBLISHERS, serve: served() });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.fetches.map((f) => f.url).sort()).toEqual([URL2, URL1]);
      expect(t.get).toHaveBeenCalledWith(URL1, UNL_FETCH_LIMITS, 'application/json');
      await t.fetcher.stop();
    });

    it('waits GH_UNL_REFRESH_MS when the list names no refresh_interval', async () => {
      const t = setup({ refreshMs: 120_000 });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(119_999);
      expect(t.fetches).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.fetches).toHaveLength(2);
      await t.fetcher.stop();
    });

    it.each([
      ['below a minute', 1, 60_000],
      ['above a day', 10_000_000_000, 86_400_000], // more than a timer can hold
    ])('keeps the wait of GH_UNL_REFRESH_MS between 1 min and 24 h (%s)', async (_label, refreshMs, waitMs) => {
      const t = setup({ refreshMs });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(10);
      expect(t.fetches).toHaveLength(1); // a wait of 1 ms would have fetched ten times by now
      await jest.advanceTimersByTimeAsync(waitMs - 11);
      expect(t.fetches).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.fetches).toHaveLength(2);
      await t.fetcher.stop();
    });

    it.each([
      ['0', 0, 60_000],
      ['1', 1, 60_000],
      ['10', 10, 600_000],
      ['1440', 1440, 86_400_000],
      ['2000', 2000, 86_400_000],
    ])('waits refresh_interval minutes, clamped to 1 min and 24 h (%s min)', async (_label, minutes, waitMs) => {
      const t = setup({ serve: served({ refreshInterval: minutes }), refreshMs: 5_000 });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(10);
      expect(t.fetches).toHaveLength(1); // a wait of none would have fetched ten times by now
      await jest.advanceTimersByTimeAsync(waitMs - 11);
      expect(t.fetches).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.fetches).toHaveLength(2);
      await t.fetcher.stop();
    });

    it('backs off 30 s doubling to 10 min after failures, and starts over after a success', async () => {
      const t = setup({ refreshMs: 300_000 });
      t.state.answer = new SafeFetchError('http_status', 'the server answered 503', { statusCode: 503 });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 240_000 + 480_000 + 600_000 + 600_000);
      const gaps = t.fetches.slice(1).map((f, i) => (f.at - t.fetches[i].at) / 1000);
      expect(gaps).toEqual([30, 60, 120, 240, 480, 600, 600]);

      // the publisher answers again: the next fetch is a regular one, and the backoff has started over
      t.state.answer = served();
      await jest.advanceTimersByTimeAsync(600_000);
      const afterOk = t.fetches.length;
      expect((t.fetches[afterOk - 1].at - t.fetches[afterOk - 2].at) / 1000).toBe(600);
      t.state.answer = new SafeFetchError('timeout', 'the fetch ran out of time');
      await jest.advanceTimersByTimeAsync(300_000);
      expect(t.fetches).toHaveLength(afterOk + 1); // the regular wait (5 min) after the success
      await jest.advanceTimersByTimeAsync(29_999);
      expect(t.fetches).toHaveLength(afterOk + 1);
      await jest.advanceTimersByTimeAsync(1); // then 30 s again
      expect(t.fetches).toHaveLength(afterOk + 2);
      await t.fetcher.stop();
    });

    it('treats an expired or stale list like a failure: it waits the backoff, not the refresh', async () => {
      const t = setup({ serve: served({ expiration: NOW - 1 }), refreshMs: 300_000 });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(29_999);
      expect(t.fetches).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.fetches).toHaveLength(2);
      await t.fetcher.stop();
    });

    it('keeps the schedules of the publishers apart', async () => {
      const t = setup({ publishers: TWO_PUBLISHERS });
      t.state.answer = (url: string) =>
        url === URL1
          ? new SafeFetchError('timeout', 'the fetch ran out of time')
          : served({ publisher: OTHER_PUBLISHER });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(t.fetches.filter((f) => f.url === URL1)).toHaveLength(2); // retried after 30 s
      expect(t.fetches.filter((f) => f.url === URL2)).toHaveLength(1); // waits its 5 minutes
      await t.fetcher.stop();
    });

    it('makes one fetch per publisher at a time', async () => {
      const t = setup();
      const slow = deferred<Fetched>();
      t.get.mockImplementationOnce(() => slow.promise);
      const first = t.fetcher.fetchOnce(ID1);
      const second = t.fetcher.fetchOnce(ID1);
      await jest.advanceTimersByTimeAsync(0);
      expect(t.get).toHaveBeenCalledTimes(1);
      slow.resolve({ url: URL1, body: Buffer.from(JSON.stringify(served())) });
      expect(await Promise.all([first, second])).toEqual(['ok', 'ok']);
      expect(t.get).toHaveBeenCalledTimes(1);
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(1);
      // and once it is done a new one may start
      expect(await t.fetcher.fetchOnce(ID1)).toBe('unchanged');
      expect(t.get).toHaveBeenCalledTimes(2);
    });

    it('rejects a publisher it does not know', async () => {
      const t = setup();
      await expect(t.fetcher.fetchOnce('nowhere.example')).rejects.toThrow('nowhere.example');
    });

    it('does not run a schedule without publishers', async () => {
      const t = setup({ publishers: '' });
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(t.get).not.toHaveBeenCalled();
      await t.fetcher.stop();
    });

    it('goes on after a storage failure: it logs it and retries with the backoff', async () => {
      const t = setup();
      t.ch.failInserts = new Error('ClickHouse is down');
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ClickHouse is down'));
      expect(t.metrics.validatorsUnlFetchesTotal.inc).not.toHaveBeenCalled();
      t.ch.failInserts = undefined;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(t.fetches).toHaveLength(2);
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(1);
      await t.fetcher.stop();
    });
  });

  describe('maps each outcome to the publisher row and the metric', () => {
    const fetchFailures = [
      'domain_invalid',
      'dns_error',
      'blocked_address',
      'connect_error',
      'tls_error',
      'timeout',
      'http_status',
      'too_large',
      'redirect_rejected',
    ] as const;
    const revokedManifest = Buffer.from(
      makeManifest({ master: PUBLISHER, sequence: REVOKED_SEQUENCE }),
      'hex',
    ).toString('base64');

    const cases: { outcome: UnlOutcome; stored?: number; serve: () => unknown }[] = [
      { outcome: 'ok', serve: () => served() },
      { outcome: 'unchanged', stored: 7, serve: () => served({ sequence: 7 }) },
      { outcome: 'stale', stored: 9, serve: () => served({ sequence: 8 }) },
      { outcome: 'expired', serve: () => served({ expiration: NOW - 1 }) },
      { outcome: 'invalid_format', serve: () => ({ hello: 'world' }) },
      { outcome: 'invalid_format', serve: () => 'this is not JSON' },
      { outcome: 'untrusted_key', serve: () => served({ publisher: OTHER_PUBLISHER }) },
      { outcome: 'manifest_invalid', serve: () => ({ ...served(), manifest: 'AAAA' }) },
      { outcome: 'revoked', serve: () => ({ ...served(), manifest: revokedManifest }) },
      { outcome: 'signature_invalid', serve: () => served({ signer: OLD_SIGNING }) },
      { outcome: 'blob_invalid', serve: () => served({ blob: Buffer.from('{}').toString('base64') }) },
      ...fetchFailures.map((reason) => ({
        outcome: reason as UnlOutcome,
        serve: () => new SafeFetchError(reason, `the fetch failed: ${reason}`),
      })),
    ];

    it.each(cases)('$outcome', async ({ outcome, stored, serve }) => {
      const t = setup({ serve: serve() });
      if (stored !== undefined) t.ch.lists.push(listRow({ sequence: stored }));

      expect(await t.fetcher.fetchOnce(ID1)).toBe(outcome);

      const ok = outcome === 'ok' || outcome === 'unchanged';
      expect(t.ch.publisherRows).toEqual([
        {
          publisher: ID1,
          url: URL1,
          publisher_key: PUBLISHER.publicKeyHex,
          configured: 1,
          threshold: 1,
          checked_at: NOW,
          status: ok ? 'ok' : 'error',
          error: ok ? '' : outcome,
          last_ok_at: ok ? NOW : null,
        },
      ]);
      expect(t.metrics.validatorsUnlFetchesTotal.inc).toHaveBeenCalledTimes(1);
      expect(t.metrics.validatorsUnlFetchesTotal.inc).toHaveBeenCalledWith({ publisher: ID1, outcome });
    });

    it('sets the expiry and the size of the list in use after an attempt, negative when it expired', async () => {
      const t = setup({ serve: served({ sequence: 7, expiration: NOW + 3 * DAY }) });
      await t.fetcher.fetchOnce(ID1);
      expect(t.metrics.validatorsUnlExpirySeconds.set).toHaveBeenLastCalledWith({ publisher: ID1 }, 3 * DAY);
      expect(t.metrics.validatorsUnlSize.set).toHaveBeenLastCalledWith({ publisher: ID1 }, 2);

      // three days and an hour later the same list is all there is, and expired
      jest.setSystemTime(NOW_MS + 3 * DAY * 1000 + 3600_000);
      t.state.answer = new SafeFetchError('timeout', 'the fetch ran out of time');
      await t.fetcher.fetchOnce(ID1);
      expect(t.metrics.validatorsUnlExpirySeconds.set).toHaveBeenLastCalledWith({ publisher: ID1 }, -3600);
      expect(t.metrics.validatorsUnlSize.set).toHaveBeenLastCalledWith({ publisher: ID1 }, 2);
    });

    it('sets no gauge for a publisher that has no list', async () => {
      const t = setup({ serve: new SafeFetchError('timeout', 'the fetch ran out of time') });
      await t.fetcher.fetchOnce(ID1);
      expect(t.metrics.validatorsUnlExpirySeconds.set).not.toHaveBeenCalled();
      expect(t.metrics.validatorsUnlSize.set).not.toHaveBeenCalled();
    });

    it('keeps last_ok_at through a failure and sets it again on the next success', async () => {
      const t = setup();
      await t.fetcher.fetchOnce(ID1);
      jest.setSystemTime(NOW_MS + 600_000);
      t.state.answer = new SafeFetchError('timeout', 'the fetch ran out of time');
      await t.fetcher.fetchOnce(ID1);
      jest.setSystemTime(NOW_MS + 1_200_000);
      t.state.answer = served({ sequence: 8 });
      await t.fetcher.fetchOnce(ID1);
      expect(t.ch.publisherRows.map((r) => [r.status, r.checked_at, r.last_ok_at])).toEqual([
        ['ok', NOW, NOW],
        ['error', NOW + 600, NOW],
        ['ok', NOW + 1200, NOW + 1200],
      ]);
    });

    it('writes the threshold in force', async () => {
      const t = setup({ publishers: TWO_PUBLISHERS, threshold: 2 });
      await t.fetcher.fetchOnce(ID1);
      expect(t.ch.publisherRows[0].threshold).toBe(2);
    });
  });

  describe('what a response writes', () => {
    it('stores a new list as one row, as served, and its validator manifests with source unl', async () => {
      const body = served({ sequence: 7, effective: NOW - DAY, expiration: NOW + 30 * DAY });
      const t = setup({ serve: body });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');

      const [row] = t.ch.rowsOf<UnlListsRow>(Table.UnlLists);
      expect(row).toEqual({
        publisher: ID1,
        publisher_key: PUBLISHER.publicKeyHex,
        sequence: 7,
        version: 1,
        effective: NOW - DAY,
        expiration: NOW + 30 * DAY,
        validators: [V1.base58, V2.base58].sort(),
        blob_sha256: expect.stringMatching(/^[0-9A-F]{64}$/),
        fetched_at: NOW,
        response: JSON.stringify(body),
      });
      expect(t.ch.rowsOf<ValidatorManifestsRow>(Table.ValidatorManifests)).toEqual([
        {
          ephemeral_key: V1_SIGNING.base58,
          master_key: V1.base58,
          seq: 3,
          domain: 'v1.example',
          manifest: V1_MANIFEST,
          source: 'unl',
        },
      ]);
    });

    it('writes the manifests before the list, and the publisher row last', async () => {
      const t = setup();
      await t.fetcher.fetchOnce(ID1);
      expect(t.ch.inserts.map((i) => i.table)).toEqual([Table.ValidatorManifests, Table.UnlLists, Table.UnlPublishers]);
    });

    it('writes null for a list with no effective time', async () => {
      const t = setup({ serve: served({ sequence: 7 }) });
      await t.fetcher.fetchOnce(ID1);
      expect(t.ch.rowsOf<UnlListsRow>(Table.UnlLists)[0].effective).toBeNull();
    });

    it('writes nothing for the same sequence again', async () => {
      const t = setup();
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
      expect(await t.fetcher.fetchOnce(ID1)).toBe('unchanged');
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(1);
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(1);
      expect(t.ch.publisherRows.map((r) => r.status)).toEqual(['ok', 'ok']);
    });

    it('writes a newer sequence beside the old one', async () => {
      const t = setup();
      await t.fetcher.fetchOnce(ID1);
      t.state.answer = served({ sequence: 8 });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
      expect(t.ch.rowsOf<UnlListsRow>(Table.UnlLists).map((r) => r.sequence)).toEqual([7, 8]);
    });

    it('is stale below the newest stored sequence, and writes nothing', async () => {
      const t = setup();
      t.ch.lists.push(listRow({ sequence: 9 }), listRow({ sequence: 5 }));
      expect(await t.fetcher.fetchOnce(ID1)).toBe('stale');
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
      expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(0);
    });

    it('is expired for a newer list past its expiration, and writes nothing', async () => {
      const t = setup({ serve: served({ sequence: 8, expiration: NOW }) });
      t.ch.lists.push(listRow({ sequence: 7 }));
      expect(await t.fetcher.fetchOnce(ID1)).toBe('expired');
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
    });

    it('stores a list whose effective time is still to come', async () => {
      const t = setup({ serve: served({ sequence: 8, effective: NOW + DAY, expiration: NOW + 30 * DAY }) });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
      expect(t.ch.rowsOf<UnlListsRow>(Table.UnlLists)[0].effective).toBe(NOW + DAY);
    });

    describe('a response of version 2', () => {
      const blob = (
        sequence: number,
        expiration = NOW + 30 * DAY,
        validators: { master: TestKey; manifestHex?: string }[] = [{ master: V1, manifestHex: V1_MANIFEST }],
      ) => makeUnlBlob({ sequence, expiration, validators });
      const v2 = (blobs: string[]) =>
        makeUnlResponse({
          publisher: PUBLISHER,
          publisherSigning: SIGNING,
          version: 2,
          blobs: blobs.map((b) => ({ blob: b })),
        });

      it('writes one row per new blob, with the version, and a shared manifest once', async () => {
        const t = setup({
          serve: v2([blob(7), blob(8, NOW + 60 * DAY, [{ master: V1, manifestHex: V1_MANIFEST }, { master: V3 }])]),
        });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        const rows = t.ch.rowsOf<UnlListsRow>(Table.UnlLists);
        expect(rows.map((r) => [r.sequence, r.version, r.validators.length])).toEqual([
          [7, 2, 1],
          [8, 2, 2],
        ]);
        expect(rows[0].response).toBe(rows[1].response);
        expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(1);
      });

      it('is ok when any blob is new, whatever the others are', async () => {
        const t = setup({ serve: v2([blob(7), blob(8)]) });
        t.ch.lists.push(listRow({ sequence: 7 }));
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        expect(t.ch.rowsOf<UnlListsRow>(Table.UnlLists).map((r) => r.sequence)).toEqual([8]);
      });

      it('is unchanged when a blob is the stored sequence and none is new', async () => {
        const t = setup({ serve: v2([blob(6), blob(7)]) });
        t.ch.lists.push(listRow({ sequence: 7 }));
        expect(await t.fetcher.fetchOnce(ID1)).toBe('unchanged');
        expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
      });

      it('is the outcome of the first blob when none is new or unchanged', async () => {
        const staleFirst = setup({ serve: v2([blob(5), blob(8, NOW - 1)]) });
        staleFirst.ch.lists.push(listRow({ sequence: 7 }));
        expect(await staleFirst.fetcher.fetchOnce(ID1)).toBe('stale');
        const expiredFirst = setup({ serve: v2([blob(8, NOW - 1), blob(5)]) });
        expiredFirst.ch.lists.push(listRow({ sequence: 7 }));
        expect(await expiredFirst.fetcher.fetchOnce(ID1)).toBe('expired');
        expect(staleFirst.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
        expect(expiredFirst.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
      });

      it('rejects the response whole when one blob fails: nothing is written', async () => {
        const bad = Buffer.from('{}').toString('base64');
        const t = setup({ serve: v2([blob(7), bad]) });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('blob_invalid');
        expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
        expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(0);
      });
    });

    describe('the validator manifests of a new list', () => {
      it('skips the manifest of a revoked validator, without counting it', async () => {
        const revoked = makeManifest({ master: V2, sequence: REVOKED_SEQUENCE });
        const t = setup({
          serve: served({
            validators: [
              { master: V1, manifestHex: V1_MANIFEST },
              { master: V2, manifestHex: revoked },
            ],
          }),
        });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        expect(t.ch.rowsOf<ValidatorManifestsRow>(Table.ValidatorManifests).map((r) => r.master_key)).toEqual([
          V1.base58,
        ]);
        expect(t.metrics.validatorsUnlFetchesTotal.inc).toHaveBeenCalledTimes(1);
        expect(t.logger.warn).not.toHaveBeenCalled();
      });

      it('skips, logs and counts a manifest that does not verify, and still stores the list', async () => {
        // signed by the wrong master key: V2's manifest, but listed under V3
        const t = setup({
          serve: served({
            validators: [
              { master: V1, manifestHex: V1_MANIFEST },
              { master: V3, manifestHex: V2_MANIFEST },
            ],
          }),
        });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        expect(t.ch.rowsOf<ValidatorManifestsRow>(Table.ValidatorManifests).map((r) => r.master_key)).toEqual([
          V1.base58,
        ]);
        expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(1);
        expect(t.metrics.validatorsUnlFetchesTotal.inc).toHaveBeenCalledWith({
          publisher: ID1,
          outcome: 'validator_manifest_invalid',
        });
        expect(t.metrics.validatorsUnlFetchesTotal.inc).toHaveBeenCalledWith({ publisher: ID1, outcome: 'ok' });
        expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining(V3.base58));
      });

      it('judges a manifest for each validator it is listed under', async () => {
        const t = setup({
          serve: served({
            validators: [
              { master: V3, manifestHex: V2_MANIFEST }, // not V3's
              { master: V2, manifestHex: V2_MANIFEST },
            ],
          }),
        });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        expect(t.ch.rowsOf<ValidatorManifestsRow>(Table.ValidatorManifests).map((r) => r.master_key)).toEqual([
          V2.base58,
        ]);
        expect(
          t.metrics.validatorsUnlFetchesTotal.inc.mock.calls.filter(
            ([labels]) => labels.outcome === 'validator_manifest_invalid',
          ),
        ).toHaveLength(1);
      });

      it('skips a manifest that does not decode, and one with a bad signature', async () => {
        const tampered = V1_MANIFEST.replace(/.{8}$/, '00000000');
        const t = setup({
          serve: served({
            validators: [{ master: V1, manifestHex: tampered }, { master: V2, manifestHex: 'ABCD' }, { master: V3 }],
          }),
        });
        expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
        expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(0);
        const invalid = t.metrics.validatorsUnlFetchesTotal.inc.mock.calls.filter(
          ([labels]) => labels.outcome === 'validator_manifest_invalid',
        );
        expect(invalid).toHaveLength(2);
      });

      it('writes no manifest of a list that is not new', async () => {
        const t = setup();
        t.ch.lists.push(listRow({ sequence: 7 }));
        await t.fetcher.fetchOnce(ID1);
        expect(t.ch.rowsOf(Table.ValidatorManifests)).toHaveLength(0);
      });
    });

    it('refuses a body that replays an older publisher manifest, using the manifest of the newest stored response', async () => {
      const t = setup();
      // the newest list stored was served with the manifest of sequence 2, signed by SIGNING
      t.ch.lists.push(listRow({ sequence: 7, response: JSON.stringify(served({ sequence: 7, manifestSequence: 2 })) }));
      // a body now replays the manifest of sequence 1 (OLD_SIGNING) with a newer list signed by that old key
      t.state.answer = served({ sequence: 8, manifestSequence: 1, publisherSigning: OLD_SIGNING });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('signature_invalid');
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
      expect(t.ch.publisherRows[0]).toMatchObject({ status: 'error', error: 'signature_invalid' });
    });

    it('keeps the highest publisher manifest in memory, and reads the stored one once', async () => {
      const t = setup({ serve: served({ sequence: 7, manifestSequence: 2 }) });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
      t.state.answer = served({ sequence: 8, manifestSequence: 1, publisherSigning: OLD_SIGNING });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('signature_invalid');
      expect(await t.fetcher.fetchOnce(ID1)).toBe('signature_invalid');
      expect(t.ch.reads.filter((r) => r === 'response')).toHaveLength(1);
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(1);
    });

    it('verifies without a known manifest when nothing is stored or the stored response does not decode', async () => {
      const none = setup({ serve: served({ manifestSequence: 1, publisherSigning: OLD_SIGNING }) });
      expect(await none.fetcher.fetchOnce(ID1)).toBe('ok');
      const garbage = setup({ serve: served({ manifestSequence: 1, publisherSigning: OLD_SIGNING, sequence: 9 }) });
      garbage.ch.lists.push(listRow({ sequence: 1, response: 'not JSON' }));
      expect(await garbage.fetcher.fetchOnce(ID1)).toBe('ok');
      const noManifest = setup({ serve: served({ manifestSequence: 1, publisherSigning: OLD_SIGNING, sequence: 9 }) });
      noManifest.ch.lists.push(listRow({ sequence: 1, response: '{"manifest": "AAAA"}' }));
      expect(await noManifest.fetcher.fetchOnce(ID1)).toBe('ok');
    });

    it('does not use the manifest of another key as the known one (a rotated configured key)', async () => {
      const t = setup({ serve: served({ sequence: 9, manifestSequence: 1, publisherSigning: OLD_SIGNING }) });
      t.ch.lists.push(
        listRow({
          sequence: 7,
          response: JSON.stringify(served({ sequence: 7, manifestSequence: 5, publisher: OTHER_PUBLISHER })),
        }),
      );
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
    });
  });

  describe('lists of another key of the same publisher', () => {
    const OTHER_KEY = OTHER_PUBLISHER.publicKeyHex;

    it('are not compared with: a lower sequence under the configured key is new, not stale', async () => {
      const t = setup({ serve: served({ sequence: 3 }) });
      t.ch.lists.push(listRow({ sequence: 9, publisher_key: OTHER_KEY }));
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
      expect(t.ch.rowsOf<UnlListsRow>(Table.UnlLists).map((r) => [r.sequence, r.publisher_key])).toEqual([
        [3, PUBLISHER.publicKeyHex],
      ]);
    });

    it('do not make the same sequence unchanged', async () => {
      const t = setup({ serve: served({ sequence: 7 }) });
      t.ch.lists.push(listRow({ sequence: 7, publisher_key: OTHER_KEY }));
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
    });

    it('still leave the lists of the configured key to decide: stale and unchanged as before', async () => {
      const t = setup({ serve: served({ sequence: 7 }) });
      t.ch.lists.push(listRow({ sequence: 9, publisher_key: OTHER_KEY }), listRow({ sequence: 8 }));
      expect(await t.fetcher.fetchOnce(ID1)).toBe('stale');
      t.state.answer = served({ sequence: 8 });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('unchanged');
    });

    it('give no manifest to compare with: the one of the newest response under the configured key is used', async () => {
      const t = setup();
      t.ch.lists.push(
        listRow({
          sequence: 7,
          fetched_at: NOW - 3600,
          response: JSON.stringify(served({ sequence: 7, manifestSequence: 2 })),
        }),
        // newer, but the response of another key
        listRow({
          sequence: 9,
          publisher_key: OTHER_KEY,
          fetched_at: NOW - 60,
          response: JSON.stringify(served({ sequence: 9, manifestSequence: 1, publisher: OTHER_PUBLISHER })),
        }),
      );
      t.state.answer = served({ sequence: 10, manifestSequence: 1, publisherSigning: OLD_SIGNING });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('signature_invalid');
    });

    it('are not the list in use: no gauge is set from them', async () => {
      const t = setup({ serve: new SafeFetchError('timeout', 'the fetch ran out of time') });
      t.ch.lists.push(listRow({ sequence: 9, publisher_key: OTHER_KEY }));
      await t.fetcher.fetchOnce(ID1);
      expect(t.metrics.validatorsUnlExpirySeconds.set).not.toHaveBeenCalled();
      expect(t.metrics.validatorsUnlSize.set).not.toHaveBeenCalled();
    });
  });

  describe('a revoked publisher key', () => {
    const revoked = Buffer.from(makeManifest({ master: PUBLISHER, sequence: REVOKED_SEQUENCE }), 'hex').toString(
      'base64',
    );

    it('is remembered: an older valid body that follows is refused as revoked too', async () => {
      const t = setup({ serve: { ...served(), manifest: revoked } });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('revoked');
      t.state.answer = served({ sequence: 9 });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('revoked');
      expect(t.ch.rowsOf(Table.UnlLists)).toHaveLength(0);
      expect(t.ch.publisherRows.map((r) => r.error)).toEqual(['revoked', 'revoked']);
    });

    it('is remembered when only an entry of a version 2 response carries the revocation', async () => {
      const body = makeUnlResponse({
        publisher: PUBLISHER,
        publisherSigning: SIGNING,
        version: 2,
        blobs: [{ blob: makeUnlBlob({ sequence: 7, expiration: NOW + 30 * DAY, validators: [{ master: V1 }] }) }],
      }) as { blobs_v2: { manifest?: string }[] };
      body.blobs_v2[0].manifest = revoked;
      const t = setup({ serve: body });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('revoked');
      t.state.answer = served({ sequence: 9 });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('revoked');
    });

    it("is not taken from a manifest that is not the configured key's", async () => {
      const otherRevoked = Buffer.from(
        makeManifest({ master: OTHER_PUBLISHER, sequence: REVOKED_SEQUENCE }),
        'hex',
      ).toString('base64');
      const t = setup({ serve: { ...served(), manifest: otherRevoked } });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('manifest_invalid');
      t.state.answer = served({ sequence: 9 });
      expect(await t.fetcher.fetchOnce(ID1)).toBe('ok');
    });
  });

  describe('registerPublishers', () => {
    it('writes an ok row for a configured publisher that has none, with no last_ok_at', async () => {
      const t = setup({ publishers: TWO_PUBLISHERS, threshold: 2 });
      await t.fetcher.registerPublishers();
      expect(t.ch.inserts).toHaveLength(1);
      expect(t.ch.publisherRows).toEqual([
        {
          publisher: ID1,
          url: URL1,
          publisher_key: PUBLISHER.publicKeyHex,
          configured: 1,
          threshold: 2,
          checked_at: NOW,
          status: 'ok',
          error: '',
          last_ok_at: null,
        },
        {
          publisher: ID2,
          url: URL2,
          publisher_key: OTHER_PUBLISHER.publicKeyHex,
          configured: 1,
          threshold: 2,
          checked_at: NOW,
          status: 'ok',
          error: '',
          last_ok_at: null,
        },
      ]);
    });

    it('keeps the stored status, error and last_ok_at of a publisher that has a row', async () => {
      const t = setup();
      t.ch.publishers.push({
        publisher: ID1,
        url: 'https://unl.example/old',
        publisher_key: PUBLISHER.publicKeyHex,
        configured: 1,
        threshold: 3,
        checked_at: NOW - 600,
        status: 'error',
        error: 'timeout',
        last_ok_at: NOW - 7200.5,
      });
      await t.fetcher.registerPublishers();
      expect(t.ch.publisherRows).toEqual([
        {
          publisher: ID1,
          url: URL1,
          publisher_key: PUBLISHER.publicKeyHex,
          configured: 1,
          threshold: 1,
          checked_at: NOW,
          status: 'error',
          error: 'timeout',
          last_ok_at: NOW - 7200.5,
        },
      ]);
    });

    it('sets configured = 0 on stored publishers that are no longer configured, keeping their values', async () => {
      const t = setup();
      t.ch.publishers.push(
        {
          publisher: 'gone.example',
          url: 'https://gone.example',
          publisher_key: OTHER_PUBLISHER.publicKeyHex,
          configured: 1,
          threshold: 1,
          checked_at: NOW - 600,
          status: 'ok',
          error: '',
          last_ok_at: NOW - 600,
        },
        {
          publisher: 'long-gone.example',
          url: 'https://long-gone.example',
          publisher_key: V1.publicKeyHex,
          configured: 0,
          threshold: 1,
          checked_at: NOW - 6000,
          status: 'error',
          error: 'expired',
          last_ok_at: null,
        },
      );
      await t.fetcher.registerPublishers();
      const rows = t.ch.publisherRows;
      expect(rows.map((r) => [r.publisher, r.configured])).toEqual([
        [ID1, 1],
        ['gone.example', 0],
      ]);
      expect(rows[1]).toEqual({
        publisher: 'gone.example',
        url: 'https://gone.example',
        publisher_key: OTHER_PUBLISHER.publicKeyHex,
        configured: 0,
        threshold: 1,
        checked_at: NOW,
        status: 'ok',
        error: '',
        last_ok_at: NOW - 600,
      });
    });

    it('writes only the rows of stored publishers when none is configured', async () => {
      const t = setup({ publishers: '' });
      await t.fetcher.registerPublishers();
      expect(t.ch.inserts).toHaveLength(0);
    });

    it('lets the first attempt keep the stored last_ok_at when it fails', async () => {
      const t = setup({ serve: new SafeFetchError('timeout', 'the fetch ran out of time') });
      t.ch.publishers.push({
        publisher: ID1,
        url: URL1,
        publisher_key: PUBLISHER.publicKeyHex,
        configured: 1,
        threshold: 1,
        checked_at: NOW - 600,
        status: 'ok',
        error: '',
        last_ok_at: NOW - 600,
      });
      await t.fetcher.registerPublishers();
      await t.fetcher.fetchOnce(ID1);
      expect(t.ch.publisherRows[1]).toMatchObject({ status: 'error', error: 'timeout', last_ok_at: NOW - 600 });
    });
  });

  describe('logging', () => {
    it('logs the status of a publisher when it changes, not on every attempt', async () => {
      const t = setup();
      await t.fetcher.registerPublishers();
      await t.fetcher.fetchOnce(ID1); // ok -> ok
      expect(t.logger.warn).not.toHaveBeenCalled();

      t.state.answer = new SafeFetchError('http_status', 'the server answered 503', { statusCode: 503 });
      await t.fetcher.fetchOnce(ID1); // ok -> error
      await t.fetcher.fetchOnce(ID1); // error -> error
      await t.fetcher.fetchOnce(ID1);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining(ID1));
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('error (http_status): the server answered 503'),
      );

      t.state.answer = served({ sequence: 8 });
      await t.fetcher.fetchOnce(ID1); // error -> ok
      expect(t.logger.log).toHaveBeenCalledWith(expect.stringContaining(`${ID1}: ok`));
    });

    it('logs the reason and message of a fetch failure, never the error object', async () => {
      const t = setup({
        serve: new SafeFetchError('connect_error', 'the connection failed: ECONNREFUSED', {
          cause: new Error('socket detail'),
        }),
      });
      await t.fetcher.fetchOnce(ID1);
      const logged = [...t.logger.warn.mock.calls, ...t.logger.error.mock.calls, ...t.logger.log.mock.calls];
      expect(logged.length).toBeGreaterThan(0);
      for (const [message, ...rest] of logged) {
        expect(typeof message).toBe('string');
        expect(message).not.toContain('socket detail');
        expect(rest).toEqual([]);
      }
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('error (connect_error): the connection failed: ECONNREFUSED'),
      );
    });

    it('logs a stored list once', async () => {
      const t = setup();
      await t.fetcher.fetchOnce(ID1);
      expect(t.logger.log).toHaveBeenCalledWith(expect.stringContaining('sequence 7'));
    });
  });

  describe('stop', () => {
    it('clears the timers: nothing is fetched after it', async () => {
      const t = setup();
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(0);
      await t.fetcher.stop();
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(t.fetches).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('waits for the fetch in flight, and writes nothing from it', async () => {
      const t = setup();
      const slow = deferred<Fetched>();
      t.get.mockImplementationOnce(() => slow.promise);
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.fetcher.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      slow.resolve({ url: URL1, body: Buffer.from(JSON.stringify(served())) });
      await stopping;
      expect(t.ch.inserts).toHaveLength(0);
      expect(t.metrics.validatorsUnlFetchesTotal.inc).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(t.get).toHaveBeenCalledTimes(1);
    });

    it('does not report a rejection of the attempt it abandoned', async () => {
      const t = setup();
      const slow = deferred<Fetched>();
      t.get.mockImplementationOnce(() => slow.promise);
      t.fetcher.start();
      await jest.advanceTimersByTimeAsync(0);
      const stopping = t.fetcher.stop();
      slow.reject(new SafeFetchError('timeout', 'the fetch ran out of time'));
      await stopping;
      expect(t.logger.warn).not.toHaveBeenCalled();
      expect(t.logger.error).not.toHaveBeenCalled();
    });

    it('may be called again', async () => {
      const t = setup();
      t.fetcher.start();
      await t.fetcher.stop();
      await expect(t.fetcher.stop()).resolves.toBeUndefined();
    });
  });
});

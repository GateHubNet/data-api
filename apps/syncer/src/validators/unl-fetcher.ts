import {
  classifyUnlBlob,
  ClickHouseService,
  decodeManifest,
  listInUse,
  Manifest,
  StoredUnlList,
  Table,
  UnlBlob,
  UnlFailure,
  UnlListError,
  UnlListsRow,
  UnlPublisherConfig,
  UnlPublishersRow,
  ValidatorManifestsRow,
  VerifiedUnlList,
  verifyManifest,
  verifyUnlList,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SyncerConfig, unlPublishersOf, unlThresholdOf } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { describeError } from './describe-error';
import { FetchFailure, SAFE_FETCHER, SafeFetcher, SafeFetchError, UNL_FETCH_LIMITS } from './safe-fetch';
import { readStoredLists } from './stored-lists';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** The wait between two fetches, from the `refresh_interval` of a list or from `GH_UNL_REFRESH_MS`, is kept between these. */
export const UNL_MIN_REFRESH_MS = 60_000;
export const UNL_MAX_REFRESH_MS = 24 * 3_600_000;
/** After a failed attempt the wait is 30 s, doubling with each failure in a row up to 10 min. */
export const UNL_RETRY_INITIAL_MS = 30_000;
export const UNL_RETRY_MAX_MS = 600_000;

/** What one attempt came to: `ok` (a list was stored), `unchanged`, `stale`, `expired`, or the reason it failed. */
export type UnlOutcome = 'ok' | 'unchanged' | 'stale' | 'expired' | UnlFailure | FetchFailure;

/** The label of the fetch counter for a validator manifest of a stored list that was skipped. */
const MANIFEST_INVALID = 'validator_manifest_invalid';

type UnlConfig = Pick<SyncerConfig, 'unlPublishers' | 'unlThreshold' | 'unlRefreshMs'>;
type UnlStore = Pick<ClickHouseService, 'query' | 'insert'>;
type UnlMetrics = Pick<
  PrometheusService,
  'validatorsUnlFetchesTotal' | 'validatorsUnlExpirySeconds' | 'validatorsUnlSize'
>;

/** The fetcher was stopped while an attempt was on its way: the attempt writes nothing and is not reported. */
class Stopped extends Error {
  constructor() {
    super('the UNL fetcher was stopped');
    this.name = 'Stopped';
  }
}

/** One publisher of `GH_UNL_PUBLISHERS` and what the fetcher remembers about it. */
interface Publisher {
  readonly config: UnlPublisherConfig;
  timer?: NodeJS.Timeout;
  /** The attempt under way: one fetch per publisher at a time. */
  inFlight?: Promise<UnlOutcome>;
  /** Failed attempts in a row. */
  failures: number;
  /** How long to wait after the last attempt before the next. */
  waitMs: number;
  /** The status last written, and logged when it changes. */
  status: 'ok' | 'error';
  /** The unix time (seconds, milliseconds as the fraction) of the last ok attempt, `null` when there was none. */
  lastOkAt: number | null;
  /** The highest publisher manifest seen so far, and whether the stored one has been read yet. */
  known?: Manifest;
  knownLoaded: boolean;
}

/** What an attempt made of the response: the outcome, and for a response with new lists those to store. */
interface Verdict {
  outcome: UnlOutcome;
  /** Why, in words for the log. */
  detail?: string;
  /** The new blobs of the response, with its format version and the JSON as served. */
  fresh?: { blobs: UnlBlob[]; version: number; response: string };
  /** The wait the response asked for (ok and unchanged only). */
  refreshMs?: number;
}

interface StoredPublisherRow extends Omit<UnlPublishersRow, 'checked_at' | 'last_ok_at'> {
  last_ok_ms: number | string | null;
}

const failure = (outcome: UnlOutcome, detail: string): Verdict => ({ outcome, detail });
const clamp = (ms: number): number => Math.min(Math.max(ms, UNL_MIN_REFRESH_MS), UNL_MAX_REFRESH_MS);
const backoff = (failures: number): number =>
  Math.min(UNL_RETRY_INITIAL_MS * 2 ** Math.max(failures - 1, 0), UNL_RETRY_MAX_MS);

/**
 * Fetches the validator lists (UNL) of the configured publishers and stores the ones that verify (spec 2.1).
 *
 * **Schedule.** Each publisher has its own timer: a fetch at start, then one after `GH_UNL_REFRESH_MS`, or the
 * `refresh_interval` of the last list (minutes), after an attempt that stored a list or found it unchanged. Either wait is
 * kept between 1 min and 24 h, so that a tiny setting cannot make a loop and a huge one cannot overflow a timer. After any
 * other outcome (a fetch that failed, a response that was rejected, a list that is stale or expired) the wait is 30 s and
 * doubles with each failure in a row, to 10 min. Never two fetches of one publisher at a time, and a timer is set only when
 * the attempt is over, so a slow publisher is not asked again meanwhile.
 *
 * **An attempt.** The body is fetched through the safe fetcher (HTTPS only, 20 s, 1 MiB, 3 redirects), parsed, and verified
 * by `verifyUnlList`: a response that fails any check is rejected whole and nothing of it is stored. Each blob of a
 * response that verified is then compared with the newest sequence stored for the publisher: a new one is written to
 * `unl_lists` (the JSON as served in `response`), after the manifests of its validators, which are decoded, verified, and
 * written to `validator_manifests` with `source = 'unl'`. Only a manifest of the validator it is listed under is used; one
 * that is not is skipped, logged and counted (`outcome="validator_manifest_invalid"`). A revoked manifest has no signing key
 * and is skipped.
 *
 * **Rollback.** A publisher key is rotated by a manifest of a higher sequence. A response that replays an older publisher
 * manifest, with a list signed by the superseded key, must not be accepted: `verifyUnlList` is given the highest manifest
 * seen, which is kept in memory (a revocation too: the response that revoked the key leaves its manifest behind) and, after
 * a restart, decoded from the newest response stored under the configured key. What only a response that stored nothing
 * showed (a revocation, or a rotation) is forgotten with a restart.
 *
 * **Keys.** The id of a publisher is its URL, but sequences and manifests belong to its key. Everything that is compared
 * with a response (the newest stored sequence, the manifest seen before) and the gauges come from the rows stored under the
 * configured key; those of an earlier key stay in `unl_lists` and count for nothing.
 *
 * **Every attempt** writes the `unl_publishers` row of the publisher and updates the metrics; the status of a publisher is
 * logged when it changes. A ClickHouse failure ends the attempt with no outcome (it is logged and retried with the
 * backoff, and no metric is set). What was inserted earlier in the same attempt can remain (the manifests, then the lists,
 * then the publisher row), and the retry then reports `unchanged` only if the lists had landed, else `ok`. `stop()` ends
 * the timers and waits for the attempts under way; one that has not yet written anything writes nothing.
 */
@Injectable()
export class UnlFetcher {
  private readonly publishers = new Map<string, Publisher>();
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private started = false;
  private stopped = false;

  constructor(
    @Inject(SyncerConfig) private readonly cfg: UnlConfig,
    @Inject(ClickHouseService) private readonly ch: UnlStore,
    @Inject(PrometheusService) private readonly metrics: UnlMetrics,
    @Inject(SAFE_FETCHER) private readonly fetcher: Pick<SafeFetcher, 'get'>,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(UnlFetcher.name);
    for (const config of unlPublishersOf(cfg)) {
      this.publishers.set(config.id, {
        config,
        failures: 0,
        waitMs: clamp(cfg.unlRefreshMs),
        status: 'ok',
        lastOkAt: null,
        knownLoaded: false,
      });
    }
  }

  /**
   * At start, writes a row for every configured publisher, and sets `configured = 0` on the stored publishers that are no
   * longer configured. The row of a publisher that has none is `ok` with no `last_ok_at`; the row of one that has keeps
   * its stored status, error and `last_ok_at`, so that the first attempt keeps the last time it was ok.
   */
  async registerPublishers(): Promise<void> {
    const stored = new Map((await this.storedPublishers()).map((row) => [row.publisher, row]));
    const checkedAt = this.now() / 1000;
    const rows: UnlPublishersRow[] = [];
    for (const p of this.publishers.values()) {
      const row = stored.get(p.config.id);
      p.lastOkAt = row?.last_ok_ms == null ? null : Number(row.last_ok_ms) / 1000;
      p.status = row?.status === 'error' ? 'error' : 'ok';
      rows.push(this.publisherRow(p, checkedAt, row?.status ?? 'ok', row?.error ?? '', p.lastOkAt));
    }
    for (const [id, row] of stored) {
      if (this.publishers.has(id) || Number(row.configured) === 0) continue;
      const { last_ok_ms, ...kept } = row;
      rows.push({
        ...kept,
        configured: 0,
        checked_at: checkedAt,
        last_ok_at: last_ok_ms == null ? null : Number(last_ok_ms) / 1000,
      });
    }
    if (rows.length > 0) await this.ch.insert(Table.UnlPublishers, rows);
  }

  /** Starts the timer of every publisher: the first fetch is at once. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const p of this.publishers.values()) this.schedule(p, 0);
  }

  /** Ends the timers and waits for the attempts under way. A fetcher that was stopped does not start again. */
  async stop(): Promise<void> {
    this.stopped = true;
    const inFlight: Promise<unknown>[] = [];
    for (const p of this.publishers.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.timer = undefined;
      if (p.inFlight !== undefined) inFlight.push(p.inFlight);
    }
    await Promise.allSettled(inFlight);
  }

  /**
   * One attempt for the publisher `id`, whose outcome it is. An attempt already under way is the answer: there is never
   * more than one per publisher. Rejects when the publisher is not configured, when ClickHouse fails, and when the fetcher
   * is stopped before the attempt wrote anything.
   */
  fetchOnce(id: string): Promise<UnlOutcome> {
    const p = this.publishers.get(id);
    if (p === undefined) return Promise.reject(new Error(`${id} is not a configured UNL publisher`));
    p.inFlight ??= this.attempt(p).finally(() => {
      p.inFlight = undefined;
    });
    return p.inFlight;
  }

  // -- the schedule ---------------------------------------------------------------------------------------------------

  private schedule(p: Publisher, delayMs: number): void {
    if (this.stopped) return;
    p.timer = setTimeout(() => {
      p.timer = undefined;
      void this.run(p);
    }, delayMs);
  }

  /** One turn of a publisher's loop: an attempt, then the timer for the next. Never rejects. */
  private async run(p: Publisher): Promise<void> {
    try {
      await this.fetchOnce(p.config.id);
    } catch (err) {
      if (this.stopped) return;
      p.failures += 1;
      p.waitMs = backoff(p.failures);
      this.logger.warn(`UNL publisher ${p.config.id}: the attempt failed: ${describeError(err)}`);
    }
    this.schedule(p, p.waitMs);
  }

  // -- an attempt -----------------------------------------------------------------------------------------------------

  private async attempt(p: Publisher): Promise<UnlOutcome> {
    const id = p.config.id;
    const fetched = await this.fetchBody(p);
    this.assertRunning();
    const nowSeconds = this.now() / 1000;
    // the rows of the configured key only: a publisher that changed its key numbers its lists anew
    const stored = (await readStoredLists(this.ch, [id])).filter((list) => list.publisherKey === p.config.publicKey);
    const verdict =
      'body' in fetched
        ? await this.judge(p, fetched.body, stored, nowSeconds)
        : failure(fetched.outcome, fetched.detail);
    this.assertRunning();

    // What is written: the manifests of the new lists, then the lists, then the publisher row. A failure in between leaves
    // nothing a retry cannot finish: the lists decide what is new, and they come last.
    const { fresh } = verdict;
    const { rows: manifests, invalid } = this.validatorManifests(id, fresh?.blobs ?? []);
    if (manifests.length > 0) await this.ch.insert(Table.ValidatorManifests, manifests);
    const lists = fresh === undefined ? [] : fresh.blobs.map((blob) => this.listRow(p, blob, fresh, nowSeconds));
    if (lists.length > 0) await this.ch.insert(Table.UnlLists, lists);

    const { outcome } = verdict;
    const ok = outcome === 'ok' || outcome === 'unchanged';
    const lastOkAt = ok ? nowSeconds : p.lastOkAt;
    await this.ch.insert(Table.UnlPublishers, [
      this.publisherRow(p, nowSeconds, ok ? 'ok' : 'error', ok ? '' : outcome, lastOkAt),
    ]);

    p.lastOkAt = lastOkAt;
    p.failures = ok ? 0 : p.failures + 1;
    p.waitMs = ok ? clamp(verdict.refreshMs ?? this.cfg.unlRefreshMs) : backoff(p.failures);
    this.record(p, verdict, stored, lists, invalid, nowSeconds);
    return outcome;
  }

  /** The `unl_publishers` row of a configured publisher: the one place that knows its url, key and the threshold in force. */
  private publisherRow(
    p: Publisher,
    checkedAt: number,
    status: string,
    error: string,
    lastOkAt: number | null,
  ): UnlPublishersRow {
    return {
      publisher: p.config.id,
      url: p.config.url,
      publisher_key: p.config.publicKey,
      configured: 1,
      threshold: unlThresholdOf(this.cfg),
      checked_at: checkedAt,
      status,
      error,
      last_ok_at: lastOkAt,
    };
  }

  private assertRunning(): void {
    if (this.stopped) throw new Stopped();
  }

  /** The body of the publisher's URL, as text, or why it could not be had. Never throws. */
  private async fetchBody(p: Publisher): Promise<{ body: string } | { outcome: FetchFailure; detail: string }> {
    try {
      const { body } = await this.fetcher.get(p.config.url, UNL_FETCH_LIMITS, 'application/json');
      return { body: body.toString('utf8') };
    } catch (err) {
      // `get` throws SafeFetchError and nothing else; anything else is a failure of the connection all the same
      if (err instanceof SafeFetchError) return { outcome: err.reason, detail: err.message };
      return { outcome: 'connect_error', detail: describeError(err) };
    }
  }

  /** Parses and verifies the response, and decides what each blob is. Rejects only when ClickHouse does. */
  private async judge(p: Publisher, text: string, stored: StoredUnlList[], nowSeconds: number): Promise<Verdict> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failure('invalid_format', 'the body is not JSON');
    }
    if (!p.knownLoaded) {
      p.known = await this.storedManifest(p.config.id, p.config.publicKey);
      p.knownLoaded = true;
    }
    let verified: VerifiedUnlList;
    try {
      verified = verifyUnlList(json, p.config.publicKey, p.known);
    } catch (err) {
      if (err instanceof UnlListError) {
        if (err.reason === 'revoked') p.known = this.revocationIn(json, p.config.publicKey) ?? p.known;
        return failure(err.reason, err.message);
      }
      throw err;
    }
    p.known = verified.manifest;

    const newest = stored.reduce<number | undefined>(
      (high, l) => (high === undefined || l.sequence > high ? l.sequence : high),
      undefined,
    );
    const kinds = verified.blobs.map((blob) => classifyUnlBlob(blob, newest, nowSeconds));
    const blobs = verified.blobs.filter((_, i) => kinds[i] === 'new');
    const refreshMs =
      verified.refreshIntervalMinutes === undefined ? undefined : verified.refreshIntervalMinutes * 60_000;
    if (blobs.length > 0) {
      return { outcome: 'ok', fresh: { blobs, version: verified.version, response: text }, refreshMs };
    }
    if (kinds.includes('unchanged')) return { outcome: 'unchanged', refreshMs };
    const first = verified.blobs[0];
    return kinds[0] === 'stale'
      ? failure('stale', `sequence ${first.sequence} is below the newest stored, ${newest}`)
      : failure('expired', `sequence ${first.sequence} expired at ${new Date(first.expiration * 1000).toISOString()}`);
  }

  /**
   * The manifest that revokes the publisher key, in the manifests of a body that `verifyUnlList` refused as `revoked`: the
   * highest of its top-level one and the own ones of its version 2 entries that decode, verify and are the configured key's
   * own, when that one revokes. Kept as the manifest seen, it makes every later body with a lower sequence `revoked` too, in
   * this process; the response stores nothing, so a restart forgets it.
   */
  private revocationIn(body: unknown, key: string): Manifest | undefined {
    const root = (body ?? {}) as { manifest?: unknown; blobs_v2?: unknown };
    const entries = Array.isArray(root.blobs_v2) ? (root.blobs_v2 as { manifest?: unknown }[]) : [];
    let highest: Manifest | undefined;
    for (const candidate of [root.manifest, ...entries.map((entry) => entry?.manifest)]) {
      if (typeof candidate !== 'string') continue;
      try {
        const manifest = decodeManifest(candidate, 'base64');
        if (manifest.masterKeyHex !== key || !verifyManifest(manifest)) continue;
        if (highest === undefined || manifest.sequence > highest.sequence) highest = manifest;
      } catch {
        // a manifest that does not decode was not what revoked the key
      }
    }
    return highest?.revoked ? highest : undefined;
  }

  /**
   * The publisher manifest of the newest list stored for the publisher under `key`, `undefined` when there is none or it
   * cannot be read.
   */
  private async storedManifest(id: string, key: string): Promise<Manifest | undefined> {
    const [row] = await this.ch.query<{ response: string }>(
      `SELECT response FROM ${Table.UnlLists}
        WHERE publisher = {publisher:String} AND publisher_key = {key:String}
        ORDER BY fetched_at DESC LIMIT 1`,
      { publisher: id, key },
    );
    if (row === undefined) return undefined;
    try {
      const body = JSON.parse(row.response) as { manifest?: unknown } | null;
      return typeof body?.manifest === 'string' ? decodeManifest(body.manifest, 'base64') : undefined;
    } catch {
      return undefined;
    }
  }

  private listRow(
    p: Publisher,
    blob: UnlBlob,
    response: NonNullable<Verdict['fresh']>,
    fetchedAt: number,
  ): UnlListsRow {
    return {
      publisher: p.config.id,
      publisher_key: p.config.publicKey,
      sequence: blob.sequence,
      version: response.version,
      effective: blob.effective ?? null,
      expiration: blob.expiration,
      validators: blob.validators.map((validator) => validator.masterKey).sort(),
      blob_sha256: blob.blobSha256,
      fetched_at: fetchedAt,
      response: response.response,
    };
  }

  /**
   * The rows for `validator_manifests` of the validators of new lists. A manifest listed in several lists is one row. A
   * manifest that does not decode, is not the listed validator's own, or does not verify is skipped and logged, and counted
   * by the caller; a revoked one has no signing key to map and is skipped without a word.
   */
  private validatorManifests(id: string, fresh: UnlBlob[]): { rows: ValidatorManifestsRow[]; invalid: number } {
    const rows: ValidatorManifestsRow[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    for (const blob of fresh) {
      for (const validator of blob.validators) {
        // the same manifest under another validator is a different case: it may be invalid there and valid here
        const key = `${validator.masterKey}\u0000${validator.manifest}`;
        if (validator.manifest === undefined || seen.has(key)) continue;
        seen.add(key);
        const manifest = this.decodeValidatorManifest(id, validator.masterKey, validator.manifest);
        if (manifest === 'invalid') {
          invalid += 1;
        } else if (!manifest.revoked) {
          rows.push({
            ephemeral_key: manifest.signingKey as string,
            master_key: manifest.masterKey,
            seq: manifest.sequence,
            domain: manifest.domain ?? '',
            manifest: manifest.hex,
            source: 'unl',
          });
        }
      }
    }
    return { rows, invalid };
  }

  private decodeValidatorManifest(id: string, masterKey: string, base64: string): Manifest | 'invalid' {
    let why: string | undefined;
    let manifest: Manifest | undefined;
    try {
      manifest = decodeManifest(base64, 'base64');
      if (manifest.masterKey !== masterKey) why = 'it is the manifest of another key';
      else if (!verifyManifest(manifest)) why = 'it does not verify';
    } catch (err) {
      why = describeError(err);
    }
    if (why === undefined && manifest !== undefined) return manifest;
    this.logger.warn(`UNL publisher ${id}: skipped the manifest of validator ${masterKey}: ${why}`);
    return 'invalid';
  }

  // -- metrics and logs -----------------------------------------------------------------------------------------------

  /** The metrics of the attempt, and the log lines: the lists stored, and the status of the publisher when it changed. */
  private record(
    p: Publisher,
    verdict: Verdict,
    stored: StoredUnlList[],
    written: UnlListsRow[],
    invalidManifests: number,
    nowSeconds: number,
  ): void {
    const id = p.config.id;
    const { outcome } = verdict;
    for (const row of written) {
      this.logger.log(
        `UNL publisher ${id}: stored list sequence ${row.sequence} of ${row.validators.length} validators, ` +
          `expires ${new Date(row.expiration * 1000).toISOString()}`,
      );
    }

    const status = outcome === 'ok' || outcome === 'unchanged' ? 'ok' : 'error';
    if (status !== p.status) {
      if (status === 'ok') this.logger.log(`UNL publisher ${id}: ok`);
      else this.logger.warn(`UNL publisher ${id}: error (${outcome}): ${verdict.detail ?? 'no detail'}`);
      p.status = status;
    }

    this.metrics.validatorsUnlFetchesTotal.inc({ publisher: id, outcome });
    for (let i = 0; i < invalidManifests; i++) {
      this.metrics.validatorsUnlFetchesTotal.inc({ publisher: id, outcome: MANIFEST_INVALID });
    }
    const lists = [
      ...stored,
      ...written.map((row) => ({
        publisher: id,
        sequence: Number(row.sequence),
        version: row.version,
        ...(row.effective === null ? {} : { effective: row.effective }),
        expiration: row.expiration,
        validators: row.validators,
        fetchedAt: row.fetched_at,
      })),
    ];
    const inUse = listInUse(lists, id, nowSeconds);
    if (inUse !== undefined) {
      this.metrics.validatorsUnlExpirySeconds.set({ publisher: id }, inUse.list.expiration - nowSeconds);
      this.metrics.validatorsUnlSize.set({ publisher: id }, inUse.list.validators.length);
    }
  }

  private storedPublishers(): Promise<StoredPublisherRow[]> {
    return this.ch.query<StoredPublisherRow>(
      `SELECT publisher,
              argMax(url, checked_at) AS url,
              argMax(publisher_key, checked_at) AS publisher_key,
              argMax(configured, checked_at) AS configured,
              argMax(threshold, checked_at) AS threshold,
              argMax(status, checked_at) AS status,
              argMax(error, checked_at) AS error,
              toUnixTimestamp64Milli(argMax(last_ok_at, checked_at)) AS last_ok_ms
         FROM ${Table.UnlPublishers}
        GROUP BY publisher
        ORDER BY publisher`,
    );
  }
}

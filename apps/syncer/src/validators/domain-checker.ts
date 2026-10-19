import {
  ClickHouseService,
  decodeManifest,
  isProperlyFormedTomlDomain,
  KEY_MAP_WITH,
  listInUse,
  mappedKey,
  NetworkProfile,
  NEWEST_MANIFEST_ORDER,
  NodeClient,
  Table,
  ValidatorDomainsRow,
  ValidatorManifestsRow,
  verifyManifest,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NETWORK_PROFILE, NODE_CLIENT, SyncerConfig, unlPublishersOf } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { describeError, isRippledError, rippledCodeOf, SIMPLE_NAME } from './describe-error';
import { SAFE_FETCHER, SafeFetcher, SafeFetchError, tomlFetchLimits } from './safe-fetch';
import { readStoredLists } from './stored-lists';
import { matchToml, TomlInvalidError } from './toml-match';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** Checks (rows written) in one pass, and node lookups in one pass. */
export const DOMAIN_PASS_LIMIT = 100;
/** Fetches (and node lookups) in flight at once. */
export const DOMAIN_FETCH_CONCURRENCY = 4;
/** A validator is checked when it was seen in the last 30 days. */
export const DOMAIN_SEEN_WITHIN_S = 30 * 86_400;
/** A key without raw manifest bytes is asked of the node at most this often, and the node gets this long to answer. */
export const MANIFEST_LOOKUP_INTERVAL_MS = 600_000;
export const MANIFEST_LOOKUP_TIMEOUT_MS = 5_000;
/** A transient failure is checked again after an hour; it keeps `verified` for this long after the last success. */
export const DOMAIN_TRANSIENT_RECHECK_S = 3_600;
export const DOMAIN_VERIFIED_GRACE_S = 86_400;

/** The manifests verified between two turns of the event loop: a verification costs about 2 ms. */
export const DOMAIN_VERIFICATIONS_PER_TURN = 50;

const ACCEPT = 'application/toml, text/plain, */*';
const MAX_UINT32 = 0xffff_ffff;

/** Why a domain is not verified (`''` when it is). The fetch failures are those of the safe fetcher. */
export type DomainReason =
  | ''
  | 'not_listed'
  | 'toml_invalid'
  | 'too_large'
  | 'redirect_rejected'
  | 'blocked_address'
  | 'domain_invalid'
  | 'manifest_unverified'
  | 'http_status'
  | 'dns_error'
  | 'connect_error'
  | 'tls_error'
  | 'timeout';

/** What one check of a (validator, domain) pair came to. */
export interface DomainCheck {
  key: string;
  domain: string;
  /** The URL fetched, or that would be. */
  tomlUrl: string;
  reason: DomainReason;
  /** The HTTP status of an `http_status` failure. */
  statusCode?: number;
  /** The accounts of a verified domain: sorted, at most 10. */
  accounts?: string[];
}

/**
 * Whether a failure may pass by itself (a website that blips) and so is checked again soon and does not take the badge from
 * a domain that was verified a moment ago: the network failures, a 5xx and a 429. A 4xx, a file that is not what it should
 * be, and every other reason are definite.
 */
export function isTransientReason(reason: DomainReason, statusCode?: number): boolean {
  if (reason === 'dns_error' || reason === 'connect_error' || reason === 'tls_error' || reason === 'timeout')
    return true;
  return reason === 'http_status' && statusCode !== undefined && (statusCode >= 500 || statusCode === 429);
}

/**
 * The row to store for a check (spec 2.2). `prev` is the stored row of the same (validator, domain), `now` unix seconds.
 *
 * - **verified**: `verified`, `verified_at` now, the accounts, the next check after `recheckMs`.
 * - **a definite failure**: `unverified` with the reason (and the status code of an `http_status`), no accounts, the time of
 *   the last success kept, the next check after `recheckMs`.
 * - **a transient failure**: the next check after an hour. A domain that was verified at most 24 h ago stays `verified`
 *   (its `verified_at` and accounts unchanged), so that a website that blips does not flap the badge; otherwise it is
 *   `unverified` with the reason and no accounts.
 */
export function nextDomainRow(
  prev: ValidatorDomainsRow | undefined,
  check: DomainCheck,
  now: number,
  recheckMs: number,
): ValidatorDomainsRow {
  const row = {
    validation_public_key: check.key,
    domain: check.domain,
    toml_url: check.tomlUrl,
    checked_at: now,
  };
  // a whole second: `next_check_at` is a `DateTime`
  const after = (seconds: number) => Math.ceil(now + seconds);

  if (check.reason === '') {
    return {
      ...row,
      status: 'verified',
      reason: '',
      status_code: 0,
      verified_at: now,
      next_check_at: after(recheckMs / 1000),
      accounts: [...(check.accounts ?? [])],
    };
  }

  const verifiedAt = prev?.verified_at ?? null;
  const unverified = (nextCheckSeconds: number): ValidatorDomainsRow => ({
    ...row,
    status: 'unverified',
    reason: check.reason,
    status_code: check.reason === 'http_status' ? (check.statusCode ?? 0) : 0,
    verified_at: verifiedAt,
    next_check_at: after(nextCheckSeconds),
    accounts: [],
  });

  if (!isTransientReason(check.reason, check.statusCode)) return unverified(recheckMs / 1000);
  if (prev?.status === 'verified' && verifiedAt !== null && now - verifiedAt <= DOMAIN_VERIFIED_GRACE_S) {
    return {
      ...row,
      status: 'verified',
      reason: '',
      status_code: 0,
      verified_at: verifiedAt,
      next_check_at: after(DOMAIN_TRANSIENT_RECHECK_S),
      accounts: [...prev.accounts],
    };
  }
  return unverified(DOMAIN_TRANSIENT_RECHECK_S);
}

// -- the checker --------------------------------------------------------------------------------------------------------

type CheckerConfig = Pick<SyncerConfig, 'unlPublishers' | 'domainRecheckMs' | 'domainFetchTimeoutMs'>;
type CheckerStore = Pick<ClickHouseService, 'query' | 'insert'>;

/** The newest manifest of a master key, as stored: the highest `seq`, preferring a row with raw bytes among equals. */
interface NewestManifestRow {
  master_key: string;
  top_domain: string;
  top_manifest: string;
}

interface StoredDomainRow {
  validation_public_key: string;
  domain: string;
  status: string;
  reason: string;
  status_code: number | string;
  toml_url: string;
  checked_ms: number | string;
  verified_ms: number | string | null;
  next_check: number | string;
  accounts: string[];
}

/** A (validator, domain) pair to check. `failure` is set when the check has no need of the website. */
interface Candidate {
  key: string;
  domain: string;
  tomlUrl: string;
  failure?: 'manifest_unverified' | 'domain_invalid';
}

/** What verifying the raw bytes of a manifest of a key found: the verified domain (`''` for none), or that it does not verify. */
type Verdict = { verified: true; domain: string } | { verified: false };

/** A fetch that did not give a file. */
type FetchFailed = Pick<DomainCheck, 'reason' | 'statusCode'>;

/** A `manifest` answer of the node: `details` of the manifest it knows, and the manifest itself in base64. */
interface ManifestAnswer {
  details?: { master_key?: unknown; ephemeral_key?: unknown; seq?: unknown; domain?: unknown };
  manifest?: unknown;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The name of whatever was thrown (`TypeError`; `string` for a thrown text), `Error` when it is not a plain name. */
function errorNameOf(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return SIMPLE_NAME.test(name) ? name : 'Error';
}
/** `a x2, b` for the counts of a map: the keys sorted, a count above 1 shown. */
const countsText = (counts: Map<string, number>): string =>
  [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, n]) => (n > 1 ? `${name} x${n}` : name))
    .join(', ');
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** A text from a manifest, safe for a log line: quoted, control characters escaped, cut short. */
const quoted = (text: string): string => JSON.stringify(text.length > 128 ? `${text.slice(0, 128)}...` : text);
const pairOf = (key: string, domain: string): string => `${key}\u0000${domain}`;

/** The row to store for the answer of the node to `manifest` for `key`, `undefined` for an answer that cannot be used. */
function manifestRowOf(key: string, answer: unknown): ValidatorManifestsRow | undefined {
  const { details, manifest } = (typeof answer === 'object' && answer !== null ? answer : {}) as ManifestAnswer;
  if (typeof details !== 'object' || details === null || details.master_key !== key) return undefined;
  const { ephemeral_key: ephemeral, seq, domain } = details;
  if (typeof ephemeral !== 'string' || ephemeral === '') return undefined;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_UINT32) return undefined;
  if (typeof manifest !== 'string' || manifest === '' || !BASE64.test(manifest)) return undefined;
  return {
    ephemeral_key: ephemeral,
    master_key: key,
    seq,
    domain: typeof domain === 'string' ? domain : '',
    manifest: Buffer.from(manifest, 'base64').toString('hex').toUpperCase(),
    source: 'rpc',
  };
}

/**
 * Verifies the domains of the validators (spec 2.2). A pass (`pass()`, made every 60 s by the worker) takes
 *
 * 1. **the validators**: the masters on the list in use of each configured publisher (only the lists stored under the key
 *    configured for it), and those seen in the last 30 days (`validator_seen`);
 * 2. **their newest manifest** (the highest `seq` per master key). A row with raw bytes is decoded and verified here, and
 *    must be the key's own: the stream's word is not enough (`manifest_unverified`). The domain is that of the verified
 *    manifest; a validator that has none is not checked and has no row. A row without raw bytes (from before migration 002)
 *    is asked of the node at the end of the pass, `manifest` with the master key, at most once in 10 minutes per key, 5 s,
 *    no retry, and the answer is stored with `source = 'rpc'`; it is checked in a later pass, like any manifest;
 * 3. **the pairs due**: no stored row for (key, domain), or `next_check_at` passed (a changed domain is a new pair). Never
 *    checked first, then the oldest `next_check_at`, at most 100 a pass;
 * 4. **the checks**. A domain whose syntax is not that of rippled's `isProperlyFormedTomlDomain` is `domain_invalid` before
 *    any DNS query. Of the others, one fetch per domain (shared by the validators that name it), at most 4 in flight, of
 *    `https://{domain}{tomlPath}` through the safe fetcher, with no fall-back to the other name. The file is matched with
 *    `matchToml` and the row follows from `nextDomainRow`. The rows of a domain are written as soon as it is done.
 *
 * **Logs** name a reason, a status code, an address class and a domain (quoted: it comes from a manifest), never a body, an
 * error object or the message of a failure. The result of a pair is logged when it changes; a fetch blocked by the address
 * policy is logged at `warn` every time. The metric `syncer_validators_domain_checks_total{outcome}` counts every check as
 * `verified` or the reason, also a transient failure that left a domain verified.
 *
 * `stop()` starts nothing more, writes nothing for what is on its way, and waits for it.
 */
@Injectable()
export class DomainChecker {
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** When each key was last asked for its manifest (ms). */
  private readonly askedAt = new Map<string, number>();
  /** The result of verifying the manifests of the last pass, so that a manifest is not verified again every minute. */
  private verdicts = new Map<string, Verdict>();
  /** The fetch failures of the pass under way that were not the safe fetcher's own, by the name of the error. */
  private foreignFetchErrors = new Map<string, number>();
  private running?: Promise<number>;
  private stopped = false;

  constructor(
    @Inject(SyncerConfig) private readonly cfg: CheckerConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: Pick<NetworkProfile, 'tomlPath'>,
    @Inject(ClickHouseService) private readonly ch: CheckerStore,
    @Inject(PrometheusService) private readonly metrics: Pick<PrometheusService, 'validatorsDomainChecksTotal'>,
    @Inject(SAFE_FETCHER) private readonly fetcher: Pick<SafeFetcher, 'get'>,
    @Inject(NODE_CLIENT) private readonly node: Pick<NodeClient, 'request'>,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(DomainChecker.name);
  }

  /**
   * One pass; resolves with the number of checks made (rows written). A pass called while one is under way is that pass.
   * Rejects when ClickHouse fails: nothing that was not written is lost, the pairs are still due.
   */
  pass(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Starts nothing more and waits for the pass under way. A checker that was stopped makes no more passes. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<number> {
    this.foreignFetchErrors = new Map();
    try {
      const now = this.now() / 1000;
      const keys = await this.validatorKeys(now);
      if (keys.length === 0 || this.stopped) return 0;

      const newest = await this.newestManifests(keys);
      let checked = 0;
      const candidates = await this.candidates(newest);
      if (candidates.length > 0 && !this.stopped) {
        const stored = await this.storedDomains([...new Set(candidates.map((c) => c.key))]);
        const due = this.dueFirst(candidates, stored, now).slice(0, DOMAIN_PASS_LIMIT);
        checked = await this.check(due, stored);
      }
      // last: a node that is slow to answer must not hold up the checks of the manifests that are known
      await this.lookUpManifests(newest.filter((m) => m.manifest === ''));
      return checked;
    } finally {
      this.reportForeignFetchErrors();
    }
  }

  /** One line for the fetches of the pass that failed with an error the fetcher does not throw: the names, no more. */
  private reportForeignFetchErrors(): void {
    if (this.foreignFetchErrors.size === 0) return;
    const total = [...this.foreignFetchErrors.values()].reduce((sum, n) => sum + n, 0);
    this.logger.warn(
      `Domain verification: ${total} ${total === 1 ? 'fetch' : 'fetches'} failed with an error that is not the fetcher's own ` +
        `(${countsText(this.foreignFetchErrors)})`,
    );
    this.foreignFetchErrors = new Map();
  }

  // -- which validators ---------------------------------------------------------------------------------------------

  /** The masters on a list in use now, and those seen in the last 30 days: sorted, once each. */
  private async validatorKeys(now: number): Promise<string[]> {
    const keys = new Set<string>();
    const publishers = unlPublishersOf(this.cfg);
    const lists = await readStoredLists(
      this.ch,
      publishers.map((p) => p.id),
    );
    for (const p of publishers) {
      // the lists numbered under the key configured for the publisher: those of an earlier key count for nothing
      const own = lists.filter((list) => list.publisher === p.id && list.publisherKey === p.publicKey);
      for (const key of listInUse(own, p.id, now)?.list.validators ?? []) keys.add(key);
    }
    // a validator seen under its signing key is that of its master: the keys go through the manifest map first, which the
    // statement computes itself
    const seen = await this.ch.query<{ master: string }>(
      `WITH ${KEY_MAP_WITH}
       SELECT ${mappedKey('validation_public_key')} AS master
         FROM ${Table.ValidatorSeen}
        GROUP BY master
       HAVING toUnixTimestamp(max(last_seen)) >= {since:UInt32}
        ORDER BY master`,
      { since: Math.max(Math.floor(now) - DOMAIN_SEEN_WITHIN_S, 0) },
    );
    for (const row of seen) keys.add(row.master);
    return [...keys].sort();
  }

  /** The newest manifest of each of the masters that has one (`NEWEST_MANIFEST_ORDER`: of one `seq`, the one with raw bytes). */
  private async newestManifests(keys: string[]): Promise<{ key: string; domain: string; manifest: string }[]> {
    // the aliases differ from the columns on purpose: ClickHouse would read a column named like an alias as the alias
    const rows = await this.ch.query<NewestManifestRow>(
      `SELECT master_key,
              argMax(domain, ${NEWEST_MANIFEST_ORDER}) AS top_domain,
              argMax(manifest, ${NEWEST_MANIFEST_ORDER}) AS top_manifest
         FROM ${Table.ValidatorManifests}
        WHERE master_key IN {keys:Array(String)}
        GROUP BY master_key
        ORDER BY master_key`,
      { keys },
    );
    return rows.map((row) => ({ key: row.master_key, domain: row.top_domain, manifest: row.top_manifest }));
  }

  // -- manifests without raw bytes ------------------------------------------------------------------------------------

  /**
   * Asks the node for the manifest of each key (at most 100 and 4 at a time, a key at most once in 10 minutes, whatever came
   * of it) and stores the answers that can be used, as `rpc` rows. Nothing is checked from an answer in this pass.
   */
  private async lookUpManifests(missing: { key: string }[]): Promise<void> {
    const nowMs = this.now();
    for (const [key, askedAt] of this.askedAt) {
      if (nowMs - askedAt >= MANIFEST_LOOKUP_INTERVAL_MS) this.askedAt.delete(key);
    }
    const keys = missing
      .map((m) => m.key)
      .filter((key) => !this.askedAt.has(key))
      .slice(0, DOMAIN_PASS_LIMIT);
    if (keys.length === 0 || this.stopped) return;
    for (const key of keys) this.askedAt.set(key, nowMs);

    const rows: ValidatorManifestsRow[] = [];
    let failures = 0;
    let firstFailure = '';
    const answeredWithError = new Map<string, number>();
    await this.inLanes(keys, async (key) => {
      try {
        const answer = await this.node.request<ManifestAnswer>(
          { command: 'manifest', public_key: key },
          { timeoutMs: MANIFEST_LOOKUP_TIMEOUT_MS, retries: 0 },
        );
        const row = manifestRowOf(key, answer);
        if (row !== undefined) rows.push(row);
      } catch (err) {
        if (isRippledError(err)) {
          // the node's own answer (it does not know the key, it is busy): counted by its error code
          const code = rippledCodeOf(err);
          answeredWithError.set(code, (answeredWithError.get(code) ?? 0) + 1);
          return;
        }
        failures += 1;
        firstFailure ||= describeError(err);
      }
    });
    if (this.stopped) return;
    if (rows.length > 0) await this.ch.insert(Table.ValidatorManifests, rows);
    const problems: string[] = [];
    if (failures > 0) problems.push(`${failures} of ${keys.length} manifest lookups failed (first: ${firstFailure})`);
    const answered = [...answeredWithError.values()].reduce((sum, n) => sum + n, 0);
    if (answered > 0) {
      problems.push(`${answered} of ${keys.length} were answered with an error (${countsText(answeredWithError)})`);
    }
    if (problems.length > 0) this.logger.warn(`Domain verification: ${problems.join('; ')}`);
  }

  // -- the pairs ----------------------------------------------------------------------------------------------------

  /**
   * The pairs to check from the newest manifests that have raw bytes: the bytes are verified here (the master's own signature
   * and, unless it revokes, the signing key's, and the key must be the row's), and the domain is the verified manifest's.
   * An unverified manifest keeps the domain it claims, so that the failure is shown with it. No domain, no pair.
   */
  private async candidates(manifests: { key: string; domain: string; manifest: string }[]): Promise<Candidate[]> {
    const verdicts = new Map<string, Verdict>();
    const pairs: Candidate[] = [];
    let verifications = 0;
    for (const { key, domain: claimed, manifest } of manifests) {
      if (manifest === '') continue;
      const id = pairOf(key, manifest);
      let verdict = this.verdicts.get(id);
      if (verdict === undefined) {
        verdict = verdictOf(key, manifest);
        // the first pass after a start verifies every manifest: let the rest of the process run in between
        if (++verifications % DOMAIN_VERIFICATIONS_PER_TURN === 0) await yieldToEventLoop();
      }
      verdicts.set(id, verdict);

      const domain = verdict.verified ? verdict.domain : claimed;
      if (domain === '') continue;
      const tomlUrl = `https://${domain}${this.profile.tomlPath}`;
      const failure = !verdict.verified
        ? 'manifest_unverified'
        : !isProperlyFormedTomlDomain(domain)
          ? 'domain_invalid'
          : undefined;
      pairs.push({ key, domain, tomlUrl, ...(failure === undefined ? {} : { failure }) });
    }
    this.verdicts = verdicts;
    return pairs;
  }

  private async storedDomains(keys: string[]): Promise<Map<string, ValidatorDomainsRow>> {
    const rows = await this.ch.query<StoredDomainRow>(
      `SELECT validation_public_key, domain,
              argMax(status, checked_at) AS status,
              argMax(reason, checked_at) AS reason,
              argMax(status_code, checked_at) AS status_code,
              argMax(toml_url, checked_at) AS toml_url,
              toUnixTimestamp64Milli(max(checked_at)) AS checked_ms,
              toUnixTimestamp64Milli(argMax(verified_at, checked_at)) AS verified_ms,
              toUnixTimestamp(argMax(next_check_at, checked_at)) AS next_check,
              argMax(accounts, checked_at) AS accounts
         FROM ${Table.ValidatorDomains}
        WHERE validation_public_key IN {keys:Array(String)}
        GROUP BY validation_public_key, domain`,
      { keys },
    );
    return new Map(
      rows.map((row) => [
        pairOf(row.validation_public_key, row.domain),
        {
          validation_public_key: row.validation_public_key,
          domain: row.domain,
          status: row.status,
          reason: row.reason,
          status_code: Number(row.status_code),
          toml_url: row.toml_url,
          checked_at: Number(row.checked_ms) / 1000,
          verified_at: row.verified_ms === null ? null : Number(row.verified_ms) / 1000,
          next_check_at: Number(row.next_check),
          accounts: row.accounts,
        },
      ]),
    );
  }

  /** The pairs due at `now`: never checked first, then the oldest `next_check_at`. */
  private dueFirst(candidates: Candidate[], stored: Map<string, ValidatorDomainsRow>, now: number): Candidate[] {
    const nextCheck = (c: Candidate) => stored.get(pairOf(c.key, c.domain))?.next_check_at;
    return candidates
      .filter((c) => (nextCheck(c) ?? -Infinity) <= now)
      .sort((a, b) => {
        const [na, nb] = [nextCheck(a), nextCheck(b)];
        if ((na === undefined) !== (nb === undefined)) return na === undefined ? -1 : 1;
        return (
          (na ?? 0) - (nb ?? 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
          (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)
        );
      });
  }

  // -- the checks ---------------------------------------------------------------------------------------------------

  /** Writes the rows of the pairs due: the ones that need no website at once, the others as their domain is fetched. */
  private async check(due: Candidate[], stored: Map<string, ValidatorDomainsRow>): Promise<number> {
    let checked = 0;
    const failed = due.filter((c) => c.failure !== undefined);
    if (failed.length > 0) {
      checked += await this.record(
        failed.map((c) => ({ key: c.key, domain: c.domain, tomlUrl: c.tomlUrl, reason: c.failure as DomainReason })),
        stored,
      );
    }

    // one fetch per domain, whoever names it and however it is written
    const byDomain = new Map<string, Candidate[]>();
    for (const c of due.filter((p) => p.failure === undefined)) {
      const group = byDomain.get(c.domain.toLowerCase());
      if (group === undefined) byDomain.set(c.domain.toLowerCase(), [c]);
      else group.push(c);
    }
    await this.inLanes([...byDomain.values()], async (group) => {
      const written = await this.checkDomain(group, stored);
      checked += written;
    });
    return checked;
  }

  /** Fetches the file of a domain once and judges the file for each validator that names the domain. */
  private async checkDomain(group: Candidate[], stored: Map<string, ValidatorDomainsRow>): Promise<number> {
    const file = await this.fetchFile(group[0].tomlUrl, group[0].domain);
    if (this.stopped) return 0;
    const checks = group.map(
      (c): DomainCheck => ({
        key: c.key,
        domain: c.domain,
        tomlUrl: c.tomlUrl,
        ...('text' in file ? judge(file.text, c.key) : file),
      }),
    );
    return this.record(checks, stored);
  }

  /** The text of the file at `url`, or why it could not be had. Never throws. */
  private async fetchFile(url: string, domain: string): Promise<{ text: string } | FetchFailed> {
    try {
      const { body } = await this.fetcher.get(url, tomlFetchLimits(this.cfg.domainFetchTimeoutMs), ACCEPT);
      return { text: body.toString('utf8') };
    } catch (err) {
      // `get` throws SafeFetchError and nothing else; anything else is a failure of the connection all the same
      if (!(err instanceof SafeFetchError)) {
        const name = errorNameOf(err);
        this.foreignFetchErrors.set(name, (this.foreignFetchErrors.get(name) ?? 0) + 1);
        return { reason: 'connect_error' };
      }
      if (err.reason === 'blocked_address') {
        this.logger.warn(
          `Domain ${quoted(domain)}: the fetch was blocked (blocked_address, ${err.addressClass ?? 'unknown range'})`,
        );
      }
      return { reason: err.reason, statusCode: err.statusCode };
    }
  }

  /** Writes the rows of the checks, then counts and logs them. */
  private async record(checks: DomainCheck[], stored: Map<string, ValidatorDomainsRow>): Promise<number> {
    if (this.stopped) return 0;
    const now = this.now() / 1000;
    const rows = checks.map((c) =>
      nextDomainRow(stored.get(pairOf(c.key, c.domain)), c, now, this.cfg.domainRecheckMs),
    );
    await this.ch.insert(Table.ValidatorDomains, rows);
    checks.forEach((check, i) => {
      this.metrics.validatorsDomainChecksTotal.inc({ outcome: check.reason === '' ? 'verified' : check.reason });
      this.logChange(stored.get(pairOf(check.key, check.domain)), rows[i], check);
    });
    return rows.length;
  }

  /** Logs the result of a pair when it is not the one stored. A blocked fetch has been logged, at warn, when it was made. */
  private logChange(prev: ValidatorDomainsRow | undefined, row: ValidatorDomainsRow, check: DomainCheck): void {
    if (check.reason === 'blocked_address') return;
    if (
      prev !== undefined &&
      prev.status === row.status &&
      prev.reason === row.reason &&
      prev.status_code === row.status_code
    ) {
      return;
    }
    const why = row.reason === '' ? '' : ` (${row.reason}${row.status_code === 0 ? '' : ` ${row.status_code}`})`;
    this.logger.log(`Validator ${row.validation_public_key}: domain ${quoted(row.domain)} is ${row.status}${why}`);
  }

  /**
   * Runs `fn` over the items, at most 4 at a time, none started once the checker is stopped. When one fails the others that
   * are on their way are waited for, no more are started, and the first failure is thrown.
   */
  private async inLanes<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failure: { error: unknown } | undefined;
    const lane = async (): Promise<void> => {
      while (!this.stopped && failure === undefined && next < items.length) {
        const item = items[next++];
        try {
          await fn(item);
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOMAIN_FETCH_CONCURRENCY, items.length) }, lane));
    if (failure !== undefined) throw failure.error;
  }
}

/** Whether the raw manifest (hex) verifies and is the key's own, and the domain it names. */
function verdictOf(key: string, hex: string): Verdict {
  try {
    const manifest = decodeManifest(hex, 'hex');
    if (manifest.masterKey !== key || !verifyManifest(manifest)) return { verified: false };
    return { verified: true, domain: manifest.domain ?? '' };
  } catch {
    return { verified: false };
  }
}

/** What the file says about the key: verified, or why not. */
function judge(text: string, key: string): Pick<DomainCheck, 'reason' | 'accounts'> {
  try {
    const { listed, accounts } = matchToml(text, key);
    return listed ? { reason: '', accounts } : { reason: 'not_listed' };
  } catch (err) {
    if (err instanceof TomlInvalidError) return { reason: 'toml_invalid' };
    throw err;
  }
}

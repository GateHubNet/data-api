import {
  ClickHouseService,
  DomainTomlsRow,
  NetworkProfile,
  readStoredTomls,
  readToml,
  Table,
  TomlInvalidError,
  tomlUrlOf,
  UnixSeconds,
  UnixSecondsMs,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { countsText, errorNameOf, quoted } from '../validators/domain-checker';
import { SafeFetcher, SafeFetchError, tomlFetchLimits } from '../validators/safe-fetch';
import { DomainDiscovery } from './domain-discovery';
import { nextTomlRow, TomlCheck, TomlFailure } from './toml-row';
import { TOMLS_SAFE_FETCHER, TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from './tomls.options';

/** Domains checked in one pass (spec 4.2). */
export const TOML_PASS_LIMIT = 300;
/** Fetches in flight at once. */
export const TOML_FETCH_CONCURRENCY = 16;
/** Rows inserted at once: 300 inserts of one row a minute would make parts. */
export const TOML_WRITE_BATCH = 50;
/** A domain named anew is checked again once it was last checked more than this long ago: at most hourly. */
export const TOML_NAMED_ANEW_AFTER_S = 3_600;
/** Domains named in the warning about the fetches that were blocked. */
const BLOCKED_NAMED = 5;

const ACCEPT = 'application/toml, text/plain, */*';

/**
 * The schedule of every stored domain, in four columns (spec 4.2): when it is next checked, when it was last, and the failures
 * in a row. Each is of the newest row of the domain, the one with the largest `checked_at`. The aliases differ from the
 * columns on purpose: ClickHouse would read a column named like an alias as the alias.
 */
export const TOML_SCHEDULE_SQL = `SELECT domain,
       toUnixTimestamp(argMax(next_check_at, checked_at)) AS next_check,
       toUnixTimestamp64Milli(max(checked_at)) AS checked_ms,
       argMax(failures, checked_at) AS fails
  FROM ${Table.DomainTomls}
 GROUP BY domain`;

/** When a stored domain is next checked, when it was last, and how many checks failed in a row (0 exactly when the last read). */
export interface TomlSchedule {
  nextCheckAt: UnixSeconds;
  checkedAt: UnixSecondsMs;
  failures: number;
}

/**
 * The domains of `discovered` that are due at `now` (spec 4.2), the first `limit`. A domain is due when it has no schedule (it
 * was never checked), or it is named anew and was last checked more than an hour ago, or its next check has come. A stored
 * domain that is not in `discovered` is never due (the worker checks the domains accounts name, no others).
 *
 * Order: never checked, then named anew, then the oldest next check, then the domain (by code unit, as a SQL `ORDER BY` would).
 */
export function dueDomains(o: {
  discovered: ReadonlyMap<string, number>;
  schedule: ReadonlyMap<string, TomlSchedule>;
  namedAnew: (domain: string) => boolean;
  now: UnixSecondsMs;
  limit?: number;
}): string[] {
  const { discovered, schedule, namedAnew, now, limit = TOML_PASS_LIMIT } = o;
  const due: { domain: string; rank: number; nextCheckAt: number }[] = [];
  for (const domain of discovered.keys()) {
    const known = schedule.get(domain);
    if (known === undefined) {
      due.push({ domain, rank: 0, nextCheckAt: 0 });
      continue;
    }
    const anew = namedAnew(domain);
    if ((anew && now - known.checkedAt > TOML_NAMED_ANEW_AFTER_S) || known.nextCheckAt <= now) {
      due.push({ domain, rank: anew ? 1 : 2, nextCheckAt: known.nextCheckAt });
    }
  }
  due.sort(
    (a, b) =>
      a.rank - b.rank || a.nextCheckAt - b.nextCheckAt || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
  );
  return due.slice(0, limit).map((d) => d.domain);
}

type CheckerConfig = Pick<SyncerConfig, 'tomlRecheckMs' | 'domainFetchTimeoutMs'>;
type CheckerStore = Pick<ClickHouseService, 'query' | 'insert'>;
type CheckerMetrics = Pick<PrometheusService, 'tomlsChecksTotal' | 'tomlsDomains' | 'tomlsDue'>;

/** A row of `TOML_SCHEDULE_SQL`: an `Int64` comes quoted. */
interface ScheduleRow {
  domain: string;
  next_check: number | string;
  checked_ms: number | string;
  fails: number | string;
}

/** What one pass has so far. */
interface PassState {
  /** The schedule as read, brought up to date with each row written. */
  schedule: Map<string, TomlSchedule>;
  /** The newest stored row of each domain this pass checks. */
  stored: Map<string, DomainTomlsRow>;
  /** Rows made and not written yet: fewer than a batch. */
  buffer: DomainTomlsRow[];
  /** Rows written, and how many of them are `ok`. */
  written: number;
  ok: number;
  /** The domains whose fetch was blocked by the address policy. */
  blocked: string[];
  /** The checks that failed with an error neither the fetcher's nor the parser's, by the name of the error. */
  unexpected: Map<string, number>;
}

/**
 * Reads the tomls of the domains accounts name (spec 4.2 and 4.3). A pass (`pass()`, made every 60 s by the worker):
 *
 * 1. reads the schedule of every stored domain, and takes the discovered domains that are due (`dueDomains`: never checked,
 *    then named anew, then the oldest next check), at most 300;
 * 2. reads the newest stored row of those, which `nextTomlRow` carries over;
 * 3. fetches `https://{domain}{tomlPath}` of each through the safe fetcher, one fetch per domain, at most 16 in flight. A file
 *    that arrives is read with `readToml`; a file that is not TOML is `toml_invalid`; a failure of the fetcher is its reason
 *    and status code; anything else that is thrown is a `connect_error`;
 * 4. makes the row with `nextTomlRow` and writes the rows in batches of 50 and at the end of the pass.
 *
 * A row is stamped with the time its file arrived. It is counted (`syncer_tomls_checks_total{outcome}`) and its domain is
 * `checked()` for the discovery when it is written, so a check that could not be written is still due and still named anew.
 *
 * **Logs** name a domain (quoted and cut like D1's: it comes from the ledger), a reason and a status code; never a body, an error
 * object, a principal or a desc. One `log` line ends every pass. The fetches blocked by the address policy are one `warn` a
 * pass, with the count and at most five domains; the errors that are not the fetcher's are one `warn` a pass, with their names.
 *
 * `stop()` starts no fetch, waits for the fetches under way and writes what is done. A pass that fails to write rejects: the
 * rows not written are due again next time.
 */
@Injectable()
export class TomlChecker {
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private running?: Promise<number>;
  private stopped = false;

  constructor(
    @Inject(SyncerConfig) private readonly cfg: CheckerConfig,
    @Inject(NETWORK_PROFILE) private readonly profile: Pick<NetworkProfile, 'name' | 'tomlPath'>,
    @Inject(ClickHouseService) private readonly ch: CheckerStore,
    @Inject(PrometheusService) private readonly metrics: CheckerMetrics,
    @Inject(TOMLS_SAFE_FETCHER) private readonly fetcher: Pick<SafeFetcher, 'get'>,
    @Inject(DomainDiscovery) private readonly discovery: Pick<DomainDiscovery, 'current' | 'namedAnew' | 'checked'>,
    @Optional() @Inject(TOMLS_WORKER_OPTIONS) options: TomlsWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new Logger(TomlChecker.name);
  }

  /**
   * One pass; resolves with the number of checks written. A pass called while one is under way is that pass. Rejects when
   * ClickHouse fails: what was not written is still due.
   */
  pass(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Starts nothing more and waits for the pass under way, which writes what is done. A checker that was stopped makes no more passes. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<number> {
    const now = this.now() / 1000;
    const discovered = this.discovery.current;
    const state: PassState = {
      schedule: await this.readSchedule(),
      stored: new Map(),
      buffer: [],
      written: 0,
      ok: 0,
      blocked: [],
      unexpected: new Map(),
    };
    // all of them: the number still due after the pass counts the ones beyond this pass's 300
    const due = dueDomains({
      discovered,
      schedule: state.schedule,
      namedAnew: (domain) => this.discovery.namedAnew(domain),
      now,
      limit: Infinity,
    });

    try {
      await this.check(due.slice(0, TOML_PASS_LIMIT), state);
    } finally {
      // also when a write failed: the gauges show what was written, the warnings what was met
      this.reportBlocked(state.blocked);
      this.reportUnexpected(state.unexpected);
      this.setGauges(discovered, state, due.length);
    }
    const failed = state.written - state.ok;
    this.logger.log(
      `Tomls: ${state.written} checked (${state.ok} ok, ${failed} failed), ${due.length - state.written} still due`,
    );
    return state.written;
  }

  /** The schedule of every stored domain, by domain (lower case, as stored). */
  private async readSchedule(): Promise<Map<string, TomlSchedule>> {
    const rows = await this.ch.query<ScheduleRow>(TOML_SCHEDULE_SQL);
    return new Map(
      rows.map((row) => [
        row.domain,
        { nextCheckAt: Number(row.next_check), checkedAt: Number(row.checked_ms) / 1000, failures: Number(row.fails) },
      ]),
    );
  }

  // -- the checks ---------------------------------------------------------------------------------------------------

  /** Checks the domains, 16 at a time, and writes the rows in batches and what is left at the end. */
  private async check(due: string[], state: PassState): Promise<void> {
    if (due.length === 0 || this.stopped) return;
    state.stored = await readStoredTomls(this.ch, due);
    await this.inLanes(due, async (domain) => {
      state.buffer.push(await this.checkDomain(domain, state));
      if (state.buffer.length >= TOML_WRITE_BATCH) await this.write(state.buffer.splice(0, TOML_WRITE_BATCH), state);
    });
    // also after stop(): what is done is written
    if (state.buffer.length > 0) await this.write(state.buffer.splice(0), state);
  }

  /** The row for the toml of a domain: fetched, read, and put through `nextTomlRow` at the time the answer came. Never throws. */
  private async checkDomain(domain: string, state: PassState): Promise<DomainTomlsRow> {
    const tomlUrl = tomlUrlOf(domain, this.profile);
    let check: TomlCheck;
    let now: UnixSecondsMs;
    try {
      const { body } = await this.fetcher.get(tomlUrl, tomlFetchLimits(this.cfg.domainFetchTimeoutMs), ACCEPT);
      now = this.now() / 1000;
      check = { domain, tomlUrl, content: readToml(body.toString('utf8'), this.profile, now) };
    } catch (err) {
      now = this.now() / 1000;
      check = { domain, tomlUrl, ...this.failureOf(err, domain, state) };
    }
    return nextTomlRow(state.stored.get(domain), check, now, this.cfg.tomlRecheckMs);
  }

  /** Why a fetch or a read failed. The error itself goes no further: only a reason, a status code and, counted, its name. */
  private failureOf(err: unknown, domain: string, state: PassState): { reason: TomlFailure; statusCode?: number } {
    if (err instanceof TomlInvalidError) return { reason: 'toml_invalid' };
    if (err instanceof SafeFetchError) {
      if (err.reason === 'blocked_address') state.blocked.push(domain);
      return { reason: err.reason, statusCode: err.statusCode };
    }
    // `get` throws SafeFetchError and `readToml` TomlInvalidError, nothing else; anything else is a failure all the same
    const name = errorNameOf(err);
    state.unexpected.set(name, (state.unexpected.get(name) ?? 0) + 1);
    return { reason: 'connect_error' };
  }

  /** Inserts the rows, then counts them, brings the schedule up to date and tells the discovery they are checked. */
  private async write(rows: DomainTomlsRow[], state: PassState): Promise<void> {
    await this.ch.insert(Table.DomainTomls, rows);
    for (const row of rows) {
      state.schedule.set(row.domain, {
        nextCheckAt: row.next_check_at,
        checkedAt: row.checked_at,
        failures: row.failures,
      });
      this.metrics.tomlsChecksTotal.inc({ outcome: row.status === 'ok' ? 'ok' : row.reason });
      this.discovery.checked(row.domain);
    }
    state.written += rows.length;
    state.ok += rows.filter((row) => row.status === 'ok').length;
  }

  /**
   * Runs `fn` over the items, at most 16 at a time, none started once the checker is stopped. When one fails the others that
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
    await Promise.all(Array.from({ length: Math.min(TOML_FETCH_CONCURRENCY, items.length) }, lane));
    if (failure !== undefined) throw failure.error;
  }

  // -- what is shown --------------------------------------------------------------------------------------------------

  /** `syncer_tomls_domains` over the discovered domains (a schedule with no failures is `ok`) and `syncer_tomls_due`. */
  private setGauges(discovered: ReadonlyMap<string, number>, state: PassState, due: number): void {
    let ok = 0;
    let failed = 0;
    let unchecked = 0;
    for (const domain of discovered.keys()) {
      const known = state.schedule.get(domain);
      if (known === undefined) unchecked++;
      else if (known.failures === 0) ok++;
      else failed++;
    }
    this.metrics.tomlsDomains.set({ status: 'ok' }, ok);
    this.metrics.tomlsDomains.set({ status: 'failed' }, failed);
    this.metrics.tomlsDomains.set({ status: 'unchecked' }, unchecked);
    this.metrics.tomlsDue.set(due - state.written);
  }

  /** One line for the fetches the address policy blocked: the count and the first five domains in order. */
  private reportBlocked(blocked: readonly string[]): void {
    if (blocked.length === 0) return;
    const named = [...blocked].sort().slice(0, BLOCKED_NAMED).map(quoted).join(', ');
    this.logger.warn(
      `Tomls: ${blocked.length} ${blocked.length === 1 ? 'fetch' : 'fetches'} blocked (blocked_address): ${named}`,
    );
  }

  /** One line for the checks that failed with an error neither the fetcher's nor the parser's: the names, no more. */
  private reportUnexpected(unexpected: Map<string, number>): void {
    if (unexpected.size === 0) return;
    const total = [...unexpected.values()].reduce((sum, n) => sum + n, 0);
    this.logger.warn(
      `Tomls: ${total} ${total === 1 ? 'check' : 'checks'} failed with an error that is not the fetcher's or the parser's own ` +
        `(${countsText(unexpected)})`,
    );
  }
}

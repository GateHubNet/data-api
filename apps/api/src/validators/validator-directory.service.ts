import {
  ClickHouseService,
  keyMapParams,
  MANIFEST_MAP_SQL,
  NetworkProfile,
  StoredUnlList,
  Table,
  VoteRow,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { agreementReadFrom, HourSentinel, KeyHour, newestFinalHour } from './agreement-windows';
import {
  ActivityRow,
  assembleDirectory,
  Directory,
  DirectoryReads,
  DomainRow,
  HeadInfo,
  ManifestRow,
  NetworkStateInfo,
  PublisherRow,
  RoundInfo,
  SeenRow,
  VersionRow,
} from './directory';

/** How long a built directory is served, in milliseconds. */
export const DIRECTORY_TTL_MS = 10_000;

/** The ledgers of `validator_validations` the directory looks at, counted back from the head (spec 3.2). */
export const ACTIVITY_LEDGERS = 300;

const HOUR = 3600;
const DAY = 86_400;
/** The hours of a range of sentinels read while looking for the newest final hour: the hours of the 30-day window. */
const AGREEMENT_RANGE_HOURS = 720;
/** The most hours back from the newest hour stored the search for a final hour goes: `validator_agreement_hourly` keeps 400 days. */
const AGREEMENT_RETENTION_HOURS = 400 * 24;
/**
 * The most ledgers a 30-day window can span: no network closes more than one ledger a second. A lower bound for the read of the
 * rounds, which then filters them by their close time.
 */
const MAX_LEDGERS_30D = 30 * DAY;
/** The manifest map as the query parameters of `transform(k, {ephemerals}, {masters}, k)`. */
type KeyMap = ReturnType<typeof keyMapParams>;

/** A row of ClickHouse with numbers that may arrive as text (64-bit integers). */
type Num = number | string;

const asNumber = (value: Num): number => Number(value);
const asSeconds = (milliseconds: Num): number => Number(milliseconds) / 1000;

/** A set of rounds as the version-set reads take them: the newest version of every round. */
interface RoundVersions {
  rounds: number[];
  /**
   * UInt64 as text: a version is passed back to ClickHouse exactly as it came out, never through a JavaScript number (as
   * `Array(String)`, since an `Array(UInt64)` parameter does not take quoted numbers).
   */
  versions: string[];
}

/**
 * Builds the validator directory (spec 3.0, 9) and keeps it for 10 s.
 *
 * **Reads.** The reads of a build run in parallel. Every one that aggregates rows maps their keys through the manifest map
 * first (`transform(k, {ephemerals}, {masters}, k)`, the map read once at the start of the build); every read of a version set
 * (`validator_votes`, `amendment_tallies`, `validator_agreement_hourly`) takes the newest sentinel's version of each round or
 * hour and only the rows of that version. They are bounded and read in the order of the key: the validations by the head, the
 * hours by the range of the window, the votes by the range of the rounds of the last 30 days. Values are bound as query
 * parameters; table names come from `Table`.
 *
 * **One build at a time.** `CacheService` keeps the result for 10 s but does not stop two requests that find it empty from
 * both building, so the service keeps its own promise of the build in flight, per network: a request that comes while a build
 * runs awaits the same promise, and the promise is dropped when it settles (a failed build is not kept).
 */
@Injectable()
export class ValidatorDirectoryService {
  private readonly building = new Map<string, Promise<Directory>>();

  constructor(
    private readonly ch: ClickHouseService,
    private readonly cache: CacheService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** The directory: the cached one, or the one being built, or a new one. */
  get(): Promise<Directory> {
    const network = this.profile.name;
    const inFlight = this.building.get(network);
    if (inFlight !== undefined) return inFlight;
    const settled = this.cache
      .wrap(`validator-directory:${network}`, DIRECTORY_TTL_MS, () => this.build())
      .finally(() => {
        if (this.building.get(network) === settled) this.building.delete(network);
      });
    this.building.set(network, settled);
    return settled;
  }

  private async build(): Promise<Directory> {
    const builtAt = Date.now();
    const now = Math.floor(builtAt / 1000);
    const keyMap = this.readKeyMap();
    const head = this.readHead();
    const state = this.readState();
    const publishers = this.readPublishers();
    const manifests = this.readManifests();
    const domains = keyMap.then((map) => this.readDomains(map));
    const seen = keyMap.then((map) => this.readSeen(map));
    const activity = Promise.all([head, state, keyMap]).then(([h, s, map]) => this.readActivity(h, s, map));
    const agreement = keyMap.then((map) => this.readAgreement(map));
    const votes = keyMap.then((map) => this.readVotes(map, now));

    const [map, headRow, stateRow, publisherRows, manifestRows, domainRows, seenRows, activityRows, hours, voted] =
      await Promise.all([keyMap, head, state, publishers, manifests, domains, seen, activity, agreement, votes]);

    const reads: DirectoryReads = {
      builtAt,
      software: this.profile.software,
      tomlPath: this.profile.tomlPath,
      head: headRow,
      state: stateRow,
      publishers: publisherRows.publishers,
      lists: publisherRows.lists,
      manifestMap: map.rows,
      manifests: manifestRows,
      seen: seenRows,
      activity: activityRows,
      domains: domainRows,
      sentinels: hours.sentinels,
      hourly: hours.hourly,
      rounds: voted.rounds,
      votes: voted.votes,
      versions: voted.versions,
    };
    return assembleDirectory(reads);
  }

  // -- the manifest map -----------------------------------------------------------------------------------------------

  private async readKeyMap(): Promise<KeyMap & { rows: { ephemeral_key: string; master_key: string }[] }> {
    const rows = await this.ch.query<{ ephemeral_key: string; master_key: string }>(MANIFEST_MAP_SQL);
    return { ...keyMapParams(rows), rows };
  }

  // -- the chain ----------------------------------------------------------------------------------------------------------

  /** The newest committed ledger and the mean interval of the last 1,000. */
  private async readHead(): Promise<HeadInfo | undefined> {
    const rows = await this.ch.query<{ ledger_index: Num; closed: Num }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS closed
         FROM ${Table.Ledgers}
        ORDER BY ledger_index DESC
        LIMIT 1000`,
    );
    if (rows.length === 0) return undefined;
    const newest = rows[0];
    const oldest = rows[rows.length - 1];
    const ledgers = asNumber(newest.ledger_index) - asNumber(oldest.ledger_index);
    const seconds = asNumber(newest.closed) - asNumber(oldest.closed);
    return {
      ledgerIndex: asNumber(newest.ledger_index),
      closeTime: asNumber(newest.closed),
      ...(ledgers > 0 && seconds > 0 && { spanSeconds: seconds, spanLedgers: ledgers }),
    };
  }

  /** The newest ledger state the syncer polled. */
  private async readState(): Promise<NetworkStateInfo | undefined> {
    const row = await this.ch.queryOne<{
      ledger_index: Num;
      amendments: string[];
      majority_ids: string[];
      majority_since: Num[];
      disabled_keys: string[];
      disabled_ledgers: Num[];
      to_disable: string;
      to_reenable: string;
      state_base_fee: string;
      state_reserve_base: string;
      state_reserve_inc: string;
      node_quorum: Num;
    }>(
      `SELECT ledger_index, amendments,
              arrayMap(m -> tupleElement(m, 'amendment'), majorities) AS majority_ids,
              arrayMap(m -> toUnixTimestamp(tupleElement(m, 'since')), majorities) AS majority_since,
              arrayMap(v -> tupleElement(v, 'validation_public_key'), negative_unl) AS disabled_keys,
              arrayMap(v -> tupleElement(v, 'first_ledger'), negative_unl) AS disabled_ledgers,
              to_disable, to_reenable,
              toString(base_fee) AS state_base_fee, toString(reserve_base) AS state_reserve_base,
              toString(reserve_inc) AS state_reserve_inc,
              node_quorum
         FROM ${Table.NetworkState}
        ORDER BY ledger_index DESC, polled_at DESC
        LIMIT 1`,
    );
    if (row === undefined) return undefined;
    return {
      ledgerIndex: asNumber(row.ledger_index),
      amendments: row.amendments,
      majorities: row.majority_ids.map((amendment, i) => ({ amendment, since: asNumber(row.majority_since[i]) })),
      negativeUnl: row.disabled_keys.map((key, i) => ({ key, firstLedger: asNumber(row.disabled_ledgers[i]) })),
      ...(row.to_disable !== '' && { toDisable: row.to_disable }),
      ...(row.to_reenable !== '' && { toReenable: row.to_reenable }),
      fees: { base_fee: row.state_base_fee, reserve_base: row.state_reserve_base, reserve_inc: row.state_reserve_inc },
      nodeQuorum: asNumber(row.node_quorum),
    };
  }

  // -- the UNL ------------------------------------------------------------------------------------------------------------

  /** The configured publishers (the newest row of each) and every list they served. */
  private async readPublishers(): Promise<{ publishers: PublisherRow[]; lists: StoredUnlList[] }> {
    const rows = await this.ch.query<{
      publisher: string;
      newest_url: string;
      newest_key: string;
      newest_threshold: Num;
      newest_status: string;
      newest_error: string;
      checked_ms: Num;
    }>(
      `SELECT publisher,
              argMax(url, checked_at) AS newest_url,
              argMax(publisher_key, checked_at) AS newest_key,
              argMax(configured, checked_at) AS newest_configured,
              argMax(threshold, checked_at) AS newest_threshold,
              argMax(status, checked_at) AS newest_status,
              argMax(error, checked_at) AS newest_error,
              toUnixTimestamp64Milli(max(checked_at)) AS checked_ms
         FROM ${Table.UnlPublishers}
        GROUP BY publisher
       HAVING newest_configured = 1
        ORDER BY publisher`,
    );
    const publishers = rows.map(
      (row): PublisherRow => ({
        id: row.publisher,
        url: row.newest_url,
        publicKey: row.newest_key,
        threshold: asNumber(row.newest_threshold),
        checked: asSeconds(row.checked_ms),
        status: row.newest_status === 'ok' ? 'ok' : 'error',
        error: row.newest_error,
      }),
    );
    if (publishers.length === 0) return { publishers, lists: [] };

    const listRows = await this.ch.query<{
      publisher: string;
      sequence: Num;
      list_key: string;
      list_version: Num;
      list_effective: Num | null;
      list_expiration: Num;
      list_validators: string[];
      fetched_ms: Num;
    }>(
      `SELECT publisher, sequence,
              argMax(publisher_key, fetched_at) AS list_key,
              argMax(version, fetched_at) AS list_version,
              toUnixTimestamp(argMax(effective, fetched_at)) AS list_effective,
              toUnixTimestamp(argMax(expiration, fetched_at)) AS list_expiration,
              argMax(validators, fetched_at) AS list_validators,
              toUnixTimestamp64Milli(max(fetched_at)) AS fetched_ms
         FROM ${Table.UnlLists}
        WHERE publisher IN {publishers:Array(String)}
        GROUP BY publisher, sequence
        ORDER BY publisher, sequence`,
      { publishers: publishers.map((publisher) => publisher.id) },
    );
    const lists = listRows.map(
      (row): StoredUnlList => ({
        publisher: row.publisher,
        publisherKey: row.list_key,
        sequence: asNumber(row.sequence),
        version: asNumber(row.list_version),
        ...(row.list_effective !== null && { effective: asNumber(row.list_effective) }),
        expiration: asNumber(row.list_expiration),
        validators: row.list_validators,
        fetchedAt: asSeconds(row.fetched_ms),
      }),
    );
    return { publishers, lists };
  }

  // -- the validators -------------------------------------------------------------------------------------------------

  /** The newest manifest of every master key and the number of signing keys it has used. */
  private async readManifests(): Promise<ManifestRow[]> {
    const rows = await this.ch.query<{
      master_key: string;
      newest_seq: Num;
      newest_signing: string;
      newest_domain: string;
      signing_keys_seen: Num;
    }>(
      `SELECT master_key,
              max(seq) AS newest_seq,
              argMax(ephemeral_key, seq) AS newest_signing,
              argMax(domain, seq) AS newest_domain,
              uniqExact(ephemeral_key) AS signing_keys_seen
         FROM ${Table.ValidatorManifests}
        GROUP BY master_key
        ORDER BY master_key`,
    );
    return rows.map(
      (row): ManifestRow => ({
        masterKey: row.master_key,
        sequence: asNumber(row.newest_seq),
        signingKey: row.newest_signing,
        ...(row.newest_domain !== '' && { domain: row.newest_domain }),
        signingKeysSeen: asNumber(row.signing_keys_seen),
      }),
    );
  }

  /** When each validator was first and last seen, the keys mapped to their masters. */
  private async readSeen(map: KeyMap): Promise<SeenRow[]> {
    const rows = await this.ch.query<{ seen_key: string; first_ms: Num; last_ms: Num }>(
      `SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS seen_key,
              toUnixTimestamp64Milli(min(first_seen)) AS first_ms,
              toUnixTimestamp64Milli(max(last_seen)) AS last_ms
         FROM ${Table.ValidatorSeen}
        GROUP BY seen_key
        ORDER BY seen_key`,
      { ephemerals: map.ephemerals, masters: map.masters },
    );
    return rows.map((row) => ({
      key: row.seen_key,
      firstSeen: asSeconds(row.first_ms),
      lastSeen: asSeconds(row.last_ms),
    }));
  }

  /** The newest result of every (validator, domain), the keys mapped to their masters. */
  private async readDomains(map: KeyMap): Promise<DomainRow[]> {
    const rows = await this.ch.query<{
      domain_key: string;
      domain_name: string;
      newest_status: string;
      newest_reason: string;
      newest_status_code: Num;
      newest_toml_url: string;
      checked_ms: Num;
      verified_ms: Num | null;
      newest_accounts: string[];
    }>(
      `SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS domain_key,
              domain AS domain_name,
              argMax(status, checked_at) AS newest_status,
              argMax(reason, checked_at) AS newest_reason,
              argMax(status_code, checked_at) AS newest_status_code,
              argMax(toml_url, checked_at) AS newest_toml_url,
              toUnixTimestamp64Milli(max(checked_at)) AS checked_ms,
              toUnixTimestamp64Milli(argMax(verified_at, checked_at)) AS verified_ms,
              argMax(accounts, checked_at) AS newest_accounts
         FROM ${Table.ValidatorDomains}
        GROUP BY domain_key, domain_name
        ORDER BY domain_key, domain_name`,
      { ephemerals: map.ephemerals, masters: map.masters },
    );
    return rows.map(
      (row): DomainRow => ({
        key: row.domain_key,
        domain: row.domain_name,
        status: row.newest_status === 'verified' ? 'verified' : 'unverified',
        reason: row.newest_reason,
        statusCode: asNumber(row.newest_status_code),
        tomlUrl: row.newest_toml_url,
        checked: asSeconds(row.checked_ms),
        ...(row.verified_ms !== null && { verified: asSeconds(row.verified_ms) }),
        accounts: row.newest_accounts,
      }),
    );
  }

  /**
   * The newest validation of each validator among the last 300 ledgers (of the head: the larger of the newest committed ledger
   * and the newest ledger state), and whether it was a full one. Without a head there is nothing to count back from.
   */
  private async readActivity(
    head: HeadInfo | undefined,
    state: NetworkStateInfo | undefined,
    map: KeyMap,
  ): Promise<ActivityRow[]> {
    const newest = Math.max(head?.ledgerIndex ?? 0, state?.ledgerIndex ?? 0);
    if (newest === 0) return [];
    const rows = await this.ch.query<{ activity_key: string; newest_ledger: Num; newest_full: Num }>(
      `SELECT activity_key, max(ledger_index) AS newest_ledger, argMax(ledger_full, ledger_index) AS newest_full
         FROM (SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS activity_key,
                      ledger_index, max(full) AS ledger_full
                 FROM ${Table.ValidatorValidations}
                WHERE ledger_index >= {since:UInt32}
                GROUP BY activity_key, ledger_index)
        GROUP BY activity_key
        ORDER BY activity_key`,
      { since: Math.max(0, newest - ACTIVITY_LEDGERS), ephemerals: map.ephemerals, masters: map.masters },
    );
    return rows.map((row) => ({
      key: row.activity_key,
      ledgerIndex: asNumber(row.newest_ledger),
      full: asNumber(row.newest_full) === 1,
    }));
  }

  // -- agreement ------------------------------------------------------------------------------------------------------

  /**
   * The sentinels of the 720 hours of the 30-day window and the rows of the validators in them, as the newest sentinel's
   * version of each hour has them and no other.
   *
   * The window ends at the newest FINAL hour, which can lie any number of non-final hours below the newest hour stored (an
   * ingest that stalled). So it is found first, from the sentinels, going back from the newest hour stored (the first granule
   * of the table, read from the end) in ranges of 720 hours until a range has an hour whose newest version is final (at most as
   * far back as the table keeps an hour, 400 days). Each range is a range of the key, so a stall costs the ranges it spans and the
   * usual case one. (The agreement job asks for the newest final hour with `GROUP BY hour ... ORDER BY hour DESC LIMIT 1`; read
   * here that statement reads the whole table when ClickHouse does not hand it the granules a previous run skipped: 839,600 rows
   * of the bulk of the e2e suite.) Then the window is completed down to `newest final - 719 h` (ruling P6: the first hour of
   * the 30-day window, not the start of a UTC day; the 30 daily entries lie inside it), and the rows of its hours are read. Per
   * validator one row comes back with its hours in an array, which keeps the answer a fraction of the rows read.
   */
  private async readAgreement(map: KeyMap): Promise<{
    sentinels: ReadonlyMap<number, HourSentinel>;
    hourly: ReadonlyMap<string, ReadonlyMap<number, KeyHour>>;
  }> {
    const none = { sentinels: new Map<number, HourSentinel>(), hourly: new Map<string, Map<number, KeyHour>>() };
    const stored = await this.ch.queryOne<{ stored_hour: Num }>(
      `SELECT toUnixTimestamp(hour) AS stored_hour
         FROM ${Table.ValidatorAgreementHourly}
        WHERE validation_public_key = ''
        ORDER BY hour DESC
        LIMIT 1`,
    );
    if (stored === undefined) return none;
    const newestStored = asNumber(stored.stored_hour);

    // the sentinels read so far, and the version of the newest of each hour
    const sentinels = new Map<number, HourSentinel>();
    const versionOf = new Map<number, string>();
    const readSentinels = async (since: number, until: number): Promise<void> => {
      const rows = await this.ch.query<{
        sentinel_hour: Num;
        newest_version: string;
        newest_final: Num;
        newest_ledgers: Num;
        newest_unobserved: Num;
      }>(
        `SELECT toUnixTimestamp(hour) AS sentinel_hour,
                toString(max(version)) AS newest_version,
                argMax(final, version) AS newest_final,
                argMax(ledgers, version) AS newest_ledgers,
                argMax(unobserved, version) AS newest_unobserved
           FROM ${Table.ValidatorAgreementHourly}
          WHERE validation_public_key = ''
            AND hour >= toDateTime({since:UInt32}, 'UTC') AND hour <= toDateTime({until:UInt32}, 'UTC')
          GROUP BY hour
          ORDER BY hour`,
        { since, until },
      );
      for (const row of rows) {
        const hour = asNumber(row.sentinel_hour);
        versionOf.set(hour, row.newest_version);
        sentinels.set(hour, {
          final: asNumber(row.newest_final) === 1,
          ledgers: asNumber(row.newest_ledgers),
          unobserved: asNumber(row.newest_unobserved),
        });
      }
    };

    // back from the newest hour stored, a range of 720 hours at a time, to the first with a final hour
    let covered = newestStored + HOUR;
    let finalHour: number | undefined;
    while (finalHour === undefined && covered > newestStored - AGREEMENT_RETENTION_HOURS * HOUR) {
      await readSentinels(covered - AGREEMENT_RANGE_HOURS * HOUR, covered - HOUR);
      covered -= AGREEMENT_RANGE_HOURS * HOUR;
      finalHour = newestFinalHour(sentinels);
    }
    if (finalHour === undefined) return none;

    // the window of 720 hours ends at the newest final hour; read the hours of it below what is read
    const from = agreementReadFrom(finalHour);
    if (from < covered) {
      await readSentinels(from, covered - HOUR);
      covered = from;
    }
    const window = [...sentinels.keys()].filter((hour) => hour >= from && hour <= finalHour).sort((a, b) => a - b);

    const rows = await this.ch.query<{ agreement_key: string; hourly: [number, number, number, number][] }>(
      `SELECT agreement_key, groupArray((agreement_hour, hour_agreed, hour_missed, hour_partial)) AS hourly
         FROM (SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS agreement_key,
                      toUnixTimestamp(hour) AS agreement_hour,
                      toUInt32(sum(agreed)) AS hour_agreed, toUInt32(sum(missed)) AS hour_missed, toUInt32(sum(partial)) AS hour_partial
                 FROM ${Table.ValidatorAgreementHourly}
                WHERE hour >= toDateTime({since:UInt32}, 'UTC') AND hour <= toDateTime({until:UInt32}, 'UTC')
                  AND validation_public_key != ''
                  AND version = toUInt64(transform(toUnixTimestamp(hour), {hours:Array(UInt32)}, {versions:Array(String)}, '0'))
                GROUP BY agreement_key, agreement_hour)
        GROUP BY agreement_key
        ORDER BY agreement_key`,
      {
        since: from,
        until: finalHour,
        hours: window,
        versions: window.map((hour) => versionOf.get(hour) as string),
        ephemerals: map.ephemerals,
        masters: map.masters,
      },
    );
    const hourly = new Map<string, Map<number, KeyHour>>(
      rows.map((row) => [
        row.agreement_key,
        new Map(
          row.hourly.map(([hour, agreed, missed, partial]): [number, KeyHour] => [
            asNumber(hour),
            { agreed: asNumber(agreed), missed: asNumber(missed), partial: asNumber(partial) },
          ]),
        ),
      ]),
    );
    return { sentinels, hourly };
  }

  // -- votes ------------------------------------------------------------------------------------------------------------

  /**
   * The rounds of the last 24 h before the newest, with their votes (records), and the versions of the last 30 days. A round
   * is the rows of its newest sentinel's version.
   */
  private async readVotes(
    map: KeyMap,
    now: number,
  ): Promise<{ rounds: RoundInfo[]; votes: VoteRow[]; versions: VersionRow[] }> {
    const none = { rounds: [], votes: [], versions: [] };
    const newest = await this.ch.queryOne<{ ledger_index: Num; round_close: Num }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS round_close
         FROM ${Table.AmendmentTallies}
        WHERE amendment_id = ''
        ORDER BY ledger_index DESC, version DESC
        LIMIT 1`,
    );
    if (newest === undefined) return none;
    const newestRound = asNumber(newest.ledger_index);
    const since24 = Math.max(0, asNumber(newest.round_close) - DAY);
    const since30 = Math.max(0, now - 30 * DAY);
    const floor = Math.max(0, newestRound - MAX_LEDGERS_30D);

    const [recent, month] = await Promise.all([
      this.ch.query<{
        ledger_index: Num;
        newest_version: string;
        round_close: Num;
        round_unl_size: Num;
        round_trusted: Num;
        round_threshold: Num;
        round_observed: Num;
        round_unl: string[];
        round_negative_unl: string[];
        round_base_fee: string;
        round_reserve_base: string;
        round_reserve_inc: string;
      }>(
        `SELECT ledger_index,
                toString(max(version)) AS newest_version,
                toUnixTimestamp(argMax(close_time, version)) AS round_close,
                argMax(unl_size, version) AS round_unl_size,
                argMax(trusted, version) AS round_trusted,
                argMax(threshold, version) AS round_threshold,
                argMax(observed, version) AS round_observed,
                argMax(unl, version) AS round_unl,
                argMax(negative_unl, version) AS round_negative_unl,
                toString(argMax(base_fee, version)) AS round_base_fee,
                toString(argMax(reserve_base, version)) AS round_reserve_base,
                toString(argMax(reserve_inc, version)) AS round_reserve_inc
           FROM ${Table.AmendmentTallies}
          WHERE amendment_id = '' AND ledger_index >= {floor:UInt32} AND ledger_index <= {newest:UInt32}
          GROUP BY ledger_index
         HAVING round_close >= {since:UInt32}
          ORDER BY ledger_index`,
        { floor, newest: newestRound, since: since24 },
      ),
      this.ch.query<{ ledger_index: Num; newest_version: string }>(
        `SELECT ledger_index, toString(max(version)) AS newest_version
           FROM ${Table.AmendmentTallies}
          WHERE amendment_id = '' AND ledger_index >= {floor:UInt32} AND ledger_index <= {newest:UInt32}
          GROUP BY ledger_index
         HAVING toUnixTimestamp(argMax(close_time, version)) >= {since:UInt32}
          ORDER BY ledger_index`,
        { floor, newest: newestRound, since: since30 },
      ),
    ]);

    const rounds = recent.map(
      (row): RoundInfo => ({
        ledgerIndex: asNumber(row.ledger_index),
        version: row.newest_version,
        closeTime: asNumber(row.round_close),
        unlSize: asNumber(row.round_unl_size),
        trusted: asNumber(row.round_trusted),
        threshold: asNumber(row.round_threshold),
        observed: asNumber(row.round_observed),
        unl: row.round_unl,
        negativeUnl: row.round_negative_unl,
        fees: {
          base_fee: row.round_base_fee,
          reserve_base: row.round_reserve_base,
          reserve_inc: row.round_reserve_inc,
        },
      }),
    );
    const [votes, versions] = await Promise.all([
      this.readRecentVotes(map, rounds, {
        rounds: recent.map((row) => asNumber(row.ledger_index)),
        versions: recent.map((row) => row.newest_version),
      }),
      this.readVersions(
        map,
        {
          rounds: month.map((row) => asNumber(row.ledger_index)),
          versions: month.map((row) => row.newest_version),
        },
        now - DAY,
      ),
    ]);
    return { rounds, votes, versions };
  }

  /** The full votes of the given rounds, by the key of their master. */
  private async readRecentVotes(map: KeyMap, rounds: readonly RoundInfo[], sets: RoundVersions): Promise<VoteRow[]> {
    if (sets.rounds.length === 0) return [];
    const rows = await this.ch.query<{
      ledger_index: Num;
      vote_key: string;
      amendments: string[];
      vote_base_fee: string | null;
      vote_reserve_base: string | null;
      vote_reserve_inc: string | null;
      vote_server_version: string | null;
    }>(
      `SELECT ledger_index,
              transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS vote_key,
              amendments,
              toString(base_fee) AS vote_base_fee, toString(reserve_base) AS vote_reserve_base,
              toString(reserve_inc) AS vote_reserve_inc, toString(server_version) AS vote_server_version
         FROM ${Table.ValidatorVotes}
        WHERE ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
          AND full = 1
          AND version = toUInt64(transform(ledger_index, {rounds:Array(UInt32)}, {versions:Array(String)}, '0'))`,
      {
        first: sets.rounds[0],
        last: sets.rounds[sets.rounds.length - 1],
        rounds: sets.rounds,
        versions: sets.versions,
        ephemerals: map.ephemerals,
        masters: map.masters,
      },
    );
    const closeOf = new Map(rounds.map((round) => [round.ledgerIndex, round.closeTime]));
    return rows.map(
      (row): VoteRow => ({
        ledger_index: asNumber(row.ledger_index),
        validation_public_key: row.vote_key,
        close_time: closeOf.get(asNumber(row.ledger_index)) ?? 0,
        full: 1,
        amendments: row.amendments,
        base_fee: row.vote_base_fee,
        reserve_base: row.vote_reserve_base,
        reserve_inc: row.vote_reserve_inc,
        server_version: row.vote_server_version,
      }),
    );
  }

  /**
   * The newest `server_version` of each validator over the rounds of the last 30 days, and the distinct ones it reported since
   * `recentSince` (unix seconds): the last 24 h, for the latest version.
   */
  private async readVersions(map: KeyMap, sets: RoundVersions, recentSince: number): Promise<VersionRow[]> {
    if (sets.rounds.length === 0) return [];
    const rows = await this.ch.query<{
      version_key: string;
      newest_server_version: string;
      recent_server_versions: string[];
    }>(
      `SELECT transform(validation_public_key, {ephemerals:Array(String)}, {masters:Array(String)}, validation_public_key) AS version_key,
              toString(argMax(server_version, ledger_index)) AS newest_server_version,
              groupUniqArrayIf(toString(server_version), close_time >= toDateTime({recent:UInt32}, 'UTC')) AS recent_server_versions
         FROM ${Table.ValidatorVotes}
        WHERE ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
          AND server_version IS NOT NULL
          AND version = toUInt64(transform(ledger_index, {rounds:Array(UInt32)}, {versions:Array(String)}, '0'))
        GROUP BY version_key
        ORDER BY version_key`,
      {
        first: sets.rounds[0],
        last: sets.rounds[sets.rounds.length - 1],
        recent: recentSince,
        rounds: sets.rounds,
        versions: sets.versions,
        ephemerals: map.ephemerals,
        masters: map.masters,
      },
    );
    return rows.map((row) => ({
      key: row.version_key,
      serverVersion: row.newest_server_version,
      recent: row.recent_server_versions,
    }));
  }
}

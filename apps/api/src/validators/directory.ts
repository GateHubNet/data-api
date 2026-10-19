import {
  compareTriples,
  decodeServerVersion,
  isProperlyFormedTomlDomain,
  listInUse,
  quorumOf,
  recordOf,
  RoundMembership,
  ServerVersion,
  StoredUnlList,
  trustedUnl,
  VoteRow,
} from '@gatehub/data-api-shared';
import { compact } from '../common/format';
import {
  AgreementWindow,
  agreementWindows,
  DailyAgreement,
  HourSentinel,
  KeyHour,
  newestFinalHour,
  NO_AGREEMENT,
} from './agreement-windows';

// the types of the windows are produced here for the routes that serve them
export type { AgreementWindow, DailyAgreement } from './agreement-windows';

/*
 * The validator directory (spec 3.0): the table of every validator that the summary, the list, the detail and the amendment
 * page read. `assembleDirectory` is pure: it turns the reads the `ValidatorDirectoryService` makes (already key-mapped, version
 * set filtered and bounded in SQL) into the table. Times are unix seconds (a fraction for the times of receipt), drops are
 * text.
 */

/*
 * The directory is shared: `ValidatorDirectoryService` keeps one build for every request of 10 s, so a route that changed
 * a field of it in place would change the answers of the others. Everything the routes receive is `readonly`, arrays
 * included, and the placeholder `NO_AGREEMENT` that entries share is frozen.
 */

/** Fees in drops, as text. */
export interface Drops {
  readonly base_fee: string;
  readonly reserve_base: string;
  readonly reserve_inc: string;
}

/** The domain verification of a validator (spec 3.2). */
export interface DomainState {
  readonly status: 'verified' | 'unverified' | 'pending';
  readonly reason?: string;
  readonly statusCode?: number;
  readonly tomlUrl: string;
  /** When the domain was last checked: unix seconds with a millisecond fraction. */
  readonly checked?: number;
  /** The last success. */
  readonly verified?: number;
  readonly accounts?: readonly string[];
}

export interface ManifestInfo {
  readonly sequence: number;
  readonly signingKey?: string;
  /** The distinct signing keys stored for the master key. */
  readonly signingKeysSeen: number;
  readonly domain?: string;
}

/** A row of `validator_votes` as the directory serves it: no field, and no amendment, can be changed. */
export type RecordRow = Readonly<Omit<VoteRow, 'amendments'>> & { readonly amendments: readonly string[] };

export interface DirectoryEntry {
  /** The master key (or the key as it is, when no manifest maps it). */
  readonly key: string;
  readonly domain?: string;
  readonly signingKey?: string;
  readonly manifest?: ManifestInfo;
  readonly domainState?: DomainState;
  /** The ledger of its newest validation among the last 300, and whether that validation was partial. */
  readonly currentIndex?: number;
  readonly partial?: boolean;
  readonly agreement1h: AgreementWindow;
  readonly agreement24h: AgreementWindow;
  readonly agreement30d: AgreementWindow;
  /** The 30 UTC days, oldest first. */
  readonly daily: readonly DailyAgreement[];
  /** On the trusted UNL. */
  readonly unl: boolean;
  /** The ids of the publishers whose list in use names the validator, sorted. */
  readonly unlLists: readonly string[];
  /** On the negative UNL. */
  readonly negativeUnl: boolean;
  readonly version?: Readonly<ServerVersion>;
  /** The newest `server_version` of the last 30 days, as reported. */
  readonly serverVersion?: string;
  readonly versionLatest?: boolean;
  /** The vote record (F7 applied to everybody, spec 3.0). */
  readonly record?: RecordRow;
  /** The record's fees, with the fees in force at its round for the ones the validation left out. */
  readonly recordFees?: Drops;
  /** The record as the newest round counts it: only rounds at which the validator was on the UNL and off the negative UNL. */
  readonly countedRecord?: RecordRow;
  readonly firstSeen?: number;
  readonly lastSeen?: number;
  readonly seen24h: boolean;
  /** On a list in use, or seen in the last 30 days. */
  readonly listed: boolean;
}

/** A voting round (the newest version of its sentinel). */
export interface RoundInfo {
  readonly ledgerIndex: number;
  /** The version of the sentinel the round was read at: UInt64 as text. The rows of the round are those of that version. */
  readonly version: string;
  readonly closeTime: number;
  readonly unlSize: number;
  readonly trusted: number;
  readonly threshold: number;
  readonly observed: number;
  readonly unl: readonly string[];
  readonly negativeUnl: readonly string[];
  /** The fees in force. */
  readonly fees: Drops;
}

export interface PublisherState {
  readonly id: string;
  readonly url: string;
  /** The configured key: 66 hex digits. */
  readonly publicKey: string;
  /** `ok` a current list, `expired` only an expired one (still used), `unavailable` none. */
  readonly status: 'ok' | 'expired' | 'unavailable';
  readonly list?: Readonly<StoredUnlList>;
  /** The validators of the list in use that were seen in the last 24 h. */
  readonly seen24h?: number;
  readonly lastError?: string;
  readonly lastErrorAt?: number;
}

export interface HeadInfo {
  readonly ledgerIndex: number;
  readonly closeTime?: number;
  /**
   * The span of the last 1,000 committed ledgers: the seconds between the close of the oldest and of the newest, and the
   * ledgers between them. Kept as two whole numbers, so that the time of a future ledger is worked out exactly (seconds
   * over ledgers is the mean interval). Both are present or neither.
   */
  readonly spanSeconds?: number;
  readonly spanLedgers?: number;
}

/** The newest ledger state the syncer polled. */
export interface NetworkStateInfo {
  readonly ledgerIndex: number;
  readonly amendments: readonly string[];
  readonly majorities: readonly { readonly amendment: string; readonly since: number }[];
  readonly negativeUnl: readonly { readonly key: string; readonly firstLedger: number }[];
  readonly toDisable?: string;
  readonly toReenable?: string;
  readonly fees: Drops;
  /** The quorum the node reports; 0 when it reports none. */
  readonly nodeQuorum: number;
}

export interface Directory {
  /** When the directory was built, in milliseconds. */
  readonly builtAt: number;
  readonly head?: HeadInfo;
  readonly state?: NetworkStateInfo;
  readonly publishers: readonly PublisherState[];
  /** Absent without a publisher row. */
  readonly threshold?: number;
  /** The trusted UNL now: the validators named by enough of the lists in use. */
  readonly trusted: ReadonlySet<string>;
  readonly quorum: {
    readonly value: number;
    readonly unlSize: number;
    readonly negativeOnUnl: number;
    readonly node?: number;
  };
  /** Every master key of `validator_seen` and of the lists in use. */
  readonly entries: ReadonlyMap<string, DirectoryEntry>;
  /** The listed entries in list order: with a domain first, by lower-case domain then key; then the rest by key. */
  readonly ordered: readonly DirectoryEntry[];
  readonly signingToMaster: ReadonlyMap<string, string>;
  readonly newestRound?: RoundInfo;
  readonly newestFinalHour?: number;
  /** The newest release build among the trusted validators' versions of the last 24 h. */
  readonly latest?: Readonly<ServerVersion>;
}

// -- the reads --------------------------------------------------------------------------------------------------------

/** The newest manifest of a master key. */
export interface ManifestRow {
  masterKey: string;
  sequence: number;
  signingKey: string;
  domain?: string;
  signingKeysSeen: number;
}

/** When a key was first and last seen. A signing key's row is merged into its master's. */
export interface SeenRow {
  key: string;
  firstSeen: number;
  lastSeen: number;
}

/** The newest validation of a key among the last 300 ledgers. */
export interface ActivityRow {
  key: string;
  ledgerIndex: number;
  full: boolean;
}

/** The newest check of a (validator, domain). */
export interface DomainRow {
  key: string;
  domain: string;
  status: 'verified' | 'unverified';
  reason: string;
  statusCode: number;
  tomlUrl: string;
  checked: number;
  verified?: number;
  accounts: string[];
}

/** The newest row of a configured publisher in `unl_publishers`. */
export interface PublisherRow {
  id: string;
  url: string;
  publicKey: string;
  threshold: number;
  checked: number;
  status: 'ok' | 'error';
  error: string;
}

/** A key's newest `server_version` of the last 30 days and the distinct ones of the last 24 h. */
export interface VersionRow {
  key: string;
  serverVersion: string;
  recent: string[];
}

export interface DirectoryReads {
  /** Milliseconds. */
  builtAt: number;
  software: 'rippled' | 'xahaud';
  tomlPath: string;
  head?: HeadInfo;
  state?: NetworkStateInfo;
  publishers: PublisherRow[];
  /** Every stored list of the publishers, whatever key it was served under. */
  lists: StoredUnlList[];
  /** `argMax(master_key, seq)` per `ephemeral_key`. */
  manifestMap: { ephemeral_key: string; master_key: string }[];
  manifests: ManifestRow[];
  seen: SeenRow[];
  activity: ActivityRow[];
  domains: DomainRow[];
  sentinels: ReadonlyMap<number, HourSentinel>;
  /** Per key (mapped to its master), the rows of its hours. */
  hourly: ReadonlyMap<string, ReadonlyMap<number, KeyHour>>;
  /** The rounds of the last 24 h before the newest one, and the newest, in any order. */
  rounds: RoundInfo[];
  /** The full votes of those rounds, keys mapped. */
  votes: VoteRow[];
  versions: VersionRow[];
}

// -- the assembly -----------------------------------------------------------------------------------------------------

const DAY_SECONDS = 86_400;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * List order (spec 3.2): with a domain first, by lower-case domain then key; then the rest by key. Of a validator it needs
 * the key and the domain only, so that a member of a round the directory has no entry for is put in its place as well.
 */
export function compareEntries(
  a: Pick<DirectoryEntry, 'key' | 'domain'>,
  b: Pick<DirectoryEntry, 'key' | 'domain'>,
): number {
  if ((a.domain === undefined) !== (b.domain === undefined)) return a.domain === undefined ? 1 : -1;
  if (a.domain !== undefined && b.domain !== undefined) {
    const byDomain = compareText(a.domain.toLowerCase(), b.domain.toLowerCase());
    if (byDomain !== 0) return byDomain;
  }
  return compareText(a.key, b.key);
}

/** The fees of a record: its own votes, and for the ones it leaves out the fees in force at its round (F5). */
function recordFeesOf(record: VoteRow, round: RoundInfo | undefined): Drops | undefined {
  const base = record.base_fee ?? round?.fees.base_fee;
  const reserveBase = record.reserve_base ?? round?.fees.reserve_base;
  const reserveInc = record.reserve_inc ?? round?.fees.reserve_inc;
  if (base === undefined || reserveBase === undefined || reserveInc === undefined) return undefined;
  return { base_fee: base, reserve_base: reserveBase, reserve_inc: reserveInc };
}

function domainStateOf(domain: string, rows: readonly DomainRow[], tomlPath: string): DomainState {
  const row = rows.find((candidate) => candidate.domain.toLowerCase() === domain.toLowerCase());
  if (row === undefined) return { status: 'pending', tomlUrl: `https://${domain}${tomlPath}` };
  return compact({
    status: row.status,
    reason: row.reason === '' ? undefined : row.reason,
    statusCode: row.statusCode === 0 ? undefined : row.statusCode,
    tomlUrl: row.tomlUrl,
    checked: row.checked,
    verified: row.verified,
    accounts: row.status === 'verified' && row.accounts.length > 0 ? row.accounts : undefined,
  });
}

/** The release build with the highest triple (and build) among the versions that decode, if any. */
function highestRelease(versions: Iterable<ServerVersion>): ServerVersion | undefined {
  let best: ServerVersion | undefined;
  for (const version of versions) {
    if (!version.release) continue;
    if (
      best === undefined ||
      compareTriples(version.triple, best.triple) > 0 ||
      (compareTriples(version.triple, best.triple) === 0 && (version.build ?? 0) > (best.build ?? 0))
    ) {
      best = version;
    }
  }
  return best;
}

/**
 * Builds the directory from the reads of one moment (`reads.builtAt`).
 *
 * "In use now" (the trusted UNL, the lists of a validator, the publishers' lists) takes only the stored lists served under the
 * configured key of their publisher (the `publisher_key` of its newest `unl_publishers` row); a list of a key the publisher no
 * longer uses was trusted in its time and is history. The trusted set, the quorum and the lists come from `listInUse` and
 * `trustedUnl` of the shared package.
 */
export function assembleDirectory(reads: DirectoryReads): Directory {
  const now = reads.builtAt / 1000;
  const signingToMaster = new Map(reads.manifestMap.map((row) => [row.ephemeral_key, row.master_key]));
  const masterOf = (key: string): string => signingToMaster.get(key) ?? key;

  // -- the publishers, their lists in use and the trusted UNL ---------------------------------------------------------
  const keyOfPublisher = new Map(reads.publishers.map((row) => [row.id, row.publicKey.toUpperCase()]));
  const lists = reads.lists.filter(
    (list) => list.publisherKey !== undefined && list.publisherKey.toUpperCase() === keyOfPublisher.get(list.publisher),
  );
  const newestRow = reads.publishers.reduce<PublisherRow | undefined>(
    (best, row) => (best === undefined || row.checked > best.checked ? row : best),
    undefined,
  );
  const threshold = newestRow?.threshold;
  const trusted =
    threshold === undefined
      ? new Set<string>()
      : trustedUnl(
          lists,
          reads.publishers.map((row) => row.id),
          threshold,
          now,
        );
  const inUse = new Map(
    reads.publishers.flatMap((row) => {
      const found = listInUse(lists, row.id, now);
      return found === undefined ? [] : [[row.id, found] as const];
    }),
  );
  const listsOf = new Map<string, string[]>();
  for (const [id, { list }] of inUse) {
    for (const validator of new Set(list.validators)) listsOf.set(validator, [...(listsOf.get(validator) ?? []), id]);
  }

  // -- the keys -------------------------------------------------------------------------------------------------------
  const seen = new Map<string, { first: number; last: number }>();
  for (const row of reads.seen) {
    const key = masterOf(row.key);
    const known = seen.get(key);
    seen.set(
      key,
      known === undefined
        ? { first: row.firstSeen, last: row.lastSeen }
        : { first: Math.min(known.first, row.firstSeen), last: Math.max(known.last, row.lastSeen) },
    );
  }
  const keys = [...new Set([...seen.keys(), ...listsOf.keys()])].sort(compareText);

  const manifests = new Map(reads.manifests.map((row) => [row.masterKey, row]));
  const activity = new Map(reads.activity.map((row) => [row.key, row]));
  const domains = new Map<string, DomainRow[]>();
  for (const row of reads.domains) domains.set(row.key, [...(domains.get(row.key) ?? []), row]);
  const versions = new Map(reads.versions.map((row) => [row.key, row]));

  // -- the state --------------------------------------------------------------------------------------------------------
  const negative = new Set((reads.state?.negativeUnl ?? []).map((member) => member.key));
  const negativeOnUnl = [...negative].filter((key) => trusted.has(key)).length;
  const quorum = {
    value: quorumOf(trusted.size, negativeOnUnl),
    unlSize: trusted.size,
    negativeOnUnl,
    ...(reads.state !== undefined && reads.state.nodeQuorum > 0 && { node: reads.state.nodeQuorum }),
  };

  // -- the versions -----------------------------------------------------------------------------------------------------
  const decoded = (raw: string): ServerVersion | undefined => decodeServerVersion(raw, reads.software);
  const latest = highestRelease(
    [...trusted].flatMap((key) =>
      (versions.get(key)?.recent ?? []).flatMap((raw) => {
        const version = decoded(raw);
        return version === undefined ? [] : [version];
      }),
    ),
  );

  // -- the rounds and the records -----------------------------------------------------------------------------------------
  const rounds = [...reads.rounds].sort((a, b) => a.ledgerIndex - b.ledgerIndex);
  const newestRound = rounds[rounds.length - 1];
  const roundAt = new Map(rounds.map((round) => [round.ledgerIndex, round]));
  const membership = new Map<number, RoundMembership>(
    rounds.map((round) => [round.ledgerIndex, { unl: new Set(round.unl), negativeUnl: new Set(round.negativeUnl) }]),
  );
  const newestUnl = new Set(newestRound?.unl ?? []);
  const votes = new Map<string, VoteRow[]>();
  for (const vote of reads.votes) {
    votes.set(vote.validation_public_key, [...(votes.get(vote.validation_public_key) ?? []), vote]);
  }

  // -- agreement ----------------------------------------------------------------------------------------------------------
  const newestFinal = newestFinalHour(reads.sentinels);
  const noRows: ReadonlyMap<number, KeyHour> = new Map();

  // -- the entries ----------------------------------------------------------------------------------------------------------
  const entries = new Map<string, DirectoryEntry>();
  for (const key of keys) {
    const seenAt = seen.get(key);
    const manifest = manifests.get(key);
    // a domain that is not one rippled would check (`isProperlyFormedTomlDomain`) is served nowhere: not as the domain, not in
    // the manifest, not as the address of a TOML file
    const domain =
      manifest?.domain === undefined || !isProperlyFormedTomlDomain(manifest.domain) ? undefined : manifest.domain;
    const rows = votes.get(key);
    const record =
      rows === undefined || newestRound === undefined
        ? undefined
        : recordOf(rows, newestRound.ledgerIndex, newestRound.closeTime);
    const countedRecord =
      rows === undefined || newestRound === undefined || !newestUnl.has(key)
        ? undefined
        : recordOf(rows, newestRound.ledgerIndex, newestRound.closeTime, membership);
    const reported = versions.get(key);
    const version = reported === undefined ? undefined : decoded(reported.serverVersion);
    const windows =
      newestFinal === undefined
        ? { agreement1h: NO_AGREEMENT, agreement24h: NO_AGREEMENT, agreement30d: NO_AGREEMENT, daily: [] }
        : agreementWindows(reads.sentinels, reads.hourly.get(key) ?? noRows, newestFinal);
    const newest = activity.get(key);

    entries.set(
      key,
      compact({
        key,
        domain,
        signingKey: manifest?.signingKey,
        manifest:
          manifest === undefined
            ? undefined
            : compact({
                sequence: manifest.sequence,
                signingKey: manifest.signingKey,
                signingKeysSeen: manifest.signingKeysSeen,
                domain,
              }),
        domainState: domain === undefined ? undefined : domainStateOf(domain, domains.get(key) ?? [], reads.tomlPath),
        currentIndex: newest?.ledgerIndex,
        partial: newest === undefined ? undefined : !newest.full,
        ...windows,
        unl: trusted.has(key),
        unlLists: [...(listsOf.get(key) ?? [])].sort(compareText),
        negativeUnl: negative.has(key),
        version,
        serverVersion: reported?.serverVersion,
        versionLatest:
          version === undefined
            ? undefined
            : latest !== undefined && compareTriples(version.triple, latest.triple) >= 0,
        record,
        recordFees: record === undefined ? undefined : recordFeesOf(record, roundAt.get(record.ledger_index)),
        countedRecord,
        firstSeen: seenAt?.first,
        lastSeen: seenAt?.last,
        seen24h: seenAt !== undefined && seenAt.last >= now - DAY_SECONDS,
        listed: listsOf.has(key) || (seenAt !== undefined && seenAt.last >= now - 30 * DAY_SECONDS),
      }),
    );
  }

  // -- the publishers' states ---------------------------------------------------------------------------------------------
  const publishers = reads.publishers.map((row): PublisherState => {
    const found = inUse.get(row.id);
    return compact({
      id: row.id,
      url: row.url,
      publicKey: row.publicKey,
      status: found === undefined ? 'unavailable' : found.expired ? 'expired' : 'ok',
      list: found?.list,
      seen24h:
        found === undefined
          ? undefined
          : [...new Set(found.list.validators)].filter((key) => entries.get(key)?.seen24h === true).length,
      lastError: row.status === 'error' ? row.error : undefined,
      lastErrorAt: row.status === 'error' ? row.checked : undefined,
    });
  });

  // no ledger indexed yet: the head is the ledger of the newest ledger state, without a close time
  const head = reads.head ?? (reads.state === undefined ? undefined : { ledgerIndex: reads.state.ledgerIndex });

  return compact({
    builtAt: reads.builtAt,
    head,
    state: reads.state,
    publishers,
    threshold,
    trusted,
    quorum,
    entries,
    ordered: [...entries.values()].filter((entry) => entry.listed).sort(compareEntries),
    signingToMaster,
    newestRound,
    newestFinalHour: newestFinal,
    latest,
  });
}

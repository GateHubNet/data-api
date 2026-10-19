import {
  AmendmentFeaturesRow,
  amendmentId,
  AmendmentTalliesRow,
  ClickHouseService,
  LedgersRow,
  NetworkName,
  NetworkStateRow,
  Table,
  TransactionsRow,
  TxByTypeRow,
  UnlListsRow,
  UnlPublishersRow,
  ValidatorAgreementHourlyRow,
  ValidatorDomainsRow,
  ValidatorManifestsRow,
  ValidatorSeenRow,
  ValidatorValidationsRow,
  ValidatorVotesRow,
} from '@gatehub/data-api-shared';
import { createHash } from 'node:crypto';
import { testKey, TestKey } from '../../../../packages/shared/src/test-utils/validator-keys';

/**
 * Seeds for the validators e2e specs: typed insert helpers for every table the validator directory reads (a helper takes
 * the fields that matter and fills the others with the values of a quiet row), the keys of a fleet, and a whole scenario,
 * "the fleet", that the summary spec and the bounded-read spec share. Times are unix seconds (a fraction for the
 * `DateTime64(3)` columns), keys are base58.
 */

export const HOUR = 3600;
export const DAY = 86_400;

/** The default publishers of XRPL (F13): their keys are the real ones, the lists signed by them are not made here. */
export const PUBLISHER_KEY = {
  'vl.ripple.com': 'ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734',
  'unl.xrplf.org': 'ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1',
  'vl.xahau.org': 'EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8',
} as const;

// -- keys -------------------------------------------------------------------------------------------------------------

export interface FleetMember {
  index: number;
  master: TestKey;
  signing: TestKey;
  /** The master key, base58. */
  key: string;
  /** The signing (ephemeral) key, base58. */
  ephemeral: string;
}

const fleets = new Map<string, FleetMember[]>();

/**
 * `size` validators with valid keys, made from labels, so the same call gives the same keys. The keys of the first `n` do
 * not depend on `size`. The master key is an ed25519 key (`nH...`), as the master keys of the real validators are; the
 * signing key is a secp256k1 key (`n9...`), as rippled makes its signing keys.
 */
export function fleet(network: NetworkName, size: number): FleetMember[] {
  const members = fleets.get(network) ?? [];
  fleets.set(network, members);
  for (let index = members.length; index < size; index++) {
    const master = testKey(`${network}-validator-${index}`);
    const signing = testKey(`${network}-signing-${index}`, 'ecdsa-secp256k1');
    members.push({ index, master, signing, key: master.base58, ephemeral: signing.base58 });
  }
  return members.slice(0, size);
}

/** The `sfServerVersion` of a software version, as the decimal text the stream carries (F3, F4). */
export function serverVersion(major: number, minor: number, patch: number, release = 0xc0, build = 0): string {
  return (
    (0x183bn << 48n) |
    (BigInt(major) << 40n) |
    (BigInt(minor) << 32n) |
    (BigInt(patch) << 24n) |
    (BigInt(release) << 16n) |
    BigInt(build)
  ).toString();
}
/** The release byte of a rippled release candidate 1. */
export const RC1 = 0x81;

// -- typed inserts ----------------------------------------------------------------------------------------------------

type Ch = Pick<ClickHouseService, 'insert'>;

export function insertManifests(
  ch: Ch,
  rows: (Pick<ValidatorManifestsRow, 'ephemeral_key' | 'master_key' | 'seq'> & Partial<ValidatorManifestsRow>)[],
): Promise<void> {
  return ch.insert(
    Table.ValidatorManifests,
    rows.map((row): ValidatorManifestsRow => ({ domain: '', manifest: '', source: 'stream', ...row })),
  );
}

/**
 * `count` manifests of validators nobody has seen, as one insert: distinct keys of the length of a base58 node key (52
 * characters), made from the row number. They are not keys of any curve and have no signature: the manifest map needs neither.
 */
export function insertManyManifests(ch: Pick<ClickHouseService, 'command'>, count: number): Promise<void> {
  return ch.command(
    `INSERT INTO ${Table.ValidatorManifests} (ephemeral_key, master_key, seq, domain, manifest, source)
     SELECT concat('n9', substring(hex(SHA256(concat('signing-', toString(number)))), 1, 50)),
            concat('nH', substring(hex(SHA256(concat('master-', toString(number)))), 1, 50)),
            1, '', '', 'stream'
       FROM numbers({count:UInt32})`,
    { count },
  );
}

export function insertSeen(
  ch: Ch,
  rows: { key: string; first: number; last: number; ledger?: number }[],
): Promise<void> {
  return ch.insert(
    Table.ValidatorSeen,
    rows.map(
      (row): ValidatorSeenRow => ({
        validation_public_key: row.key,
        first_seen: row.first,
        last_seen: row.last,
        last_ledger_index: row.ledger ?? 0,
      }),
    ),
  );
}

export function insertLists(
  ch: Ch,
  rows: (Pick<UnlListsRow, 'publisher' | 'sequence' | 'expiration' | 'validators'> & Partial<UnlListsRow>)[],
): Promise<void> {
  return ch.insert(
    Table.UnlLists,
    rows.map(
      (row): UnlListsRow => ({
        publisher_key: PUBLISHER_KEY[row.publisher as keyof typeof PUBLISHER_KEY] ?? '',
        version: 1,
        effective: null,
        blob_sha256: '',
        fetched_at: row.expiration - 30 * DAY,
        response: '{}',
        ...row,
        validators: [...row.validators].sort(),
      }),
    ),
  );
}

export function insertPublishers(
  ch: Ch,
  rows: (Pick<UnlPublishersRow, 'publisher' | 'checked_at'> & Partial<UnlPublishersRow>)[],
): Promise<void> {
  return ch.insert(
    Table.UnlPublishers,
    rows.map(
      (row): UnlPublishersRow => ({
        url: `https://${row.publisher}`,
        publisher_key: PUBLISHER_KEY[row.publisher as keyof typeof PUBLISHER_KEY] ?? '',
        configured: 1,
        threshold: 1,
        status: 'ok',
        error: '',
        last_ok_at: row.checked_at,
        ...row,
      }),
    ),
  );
}

export function insertDomains(
  ch: Ch,
  rows: (Pick<ValidatorDomainsRow, 'validation_public_key' | 'domain' | 'checked_at'> & Partial<ValidatorDomainsRow>)[],
): Promise<void> {
  return ch.insert(
    Table.ValidatorDomains,
    rows.map(
      (row): ValidatorDomainsRow => ({
        status: 'verified',
        reason: '',
        status_code: 0,
        toml_url: `https://${row.domain}/.well-known/xrp-ledger.toml`,
        verified_at: row.checked_at,
        next_check_at: Math.floor(row.checked_at) + 6 * HOUR,
        accounts: [],
        ...row,
      }),
    ),
  );
}

export function insertState(
  ch: Ch,
  rows: (Pick<NetworkStateRow, 'ledger_index' | 'polled_at'> & Partial<NetworkStateRow>)[],
): Promise<void> {
  return ch.insert(
    Table.NetworkState,
    rows.map(
      (row): NetworkStateRow => ({
        ledger_hash: 'AB'.repeat(32),
        amendments: [],
        majorities: [],
        negative_unl: [],
        to_disable: '',
        to_reenable: '',
        base_fee: 10,
        reserve_base: 1_000_000,
        reserve_inc: 200_000,
        node_quorum: 0,
        ...row,
      }),
    ),
  );
}

/** A committed ledger as `ledgers` holds it: only the index and the close time matter to the directory. */
export function ledgerRow(ledgerIndex: number, closeTime: number): LedgersRow {
  return {
    ledger_index: ledgerIndex,
    ledger_hash: ledgerIndex.toString(16).toUpperCase().padStart(64, '0'),
    parent_hash: (ledgerIndex - 1).toString(16).toUpperCase().padStart(64, '0'),
    account_hash: '',
    transaction_hash: '',
    total_coins: '99985687626634189',
    close_time: closeTime,
    parent_close_time: closeTime - 4,
    close_time_resolution: 10,
    close_flags: 0,
    tx_count: 0,
    type_counts: {},
    result_counts: {},
    payments_count: 0,
    exchanges_count: 0,
    accounts_created: 0,
    fee_total: 0,
    fee_min: 0,
    fee_max: 0,
    parser_version: 1,
  };
}

/** `count` committed ledgers ending with `lastIndex`, which closed at `lastClose`, `interval` seconds apart. */
export function insertLedgers(
  ch: Ch,
  lastIndex: number,
  lastClose: number,
  count: number,
  interval: number,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => {
    const behind = count - 1 - i;
    return ledgerRow(lastIndex - behind, lastClose - behind * interval);
  });
  return ch.insert(Table.Ledgers, rows);
}

/** One voting round as `amendment_tallies` and `validator_votes` hold it, written whole under one `version`. */
export interface SeedRound {
  ledgerIndex: number;
  closeTime: number;
  /** A UInt64: text keeps what a number cannot (above 2^53). Default: the clock in milliseconds. */
  version?: number | string;
  unl: string[];
  negativeUnl?: string[];
  /** The validators of the UNL with a record. Default: all of the UNL. */
  trusted?: number;
  observed?: number;
  fees?: { base_fee: number; reserve_base: number; reserve_inc: number };
  /** The votes of the round, by (master or signing) key. */
  votes?: SeedVote[];
  /** The tally rows of the round: the amendments with yes votes (or in `Majorities`). */
  tallies?: { id: string; yes: number }[];
}

export interface SeedVote {
  key: string;
  full?: number;
  amendments?: string[];
  base_fee?: number | null;
  reserve_base?: number | null;
  reserve_inc?: number | null;
  serverVersion?: string | null;
}

/** The votes and the tallies first, then the sentinel last, as the rounds job writes them. */
export async function insertRound(ch: Ch, round: SeedRound): Promise<void> {
  const version = round.version ?? Date.now();
  const fees = round.fees ?? { base_fee: 10, reserve_base: 1_000_000, reserve_inc: 200_000 };
  const votes: ValidatorVotesRow[] = (round.votes ?? []).map((vote) => ({
    ledger_index: round.ledgerIndex,
    validation_public_key: vote.key,
    ledger_hash: round.ledgerIndex.toString(16).toUpperCase().padStart(64, '0'),
    close_time: round.closeTime,
    full: vote.full ?? 1,
    amendments: vote.amendments ?? [],
    base_fee: vote.base_fee ?? null,
    reserve_base: vote.reserve_base ?? null,
    reserve_inc: vote.reserve_inc ?? null,
    server_version: vote.serverVersion ?? null,
    version,
  }));
  await ch.insert(Table.ValidatorVotes, votes);
  const trusted = round.trusted ?? round.unl.length;
  const sentinel: AmendmentTalliesRow = {
    ledger_index: round.ledgerIndex,
    amendment_id: '',
    close_time: round.closeTime,
    yes: 0,
    trusted,
    threshold: Math.max(1, Math.floor((trusted * 80) / 100)),
    unl_size: round.unl.length,
    observed: round.observed ?? round.unl.length,
    unl: round.unl,
    negative_unl: round.negativeUnl ?? [],
    ...fees,
    version,
  };
  await ch.insert(
    Table.AmendmentTallies,
    (round.tallies ?? []).map(
      (tally): AmendmentTalliesRow => ({
        ...sentinel,
        amendment_id: tally.id,
        yes: tally.yes,
        unl: [],
        negative_unl: [],
      }),
    ),
  );
  await ch.insert(Table.AmendmentTallies, [sentinel]);
}

/** What the node says of amendments (`feature`): the name, which may be empty, and whether it supports it. */
export function insertFeatures(
  ch: Ch,
  rows: (Pick<AmendmentFeaturesRow, 'amendment_id' | 'polled_at'> & Partial<AmendmentFeaturesRow>)[],
): Promise<void> {
  return ch.insert(
    Table.AmendmentFeatures,
    rows.map((row): AmendmentFeaturesRow => ({ name: '', supported: 1, ...row })),
  );
}

/** An `EnableAmendment` pseudo-transaction as the index holds it: the ledger of it, and what it did (its flags). */
export interface SeedEnableAmendment {
  amendment: string;
  /** 0 enables, 0x10000 is tfGotMajority, 0x20000 tfLostMajority. */
  flags: number;
  ledgerIndex: number;
  closeTime: number;
  /** Default: made from the other fields. */
  hash?: string;
  /** Leave `Flags` out of the transaction, as a transaction that enables has no use for it. */
  withoutFlags?: boolean;
}

/** The hash a seeded `EnableAmendment` gets: upper-case hex of the ledger, the amendment and the flags. */
export const enableHash = (ledgerIndex: number, amendment: string, flags: number): string =>
  createHash('sha256').update(`${ledgerIndex}:${amendment}:${flags}`).digest('hex').toUpperCase();

export async function insertEnableAmendments(ch: Ch, rows: SeedEnableAmendment[]): Promise<void> {
  const transactions = rows.map(
    (row): TransactionsRow => ({
      ledger_index: row.ledgerIndex,
      tx_index: 0,
      hash: row.hash ?? enableHash(row.ledgerIndex, row.amendment, row.flags),
      tx_type: 'EnableAmendment',
      result: 'tesSUCCESS',
      account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
      sequence: 0,
      fee: 0,
      close_time: row.closeTime,
      tx_json: JSON.stringify({
        Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        Amendment: row.amendment,
        Fee: '0',
        ...(row.withoutFlags ? {} : { Flags: row.flags }),
        LedgerSequence: row.ledgerIndex - 1,
        Sequence: 0,
        SigningPubKey: '',
        TransactionType: 'EnableAmendment',
      }),
      meta_json: '{}',
    }),
  );
  await ch.insert(Table.Transactions, transactions);
  await ch.insert(
    Table.TxByType,
    rows.map(
      (row): TxByTypeRow => ({
        tx_type: 'EnableAmendment',
        ledger_index: row.ledgerIndex,
        tx_index: 0,
        result: 'tesSUCCESS',
      }),
    ),
  );
}

/** One hour as `validator_agreement_hourly` holds it: the rows of the keys first, the sentinel last, under one version. */
export interface SeedHour {
  hour: number;
  /** A UInt64: text keeps what a number cannot (above 2^53). Default: the clock in milliseconds. */
  version?: number | string;
  final?: boolean;
  /** Observed ledgers; default 900. */
  ledgers?: number;
  unobserved?: number;
  rows?: { key: string; agreed: number; missed: number; partial?: number; lastSeen?: number }[];
}

export function hourRows(hour: SeedHour): ValidatorAgreementHourlyRow[] {
  const version = hour.version ?? Date.now();
  const ledgers = hour.ledgers ?? 900;
  const rows = (hour.rows ?? []).map(
    (row): ValidatorAgreementHourlyRow => ({
      hour: hour.hour,
      validation_public_key: row.key,
      agreed: row.agreed,
      missed: row.missed,
      partial: row.partial ?? 0,
      last_seen: row.lastSeen ?? hour.hour + HOUR - 1,
      ledgers: 0,
      unobserved: 0,
      gaps: 0,
      unl_size: 0,
      quorum: 0,
      final: 0,
      version,
    }),
  );
  const sentinel: ValidatorAgreementHourlyRow = {
    hour: hour.hour,
    validation_public_key: '',
    agreed: 0,
    missed: 0,
    partial: 0,
    last_seen: hour.hour,
    ledgers,
    unobserved: hour.unobserved ?? 0,
    gaps: 0,
    unl_size: 35,
    quorum: 28,
    final: hour.final === false ? 0 : 1,
    version,
  };
  return [...rows, sentinel];
}

export function insertHours(ch: Ch, hours: SeedHour[]): Promise<void> {
  return ch.insert(Table.ValidatorAgreementHourly, hours.flatMap(hourRows));
}

export function insertValidatorValidations(
  ch: Ch,
  rows: (Pick<ValidatorValidationsRow, 'validation_public_key' | 'ledger_index' | 'first_datetime'> &
    Partial<ValidatorValidationsRow>)[],
): Promise<void> {
  return ch.insert(
    Table.ValidatorValidations,
    rows.map(
      (row): ValidatorValidationsRow => ({
        ledger_hash: row.ledger_index.toString(16).toUpperCase().padStart(64, '0'),
        count: 1,
        last_datetime: row.first_datetime,
        ephemeral_public_key: '',
        signing_time: 0,
        full: 1,
        server_version: null,
        ...row,
      }),
    ),
  );
}

// -- the fleet --------------------------------------------------------------------------------------------------------

/** The head of the fleet's chain, and the voting ledger before it. */
export const HEAD_LEDGER = 107_748_183;
export const VOTING_LEDGER = 107_748_095;
const LEDGER_INTERVAL = 4;

/** What `seedFleet` wrote: the validators by role and the times it chose. */
export interface FleetScenario {
  /** The clock of the seed, in seconds. The summary of the scenario is built a few seconds later. */
  now: number;
  /** The 35 trusted validators. [33] was never seen; [34] was seen only under its signing key. */
  unl: FleetMember[];
  /** 20 validators off the UNL seen in the last 24 h. */
  others: FleetMember[];
  /** 2 seen three days ago, and 1 seen 40 days ago. */
  lapsed: FleetMember[];
  dormant: FleetMember;
  /** The signing key unl[0] rotated to (its manifest of sequence 2, which names the domain `northpeak.example`). */
  rotated: TestKey;
  /** The close time of the head ledger. */
  headClose: number;
  /** When `vl.ripple.com` fetched its list, and when its list expires. */
  fetchedA: number;
  expirationA: number;
  /** The same for `unl.xrplf.org`, whose list is expired, and when its newest attempt failed. */
  fetchedB: number;
  expirationB: number;
  failedAtB: number;
  newestHour: number;
  /** The close time of the voting ledger of round `i` (0 is the newest). */
  roundClose(round: number): number;
  /** The newest voting ledger of round `i`. */
  roundLedger(round: number): number;
}

export interface FleetOptions {
  /** Final agreement hours to write, ending with the previous hour. Default 48. */
  hours?: number;
  /**
   * Write `validator_validations` too: the validations of the 54 validators seen in the last 24 h for each of the last 301
   * ledgers (the ones of unl[34] under its signing key); unl[1] has only a partial validation of the head. Default false.
   */
  activity?: boolean;
  network?: NetworkName;
}

/**
 * The fleet of the summary examples (XRPL, 35 trusted validators on two publishers: `vl.ripple.com` with a current list and
 * `unl.xrplf.org` with an expired one and a failed newest attempt), 20 others seen in the last 24 h, 2 seen three days ago and
 * 1 forty days ago.
 *
 *  - versions: 30 of the UNL on 3.4.1, 4 on 3.4.0, one unseen without one; of the others 10 on 3.4.1, 5 on 3.4.0, 3 on
 *    3.5.0-rc1 and 2 without (unl[34] voted under its signing key);
 *  - negative UNL: unl[4] is on it, and its re-enabling is pending; the node reports a quorum of 28;
 *  - chain: 1,000 ledgers 4 s apart ending with 107748183 (8 s ago), four voting rounds 256 ledgers apart from 107748095
 *    and one ten days ago, final agreement hours up to the previous full hour.
 */
export async function seedFleet(ch: ClickHouseService, options: FleetOptions = {}): Promise<FleetScenario> {
  const network = options.network ?? 'xrpl';
  const members = fleet(network, 58);
  const unl = members.slice(0, 35);
  const others = members.slice(35, 55);
  const lapsed = members.slice(55, 57);
  const dormant = members[57];
  const now = Math.floor(Date.now() / 1000);
  const headClose = now - 8;
  const closeOfLedger = (ledger: number): number => headClose - (HEAD_LEDGER - ledger) * LEDGER_INTERVAL;
  const roundLedger = (round: number): number => VOTING_LEDGER - round * 256;
  const roundClose = (round: number): number => closeOfLedger(roundLedger(round));
  const newestHour = Math.floor(now / HOUR) * HOUR - HOUR;
  const hours = options.hours ?? 48;

  await insertLedgers(ch, HEAD_LEDGER, headClose, 1000, LEDGER_INTERVAL);

  // manifests: every validator has one; unl[0] rotated its signing key and has a domain, as have unl[1] and others[1]
  const rotated = testKey('xrpl-signing-rotated-0', 'ecdsa-secp256k1');
  await insertManifests(ch, [
    ...members.map((m) => ({ ephemeral_key: m.ephemeral, master_key: m.key, seq: 1 })),
    { ephemeral_key: rotated.base58, master_key: unl[0].key, seq: 2, domain: 'northpeak.example' },
    { ephemeral_key: unl[1].ephemeral, master_key: unl[1].key, seq: 3, domain: 'shoreline.example' },
    { ephemeral_key: others[1].ephemeral, master_key: others[1].key, seq: 2, domain: 'tidewater.example' },
  ]);
  await insertDomains(ch, [
    {
      validation_public_key: unl[0].key,
      domain: 'northpeak.example',
      checked_at: now - 600.511,
      accounts: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    },
    // recorded under the signing key, before the manifest was known to the checker
    {
      validation_public_key: others[1].ephemeral,
      domain: 'tidewater.example',
      checked_at: now - 300.125,
    },
    {
      validation_public_key: unl[1].key,
      domain: 'shoreline.example',
      status: 'unverified',
      reason: 'not_listed',
      verified_at: null,
      checked_at: now - 700.25,
    },
  ]);

  // seen: the master keys; unl[33] never; unl[34] by its master three days ago and by its signing key a minute ago
  const day90 = now - 90 * DAY;
  await insertSeen(ch, [
    ...unl.slice(0, 33).map((m) => ({ key: m.key, first: day90, last: now - 60.25 })),
    { key: unl[34].key, first: day90, last: now - 3 * DAY },
    { key: unl[34].ephemeral, first: now - DAY, last: now - 90.5 },
    ...others.map((m) => ({ key: m.key, first: now - 30 * DAY, last: now - 120.75 })),
    ...lapsed.map((m) => ({ key: m.key, first: now - 30 * DAY, last: now - 3 * DAY })),
    { key: dormant.key, first: now - 80 * DAY, last: now - 40 * DAY },
  ]);

  // lists: vl.ripple.com current with all 35; unl.xrplf.org with 34, expired a day ago, its newest attempt failed
  const fetchedA = now - 173.886;
  const fetchedB = now - 7 * DAY + 0.38;
  const expirationA = now + 170 * DAY;
  const expirationB = now - DAY;
  const failedAtB = now - 600.38;
  await insertLists(ch, [
    {
      publisher: 'vl.ripple.com',
      sequence: 85,
      expiration: expirationA,
      fetched_at: fetchedA,
      validators: unl.map((m) => m.key),
    },
    {
      publisher: 'unl.xrplf.org',
      sequence: 2_026_070_302,
      expiration: expirationB,
      fetched_at: fetchedB,
      validators: unl.slice(0, 34).map((m) => m.key),
    },
  ]);
  await insertPublishers(ch, [
    { publisher: 'vl.ripple.com', checked_at: now - 173.886 },
    { publisher: 'unl.xrplf.org', checked_at: failedAtB, status: 'error', error: 'http_status', last_ok_at: fetchedB },
  ]);

  // the ledger state: unl[4] is on the negative UNL, its re-enabling is pending
  await insertState(ch, [
    {
      ledger_index: HEAD_LEDGER - 3,
      polled_at: now - 20.5,
      negative_unl: [{ validation_public_key: unl[4].key, first_ledger: 107_747_000 }],
      to_reenable: unl[4].key,
      node_quorum: 28,
    },
  ]);

  // votes: the 54 validators seen in the last 24 h vote in every round, with the versions of the description
  const v341 = serverVersion(3, 4, 1);
  const v340 = serverVersion(3, 4, 0);
  const rc = serverVersion(3, 5, 0, RC1);
  const versionOf = (m: FleetMember): string | null => {
    const unlIndex = unl.indexOf(m);
    if (unlIndex >= 0) return unlIndex < 30 ? v341 : v340;
    const other = others.indexOf(m);
    if (other < 0) return null;
    return other < 10 ? v341 : other < 15 ? v340 : other < 18 ? rc : null;
  };
  const voters = [...unl.slice(0, 33), unl[34], ...others];
  const unlKeys = unl.map((m) => m.key);
  const negative = [unl[4].key];
  const base = Date.now();
  for (let round = 3; round >= 0; round--) {
    await insertRound(ch, {
      ledgerIndex: roundLedger(round),
      closeTime: roundClose(round),
      version: base + (3 - round),
      unl: unlKeys,
      negativeUnl: round === 0 ? negative : [],
      votes: voters.map((m) => ({
        // unl[34] was recorded under its signing key, before its manifest was known
        key: m === unl[34] ? m.ephemeral : m.key,
        amendments: ['98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76'],
        serverVersion: versionOf(m),
        ...(round === 0 && m === unl[2] ? { base_fee: 12 } : {}),
      })),
    });
  }
  // an old round: the lapsed validators voted in it
  await insertRound(ch, {
    ledgerIndex: roundLedger(800),
    closeTime: now - 10 * DAY,
    version: base,
    unl: unlKeys,
    votes: lapsed.map((m) => ({ key: m.key, serverVersion: v340 })),
  });

  // agreement: every validator seen in the last 24 h is tracked in every hour
  const tracked = [...unl.slice(0, 33), unl[34], ...others];
  const hourList: SeedHour[] = [];
  for (let back = hours - 1; back >= 0; back--) {
    const hour = newestHour - back * HOUR;
    hourList.push({
      hour,
      version: base,
      rows: tracked.map((m, i) => {
        const missed = (i + back) % 17 === 0 ? 1 : 0;
        // unl[34]'s older hours were written under its signing key, before its manifest was known
        const key = m === unl[34] && back >= 24 ? m.ephemeral : m.key;
        return { key, agreed: 900 - missed, missed, partial: missed && (i + back) % 34 === 0 ? 1 : 0 };
      }),
    });
  }
  await insertHours(ch, hourList);

  if (options.activity) {
    const rows: Parameters<typeof insertValidatorValidations>[1] = [];
    for (let ledger = HEAD_LEDGER - 300; ledger <= HEAD_LEDGER; ledger++) {
      for (const m of tracked) {
        rows.push({
          validation_public_key: m === unl[34] ? m.ephemeral : m.key,
          ledger_index: ledger,
          first_datetime: closeOfLedger(ledger) + 1.25,
          full: m === unl[1] && ledger === HEAD_LEDGER ? 0 : 1,
        });
      }
    }
    await insertValidatorValidations(ch, rows);
  }

  return {
    now,
    unl,
    others,
    lapsed,
    dormant,
    rotated,
    headClose,
    fetchedA,
    expirationA,
    fetchedB,
    expirationB,
    failedAtB,
    newestHour,
    roundClose,
    roundLedger,
  };
}

// -- the amendment board ------------------------------------------------------------------------------------------------

/**
 * The amendments of the board's metadata file, `test/support/amendments-xrpl.json` (hand-written for the tests: the names
 * and the figures in it are made up, none is recorded from the network).
 */
export const BOARD_NAMES = {
  enabledLedger: 'TestEnabledLedger',
  enabledFile: 'TestEnabledFile',
  majority: 'TestMajority',
  voting: 'TestVoting',
  idle: 'TestVotingIdle',
  obsolete: 'TestObsolete',
} as const;

/**
 * The IDs of the board. The ones of the file are the SHA-512Half of their names; the others are not in the file: a name only
 * the node gives, none at all, the one mainnet's majority has (F10).
 */
export const BOARD_IDS = {
  enabledLedger: amendmentId(BOARD_NAMES.enabledLedger),
  enabledFile: amendmentId(BOARD_NAMES.enabledFile),
  majority: amendmentId(BOARD_NAMES.majority),
  voting: amendmentId(BOARD_NAMES.voting),
  idle: amendmentId(BOARD_NAMES.idle),
  obsolete: amendmentId(BOARD_NAMES.obsolete),
  /** In `Majorities`, named by nobody, no `EnableAmendment` indexed (G5). */
  majorityNameless: '98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76',
  /** Named by the node only, voted for by one validator of the UNL. */
  nodeOnly: '11'.repeat(32),
  /** Listed by the node without a name, voted for by nobody. */
  unknown: '22'.repeat(32),
  /** The node does not support it and nobody votes yes. */
  obsoleteNode: '33'.repeat(32),
  /** The node does not support it but two validators of the UNL vote yes. */
  unsupportedVoted: '44'.repeat(32),
  /** No name; voted for only by a validator that is not on the UNL. */
  votedByOther: '55'.repeat(32),
  /** Enabled in the ledger, and no source says when. */
  enabledBare: '66'.repeat(32),
  /** Voted for by a validator only before the last 30 days. */
  votedLongAgo: '77'.repeat(32),
} as const;

/** The yes votes of each amendment in the four newest rounds, oldest (round 3) to newest (round 0). */
const BOARD_YES: Record<string, [number, number, number, number]> = {
  [BOARD_IDS.majority]: [25, 29, 31, 31],
  [BOARD_IDS.voting]: [2, 3, 3, 4],
  [BOARD_IDS.enabledLedger]: [32, 32, 32, 32],
  [BOARD_IDS.majorityNameless]: [30, 30, 30, 30],
  [BOARD_IDS.nodeOnly]: [0, 0, 0, 1],
  [BOARD_IDS.unsupportedVoted]: [0, 0, 0, 2],
};

/** What `seedAmendmentBoard` wrote. */
export interface BoardScenario {
  /** The clock of the seed, in seconds. */
  now: number;
  /** The 36 validators of the UNL. [0..34] vote in every round; [35] never voted. */
  unl: FleetMember[];
  /** [0] votes for the majority amendment and for one only it votes for; [1] votes for nothing; [2] never voted; [3] voted, but was seen three days ago. */
  others: FleetMember[];
  headClose: number;
  /** The voting ledger of round `i` (0 is the newest), and its close time. */
  roundLedger(round: number): number;
  roundClose(round: number): number;
  /** The voting ledger of the round of ten days ago, and of the one of forty days ago (outside the 30-day window). */
  oldLedger: number;
  oldClose: number;
  veryOldLedger: number;
  /** The ledger and close time of the `EnableAmendment` that enabled `TestEnabledLedger`. */
  enabledAt: { ledgerIndex: number; closeTime: number };
  /** `Majorities`: when each majority was gained. */
  since: { majority: number; majorityNameless: number };
  /** The ledger and time of the `EnableAmendment` (tfGotMajority) behind the `TestMajority` majority. */
  gotMajority: { ledgerIndex: number; closeTime: number };
  /** The `EnableAmendment` transactions written. */
  transactions: SeedEnableAmendment[];
  /** The ledger state the amendments are read from. */
  state: { amendments: string[] };
}

/**
 * The board of the amendments page (XRPL, with the metadata file `test/support/amendments-xrpl.json`): 36 validators on the
 * UNL of one publisher (35 with a record, so `trusted` is 35, the threshold 28), 4 others, and thirteen amendments, at least
 * one in every state:
 *
 *  - enabled: `TestEnabledLedger` (an indexed `EnableAmendment` in the middle of the rounds), `TestEnabledFile` (only the
 *    file says when) and an ID nobody says anything of;
 *  - majority: `TestMajority` (31 yes of 35; an indexed tfGotMajority, after a lost majority and an earlier one) and the
 *    nameless one of mainnet (30 yes, no indexed transaction);
 *  - voting: `TestVoting` (4 yes), `TestVotingIdle` (no vote at all), one named by the node only, one the node does not
 *    support with two yes, and one nameless voted for by an outsider;
 *  - obsolete: `TestObsolete` (the file) and one the node does not support;
 *  - unknown: an ID the node lists without a name.
 *
 * Rounds: four of 256 ledgers apart ending with `VOTING_LEDGER`, one ten days ago and one forty days ago, which the 30-day
 * window leaves out. The votes of each round are what its tallies say (member `i` of the UNL votes for an amendment that has
 * `n` yes when `i < n`); unl[5] is recorded under its signing key, and the ledger state was polled twice (the newer wins).
 * Versions: unl[0..29] 3.4.1, unl[30..34] 3.4.0, others[0] 3.4.1, others[1] 3.5.0.
 */
export async function seedAmendmentBoard(ch: ClickHouseService): Promise<BoardScenario> {
  const members = fleet('xrpl', 40);
  const unl = members.slice(0, 36);
  const others = members.slice(36);
  const now = Math.floor(Date.now() / 1000);
  const headClose = now - 8;
  const closeOfLedger = (ledger: number): number => headClose - (HEAD_LEDGER - ledger) * LEDGER_INTERVAL;
  const roundLedger = (round: number): number => VOTING_LEDGER - round * 256;
  const roundClose = (round: number): number => closeOfLedger(roundLedger(round));
  const oldLedger = roundLedger(800);
  const oldClose = now - 10 * DAY;
  const veryOldLedger = roundLedger(5000);

  await insertLedgers(ch, HEAD_LEDGER, headClose, 1000, LEDGER_INTERVAL);

  // the UNL: one publisher with all 36; manifests with the domains of three
  await insertLists(ch, [
    {
      publisher: 'vl.ripple.com',
      sequence: 85,
      expiration: now + 170 * DAY,
      fetched_at: now - 200,
      validators: unl.map((m) => m.key),
    },
  ]);
  await insertPublishers(ch, [{ publisher: 'vl.ripple.com', checked_at: now - 200 }]);
  await insertManifests(ch, [
    ...members.map((m) => ({ ephemeral_key: m.ephemeral, master_key: m.key, seq: 1 })),
    { ephemeral_key: unl[0].ephemeral, master_key: unl[0].key, seq: 2, domain: 'northpeak.example' },
    { ephemeral_key: unl[1].ephemeral, master_key: unl[1].key, seq: 2, domain: 'shoreline.example' },
    { ephemeral_key: others[0].ephemeral, master_key: others[0].key, seq: 2, domain: 'tidewater.example' },
  ]);
  await insertSeen(
    ch,
    members.map((m) => ({
      key: m.key,
      first: now - 90 * DAY,
      last: m === others[3] ? now - 3 * DAY : now - 60.25,
    })),
  );

  // the ledger state, polled twice: the newer one is the one that counts
  const since = { majority: now - 2 * DAY, majorityNameless: now - 5 * DAY };
  const state = {
    amendments: [BOARD_IDS.enabledLedger, BOARD_IDS.enabledFile, BOARD_IDS.enabledBare],
    majorities: [
      { amendment: BOARD_IDS.majority, since: since.majority },
      { amendment: BOARD_IDS.majorityNameless, since: since.majorityNameless },
    ],
  };
  await insertState(ch, [
    { ledger_index: HEAD_LEDGER - 600, polled_at: now - 700, amendments: [BOARD_IDS.enabledFile], majorities: [] },
    { ledger_index: HEAD_LEDGER - 3, polled_at: now - 20.5, ...state },
  ]);

  // what the node says: the newer row of an amendment wins
  await insertFeatures(ch, [
    { amendment_id: BOARD_IDS.unknown, name: 'OldName', supported: 0, polled_at: now - 5000 },
    { amendment_id: BOARD_IDS.unknown, name: '', supported: 1, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.nodeOnly, name: 'NodeNamedOnly', supported: 1, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.obsoleteNode, name: 'NodeGone', supported: 0, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.unsupportedVoted, name: 'StillVoted', supported: 0, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.voting, name: BOARD_NAMES.voting, supported: 1, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.majority, name: BOARD_NAMES.majority, supported: 1, polled_at: now - 300 },
    { amendment_id: BOARD_IDS.enabledLedger, name: BOARD_NAMES.enabledLedger, supported: 1, polled_at: now - 300 },
  ]);

  // the indexed EnableAmendment transactions
  const enabledAt = { ledgerIndex: roundLedger(1) + 2, closeTime: roundClose(1) + 8 };
  const gotMajority = { ledgerIndex: 107_704_833, closeTime: since.majority + 5 };
  const transactions: SeedEnableAmendment[] = [
    { amendment: BOARD_IDS.majority, flags: 0x10000, ledgerIndex: 106_500_001, closeTime: now - 60 * DAY },
    { amendment: BOARD_IDS.majority, flags: 0x20000, ledgerIndex: 106_600_001, closeTime: now - 50 * DAY },
    { amendment: BOARD_IDS.majority, flags: 0x10000, ...gotMajority },
    { amendment: BOARD_IDS.enabledLedger, flags: 0x10000, ledgerIndex: 107_000_001, closeTime: now - 20 * DAY },
    // the plain enabling carries no flags
    { amendment: BOARD_IDS.enabledLedger, flags: 0, withoutFlags: true, ...enabledAt },
    // another amendment's: it must not show up in these
    { amendment: BOARD_IDS.voting, flags: 0x10000, ledgerIndex: 106_000_001, closeTime: now - 100 * DAY },
  ];
  await insertEnableAmendments(ch, transactions);

  // the rounds
  const v341 = serverVersion(3, 4, 1);
  const v340 = serverVersion(3, 4, 0);
  const versionOf = (m: FleetMember): string | null => {
    const unlIndex = unl.indexOf(m);
    if (unlIndex >= 0) return unlIndex < 30 ? v341 : unlIndex < 35 ? v340 : null;
    return m === others[0] ? v341 : m === others[1] ? serverVersion(3, 5, 0) : null;
  };
  const unlKeys = unl.map((m) => m.key);
  const base = Date.now();
  for (let round = 3; round >= 0; round--) {
    const column = 3 - round;
    const yesOf = (id: string): number => BOARD_YES[id]?.[column] ?? 0;
    const voting = (i: number): string[] => Object.keys(BOARD_YES).filter((id) => i < yesOf(id));
    await insertRound(ch, {
      ledgerIndex: roundLedger(round),
      closeTime: roundClose(round),
      version: base + column,
      unl: unlKeys,
      trusted: 35,
      observed: 35,
      tallies: Object.keys(BOARD_YES)
        .filter((id) => yesOf(id) > 0 || id === BOARD_IDS.majority || id === BOARD_IDS.majorityNameless)
        .map((id) => ({ id, yes: yesOf(id) })),
      votes: [
        // unl[5] is recorded under its signing key
        ...unl.slice(0, 35).map((m, i) => ({
          key: i === 5 ? m.ephemeral : m.key,
          amendments: voting(i),
          serverVersion: versionOf(m),
        })),
        {
          key: others[0].key,
          amendments: [BOARD_IDS.majority, BOARD_IDS.votedByOther],
          serverVersion: versionOf(others[0]),
        },
        { key: others[1].key, amendments: [], serverVersion: versionOf(others[1]) },
        { key: others[3].key, amendments: [BOARD_IDS.majority] },
      ],
    });
  }
  // ten days ago: no votes kept, two tallies; forty days ago: outside the 30-day window
  await insertRound(ch, {
    ledgerIndex: oldLedger,
    closeTime: oldClose,
    version: base,
    unl: unlKeys,
    trusted: 35,
    observed: 35,
    tallies: [{ id: BOARD_IDS.enabledLedger, yes: 20 }],
  });
  await insertRound(ch, {
    ledgerIndex: veryOldLedger,
    closeTime: now - 40 * DAY,
    version: base,
    unl: unlKeys,
    trusted: 35,
    observed: 35,
    tallies: [{ id: BOARD_IDS.voting, yes: 9 }],
    votes: [{ key: others[2].key, amendments: [BOARD_IDS.votedLongAgo] }],
  });

  return {
    now,
    unl,
    others,
    headClose,
    roundLedger,
    roundClose,
    oldLedger,
    oldClose,
    veryOldLedger,
    enabledAt,
    since,
    gotMajority,
    transactions,
    state,
  };
}

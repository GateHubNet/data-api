import { amendmentNeeded, compareTriples, NetworkProfile, parseVersionTriple } from '@gatehub/data-api-shared';
import { compact, fmtTime } from '../common/format';
import {
  AMENDMENT_STATUSES,
  AmendmentsAssembly,
  AmendmentStatus,
  AmendmentView,
  HistoryEvent,
  RoundPoint,
} from './amendment-status';
import { compareEntries, Directory, DirectoryEntry, RecordRow } from './directory';
import { instant, nextFlagLedgerOf, ValidatorsSummary } from './summary-object';

/*
 * The objects `GET /v2/network/amendments[/{name}]` answers (spec 3.5, 3.6). Pure: keys in the order of the constants below,
 * a key with no value absent, never `null`. Times are `YYYY-MM-DDTHH:mm:ssZ` (the close of a ledger), the instants of receipt
 * `YYYY-MM-DDTHH:mm:ss.SSSZ`.
 */

/** The keys of `GET /v2/network/amendments`, in the order of the answer. */
export const AMENDMENTS_BODY_KEYS = [
  'result',
  'ledger_index',
  'rules',
  'round',
  'next_flag_ledger',
  'counts',
  'count',
  'amendments',
] as const;

/** The keys of `round`: the newest stored voting round, in order. */
export const ROUND_KEYS = ['ledger_index', 'date', 'unl_size', 'trusted', 'threshold', 'needed', 'observed'] as const;

/** The keys of an amendment of the list, in order. */
export const AMENDMENT_ROW_KEYS = [
  'id',
  'name',
  'status',
  'retired',
  'introduced',
  'xls',
  'xls_url',
  'description',
  'node_supported',
  'votes',
  'majority',
  'enabled',
] as const;

/** The keys of the `votes` of an amendment, in order. */
export const AMENDMENT_VOTES_KEYS = ['ledger_index', 'yes', 'trusted', 'needed', 'pct'] as const;

/** The keys of the `majority` of an amendment, in order. */
export const MAJORITY_KEYS = ['since', 'ledger_index', 'tx_hash', 'expected_activation'] as const;

/** The keys of the `enabled` of an amendment, in order. */
export const ENABLED_KEYS = ['ledger_index', 'date', 'tx_hash', 'source'] as const;

/** The keys of `GET /v2/network/amendments/{name}`, in the order of the answer. */
export const AMENDMENT_DETAIL_KEYS = [
  'ledger_index',
  'rules',
  'round',
  'next_flag_ledger',
  ...AMENDMENT_ROW_KEYS,
  'unl_votes',
  'other_votes',
  'rounds',
  'history',
  'result',
] as const;

/** The keys of a validator's vote, in order. */
export const UNL_VOTE_KEYS = [
  'validation_public_key',
  'domain',
  'vote',
  'version',
  'version_supports',
  'last_seen',
] as const;

/** The keys of a round of the `rounds` of an amendment, in order. */
export const ROUND_POINT_KEYS = [
  'ledger_index',
  'flag_ledger',
  'date',
  'yes',
  'trusted',
  'threshold',
  'passes',
] as const;

/** The keys of a `history` event, in order. */
export const HISTORY_KEYS = ['event', 'ledger_index', 'date', 'tx_hash'] as const;

export interface AmendmentsRules {
  threshold_percent: number;
  majority_hold_seconds: number;
  flag_interval: number;
}

export interface AmendmentRound {
  ledger_index: number;
  date: string;
  unl_size: number;
  trusted: number;
  threshold: number;
  needed: number;
  observed: number;
}

export interface AmendmentRow {
  id: string;
  name?: string;
  status: AmendmentStatus;
  retired?: true;
  introduced?: string;
  xls?: string;
  xls_url?: string;
  description?: string;
  node_supported?: boolean;
  votes?: { ledger_index: number; yes: number; trusted: number; needed: number; pct: number };
  majority?: { since: string; ledger_index?: number; tx_hash?: string; expected_activation: string };
  enabled?: { ledger_index?: number; date?: string; tx_hash?: string; source: 'ledger' | 'metadata' };
}

/** What the answers of both routes start with, ahead of their own keys (G3). */
export interface AmendmentsEnvelope {
  ledger_index?: number;
  rules: AmendmentsRules;
  round?: AmendmentRound;
  next_flag_ledger?: ValidatorsSummary['next_flag_ledger'];
}

export interface AmendmentsBody extends AmendmentsEnvelope {
  result: 'success';
  counts: Record<AmendmentStatus, number>;
  count: number;
  amendments: AmendmentRow[];
}

export interface UnlVote {
  validation_public_key: string;
  domain?: string;
  vote: 'yes' | 'no' | 'none';
  version?: string;
  version_supports?: boolean;
  last_seen?: string;
}

export interface AmendmentDetail extends AmendmentsEnvelope, AmendmentRow {
  unl_votes: UnlVote[];
  other_votes: UnlVote[];
  rounds: {
    ledger_index: number;
    flag_ledger: number;
    date: string;
    yes: number;
    trusted: number;
    threshold: number;
    passes: boolean;
  }[];
  history: { event: HistoryEvent['event']; ledger_index: number; date: string; tx_hash: string }[];
  result: 'success';
}

/** The values of the network that the answers state. */
export type AmendmentsProfile = Pick<
  NetworkProfile,
  'majorityHoldSeconds' | 'amendmentThresholdPercent' | 'flagInterval'
>;

// -- the envelope -------------------------------------------------------------------------------------------------------

/**
 * `ledger_index`, `rules`, `round` and `next_flag_ledger`: the same values in both answers, and the summary's for the ledger
 * and the flag ledger. The round is the newest stored one.
 */
export function envelopeOf(directory: Directory, profile: AmendmentsProfile): AmendmentsEnvelope {
  const { head, newestRound: round } = directory;
  return compact({
    ledger_index: head?.ledgerIndex,
    rules: {
      threshold_percent: profile.amendmentThresholdPercent,
      majority_hold_seconds: profile.majorityHoldSeconds,
      flag_interval: profile.flagInterval,
    },
    round:
      round === undefined
        ? undefined
        : {
            ledger_index: round.ledgerIndex,
            date: fmtTime(round.closeTime),
            unl_size: round.unlSize,
            trusted: round.trusted,
            threshold: round.threshold,
            needed: amendmentNeeded(round.trusted),
            observed: round.observed,
          },
    next_flag_ledger: nextFlagLedgerOf(head),
  });
}

// -- the amendment --------------------------------------------------------------------------------------------------------

/** One amendment of the list, with the keys of `AMENDMENT_ROW_KEYS` it has a value for. */
export function amendmentRow(view: AmendmentView): AmendmentRow {
  const { meta, votes, majority, enabled } = view;
  return compact({
    id: view.id,
    name: view.name,
    status: view.status,
    retired: view.retired,
    introduced: meta?.introduced,
    xls: meta?.xls,
    xls_url: meta?.xls_url,
    description: meta?.description,
    node_supported: view.nodeSupported,
    votes:
      votes === undefined
        ? undefined
        : {
            ledger_index: votes.ledgerIndex,
            yes: votes.yes,
            trusted: votes.trusted,
            needed: votes.needed,
            pct: votes.pct,
          },
    majority:
      majority === undefined
        ? undefined
        : compact({
            since: fmtTime(majority.since),
            ledger_index: majority.ledgerIndex,
            tx_hash: majority.txHash,
            expected_activation: fmtTime(majority.expectedActivation),
          }),
    enabled:
      enabled === undefined
        ? undefined
        : compact({
            ledger_index: enabled.ledgerIndex,
            date: enabled.date,
            tx_hash: enabled.txHash,
            source: enabled.source,
          }),
  });
}

/**
 * `GET /v2/network/amendments`: the envelope, the counts of every status, and the amendments of `statuses` (all of them
 * when it is empty) in list order.
 */
export function buildAmendmentsBody(
  assembly: AmendmentsAssembly,
  profile: AmendmentsProfile,
  statuses: readonly AmendmentStatus[] = [],
): AmendmentsBody {
  const wanted = statuses.length === 0 ? AMENDMENT_STATUSES : statuses;
  const rows = assembly.amendments.filter((each) => wanted.includes(each.status)).map(amendmentRow);
  return {
    result: 'success',
    ...envelopeOf(assembly.directory, profile),
    counts: { ...assembly.counts },
    count: rows.length,
    amendments: rows,
  };
}

// -- the votes of the validators -------------------------------------------------------------------------------------------------

type Triple = [number, number, number];

/** How a validator votes on an amendment by its record; `none` without one. */
function voteOf(record: RecordRow | undefined, id: string): UnlVote['vote'] {
  if (record === undefined) return 'none';
  return record.amendments.includes(id) ? 'yes' : 'no';
}

function memberOf(
  key: string,
  entry: DirectoryEntry | undefined,
  vote: UnlVote['vote'],
  introduced: Triple | undefined,
): UnlVote {
  const version = entry?.version;
  return compact({
    validation_public_key: key,
    domain: entry?.domain,
    vote,
    version: version?.version,
    version_supports:
      version === undefined || introduced === undefined ? undefined : compareTriples(version.triple, introduced) >= 0,
    last_seen: entry?.lastSeen === undefined ? undefined : instant(entry.lastSeen),
  });
}

/**
 * The votes of the trusted validators of the newest round (every member of its `unl`, as its counted record votes) and of
 * the validators off it that were seen in 24 hours and hold a record, both in the order of the validators list.
 */
function votesOfValidators(directory: Directory, view: AmendmentView): { unl: UnlVote[]; others: UnlVote[] } {
  const round = directory.newestRound;
  if (round === undefined) return { unl: [], others: [] };
  const parsed = view.meta?.introduced === undefined ? undefined : parseVersionTriple(view.meta.introduced);
  const members = new Set(round.unl);

  const unl = [...members]
    .map((key) => ({ key, entry: directory.entries.get(key) }))
    .sort((a, b) => compareEntries({ key: a.key, domain: a.entry?.domain }, { key: b.key, domain: b.entry?.domain }))
    .map(({ key, entry }) => memberOf(key, entry, voteOf(entry?.countedRecord, view.id), parsed));
  const others = directory.ordered
    .filter((entry) => !members.has(entry.key) && entry.seen24h && entry.record !== undefined)
    .map((entry) => memberOf(entry.key, entry, voteOf(entry.record, view.id), parsed));
  return { unl, others };
}

/**
 * `GET /v2/network/amendments/{name}`: the envelope of the list (G3), the amendment as the list has it, then the votes of the
 * validators, the rounds of the last 30 days (`rounds`, as `roundPoints` made them) and the history.
 */
export function buildAmendmentDetail(
  assembly: AmendmentsAssembly,
  profile: AmendmentsProfile,
  view: AmendmentView,
  rounds: readonly RoundPoint[],
): AmendmentDetail {
  const { unl, others } = votesOfValidators(assembly.directory, view);
  return {
    ...envelopeOf(assembly.directory, profile),
    ...amendmentRow(view),
    unl_votes: unl,
    other_votes: others,
    rounds: rounds.map((point) => ({
      ledger_index: point.ledgerIndex,
      flag_ledger: point.flagLedger,
      date: fmtTime(point.date),
      yes: point.yes,
      trusted: point.trusted,
      threshold: point.threshold,
      passes: point.passes,
    })),
    history: view.history.map((event) => ({
      event: event.event,
      ledger_index: event.ledgerIndex,
      date: fmtTime(event.date),
      tx_hash: event.txHash,
    })),
    result: 'success',
  };
}

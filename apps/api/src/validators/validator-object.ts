import { compact } from '../common/format';
import type { AgreementWindow } from './agreement-windows';
import type { AmendmentsAssembly, AmendmentStatus } from './amendment-status';
import type { DirectoryEntry, DomainState, ManifestInfo } from './directory';
import { instant, wholeUnits } from './summary-object';

/*
 * The objects `GET /v2/network/validators[/{key}]` answers (spec 3.2, 3.3). Pure: keys in the order of the constants below, a
 * key with no value absent, never `null`. Instants of receipt are `YYYY-MM-DDTHH:mm:ss.SSSZ`, amounts whole units as exact
 * decimal text. The directory is shared between requests: nothing here changes an entry, and the arrays of an answer are copies.
 */

/** The keys of `GET /v2/network/validators`, in the order of the answer. `marker` is there when more follow. */
export const LIST_BODY_KEYS = ['result', 'count', 'marker', 'validators'] as const;

/** The keys of a validator of the list, in order: the original's row first (spec 3.7), then the new ones. */
export const VALIDATOR_ROW_KEYS = [
  'validation_public_key',
  'domain',
  'current_index',
  'agreement_1h',
  'agreement_24h',
  'partial',
  'unl',
  'agreement_30d',
  'signing_key',
  'domain_verification',
  'unl_lists',
  'negative_unl',
  'version',
  'version_build',
  'version_latest',
  'server_version',
  'fee_vote',
  'amendment_votes',
  'first_seen',
  'last_seen',
] as const;

/** The keys of a window of agreement, in order. */
export const AGREEMENT_KEYS = ['missed', 'total', 'score', 'incomplete', 'partial'] as const;

/** The keys of `domain_verification`, in order. */
export const DOMAIN_VERIFICATION_KEYS = [
  'status',
  'reason',
  'status_code',
  'toml_url',
  'checked',
  'verified',
  'accounts',
] as const;

/** The keys of `fee_vote`, in order. */
export const FEE_VOTE_KEYS = ['ledger_index', 'base_fee', 'reserve_base', 'reserve_inc'] as const;

/** The keys of `amendment_votes` on a row of the list, in order. */
export const ROW_AMENDMENT_VOTES_KEYS = ['ledger_index', 'yes'] as const;

/** The keys of an entry of `amendment_votes.yes`, in order. */
export const YES_ENTRY_KEYS = ['id', 'name'] as const;

/** The keys of `amendment_votes` on the answer for one validator, in order. */
export const DETAIL_AMENDMENT_VOTES_KEYS = ['ledger_index', 'yes', 'votes'] as const;

/** The keys of an entry of `amendment_votes.votes`, in order. */
export const VOTE_ENTRY_KEYS = ['id', 'name', 'status', 'vote'] as const;

/** The keys of the answer for one validator after the row's, in order. */
export const DETAIL_TAIL_KEYS = ['manifest', 'daily_agreement', 'result'] as const;

/** The keys of `manifest`, in order. */
export const MANIFEST_KEYS = ['sequence', 'signing_key', 'signing_keys_seen', 'domain'] as const;

/** The keys of a day of `daily_agreement`, in order. */
export const DAILY_KEYS = ['date', 'missed', 'total', 'score', 'incomplete', 'partial'] as const;

export interface AgreementObject {
  missed: number;
  total: number;
  score?: string;
  incomplete: boolean;
  partial: number;
}

export interface DomainVerification {
  status: DomainState['status'];
  reason?: string;
  status_code?: number;
  toml_url: string;
  checked?: string;
  verified?: string;
  accounts?: string[];
}

export interface FeeVote {
  ledger_index: number;
  base_fee: string;
  reserve_base: string;
  reserve_inc: string;
}

export interface YesEntry {
  id: string;
  name?: string;
}

export interface VoteEntry {
  id: string;
  name?: string;
  status: AmendmentStatus;
  vote: 'yes' | 'no' | 'none';
}

/** `amendment_votes` of a row of the list: the amendments the record votes yes for. */
export interface RowAmendmentVotes {
  ledger_index: number;
  yes: YesEntry[];
}

/** `amendment_votes` of the answer for one validator: the same, and a vote for every amendment being decided. */
export interface DetailAmendmentVotes {
  /** Absent for a validator with no record. */
  ledger_index?: number;
  yes: YesEntry[];
  votes: VoteEntry[];
}

export interface ValidatorRow {
  validation_public_key: string;
  domain?: string;
  current_index?: number;
  agreement_1h: AgreementObject;
  agreement_24h: AgreementObject;
  partial?: boolean;
  unl: boolean;
  agreement_30d: AgreementObject;
  signing_key?: string;
  domain_verification?: DomainVerification;
  unl_lists: string[];
  negative_unl: boolean;
  version?: string;
  version_build?: number;
  version_latest?: boolean;
  server_version?: string;
  fee_vote?: FeeVote;
  amendment_votes?: RowAmendmentVotes;
  first_seen?: string;
  last_seen?: string;
}

export interface ManifestObject {
  sequence: number;
  signing_key?: string;
  signing_keys_seen: number;
  domain?: string;
}

export interface DailyObject extends AgreementObject {
  date: string;
}

export interface ValidatorsBody {
  result: 'success';
  count: number;
  marker?: string;
  validators: ValidatorRow[];
}

export interface ValidatorDetail extends Omit<ValidatorRow, 'amendment_votes'> {
  amendment_votes: DetailAmendmentVotes;
  manifest?: ManifestObject;
  daily_agreement: DailyObject[];
  result: 'success';
}

/** What the answers need of the amendments: the name of an ID, and for the detail the list in its order. */
export type NamedAmendments = Pick<AmendmentsAssembly, 'byId'>;
export type ListedAmendments = Pick<AmendmentsAssembly, 'amendments' | 'byId'>;

/** The statuses of the amendments a validator still votes on (spec 3.3, G4: an unknown one is voted on too). */
const DECIDED: readonly AmendmentStatus[] = ['voting', 'majority', 'unknown'];

// -- the parts of a row ---------------------------------------------------------------------------------------------------

const agreementOf = (window: AgreementWindow): AgreementObject =>
  compact({
    missed: window.missed,
    total: window.total,
    score: window.score,
    incomplete: window.incomplete,
    partial: window.partial,
  });

/**
 * The verification of a domain (spec 3.2). A domain not yet checked (`pending`) has neither `checked` nor `verified`;
 * `reason` belongs to `unverified`, `status_code` to its `http_status`, and `accounts` to a domain that `verified`, last.
 */
function verificationOf(state: DomainState): DomainVerification {
  const unverified = state.status === 'unverified';
  const checked = state.status !== 'pending';
  return compact({
    status: state.status,
    reason: unverified ? state.reason : undefined,
    status_code: unverified && state.reason === 'http_status' ? state.statusCode : undefined,
    toml_url: state.tomlUrl,
    checked: checked && state.checked !== undefined ? instant(state.checked) : undefined,
    verified: checked && state.verified !== undefined ? instant(state.verified) : undefined,
    accounts:
      state.status === 'verified' && (state.accounts?.length ?? 0) > 0 ? [...(state.accounts ?? [])] : undefined,
  });
}

/** The fee vote of the record: its ledger, and whole units, the fields the validation left out being those in force then. */
function feeVoteOf(entry: DirectoryEntry): FeeVote | undefined {
  const { record, recordFees: fees } = entry;
  if (record === undefined || fees === undefined) return undefined;
  return {
    ledger_index: record.ledger_index,
    base_fee: wholeUnits(fees.base_fee),
    reserve_base: wholeUnits(fees.reserve_base),
    reserve_inc: wholeUnits(fees.reserve_inc),
  };
}

/** The amendments a record votes yes for, in its order, the ID in upper case and the name where one is known. */
function yesOf(entry: DirectoryEntry, amendments: NamedAmendments): YesEntry[] {
  return (entry.record?.amendments ?? []).map((raw) => {
    const id = raw.toUpperCase();
    return compact({ id, name: amendments.byId.get(id)?.name });
  });
}

const manifestOf = (manifest: ManifestInfo): ManifestObject =>
  compact({
    sequence: manifest.sequence,
    signing_key: manifest.signingKey,
    signing_keys_seen: manifest.signingKeysSeen,
    domain: manifest.domain,
  });

/** A row, whose `amendment_votes` the list and the detail make differently. */
type RowWith<V> = Omit<ValidatorRow, 'amendment_votes'> & { amendment_votes?: V };

/** The row of a validator. `votes` is its `amendment_votes`, which stands in the row where the specification puts it. */
function rowOf<V>(entry: DirectoryEntry, votes: V | undefined): RowWith<V> {
  return compact({
    validation_public_key: entry.key,
    domain: entry.domain,
    current_index: entry.currentIndex,
    agreement_1h: agreementOf(entry.agreement1h),
    agreement_24h: agreementOf(entry.agreement24h),
    partial: entry.partial,
    unl: entry.unl,
    agreement_30d: agreementOf(entry.agreement30d),
    signing_key: entry.signingKey,
    domain_verification: entry.domainState === undefined ? undefined : verificationOf(entry.domainState),
    unl_lists: [...entry.unlLists],
    negative_unl: entry.negativeUnl,
    version: entry.version?.version,
    version_build: entry.version?.build,
    version_latest: entry.version === undefined ? undefined : entry.versionLatest,
    server_version: entry.serverVersion,
    fee_vote: feeVoteOf(entry),
    amendment_votes: votes,
    first_seen: entry.firstSeen === undefined ? undefined : instant(entry.firstSeen),
    last_seen: entry.lastSeen === undefined ? undefined : instant(entry.lastSeen),
  });
}

// -- the answers --------------------------------------------------------------------------------------------------------------

/** A validator of the list (spec 3.2). `amendment_votes` is absent without a record. */
export function validatorRow(entry: DirectoryEntry, amendments: NamedAmendments): ValidatorRow {
  const record = entry.record;
  return rowOf<RowAmendmentVotes>(
    entry,
    record === undefined ? undefined : { ledger_index: record.ledger_index, yes: yesOf(entry, amendments) },
  );
}

/** The body of the list: the rows of a page and the marker of the next one. */
export function buildValidatorsBody(
  rows: readonly DirectoryEntry[],
  marker: string | undefined,
  amendments: NamedAmendments,
): ValidatorsBody {
  return compact({
    result: 'success' as const,
    count: rows.length,
    marker,
    validators: rows.map((entry) => validatorRow(entry, amendments)),
  });
}

/**
 * The answer for one validator (spec 3.3): the row with `amendment_votes` always there, and holding a vote on every amendment
 * still being decided; then its manifest, its 30 days of agreement and the result.
 */
export function validatorDetail(entry: DirectoryEntry, amendments: ListedAmendments): ValidatorDetail {
  const record = entry.record;
  const yes = yesOf(entry, amendments);
  const voted = new Set(yes.map((each) => each.id));
  const votes = amendments.amendments
    .filter((each) => DECIDED.includes(each.status))
    .map(
      (each): VoteEntry =>
        compact({
          id: each.id,
          name: each.name,
          status: each.status,
          vote: record === undefined ? ('none' as const) : voted.has(each.id) ? ('yes' as const) : ('no' as const),
        }),
    );
  const amendmentVotes: DetailAmendmentVotes = compact({ ledger_index: record?.ledger_index, yes, votes });

  return {
    // the row has `amendment_votes` in its place already: naming it again keeps the place and drops the `undefined`
    ...rowOf(entry, amendmentVotes),
    amendment_votes: amendmentVotes,
    ...(entry.manifest !== undefined && { manifest: manifestOf(entry.manifest) }),
    daily_agreement: entry.daily.map(
      (day): DailyObject =>
        compact({
          date: day.date,
          missed: day.missed,
          total: day.total,
          score: day.score,
          incomplete: day.incomplete,
          partial: day.partial,
        }),
    ),
    result: 'success',
  };
}

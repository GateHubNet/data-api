import { compareVersions, nextFlagLedger, ServerVersion } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { compact, fmtMillis, fmtTime } from '../common/format';
import { Directory, DirectoryEntry, Drops, PublisherState } from './directory';

/** The keys of `GET /v2/network/validators/summary`, in the order of the answer. A key without a value is left out. */
export const SUMMARY_KEYS = [
  'result',
  'ledger_index',
  'close_time',
  'validators',
  'unl',
  'quorum',
  'negative_unl',
  'negative_unl_pending',
  'fees',
  'next_flag_ledger',
  'latest_version',
  'versions',
  'versions_unknown',
  'agreement_through',
  'votes_through_ledger',
  'updated',
] as const;

/** The keys of a publisher of the summary, in order. */
export const PUBLISHER_KEYS = [
  'id',
  'url',
  'public_key',
  'status',
  'sequence',
  'version',
  'expiration',
  'fetched',
  'validators',
  'seen_24h',
  'last_error',
  'last_error_at',
] as const;

export interface SummaryPublisher {
  id: string;
  url: string;
  public_key: string;
  status: 'ok' | 'expired' | 'unavailable';
  sequence?: number;
  version?: number;
  expiration?: string;
  fetched?: string;
  validators?: number;
  seen_24h?: number;
  last_error?: string;
  last_error_at?: string;
}

export interface ValidatorsSummary {
  result: 'success';
  ledger_index?: number;
  close_time?: string;
  validators: { seen_24h: number; unl_seen_24h: number; others_seen_24h: number; all: number };
  unl: { trusted: number; threshold?: number; publishers: SummaryPublisher[] };
  quorum: { value: number; unl_size: number; negative_unl: number; node?: number };
  negative_unl: { validation_public_key: string; first_ledger: number }[];
  negative_unl_pending?: { to_disable?: string; to_reenable?: string };
  fees?: { base_fee: string; reserve_base: string; reserve_inc: string };
  next_flag_ledger?: { ledger_index: number; voting_ledger: number; expected?: string };
  latest_version?: string;
  versions: { version: string; unl: number; all: number }[];
  versions_unknown: { unl: number; all: number };
  agreement_through?: string;
  votes_through_ledger?: number;
  updated: string;
}

/** Drops (text) as whole native units, exact decimal text: `10` is `"0.00001"`, `1000000` is `"1"`, `200000` is `"0.2"`. */
function wholeUnits(drops: string): string {
  return new BigNumber(drops).shiftedBy(-6).toFixed();
}

const feesOf = (drops: Drops): NonNullable<ValidatorsSummary['fees']> => ({
  base_fee: wholeUnits(drops.base_fee),
  reserve_base: wholeUnits(drops.reserve_base),
  reserve_inc: wholeUnits(drops.reserve_inc),
});

/** An instant of receipt, `YYYY-MM-DDTHH:mm:ss.SSSZ`, from unix seconds with a fraction (cut to the millisecond, not floored). */
export const instant = (seconds: number): string => fmtMillis(new Date(Math.round(seconds * 1000)));

function publisherOf(state: PublisherState): SummaryPublisher {
  const list = state.list;
  return compact({
    id: state.id,
    url: state.url,
    public_key: state.publicKey,
    status: state.status,
    sequence: list?.sequence,
    version: list?.version,
    expiration: list === undefined ? undefined : fmtTime(list.expiration),
    fetched: list === undefined ? undefined : instant(list.fetchedAt),
    validators: list === undefined ? undefined : new Set(list.validators).size,
    seen_24h: state.seen24h,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt === undefined ? undefined : instant(state.lastErrorAt),
  });
}

/**
 * When the next flag ledger is expected: the close time of the head plus (flag - ledger) x seconds / ledgers of the last 1,000
 * ledgers (the mean interval), in whole seconds. All in whole numbers: the product is divided exactly and rounded half up to the
 * second (the time of a ledger has no fraction, and `.5` goes up).
 */
function expectedFlagTime(head: NonNullable<Directory['head']>, flag: number): string | undefined {
  const { closeTime, spanSeconds, spanLedgers } = head;
  if (closeTime === undefined || spanSeconds === undefined || spanLedgers === undefined || spanLedgers <= 0) {
    return undefined;
  }
  const numerator = new BigNumber(flag - head.ledgerIndex).times(spanSeconds);
  const wait = numerator.idiv(spanLedgers);
  const remainder = numerator.minus(wait.times(spanLedgers));
  const seconds = remainder.times(2).gte(spanLedgers) ? wait.plus(1) : wait;
  return fmtTime(closeTime + seconds.toNumber());
}

/**
 * The next flag ledger after the head, the voting ledger before it, and when it is expected (the amendment routes state the
 * same figures as the summary); nothing without a head.
 */
export function nextFlagLedgerOf(head: Directory['head']): ValidatorsSummary['next_flag_ledger'] {
  if (head === undefined) return undefined;
  const flag = nextFlagLedger(head.ledgerIndex);
  return compact({ ledger_index: flag, voting_ledger: flag - 1, expected: expectedFlagTime(head, flag) });
}

/**
 * The summary of the validator directory (spec 3.1): the figures of the board's header. Pure; keys in the order of
 * `SUMMARY_KEYS`, a key with no value absent, never `null`.
 */
export function buildSummary(directory: Directory): ValidatorsSummary {
  const entries = [...directory.entries.values()];
  const seen = entries.filter((entry) => entry.seen24h);
  const unlSeen = seen.filter((entry) => entry.unl).length;
  const { head, state, newestRound } = directory;

  // the versions of the trusted validators (`unl`) and of those seen in 24 h (`all`), newest first
  const byVersion = new Map<string, { version: ServerVersion; unl: number; all: number }>();
  const unknown = { unl: 0, all: 0 };
  const count = (list: readonly DirectoryEntry[], field: 'unl' | 'all') => {
    for (const entry of list) {
      if (entry.version === undefined) {
        unknown[field] += 1;
        continue;
      }
      const row = byVersion.get(entry.version.version) ?? { version: entry.version, unl: 0, all: 0 };
      row[field] += 1;
      byVersion.set(entry.version.version, row);
    }
  };
  count(
    entries.filter((entry) => entry.unl),
    'unl',
  );
  count(seen, 'all');

  const pending = compact({ to_disable: state?.toDisable, to_reenable: state?.toReenable });
  const fees = state?.fees ?? newestRound?.fees;

  const summary: ValidatorsSummary = {
    result: 'success',
    ledger_index: head?.ledgerIndex,
    close_time: head?.closeTime === undefined ? undefined : fmtTime(head.closeTime),
    validators: {
      seen_24h: seen.length,
      unl_seen_24h: unlSeen,
      others_seen_24h: seen.length - unlSeen,
      all: directory.trusted.size + seen.length - unlSeen,
    },
    unl: compact({
      trusted: directory.trusted.size,
      threshold: directory.threshold,
      publishers: directory.publishers.map(publisherOf),
    }),
    quorum: compact({
      value: directory.quorum.value,
      unl_size: directory.quorum.unlSize,
      negative_unl: directory.quorum.negativeOnUnl,
      node: directory.quorum.node,
    }),
    negative_unl: (state?.negativeUnl ?? []).map((member) => ({
      validation_public_key: member.key,
      first_ledger: member.firstLedger,
    })),
    negative_unl_pending: Object.keys(pending).length === 0 ? undefined : pending,
    fees: fees === undefined ? undefined : feesOf(fees),
    next_flag_ledger: nextFlagLedgerOf(head),
    latest_version: directory.latest?.version,
    versions: [...byVersion.values()]
      .sort((a, b) => compareVersions(a.version, b.version))
      .map((row) => ({ version: row.version.version, unl: row.unl, all: row.all })),
    versions_unknown: unknown,
    agreement_through: directory.newestFinalHour === undefined ? undefined : fmtTime(directory.newestFinalHour + 3600),
    votes_through_ledger: newestRound?.ledgerIndex,
    updated: instant(directory.builtAt / 1000),
  };
  return compact(summary);
}

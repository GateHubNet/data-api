import { AmendmentMeta, AmendmentsConfig, amendmentNeeded, amendmentPasses } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { compact, fmtTime } from '../common/format';
import { Directory } from './directory';

/*
 * What the amendments routes tell of an amendment (spec 2.7, 3.5): its status, the votes of the newest round, the majority
 * or enabling it is at, and its history. Pure: `AmendmentsService` reads the sources, this turns them into the list. The
 * assembly is shared by every request of 10 s, so everything in it is read-only.
 */

export const AMENDMENT_STATUSES = ['enabled', 'majority', 'voting', 'obsolete', 'unknown'] as const;
export type AmendmentStatus = (typeof AMENDMENT_STATUSES)[number];

/** The words of the `status` parameter: a comma list of statuses, none (or an empty parameter) for all. `undefined` if invalid. */
export function parseStatuses(raw: string | undefined): AmendmentStatus[] | undefined {
  if (raw === undefined || raw === '') return [];
  const words = raw.split(',').map((word) => word.trim());
  const statuses = words.filter((word): word is AmendmentStatus =>
    (AMENDMENT_STATUSES as readonly string[]).includes(word),
  );
  return statuses.length === words.length ? statuses : undefined;
}

/** What the node says of an amendment (`amendment_features`): its name, `''` when it does not know it, and whether it supports it. */
export interface NodeFeature {
  readonly name: string;
  readonly supported: boolean;
}

const TF_GOT_MAJORITY = 0x00010000;
const TF_LOST_MAJORITY = 0x00020000;

export type EnableEventKind = 'got_majority' | 'lost_majority' | 'enabled';

/** What an `EnableAmendment` with these flags did; `undefined` for flags the network does not use for it. */
export function eventOfFlags(flags: number): EnableEventKind | undefined {
  if (flags === 0) return 'enabled';
  if ((flags & TF_GOT_MAJORITY) !== 0) return 'got_majority';
  if ((flags & TF_LOST_MAJORITY) !== 0) return 'lost_majority';
  return undefined;
}

/** An indexed `EnableAmendment` transaction, as read. `date` is the close time of its ledger (unix seconds). */
export interface EnableTx {
  amendment: string;
  flags: number;
  ledgerIndex: number;
  date: number;
  txHash: string;
}

export interface HistoryEvent {
  readonly event: EnableEventKind;
  readonly ledgerIndex: number;
  /** Unix seconds. */
  readonly date: number;
  readonly txHash: string;
}

// -- the status -------------------------------------------------------------------------------------------------------

export interface StatusFacts {
  /** In `Amendments` of the newest ledger state. */
  inLedger: boolean;
  /** In `Majorities` of the newest ledger state. */
  inMajorities: boolean;
  meta?: Pick<AmendmentMeta, 'obsolete' | 'retired'>;
  feature?: NodeFeature;
  /** The yes votes of the UNL in the newest round (0 without a tally row). */
  yes: number;
  /** Voted for by any validator in the last 30 days. */
  voted: boolean;
}

/**
 * The status, the first rule that matches (spec 2.7): enabled (in the ledger, or retired in the file); majority; obsolete
 * (flagged in the file, or the node does not support it and no UNL validator votes yes in the newest round); voting (named
 * by the node or the file, or voted for in the last 30 days); unknown.
 */
export function amendmentStatus(facts: StatusFacts): AmendmentStatus {
  const { meta, feature } = facts;
  if (facts.inLedger || meta?.retired === true) return 'enabled';
  if (facts.inMajorities) return 'majority';
  if (meta?.obsolete === true || (feature?.supported === false && facts.yes === 0)) return 'obsolete';
  if (meta !== undefined || (feature !== undefined && feature.name !== '') || facts.voted) return 'voting';
  return 'unknown';
}

// -- the votes ---------------------------------------------------------------------------------------------------------

/**
 * yes / trusted as a percentage, two decimals, half up; 0 when nobody is trusted. In whole numbers: the product is divided
 * exactly and the remainder decides the last digit, so no floating point reaches the figure.
 */
export function pctOf(yes: number, trusted: number): number {
  if (trusted <= 0) return 0;
  const scaled = new BigNumber(yes).times(10_000);
  const hundredths = scaled.idiv(trusted);
  const remainder = scaled.minus(hundredths.times(trusted));
  return (remainder.times(2).gte(trusted) ? hundredths.plus(1) : hundredths).shiftedBy(-2).toNumber();
}

export interface AmendmentVotes {
  readonly ledgerIndex: number;
  readonly yes: number;
  readonly trusted: number;
  readonly needed: number;
  readonly pct: number;
}

// -- the amendment -----------------------------------------------------------------------------------------------------

export interface AmendmentView {
  readonly id: string;
  readonly name?: string;
  readonly status: AmendmentStatus;
  /** Xahau: behaviour that is always on although the ledger does not list the amendment. */
  readonly retired?: true;
  readonly meta?: Readonly<AmendmentMeta>;
  /** The node's `supported`, when it lists the amendment. */
  readonly nodeSupported?: boolean;
  /** From the newest round, for a majority, voting or unknown amendment, when a round is stored. */
  readonly votes?: AmendmentVotes;
  readonly majority?: {
    /** The close time in `Majorities` (unix seconds). */
    readonly since: number;
    readonly ledgerIndex?: number;
    readonly txHash?: string;
    /** since + the hold of the network. */
    readonly expectedActivation: number;
  };
  readonly enabled?: {
    readonly ledgerIndex?: number;
    /** `YYYY-MM-DDTHH:mm:ssZ` of an indexed transaction, the file's `YYYY-MM-DD`; absent when the file gives only a ledger. */
    readonly date?: string;
    readonly txHash?: string;
    readonly source: 'ledger' | 'metadata';
  };
  /** Every indexed `EnableAmendment` of the amendment, oldest first. */
  readonly history: readonly HistoryEvent[];
}

export interface AmendmentsAssembly {
  /** In list order. */
  readonly amendments: readonly AmendmentView[];
  readonly byId: ReadonlyMap<string, AmendmentView>;
  /** Over all the amendments, whatever a request filters. */
  readonly counts: Readonly<Record<AmendmentStatus, number>>;
  /** The directory the assembly was built on: the envelope and the validators' votes come from it. */
  readonly directory: Directory;
}

export interface AmendmentSources {
  /** The metadata file. */
  config: AmendmentsConfig;
  /** What the node says, by amendment ID. */
  features: ReadonlyMap<string, NodeFeature>;
  /** Every ID in a vote of the last 30 days (any validator, upper-case). */
  voted: ReadonlySet<string>;
  /** The yes votes of the UNL in the newest round, by amendment ID. */
  yes: ReadonlyMap<string, number>;
  /** The `EnableAmendment` transactions indexed, in any order. */
  transactions: readonly EnableTx[];
  /** How long a majority must hold (the network profile). */
  majorityHoldSeconds: number;
}

/**
 * The one rule for the case of an ID: upper case (the form amendment IDs have, Global Constraints), whatever a source wrote.
 * Every ID that comes in from a read (the ledger state, the node, the votes, the tallies, the index) goes through it, so that
 * nothing depends on the case the writer used.
 */
const upper = (id: string): string => id.toUpperCase();

/** A map by ID with its keys in upper case; the values of two keys that become one are merged. */
function byUpperId<T>(entries: ReadonlyMap<string, T>, merge: (a: T, b: T) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const [id, value] of entries) {
    const key = upper(id);
    const known = out.get(key);
    out.set(key, known === undefined ? value : merge(known, value));
  }
  return out;
}

/** Every amendment ID the routes know of (spec 2.7): the ledger state, the node, the file and the votes of 30 days. Upper case. */
export function amendmentIds(
  directory: Directory,
  sources: Pick<AmendmentSources, 'config' | 'features' | 'voted'>,
): string[] {
  const state = directory.state;
  return [
    ...new Set(
      [
        ...(state?.amendments ?? []),
        ...(state?.majorities ?? []).map((majority) => majority.amendment),
        ...sources.features.keys(),
        ...sources.config.byId.keys(),
        ...sources.voted,
      ].map(upper),
    ),
  ];
}

/** The indexed transactions of each amendment as events, oldest first; a transaction read twice counts once. */
function historyByAmendment(transactions: readonly EnableTx[]): Map<string, HistoryEvent[]> {
  const byAmendment = new Map<string, HistoryEvent[]>();
  const seen = new Set<string>();
  const ordered = transactions
    .map((tx, position) => ({ tx, position }))
    .sort((a, b) => a.tx.ledgerIndex - b.tx.ledgerIndex || a.position - b.position);
  for (const { tx } of ordered) {
    const event = eventOfFlags(tx.flags);
    const id = tx.amendment.toUpperCase();
    const key = `${tx.ledgerIndex}:${tx.txHash}`;
    if (event === undefined || id === '' || seen.has(key)) continue;
    seen.add(key);
    byAmendment.set(id, [
      ...(byAmendment.get(id) ?? []),
      { event, ledgerIndex: tx.ledgerIndex, date: tx.date, txHash: tx.txHash },
    ]);
  }
  return byAmendment;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** By name without regard to case (then as written), a named amendment before an unnamed one, an unnamed one by its ID. */
function compareByName(a: AmendmentView, b: AmendmentView): number {
  if ((a.name === undefined) !== (b.name === undefined)) return a.name === undefined ? 1 : -1;
  if (a.name !== undefined && b.name !== undefined) {
    const byName = compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name);
    if (byName !== 0) return byName;
  }
  return compareText(a.id, b.id);
}

/** The groups of the list in order, each with the order inside it (spec 3.5). */
const GROUPS: readonly { status: AmendmentStatus; compare: (a: AmendmentView, b: AmendmentView) => number }[] = [
  {
    status: 'majority',
    compare: (a, b) =>
      (a.majority?.expectedActivation ?? 0) - (b.majority?.expectedActivation ?? 0) || compareByName(a, b),
  },
  { status: 'voting', compare: (a, b) => (b.votes?.yes ?? 0) - (a.votes?.yes ?? 0) || compareByName(a, b) },
  { status: 'unknown', compare: (a, b) => compareText(a.id, b.id) },
  {
    status: 'enabled',
    compare: (a, b) => {
      const [ledgerA, ledgerB] = [a.enabled?.ledgerIndex, b.enabled?.ledgerIndex];
      if ((ledgerA === undefined) !== (ledgerB === undefined)) return ledgerA === undefined ? 1 : -1;
      if (ledgerA !== undefined && ledgerB !== undefined && ledgerA !== ledgerB) return ledgerB - ledgerA;
      return compareByName(a, b);
    },
  },
  { status: 'obsolete', compare: compareByName },
];

/**
 * Builds the amendments from the directory (the newest ledger state and the newest round) and the other sources. The list
 * is in the order of spec 3.5: the groups majority, voting, unknown, enabled, obsolete; inside a group by expected
 * activation, by yes, by ID, by the ledger it was enabled in (newest first) and by name.
 */
export function assembleAmendments(directory: Directory, sources: AmendmentSources): AmendmentsAssembly {
  const { config, majorityHoldSeconds } = sources;
  const round = directory.newestRound;
  const inLedger = new Set((directory.state?.amendments ?? []).map(upper));
  const since = new Map(
    (directory.state?.majorities ?? []).map((majority) => [upper(majority.amendment), majority.since]),
  );
  const features = byUpperId(sources.features, (a, b) => (a.name !== '' ? a : b));
  const voted = new Set([...sources.voted].map(upper));
  const yes = byUpperId(sources.yes, Math.max);
  const history = historyByAmendment(sources.transactions);

  const view = (id: string): AmendmentView => {
    const meta = config.byId.get(id);
    const feature = features.get(id);
    const yesVotes = yes.get(id) ?? 0;
    const status = amendmentStatus({
      inLedger: inLedger.has(id),
      inMajorities: since.has(id),
      meta,
      feature,
      yes: yesVotes,
      voted: voted.has(id),
    });
    const events = history.get(id) ?? [];
    const lastOf = (kind: EnableEventKind): HistoryEvent | undefined => events.filter((e) => e.event === kind).pop();

    let majority: AmendmentView['majority'];
    if (status === 'majority') {
      const majoritySince = since.get(id) as number;
      // the transaction behind this majority is the newest got_majority, unless a lost_majority or an enabling came after it:
      // then the majority now was regained and its transaction is not indexed yet (G5)
      const got = lastOf('got_majority');
      const regained =
        got !== undefined && events.slice(events.lastIndexOf(got) + 1).some((e) => e.event !== 'got_majority');
      majority = compact({
        since: majoritySince,
        ledgerIndex: regained ? undefined : got?.ledgerIndex,
        txHash: regained ? undefined : got?.txHash,
        expectedActivation: majoritySince + majorityHoldSeconds,
      });
    }

    let enabled: AmendmentView['enabled'];
    if (status === 'enabled') {
      const enabling = lastOf('enabled');
      if (enabling !== undefined) {
        enabled = {
          ledgerIndex: enabling.ledgerIndex,
          date: fmtTime(enabling.date),
          txHash: enabling.txHash,
          source: 'ledger',
        };
      } else if (meta?.enabled !== undefined && (meta.retired !== true || inLedger.has(id))) {
        // a retired name has an enabled object only when the ledger has one (spec 2.7)
        enabled = compact({
          ledgerIndex: meta.enabled.ledger_index,
          date: meta.enabled.date,
          source: 'metadata' as const,
        });
      }
    }

    return compact({
      id,
      name: meta?.name ?? (feature !== undefined && feature.name !== '' ? feature.name : undefined),
      status,
      retired: meta?.retired === true ? (true as const) : undefined,
      meta,
      nodeSupported: feature?.supported,
      votes:
        round === undefined || !(status === 'majority' || status === 'voting' || status === 'unknown')
          ? undefined
          : {
              ledgerIndex: round.ledgerIndex,
              yes: yesVotes,
              trusted: round.trusted,
              needed: amendmentNeeded(round.trusted),
              pct: pctOf(yesVotes, round.trusted),
            },
      majority,
      enabled,
      history: events,
    });
  };

  const views = amendmentIds(directory, sources).map(view);
  const counts = Object.fromEntries(AMENDMENT_STATUSES.map((status) => [status, 0])) as Record<AmendmentStatus, number>;
  for (const each of views) counts[each.status] += 1;

  const amendments = GROUPS.flatMap(({ status, compare }) =>
    views.filter((each) => each.status === status).sort(compare),
  );
  return { amendments, byId: new Map(amendments.map((each) => [each.id, each])), counts, directory };
}

/**
 * The amendment a request names (spec 3.6): a name as it is written; else a name in any case when only one amendment has it;
 * a 64-digit hex string is an ID in any case.
 */
export function findAmendment(
  assembly: Pick<AmendmentsAssembly, 'amendments' | 'byId'>,
  ref: string,
): AmendmentView | undefined {
  const exact = assembly.amendments.find((each) => each.name === ref);
  if (exact !== undefined) return exact;
  if (/^[0-9a-f]{64}$/i.test(ref)) return assembly.byId.get(ref.toUpperCase());
  const lower = ref.toLowerCase();
  const same = assembly.amendments.filter((each) => each.name?.toLowerCase() === lower);
  return same.length === 1 ? same[0] : undefined;
}

// -- the rounds of the window -----------------------------------------------------------------------------------------------

/** The window of the rounds of an amendment and of the votes of "the last 30 days", in days. */
export const WINDOW_DAYS = 30;

/** The fewest ledgers a window can reach back: no network closes more than one ledger a second. */
export function windowFloor(newestRound: number): number {
  return Math.max(0, newestRound - WINDOW_DAYS * 86_400);
}

/** A stored round: the newest version of its sentinel. */
export interface WindowRound {
  ledgerIndex: number;
  /** Unix seconds. */
  closeTime: number;
  trusted: number;
  threshold: number;
}

export interface RoundPoint {
  ledgerIndex: number;
  flagLedger: number;
  /** Unix seconds. */
  date: number;
  yes: number;
  trusted: number;
  threshold: number;
  passes: boolean;
}

/**
 * One point per round, oldest first: `yes` is the tally row's (0 for a round with none), `passes` whether that carries the
 * amendment. An enabled amendment has only the rounds before the ledger it was enabled in, and none when that ledger is not
 * known.
 */
export function roundPoints(
  rounds: readonly WindowRound[],
  yes: ReadonlyMap<number, number>,
  view: Pick<AmendmentView, 'status' | 'enabled'>,
): RoundPoint[] {
  let before = Number.POSITIVE_INFINITY;
  if (view.status === 'enabled') {
    if (view.enabled?.ledgerIndex === undefined) return [];
    before = view.enabled.ledgerIndex;
  }
  return [...rounds]
    .filter((round) => round.ledgerIndex < before)
    .sort((a, b) => a.ledgerIndex - b.ledgerIndex)
    .map((round) => {
      const yesVotes = yes.get(round.ledgerIndex) ?? 0;
      return {
        ledgerIndex: round.ledgerIndex,
        flagLedger: round.ledgerIndex + 1,
        date: round.closeTime,
        yes: yesVotes,
        trusted: round.trusted,
        threshold: round.threshold,
        passes: amendmentPasses(yesVotes, round.trusted),
      };
    });
}

import {
  AmendmentTalliesRow,
  amendmentThreshold,
  Fees,
  quorumOf,
  recordOf,
  RoundMembership,
  VoteRow,
} from '@gatehub/data-api-shared';

export interface TallyInput {
  /** The voting ledger V. */
  round: number;
  /** close(V), unix seconds. */
  closeTime: number;
  /** The votes of V: one row per validator that has a validation of the hash of V, keys mapped to master keys. */
  votes: readonly VoteRow[];
  /** The votes of the earlier rounds that closed no more than 24 h before V (of the newest version set of each). */
  history: readonly VoteRow[];
  /** Who was on the UNL and the negative UNL in each round of `history`. The entry of V itself is taken from `unl` and `negativeUnl`. */
  membership: ReadonlyMap<number, RoundMembership>;
  /** UNL(V). */
  unl: ReadonlySet<string>;
  /** nUNL(V). */
  negativeUnl: ReadonlySet<string>;
  /** The amendments in a majority in the newest ledger state: each has a row even with no vote. */
  majorities: readonly string[];
  /** The fees in force at V. */
  fees: Fees;
  /** The version of the whole set of the round. */
  version: number;
}

export interface TallyResult {
  /** The row of each amendment (by ID), then the sentinel. */
  tallies: AmendmentTalliesRow[];
  /** The validations a ledger needs to be fully validated with this UNL and negative UNL. */
  quorum: number;
  /** The UNL members with a full validation of the hash of V (the stored `observed`). */
  observed: number;
  /**
   * The same members less those on the negative UNL: what a ledger is validated with, since rippled discounts the validations of
   * the negative UNL. It is what is compared with `quorum`; `observed` is stored as it is.
   */
  counted: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (keys: ReadonlySet<string>): string[] => [...keys].sort(byText);

/** The validations a ledger needs to be fully validated with this UNL: the members of the negative UNL that are on it do not count. */
export function roundQuorum(unl: ReadonlySet<string>, negativeUnl: ReadonlySet<string>): number {
  return quorumOf(unl.size, [...negativeUnl].filter((key) => unl.has(key)).length);
}

/** The common columns of the rows of a round. */
function rowOf(
  i: { round: number; closeTime: number; version: number },
  amendmentId: string,
  yes: number,
  counts: { trusted: number; threshold: number; unlSize: number; observed: number },
  sentinel?: { unl: string[]; negativeUnl: string[]; fees: Fees },
): AmendmentTalliesRow {
  return {
    ledger_index: i.round,
    amendment_id: amendmentId,
    close_time: i.closeTime,
    yes,
    trusted: counts.trusted,
    threshold: counts.threshold,
    unl_size: counts.unlSize,
    observed: counts.observed,
    unl: sentinel?.unl ?? [],
    negative_unl: sentinel?.negativeUnl ?? [],
    base_fee: sentinel?.fees.base_fee ?? '0',
    reserve_base: sentinel?.fees.reserve_base ?? '0',
    reserve_inc: sentinel?.fees.reserve_inc ?? '0',
    version: i.version,
  };
}

/**
 * The `amendment_tallies` set of a round (spec 2.4 steps 4 and 5, F7): of each UNL member the vote record (`recordOf`: the
 * newest full validation of a round it was on the UNL of and off the negative UNL of, no older than 24 h), `trusted` the members
 * with a record, `yes` of an amendment the records that name it, `threshold` that of `trusted`, `observed` the members with a
 * full validation of this round, `quorum` what a ledger needs to be fully validated and `counted` the observed members that
 * count towards it (not on the negative UNL). One row per amendment that has a yes or is in
 * a majority, in the order of the IDs, and the sentinel (`amendment_id ''`: the UNL, the negative UNL and the fees) last.
 * The input is not changed.
 */
export function tallyRound(i: TallyInput): TallyResult {
  const membership = new Map(i.membership);
  membership.set(i.round, { unl: i.unl, negativeUnl: i.negativeUnl });

  const rowsOf = new Map<string, VoteRow[]>();
  for (const row of [...i.history, ...i.votes]) {
    if (!i.unl.has(row.validation_public_key)) continue;
    const rows = rowsOf.get(row.validation_public_key);
    if (rows) rows.push(row);
    else rowsOf.set(row.validation_public_key, [row]);
  }

  let trusted = 0;
  const yes = new Map<string, number>();
  for (const key of i.unl) {
    const record = recordOf(rowsOf.get(key) ?? [], i.round, i.closeTime, membership);
    if (record === undefined) continue;
    trusted++;
    for (const id of new Set(record.amendments)) yes.set(id, (yes.get(id) ?? 0) + 1);
  }

  const observers = new Set<string>();
  for (const row of i.votes)
    if (row.full === 1 && i.unl.has(row.validation_public_key)) observers.add(row.validation_public_key);
  const counted = [...observers].filter((key) => !i.negativeUnl.has(key)).length;

  const counts = { trusted, threshold: amendmentThreshold(trusted), unlSize: i.unl.size, observed: observers.size };
  const ids = [...new Set([...yes.keys(), ...i.majorities])].sort(byText);
  const tallies = ids.map((id) => rowOf(i, id, yes.get(id) ?? 0, counts));
  tallies.push(
    rowOf(i, '', 0, counts, { unl: sortedKeys(i.unl), negativeUnl: sortedKeys(i.negativeUnl), fees: i.fees }),
  );
  return { tallies, quorum: roundQuorum(i.unl, i.negativeUnl), observed: counts.observed, counted };
}

/**
 * The sentinel of a round the ingest lacks (spec 2.4): the UNL and the fees of the round, `observed 0`, `trusted 0`,
 * `threshold 1`; no amendment row and no vote row go with it. `closeTime` is that of the first ledger above the round.
 */
export function missingRound(i: {
  round: number;
  closeTime: number;
  unl: ReadonlySet<string>;
  negativeUnl: ReadonlySet<string>;
  fees: Fees;
  version: number;
}): AmendmentTalliesRow {
  const counts = { trusted: 0, threshold: amendmentThreshold(0), unlSize: i.unl.size, observed: 0 };
  return rowOf(i, '', 0, counts, { unl: sortedKeys(i.unl), negativeUnl: sortedKeys(i.negativeUnl), fees: i.fees });
}

const AMENDMENT_ID = /^[0-9A-Fa-f]{64}$/;

/**
 * The amendment IDs a validation votes for, from the JSON text the collector stored (`''` when it names none): upper case,
 * once each, in the order of the text. What is not a list of IDs gives none, and so does an entry that is not an ID: a
 * strange value in one validation must not stop the round it is in for ever.
 */
export function voteAmendmentsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = new Set<string>();
  for (const id of parsed) if (typeof id === 'string' && AMENDMENT_ID.test(id)) ids.add(id.toUpperCase());
  return [...ids];
}

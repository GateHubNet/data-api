import { ValidatorAgreementHourlyRow } from '@gatehub/data-api-shared';

/**
 * How long a validator that went quiet is still tracked, and so still misses the observed ledgers: while its `last_seen` is no
 * more than this before the end of the hour (spec 2.5, "a validator that goes quiet keeps collecting misses for a day").
 */
export const TRACK_CARRY_SECONDS = 86_400;

const HOUR_SECONDS = 3600;

/**
 * The ledgers missing around an hour, for `gaps`. `indices` are the ledger indices of the hour, sorted (a repeated index counts
 * once); `before` and `after` are the nearest committed ledger below the first and above the last, when there is one.
 *
 * The missing indices between the first and the last (spec 2.5: (last - first + 1) - |L(h)|), plus those between `before` and
 * the first, and between the last and `after`. An hour with no ledger counts the missing indices between `before` and `after`,
 * and none while one of them is unknown. The edges are a deliberate deviation from the spec's formula (ruling P10, ADR-0012): a
 * ledger missing at the border of two hours keeps both of them from being final, which the spec's formula would not.
 */
export function gapsOf(indices: readonly number[], before?: number, after?: number): number {
  const distinct = new Set(indices);
  if (distinct.size === 0) {
    return before === undefined || after === undefined ? 0 : Math.max(0, after - before - 1);
  }
  const first = indices[0];
  const last = indices[indices.length - 1];
  const inside = last - first + 1 - distinct.size;
  const atStart = before === undefined ? 0 : Math.max(0, first - before - 1);
  const atEnd = after === undefined ? 0 : Math.max(0, after - last - 1);
  return inside + atStart + atEnd;
}

/** What `agreementRows` needs of one UTC hour. Times are unix seconds. */
export interface HourAgreementInput {
  /** The start of the hour. */
  hour: number;
  /** |L(h)|: the ledgers of the hour in `ledgers` (distinct by index). */
  ledgers: number;
  /** The ledgers of the hour that are observed: full validations recorded from at least `quorum` members of the UNL. */
  observed: number;
  /** See `gapsOf`. */
  gaps: number;
  /** UNL(h). */
  unl: ReadonlySet<string>;
  /** quorum(h). */
  quorum: number;
  /** Per validator (master key), over the observed ledgers: those it fully validated and those it only partially did. */
  perKey: ReadonlyMap<string, { agreed: number; partialOnly: number }>;
  /** Per validator (master key), the newest receipt of a validation in the hour. */
  seenInHour: ReadonlyMap<string, number>;
  /**
   * The rows of the hour before, of the version its newest sentinel names (only the key and `last_seen` of a row are read; the
   * sentinel, with the key `''`, is ignored).
   */
  previous: readonly Pick<ValidatorAgreementHourlyRow, 'validation_public_key' | 'last_seen'>[];
  final: boolean;
  /** Wall-clock milliseconds, one for the whole hour. */
  version: number;
}

/**
 * The rows of an hour of `validator_agreement_hourly` (spec 2.5): a row per tracked validator, in the order of the keys, then
 * the hour's sentinel (`validation_public_key ''`) last.
 *
 * Tracked: the UNL of the hour, the validators with a validation received in it, and those of the hour before whose `last_seen` is
 * no more than `TRACK_CARRY_SECONDS` before the end of the hour. Per tracked validator, `agreed` and `partial` are the observed
 * ledgers it signed fully and only partially, `missed` is the rest of the observed ledgers (a partial one included), and
 * `last_seen` is the newest receipt known (this hour's, else the row before's, else 0 for a validator never seen). A ledger that
 * is not observed (fewer than quorum UNL validations recorded) is in the `unobserved` of the sentinel and in nobody's count.
 */
export function agreementRows(i: HourAgreementInput): ValidatorAgreementHourlyRow[] {
  const horizon = i.hour + HOUR_SECONDS - TRACK_CARRY_SECONDS;
  const carried = new Map<string, number>();
  for (const row of i.previous) {
    if (row.validation_public_key !== '') carried.set(row.validation_public_key, row.last_seen);
  }
  const tracked = new Set<string>(i.unl);
  for (const key of i.seenInHour.keys()) tracked.add(key);
  for (const [key, lastSeen] of carried) if (lastSeen >= horizon) tracked.add(key);

  const rows: ValidatorAgreementHourlyRow[] = [...tracked].sort().map((key) => {
    const counts = i.perKey.get(key);
    const agreed = counts?.agreed ?? 0;
    return {
      hour: i.hour,
      validation_public_key: key,
      agreed,
      missed: Math.max(0, i.observed - agreed),
      partial: counts?.partialOnly ?? 0,
      last_seen: Math.max(i.seenInHour.get(key) ?? 0, carried.get(key) ?? 0),
      ledgers: 0,
      unobserved: 0,
      gaps: 0,
      unl_size: 0,
      quorum: 0,
      final: 0,
      version: i.version,
    };
  });
  rows.push({
    hour: i.hour,
    validation_public_key: '',
    agreed: 0,
    missed: 0,
    partial: 0,
    last_seen: 0,
    ledgers: i.observed,
    unobserved: Math.max(0, i.ledgers - i.observed),
    gaps: i.gaps,
    unl_size: i.unl.size,
    quorum: i.quorum,
    final: i.final ? 1 : 0,
    version: i.version,
  });
  return rows;
}

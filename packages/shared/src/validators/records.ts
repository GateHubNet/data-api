/**
 * The fields of a `validator_votes` row that decide a vote record. `full` is 1 for a full validation and 0 for a
 * partial one; the fee fields are drops as decimal text, absent from a validation that did not change them.
 */
export interface VoteRow {
  ledger_index: number;
  validation_public_key: string;
  close_time: number;
  full: number;
  amendments: string[];
  base_fee: string | null;
  reserve_base: string | null;
  reserve_inc: string | null;
  server_version: string | null;
}

/** Who was on the UNL and on the negative UNL at a voting round. */
export interface RoundMembership {
  unl: ReadonlySet<string>;
  negativeUnl: ReadonlySet<string>;
}

/** A vote is remembered for 24 hours (F7). */
export const RECORD_LIFETIME_SECONDS = 86_400;

/**
 * The vote record of one validator for the round `roundLedger` that closed at `roundClose` (F7, spec 2.4 step 4): of
 * `rows` (all of one key), the one with the highest `ledger_index` that is a full validation, is not after the round
 * and closed no more than 24 hours before it. With `membership`, a row counts only when its own round has an entry
 * with the key on the UNL and off the negative UNL. A record with no amendments votes for none; no record is undefined.
 */
export function recordOf(
  rows: readonly VoteRow[],
  roundLedger: number,
  roundClose: number,
  membership?: ReadonlyMap<number, RoundMembership>,
): VoteRow | undefined {
  let record: VoteRow | undefined;
  for (const row of rows) {
    if (row.full !== 1 || row.ledger_index > roundLedger || row.close_time < roundClose - RECORD_LIFETIME_SECONDS) {
      continue;
    }
    if (record && row.ledger_index <= record.ledger_index) continue;
    if (membership) {
      const round = membership.get(row.ledger_index);
      if (!round || !round.unl.has(row.validation_public_key) || round.negativeUnl.has(row.validation_public_key)) {
        continue;
      }
    }
    record = row;
  }
  return record;
}

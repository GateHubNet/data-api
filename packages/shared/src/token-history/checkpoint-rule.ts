import { TOKEN_HISTORY_CHECKPOINT_FLOOR } from './constants';

/**
 * The checkpoint rule (spec 4.3): after a ledger L with changes of a token, the token gets a checkpoint at L when its changes since
 * its previous checkpoint (or since its first change) reach `max(trust lines after L, floor)`. A pure function of the history, so a
 * rebuild writes the same checkpoints; and a checkpoint of S lines comes only after at least S changes, so the checkpoints never
 * hold more rows than the change log.
 */

/** A ledger with changes of a token: how many, and the token's trust lines after it. */
export interface LedgerTotals {
  ledger_index: number;
  changes: number;
  trust_lines_after: number;
}

/**
 * The ledgers of `totals` (in ledger order, streamed) that get a checkpoint. `changesSinceStart` is the token's changes since its
 * previous checkpoint before the first of `totals` (since its first change when it has none), so a resumed run puts its checkpoints
 * where a whole one does.
 */
export function checkpointLedgers(
  totals: Iterable<LedgerTotals>,
  changesSinceStart: number,
  floor = TOKEN_HISTORY_CHECKPOINT_FLOOR,
): number[] {
  const ledgers: number[] = [];
  let since = changesSinceStart;
  for (const t of totals) {
    since += t.changes;
    if (since >= Math.max(t.trust_lines_after, floor)) {
      ledgers.push(t.ledger_index);
      since = 0;
    }
  }
  return ledgers;
}

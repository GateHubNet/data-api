import { seededRandom } from '../test-utils/token-history-cases';
import { checkpointLedgers, LedgerTotals } from './checkpoint-rule';
import { TOKEN_HISTORY_CHECKPOINT_FLOOR } from './constants';

/** A generated history of a token: ledgers with 1 to `maxChanges` changes, and trust lines that grow and shrink. */
function history(rnd: () => number, ledgers: number, maxChanges: number): LedgerTotals[] {
  const out: LedgerTotals[] = [];
  let lines = 0;
  let ledger = 1_000;
  for (let i = 0; i < ledgers; i++) {
    ledger += 1 + Math.floor(rnd() * 20);
    const changes = 1 + Math.floor(rnd() * maxChanges);
    lines = Math.max(0, lines + Math.floor(rnd() * changes) - Math.floor(rnd() * changes * 0.6));
    out.push({ ledger_index: ledger, changes, trust_lines_after: lines });
  }
  return out;
}

describe('checkpointLedgers', () => {
  it('checkpointLedgers is deterministic and writes no more checkpoint rows than changes', () => {
    const rnd = seededRandom(43);
    for (let h = 0; h < 50; h++) {
      const totals = history(rnd, 2_000, 300);
      const floor = 1 + Math.floor(rnd() * 2_000);
      const first = checkpointLedgers(totals, 0, floor);
      expect(checkpointLedgers(totals, 0, floor)).toEqual(first);
      // a generator gives the same as an array: the rule streams
      expect(checkpointLedgers((function* () {
        yield* totals;
      })(), 0, floor)).toEqual(first);
      const allChanges = totals.reduce((s, t) => s + t.changes, 0);
      const byLedger = new Map(totals.map((t) => [t.ledger_index, t]));
      const rows = first.reduce((s, l) => s + byLedger.get(l)!.trust_lines_after, 0);
      expect(rows).toBeLessThanOrEqual(allChanges);
      // each checkpoint comes once its changes since the last one reach max(lines, floor), and not a ledger earlier
      let since = 0;
      const want: number[] = [];
      for (const t of totals) {
        since += t.changes;
        if (since >= Math.max(t.trust_lines_after, floor)) {
          want.push(t.ledger_index);
          since = 0;
        }
      }
      expect(first).toEqual(want);
    }
  });

  it('counts the changes since the start, so a resumed run puts its checkpoints where a whole run does', () => {
    const rnd = seededRandom(7);
    const totals = history(rnd, 3_000, 100);
    const whole = checkpointLedgers(totals, 0, 500);
    const cut = 1_234;
    const head = checkpointLedgers(totals.slice(0, cut), 0, 500);
    const last = head.length === 0 ? undefined : head[head.length - 1];
    const sinceLast = totals
      .slice(0, cut)
      .filter((t) => last === undefined || t.ledger_index > last)
      .reduce((s, t) => s + t.changes, 0);
    expect([...head, ...checkpointLedgers(totals.slice(cut), sinceLast, 500)]).toEqual(whole);
  });

  it('a token with fewer than 50,000 changes and 10 lines has no checkpoint', () => {
    const totals: LedgerTotals[] = Array.from({ length: 4_999 }, (_, i) => ({
      ledger_index: 100 + i,
      changes: 10,
      trust_lines_after: 10,
    }));
    expect(checkpointLedgers(totals, 0)).toEqual([]);
    expect(TOKEN_HISTORY_CHECKPOINT_FLOOR).toBe(50_000);
    // the 50,000th change makes one
    expect(checkpointLedgers([...totals, { ledger_index: 99_999, changes: 10, trust_lines_after: 10 }], 0)).toEqual([99_999]);
  });
});

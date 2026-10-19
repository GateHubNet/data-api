import { RECORD_LIFETIME_SECONDS, recordOf, RoundMembership, VoteRow } from './records';

const KEY = 'nHBtBkHGfL4NpB54H1AwBaaSJkSJLUSPvnUNAcuNpuffYB51VjH6';
const ROUND_LEDGER = 107748095;
const ROUND_CLOSE = 800_000_000;

function row(ledger_index: number, over: Partial<VoteRow> = {}): VoteRow {
  return {
    ledger_index,
    validation_public_key: KEY,
    close_time: ROUND_CLOSE - (ROUND_LEDGER - ledger_index) * 4,
    full: 1,
    amendments: ['A'.repeat(64)],
    base_fee: null,
    reserve_base: null,
    reserve_inc: null,
    server_version: null,
    ...over,
  };
}

function member(unl: string[] = [KEY], negativeUnl: string[] = []): RoundMembership {
  return { unl: new Set(unl), negativeUnl: new Set(negativeUnl) };
}

describe('recordOf (F7, spec 2.4 step 4)', () => {
  it('lasts 24 hours', () => {
    expect(RECORD_LIFETIME_SECONDS).toBe(86_400);
  });

  it('is undefined without rows', () => {
    expect(recordOf([], ROUND_LEDGER, ROUND_CLOSE)).toBeUndefined();
  });

  it('is the row with the highest ledger index, whatever the order of the rows', () => {
    const rows = [row(ROUND_LEDGER - 512), row(ROUND_LEDGER), row(ROUND_LEDGER - 256)];
    expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE)).toBe(rows[1]);
    expect(recordOf([...rows].reverse(), ROUND_LEDGER, ROUND_CLOSE)).toBe(rows[1]);
  });

  it('ignores rounds after the round asked for', () => {
    const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER + 256)];
    expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE)).toBe(rows[0]);
    expect(recordOf([rows[1]], ROUND_LEDGER, ROUND_CLOSE)).toBeUndefined();
  });

  it('skips a partial validation', () => {
    const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER, { full: 0 })];
    expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE)).toBe(rows[0]);
    expect(recordOf([rows[1]], ROUND_LEDGER, ROUND_CLOSE)).toBeUndefined();
  });

  it('counts a row at exactly close - 86 400 s, and not one a second older', () => {
    const edge = row(ROUND_LEDGER - 256, { close_time: ROUND_CLOSE - RECORD_LIFETIME_SECONDS });
    const stale = row(ROUND_LEDGER - 256, { close_time: ROUND_CLOSE - RECORD_LIFETIME_SECONDS - 1 });
    expect(recordOf([edge], ROUND_LEDGER, ROUND_CLOSE)).toBe(edge);
    expect(recordOf([stale], ROUND_LEDGER, ROUND_CLOSE)).toBeUndefined();
  });

  it('falls back to an older row when the newest is too old or partial', () => {
    const fresh = row(ROUND_LEDGER - 512, { close_time: ROUND_CLOSE - 100 });
    const stale = row(ROUND_LEDGER - 256, { close_time: ROUND_CLOSE - RECORD_LIFETIME_SECONDS - 1 });
    expect(recordOf([stale, fresh], ROUND_LEDGER, ROUND_CLOSE)).toBe(fresh);
  });

  it('is a record that votes for none when the row has no amendments', () => {
    const none = row(ROUND_LEDGER, { amendments: [] });
    expect(recordOf([row(ROUND_LEDGER - 256), none], ROUND_LEDGER, ROUND_CLOSE)).toBe(none);
  });

  describe('with membership', () => {
    it('counts rows of rounds where the key was on the UNL and not on the negative UNL', () => {
      const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER)];
      const membership = new Map([
        [ROUND_LEDGER - 256, member()],
        [ROUND_LEDGER, member()],
      ]);
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, membership)).toBe(rows[1]);
    });

    it('skips a row from a round where the key was on the negative UNL', () => {
      const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER)];
      const membership = new Map([
        [ROUND_LEDGER - 256, member()],
        [ROUND_LEDGER, member([KEY], [KEY])],
      ]);
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, membership)).toBe(rows[0]);
    });

    it('skips a row from a round where the key was not yet on the UNL', () => {
      const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER)];
      const membership = new Map([
        [ROUND_LEDGER - 256, member(['nOther'])],
        [ROUND_LEDGER, member()],
      ]);
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, membership)).toBe(rows[1]);
      expect(recordOf([rows[0]], ROUND_LEDGER, ROUND_CLOSE, membership)).toBeUndefined();
    });

    it('skips a row whose round has no entry', () => {
      const rows = [row(ROUND_LEDGER - 256), row(ROUND_LEDGER)];
      const membership = new Map([[ROUND_LEDGER - 256, member()]]);
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, membership)).toBe(rows[0]);
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, new Map())).toBeUndefined();
    });

    it('still applies the full, round and 24 h rules', () => {
      const membership = new Map([
        [ROUND_LEDGER - 256, member()],
        [ROUND_LEDGER, member()],
        [ROUND_LEDGER + 256, member()],
      ]);
      const partial = row(ROUND_LEDGER, { full: 0 });
      const later = row(ROUND_LEDGER + 256);
      const stale = row(ROUND_LEDGER - 256, { close_time: ROUND_CLOSE - RECORD_LIFETIME_SECONDS - 1 });
      expect(recordOf([partial, later, stale], ROUND_LEDGER, ROUND_CLOSE, membership)).toBeUndefined();
    });

    it('counts nothing as membership when the map is not given', () => {
      const rows = [row(ROUND_LEDGER)];
      expect(recordOf(rows, ROUND_LEDGER, ROUND_CLOSE, undefined)).toBe(rows[0]);
    });
  });
});

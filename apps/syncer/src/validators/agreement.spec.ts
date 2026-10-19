import { ValidatorAgreementHourlyRow } from '@gatehub/data-api-shared';
import { agreementRows, gapsOf, HourAgreementInput, TRACK_CARRY_SECONDS } from './agreement';

const HOUR = 3600;
/** An hour boundary (unix seconds). */
const H = 488_888 * HOUR;
const END = H + HOUR;
const VERSION = 1_760_000_000_000;

const A = 'nHa';
const B = 'nHb';
const C = 'nHc';
const D = 'nHd';
const Q = 'nHq';

/** The hour of four UNL members that has ten ledgers, nine of them observed, over `over`. */
function input(over: Partial<HourAgreementInput> = {}): HourAgreementInput {
  return {
    hour: H,
    ledgers: 10,
    observed: 9,
    gaps: 0,
    unl: new Set([A, B, C, D]),
    quorum: 4,
    perKey: new Map(),
    seenInHour: new Map(),
    previous: [],
    final: true,
    version: VERSION,
    ...over,
  };
}

/** A row of the previous hour: only the key and `last_seen` matter. */
function previousRow(key: string, lastSeen: number): ValidatorAgreementHourlyRow {
  return {
    hour: H - HOUR,
    validation_public_key: key,
    agreed: 5,
    missed: 1,
    partial: 0,
    last_seen: lastSeen,
    ledgers: 0,
    unobserved: 0,
    gaps: 0,
    unl_size: 0,
    quorum: 0,
    final: 0,
    version: VERSION - 1,
  };
}

const keysOf = (rows: ValidatorAgreementHourlyRow[]) => rows.map((row) => row.validation_public_key);
const rowOf = (rows: ValidatorAgreementHourlyRow[], key: string) =>
  rows.find((row) => row.validation_public_key === key);

describe('gapsOf', () => {
  it('counts the indices missing between the first and the last ledger of the hour', () => {
    expect(gapsOf([5, 6, 8])).toBe(1);
    expect(gapsOf([5, 6, 7])).toBe(0);
    expect(gapsOf([5, 9])).toBe(3);
  });

  it('counts the indices missing at the edges of the hour: before the first ledger and after the last', () => {
    expect(gapsOf([5, 6, 8], 4, 9)).toBe(1);
    expect(gapsOf([5, 6], 2, 9)).toBe(4);
    expect(gapsOf([5, 6, 7], 4, 8)).toBe(0);
    expect(gapsOf([5, 6, 7], 1)).toBe(3);
    expect(gapsOf([5, 6, 7], undefined, 12)).toBe(4);
  });

  it('counts the indices missing between the committed ledgers around an hour that has none', () => {
    expect(gapsOf([], 4, 9)).toBe(4);
    expect(gapsOf([], 4, 5)).toBe(0);
  });

  it('is 0 for an hour with no ledger and no committed ledger on one side: nothing says what is missing', () => {
    expect(gapsOf([])).toBe(0);
    expect(gapsOf([], 4)).toBe(0);
    expect(gapsOf([], undefined, 9)).toBe(0);
  });

  it('counts a ledger that is listed twice once', () => {
    expect(gapsOf([5, 5, 6, 6, 8], 4, 9)).toBe(1);
  });

  it('does not count a neighbour that is not outside the hour', () => {
    expect(gapsOf([5, 6], 7, 3)).toBe(0);
  });
});

describe('agreementRows', () => {
  it('writes a row per tracked validator in the order of the keys, then the sentinel', () => {
    const rows = agreementRows(
      input({
        perKey: new Map([
          [D, { agreed: 9, partialOnly: 0 }],
          [A, { agreed: 9, partialOnly: 0 }],
        ]),
      }),
    );
    expect(keysOf(rows)).toEqual([A, B, C, D, '']);
    expect(rows.every((row) => row.hour === H && row.version === VERSION)).toBe(true);
  });

  it('counts a validator that signed the hash fully as agreed, and one that did not as missed', () => {
    const rows = agreementRows(input({ perKey: new Map([[A, { agreed: 9, partialOnly: 0 }]]) }));
    expect(rowOf(rows, A)).toMatchObject({ agreed: 9, missed: 0, partial: 0 });
    expect(rowOf(rows, B)).toMatchObject({ agreed: 0, missed: 9, partial: 0 });
  });

  it('counts a partial validation as partial and as missed', () => {
    const rows = agreementRows(input({ perKey: new Map([[A, { agreed: 7, partialOnly: 1 }]]) }));
    expect(rowOf(rows, A)).toMatchObject({ agreed: 7, partial: 1, missed: 2 });
    const only = agreementRows(input({ observed: 1, perKey: new Map([[B, { agreed: 0, partialOnly: 1 }]]) }));
    expect(rowOf(only, B)).toMatchObject({ agreed: 0, partial: 1, missed: 1 });
  });

  it('leaves an under-recorded ledger out for everybody', () => {
    // two ledgers: one with all four UNL validations, one with 3 of the quorum of 4 recorded (D's is not in the collector's data)
    const rows = agreementRows(
      input({
        ledgers: 2,
        observed: 1,
        perKey: new Map([
          [A, { agreed: 1, partialOnly: 0 }],
          [B, { agreed: 1, partialOnly: 0 }],
          [C, { agreed: 1, partialOnly: 0 }],
          [D, { agreed: 1, partialOnly: 0 }],
        ]),
      }),
    );
    const sentinel = rowOf(rows, '');
    expect(sentinel).toMatchObject({ ledgers: 1, unobserved: 1 });
    // nobody's missed grew for the ledger that was left out
    expect([A, B, C, D].map((key) => rowOf(rows, key)?.missed)).toEqual([0, 0, 0, 0]);
    expect([A, B, C, D].map((key) => rowOf(rows, key)?.agreed)).toEqual([1, 1, 1, 1]);
  });

  it('fills the sentinel: the observed ledgers, the unobserved, the gaps, the size of the UNL, the quorum and whether it is final', () => {
    const rows = agreementRows(input({ gaps: 3, final: false }));
    expect(rows[rows.length - 1]).toEqual({
      hour: H,
      validation_public_key: '',
      agreed: 0,
      missed: 0,
      partial: 0,
      last_seen: 0,
      ledgers: 9,
      unobserved: 1,
      gaps: 3,
      unl_size: 4,
      quorum: 4,
      final: 0,
      version: VERSION,
    });
    expect(rowOf(agreementRows(input()), '')?.final).toBe(1);
  });

  it('leaves the totals of the hour off the rows of the validators', () => {
    const rows = agreementRows(input({ gaps: 3, final: true }));
    for (const row of rows.filter((r) => r.validation_public_key !== '')) {
      expect(row).toMatchObject({ ledgers: 0, unobserved: 0, gaps: 0, unl_size: 0, quorum: 0, final: 0 });
    }
  });

  it('tracks a validator seen in the hour that is not on the UNL, and takes its last_seen from the hour', () => {
    const rows = agreementRows(
      input({
        perKey: new Map([[Q, { agreed: 5, partialOnly: 2 }]]),
        seenInHour: new Map([[Q, H + 3000.25]]),
      }),
    );
    expect(keysOf(rows)).toEqual([A, B, C, D, Q, '']);
    expect(rowOf(rows, Q)).toMatchObject({ agreed: 5, partial: 2, missed: 4, last_seen: H + 3000.25 });
  });

  it('does not track a validator that has a count but no receipt in the hour, and is not on the UNL or carried', () => {
    const rows = agreementRows(
      input({
        perKey: new Map([[Q, { agreed: 1, partialOnly: 0 }]]),
        seenOutside: new Map([[Q, END + 2.5]]),
      }),
    );
    expect(keysOf(rows)).toEqual([A, B, C, D, '']);
  });

  it('fills the last_seen of a tracked validator that has no receipt in the hour from one outside it, and not the other way', () => {
    const rows = agreementRows(
      input({
        perKey: new Map([
          [A, { agreed: 1, partialOnly: 0 }],
          [B, { agreed: 1, partialOnly: 0 }],
          [C, { agreed: 1, partialOnly: 0 }],
        ]),
        seenInHour: new Map([[B, H + 3500]]),
        seenOutside: new Map([
          [A, END + 2.5],
          [B, END + 2.5],
          [Q, END + 2.5],
        ]),
        previous: [previousRow(C, H - 100)],
      }),
    );
    // A: only a receipt after the hour; B: its receipt in the hour stands; C: the row before; D: none known
    expect([A, B, C, D].map((key) => rowOf(rows, key)?.last_seen)).toEqual([END + 2.5, H + 3500, H - 100, 0]);
    expect(keysOf(rows)).not.toContain(Q);
  });

  it('tracks a validator seen in the hour that agreed with nothing, with all the observed ledgers missed', () => {
    const rows = agreementRows(input({ seenInHour: new Map([[Q, H + 10]]) }));
    expect(rowOf(rows, Q)).toMatchObject({ agreed: 0, partial: 0, missed: 9 });
  });

  describe('the validators of the hour before', () => {
    it('keeps one that is quiet this hour but was seen 23 h before the end of the hour, missing every observed ledger', () => {
      const seen = END - 23 * HOUR;
      const rows = agreementRows(input({ previous: [previousRow(Q, seen)] }));
      expect(rowOf(rows, Q)).toMatchObject({ agreed: 0, partial: 0, missed: 9, last_seen: seen });
    });

    it('drops one that was last seen 25 h before the end of the hour', () => {
      const rows = agreementRows(input({ previous: [previousRow(Q, END - 25 * HOUR)] }));
      expect(keysOf(rows)).not.toContain(Q);
    });

    it('keeps one last seen exactly 24 h before the end of the hour, and drops one a millisecond older', () => {
      expect(TRACK_CARRY_SECONDS).toBe(24 * HOUR);
      const kept = agreementRows(input({ previous: [previousRow(Q, END - TRACK_CARRY_SECONDS)] }));
      expect(keysOf(kept)).toContain(Q);
      const dropped = agreementRows(input({ previous: [previousRow(Q, END - TRACK_CARRY_SECONDS - 0.001)] }));
      expect(keysOf(dropped)).not.toContain(Q);
    });

    it('takes the last_seen of the hour over that of the row before, and the row before when the hour has none', () => {
      const rows = agreementRows(
        input({
          previous: [previousRow(Q, H - 600), previousRow(B, H - 900)],
          seenInHour: new Map([[Q, H + 1200.5]]),
        }),
      );
      expect(rowOf(rows, Q)?.last_seen).toBe(H + 1200.5);
      expect(rowOf(rows, B)?.last_seen).toBe(H - 900);
    });

    it('does not take the sentinel of the hour before for a validator', () => {
      const rows = agreementRows(input({ previous: [previousRow('', END - HOUR)] }));
      expect(keysOf(rows)).toEqual([A, B, C, D, '']);
    });

    it('keeps a member of the UNL that was last seen long ago, and has no last_seen for one never seen', () => {
      const rows = agreementRows(input({ previous: [previousRow(A, END - 40 * HOUR)] }));
      expect(rowOf(rows, A)?.last_seen).toBe(END - 40 * HOUR);
      expect(rowOf(rows, B)?.last_seen).toBe(0);
    });
  });

  it('writes the totals of an hour with no ledger: nothing observed, nobody missed', () => {
    const rows = agreementRows(input({ ledgers: 0, observed: 0 }));
    expect(rowOf(rows, '')).toMatchObject({ ledgers: 0, unobserved: 0 });
    expect(rows.every((row) => row.missed === 0 && row.agreed === 0)).toBe(true);
  });
});

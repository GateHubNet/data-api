import {
  agreementReadFrom,
  agreementWindow,
  agreementWindows,
  HourSentinel,
  KeyHour,
  newestFinalHour,
  NO_AGREEMENT,
} from './agreement-windows';

const HOUR = 3600;
/** 2026-10-19T15:00:00Z: the newest final hour of most of these tests, in the middle of a UTC day. */
const NEWEST = Date.UTC(2026, 9, 19, 15) / 1000;

const hoursFrom = (first: number, count: number): number[] => Array.from({ length: count }, (_, i) => first + i * HOUR);

/** A sentinel for each of `count` hours from `first`: final, with 900 observed ledgers and none unobserved. */
function sentinelsOf(first: number, count: number, over: Partial<HourSentinel> = {}): Map<number, HourSentinel> {
  return new Map(hoursFrom(first, count).map((hour) => [hour, { final: true, ledgers: 900, unobserved: 0, ...over }]));
}

/** The same row for each of `count` hours from `first`. */
function rowsOf(first: number, count: number, row: KeyHour): Map<number, KeyHour> {
  return new Map(hoursFrom(first, count).map((hour) => [hour, { ...row }]));
}

describe('agreementWindow', () => {
  describe('the figures', () => {
    it('is missed 4 of 22,096 with the score 0.9998, partial ones counted separately', () => {
      const sentinels = sentinelsOf(NEWEST, 1);
      const rows = new Map([[NEWEST, { agreed: 22_092, missed: 4, partial: 1 }]]);
      expect(agreementWindow(sentinels, rows, NEWEST, NEWEST + HOUR)).toEqual({
        missed: 4,
        total: 22_096,
        score: '0.9998',
        incomplete: false,
        partial: 1,
      });
    });

    it('is 1.0000 for 0 missed of 921', () => {
      const rows = new Map([[NEWEST, { agreed: 921, missed: 0, partial: 0 }]]);
      const window = agreementWindow(sentinelsOf(NEWEST, 1), rows, NEWEST, NEWEST + HOUR);
      expect(window).toEqual({ missed: 0, total: 921, score: '1.0000', incomplete: false, partial: 0 });
    });

    it('adds the hours up: total is the sum of agreed and missed, missed and partial are summed', () => {
      const first = NEWEST - 23 * HOUR;
      const rows = new Map<number, KeyHour>([
        [first, { agreed: 100, missed: 5, partial: 2 }],
        [first + HOUR, { agreed: 200, missed: 0, partial: 0 }],
        [NEWEST, { agreed: 50, missed: 1, partial: 3 }],
      ]);
      expect(agreementWindow(sentinelsOf(first, 24), rows, first, NEWEST + HOUR)).toEqual({
        missed: 6,
        total: 356,
        score: '0.9831',
        incomplete: false,
        partial: 5,
      });
    });

    it('rounds the score half up at the 5th decimal (and not to even)', () => {
      // 2,469 / 20,000 = 0.12345 exactly: half up is 0.1235, half to even 0.1234
      const rows = new Map([[NEWEST, { agreed: 2_469, missed: 17_531, partial: 0 }]]);
      expect(agreementWindow(sentinelsOf(NEWEST, 1), rows, NEWEST, NEWEST + HOUR).score).toBe('0.1235');
      // 19,999 / 20,000 = 0.99995 exactly
      const high = new Map([[NEWEST, { agreed: 19_999, missed: 1, partial: 0 }]]);
      expect(agreementWindow(sentinelsOf(NEWEST, 1), high, NEWEST, NEWEST + HOUR).score).toBe('1.0000');
    });

    it('has no score at a total of 0, with a row of zeros or with none, and the key is absent', () => {
      const none = agreementWindow(sentinelsOf(NEWEST, 1), new Map(), NEWEST, NEWEST + HOUR);
      expect(none).toEqual({ missed: 0, total: 0, incomplete: false, partial: 0 });
      expect('score' in none).toBe(false);
      const zeros = new Map([[NEWEST, { agreed: 0, missed: 0, partial: 4 }]]);
      const window = agreementWindow(sentinelsOf(NEWEST, 1), zeros, NEWEST, NEWEST + HOUR);
      expect(window).toEqual({ missed: 0, total: 0, incomplete: false, partial: 4 });
      expect('score' in window).toBe(false);
    });

    it('lists the keys in the order of the answer: missed, total, score, incomplete, partial', () => {
      const rows = new Map([[NEWEST, { agreed: 10, missed: 0, partial: 0 }]]);
      expect(Object.keys(agreementWindow(sentinelsOf(NEWEST, 1), rows, NEWEST, NEWEST + HOUR))).toEqual([
        'missed',
        'total',
        'score',
        'incomplete',
        'partial',
      ]);
    });

    it('ignores rows outside the window', () => {
      const rows = new Map<number, KeyHour>([
        [NEWEST - HOUR, { agreed: 7, missed: 7, partial: 7 }],
        [NEWEST, { agreed: 10, missed: 0, partial: 0 }],
        [NEWEST + HOUR, { agreed: 7, missed: 7, partial: 7 }],
      ]);
      expect(agreementWindow(sentinelsOf(NEWEST - HOUR, 3), rows, NEWEST, NEWEST + HOUR)).toMatchObject({ total: 10 });
    });
  });

  describe('incomplete', () => {
    it('is false when every hour has a final sentinel and nothing is unobserved', () => {
      const first = NEWEST - 23 * HOUR;
      expect(agreementWindow(sentinelsOf(first, 24), new Map(), first, NEWEST + HOUR).incomplete).toBe(false);
    });

    it('is true when an hour of the window has no sentinel', () => {
      const first = NEWEST - 23 * HOUR;
      const sentinels = sentinelsOf(first, 24);
      sentinels.delete(first + 5 * HOUR);
      expect(agreementWindow(sentinels, new Map(), first, NEWEST + HOUR).incomplete).toBe(true);
    });

    it('is true when an hour of the window is not final', () => {
      const first = NEWEST - 23 * HOUR;
      const sentinels = sentinelsOf(first, 24);
      sentinels.set(first + 5 * HOUR, { final: false, ledgers: 900, unobserved: 0 });
      expect(agreementWindow(sentinels, new Map(), first, NEWEST + HOUR).incomplete).toBe(true);
    });

    it('is not decided by a missing hour outside the window', () => {
      const sentinels = sentinelsOf(NEWEST, 1);
      expect(agreementWindow(sentinels, new Map(), NEWEST, NEWEST + HOUR).incomplete).toBe(false);
    });

    it('flags a window incomplete above 1 % unobserved', () => {
      // 1 of 100 validated ledgers (99 observed + 1) is exactly 1.0 %: not above
      const exactly = sentinelsOf(NEWEST, 1, { ledgers: 99, unobserved: 1 });
      expect(agreementWindow(exactly, new Map(), NEWEST, NEWEST + HOUR).incomplete).toBe(false);
      // 11 of 1,000 is 1.1 %
      const above = sentinelsOf(NEWEST, 1, { ledgers: 989, unobserved: 11 });
      expect(agreementWindow(above, new Map(), NEWEST, NEWEST + HOUR).incomplete).toBe(true);
    });

    it('judges the unobserved share over the whole window, not hour by hour', () => {
      const first = NEWEST - 23 * HOUR;
      const sentinels = sentinelsOf(first, 24);
      // one bad hour: 500 unobserved of 1,400 ledgers; the window holds 24 × 900 + 500 = 22,100 ledgers: 2.3 %
      sentinels.set(first, { final: true, ledgers: 900, unobserved: 500 });
      expect(agreementWindow(sentinels, new Map(), first, NEWEST + HOUR).incomplete).toBe(true);
      // a handful of unobserved ledgers does not flag a day
      sentinels.set(first, { final: true, ledgers: 900, unobserved: 30 });
      expect(agreementWindow(sentinels, new Map(), first, NEWEST + HOUR).incomplete).toBe(false);
    });

    it('does not divide by zero for hours with no ledgers at all', () => {
      const sentinels = sentinelsOf(NEWEST, 1, { ledgers: 0, unobserved: 0 });
      expect(agreementWindow(sentinels, new Map(), NEWEST, NEWEST + HOUR).incomplete).toBe(false);
    });
  });
});

describe('newestFinalHour', () => {
  it('is the newest hour with a final sentinel', () => {
    const sentinels = sentinelsOf(NEWEST - 2 * HOUR, 3);
    sentinels.set(NEWEST + HOUR, { final: false, ledgers: 1, unobserved: 0 });
    expect(newestFinalHour(sentinels)).toBe(NEWEST);
  });

  it('is undefined without one', () => {
    expect(newestFinalHour(new Map())).toBeUndefined();
    expect(newestFinalHour(new Map([[NEWEST, { final: false, ledgers: 1, unobserved: 0 }]]))).toBeUndefined();
  });
});

describe('agreementReadFrom (ruling P6)', () => {
  it('is the first hour of the 30-day window: the newest final hour minus 719 hours, not the start of a UTC day', () => {
    expect(agreementReadFrom(NEWEST)).toBe(NEWEST - 719 * HOUR);
    // 15:00 minus 719 h is 16:00 of the day 30 days back
    expect(new Date(agreementReadFrom(NEWEST) * 1000).toISOString()).toBe('2026-09-19T16:00:00.000Z');
  });
});

describe('agreementWindows', () => {
  const first = agreementReadFrom(NEWEST);
  const rowsAllHours = rowsOf(first, 720, { agreed: 899, missed: 1, partial: 0 });

  it('answers the three windows and the 30 days: 1 h is the newest final hour, 24 h the 24 ending there, 30 d the 720', () => {
    const windows = agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST);
    expect(windows.agreement1h).toEqual({ missed: 1, total: 900, score: '0.9989', incomplete: false, partial: 0 });
    expect(windows.agreement24h).toEqual({ missed: 24, total: 21_600, score: '0.9989', incomplete: false, partial: 0 });
    expect(windows.agreement30d).toEqual({
      missed: 720,
      total: 648_000,
      score: '0.9989',
      incomplete: false,
      partial: 0,
    });
  });

  it('is complete when all 720 hours are present, though the first hour is in the middle of a UTC day (P6)', () => {
    expect(new Date(first * 1000).getUTCHours()).toBe(16);
    expect(agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST).agreement30d.incomplete).toBe(false);
  });

  it('is incomplete for 30 d when one of the 720 hours is missing, and the other windows are not', () => {
    const sentinels = sentinelsOf(first, 720);
    sentinels.delete(first);
    const windows = agreementWindows(sentinels, rowsAllHours, NEWEST);
    expect(windows.agreement30d.incomplete).toBe(true);
    expect(windows.agreement24h.incomplete).toBe(false);
    expect(windows.agreement1h.incomplete).toBe(false);
  });

  it('lists 30 UTC days oldest first, ending with the day of the newest final hour', () => {
    const { daily } = agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST);
    expect(daily).toHaveLength(30);
    expect(daily[0].date).toBe('2026-09-20');
    expect(daily[28].date).toBe('2026-10-18');
    expect(daily[29].date).toBe('2026-10-19');
    expect(daily.map((day) => day.date)).toEqual([...daily.map((day) => day.date)].sort());
  });

  it('puts date first in a day, then the keys of a window', () => {
    const { daily } = agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST);
    expect(Object.keys(daily[0])).toEqual(['date', 'missed', 'total', 'score', 'incomplete', 'partial']);
  });

  it('counts the hours of a whole day: 24 × 900 for a day of 24 final hours', () => {
    const { daily } = agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST);
    expect(daily[0]).toEqual({
      date: '2026-09-20',
      missed: 24,
      total: 21_600,
      score: '0.9989',
      incomplete: false,
      partial: 0,
    });
  });

  it('flags the day of the newest hour incomplete (it has 16 hours), the days before it are complete', () => {
    const { daily } = agreementWindows(sentinelsOf(first, 720), rowsAllHours, NEWEST);
    expect(daily[29]).toMatchObject({ date: '2026-10-19', total: 16 * 900, incomplete: true });
    expect(daily.slice(0, 29).every((day) => !day.incomplete)).toBe(true);
  });

  it('flags a day of 23 final hours incomplete', () => {
    const sentinels = sentinelsOf(first, 720);
    const gap = Date.UTC(2026, 9, 10, 7) / 1000;
    sentinels.delete(gap);
    const { daily } = agreementWindows(sentinels, rowsAllHours, NEWEST);
    expect(daily.filter((day) => day.incomplete).map((day) => day.date)).toEqual(['2026-10-10', '2026-10-19']);
  });

  it('flags a day with a non-final hour incomplete', () => {
    const sentinels = sentinelsOf(first, 720);
    const hour = Date.UTC(2026, 9, 12, 23) / 1000;
    sentinels.set(hour, { final: false, ledgers: 900, unobserved: 0 });
    const { daily } = agreementWindows(sentinels, rowsAllHours, NEWEST);
    expect(daily.find((day) => day.date === '2026-10-12')?.incomplete).toBe(true);
    expect(daily.find((day) => day.date === '2026-10-13')?.incomplete).toBe(false);
  });

  it('has a day complete only when the newest hour is the last of its UTC day', () => {
    const lastOfDay = Date.UTC(2026, 9, 19, 23) / 1000;
    const from = agreementReadFrom(lastOfDay);
    const { daily } = agreementWindows(
      sentinelsOf(from, 720),
      rowsOf(from, 720, { agreed: 1, missed: 0, partial: 0 }),
      lastOfDay,
    );
    expect(daily[29]).toMatchObject({ date: '2026-10-19', total: 24, incomplete: false });
  });

  it('gives the absent score of a validator with no rows, over complete hours', () => {
    const windows = agreementWindows(sentinelsOf(first, 720), new Map(), NEWEST);
    expect(windows.agreement24h).toEqual({ missed: 0, total: 0, incomplete: false, partial: 0 });
    expect(windows.daily[0]).toEqual({ date: '2026-09-20', missed: 0, total: 0, incomplete: false, partial: 0 });
  });

  it('has the windows of the hours it has: a database only a few hours old is incomplete for 24 h and 30 d', () => {
    const windows = agreementWindows(sentinelsOf(NEWEST - 2 * HOUR, 3), new Map(), NEWEST);
    expect(windows.agreement1h.incomplete).toBe(false);
    expect(windows.agreement24h.incomplete).toBe(true);
    expect(windows.agreement30d.incomplete).toBe(true);
  });

  it('has a placeholder for a validator before any hour is final', () => {
    expect(NO_AGREEMENT).toEqual({ missed: 0, total: 0, incomplete: true, partial: 0 });
  });

  it('shares the placeholder between validators, so it is frozen: it cannot be changed in place', () => {
    expect(Object.isFrozen(NO_AGREEMENT)).toBe(true);
    expect(() => {
      // @ts-expect-error a field of a window is read-only
      NO_AGREEMENT.missed = 1;
    }).toThrow(TypeError);
    expect(NO_AGREEMENT.missed).toBe(0);
  });

  it('has windows whose fields are read-only', () => {
    const window = agreementWindow(new Map(), new Map(), NEWEST, NEWEST + HOUR);
    const mutate = (): void => {
      // @ts-expect-error a field of a window is read-only
      window.total = 1;
      // @ts-expect-error a field of a window is read-only
      window.incomplete = false;
    };
    expect(mutate).toBeDefined();
  });
});

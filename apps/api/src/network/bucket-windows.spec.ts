import { ceilTo, collectBuckets, floorTo } from './bucket-windows';

describe('floorTo / ceilTo', () => {
  it('align a time to a multiple of the bucket size', () => {
    expect(floorTo(7200, 3600)).toBe(7200);
    expect(floorTo(7201, 3600)).toBe(7200);
    expect(floorTo(7199, 3600)).toBe(3600);
    expect(ceilTo(7200, 3600)).toBe(7200);
    expect(ceilTo(7201, 3600)).toBe(10800);
    expect(ceilTo(0, 3600)).toBe(0);
    expect(ceilTo(1, 86400)).toBe(86400);
  });
});

describe('collectBuckets', () => {
  const HOUR = 3600;

  /** A source of buckets: every `starts` entry is a non-empty bucket; `fetch` is what the query does for a window. */
  function source(starts: number[], descending = false) {
    const calls: { from: number; until: number; limit: number }[] = [];
    const fetch = async (w: { from: number; until: number }, limit: number): Promise<{ bucket: number }[]> => {
      calls.push({ ...w, limit });
      return starts
        .filter((b) => b >= w.from && b < w.until)
        .sort((a, b) => (descending ? b - a : a - b))
        .slice(0, limit)
        .map((bucket) => ({ bucket }));
    };
    return { fetch, calls };
  }
  const hours = (...n: number[]): number[] => n.map((h) => h * HOUR);
  const buckets = (rows: { bucket: number }[]): number[] => rows.map((r) => r.bucket / HOUR);

  it('is one query when the first window holds enough buckets (the dense case)', async () => {
    const { fetch, calls } = source(hours(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    const rows = await collectBuckets({ from: 0, until: 100 * HOUR, size: HOUR, want: 4, descending: false, fetch });
    expect(buckets(rows)).toEqual([0, 1, 2, 3]);
    expect(calls).toEqual([{ from: 0, until: 4 * HOUR, limit: 4 }]);
  });

  it('descending starts at the end of the range and walks back', async () => {
    const { fetch, calls } = source(hours(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), true);
    const rows = await collectBuckets({ from: 0, until: 10 * HOUR, size: HOUR, want: 3, descending: true, fetch });
    expect(buckets(rows)).toEqual([9, 8, 7]);
    expect(calls).toEqual([{ from: 7 * HOUR, until: 10 * HOUR, limit: 3 }]);
  });

  it('doubles the window across a gap, and still returns the first buckets in order', async () => {
    const { fetch, calls } = source(hours(0, 1, 500, 501, 502, 9000));
    const rows = await collectBuckets({ from: 0, until: 10_000 * HOUR, size: HOUR, want: 5, descending: false, fetch });
    expect(buckets(rows)).toEqual([0, 1, 500, 501, 502]);
    // windows 5 h, 10 h, 20 h, ... grow: far fewer queries than hours
    expect(calls.length).toBeLessThan(12);
    expect(calls.every((c) => c.from % HOUR === 0 && c.until % HOUR === 0)).toBe(true);
    // consecutive windows neither overlap nor leave a hole
    calls.slice(1).forEach((c, i) => expect(c.from).toBe(calls[i].until));
    // later windows ask only for what is still missing
    expect(calls[0].limit).toBe(5);
    expect(calls[calls.length - 1].limit).toBeLessThan(5);
  });

  it('walks back across a gap too', async () => {
    const { fetch, calls } = source(hours(0, 1, 2, 500, 9000), true);
    const rows = await collectBuckets({ from: 0, until: 10_000 * HOUR, size: HOUR, want: 4, descending: true, fetch });
    expect(buckets(rows)).toEqual([9000, 500, 2, 1]);
    calls.slice(1).forEach((c, i) => expect(c.until).toBe(calls[i].from));
  });

  it('stops at the end of the range with what there is', async () => {
    const { fetch, calls } = source(hours(2, 3));
    const rows = await collectBuckets({ from: 0, until: 6 * HOUR, size: HOUR, want: 10, descending: false, fetch });
    expect(buckets(rows)).toEqual([2, 3]);
    expect(calls[calls.length - 1].until).toBe(6 * HOUR);
    expect(calls.every((c) => c.from >= 0 && c.until <= 6 * HOUR)).toBe(true);
  });

  it('asks nothing of an empty range', async () => {
    const { fetch, calls } = source(hours(1));
    expect(
      await collectBuckets({ from: 5 * HOUR, until: 5 * HOUR, size: HOUR, want: 3, descending: false, fetch }),
    ).toEqual([]);
    expect(
      await collectBuckets({ from: 6 * HOUR, until: 5 * HOUR, size: HOUR, want: 3, descending: true, fetch }),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('returns exactly `want` rows even when a window holds more', async () => {
    const { fetch } = source(hours(0, 1, 2, 3, 4, 5));
    const rows = await collectBuckets({
      from: 0,
      until: 6 * HOUR,
      size: HOUR,
      want: 2,
      descending: false,
      fetch: async (w, limit) => (await fetch(w, limit)).concat([{ bucket: w.from }]),
    });
    expect(rows).toHaveLength(2);
  });

  it('works with a bucket size of a day', async () => {
    const DAY = 86400;
    const { fetch } = source([0, 3 * DAY, 400 * DAY]);
    const rows = await collectBuckets({ from: 0, until: 1000 * DAY, size: DAY, want: 3, descending: false, fetch });
    expect(rows.map((r) => r.bucket / DAY)).toEqual([0, 3, 400]);
  });
});

import BigNumber from 'bignumber.js';
import { RATES_DAILY_CONFIG_VERSION } from '../aggregate/rates-daily.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Asset, assetKey } from './asset';
import { DailyRates, ON_READ_CACHE_MS, ON_READ_RUN_DAYS, RateCache } from './daily-rates';
import { RatesService } from './rates.service';

const DAY_MS = 86_400_000;
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const USD: Asset = { currency: 'USD', issuer: ISSUER };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER };
const XRP: Asset = { currency: 'XRP' };

/** `n` consecutive UTC days from `first` (`YYYY-MM-DD`). */
const daysFrom = (first: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${first}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10),
  );
const midnight = (day: string): Date => new Date(`${day}T00:00:00Z`);

interface Sentinel {
  day: string;
  version: number;
  stale: 0 | 1;
  config_version: number;
}
interface StoredRate {
  currency: string;
  issuer: string;
  day: string;
  version: number;
  rate: string;
}
const sentinel = (day: string, version: number, extra: Partial<Sentinel> = {}): Sentinel => ({
  day,
  version,
  stale: 0,
  config_version: RATES_DAILY_CONFIG_VERSION,
  ...extra,
});
const stored = (asset: Asset, day: string, version: number, rate: string): StoredRate => ({
  currency: asset.currency,
  issuer: asset.issuer ?? '',
  day,
  version,
  rate,
});

/**
 * A `ClickHouseService` over two small tables, answering the two reads of `DailyRates` the way the SQL of each means it:
 * the valid days (the newest sentinel of each day, if it is not stale and of the current config version) and the rows of
 * the assets for the days and versions asked for. The queries are remembered. (The real SQL is the e2e suite's.)
 */
function fakeClickHouse(sentinels: Sentinel[], rows: StoredRate[]) {
  const calls: { sql: string; params: Record<string, unknown> }[] = [];
  const query = async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    calls.push({ sql, params });
    if (sql.includes("currency = '' AND issuer = ''")) {
      const newest = new Map<string, Sentinel>();
      for (const s of sentinels) {
        const inRange = s.day >= String(params.from) && s.day <= String(params.through);
        if (inRange && s.version > (newest.get(s.day)?.version ?? -1)) newest.set(s.day, s);
      }
      return [...newest.values()]
        .filter((s) => s.stale === 0 && s.config_version === params.configVersion)
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .map((s) => ({ day: s.day, version: String(s.version) }));
    }
    const currencies = params.currencies as string[];
    const issuers = params.issuers as string[];
    const days = params.days as string[];
    const versions = params.versions as number[];
    const seen = new Set<string>();
    return rows
      .filter(
        (r) =>
          currencies.some((c, i) => c === r.currency && issuers[i] === r.issuer) &&
          days.some((d, i) => d === r.day && Number(versions[i]) === r.version),
      )
      .filter((r) => {
        const key = [r.currency, r.issuer, r.day].join('\u0000');
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .map((r) => ({ currency: r.currency, issuer: r.issuer, day_key: r.day, rate: r.rate }));
  };
  const ch = { query } as unknown as ClickHouseService;
  return { ch, calls };
}

/** A `RatesService` whose `dailyNativeRates` gives `rateOf(asset, day)` for each day asked for. */
function fakeRates(rateOf: (asset: Asset, day: string) => BigNumber.Value = () => 0) {
  const dailyNativeRates = jest.fn(async (assets: Asset[], from: Date, toExclusive: Date) => {
    const out = new Map<string, Map<string, BigNumber>>();
    for (const asset of assets) {
      const perDay = new Map<string, BigNumber>();
      for (let ms = from.getTime(); ms < toExclusive.getTime(); ms += DAY_MS) {
        const day = new Date(ms).toISOString().slice(0, 10);
        perDay.set(day, new BigNumber(rateOf(asset, day)));
      }
      out.set(assetKey(asset), perDay);
    }
    return out;
  });
  const service = { nativeCurrency: 'XRP', dailyNativeRates } as unknown as RatesService;
  return { service, dailyNativeRates };
}

/** The shape of `CacheService`, on a clock the test moves. */
class FakeCache implements RateCache {
  now = 1_000_000;
  readonly sets: { key: string; ttlMs: number }[] = [];
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  get(key: string): unknown {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > this.now ? entry.value : undefined;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.sets.push({ key, ttlMs });
    this.entries.set(key, { value, expiresAt: this.now + ttlMs });
  }
}

const tableOf = (got: Map<string, Map<string, BigNumber>>, asset: Asset): [string, string][] =>
  [...(got.get(assetKey(asset)) as Map<string, BigNumber>).entries()].map(([day, rate]) => [day, rate.toFixed()]);

describe('DailyRates', () => {
  it('has the native currency of the RatesService', () => {
    expect(new DailyRates(fakeClickHouse([], []).ch, fakeRates().service).nativeCurrency).toBe('XRP');
  });

  it('the native currency is 1 on every day, with no read', async () => {
    const { ch, calls } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates();
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { onRead });
    const days = daysFrom('2020-01-01', 3);

    const got = await daily.rates([XRP], days);

    expect(tableOf(got, XRP)).toEqual(days.map((day) => [day, '1']));
    expect(calls).toEqual([]);
    expect(dailyNativeRates).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });

  it('valid days come from one read of the table, rows of the sentinel version only; an asset absent on a valid day is 0', async () => {
    const days = daysFrom('2020-01-01', 3);
    const { ch, calls } = fakeClickHouse(
      // day 2 was written twice: its newest set is version 25, whose rows are the ones that count
      [sentinel(days[0], 10), sentinel(days[1], 20), sentinel(days[1], 25), sentinel(days[2], 30)],
      [
        stored(USD, days[0], 10, '4'),
        stored(USD, days[1], 20, '99'), // an older set of the day
        stored(USD, days[1], 25, '1e-8'), // BigNumber text can be exponential
        stored(EUR, days[1], 25, '0.5'),
        // USD has no row on day 3, EUR none on day 1: no rate
        stored(EUR, days[2], 30, '1234567890.123456789'),
        stored(EUR, days[2], 29, '7'), // a set that is gone
      ],
    );
    const { service, dailyNativeRates } = fakeRates();
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { onRead });

    const got = await daily.rates([USD, EUR, USD], days);

    expect([...got.keys()]).toEqual([assetKey(USD), assetKey(EUR)]);
    expect(tableOf(got, USD)).toEqual([
      [days[0], '4'],
      [days[1], '0.00000001'],
      [days[2], '0'],
    ]);
    expect(tableOf(got, EUR)).toEqual([
      [days[0], '0'],
      [days[1], '0.5'],
      [days[2], '1234567890.123456789'],
    ]);
    for (const perDay of got.values()) for (const rate of perDay.values()) expect(rate).toBeInstanceOf(BigNumber);
    expect(dailyNativeRates).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();

    // two reads: the valid days of the range, then the rows of every asset once for the days and sets that are valid
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual({ from: days[0], through: days[2], configVersion: RATES_DAILY_CONFIG_VERSION });
    expect(calls[1].params).toEqual({
      currencies: ['USD', 'EUR'],
      issuers: [ISSUER, ISSUER],
      from: days[0],
      through: days[2],
      days,
      versions: [10, 25, 30],
    });
    expect(calls[1].sql).toContain('FROM native_rates_daily');
    expect(calls[1].sql).toContain('(currency, issuer) IN');
    expect(calls[1].sql).toContain('(day, version) IN');
    expect(calls[1].sql).toContain('LIMIT 1 BY currency, issuer, day');
    for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b/);
  });

  it('asks for the range of the days it is given, whatever the order or the repeats of them', async () => {
    const { ch, calls } = fakeClickHouse([], []);
    const daily = new DailyRates(ch, fakeRates().service);
    await daily.rates([USD], ['2020-03-05', '2020-01-02', '2020-03-05']);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ from: '2020-01-02', through: '2020-03-05' });
  });

  it('a day whose newest sentinel is stale, or of config version 2, is computed on read', async () => {
    const days = daysFrom('2020-01-01', 5);
    const { ch, calls } = fakeClickHouse(
      [
        sentinel(days[0], 10),
        sentinel(days[1], 20),
        sentinel(days[1], 21, { stale: 1 }), // marked stale after it was computed
        sentinel(days[2], 30, { config_version: 2 }),
        sentinel(days[3], 40, { stale: 1 }),
        sentinel(days[3], 41), // computed again: valid
        // day 5 has no set
      ],
      [stored(USD, days[0], 10, '4'), stored(USD, days[1], 20, '5'), stored(USD, days[3], 41, '8')],
    );
    const { service, dailyNativeRates } = fakeRates((asset, day) => (day === days[4] ? '0' : `1${day.slice(-2)}`));
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { onRead });

    const got = await daily.rates([USD], days);

    expect(tableOf(got, USD)).toEqual([
      [days[0], '4'],
      [days[1], '102'], // the stored 5 is of a set that was marked stale
      [days[2], '103'], // another config version
      [days[3], '8'],
      [days[4], '0'], // computed, and there is none
    ]);
    // days 2, 3 and 5 are not valid: days 2 and 3 are one run, and day 4 (read from the table) parts them from day 5
    expect(dailyNativeRates.mock.calls.map(([assets, from, to]) => [assets.map(assetKey), from, to])).toEqual([
      [[assetKey(USD)], midnight(days[1]), midnight(days[3])],
      [[assetKey(USD)], midnight(days[4]), midnight('2020-01-06')],
    ]);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledWith(3);
    // only the versions of the valid days are asked for
    expect(calls[1].params).toMatchObject({ days: [days[0], days[3]], versions: [10, 41] });
  });

  it('reads nothing of the table when no requested day is valid', async () => {
    // a valid day outside the days asked for does not count
    const { ch, calls } = fakeClickHouse([sentinel('2020-01-02', 10)], [stored(USD, '2020-01-02', 10, '4')]);
    const { service } = fakeRates(() => 6);
    const daily = new DailyRates(ch, service);
    const got = await daily.rates([USD], ['2020-01-01', '2020-01-03']);
    expect(tableOf(got, USD)).toEqual([
      ['2020-01-01', '6'],
      ['2020-01-03', '6'],
    ]);
    expect(calls).toHaveLength(1); // the valid days only
  });

  it('on-read days go in runs of consecutive days of at most 3000', async () => {
    const { ch } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates();
    const daily = new DailyRates(ch, service);
    const runsOf = () =>
      dailyNativeRates.mock.calls.map(([assets, from, to]) => [
        assets.map(assetKey),
        from.toISOString(),
        to.toISOString(),
      ]);

    await daily.rates([USD], ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-10']);
    expect(runsOf()).toEqual([
      [[assetKey(USD)], '2020-01-01T00:00:00.000Z', '2020-01-04T00:00:00.000Z'],
      [[assetKey(USD)], '2020-01-10T00:00:00.000Z', '2020-01-11T00:00:00.000Z'],
    ]);

    // days out of order and repeated make the same runs; across a month and a year end, and a leap day
    dailyNativeRates.mockClear();
    await daily.rates([EUR], ['2020-03-01', '2019-12-31', '2020-02-29', '2020-01-01', '2020-03-01']);
    expect(runsOf()).toEqual([
      [[assetKey(EUR)], '2019-12-31T00:00:00.000Z', '2020-01-02T00:00:00.000Z'],
      [[assetKey(EUR)], '2020-02-29T00:00:00.000Z', '2020-03-02T00:00:00.000Z'],
    ]);

    expect(ON_READ_RUN_DAYS).toBe(3000);
    for (const [n, sizes] of [
      [3000, [3000]],
      [3001, [3000, 1]],
      [3500, [3000, 500]],
      [6000, [3000, 3000]],
    ] as const) {
      dailyNativeRates.mockClear();
      const days = daysFrom('2001-01-01', n);
      await new DailyRates(ch, service).rates([USD], days);
      expect(dailyNativeRates.mock.calls.map(([, from, to]) => (to.getTime() - from.getTime()) / DAY_MS)).toEqual(
        sizes,
      );
      // the runs follow one another, from the first day to the day after the last
      const calls = dailyNativeRates.mock.calls;
      expect(calls[0][1]).toEqual(midnight(days[0]));
      expect(calls[calls.length - 1][2].getTime()).toBe(midnight(days[n - 1]).getTime() + DAY_MS);
      calls.slice(1).forEach(([, from], i) => expect(from).toEqual(calls[i][2]));
    }
  });

  it('computes each asset on its own: its days, its runs, one onRead for all of them', async () => {
    const { ch } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates((asset, day) => (asset.currency === 'USD' ? 2 : 4));
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { onRead });

    const got = await daily.rates([USD, EUR, USD], ['2020-01-01', '2020-01-02', '2020-01-05']);

    expect(tableOf(got, USD)).toEqual([
      ['2020-01-01', '2'],
      ['2020-01-02', '2'],
      ['2020-01-05', '2'],
    ]);
    expect(tableOf(got, EUR).map(([, rate]) => rate)).toEqual(['4', '4', '4']);
    // every call has one asset
    expect(dailyNativeRates.mock.calls.map(([assets]) => assets.map(assetKey))).toEqual([
      [assetKey(USD)],
      [assetKey(USD)],
      [assetKey(EUR)],
      [assetKey(EUR)],
    ]);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledWith(6);
  });

  it('works through several runs at once, but not through all of them at once', async () => {
    const { ch } = fakeClickHouse([], []);
    let running = 0;
    let peak = 0;
    const dailyNativeRates = jest.fn(async (assets: Asset[], from: Date, to: Date) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return new Map(
        assets.map((asset) => [
          assetKey(asset),
          new Map(
            daysFrom(from.toISOString().slice(0, 10), (to.getTime() - from.getTime()) / DAY_MS).map((d) => [
              d,
              new BigNumber(1),
            ]),
          ),
        ]),
      );
    });
    const service = { nativeCurrency: 'XRP', dailyNativeRates } as unknown as RatesService;
    const assets = Array.from({ length: 20 }, (_, i): Asset => ({ currency: `A${i}`, issuer: ISSUER }));
    await new DailyRates(ch, service).rates(assets, ['2020-01-01']);
    expect(dailyNativeRates).toHaveBeenCalledTimes(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('what it computes on read is cached for 60 s per asset and day', async () => {
    const { ch } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates((asset, day) => `${day.slice(-2)}.5`);
    const cache = new FakeCache();
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { cache, onRead });
    const days = ['2020-01-01', '2020-01-02'];

    const first = await daily.rates([USD], days);
    expect(tableOf(first, USD)).toEqual([
      ['2020-01-01', '1.5'],
      ['2020-01-02', '2.5'],
    ]);
    expect(dailyNativeRates).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenLastCalledWith(2);
    expect(ON_READ_CACHE_MS).toBe(60_000);
    expect(cache.sets).toEqual([
      { key: `daily-rate:${assetKey(USD)}:2020-01-01`, ttlMs: 60_000 },
      { key: `daily-rate:${assetKey(USD)}:2020-01-02`, ttlMs: 60_000 },
    ]);

    // within 60 s: from the cache, the same rates, no call and no onRead
    cache.now += 59_999;
    const again = await daily.rates([USD], days);
    expect(tableOf(again, USD)).toEqual(tableOf(first, USD));
    expect(dailyNativeRates).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
    for (const perDay of again.values()) for (const rate of perDay.values()) expect(rate).toBeInstanceOf(BigNumber);

    // a day that is not cached is computed alone, and counted as one
    await daily.rates([USD], ['2020-01-02', '2020-01-03']);
    expect(dailyNativeRates).toHaveBeenCalledTimes(2);
    expect(dailyNativeRates.mock.calls[1].slice(1)).toEqual([midnight('2020-01-03'), midnight('2020-01-04')]);
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(onRead).toHaveBeenLastCalledWith(1);

    // after 60 s: computed again (the entries of the first two days have expired; the third was cached later)
    cache.now += 1;
    await daily.rates([USD], days);
    expect(dailyNativeRates).toHaveBeenCalledTimes(3);
    expect(dailyNativeRates.mock.calls[2].slice(1)).toEqual([midnight('2020-01-01'), midnight('2020-01-03')]);
    expect(onRead).toHaveBeenCalledTimes(3);
    expect(onRead).toHaveBeenLastCalledWith(2);
  });

  it('caches a rate of 0 too, and cached rates are per asset', async () => {
    const { ch } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates((asset) => (asset.currency === 'USD' ? 0 : 3));
    const daily = new DailyRates(ch, service, { cache: new FakeCache() });
    await daily.rates([USD], ['2020-01-01']);
    const got = await daily.rates([USD, EUR], ['2020-01-01']);
    expect(tableOf(got, USD)).toEqual([['2020-01-01', '0']]);
    expect(tableOf(got, EUR)).toEqual([['2020-01-01', '3']]);
    // USD was cached, EUR was not
    expect(dailyNativeRates.mock.calls.map(([assets]) => assets.map(assetKey))).toEqual([
      [assetKey(USD)],
      [assetKey(EUR)],
    ]);
  });

  it('does not cache what the table gave, and works without a cache or an onRead', async () => {
    const days = daysFrom('2020-01-01', 2);
    const { ch } = fakeClickHouse([sentinel(days[0], 10)], [stored(USD, days[0], 10, '4')]);
    const cache = new FakeCache();
    const { service } = fakeRates(() => 5);
    const got = await new DailyRates(ch, service, { cache }).rates([USD], days);
    expect(tableOf(got, USD)).toEqual([
      [days[0], '4'],
      [days[1], '5'],
    ]);
    expect(cache.sets.map(({ key }) => key)).toEqual([`daily-rate:${assetKey(USD)}:${days[1]}`]);

    const bare = await new DailyRates(ch, service).rates([USD], days);
    expect(tableOf(bare, USD)).toEqual(tableOf(got, USD));
  });

  it('ignores a cache entry that is not the text of a rate', async () => {
    const { ch } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates(() => 7);
    const cache = new FakeCache();
    cache.set(`daily-rate:${assetKey(USD)}:2020-01-01`, { not: 'a rate' }, 60_000);
    const got = await new DailyRates(ch, service, { cache }).rates([USD], ['2020-01-01']);
    expect(tableOf(got, USD)).toEqual([['2020-01-01', '7']]);
    expect(dailyNativeRates).toHaveBeenCalledTimes(1);
  });

  it('gives an issued currency without an issuer no rate, with no read for it', async () => {
    const { ch, calls } = fakeClickHouse([], []);
    const { service, dailyNativeRates } = fakeRates(() => 9);
    const got = await new DailyRates(ch, service).rates([{ currency: 'USD' }, XRP], ['2020-01-01']);
    expect(tableOf(got, { currency: 'USD' })).toEqual([['2020-01-01', '0']]);
    expect(tableOf(got, XRP)).toEqual([['2020-01-01', '1']]);
    expect(calls).toEqual([]);
    expect(dailyNativeRates).not.toHaveBeenCalled();
  });

  it('no assets, or no days, reads nothing', async () => {
    const { ch, calls } = fakeClickHouse([sentinel('2020-01-01', 10)], []);
    const { service, dailyNativeRates } = fakeRates();
    const onRead = jest.fn();
    const daily = new DailyRates(ch, service, { onRead });

    expect((await daily.rates([], ['2020-01-01'])).size).toBe(0);
    const noDays = await daily.rates([USD, XRP], []);
    expect([...noDays.keys()]).toEqual([assetKey(USD), assetKey(XRP)]);
    expect([...noDays.values()].map((perDay) => perDay.size)).toEqual([0, 0]);
    expect((await daily.rates([], [])).size).toBe(0);

    expect(calls).toEqual([]);
    expect(dailyNativeRates).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });
});

import { MarketsPeriod, ratio } from '@gatehub/data-api-shared';
import { CacheService } from '../common/cache.service';
import { StoredMarket, StoredMarketsSet } from '../network/markets-object';
import { MarketsService } from '../network/markets.service';
import {
  assetKeyOf,
  indexMarkets,
  MarketsSnapshot,
  TOKEN_MARKETS_CACHE_MS,
  tokenMarketFacts,
  TokenMarkets,
  tokenMarkets,
} from './token-markets';
import { TOKEN_MARKET_KEYS } from './token-objects';

/** Freezes the whole structure: the functions are pure and a write to their input would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const OTHER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const NPUSD = '4E50555344000000000000000000000000000000';
const TOKEN = { currency: NPUSD, issuer: ISSUER };
const sec = (text: string): number => Date.parse(text) / 1000;

const BASE = {
  count: 1,
  base_volume: '1',
  counter_volume: '1',
  native_volume: null,
  open: '1',
  high: '1',
  low: '1',
  last: '1',
  open_time: sec('2026-10-24T00:00:10Z'),
  last_time: sec('2026-10-24T14:02:51Z'),
  closes: [],
  amm_share: null,
  amm_pool: null,
};

/** A stored pair: the given sides over the defaults above. */
const pair = (base: [string, string], counter: [string, string], over: Partial<StoredMarket> = {}): StoredMarket => ({
  ...BASE,
  base_currency: base[0],
  base_issuer: base[1],
  counter_currency: counter[0],
  counter_issuer: counter[1],
  ...over,
});

/** NPUSD against the native currency, the token being the base: 0.4096 up to 0.4101, a rise of 0.12 percent. */
const TOKEN_XRP = pair([NPUSD, ISSUER], ['XRP', ''], {
  count: 1402,
  base_volume: '17361000',
  counter_volume: '7120000',
  native_volume: '7120000',
  open: '0.4096',
  last: '0.4101',
  amm_pool: 1,
});

/** The same trades as `TOKEN_XRP` stored the other way round: the native currency is the base, the token the counter. */
const XRP_TOKEN = pair(['XRP', ''], [NPUSD, ISSUER], {
  count: 1402,
  base_volume: '7120000',
  counter_volume: '17361000',
  native_volume: '7120000',
  open: ratio(1, '0.4096').toFixed(),
  last: ratio(1, '0.4101').toFixed(),
  amm_pool: 1,
});

/** The sets of a snapshot from their pairs, frozen: the functions are pure and a write to the input would throw. */
const snapshotOf = (day?: StoredMarket[], month?: StoredMarket[]): MarketsSnapshot => ({
  ...(day && { day: { total_native_volume: '58400000', byAsset: indexMarkets(deepFreeze(day)) } }),
  ...(month && { month: { byAsset: indexMarkets(deepFreeze(month)) } }),
});

describe('indexMarkets', () => {
  it('keys a pair under both of its sides, `currency|issuer`, the native currency with no issuer', () => {
    const index = indexMarkets([TOKEN_XRP]);
    expect([...index.keys()].sort()).toEqual([`${NPUSD}|${ISSUER}`, 'XRP|']);
    expect(index.get(`${NPUSD}|${ISSUER}`)).toEqual([TOKEN_XRP]);
    expect(index.get('XRP|')).toEqual([TOKEN_XRP]);
  });

  it('collects the pairs of an asset in the order given', () => {
    const eur = pair([NPUSD, ISSUER], ['EUR', OTHER]);
    const index = indexMarkets([TOKEN_XRP, eur]);
    expect(index.get(`${NPUSD}|${ISSUER}`)).toEqual([TOKEN_XRP, eur]);
    expect(index.get(`EUR|${OTHER}`)).toEqual([eur]);
    expect(index.get('XRP|')).toEqual([TOKEN_XRP]);
  });

  it('is empty for no pairs', () => {
    expect(indexMarkets([]).size).toBe(0);
  });

  it('assetKeyOf is the key of the index', () => {
    expect(assetKeyOf(TOKEN)).toBe(`${NPUSD}|${ISSUER}`);
    expect(assetKeyOf({ currency: 'XRP', issuer: '' })).toBe('XRP|');
  });
});

describe('tokenMarkets', () => {
  it('serves the pair of a token on the base side as stored', () => {
    expect(tokenMarkets(snapshotOf([TOKEN_XRP]), TOKEN)).toEqual([
      {
        counter_currency: 'XRP',
        count: 1402,
        volume: '17361000',
        counter_volume: '7120000',
        native_volume: '7120000',
        last: '0.41010000',
        change: '0.12',
        last_time: '2026-10-24T14:02:51Z',
        amm_pool: true,
      },
    ]);
  });

  it('turns a pair of a token on the counter side: the same last and change, the volumes swapped', () => {
    const base = tokenMarkets(snapshotOf([TOKEN_XRP]), TOKEN);
    const counter = tokenMarkets(snapshotOf([XRP_TOKEN]), TOKEN);
    expect(counter).toEqual(base);
    expect(counter[0].last).toBe('0.41010000');
    expect(counter[0].change).toBe('0.12');
    expect(counter[0].volume).toBe('17361000');
    expect(counter[0].counter_volume).toBe('7120000');
  });

  it('names the other asset of a pair, its issuer unless it is native, from either side', () => {
    const baseSide = pair([NPUSD, ISSUER], ['EUR', OTHER]);
    const counterSide = pair(['EUR', OTHER], [NPUSD, ISSUER]);
    for (const stored of [baseSide, counterSide]) {
      const [market] = tokenMarkets(snapshotOf([stored]), TOKEN);
      expect(market.counter_currency).toBe('EUR');
      expect(market.counter_issuer).toBe(OTHER);
    }
    const [native] = tokenMarkets(snapshotOf([TOKEN_XRP]), TOKEN);
    expect(native).not.toHaveProperty('counter_issuer');
  });

  it('the keys come in the order of TOKEN_MARKET_KEYS', () => {
    const stored = pair([NPUSD, ISSUER], ['EUR', OTHER], { native_volume: '5', amm_pool: 1, open: '0.5', last: '0.6' });
    const [market] = tokenMarkets(snapshotOf([stored]), TOKEN);
    expect(Object.keys(market)).toEqual([...TOKEN_MARKET_KEYS]);
  });

  it('leaves out what the pair does not have: no native volume, no pool fact, no change for an open of 0', () => {
    const stored = pair([NPUSD, ISSUER], ['EUR', OTHER], { open: '0', last: '2' });
    const [market] = tokenMarkets(snapshotOf([stored]), TOKEN);
    expect(Object.keys(market)).toEqual([
      'counter_currency',
      'counter_issuer',
      'count',
      'volume',
      'counter_volume',
      'last',
      'last_time',
    ]);
  });

  it('serves a pool fact of false: a known absence is a value', () => {
    const [market] = tokenMarkets(snapshotOf([pair([NPUSD, ISSUER], ['EUR', OTHER], { amm_pool: 0 })]), TOKEN);
    expect(market.amm_pool).toBe(false);
  });

  it('reads a count that came back as text', () => {
    const [market] = tokenMarkets(snapshotOf([pair([NPUSD, ISSUER], ['EUR', OTHER], { count: '1402' })]), TOKEN);
    expect(market.count).toBe(1402);
  });

  it('orders by native volume, the largest first as numbers, the pairs without one last, then by count', () => {
    const at = (code: string, over: Partial<StoredMarket>): StoredMarket => pair([NPUSD, ISSUER], [code, OTHER], over);
    const day = [
      at('AAA', { native_volume: '9', count: 1 }),
      at('BBB', { native_volume: '100', count: 1 }),
      at('CCC', { native_volume: null, count: 50 }),
      at('DDD', { native_volume: null, count: 70 }),
      at('EEE', { native_volume: '100', count: 5 }),
      at('FFF', { native_volume: '1000', count: 1 }),
    ];
    expect(tokenMarkets(snapshotOf(day), TOKEN).map((m) => m.counter_currency)).toEqual([
      'FFF',
      'EEE',
      'BBB',
      'AAA',
      'DDD',
      'CCC',
    ]);
  });

  it('breaks a full tie by the counter asset, whatever the order given', () => {
    const at = (code: string): StoredMarket => pair([NPUSD, ISSUER], [code, OTHER], { native_volume: '5', count: 2 });
    const forward = tokenMarkets(snapshotOf([at('AAA'), at('BBB'), at('CCC')]), TOKEN);
    const backward = tokenMarkets(snapshotOf([at('CCC'), at('BBB'), at('AAA')]), TOKEN);
    expect(forward.map((m) => m.counter_currency)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(backward).toEqual(forward);
  });

  it('serves at most 20, the largest', () => {
    const day = Array.from({ length: 25 }, (_, i) =>
      pair([NPUSD, ISSUER], [`C${String(i).padStart(2, '0')}`, OTHER], { native_volume: String(i * 10), count: 1 }),
    );
    const markets = tokenMarkets(snapshotOf(day), TOKEN);
    expect(markets).toHaveLength(20);
    expect(markets[0].native_volume).toBe('240');
    expect(markets[19].native_volume).toBe('50');
  });

  it('is empty for a token with no pair, and without a day set', () => {
    expect(tokenMarkets(snapshotOf([pair(['USD', OTHER], ['XRP', ''])]), TOKEN)).toEqual([]);
    expect(tokenMarkets(snapshotOf(undefined, [TOKEN_XRP]), TOKEN)).toEqual([]);
    expect(tokenMarkets({}, TOKEN)).toEqual([]);
  });
});

describe('tokenMarketFacts', () => {
  it('takes the price from the native pair of the day set, with its change and time', () => {
    expect(tokenMarketFacts(snapshotOf([TOKEN_XRP]), TOKEN, 'XRP')).toEqual({
      price: '0.41010000',
      price_change: '0.12',
      price_time: '2026-10-24T14:02:51Z',
      native_volume: '7120000',
      trades: 1402,
    });
  });

  it('turns the native pair of a token on the counter side to native per token', () => {
    expect(tokenMarketFacts(snapshotOf([XRP_TOKEN]), TOKEN, 'XRP')).toEqual(
      tokenMarketFacts(snapshotOf([TOKEN_XRP]), TOKEN, 'XRP'),
    );
  });

  it('the keys come in the order of the fields of a row', () => {
    expect(Object.keys(tokenMarketFacts(snapshotOf([TOKEN_XRP]), TOKEN, 'XRP'))).toEqual([
      'price',
      'price_change',
      'price_time',
      'native_volume',
      'trades',
    ]);
  });

  it('takes the price from the month set when the day set has no native pair: its time, no change', () => {
    const month = pair([NPUSD, ISSUER], ['XRP', ''], {
      open: '0.3',
      last: '0.35',
      last_time: sec('2026-10-20T08:00:00Z'),
    });
    const eur = pair([NPUSD, ISSUER], ['EUR', OTHER], { native_volume: '40', count: 3 });
    const facts = tokenMarketFacts(snapshotOf([eur], [month]), TOKEN, 'XRP');
    expect(facts).toEqual({
      price: '0.35000000',
      price_time: '2026-10-20T08:00:00Z',
      native_volume: '40',
      trades: 3,
    });
    expect(facts).not.toHaveProperty('price_change');
  });

  it('prefers the day pair over the month pair', () => {
    const month = pair([NPUSD, ISSUER], ['XRP', ''], { last: '0.35' });
    expect(tokenMarketFacts(snapshotOf([TOKEN_XRP], [month]), TOKEN, 'XRP').price).toBe('0.41010000');
  });

  it('turns the month pair of a token on the counter side too', () => {
    const month = pair(['XRP', ''], [NPUSD, ISSUER], { last: '4' });
    expect(tokenMarketFacts(snapshotOf(undefined, [month]), TOKEN, 'XRP').price).toBe('0.25000000');
  });

  it('has no price without a native pair in either set, and the volume and trades of the day set only', () => {
    const eur = pair([NPUSD, ISSUER], ['EUR', OTHER], { native_volume: '40', count: 3 });
    expect(tokenMarketFacts(snapshotOf([eur], [eur]), TOKEN, 'XRP')).toEqual({ native_volume: '40', trades: 3 });
  });

  it('a pair against a currency that is not the native one is no native pair, whatever its name (XRP is a token on Xahau)', () => {
    const xrpToken = pair([NPUSD, ISSUER], ['XRP', OTHER], { native_volume: '7', count: 2 });
    const facts = tokenMarketFacts(snapshotOf([xrpToken]), TOKEN, 'XAH');
    expect(facts).toEqual({ native_volume: '7', trades: 2 });
  });

  it('sums the native volume of the pairs that have one, and the trades of all of them', () => {
    const day = [
      TOKEN_XRP,
      pair([NPUSD, ISSUER], ['EUR', OTHER], { native_volume: '100.5', count: 12 }),
      pair(['BTC', OTHER], [NPUSD, ISSUER], { native_volume: null, count: 30 }),
    ];
    expect(tokenMarketFacts(snapshotOf(day), TOKEN, 'XRP')).toMatchObject({ native_volume: '7120100.5', trades: 1444 });
  });

  it('writes the sum as plain digits, never as an exponent', () => {
    const day = [
      pair([NPUSD, ISSUER], ['EUR', OTHER], { native_volume: '0.0000001', count: 1 }),
      pair([NPUSD, ISSUER], ['USD', OTHER], { native_volume: '0.0000002', count: 1 }),
    ];
    expect(tokenMarketFacts(snapshotOf(day), TOKEN, 'XRP').native_volume).toBe('0.0000003');
  });

  it('reads a count that came back as text', () => {
    const day = [
      pair([NPUSD, ISSUER], ['EUR', OTHER], { count: '1402' }),
      pair([NPUSD, ISSUER], ['USD', OTHER], { count: 8 }),
    ];
    expect(tokenMarketFacts(snapshotOf(day), TOKEN, 'XRP').trades).toBe(1410);
  });

  it('is "0" and 0 for a token with no pair in a day set that exists', () => {
    expect(tokenMarketFacts(snapshotOf([pair(['USD', OTHER], ['XRP', ''])]), TOKEN, 'XRP')).toEqual({
      native_volume: '0',
      trades: 0,
    });
  });

  it('has neither volume nor trades without a day set, and no price without a month set either', () => {
    expect(tokenMarketFacts({}, TOKEN, 'XRP')).toEqual({});
    expect(tokenMarketFacts(snapshotOf(undefined, [TOKEN_XRP]), TOKEN, 'XRP')).toEqual({
      price: '0.41010000',
      price_time: '2026-10-24T14:02:51Z',
    });
  });
});

describe('TokenMarkets', () => {
  const setOf = (markets: StoredMarket[], total = '243.5'): StoredMarketsSet => ({
    start_time: 0,
    end_time: 0,
    pairs_traded: markets.length,
    total_count: 0,
    total_native_volume: total,
    total_amm_share: null,
    markets,
  });

  /** A `TokenMarkets` over a stub of the sets, and the cache it reads through. */
  function build(sets: Partial<Record<MarketsPeriod, StoredMarketsSet>>) {
    const newestSet = jest.fn(async (period: MarketsPeriod) => Promise.resolve(sets[period]));
    const cache = new CacheService();
    const markets = new TokenMarkets({ newestSet } as unknown as MarketsService, cache);
    return { newestSet, cache, markets };
  }

  afterEach(() => jest.useRealTimers());

  it('is the newest include sets of day and 30day: the total of the day, and each set indexed by its assets', async () => {
    const { newestSet, markets } = build({
      day: setOf([TOKEN_XRP], '243.5'),
      '30day': setOf([XRP_TOKEN, pair(['USD', OTHER], ['XRP', ''])], '999'),
    });
    const snapshot = await markets.snapshot();
    expect(newestSet.mock.calls).toEqual([
      ['day', 'include'],
      ['30day', 'include'],
    ]);
    expect(snapshot.day?.total_native_volume).toBe('243.5');
    expect(snapshot.day?.byAsset.get(assetKeyOf(TOKEN))).toEqual([TOKEN_XRP]);
    expect(snapshot.month?.byAsset.get(assetKeyOf(TOKEN))).toEqual([XRP_TOKEN]);
    expect(snapshot.month).not.toHaveProperty('total_native_volume');
    // what the pure functions take
    expect(tokenMarketFacts(snapshot, TOKEN, 'XRP').native_volume).toBe('7120000');
  });

  it('leaves out the set that is not there: no day, no month', async () => {
    expect(await build({}).markets.snapshot()).toEqual({});
    const onlyMonth = await build({ '30day': setOf([TOKEN_XRP]) }).markets.snapshot();
    expect(Object.keys(onlyMonth)).toEqual(['month']);
    const onlyDay = await build({ day: setOf([TOKEN_XRP]) }).markets.snapshot();
    expect(Object.keys(onlyDay)).toEqual(['day']);
  });

  it('keeps each set 30 s in the global cache under a fixed key, and the misses that come together share one read', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-24T14:00:00Z') });
    const { newestSet, cache, markets } = build({ day: setOf([TOKEN_XRP]), '30day': setOf([XRP_TOKEN]) });
    const wrap = jest.spyOn(cache, 'wrap');

    await Promise.all([markets.snapshot(), markets.snapshot(), markets.snapshot()]);
    expect(newestSet).toHaveBeenCalledTimes(2);
    // two keys and no other, whatever is asked: nothing of a request is in a key
    expect([...new Set(wrap.mock.calls.map(([key, ttl]) => `${key} ${ttl}`))].sort()).toEqual([
      `token-markets:30day ${TOKEN_MARKETS_CACHE_MS}`,
      `token-markets:day ${TOKEN_MARKETS_CACHE_MS}`,
    ]);
    expect(TOKEN_MARKETS_CACHE_MS).toBe(30_000);

    jest.setSystemTime(Date.now() + TOKEN_MARKETS_CACHE_MS - 1);
    await markets.snapshot();
    expect(newestSet).toHaveBeenCalledTimes(2);
    jest.setSystemTime(Date.now() + 2);
    await markets.snapshot();
    expect(newestSet).toHaveBeenCalledTimes(4);
  });

  it('is read again once the cache is cleared (the clear route of the e2e suites), and a failed read is not kept', async () => {
    const { newestSet, cache, markets } = build({ day: setOf([TOKEN_XRP]) });
    await markets.snapshot();
    cache.clear();
    await markets.snapshot();
    expect(newestSet).toHaveBeenCalledTimes(4);

    cache.clear();
    newestSet.mockRejectedValueOnce(new Error('clickhouse is down'));
    await expect(markets.snapshot()).rejects.toThrow('clickhouse is down');
    expect(Object.keys(await markets.snapshot())).toEqual(['day']);
  });
});

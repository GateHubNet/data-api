import { ClickHouseService } from '@gatehub/data-api-shared';
import { LedgerRangeResolver } from '../src/common/ledger-range.service';
import { Harness, startHarness } from './harness';
import { fixtureSource } from './support/fixtures';

/** The ripple-mock ledgers as (index, close time in unix seconds), ascending. */
const MOCK = fixtureSource('ripple-mock')
  .list()
  .map((l) => ({ index: l.header.ledger_index, close: l.header.close_time }));

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const secondsBefore = (close: number, s: number) => new Date((close - s) * 1000);

/** Counts the SELECTs the resolver sends. */
function countQueries(ch: ClickHouseService): jest.SpyInstance {
  return jest.spyOn(ch, 'query');
}

describe('LedgerRangeResolver on an empty database', () => {
  let h: Harness;
  let resolver: LedgerRangeResolver;
  beforeAll(async () => {
    h = await startHarness();
    resolver = new LedgerRangeResolver(h.ch);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('resolve returns null', async () => {
    expect(await resolver.resolve()).toBeNull();
    expect(await resolver.resolve(day('2015-01-14'), day('2015-01-15'))).toBeNull();
  });

  it('has no latest ledger and no ledger at or before a date', async () => {
    expect(await resolver.latest()).toBeUndefined();
    expect(await resolver.ledgerAtOrBefore(day('2015-01-14'))).toBeUndefined();
  });
});

describe('LedgerRangeResolver on the ripple-mock ledgers', () => {
  let h: Harness;
  let resolver: LedgerRangeResolver;
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock' });
    resolver = new LedgerRangeResolver(h.ch);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('resolves the 2015-01-14 window to the first and last mock ledger of that day', async () => {
    const onTheDay = MOCK.filter(
      (l) => l.close >= day('2015-01-14').getTime() / 1000 && l.close < day('2015-01-15').getTime() / 1000,
    );
    expect(onTheDay.length).toBeGreaterThan(30);
    const expected = { min: onTheDay[0].index, max: onTheDay[onTheDay.length - 1].index };
    expect(expected).toEqual({ min: 11118827, max: 11120176 });
    expect(await resolver.resolve(day('2015-01-14'), day('2015-01-15'))).toEqual(expected);
  });

  it('resolves the other mock days, and open ends', async () => {
    expect(await resolver.resolve(day('2015-02-09'), day('2015-02-10'))).toEqual({ min: 11616399, max: 11618225 });
    expect(await resolver.resolve(day('2016-01-01'))).toEqual({ min: 20005122, max: 29709909 });
    expect(await resolver.resolve(undefined, day('2014-01-01'))).toEqual({ min: 1021029, max: 2964124 });
    expect(await resolver.resolve()).toEqual({ min: 1021029, max: 29709909 });
  });

  it('start is inclusive and end is exclusive', async () => {
    // 11119599 closed at 18:27:00, 11119600 and 11119601 at 18:27:10
    const t = (hhmmss: string) => new Date(`2015-01-14T${hhmmss}Z`);
    expect(await resolver.resolve(t('18:27:10'), t('18:27:20'))).toEqual({ min: 11119600, max: 11119601 });
    expect(await resolver.resolve(t('18:27:10'), t('18:27:10'))).toBeNull();
    expect(await resolver.resolve(t('18:27:11'), t('18:27:20'))).toBeNull();
    expect(await resolver.resolve(t('18:27:00'), t('18:27:10'))).toEqual({ min: 11119599, max: 11119599 });
  });

  it('is null for a window in 2030, before the first ledger and between ledgers', async () => {
    expect(await resolver.resolve(day('2030-01-01'), day('2031-01-01'))).toBeNull();
    expect(await resolver.resolve(day('2000-01-01'), day('2001-01-01'))).toBeNull();
    expect(await resolver.resolve(day('2015-03-01'), day('2015-12-31'))).toBeNull();
    expect(await resolver.resolve(day('2015-01-15'), day('2015-01-14'))).toBeNull();
  });

  it('ledgerAtOrBefore(1 second before ledger X closed) is the previous mock ledger', async () => {
    const x = MOCK.find((l) => l.index === 11119602)!;
    expect(await resolver.ledgerAtOrBefore(secondsBefore(x.close, 1))).toBe(11119601);
    expect(await resolver.ledgerAtOrBefore(secondsBefore(x.close, 1))).toBe(x.index - 1);
  });

  it('ledgerAtOrBefore agrees with the fixture for every mock ledger, on the close time and a second before it', async () => {
    for (const { index, close } of MOCK) {
      const atOrBefore = (limit: number) => MOCK.filter((l) => l.close <= limit).pop()?.index;
      expect(await resolver.ledgerAtOrBefore(new Date(close * 1000))).toBe(atOrBefore(close));
      expect(await resolver.ledgerAtOrBefore(new Date(close * 1000))).toBeGreaterThanOrEqual(index);
      expect(await resolver.ledgerAtOrBefore(secondsBefore(close, 1))).toBe(atOrBefore(close - 1));
    }
  });

  it('ledgerAtOrBefore is undefined before the first ledger and the last ledger after the last one', async () => {
    expect(await resolver.ledgerAtOrBefore(day('2013-01-01'))).toBeUndefined();
    expect(await resolver.ledgerAtOrBefore(day('2099-01-01'))).toBe(29709909);
  });

  it('latest is the highest committed ledger', async () => {
    expect(await resolver.latest()).toBe(29709909);
  });

  it('counts a ledger only when its commit marker (the ledgers row) is there', async () => {
    // A ledger whose child rows were written but whose ledgers row was not does not exist for the API.
    await h.ch.insert('transactions', [
      {
        ledger_index: 99999999,
        tx_index: 0,
        hash: 'AB',
        tx_type: 'Payment',
        result: 'tesSUCCESS',
        account: 'rX',
        sequence: 1,
        fee: '10',
        close_time: 4000000000,
        tx_json: '{}',
        meta_json: '{}',
      },
    ]);
    expect(await resolver.latest()).toBe(29709909);
    expect(await resolver.resolve(day('2100-01-01'))).toBeNull();
  });

  it('answers a repeated historical resolution from memory', async () => {
    const query = countQueries(h.ch);
    expect(await resolver.resolve(day('2016-03-28'), day('2016-03-29'))).toEqual({ min: 20005122, max: 20005122 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(await resolver.resolve(day('2016-03-28'), day('2016-03-29'))).toEqual({ min: 20005122, max: 20005122 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('binds the dates as parameters (no SQL text carries them)', async () => {
    const query = countQueries(h.ch);
    await resolver.resolve(day('2015-03-09'), day('2015-03-10'));
    for (const [sql, params] of query.mock.calls) {
      expect(String(sql)).not.toMatch(/2015|14\d{8}/);
      expect(params).toEqual({ secs: expect.any(Number) });
    }
  });
});

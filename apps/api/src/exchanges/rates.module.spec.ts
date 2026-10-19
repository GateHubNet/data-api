import { ClickHouseService, DailyRates, getNetworkProfile, RatesService } from '@gatehub/data-api-shared';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import BigNumber from 'bignumber.js';
import { CacheService } from '../common/cache.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { RATES_CACHE, RatesModule } from './rates.module';

const USD = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };

/** What the CommonModule gives every endpoint module, with a ClickHouse that has no valid day. */
@Global()
@Module({
  providers: [
    { provide: ClickHouseService, useValue: { query: async () => [] } },
    { provide: NETWORK_PROFILE, useValue: getNetworkProfile('xrpl') },
    CacheService,
    PrometheusService,
  ],
  exports: [ClickHouseService, NETWORK_PROFILE, CacheService, PrometheusService],
})
class FakeCommonModule {}

/** What a module that imports the RatesModule can inject. */
@Injectable()
class Consumer {
  constructor(readonly daily: DailyRates) {}
}

@Module({ imports: [RatesModule], providers: [Consumer] })
class ConsumerModule {}

const countOf = async (metrics: PrometheusService): Promise<number> =>
  (await metrics.ratesOnReadTotal.get()).values.reduce((sum, v) => sum + v.value, 0);

describe('RatesModule', () => {
  it('provides DailyRates with a CacheService of its own (RATES_CACHE, not the shared one) and the rates-on-read metric, and exports it', async () => {
    // a rate of 4 on the first day asked for and 5 on the second
    const dailyNativeRates = jest.fn(async (_assets: unknown[], from: Date) => {
      const second = new Date(from.getTime() + 86_400_000);
      return new Map([
        [
          `USD.${USD.issuer}`,
          new Map([
            [from.toISOString().slice(0, 10), new BigNumber(4)],
            [second.toISOString().slice(0, 10), new BigNumber(5)],
          ]),
        ],
      ]);
    });
    const moduleRef = await Test.createTestingModule({ imports: [FakeCommonModule, ConsumerModule] })
      .overrideProvider(RatesService)
      .useValue({ nativeCurrency: 'XRP', dailyNativeRates })
      .compile();
    const daily = moduleRef.get(Consumer).daily;
    const shared = moduleRef.get(CacheService);
    const cache = moduleRef.get<CacheService>(RATES_CACHE, { strict: false });
    const metrics = moduleRef.get(PrometheusService);
    expect(daily).toBeInstanceOf(DailyRates);
    expect(daily.nativeCurrency).toBe('XRP');
    // its cache is an instance of its own: what the shared one holds (node answers) and what DailyRates keeps cannot evict each other
    expect(cache).toBeInstanceOf(CacheService);
    expect(cache).not.toBe(shared);

    // no valid day: both days are computed on read, kept in the CacheService and counted
    const before = await countOf(metrics);
    const got = await daily.rates([USD], ['2020-01-01', '2020-01-02']);
    expect(
      [...(got.get(`USD.${USD.issuer}`) as Map<string, BigNumber>).values()].map((rate) => rate.toFixed()),
    ).toEqual(['4', '5']);
    expect(await countOf(metrics)).toBe(before + 2);
    expect(cache.get(`daily-rate:USD.${USD.issuer}:2020-01-02`)).toBe('5');
    expect(shared.get(`daily-rate:USD.${USD.issuer}:2020-01-02`)).toBeUndefined();
    expect(await metrics.getMetrics()).toContain('# TYPE api_rates_on_read_total counter');

    // within a minute they come from the cache: nothing is computed and nothing is counted
    await daily.rates([USD], ['2020-01-01', '2020-01-02']);
    expect(dailyNativeRates).toHaveBeenCalledTimes(1);
    expect(await countOf(metrics)).toBe(before + 2);

    // the shared cache is not theirs: clearing it keeps them; `clear()` of their own is what the e2e suites call between tests
    shared.clear();
    await daily.rates([USD], ['2020-01-01', '2020-01-02']);
    expect(dailyNativeRates).toHaveBeenCalledTimes(1);
    cache.clear();
    await daily.rates([USD], ['2020-01-01', '2020-01-02']);
    expect(dailyNativeRates).toHaveBeenCalledTimes(2);
    expect(await countOf(metrics)).toBe(before + 4);
  });
});

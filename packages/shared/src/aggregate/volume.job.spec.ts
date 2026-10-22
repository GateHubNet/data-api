import BigNumber from 'bignumber.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MarketsConfig } from '../network/network-profile';
import { SwapTotals } from './amm-daily.job';
import {
  assertValidMarketsConfig,
  componentFeesEst,
  computeDailyVolumeSet,
  computeLiveVolumeSet,
  LIVE_PERIOD_SECONDS,
  livePeriodsOf,
  PAYMENT_LIVE_PERIODS,
  TRADE_LIVE_PERIODS,
  VOLUME_DAY_SETTLE_MS,
  VOLUME_METRICS,
  VolumeRecomputeAborted,
} from './volume.job';

const ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const USD = { currency: 'USD', issuer: ISSUER };
const EUR = { currency: 'EUR', issuer: ISSUER };
const XRP = { currency: 'XRP' };

const config = (patch: Partial<MarketsConfig> = {}): MarketsConfig => ({
  version: 1,
  tradeMarkets: [],
  paymentCurrencies: [],
  ...patch,
});

describe('the periods and the metrics', () => {
  it('trade volume has hour, day, 3day, 7day, 30day; payment volume hour and day (the develop branch of the original also had minute)', () => {
    expect(TRADE_LIVE_PERIODS).toEqual(['hour', 'day', '3day', '7day', '30day']);
    expect(PAYMENT_LIVE_PERIODS).toEqual(['hour', 'day']);
    expect(livePeriodsOf('trade_volume')).toBe(TRADE_LIVE_PERIODS);
    expect(livePeriodsOf('payment_volume')).toBe(PAYMENT_LIVE_PERIODS);
  });

  it('the AMM volume is the third metric, after the trade and the payment volume, and has the live periods of the trade volume', () => {
    expect(VOLUME_METRICS).toEqual(['trade_volume', 'payment_volume', 'amm_volume']);
    expect(livePeriodsOf('amm_volume')).toBe(TRADE_LIVE_PERIODS);
    expect(livePeriodsOf('amm_volume')).toEqual(['hour', 'day', '3day', '7day', '30day']);
  });

  it('each period is as long as its name says, in seconds', () => {
    expect(LIVE_PERIOD_SECONDS).toEqual({
      hour: 3600,
      day: 86_400,
      '3day': 259_200,
      '7day': 604_800,
      '30day': 2_592_000,
    });
  });

  it('a daily set is final an hour after its day', () => {
    expect(VOLUME_DAY_SETTLE_MS).toBe(3_600_000);
  });
});

describe('assertValidMarketsConfig', () => {
  it('accepts the bundled configs of both networks, and an empty one', () => {
    for (const [network, native] of [
      ['xrpl', 'XRP'],
      ['xahau', 'XAH'],
    ] as const) {
      const file = join(__dirname, '..', '..', 'config', 'markets', `${network}.json`);
      expect(() =>
        assertValidMarketsConfig(JSON.parse(readFileSync(file, 'utf8')) as MarketsConfig, native),
      ).not.toThrow();
    }
    expect(() => assertValidMarketsConfig(config(), 'XRP')).not.toThrow();
  });

  it('accepts the codes of the ledger: three characters of the standard set, or 40 hexadecimal digits', () => {
    const codes = [
      'USD',
      'usd',
      'U5D',
      'BTC',
      '$$$',
      'A!B',
      '524C555344000000000000000000000000000000',
      '524c555344000000000000000000000000000000',
    ];
    expect(() =>
      assertValidMarketsConfig(
        config({ paymentCurrencies: codes.map((currency) => ({ currency, issuer: ISSUER })) }),
        'XRP',
      ),
    ).not.toThrow();
  });

  it('says what is wrong with the address and with the code', () => {
    expect(() =>
      assertValidMarketsConfig(config({ paymentCurrencies: [{ currency: 'USD', issuer: 'rNope' }] }), 'XRP'),
    ).toThrow('Invalid markets config: paymentCurrencies[0]: the issuer "rNope" is not a classic address');
    expect(() =>
      assertValidMarketsConfig(config({ paymentCurrencies: [{ currency: 'DOLLAR', issuer: ISSUER }] }), 'XRP'),
    ).toThrow('paymentCurrencies[0]: "DOLLAR" is not a currency code (three characters, or 40 hexadecimal digits)');
  });

  it('accepts a market with the native currency on either side', () => {
    expect(() =>
      assertValidMarketsConfig(
        config({
          tradeMarkets: [
            { base: USD, counter: XRP },
            { base: XRP, counter: EUR },
          ],
        }),
        'XRP',
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'a market without a currency',
      config({ tradeMarkets: [{ base: { currency: '' }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'a market without a counter',
      config({ tradeMarkets: [{ base: USD, counter: undefined as never }] }),
      'tradeMarkets[0].counter',
    ],
    [
      'an issued currency without an issuer',
      config({ tradeMarkets: [{ base: { currency: 'USD' }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'the native currency with an issuer',
      config({ tradeMarkets: [{ base: USD, counter: { currency: 'XRP', issuer: ISSUER } }] }),
      'tradeMarkets[0].counter',
    ],
    [
      'a market of an asset against itself',
      config({ tradeMarkets: [{ base: USD, counter: { ...USD } }] }),
      'tradeMarkets[0]',
    ],
    ['two native sides', config({ tradeMarkets: [{ base: XRP, counter: XRP }] }), 'tradeMarkets[0]'],
    ['a market that is not an object', config({ tradeMarkets: [null as never] }), 'tradeMarkets[0]'],
    [
      'an issuer that is not text',
      config({ tradeMarkets: [{ base: { currency: 'USD', issuer: 5 as never }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'the second market being wrong',
      config({
        tradeMarkets: [
          { base: USD, counter: XRP },
          { base: EUR, counter: EUR },
        ],
      }),
      'tradeMarkets[1]',
    ],
    [
      'a payment currency without an issuer',
      config({ paymentCurrencies: [{ currency: 'USD' }] }),
      'paymentCurrencies[0]',
    ],
    [
      'a payment currency that is not an object',
      config({ paymentCurrencies: [null as never] }),
      'paymentCurrencies[0]',
    ],
    [
      'an issuer that is not a classic address',
      config({ tradeMarkets: [{ base: { currency: 'USD', issuer: 'notanaddress' }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'an issuer whose checksum is wrong',
      config({
        tradeMarkets: [{ base: { currency: 'USD', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2X' }, counter: XRP }],
      }),
      'tradeMarkets[0].base',
    ],
    [
      'the counter issuer being no address',
      config({ tradeMarkets: [{ base: USD, counter: { currency: 'EUR', issuer: 'r' } }] }),
      'tradeMarkets[0].counter',
    ],
    [
      'a payment issuer that is no address',
      config({ paymentCurrencies: [{ currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59X' }] }),
      'paymentCurrencies[0]',
    ],
    [
      'a currency code of two characters',
      config({ tradeMarkets: [{ base: { currency: 'US', issuer: ISSUER }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'a currency code of four characters',
      config({ tradeMarkets: [{ base: { currency: 'USDT', issuer: ISSUER }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'a currency code with a space',
      config({ tradeMarkets: [{ base: { currency: 'U D', issuer: ISSUER }, counter: XRP }] }),
      'tradeMarkets[0].base',
    ],
    [
      'a hexadecimal currency code of 39 digits',
      config({ paymentCurrencies: [{ currency: '524C55534400000000000000000000000000000', issuer: ISSUER }] }),
      'paymentCurrencies[0]',
    ],
    [
      'a currency code of 40 characters that are not all hexadecimal',
      config({ paymentCurrencies: [{ currency: '524C5553440000000000000000000000000000ZZ', issuer: ISSUER }] }),
      'paymentCurrencies[0]',
    ],
    ['a version that is not a whole number', config({ version: 1.5 }), 'version'],
    ['a negative version', config({ version: -1 }), 'version'],
    ['a version past what a UInt32 holds', config({ version: 4_294_967_296 }), 'version'],
  ])('rejects %s, and says where', (_name, bad, where) => {
    expect(() => assertValidMarketsConfig(bad, 'XRP')).toThrow(where);
    expect(() => assertValidMarketsConfig(bad, 'XRP')).toThrow(/^Invalid markets config: /);
  });

  it('knows the native currency of the network: XAH has no issuer on Xahau, and XRP there is an issued currency', () => {
    expect(() =>
      assertValidMarketsConfig(config({ tradeMarkets: [{ base: USD, counter: { currency: 'XAH' } }] }), 'XAH'),
    ).not.toThrow();
    expect(() => assertValidMarketsConfig(config({ tradeMarkets: [{ base: USD, counter: XRP }] }), 'XAH')).toThrow(
      'tradeMarkets[0].counter',
    );
    expect(() =>
      assertValidMarketsConfig(config({ tradeMarkets: [{ base: USD, counter: { currency: 'XAH' } }] }), 'XRP'),
    ).toThrow('tradeMarkets[0].counter');
  });
});

describe('the set functions refuse before they read', () => {
  const never = {
    query: () => {
      throw new Error('no query expected');
    },
    insert: () => {
      throw new Error('no insert expected');
    },
  } as never;
  const rates = { nativeCurrency: 'XRP' } as never;

  it('an aborted signal throws VolumeRecomputeAborted at once', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      computeDailyVolumeSet(never, rates, config(), 'trade_volume', new Date('2026-01-01T00:00:00Z'), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(VolumeRecomputeAborted);
    await expect(
      computeLiveVolumeSet(never, rates, config(), 'payment_volume', 'hour', new Date('2026-01-01T00:00:00Z'), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(VolumeRecomputeAborted);
  });

  it('a period the metric does not have, and a date that is none, are RangeErrors', async () => {
    await expect(
      computeLiveVolumeSet(never, rates, config(), 'payment_volume', '3day', new Date('2026-01-01T00:00:00Z')),
    ).rejects.toThrow(RangeError);
    await expect(computeLiveVolumeSet(never, rates, config(), 'trade_volume', 'day', new Date(NaN))).rejects.toThrow(
      RangeError,
    );
    await expect(computeDailyVolumeSet(never, rates, config(), 'trade_volume', new Date(NaN))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('componentFeesEst', () => {
  const GBP = { currency: 'GBP', issuer: ISSUER };
  const ZED = { currency: 'ZED', issuer: ISSUER };
  const ZRO = { currency: 'ZRO', issuer: ISSUER };
  const n = (value: BigNumber.Value): BigNumber => new BigNumber(value);
  /** The fees of the window by side of the stored pool; the counts and volumes of `swapTotals` play no part. */
  const totals = (fees_base_est: string | null, fees_counter_est: string | null): SwapTotals => ({
    count: 3,
    volume_base: '1',
    volume_counter: '1',
    fees_base_est,
    fees_counter_est,
  });
  // USD/XRP: 80 USD and 160 XRP went through the pool; the component is the 80 USD, converted to its 160 XRP
  const usdXrp = { base: USD, counter: XRP, baseVolume: n(80), counterVolume: n(160) };
  const usdComponent = { base: USD, amount: n(80), converted: n(160) };

  it('a pool against the native currency: the fees of its base at the pool price, its native fees worth themselves', () => {
    // 0.105 USD x 160 / 80 + 0.4 XRP
    expect(componentFeesEst(usdComponent, usdXrp, totals('0.105', '0.4'))?.toFixed()).toBe('0.61');
    // XRP/ZED is stored with the native currency as its base and turned round: the component is the 70 ZED, converted to the
    // 140 XRP; the fees of the stored counter (ZED) are those of the side of the amount: 0.04 XRP + 0.003 ZED x 140 / 70
    const xrpZed = { base: XRP, counter: ZED, baseVolume: n(140), counterVolume: n(70) };
    expect(
      componentFeesEst({ base: ZED, amount: n(70), converted: n(140) }, xrpZed, totals('0.04', '0.003'))?.toFixed(),
    ).toBe('0.046');
  });

  it('a pool converted through its counter: the side of the amount is the stored counter, the other side is the stored base', () => {
    // EUR/USD: 20 EUR and 43 USD; EUR has no rate, USD 0.5 a coin: the component is the 43 USD, converted to 86 XRP.
    // 0.006 USD x 86 / 43 + 0.105 EUR x 86 / 20 (the EUR priced in USD by the pool, 43 / 20, then converted)
    const eurUsd = { base: EUR, counter: USD, baseVolume: n(20), counterVolume: n(43) };
    expect(
      componentFeesEst({ base: USD, amount: n(43), converted: n(86) }, eurUsd, totals('0.105', '0.006'))?.toFixed(),
    ).toBe('0.4635');
    // the same pool converted through its base (a rate of EUR, 2 a coin): the component is the 20 EUR, converted to 10 XRP.
    // 0.105 EUR x 10 / 20 + 0.006 USD x 10 / 43 = 0.0525 + 0.00139534883720930232558...
    expect(
      componentFeesEst({ base: EUR, amount: n(20), converted: n(10) }, eurUsd, totals('0.105', '0.006'))?.toFixed(18),
    ).toBe('0.053895348837209302');
  });

  it('a side whose fees are not known (a swap with no known fee, Ruling R-A26) makes the estimate unknown, on either side', () => {
    expect(componentFeesEst(usdComponent, usdXrp, totals(null, '0.4'))).toBeNull();
    expect(componentFeesEst(usdComponent, usdXrp, totals('0.105', null))).toBeNull();
    expect(componentFeesEst(usdComponent, usdXrp, totals(null, null))).toBeNull();
  });

  it('a side with fees and no volume to price them by has no estimate: the fees count every swap, the volumes only the kept ones (D8)', () => {
    // GBP/USD through the rate of GBP: no USD went through the pool among the kept swaps, but a dust swap paid a USD fee
    const gbpUsd = { base: GBP, counter: USD, baseVolume: n(60), counterVolume: n(0) };
    const gbp = { base: GBP, amount: n(60), converted: n(12) };
    expect(componentFeesEst(gbp, gbpUsd, totals('0.3', '0.001'))).toBeNull();
    // XRP/ZRO, 1 XRP for no ZRO: the component is the 0 ZRO converted to its 1 XRP (a rate of 0), and a ZRO fee was paid
    const xrpZro = { base: XRP, counter: ZRO, baseVolume: n(1), counterVolume: n(0) };
    expect(
      componentFeesEst({ base: ZRO, amount: n(0), converted: n(1) }, xrpZro, totals('0.003', '0.0001')),
    ).toBeNull();
  });

  it('a side without fees adds 0, also when it has no volume (no division, no NaN), and no fees at all is an estimate of 0', () => {
    expect(componentFeesEst(usdComponent, usdXrp, totals('0', '0'))?.toFixed()).toBe('0');
    const xrpZro = { base: XRP, counter: ZRO, baseVolume: n(1), counterVolume: n(0) };
    const zro = { base: ZRO, amount: n(0), converted: n(1) };
    // 0 ZRO of fees on 0 ZRO of volume, and 0.003 XRP
    expect(componentFeesEst(zro, xrpZro, totals('0.003', '0'))?.toFixed()).toBe('0.003');
    expect(componentFeesEst(zro, xrpZro, totals('0', '0'))?.toFixed()).toBe('0');
  });
});

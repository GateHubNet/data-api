import BigNumber from 'bignumber.js';
import { Asset } from './asset';
import { DayRates } from './daily-rates';
import { balanceChangeAsset, nativeValue, QUOTIENT_DIGITS } from './valuation';

const USD: Asset = { currency: 'USD', issuer: 'rXissuer' };
const XRP: Asset = { currency: 'XRP' };
const DAY = '2020-01-01';

const ratesOf = (rate: BigNumber.Value, asset = USD, day = DAY): DayRates =>
  new Map([[`${asset.currency}.${asset.issuer}`, new Map([[day, new BigNumber(rate)]])]]);

describe('QUOTIENT_DIGITS', () => {
  it('is the 17 significant digits of a quotient', () => {
    expect(QUOTIENT_DIGITS).toBe(17);
  });
});

describe('nativeValue', () => {
  it('values the native amount at itself, to the drop', () => {
    const amount = new BigNumber('99999999999.999999');
    const value = nativeValue(amount, XRP, DAY, new Map(), 'XRP');
    expect(value.toFixed()).toBe('99999999999.999999');
    // no rate is looked up for it: even a rate table that says otherwise changes nothing
    expect(nativeValue(new BigNumber('0.000001'), XRP, DAY, ratesOf(3, XRP), 'XRP').toFixed()).toBe('0.000001');
  });

  it('values an issued amount at amount over the rate, cut to 17 significant digits', () => {
    expect(nativeValue(new BigNumber(1), USD, DAY, ratesOf(3), 'XRP').toString()).toBe('0.33333333333333333');
    expect(nativeValue(new BigNumber(10), USD, DAY, ratesOf(4), 'XRP').toString()).toBe('2.5');
    // 17 significant digits, not 17 decimal places: a small value keeps its digits, a large one its integer part
    expect(nativeValue(new BigNumber(1), USD, DAY, ratesOf('3e20'), 'XRP').toString()).toBe('3.3333333333333333e-21');
    expect(nativeValue(new BigNumber('1e30'), USD, DAY, ratesOf(3), 'XRP').toString()).toBe('3.3333333333333333e+29');
  });

  it('values an issued amount without a rate, or with a rate of 0, at 0', () => {
    expect(nativeValue(new BigNumber(5), USD, DAY, new Map(), 'XRP').toString()).toBe('0');
    expect(nativeValue(new BigNumber(5), USD, '2020-01-02', ratesOf(3), 'XRP').toString()).toBe('0');
    expect(nativeValue(new BigNumber(5), USD, DAY, ratesOf(0), 'XRP').toString()).toBe('0');
    // an issued currency without an issuer has no rate; so does a negative one
    expect(nativeValue(new BigNumber(5), { currency: 'USD' }, DAY, ratesOf(3), 'XRP').toString()).toBe('0');
    expect(nativeValue(new BigNumber(5), USD, DAY, ratesOf(-3), 'XRP').toString()).toBe('0');
  });

  it('knows the native currency of the network: XRP is an issued currency on Xahau', () => {
    expect(nativeValue(new BigNumber(5), XRP, DAY, new Map(), 'XAH').toString()).toBe('0');
    expect(nativeValue(new BigNumber(5), { currency: 'XAH' }, DAY, new Map(), 'XAH').toString()).toBe('5');
    // an issued currency that is called like the native one is issued
    const fake: Asset = { currency: 'XRP', issuer: 'rXissuer' };
    expect(nativeValue(new BigNumber(6), fake, DAY, ratesOf(2, fake), 'XRP').toString()).toBe('3');
  });
});

describe('balanceChangeAsset', () => {
  it('is (currency, counterparty) of a line the account is owed on', () => {
    expect(balanceChangeAsset({ currency: 'USD', counterparty: 'rB', owes: false }, 'rA')).toEqual({
      currency: 'USD',
      issuer: 'rB',
    });
  });

  it('is (currency, account) of a line the account owes: it is the issuer of that', () => {
    expect(balanceChangeAsset({ currency: 'USD', counterparty: 'rB', owes: true }, 'rA')).toEqual({
      currency: 'USD',
      issuer: 'rA',
    });
  });

  it('is the currency alone for the native line, whatever it owes', () => {
    for (const owes of [false, true]) {
      const asset = balanceChangeAsset({ currency: 'XRP', counterparty: '', owes }, 'rA');
      expect(asset).toEqual({ currency: 'XRP' });
      expect(Object.keys(asset)).toEqual(['currency']);
    }
  });
});

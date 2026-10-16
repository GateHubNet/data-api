import { NodeOffer, SELL_FLAG, toOrderObject } from './order-object';

const MAKER = 'rHsZHqa5oMQNL5hFm4kfLd47aEMYjPstpg';
const GATEWAY = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const USD = (value: string) => ({ currency: 'USD', issuer: GATEWAY, value });

/** Pays 10 USD for 5 XRP. Frozen, as an input must not be changed. */
const BUY: NodeOffer = Object.freeze({
  flags: 0,
  seq: 12,
  quality: '0.000002',
  taker_gets: '5000000',
  taker_pays: Object.freeze(USD('10')),
});

describe('toOrderObject', () => {
  it('a buy: the quantity is what the offer pays (TakerPays), the total price what it gets (TakerGets)', () => {
    expect(toOrderObject(BUY, MAKER, 'XRP')).toEqual({
      specification: {
        direction: 'buy',
        quantity: { currency: 'USD', value: '10', counterparty: GATEWAY },
        totalPrice: { currency: 'XRP', value: '5' },
      },
      properties: { maker: MAKER, flags: 0, sequence: 12, makerExchangeRate: '2' },
    });
  });

  it('a sell: the other way round, and the direction says so', () => {
    const sell: NodeOffer = {
      flags: SELL_FLAG,
      seq: 13,
      quality: '500000',
      taker_gets: USD('20'),
      taker_pays: '10000000',
    };
    expect(toOrderObject(sell, MAKER, 'XRP')).toEqual({
      specification: {
        direction: 'sell',
        quantity: { currency: 'USD', value: '20', counterparty: GATEWAY },
        totalPrice: { currency: 'XRP', value: '10' },
      },
      properties: { maker: MAKER, flags: SELL_FLAG, sequence: 13, makerExchangeRate: '0.5' },
    });
  });

  it('the sell flag is bit 0x00020000: other bits do not make a sell, and do not stop one', () => {
    const direction = (flags: number) => toOrderObject({ ...BUY, flags }, MAKER, 'XRP').specification.direction;
    expect(SELL_FLAG).toBe(131072);
    expect(direction(0)).toBe('buy');
    expect(direction(0x00010000)).toBe('buy'); // passive
    expect(direction(0x00040000)).toBe('buy');
    expect(direction(0x00000002)).toBe('buy');
    expect(direction(0x00020000)).toBe('sell');
    expect(direction(0x00030000)).toBe('sell');
    expect(direction(0xffffffff)).toBe('sell');
    expect(direction(0xfffdffff)).toBe('buy');
  });

  it('keys come in the order of the original', () => {
    const order = toOrderObject(BUY, MAKER, 'XRP');
    expect(Object.keys(order)).toEqual(['specification', 'properties']);
    expect(Object.keys(order.specification)).toEqual(['direction', 'quantity', 'totalPrice']);
    expect(Object.keys(order.specification.quantity)).toEqual(['currency', 'value', 'counterparty']);
    expect(Object.keys(order.specification.totalPrice)).toEqual(['currency', 'value']);
    expect(Object.keys(order.properties)).toEqual(['maker', 'flags', 'sequence', 'makerExchangeRate']);
  });

  it('does not change its input', () => {
    expect(() => toOrderObject(BUY, MAKER, 'XRP')).not.toThrow();
  });

  describe('amounts', () => {
    it('drops become whole units of the native currency of the network, exactly, with no counterparty', () => {
      const offer = (drops: string): NodeOffer => ({ ...BUY, taker_gets: drops });
      const price = (drops: string, native = 'XRP') =>
        toOrderObject(offer(drops), MAKER, native).specification.totalPrice;
      expect(price('0')).toEqual({ currency: 'XRP', value: '0' });
      expect(price('1')).toEqual({ currency: 'XRP', value: '0.000001' });
      expect(price('12345678')).toEqual({ currency: 'XRP', value: '12.345678' });
      expect(price('99999999999999999')).toEqual({ currency: 'XRP', value: '99999999999.999999' });
      expect(price('5000000', 'XAH')).toEqual({ currency: 'XAH', value: '5' });
      expect('counterparty' in price('1')).toBe(false);
    });

    it('a token keeps its currency, value and issuer (as counterparty)', () => {
      const offer: NodeOffer = {
        flags: 0,
        seq: 1,
        quality: '2',
        taker_gets: USD('3.50'),
        taker_pays: { currency: 'EUR', issuer: GATEWAY, value: '7' },
      };
      const { quantity, totalPrice } = toOrderObject(offer, MAKER, 'XRP').specification;
      expect(quantity).toEqual({ currency: 'EUR', value: '7', counterparty: GATEWAY });
      expect(totalPrice).toEqual({ currency: 'USD', value: '3.50', counterparty: GATEWAY });
    });

    it('a token without an issuer has no counterparty', () => {
      const offer: NodeOffer = { ...BUY, taker_pays: { currency: 'USD', value: '1' } };
      expect(toOrderObject(offer, MAKER, 'XRP').specification.quantity).toEqual({ currency: 'USD', value: '1' });
    });

    it('a token named like the native currency is a token', () => {
      const offer: NodeOffer = { ...BUY, taker_gets: { currency: 'XRP', issuer: GATEWAY, value: '1' }, quality: '5' };
      const order = toOrderObject(offer, MAKER, 'XAH');
      expect(order.specification.totalPrice).toEqual({ currency: 'XRP', value: '1', counterparty: GATEWAY });
      expect(order.properties.makerExchangeRate).toBe('5'); // no native side: left alone
    });
  });

  describe('makerExchangeRate (adjustQualityForXRP)', () => {
    const rate = (quality: string | number | undefined, gets: NodeOffer['taker_gets'], pays: NodeOffer['taker_pays']) =>
      toOrderObject({ flags: 0, seq: 1, quality, taker_gets: gets, taker_pays: pays }, MAKER, 'XRP').properties
        .makerExchangeRate;

    it('a native TakerGets makes the quality 10^6 too small, a native TakerPays 10^6 too big', () => {
      expect(rate('0.000002', '5000000', USD('10'))).toBe('2');
      expect(rate('500000', USD('20'), '10000000')).toBe('0.5');
    });

    it('two tokens or two native amounts leave it as it is, written as the node wrote it', () => {
      expect(rate('2', USD('3'), { currency: 'EUR', issuer: GATEWAY, value: '6' })).toBe('2');
      expect(rate('0.0000000012', USD('3'), USD('6'))).toBe('0.0000000012');
      expect(rate('1.2e-9', USD('3'), USD('6'))).toBe('1.2e-9');
      expect(rate('7', '1000000', '2000000')).toBe('7');
    });

    it('is exact and written the way BigNumber writes a number', () => {
      expect(rate('0.0000000000123456789', '1000000', USD('1'))).toBe('0.0000123456789');
      expect(rate('12345678901234567', USD('1'), '1000000')).toBe('12345678901.234567');
      expect(rate('1e-7', '1000000', USD('1'))).toBe('0.1');
      expect(rate('4.5e-9', USD('1'), '1000000')).toBe('4.5e-15');
      expect(rate('1e21', '1000000', USD('1'))).toBe('1e+27');
    });

    it('a quality that is a number is text in the order', () => {
      expect(rate(2, USD('1'), USD('2'))).toBe('2');
      expect(rate(0.000002, '5000000', USD('10'))).toBe('2');
    });

    it('no quality, no makerExchangeRate', () => {
      const order = toOrderObject({ flags: 0, seq: 1, taker_gets: '1', taker_pays: '2' }, MAKER, 'XRP');
      expect(Object.keys(order.properties)).toEqual(['maker', 'flags', 'sequence']);
    });
  });
});

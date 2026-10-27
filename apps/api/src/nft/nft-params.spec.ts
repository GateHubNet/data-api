import { eventsParam, issuerParam, nftIdParam, offerTypeParam, rolesParam, taxonParam } from './nft-params';

/** The message of the 400 a call answers, `'no error'` when it returns, `'not a 400'` for any other failure. */
const message = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return (err as { getStatus(): number }).getStatus() === 400
      ? (err as { response: { result: string; message: string } }).response.message
      : 'not a 400';
  }
  return 'no error';
};

const ID = '00081388D7A2B1C3E5F70912345678ABCDEF0123456789ABCDEF000000000102';

describe('nftIdParam', () => {
  it('is the 64 hex digits, upper-cased: a lower-case or mixed id is accepted', () => {
    expect(nftIdParam(ID)).toBe(ID);
    expect(nftIdParam(ID.toLowerCase())).toBe(ID);
    expect(nftIdParam(`${ID.slice(0, 32).toLowerCase()}${ID.slice(32)}`)).toBe(ID);
  });

  it('answers 400 invalid nft id for 63 or 65 digits, a character that is no hex digit, and anything around the id', () => {
    for (const raw of [
      ID.slice(1),
      `${ID}0`,
      `${ID.slice(0, 63)}G`,
      ` ${ID}`,
      `${ID} `,
      `0x${ID.slice(2)}`,
      '',
      'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    ]) {
      expect([raw, message(() => nftIdParam(raw))]).toEqual([raw, 'invalid nft id']);
    }
  });
});

describe('issuerParam', () => {
  it('is a classic address, as it is', () => {
    expect(issuerParam('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
  });

  it('answers 400 invalid issuer address for anything else', () => {
    for (const raw of ['', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyT', ID, 'xyz']) {
      expect([raw, message(() => issuerParam(raw))]).toEqual([raw, 'invalid issuer address']);
    }
  });
});

describe('taxonParam', () => {
  it('is a decimal UInt32', () => {
    expect(taxonParam('0')).toBe(0);
    expect(taxonParam('1')).toBe(1);
    expect(taxonParam('4294967295')).toBe(4_294_967_295);
    expect(taxonParam('0007')).toBe(7);
  });

  it('answers 400 invalid taxon for a negative number, a decimal, a number above UInt32 and any text that is no number', () => {
    for (const raw of ['-1', '1.5', '4294967296', '99999999999', '', '1e3', '0x10', ' 1', 'abc', '+1']) {
      expect([raw, message(() => taxonParam(raw))]).toEqual([raw, 'invalid taxon']);
    }
  });
});

describe('eventsParam', () => {
  it('is the events of a comma list, in the order asked for, each once', () => {
    expect(eventsParam({ event: 'sale,mint' })).toEqual(['sale', 'mint']);
    expect(eventsParam({ event: 'mint' })).toEqual(['mint']);
    expect(eventsParam({ event: 'offer_create,offer_cancel,offer_removed' })).toEqual([
      'offer_create',
      'offer_cancel',
      'offer_removed',
    ]);
    expect(eventsParam({ event: 'sale,sale,mint,sale' })).toEqual(['sale', 'mint']);
    expect(eventsParam({ event: ['burn', 'sale'] })).toEqual(['burn']);
  });

  it('is none for a missing or empty param', () => {
    expect(eventsParam({})).toBeUndefined();
    expect(eventsParam({ event: '' })).toBeUndefined();
  });

  it('answers 400 invalid event when a member is none, also an empty one, another case or a space', () => {
    for (const event of ['sale,nope', 'nope', 'SALE', 'sale,', ',sale', 'sale,,mint', 'sale, mint', ' sale', 'all']) {
      expect([event, message(() => eventsParam({ event }))]).toEqual([event, 'invalid event']);
    }
  });
});

describe('rolesParam', () => {
  it('is the roles of a comma list', () => {
    expect(rolesParam({ role: 'issuer,broker' })).toEqual(['issuer', 'broker']);
    expect(rolesParam({ role: 'offer_owner' })).toEqual(['offer_owner']);
    expect(rolesParam({})).toBeUndefined();
    expect(rolesParam({ role: '' })).toBeUndefined();
  });

  it('answers 400 invalid role when a member is none', () => {
    for (const role of ['issuer,owner', 'owner', 'Issuer', 'issuer,']) {
      expect([role, message(() => rolesParam({ role }))]).toEqual([role, 'invalid role']);
    }
  });
});

describe('offerTypeParam', () => {
  it('is sell or buy, and none for a missing or empty param', () => {
    expect(offerTypeParam({ type: 'sell' })).toBe('sell');
    expect(offerTypeParam({ type: 'buy' })).toBe('buy');
    expect(offerTypeParam({})).toBeUndefined();
    expect(offerTypeParam({ type: '' })).toBeUndefined();
  });

  it('answers 400 invalid type for anything else', () => {
    for (const type of ['both', 'Sell', 'sell,buy', 'sells', '1']) {
      expect([type, message(() => offerTypeParam({ type }))]).toEqual([type, 'invalid type']);
    }
  });
});

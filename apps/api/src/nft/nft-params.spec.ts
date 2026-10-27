import {
  checkSaleCurrencyIssuer,
  collectionDescendingParam,
  collectionKeyParam,
  collectionSortParam,
  eventsParam,
  holdingsCollectionParam,
  issuerParam,
  nftIdParam,
  offerTypeParam,
  rolesParam,
  saleAssetParam,
  saleCurrencyParam,
  STATS_MAX_DAYS,
  statsWindowParam,
  taxonParam,
} from './nft-params';

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

describe('collectionSortParam', () => {
  it('is volume, supply or holders, and volume for a missing or empty param', () => {
    expect(collectionSortParam({})).toBe('volume');
    expect(collectionSortParam({ sort: '' })).toBe('volume');
    expect(collectionSortParam({ sort: 'volume' })).toBe('volume');
    expect(collectionSortParam({ sort: 'supply' })).toBe('supply');
    expect(collectionSortParam({ sort: ['holders', 'supply'] })).toBe('holders');
  });

  it('answers 400 invalid sort for anything else, also another case or a list', () => {
    for (const sort of ['sales', 'Volume', 'supply,holders', ' supply', 'volume_native', '1']) {
      expect([sort, message(() => collectionSortParam({ sort }))]).toEqual([sort, 'invalid sort']);
    }
  });
});

describe('collectionDescendingParam', () => {
  it('is on by default and for anything but false, which turns it off in any case', () => {
    for (const q of [{}, { descending: '' }, { descending: 'true' }, { descending: '1' }, { descending: 'yes' }]) {
      expect([q, collectionDescendingParam(q)]).toEqual([q, true]);
    }
    for (const descending of ['false', 'FALSE', 'False', ['false', 'true']]) {
      expect([descending, collectionDescendingParam({ descending })]).toEqual([descending, false]);
    }
  });
});

describe('statsWindowParam', () => {
  const NOW = new Date('2026-10-27T12:00:00Z');
  const DAY = 86_400_000;

  it('is the start and, when the request has an end, the end of the period it names (exclusive)', () => {
    const window = statsWindowParam({ start: '2026-10-01', end: '2026-10-05' }, NOW);
    expect(window.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(window.endExclusive?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(Object.keys(statsWindowParam({ start: '2026-10-01' }, NOW))).toEqual(['start']);
  });

  it('answers 400 start is required for a request with no start', () => {
    expect(message(() => statsWindowParam({}, NOW))).toBe('start is required');
    expect(message(() => statsWindowParam({ end: '2026-10-05' }, NOW))).toBe('start is required');
  });

  it('checks the start, then that there is one, then the end: the first mistake is the one reported', () => {
    expect(message(() => statsWindowParam({ start: 'x', end: 'y' }, NOW))).toBe('invalid start date format');
    expect(message(() => statsWindowParam({ start: '', end: 'y' }, NOW))).toBe('invalid start date format');
    expect(message(() => statsWindowParam({ end: 'y' }, NOW))).toBe('start is required');
    expect(message(() => statsWindowParam({ start: '2026-10-01', end: 'y' }, NOW))).toBe('invalid end date format');
  });

  it('allows a window of 366 days and answers 400 invalid window - use at most 366 days for more', () => {
    expect(STATS_MAX_DAYS).toBe(366);
    const start = new Date(NOW.getTime() - STATS_MAX_DAYS * DAY).toISOString();
    expect(statsWindowParam({ start }, NOW).start.toISOString()).toBe(start);
    const tooEarly = new Date(NOW.getTime() - STATS_MAX_DAYS * DAY - 1000).toISOString().slice(0, 19) + 'Z';
    expect(message(() => statsWindowParam({ start: tooEarly }, NOW))).toBe('invalid window - use at most 366 days');
    // the leap year 2024 has 366 days; the end names the end of its last day
    expect(statsWindowParam({ start: '2024-01-01', end: '2024-12-31' }, NOW).endExclusive?.toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    );
    expect(message(() => statsWindowParam({ start: '2024-01-01', end: '2025-01-01' }, NOW))).toBe(
      'invalid window - use at most 366 days',
    );
    expect(message(() => statsWindowParam({ start: '2020', end: '2021' }, NOW))).toBe(
      'invalid window - use at most 366 days',
    );
  });

  it('an end before the start, or a start in the future, is a window of no days and not a mistake', () => {
    expect(statsWindowParam({ start: '2026-10-05', end: '2026-10-01' }, NOW).start.toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(statsWindowParam({ start: '2030-01-01' }, NOW).start.getUTCFullYear()).toBe(2030);
  });
});

describe('collectionKeyParam', () => {
  const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

  it('is the issuer and the taxon on XRPL, and the issuer alone, taxon_key 0, on Xahau', () => {
    expect(collectionKeyParam('xrpl', ISSUER, '7')).toEqual({ issuer: ISSUER, taxon_key: 7 });
    expect(collectionKeyParam('xrpl', ISSUER, '0')).toEqual({ issuer: ISSUER, taxon_key: 0 });
    expect(collectionKeyParam('xrpl', ISSUER, '0042')).toEqual({ issuer: ISSUER, taxon_key: 42 });
    expect(collectionKeyParam('xahau', ISSUER)).toEqual({ issuer: ISSUER, taxon_key: 0 });
  });

  it("is none for the other family's form: an XRPL path with no taxon, a Xahau path with one (whatever it says)", () => {
    expect(collectionKeyParam('xrpl', ISSUER)).toBeUndefined();
    expect(collectionKeyParam('xahau', ISSUER, '7')).toBeUndefined();
    expect(collectionKeyParam('xahau', ISSUER, 'nope')).toBeUndefined();
  });

  it('answers 400 invalid issuer address first, then invalid taxon on XRPL, in either form', () => {
    expect(message(() => collectionKeyParam('xrpl', 'xyz', 'nope'))).toBe('invalid issuer address');
    expect(message(() => collectionKeyParam('xrpl', 'xyz'))).toBe('invalid issuer address');
    expect(message(() => collectionKeyParam('xahau', 'xyz', '7'))).toBe('invalid issuer address');
    expect(message(() => collectionKeyParam('xrpl', ISSUER, 'nope'))).toBe('invalid taxon');
    expect(message(() => collectionKeyParam('xrpl', ISSUER, '4294967296'))).toBe('invalid taxon');
  });
});

describe('holdingsCollectionParam', () => {
  const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

  it('is none without an issuer or a taxon, and an empty one is none too', () => {
    expect(holdingsCollectionParam({})).toEqual({});
    expect(holdingsCollectionParam({ issuer: '', taxon: '' })).toEqual({});
  });

  it('is the issuer alone, or the issuer and its taxon (a decimal, 0 too)', () => {
    expect(holdingsCollectionParam({ issuer: ISSUER })).toEqual({ issuer: ISSUER });
    expect(holdingsCollectionParam({ issuer: ISSUER, taxon: '7' })).toEqual({ issuer: ISSUER, taxon_key: 7 });
    expect(holdingsCollectionParam({ issuer: ISSUER, taxon: '0' })).toEqual({ issuer: ISSUER, taxon_key: 0 });
    expect(holdingsCollectionParam({ issuer: ISSUER, taxon: '' })).toEqual({ issuer: ISSUER });
  });

  it('answers 400 invalid taxon for a taxon without an issuer, a taxon that is none, and a taxon that is too large', () => {
    expect(message(() => holdingsCollectionParam({ taxon: '7' }))).toBe('invalid taxon');
    expect(message(() => holdingsCollectionParam({ issuer: '', taxon: '7' }))).toBe('invalid taxon');
    expect(message(() => holdingsCollectionParam({ issuer: ISSUER, taxon: 'x' }))).toBe('invalid taxon');
    expect(message(() => holdingsCollectionParam({ issuer: ISSUER, taxon: '-1' }))).toBe('invalid taxon');
    expect(message(() => holdingsCollectionParam({ issuer: ISSUER, taxon: '4294967296' }))).toBe('invalid taxon');
  });

  it('checks the issuer first: 400 invalid issuer address, whatever the taxon says', () => {
    expect(message(() => holdingsCollectionParam({ issuer: 'xyz' }))).toBe('invalid issuer address');
    expect(message(() => holdingsCollectionParam({ issuer: 'xyz', taxon: 'x' }))).toBe('invalid issuer address');
  });
});

describe('the currency of the sales', () => {
  const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

  it('is none when missing or empty, and a space is the + that arrived as one (Ruling 8)', () => {
    expect(saleCurrencyParam({})).toBeUndefined();
    expect(saleCurrencyParam({ currency: '' })).toBeUndefined();
    expect(saleCurrencyParam({ currency: 'XRP' })).toBe('XRP');
    expect(saleCurrencyParam({ currency: `USD+${ISSUER}` })).toBe(`USD+${ISSUER}`);
    expect(saleCurrencyParam({ currency: `USD ${ISSUER}` })).toBe(`USD+${ISSUER}`);
    expect(saleCurrencyParam({ currency: ['USD rA', 'EUR rB'] })).toBe('USD+rA');
  });

  it('is the native currency or CUR+issuer as /v2/payments/{currency} reads it: split at +, | and ., upper-cased', () => {
    expect(saleAssetParam(undefined, 'XRP')).toBeUndefined();
    expect(saleAssetParam('XRP', 'XRP')).toEqual({ currency: 'XRP' });
    expect(saleAssetParam('xrp', 'XRP')).toEqual({ currency: 'XRP' });
    for (const separator of ['+', '|', '.']) {
      expect(saleAssetParam(`usd${separator}${ISSUER}`, 'XRP')).toEqual({ currency: 'USD', issuer: ISSUER });
    }
  });

  it('is the native currency of the network: XAH on Xahau, where XRP is an issued currency that needs an issuer', () => {
    expect(saleAssetParam('XAH', 'XAH')).toEqual({ currency: 'XAH' });
    expect(saleAssetParam(`XRP+${ISSUER}`, 'XAH')).toEqual({ currency: 'XRP', issuer: ISSUER });
    expect(message(() => saleAssetParam('XRP', 'XAH'))).toBe('issuer is required');
    expect(message(() => saleAssetParam(`XAH+${ISSUER}`, 'XAH'))).toBe('XAH cannot have an issuer');
    expect(message(() => saleAssetParam('XAH', 'XRP'))).toBe('issuer is required');
  });

  it('answers the errors of parseAsset: XRP cannot have an issuer, issuer is required, invalid issuer address, currency is required', () => {
    expect(message(() => saleAssetParam(`XRP+${ISSUER}`, 'XRP'))).toBe('XRP cannot have an issuer');
    expect(message(() => saleAssetParam('USD', 'XRP'))).toBe('issuer is required');
    expect(message(() => saleAssetParam('USD+xyz', 'XRP'))).toBe('invalid issuer address');
    expect(message(() => saleAssetParam(`+${ISSUER}`, 'XRP'))).toBe('currency is required');
  });

  it('checks the issuer first, before the dates, as /v2/payments/{currency} does: 400 invalid issuer address', () => {
    expect(message(() => checkSaleCurrencyIssuer(undefined))).toBe('no error');
    expect(message(() => checkSaleCurrencyIssuer('USD'))).toBe('no error');
    expect(message(() => checkSaleCurrencyIssuer(`USD+${ISSUER}`))).toBe('no error');
    expect(message(() => checkSaleCurrencyIssuer('USD+xyz'))).toBe('invalid issuer address');
    // (the other mistakes of the currency come after the dates)
    expect(message(() => checkSaleCurrencyIssuer(`XRP+${ISSUER}`))).toBe('no error');
  });
});

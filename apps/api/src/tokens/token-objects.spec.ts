import { getNetworkProfile } from '@gatehub/data-api-shared';
import { PaymentObject } from '../payments/payment-object';
import {
  HOLDER_ROW_KEYS,
  holderRow,
  HOLDERS_ANSWER_KEYS,
  ISSUED_TOKEN_ROW_KEYS,
  ISSUED_TOTALS_KEYS,
  issuedTokenRow,
  issuedTotals,
  ISSUER_SETTINGS_KEYS,
  issuerSettingsOf,
  shareOf,
  StoredToken,
  toIssuedTokenCsvRow,
  TOKEN_ANSWER_KEYS,
  TOKEN_KEYS,
  TOKEN_MARKET_KEYS,
  TokenMarket,
  tokenObject,
  toTransferCsvRow,
  TRANSFER_ROW_KEYS,
  transferFeeOf,
  transferRow,
  TRANSFERS_ANSWER_KEYS,
} from './token-objects';

const xrpl = getNetworkProfile('xrpl');
const xahau = getNetworkProfile('xahau');

const ISSUER = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const HOLDER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const NPUSD = '4E50555344000000000000000000000000000000';
/** Bytes that are no text: a token with no code. */
const NO_CODE = `FF${'00'.repeat(18)}01`;

// the AccountRoot flags the issuer settings read
const REQUIRE_AUTH = 0x00040000;
const NO_FREEZE = 0x00200000;
const GLOBAL_FREEZE = 0x00400000;
const DEFAULT_RIPPLE = 0x00800000;
const XRPL_CLAWBACK = 0x80000000;
const XAHAU_CLAWBACK = 0x00001000;

const TOML = JSON.stringify({
  name: 'Northpeak Dollar',
  desc: 'A US dollar stablecoin',
  display_decimals: 2,
  asset_class: 'Fiat-backed stablecoin',
  attestation: 'https://northpeak.example/attestations/2026-09.pdf',
});

/** The token of the example of the spec. */
const STORED: StoredToken = {
  issuer: ISSUER,
  currency: NPUSD,
  code: 'NPUSD',
  holders: 48_920,
  trust_lines: 61_207,
  supply: '182402118.55',
  last_ledger: 107_721_451,
  issuer_ledger: 107_721_000,
  issuer_flags: XRPL_CLAWBACK | DEFAULT_RIPPLE,
  transfer_rate: 0,
  domain: 'northpeak.example',
  listed: 1,
  name: 'Northpeak Dollar',
  toml: TOML,
};

/** A token nothing is known of beyond its lines. */
const BARE: StoredToken = {
  ...STORED,
  currency: NO_CODE,
  code: '',
  issuer_ledger: 0,
  issuer_flags: 0,
  transfer_rate: 0,
  domain: '',
  listed: 0,
  name: '',
  toml: '',
};

const FACTS = {
  price: '0.41010000',
  price_change: '0.12',
  price_time: '2026-10-24T14:02:51Z',
  native_volume: '9820000',
  trades: 2140,
};

const MARKET: TokenMarket = {
  counter_currency: 'XRP',
  count: 1402,
  volume: '17361000',
  counter_volume: '7120000',
  native_volume: '7120000',
  last: '0.41010000',
  change: '0.12',
  last_time: '2026-10-24T14:02:51Z',
  amm_pool: true,
};

describe('the key orders', () => {
  it('are those of spec 5.1 to 5.4', () => {
    expect([...ISSUED_TOTALS_KEYS]).toEqual(['tokens', 'tokens_with_10_holders', 'holders', 'native_volume']);
    expect([...ISSUED_TOKEN_ROW_KEYS]).toEqual([
      'rank',
      'currency',
      'code',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'price',
      'price_change',
      'price_time',
      'native_volume',
      'trades',
      'domain',
      'listed',
      'name',
    ]);
    expect([...TOKEN_ANSWER_KEYS]).toEqual(['result', 'coverage', 'ledger_index', 'close_time', 'token']);
    expect([...TOKEN_KEYS]).toEqual([
      'currency',
      'code',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'price',
      'price_change',
      'price_time',
      'native_volume',
      'trades',
      'domain',
      'toml_url',
      'listed',
      'toml',
      'issuer_settings',
      'markets',
      'last_ledger',
    ]);
    expect([...ISSUER_SETTINGS_KEYS]).toEqual([
      'transfer_fee',
      'global_freeze',
      'no_freeze',
      'allow_trust_line_clawback',
      'require_auth',
      'default_ripple',
    ]);
    expect([...TOKEN_MARKET_KEYS]).toEqual([
      'counter_currency',
      'counter_issuer',
      'count',
      'volume',
      'counter_volume',
      'native_volume',
      'last',
      'change',
      'last_time',
      'amm_pool',
    ]);
    expect([...HOLDERS_ANSWER_KEYS]).toEqual([
      'result',
      'coverage',
      'ledger_index',
      'close_time',
      'supply',
      'count',
      'marker',
      'holders',
    ]);
    expect([...HOLDER_ROW_KEYS]).toEqual(['rank', 'holder', 'balance', 'share', 'limit', 'frozen', 'authorized']);
    expect([...TRANSFERS_ANSWER_KEYS]).toEqual(['result', 'coverage', 'count', 'marker', 'transfers']);
    expect([...TRANSFER_ROW_KEYS]).toEqual([
      'hash',
      'ledger_index',
      'executed_time',
      'source',
      'destination',
      'amount',
      'source_tag',
      'destination_tag',
    ]);
  });
});

describe('issuedTotals', () => {
  const counts = { tokens: 49_490, tokens_with_10_holders: 1284 };

  it('is the totals in order, with the generation holders and the native volume', () => {
    const totals = issuedTotals(counts, { holders: 612_480, holders_ledger: 107_721_455 }, '58400000');
    expect(Object.keys(totals)).toEqual([...ISSUED_TOTALS_KEYS]);
    expect(totals).toEqual({
      tokens: 49_490,
      tokens_with_10_holders: 1284,
      holders: 612_480,
      native_volume: '58400000',
    });
  });

  it('leaves out the native volume while there is no day set', () => {
    const totals = issuedTotals(counts, { holders: 612_480, holders_ledger: 107_721_455 }, undefined);
    expect(Object.keys(totals)).toEqual(['tokens', 'tokens_with_10_holders', 'holders']);
  });

  it('leaves out the holders of a generation that has not counted them yet, never serves a false 0', () => {
    const totals = issuedTotals(counts, { holders: 0, holders_ledger: 0 }, '1');
    expect(Object.keys(totals)).toEqual(['tokens', 'tokens_with_10_holders', 'native_volume']);
  });

  it('serves a count of 0 holders that was counted', () => {
    expect(issuedTotals(counts, { holders: 0, holders_ledger: 107_721_455 }, undefined).holders).toBe(0);
  });
});

describe('issuedTokenRow', () => {
  it('is the row of the spec, in the order of ISSUED_TOKEN_ROW_KEYS', () => {
    const row = issuedTokenRow({ ...STORED, rank: 1 }, FACTS);
    expect(Object.keys(row)).toEqual([...ISSUED_TOKEN_ROW_KEYS]);
    expect(row).toEqual({
      rank: 1,
      currency: NPUSD,
      code: 'NPUSD',
      issuer: ISSUER,
      holders: 48_920,
      trust_lines: 61_207,
      supply: '182402118.55',
      price: '0.41010000',
      price_change: '0.12',
      price_time: '2026-10-24T14:02:51Z',
      native_volume: '9820000',
      trades: 2140,
      domain: 'northpeak.example',
      listed: true,
      name: 'Northpeak Dollar',
    });
  });

  it('leaves out what the token does not have: a code, the market facts, a domain, a name', () => {
    const row = issuedTokenRow({ ...BARE, rank: 7 }, {});
    expect(Object.keys(row)).toEqual(['rank', 'currency', 'issuer', 'holders', 'trust_lines', 'supply', 'listed']);
    expect(row.listed).toBe(false);
  });

  it('serves a trade count of 0 and a native volume of "0", which are facts', () => {
    const row = issuedTokenRow({ ...STORED, rank: 2 }, { native_volume: '0', trades: 0 });
    expect(row.native_volume).toBe('0');
    expect(row.trades).toBe(0);
  });

  it('serves a domain with no listing, and a listed token that has no name', () => {
    const row = issuedTokenRow({ ...STORED, rank: 3, listed: 0, name: '', toml: '' }, {});
    expect(row.domain).toBe('northpeak.example');
    expect(row.listed).toBe(false);
    expect(row).not.toHaveProperty('name');
    expect(issuedTokenRow({ ...STORED, rank: 3, name: '', toml: '{}' }, {}).listed).toBe(true);
  });

  it('builds the object key by key: a column of the row that is no key never gets in', () => {
    const row = issuedTokenRow({ ...STORED, rank: 1, extra: 'x' } as never, {});
    expect(row).not.toHaveProperty('extra');
    expect(row).not.toHaveProperty('toml');
    expect(row).not.toHaveProperty('issuer_flags');
  });
});

describe('tokenObject', () => {
  it('is the token of the spec, in the order of TOKEN_KEYS', () => {
    const token = tokenObject(STORED, FACTS, [MARKET], xrpl);
    expect(Object.keys(token)).toEqual([...TOKEN_KEYS]);
    expect(token).toEqual({
      currency: NPUSD,
      code: 'NPUSD',
      issuer: ISSUER,
      holders: 48_920,
      trust_lines: 61_207,
      supply: '182402118.55',
      price: '0.41010000',
      price_change: '0.12',
      price_time: '2026-10-24T14:02:51Z',
      native_volume: '9820000',
      trades: 2140,
      domain: 'northpeak.example',
      toml_url: 'https://northpeak.example/.well-known/xrp-ledger.toml',
      listed: true,
      toml: JSON.parse(TOML),
      issuer_settings: {
        transfer_fee: '0',
        global_freeze: false,
        no_freeze: false,
        allow_trust_line_clawback: true,
        require_auth: false,
        default_ripple: true,
      },
      markets: [MARKET],
      last_ledger: 107_721_451,
    });
  });

  it('leaves out what is not known: a code, the market facts, the domain and its toml, the issuer settings', () => {
    const token = tokenObject(BARE, {}, [], xrpl);
    expect(Object.keys(token)).toEqual([
      'currency',
      'issuer',
      'holders',
      'trust_lines',
      'supply',
      'listed',
      'markets',
      'last_ledger',
    ]);
    expect(token.markets).toEqual([]);
    expect(token.listed).toBe(false);
  });

  it('leaves out the issuer settings while the issuer has no row in the state tables (issuer_ledger 0)', () => {
    const token = tokenObject({ ...STORED, issuer_ledger: 0, issuer_flags: XRPL_CLAWBACK }, FACTS, [], xrpl);
    expect(token).not.toHaveProperty('issuer_settings');
  });

  it('serves the settings of an issuer with no flags at all: all false and a fee of "0"', () => {
    const token = tokenObject({ ...STORED, issuer_flags: 0 }, FACTS, [], xrpl);
    expect(token.issuer_settings).toEqual({
      transfer_fee: '0',
      global_freeze: false,
      no_freeze: false,
      allow_trust_line_clawback: false,
      require_auth: false,
      default_ripple: false,
    });
  });

  it('toml_url is https://{domain}{tomlPath} of the network, for a domain that is not listed too', () => {
    expect(tokenObject(STORED, {}, [], xrpl).toml_url).toBe('https://northpeak.example/.well-known/xrp-ledger.toml');
    expect(tokenObject(STORED, {}, [], xahau).toml_url).toBe('https://northpeak.example/.well-known/xahau.toml');
    const unlisted = tokenObject({ ...STORED, listed: 0, name: '', toml: '' }, {}, [], xrpl);
    expect(unlisted.toml_url).toBe('https://northpeak.example/.well-known/xrp-ledger.toml');
    expect(unlisted).not.toHaveProperty('toml');
  });

  it('serves no toml_url without a domain', () => {
    expect(tokenObject({ ...STORED, domain: '' }, {}, [], xrpl)).not.toHaveProperty('toml_url');
  });

  it('parses the toml from the stored JSON, its served fields in the order of the spec', () => {
    const stored = JSON.stringify({
      attestation: 'a',
      display_decimals: 6,
      name: 'N',
      symbol: 'S',
      icon: 'i',
      desc: 'd',
    });
    const toml = tokenObject({ ...STORED, toml: stored }, {}, [], xrpl).toml;
    expect(Object.keys(toml ?? {})).toEqual(['name', 'desc', 'icon', 'symbol', 'display_decimals', 'attestation']);
    expect(toml).toEqual({ name: 'N', desc: 'd', icon: 'i', symbol: 'S', display_decimals: 6, attestation: 'a' });
  });

  it.each([
    ['empty', ''],
    ['an empty object: a listed token with no served field', '{}'],
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
  ])('leaves out the toml when it is %s', (_name, stored) => {
    expect(tokenObject({ ...STORED, toml: stored }, {}, [], xrpl)).not.toHaveProperty('toml');
  });

  it('serves a display_decimals of 0, which is a value', () => {
    const toml = tokenObject({ ...STORED, toml: JSON.stringify({ display_decimals: 0 }) }, {}, [], xrpl).toml;
    expect(toml).toEqual({ display_decimals: 0 });
  });

  it('builds the object key by key: a column of the row that is no key never gets in', () => {
    const token = tokenObject({ ...STORED, extra: 'x' } as never, {}, [], xrpl);
    expect(token).not.toHaveProperty('extra');
    expect(token).not.toHaveProperty('issuer_flags');
    expect(token).not.toHaveProperty('transfer_rate');
    expect(token).not.toHaveProperty('name');
  });

  it('serves the transfer fee of the issuer', () => {
    expect(tokenObject({ ...STORED, transfer_rate: 1_002_000_000 }, {}, [], xrpl).issuer_settings?.transfer_fee).toBe(
      '0.2',
    );
  });
});

describe('issuerSettingsOf', () => {
  it('reads the flags by name on the XRP Ledger: 0x80000000 is the clawback flag', () => {
    const flags = REQUIRE_AUTH | NO_FREEZE | GLOBAL_FREEZE | DEFAULT_RIPPLE | XRPL_CLAWBACK;
    const settings = issuerSettingsOf(flags, 1_002_000_000, xrpl);
    expect(Object.keys(settings)).toEqual([...ISSUER_SETTINGS_KEYS]);
    expect(settings).toEqual({
      transfer_fee: '0.2',
      global_freeze: true,
      no_freeze: true,
      allow_trust_line_clawback: true,
      require_auth: true,
      default_ripple: true,
    });
  });

  it('reads each flag alone', () => {
    const only = (flag: number): string[] =>
      Object.entries(issuerSettingsOf(flag >>> 0, 0, xrpl))
        .filter(([, v]) => v === true)
        .map(([k]) => k);
    expect(only(REQUIRE_AUTH)).toEqual(['require_auth']);
    expect(only(NO_FREEZE)).toEqual(['no_freeze']);
    expect(only(GLOBAL_FREEZE)).toEqual(['global_freeze']);
    expect(only(DEFAULT_RIPPLE)).toEqual(['default_ripple']);
    expect(only(XRPL_CLAWBACK)).toEqual(['allow_trust_line_clawback']);
    expect(only(0)).toEqual([]);
  });

  it('reads the clawback flag of Xahau at 0x1000, and 0x80000000 (DisallowIncomingRemit there) is not it', () => {
    expect(issuerSettingsOf(XAHAU_CLAWBACK, 0, xahau).allow_trust_line_clawback).toBe(true);
    expect(issuerSettingsOf(XRPL_CLAWBACK, 0, xahau).allow_trust_line_clawback).toBe(false);
    // and the other way round: 0x1000 is no flag of the XRP Ledger
    expect(issuerSettingsOf(XAHAU_CLAWBACK, 0, xrpl).allow_trust_line_clawback).toBe(false);
  });

  it('reads the freeze, auth and ripple flags the same on Xahau', () => {
    const settings = issuerSettingsOf(REQUIRE_AUTH | NO_FREEZE | GLOBAL_FREEZE | DEFAULT_RIPPLE, 0, xahau);
    expect(settings).toEqual({
      transfer_fee: '0',
      global_freeze: true,
      no_freeze: true,
      allow_trust_line_clawback: false,
      require_auth: true,
      default_ripple: true,
    });
  });
});

describe('transferFeeOf', () => {
  it.each<[number, string]>([
    [1_002_000_000, '0.2'],
    [1_000_000_000, '0'],
    [0, '0'],
    [1_000_000_001, '0.0000001'],
    [1_005_000_000, '0.5'],
    [1_100_000_000, '10'],
    [1_234_567_890, '23.456789'],
    [2_000_000_000, '100'],
    // a rate below 1 is none the ledger allows, and no negative fee
    [999_999_999, '0'],
  ])('%d is %s', (rate, fee) => {
    expect(transferFeeOf(rate)).toBe(fee);
  });
});

describe('shareOf', () => {
  it('is the balance over the supply, 6 decimals', () => {
    expect(shareOf('21395768.51', '182402118.55')).toBe('0.117300');
    expect(shareOf('182402118.55', '182402118.55')).toBe('1.000000');
    expect(shareOf('0', '182402118.55')).toBe('0.000000');
  });

  it('rounds half up at the 7th decimal', () => {
    expect(shareOf('1', '2000000')).toBe('0.000001'); // 0.0000005
    expect(shareOf('1', '4000000')).toBe('0.000000'); // 0.00000025
    expect(shareOf('3', '4000000')).toBe('0.000001'); // 0.00000075
    expect(shareOf('1', '3')).toBe('0.333333');
    expect(shareOf('2', '3')).toBe('0.666667');
  });

  it('rounds once: a quotient just below a tie does not round up through a rounding of its own', () => {
    // 0.4999999999999999999999 / 1000000 = 4.999999999999999999999e-7: below the tie, so 0.000000
    expect(shareOf('0.4999999999999999999999', '1000000')).toBe('0.000000');
    expect(shareOf('0.5000000000000000000001', '1000000')).toBe('0.000001');
  });

  it('is "0.000000" for a supply of 0', () => {
    expect(shareOf('0', '0')).toBe('0.000000');
    expect(shareOf('5', '0')).toBe('0.000000');
  });

  it('writes plain digits, never an exponent', () => {
    expect(shareOf('1', '1000000000000')).toBe('0.000000');
    expect(shareOf('1000000000000', '1000000000000')).toBe('1.000000');
  });
});

describe('holderRow', () => {
  const HOLDER_ROW = { rank: 1, holder: HOLDER, balance: '21395768.51', limit: '1000000000', frozen: 0, authorized: 0 };

  it('is the holder of the spec, in the order of HOLDER_ROW_KEYS', () => {
    const row = holderRow(HOLDER_ROW, '182402118.55');
    expect(Object.keys(row)).toEqual([...HOLDER_ROW_KEYS]);
    expect(row).toEqual({
      rank: 1,
      holder: HOLDER,
      balance: '21395768.51',
      share: '0.117300',
      limit: '1000000000',
      frozen: false,
      authorized: false,
    });
  });

  it('serves the freeze and auth flags as booleans', () => {
    const row = holderRow({ ...HOLDER_ROW, frozen: 1, authorized: 1 }, '182402118.55');
    expect(row.frozen).toBe(true);
    expect(row.authorized).toBe(true);
  });

  it('builds the row key by key', () => {
    expect(holderRow({ ...HOLDER_ROW, extra: 'x' } as never, '1')).not.toHaveProperty('extra');
  });
});

describe('transferRow', () => {
  const PAYMENT: PaymentObject = {
    amount: '1300',
    delivered_amount: '1250',
    destination_balance_changes: [{ counterparty: ISSUER, currency: NPUSD, value: '1250' }],
    source_balance_changes: [{ counterparty: ISSUER, currency: NPUSD, value: '-1300' }],
    tx_index: 4,
    currency: NPUSD,
    destination: HOLDER,
    destination_tag: 12,
    executed_time: '2026-10-24T14:02:51Z',
    invoice_id: 'AB'.repeat(32),
    issuer: ISSUER,
    ledger_index: 107_721_440,
    source: ISSUER,
    source_currency: NPUSD,
    source_tag: 7,
    tx_hash: 'AA'.repeat(32),
    transaction_cost: '0.00001',
  };

  it('is the transfer of the spec, in the order of TRANSFER_ROW_KEYS: the hash and the delivered amount', () => {
    const row = transferRow(PAYMENT);
    expect(Object.keys(row)).toEqual([...TRANSFER_ROW_KEYS]);
    expect(row).toEqual({
      hash: 'AA'.repeat(32),
      ledger_index: 107_721_440,
      executed_time: '2026-10-24T14:02:51Z',
      source: ISSUER,
      destination: HOLDER,
      amount: '1250',
      source_tag: 7,
      destination_tag: 12,
    });
    expect(row).not.toHaveProperty('invoice_id');
  });

  it('keeps a tag of 0, which is a tag, and leaves out one the payment does not have', () => {
    const zero = transferRow({ ...PAYMENT, source_tag: 0, destination_tag: 0 });
    expect(zero.source_tag).toBe(0);
    expect(zero.destination_tag).toBe(0);
    const { source_tag: _s, destination_tag: _d, ...bare } = PAYMENT;
    expect(Object.keys(transferRow(bare))).toEqual([
      'hash',
      'ledger_index',
      'executed_time',
      'source',
      'destination',
      'amount',
    ]);
    expect(Object.keys(transferRow({ ...bare, destination_tag: 12 }))).toEqual([
      'hash',
      'ledger_index',
      'executed_time',
      'source',
      'destination',
      'amount',
      'destination_tag',
    ]);
  });
});

describe('the CSV rows', () => {
  it('give every column of the list in its order, an empty cell where the row has none', () => {
    const full = toIssuedTokenCsvRow(issuedTokenRow({ ...STORED, rank: 1 }, FACTS));
    const bare = toIssuedTokenCsvRow(issuedTokenRow({ ...BARE, rank: 2 }, {}));
    expect(Object.keys(full)).toEqual([...ISSUED_TOKEN_ROW_KEYS]);
    expect(Object.keys(bare)).toEqual([...ISSUED_TOKEN_ROW_KEYS]);
    expect(full.listed).toBe(true);
    expect(bare).toMatchObject({
      rank: 2,
      currency: NO_CODE,
      code: null,
      price: null,
      trades: null,
      domain: null,
      name: null,
    });
  });

  it('give every column of the transfers in their order, with null for a tag the payment does not have', () => {
    const row = toTransferCsvRow({
      hash: 'AA',
      ledger_index: 5,
      executed_time: '2026-10-24T14:02:51Z',
      source: ISSUER,
      destination: HOLDER,
      amount: '1',
    });
    expect(Object.keys(row)).toEqual([...TRANSFER_ROW_KEYS]);
    expect(row.source_tag).toBeNull();
    expect(row.destination_tag).toBeNull();
    expect(toTransferCsvRow({ ...row, destination_tag: 0 } as never).destination_tag).toBe(0);
  });
});

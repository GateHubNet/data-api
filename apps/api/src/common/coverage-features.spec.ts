import {
  AMM_PARSER_VERSION,
  DESTINATION_TAG_PARSER_VERSION,
  getNetworkProfile,
  MINT_PARSER_VERSION,
  MPT_PARSER_VERSION,
  NETWORK_NAMES,
  OBJECT_PARSER_VERSION,
  STATE_PARSER_VERSION,
} from '@gatehub/data-api-shared';
import { COVERAGE_FEATURES, CoverageFeatureName } from './coverage-features';

/** The features D5 registers (spec 1.4): the escrows, checks and payment channels of the ledger, and the delegations of an account. */
const D5_FEATURES = ['escrows', 'payment_channels', 'checks', 'delegations'] as const satisfies CoverageFeatureName[];

/** The entries of `source` named by `keys`, in the order of `keys`. */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;
}

/** What a feature starts at on each network, in the order of `NETWORK_NAMES` (xrpl, xahau, xrpl-testnet, xahau-testnet). */
const startsOf = (feature: CoverageFeatureName) =>
  NETWORK_NAMES.map((name) => COVERAGE_FEATURES[feature].startOf(getNetworkProfile(name)));

describe('the coverage features of D5', () => {
  it('registers the four features on the object parser, and no other feature of D5', () => {
    expect(Object.keys(pick(COVERAGE_FEATURES, D5_FEATURES))).toEqual([...D5_FEATURES]);
    expect(Object.values(pick(COVERAGE_FEATURES, D5_FEATURES)).map((f) => f.parserVersion)).toEqual([7, 7, 7, 7]);
    expect(OBJECT_PARSER_VERSION).toBe(7);
  });

  it.each([
    ['escrows', 'Escrow'],
    ['payment_channels', 'PayChan'],
    ['checks', 'Checks'],
  ] as const)(
    '%s starts with the %s amendment on the XRP Ledger and at the first ledger on Xahau',
    (feature, amendment) => {
      // a testnet takes the rule of the family it follows
      expect(startsOf(feature)).toEqual([
        { kind: 'amendment', amendment },
        { kind: 'first_ledger' },
        { kind: 'amendment', amendment },
        { kind: 'first_ledger' },
      ]);
    },
  );

  it('delegations start with PermissionDelegationV1_1 where the network has delegation, and are unavailable where it has none', () => {
    expect(startsOf('delegations').map((start) => start.kind)).toEqual([
      'amendment',
      'unavailable',
      'amendment',
      'unavailable',
    ]);
    expect(startsOf('delegations')[0]).toEqual({ kind: 'amendment', amendment: 'PermissionDelegationV1_1' });
    expect(startsOf('delegations')[2]).toEqual({ kind: 'amendment', amendment: 'PermissionDelegationV1_1' });
  });
});

/** The features D6 registers (spec 6): the issued tokens of the state tables, and the transfers of a token. */
const D6_FEATURES = ['issued_tokens', 'token_transfers'] as const satisfies CoverageFeatureName[];

describe('the coverage features of D6', () => {
  it('registers issued_tokens on the state parser and token_transfers on parser 1, and no other feature of D6', () => {
    expect(Object.keys(pick(COVERAGE_FEATURES, D6_FEATURES))).toEqual([...D6_FEATURES]);
    expect(COVERAGE_FEATURES.issued_tokens.parserVersion).toBe(STATE_PARSER_VERSION);
    expect(COVERAGE_FEATURES.token_transfers.parserVersion).toBe(1);
  });

  it.each(D6_FEATURES)(
    '%s starts at the first ledger of the network on all four profiles (none on a testnet)',
    (feature) => {
      // trust lines need no amendment: the start is NetworkProfile.firstLedger, which the testnets do not have
      expect(startsOf(feature)).toEqual([
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
      ]);
      expect(NETWORK_NAMES.map((name) => getNetworkProfile(name).firstLedger !== undefined)).toEqual([
        true,
        true,
        false,
        false,
      ]);
    },
  );
});

/**
 * The features D7 registers (spec 1.5): the parts of the supply that are read from ledger history. `escrows` (D5) is the coverage of
 * the escrowed and circulating parts.
 */
const D7_FEATURES = ['fees', 'amm', 'account_states', 'mints'] as const satisfies CoverageFeatureName[];

describe('the coverage features of D7', () => {
  it('registers the four features, each on the parser that writes its rows, and no other feature of D7', () => {
    expect(Object.keys(pick(COVERAGE_FEATURES, D7_FEATURES))).toEqual([...D7_FEATURES]);
    expect(COVERAGE_FEATURES.fees.parserVersion).toBe(1);
    expect(COVERAGE_FEATURES.amm.parserVersion).toBe(AMM_PARSER_VERSION);
    expect(COVERAGE_FEATURES.account_states.parserVersion).toBe(STATE_PARSER_VERSION);
    expect(COVERAGE_FEATURES.mints.parserVersion).toBe(MINT_PARSER_VERSION);
    // the versions the rows are written from (rows.ts), not constants of this spec
    expect([AMM_PARSER_VERSION, STATE_PARSER_VERSION, MINT_PARSER_VERSION]).toEqual([2, 3, 9]);
  });

  it.each(['fees', 'account_states'] as const)(
    '%s starts at the first ledger of the network on all four profiles (none on a testnet)',
    (feature) => {
      // every stored ledger has a fee total, and the state tables need no amendment
      expect(startsOf(feature)).toEqual([
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
        { kind: 'first_ledger' },
      ]);
    },
  );

  it('amm starts with the AMM amendment where the network has AMM, and is unavailable where it has none', () => {
    // a testnet takes the rule of the family it follows, and Xahau has no AMM
    expect(startsOf('amm')).toEqual([
      { kind: 'amendment', amendment: 'AMM' },
      { kind: 'unavailable' },
      { kind: 'amendment', amendment: 'AMM' },
      { kind: 'unavailable' },
    ]);
    expect(NETWORK_NAMES.map((name) => getNetworkProfile(name).hasAmm)).toEqual([true, false, true, false]);
  });

  it('mints start at the first ledger where the network mints, and are unavailable where it does not', () => {
    expect(startsOf('mints')).toEqual([
      { kind: 'unavailable' },
      { kind: 'first_ledger' },
      { kind: 'unavailable' },
      { kind: 'first_ledger' },
    ]);
    expect(NETWORK_NAMES.map((name) => getNetworkProfile(name).hasMinting)).toEqual([false, true, false, true]);
  });
});

describe('the coverage feature of D9', () => {
  it('mpt: MPTokensV1 on the XRPL family, unavailable on Xahau and Xahau Testnet', () => {
    expect(COVERAGE_FEATURES.mpt.parserVersion).toBe(MPT_PARSER_VERSION);
    expect(MPT_PARSER_VERSION).toBe(10);
    expect(startsOf('mpt')).toEqual([
      { kind: 'amendment', amendment: 'MPTokensV1' },
      { kind: 'unavailable' },
      { kind: 'amendment', amendment: 'MPTokensV1' },
      { kind: 'unavailable' },
    ]);
    expect(NETWORK_NAMES.map((name) => getNetworkProfile(name).hasMpt)).toEqual([true, false, true, false]);
  });
});

describe('the coverage feature of the destination tags', () => {
  it('destination_tags: parser version 11, from the first ledger on every network', () => {
    expect(COVERAGE_FEATURES.destination_tags.parserVersion).toBe(DESTINATION_TAG_PARSER_VERSION);
    expect(DESTINATION_TAG_PARSER_VERSION).toBe(11);
    // any stored ledger can hold a tagged transaction: the start is NetworkProfile.firstLedger, which the testnets do not have
    expect(startsOf('destination_tags')).toEqual([
      { kind: 'first_ledger' },
      { kind: 'first_ledger' },
      { kind: 'first_ledger' },
      { kind: 'first_ledger' },
    ]);
  });
});

import {
  getNetworkProfile,
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

import { NetworkProfile, NFT_PARSER_VERSION, OBJECT_PARSER_VERSION } from '@gatehub/data-api-shared';

/** Where a feature starts on a network (spec §4). */
export type FeatureStart =
  /** The ledger the amendment was enabled in, as `AmendmentsService` reports it (never a constant). */
  | { kind: 'amendment'; amendment: string }
  /** As old as the network: `NetworkProfile.firstLedger`. */
  | { kind: 'first_ledger' }
  /** The network cannot have the feature: there is nothing to be missing. */
  | { kind: 'unavailable' };

/** What `FeatureCoverageService` needs to know of a feature: the parser that writes its rows and where it starts. */
export interface CoverageFeature {
  /** The first `ledgers.parser_version` that writes the feature's rows. */
  parserVersion: number;
  /** Where the feature starts on the network of `profile`. */
  startOf(profile: NetworkProfile): FeatureStart;
}

/**
 * The features of program 2 whose coverage an answer states, by name. D3 registers `nfts`, D5 `escrows`, `payment_channels`,
 * `checks` and `delegations`; D6, D7 and D9 add their entries here and use `FeatureCoverageService`, and define no rule of their own.
 */
export const COVERAGE_FEATURES = {
  // NFTs are an amendment on both families, by the family and not the network, so a testnet takes its mainnet's
  nfts: {
    parserVersion: NFT_PARSER_VERSION,
    startOf: (p) => ({
      kind: 'amendment',
      amendment: p.family === 'xahau' ? 'URIToken' : 'NonFungibleTokensV1_1',
    }),
  },
  // The ledger objects of D5 (spec 1.4). Xahau has had escrows, payment channels and checks since its genesis, so on the family
  // they start at the first ledger of the network (no enable ledger is added to the amendment metadata of Xahau). The XRP
  // Ledger enabled them by amendment: Escrow and PayChan are retired, so the assembly gives them an enable ledger only when
  // the ledger state lists them, and on a testnet only an indexed one counts. A testnet takes the rule of its family.
  escrows: {
    parserVersion: OBJECT_PARSER_VERSION,
    startOf: (p) => (p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'Escrow' }),
  },
  payment_channels: {
    parserVersion: OBJECT_PARSER_VERSION,
    startOf: (p) => (p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'PayChan' }),
  },
  checks: {
    parserVersion: OBJECT_PARSER_VERSION,
    startOf: (p) => (p.family === 'xahau' ? { kind: 'first_ledger' } : { kind: 'amendment', amendment: 'Checks' }),
  },
  // Delegation is an amendment of the XRP Ledger family only: Xahau cannot have it, so its delegations are complete and
  // the route reads no table.
  delegations: {
    parserVersion: OBJECT_PARSER_VERSION,
    startOf: (p) =>
      p.hasDelegation ? { kind: 'amendment', amendment: 'PermissionDelegationV1_1' } : { kind: 'unavailable' },
  },
} satisfies Record<string, CoverageFeature>;

export type CoverageFeatureName = keyof typeof COVERAGE_FEATURES;

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** The four networks a deployment can follow. A testnet is a network of its own, with its own name, database and files. */
export type NetworkName = 'xrpl' | 'xahau' | 'xrpl-testnet' | 'xahau-testnet';

/** The software and ledger rules a network shares with the others of its family. */
export type NetworkFamily = 'xrpl' | 'xahau';

/** Whether a network holds value (`mainnet`) or is for testing (`testnet`). A fact of the profile, never of the environment. */
export type NetworkKind = 'mainnet' | 'testnet';

/** In this order: the order of every message and test that lists them. */
export const NETWORK_NAMES: readonly NetworkName[] = ['xrpl', 'xahau', 'xrpl-testnet', 'xahau-testnet'];

/** An asset in a markets config. `issuer` is omitted for the native currency. */
export interface MarketAsset {
  currency: string;
  issuer?: string;
}

/** The versioned per-network component list used by the volume jobs. */
export interface MarketsConfig {
  version: number;
  tradeMarkets: { base: MarketAsset; counter: MarketAsset }[];
  paymentCurrencies: MarketAsset[];
}

/**
 * Everything that differs between the deployments of the same images: one record for each of the four networks (the
 * XRP Ledger and Xahau, and the testnet of each). Files of markets and definitions, databases, lease rows, export keys
 * and cache keys follow `name`; the amendment metadata file and the account flags follow `family`; the reset rule and
 * the boot line follow `kind`.
 */
export interface NetworkProfile {
  name: NetworkName;
  family: NetworkFamily;
  kind: NetworkKind;
  /** The name of the network in the words of a person (the header of the PDF export). */
  displayName: 'XRP Ledger' | 'Xahau' | 'XRPL Testnet' | 'Xahau Testnet';
  /** CTID network id. */
  networkId: number;
  /** `server_info.network_id` values a node of this network may report; `undefined` is "the field is absent". */
  acceptedNodeNetworkIds: ReadonlyArray<number | undefined>;
  nativeCurrency: 'XRP' | 'XAH';
  /** ClickHouse database used when `GH_CLICKHOUSE_DATABASE` is not set. */
  defaultDatabase: string;
  /**
   * Public websocket endpoints of the network, used when `GH_NODE_ENDPOINTS` is not set, in the order they are tried.
   * XRPL: Ripple's full-history server first (it did not throttle a first sync), the community cluster as the
   * failover (ruling R98).
   */
  defaultNodeEndpoints: string[];
  /** First ledger from which a partial payment's delivered amount is taken from `delivered_amount` metadata. */
  partialPaymentFixLedger: number;
  /** The node software of the network: it decides how `server_version` is decoded. */
  software: 'rippled' | 'xahaud';
  /** Where a validator's domain publishes its TOML file. */
  tomlPath: '/.well-known/xrp-ledger.toml' | '/.well-known/xahau.toml';
  /**
   * The `GH_UNL_PUBLISHERS` text used when that variable is not set: comma separated `url=publicKey` pairs of the
   * network's default validator list publishers (see `parseUnlPublishers`).
   */
  defaultUnlPublishers: string;
  /** The `GH_UNL_VALIDATORS` text when that variable is unset or `default`: comma separated validator master keys (n…). */
  defaultUnlValidators: string;
  /** How long an amendment must hold its majority before it is enabled, in seconds. */
  majorityHoldSeconds: number;
  /** The share of trusted validators, in percent, an amendment needs. */
  amendmentThresholdPercent: 80;
  /** Ledgers between two flag ledgers. */
  flagInterval: 256;
  /**
   * Binary-codec definitions (the `server_definitions` result shape) to use when the node cannot supply them: the
   * file recorded from a public node of the network, bundled as `config/definitions/<network>.json`. `undefined`
   * means that file is missing, and the codec's built-in definitions apply. `definitionsPath` overrides the file
   * (tests).
   */
  definitionsFallback(definitionsPath?: string): Record<string, unknown> | undefined;
}

// `src/network` and `dist/network` are both two levels below the package root, which ships `config/` in `files`.
const PACKAGE_ROOT = join(__dirname, '..', '..');
const DEFAULT_MARKETS_DIR = join(PACKAGE_ROOT, 'config', 'markets');
const DEFAULT_DEFINITIONS_DIR = join(PACKAGE_ROOT, 'config', 'definitions');

function readDefinitions(name: NetworkName, definitionsPath?: string): Record<string, unknown> | undefined {
  const file = definitionsPath ?? join(DEFAULT_DEFINITIONS_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : undefined;
}

const PROFILES: Record<NetworkName, NetworkProfile> = {
  xrpl: {
    name: 'xrpl',
    family: 'xrpl',
    kind: 'mainnet',
    displayName: 'XRP Ledger',
    networkId: 0,
    // Mainnet rippled omits `network_id` from `server_info`.
    acceptedNodeNetworkIds: [undefined, 0],
    nativeCurrency: 'XRP',
    defaultDatabase: 'xrpl',
    defaultNodeEndpoints: ['wss://s2.ripple.com', 'wss://xrplcluster.com'],
    partialPaymentFixLedger: 4594094,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    defaultUnlPublishers:
      'https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,' +
      'https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1',
    defaultUnlValidators: '',
    majorityHoldSeconds: 1_209_600,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xrpl', definitionsPath),
  },
  xahau: {
    name: 'xahau',
    family: 'xahau',
    kind: 'mainnet',
    displayName: 'Xahau',
    networkId: 21337,
    acceptedNodeNetworkIds: [21337],
    nativeCurrency: 'XAH',
    defaultDatabase: 'xahau',
    defaultNodeEndpoints: ['wss://xahau.network'],
    partialPaymentFixLedger: 0,
    software: 'xahaud',
    tomlPath: '/.well-known/xahau.toml',
    defaultUnlPublishers: 'https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8',
    defaultUnlValidators: '',
    majorityHoldSeconds: 432_000,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xahau', definitionsPath),
  },
  'xrpl-testnet': {
    name: 'xrpl-testnet',
    family: 'xrpl',
    kind: 'testnet',
    displayName: 'XRPL Testnet',
    networkId: 1,
    acceptedNodeNetworkIds: [1],
    nativeCurrency: 'XRP',
    defaultDatabase: 'xrpl_testnet',
    // The rippled servers, the kind of node the syncer's streams were verified against; the Clio of the testnet
    // (clio.altnet.rippletest.net) throttles bursts and is a backfill source, not a live one.
    defaultNodeEndpoints: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com'],
    partialPaymentFixLedger: 0,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    // The list `https://vl.altnet.rippletest.net` serves (version 1, signed by this key), read 2026-10-24.
    defaultUnlPublishers:
      'https://vl.altnet.rippletest.net=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860',
    defaultUnlValidators: '',
    // 30 minutes, not mainnet's 14 days. Read on clio.altnet.rippletest.net on 2026-10-24: each of the 7 amendments
    // whose got-majority and enabling EnableAmendment pair was read (the newest ones, back to ledger 14635521) was
    // enabled exactly 3 flag intervals (768 ledgers, 39 to 43 minutes) after it gained a majority. E.g. 0F48FF56...
    // gained it in ledger 21394177 (tx F7077524E6D29D05EB8CAAA24B6B2F2623911D52D9D92F6C21088F914D404B63, flags 65536,
    // closed 2026-10-09T05:11:50Z) and was enabled in ledger 21394945 (tx
    // 7A730EDFD2E4E248B1E0F0D30928172381E200D9BA543502B21F075CA1FD30E3, flags 0, closed 05:54:40Z). The hold H is
    // checked at each flag ledger, so across the 7 pairs 1711 s < H <= 2359 s (the time elapsed at the second and at
    // the third flag ledger after the majority began). No setting is published; 30 minutes is the round value in that
    // range. account_tx of rrrrrrrrrrrrrrrrrrrrrhoLvTp lists no EnableAmendment: the pairs come from walking the
    // Amendments object back through PreviousTxnID.
    majorityHoldSeconds: 1_800,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xrpl-testnet', definitionsPath),
  },
  'xahau-testnet': {
    name: 'xahau-testnet',
    family: 'xahau',
    kind: 'testnet',
    displayName: 'Xahau Testnet',
    networkId: 21338,
    acceptedNodeNetworkIds: [21338],
    nativeCurrency: 'XAH',
    defaultDatabase: 'xahau_testnet',
    defaultNodeEndpoints: ['wss://xahau-test.net'],
    partialPaymentFixLedger: 0,
    software: 'xahaud',
    tomlPath: '/.well-known/xahau.toml',
    // The testnet has no validator list site: its trusted validators are the fixed list below.
    defaultUnlPublishers: '',
    // The `[validators]` of `store/etc/validators-xahau.txt` in Xahau/Xahau-Testnet-Docker, last changed in commit
    // 01ed74b5ebf34b27c8d5635b6d03972cc23346da (2024-10-25) and unchanged at 87eeb5db5f81f0d0b526f6365e2aede14cd2559d
    // (2025-12-18, the head when read on 2026-10-24).
    defaultUnlValidators:
      'nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ,nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ,' +
      'nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q,nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe',
    // 5 days: the software default. Xahau/Xahau-Testnet-Docker@87eeb5db5f81f0d0b526f6365e2aede14cd2559d sets no
    // [amendment_majority_time] (store/etc/xahaud.cfg, commit 1dd22588ce2dd8826488e6da1b65e304776a95a1), so xahaud's
    // `defaultAmendmentMajorityTime` applies: days{5} in include/xrpl/protocol/SystemParameters.h of
    // Xahau/xahaud@5c05e107c0211dcedb7adcf73dab1f6012747fe7. No pair on the chain: wss://xahau-test.net holds only
    // ledgers 13293254 to 13463527 (about 5.7 days, read 2026-10-24), and the Amendments object last changed in
    // ledger 13236737, before them.
    majorityHoldSeconds: 432_000,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xahau-testnet', definitionsPath),
  },
};

/** Whether `value` is the name of a network. Only the names of `PROFILES` count: `constructor` and the like do not. */
export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/** `<what> must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`: the refusal of the config classes and the scripts. */
export function networkChoiceText(what: string): string {
  return `${what} must be one of ${NETWORK_NAMES.join(', ')}`;
}

/** The network words of a boot line: `network=xrpl`, and on a testnet `network=xrpl-testnet kind=testnet`. */
export function networkLogText(profile: Pick<NetworkProfile, 'name' | 'kind'>): string {
  return profile.kind === 'testnet' ? `network=${profile.name} kind=testnet` : `network=${profile.name}`;
}

/** Resolve a profile by name, defaulting to `GH_NETWORK` and then `xrpl`. An empty `GH_NETWORK` counts as unset. */
export function getNetworkProfile(name?: string): NetworkProfile {
  const key = name ?? (process.env.GH_NETWORK || 'xrpl');
  if (!isNetworkName(key)) {
    throw new Error(`Unknown GH_NETWORK "${key}"`);
  }
  return PROFILES[key];
}

/**
 * Load the markets config for a network. The path defaults to `GH_MARKETS_CONFIG` (empty counts as unset) and then to
 * the bundled `config/markets/<network>.json`.
 */
export function loadMarketsConfig(profile: NetworkProfile, path?: string): MarketsConfig {
  const file = path ?? (process.env.GH_MARKETS_CONFIG || join(DEFAULT_MARKETS_DIR, `${profile.name}.json`));
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarketsConfig> | null;
  if (
    !parsed ||
    typeof parsed.version !== 'number' ||
    !Array.isArray(parsed.tradeMarkets) ||
    !Array.isArray(parsed.paymentCurrencies)
  ) {
    throw new Error(
      `Invalid markets config ${file}: expected { version: number, tradeMarkets: [], paymentCurrencies: [] }`,
    );
  }
  return parsed as MarketsConfig;
}

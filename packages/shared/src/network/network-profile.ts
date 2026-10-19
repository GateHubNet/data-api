import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type NetworkName = 'xrpl' | 'xahau';

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

/** Everything that differs between the XRPL and Xahau deployments of the same images. */
export interface NetworkProfile {
  name: NetworkName;
  /** CTID network id. */
  networkId: number;
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
    networkId: 0,
    nativeCurrency: 'XRP',
    defaultDatabase: 'xrpl',
    defaultNodeEndpoints: ['wss://s2.ripple.com', 'wss://xrplcluster.com'],
    partialPaymentFixLedger: 4594094,
    software: 'rippled',
    tomlPath: '/.well-known/xrp-ledger.toml',
    defaultUnlPublishers:
      'https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,' +
      'https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1',
    majorityHoldSeconds: 1_209_600,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xrpl', definitionsPath),
  },
  xahau: {
    name: 'xahau',
    networkId: 21337,
    nativeCurrency: 'XAH',
    defaultDatabase: 'xahau',
    defaultNodeEndpoints: ['wss://xahau.network'],
    partialPaymentFixLedger: 0,
    software: 'xahaud',
    tomlPath: '/.well-known/xahau.toml',
    defaultUnlPublishers: 'https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8',
    majorityHoldSeconds: 432_000,
    amendmentThresholdPercent: 80,
    flagInterval: 256,
    definitionsFallback: (definitionsPath) => readDefinitions('xahau', definitionsPath),
  },
};

/** Resolve a profile by name, defaulting to `GH_NETWORK` and then `xrpl`. An empty `GH_NETWORK` counts as unset. */
export function getNetworkProfile(name?: string): NetworkProfile {
  const key = name ?? (process.env.GH_NETWORK || 'xrpl');
  if (!Object.prototype.hasOwnProperty.call(PROFILES, key)) {
    throw new Error(`Unknown GH_NETWORK "${key}"`);
  }
  return PROFILES[key as NetworkName];
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

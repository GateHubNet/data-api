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
  /** First ledger from which a partial payment's delivered amount is taken from `delivered_amount` metadata. */
  partialPaymentFixLedger: number;
  /**
   * Binary-codec definitions (the `server_definitions` result shape) to use when the node cannot supply them.
   * `undefined` means the codec's built-in definitions apply, or, on xahau, that no definitions file has been
   * bundled yet. The file defaults to `config/definitions/<network>.json`; `definitionsPath` overrides it (tests).
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
    partialPaymentFixLedger: 4594094,
    definitionsFallback: () => undefined,
  },
  xahau: {
    name: 'xahau',
    networkId: 21337,
    nativeCurrency: 'XAH',
    defaultDatabase: 'xahau',
    partialPaymentFixLedger: 0,
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

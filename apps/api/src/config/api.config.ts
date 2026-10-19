// Only the network profile, not the package root: the config is loaded (and its tests reload it) before anything else.
import { getNetworkProfile } from '@gatehub/data-api-shared/dist/network';
import { ConfigService, ConfigValue } from '@gatehub/toolbox/lib/config';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
import { IntValue, MaybeEmptyText, rawValue, splitList, Text, validator } from './env-decorators';

/**
 * API configuration, read from `GH_*` environment variables by the toolbox ConfigService (`@ConfigValue()` maps the
 * property `fooBar` to `GH_FOO_BAR`; an invalid value prints the problem and exits the process). The decorators of
 * `env-decorators.ts` supply what the ConfigService cannot: defaults (the initializers below), strict integers and
 * messages that name the variable.
 *
 * The toolbox is imported through its `lib/*` modules: the package root also registers its database and queue
 * configuration when it is imported, and exits the process when `GH_DATABASE_*` is missing.
 *
 * Without `GH_ENV` the ConfigService loads `.env.$NODE_ENV` (or `.env`) from the working directory and throws when
 * that file is missing, so containers (NODE_ENV=production) must set `GH_ENV` to any value.
 */

/** Every entry of a comma list of node endpoints must be a `ws://` or `wss://` URL. */
const IsEndpointList = validator(
  'isEndpointList',
  (value) =>
    typeof value === 'string' && splitList(value).length > 0 && splitList(value).every((e) => /^wss?:\/\/\S+$/.test(e)),
  (variable) => `${variable} must be a comma separated list of ws:// or wss:// URLs`,
);

/** `*`, or a comma list of `http(s)://` origins. */
const IsOriginList = validator(
  'isOriginList',
  (value) => typeof value === 'string' && (value === '*' || splitList(value).every((o) => /^https?:\/\/\S+$/.test(o))),
  (variable) => `${variable} must be * or a comma separated list of http:// or https:// origins`,
);

/** A header value: printable ASCII, so that setting it can never throw while a request is served. */
const IsHeaderValue = validator(
  'isHeaderValue',
  (value) => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value),
  (variable) => `${variable} must be printable ASCII`,
);

/**
 * `GH_NODE_ENDPOINTS`, or when it is unset or empty the public endpoints of `GH_NETWORK` (a Xahau API must not fall back to
 * an XRPL node). An unknown network takes the XRPL ones: `IsIn` on `network` reports it.
 */
function NodeEndpoints(): PropertyDecorator {
  return Transform(({ obj }) => {
    const explicit = rawValue(obj, 'nodeEndpoints');
    if (explicit !== undefined) return explicit;
    let profile;
    try {
      profile = getNetworkProfile(rawValue(obj, 'network') ?? 'xrpl');
    } catch {
      profile = getNetworkProfile('xrpl');
    }
    return profile.defaultNodeEndpoints.join(',');
  });
}

export class ApiConfig {
  /** `GH_NETWORK`: `xrpl` or `xahau`. */
  @ConfigValue()
  @Text()
  @IsIn(['xrpl', 'xahau'], { message: 'GH_NETWORK must be xrpl or xahau' })
  network: string = 'xrpl';

  /**
   * `GH_NODE_ENDPOINTS`: comma separated rippled / xahaud websocket URLs for the live-state endpoints, tried in order.
   * Default: the public endpoint of `network` (`defaultNodeEndpoints` of its profile; the initializer is the XRPL one).
   */
  @ConfigValue()
  @NodeEndpoints()
  @IsEndpointList()
  nodeEndpoints: string = 'wss://s2.ripple.com,wss://xrplcluster.com';

  /**
   * `GH_API_KEYS`: comma separated API keys, sent as `X-API-Key` or `Authorization: Bearer`. Empty disables the
   * authentication outside production; in production an empty list fails the boot (see `apiKeysOf`).
   */
  @ConfigValue()
  @MaybeEmptyText()
  apiKeys: string = '';

  /** `GH_HTTP_API_PORT`: the REST API, the probe and the swagger docs. */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  httpApiPort: number = 3001;

  /** `GH_METRICZ_PORT`: Prometheus scrape port (a second app on its own port). */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  metriczPort: number = 3000;

  /** `GH_CORS_ORIGINS`: `*` or comma separated allowed origins; empty sends no CORS headers. */
  @ConfigValue()
  @MaybeEmptyText()
  @IsOriginList()
  corsOrigins: string = '';

  /** `GH_RATE_LIMIT`: requests per client address and route within `rateLimitWindow`. */
  @ConfigValue()
  @IntValue({ min: 1 })
  rateLimit: number = 600;

  /** `GH_RATE_LIMIT_WINDOW`: the rate limit window, in seconds. */
  @ConfigValue()
  @IntValue({ min: 1 })
  rateLimitWindow: number = 60;

  /**
   * `GH_RATE_LIMIT_KEYS`: comma separated `key=limit` pairs, each an API key from `GH_API_KEYS` with its own requests
   * per `rateLimitWindow` in place of `rateLimit` (see `rateLimitKeysOf`). Empty, the default, changes nothing. A
   * secret like `apiKeys`: it holds API keys, so it is never logged or echoed.
   */
  @ConfigValue()
  @MaybeEmptyText()
  rateLimitKeys: string = '';

  /** `GH_LIVE_CACHE_TTL_MS`: how long a live-node response (balances, orders) is cached; 0 disables the cache. */
  @ConfigValue()
  @IntValue({ min: 0 })
  liveCacheTtlMs: number = 10000;

  /**
   * `GH_TX_CACHE_SIZE`: how many transactions' serialized forms (the decoded JSON and the binary hex that the responses
   * are made of) are kept in memory by transaction hash, to spare the codec on repeated requests. A transaction never
   * changes, so nothing expires; each entry is a few KB. 0 disables the cache.
   */
  @ConfigValue()
  @IntValue({ min: 0 })
  txCacheSize: number = 20000;

  /** `GH_TRUST_PROXY_HOPS`: reverse-proxy hops whose `X-Forwarded-For` is trusted for the client address. */
  @ConfigValue()
  @IntValue({ min: 0 })
  trustProxyHops: number = 1;

  /**
   * `GH_CACHE_CONTROL`: the `Cache-Control` of successful `/v2/*` responses; empty sends none. `private` by default: the
   * answers are for the holder of an API key, and a shared cache that ignores the key would hand them to anybody
   * (Ruling R109). The live routes (`/balances`, `/orders`) send their own, bound to `liveCacheTtlMs` (R108).
   */
  @ConfigValue()
  @MaybeEmptyText()
  @IsHeaderValue()
  cacheControl: string = 'private, max-age=60';

  /**
   * `GH_AMENDMENTS_CONFIG`: path of the amendment metadata file (the same file as the syncer's, so that both name an amendment
   * alike). Empty, the default, is the file shipped as `config/amendments/<network>.json`.
   */
  @ConfigValue()
  @MaybeEmptyText()
  amendmentsConfig: string = '';
}

/** The network profile of the app (`getNetworkProfile(cfg.network)`), provided by the CommonModule. */
export const NETWORK_PROFILE = Symbol('NETWORK_PROFILE');

/** The entries of a comma separated endpoint list, trimmed, without empty items. */
export function endpointList(csv: string): string[] {
  return splitList(csv);
}

/** The origin list in the shape the `cors` package takes: `*`, or the exact origins. */
export function corsOriginOf(cfg: Pick<ApiConfig, 'corsOrigins'>): '*' | string[] {
  return cfg.corsOrigins === '*' ? '*' : splitList(cfg.corsOrigins);
}

/**
 * The placeholder keys of the dev compose file (`dev-api-key`) and of the env examples (`change-me-...`): public
 * knowledge, so a production API that accepts one is open. Matched case-insensitively.
 */
function isPlaceholderKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === 'dev-api-key' || lower.startsWith('change-me');
}

/**
 * The accepted API keys (`GH_API_KEYS`, comma separated). An empty list means the authentication is off, which is for
 * development only: with `NODE_ENV=production` it throws, so that the boot fails instead of serving an open API. In
 * production a placeholder key (`dev-api-key`, or anything starting with `change-me`) throws as well.
 */
export function apiKeysOf(cfg: Pick<ApiConfig, 'apiKeys'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = splitList(cfg.apiKeys);
  if (env.NODE_ENV === 'production') {
    if (keys.length === 0) throw new Error('GH_API_KEYS must be set in production');
    if (keys.some(isPlaceholderKey)) {
      throw new Error(
        'GH_API_KEYS contains a placeholder key (dev-api-key or change-me...): set real keys in production',
      );
    }
  }
  return keys;
}

/**
 * The per-key rate limits (`GH_RATE_LIMIT_KEYS`, comma separated `key=limit`): a map from API key to its requests per
 * window. A pair splits at its last `=` (an API key may end in `=`), and the entry and both sides are trimmed. Every
 * entry needs a non-empty key and a positive whole limit (a safe integer: a larger one is no longer exact), the key has
 * to be one of `GH_API_KEYS`, and no key is listed
 * twice. A failure names the entry by its position (1-based), never by key: the keys are secrets, and the message ends
 * up in the logs. Empty means no overrides; a non-empty setting without `GH_API_KEYS` throws.
 */
export function rateLimitKeysOf(cfg: Pick<ApiConfig, 'apiKeys' | 'rateLimitKeys'>): Map<string, number> {
  const entries = splitList(cfg.rateLimitKeys);
  const limits = new Map<string, number>();
  if (entries.length === 0) return limits;
  const known = new Set(splitList(cfg.apiKeys));
  if (known.size === 0) throw new Error('GH_RATE_LIMIT_KEYS needs GH_API_KEYS');
  entries.forEach((entry, index) => {
    const at = `GH_RATE_LIMIT_KEYS entry ${index + 1}`;
    const split = entry.lastIndexOf('=');
    const key = split < 0 ? '' : entry.slice(0, split).trim();
    if (key === '') throw new Error(`${at} must be key=limit`);
    const limit = entry.slice(split + 1).trim();
    if (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
      throw new Error(`${at} must have a positive whole limit`);
    }
    if (!known.has(key)) throw new Error(`${at} names a key that is not in GH_API_KEYS`);
    if (limits.has(key)) throw new Error(`${at} repeats a key`);
    limits.set(key, Number(limit));
  });
  return limits;
}

let loading: Promise<ApiConfig> | undefined;

/**
 * Registers and returns the API configuration. Safe to call any number of times: the toolbox ConfigService throws on
 * a second registration of the same schema, so `main.ts` (which needs the ports) and the AppModule share this promise.
 */
export function loadApiConfig(): Promise<ApiConfig> {
  loading ??= (async () => {
    await GateHubConfigModule.forFeature(ApiConfig);
    return new ConfigService().get(ApiConfig);
  })();
  return loading;
}

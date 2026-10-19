// Only the network profile, not the package root: the config is loaded (and its tests reload it) before anything else.
import {
  defaultUnlThreshold,
  getNetworkProfile,
  NetworkProfile,
  parseUnlPublishers,
  UnlPublisherConfig,
} from '@gatehub/data-api-shared/dist/network';
import { ConfigService, ConfigValue } from '@gatehub/toolbox/lib/config';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { Transform } from 'class-transformer';
import { IsIn, IsString, registerDecorator, ValidateIf, ValidationArguments } from 'class-validator';

/**
 * Syncer configuration, read from `GH_*` environment variables by the toolbox ConfigService (`@ConfigValue()` maps the
 * property `fooBar` to `GH_FOO_BAR`; an invalid value prints the problem and exits the process).
 *
 * The toolbox pipeline cannot express an optional or defaulted value on its own: an unset variable overwrites a class
 * initializer with `undefined`, `@ConfigValue()` makes every value required, and the implicit conversion turns
 * the string "false" into `true` and a blank into `0`. The decorators below read the raw variable instead, and take the
 * default from the initializer (via `DEFAULTS`).
 *
 * The toolbox is imported through its `lib/*` modules: the package root also registers its database and queue
 * configuration when it is imported, and exits the process when `GH_DATABASE_*` is missing.
 *
 * Without `GH_ENV` the ConfigService loads `.env.$NODE_ENV` (or `.env`) from the working directory and throws when
 * that file is missing, so containers (NODE_ENV=production) must set `GH_ENV` to any value.
 */

export const WORKER_NAMES = ['ingest', 'validations', 'fee_stats', 'aggregator', 'validators'] as const;
export type WorkerName = (typeof WORKER_NAMES)[number];

/** `ledgerFetchTimeoutMs` -> `GH_LEDGER_FETCH_TIMEOUT_MS`: the name the ConfigService reads. */
function envName(property: string): string {
  return `GH_${property.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** The raw string behind `obj[key]`, trimmed; `undefined` when the variable is unset or blank. */
function rawValue(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The default of `key`: the property initializer of `SyncerConfig`. */
function defaultOf(key: string): unknown {
  return (DEFAULTS as unknown as Record<string, unknown>)[key];
}

/** A class-validator decorator whose message names the environment variable instead of the property. */
function validator(
  name: string,
  validate: (value: unknown, args: ValidationArguments) => boolean,
  describe: (variable: string, args: ValidationArguments) => string,
): () => PropertyDecorator {
  return () => (target, propertyKey) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate,
        defaultMessage: (args: ValidationArguments) => describe(envName(args.property), args),
      },
    });
}

/** Every name of a comma list of workers must be known; the message is the one `enabledWorkers` throws. */
const IsWorkerList = validator(
  'isWorkerList',
  (value) => {
    try {
      parseWorkers(String(value));
      return true;
    } catch {
      return false;
    }
  },
  (variable, args) => {
    try {
      parseWorkers(String(args.value));
      return `${variable} is invalid`;
    } catch (err) {
      return `${variable}: ${(err as Error).message}`;
    }
  },
);

/** Separates a comma list the same way everywhere (node endpoints, workers). */
function splitList(csv: string): string[] {
  return csv
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Every entry of a comma list of node endpoints must be a `ws://` or `wss://` URL. */
const IsEndpointList = validator(
  'isEndpointList',
  (value) =>
    typeof value === 'string' && splitList(value).length > 0 && splitList(value).every((e) => /^wss?:\/\/\S+$/.test(e)),
  (variable) => `${variable} must be a comma separated list of ws:// or wss:// URLs`,
);

/** The publishers of a `GH_UNL_PUBLISHERS` text, or the reason it cannot be read (the message names the variable). */
function tryParsePublishers(text: unknown): { publishers: UnlPublisherConfig[] } | { reason: string } {
  try {
    return { publishers: parseUnlPublishers(String(text)) };
  } catch (err) {
    return { reason: (err as Error).message };
  }
}

/** Every entry of `GH_UNL_PUBLISHERS` must be a valid `url=key` pair; the message is the one `parseUnlPublishers` throws. */
const IsUnlPublishers = validator(
  'isUnlPublishers',
  (value) => 'publishers' in tryParsePublishers(value),
  (variable, args) => {
    const parsed = tryParsePublishers(args.value);
    return 'reason' in parsed ? parsed.reason : `${variable} is invalid`;
  },
);

/**
 * The threshold may not exceed the number of publishers. Publishers that cannot be read, and a threshold that is not a
 * non-negative integer, are reported on their own (by `IsUnlPublishers` and `IntValue`), and not again here.
 */
const IsWithinPublishers = validator(
  'isWithinPublishers',
  (value, args) => {
    const parsed = tryParsePublishers((args.object as SyncerConfig).unlPublishers);
    if (!('publishers' in parsed) || !Number.isSafeInteger(value) || (value as number) < 0) return true;
    return (value as number) <= parsed.publishers.length;
  },
  (variable, args) => {
    const parsed = tryParsePublishers((args.object as SyncerConfig).unlPublishers);
    const count = 'publishers' in parsed ? parsed.publishers.length : 0;
    return `${variable} must be between 0 and the number of publishers (${count})`;
  },
);

/** An integer between `min` and `max`, read from the env as plain decimal digits (so `1.5`, `1e3` and `abc` are invalid). */
function IntValue(options: { min: number; max?: number; optional?: boolean }): PropertyDecorator {
  const { min, max, optional } = options;
  const range =
    max !== undefined
      ? `an integer between ${min} and ${max}`
      : min === 1
        ? 'a positive integer'
        : 'a non-negative integer';
  const check = validator(
    'isConfigInteger',
    (value) =>
      Number.isSafeInteger(value) && (value as number) >= min && (max === undefined || (value as number) <= max),
    (variable) => `${variable} must be ${range}`,
  )();
  const read = Transform(({ obj, key }) => {
    const raw = rawValue(obj, key);
    if (raw === undefined) return optional ? undefined : defaultOf(key);
    return /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  });
  return (target, key) => {
    read(target, key);
    check(target, key);
  };
}

/**
 * A string that may be empty (`GH_UNL_PUBLISHERS=`): an unset variable takes `fallback` (the initializer by default), a set
 * one is used as it is (trimmed), and an empty value skips the other validators of the property.
 */
function MaybeEmptyText(fallback?: (obj: Record<string, unknown>) => string): PropertyDecorator {
  return (target, key) => {
    Transform(({ obj }) => {
      const value = obj[key as string];
      return typeof value === 'string' ? value.trim() : (fallback?.(obj) ?? defaultOf(key as string));
    })(target, key);
    ValidateIf((config: Record<string, unknown>) => config[key as string] !== '')(target, key);
    IsString()(target, key);
  };
}

/** `true`, `false`, `1` or `0` in any case; unset or blank takes the initializer. */
function BoolValue(): PropertyDecorator {
  const check = validator(
    'isConfigBoolean',
    (value) => typeof value === 'boolean',
    (variable) => `${variable} must be true or false`,
  )();
  return (target, key) => {
    Transform(({ obj }) => {
      const raw = rawValue(obj, key as string)?.toLowerCase();
      if (raw === undefined) return defaultOf(key as string);
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return raw; // not a boolean: the check rejects it
    })(target, key);
    check(target, key);
  };
}

/** The profile of `GH_NETWORK`. An unknown network takes the XRPL one: `IsIn` on `network` reports it. */
function networkProfileOf(obj: Record<string, unknown>): NetworkProfile {
  try {
    return getNetworkProfile(rawValue(obj, 'network') ?? 'xrpl');
  } catch {
    return getNetworkProfile('xrpl');
  }
}

/** The public node endpoints of `GH_NETWORK` (a Xahau syncer must not fall back to an XRPL node). */
function defaultNodeEndpoints(obj: Record<string, unknown>): string {
  return networkProfileOf(obj).defaultNodeEndpoints.join(',');
}

/** The default validator list publishers of `GH_NETWORK` (a Xahau syncer must not fall back to the XRPL lists). */
function defaultUnlPublishersOf(obj: Record<string, unknown>): string {
  return networkProfileOf(obj).defaultUnlPublishers;
}

export class SyncerConfig {
  /** `GH_NETWORK`: `xrpl` or `xahau`. */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key) ?? defaultOf(key))
  @IsIn(['xrpl', 'xahau'], { message: 'GH_NETWORK must be xrpl or xahau' })
  network: string = 'xrpl';

  /**
   * `GH_NODE_ENDPOINTS`: comma separated rippled / xahaud websocket URLs, tried in order. Default: the public endpoint of
   * `network` (`defaultNodeEndpoints` of its profile).
   */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key) ?? defaultNodeEndpoints(obj))
  @IsEndpointList()
  nodeEndpoints!: string;

  /** `GH_VALIDATION_ENDPOINTS`: comma separated nodes the validations collector subscribes to. Default `nodeEndpoints`. */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key) ?? rawValue(obj, 'nodeEndpoints') ?? defaultNodeEndpoints(obj))
  @IsEndpointList()
  validationEndpoints!: string;

  /** `GH_WORKERS`: comma separated subset of `ingest,validations,fee_stats,aggregator,validators`; empty runs none of them. */
  @ConfigValue()
  @Transform(({ obj, key }) => (typeof obj[key] === 'string' ? obj[key].trim() : defaultOf(key)))
  @ValidateIf((config: SyncerConfig) => config.workers !== '')
  @IsWorkerList()
  workers: string = WORKER_NAMES.join(',');

  /** `GH_SYNC_START_LEDGER`: where the very first run starts; default is the validated head. */
  @ConfigValue()
  @IntValue({ min: 1, optional: true })
  @ValidateIf((config: SyncerConfig) => config.syncStartLedger !== undefined)
  syncStartLedger?: number;

  /** `GH_LEDGER_FETCH_TIMEOUT_MS`: timeout of one expanded `ledger` request. */
  @ConfigValue()
  @IntValue({ min: 1 })
  ledgerFetchTimeoutMs: number = 120000;

  /**
   * `GH_CATCHUP_CONCURRENCY`: ledgers fetched in parallel while catching up (default 4, ruling R98). Observed on the public
   * nodes: `wss://s2.ripple.com` did not throttle a first sync at 2; `wss://xahau.network` throttles even at 1, which the
   * runner waits out. Raise it with a node of your own.
   */
  @ConfigValue()
  @IntValue({ min: 1 })
  catchupConcurrency: number = 4;

  /** `GH_CATCHUP_FLUSH_LEDGERS`: flush a catch-up batch at this many ledgers ... */
  @ConfigValue()
  @IntValue({ min: 1 })
  catchupFlushLedgers: number = 300;

  /** `GH_CATCHUP_FLUSH_TXS`: ... or this many transactions ... */
  @ConfigValue()
  @IntValue({ min: 1 })
  catchupFlushTxs: number = 100000;

  /** `GH_CATCHUP_FLUSH_MS`: ... or after this long, whichever comes first. */
  @ConfigValue()
  @IntValue({ min: 1 })
  catchupFlushMs: number = 5000;

  /** `GH_RUN_MIGRATIONS_ON_BOOT`: apply the ClickHouse schema before the workers start. */
  @ConfigValue()
  @BoolValue()
  runMigrationsOnBoot: boolean = false;

  /** `GH_HTTP_API_PORT`: liveliness probe. */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  httpApiPort: number = 3002;

  /** `GH_METRICZ_PORT`: Prometheus scrape port (a second app on its own port). */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  metriczPort: number = 3000;

  /** `GH_MAX_LAG_HEALTHY`: liveliness fails when the ingest lag stays above this (in ledgers) for more than 60 s. */
  @ConfigValue()
  @IntValue({ min: 0 })
  maxLagHealthy: number = 10;

  /**
   * `GH_UNL_PUBLISHERS`: comma separated `url=publicKey` validator list publishers of the `validators` worker (see
   * `parseUnlPublishers`). Unset: the default publishers of `network`. Set but empty: no lists, so every validator is untrusted.
   */
  @ConfigValue()
  @MaybeEmptyText(defaultUnlPublishersOf)
  @IsUnlPublishers()
  unlPublishers!: string;

  /** `GH_UNL_THRESHOLD`: lists that must name a validator for it to be trusted; 0 is rippled's rule (see `unlThresholdOf`). */
  @ConfigValue()
  @IntValue({ min: 0 })
  @IsWithinPublishers()
  unlThreshold: number = 0;

  /** `GH_UNL_REFRESH_MS`: refresh interval of a list that gives no `refresh_interval`. */
  @ConfigValue()
  @IntValue({ min: 1 })
  unlRefreshMs: number = 300000;

  /** `GH_DOMAIN_VERIFICATION`: `false` skips the checks of validator domains (a host without outbound HTTPS). */
  @ConfigValue()
  @BoolValue()
  domainVerification: boolean = true;

  /** `GH_DOMAIN_RECHECK_MS`: how long a definite domain result stands before it is checked again. */
  @ConfigValue()
  @IntValue({ min: 1 })
  domainRecheckMs: number = 21600000;

  /** `GH_DOMAIN_FETCH_TIMEOUT_MS`: overall timeout of one TOML fetch, redirects included. */
  @ConfigValue()
  @IntValue({ min: 1 })
  domainFetchTimeoutMs: number = 10000;

  /** `GH_AMENDMENTS_CONFIG`: path of the amendment metadata file; empty is the file shipped as `config/amendments/<network>.json`. */
  @ConfigValue()
  @MaybeEmptyText()
  amendmentsConfig: string = '';
}

/** An instance holds the defaults (the property initializers) for the decorators above. */
const DEFAULTS = new SyncerConfig();

export const NODE_CLIENT = Symbol('NODE_CLIENT');
export const NETWORK_PROFILE = Symbol('NETWORK_PROFILE');
export const PARSE_CONTEXT = Symbol('PARSE_CONTEXT');

/** The entries of a comma separated endpoint list, trimmed, without empty items. */
export function endpointList(csv: string): string[] {
  return splitList(csv);
}

/** `wss://user:key@host:443/path?token=...` -> `wss://host:443`: endpoints may carry credentials, so logs show only this. */
export function endpointHost(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(invalid url)';
  }
}

function parseWorkers(csv: string): WorkerName[] {
  const names = splitList(csv);
  for (const name of names) {
    if (!(WORKER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown worker "${name}"`);
    }
  }
  return names as WorkerName[];
}

/**
 * The validator list publishers of `cfg.unlPublishers`, parsed. A syncer that booted holds a valid text, so this does not
 * throw there; an invalid one throws `GH_UNL_PUBLISHERS entry <n>: <why>`.
 */
export function unlPublishersOf(cfg: Pick<SyncerConfig, 'unlPublishers'>): UnlPublisherConfig[] {
  return parseUnlPublishers(cfg.unlPublishers);
}

/**
 * The number of lists that must name a validator for it to be trusted: `GH_UNL_THRESHOLD`, or when that is 0 rippled's rule
 * for the number of publishers (`defaultUnlThreshold`).
 */
export function unlThresholdOf(cfg: Pick<SyncerConfig, 'unlPublishers' | 'unlThreshold'>): number {
  return cfg.unlThreshold > 0 ? cfg.unlThreshold : defaultUnlThreshold(unlPublishersOf(cfg).length);
}

/** The workers named by `cfg.workers`. An empty list enables none; an unknown name throws `Unknown worker "<name>"`. */
export function enabledWorkers(cfg: Pick<SyncerConfig, 'workers'>): Set<WorkerName> {
  return new Set(parseWorkers(cfg.workers));
}

let loading: Promise<SyncerConfig> | undefined;

/**
 * Registers and returns the syncer configuration. Safe to call any number of times: the toolbox ConfigService throws on
 * a second registration of the same schema, so `main.ts` (which needs the ports) and the AppModule share this promise.
 */
export function loadSyncerConfig(): Promise<SyncerConfig> {
  loading ??= (async () => {
    await GateHubConfigModule.forFeature(SyncerConfig);
    return new ConfigService().get(SyncerConfig);
  })();
  return loading;
}

import { ConfigService, ConfigValue } from '@gatehub/toolbox/lib/config';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, registerDecorator, ValidateIf, ValidationArguments } from 'class-validator';

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

export const WORKER_NAMES = ['ingest', 'validations', 'fee_stats', 'aggregator'] as const;
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
  validate: (value: unknown) => boolean,
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

export class SyncerConfig {
  /** `GH_NETWORK`: `xrpl` or `xahau`. */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key) ?? defaultOf(key))
  @IsIn(['xrpl', 'xahau'], { message: 'GH_NETWORK must be xrpl or xahau' })
  network: string = 'xrpl';

  /** `GH_NODE_ENDPOINTS`: comma separated rippled / xahaud websocket URLs, tried in order. Required. */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key))
  @IsEndpointList()
  nodeEndpoints!: string;

  /** `GH_VALIDATION_ENDPOINTS`: comma separated nodes the validations collector subscribes to. Default `nodeEndpoints`. */
  @ConfigValue()
  @Transform(({ obj, key }) => rawValue(obj, key) ?? rawValue(obj, 'nodeEndpoints'))
  @IsEndpointList()
  validationEndpoints!: string;

  /** `GH_WORKERS`: comma separated subset of `ingest,validations,fee_stats,aggregator`; empty runs none of them. */
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

  /** `GH_CATCHUP_CONCURRENCY`: ledgers fetched in parallel while catching up. */
  @ConfigValue()
  @IntValue({ min: 1 })
  catchupConcurrency: number = 8;

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
  @Transform(({ obj, key }) => {
    const raw = rawValue(obj, key)?.toLowerCase();
    if (raw === undefined) return defaultOf(key);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return raw; // not a boolean: IsBoolean rejects it
  })
  @IsBoolean({ message: 'GH_RUN_MIGRATIONS_ON_BOOT must be true or false' })
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

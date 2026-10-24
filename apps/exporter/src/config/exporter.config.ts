import { ConfigService, ConfigValue } from '@gatehub/toolbox/lib/config';
import { GateHubConfigModule } from '@gatehub/toolbox/lib/config/config.module';
import { IsIn } from 'class-validator';
import { IntValue, MaybeEmptyText, Text, validator } from './env-decorators';

/**
 * Exporter configuration, read from `GH_*` environment variables by the toolbox ConfigService, the way the api reads
 * its own (see `env-decorators.ts`: defaults are the initializers below). The ClickHouse settings are not here:
 * `clickHouseConfigFromEnv` reads the `GH_CLICKHOUSE_*` variables, as in the other apps.
 *
 * The toolbox is imported through its `lib/*` modules: the package root also registers its database and queue
 * configuration when it is imported, and exits the process when `GH_DATABASE_*` is missing.
 */

/** An `http://` or `https://` URL. */
const IsHttpUrl = validator(
  'isHttpUrl',
  (value) => typeof value === 'string' && /^https?:\/\/\S+$/.test(value),
  (variable) => `${variable} must be an http:// or https:// URL`,
);

/** A bucket name, as Google Cloud Storage allows it: lower case letters, digits, `-`, `_` and `.`, 3 to 222 characters. */
const IsBucketName = validator(
  'isBucketName',
  (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(value),
  (variable) => `${variable} must be a Google Cloud Storage bucket name`,
);

export class ExporterConfig {
  /** `GH_NETWORK`: `xrpl` or `xahau`. The exporter makes the exports of this network only. */
  @ConfigValue()
  @Text()
  @IsIn(['xrpl', 'xahau'], { message: 'GH_NETWORK must be xrpl or xahau' })
  network: string = 'xrpl';

  /** `GH_API_URL`: the base URL of this network's api, whose lists the exporter walks. */
  @ConfigValue()
  @Text()
  @IsHttpUrl()
  apiUrl: string = 'http://127.0.0.1:3001';

  /**
   * `GH_EXPORTER_API_KEY`: the exporter's own API key, one of the api's `GH_API_KEYS`, best with a large budget in its
   * `GH_RATE_LIMIT_KEYS`. A secret. Empty sends no key (an api without keys, in development).
   */
  @ConfigValue()
  @MaybeEmptyText()
  exporterApiKey: string = '';

  /**
   * `GH_EXPORT_BUCKET`: the Google Cloud Storage bucket of the export files (the api's `GH_EXPORT_BUCKET`); this
   * network's files are under `<network>/`. The client uses the application default credentials
   * (`GOOGLE_APPLICATION_CREDENTIALS`). Required.
   */
  @ConfigValue()
  @Text()
  @IsBucketName()
  exportBucket!: string;

  /** `GH_EXPORT_PAGE_SIZE`: the `limit` of each page the exporter asks for (a list serves at most its own maximum). */
  @ConfigValue()
  @IntValue({ min: 1, max: 1000 })
  exportPageSize: number = 1000;

  /** `GH_EXPORT_POLL_MS`: how often the exporter looks for a queued job while it has none, in milliseconds. */
  @ConfigValue()
  @IntValue({ min: 100 })
  exportPollMs: number = 2000;

  /** `GH_EXPORT_REQUEST_TIMEOUT_MS`: how long one page of a list may take, in milliseconds; a slower one fails the job. */
  @ConfigValue()
  @IntValue({ min: 1000 })
  exportRequestTimeoutMs: number = 60000;

  /** `GH_HTTP_API_PORT`: the liveliness probe. */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  httpApiPort: number = 3005;

  /** `GH_METRICZ_PORT`: Prometheus scrape port (a second app on its own port). */
  @ConfigValue()
  @IntValue({ min: 1, max: 65535 })
  metriczPort: number = 3000;
}

/** The network profile of the app, provided by the AppModule. */
export const NETWORK_PROFILE = Symbol('NETWORK_PROFILE');

let loading: Promise<ExporterConfig> | undefined;

/**
 * Registers and returns the exporter configuration. Safe to call any number of times: the toolbox ConfigService throws
 * on a second registration of the same schema, so `main.ts` (which needs the ports) and the AppModule share this promise.
 */
export function loadExporterConfig(): Promise<ExporterConfig> {
  loading ??= (async () => {
    await GateHubConfigModule.forFeature(ExporterConfig);
    return new ConfigService().get(ExporterConfig);
  })();
  return loading;
}

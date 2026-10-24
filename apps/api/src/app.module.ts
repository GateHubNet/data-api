import {
  clickHouseConfigFromEnv,
  getNetworkProfile,
  NetworkProfile,
  sharedDatabaseFromEnv,
} from '@gatehub/data-api-shared';
import {
  DynamicModule,
  Inject,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  RequestMethod,
  Type,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import compression from 'compression';
import cors from 'cors';
import { NextFunction, Request, Response } from 'express';
import { AccountsModule } from './accounts/accounts.module';
import { ActiveAccountsModule } from './active-accounts/active-accounts.module';
import { AmmModule } from './amm/amm.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { ApiThrottlerGuard } from './common/api-throttler.guard';
import { CommonModule } from './common/common.module';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { NotFoundModule } from './common/not-found.controller';
import { pathDecodeErrors } from './common/path-decode-errors';
import {
  ApiConfig,
  apiKeysOf,
  corsOriginOf,
  loadApiConfig,
  NETWORK_PROFILE,
  rateLimitKeysOf,
} from './config/api.config';
import { ExchangesModule } from './exchanges/exchanges.module';
import { RatesModule } from './exchanges/rates.module';
import { ExportsModule } from './exports/exports.module';
import { LedgersModule } from './ledgers/ledgers.module';
import { LivelinessModule } from './modules/liveliness/liveliness.module';
import { NetworkModule } from './network/network.module';
import { PathPaymentsModule } from './path-payments/path-payments.module';
import { PaymentsModule } from './payments/payments.module';
import { StatsModule } from './stats/stats.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ValidationsModule } from './validations/validations.module';
import { ValidatorsModule } from './validators/validators.module';
import { XrplModule } from './xrpl/xrpl.module';

/**
 * Reads the configuration (GH_* variables, see `ApiConfig`) and assembles the shared infrastructure. Importing
 * `app.module` therefore loads and validates the configuration, and refuses the keyless production boot.
 */
async function assemble(): Promise<DynamicModule> {
  const config = await loadApiConfig();
  apiKeysOf(config); // throws now, before anything is built, when production has no key
  rateLimitKeysOf(config); // and on an invalid GH_RATE_LIMIT_KEYS (the guard checks it again when it is built)
  const profile = getNetworkProfile(config.network);
  return CommonModule.register({
    config,
    profile,
    clickHouse: clickHouseConfigFromEnv(process.env, profile),
    sharedDatabase: sharedDatabaseFromEnv(process.env),
  });
}

const assembled = assemble();
// A failure (invalid configuration, a keyless production boot, ...) is reported when Nest awaits the module in
// `NestFactory.create`; this handler only keeps it from also being reported as an unhandled rejection while the import
// is still running.
assembled.catch(() => undefined);

/**
 * The Ripple endpoint modules. Each of the Phase 5-8 tasks adds its module here. They are listed BEFORE the
 * `NotFoundModule` below, the `/v2/*` catch-all, which has to be the last thing Nest registers.
 */
const ENDPOINT_MODULES: Type<unknown>[] = [
  LedgersModule,
  TransactionsModule,
  PaymentsModule,
  PathPaymentsModule,
  ExchangesModule,
  RatesModule,
  AccountsModule,
  ActiveAccountsModule,
  NetworkModule,
  ValidationsModule,
  ValidatorsModule,
  StatsModule,
  AmmModule,
  ExportsModule,
];

/** `Cache-Control` for the `/v2` responses that succeed; `RippleErrorFilter` replaces it with `no-store` on an error. */
function cacheControl(value: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', value);
    next();
  };
}

@Module({
  imports: [
    assembled,
    ThrottlerModule.forRootAsync({
      inject: [ApiConfig],
      useFactory: (config: ApiConfig) => [{ ttl: config.rateLimitWindow * 1000, limit: config.rateLimit }],
    }),
    XrplModule,
    LivelinessModule,
    ...ENDPOINT_MODULES,
    NotFoundModule, // last: it answers every /v2 route nothing above serves
  ],
  providers: [
    // The key is checked before the rate limit, so requests without a valid key do not use up anybody's budget.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ApiThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  // Property injection: the toolbox `bootstrap()` takes the root module as a `new () => NestModule`, so it cannot have
  // constructor parameters.
  @Inject(ApiConfig) private readonly config!: ApiConfig;
  @Inject(HttpAdapterHost) private readonly adapterHost!: HttpAdapterHost;
  @Inject(NETWORK_PROFILE) private readonly profile!: NetworkProfile;

  /** The toolbox `bootstrap()` returns no app handle, so the Express-level settings are applied here. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(compression()).forRoutes({ path: '*', method: RequestMethod.ALL });
    if (this.config.corsOrigins !== '') {
      consumer.apply(cors({ origin: corsOriginOf(this.config) })).forRoutes({ path: '*', method: RequestMethod.ALL });
    }
    if (this.config.cacheControl !== '') {
      consumer.apply(cacheControl(this.config.cacheControl)).forRoutes({ path: 'v2/*', method: RequestMethod.ALL });
    }
  }

  onModuleInit(): void {
    new Logger('Api').log(`network=${this.profile.name} native=${this.profile.nativeCurrency}`);
    // The service runs behind the GateHub reverse proxy (TLS termination + edge routing). Trust it so `req.ip` resolves
    // to the real client from X-Forwarded-For, which the rate limit and the logs need. `trustProxyHops` is how many
    // hops to trust (1 = the GateHub proxy).
    const app = this.adapterHost.httpAdapter.getInstance<{
      set(setting: string, value: unknown): void;
      use(handler: unknown): void;
    }>();
    app.set('trust proxy', this.config.trustProxyHops);
    // A malformed percent-escape in a /v2 path is a Ripple 400 (R55). Nest calls this hook after it registered the routes
    // and before its own exception handler, which is where an Express error middleware has to go.
    app.use(pathDecodeErrors);
  }
}

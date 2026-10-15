import { ClickHouseModule } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { API_CONFIG, ApiConfig, ConfigModule } from './config/api.config';
import { ExchangesModule } from './exchanges/exchanges.module';
import { LedgersModule } from './ledgers/ledgers.module';
import { LivelinessModule } from './modules/liveliness/liveliness.module';
import { PrometheusModule } from './modules/prometheus/prometheus.module';
import { NetworkModule } from './network/network.module';
import { PaymentsModule } from './payments/payments.module';
import { StatsModule } from './stats/stats.module';
import { TransactionsModule } from './transactions/transactions.module';
import { XrplModule } from './xrpl/xrpl.module';

@Module({
  imports: [
    ConfigModule,
    ClickHouseModule.forRoot(),
    XrplModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => [{ ttl: config.rateLimitWindow * 1000, limit: config.rateLimit }],
    }),
    PrometheusModule,
    LivelinessModule,
    PaymentsModule,
    TransactionsModule,
    LedgersModule,
    StatsModule,
    NetworkModule,
    ExchangesModule,
    AccountsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule {}

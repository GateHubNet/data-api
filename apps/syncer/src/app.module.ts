import { ClickHouseModule } from '@gatehub/data-api-shared';
import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { LivelinessModule } from './modules/liveliness/liveliness.module';
import { PrometheusModule } from './modules/prometheus/prometheus.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule, ClickHouseModule.forRoot(), PrometheusModule, LivelinessModule, SyncModule],
  providers: [AppService],
})
export class AppModule {}

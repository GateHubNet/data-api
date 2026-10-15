import { Global, Module } from '@nestjs/common';
import { SYNCER_CONFIG, syncerConfigFromEnv } from './syncer.config';

@Global()
@Module({
  providers: [{ provide: SYNCER_CONFIG, useFactory: () => syncerConfigFromEnv() }],
  exports: [SYNCER_CONFIG],
})
export class ConfigModule {}

import { clickHouseConfigFromEnv, getNetworkProfile } from '@gatehub/data-api-shared';
import { DynamicModule, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { enabledWorkers, endpointHost, endpointList, loadSyncerConfig } from './config/syncer.config';
import { SyncerCoreModule } from './core/syncer-core.module';
import { selectWorkerModules } from './worker-registry';

/**
 * Reads the configuration (GH_* variables, see `SyncerConfig`) and assembles the app: the shared infrastructure plus the
 * modules of the enabled workers. Importing `app.module` therefore loads and validates the configuration.
 */
async function assemble(): Promise<DynamicModule> {
  const config = await loadSyncerConfig();
  const profile = getNetworkProfile(config.network);
  const logger = new Logger('Syncer');
  const workers = enabledWorkers(config);
  logger.log(
    `network=${profile.name} workers=${workers.size === 0 ? '(none)' : [...workers].join(',')} ` +
      `nodes=${endpointList(config.nodeEndpoints).map(endpointHost).join(',')}`,
  );
  return SyncerCoreModule.register({
    config,
    profile,
    clickHouse: clickHouseConfigFromEnv(process.env, profile),
    workerModules: selectWorkerModules(workers),
  });
}

const assembled = assemble();
// A failure (missing env file, unknown worker, ...) is reported when Nest awaits the module in `NestFactory.create`;
// this handler only keeps it from also being reported as an unhandled rejection while the import is still running.
assembled.catch(() => undefined);

@Module({ imports: [assembled] })
export class AppModule implements NestModule {
  // The toolbox bootstrap() types its root module as a NestModule; the syncer has no middleware.
  configure(_consumer: MiddlewareConsumer): void {}
}

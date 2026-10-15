import { DynamicModule, Logger, Type } from '@nestjs/common';
import { WORKER_NAMES, WorkerName } from './config/syncer.config';
import { IngestModule } from './ingest/ingest.module';

/** What a worker contributes to the app: its Nest module (static or dynamic). */
export type WorkerModule = Type<unknown> | DynamicModule;

export type WorkerModuleRegistry = Partial<Record<WorkerName, WorkerModule>>;

/**
 * The worker -> module registry. A worker module is only imported when its name is in `GH_WORKERS`.
 *
 * Each worker adds its own line (`validations: ValidationsModule`, `fee_stats: FeesModule`,
 * `aggregator: AggregatorModule`) and nothing else in the app changes.
 *
 * The module that provides `INGEST_STATUS` for the liveliness probe must be `@Global()` and export that token.
 */
export const WORKER_MODULES: WorkerModuleRegistry = {
  ingest: IngestModule,
};

/**
 * The modules of the enabled workers, in `WORKER_NAMES` order. An enabled worker with no registered module is
 * reported with a warning and skipped: the app still starts with the workers that exist.
 */
export function selectWorkerModules(
  enabled: ReadonlySet<WorkerName>,
  registry: WorkerModuleRegistry = WORKER_MODULES,
  logger: Pick<Logger, 'warn'> = new Logger('Workers'),
): WorkerModule[] {
  const modules: WorkerModule[] = [];
  for (const name of WORKER_NAMES) {
    if (!enabled.has(name)) continue;
    const module = registry[name];
    if (module === undefined) {
      logger.warn(`Worker "${name}" is enabled but has no module registered yet; skipping it`);
    } else {
      modules.push(module);
    }
  }
  return modules;
}

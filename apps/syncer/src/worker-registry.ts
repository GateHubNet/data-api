import { DynamicModule, Logger, Type } from '@nestjs/common';
import { AggregatorModule } from './aggregator/aggregator.module';
import { WORKER_NAMES, WorkerName } from './config/syncer.config';
import { FeesModule } from './fees/fees.module';
import { IngestModule } from './ingest/ingest.module';
import { ValidationsModule } from './validations/validations.module';
import { ValidatorsModule } from './validators/validators.module';

/** What a worker contributes to the app: its Nest module (static or dynamic). */
export type WorkerModule = Type<unknown> | DynamicModule;

export type WorkerModuleRegistry = Partial<Record<WorkerName, WorkerModule>>;

/**
 * The worker -> module registry. A worker module is only imported when its name is in `GH_WORKERS`.
 *
 * Each worker adds its own line and nothing else in the app changes.
 *
 * The module that provides `INGEST_STATUS` for the liveliness probe must be `@Global()` and export that token.
 */
export const WORKER_MODULES: WorkerModuleRegistry = {
  ingest: IngestModule,
  fee_stats: FeesModule,
  validations: ValidationsModule,
  aggregator: AggregatorModule,
  validators: ValidatorsModule,
};

/** The workers that read from the shared node client (`NODE_CLIENT`). The validations collector makes its own. */
export const NODE_CLIENT_WORKERS: ReadonlySet<WorkerName> = new Set<WorkerName>(['ingest', 'fee_stats', 'validators']);

/** Whether one of the enabled workers reads from the shared node client: only then does the app make one (ruling R99). */
export function needsNodeClient(enabled: ReadonlySet<WorkerName>): boolean {
  return [...enabled].some((name) => NODE_CLIENT_WORKERS.has(name));
}

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

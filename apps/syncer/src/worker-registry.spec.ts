import { Module } from '@nestjs/common';
import { WORKER_NAMES, WorkerName } from './config/syncer.config';
import { ValidatorsModule } from './validators/validators.module';
import {
  needsNodeClient,
  NODE_CLIENT_WORKERS,
  selectWorkerModules,
  WORKER_MODULES,
  WorkerModuleRegistry,
} from './worker-registry';

@Module({})
class IngestStubModule {}

@Module({})
class FeesStubModule {}

const logger = () => ({ warn: jest.fn() });

describe('the worker registry', () => {
  it('registers the validators worker', () => {
    expect(WORKER_MODULES.validators).toBe(ValidatorsModule);
    expect(selectWorkerModules(new Set<WorkerName>(['validators']), WORKER_MODULES, logger())).toEqual([
      ValidatorsModule,
    ]);
  });

  it('has a module for every worker', () => {
    for (const name of WORKER_NAMES) expect(WORKER_MODULES[name]).toBeDefined();
  });

  it('makes the node client for the validators worker, as it does for ingest and fee_stats', () => {
    expect(NODE_CLIENT_WORKERS.has('validators')).toBe(true);
    expect(needsNodeClient(new Set<WorkerName>(['validators']))).toBe(true);
    expect(needsNodeClient(new Set<WorkerName>(['aggregator', 'validations']))).toBe(false);
  });
});

describe('selectWorkerModules', () => {
  const registry: WorkerModuleRegistry = { ingest: IngestStubModule, fee_stats: FeesStubModule };

  it('returns the modules of the enabled workers that are registered, in worker order', () => {
    const enabled = new Set<WorkerName>(['fee_stats', 'ingest']);
    expect(selectWorkerModules(enabled, registry, logger())).toEqual([IngestStubModule, FeesStubModule]);
  });

  it('leaves out registered workers that are not enabled', () => {
    expect(selectWorkerModules(new Set<WorkerName>(['ingest']), registry, logger())).toEqual([IngestStubModule]);
    expect(selectWorkerModules(new Set<WorkerName>(), registry, logger())).toEqual([]);
  });

  it('warns, without failing, about an enabled worker whose module is not registered yet', () => {
    const log = logger();
    const enabled = new Set<WorkerName>(['ingest', 'validations', 'aggregator']);
    expect(selectWorkerModules(enabled, registry, log)).toEqual([IngestStubModule]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"validations"'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"aggregator"'));
  });

  it('warns about the validators worker, without failing, when the registry has no module for it', () => {
    const log = logger();
    const enabled = new Set<WorkerName>(['ingest', 'validators']);
    expect(selectWorkerModules(enabled, registry, log)).toEqual([IngestStubModule]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"validators"'));
  });

  it('selects the validators module after the other workers when it is registered', () => {
    const ValidatorsStubModule = class {};
    const enabled = new Set<WorkerName>(['validators', 'fee_stats', 'ingest']);
    expect(selectWorkerModules(enabled, { ...registry, validators: ValidatorsStubModule }, logger())).toEqual([
      IngestStubModule,
      FeesStubModule,
      ValidatorsStubModule,
    ]);
  });

  it('accepts dynamic modules', () => {
    const dynamic = { module: IngestStubModule, providers: [] };
    expect(selectWorkerModules(new Set<WorkerName>(['ingest']), { ingest: dynamic }, logger())).toEqual([dynamic]);
  });
});

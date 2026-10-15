import { Module } from '@nestjs/common';
import { WorkerName } from './config/syncer.config';
import { selectWorkerModules, WorkerModuleRegistry } from './worker-registry';

@Module({})
class IngestStubModule {}

@Module({})
class FeesStubModule {}

const logger = () => ({ warn: jest.fn() });

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

  it('accepts dynamic modules', () => {
    const dynamic = { module: IngestStubModule, providers: [] };
    expect(selectWorkerModules(new Set<WorkerName>(['ingest']), { ingest: dynamic }, logger())).toEqual([dynamic]);
  });
});

import { Module } from '@nestjs/common';
import { enabledWorkers, SyncerConfig, WORKER_NAMES, WorkerName } from './config/syncer.config';
import { TokenHistoryModule } from './token-history/token-history.module';
import { TomlsModule } from './tomls/tomls.module';
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

  it('registers the tomls worker, before the token_history one', () => {
    expect(WORKER_MODULES.tomls).toBe(TomlsModule);
    expect(WORKER_NAMES[WORKER_NAMES.length - 2]).toBe('tomls');
    expect(selectWorkerModules(new Set<WorkerName>(['tomls']), WORKER_MODULES, logger())).toEqual([TomlsModule]);
    // after the validators, in worker order whatever the order of the set
    expect(selectWorkerModules(new Set<WorkerName>(['tomls', 'validators']), WORKER_MODULES, logger())).toEqual([
      ValidatorsModule,
      TomlsModule,
    ]);
  });

  it('registers the token_history worker, the last one', () => {
    expect(WORKER_MODULES.token_history).toBe(TokenHistoryModule);
    expect(WORKER_NAMES[WORKER_NAMES.length - 1]).toBe('token_history');
    expect(selectWorkerModules(new Set<WorkerName>(['token_history', 'tomls']), WORKER_MODULES, logger())).toEqual([
      TomlsModule,
      TokenHistoryModule,
    ]);
  });

  it('runs all seven workers by default: GH_WORKERS defaults to the names in order, token_history last', () => {
    expect(WORKER_NAMES.join(',')).toBe('ingest,validations,fee_stats,aggregator,validators,tomls,token_history');
    expect(new SyncerConfig().workers).toBe('ingest,validations,fee_stats,aggregator,validators,tomls,token_history');
    expect(enabledWorkers(new SyncerConfig())).toEqual(new Set(WORKER_NAMES));
  });

  it('has a module for every worker', () => {
    for (const name of WORKER_NAMES) expect(WORKER_MODULES[name]).toBeDefined();
  });

  it('makes the node client for the validators worker, as it does for ingest and fee_stats', () => {
    expect(NODE_CLIENT_WORKERS.has('validators')).toBe(true);
    expect(needsNodeClient(new Set<WorkerName>(['validators']))).toBe(true);
    expect(needsNodeClient(new Set<WorkerName>(['aggregator', 'validations']))).toBe(false);
  });

  it('the token_history worker needs no node client', () => {
    expect(NODE_CLIENT_WORKERS.has('token_history')).toBe(false);
    expect(needsNodeClient(new Set<WorkerName>(['token_history']))).toBe(false);
    expect(needsNodeClient(new Set<WorkerName>(['token_history', 'aggregator', 'tomls']))).toBe(false);
  });

  it('makes no node client for a syncer of only the tomls worker: it reads ClickHouse and the web', () => {
    expect(NODE_CLIENT_WORKERS.has('tomls')).toBe(false);
    expect(needsNodeClient(new Set<WorkerName>(['tomls']))).toBe(false);
    expect(needsNodeClient(new Set<WorkerName>(['tomls', 'aggregator']))).toBe(false);
    // the set of the workers that read from the node is the same as before the tomls worker
    expect([...NODE_CLIENT_WORKERS].sort()).toEqual(['fee_stats', 'ingest', 'validators']);
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

import { ClickHouseModule, ClickHouseService } from '@gatehub/data-api-shared';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

/**
 * A worker stops in its `onModuleDestroy` and writes what it holds, so the client of ClickHouse must still be open then. The
 * ClickHouse module and the module of a worker are imports of the core module at the same distance, and Nest runs the hooks of
 * such modules in the order they were scanned: the ClickHouse module is first, so a client closed in its own `onModuleDestroy`
 * was closed before the worker's stop. `ClickHouseService` closes it in `onApplicationShutdown`, which Nest runs after every
 * `onModuleDestroy`.
 */
describe('the shutdown of the ClickHouse client', () => {
  it('closes after the onModuleDestroy of a worker whose module comes after the ClickHouse module', async () => {
    const events: string[] = [];

    @Injectable()
    class FlushingWorker {
      async onModuleDestroy(): Promise<void> {
        events.push('worker stops');
        // what a stop does: waits for work under way, then writes it
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('worker has written');
      }
    }
    @Module({ providers: [FlushingWorker] })
    class WorkerModule {}

    const moduleRef = await Test.createTestingModule({
      // the ClickHouse module first, as the core module imports it
      imports: [ClickHouseModule.forRoot({ url: 'http://127.0.0.1:1', database: 'unused' }), WorkerModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const client = app.get(ClickHouseService).raw;
    const closeClient = client.close.bind(client);
    jest.spyOn(client, 'close').mockImplementation(async () => {
      events.push('client closes');
      await closeClient();
    });

    await app.close();

    expect(events).toEqual(['worker stops', 'worker has written', 'client closes']);
  });
});

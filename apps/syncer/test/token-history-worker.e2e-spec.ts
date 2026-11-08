import {
  ClickHouseService,
  committedCheckpoint,
  getNetworkProfile,
  holdersAt,
  LedgerWriter,
  liveTokenHistory,
  parseContextFor,
  patchTokenHistoryState,
  readTokenHistoryStates,
  runMigrations,
  runTokenHistoryBuild,
  Table,
  totalsAt,
} from '@gatehub/data-api-shared';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import {
  seedTokenHistoryWorld,
  seedTokenHistoryWorldLater,
  seedTokensWorld,
} from '../../../packages/shared/test/tokens-world';
import { TokenHistoryWorker } from '../src/token-history/token-history-worker';

const PROFILE = getNetworkProfile('xrpl');
const CTX = parseContextFor(PROFILE);
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;
const log = { info: () => undefined };
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('the token_history worker (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_worker_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const workerOf = (ch: ClickHouseService, holder = 'worker-1') =>
    new TokenHistoryWorker(ch, { network: 'xrpl' } as never, PROFILE, undefined, {
      start: false,
      holder,
      floor: 5,
      window: 2,
      logger: quiet,
    });

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  it('the worker follows a synthetic chain, catches up a build and promotes it', async () => {
    const ch = await fresh();
    const writer = new LedgerWriter(ch, CTX);
    // the first batch of the world, as the live syncer writes it
    const world = await seedTokensWorld(ch as never, writer as never);
    const worker = workerOf(ch);

    // no generation yet: the worker follows the head with nothing to write, and holds its lease
    expect(await worker.pass()).toMatchObject({ head: world.head, windows: 0 });
    const lease = await ch.queryOne<{ holder: string }>(
      `SELECT argMax(holder, heartbeat) AS holder FROM ${Table.SyncerLease} WHERE network = 'xrpl:token_history'`,
    );
    expect(lease?.holder).toBe('worker-1');

    // the operator's build, which needs the worker's lease; it ends at the head it started at
    await runTokenHistoryBuild(ch, { network: 'xrpl', hasMpt: true, threads: 2, log, ...SMALL });
    // the chain goes on while the build is still in its last phases: the worker's windows write the changes only
    await patchTokenHistoryState(ch, 1, { phase: 'dex' });
    await seedTokenHistoryWorldLater(writer as never, world);
    const head = (await committedCheckpoint(ch))!;
    const following = await worker.pass();
    expect(following.windows).toBeGreaterThan(1);
    expect(following.promoted).toBeUndefined();
    let [state] = await readTokenHistoryStates(ch);
    expect({ through: state.through_ledger, levels: state.levels_through }).toEqual({ through: head, levels: world.head });

    // the build is done: the worker catches its levels up to the head, a step a pass, and promotes it
    await patchTokenHistoryState(ch, 1, { phase: 'done' });
    for (let i = 0; i < 20 && liveTokenHistory(await readTokenHistoryStates(ch)) === undefined; i++) await worker.pass();
    [state] = await readTokenHistoryStates(ch);
    expect(state).toMatchObject({ generation: 1, state: 'live', through_ledger: head, levels_through: head });

    // what it serves equals a generation built at the head
    const reference = await fresh();
    await seedTokenHistoryWorld(reference as never, new LedgerWriter(reference, CTX) as never);
    await reference.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT 'xrpl:token_history', 'reference', now64(3)`,
    );
    await runTokenHistoryBuild(reference, { network: 'xrpl', hasMpt: true, threads: 2, log, ...SMALL });
    const sort = (a: { holder: string }, b: { holder: string }) => (a.holder < b.holder ? -1 : 1);
    for (const token of [
      { issuer: world.gate, currency: world.usd },
      { issuer: world.plain, currency: 'NEW' },
      { issuer: world.nostate, currency: 'ABC' },
    ]) {
      expect((await holdersAt(ch, 1, token, head)).sort(sort)).toEqual((await holdersAt(reference, 1, token, head)).sort(sort));
      expect(await totalsAt(ch, 1, token, head)).toEqual(await totalsAt(reference, 1, token, head));
    }

    // a second worker waits while the first holds the lease
    const second = workerOf(ch, 'worker-2');
    await second.pass();
    const after = await ch.queryOne<{ holder: string }>(
      `SELECT argMax(holder, heartbeat) AS holder FROM ${Table.SyncerLease} WHERE network = 'xrpl:token_history'`,
    );
    expect(after?.holder).toBe('worker-1');
  });
});

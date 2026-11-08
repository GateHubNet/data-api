import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { TokenHistoryStateRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { committedCheckpoint } from '../src/ingest/ingest-state';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { runTokenHistoryBuild } from '../src/token-history/build/run-build';
import { TOKEN_HISTORY_RETIRED_KEEP_MS } from '../src/token-history/constants';
import { totalsAt } from '../src/token-history/holders-at';
import { applyLiveWindow } from '../src/token-history/live-window';
import { catchUpLevels, dropRetired, promoteIfCaughtUp } from '../src/token-history/promote';
import { appendTokenHistoryDirty } from '../src/token-history/repair';
import {
  liveTokenHistory,
  patchTokenHistoryState,
  readTokenHistoryStates,
  writeTokenHistoryState,
} from '../src/token-history/state';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { seedTokenHistoryWorld, seedTokenHistoryWorldLater, seedTokensWorld, TokensWorld } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const NETWORK = 'xrpl';
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;
const LIVE = { hasMpt: true, network: NETWORK, floor: 5 } as const;
const log = { info: () => undefined };

const TABLES = `SELECT t, r FROM (
  SELECT 'changes' AS t, toString(tuple(issuer, currency, ledger_index, tx_index, node_index, holder, amount_before, amount_after,
         counted_before, counted_after, before_known)) AS r
    FROM ${Table.TokenHolderChanges} WHERE generation = {g:UInt32} GROUP BY r
  UNION ALL
  SELECT 'checkpoints', toString(tuple(issuer, currency, checkpoint_ledger, holder, amount, first_ledger, last_ledger))
    FROM ${Table.TokenCheckpoints} WHERE generation = {g:UInt32} GROUP BY 2
  UNION ALL
  SELECT 'heads', toString(tuple(issuer, currency, checkpoint_ledger, supply, holders, trust_lines, changes_since))
    FROM ${Table.TokenCheckpointHeads} WHERE generation = {g:UInt32} GROUP BY 2
  UNION ALL
  SELECT 'hours', toString(tuple(issuer, currency, hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred,
         transfers, changes, unknown_before, first_ledger, last_ledger))
    FROM (SELECT * FROM ${Table.TokenHourly} WHERE generation = {g:UInt32}
          ORDER BY issuer, currency, hour, version DESC LIMIT 1 BY issuer, currency, hour)
   GROUP BY 2)
 ORDER BY t, r`;

describe('catch-up, promotion and drop of the token history (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_promote_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  async function workerLease(ch: ClickHouseService): Promise<void> {
    await ch.command(
      `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT {network:String}, 'worker-1', now64(3)`,
      { network: `${NETWORK}:token_history` },
    );
  }

  const gen = async (ch: ClickHouseService, g: number): Promise<TokenHistoryStateRow> =>
    (await readTokenHistoryStates(ch)).find((r) => r.generation === g)!;

  /**
   * A generation built at the first batch's head whose build finished while the worker's windows went on to the head: its changes
   * are at the head, its levels at the first batch's (as a build whose `dex` phase ran while the windows applied).
   */
  async function doneAndBehind(ch: ClickHouseService, g = 1): Promise<{ world: TokensWorld; head: number }> {
    const writer = new LedgerWriter(ch, CTX);
    const world = await seedTokensWorld(ch, writer);
    await workerLease(ch);
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    await seedTokenHistoryWorldLater(writer, world);
    const head = (await committedCheckpoint(ch))!;
    // the windows apply while the build is in its dex phase: change rows only
    await patchTokenHistoryState(ch, g, { phase: 'dex' });
    for (;;) {
      const gens = (await readTokenHistoryStates(ch)).filter((r) => r.state !== 'retired');
      if (gens.every((r) => r.through_ledger >= head)) break;
      await applyLiveWindow(ch, gens, head, { ...LIVE, window: 2 });
    }
    await patchTokenHistoryState(ch, g, { phase: 'done' });
    return { world, head };
  }

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  it('a done build is caught up and promoted, and readers switch at the live row', async () => {
    const ch = await fresh();
    const { world, head } = await doneAndBehind(ch);
    // an old live generation below the building one
    await writeTokenHistoryState(ch, { ...(await gen(ch, 1)), generation: 0, state: 'live', phase: 'done' });
    const behind = await gen(ch, 1);
    expect({ levels: behind.levels_through, through: behind.through_ledger }).toEqual({ levels: world.head, through: head });
    expect(liveTokenHistory(await readTokenHistoryStates(ch))?.generation).toBe(0);
    // not caught up (the margin is 0 here; the world's gap of 5 ledgers is inside the default 10): no promotion
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch), 0)).toBe(false);

    let levels = behind.levels_through;
    let steps = 0;
    while (levels < head) {
      levels = await catchUpLevels(ch, await gen(ch, 1), head, 1_000, { floor: 5, window: 2 });
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    expect((await gen(ch, 1)).levels_through).toBe(head);
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch), 0)).toBe(true);
    const states = await readTokenHistoryStates(ch);
    expect(liveTokenHistory(states)?.generation).toBe(1);
    expect(states.find((r) => r.generation === 0)?.state).toBe('retired');

    // the caught-up generation equals one built at the head
    const reference = await fresh();
    await seedTokenHistoryWorld(reference, new LedgerWriter(reference, CTX));
    await workerLease(reference);
    await runTokenHistoryBuild(reference, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    expect(await ch.query(TABLES, { g: 1 })).toEqual(await reference.query(TABLES, { g: 1 }));
    const usd = { issuer: world.gate, currency: world.usd };
    expect(await totalsAt(ch, 1, usd, head)).toEqual(await totalsAt(reference, 1, usd, head));
  });

  it('a build within 10 ledgers of the head is promoted, and caught up as live', async () => {
    const ch = await fresh();
    const { head } = await doneAndBehind(ch);
    const g = await gen(ch, 1);
    expect(g.through_ledger - g.levels_through).toBeLessThanOrEqual(10);
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
    expect((await gen(ch, 1)).state).toBe('live');
    expect(await catchUpLevels(ch, await gen(ch, 1), head, 1_000, { floor: 5 })).toBe(head);
  });

  it('the first build is promoted with no generation to retire', async () => {
    const ch = await fresh();
    await seedTokensWorld(ch, new LedgerWriter(ch, CTX));
    await workerLease(ch);
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
    const states = await readTokenHistoryStates(ch);
    expect(states.map((r) => [r.generation, r.state])).toEqual([[1, 'live']]);
    // nothing to promote any more
    expect(await promoteIfCaughtUp(ch, states)).toBe(false);
  });

  it('a promotion clears the ranges the build already reflects, and keeps the others', async () => {
    const ch = await fresh();
    const world = await seedTokensWorld(ch, new LedgerWriter(ch, CTX));
    await workerLease(ch);
    // a range of a recovery before the build started, and one past its h0
    await appendTokenHistoryDirty(ch, world.first + 1, world.first + 2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    await appendTokenHistoryDirty(ch, world.first + 2, world.first + 3);
    await appendTokenHistoryDirty(ch, world.head + 1, world.head + 2);
    expect(await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch))).toBe(true);
    const left = await ch.query<{ from_ledger: number; to_ledger: number }>(
      `SELECT from_ledger, to_ledger FROM ${Table.TokenHistoryDirty} ORDER BY from_ledger`,
    );
    expect(left).toEqual([
      { from_ledger: world.first + 2, to_ledger: world.first + 3 },
      { from_ledger: world.head + 1, to_ledger: world.head + 2 },
    ]);
  });

  it('a retired generation is dropped after 15 minutes and not before', async () => {
    const ch = await fresh();
    await seedTokensWorld(ch, new LedgerWriter(ch, CTX));
    await workerLease(ch);
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    await promoteIfCaughtUp(ch, await readTokenHistoryStates(ch));
    // a second build, promoted: the first is retired
    await runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL });
    const before = await readTokenHistoryStates(ch);
    expect(before.map((r) => r.state)).toEqual(['live', 'building']);
    // a new build is not started while one is live and none builds: it was started by the second run above
    await promoteIfCaughtUp(ch, before);
    const states = await readTokenHistoryStates(ch);
    const retired = states.find((r) => r.state === 'retired')!;
    expect(retired.generation).toBe(1);
    const parts = async (g: number) =>
      Number(
        (
          await ch.queryOne<{ n: string }>(
            `SELECT toString(count()) AS n FROM system.parts
              WHERE database = currentDatabase() AND active AND table IN ({tables:Array(String)})
                AND (partition_id = toString({g:UInt32}) OR startsWith(partition_id, concat(toString({g:UInt32}), '-')))`,
            {
              g,
              tables: [Table.TokenHolderChanges, Table.TokenCheckpoints, Table.TokenCheckpointHeads, Table.TokenHourly],
            },
          )
        )?.n,
      );
    expect(await parts(1)).toBeGreaterThan(0);
    const retiredAt = retired.changed_at * 1000;
    expect(await dropRetired(ch, states, retiredAt + TOKEN_HISTORY_RETIRED_KEEP_MS - 1)).toEqual([]);
    expect(await parts(1)).toBeGreaterThan(0);
    expect(await dropRetired(ch, states, retiredAt + TOKEN_HISTORY_RETIRED_KEEP_MS)).toEqual([1]);
    expect(await parts(1)).toBe(0);
    // the live generation keeps its partitions, and a second drop finds nothing
    expect(await parts(2)).toBeGreaterThan(0);
    expect(await dropRetired(ch, states, retiredAt + TOKEN_HISTORY_RETIRED_KEEP_MS)).toEqual([]);
  });
});

import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { MptHolderStatesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import {
  buildLeaseName,
  BuildRefused,
  BuildStopped,
  readLease,
  runTokenHistoryBuild,
  writeLease,
} from '../src/token-history/build/run-build';
import { patchTokenHistoryState, readTokenHistoryStates, writeTokenHistoryState } from '../src/token-history/state';
import { mptIssuanceId } from '../src/util/mpt';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { seedTokenHistoryWorld, TokenHistoryWorld } from './tokens-world';

const CTX = parseContextFor(getNetworkProfile('xrpl'));
const NETWORK = 'xrpl';
const FIRST = 10_000_100;
const MPT = mptIssuanceId(1, 'rBEERdzDHqDyYmfw2jqzyMNBZu31yzfg6q');

/** The small batches of the tests: every phase has more than one. */
const SMALL = { passAccounts: 3, levelTokens: 2, floor: 5 } as const;

/** The world, three MPT holders with changes in its ledgers, two old ledgers in the partition below it, and a worker lease. */
async function seedBuildWorld(ch: ClickHouseService): Promise<TokenHistoryWorld> {
  const world = await seedTokenHistoryWorld(ch, new LedgerWriter(ch, CTX), { first: FIRST });
  const mpt = (holder: string, ledger: number, amount: string): MptHolderStatesRow => ({
    holder,
    mpt_issuance_id: MPT,
    ledger_index: ledger,
    tx_index: 0,
    node_index: 0,
    tx_hash: `mpt-${holder}-${ledger}`,
    tx_type: 'Payment',
    close_time: 800_000_000 + ledger * 4,
    amount,
    escrowed_amount: '0',
    flags: 0,
    deleted: 0,
  });
  await ch.insert(Table.MptHolderStates, [
    mpt('rMptHolderA00000000000000000000000', world.first, '0'),
    mpt('rMptHolderA00000000000000000000000', world.first + 2, '100'),
    mpt('rMptHolderB00000000000000000000000', world.first + 1, '0'),
    mpt('rMptHolderB00000000000000000000000', world.first + 3, '7'),
    mpt('rMptHolderC00000000000000000000000', world.first + 4, '0'),
  ]);
  // two ledgers of an older partition, hours before the world: the DEX history has a partition to scan
  await ch.insert(
    Table.Ledgers,
    [5_000_000, 5_000_001].map((l, i) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: l,
      ledger_hash: String(l).padStart(64, 'B'),
      close_time: 700_000_000 + i * 4_000,
    })),
  );
  await freshWorkerLease(ch);
  return world;
}

async function freshWorkerLease(ch: ClickHouseService): Promise<void> {
  await ch.command(
    `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT {network:String}, 'worker-1', now64(3)`,
    { network: `${NETWORK}:token_history` },
  );
}

const TABLES = `SELECT t, r FROM (
  SELECT 'changes' AS t, toString(tuple(issuer, currency, ledger_index, tx_index, node_index, holder, amount_before, amount_after,
         counted_before, counted_after, before_known, clawback, order_exp, order_mant)) AS r
    FROM ${Table.TokenHolderChanges} WHERE generation = {g:UInt32}
   GROUP BY r
  UNION ALL
  SELECT 'checkpoints', toString(tuple(issuer, currency, checkpoint_ledger, holder, amount, first_ledger, last_ledger))
    FROM ${Table.TokenCheckpoints} WHERE generation = {g:UInt32}
   GROUP BY 2
  UNION ALL
  SELECT 'heads', toString(tuple(issuer, currency, checkpoint_ledger, supply, holders, trust_lines, changes_since, first_ledger))
    FROM ${Table.TokenCheckpointHeads} WHERE generation = {g:UInt32}
   GROUP BY 2
  UNION ALL
  SELECT 'hours', toString(tuple(issuer, currency, hour, supply, holders, trust_lines, issued, redeemed, clawed_back, transferred,
         transfers, changes, unknown_before, first_ledger, last_ledger, final))
    FROM (SELECT * FROM ${Table.TokenHourly} WHERE generation = {g:UInt32}
          ORDER BY issuer, currency, hour, version DESC LIMIT 1 BY issuer, currency, hour)
   GROUP BY 2
  UNION ALL
  SELECT 'dex', toString(tuple(issuer, currency, hour, exchanged, trades))
    FROM ${Table.TokenHourlyDex}
   GROUP BY 2)
 ORDER BY t, r`;

describe('the token history build (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;
  const logs: string[] = [];
  const log = { info: (m: string) => void logs.push(m) };

  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `token_history_build_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const build = (ch: ClickHouseService, more: Partial<Parameters<typeof runTokenHistoryBuild>[1]> = {}) =>
    runTokenHistoryBuild(ch, { network: NETWORK, hasMpt: true, threads: 2, log, ...SMALL, ...more });

  beforeAll(async () => {
    container = await startClickHouse();
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  describe('refusals', () => {
    it('refuses while a range-ingest runs', async () => {
      const ch = await fresh();
      await seedBuildWorld(ch);
      await ch.insert(Table.IngestLog, [
        { range_start: 100, range_end: 199, run_id: 'run-1', status: 'started', updated_at: Date.now() / 1000 },
      ]);
      await expect(build(ch)).rejects.toMatchObject({ reason: 'range_ingest' });
      await expect(build(ch)).rejects.toBeInstanceOf(BuildRefused);
      expect(await readTokenHistoryStates(ch)).toEqual([]);
    });

    it('refuses while another build holds the lease', async () => {
      const ch = await fresh();
      await seedBuildWorld(ch);
      await ch.command(
        `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat) SELECT {network:String}, 'another-build', now64(3)`,
        { network: `${NETWORK}:token_history_build` },
      );
      await expect(build(ch)).rejects.toMatchObject({ reason: 'build_running' });
    });

    it('refuses when another build took the lease between its check and its write, and leaves that lease alone', async () => {
      const ch = await fresh();
      await seedBuildWorld(ch);
      const name = buildLeaseName(NETWORK);
      // a second build that read the lease free at the same moment, and wrote its own just after this one's
      const racing = new Proxy(ch, {
        get(target, prop, receiver) {
          if (prop !== 'command') return Reflect.get(target, prop, receiver);
          return async (q: string, p?: Record<string, unknown>, o?: never) => {
            await target.command(q, p, o);
            if (p?.network === name && String(p.holder).startsWith('token-history-build:')) {
              await writeLease(target, name, 'another-build');
            }
          };
        },
      });
      await expect(build(racing, { leaseSettleMs: 0 })).rejects.toMatchObject({ reason: 'build_running' });
      expect((await readLease(ch, name)).holder).toBe('another-build');
      expect(await readTokenHistoryStates(ch)).toEqual([]);
    });

    it('refuses without a fresh worker lease', async () => {
      const ch = await fresh();
      await seedTokenHistoryWorld(ch, new LedgerWriter(ch, CTX), { first: FIRST });
      await expect(build(ch)).rejects.toMatchObject({ reason: 'no_worker' });
      // a lease older than the freshness the build asks for is no worker either
      await freshWorkerLease(ch);
      await expect(build(ch, { workerLeaseFreshMs: 0 })).rejects.toMatchObject({ reason: 'no_worker' });
    });
  });

  it('stops and retires the generation when a range-ingest starts', async () => {
    const ch = await fresh();
    await seedBuildWorld(ch);
    let started = false;
    const starting = {
      info: (m: string) => {
        logs.push(m);
        if (started || !m.includes('phase changes')) return;
        started = true;
        void ch.insert(Table.IngestLog, [
          { range_start: 100, range_end: 199, run_id: 'run-2', status: 'started', updated_at: Date.now() / 1000 },
        ]);
      },
    };
    await expect(build(ch, { log: starting })).rejects.toBeInstanceOf(BuildStopped);
    const [state] = await readTokenHistoryStates(ch);
    expect(state).toMatchObject({ generation: 1, state: 'retired' });
  });

  describe('a whole build', () => {
    let ch: ClickHouseService;
    let world: TokenHistoryWorld;
    let result: Awaited<ReturnType<typeof runTokenHistoryBuild>>;

    beforeAll(async () => {
      ch = await fresh();
      world = await seedBuildWorld(ch);
      logs.length = 0;
      result = await build(ch);
    }, 120_000);

    it('a build ends with phase done and levels_through = h1', async () => {
      expect(result).toEqual({ generation: 1, phase: 'done' });
      const [state] = await readTokenHistoryStates(ch);
      expect(state).toMatchObject({
        generation: 1,
        state: 'building',
        phase: 'done',
        h0: world.head,
        h1: world.head,
        through_ledger: world.head,
        levels_through: world.head,
        coverage_from: world.first,
      });
    });

    it('writes every table of the generation, MPTs and DEX hours included', async () => {
      const rows = await ch.query<{ t: string; r: string }>(TABLES, { g: 1 });
      const kinds = new Set(rows.map((r) => r.t));
      expect([...kinds].sort()).toEqual(['changes', 'checkpoints', 'dex', 'heads', 'hours']);
      expect(rows.some((r) => r.t === 'changes' && r.r.includes(MPT))).toBe(true);
    });

    it('logs its progress as range-ingest does', () => {
      expect(logs.some((m) => /^token-history-build: generation 1 phase changes cursor \S+ rows \d+ \(\d+ rows\/s\)$/.test(m))).toBe(
        true,
      );
      for (const phase of ['mpt_changes', 'levels', 'dex']) expect(logs.some((m) => m.includes(`phase ${phase} `))).toBe(true);
    });

    it('sends every statement with max_threads = threads', async () => {
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ threads: string; n: string }>(
        `SELECT Settings['max_threads'] AS threads, toString(count()) AS n FROM system.query_log
          WHERE current_database = currentDatabase() AND log_comment = 'token-history-build' AND type = 'QueryFinish'
          GROUP BY threads`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].threads).toBe('2');
      expect(Number(rows[0].n)).toBeGreaterThan(20);
    });

    it('resumes after an abort in every phase and gives the same tables as an uninterrupted build', async () => {
      const other = await fresh();
      await seedBuildWorld(other);
      for (const phase of ['changes', 'mpt_changes', 'levels', 'dex']) {
        const abort = new AbortController();
        const aborting = {
          info: (m: string) => {
            if (m.includes(`phase ${phase} `)) abort.abort(new Error(`stopped in ${phase}`));
          },
        };
        await expect(build(other, { log: aborting, signal: abort.signal })).rejects.toThrow(`stopped in ${phase}`);
        const [state] = await readTokenHistoryStates(other);
        expect({ phase, state: state.state, generation: state.generation }).toEqual({ phase, state: 'building', generation: 1 });
      }
      expect(await build(other)).toEqual({ generation: 1, phase: 'done' });
      expect(await other.query(TABLES, { g: 1 })).toEqual(await ch.query(TABLES, { g: 1 }));
    });
  });

  it('a patch keeps the fields of the state it does not name', async () => {
    const ch = await fresh();
    await writeTokenHistoryState(ch, {
      generation: 4,
      state: 'building',
      config_version: 1,
      coverage_from: 10,
      h0: 20,
      h1: 0,
      phase: 'changes',
      account_cursor: '',
      token_cursor_issuer: '',
      token_cursor_currency: '',
      through_ledger: 25,
      levels_through: 20,
      started_at: 1_700_000_000.25,
    });
    await patchTokenHistoryState(ch, 4, { account_cursor: 'rZ' });
    await patchTokenHistoryState(ch, 4, { through_ledger: 30 });
    const [row] = await readTokenHistoryStates(ch);
    expect(row).toMatchObject({ account_cursor: 'rZ', through_ledger: 30, h0: 20, coverage_from: 10, started_at: 1_700_000_000.25 });
  });
});

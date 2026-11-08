import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { TokenKey } from '../../aggregate/token-rules';
import { nextPassAccounts } from '../../aggregate/tokens.job';
import { ClickHouseService } from '../../clickhouse/clickhouse.service';
import { TokenHistoryStateRow } from '../../clickhouse/rows';
import { Table } from '../../clickhouse/tables';
import { committedCheckpoint } from '../../ingest/ingest-state';
import { getNetworkProfile, NetworkName } from '../../network';
import { loadAmendmentsConfig } from '../../validators/amendments-config';
import { TOKEN_HISTORY_CONFIG_VERSION, TOKEN_HISTORY_PASS_ACCOUNTS } from '../constants';
import { rangeIngestRunning, tokenHistoryCoverageFrom } from '../coverage-start';
import {
  buildingTokenHistory,
  nextGeneration,
  patchTokenHistoryState,
  readTokenHistoryStates,
  TokenHistoryStatePatch,
  writeTokenHistoryState,
} from '../state';
import { nextMptPassHolders, writeChangesBatch, writeMptChangesBatch } from './changes-pass';
import { dexHistoryPartition, nextDexPartition } from './dex';
import { buildSmallTokenLevels, buildTokenLevels, nextLevelTokens } from './levels';

/**
 * The `token-history-build` command's work (spec 4.6): a generation of the token history, phase by phase, resumable from its state
 * row, as `INSERT … SELECT`s in ClickHouse. It holds its own lease, refuses to start or goes on only while no range-ingest runs, and
 * needs the `token_history` worker, whose live windows write the changes above `h0`.
 */

/** Why the build did not start. */
export type BuildRefusal = 'build_running' | 'range_ingest' | 'no_worker';

/** The build did not start; the message names why. */
export class BuildRefused extends Error {
  constructor(
    readonly reason: BuildRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'BuildRefused';
  }
}

/** A range-ingest started while the build ran: the generation is retired, and a new build is due once the fill is done. */
export class BuildStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildStopped';
  }
}

export interface BuildLog {
  info(msg: string): void;
}

/** The options of a build. The last four are the tests' (smaller batches); the command leaves them out. */
export interface TokenHistoryBuildOptions {
  network: string;
  hasMpt: boolean;
  /** `max_threads` of every statement. */
  threads: number;
  log: BuildLog;
  now?: () => number;
  /** An abort stops the build after the statement in flight; it resumes on the next run. */
  signal?: AbortSignal;
  /** How fresh the worker's lease must be (default 30 s, its TTL). */
  workerLeaseFreshMs?: number;
  passAccounts?: number;
  levelTokens?: number;
  floor?: number;
  slice?: number;
}

/** The tokens of one batch of the levels phase: the small ones of a batch are built in one statement. */
export const TOKEN_HISTORY_LEVEL_TOKENS = 1_000;

/** The TTL of the build's lease and of the worker's (as the live runner's), and how often the build renews its own. */
export const TOKEN_HISTORY_LEASE_TTL_MS = 30_000;
export const TOKEN_HISTORY_LEASE_HEARTBEAT_MS = 10_000;
/** The `log_comment` of every statement of the build: its reads and writes can be found in `system.query_log`. */
export const TOKEN_HISTORY_BUILD_COMMENT = 'token-history-build';

/** The lease rows of `syncer_lease`: the build's and the worker's, per network. */
export const buildLeaseName = (network: string): string => `${network}:token_history_build`;
export const workerLeaseName = (network: string): string => `${network}:token_history`;

/** The newest row of a lease, aged on the server's clock (as the live runner reads its own); holder `''` when none or released. */
export async function readLease(ch: ClickHouseService, name: string): Promise<{ holder: string; ageMs: number }> {
  const row = await ch.queryOne<{ holder: string; age_ms: string | number; n: string }>(
    `SELECT argMax(holder, heartbeat) AS holder, dateDiff('millisecond', max(heartbeat), now64(3)) AS age_ms,
            toString(count()) AS n
       FROM ${Table.SyncerLease} WHERE network = {network:String}`,
    { network: name },
  );
  if (row === undefined || row.n === '0') return { holder: '', ageMs: Number.POSITIVE_INFINITY };
  return { holder: row.holder, ageMs: Number(row.age_ms) };
}

/** Writes a lease row on the server's clock, strictly newer than every row of the lease. */
export async function writeLease(ch: ClickHouseService, name: string, holder: string): Promise<void> {
  await ch.command(
    `INSERT INTO ${Table.SyncerLease} (network, holder, heartbeat)
     SELECT {network:String}, {holder:String},
            greatest(now64(3), (SELECT max(heartbeat) FROM ${Table.SyncerLease} WHERE network = {network:String})
                               + toIntervalMillisecond(1))`,
    { network: name, holder },
  );
}

/** `ch` with `max_threads` and the build's `log_comment` on every query and command. */
function withBuildSettings(ch: ClickHouseService, threads: number): ClickHouseService {
  const extra = { max_threads: threads, log_comment: TOKEN_HISTORY_BUILD_COMMENT };
  return new Proxy(ch, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (q: string, p?: Record<string, unknown>, s: Record<string, unknown> = {}) => target.query(q, p, { ...extra, ...s });
      }
      if (prop === 'queryOne') {
        return (q: string, p?: Record<string, unknown>, s: Record<string, unknown> = {}) =>
          target.queryOne(q, p, { ...extra, ...s });
      }
      if (prop === 'command') {
        return (q: string, p?: Record<string, unknown>, o: { settings?: Record<string, unknown>; queryId?: string } = {}) =>
          target.command(q, p, { ...o, settings: { ...extra, ...o.settings } });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Whether a coverage that starts at `from` is complete for issued tokens (spec 6): at or before the network's first ledger. */
function issuedComplete(network: string, from: number): boolean {
  const first = getNetworkProfile(network as NetworkName).firstLedger;
  return first !== undefined && from <= first;
}

/** Whether it is complete for MPTs: at or before the ledger `MPTokensV1` was enabled in (none known on a testnet). */
function mptComplete(network: string, from: number): boolean {
  const profile = getNetworkProfile(network as NetworkName);
  const enabled = loadAmendmentsConfig(profile).byName.get('MPTokensV1')?.enabled?.ledger_index;
  return enabled !== undefined && from <= enabled;
}

/**
 * Builds a generation of the token history (spec 4.6), or finishes the building one of the current config and coverage. Refuses
 * (`BuildRefused`) while another build holds the lease, while a range-ingest runs, and while the worker has no fresh lease. Runs the
 * phases `changes`, `mpt_changes` (with MPTs), `levels`, `dex` and `done`, writing the state row after every batch and logging its
 * progress. A range-ingest that starts meanwhile retires the generation and throws `BuildStopped`; an abort leaves it building.
 */
export async function runTokenHistoryBuild(
  plain: ClickHouseService,
  o: TokenHistoryBuildOptions,
): Promise<{ generation: number; phase: 'done' }> {
  const ch = withBuildSettings(plain, o.threads);
  const now = o.now ?? Date.now;
  const holder = `token-history-build:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseName = buildLeaseName(o.network);

  const lease = await readLease(ch, leaseName);
  if (lease.holder !== '' && lease.ageMs < TOKEN_HISTORY_LEASE_TTL_MS) {
    throw new BuildRefused('build_running', `another token-history-build holds the lease (${lease.holder})`);
  }
  await writeLease(ch, leaseName, holder);
  const heartbeat = setInterval(() => void writeLease(plain, leaseName, holder).catch(() => undefined), TOKEN_HISTORY_LEASE_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    if (await rangeIngestRunning(ch)) {
      throw new BuildRefused('range_ingest', 'a range-ingest is running: build the token history once the fill is done');
    }
    const worker = await readLease(ch, workerLeaseName(o.network));
    if (worker.holder === '' || worker.ageMs >= (o.workerLeaseFreshMs ?? TOKEN_HISTORY_LEASE_TTL_MS)) {
      throw new BuildRefused(
        'no_worker',
        'no token_history worker holds a fresh lease: the build needs it to write the changes above its start',
      );
    }
    return await runPhases(ch, o, now);
  } finally {
    clearInterval(heartbeat);
    await writeLease(plain, leaseName, '').catch(() => undefined);
  }
}

/** The generation to work on: the building one of the current config and coverage, else a new one (the old one retired). */
async function generationToBuild(ch: ClickHouseService, o: TokenHistoryBuildOptions, now: () => number): Promise<TokenHistoryStateRow> {
  const states = await readTokenHistoryStates(ch);
  const head = await committedCheckpoint(ch);
  if (head === undefined) throw new Error('no ledger is committed: there is nothing to build the token history from');
  const coverage = await tokenHistoryCoverageFrom(ch, head);
  if (coverage === undefined) throw new Error(`no unbroken run of stored ledgers reaches the head ${head}`);
  const building = buildingTokenHistory(states);
  if (building !== undefined) {
    if (building.config_version === TOKEN_HISTORY_CONFIG_VERSION && building.coverage_from === coverage) return building;
    await patchTokenHistoryState(ch, building.generation, { state: 'retired' });
    o.log.info(
      `token-history-build: generation ${building.generation} retired (config ${building.config_version}, coverage from ` +
        `${building.coverage_from}; now config ${TOKEN_HISTORY_CONFIG_VERSION}, coverage from ${coverage})`,
    );
  }
  const generation = nextGeneration(states);
  const row = {
    generation,
    state: 'building' as const,
    config_version: TOKEN_HISTORY_CONFIG_VERSION,
    coverage_from: coverage,
    h0: head,
    h1: 0,
    phase: 'changes' as const,
    account_cursor: '',
    token_cursor_issuer: '',
    token_cursor_currency: '',
    through_ledger: head,
    levels_through: head,
    started_at: now() / 1000,
  };
  await writeTokenHistoryState(ch, row);
  o.log.info(`token-history-build: generation ${generation} started at h0 ${head}, coverage from ${coverage}`);
  return (await readTokenHistoryStates(ch)).find((r) => r.generation === generation)!;
}

async function runPhases(
  ch: ClickHouseService,
  o: TokenHistoryBuildOptions,
  now: () => number,
): Promise<{ generation: number; phase: 'done' }> {
  let state = await generationToBuild(ch, o, now);
  const g = state.generation;
  const version = Math.round(state.started_at * 1000);
  const batch = o.passAccounts ?? TOKEN_HISTORY_PASS_ACCOUNTS;

  /** Between two batches: an abort stops here; a range-ingest that started retires the generation. */
  const between = async (): Promise<void> => {
    o.signal?.throwIfAborted();
    if (await rangeIngestRunning(ch)) {
      await patchTokenHistoryState(ch, g, { state: 'retired' });
      throw new BuildStopped(`a range-ingest started: generation ${g} is retired; build again once the fill is done`);
    }
  };
  const step = async (patch: TokenHistoryStatePatch, cursor: string, rows: number, started: number): Promise<void> => {
    await patchTokenHistoryState(ch, g, patch);
    state = { ...state, ...patch };
    const seconds = Math.max((now() - started) / 1000, 0.001);
    o.log.info(
      `token-history-build: generation ${g} phase ${state.phase} cursor ${cursor === '' ? '-' : cursor} rows ${rows} ` +
        `(${Math.round(rows / seconds)} rows/s)`,
    );
  };

  for (;;) {
    await between();
    const started = now();
    switch (state.phase) {
      case 'changes': {
        const accounts = await nextPassAccounts(ch, state.account_cursor, batch);
        if (accounts.length === 0) {
          await patchTokenHistoryState(ch, g, { phase: o.hasMpt ? 'mpt_changes' : 'levels', account_cursor: '' });
          state = { ...state, phase: o.hasMpt ? 'mpt_changes' : 'levels', account_cursor: '' };
          break;
        }
        const { rows } = await writeChangesBatch(ch, g, accounts, state.coverage_from, state.h0, {
          coverageComplete: issuedComplete(o.network, state.coverage_from),
          threads: o.threads,
        });
        const last = accounts[accounts.length - 1];
        await step({ account_cursor: last }, last, rows, started);
        break;
      }
      case 'mpt_changes': {
        const holders = await nextMptPassHolders(ch, state.account_cursor, batch);
        if (holders.length === 0) {
          await patchTokenHistoryState(ch, g, { phase: 'levels', account_cursor: '' });
          state = { ...state, phase: 'levels', account_cursor: '' };
          break;
        }
        const { rows } = await writeMptChangesBatch(ch, g, holders, state.coverage_from, state.h0, {
          coverageComplete: mptComplete(o.network, state.coverage_from),
          threads: o.threads,
        });
        const last = holders[holders.length - 1];
        await step({ account_cursor: last }, last, rows, started);
        break;
      }
      case 'levels': {
        if (state.h1 === 0) {
          // h1 is the generation's through_ledger when the phase begins, fixed for the phase (the worker moves through_ledger on)
          const fresh = (await readTokenHistoryStates(ch)).find((r) => r.generation === g)!;
          await patchTokenHistoryState(ch, g, { h1: fresh.through_ledger });
          state = { ...state, h1: fresh.through_ledger };
        }
        const after: TokenKey | undefined =
          state.token_cursor_issuer === '' && state.token_cursor_currency === ''
            ? undefined
            : { issuer: state.token_cursor_issuer, currency: state.token_cursor_currency };
        const tokens = await nextLevelTokens(ch, g, after, o.levelTokens ?? TOKEN_HISTORY_LEVEL_TOKENS);
        if (tokens.length === 0) {
          await patchTokenHistoryState(ch, g, { phase: 'dex', levels_through: state.h1 });
          state = { ...state, phase: 'dex', levels_through: state.h1 };
          break;
        }
        const levelOpts = { version, threads: o.threads, floor: o.floor, slice: o.slice, signal: o.signal };
        // the small tokens of the batch in one statement, then each big one (checkpoints, slices, BigNumber) on its own
        const small = await buildSmallTokenLevels(ch, g, tokens, state.h1, levelOpts);
        let rows = small.hours;
        for (const token of small.big) {
          o.signal?.throwIfAborted();
          const built = await buildTokenLevels(ch, g, token, state.h1, levelOpts);
          rows += built.hours + built.checkpoints;
        }
        const last = tokens[tokens.length - 1];
        await step(
          { token_cursor_issuer: last.issuer, token_cursor_currency: last.currency },
          `${last.issuer}.${last.currency}`,
          rows,
          started,
        );
        break;
      }
      case 'dex': {
        const partition = await nextDexPartition(ch);
        if (partition === undefined) {
          await patchTokenHistoryState(ch, g, { phase: 'done' });
          state = { ...state, phase: 'done' };
          break;
        }
        const { hours } = await dexHistoryPartition(ch, partition);
        await step({}, String(partition), hours, started);
        break;
      }
      case 'done':
        o.log.info(`token-history-build: generation ${g} done, levels through ${state.levels_through}`);
        return { generation: g, phase: 'done' };
    }
  }
}

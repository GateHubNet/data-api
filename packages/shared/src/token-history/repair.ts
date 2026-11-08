import type { TokenKey } from '../aggregate/token-rules';
import { LineKey, parserFloorOf, WINDOW_LINES_SQL } from '../aggregate/tokens.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { MPT_PARSER_VERSION, TOKEN_PARSER_VERSION, TokenHistoryDirtyRow, TokenHistoryStateRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { buildTokenLevels } from './build/levels';
import { issuedComplete } from './build/run-build';
import { mptCoverageComplete } from './coverage-start';
import { closeHourOf, ledgersOfHour } from './hour-sets';
import { changesOf, keysIn, windowHistories } from './live-window';
import { buildingTokenHistory, liveTokenHistory } from './state';

/**
 * Re-ingest and repair (spec 4.7). The aggregator's eighth `agg_dirty` hook appends the ledgers of a recomputed slice to
 * `token_history_dirty`; the worker takes the oldest range and repairs it: its part below the live generation's coverage is dropped,
 * its part in the coverage is written again (the change rows of the tokens the touches name, then their hours and checkpoints from the
 * checkpoint before it), and the range row is deleted.
 */

const UNBOUNDED = 4_294_967_295;
const SYNC = { lightweight_deletes_sync: '2' } as const;
const TOKEN_KEYS = keysIn(['issuer', 'currency'], ['issuers', 'currencies']);

/** Appends a ledger range to repair (`token_history_dirty`). */
export async function appendTokenHistoryDirty(ch: ClickHouseService, from: number, to: number): Promise<void> {
  const row: TokenHistoryDirtyRow = { from_ledger: from, to_ledger: to, created_at: Date.now() / 1000 };
  await ch.insert(Table.TokenHistoryDirty, [row]);
}

/**
 * The aggregator's eighth `agg_dirty` hook: appends the ledgers that close in the slice `[start, end)` (unix seconds) to
 * `token_history_dirty`, and rebuilds nothing. A slice without a ledger appends nothing. It runs whether or not the worker runs.
 */
export async function markTokenHistoryDirty(ch: ClickHouseService, start: number, end: number): Promise<void> {
  const row = await ch.queryOne<{ first: number | null; last: number | null; n: string }>(
    `SELECT min(ledger_index) AS first, max(ledger_index) AS last, toString(count()) AS n FROM ${Table.Ledgers}
      WHERE close_time >= toDateTime({start:UInt32}, 'UTC') AND close_time < toDateTime({end:UInt32}, 'UTC')`,
    { start, end },
  );
  if (row === undefined || row.n === '0') return;
  await appendTokenHistoryDirty(ch, Number(row.first), Number(row.last));
}

/** The oldest range to repair, `undefined` when none. */
export async function oldestDirtyRange(ch: ClickHouseService): Promise<{ from: number; to: number } | undefined> {
  const row = await ch.queryOne<{ from_ledger: number; to_ledger: number }>(
    `SELECT from_ledger, to_ledger FROM ${Table.TokenHistoryDirty} ORDER BY from_ledger, to_ledger LIMIT 1`,
  );
  return row === undefined ? undefined : { from: Number(row.from_ledger), to: Number(row.to_ledger) };
}

async function deleteDirtyRange(ch: ClickHouseService, range: { from: number; to: number }): Promise<void> {
  await ch.command(
    `DELETE FROM ${Table.TokenHistoryDirty} WHERE from_ledger = {from:UInt32} AND to_ledger = {to:UInt32}`,
    range,
    { settings: SYNC },
  );
}

/** Whether the ledgers `[from, to]` hold one of a parser older than the token history reads (the touch indexes'). */
export async function holdsOlderParser(ch: ClickHouseService, from: number, to: number, hasMpt: boolean): Promise<boolean> {
  const floor = await parserFloorOf(ch, from - 1, to);
  return floor !== null && (floor < TOKEN_PARSER_VERSION || (hasMpt && floor < MPT_PARSER_VERSION));
}

/** The outcome of a repair step. */
export type RepairOutcome = 'none' | 'repaired' | 'dropped' | 'older_parser';

export interface RepairOptions {
  hasMpt: boolean;
  network: string;
  /** The checkpoint floor (the tests lower it). */
  floor?: number;
  onUnfit?: () => void;
}

/**
 * Repairs one generation over the ledgers `[from, to]`: the change rows of the tokens that the touches name there are deleted and
 * written again from the state tables (the rule of the live window, the before-state the newest row before `from`), then those tokens'
 * checkpoints and hour rows from the hour of `from` on are deleted and built again, from the checkpoint before it, up to the
 * generation's `levels_through`.
 */
async function repairGeneration(
  ch: ClickHouseService,
  gen: TokenHistoryStateRow,
  from: number,
  to: number,
  o: RepairOptions,
): Promise<void> {
  const lines = await ch.query<LineKey>(WINDOW_LINES_SQL, { from: from - 1, to, limit: UNBOUNDED });
  const mpts = o.hasMpt
    ? await ch.query<{ holder: string; id: string }>(
        `SELECT DISTINCT holder, mpt_issuance_id AS id FROM ${Table.MptTouches}
          WHERE ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32} AND holder != ''`,
        { from, to },
      )
    : [];
  const histories = await windowHistories(ch, lines, mpts, from - 1, to);
  const rows = changesOf({ ...gen, through_ledger: from - 1 }, histories, {
    issued: issuedComplete(o.network, gen.coverage_from),
    mpt: await mptCoverageComplete(ch, o.network, gen.coverage_from),
  });
  const tokens = new Map<string, TokenKey>();
  for (const l of lines) {
    tokens.set(`${l.account}|${l.currency}`, { issuer: l.account, currency: l.currency });
    tokens.set(`${l.counterparty}|${l.currency}`, { issuer: l.counterparty, currency: l.currency });
  }
  for (const r of rows) tokens.set(`${r.issuer}|${r.currency}`, { issuer: r.issuer, currency: r.currency });
  if (tokens.size === 0) return;
  const keys = { issuers: [...tokens.values()].map((t) => t.issuer), currencies: [...tokens.values()].map((t) => t.currency) };

  // 1-2: the tokens' change rows of the range, deleted and written again (a dedup token of its own: the content may equal an earlier insert's)
  await ch.command(
    `DELETE FROM ${Table.TokenHolderChanges}
      WHERE generation = {g:UInt32} AND ${TOKEN_KEYS} AND ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}`,
    { g: gen.generation, ...keys, from, to },
    { settings: SYNC },
  );
  if (rows.length > 0) {
    await ch.insert(Table.TokenHolderChanges, rows, {
      dedupToken: `token_history:${gen.generation}:repair:${from}-${to}:${Date.now()}`,
    });
  }

  // 3: their checkpoints and hour rows from the hour of `from` on, built again from the checkpoint before it
  if (gen.levels_through < from) return;
  const hour = await closeHourOf(ch, from);
  if (hour === undefined) return;
  const hourStart = (await ledgersOfHour(ch, hour))?.first ?? from;
  const levelKeys = { g: gen.generation, ...keys, ledger: hourStart, hour };
  await ch.command(
    `DELETE FROM ${Table.TokenCheckpoints} WHERE generation = {g:UInt32} AND ${TOKEN_KEYS} AND checkpoint_ledger >= {ledger:UInt32}`,
    levelKeys,
    { settings: SYNC },
  );
  await ch.command(
    `DELETE FROM ${Table.TokenCheckpointHeads} WHERE generation = {g:UInt32} AND ${TOKEN_KEYS} AND checkpoint_ledger >= {ledger:UInt32}`,
    levelKeys,
    { settings: SYNC },
  );
  await ch.command(
    `DELETE FROM ${Table.TokenHourly}
      WHERE generation = {g:UInt32} AND ${TOKEN_KEYS} AND hour >= toDateTime({hour:UInt32}, 'UTC')`,
    levelKeys,
    { settings: SYNC },
  );
  for (const token of tokens.values()) {
    await buildTokenLevels(ch, gen.generation, token, gen.levels_through, { floor: o.floor, onUnfit: o.onUnfit });
  }
}

/**
 * Takes the oldest range of `token_history_dirty` and repairs the live generation, and a building one whose build is done (spec
 * 4.7). Its part below the live generation's `coverage_from` (a fill below the head's run) and above `through_ledger` (the live
 * windows have not reached it) is dropped: `'dropped'` when nothing is left. A range holding a ledger of an older parser is not
 * repaired and stays (`'older_parser'`: a build is due). While a build is not done, ranges wait (`'none'`). The range row is
 * deleted once repaired.
 */
export async function repairOldestRange(
  ch: ClickHouseService,
  gens: readonly TokenHistoryStateRow[],
  o: RepairOptions,
): Promise<RepairOutcome> {
  const range = await oldestDirtyRange(ch);
  if (range === undefined) return 'none';
  const live = liveTokenHistory(gens);
  const building = buildingTokenHistory(gens);
  if (building !== undefined && building.phase !== 'done') return 'none';
  const targets = [live, building].filter((g): g is TokenHistoryStateRow => g !== undefined);
  if (targets.length === 0) {
    await deleteDirtyRange(ch, range);
    return 'dropped';
  }
  const coverage = (live ?? building)!.coverage_from;
  const from = Math.max(range.from, coverage);
  const to = Math.min(range.to, Math.max(...targets.map((g) => g.through_ledger)));
  if (from > to) {
    await deleteDirtyRange(ch, range);
    return 'dropped';
  }
  if (await holdsOlderParser(ch, from, to, o.hasMpt)) return 'older_parser';
  for (const gen of targets) {
    const end = Math.min(to, gen.through_ledger);
    if (Math.max(from, gen.coverage_from) <= end) await repairGeneration(ch, gen, Math.max(from, gen.coverage_from), end, o);
  }
  await deleteDirtyRange(ch, range);
  return 'repaired';
}

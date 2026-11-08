import type { TokenKey } from '../aggregate/token-rules';
import { touchesOfWindow } from '../aggregate/tokens.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { TokenHistoryStateRow, TokenHolderChangesRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { mptIssuerOf } from '../util/mpt';
import { TOKEN_HISTORY_PROMOTE_NEAR, TOKEN_HISTORY_RETIRED_KEEP_MS } from './constants';
import { keysIn, windowLevels, WindowLevelsOptions } from './live-window';
import { buildingTokenHistory, liveTokenHistory, patchTokenHistoryState } from './state';

/**
 * The worker's end of a build (spec 4.6): it catches a finished build's levels up to its `through_ledger`, which its live windows keep
 * at the head, promotes it once it is near, and drops a retired generation's partitions 15 minutes after it was retired.
 */

/** The four tables of a generation, dropped by partition when it is retired. */
export const GENERATION_TABLES: readonly Table[] = [
  Table.TokenHolderChanges,
  Table.TokenCheckpoints,
  Table.TokenCheckpointHeads,
  Table.TokenHourly,
];

const TOKEN_KEYS = keysIn(['issuer', 'currency'], ['issuers', 'currencies']);

/** The generation's change rows of the tokens `tokens` in the ledgers `(from, to]`, each once: the rows a catch-up step levels. */
async function changesOfTokens(
  ch: ClickHouseService,
  g: number,
  tokens: TokenKey[],
  from: number,
  to: number,
): Promise<TokenHolderChangesRow[]> {
  if (tokens.length === 0) return [];
  return ch.query<TokenHolderChangesRow>(
    `SELECT generation, issuer, currency, ledger_index, tx_index, node_index, holder, toUnixTimestamp(close_time) AS close_time,
            clawback, amount_before, amount_after, counted_before, counted_after, before_known, \`limit\`, frozen, authorized, escrowed,
            order_exp, toString(order_mant) AS order_mant
       FROM ${Table.TokenHolderChanges}
      WHERE generation = {g:UInt32} AND ${TOKEN_KEYS} AND ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32}
      ORDER BY issuer, currency, ledger_index, tx_index, node_index, holder
      LIMIT 1 BY issuer, currency, ledger_index, tx_index, node_index, holder`,
    { g, issuers: tokens.map((t) => t.issuer), currencies: tokens.map((t) => t.currency), from, to },
  );
}

/**
 * Catches a generation's levels up toward `through` (spec 4.6): windows of `touchesOfWindow` over `(levels_through, through]`, each the
 * live window's level logic (hour sets, checkpoints) over the generation's change rows of the window's touched tokens, then the new
 * `levels_through`, while `budgetMs` lasts (one window at least). Returns the new `levels_through`.
 */
export async function catchUpLevels(
  ch: ClickHouseService,
  gen: TokenHistoryStateRow,
  through: number,
  budgetMs: number,
  o: WindowLevelsOptions & { hasMpt?: boolean; window?: number; now?: () => number } = {},
): Promise<number> {
  const now = o.now ?? Date.now;
  const started = now();
  let levels = gen.levels_through;
  while (levels < through) {
    const window = await touchesOfWindow(ch, levels, through, { window: o.window });
    const to = window.to;
    const tokens = new Map<string, TokenKey>();
    for (const l of window.lines) {
      tokens.set(`${l.account}|${l.currency}`, { issuer: l.account, currency: l.currency });
      tokens.set(`${l.counterparty}|${l.currency}`, { issuer: l.counterparty, currency: l.currency });
    }
    if (o.hasMpt !== false) {
      const ids = await ch.query<{ id: string }>(
        `SELECT DISTINCT mpt_issuance_id AS id FROM ${Table.MptTouches}
          WHERE ledger_index > {from:UInt32} AND ledger_index <= {to:UInt32} AND holder != ''`,
        { from: levels, to },
      );
      for (const { id } of ids) tokens.set(`${mptIssuerOf(id)}|${id}`, { issuer: mptIssuerOf(id), currency: id });
    }
    const rows = await changesOfTokens(ch, gen.generation, [...tokens.values()], levels, to);
    await windowLevels(ch, { ...gen, through_ledger: levels }, rows, to, o);
    await patchTokenHistoryState(ch, gen.generation, { levels_through: to });
    levels = to;
    if (now() - started >= budgetMs) break;
  }
  return levels;
}

/**
 * Promotes the building generation once its build is done and its `levels_through` is within `near` ledgers of its `through_ledger`
 * (spec 4.6): a `live` row for it, then a `retired` row for the generation that was live, if there was one. Readers switch at the
 * first row. Returns whether it promoted.
 */
export async function promoteIfCaughtUp(
  ch: ClickHouseService,
  gens: readonly TokenHistoryStateRow[],
  near = TOKEN_HISTORY_PROMOTE_NEAR,
): Promise<boolean> {
  const building = buildingTokenHistory(gens);
  if (building === undefined || building.phase !== 'done') return false;
  if (building.levels_through < building.through_ledger - near) return false;
  const old = liveTokenHistory(gens);
  await patchTokenHistoryState(ch, building.generation, { state: 'live' });
  if (old !== undefined && old.generation !== building.generation) {
    await patchTokenHistoryState(ch, old.generation, { state: 'retired' });
  }
  return true;
}

const PARTITION_ID = /^\d+(-\d+)?$/;

/**
 * Drops the partitions of the four generation tables of every retired generation retired at least `TOKEN_HISTORY_RETIRED_KEEP_MS`
 * before `now` (ms): `ALTER TABLE … DROP PARTITION ID` (the syncer's user needs that right on the four tables). The generation is
 * checked to be a whole number and each partition ID read from `system.parts` to be one of its own before it is named in a statement.
 * Returns the generations whose partitions it dropped.
 */
export async function dropRetired(ch: ClickHouseService, gens: readonly TokenHistoryStateRow[], now: number): Promise<number[]> {
  const dropped: number[] = [];
  for (const gen of gens) {
    if (gen.state !== 'retired' || now - gen.changed_at * 1000 < TOKEN_HISTORY_RETIRED_KEEP_MS) continue;
    const g = gen.generation;
    if (!Number.isInteger(g) || g < 0) throw new RangeError(`not a generation: ${String(g)}`);
    let any = false;
    for (const table of GENERATION_TABLES) {
      const parts = await ch.query<{ id: string }>(
        `SELECT DISTINCT partition_id AS id FROM system.parts
          WHERE database = currentDatabase() AND table = {table:String} AND active
            AND (partition_id = {g:String} OR startsWith(partition_id, {prefix:String}))`,
        { table, g: String(g), prefix: `${g}-` },
      );
      for (const { id } of parts) {
        if (!PARTITION_ID.test(id) || (id !== String(g) && !id.startsWith(`${g}-`))) continue;
        await ch.command(`ALTER TABLE ${table} DROP PARTITION ID '${id}'`);
        any = true;
      }
    }
    if (any) dropped.push(g);
  }
  return dropped;
}
